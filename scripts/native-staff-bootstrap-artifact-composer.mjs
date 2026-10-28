import { createHash, randomUUID } from 'node:crypto';
import { nativeStaffBootstrapD1InsertColumns } from './native-staff-bootstrap-d1.mjs';
import { canonicalJson } from './native-staff-bootstrap-owner-approval.mjs';

const fail = code => { throw new Error(`native_staff_bootstrap_artifact_${code}`); };
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ORDER = Object.freeze({ native_business_areas: 0, native_staff_admissions: 1, native_staff_profiles: 2,
  native_staff_target_memberships: 3, native_staff_management_delegations: 4, native_staff_admin_delegations: 4,
  native_staff_delegation_ceilings: 5, native_directory_grants: 6, native_directory_assignments: 7 });
const PRIMARY = Object.freeze({ native_business_areas: 'id', native_staff_admissions: 'staff_id', native_staff_profiles: 'staff_id',
  native_staff_target_memberships: 'id', native_staff_management_delegations: 'id', native_staff_admin_delegations: 'id',
  native_staff_delegation_ceilings: 'id', native_directory_grants: 'id', native_directory_assignments: 'record_id' });
const REF_COLUMNS = Object.freeze(['staff_id', 'actor_staff_id', 'target_staff_id']);
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = 20_000;
// Intentionally mirrors the exact source-chain pin enforced by
// native-staff-bootstrap-d1.mjs; change only with a reviewed migration update.
const REVIEWED_MIGRATION_NAMES_SHA256 = 'e9ca08f7e051a7581da54ba585b740d0cbf033c91f69470649750ae2fdabd8a7';

function cloneJson(value, code) {
  try {
    const encoded = canonicalJson(value);
    const clone = JSON.parse(encoded);
    if (canonicalJson(clone) !== encoded) fail(code);
    return clone;
  } catch (error) {
    if (String(error?.message ?? '').startsWith('native_staff_bootstrap_artifact_')) throw error;
    fail(code);
  }
}

function requireId(value, code = 'staff_id_invalid') {
  if (typeof value !== 'string' || value.length < 1 || value.length > 191 || /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}

function exactKeys(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateReviewedSnapshot(snapshot) {
  if (!exactKeys(snapshot, ['snapshotJson', 'snapshotSha256', 'migrationNames', 'migrationNamesSha256', 'currentStaffCount', 'controlPlaneStaffIds'])
    || typeof snapshot.snapshotJson !== 'string' || Buffer.byteLength(snapshot.snapshotJson, 'utf8') > MAX_SNAPSHOT_BYTES
    || !/^[0-9a-f]{64}$/u.test(snapshot.snapshotSha256 ?? '') || sha256(snapshot.snapshotJson) !== snapshot.snapshotSha256
    || !Array.isArray(snapshot.migrationNames) || snapshot.migrationNames.length !== 225
    || !/^[0-9a-f]{64}$/u.test(snapshot.migrationNamesSha256 ?? '')
    || sha256(snapshot.migrationNames.join('\n')) !== snapshot.migrationNamesSha256
    || !Number.isSafeInteger(snapshot.currentStaffCount) || snapshot.currentStaffCount < 1
    || !Array.isArray(snapshot.controlPlaneStaffIds)) fail('snapshot_invalid');

  for (let index = 0; index < 225; index++) {
    const expectedPrefix = String(index + 1).padStart(4, '0');
    const name = snapshot.migrationNames[index];
    if (typeof name !== 'string' || !name.startsWith(`${expectedPrefix}_`) || !/^[0-9]{4}_[A-Za-z0-9_.-]+\.sql$/u.test(name)) fail('migration_chain_invalid');
  }
  if (snapshot.migrationNames.at(-1) !== '0225_native_staff_lifecycle_bridge.sql') fail('migration_chain_invalid');
  if (snapshot.migrationNamesSha256 !== REVIEWED_MIGRATION_NAMES_SHA256) fail('migration_chain_invalid');

  let state;
  try { state = JSON.parse(snapshot.snapshotJson); } catch { fail('snapshot_json_invalid'); }
  if (!exactKeys(state, ['schema_count', 'schema', 'ledger', 'rows']) || !Number.isSafeInteger(state.schema_count)
    || !Array.isArray(state.schema) || state.schema.length !== state.schema_count
    || !Array.isArray(state.ledger) || canonicalJson(state.ledger) !== canonicalJson(snapshot.migrationNames)
    || !state.rows || typeof state.rows !== 'object' || Array.isArray(state.rows)
    || !Array.isArray(state.rows.staff_users) || state.rows.staff_users.length !== snapshot.currentStaffCount
    || !Array.isArray(state.rows.native_staff_admissions) || !Array.isArray(state.rows.native_staff_profiles)) fail('snapshot_shape_invalid');
  if (Object.entries(state.rows).some(([table, rows]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(table) || !Array.isArray(rows))) fail('snapshot_rows_invalid');
  if (snapshot.controlPlaneStaffIds.some(id => typeof id !== 'string' || !id.length)
    || new Set(snapshot.controlPlaneStaffIds).size !== snapshot.controlPlaneStaffIds.length) fail('snapshot_control_plane_invalid');
  return { snapshot: cloneJson(snapshot, 'snapshot_invalid'), state };
}

function staffMap(state) {
  const rows = state.rows.staff_users;
  const map = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || map.has(row.id)) fail('snapshot_staff_rows_invalid');
    map.set(row.id, row);
  }
  return map;
}

function rowsReferencing(state, staffId) {
  const result = {};
  for (const [table, rows] of Object.entries(state.rows)) {
    if (!Array.isArray(rows)) continue;
    const matches = rows.filter(row => row && typeof row === 'object' && Object.values(row).some(value => value === staffId));
    if (matches.length) result[table] = matches;
  }
  return result;
}

function inactiveHistoryDigest(state) {
  const inactiveIds = new Set(state.rows.staff_users.filter(row => row?.status !== 'active').map(row => row.id));
  const tables = {};
  for (const [table, rows] of Object.entries(state.rows)) {
    if (!Array.isArray(rows)) continue;
    const matches = rows.filter(row => row && typeof row === 'object' && Object.values(row).some(value => inactiveIds.has(value)));
    if (matches.length) tables[table] = matches;
  }
  return sha256(canonicalJson({ inactiveStaff: state.rows.staff_users.filter(row => row?.status !== 'active'), relatedRows: tables }));
}

function identityRows(state, staffIds, preservedIds, admittedByStaffId) {
  const byId = staffMap(state);
  const rows = [];
  for (const staffId of staffIds) {
    const staff = byId.get(staffId);
    if (!staff || staff.status !== 'active' || typeof staff.access_subject !== 'string' || !staff.access_subject.trim()
      || typeof staff.email !== 'string' || !staff.email.trim() || typeof staff.display_name !== 'string' || !staff.display_name.trim()) fail('cohort_identity_missing');
    if (preservedIds.has(staffId)) fail('protected_staff_in_cohort');
    if (state.rows.native_staff_admissions.some(row => row?.staff_id === staffId)
      || state.rows.native_staff_profiles.some(row => row?.staff_id === staffId)) fail('cohort_already_native');
    rows.push({ table: 'native_staff_admissions', row: {
      staff_id: staff.id, bound_access_subject: staff.access_subject, active: 1,
      admitted_by: admittedByStaffId,
    } });
    rows.push({ table: 'native_staff_profiles', row: {
      staff_id: staff.id, login_email: staff.email, display_name: staff.display_name, version: 1,
    } });
  }
  return rows;
}

function validatePreservedStaff(state, roles, controlPlaneStaffIds) {
  if (!exactKeys(roles, ['ownerStaffId', 'kstirnStaffId'])) fail('preservation_roles_invalid');
  const ids = [requireId(roles.ownerStaffId), requireId(roles.kstirnStaffId)];
  if (ids[0] === ids[1]) fail('preservation_roles_invalid');
  const byId = staffMap(state);
  for (const staffId of ids) {
    const staff = byId.get(staffId);
    if (!staff || staff.status !== 'active' || typeof staff.access_subject !== 'string' || !staff.access_subject.trim()) fail('protected_staff_missing');
    const admission = state.rows.native_staff_admissions.find(row => row?.staff_id === staffId);
    const profile = state.rows.native_staff_profiles.find(row => row?.staff_id === staffId);
    if (!admission || admission.active !== 1 || admission.bound_access_subject !== staff.access_subject
      || !profile || profile.login_email !== staff.email || profile.display_name !== staff.display_name) fail('protected_staff_binding_invalid');
    if (!controlPlaneStaffIds.includes(staffId) && staffId === roles.ownerStaffId) fail('owner_not_control_plane_candidate');
  }
  return ids.map((staffId, index) => ({
    role: index === 0 ? 'owner' : 'kstirn', staffId,
    staffRowSha256: sha256(canonicalJson(byId.get(staffId))),
    effectiveOpsStateSha256: sha256(canonicalJson(rowsReferencing(state, staffId))),
  }));
}

function validateExplicitRows(policyRows, state, cohortIds, preservedIds) {
  if (!Array.isArray(policyRows) || policyRows.length > MAX_ROWS) fail('policy_rows_invalid');
  const generatedTableKeys = new Set(['native_staff_admissions', 'native_staff_profiles']);
  const forbiddenClientTables = new Set(['native_directory_grants', 'native_directory_assignments']);
  const existing = new Set();
  for (const [table, key] of Object.entries(PRIMARY)) {
    for (const row of state.rows[table] ?? []) if (row && typeof row === 'object') existing.add(`${table}\0${String(row[key])}`);
  }
  const planIds = new Set(policyRows.filter(item => item?.table === 'native_staff_management_delegations').map(item => item?.row?.id));
  const areaIds = new Set(policyRows.filter(item => item?.table === 'native_business_areas').map(item => item?.row?.id));
  const knownAreas = new Set([...(state.rows.native_business_areas ?? []).map(row => row?.id), ...areaIds]);
  const knownDivisions = new Set((state.rows.native_business_divisions ?? []).map(row => row?.id));
  const seen = new Set();
  for (const item of policyRows) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !exactKeys(item, ['table', 'row'])
      || !Object.hasOwn(nativeStaffBootstrapD1InsertColumns, item.table) || generatedTableKeys.has(item.table)
      || forbiddenClientTables.has(item.table) || !exactKeys(item.row, nativeStaffBootstrapD1InsertColumns[item.table])) fail('policy_row_invalid');
    const key = PRIMARY[item.table];
    if (typeof item.row[key] !== 'string' || !item.row[key].trim()) fail('policy_row_key_invalid');
    const composite = `${item.table}\0${item.row[key]}`;
    if (existing.has(composite) || seen.has(composite)) fail('policy_row_duplicate');
    seen.add(composite);
    for (const column of REF_COLUMNS) {
      const value = item.row[column];
      if (value == null) continue;
      if (preservedIds.has(value) && column !== 'staff_id') fail('policy_mutates_protected_authority');
      if (column === 'actor_staff_id' && !cohortIds.has(value)) fail('policy_actor_not_new_cohort');
      if (column === 'staff_id' && !cohortIds.has(value)) fail('policy_target_not_new_cohort');
      if (column === 'target_staff_id' && !cohortIds.has(value)) fail('policy_target_not_new_cohort');
    }
    for (const column of ['admitted_by', 'created_by', 'granted_by']) {
      const value = item.row[column];
      if (value != null && !preservedIds.has(value)) fail('policy_provenance_not_preserved_owner');
    }
    if (item.row.business_area_id != null && !knownAreas.has(item.row.business_area_id)) fail('policy_area_unbound');
    if (item.row.division_id != null && !knownDivisions.has(item.row.division_id)) fail('policy_division_unbound');
    if (item.table === 'native_staff_target_memberships' && !cohortIds.has(item.row.staff_id)) fail('policy_target_not_new_cohort');
    if (item.table === 'native_staff_delegation_ceilings'
      && (!planIds.has(item.row.parent_delegation_id) || (item.row.target_staff_id != null && !cohortIds.has(item.row.target_staff_id)))) fail('policy_ceiling_parent_invalid');
  }
  return policyRows.map(row => cloneJson(row, 'policy_row_invalid'));
}

/**
 * Compose a review artifact from the exact shape returned by
 * readNativeStaffBootstrapSnapshot. This is a planner only: it does not read
 * credentials, create trust material, sign approval, or perform D1 writes.
 * Every non-identity policy row is caller-supplied, hashed into the binding
 * evidence, and restricted to the proposed cohort. Directory grants and
 * client assignments are deliberately outside this bootstrap composition.
 */
export function composeNativeStaffBootstrapArtifact({ reviewedSnapshot, proposedStaffIds,
  controlPlaneStaffIds, preservationRoles, explicitPolicyRows = [], decisionReference,
  approvalId = randomUUID(), commandId = randomUUID() } = {}) {
  if (!UUID.test(approvalId) || !UUID.test(commandId)) fail('uuid_invalid');
  if (typeof decisionReference !== 'string' || decisionReference.trim().length < 1 || decisionReference.length > 256
    || /[\u0000-\u001f\u007f]/u.test(decisionReference)) fail('decision_reference_required');
  const validated = validateReviewedSnapshot(reviewedSnapshot);
  const snapshot = validated.snapshot, state = validated.state;
  if (!Array.isArray(proposedStaffIds) || !proposedStaffIds.length || proposedStaffIds.length > 250) fail('cohort_invalid');
  const cohort = proposedStaffIds.map(value => requireId(value, 'cohort_invalid')).sort();
  if (new Set(cohort).size !== cohort.length) fail('cohort_invalid');
  if (!Array.isArray(controlPlaneStaffIds)) fail('control_plane_invalid');
  const cp = controlPlaneStaffIds.map(value => requireId(value, 'control_plane_invalid'));
  if (canonicalJson([...cp].sort()) !== canonicalJson([...snapshot.controlPlaneStaffIds].sort())
    || new Set(cp).size !== cp.length) fail('control_plane_mismatch');
  const protectedRows = validatePreservedStaff(state, preservationRoles, cp);
  const preservedIds = new Set(protectedRows.map(row => row.staffId));
  const cohortIdSet = new Set(cohort);
  for (const id of cohort) if (!staffMap(state).has(id)) fail('cohort_identity_missing');
  const derived = identityRows(state, cohort, preservedIds, preservationRoles.ownerStaffId);
  const supplied = validateExplicitRows(explicitPolicyRows, state, cohortIdSet, preservedIds);
  const cmp = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const rows = [...derived, ...supplied].sort((left, right) => ORDER[left.table] - ORDER[right.table]
    || cmp(left.table, right.table) || cmp(canonicalJson(left.row), canonicalJson(right.row)));
  const plan = { kind: 'operations-native-staff-bootstrap-install-v1', reviewedSnapshotSha256: snapshot.snapshotSha256,
    approvalId, staffCohort: cohort, controlPlaneStaffIds: [...cp].sort(), rows };
  const inactiveStaffHistorySha256 = inactiveHistoryDigest(state);
  const binding = { kind: 'operations-native-staff-binding-review-v1', schemaVersion: 1,
    status: 'draft-not-approved', decisionReference, reviewedSnapshotSha256: snapshot.snapshotSha256,
    cohortIdentityBindings: cohort.map(staffId => ({ staffId, accessSubjectSha256: sha256(state.rows.staff_users.find(row => row.id === staffId).access_subject) })),
    explicitPolicyRowsSha256: sha256(canonicalJson(supplied)), preservation: {
      protectedStaff: protectedRows, inactiveStaffHistorySha256,
      clientStateMutation: 'not-requested; directory grant and client assignment rows are excluded from this composer',
      installerMutationMode: 'existing-approved-installer-insert-only-atomic-batch',
    } };
  const artifact = { canonicalPlanJson: canonicalJson(plan), bindingEvidenceJson: canonicalJson(binding),
    reviewedSnapshot: snapshot, commandId };
  if (Buffer.byteLength(canonicalJson(artifact), 'utf8') > MAX_SNAPSHOT_BYTES) fail('artifact_too_large');
  return Object.freeze({ artifact: deepFreeze(cloneJson(artifact, 'artifact_invalid')), planSha256: sha256(artifact.canonicalPlanJson),
    bindingSha256: sha256(artifact.bindingEvidenceJson), preservedStaff: protectedRows.map(({ role, staffId }) => ({ role, staffId })),
    inactiveStaffHistorySha256 });
}
