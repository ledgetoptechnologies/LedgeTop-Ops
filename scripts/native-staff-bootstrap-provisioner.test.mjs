import assert from 'node:assert/strict';
import { constants, createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { constants as fsConstants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson, initializeNativeStaffBootstrapApprovalRegistry,
  PINNED_TRUST_CONFIG_SHA256 } from './native-staff-bootstrap-owner-approval.mjs';
import { assertPinnedNativeStaffBootstrapProvisionerPackage,
  NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_FILES } from './native-staff-bootstrap-provisioner-package.mjs';
import { decodePinnedNativeStaffBootstrapConfig, runNativeStaffBootstrapProvisioner,
  reconcileNativeStaffBootstrapProvisioningReadOnly, runNativeStaffBootstrapProvisioningWorkflow,
  verifyEmptyRegistrySignature } from './native-staff-bootstrap-provisioner-core.mjs';
import { readNativeStaffBootstrapApprovalRegistry } from './native-staff-bootstrap-owner-approval.mjs';
import { PINNED_NATIVE_STAFF_BOOTSTRAP_CONFIG_SHA256,
  PINNED_NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_SHA256,
  PINNED_NATIVE_STAFF_BOOTSTRAP_RECEIPT_DIRECTORY } from './native-staff-bootstrap-provisioner-pin-value.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  const syntheticRoot = path.join(path.parse(os.tmpdir()).root, 'synthetic');
  const config = {
    schemaVersion: 1, kind: 'operations-native-staff-bootstrap-trust-config-v1',
    target: { accountId: 'a'.repeat(32), databaseId: '11111111-1111-4111-8111-111111111111' },
    source: { commit: 'b'.repeat(40), migrationNamesSha256: 'c'.repeat(64) },
    access: { origin: 'https://ops.example.test', issuer: 'https://synthetic.cloudflareaccess.com',
      audience: 'syntheticAudience01', owner: { staffId: 'synthetic-owner', accessSubject: 'synthetic-subject' },
      cloudflaredExecutablePath: path.join(syntheticRoot, 'cloudflared.exe'), cloudflaredExecutableSha256: 'd'.repeat(64) },
    signer: { algorithm: 'RSA-PSS-SHA256', keyId: hash(publicDer), publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      protectedPrivateKeyPath: path.join(syntheticRoot, 'candidate', 'signer-key.dpapi'),
      dpapiEntropy: 'synthetic-only-entropy-for-provisioner-tests-32-bytes' },
    receiptDirectory: path.join(syntheticRoot, 'AppData', 'Local', 'native-staff-bootstrap-receipts-synthetic'),
  };
  const bytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const payloadJson = canonicalJson({ schemaVersion: 1, sequence: 0, previousStateSha256: null, entries: [] });
  const signature = signBytes('sha256', Buffer.from(payloadJson), { key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64');
  return { config, bytes, payloadJson, signature, privateKey };
}

test('CLI provisioner stays blocked on independent zero package pin before candidate or adapter access', () => {
  assert.equal(PINNED_NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_SHA256, '0'.repeat(64));
  assert.equal(PINNED_NATIVE_STAFF_BOOTSTRAP_CONFIG_SHA256, '0'.repeat(64));
  assert.equal(PINNED_NATIVE_STAFF_BOOTSTRAP_RECEIPT_DIRECTORY, '');
  assert.equal(PINNED_TRUST_CONFIG_SHA256, '0'.repeat(64));
  assert.throws(() => runNativeStaffBootstrapProvisioner(['--candidate', 'Z:\\missing\\candidate.json']),
    /native_staff_bootstrap_provisioner_package_pin_not_provisioned/u);
});

test('package manifest verifier requires its separate pin before reading and checks exact file bytes synthetically', () => {
  let reads = 0;
  assert.throws(() => assertPinnedNativeStaffBootstrapProvisionerPackage({
    read() { reads++; throw new Error('unexpected read'); }, stat() { reads++; throw new Error('unexpected stat'); },
  }), /package_pin_not_provisioned/u);
  assert.equal(reads, 0);

  const root = mkdtempSync(path.join(os.tmpdir(), 'native-issuer-provisioner-package-'));
  try {
    const files = [...NATIVE_STAFF_BOOTSTRAP_PROVISIONER_PACKAGE_FILES].sort().map((relative, index) => {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      const bytes = Buffer.from(`synthetic provisioner package file ${index}`);
      writeFileSync(target, bytes);
      return { path: relative, sha256: hash(bytes) };
    });
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1,
      kind: 'operations-native-staff-bootstrap-provisioner-package-v1', files }));
    const manifestPath = path.join(root, 'scripts/native-staff-bootstrap-provisioner-package-manifest.json');
    writeFileSync(manifestPath, manifest);
    assert.equal(assertPinnedNativeStaffBootstrapProvisionerPackage({ root, expectedSha256: hash(manifest) }), true);
    writeFileSync(path.join(root, files[0].path), 'changed synthetic file');
    assert.throws(() => assertPinnedNativeStaffBootstrapProvisionerPackage({ root, expectedSha256: hash(manifest) }),
      /package_file_mismatch/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pinned config decoding rejects duplicate keys, invalid UTF-8, hash changes and an alternate receipt path', () => {
  const { config, bytes } = fixture();
  for (const candidatePath of [config.access.cloudflaredExecutablePath,
    config.signer.protectedPrivateKeyPath, config.receiptDirectory]) {
    assert.equal(path.isAbsolute(candidatePath), true);
    assert.equal(path.win32.isAbsolute(candidatePath), true);
  }
  const configSha256 = hash(bytes);
  assert.equal(decodePinnedNativeStaffBootstrapConfig(bytes, configSha256, config.receiptDirectory).config.signer.keyId,
    config.signer.keyId);

  const duplicateText = bytes.toString('utf8').replace('"schemaVersion": 1,',
    '"schemaVersion": 1,\n  "schemaVersion": 1,');
  const duplicateBytes = Buffer.from(duplicateText);
  assert.throws(() => decodePinnedNativeStaffBootstrapConfig(duplicateBytes, hash(duplicateBytes), config.receiptDirectory),
    /candidate_duplicate_key/u);
  const invalidUtf8 = Buffer.concat([bytes, Buffer.from([0xff])]);
  assert.throws(() => decodePinnedNativeStaffBootstrapConfig(invalidUtf8, hash(invalidUtf8), config.receiptDirectory),
    /candidate_utf8_invalid/u);
  assert.throws(() => decodePinnedNativeStaffBootstrapConfig(bytes, '0'.repeat(64), config.receiptDirectory),
    /candidate_pin_mismatch/u);
  assert.throws(() => decodePinnedNativeStaffBootstrapConfig(bytes, configSha256, 'C:\\Synthetic\\other'),
    /receipt_path_pin_mismatch/u);
});

test('empty-state preflight signature is verified with the candidate public key', () => {
  const { config, payloadJson, signature } = fixture();
  assert.equal(verifyEmptyRegistrySignature(config, payloadJson, signature), true);
  assert.throws(() => verifyEmptyRegistrySignature(config, `${payloadJson} `, signature),
    /preflight_signature_invalid/u);
  assert.throws(() => verifyEmptyRegistrySignature(config, payloadJson, Buffer.alloc(384, 9).toString('base64')),
    /preflight_signature_invalid/u);
});

test('pinned initializer publisher gets exact empty state and failed publication preserves temp and lock', () => {
  const { config, privateKey } = fixture();
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-issuer-provisioner-init-'));
  config.receiptDirectory = directory;
  const sign = payload => signBytes('sha256', Buffer.from(payload), { key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64');
  try {
    const result = initializeNativeStaffBootstrapApprovalRegistry(config, sign, { publishNoReplace(temporary, state) {
      assert.equal(path.dirname(temporary), directory);
      assert.equal(state, path.join(directory, 'approval-state.json'));
      assert.equal(lstatSync(state, { throwIfNoEntry: false }), undefined);
      copyFileSync(temporary, state, 1);
      unlinkSync(temporary);
    } });
    assert.equal(result.envelope.payload.sequence, 0);
    assert.equal(readdirSync(directory).join(), 'approval-state.json');
  } finally { rmSync(directory, { recursive: true, force: true }); }

  const failedDirectory = mkdtempSync(path.join(os.tmpdir(), 'native-issuer-provisioner-failure-'));
  config.receiptDirectory = failedDirectory;
  try {
    assert.throws(() => initializeNativeStaffBootstrapApprovalRegistry(config, sign, {
      preserveFailureArtifacts: true, publishNoReplace() { throw new Error('synthetic no-replace failure'); },
    }), /approval_registry_write_failed/u);
    const entries = readdirSync(failedDirectory);
    assert.equal(entries.some(name => name === 'approval-state.json'), false);
    assert.equal(entries.some(name => name === 'approval-state.lock'), true);
    assert.equal(entries.some(name => name.endsWith('.tmp')), true);
  } finally { rmSync(failedDirectory, { recursive: true, force: true }); }

  const malformedDirectory = mkdtempSync(path.join(os.tmpdir(), 'native-issuer-provisioner-bad-signature-'));
  config.receiptDirectory = malformedDirectory;
  try {
    assert.throws(() => initializeNativeStaffBootstrapApprovalRegistry(config,
      () => Buffer.alloc(384, 0x41).toString('base64')), /approval_registry_signature_invalid/u);
    assert.deepEqual(readdirSync(malformedDirectory), []);
  } finally { rmSync(malformedDirectory, { recursive: true, force: true }); }
});

test('synthetic workflow provisions with exact signer callback contract; failed phases retain evidence and reconcile is read-only', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-issuer-provisioner-flow-'));
  const { config, privateKey } = fixture();
  const receiptDirectory = path.join(root, 'native-staff-bootstrap-receipts-7f4f');
  config.receiptDirectory = receiptDirectory;
  const bytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
  const configSha256 = hash(bytes);
  const configPath = path.join(root, 'LedgeTop', 'native-staff-bootstrap', 'trust-config.json');
  const paths = { configPath, receiptDirectory, protectedPrivateKeyPath: 'C:\\Synthetic\\key.dpapi',
    journalPath: path.join(root, 'native-staff-bootstrap-provisioning-attempt.json'),
    lockPath: path.join(root, 'native-staff-bootstrap-provisioning.lock') };
  const sign = payload => signBytes('sha256', Buffer.from(payload), { key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64');
  const events = [];
  const adapter = {
    preflight(received) { assert.equal(received, paths); events.push('preflight'); },
    begin(intent) { assert.equal(intent.configSha256, configSha256); events.push('intent-durable'); },
    installConfigNoReplace(destination, content, expected) {
      assert.equal(destination, configPath); assert.equal(hash(content), expected);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, content, { flag: 'wx' }); events.push('config-published');
    },
    advanceJournal(phase) { events.push(phase); },
    createReceiptDirectory(destination) { mkdirSync(destination); events.push('receipt-created'); },
    publishInitialRegistryNoReplace(temporary, destination) {
      copyFileSync(temporary, destination, fsConstants.COPYFILE_EXCL); unlinkSync(temporary);
      events.push('registry-published');
    },
    verifyPublishedRegistry(destination) { return { registryRawSha256: hash(readFileSync(destination)) }; },
    finish(result) { events.push('complete'); return { complete: true, ...result }; },
    failClosed(reason) { events.push(`failed:${reason}`); },
  };
  try {
    const result = runNativeStaffBootstrapProvisioningWorkflow({ candidateBytes: bytes, config, configSha256,
      paths, adapter, packageSha256: 'e'.repeat(64), sourceVerifier: () => events.push('source-verified'), sign });
    assert.equal(result.receipt.complete, true);
    assert.deepEqual(events, ['source-verified', 'preflight', 'intent-durable', 'config-published',
      'config-published', 'receipt-created', 'receipt-directory-created', 'registry-published', 'complete']);
    assert.deepEqual(readNativeStaffBootstrapApprovalRegistry(config).envelope.payload.entries, []);

    const failedRoot = mkdtempSync(path.join(os.tmpdir(), 'native-issuer-provisioner-failed-phase-'));
    try {
      const failedConfig = { ...config, receiptDirectory: path.join(failedRoot, 'native-staff-bootstrap-receipts-fail') };
      const failedBytes = Buffer.from(`${JSON.stringify(failedConfig, null, 2)}\n`);
      const failedPaths = { ...paths, configPath: path.join(failedRoot, 'LedgeTop', 'native-staff-bootstrap', 'trust-config.json'),
        receiptDirectory: failedConfig.receiptDirectory, journalPath: path.join(failedRoot, 'attempt.json'),
        lockPath: path.join(failedRoot, 'attempt.lock') };
      const failedEvents = [];
      const failedAdapter = { ...adapter, preflight() { failedEvents.push('preflight'); },
        begin() { writeFileSync(failedPaths.journalPath, 'synthetic durable intent'); failedEvents.push('intent'); },
        installConfigNoReplace() { throw new Error('synthetic config publication failure'); },
        failClosed(message) { failedEvents.push(message); } };
      assert.throws(() => runNativeStaffBootstrapProvisioningWorkflow({ candidateBytes: failedBytes,
        config: failedConfig, configSha256: hash(failedBytes), paths: failedPaths, adapter: failedAdapter,
        sourceVerifier: () => {}, sign }), /synthetic config publication failure/u);
      assert.equal(readdirSync(failedRoot).includes('attempt.json'), true);
      assert.deepEqual(failedEvents, ['preflight', 'intent', 'synthetic config publication failure']);
      assert.equal(lstatSync(failedPaths.configPath, { throwIfNoEntry: false }), undefined);
      assert.equal(lstatSync(failedPaths.receiptDirectory, { throwIfNoEntry: false }), undefined);
    } finally { rmSync(failedRoot, { recursive: true, force: true }); }

    let reconcileWrites = 0;
    const reconciled = reconcileNativeStaffBootstrapProvisioningReadOnly({ reconcileReadOnly(input) {
      reconcileWrites++; return { readOnly: true, phase: 'incomplete', input };
    } }, { receiptDirectory });
    assert.equal(reconciled.readOnly, true);
    assert.equal(reconcileWrites, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
