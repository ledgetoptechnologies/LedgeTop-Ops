import { isDeepStrictEqual as same } from "node:util";

import { DIRECTORY_SCALAR_AUTHORITY_V184_TARGET as target } from "./staging-directory-scalar-authority-v184.mjs";
import { validateClosedRelationshipRecoveryLineageV184 } from "./staging-project-business-area-authority-v184.mjs";

const APPROVAL_COLUMNS = "approval_id,canonical_plan_json,canonical_plan_sha256,approved_operator_staff_id,approved_operator_access_subject,independent_binding_verification_json,independent_binding_verification_sha256,issued_by_staff_id,issued_by_access_subject,issued_at,expires_at,revoked_at";
const RECEIPT_COLUMNS = "command_id,approval_id,operator_staff_id,operator_access_subject,canonical_plan_json,canonical_plan_sha256,independent_binding_verification_json,independent_binding_verification_sha256,result_json,result_sha256,executed_at";

const fail = message => { throw new Error(`staging-directory-scalar-evidence-capture: ${message}`); };
const select = sql => {
  if (typeof sql !== "string" || !/^\s*SELECT\b/i.test(sql) || sql.includes(";")) fail("only one fixed SELECT statement is permitted");
  return sql;
};
async function all(db, sql, ...params) {
  const result = await db.prepare(select(sql)).bind(...params).all();
  if (!result || !Array.isArray(result.results)) fail("SELECT did not return rows");
  return result.results;
}
async function first(db, sql, ...params) {
  const result = await db.prepare(select(sql)).bind(...params).first();
  return result ?? null;
}
function exactlyOne(rows, label) {
  if (rows.length !== 1) fail(`${label} must have exactly one row`);
  return rows[0];
}

export async function captureDirectoryScalarSnapshot(db, options = {}) {
  const recordId = options.recordId ?? target.clientRecordId;
  const expectedVersion = options.expectedVersion ?? target.clientVersion;
  if (recordId !== target.clientRecordId || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
    fail("exact scalar target and positive expected version required");

  const dependencies = await all(db, `SELECT d.intent_id,d.client_record_id,d.client_record_version,d.relationship_version,d.relationship_mutation_id,d.organization_record_id,d.organization_record_version,d.source_id,d.source_instance_uuid,d.application_uuid,d.history_epoch_id,d.destination_origin,d.parent_external_canonical_id,d.evidence_kind,d.parent_intent_id,d.parent_mapping_command_id,d.parent_activation_id,d.parent_public_id,d.parent_ack_revision,d.parent_ack_command_json,d.parent_ack_outcome_json,r.resolved_parent_public_id FROM operations_directory_intent_relationship_dependencies d JOIN operations_directory_intent_relationship_resolved r ON r.intent_id=d.intent_id WHERE d.client_record_id=? ORDER BY d.intent_id`, recordId);
  const evidence = [];
  for (const dependency of dependencies.filter(row => row.evidence_kind === "acquired_mapping")) {
    if (typeof dependency.intent_id !== "string" || typeof dependency.parent_activation_id !== "string"
      || typeof dependency.organization_record_id !== "string") fail("acquired parent dependency identity is incomplete");
    evidence.push({
      intent_id: dependency.intent_id,
      activeMapping: exactlyOne(await all(db,
        "SELECT * FROM project_alpha_active_directory_mappings WHERE provenance_id=? AND record_id=?",
        dependency.parent_activation_id, dependency.organization_record_id), "active parent mapping"),
      activationReceipt: exactlyOne(await all(db,
        "SELECT * FROM project_alpha_existing_directory_binding_activation_receipts WHERE activation_id=?",
        dependency.parent_activation_id), "parent activation receipt"),
    });
  }

  const snapshot = {
    record: await first(db, "SELECT record_id,record_kind,current_version FROM operations_directory_records WHERE record_id=?", recordId),
    revisions: await all(db, "SELECT record_id,version,mutation_id,profile_json FROM operations_directory_revisions WHERE record_id=? ORDER BY version", recordId),
    audits: await all(db, "SELECT audit_id,mutation_id,record_id,record_version,actor_type,actor_id,original_verified_access_subject,command_json FROM operations_directory_audit WHERE record_id=? ORDER BY record_version", recordId),
    intents: await all(db, "SELECT intent_id,mutation_id,record_id,record_version,source_id,source_instance_uuid,application_uuid,expected_history_epoch_id,destination_origin,external_canonical_id,desired_payload_json,state FROM operations_directory_intents WHERE record_id=? ORDER BY record_version", recordId),
    materializations: await all(db, "SELECT m.intent_id,m.command_id,m.command_json,m.origin_snapshot_json,m.disposition_json,m.history_epoch_id FROM operations_directory_materializations m JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.record_id=? ORDER BY i.record_version", recordId),
    outbox: await all(db, "SELECT o.command_id,o.source_id,o.application_id,o.resource_type,o.external_id,o.command_json,o.destination_base_url,o.expected_source_instance_id,o.expected_history_epoch_id,o.origin_snapshot_json,o.state,o.outcome_json FROM project_alpha_directory_outbox o JOIN operations_directory_materializations m ON m.command_id=o.command_id JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.record_id=? ORDER BY i.record_version", recordId),
    relationshipDependencies: dependencies,
    relationshipDependencyEvidence: evidence,
    relationship: await first(db, "SELECT client_record_id,organization_record_id,relationship_version,created_at,updated_at FROM operations_directory_client_organizations WHERE client_record_id=?", recordId),
    relationshipHistory: await all(db, "SELECT client_record_id,relationship_version,mutation_id FROM operations_directory_client_organization_history WHERE client_record_id=? ORDER BY relationship_version", recordId),
    resourceScopes: await all(db, "SELECT record_id,scope_kind,business_area_id,division_id,active FROM native_directory_resource_scopes WHERE record_id=? ORDER BY scope_kind", recordId),
    enrollment: await first(db, "SELECT record_id,destinations_json FROM native_directory_enrollments WHERE record_id=?", recordId),
    protectedSnapshots: {
      records: await all(db, "SELECT record_id,record_kind,current_version FROM operations_directory_records WHERE record_id<>? ORDER BY record_id", recordId),
      resourceScopes: await all(db, "SELECT record_id,scope_kind,business_area_id,division_id,active FROM native_directory_resource_scopes WHERE record_id<>? ORDER BY record_id,scope_kind", recordId),
      enrollments: await all(db, "SELECT record_id,destinations_json FROM native_directory_enrollments WHERE record_id<>? ORDER BY record_id", recordId),
      relationships: await all(db, "SELECT client_record_id,organization_record_id,relationship_version FROM operations_directory_client_organizations ORDER BY client_record_id"),
      relationshipHistory: await all(db, "SELECT client_record_id,relationship_version,mutation_id FROM operations_directory_client_organization_history ORDER BY client_record_id,relationship_version"),
    },
  };
  if (!same(snapshot.record, { record_id: recordId, record_kind: "client", current_version: expectedVersion }))
    fail("current client record/version is missing or stale");
  if (!snapshot.relationship || snapshot.relationship.client_record_id !== recordId) fail("current client relationship is missing");
  if (!snapshot.enrollment || snapshot.enrollment.record_id !== recordId) fail("current client enrollment is missing");
  if (new Set(dependencies.map(row => row.intent_id)).size !== dependencies.length) fail("relationship dependencies are ambiguous");
  return snapshot;
}

export async function reconstructClosedRecoveryLineage(db, provisionArtifact, revokeArtifact, options = {}) {
  if (!provisionArtifact || !revokeArtifact) fail("complete provision and revoke artifacts are required");
  const staffId = options.staffId ?? target.staffId;
  if (staffId !== target.staffId) fail("exact scalar actor required");
  const provisionApproval = provisionArtifact.approval?.approval_id;
  const revokeApproval = revokeArtifact.approval?.approval_id;
  const provisionReceipt = provisionArtifact.receipt?.command_id;
  const revokeReceipt = revokeArtifact.receipt?.command_id;
  if (![provisionApproval, revokeApproval, provisionReceipt, revokeReceipt].every(value => typeof value === "string" && value.length))
    fail("complete provision and revoke artifact identities are required");
  const lineage = {
    provisionArtifact,
    revokeArtifact,
    approvals: await all(db, `SELECT ${APPROVAL_COLUMNS} FROM native_staff_bootstrap_approvals WHERE approval_id IN (?,?) ORDER BY approval_id`, provisionApproval, revokeApproval),
    receipts: await all(db, `SELECT ${RECEIPT_COLUMNS} FROM native_staff_bootstrap_receipts WHERE command_id IN (?,?) ORDER BY command_id`, provisionReceipt, revokeReceipt),
    directoryGrants: await all(db, "SELECT * FROM native_directory_grants WHERE staff_id=? ORDER BY id", staffId),
    directoryGrantHistory: await all(db, "SELECT * FROM native_directory_grant_history WHERE staff_id=? ORDER BY grant_generation", staffId),
    directoryGrantGeneration: await first(db, "SELECT * FROM native_directory_grant_generations WHERE staff_id=?", staffId),
  };
  if (lineage.approvals.length !== 2 || lineage.receipts.length !== 2 || !lineage.directoryGrantGeneration)
    fail("closed recovery lineage readback is incomplete or ambiguous");
  validateClosedRelationshipRecoveryLineageV184(lineage, options.validatorOptions ?? {});
  return lineage;
}
