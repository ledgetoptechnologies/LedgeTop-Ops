import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { assertApplyReady, assertNoForeignKeyViolations, assertPostflightPreserved,
  assertSafePrivateArtifactStat, buildOperations0186To0187Plan } from
  "./staging-operations-migrations-0186-0187.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

test("pins the exact 185 to 187 one-shot suffix", () => {
  const plan = buildOperations0186To0187Plan(root);
  assert.equal(plan.priorNames.length, 185); assert.equal(plan.finalNames.length, 187);
  assert.deepEqual(plan.migrations.map(row => row.name), [
    "0186_project_alpha_directory_conflict_evidence_binding.sql",
    "0187_operations_portal_native_delivery_literal_prefix_guard.sql",
  ]);
  for (const migration of plan.migrations) assert.equal(
    sha(fs.readFileSync(path.join(plan.directory, migration.name))), migration.sha256);
});

test("keeps the helper private-backup-first and binding-free", () => {
  const source = fs.readFileSync(new URL("./staging-operations-migrations-0186-0187.mjs", import.meta.url), "utf8");
  assert.match(source, /scripts\/restrict-private-authority-file\.ps1/u);
  assert.ok(source.indexOf("privateFile(paths.marker") < source.indexOf("wrangler(token, paths.config, [\"migrations\""));
  assert.match(source, /wrangler\(token, paths\.config, \["export"/u);
  assert.ok(source.indexOf("wrangler(token, paths.config, [\"export\"") <
    source.indexOf("restrictPrivateFile(paths.backup)"));
  assert.match(source, /snapshot: current/u);
  assert.doesNotMatch(source, /services|r2_buckets|kv_namespaces|durable_objects/u);
  assert.match(source, /d1_databases/u);
});

test("apply gate is fresh, exact, and permanently refuses a prior attempt", () => {
  const snapshot = { schema: [{ name: "before" }] };
  const now = Date.parse("2026-10-10T18:00:00Z");
  const saved = { createdAt: "2026-10-10T17:45:00Z", snapshot };
  assert.doesNotThrow(() => assertApplyReady(structuredClone(snapshot), saved, false, now));
  assert.throws(() => assertApplyReady(structuredClone(snapshot), saved, true, now), /never retry/u);
  assert.throws(() => assertApplyReady({ schema: [] }, saved, false, now));
  assert.throws(() => assertApplyReady(structuredClone(snapshot), saved, false,
    Date.parse("2026-10-10T18:15:01Z")), /Fresh backup/u);
});

test("integrity gates reject foreign-key violations and private artifact symlinks", () => {
  assert.doesNotThrow(() => assertNoForeignKeyViolations([]));
  assert.throws(() => assertNoForeignKeyViolations([{ table: "x", rowid: 1, parent: "y", fkid: 0 }]),
    /Foreign-key violations/u);
  assert.doesNotThrow(() => assertSafePrivateArtifactStat({ isFile: () => true, isSymbolicLink: () => false }));
  assert.throws(() => assertSafePrivateArtifactStat({ isFile: () => true, isSymbolicLink: () => true }),
    /non-symlink/u);
  assert.throws(() => assertSafePrivateArtifactStat({ isFile: () => false, isSymbolicLink: () => false }),
    /regular/u);
});

test("postflight remains usable after expiry and rejects every unrelated state change", () => {
  const keys = ["grants", "workspaceHeads", "recipientHeads", "deliveryHeads", "publicationOutbox",
    "recipientOutbox", "deliveryOutbox", "conflicts"];
  const saved = { schema: [{ name: "unchanged", sql: "CREATE VIEW unchanged AS SELECT 1" }] };
  for (const key of keys) saved[key] = [{ id: `${key}-before` }];
  const expected = new Map([
    ["project_alpha_api_v2_directory_observations_current", "CREATE VIEW project_alpha_api_v2_directory_observations_current AS SELECT 2;"],
    ["operations_portal_native_delivery_grant_folder_guard", "CREATE TRIGGER operations_portal_native_delivery_grant_folder_guard AFTER INSERT ON x BEGIN SELECT 1; END;"],
  ]);
  const current = structuredClone(saved);
  current.schema.push(...[...expected].map(([name, sql]) => ({ name, sql })));
  // Postflight intentionally takes no timestamp: it must reconcile safely after an interrupted release.
  assert.doesNotThrow(() => assertPostflightPreserved(current, saved, expected));
  for (const key of keys) {
    const changed = structuredClone(current); changed[key].push({ id: `${key}-unexpected` });
    assert.throws(() => assertPostflightPreserved(changed, saved, expected), key);
  }
  const unrelatedSchema = structuredClone(current);
  unrelatedSchema.schema[0].sql = "CREATE VIEW unchanged AS SELECT 9";
  assert.throws(() => assertPostflightPreserved(unrelatedSchema, saved, expected));
});
