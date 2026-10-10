import assert from "node:assert/strict";
import test from "node:test";

import { captureDirectoryScalarSnapshot, reconstructClosedRecoveryLineage } from "./staging-directory-scalar-evidence-capture.mjs";
import { recoveryLineage, scalarPrestate } from "./staging-directory-scalar-authority-v184-fixtures.mjs";

function dbFrom(handler) {
  const queries = [];
  return { queries, db: { prepare(sql) {
    assert.match(sql, /^SELECT\b/i); assert.equal(sql.includes(";"), false); queries.push(sql);
    let params = [];
    return { bind(...values) { params = values; return this; }, async all() { return { results: structuredClone(handler(sql, params, "all") ?? []) }; }, async first() { return structuredClone(handler(sql, params, "first") ?? null); } };
  } } };
}

function snapshotHandler(before, overrides = {}) {
  return sql => {
    if (sql.includes("intent_relationship_dependencies")) return overrides.dependencies ?? before.relationshipDependencies;
    if (sql.includes("active_directory_mappings")) return overrides.mappings ?? [];
    if (sql.includes("existing_directory_binding_activation_receipts")) return overrides.receipts ?? [];
    if (sql.includes("operations_directory_records WHERE record_id=?")) return overrides.record ?? before.record;
    if (sql.includes("operations_directory_records WHERE record_id<>?")) return before.protectedSnapshots.records;
    if (sql.includes("operations_directory_revisions")) return before.revisions;
    if (sql.includes("operations_directory_audit")) return before.audits;
    if (sql.includes("operations_directory_intents WHERE")) return before.intents;
    if (sql.includes("operations_directory_materializations")) return before.materializations;
    if (sql.includes("project_alpha_directory_outbox")) return before.outbox;
    if (sql.includes("client_organization_history WHERE")) return before.relationshipHistory;
    if (sql.includes("client_organization_history ORDER")) return before.protectedSnapshots.relationshipHistory;
    if (sql.includes("client_organizations WHERE")) return before.relationship;
    if (sql.includes("client_organizations ORDER")) return before.protectedSnapshots.relationships;
    if (sql.includes("resource_scopes WHERE record_id=?")) return before.resourceScopes;
    if (sql.includes("resource_scopes WHERE record_id<>?")) return before.protectedSnapshots.resourceScopes;
    if (sql.includes("enrollments WHERE record_id=?")) return before.enrollment;
    if (sql.includes("enrollments WHERE record_id<>?")) return before.protectedSnapshots.enrollments;
    throw new Error(`unexpected query: ${sql}`);
  };
}

test("captures the exact complete scalar snapshot using fixed SELECTs only", async () => {
  const before = scalarPrestate().before, state = dbFrom(snapshotHandler(before));
  assert.deepEqual(await captureDirectoryScalarSnapshot(state.db), before);
  assert.equal(state.queries.length, 16);
  assert.ok(state.queries.every(sql => /^SELECT\b/i.test(sql)));
});

test("captures exact acquired-parent evidence and rejects missing or ambiguous proof", async () => {
  const before = scalarPrestate().before;
  const dependency = { intent_id: "intent-1", client_record_id: before.record.record_id, evidence_kind: "acquired_mapping", parent_activation_id: "activation-1", organization_record_id: before.relationship.organization_record_id };
  const mapping = { provenance_id: "activation-1" }, receipt = { activation_id: "activation-1" };
  const good = dbFrom(snapshotHandler(before, { dependencies: [dependency], mappings: [mapping], receipts: [receipt] }));
  const captured = await captureDirectoryScalarSnapshot(good.db);
  assert.deepEqual(captured.relationshipDependencyEvidence, [{ intent_id: "intent-1", activeMapping: mapping, activationReceipt: receipt }]);
  const missing = dbFrom(snapshotHandler(before, { dependencies: [dependency], mappings: [], receipts: [receipt] }));
  await assert.rejects(captureDirectoryScalarSnapshot(missing.db), /exactly one row/);
  const ambiguous = dbFrom(snapshotHandler(before, { dependencies: [dependency], mappings: [mapping, mapping], receipts: [receipt] }));
  await assert.rejects(captureDirectoryScalarSnapshot(ambiguous.db), /exactly one row/);
});

test("rejects stale versions, arbitrary targets, and incomplete current evidence", async () => {
  const before = scalarPrestate().before;
  await assert.rejects(captureDirectoryScalarSnapshot(dbFrom(snapshotHandler(before)).db, { recordId: "other" }), /exact scalar target/);
  await assert.rejects(captureDirectoryScalarSnapshot(dbFrom(snapshotHandler(before, { record: { ...before.record, current_version: 3 } })).db), /missing or stale/);
  await assert.rejects(captureDirectoryScalarSnapshot(dbFrom(snapshotHandler({ ...before, enrollment: null })).db), /enrollment is missing/);
});

test("reconstructs and validates closed recovery lineage from exact artifacts and current rows", async () => {
  const expected = recoveryLineage();
  const state = dbFrom(sql => {
    if (sql.includes("bootstrap_approvals")) return expected.approvals;
    if (sql.includes("bootstrap_receipts")) return expected.receipts;
    if (sql.includes("native_directory_grants")) return expected.directoryGrants;
    if (sql.includes("native_directory_grant_history")) return expected.directoryGrantHistory;
    if (sql.includes("native_directory_grant_generations")) return expected.directoryGrantGeneration;
    throw new Error(`unexpected query: ${sql}`);
  });
  assert.deepEqual(await reconstructClosedRecoveryLineage(state.db, expected.provisionArtifact, expected.revokeArtifact), expected);
  assert.equal(state.queries.length, 5);
});

test("rejects incomplete or drifted recovery readback", async () => {
  const expected = recoveryLineage();
  const state = dbFrom(sql => {
    if (sql.includes("bootstrap_approvals")) return expected.approvals.slice(0, 1);
    if (sql.includes("bootstrap_receipts")) return expected.receipts;
    if (sql.includes("native_directory_grants")) return expected.directoryGrants;
    if (sql.includes("native_directory_grant_history")) return expected.directoryGrantHistory;
    if (sql.includes("native_directory_grant_generations")) return expected.directoryGrantGeneration;
    return [];
  });
  await assert.rejects(reconstructClosedRecoveryLineage(state.db, expected.provisionArtifact, expected.revokeArtifact), /incomplete or ambiguous/);
});

test("database stub proves non-SELECT statements are rejected at its boundary", () => {
  const state = dbFrom(() => []);
  assert.throws(() => state.db.prepare("UPDATE native_directory_grants SET active=0"), /SELECT/);
});
