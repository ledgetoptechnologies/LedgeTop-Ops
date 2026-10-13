import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileRelationshipRecoveryAuthorityV184, RELATIONSHIP_RECOVERY_AUTHORITY_TARGET as historicalTarget,
  RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2 as recoveryTarget } from "./staging-relationship-generation-recovery-authority-v184.mjs";
import { PROJECT_BUSINESS_AREA_AUTHORITY_V184_TARGET as clientAreaTarget } from "./staging-project-business-area-authority-v184.mjs";
import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";
import { compileProjectOrganizationAuthorityV184, PROJECT_ORGANIZATION_AUTHORITY_V184_PURPOSE as purpose,
  PROJECT_ORGANIZATION_AUTHORITY_V184_TARGET as target } from "./staging-project-organization-authority-v184.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = "2026-10-10T12:00:00.000Z", closeStamp = "2026-10-10T12:10:00.000Z";
const uuid = value => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const migrationNames = fs.readdirSync(path.join(root, "apps", "operations", "migrations")).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
const grant = (value, permission, recordId, active = 0, scope = "resource") => ({ id: uuid(value), staff_id: recoveryTarget.staffId, permission, effect: "allow", scope_kind: scope, business_area_id: null, division_id: null, resource_id: recordId, active, granted_by: recoveryTarget.staffId, created_at: stamp });

function recoveryBase(schemaVersion = 2) {
  const selected = schemaVersion === 1 ? historicalTarget : recoveryTarget;
  const grants = [grant(1, "directory.profile.view", null, 1, "global")];
  let sequence = 2;
  for (const recordId of [selected.clientRecordId, selected.organizationRecordId])
    for (const permission of ["directory.profile.edit", "directory.identity.link", "directory.enrollment.manage"])
      grants.push({ ...grant(sequence++, permission, recordId), staff_id: selected.staffId, granted_by: selected.staffId });
  const history = grants.map((row, index) => ({ grant_id: row.id, grant_version: 1, staff_id: row.staff_id, permission: row.permission, effect: row.effect, scope_kind: row.scope_kind, business_area_id: row.business_area_id, division_id: row.division_id, resource_id: row.resource_id, active: row.active, grant_generation: index + 1, recorded_at: stamp }));
  return { schemaVersion, staging: STAGING_TARGET, phase: "provision", target: selected, migrationNames: [...migrationNames], staff: { id: selected.staffId, status: "active", access_subject: "access|owner" }, roles: [{ id: "owner-role", staff_id: selected.staffId, role_id: "role-owner", scope: "global", scope_key: "global" }], admission: { staff_id: selected.staffId, bound_access_subject: "access|owner", active: 1, admitted_by: selected.staffId, created_at: stamp, updated_at: stamp, version: 3 }, profile: { staff_id: selected.staffId, login_email: "owner@example.test", display_name: "Owner", version: 2, created_at: stamp, updated_at: stamp }, generation: { staff_id: selected.staffId, generation: history.length, updated_at: stamp }, records: [{ record_id: selected.clientRecordId, record_kind: "client", current_version: 2 }, { record_id: selected.organizationRecordId, record_kind: "organization", current_version: 1 }], resourceScopes: schemaVersion === 1 ? [{ record_id: selected.clientRecordId, scope_kind: "business_area", business_area_id: selected.businessAreaId, division_id: null, active: 1 }, { record_id: selected.organizationRecordId, scope_kind: "business_area", business_area_id: selected.businessAreaId, division_id: null, active: 1 }] : [{ record_id: selected.clientRecordId, scope_kind: "business_area", business_area_id: selected.clientBusinessAreaId, division_id: null, active: 1 }, { record_id: selected.organizationRecordId, scope_kind: "business_area", business_area_id: selected.organizationBusinessAreaId, division_id: null, active: 1 }], relationship: { client_record_id: selected.clientRecordId, organization_record_id: selected.organizationRecordId, relationship_version: 2 }, predecessor: { command_id: selected.predecessorCommandId, source_id: selected.sourceId, source_instance_id: selected.sourceInstanceId, application_id: selected.applicationId, history_epoch_id: selected.historyEpochId, destination_origin: selected.destinationOrigin, client_record_id: selected.clientRecordId, client_public_id: selected.clientPublicId, relationship_version: 2, action: "assign", organization_record_id: selected.organizationRecordId, organization_public_id: selected.organizationPublicId, command_json: JSON.stringify({ expectedAuthorizationGeneration: "54" }), state: "terminal", outcome_json: JSON.stringify({ httpStatus: 409 }) }, grants, history, approval: { approvalId: uuid(90), commandId: uuid(91), grantIds: [2, 3, 4, 5, 6, 7].map(uuid), issuedAt: stamp, expiresAt: "2026-10-10T13:00:00.000Z", executedAt: stamp } };
}
function successor(input, active, recordedAt) {
  const ids = input.approval.grantIds, grants = input.grants.map(row => ids.includes(row.id) ? { ...row, active } : row), history = [...input.history];
  ids.forEach((id, index) => { const row = grants.find(item => item.id === id); history.push({ grant_id: id, grant_version: input.history.filter(item => item.grant_id === id).length + 1, staff_id: row.staff_id, permission: row.permission, effect: row.effect, scope_kind: row.scope_kind, business_area_id: row.business_area_id, division_id: row.division_id, resource_id: row.resource_id, active, grant_generation: input.generation.generation + index + 1, recorded_at: recordedAt }); });
  return { grants, history, generation: { staff_id: recoveryTarget.staffId, generation: input.generation.generation + 6, updated_at: recordedAt } };
}
function recoveryLineage(schemaVersion = 2) {
  const initial = recoveryBase(schemaVersion), provisionArtifact = compileRelationshipRecoveryAuthorityV184(initial), opened = successor(initial, 1, stamp);
  const revokeInput = { ...initial, phase: "revoke", grants: opened.grants, history: opened.history, generation: opened.generation, approval: { approvalId: uuid(92), commandId: uuid(93), grantIds: [...initial.approval.grantIds], issuedAt: stamp, expiresAt: "2026-10-10T13:00:00.000Z", executedAt: closeStamp }, provisionArtifact };
  const revokeArtifact = compileRelationshipRecoveryAuthorityV184(revokeInput), closed = successor(revokeInput, 0, closeStamp);
  return { provisionArtifact, revokeArtifact, approvals: [{ ...provisionArtifact.approval, revoked_at: closeStamp }, revokeArtifact.approval], receipts: [provisionArtifact.receipt, revokeArtifact.receipt], directoryGrants: closed.grants, directoryGrantHistory: closed.history, directoryGrantGeneration: closed.generation };
}
function fixture(recoverySchemaVersion = 2) {
  return { schemaVersion: 1, purpose, staging: STAGING_TARGET, migrationNames: [...migrationNames], target, staff: { id: target.staffId, status: "active", access_subject: "access|owner" }, roles: [{ id: "owner-role", staff_id: target.staffId, role_id: "role-owner", scope: "global", division_id: null, scope_key: "global", created_by: target.staffId, created_at: stamp }], admission: { staff_id: target.staffId, bound_access_subject: "access|owner", active: 1, admitted_by: target.staffId, created_at: stamp, updated_at: stamp, version: 3 }, profile: { staff_id: target.staffId, login_email: "owner@example.test", display_name: "Owner", version: 2, created_at: stamp, updated_at: stamp }, businessArea: { id: target.businessAreaId, name: target.businessAreaName, active: 1 }, projectGeneration: { staff_id: target.staffId, generation: 1 }, projectGrants: [{ id: uuid(40), staff_id: target.staffId, capability: "project.shared.sync", effect: "allow", scope_kind: "global", business_area_id: null, division_id: null, external_project_id: null, active: 0, version: 2, granted_by: target.staffId, created_at: stamp }], recoveryLineage: recoveryLineage(recoverySchemaVersion), approval: { provisionApprovalId: uuid(50), provisionCommandId: uuid(51), revokeApprovalId: uuid(52), revokeCommandId: uuid(53), grantId: uuid(54), issuedAt: stamp, expiresAt: "2026-10-10T13:00:00.000Z" } };
}
function sealed(executedAt = stamp) {
  const value = fixture(), provision = compileProjectOrganizationAuthorityV184(value, { root });
  return { ...value, provisionReadback: { approval: provision.provision.approval, receipt: { ...provision.provision.receipt, executed_at: executedAt }, grant: { id: value.approval.grantId, staff_id: value.target.staffId, capability: "project.shared.sync", effect: "allow", scope_kind: "business_area", business_area_id: value.target.businessAreaId, division_id: null, external_project_id: null, active: 1, version: 1, granted_by: value.target.staffId, created_at: executedAt } } };
}

function reusableFixture() {
  const value = fixture();
  value.schemaVersion = 2;
  const reusable = { id: uuid(54), staff_id: value.target.staffId, capability: "project.shared.sync", effect: "allow", scope_kind: "business_area", business_area_id: value.target.businessAreaId, division_id: null, external_project_id: null, active: 0, version: 2, granted_by: value.target.staffId, created_at: stamp };
  value.projectGrants.push(reusable);
  value.projectGeneration.generation++;
  return value;
}

test("compiles an exact organization-area provision and paired cleanup", () => {
  const provision = compileProjectOrganizationAuthorityV184(fixture(), { root });
  assert.equal(provision.input.target.businessAreaId, "drone-services-staging");
  assert.equal(provision.input.target.businessAreaName, "Drone services staging acceptance");
  assert.notEqual(provision.input.target.businessAreaId, clientAreaTarget.businessAreaId);
  assert.ok(provision.provision.statements.some(statement => statement.sql.startsWith("INSERT INTO native_project_grants") && statement.params.includes("drone-services-staging")));
  const pair = compileProjectOrganizationAuthorityV184(sealed("2026-10-10T12:00:01.000Z"), { root });
  assert.equal(pair.provision.statements, undefined);
  assert.ok(pair.revoke.statements.some(statement => statement.sql.startsWith("UPDATE native_project_grants SET active=0")));
  assert.ok(pair.revoke.statements.some(statement => statement.sql.includes("paired-receipt")));
  assert.ok(pair.revoke.statements.some(statement => statement.sql.includes("revoke-unrelated-grant")));
});

test("v2 reuses only the exact inactive grant identity with versioned CAS", () => {
  const value = reusableFixture(), artifact = compileProjectOrganizationAuthorityV184(value, { root });
  const mutation = artifact.provision.statements.find(statement => statement.sql.startsWith("UPDATE native_project_grants SET active=1"));
  assert.deepEqual(mutation.params, [value.approval.grantId, value.target.staffId, value.target.businessAreaId, 2, value.target.staffId, stamp]);
  assert.equal(artifact.provision.statements.some(statement => statement.sql.startsWith("INSERT INTO native_project_grants")), false);

  for (const mutate of [
    input => input.projectGrants.find(grant => grant.id === input.approval.grantId).active = 1,
    input => input.projectGrants.find(grant => grant.id === input.approval.grantId).business_area_id = clientAreaTarget.businessAreaId,
    input => input.approval.grantId = uuid(55),
  ]) {
    const rejected = reusableFixture(); mutate(rejected);
    assert.throws(() => compileProjectOrganizationAuthorityV184(rejected, { root }), /exact inactive project grant identity/);
  }
});

test("accepts exact closed v3 recovery lineage without weakening the organization target", () => {
  const artifact = compileProjectOrganizationAuthorityV184(fixture(3), { root });
  assert.equal(artifact.input.recoveryLineage.revokeArtifact.approval.revoked_at, closeStamp);
  assert.equal(artifact.input.target.businessAreaId, target.businessAreaId);
});

test("rejects client-area and arbitrary organization targets", () => {
  for (const mutate of [value => value.target = clientAreaTarget, value => value.target = { ...value.target, businessAreaId: clientAreaTarget.businessAreaId },
    value => value.businessArea.id = clientAreaTarget.businessAreaId, value => value.businessArea.name = "Drone Services Staging"] ) {
    const value = fixture(); mutate(value);
    assert.throws(() => compileProjectOrganizationAuthorityV184(value, { root }), /exact staging target|organization area/);
  }
});

test("requires closed mixed-scope v2 lineage and complete current authority", () => {
  for (const mutate of [value => value.recoveryLineage = recoveryLineage(1), value => value.staff.status = "inactive",
    value => value.roles[0].scope = "division", value => value.admission.version = 0, value => value.projectGeneration.generation = -1,
    value => value.recoveryLineage.receipts.pop()]) {
    const value = fixture(); mutate(value);
    assert.throws(() => compileProjectOrganizationAuthorityV184(value, { root }));
  }
});

test("rejects active global and exact organization-area denies without broadening other scopes", () => {
  for (const denied of [
    { scope_kind: "global", business_area_id: null, division_id: null, external_project_id: null },
    { scope_kind: "business_area", business_area_id: target.businessAreaId, division_id: null, external_project_id: null },
  ]) {
    const value = fixture();
    value.projectGrants.push({ id: uuid(60), staff_id: target.staffId, capability: "project.shared.sync", effect: "deny", ...denied, active: 1, version: 1, granted_by: target.staffId, created_at: stamp });
    assert.throws(() => compileProjectOrganizationAuthorityV184(value, { root }), /applicable project deny/);
  }
  const unrelated = fixture();
  unrelated.projectGrants.push({ id: uuid(61), staff_id: target.staffId, capability: "project.shared.sync", effect: "deny", scope_kind: "business_area", business_area_id: clientAreaTarget.businessAreaId, division_id: null, external_project_id: null, active: 1, version: 1, granted_by: target.staffId, created_at: stamp });
  assert.equal(compileProjectOrganizationAuthorityV184(unrelated, { root }).input.projectGrants.length, 2);
});

test("binds every SQL parameter and rejects mismatched sealed cleanup evidence", () => {
  for (const statements of [compileProjectOrganizationAuthorityV184(fixture(), { root }).provision.statements,
    compileProjectOrganizationAuthorityV184(sealed(), { root }).revoke.statements])
    for (const statement of statements) assert.equal((statement.sql.match(/\?/g) ?? []).length, statement.params.length, statement.sql);
  const wrong = sealed(); wrong.provisionReadback.grant.business_area_id = clientAreaTarget.businessAreaId;
  assert.throws(() => compileProjectOrganizationAuthorityV184(wrong, { root }), /readback/);
});
