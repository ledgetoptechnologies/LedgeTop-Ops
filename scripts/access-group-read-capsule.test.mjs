import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { accessGroupCapsuleEnvironment, loadPinnedAccessGroupReadCredential } from './access-group-read-capsule.mjs';
import { PINNED_TRUST_CONFIG_SHA256, PINNED_UNSEALER_SHA256 } from './access-group-read-capsule-pins.mjs';

const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const ZERO = '0'.repeat(64);
const PURPOSE = 'ltds-ops-access-group-read-capsule-v1';
const sha = value => createHash('sha256').update(value).digest('hex');
const isWindows = process.platform === 'win32' && fs.existsSync(PS);
const psQuote = value => `'${value.replaceAll("'", "''")}'`;

function runPowerShell(script, input = '') {
  const result = spawnSync(PS, ['-NoLogo','-NoProfile','-NonInteractive','-Command',script], {
    input, encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0 || result.stderr) throw new Error('synthetic_dpapi_fixture_failed');
  return result.stdout;
}

function protectSyntheticValue(value) {
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Security',
    '$raw=[Convert]::FromBase64String([Console]::In.ReadToEnd())',
    `$entropy=[Text.Encoding]::UTF8.GetBytes(${psQuote(PURPOSE)})`,
    '$sealed=[Security.Cryptography.ProtectedData]::Protect($raw,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($sealed))',
  ].join(';');
  const encoded = runPowerShell(script, Buffer.from(value, 'utf8').toString('base64')).trim();
  assert.match(encoded, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u);
  return Buffer.from(encoded, 'base64');
}

function acl(pathname, ownerSid, { directory = false, addUsers = false } = {}) {
  const flags = directory ? '(OI)(CI)F' : 'F';
  const args = [pathname, '/inheritance:r', '/grant:r', `*${ownerSid}:${flags}`, `*S-1-5-18:${flags}`];
  const result = spawnSync('icacls.exe', args, { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error('synthetic_acl_fixture_failed');
  if (addUsers) {
    const extra = spawnSync('icacls.exe', [pathname, '/grant', '*S-1-5-32-545:(R)'], {
      encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000,
    });
    if (extra.error || extra.status !== 0) throw new Error('synthetic_acl_fixture_failed');
  }
}

function exactReplace(text, before, after, label) {
  assert.equal(text.split(before).length - 1, 1, `expected one ${label} placeholder`);
  return text.replace(before, after);
}

async function fixture({ expired = false, tamperCipher = false, tamperPlainHash = false, extraAcl = false,
  reparseParent = false, wrongPermission = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'access-group-capsule-test-'));
  const realPrivate = path.join(base, 'private');
  fs.mkdirSync(realPrivate);
  const targetDirectory = reparseParent ? path.join(base, 'redirected') : realPrivate;
  if (reparseParent) fs.mkdirSync(targetDirectory);
  const configPath = path.join(targetDirectory, 'trust.json');
  const capsulePath = path.join(targetDirectory, 'access-group-read.dpapi');
  const helperPath = path.join(base, 'access-group-read-capsule-unseal.ps1');
  const modulePath = path.join(base, 'access-group-read-capsule.mjs');
  const pinsPath = path.join(base, 'access-group-read-capsule-pins.mjs');
  const ownerSid = runPowerShell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value').trim();
  assert.match(ownerSid, /^S-1-5-21-(?:\d+-){2}\d+-\d+$/u);
  const token = 'synthetic-access-group-read-token-never-real';
  const plaintext = Buffer.from(token, 'utf8');
  const cipher = protectSyntheticValue(token);
  const storedCipher = Buffer.from(cipher);
  if (tamperCipher) storedCipher[storedCipher.length - 1] ^= 1;
  const now = Date.now();
  const notBefore = new Date(now - 60_000).toISOString();
  const expiresAt = new Date(expired ? now - 1_000 : now + 60 * 60_000).toISOString();
  const config = {
    schemaVersion: 1,
    purpose: PURPOSE,
    accountId: 'a'.repeat(32),
    groupId: '11111111-1111-4111-8111-111111111111',
    groupName: 'Synthetic Ops Staff',
    permission: wrongPermission ? 'Access:Groups Edit' : 'Access:Groups Read',
    permissionScope: 'account',
    scopeAccountId: 'a'.repeat(32),
    tokenNotBefore: notBefore,
    tokenExpiresAt: expiresAt,
    ciphertextSha256: sha(cipher),
    plaintextSha256: tamperPlainHash ? '0'.repeat(64) : sha(plaintext),
    ownerSid,
  };
  const configBytes = Buffer.from(JSON.stringify(config), 'utf8');
  fs.writeFileSync(configPath, configBytes, { flag: 'wx' });
  fs.writeFileSync(capsulePath, storedCipher, { flag: 'wx' });
  acl(targetDirectory, ownerSid, { directory: true });
  acl(configPath, ownerSid, { addUsers: extraAcl });
  acl(capsulePath, ownerSid);
  let actualConfigPath = configPath;
  if (reparseParent) {
    const link = path.join(base, 'junction');
    const created = spawnSync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',
      `New-Item -ItemType Junction -Path ${psQuote(link)} -Target ${psQuote(targetDirectory)} | Out-Null`],
    { encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000 });
    if (created.error || created.status !== 0) throw new Error('synthetic_reparse_fixture_failed');
    actualConfigPath = path.join(link, 'trust.json');
  }
  const helperOriginal = fs.readFileSync(new URL('./access-group-read-capsule-unseal.ps1', import.meta.url), 'utf8');
  let helper = exactReplace(helperOriginal,
    "$ExpectedTrustConfigSha256 = '" + ZERO + "'", `$ExpectedTrustConfigSha256 = '${sha(configBytes)}'`, 'config hash');
  helper = exactReplace(helper, "$TrustConfigPath = 'C:\\Users\\fstor\\.codex\\private\\ops-access-group-read\\trust.json'",
    `$TrustConfigPath = ${psQuote(actualConfigPath)}`, 'config path');
  helper = exactReplace(helper, "$CapsulePath = 'C:\\Users\\fstor\\.codex\\private\\ops-access-group-read\\access-group-read.dpapi'",
    `$CapsulePath = ${psQuote(path.join(path.dirname(actualConfigPath), 'access-group-read.dpapi'))}`, 'capsule path');
  fs.writeFileSync(helperPath, helper, { flag: 'wx' });
  const helperHash = sha(Buffer.from(helper, 'utf8'));
  const productionModule = fs.readFileSync(new URL('./access-group-read-capsule.mjs', import.meta.url), 'utf8');
  const moduleSource = exactReplace(productionModule,
    "const UNSEALER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'access-group-read-capsule-unseal.ps1');",
    `const UNSEALER = ${JSON.stringify(helperPath)};`, 'helper path');
  fs.writeFileSync(modulePath, moduleSource, { flag: 'wx' });
  fs.writeFileSync(pinsPath,
    `export const PINNED_TRUST_CONFIG_SHA256 = '${sha(configBytes)}';\nexport const PINNED_UNSEALER_SHA256 = '${helperHash}';\n`, { flag: 'wx' });
  return { base, modulePath, token, ownerSid, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('zero production pins refuse before reading config/cipher/helper or starting PowerShell', async () => {
  assert.equal(PINNED_TRUST_CONFIG_SHA256, ZERO);
  assert.equal(PINNED_UNSEALER_SHA256, ZERO);
  await assert.rejects(loadPinnedAccessGroupReadCredential(), /access_group_capsule_not_provisioned/u);
});

test('the environment boundary strips Cloudflare credentials, Node overrides, and proxies', () => {
  const result = accessGroupCapsuleEnvironment({ PATH: 'safe', SYSTEMROOT: 'root', CLOUDFLARE_API_TOKEN: 'secret-sentinel',
    CLOUDFLARE_API_KEY: 'key-sentinel', NODE_OPTIONS: '--require evil', NODE_PATH: 'evil', HTTPS_PROXY: 'proxy',
    HTTP_PROXY: 'proxy', ALL_PROXY: 'proxy', AWS_SECRET_ACCESS_KEY: 'other-secret' });
  assert.deepEqual(result, { PATH: 'safe', SYSTEMROOT: 'root', DOTNET_CLI_TELEMETRY_OPTOUT: '1', POWERSHELL_TELEMETRY_OPTOUT: '1' });
  assert.equal(JSON.stringify(result).includes('secret-sentinel'), false);
});

test('loads only the hash-pinned synthetic CurrentUser capsule into memory', { skip: !isWindows }, async t => {
  const created = await fixture(); t.after(created.cleanup);
  const module = await import(`${pathToFileURL(created.modulePath).href}?positive`);
  const originalLog = console.log, originalError = console.error, logged = [];
  let token;
  console.log = (...values) => logged.push(values.join(' '));
  console.error = (...values) => logged.push(values.join(' '));
  try { token = await module.loadPinnedAccessGroupReadCredential(); }
  finally { console.log = originalLog; console.error = originalError; }
  assert.deepEqual(token, {schemaVersion:1,accountId:'a'.repeat(32),groupId:'11111111-1111-4111-8111-111111111111',
    groupName:'Synthetic Ops Staff',token:created.token});
  assert.equal(Object.isFrozen(token), true);
  assert.equal(process.env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(process.argv.includes(created.token), false);
  assert.deepEqual(logged, []);
  assert.doesNotMatch(fs.readFileSync(created.modulePath, 'utf8'), /console\.(?:log|error)\s*\(/u);
  // This module owns no fetch/D1 client; its only exported secret capability
  // is consumed by the fixed Access-group GET adapter, not management SQL.
  assert.doesNotMatch(fs.readFileSync(created.modulePath, 'utf8'), /D1Database|d1\/database|CLOUDFLARE_API_TOKEN/u);
});

for (const [name, options, expected] of [
  ['expired capsule', { expired: true }, 'access_group_capsule_unseal_unavailable'],
  ['tampered ciphertext', { tamperCipher: true }, 'access_group_capsule_unseal_unavailable'],
  ['plaintext fingerprint mismatch', { tamperPlainHash: true }, 'access_group_capsule_unseal_unavailable'],
  ['unexpected ACL principal', { extraAcl: true }, 'access_group_capsule_unseal_unavailable'],
  ['reparse-point parent', { reparseParent: true }, 'access_group_capsule_unseal_unavailable'],
  ['wrong provider permission', { wrongPermission: true }, 'access_group_capsule_unseal_unavailable'],
]) test(`refuses ${name} without returning secret data`, { skip: !isWindows }, async t => {
  const created = await fixture(options); t.after(created.cleanup);
  const module = await import(`${pathToFileURL(created.modulePath).href}?${name.replaceAll(' ', '-')}`);
  await assert.rejects(module.loadPinnedAccessGroupReadCredential(), new RegExp(expected));
  assert.equal(process.argv.includes(created.token), false);
});

test('source keeps the loader single-purpose and does not pass token material in args or environment', () => {
  const source = fs.readFileSync(new URL('./access-group-read-capsule.mjs', import.meta.url), 'utf8');
  assert.match(source, /spawn\(POWERSHELL, \['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',UNSEALER\]/u);
  assert.doesNotMatch(source, /\bprocess\.env\s*\[|CLOUDFLARE_API_TOKEN|D1Database|d1\/database|fetch\s*\(/u);
  const pinCheck = source.indexOf('PINNED_TRUST_CONFIG_SHA256 !== ZERO');
  const firstRead = source.indexOf('fs.lstatSync(UNSEALER)');
  const firstSpawn = source.indexOf('spawn(POWERSHELL');
  assert.ok(pinCheck >= 0 && pinCheck < firstRead && firstRead < firstSpawn);
});
