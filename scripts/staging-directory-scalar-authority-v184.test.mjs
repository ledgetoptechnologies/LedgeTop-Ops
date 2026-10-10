import assert from "node:assert/strict";
import test from "node:test";

import {
  compileDirectoryScalarAuthorityV184,
  DIRECTORY_SCALAR_AUTHORITY_V184_TARGET as target,
} from "./staging-directory-scalar-authority-v184.mjs";
import {
  clone,
  fixture,
  makeScalarAuthorityInput,
  revokeFixture,
} from "./staging-directory-scalar-authority-v184-fixtures.mjs";
import { compileRelationshipRecoveryAuthorityV184, RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2 as recoveryTargetV2 } from "./staging-relationship-generation-recovery-authority-v184.mjs";

const placeholders = sql => (sql.match(/\?/g) ?? []).length;
const assertBoundStatements = artifact => {
  for (const [index, statement] of artifact.statements.entries()) {
    assert.equal(statement.params.length, placeholders(statement.sql), `statement ${index} has exact bound parameter count`);
  }
};
const addConsistentInactiveAuthority = input => {
  const generation = input.generation.generation + 1;
  const row = {
    id: "00000000-0000-4000-8000-000000000200", staff_id: target.staffId,
    permission: "directory.profile.view", effect: "allow", scope_kind: "resource",
    business_area_id: null, division_id: null, resource_id: target.organizationRecordId,
    active: 0, granted_by: target.staffId, created_at: "2026-10-10T12:00:00.000Z",
  };
  input.grants.push(row);
  input.history.push({ grant_id: row.id, grant_version: 1, staff_id: row.staff_id,
    permission: row.permission, effect: row.effect, scope_kind: row.scope_kind,
    business_area_id: row.business_area_id, division_id: row.division_id,
    resource_id: row.resource_id, active: 0, grant_generation: generation,
    recorded_at: "2026-10-10T12:00:00.000Z" });
  input.generation = { ...input.generation, generation, updated_at: "2026-10-10T12:00:00.000Z" };
};

function lifecycle() {
  const provisionInput = makeScalarAuthorityInput();
  const provisionArtifact = compileDirectoryScalarAuthorityV184(provisionInput);
  const revokeInput = makeScalarAuthorityInput({ phase: "revoke", provisionArtifact });
  const revokeArtifact = compileDirectoryScalarAuthorityV184(revokeInput);
  return { provisionInput, provisionArtifact, revokeInput, revokeArtifact };
}

test("compiles exact two-grant provision and ACK-bound paired cleanup after closed v2 recovery", () => {
  const { provisionArtifact, revokeArtifact } = lifecycle();
  const expected = [
    { grantId: "00000000-0000-4000-8000-000000000002", permission: "directory.profile.edit" },
    { grantId: "00000000-0000-4000-8000-000000000003", permission: "directory.identity.link" },
  ];
  assert.deepEqual(provisionArtifact.selection, expected);
  assert.deepEqual(revokeArtifact.selection, expected);
  assert.equal(provisionArtifact.input.recoveryLineage.provisionArtifact.schemaVersion, 2);
  assert.equal(provisionArtifact.input.recoveryLineage.revokeArtifact.schemaVersion, 2);
  assert.deepEqual(JSON.parse(provisionArtifact.receipt.result_json), {
    active: 1, generation: provisionArtifact.input.generation.generation + 2,
    grantIds: expected.map(row => row.grantId), phase: "provision", settlementSha256: null,
  });
  assert.deepEqual(JSON.parse(revokeArtifact.receipt.result_json), {
    active: 0, generation: revokeArtifact.input.generation.generation + 2,
    grantIds: expected.map(row => row.grantId), phase: "revoke",
    settlementSha256: JSON.parse(revokeArtifact.approval.canonical_plan_json).settlementSha256,
  });
  assert.equal(revokeArtifact.statements.filter(row => row.sql === "UPDATE native_staff_bootstrap_approvals SET revoked_at=? WHERE approval_id=? AND revoked_at IS NULL").length, 1);
  assert.equal(revokeArtifact.statements.filter(row => row.sql.startsWith("UPDATE native_directory_grants SET active=?")).length, 2);
  const provisionOpenWindow = provisionArtifact.statements.find(row => row.sql.includes("scalar-authority-open-window"));
  assert.deepEqual(provisionOpenWindow.params, [target.staffId, provisionArtifact.approval.approval_id,
    provisionArtifact.input.recoveryLineage.revokeArtifact.approval.approval_id, ""]);
  assertBoundStatements(provisionArtifact);
  assertBoundStatements(revokeArtifact);
});

test("canonical plan binds exact scalar prestate, relationship mapping, and current mixed-area scope", () => {
  const { provisionInput, provisionArtifact } = lifecycle();
  const canonical = JSON.parse(provisionArtifact.approval.canonical_plan_json);
  assert.deepEqual(canonical.scalarPrestate, provisionInput.scalarPrestate);
  assert.deepEqual(canonical.scalarPrestate.before.record, {
    record_id: target.clientRecordId, record_kind: "client", current_version: target.clientVersion,
  });
  assert.equal(canonical.scalarPrestate.before.relationship.organization_record_id, target.organizationRecordId);
  assert.equal(canonical.scalarPrestate.before.relationship.relationship_version, target.relationshipVersion);
  assert.deepEqual(canonical.scalarPrestate.before.resourceScopes, [{
    record_id: target.clientRecordId, scope_kind: "business_area", business_area_id: recoveryTargetV2.clientBusinessAreaId,
    division_id: null, active: 1,
  }]);
  assert.equal(canonical.scalarPrestate.plan.field, "email");
  assert.equal(canonical.scalarPrestate.plan.destinations[0].sourceId, target.sourceId);
  assert.deepEqual(canonical.scalarPrestate.plan.temporaryGrantIds, {
    profileEdit: provisionArtifact.selection[0].grantId,
    identityLink: provisionArtifact.selection[1].grantId,
  });
});

test("rejects wrong actor, relationship, parent, history, approval, and settled drift", () => {
  const { provisionArtifact } = lifecycle();
  const cases = [
    ["actor", input => { input.scalarPrestate.plan.actor.staffId = "other"; }],
    ["relationship", input => { input.relationship.organization_record_id = "other"; }],
    ["parent", input => { input.settlement.settled.relationshipDependencies[0].organization_record_id = "other"; }],
    ["history", input => { input.history.pop(); }],
    ["approval", input => { input.approval.approvalId = input.recoveryLineage.provisionArtifact.approval.approval_id; }],
    ["scope drift", input => { input.settlement.settled.resourceScopes[0].active = 0; }],
  ];
  for (const [label, mutate] of cases) {
    const input = makeScalarAuthorityInput({ phase: "revoke", provisionArtifact });
    mutate(input);
    assert.throws(() => compileDirectoryScalarAuthorityV184(input), undefined, label);
  }
});

test("binds every writer actor field to current native identity and selected grants", () => {
  const cases = [
    ["access subject", actor => { actor.accessSubject = "access|other"; }],
    ["login email", actor => { actor.loginEmail = "other@example.test"; }],
    ["admission version", actor => { actor.admissionVersion += 1; }],
    ["profile version", actor => { actor.profileVersion += 1; }],
    ["selected edit grant", actor => { actor.selectedGrantId = "00000000-0000-4000-8000-000000000004"; }],
    ["selected identity grant", actor => { actor.selectedIdentityGrantId = "00000000-0000-4000-8000-000000000004"; }],
  ];
  for (const [label, mutate] of cases) {
    const input = makeScalarAuthorityInput();
    mutate(input.scalarPrestate.plan.actor);
    assert.throws(() => compileDirectoryScalarAuthorityV184(input), /exact intended scalar plan/, label);
  }
});

test("rejects self-consistent actor row drift after closed recovery", () => {
  const cases = [
    ["subject", input => { input.staff.access_subject = "access|other"; input.admission.bound_access_subject = "access|other"; input.scalarPrestate.plan.actor.accessSubject = "access|other"; }],
    ["email", input => { input.profile.login_email = "other@example.test"; input.scalarPrestate.plan.actor.loginEmail = "other@example.test"; }],
    ["admission version", input => { input.admission.version += 1; input.scalarPrestate.plan.actor.admissionVersion += 1; }],
    ["profile version", input => { input.profile.version += 1; input.scalarPrestate.plan.actor.profileVersion += 1; }],
  ];
  for (const [label, mutate] of cases) {
    const input = makeScalarAuthorityInput();
    mutate(input);
    assert.throws(() => compileDirectoryScalarAuthorityV184(input), /exact closed recovery authority/, label);
  }
});

test("rejects internally consistent unrelated authority added after recovery close or scalar provision", () => {
  const provisionInput = makeScalarAuthorityInput();
  addConsistentInactiveAuthority(provisionInput);
  assert.throws(() => compileDirectoryScalarAuthorityV184(provisionInput), /exact closed recovery authority/);

  const { provisionArtifact } = lifecycle();
  const revokeInput = makeScalarAuthorityInput({ phase: "revoke", provisionArtifact });
  addConsistentInactiveAuthority(revokeInput);
  assert.throws(() => compileDirectoryScalarAuthorityV184(revokeInput), /exact provision authority successor/);
});

test("rejects self-consistent actor identity drift between scalar provision and cleanup", () => {
  const { provisionArtifact } = lifecycle();
  const input = makeScalarAuthorityInput({ phase: "revoke", provisionArtifact });
  input.staff.access_subject = "access|other";
  input.admission.bound_access_subject = "access|other";
  input.scalarPrestate.plan.actor.accessSubject = "access|other";
  input.settlement.plan.actor.accessSubject = "access|other";
  assert.throws(() => compileDirectoryScalarAuthorityV184(input), /exact provision authority successor/);
});

test("rejects cleanup before durable acknowledgement", () => {
  const { provisionArtifact } = lifecycle();
  const input = makeScalarAuthorityInput({ phase: "revoke", provisionArtifact });
  input.settlement.settled.intents[0].state = "materialized";
  assert.throws(() => compileDirectoryScalarAuthorityV184(input), /directory scalar settlement/);
});

test("rejects historical v1 recovery lineage", () => {
  const recoveryProvision = compileRelationshipRecoveryAuthorityV184(fixture());
  const recoveryRevokeInput = revokeFixture(fixture, recoveryProvision);
  const recoveryRevoke = compileRelationshipRecoveryAuthorityV184(recoveryRevokeInput);
  const input = makeScalarAuthorityInput();
  const state = clone(recoveryRevokeInput);
  const ids = recoveryProvision.input.approval.grantIds;
  for (const [index, id] of ids.entries()) {
    const row = state.grants.find(item => item.id === id); row.active = 0;
    state.history.push({ grant_id: id, grant_version: state.history.filter(item => item.grant_id === id).length + 1,
      staff_id: row.staff_id, permission: row.permission, effect: row.effect, scope_kind: row.scope_kind,
      business_area_id: row.business_area_id, division_id: row.division_id, resource_id: row.resource_id,
      active: 0, grant_generation: state.generation.generation + index + 1, recorded_at: recoveryRevokeInput.approval.executedAt });
  }
  state.generation.generation += 6;
  input.recoveryLineage = {
    provisionArtifact: recoveryProvision, revokeArtifact: recoveryRevoke,
    approvals: [{ ...recoveryProvision.approval, revoked_at: recoveryRevokeInput.approval.executedAt }, recoveryRevoke.approval],
    receipts: [recoveryProvision.receipt, recoveryRevoke.receipt], directoryGrants: state.grants,
    directoryGrantHistory: state.history, directoryGrantGeneration: state.generation,
  };
  input.grants = clone(state.grants); input.history = clone(state.history); input.generation = clone(state.generation);
  assert.throws(() => compileDirectoryScalarAuthorityV184(input), /exact closed v2 recovery lineage/);
});

test("rejects current-scope substitution and UTF-8 canonical plans above the ledger limit", () => {
  const wrongScope = makeScalarAuthorityInput();
  wrongScope.scalarPrestate.before.resourceScopes[0].business_area_id = "land-services-staging";
  assert.throws(() => compileDirectoryScalarAuthorityV184(wrongScope), /current scope/);

  const oversized = makeScalarAuthorityInput();
  oversized.scalarPrestate.plan.afterProfile.email = "é".repeat(140_000);
  assert.throws(() => compileDirectoryScalarAuthorityV184(oversized), /bounded evidence/);
});
