import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, sign as signBytes, verify as verifyBytes, constants } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertPinnedIssuerDistribution } from './native-staff-bootstrap-owner-approval-distribution-pin.mjs';
import {
  BOOTSTRAP_OWNER_APPROVAL_KIND, canonicalJson, buildOwnerApprovalReceipt,
  assertPinnedInstallerSource, ownerApprovalConsentText, parseTrustConfig, verifyCloudflareAccessJwt,
  verifyNativeStaffBootstrapOwnerApprovalReceipt, initializeNativeStaffBootstrapApprovalRegistry,
  readNativeStaffBootstrapApprovalRegistry, issueNativeStaffBootstrapApproval,
  revokeNativeStaffBootstrapApproval, acquireNativeStaffBootstrapApprovalLease, preparedOwnerApprovalConsentText,
  runPinnedCloudflaredToken,
} from './native-staff-bootstrap-owner-approval.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const uuid = (tail = '1') => `aaaaaaaa-aaaa-4aaa-8aaa-${tail.padStart(12, '0')}`;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function makeConfig(publicKeyPem, owner = { staffId: 'owner-synthetic', accessSubject: 'access|owner-synthetic' }) {
  const keyId = sha(requirePublicDer(publicKeyPem));
  const migrationNames = Array.from({ length: 225 }, (_, index) => `${String(index + 1).padStart(4, '0')}_synthetic.sql`);
  migrationNames[224] = '0225_native_staff_lifecycle_bridge.sql';
  return {
    schemaVersion: 1, kind: 'operations-native-staff-bootstrap-trust-config-v1',
    target: { accountId: 'a'.repeat(32), databaseId: uuid('2') },
    source: { commit: 'b'.repeat(40), migrationNamesSha256: sha(migrationNames.join('\n')) },
    access: { origin: 'https://ops.example.test', issuer: 'https://example.cloudflareaccess.com', audience: 'A'.repeat(32), owner,
      cloudflaredExecutablePath: 'C:\\synthetic\\cloudflared.exe', cloudflaredExecutableSha256: sha('synthetic cloudflared') },
    signer: { algorithm: 'RSA-PSS-SHA256', keyId, publicKeyPem, protectedPrivateKeyPath: 'C:\\synthetic\\key.dpapi', dpapiEntropy: 'synthetic-test-entropy-material-which-is-long-enough' },
    receiptDirectory: 'C:\\synthetic\\receipts',
  };
}

function requirePublicDer(publicKeyPem) {
  return createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
}

function makeFixture(config) {
  const owner = { id: config.access.owner.staffId, email: 'owner@example.test', display_name: 'Synthetic Owner',
    access_subject: config.access.owner.accessSubject, status: 'active', project_alpha_user_id: 'pa-owner', updated_at: '2026-10-26', last_seen_at: '2026-10-26T00:00:00Z' };
  const employee = { id: 'employee-synthetic', email: 'employee@example.test', display_name: 'Synthetic Employee',
    access_subject: 'access|employee-synthetic', status: 'active', project_alpha_user_id: null, updated_at: '2026-10-26', last_seen_at: '2026-10-26T00:00:00Z' };
  const admission = { staff_id: owner.id, bound_access_subject: owner.access_subject, active: 1, admitted_by: owner.id, version: 1 };
  const profile = { staff_id: owner.id, login_email: owner.email, display_name: owner.display_name, version: 1 };
  const emptyAuthorityTables = Object.fromEntries([
    'staff_divisions', 'permissions', 'roles', 'role_permissions', 'staff_role_assignments',
    'staff_permission_overrides', 'local_staff_role_assignments', 'native_business_areas',
    'native_business_divisions', 'native_directory_resource_scopes', 'native_staff_target_memberships',
    'native_staff_admin_delegations', 'native_staff_management_delegations', 'native_staff_delegation_ceilings',
    'native_staff_authority_capabilities', 'native_staff_access_reconciliation', 'native_directory_grants',
    'native_directory_grant_generations', 'native_directory_grant_history', 'native_project_grants',
    'native_project_grant_generations', 'native_directory_assignments', 'native_staff_admin_command_fences',
    'native_staff_admin_commands', 'native_staff_management_commands',
  ].map(name => [name, []]));
  const snapshotValue = { schema_count: 1, schema: [], ledger: [], rows: {
    ...emptyAuthorityTables,
    staff_users: [owner, employee].map(({ last_seen_at, ...row }) => row).sort((a, b) => a.id.localeCompare(b.id)),
    native_staff_admissions: [admission], native_staff_profiles: [profile],
    native_staff_bootstrap_approvals: [], native_staff_bootstrap_receipts: [],
  } };
  const snapshotJson = canonicalJson(snapshotValue), snapshotSha256 = sha(snapshotJson);
  const migrationNames = Array.from({ length: 225 }, (_, index) => `${String(index + 1).padStart(4, '0')}_synthetic.sql`);
  migrationNames[224] = '0225_native_staff_lifecycle_bridge.sql';
  const approvalId = uuid('3'), commandId = uuid('4');
  const plan = { kind: 'operations-native-staff-bootstrap-install-v1', reviewedSnapshotSha256: snapshotSha256,
    approvalId, staffCohort: [employee.id], controlPlaneStaffIds: [owner.id], rows: [
      { table: 'native_staff_admissions', row: { staff_id: employee.id, bound_access_subject: employee.access_subject, active: 1, admitted_by: owner.id } },
      { table: 'native_staff_profiles', row: { staff_id: employee.id, login_email: employee.email, display_name: employee.display_name, version: 1 } },
    ] };
  const artifact = { canonicalPlanJson: canonicalJson(plan), bindingEvidenceJson: canonicalJson({ kind: 'operations-native-staff-binding-review-v1',
    cohortSha256: sha('synthetic-cohort'), operatorStaffId: owner.id, operatorSubject: owner.access_subject }),
    reviewedSnapshot: { snapshotJson, snapshotSha256, migrationNames, migrationNamesSha256: sha(migrationNames.join('\n')),
      currentStaffCount: 2, controlPlaneStaffIds: [owner.id] }, commandId };
  const packet = { schemaVersion: 1, kind: 'operations-current-staff-cohort-review-draft-v1', ownerStaffId: owner.id,
    snapshotSha256: sha('live advisory snapshot'), schema: [], tables: { ...snapshotValue.rows,
      staff_users: [owner, employee] },
    cohort: [
      { staffId: owner.id, email: owner.email, displayName: owner.display_name, accessSubject: owner.access_subject,
        status: 'active', bridgeStatus: 'matched', admission, profile, directoryGrantCount: 5, projectGrantCount: 0, managementDelegationCount: 0 },
      { staffId: employee.id, email: employee.email, displayName: employee.display_name, accessSubject: employee.access_subject,
        status: 'active', bridgeStatus: 'not_admitted', admission: null, profile: null, directoryGrantCount: 0, projectGrantCount: 0, managementDelegationCount: 0 },
    ], status: 'draft', advisory: true, executionAuthority: false, bootstrapApproval: false, acceptedReceipt: false, installerClaim: false };
  const review = { packet, packetSha256: sha(canonicalJson(packet)) };
  const ownerClaims = { issuer: config.access.issuer, audience: config.access.audience,
    subject: owner.access_subject, email: owner.email, issuedAt: Math.floor(Date.now() / 1000) - 60,
    expiresAt: Math.floor(Date.now() / 1000) + 1800, assertionSha256: sha('synthetic-access-jwt') };
  return { artifact, review, ownerClaims, owner, employee, migrationNames };
}

test('trust config requires its independent source hash pin and exact owner/key binding', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const config = makeConfig(publicKey.export({ type: 'spki', format: 'pem' }));
  const text = canonicalJson(config);
  assert.throws(() => parseTrustConfig(text, '0'.repeat(64)), /trust_config_pin_mismatch/u);
  assert.deepEqual(parseTrustConfig(text, sha(text)), config);
  const unpinnedBinary = { ...config, access: { ...config.access, cloudflaredExecutableSha256: 'invalid-hash' } };
  assert.throws(() => parseTrustConfig(canonicalJson(unpinnedBinary), sha(canonicalJson(unpinnedBinary))), /trust_config_invalid/u);
  const changed = { ...config, access: { ...config.access, owner: { staffId: config.access.owner.staffId, accessSubject: 'access|changed' } } };
  assert.throws(() => parseTrustConfig(canonicalJson(changed), sha(text)), /trust_config_pin_mismatch/u);
});

test('pins executor source to the configured Git object without requiring issuer HEAD equality', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ops-source-pin-'));
  try {
    const migrationsDir = path.join(root, 'apps', 'operations', 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    const names = Array.from({ length: 225 }, (_, index) => `${String(index + 1).padStart(4, '0')}_fixture.sql`);
    names[224] = '0225_native_staff_lifecycle_bridge.sql';
    const blobs = new Map([['scripts/native-staff-bootstrap-d1.mjs', Buffer.from('pinned installer source')]]);
    for (const name of names) {
      const bytes = Buffer.from(`migration ${name}`);
      blobs.set(`apps/operations/migrations/${name}`, bytes);
      writeFileSync(path.join(migrationsDir, name), bytes);
    }
    const installerPath = path.join(root, 'scripts', 'native-staff-bootstrap-d1.mjs');
    mkdirSync(path.dirname(installerPath), { recursive: true }); writeFileSync(installerPath, blobs.get('scripts/native-staff-bootstrap-d1.mjs'));
    const config = { source: { commit: 'b'.repeat(40), migrationNamesSha256: sha(names.join('\n')) } };
    const run = (_file, args) => {
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'ls-tree') return names.map(name => `apps/operations/migrations/${name}`).join('\n');
      if (args[0] === 'show') return blobs.get(args[1].slice(config.source.commit.length + 1));
      throw new Error('unexpected git command');
    };
    assert.equal(assertPinnedInstallerSource(config, { cwd: root, run }), true);
    writeFileSync(installerPath, 'changed installer');
    assert.throws(() => assertPinnedInstallerSource(config, { cwd: root, run }), /installer_source_tree_mismatch/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('fails closed on an unprovisioned distribution pin and verifies exact executable files', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ops-issuer-distribution-'));
  const runtimeFiles = ['scripts/native-staff-bootstrap-owner-approval.mjs','scripts/native-staff-bootstrap-sign-dpapi.ps1',
    'scripts/native-staff-bootstrap-approved-executor.mjs','scripts/native-staff-bootstrap-approved-executor-config.mjs',
    'scripts/native-staff-bootstrap-d1.mjs','scripts/native-staff-bootstrap-owner-approval-distribution-pin.mjs',
    'apps/operations/node_modules/wrangler/wrangler-dist/cli.js'];
  const migrationNames = Array.from({ length: 225 }, (_, index) => `${String(index + 1).padStart(4, '0')}_fixture.sql`);
  migrationNames[224] = '0225_native_staff_lifecycle_bridge.sql';
  const files = [...runtimeFiles, ...migrationNames.map(name => `apps/operations/migrations/${name}`)];
  try {
    assert.throws(() => assertPinnedIssuerDistribution({ root }), /issuer_distribution_pin_not_provisioned/u);
    const entries = files.map((relative, index) => {
      const target = path.join(root, relative); mkdirSync(path.dirname(target), { recursive: true });
      const bytes = Buffer.from(`issuer file ${index}`); writeFileSync(target, bytes);
      return { path: relative, sha256: sha(bytes) };
    });
    const manifestPath = path.join(root, 'scripts/native-staff-bootstrap-owner-approval-distribution-manifest.json');
    const manifest = Buffer.from(canonicalJson({ schemaVersion: 1,
      kind: 'operations-native-staff-bootstrap-issuer-distribution-v1', files: entries }));
    writeFileSync(manifestPath, manifest);
    assert.equal(assertPinnedIssuerDistribution({ root, expectedSha256: sha(manifest) }), true);
    writeFileSync(path.join(root, files[0]), 'modified');
    assert.throws(() => assertPinnedIssuerDistribution({ root, expectedSha256: sha(manifest) }), /issuer_distribution_file_mismatch/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verifies the exact human Access JWT against pinned issuer, audience, subject and RS256 JWKS', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const access = { issuer: 'https://example.cloudflareaccess.com', audience: 'A'.repeat(32),
    owner: { staffId: 'owner-synthetic', accessSubject: 'access|owner-synthetic' } };
  const header = encode({ alg: 'RS256', kid: 'synthetic-kid', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const claims = encode({ iss: access.issuer, aud: access.audience, sub: access.owner.accessSubject,
    email: 'owner@example.test', type: 'app', iat: now - 30, exp: now + 300 });
  const signingInput = `${header}.${claims}`;
  const jwt = `${signingInput}.${signBytes('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')}`;
  const jwk = publicKey.export({ format: 'jwk' });
  const verified = await verifyCloudflareAccessJwt(jwt, access, { now: Date.now(), fetchImpl: async url => {
    assert.equal(url.href, `${access.issuer}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'synthetic-kid', alg: 'RS256', use: 'sig' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(verified.subject, access.owner.accessSubject);
  assert.equal(verified.assertionSha256, sha(jwt));
  const wrong = `${header}.${encode({ iss: access.issuer, aud: access.audience, sub: 'access|other', type: 'app', iat: now - 30, exp: now + 300 })}.`+
    signBytes('RSA-SHA256', Buffer.from(`${header}.${encode({ iss: access.issuer, aud: access.audience, sub: 'access|other', type: 'app', iat: now - 30, exp: now + 300 })}`), privateKey).toString('base64url');
  await assert.rejects(verifyCloudflareAccessJwt(wrong, access, { now: Date.now(), fetchImpl: async () => { throw new Error('must not fetch JWKS'); } }), /access_token_claims_invalid/u);
});

test('uses only a hash-pinned absolute cloudflared executable and minimal inherited environment', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ops-cloudflared-pin-'));
  const executable = path.join(root, 'cloudflared.exe'), bytes = Buffer.from('synthetic executable');
  writeFileSync(executable, bytes);
  try {
    const config = { access: { origin: 'https://ops.example.test', cloudflaredExecutablePath: executable,
      cloudflaredExecutableSha256: sha(bytes) } };
    let invocation;
    const token = runPinnedCloudflaredToken(config, { env: { PATH: 'untrusted-path', USERPROFILE: 'C:\\Users\\synthetic' },
      spawn: (file, args, options) => { invocation = { file, args, options }; return { status: 0, stdout: 'a.b.c' }; } });
    assert.equal(token, 'a.b.c');
    assert.equal(invocation.file, executable);
    assert.deepEqual(invocation.args, ['access', 'token', '-app=https://ops.example.test']);
    assert.deepEqual(invocation.options.env, { USERPROFILE: 'C:\\Users\\synthetic' });
    assert.throws(() => runPinnedCloudflaredToken({ access: { ...config.access, cloudflaredExecutableSha256: '0'.repeat(64) } },
      { spawn: () => { throw new Error('must not spawn'); } }), /cloudflared_binary_pin_mismatch/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('builds a signed receipt binding exact owner, prestate, plan, binding, target and current live native identity', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const config = makeConfig(publicKey.export({ type: 'spki', format: 'pem' }));
  const { artifact, review, ownerClaims } = makeFixture(config);
  const now = Date.now();
  const built = buildOwnerApprovalReceipt({ config, artifact, liveReview: review, ownerClaims, now,
    authorizationChallenge: sha('interactive synthetic one-shot') });
  assert.equal(built.payload.kind, BOOTSTRAP_OWNER_APPROVAL_KIND);
  assert.equal(built.payload.trustEnvelope.consentPhrase, 'I approve this exact Operations staff cohort and native authority plan');
  assert.equal(built.payload.ownerConsentText, ownerApprovalConsentText({ planSha256: built.payload.canonicalPlanSha256,
    bindingEvidenceSha256: built.payload.bindingEvidenceSha256, snapshotSha256: built.payload.reviewedSnapshotSha256,
    liveCohortPacketSha256: built.payload.liveCohortPacketSha256 }));
  assert.equal(preparedOwnerApprovalConsentText({ planSha256: built.payload.canonicalPlanSha256,
    bindingSha256: built.payload.bindingEvidenceSha256, snapshot: { snapshotSha256: built.payload.reviewedSnapshotSha256 } },
  { liveCohortPacketSha256: built.payload.liveCohortPacketSha256 }), built.payload.ownerConsentText);
  const signature = signBytes('sha256', Buffer.from(built.payloadJson), { key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64');
  const receipt = { schemaVersion: 1, kind: BOOTSTRAP_OWNER_APPROVAL_KIND, algorithm: built.algorithm,
    keyId: built.keyId, payload: built.payload, signature };
  const expected = { approval: { approvalId: built.payload.trustEnvelope.approvalId,
    approvedOperatorStaffId: built.payload.trustEnvelope.approvedOperatorStaffId,
    approvedOperatorAccessSubject: built.payload.trustEnvelope.approvedOperatorAccessSubject,
    issuedByStaffId: built.payload.trustEnvelope.issuedByStaffId,
    issuedByAccessSubject: built.payload.trustEnvelope.issuedByAccessSubject,
    issuedAt: built.payload.trustEnvelope.authorizedAt, expiresAt: built.payload.trustEnvelope.expiresAt },
    commandId: built.payload.trustEnvelope.commandId, canonicalPlanJson: artifact.canonicalPlanJson,
    bindingEvidenceJson: artifact.bindingEvidenceJson, reviewedSnapshot: artifact.reviewedSnapshot };
  assert.equal(verifyNativeStaffBootstrapOwnerApprovalReceipt(receipt, { config, now, expected }).trusted, true);
  assert.equal(verifyBytes('sha256', Buffer.from(built.payloadJson), { key: publicKey,
    padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(signature, 'base64')), true);
  const changed = { ...receipt, payload: { ...receipt.payload, canonicalPlanSha256: '0'.repeat(64) } };
  assert.throws(() => verifyNativeStaffBootstrapOwnerApprovalReceipt(changed, { config, now }), /receipt_binding_invalid/u);
  assert.throws(() => verifyNativeStaffBootstrapOwnerApprovalReceipt(receipt, { config, now,
    expected: { ...expected, commandId: uuid('8') } }), /receipt_execution_mismatch/u);
  assert.throws(() => verifyNativeStaffBootstrapOwnerApprovalReceipt(receipt, { config, now: Date.parse(built.payload.trustEnvelope.expiresAt) }), /receipt_binding_invalid/u);
});

test('requires a signed issue-state, rejects revoked receipt, and holds a one-shot dispatch lease', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const config = makeConfig(publicKey.export({ type: 'spki', format: 'pem' }));
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ops-approval-registry-'));
  config.receiptDirectory = directory;
  const sign = payload => signBytes('sha256', Buffer.from(payload), { key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }).toString('base64');
  const { artifact: original, review, ownerClaims } = makeFixture(config);
  const makeReceipt = (index) => {
    const plan = JSON.parse(original.canonicalPlanJson);
    plan.approvalId = uuid(String(10 + index));
    const artifact = { ...original, canonicalPlanJson: canonicalJson(plan), commandId: uuid(String(20 + index)) };
    const built = buildOwnerApprovalReceipt({ config, artifact, liveReview: review, ownerClaims,
      authorizationChallenge: sha(`synthetic registry challenge ${index}`) });
    const signature = sign(built.payloadJson);
    return { schemaVersion: 1, kind: BOOTSTRAP_OWNER_APPROVAL_KIND, algorithm: built.algorithm,
      keyId: built.keyId, payload: built.payload, signature };
  };
  try {
    assert.throws(() => readNativeStaffBootstrapApprovalRegistry(config), /approval_registry_unavailable/u);
    initializeNativeStaffBootstrapApprovalRegistry(config, sign);
    const statePath = path.join(directory, 'approval-state.json'), validState = readFileSync(statePath, 'utf8');
    writeFileSync(statePath, '{}');
    assert.throws(() => readNativeStaffBootstrapApprovalRegistry(config), /approval_registry_invalid/u);
    writeFileSync(statePath, validState);
    const revoked = makeReceipt(1), accepted = makeReceipt(2);
    issueNativeStaffBootstrapApproval(config, revoked, sign);
    issueNativeStaffBootstrapApproval(config, accepted, sign);
    const issued = readNativeStaffBootstrapApprovalRegistry(config);
    assert.equal(issued.envelope.payload.entries.length, 2);
    assert.throws(() => issueNativeStaffBootstrapApproval(config, accepted, sign), /approval_registry_replay/u);
    const beforeRevoke = readNativeStaffBootstrapApprovalRegistry(config);
    revokeNativeStaffBootstrapApproval(config, revoked, sign, beforeRevoke.stateSha256);
    assert.throws(() => acquireNativeStaffBootstrapApprovalLease(config, revoked, sign), /approval_registry_not_issuable/u);
    const lease = acquireNativeStaffBootstrapApprovalLease(config, accepted, sign);
    assert.equal(readNativeStaffBootstrapApprovalRegistry(config).envelope.payload.entries
      .find(entry => entry.approvalId === accepted.payload.trustEnvelope.approvalId).state, 'dispatching');
    const dispatchingState = readNativeStaffBootstrapApprovalRegistry(config);
    assert.throws(() => revokeNativeStaffBootstrapApproval(config, accepted, sign, dispatchingState.stateSha256), /approval_registry_locked/u);
    lease.finish('consumed');
    assert.equal(readNativeStaffBootstrapApprovalRegistry(config).envelope.payload.entries
      .find(entry => entry.approvalId === accepted.payload.trustEnvelope.approvalId).state, 'consumed');
    assert.throws(() => acquireNativeStaffBootstrapApprovalLease(config, accepted, sign), /approval_registry_not_issuable/u);
    assert.throws(() => lease.finish('uncertain'), /approval_registry_finish_invalid/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('refuses changed native identities, changed staff authority, consumed IDs and unpinned owner claims', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const config = makeConfig(publicKey.export({ type: 'spki', format: 'pem' }));
  const { artifact, review, ownerClaims } = makeFixture(config);
  const changedStaff = structuredClone(review);
  changedStaff.packet.tables.staff_users[1].status = 'inactive';
  changedStaff.packetSha256 = sha(canonicalJson(changedStaff.packet));
  assert.throws(() => buildOwnerApprovalReceipt({ config, artifact, liveReview: changedStaff, ownerClaims,
    authorizationChallenge: sha('x') }), /live_authority_state_mismatch/u);
  const existingId = structuredClone(review);
  existingId.packet.tables.native_staff_bootstrap_approvals.push({ approval_id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003' });
  existingId.packetSha256 = sha(canonicalJson(existingId.packet));
  assert.throws(() => buildOwnerApprovalReceipt({ config, artifact, liveReview: existingId, ownerClaims,
    authorizationChallenge: sha('x') }), /approval_replay_detected/u);
  assert.throws(() => buildOwnerApprovalReceipt({ config, artifact, liveReview: review,
    ownerClaims: { ...ownerClaims, subject: 'access|wrong' }, authorizationChallenge: sha('x') }), /owner_session_invalid/u);
});

test('DPAPI signer signs with a synthetic CurrentUser protected key and emits no private bytes', { skip: process.platform !== 'win32' }, () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
  const entropy = 'synthetic-dpapi-test-entropy-only-32-bytes';
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'native-staff-bootstrap-dpapi-test-'));
  try {
    const protectedInput = JSON.stringify({ privateKeyBase64: pkcs8.toString('base64'), entropy });
    const protect = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$a=Join-Path $PSHOME "System.Security.Cryptography.ProtectedData.dll"; Add-Type -Path $a; $r=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); $p=[Convert]::FromBase64String($r.privateKeyBase64); $e=[Text.Encoding]::UTF8.GetBytes($r.entropy); [Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($p,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)))'],
    { input: protectedInput, encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 32 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(protect.status, 0, String(protect.stderr ?? ''));
    const keyPath = path.join(scratch, 'synthetic.dpapi');
    writeFileSync(keyPath, Buffer.from(protect.stdout.trim(), 'base64'), { flag: 'wx', mode: 0o600 });
    const payload = canonicalJson({ kind: 'synthetic-test-only', hash: sha('nonsecret test payload') });
    const signRequest = JSON.stringify({ privateKeyPath: keyPath, dpapiEntropy: entropy,
      payloadBase64: Buffer.from(payload).toString('base64') });
    const signerScript = fileURLToPath(new URL('./native-staff-bootstrap-sign-dpapi.ps1', import.meta.url));
    const signed = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', signerScript],
      { input: signRequest, encoding: 'utf8', windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(signed.status, 0, String(signed.stderr ?? ''));
    assert.equal(signed.stdout.trim().includes(pkcs8.toString('base64')), false);
    assert.equal(verifyBytes('sha256', Buffer.from(payload), { key: publicKey,
      padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(signed.stdout.trim(), 'base64')), true);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
