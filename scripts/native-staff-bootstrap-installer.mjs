import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const fail = code => { throw new Error(`native_staff_bootstrap_${code}`); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
};
const digest = value => sha(stable(value));

// These are only the tables a reviewed bootstrap plan may initially populate.
// Existing legacy staff/role rows are never updated or deleted by this module.
const INSERT_COLUMNS = Object.freeze({
  native_staff_bootstrap_approvals: ['approval_id','canonical_plan_json','canonical_plan_sha256','approved_operator_staff_id','approved_operator_access_subject','independent_binding_verification_json','independent_binding_verification_sha256','issued_by_staff_id','issued_by_access_subject','issued_at','expires_at','revoked_at'],
  native_staff_admissions: ['staff_id','bound_access_subject','active','admitted_by'],
  native_staff_profiles: ['staff_id','login_email','display_name','version'],
  native_staff_target_memberships: ['id','staff_id','scope_kind','business_area_id','division_id','active','version','created_by'],
  native_staff_admin_delegations: ['id','actor_staff_id','action','effect','scope_kind','business_area_id','division_id','target_staff_id','active','version','granted_by'],
  native_staff_management_delegations: ['id','contract_version','actor_staff_id','capability','effect','scope_kind','business_area_id','division_id','target_staff_id','active','version','granted_by'],
  native_directory_grants: ['id','staff_id','permission','effect','scope_kind','business_area_id','division_id','resource_id','active','granted_by'],
  native_directory_assignments: ['record_id','staff_id','active','assigned_by'],
});

/**
 * Compile already-reviewed artifacts. `verifyTrust` must be supplied by a
 * separately controlled offline root/operator verifier; a boolean, role name,
 * email, or Worker credential is deliberately not accepted as trust evidence.
 * No acceptance, identity evidence, approval, or plan is synthesized here.
 */
export async function prepareNativeStaffBootstrapInstall(input, { verifyTrust } = {}) {
  if (typeof verifyTrust !== 'function') fail('trust_verifier_required');
  if (!exact(input, ['approval','canonicalPlanJson','bindingEvidenceJson','reviewedSnapshot','trustEnvelope'])) fail('input_invalid');
  const { approval, canonicalPlanJson, bindingEvidenceJson, reviewedSnapshot, trustEnvelope } = input;
  if (typeof canonicalPlanJson !== 'string' || Buffer.byteLength(canonicalPlanJson) > 262144
    || typeof bindingEvidenceJson !== 'string' || Buffer.byteLength(bindingEvidenceJson) > 262144) fail('artifact_invalid');
  let plan, binding;
  try { plan = JSON.parse(canonicalPlanJson); binding = JSON.parse(bindingEvidenceJson); } catch { fail('artifact_json_invalid'); }
  if (stable(plan) !== canonicalPlanJson || stable(binding) !== bindingEvidenceJson) fail('artifact_not_canonical');
  if (!exact(approval, ['approvalId','operatorStaffId','operatorAccessSubject','issuedByStaffId','issuedByAccessSubject','issuedAt','expiresAt'])
    || !Object.values(approval).every(v => typeof v === 'string' && v.length > 0)) fail('approval_invalid');
  const planSha256 = sha(canonicalPlanJson), bindingSha256 = sha(bindingEvidenceJson);
  if (!exact(reviewedSnapshot, ['schemaVersion','migrationLedgerSha256','cohortSha256','controlPlaneSha256','permissionStateSha256','cohort','controlPlaneStaffIds'])
    || reviewedSnapshot.schemaVersion !== 1 || !/^[0-9a-f]{64}$/u.test(reviewedSnapshot.migrationLedgerSha256)
    || !/^[0-9a-f]{64}$/u.test(reviewedSnapshot.cohortSha256) || !/^[0-9a-f]{64}$/u.test(reviewedSnapshot.controlPlaneSha256)
    || !/^[0-9a-f]{64}$/u.test(reviewedSnapshot.permissionStateSha256)
    || digest(reviewedSnapshot.cohort) !== reviewedSnapshot.cohortSha256
    || digest(reviewedSnapshot.controlPlaneStaffIds) !== reviewedSnapshot.controlPlaneSha256) fail('review_snapshot_invalid');
  if (!await verifyTrust({ trustEnvelope, approval, canonicalPlanJson, planSha256, bindingEvidenceJson, bindingSha256, reviewedSnapshot })) fail('independent_approval_missing');
  if (!plan || typeof plan !== 'object' || Array.isArray(plan) || plan.kind !== 'operations-native-staff-bootstrap-install-v1'
    || plan.reviewedSnapshotSha256 !== digest(reviewedSnapshot) || plan.approvalId !== approval.approvalId
    || !Array.isArray(plan.rows) || plan.rows.length > 4096) fail('plan_invalid');
  const rows = plan.rows.map(item => {
    if (!exact(item, ['table','row']) || !Object.hasOwn(INSERT_COLUMNS, item.table)) fail('plan_table_invalid');
    if (item.table === 'native_staff_bootstrap_approvals') fail('approval_row_must_be_derived');
    const cols = INSERT_COLUMNS[item.table];
    if (!exact(item.row, cols)) fail('plan_row_invalid');
    return Object.freeze({ table: item.table, row: Object.freeze({ ...item.row }) });
  });
  const approvalRow = Object.freeze({ approval_id:approval.approvalId, canonical_plan_json:canonicalPlanJson,
    canonical_plan_sha256:planSha256, approved_operator_staff_id:approval.operatorStaffId,
    approved_operator_access_subject:approval.operatorAccessSubject, independent_binding_verification_json:bindingEvidenceJson,
    independent_binding_verification_sha256:bindingSha256, issued_by_staff_id:approval.issuedByStaffId,
    issued_by_access_subject:approval.issuedByAccessSubject, issued_at:approval.issuedAt, expires_at:approval.expiresAt, revoked_at:null });
  rows.unshift(Object.freeze({ table:'native_staff_bootstrap_approvals', row:approvalRow }));
  return Object.freeze({ approval, canonicalPlanJson, planSha256, bindingEvidenceJson, bindingSha256,
    reviewedSnapshot: Object.freeze(structuredClone(reviewedSnapshot)), rows: Object.freeze(rows), trustEnvelope: structuredClone(trustEnvelope) });
}

/**
 * Apply only through a transaction-capable, independently provisioned
 * management adapter. The adapter must implement BEGIN IMMEDIATE/COMMIT/ROLLBACK
 * (or a database equivalent), with `readSnapshot` and writes on that same
 * transaction connection. There is intentionally no D1/Worker adapter here:
 * ordinary Worker credentials cannot issue bootstrap rows.
 */
export async function executeNativeStaffBootstrapInstall(prepared, managementDb, { verifyTrust } = {}) {
  if (!prepared || typeof managementDb?.withImmediateTransaction !== 'function' || typeof verifyTrust !== 'function') fail('management_adapter_required');
  return managementDb.withImmediateTransaction(async tx => {
    const current = await tx.readSnapshot();
    if (!current || current.schemaVersion !== 1 || current.migrationLedgerSha256 !== prepared.reviewedSnapshot.migrationLedgerSha256
      || digest(current.cohort) !== prepared.reviewedSnapshot.cohortSha256
      || digest(current.controlPlaneStaffIds) !== prepared.reviewedSnapshot.controlPlaneSha256
      || digest(current.permissions) !== prepared.reviewedSnapshot.permissionStateSha256) fail('state_changed');
    // Revalidate authority after the transaction acquired its write lock.
    if (!await verifyTrust({ trustEnvelope: prepared.trustEnvelope, approval: prepared.approval,
      canonicalPlanJson: prepared.canonicalPlanJson, planSha256: prepared.planSha256,
      bindingEvidenceJson: prepared.bindingEvidenceJson, bindingSha256: prepared.bindingSha256,
      reviewedSnapshot: prepared.reviewedSnapshot })) fail('independent_approval_revoked');
    const receipt = await tx.findBootstrapReceipt(prepared.approval.approvalId);
    if (receipt) fail('already_consumed');
    const missing = [];
    for (const item of prepared.rows) {
      const existing = await tx.findExactRow(item.table, item.row);
      if (existing === null) missing.push(item);
      else if (stable(existing) !== stable(item.row)) fail('row_conflict');
    }
    // Any pre-existing approval/receipt for this one-shot ID is a conflict.
    if (await tx.findApproval(prepared.approval.approvalId)) fail('approval_id_conflict');
    for (const item of missing) await tx.insertExactRow(item.table, item.row);
    const result = Object.freeze({ schemaVersion: 1, approvalId: prepared.approval.approvalId,
      planSha256: prepared.planSha256, bindingSha256: prepared.bindingSha256,
      insertedRows: missing.length, tables: [...new Set(missing.map(row => row.table))].sort() });
    const resultJson = stable(result);
    await tx.insertBootstrapReceipt({ commandId: `bootstrap:${prepared.approval.approvalId}`,
      approvalId: prepared.approval.approvalId, operatorStaffId: prepared.approval.operatorStaffId,
      operatorAccessSubject: prepared.approval.operatorAccessSubject,
      canonicalPlanJson: prepared.canonicalPlanJson, canonicalPlanSha256: prepared.planSha256,
      bindingEvidenceJson: prepared.bindingEvidenceJson, bindingEvidenceSha256: prepared.bindingSha256,
      resultJson, resultSha256: sha(resultJson) });
    return result;
  });
}

export const nativeStaffBootstrapInsertColumns = INSERT_COLUMNS;
