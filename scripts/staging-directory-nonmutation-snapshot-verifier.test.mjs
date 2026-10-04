import assert from "node:assert/strict";
import test from "node:test";
import { CLIENT_DIRECTORY_NONMUTATION_MANIFEST as manifest, compareClientDirectoryNonmutation,
  verifyClientDirectoryCapture, verifyClientDirectoryCaptureJson } from "./staging-directory-nonmutation-snapshot-verifier.mjs";

function capture(mode = "primary-bookmark") {
  return { version: 1, provenance: { environment: "staging", database: "Client",
    databaseId: "b6f653ab-9acd-4421-9ad0-207754b59aeb", revision: "538dff936c2049fc16416b639a4ef6a986ab3b25",
    readConsistency: { mode, bookmark: mode === "primary-bookmark" ? "opaque-bookmark" : null } },
    tables: Object.fromEntries(Object.entries(manifest).map(([name, spec]) => [name, { columns: [...spec.columns], rows: [] }])) };
}
function populated() {
  const value = capture();
  const table = value.tables.operations_portal_native_delivery_heads;
  table.rows = [
    { authority_id: "b", recipient_binding_id: "r2", folder_reservation_id: "f2", target_id: "t", revision: 2, state: "active", latest_operation_id: "o2" },
    { authority_id: "a", recipient_binding_id: "r1", folder_reservation_id: "f1", target_id: "t", revision: 1, state: "active", latest_operation_id: "o1" },
  ];
  return value;
}

test("produces only bounded table counts and full-row hashes in canonical PK order", () => {
  const first = verifyClientDirectoryCapture(populated());
  const reordered = populated(); reordered.tables.operations_portal_native_delivery_heads.rows.reverse();
  const second = verifyClientDirectoryCapture(reordered);
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first.tables[0]), ["table", "rowCount", "sha256"]);
  assert.equal(JSON.stringify(first).includes("recipient_binding_id"), false);
  assert.equal(compareClientDirectoryNonmutation(populated(), reordered).unchanged, true);
});

test("reports changed table names without row data", () => {
  const before = populated(), after = populated();
  after.tables.operations_portal_native_delivery_heads.rows[0].state = "revoked";
  const result = compareClientDirectoryNonmutation(before, after);
  assert.equal(result.unchanged, false);
  assert.deepEqual(result.changedTables, ["operations_portal_native_delivery_heads"]);
  assert.equal(JSON.stringify(result).includes("revoked"), false);
});

test("rejects missing tables, column drift, unknown columns, duplicate keys, and overflow", () => {
  const missing = capture(); delete missing.tables.shares;
  assert.throws(() => verifyClientDirectoryCapture(missing), /capture contract/);
  const drift = capture(); drift.tables.shares.columns.push("surprise");
  assert.throws(() => verifyClientDirectoryCapture(drift), /columns drifted/);
  const unknown = populated(); unknown.tables.operations_portal_native_delivery_heads.rows[0].surprise = "x";
  assert.throws(() => verifyClientDirectoryCapture(unknown), /capture contract/);
  const duplicate = populated(); duplicate.tables.operations_portal_native_delivery_heads.rows.push({ ...duplicate.tables.operations_portal_native_delivery_heads.rows[0] });
  assert.throws(() => verifyClientDirectoryCapture(duplicate), /duplicate primary key/);
  assert.throws(() => verifyClientDirectoryCapture(populated(), { maxRowsPerTable: 1 }), /row bound exceeded/);
  assert.throws(() => verifyClientDirectoryCaptureJson("{}", { maxBytes: 1 }), /byte bound exceeded/);
});

test("makes unavailable bookmark provenance and comparison limits explicit", () => {
  assert.equal(compareClientDirectoryNonmutation(capture(), capture()).atomicityClaim, "not-attested");
  const before = capture("primary-read-unbookmarked"), after = capture("primary-read-unbookmarked");
  assert.equal(compareClientDirectoryNonmutation(before, after).atomicityClaim, "not-attested");
  assert.equal(compareClientDirectoryNonmutation(before, after).equalityClaim, "declared-capture-equality-only");
  const bad = capture(); bad.provenance.environment = "production";
  assert.throws(() => verifyClientDirectoryCapture(bad), /staging Client/);
  const wrongDatabase = capture(); wrongDatabase.provenance.databaseId = "00000000-0000-4000-8000-000000000000";
  assert.throws(() => verifyClientDirectoryCapture(wrongDatabase), /databaseId/);
  const shortRevision = capture(); shortRevision.provenance.revision = "538dff93";
  assert.throws(() => verifyClientDirectoryCapture(shortRevision), /full commit SHA/);
});
