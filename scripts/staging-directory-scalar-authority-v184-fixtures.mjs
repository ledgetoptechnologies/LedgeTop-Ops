import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";
import {
  compileRelationshipRecoveryAuthorityV184,
  RELATIONSHIP_RECOVERY_AUTHORITY_TARGET as recoveryTarget,
  RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2 as recoveryTargetV2,
} from "./staging-relationship-generation-recovery-authority-v184.mjs";
import { DIRECTORY_SCALAR_AUTHORITY_V184_TARGET as scalarTarget } from "./staging-directory-scalar-authority-v184.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const stamp = "2026-10-10T12:00:00.000Z";
export const clone = value => structuredClone(value);
export const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const permissions = ["directory.profile.edit", "directory.identity.link", "directory.enrollment.manage"];

export const grant = (n, permission, recordId, active = 0, scope = "resource") => ({
  id: uuid(n), staff_id: recoveryTarget.staffId, permission, effect: "allow", scope_kind: scope,
  business_area_id: null, division_id: null, resource_id: recordId, active,
  granted_by: recoveryTarget.staffId, created_at: stamp,
});

export function fixture() {
  const grants = [grant(1, "directory.profile.view", null, 1, "global")];
  let number = 2;
  for (const recordId of [recoveryTarget.clientRecordId, recoveryTarget.organizationRecordId]) {
    for (const permission of permissions) {
      if (recordId === recoveryTarget.organizationRecordId && permission === "directory.enrollment.manage") continue;
      grants.push(grant(number++, permission, recordId));
    }
  }
  const history = grants.map((row, index) => ({
    grant_id: row.id, grant_version: 1, staff_id: row.staff_id, permission: row.permission,
    effect: row.effect, scope_kind: row.scope_kind, business_area_id: row.business_area_id,
    division_id: row.division_id, resource_id: row.resource_id, active: row.active,
    grant_generation: index + 1, recorded_at: stamp,
  }));
  return {
    schemaVersion: 1, staging: STAGING_TARGET, phase: "provision", target: recoveryTarget,
    migrationNames: fs.readdirSync(path.join(root, "apps/operations/migrations"))
      .filter(name => /^\d{4}_.+\.sql$/.test(name)).sort(),
    staff: { id: recoveryTarget.staffId, status: "active", access_subject: "access|owner" },
    roles: [{ id: "owner-role", staff_id: recoveryTarget.staffId, role_id: "role-owner", scope: "global", scope_key: "global" }],
    admission: { staff_id: recoveryTarget.staffId, bound_access_subject: "access|owner", active: 1, admitted_by: recoveryTarget.staffId, created_at: stamp, updated_at: stamp, version: 3 },
    profile: { staff_id: recoveryTarget.staffId, login_email: "owner@example.test", display_name: "Owner", version: 2, created_at: stamp, updated_at: stamp },
    generation: { staff_id: recoveryTarget.staffId, generation: history.length, updated_at: stamp },
    records: [{ record_id: recoveryTarget.clientRecordId, record_kind: "client", current_version: 2 }, { record_id: recoveryTarget.organizationRecordId, record_kind: "organization", current_version: 1 }],
    resourceScopes: [{ record_id: recoveryTarget.clientRecordId, scope_kind: "business_area", business_area_id: recoveryTarget.businessAreaId, division_id: null, active: 1 }, { record_id: recoveryTarget.organizationRecordId, scope_kind: "business_area", business_area_id: recoveryTarget.businessAreaId, division_id: null, active: 1 }],
    relationship: { client_record_id: recoveryTarget.clientRecordId, organization_record_id: recoveryTarget.organizationRecordId, relationship_version: 2 },
    predecessor: { command_id: recoveryTarget.predecessorCommandId, source_id: recoveryTarget.sourceId, source_instance_id: recoveryTarget.sourceInstanceId, application_id: recoveryTarget.applicationId, history_epoch_id: recoveryTarget.historyEpochId, destination_origin: recoveryTarget.destinationOrigin, client_record_id: recoveryTarget.clientRecordId, client_public_id: recoveryTarget.clientPublicId, relationship_version: 2, action: "assign", organization_record_id: recoveryTarget.organizationRecordId, organization_public_id: recoveryTarget.organizationPublicId, command_json: JSON.stringify({ expectedAuthorizationGeneration: "54" }), state: "terminal", outcome_json: JSON.stringify({ httpStatus: 409 }) },
    grants, history,
    approval: { approvalId: uuid(90), commandId: uuid(91), grantIds: [uuid(2), uuid(3), uuid(4), uuid(5), uuid(6), uuid(7)], issuedAt: stamp, expiresAt: "2026-10-10T13:00:00.000Z", executedAt: stamp },
  };
}

export function fixtureV2() {
  const value = fixture();
  value.schemaVersion = 2;
  value.target = recoveryTargetV2;
  value.resourceScopes = [
    { record_id: recoveryTargetV2.clientRecordId, scope_kind: "business_area", business_area_id: recoveryTargetV2.clientBusinessAreaId, division_id: null, active: 1 },
    { record_id: recoveryTargetV2.organizationRecordId, scope_kind: "business_area", business_area_id: recoveryTargetV2.organizationBusinessAreaId, division_id: null, active: 1 },
  ];
  return value;
}

export function revokeFixture(base, provisionArtifact) {
  const value = base();
  value.phase = "revoke";
  value.provisionArtifact = provisionArtifact;
  const generation = value.generation.generation;
  for (const [index, id] of value.approval.grantIds.entries()) {
    const recordId = index < 3 ? value.target.clientRecordId : value.target.organizationRecordId;
    const permission = permissions[index % 3];
    let row = value.grants.find(item => item.id === id);
    if (!row) {
      row = grant(Number(id.slice(-12)), permission, recordId, 1);
      value.grants.push(row);
    } else row.active = 1;
    const prior = value.history.filter(item => item.grant_id === id).length;
    value.history.push({ grant_id: id, grant_version: prior + 1, staff_id: row.staff_id, permission: row.permission, effect: row.effect, scope_kind: row.scope_kind, business_area_id: row.business_area_id, division_id: row.division_id, resource_id: row.resource_id, active: 1, grant_generation: generation + index + 1, recorded_at: stamp });
  }
  value.generation = { ...value.generation, generation: generation + 6 };
  value.approval = { ...value.approval, approvalId: uuid(92), commandId: uuid(93) };
  return value;
}

export const plan = {
  recordId: "client-1", kind: "client", mutationId: "11111111-1111-4111-8111-111111111111",
  actor: { staffId: "staff", accessSubject: "access|staff", loginEmail: "staff@example.test", admissionVersion: 2, profileVersion: 3, selectedGrantId: "edit", selectedIdentityGrantId: "link" },
  expectedLocalVersion: 4, field: "phone",
  beforeProfile: { name: "Client", email: "c@example.test", phone: "1", addressLine1: "", addressLine2: "", city: "", state: "IL", postalCode: "", country: "US" },
  afterProfile: { name: "Client", email: "c@example.test", phone: "2", addressLine1: "", addressLine2: "", city: "", state: "IL", postalCode: "", country: "US" },
  destinations: [], temporaryGrantIds: { profileEdit: "edit", identityLink: "link" },
};
export const destination = { sourceId: "project-alpha:staging", sourceInstanceUUID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", applicationUUID: "pa", historyEpoch: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", origin: "https://pa.example.test", externalCanonicalId: "client-1" };
plan.destinations = [{ sourceId: destination.sourceId, sourceInstanceUUID: destination.sourceInstanceUUID, applicationUUID: destination.applicationUUID, historyEpoch: destination.historyEpoch, origin: destination.origin, enrollmentExternalCanonicalId: "client-1", externalCanonicalId: "client-1", projectAlphaPublicId: "a".repeat(32), revision: "7", authorizationGeneration: "9", expectedAuthorizationGeneration: "9", acquisitionEvidence: null }];

function buildSettlement(sourcePlan, sourceDestination, organizationRecordId, businessAreaId, organizationVersion = 3, protectedRecords = ["unchanged"]) {
  const p = clone(sourcePlan), d = clone(sourceDestination);
  const command = { operation: "update", commandId: "cmd", resourceType: "client", externalId: p.recordId, expectedProjectAlphaPublicId: p.destinations[0].projectAlphaPublicId, expectedRevision: "7", expectedAuthorizationGeneration: "9", fields: { ...p.afterProfile, organizationPublicId: "b".repeat(32) } };
  const auditCommand = { operation: "update", mutationId: p.mutationId, resourceType: "client", recordId: p.recordId, expectedLocalVersion: p.expectedLocalVersion, actor: p.actor, fields: p.afterProfile, scopes: null, destinations: [{ ...d, expectedAuthorizationGeneration: "9" }], createAdmissionId: null, relationship: { organizationRecordId, expectedRelationshipVersion: 2 } };
  const relationship = { client_record_id: p.recordId, organization_record_id: organizationRecordId, relationship_version: 2, created_at: "same", updated_at: "same" };
  const common = {
    record: { record_id: p.recordId, record_kind: "client", current_version: p.expectedLocalVersion },
    revisions: [{ record_id: p.recordId, version: p.expectedLocalVersion, mutation_id: "old", profile_json: JSON.stringify(p.beforeProfile) }],
    audits: [], intents: [], materializations: [], outbox: [], relationshipDependencies: [], relationshipDependencyEvidence: [],
    relationship, relationshipHistory: [{ client_record_id: p.recordId, relationship_version: 2, mutation_id: "relationship" }],
    resourceScopes: [{ record_id: p.recordId, scope_kind: "business_area", business_area_id: businessAreaId, division_id: null, active: 1 }],
    enrollment: { record_id: p.recordId, destinations_json: JSON.stringify([d]) },
    protectedSnapshots: { records: protectedRecords, resourceScopes: [], enrollments: [], relationships: [], relationshipHistory: [] },
  };
  const settled = clone(common), next = p.expectedLocalVersion + 1;
  settled.record.current_version = next;
  settled.revisions.push({ record_id: p.recordId, version: next, mutation_id: p.mutationId, profile_json: JSON.stringify(p.afterProfile) });
  settled.audits.push({ audit_id: `${p.mutationId}:audit`, mutation_id: p.mutationId, record_id: p.recordId, record_version: next, actor_type: "staff", actor_id: p.actor.staffId, original_verified_access_subject: p.actor.accessSubject, command_json: JSON.stringify(auditCommand) });
  settled.intents.push({ intent_id: `${p.mutationId}:intent:0`, mutation_id: p.mutationId, record_id: p.recordId, record_version: next, source_id: d.sourceId, source_instance_uuid: d.sourceInstanceUUID, application_uuid: d.applicationUUID, expected_history_epoch_id: d.historyEpoch, destination_origin: d.origin, external_canonical_id: p.recordId, desired_payload_json: JSON.stringify(p.afterProfile), state: "acknowledged" });
  settled.relationshipDependencies.push({ intent_id: `${p.mutationId}:intent:0`, client_record_id: p.recordId, client_record_version: next, relationship_version: 2, relationship_mutation_id: "relationship", organization_record_id: organizationRecordId, organization_record_version: organizationVersion, source_id: d.sourceId, source_instance_uuid: d.sourceInstanceUUID, application_uuid: d.applicationUUID, history_epoch_id: d.historyEpoch, destination_origin: d.origin, parent_external_canonical_id: organizationRecordId, evidence_kind: "existing_mapping", parent_intent_id: null, parent_mapping_command_id: "parent-command", parent_activation_id: null, parent_public_id: "b".repeat(32), parent_ack_revision: "4", parent_ack_command_json: "{}", parent_ack_outcome_json: "{}", resolved_parent_public_id: "b".repeat(32) });
  settled.materializations.push({ intent_id: `${p.mutationId}:intent:0`, command_id: "cmd", command_json: JSON.stringify(command), origin_snapshot_json: JSON.stringify({ actorId: p.actor.staffId, authorityRevision: String(next), actorSubject: p.actor.accessSubject }), disposition_json: JSON.stringify({ kind: "existing", sourceId: d.sourceId, sourceInstanceUUID: d.sourceInstanceUUID, applicationUUID: d.applicationUUID, historyEpoch: d.historyEpoch, origin: d.origin, externalCanonicalId: p.recordId, projectAlphaPublicId: p.destinations[0].projectAlphaPublicId, projectAlphaRevision: "7" }), history_epoch_id: d.historyEpoch });
  settled.outbox.push({ command_id: "cmd", source_id: d.sourceId, application_id: d.applicationUUID, resource_type: "client", external_id: p.recordId, command_json: JSON.stringify(command), destination_base_url: d.origin, expected_source_instance_id: d.sourceInstanceUUID, expected_history_epoch_id: d.historyEpoch, origin_snapshot_json: JSON.stringify({ actorId: p.actor.staffId, authorityRevision: String(next), actorSubject: p.actor.accessSubject }), state: "acknowledged", outcome_json: JSON.stringify({ status: "acknowledged", response: { sourceInstanceId: d.sourceInstanceUUID, applicationId: d.applicationUUID, historyEpoch: d.historyEpoch, requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", replayed: false, result: { resource: { type: "client", publicId: p.destinations[0].projectAlphaPublicId, revision: "8" }, authorizationGeneration: "9", data: { publicId: p.destinations[0].projectAlphaPublicId } } } }) });
  return { plan: p, before: common, settled };
}

export function settlement() { return buildSettlement(plan, destination, "org-1", "area"); }
export const settlementFixture = settlement;

export function cleanup() {
  const settled = settlementFixture();
  const makeGrant = (id, permission, active) => ({ id, staff_id: "staff", permission, effect: "allow", scope_kind: "resource", business_area_id: null, division_id: null, resource_id: "client-1", active, granted_by: "staff", created_at: "2026-01-01T00:00:00.000Z" });
  const acknowledged = { grants: [makeGrant("edit", "directory.profile.edit", 1), makeGrant("link", "directory.identity.link", 1)], grantGeneration: 10, grantHistory: [{ grant_id: "edit", grant_version: 1, staff_id: "staff", permission: "directory.profile.edit", effect: "allow", scope_kind: "resource", business_area_id: null, division_id: null, resource_id: "client-1", active: 1, grant_generation: 8 }, { grant_id: "link", grant_version: 1, staff_id: "staff", permission: "directory.identity.link", effect: "allow", scope_kind: "resource", business_area_id: null, division_id: null, resource_id: "client-1", active: 1, grant_generation: 10 }], settlementSnapshot: settled, protectedSnapshots: { otherGrants: [{ id: "other", active: 1 }], actorAdmission: [{ staff_id: "staff", active: 1, version: 1 }], actorProfile: [{ staff_id: "staff", version: 1 }], otherGrantGenerations: [] } };
  const cleaned = clone(acknowledged); cleaned.grants = cleaned.grants.map(x => ({ ...x, active: 0 })); cleaned.grantGeneration = 12;
  cleaned.grantHistory.push({ ...cleaned.grantHistory[0], grant_version: 2, active: 0, grant_generation: 11 }, { ...cleaned.grantHistory[1], grant_version: 2, active: 0, grant_generation: 12 });
  return { settlement: settled, acknowledged, cleaned };
}

export const activationReceipt = (trusted, overrides = {}) => ({ activation_id: "activation", review_receipt_id: "review", idempotency_key: "activation", acquired_receipt_id: "acquired", native_owner_claim_id: "claim", record_id: "client-1", source_id: trusted.sourceId, source_instance_id: trusted.sourceInstanceUUID, application_id: trusted.applicationUUID, history_epoch_id: trusted.historyEpoch, resource_type: "client", external_id: "pa-client", project_alpha_public_id: trusted.projectAlphaPublicId, project_alpha_revision: "7", local_record_version: 4, request_sha256: "a".repeat(64), acquisition_evidence_sha256: "b".repeat(64), profile_evidence_sha256: "c".repeat(64), binding_status_evidence_sha256: "d".repeat(64), activated_by_staff_id: "staff", directory_grant_generation: 2, activated_at: "2026-01-01T00:00:00.000Z", expected_authorization_generation: "8", result_authorization_generation: "9", ...overrides });

export function acquired(x, heads = {}) {
  const trusted = x.plan.destinations[0]; trusted.externalCanonicalId = "pa-client";
  const activation = activationReceipt(trusted, heads.activation);
  trusted.acquisitionEvidence = { activeMapping: { record_id: "client-1", resource_type: "client", source_id: trusted.sourceId, source_instance_id: trusted.sourceInstanceUUID, application_id: trusted.applicationUUID, history_epoch_id: trusted.historyEpoch, external_id: "pa-client", project_alpha_public_id: trusted.projectAlphaPublicId, provenance_id: "activation", mapping_kind: "acquired", created_at: "same" }, authoritativeHeadEvidence: { schemaVersion: 1, activationReceipt: activation, refreshes: heads.refreshes ?? [], deliveries: heads.deliveries ?? [] } };
  const audit = JSON.parse(x.settled.audits[0].command_json); audit.destinations[0].externalCanonicalId = "pa-client"; x.settled.audits[0].command_json = JSON.stringify(audit); x.settled.intents[0].external_canonical_id = "pa-client";
  const command = JSON.parse(x.settled.materializations[0].command_json); command.externalId = "pa-client"; x.settled.materializations[0].command_json = JSON.stringify(command);
  const disposition = JSON.parse(x.settled.materializations[0].disposition_json); disposition.externalCanonicalId = "pa-client"; x.settled.materializations[0].disposition_json = JSON.stringify(disposition);
  Object.assign(x.settled.outbox[0], { external_id: "pa-client", command_json: JSON.stringify(command) }); return trusted;
}

function appendTransition(input, ids, active, recordedAt) {
  for (const [index, id] of ids.entries()) {
    const row = input.grants.find(item => item.id === id);
    row.active = active;
    input.history.push({ grant_id: id, grant_version: input.history.filter(item => item.grant_id === id).length + 1, staff_id: row.staff_id, permission: row.permission, effect: row.effect, scope_kind: row.scope_kind, business_area_id: row.business_area_id, division_id: row.division_id, resource_id: row.resource_id, active, grant_generation: input.generation.generation + index + 1, recorded_at: recordedAt });
  }
  input.generation = { ...input.generation, generation: input.generation.generation + ids.length, updated_at: recordedAt };
}

export function makeClosedRecoveryLineage() {
  const provisionArtifact = compileRelationshipRecoveryAuthorityV184(fixtureV2(), { root });
  const revokeInput = revokeFixture(fixtureV2, provisionArtifact);
  const revokeArtifact = compileRelationshipRecoveryAuthorityV184(revokeInput, { root });
  const directoryGrants = clone(revokeInput.grants), directoryGrantHistory = clone(revokeInput.history);
  const state = { grants: directoryGrants, history: directoryGrantHistory, generation: clone(revokeInput.generation) };
  appendTransition(state, provisionArtifact.input.approval.grantIds, 0, revokeInput.approval.executedAt);
  return {
    provisionArtifact, revokeArtifact,
    approvals: [{ ...provisionArtifact.approval, revoked_at: revokeInput.approval.executedAt }, revokeArtifact.approval],
    receipts: [provisionArtifact.receipt, revokeArtifact.receipt],
    directoryGrants: state.grants,
    directoryGrantHistory: state.history,
    directoryGrantGeneration: state.generation,
  };
}

export function makeAuthoritySettlement(grantIds = [uuid(2), uuid(3)]) {
  const d = { sourceId: recoveryTargetV2.sourceId, sourceInstanceUUID: recoveryTargetV2.sourceInstanceId, applicationUUID: recoveryTargetV2.applicationId, historyEpoch: recoveryTargetV2.historyEpochId, origin: recoveryTargetV2.destinationOrigin, externalCanonicalId: scalarTarget.clientRecordId };
  const p = { recordId: scalarTarget.clientRecordId, kind: "client", mutationId: uuid(110), actor: { staffId: scalarTarget.staffId, accessSubject: "access|owner", loginEmail: "owner@example.test", admissionVersion: 3, profileVersion: 2, selectedGrantId: grantIds[0], selectedIdentityGrantId: grantIds[1] }, expectedLocalVersion: 2, field: "email", beforeProfile: { name: "Synthetic Client", email: "before@example.test", phone: "1", addressLine1: "", addressLine2: "", city: "", state: "IL", postalCode: "", country: "US" }, afterProfile: { name: "Synthetic Client", email: "after@example.test", phone: "1", addressLine1: "", addressLine2: "", city: "", state: "IL", postalCode: "", country: "US" }, destinations: [{ sourceId: d.sourceId, sourceInstanceUUID: d.sourceInstanceUUID, applicationUUID: d.applicationUUID, historyEpoch: d.historyEpoch, origin: d.origin, enrollmentExternalCanonicalId: scalarTarget.clientRecordId, externalCanonicalId: scalarTarget.clientRecordId, projectAlphaPublicId: recoveryTargetV2.clientPublicId, revision: "7", authorizationGeneration: "9", expectedAuthorizationGeneration: "9", acquisitionEvidence: null }], temporaryGrantIds: { profileEdit: grantIds[0], identityLink: grantIds[1] } };
  return buildSettlement(p, d, scalarTarget.organizationRecordId, recoveryTargetV2.clientBusinessAreaId, scalarTarget.organizationVersion, []);
}

export function makeScalarAuthorityInput({ phase = "provision", provisionArtifact, settlement: suppliedSettlement, overrides = {} } = {}) {
  const recoveryLineage = makeClosedRecoveryLineage();
  const grantIds = recoveryLineage.provisionArtifact.input.approval.grantIds.slice(0, 2);
  const scalarSettlement = suppliedSettlement ? clone(suppliedSettlement) : makeAuthoritySettlement(grantIds);
  const input = {
    schemaVersion: 1, staging: clone(STAGING_TARGET), phase, target: clone(scalarTarget),
    migrationNames: clone(recoveryLineage.provisionArtifact.input.migrationNames),
    staff: { id: scalarTarget.staffId, status: "active", access_subject: "access|owner" },
    admission: { staff_id: scalarTarget.staffId, bound_access_subject: "access|owner", active: 1, admitted_by: scalarTarget.staffId, created_at: stamp, updated_at: stamp, version: 3 },
    profile: { staff_id: scalarTarget.staffId, login_email: "owner@example.test", display_name: "Owner", version: 2, created_at: stamp, updated_at: stamp },
    generation: clone(recoveryLineage.directoryGrantGeneration),
    record: { record_id: scalarTarget.clientRecordId, record_kind: "client", current_version: phase === "provision" ? 2 : 3 },
    relationship: { client_record_id: scalarTarget.clientRecordId, organization_record_id: scalarTarget.organizationRecordId, relationship_version: 2 },
    grants: clone(recoveryLineage.directoryGrants), history: clone(recoveryLineage.directoryGrantHistory),
    recoveryLineage, scalarPrestate: { plan: clone(scalarSettlement.plan), before: clone(scalarSettlement.before) },
    approval: { approvalId: phase === "provision" ? uuid(100) : uuid(102), commandId: phase === "provision" ? uuid(101) : uuid(103), issuedAt: stamp, expiresAt: "2026-10-10T13:00:00.000Z", executedAt: stamp },
  };
  if (phase === "revoke") {
    if (!provisionArtifact) throw new Error("provisionArtifact is required for revoke fixture");
    appendTransition(input, grantIds, 1, provisionArtifact.input.approval.executedAt);
    input.provisionArtifact = clone(provisionArtifact);
    input.settlement = scalarSettlement;
  }
  return Object.assign(input, clone(overrides));
}

export const recoveryLineage = () => makeClosedRecoveryLineage();
export const scalarPrestate = () => {
  const lineage = makeClosedRecoveryLineage();
  const ids = lineage.provisionArtifact.input.approval.grantIds.slice(0, 2);
  const value = makeAuthoritySettlement(ids);
  return { plan: clone(value.plan), before: clone(value.before) };
};
