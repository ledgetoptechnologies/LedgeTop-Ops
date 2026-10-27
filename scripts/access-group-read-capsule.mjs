import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PINNED_TRUST_CONFIG_SHA256, PINNED_UNSEALER_SHA256 } from './access-group-read-capsule-pins.mjs';

const ZERO = '0'.repeat(64);
const HASH = /^[a-f0-9]{64}$/u;
const TOKEN = /^[\x21-\x7e]{20,1024}$/u;
const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const GROUP_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/u;
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const UNSEALER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'access-group-read-capsule-unseal.ps1');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (condition, code) => { if (!condition) throw new Error(`access_group_capsule_${code}`); };

/**
 * Keep the DPAPI helper's environment small and exclude ambient Cloudflare,
 * Node, and proxy overrides. This token is never sent through an environment
 * variable or a command-line argument.
 */
export function accessGroupCapsuleEnvironment(source = process.env) {
  const allowed = new Set(['SYSTEMROOT','WINDIR','COMSPEC','PATH','TEMP','TMP','USERPROFILE','LOCALAPPDATA',
    'APPDATA','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA','PATHEXT']);
  const output = Object.fromEntries(Object.entries(source).filter(([name]) => allowed.has(name.toUpperCase())));
  return { ...output, DOTNET_CLI_TELEMETRY_OPTOUT: '1', POWERSHELL_TELEMETRY_OPTOUT: '1' };
}

/**
 * Load the one provisioned Access Groups Read token for the fixed group-read
 * adapter. No path, purpose, account, group, fetch, command, or credential is
 * accepted from the caller. The returned string is secret; keep it in memory
 * and pass it only as the Authorization value to the pinned group GET.
 */
export async function loadPinnedAccessGroupReadCredential() {
  // This check intentionally precedes every filesystem or subprocess access.
  need(HASH.test(PINNED_TRUST_CONFIG_SHA256) && PINNED_TRUST_CONFIG_SHA256 !== ZERO
    && HASH.test(PINNED_UNSEALER_SHA256) && PINNED_UNSEALER_SHA256 !== ZERO, 'not_provisioned');
  let helper;
  try {
    const stat = fs.lstatSync(UNSEALER);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= 64 * 1024,
      'unseal_helper_unavailable');
    helper = fs.readFileSync(UNSEALER);
    need(helper.length === stat.size, 'unseal_helper_unavailable');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('access_group_capsule_')) throw error;
    need(false, 'unseal_helper_unavailable');
  }
  need(sha256(helper) === PINNED_UNSEALER_SHA256, 'unseal_helper_pin_mismatch');
  const source = helper.toString('utf8');
  need(source.includes(`$ExpectedTrustConfigSha256 = '${PINNED_TRUST_CONFIG_SHA256}'`), 'trust_pin_mismatch');

  return await new Promise((resolve, reject) => {
    let child, settled = false, byteCount = 0;
    const chunks = [];
    const finishError = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* retain fixed failure */ }
      for (const chunk of chunks) chunk.fill(0);
      reject(new Error(`access_group_capsule_${code}`));
    };
    const timer = setTimeout(() => finishError('unseal_timeout'), 20_000);
    try {
      child = spawn(POWERSHELL, ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',UNSEALER], {
        cwd: path.dirname(UNSEALER), env: accessGroupCapsuleEnvironment(), shell: false, windowsHide: true,
        stdio: ['ignore','pipe','ignore'],
      });
    } catch { finishError('unseal_unavailable'); return; }
    child.on('error', () => finishError('unseal_unavailable'));
    child.stdout.on('data', value => {
      byteCount += value.length;
      if (byteCount > 4096) { finishError('unseal_output_invalid'); return; }
      chunks.push(Buffer.from(value));
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        need(code === 0 && byteCount > 0, 'unseal_unavailable');
        const encoded = Buffer.concat(chunks, byteCount).toString('ascii').trim();
        need(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded), 'unseal_output_invalid');
        const bytes = Buffer.from(encoded, 'base64');
        const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        bytes.fill(0);
        need(payload && typeof payload === 'object' && !Array.isArray(payload)
          && Object.getPrototypeOf(payload) === Object.prototype
          && Reflect.ownKeys(payload).length === 5
          && ['schemaVersion','accountId','groupId','groupName','token'].every(key => Object.hasOwn(payload, key))
          && payload.schemaVersion === 1 && ACCOUNT_ID.test(payload.accountId ?? '')
          && GROUP_ID.test(payload.groupId ?? '') && GROUP_NAME.test(payload.groupName ?? '')
          && TOKEN.test(payload.token ?? ''), 'unseal_output_invalid');
        resolve(Object.freeze({ schemaVersion: 1, accountId: payload.accountId, groupId: payload.groupId,
          groupName: payload.groupName, token: payload.token }));
      } catch (error) {
        reject(error instanceof Error && error.message.startsWith('access_group_capsule_')
          ? error : new Error('access_group_capsule_unseal_output_invalid'));
      } finally { for (const chunk of chunks) chunk.fill(0); }
    });
  });
}
