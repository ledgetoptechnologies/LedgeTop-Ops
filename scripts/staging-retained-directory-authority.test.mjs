import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  RETAINED_DIRECTORY_TARGET, REVIEWED_REFERENCE_BASELINE, applyAndReconcileRetainedDirectoryAuthority,
  compileRetainedDirectoryAuthority, verifyHistoricalNativeOnlyArtifact, verifyReviewedReferenceSchema,
} from "./staging-retained-directory-authority.mjs";
import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";

const UUIDS = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003"];
const grant = (id, permission, active) => ({ id, staff_id: RETAINED_DIRECTORY_TARGET.staffId, permission, effect: "allow", scope_kind: "business_area", business_area_id: RETAINED_DIRECTORY_TARGET.areaId, division_id: null, resource_id: null, active, granted_by: RETAINED_DIRECTORY_TARGET.staffId, created_at: "2026-10-08T12:00:00.000Z" });
const history = (row, version, active, generation) => ({ grant_id: row.id, grant_version: version, staff_id: row.staff_id, permission: row.permission, effect: row.effect, scope_kind: row.scope_kind, business_area_id: row.business_area_id, division_id: null, resource_id: null, active, grant_generation: generation, recorded_at: `2026-10-08T12:0${generation}:00.000Z` });
const receipt = (command, approval, plan = "{}") => ({ command_id: command, approval_id: approval, operator_staff_id: RETAINED_DIRECTORY_TARGET.staffId, operator_access_subject: "access|staff", canonical_plan_json: plan, canonical_plan_sha256: "a".repeat(64), independent_binding_verification_json: "{}", independent_binding_verification_sha256: "b".repeat(64), result_json: "{}", result_sha256: "c".repeat(64), executed_at: "2026-10-08T12:00:00.000Z" });
const legacy = (phase, priorProvision = null) => {
  const r = receipt(`20000000-0000-4000-8000-00000000000${phase === "provision" ? 1 : 2}`, `30000000-0000-4000-8000-00000000000${phase === "provision" ? 1 : 2}`);
  return { schemaVersion: 3, input: { schemaVersion: 3, staging: STAGING_TARGET, phase,
    admission: { staff_id: RETAINED_DIRECTORY_TARGET.staffId }, businessArea: { id: RETAINED_DIRECTORY_TARGET.areaId },
    approval: { grantIds: UUIDS }, priorProvision }, receipt: r, approval: {}, statements: [] };
};

function input(phase = "reactivate") {
  const grants = [grant(UUIDS[0], "directory.profile.edit", phase === "revoke" ? 1 : 0), grant(UUIDS[1], "directory.identity.link", phase === "revoke" ? 1 : 0), grant(UUIDS[2], "directory.enrollment.manage", phase === "revoke" ? 1 : 0)];
  const rows = grants.flatMap((row, index) => [history(row, 1, 1, index + 1), history(row, 2, 0, index + 4), ...(phase === "revoke" ? [history(row, 3, 1, index + 7)] : [])]);
  const provisionArtifact = legacy("provision"), revokeArtifact = legacy("revoke", { receipt: provisionArtifact.receipt });
  return { schemaVersion: 1, staging: STAGING_TARGET, phase, target: RETAINED_DIRECTORY_TARGET,
    migrationNames: fs.readdirSync(path.resolve(import.meta.dirname, "../apps/operations/migrations")).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort(),
    admission: { staff_id: RETAINED_DIRECTORY_TARGET.staffId, bound_access_subject: "access|staff", active: 1, admitted_by: RETAINED_DIRECTORY_TARGET.staffId, created_at: "2026-10-08T12:00:00.000Z", updated_at: "2026-10-08T12:00:00.000Z", version: 1 },
    profile: { staff_id: RETAINED_DIRECTORY_TARGET.staffId, login_email: "staff@example.test", display_name: "Staff", version: 1, created_at: "2026-10-08T12:00:00.000Z", updated_at: "2026-10-08T12:00:00.000Z" }, generation: { staff_id: RETAINED_DIRECTORY_TARGET.staffId, generation: phase === "revoke" ? 9 : 6, updated_at: "2026-10-08T12:00:00.000Z" },
    projectGeneration: { staff_id: RETAINED_DIRECTORY_TARGET.staffId, generation: 14 },
    businessArea: { id: RETAINED_DIRECTORY_TARGET.areaId, name: "Synthetic", active: 1 },
    resourceScope: { record_id: RETAINED_DIRECTORY_TARGET.recordId, scope_kind: "business_area", business_area_id: RETAINED_DIRECTORY_TARGET.areaId, division_id: null, active: 1 },
    projectGrant: { id: "302f4862-retained-project-grant", staff_id: RETAINED_DIRECTORY_TARGET.staffId, capability: "project.shared.sync", effect: "allow", scope_kind: "business_area", business_area_id: RETAINED_DIRECTORY_TARGET.areaId, division_id: null, external_project_id: null, active: 0, version: 2, granted_by: RETAINED_DIRECTORY_TARGET.staffId, created_at: "2026-10-08T12:00:00.000Z" },
    grants, history: rows, referenceCounts: { ...REVIEWED_REFERENCE_BASELINE, native_directory_grant_history: phase === "revoke" ? 9 : 6 }, predecessor: { command_id: RETAINED_DIRECTORY_TARGET.predecessorCommandId, source_id: RETAINED_DIRECTORY_TARGET.sourceId, resource_type: "client", external_id: RETAINED_DIRECTORY_TARGET.recordId, state: "terminal", outcome_json: JSON.stringify({ directoryProfileDispatcher: "conflict", reason: "http_status", httpStatus: 409, requestId: "c2f0de0c-5e83-4d2b-b916-d46b15bacfcb" }) },
    lineage: { provisionArtifact, revokeArtifact, provisionReceipt: provisionArtifact.receipt, revokeReceipt: revokeArtifact.receipt },
    approval: { approvalId: "40000000-0000-4000-8000-000000000001", commandId: "40000000-0000-4000-8000-000000000002", issuedAt: "2026-10-08T13:00:00.000Z", expiresAt: "2026-10-08T14:00:00.000Z", executedAt: "2026-10-08T13:00:00.000Z" } };
}

const historicalVerifier = value => value;
const compile = value => compileRetainedDirectoryAuthority(value,
  { root: path.resolve(import.meta.dirname, ".."), historicalVerifier });

// Isolate tests from the legacy compiler while still exercising immutable equality checks.
test("retained authority compiler is isolated to exact fixture and same three grant IDs", () => {
  const artifact = compile(input());
  assert.deepEqual(artifact.input.grants.map(row => row.id), UUIDS);
  assert.equal(artifact.input.target.recordId, RETAINED_DIRECTORY_TARGET.recordId);
});

test("rejects an unrelated area reference, deny-shaped grant, and changed predecessor", () => {
  for (const mutate of [
    value => { value.referenceCounts.native_staff_admin_delegations = 1; },
    value => { value.grants[0].effect = "deny"; },
    value => { value.predecessor.command_id = "50000000-0000-4000-8000-000000000001"; },
  ]) { const value = input(); mutate(value); assert.throws(() => compile(value)); }
});

test("unknown apply response reconciles only the exact immutable receipt", async () => {
  const artifact = { receipt: receipt("60000000-0000-4000-8000-000000000001", "60000000-0000-4000-8000-000000000002"), statements: [] };
  const db = { prepare: () => ({ bind() { return this; }, first: async () => artifact.receipt }) };
  assert.equal((await applyAndReconcileRetainedDirectoryAuthority(db, artifact, { target: STAGING_TARGET, apply: async () => { throw new Error("lost"); } })).status, "committed-after-response-recovery");
  await assert.rejects(applyAndReconcileRetainedDirectoryAuthority({ prepare: () => ({ bind() { return this; }, first: async () => ({ ...artifact.receipt, result_sha256: "d".repeat(64) }) }) }, artifact, { target: STAGING_TARGET, apply: async () => {} }), /receipt mismatch/);
});

test("generated batch retains CAS, deny, unsettled-work, history and exact reference guards", () => {
  const sql = compile(input()).statements.map(row => row.sql).join("\n");
  assert.match(sql, /changes\(\)=1/); assert.match(sql, /effect='deny'/); assert.match(sql, /pending','leased/);
  assert.match(sql, /history-suffix-count/); assert.match(sql, /reference-native_project_grants/);
});

test("paired revoke requires the exact reactivation receipt and CAS-revokes its approval", () => {
  const reactivation = compile(input());
  const revoke = input("revoke");
  revoke.lineage.reactivationArtifact = reactivation;
  revoke.lineage.reactivationReceipt = reactivation.receipt;
  revoke.approval.approvalId = "70000000-0000-4000-8000-000000000001";
  revoke.approval.commandId = "70000000-0000-4000-8000-000000000002";
  const artifact = compile(revoke), sql = artifact.statements.map(row => row.sql).join("\n");
  assert.match(sql, /SET revoked_at=\?/); assert.match(sql, /reactivation-approval-cas/);
  const forged = input("revoke");
  forged.lineage.reactivationArtifact = reactivation;
  forged.lineage.reactivationReceipt = { ...reactivation.receipt, result_sha256: "f".repeat(64) };
  assert.throws(() => compile(forged), /immutable reactivation lineage/);
});

test("reference discovery rejects an unrelated or missing business-area table", async () => {
  const database = names => ({ prepare: sql => ({
    async all() {
      if (sql.includes("sqlite_schema")) return { results: names.map(name => ({ name })) };
      const name = /table_info\("([^"]+)"\)/.exec(sql)?.[1];
      return { results: [{ name: "id" }, ...(Object.hasOwn(REVIEWED_REFERENCE_BASELINE, name) || name === "unrelated_reference" ? [{ name: "business_area_id" }] : [])] };
    },
  }) });
  const reviewed = Object.keys(REVIEWED_REFERENCE_BASELINE);
  assert.deepEqual((await verifyReviewedReferenceSchema(database(reviewed))).sort(), [...reviewed].sort());
  await assert.rejects(verifyReviewedReferenceSchema(database([...reviewed, "unrelated_reference"])), /reference schema changed/);
  await assert.rejects(verifyReviewedReferenceSchema(database(reviewed.slice(1))), /reference schema changed/);
});

test("historical 0180 provision and paired revoke artifacts retain valid immutable hashes", { skip: !fs.existsSync(path.resolve(import.meta.dirname, "../.backups/staging-native-authority/5731d19f-fea5-4be7-8b6f-83fc2e427e26/provision.json")) }, () => {
  const directory = path.resolve(import.meta.dirname, "../.backups/staging-native-authority/5731d19f-fea5-4be7-8b6f-83fc2e427e26");
  const provision = JSON.parse(fs.readFileSync(path.join(directory, "provision.json"), "utf8"));
  const revoke = JSON.parse(fs.readFileSync(path.join(directory, "revoke-recovery-2026-10-08T21-51-25.947Z.json"), "utf8"));
  assert.equal(verifyHistoricalNativeOnlyArtifact(provision).input.phase, "provision");
  assert.equal(verifyHistoricalNativeOnlyArtifact(revoke).input.phase, "revoke");
  assert.deepEqual(revoke.input.priorProvision.receipt, provision.receipt);
});

test("default compiler accepts the genuine historical lineage without reconstructing it as 0181", { skip: !fs.existsSync(path.resolve(import.meta.dirname, "../.backups/staging-native-authority/5731d19f-fea5-4be7-8b6f-83fc2e427e26/provision.json")) }, () => {
  const directory = path.resolve(import.meta.dirname, "../.backups/staging-native-authority/5731d19f-fea5-4be7-8b6f-83fc2e427e26");
  const provision = JSON.parse(fs.readFileSync(path.join(directory, "provision.json"), "utf8"));
  const revoke = JSON.parse(fs.readFileSync(path.join(directory, "revoke-recovery-2026-10-08T21-51-25.947Z.json"), "utf8"));
  const value = input(), actualIds = provision.input.approval.grantIds;
  const replacements = new Map(UUIDS.map((id, index) => [id, actualIds[index]]));
  value.grants = value.grants.map(row => ({ ...row, id: replacements.get(row.id) }));
  value.history = value.history.map(row => ({ ...row, grant_id: replacements.get(row.grant_id) }));
  value.lineage = { provisionArtifact: provision, revokeArtifact: revoke,
    provisionReceipt: provision.receipt, revokeReceipt: revoke.receipt };
  const artifact = compileRetainedDirectoryAuthority(value, { root: path.resolve(import.meta.dirname, "..") });
  assert.deepEqual(artifact.input.grants.filter(row => actualIds.includes(row.id)).map(row => row.id), actualIds);
  const assertD1Envelope = compiled => {
    assert.ok(Buffer.byteLength(compiled.approval.canonical_plan_json) <= 262_144);
    for (const row of [compiled.approval, compiled.receipt]) {
      assert.ok(Object.values(row).reduce((sum, item) => sum + (item === null ? 0 : Buffer.byteLength(typeof item === "string" ? item : String(item))), 0) <= 2_000_000);
    }
    assert.ok(Math.max(...compiled.statements.map(statement => statement.params.length)) <= 100);
    assert.ok(Math.max(...compiled.statements.map(statement => Buffer.byteLength(statement.sql))) <= 100_000);
    assert.ok(Math.max(...compiled.statements.flatMap(statement => statement.params)
      .filter(item => typeof item === "string").map(item => Buffer.byteLength(item))) <= 2_000_000);
  };
  assertD1Envelope(artifact);

  const revokeValue = structuredClone(value);
  revokeValue.phase = "revoke";
  revokeValue.grants = revokeValue.grants.map(row => ({ ...row, active: 1 }));
  revokeValue.history = revokeValue.history.concat(revokeValue.grants.map((row, index) => history(row, 3, 1, value.generation.generation + index + 1)));
  revokeValue.generation = { ...revokeValue.generation, generation: value.generation.generation + 3 };
  revokeValue.referenceCounts.native_directory_grant_history += 3;
  revokeValue.lineage.reactivationArtifact = artifact;
  revokeValue.lineage.reactivationReceipt = artifact.receipt;
  revokeValue.approval = { ...revokeValue.approval,
    approvalId: "70000000-0000-4000-8000-000000000001", commandId: "70000000-0000-4000-8000-000000000002" };
  const pairedRevoke = compileRetainedDirectoryAuthority(revokeValue, { root: path.resolve(import.meta.dirname, "..") });
  assertD1Envelope(pairedRevoke);
});

test("schema 2 reopens only the latest verified close and derives v5/v6 history guards", () => {
  const firstOpen = compile(input());
  const firstCloseInput = input("revoke");
  const unrelated = { ...grant("unrelated-global-grant", "directory.profile.view", 0), scope_kind: "global", business_area_id: null };
  firstCloseInput.grants.push(unrelated);
  firstCloseInput.history.push({ ...history(unrelated, 1, 1, 20), recorded_at: "2026-10-08T12:20:00.000Z" },
    { ...history(unrelated, 2, 0, 21), recorded_at: "2026-10-08T12:21:00.000Z" });
  firstCloseInput.lineage.reactivationArtifact = firstOpen;
  firstCloseInput.lineage.reactivationReceipt = firstOpen.receipt;
  firstCloseInput.approval = { ...firstCloseInput.approval,
    approvalId: "71000000-0000-4000-8000-000000000001", commandId: "71000000-0000-4000-8000-000000000002" };
  const latestClose = compile(firstCloseInput);
  const closedGrants = firstCloseInput.grants.map(row => ({ ...row, active: 0 }));
  const closedHistory = [...firstCloseInput.history, ...closedGrants.filter(row => UUIDS.includes(row.id)).map((row, index) => ({
    ...history(row, 4, 0, 10 + index), recorded_at: `2026-10-08T12:10:0${index}.000Z`,
  }))];
  const reopenInput = { ...structuredClone(firstCloseInput), schemaVersion: 2, phase: "reactivate",
    grants: closedGrants, history: closedHistory,
    generation: { ...firstCloseInput.generation, generation: 12 },
    referenceCounts: { ...firstCloseInput.referenceCounts, native_directory_grant_history: 12 },
    lineage: { latestCloseArtifact: latestClose, latestCloseReceipt: latestClose.receipt },
    approval: { ...firstCloseInput.approval, approvalId: "72000000-0000-4000-8000-000000000001",
      commandId: "72000000-0000-4000-8000-000000000002" } };
  const reopened = compile(reopenInput);
  assert.ok(reopened.statements.some(row => row.params.includes(5)));
  const closeInput = { ...structuredClone(reopenInput), phase: "revoke",
    grants: reopenInput.grants.map(row => UUIDS.includes(row.id) ? ({ ...row, active: 1 }) : row),
    history: [...reopenInput.history, ...reopenInput.grants.filter(row => UUIDS.includes(row.id)).map((row, index) => ({
      ...history({ ...row, active: 1 }, 5, 1, 13 + index), recorded_at: `2026-10-08T12:11:0${index}.000Z`,
    }))],
    generation: { ...reopenInput.generation, generation: 15 },
    referenceCounts: { ...reopenInput.referenceCounts, native_directory_grant_history: 15 },
    lineage: { ...reopenInput.lineage, reactivationArtifact: reopened, reactivationReceipt: reopened.receipt },
    approval: { ...reopenInput.approval, approvalId: "73000000-0000-4000-8000-000000000001",
      commandId: "73000000-0000-4000-8000-000000000002" } };
  const closed = compile(closeInput);
  assert.ok(closed.statements.some(row => row.params.includes(6)));
  assert.deepEqual(closed.input.grants.find(row => row.id === unrelated.id), unrelated);
  assert.equal(closed.input.history.filter(row => row.grant_id === unrelated.id).length, 2);
  for (const [key, reused] of [["approvalId", reopened.approval.approval_id], ["commandId", reopened.receipt.command_id]]) {
    const collision = structuredClone(closeInput); collision.approval[key] = reused;
    assert.throws(() => compile(collision), /fresh phase identifiers required/);
  }
  const stale = structuredClone(reopenInput);
  stale.history.splice(-1, 1); stale.referenceCounts.native_directory_grant_history--;
  assert.throws(() => compile(stale), /complete retained grant history|complete latest retained history/);
});
