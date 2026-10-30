import { createHash, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTrustConfig } from './native-staff-bootstrap-owner-approval.mjs';

export const TRUST_CANDIDATE_INPUT_KIND = 'operations-native-staff-bootstrap-trust-candidate-input-v1';
export const TRUST_CANDIDATE_STATUS = 'draft-not-approved';
const HASH = /^[0-9a-f]{64}$/u;
const fail = code => { throw new Error(`native_staff_bootstrap_trust_candidate_${code}`); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const exactObject = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));

const INPUT_KEYS = ['schemaVersion', 'kind', 'target', 'source', 'access', 'receiptDirectory'];

/** Validate independently supplied operator facts; no snapshots or identity inference are accepted. */
export function validateNativeStaffBootstrapTrustCandidateInput(input) {
  if (!exactObject(input, INPUT_KEYS) || input.schemaVersion !== 1 || input.kind !== TRUST_CANDIDATE_INPUT_KIND
    || !exactObject(input.target, ['accountId', 'databaseId'])
    || typeof input.target.accountId !== 'string' || !/^[a-f0-9]{32}$/u.test(input.target.accountId)
    || typeof input.target.databaseId !== 'string' || !/^[a-f0-9-]{36}$/u.test(input.target.databaseId)
    || !exactObject(input.source, ['commit', 'migrationNamesSha256'])
    || typeof input.source.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(input.source.commit)
    || typeof input.source.migrationNamesSha256 !== 'string' || !HASH.test(input.source.migrationNamesSha256)
    || !exactObject(input.access, ['origin', 'issuer', 'audience', 'owner', 'cloudflaredExecutablePath', 'cloudflaredExecutableSha256'])
    || !exactObject(input.access.owner, ['staffId', 'accessSubject'])
    || typeof input.access.owner.staffId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u.test(input.access.owner.staffId)
    || typeof input.access.owner.accessSubject !== 'string' || !input.access.owner.accessSubject.trim()
    || input.access.owner.accessSubject.length > 191
    || typeof input.access.origin !== 'string' || typeof input.access.issuer !== 'string'
    || typeof input.access.audience !== 'string' || typeof input.access.cloudflaredExecutablePath !== 'string'
    || !/^[A-Za-z0-9_-]{16,128}$/u.test(input.access.audience)
    || !path.win32.isAbsolute(input.access.cloudflaredExecutablePath)
    || typeof input.access.cloudflaredExecutableSha256 !== 'string' || !HASH.test(input.access.cloudflaredExecutableSha256)
    || typeof input.receiptDirectory !== 'string' || !path.win32.isAbsolute(input.receiptDirectory))
    fail('input_invalid');
  try {
    const origin = new URL(input.access.origin), issuer = new URL(input.access.issuer);
    if (origin.protocol !== 'https:' || origin.origin !== input.access.origin || origin.username || origin.password
      || origin.port || origin.pathname !== '/' || origin.search || origin.hash
      || issuer.protocol !== 'https:' || issuer.origin !== input.access.issuer || issuer.username || issuer.password
      || issuer.port || issuer.pathname !== '/' || issuer.search || issuer.hash
      || !issuer.hostname.endsWith('.cloudflareaccess.com') || issuer.hostname === '.cloudflareaccess.com')
      fail('input_invalid');
  } catch { fail('input_invalid'); }
  return input;
}

function readOperatorInput(inputPath) {
  let info, fd, before, after, afterPath, bytes;
  try {
    info = lstatSync(inputPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > 32 * 1024)
      fail('input_invalid');
    fd = openSync(inputPath, 'r');
    before = fstatSync(fd);
    bytes = readFileSync(fd);
    after = fstatSync(fd);
    afterPath = lstatSync(inputPath);
  } catch (error) {
    if (error instanceof Error && error.message === 'native_staff_bootstrap_trust_candidate_input_invalid') throw error;
    fail('input_unavailable');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!before.isFile() || before.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino
    || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size
    || afterPath.isSymbolicLink() || afterPath.dev !== before.dev || afterPath.ino !== before.ino)
    fail('input_invalid');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('input_invalid'); }
  return validateNativeStaffBootstrapTrustCandidateInput(value);
}

function powershellRequest(operation, request, { spawn = spawnSync } = {}) {
  if (process.platform !== 'win32') fail('windows_required');
  const script = fileURLToPath(new URL('./native-staff-bootstrap-trust-candidate.ps1', import.meta.url));
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PSHOME', 'USERPROFILE', 'APPDATA',
    'LOCALAPPDATA', 'TEMP', 'TMP', 'HOME'].filter(key => typeof process.env[key] === 'string' && process.env[key].length > 0)
    .map(key => [key, process.env[key]]));
  const result = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script], {
    input: JSON.stringify({ operation, ...request }), encoding: 'utf8', windowsHide: true, timeout: 30_000,
    maxBuffer: 256 * 1024, stdio: ['pipe', 'pipe', 'pipe'], env,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    const code = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    if (/^native_staff_bootstrap_trust_candidate_[a-z0-9_]+$/u.test(code)) fail(code.slice('native_staff_bootstrap_trust_candidate_'.length));
    fail('windows_helper_failed');
  }
  let output;
  try { output = JSON.parse(result.stdout); } catch { fail('windows_helper_failed'); }
  return output;
}

function createCandidateConfig(input, { directoryPath, signer }) {
  const config = {
    schemaVersion: 1,
    kind: 'operations-native-staff-bootstrap-trust-config-v1',
    target: { ...input.target },
    source: { ...input.source },
    access: { ...input.access, owner: { ...input.access.owner } },
    signer: {
      algorithm: 'RSA-PSS-SHA256',
      keyId: signer.keyId,
      publicKeyPem: signer.publicKeyPem,
      protectedPrivateKeyPath: path.win32.join(directoryPath, 'signer-key.dpapi'),
      dpapiEntropy: signer.dpapiEntropy,
    },
    receiptDirectory: input.receiptDirectory,
  };
  const configBytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const configSha256 = sha256(configBytes);
  try { parseTrustConfig(configBytes.toString('utf8'), configSha256); }
  catch { fail('candidate_config_contract_invalid'); }
  return { configBytes, configSha256 };
}

/**
 * Explicit candidate creation API. This writes only DPAPI-protected key bytes
 * plus an unapproved config and review marker; it does not change any trust pin,
 * registry, configured path, owner state, or approval.
 */
export function createNativeStaffBootstrapTrustCandidate(input, { candidateParent } = {}) {
  validateNativeStaffBootstrapTrustCandidateInput(input);
  if (process.platform !== 'win32') fail('windows_required');
  if (typeof candidateParent !== 'string' || !path.win32.isAbsolute(candidateParent)) fail('candidate_parent_invalid');
  let parentInfo;
  try { parentInfo = lstatSync(candidateParent); } catch { fail('candidate_parent_unavailable'); }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) fail('candidate_parent_invalid');

  const candidateId = randomUUID();
  const directoryPath = path.win32.join(candidateParent, `native-staff-bootstrap-trust-candidate-${candidateId}`);
  const entropy = randomBytes(32);
  const dpapiEntropy = entropy.toString('base64url');
  let protectedKeyBytes;
  try {
    const generated = powershellRequest('generate', { dpapiEntropy });
    if (!exactObject(generated, ['publicKeyPem', 'keyId', 'protectedPrivateKeyBase64'])
      || typeof generated.publicKeyPem !== 'string' || !HASH.test(generated.keyId ?? '')
      || typeof generated.protectedPrivateKeyBase64 !== 'string'
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(generated.protectedPrivateKeyBase64)) fail('windows_helper_failed');
    const publicKey = createPublicKeyFromPem(generated.publicKeyPem);
    if (publicKey.modulusLength < 3072 || sha256(publicKey.spkiDer) !== generated.keyId) fail('windows_helper_failed');
    protectedKeyBytes = Buffer.from(generated.protectedPrivateKeyBase64, 'base64');
    if (protectedKeyBytes.length < 64 || protectedKeyBytes.length > 16 * 1024) fail('windows_helper_failed');
    const configResult = createCandidateConfig(input, { directoryPath, signer: {
      ...generated, dpapiEntropy,
    } });
    const reviewBytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1,
      kind: 'operations-native-staff-bootstrap-trust-candidate-review-v1', status: TRUST_CANDIDATE_STATUS,
      configSha256: configResult.configSha256, keyId: generated.keyId,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`, 'utf8');
    const persisted = powershellRequest('create-candidate', {
      directoryPath,
      configJson: configResult.configBytes.toString('utf8'),
      configSha256: configResult.configSha256,
      reviewJson: reviewBytes.toString('utf8'),
      protectedPrivateKeyBase64: generated.protectedPrivateKeyBase64,
      keyId: generated.keyId,
    });
    if (!exactObject(persisted, ['created']) || persisted.created !== true) fail('candidate_persistence_failed');
    return Object.freeze({ status: TRUST_CANDIDATE_STATUS, keyId: generated.keyId,
      configSha256: configResult.configSha256, directoryPath,
      configPath: path.win32.join(directoryPath, 'trust-config.candidate.json'),
      protectedPrivateKeyPath: path.win32.join(directoryPath, 'signer-key.dpapi'),
      reviewPath: path.win32.join(directoryPath, 'candidate-review.json') });
  } finally {
    entropy.fill(0);
    protectedKeyBytes?.fill(0);
  }
}

function createPublicKeyFromPem(publicKeyPem) {
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'rsa') fail('windows_helper_failed');
    return { modulusLength: key.asymmetricKeyDetails?.modulusLength ?? 0,
      spkiDer: key.export({ type: 'spki', format: 'der' }) };
  } catch { fail('windows_helper_failed'); }
}

export function validateNativeStaffBootstrapTrustCandidateFile(inputPath) {
  readOperatorInput(path.resolve(inputPath));
  return Object.freeze({ status: 'input-valid-candidate-not-created' });
}

function main(argv) {
  if (argv.length === 2 && argv[0] === '--validate') {
    const result = validateNativeStaffBootstrapTrustCandidateFile(argv[1]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (argv.length === 2 && argv[0] === '--create-candidate' && argv[1]) {
    const input = readOperatorInput(path.resolve(argv[1]));
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData || !path.win32.isAbsolute(localAppData)) fail('candidate_parent_unavailable');
    const result = createNativeStaffBootstrapTrustCandidate(input, { candidateParent: localAppData });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write('Usage: node scripts/native-staff-bootstrap-trust-candidate.mjs --validate <operator-input.json>\n'
    + '       node scripts/native-staff-bootstrap-trust-candidate.mjs --create-candidate <operator-input.json>\n'
    + 'Default behavior validates only; candidate creation is explicitly opt-in.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    const code = error instanceof Error && /^native_staff_bootstrap_trust_candidate_[a-z0-9_]+$/u.test(error.message)
      ? error.message : 'native_staff_bootstrap_trust_candidate_unavailable';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
