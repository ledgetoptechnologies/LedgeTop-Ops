import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

const MAX_RESPONSE = 32 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const need = (ok, code) => { if (!ok) throw new Error(code); };

async function checkedDirectory(path, create = false) {
  if (create) await mkdir(path, { recursive: true });
  let current = resolve(path);
  for (;;) {
    const info = await lstat(current);
    need(info.isDirectory() && !info.isSymbolicLink(), 'staging_inquiry_custody_path_refused');
    const canonical = await realpath(current);
    need(process.platform === 'win32' ? canonical.toLowerCase() === current.toLowerCase() : canonical === current,
      'staging_inquiry_custody_path_refused');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function ensureParents(root, directory) {
  await mkdir(root, { recursive: true });
  await checkedDirectory(root);
  const rel = relative(root, directory);
  need(rel === '' || !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel), 'staging_inquiry_custody_path_refused');
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await checkedDirectory(current);
  }
}

async function createDurableFile(path, bytes) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

// Windows-only production sealer. The response bytes cross a pipe as base64;
// PowerShell invokes CurrentUser DPAPI and writes only ciphertext to disk.
export function createWindowsDpapiSealer({ powershell = 'powershell.exe' } = {}) {
  return async ({ rawResponseBytes, destination }) => {
    need(process.platform === 'win32', 'staging_inquiry_custody_dpapi_windows_only');
    need(Buffer.isBuffer(rawResponseBytes) && rawResponseBytes.length <= MAX_RESPONSE, 'staging_inquiry_custody_response_invalid');
    const target = resolve(destination), folder = dirname(target);
    await checkedDirectory(folder);
    const command = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); try { if($b.Length -gt ${MAX_RESPONSE}) { throw 'response too large' }; $e=[Text.Encoding]::UTF8.GetBytes('LedgeTop-Ops/staging-inquiry-custody/v1'); $c=[Security.Cryptography.ProtectedData]::Protect($b,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser); $s=[IO.File]::Open('${target.replaceAll("'", "''")}',[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); try { $s.Write($c,0,$c.Length); $s.Flush($true) } finally { $s.Dispose() } } finally { [Array]::Clear($b,0,$b.Length) }`;
    const encoded = Buffer.from(`& { ${command} }`, 'utf16le').toString('base64');
    await new Promise((resolvePromise, reject) => {
      const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
      child.once('error', () => reject(new Error('staging_inquiry_custody_dpapi_failed')));
      child.once('close', code => code === 0 ? resolvePromise() : reject(new Error('staging_inquiry_custody_dpapi_failed')));
      child.stdin.end(rawResponseBytes.toString('base64'), 'utf8');
    });
    return { encrypted: true };
  };
}

export function createStagingInquiryCustody({ root, sealRaw = createWindowsDpapiSealer(), worker = 'ledgetop-ops-staging' }) {
  need(typeof root === 'string' && isAbsolute(root) && worker === 'ledgetop-ops-staging', 'staging_inquiry_custody_config_invalid');
  const base = resolve(root), workerRoot = join(base, worker);
  let claimReady, attemptStarted = false;
  async function claimWorker() {
    if (claimReady) return claimReady;
    claimReady = (async () => {
      await ensureParents(base, workerRoot);
      const claim = join(workerRoot, 'worker.claim');
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, worker, claimedAt: new Date().toISOString(), claimId: randomUUID() }) + '\n');
      try { await createDurableFile(claim, bytes); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('staging_inquiry_custody_worker_already_claimed'); throw error; }
      return claim;
    })();
    return claimReady;
  }
  return Object.freeze({
    createAttempt: async attemptId => {
      need(typeof attemptId === 'string' && UUID.test(attemptId), 'staging_inquiry_custody_attempt_invalid');
      need(!attemptStarted, 'staging_inquiry_custody_instance_already_used');
      attemptStarted = true;
      await claimWorker();
      const attempts = join(workerRoot, 'attempts'); await ensureParents(base, attempts);
      const attemptPath = join(attempts, attemptId);
      try { await mkdir(attemptPath); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('staging_inquiry_custody_attempt_exists'); throw error; }
      await checkedDirectory(attemptPath);
      const writeRecord = async (name, value) => {
        const fixed = new Set(['active-attempt.claim.json', 'attempt.intent.json', 'version-upload.intent.json',
          'version-upload.outcome.json', 'readback.outcome.json', 'upload-summary.json']);
        need(typeof name === 'string' && (fixed.has(name)
          || /^asset-[A-Za-z0-9_-]{1,96}\.(?:intent|outcome)\.json$/u.test(name)), 'staging_inquiry_custody_record_name_invalid');
        const path = join(attemptPath, name);
        need(dirname(path) === attemptPath, 'staging_inquiry_custody_path_refused');
        const data = Buffer.from(JSON.stringify(value) + '\n');
        try { await createDurableFile(path, data); }
        catch (error) { if (error.code === 'EEXIST') throw new Error('staging_inquiry_custody_record_exists'); throw error; }
        return true;
      };
      const sealResponse = async (rawResponseBytes, responseName) => {
        need(Buffer.isBuffer(rawResponseBytes) && rawResponseBytes.length <= MAX_RESPONSE
          && typeof responseName === 'string'
          && (responseName === 'version-upload.response' || /^asset-[A-Za-z0-9_-]{1,96}\.response$/u.test(responseName)),
        'staging_inquiry_custody_response_invalid');
        const responseSha256 = createHash('sha256').update(rawResponseBytes).digest('hex');
        need(HASH.test(responseSha256), 'staging_inquiry_custody_response_invalid');
        const file = `${responseName}.dpapi`, destination = join(attemptPath, file);
        const result = await sealRaw({ rawResponseBytes: Buffer.from(rawResponseBytes), destination });
        need(result?.encrypted === true, 'staging_inquiry_custody_sealer_invalid');
        const info = await lstat(destination);
        need(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0, 'staging_inquiry_custody_seal_missing');
        const ciphertext = await readFile(destination);
        need(ciphertext.length === info.size && ciphertext.length > 0, 'staging_inquiry_custody_seal_missing');
        const ciphertextSha256 = createHash('sha256').update(ciphertext).digest('hex');
        need(HASH.test(ciphertextSha256), 'staging_inquiry_custody_seal_missing');
        return Object.freeze({ verified: true, digest: ciphertextSha256 });
      };
      return Object.freeze({ attemptId, path: attemptPath, record: writeRecord, seal: sealResponse });
    },
  });
}
