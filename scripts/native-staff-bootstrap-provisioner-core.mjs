import { createHash, constants, createPublicKey, randomUUID, verify as verifySignature } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseTrustConfig, assertPinnedInstallerSource, protectedSign,
  PINNED_TRUST_CONFIG_SHA256, initializeNativeStaffBootstrapApprovalRegistry,
  readNativeStaffBootstrapApprovalRegistry, canonicalJson } from './native-staff-bootstrap-owner-approval.mjs';
import { assertPinnedNativeStaffBootstrapProvisionerPackage } from './native-staff-bootstrap-provisioner-package.mjs';
import { createNativeStaffBootstrapProvisionerWindowsAdapter } from './native-staff-bootstrap-provisioner-windows-adapter.mjs';
import { PINNED_NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_SHA256,
  PINNED_NATIVE_STAFF_BOOTSTRAP_CONFIG_SHA256, PINNED_NATIVE_STAFF_BOOTSTRAP_RECEIPT_DIRECTORY }
  from './native-staff-bootstrap-provisioner-pin-value.mjs';

export const NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_MANIFEST =
  'scripts/native-staff-bootstrap-provisioner-package-manifest.json';
export const NATIVE_STAFF_BOOTSTRAP_PROVISIONER_CONFIG_RELATIVE_PATH =
  path.win32.join('LedgeTop', 'native-staff-bootstrap', 'trust-config.json');
export const NATIVE_STAFF_BOOTSTRAP_PROVISIONER_JOURNAL_NAME = 'native-staff-bootstrap-provisioning-attempt.json';
const MAX_CONFIG_BYTES = 32 * 1024;
const HASH = /^[0-9a-f]{64}$/u;
const fail = code => { throw new Error(`native_staff_bootstrap_provisioner_${code}`); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Reject duplicate members before JSON.parse can apply last-key-wins behavior.
function assertUniqueJsonMembers(text) {
  let i = 0, depth = 0;
  const ws = () => { while (/[\u0009\u000a\u000d\u0020]/u.test(text[i] ?? '')) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    fail('candidate_json_invalid');
  };
  const value = () => {
    ws();
    if (++depth > 16) fail('candidate_json_invalid');
    const c = text[i];
    if (c === '{') {
      i++; ws(); const seen = new Set();
      if (text[i] !== '}') for (;;) {
        ws(); if (text[i] !== '"') fail('candidate_json_invalid');
        const key = string(); if (seen.has(key)) fail('candidate_duplicate_key'); seen.add(key);
        ws(); if (text[i++] !== ':') fail('candidate_json_invalid'); value(); ws();
        if (text[i] === '}') break;
        if (text[i++] !== ',') fail('candidate_json_invalid');
      }
      if (text[i++] !== '}') fail('candidate_json_invalid');
    } else if (c === '[') {
      i++; ws();
      if (text[i] !== ']') for (;;) {
        value(); ws(); if (text[i] === ']') break;
        if (text[i++] !== ',') fail('candidate_json_invalid');
      }
      if (text[i++] !== ']') fail('candidate_json_invalid');
    } else if (c === '"') string();
    else {
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(i));
      if (!match) fail('candidate_json_invalid'); i += match[0].length;
    }
    depth--;
  };
  value(); ws(); if (i !== text.length) fail('candidate_json_invalid');
}

export function decodePinnedNativeStaffBootstrapConfig(bytes, expectedSha256, expectedReceiptDirectory) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_CONFIG_BYTES
    || !HASH.test(expectedSha256 ?? '') || sha256(bytes) !== expectedSha256
    || typeof expectedReceiptDirectory !== 'string' || !path.win32.isAbsolute(expectedReceiptDirectory))
    fail('candidate_pin_mismatch');
  let text, config;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail('candidate_utf8_invalid'); }
  assertUniqueJsonMembers(text);
  try { config = parseTrustConfig(text, expectedSha256); }
  catch { fail('candidate_config_invalid'); }
  if (path.win32.normalize(config.receiptDirectory).toLowerCase()
      !== path.win32.normalize(expectedReceiptDirectory).toLowerCase()) fail('receipt_path_pin_mismatch');
  return Object.freeze({ text, config, configSha256: expectedSha256 });
}

export function verifyEmptyRegistrySignature(config, payloadJson, signature) {
  if (typeof payloadJson !== 'string' || typeof signature !== 'string'
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(signature)) fail('preflight_signature_invalid');
  let publicKey;
  try { publicKey = createPublicKey(config.signer.publicKeyPem); } catch { fail('preflight_key_invalid'); }
  if (!verifySignature('sha256', Buffer.from(payloadJson),
    { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(signature, 'base64')))
    fail('preflight_signature_invalid');
  return true;
}

function readCandidateBytes(file) {
  let fd, before, after, pathInfo, bytes;
  try {
    pathInfo = lstatSync(file);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1
      || pathInfo.size < 1 || pathInfo.size > MAX_CONFIG_BYTES) fail('candidate_invalid');
    fd = openSync(file, 'r'); before = fstatSync(fd); bytes = readFileSync(fd); after = fstatSync(fd);
    const finalPath = lstatSync(file);
    if (!before.isFile() || before.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size
      || finalPath.isSymbolicLink() || finalPath.dev !== before.dev || finalPath.ino !== before.ino) fail('candidate_invalid');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('native_staff_bootstrap_provisioner_')) throw error;
    fail('candidate_unavailable');
  } finally { if (fd !== undefined) closeSync(fd); }
  return bytes;
}

function fixedPaths(localAppData, config) {
  if (typeof localAppData !== 'string' || !path.win32.isAbsolute(localAppData)) fail('local_app_data_unavailable');
  const configPath = path.win32.join(localAppData, NATIVE_STAFF_BOOTSTRAP_PROVISIONER_CONFIG_RELATIVE_PATH);
  if (path.win32.normalize(configPath).toLowerCase()
    !== path.win32.normalize(path.win32.join(localAppData, 'LedgeTop', 'native-staff-bootstrap', 'trust-config.json')).toLowerCase())
    fail('config_destination_invalid');
  const expectedReceiptDirectory = PINNED_NATIVE_STAFF_BOOTSTRAP_RECEIPT_DIRECTORY;
  if (path.win32.normalize(config.receiptDirectory).toLowerCase()
    !== path.win32.normalize(expectedReceiptDirectory).toLowerCase()) fail('receipt_destination_invalid');
  const receiptRelativePath = path.win32.relative(localAppData, config.receiptDirectory);
  if (!receiptRelativePath || receiptRelativePath === '.' || path.win32.isAbsolute(receiptRelativePath)
    || receiptRelativePath === '..' || receiptRelativePath.startsWith('..\\')) fail('receipt_destination_invalid');
  return Object.freeze({ configPath, receiptDirectory: config.receiptDirectory,
    protectedPrivateKeyPath: config.signer.protectedPrivateKeyPath,
    journalPath: path.win32.join(localAppData, NATIVE_STAFF_BOOTSTRAP_PROVISIONER_JOURNAL_NAME),
    lockPath: path.win32.join(localAppData, 'native-staff-bootstrap-provisioning.lock') });
}

export function runNativeStaffBootstrapProvisioningWorkflow({ candidateBytes, config, configSha256, paths,
  adapter, packageSha256 = '0'.repeat(64), sourceVerifier = assertPinnedInstallerSource, sign = protectedSign,
  initialize = initializeNativeStaffBootstrapApprovalRegistry, readRegistry = readNativeStaffBootstrapApprovalRegistry,
  now = () => new Date().toISOString() }) {
  if (!adapter || typeof adapter.preflight !== 'function' || typeof adapter.begin !== 'function'
    || typeof adapter.installConfigNoReplace !== 'function' || typeof adapter.createReceiptDirectory !== 'function'
    || typeof adapter.advanceJournal !== 'function' || typeof adapter.publishInitialRegistryNoReplace !== 'function'
    || typeof adapter.verifyPublishedRegistry !== 'function'
    || typeof adapter.finish !== 'function' || typeof adapter.failClosed !== 'function') fail('adapter_unavailable');
  const verified = decodePinnedNativeStaffBootstrapConfig(candidateBytes, configSha256, paths.receiptDirectory);
  if (canonicalJson(config) !== canonicalJson(verified.config)) fail('config_changed');
  sourceVerifier(config);
  adapter.preflight(paths);
  const payload = { schemaVersion: 1, sequence: 0, previousStateSha256: null, entries: [] };
  const payloadJson = canonicalJson(payload);
  const signature = sign(payloadJson, config);
  verifyEmptyRegistrySignature(config, payloadJson, signature);
  const { protectedPrivateKeyPath: _protectedPrivateKeyPath, ...journalPaths } = paths;
  adapter.begin({ ...journalPaths, packageSha256,
    configSha256, sourceCommit: config.source.commit,
    initialPayloadSha256: sha256(Buffer.from(payloadJson)), startedAt: now(), operationId: randomUUID() });
  try {
    adapter.installConfigNoReplace(paths.configPath, candidateBytes, configSha256);
    adapter.advanceJournal('config-published');
    adapter.createReceiptDirectory(paths.receiptDirectory);
    adapter.advanceJournal('receipt-directory-created');
    const state = initialize(config, (receivedPayload, receivedConfig) => {
      if (receivedConfig !== config || receivedPayload !== payloadJson) fail('unexpected_registry_payload');
      return signature;
    }, { publishNoReplace: adapter.publishInitialRegistryNoReplace, preserveFailureArtifacts: true });
    const verifiedState = readRegistry(config);
    if (verifiedState.envelope.payload.sequence !== 0 || verifiedState.envelope.payload.previousStateSha256 !== null
      || verifiedState.envelope.payload.entries.length !== 0 || verifiedState.stateSha256 !== state.stateSha256)
      fail('initial_registry_mismatch');
    const published = adapter.verifyPublishedRegistry(path.win32.join(paths.receiptDirectory, 'approval-state.json'));
    if (!published || !HASH.test(published.registryRawSha256 ?? '')) fail('registry_readback_invalid');
    const receipt = adapter.finish({ configSha256, registryStateSha256: verifiedState.stateSha256,
      registryRawSha256: published.registryRawSha256 });
    return Object.freeze({ configSha256, registryStateSha256: verifiedState.stateSha256,
      registryRawSha256: published.registryRawSha256, receipt });
  } catch (error) {
    try { adapter.failClosed(error?.message ?? 'provisioning_failed'); } catch {}
    throw error;
  }
}

export function reconcileNativeStaffBootstrapProvisioningReadOnly(adapter, input) {
  if (!adapter || typeof adapter.reconcileReadOnly !== 'function') fail('adapter_unavailable');
  return adapter.reconcileReadOnly(input);
}

function provisionNativeStaffBootstrapIssuer({ candidateBytes, config, configSha256, paths }) {
  if (PINNED_NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_SHA256 === '0'.repeat(64)) fail('package_pin_not_provisioned');
  if (PINNED_NATIVE_STAFF_BOOTSTRAP_CONFIG_SHA256 === '0'.repeat(64)
    || PINNED_NATIVE_STAFF_BOOTSTRAP_CONFIG_SHA256 !== PINNED_TRUST_CONFIG_SHA256
    || configSha256 !== PINNED_NATIVE_STAFF_BOOTSTRAP_CONFIG_SHA256
    || path.win32.normalize(paths.receiptDirectory).toLowerCase()
      !== path.win32.normalize(PINNED_NATIVE_STAFF_BOOTSTRAP_RECEIPT_DIRECTORY).toLowerCase())
    fail('config_pin_not_provisioned');
  assertPinnedNativeStaffBootstrapProvisionerPackage();
  const adapter = createNativeStaffBootstrapProvisionerWindowsAdapter();
  return runNativeStaffBootstrapProvisioningWorkflow({ candidateBytes, config, configSha256, paths, adapter,
    packageSha256: PINNED_NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_SHA256 });
}

export function runNativeStaffBootstrapProvisioner(argv) {
  // The all-zero package pin is checked before argument parsing, candidate reads,
  // filesystem adapter calls, source checks, or DPAPI signing.
  if (PINNED_NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_SHA256 === '0'.repeat(64))
    fail('package_pin_not_provisioned');
  assertPinnedNativeStaffBootstrapProvisionerPackage();
  if (argv.length === 1 && argv[0] === '--reconcile') {
    return reconcileNativeStaffBootstrapProvisioningReadOnly(createNativeStaffBootstrapProvisionerWindowsAdapter(),
      { localAppData: process.env.LOCALAPPDATA,
      receiptDirectory: PINNED_NATIVE_STAFF_BOOTSTRAP_RECEIPT_DIRECTORY });
  }
  if (PINNED_NATIVE_STAFF_BOOTSTRAP_CONFIG_SHA256 === '0'.repeat(64)
    || PINNED_NATIVE_STAFF_BOOTSTRAP_CONFIG_SHA256 !== PINNED_TRUST_CONFIG_SHA256
    || !path.win32.isAbsolute(PINNED_NATIVE_STAFF_BOOTSTRAP_RECEIPT_DIRECTORY)) fail('config_pin_not_provisioned');
  if (argv.length !== 3 || argv[0] !== '--provision' || argv[1] !== '--candidate'
    || typeof argv[2] !== 'string') fail('usage');
  const bytes = readCandidateBytes(path.resolve(argv[2]));
  const { config } = decodePinnedNativeStaffBootstrapConfig(bytes, PINNED_NATIVE_STAFF_BOOTSTRAP_CONFIG_SHA256,
    PINNED_NATIVE_STAFF_BOOTSTRAP_RECEIPT_DIRECTORY);
  const paths = fixedPaths(process.env.LOCALAPPDATA, config);
  const result = provisionNativeStaffBootstrapIssuer({ candidateBytes: bytes, config,
    configSha256: PINNED_NATIVE_STAFF_BOOTSTRAP_CONFIG_SHA256, paths });
  return result;
}
