import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './native-staff-bootstrap-owner-approval.mjs';
import { nativeStaffBootstrapD1InsertColumns, prepareNativeStaffBootstrapD1 } from './native-staff-bootstrap-d1.mjs';
import { composeNativeStaffBootstrapArtifact } from './native-staff-bootstrap-artifact-composer.mjs';

const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const uuid = () => randomUUID();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fixture() {
  const migrationDirectory = path.join(root, 'apps', 'operations', 'migrations');
  const migrationNames = readdirSync(migrationDirectory).filter(name => /^\d{4}_.+\.sql$/u.test(name)
    && Number(name.slice(0, 4)) <= 225).sort();
  const ownerId = 'synthetic-owner-id';
  const kstirnId = 'synthetic-kstirn-id';
  const newId = 'synthetic-new-employee-id';
  const inactiveId = 'synthetic-inactive-history-id';
  const users = [
    { id: ownerId, email: 'owner@example.test', display_name: 'Synthetic Owner', access_subject: 'access|synthetic-owner', status: 'active' },
    { id: kstirnId, email: 'kstirn@example.test', display_name: 'Synthetic Kstirn', access_subject: 'access|synthetic-kstirn', status: 'active' },
    { id: newId, email: 'employee@example.test', display_name: 'Synthetic Employee', access_subject: 'access|synthetic-new', status: 'active' },
    { id: inactiveId, email: 'old@example.test', display_name: 'Synthetic Inactive', access_subject: 'access|synthetic-inactive', status: 'inactive' },
  ].sort((a, b) => a.id.localeCompare(b.id));
  const rows = {
    staff_users: users,
    native_staff_admissions: [
      { staff_id: ownerId, bound_access_subject: 'access|synthetic-owner', active: 1, admitted_by: ownerId, version: 1 },
      { staff_id: kstirnId, bound_access_subject: 'access|synthetic-kstirn', active: 1, admitted_by: ownerId, version: 1 },
      { staff_id: inactiveId, bound_access_subject: 'access|synthetic-inactive', active: 0, admitted_by: ownerId, version: 2 },
    ],
    native_staff_profiles: [
      { staff_id: ownerId, login_email: 'owner@example.test', display_name: 'Synthetic Owner', version: 1 },
      { staff_id: kstirnId, login_email: 'kstirn@example.test', display_name: 'Synthetic Kstirn', version: 1 },
      { staff_id: inactiveId, login_email: 'old@example.test', display_name: 'Synthetic Inactive', version: 2 },
    ],
    native_staff_management_delegations: [
      { id: 'existing-owner-profile-read', actor_staff_id: ownerId, capability: 'staff.profile.read', effect: 'allow', active: 1, version: 1 },
    ],
    native_directory_grants: [
      { id: 'existing-kstirn-directory-read', staff_id: kstirnId, permission: 'directory.profile.view', effect: 'allow', active: 1 },
      { id: 'existing-inactive-client-history', staff_id: inactiveId, permission: 'directory.profile.view', effect: 'allow', active: 0 },
    ],
    native_directory_assignments: [
      { record_id: 'synthetic-client-record-preserved', staff_id: kstirnId, active: 1, assigned_by: ownerId },
      { record_id: 'synthetic-inactive-client-record', staff_id: inactiveId, active: 0, assigned_by: ownerId },
    ],
  };
  const snapshotValue = { schema_count: 1, schema: [{ type: 'table', name: 'staff_users', tbl_name: 'staff_users', sql: 'CREATE TABLE staff_users(id TEXT)' }],
    ledger: migrationNames, rows };
  const snapshotJson = JSON.stringify(snapshotValue);
  const migrationNamesSha256 = sha(migrationNames.join('\n'));
  const reviewedSnapshot = { snapshotJson, snapshotSha256: sha(snapshotJson), migrationNames, migrationNamesSha256,
    currentStaffCount: users.length, controlPlaneStaffIds: [ownerId] };
  return { reviewedSnapshot, ownerId, kstirnId, newId, inactiveId, state: snapshotValue };
}

function compose(f = fixture(), overrides = {}) {
  return composeNativeStaffBootstrapArtifact({ reviewedSnapshot: f.reviewedSnapshot,
    proposedStaffIds: [f.newId], controlPlaneStaffIds: f.reviewedSnapshot.controlPlaneStaffIds,
    preservationRoles: { ownerStaffId: f.ownerId, kstirnStaffId: f.kstirnId },
    decisionReference: 'synthetic-review-ticket-1', ...overrides });
}

test('composes canonical draft from a populated 225-migration snapshot and records preservation evidence', () => {
  const f = fixture();
  const result = compose(f);
  const { artifact } = result;
  const plan = JSON.parse(artifact.canonicalPlanJson);
  const binding = JSON.parse(artifact.bindingEvidenceJson);
  assert.equal(artifact.reviewedSnapshot.snapshotSha256, sha(artifact.reviewedSnapshot.snapshotJson));
  assert.equal(artifact.reviewedSnapshot.migrationNames.length, 225);
  assert.equal(plan.staffCohort.length, 1);
  assert.deepEqual(plan.staffCohort, [f.newId]);
  assert.deepEqual(plan.controlPlaneStaffIds, [f.ownerId]);
  assert.deepEqual(plan.rows.map(row => row.table), ['native_staff_admissions', 'native_staff_profiles']);
  assert.equal(plan.rows[0].row.bound_access_subject, 'access|synthetic-new');
  assert.equal(plan.rows[0].row.admitted_by, f.ownerId);
  assert.equal(plan.rows[1].row.login_email, 'employee@example.test');
  assert.equal(binding.status, 'draft-not-approved');
  assert.equal(binding.preservation.protectedStaff.length, 2);
  assert.deepEqual(binding.preservation.protectedStaff.map(row => row.role), ['owner', 'kstirn']);
  assert.ok(binding.preservation.inactiveStaffHistorySha256);
  assert.match(binding.preservation.clientStateMutation, /excluded/);
  assert.ok(result.planSha256 && result.bindingSha256);
  assert.equal(nativeStaffBootstrapD1InsertColumns.native_staff_profiles.length, 4);
});

test('composed artifact is accepted by the existing prepare API when supplied a synthetic verifier', async () => {
  const f = fixture();
  const { artifact } = compose(f);
  const plan = JSON.parse(artifact.canonicalPlanJson);
  const approval = { approvalId: plan.approvalId, approvedOperatorStaffId: f.ownerId,
    approvedOperatorAccessSubject: 'access|synthetic-owner', issuedByStaffId: f.ownerId,
    issuedByAccessSubject: 'access|synthetic-owner', issuedAt: '2026-10-28T12:00:00.000Z', expiresAt: '2026-10-28T12:10:00.000Z' };
  const envelope = { schemaVersion: 1, action: 'install-operations-native-staff-bootstrap', ownerSessionId: 'synthetic-session',
    authorizationChallenge: 'synthetic-challenge', approvalId: approval.approvalId, commandId: artifact.commandId,
    approvedOperatorStaffId: approval.approvedOperatorStaffId, approvedOperatorAccessSubject: approval.approvedOperatorAccessSubject,
    issuedByStaffId: approval.issuedByStaffId, issuedByAccessSubject: approval.issuedByAccessSubject,
    authorizedAt: approval.issuedAt, expiresAt: approval.expiresAt, reviewedSnapshotSha256: artifact.reviewedSnapshot.snapshotSha256,
    canonicalPlanSha256: sha(artifact.canonicalPlanJson), bindingEvidenceSha256: sha(artifact.bindingEvidenceJson),
    consentPhrase: 'I approve this exact Operations staff cohort and native authority plan' };
  const prepared = await prepareNativeStaffBootstrapD1({ ...artifact, approval, trustEnvelope: envelope }, { verifyTrust: async () => true });
  assert.equal(prepared.planSha256, sha(artifact.canonicalPlanJson));
  assert.deepEqual(prepared.plan.staffCohort, [f.newId]);
});

test('refuses the pre-0225 221-migration snapshot', () => {
  const f = fixture();
  const names = f.reviewedSnapshot.migrationNames.slice(0, 221);
  const value = JSON.parse(f.reviewedSnapshot.snapshotJson);
  value.ledger = names;
  const snapshotJson = JSON.stringify(value);
  const reviewedSnapshot = { ...f.reviewedSnapshot, snapshotJson, snapshotSha256: sha(snapshotJson), migrationNames: names,
    migrationNamesSha256: sha(names.join('\n')) };
  assert.throws(() => compose(f, { reviewedSnapshot }), /snapshot_invalid/);
});

test('refuses future or unknown migration chains even when supplied hashes are self-consistent', () => {
  const f = fixture();
  const future = [...f.reviewedSnapshot.migrationNames, '0226_future.sql'];
  assert.throws(() => compose(f, { reviewedSnapshot: { ...f.reviewedSnapshot, migrationNames: future,
    migrationNamesSha256: sha(future.join('\n')) } }), /snapshot_invalid/);
  const unknown = [...f.reviewedSnapshot.migrationNames];
  unknown[80] = '0081_unreviewed_name.sql';
  const value = JSON.parse(f.reviewedSnapshot.snapshotJson);
  value.ledger = unknown;
  const snapshotJson = JSON.stringify(value);
  assert.throws(() => compose(f, { reviewedSnapshot: { ...f.reviewedSnapshot, snapshotJson, snapshotSha256: sha(snapshotJson),
    migrationNames: unknown, migrationNamesSha256: sha(unknown.join('\n')) } }), /migration_chain_invalid/);
});

test('refuses duplicate identities and does not select by email', () => {
  const f = fixture();
  assert.throws(() => compose(f, { proposedStaffIds: [f.newId, f.newId] }), /cohort_invalid/);
  const duplicateEmail = JSON.parse(f.reviewedSnapshot.snapshotJson);
  duplicateEmail.rows.staff_users.find(row => row.id === f.newId).email = 'kstirn@example.test';
  const snapshotJson = JSON.stringify(duplicateEmail);
  const reviewedSnapshot = { ...f.reviewedSnapshot, snapshotJson, snapshotSha256: sha(snapshotJson) };
  const result = compose(f, { reviewedSnapshot });
  assert.deepEqual(JSON.parse(result.artifact.canonicalPlanJson).staffCohort, [f.newId]);
  assert.equal(JSON.parse(result.artifact.canonicalPlanJson).rows[1].row.login_email, 'kstirn@example.test');
});

test('keeps the owner unchanged and refuses duplicate owner or already-present kstirn native identity', () => {
  const f = fixture();
  const before = sha(canonicalJson(f.state.rows));
  assert.throws(() => compose(f, { proposedStaffIds: [f.ownerId] }), /owner_protected_from_cohort/);
  assert.throws(() => compose(f, { proposedStaffIds: [f.kstirnId] }), /kstirn_native_state_already_present/);
  assert.equal(sha(canonicalJson(f.state.rows)), before);
});

test('permits an identity-only kstirn copy from exact legacy staff ID and stored subject when native rows are absent', () => {
  const f = fixture();
  const state = JSON.parse(f.reviewedSnapshot.snapshotJson);
  state.rows.native_staff_admissions = state.rows.native_staff_admissions.filter(row => row.staff_id !== f.kstirnId);
  state.rows.native_staff_profiles = state.rows.native_staff_profiles.filter(row => row.staff_id !== f.kstirnId);
  const snapshotJson = JSON.stringify(state);
  const reviewedSnapshot = { ...f.reviewedSnapshot, snapshotJson, snapshotSha256: sha(snapshotJson) };
  const beforeClientState = sha(canonicalJson({ grants: state.rows.native_directory_grants, assignments: state.rows.native_directory_assignments }));
  const result = compose(f, { reviewedSnapshot, proposedStaffIds: [f.kstirnId] });
  const plan = JSON.parse(result.artifact.canonicalPlanJson);
  const binding = JSON.parse(result.artifact.bindingEvidenceJson);
  assert.deepEqual(plan.rows.map(item => item.table), ['native_staff_admissions', 'native_staff_profiles']);
  assert.equal(plan.rows[0].row.staff_id, f.kstirnId);
  assert.equal(plan.rows[0].row.bound_access_subject, 'access|synthetic-kstirn');
  assert.equal(plan.rows[0].row.admitted_by, f.ownerId);
  assert.equal(plan.rows[1].row.login_email, 'kstirn@example.test');
  assert.equal(plan.rows[1].row.display_name, 'Synthetic Kstirn');
  assert.equal(binding.preservation.protectedStaff.find(row => row.role === 'kstirn').nativeIdentityState,
    'legacy-identity-present-native-copy-missing');
  assert.equal(plan.rows.some(item => item.table.includes('delegation') || item.table.includes('grant') || item.table.includes('assignment')), false);
  assert.equal(sha(canonicalJson({ grants: state.rows.native_directory_grants, assignments: state.rows.native_directory_assignments })), beforeClientState);
});

test('refuses partial kstirn native identity and any explicit authority row targeting kstirn', () => {
  const f = fixture();
  const partial = JSON.parse(f.reviewedSnapshot.snapshotJson);
  partial.rows.native_staff_profiles = partial.rows.native_staff_profiles.filter(row => row.staff_id !== f.kstirnId);
  const partialJson = JSON.stringify(partial);
  assert.throws(() => compose(f, { reviewedSnapshot: { ...f.reviewedSnapshot, snapshotJson: partialJson, snapshotSha256: sha(partialJson) } }),
    /protected_staff_binding_invalid/);
  const explicit = { table: 'native_staff_management_delegations', row: {
    id: 'synthetic-kstirn-added-authority', actor_staff_id: f.kstirnId, contract_version: 1,
    authority_domain: 'staff_admin', capability: 'staff.profile.read', effect: 'allow', scope_kind: 'global',
    business_area_id: null, division_id: null, target_staff_id: null, active: 1, version: 1, granted_by: f.ownerId,
  } };
  assert.throws(() => compose(f, { explicitPolicyRows: [explicit] }), /policy_mutates_protected_authority|policy_actor_not_new_cohort/);
});

test('accepts only explicit cohort-scoped policy rows and excludes client grants/assignments', () => {
  const f = fixture();
  const explicit = { table: 'native_staff_management_delegations', row: {
    id: 'synthetic-new-employee-profile-read', actor_staff_id: f.newId, contract_version: 1,
    authority_domain: 'staff_admin', capability: 'staff.profile.read', effect: 'allow', scope_kind: 'global',
    business_area_id: null, division_id: null, target_staff_id: null, active: 1, version: 1, granted_by: f.ownerId,
  } };
  const result = compose(f, { explicitPolicyRows: [explicit] });
  assert.deepEqual(JSON.parse(result.artifact.canonicalPlanJson).rows.map(row => row.table),
    ['native_staff_admissions', 'native_staff_profiles', 'native_staff_management_delegations']);
  assert.equal(JSON.parse(result.artifact.bindingEvidenceJson).explicitPolicyRowsSha256, sha(canonicalJson([explicit])));
  assert.throws(() => compose(f, { explicitPolicyRows: [{ table: 'native_directory_grants', row: {
    id: 'synthetic-client-access', staff_id: f.newId, permission: 'directory.profile.view', effect: 'allow',
    scope_kind: 'global', business_area_id: null, division_id: null, resource_id: null, active: 1, granted_by: f.ownerId,
  } }] }), /policy_row_invalid/);
  assert.throws(() => compose(f, { explicitPolicyRows: [{ ...explicit, row: { ...explicit.row, actor_staff_id: f.ownerId } }] }), /policy_mutates_protected_authority|policy_actor_not_new_cohort/);
});

test('refuses unknown snapshot row shapes and non-active/unbound identities', () => {
  const f = fixture();
  const broken = JSON.parse(f.reviewedSnapshot.snapshotJson);
  broken.rows.staff_users.push({ id: f.newId, email: 'dup@example.test', display_name: 'Dup', access_subject: 'access|dup', status: 'active' });
  const snapshotJson = JSON.stringify(broken);
  assert.throws(() => compose(f, { reviewedSnapshot: { ...f.reviewedSnapshot, snapshotJson, snapshotSha256: sha(snapshotJson), currentStaffCount: broken.rows.staff_users.length } }), /snapshot_staff_rows_invalid/);
  const inactive = JSON.parse(f.reviewedSnapshot.snapshotJson);
  inactive.rows.staff_users.find(row => row.id === f.newId).status = 'inactive';
  const inactiveJson = JSON.stringify(inactive);
  assert.throws(() => compose(f, { reviewedSnapshot: { ...f.reviewedSnapshot, snapshotJson: inactiveJson, snapshotSha256: sha(inactiveJson) } }), /cohort_identity_missing/);
});
