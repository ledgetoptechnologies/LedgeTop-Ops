import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { assertPreserved, normalizedSql } from "./staging-native-portal-149-194-migrations.mjs";
import { fileURLToPath } from "node:url";
import { createNativeDirectoryMigrationWindow, reviewedNativeDirectorySchemaDefinitions } from "./staging-native-directory-migration-window.mjs";
import { OPERATIONS_CURRENT_SOURCE_MIGRATION_CHAIN as FROZEN203 } from "./staging-bootstrap.mjs";
import { OPERATIONS_SOURCE_CHAIN_204 } from "./staging-operations-source-v204.mjs";
import { verifyNativeDirectory203SourceCi } from "./staging-native-directory-200-203-migrations.mjs";

// Source CI validation is shared: all ten jobs must pass for the exact clean
// checkout. The migration inventory and execution window are separately pinned.
export { SOURCE_CI_JOBS, assertNativeDirectory203SourceCi as assertNativeProject204SourceCi,
  verifyNativeDirectory203SourceCi as verifyNativeProject204SourceCi } from "./staging-native-directory-200-203-migrations.mjs";
export const SPEC = Object.freeze({
  application: "operations", preservationPolicy: "strict", from: 203, to: 204,
  database: "78b34173-b168-4e3d-9832-bb9d245cc6b8", databaseName: "ltds-ops-staging", binding: "OPS_DB",
  priorNamesSha256: FROZEN203.namesSha256, priorContentsSha256: FROZEN203.contentsSha256,
  suffix: Object.freeze(Object.entries(OPERATIONS_SOURCE_CHAIN_204.appendedMigrations)
    .map(([name, sha256]) => Object.freeze({ name, sha256 }))),
});
// Only this reviewed204 window permits the exact nullable lineage column.
export function assertNativeProject204Preserved(before, after, sql) {
  assert.equal(crypto.createHash("sha256").update(sql).digest("hex"),
    OPERATIONS_SOURCE_CHAIN_204.appendedMigrations[OPERATIONS_SOURCE_CHAIN_204.finalMigration], "exact frozen204 SQL required");
  const alter = "ALTER TABLE operations_shared_project_revisions ADD COLUMN lifecycle_settlement_id TEXT REFERENCES native_project_lifecycle_settlements(settlement_id) ON DELETE RESTRICT";
  assert(sql.includes(`${alter};`), "exact reviewed204 additive column required");
  const table = "operations_shared_project_revisions";
  const prior = before.schema.find(row => row.type === "table" && row.name === table);
  assert(prior && !/\blifecycle_settlement_id\b/.test(prior.sql), "prior203 lineage table required");
  const local = new DatabaseSync(":memory:");
  let expected;
  try {
    local.exec(prior.sql); local.exec(alter);
    expected = local.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table).sql;
    const column = local.prepare(`PRAGMA table_info(${table})`).all().find(row => row.name === "lifecycle_settlement_id");
    assert.equal(column.type, "TEXT"); assert.equal(column.notnull, 0); assert.equal(column.dflt_value, null);
  } finally { local.close(); }
  const definitions = reviewedNativeDirectorySchemaDefinitions(sql);
  definitions.set(table, { type: "table", sql: normalizedSql(expected) });
  const projected = structuredClone(before);
  projected.data[table] = before.data[table].map(raw => {
    const row = JSON.parse(raw); assert(!Object.hasOwn(row, "lifecycle_settlement_id"));
    return JSON.stringify({ ...row, lifecycle_settlement_id: null });
  }).sort();
  assertPreserved(projected, after, definitions, "strict");
}
const window = createNativeDirectoryMigrationWindow(SPEC,
  (base, dependencies) => (dependencies.sourceCiGate ?? verifyNativeDirectory203SourceCi)(base, dependencies), assertNativeProject204Preserved);
export const buildNativeProject203To204Plan = window.buildPlan;
export const materializeNativeProject203To204 = window.materialize;
export const nativeProject203To204ReadOnlyQueries = window.readOnlyQueries;
export const runNativeProject203To204 = window.run;
export const safeNativeProject203To204Failure = window.safeFailure;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runNativeProject203To204().then(value => console.log(JSON.stringify(value))).catch(() => {
    console.error(safeNativeProject203To204Failure()); process.exitCode = 1;
  });
