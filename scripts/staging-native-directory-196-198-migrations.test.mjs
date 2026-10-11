import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import {
  applicationTableNames,
  assertApplyReady,
  assertAttemptMarker,
  assertPreserved,
  buildNativeDirectory196To198Plan,
  nativeDirectory196To198ReadOnlyQueries,
  normalizedSql,
  reviewedSchemaDefinitions,
  quoteSqlIdentifier,
  runNativeDirectory196To198,
  safeNativeDirectory196To198Failure,
  SPEC,
} from "./staging-native-directory-196-198-migrations.mjs";
import { transformSeed } from "./staging-bootstrap.mjs";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "apps/operations/package.json"));
const { Miniflare } = require("miniflare");
const { unstable_splitSqlQuery } = require("wrangler");
const syntheticOwner = { email: "owner@staging.example.test", displayName: "Synthetic Staging Owner",
  clientStaffId: "staging-client-owner", operationsStaffId: "staging-operations-owner" };
const current = plan => ({ ledger: plan.priorNames.map(name => ({ name })), foreignKeys: [], schema: [], data: {} });
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

test("dry-run pins exact Ops staging 196-to-198 chain and performs no I/O", async () => {
  const plan = buildNativeDirectory196To198Plan(root);
  const result = await runNativeDirectory196To198(["dry-run"], {
    credential: () => assert.fail("dry-run must not read credentials"),
    remoteState: () => assert.fail("dry-run must not call provider"),
  });
  assert.equal(result.account, "846c924bf17bf4f3dd15c97a4c5d1d51");
  assert.equal(result.database, "78b34173-b168-4e3d-9832-bb9d245cc6b8");
  assert.equal(result.from, 196);
  assert.equal(result.to, 198);
  assert.deepEqual(result.migrations, [
    { name: "0197_operations_portal_native_delivery_cancellation_checkpoint_scope.sql", sha256: "9cf2194a57cf7888c768d492c78cacf842e3f6c6814d3f395e6fa8f4d0a31a76" },
    { name: "0198_native_directory_active_binding_revision_refresh.sql", sha256: "a51026608eb70a0645540cfe12bad51feb7a97f924e0b2c3b83837a3ae2fa7c3" },
  ]);
  assert.deepEqual(plan.migrations, result.migrations);
  assert.equal(result.mutationsPerformed, false);
});

test("wrong target, extra SQL, and source drift fail closed", async () => {
  let requested = false;
  await assert.rejects(nativeDirectory196To198ReadOnlyQueries("synthetic", { ...SPEC, database: "wrong" }, ["SELECT 1"], async () => {
    requested = true;
    throw new Error("must not reach transport");
  }));
  assert.equal(requested, false);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "native-directory-196-198-inventory-"));
  try {
    const destination = path.join(temporary, "apps/operations/migrations");
    fs.mkdirSync(destination, { recursive: true });
    fs.cpSync(path.join(root, "apps/operations/migrations"), destination, { recursive: true });
    assert.equal(buildNativeDirectory196To198Plan(temporary).finalNames.length, 198);
    fs.writeFileSync(path.join(destination, "0199_unreviewed.sql"), "SELECT 1;\n", { flag: "wx" });
    assert.throws(() => buildNativeDirectory196To198Plan(temporary), /exact current Operations bootstrap inventory/u);
    fs.unlinkSync(path.join(destination, "0199_unreviewed.sql"));
    const last = path.join(destination, SPEC.suffix[1].name);
    fs.appendFileSync(last, "\n-- local drift\n");
    assert.throws(() => buildNativeDirectory196To198Plan(temporary), /content drifted/u);
  } finally {
    assert(path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith("native-directory-196-198-inventory-"));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("preflight accepts only exact 196 ledger and zero FK violations", async () => {
  const plan = buildNativeDirectory196To198Plan(root);
  const dependencies = { credential: () => "synthetic", remoteState: async () => current(plan), wrangler: () => assert.fail("preflight attempted a provider command") };
  const result = await runNativeDirectory196To198(["preflight"], dependencies);
  assert.equal(result.mutationsPerformed, false);
  assert.deepEqual(result.pending.map(item => item.name), SPEC.suffix.map(item => item.name));
  for (const bad of [
    { ...current(plan), ledger: plan.finalNames.map(name => ({ name })) },
    { ...current(plan), ledger: plan.priorNames.slice(0, -1).map(name => ({ name })) },
    { ...current(plan), foreignKeys: [{ table: "bad" }] },
  ]) await assert.rejects(runNativeDirectory196To198(["preflight"], { ...dependencies, remoteState: async () => bad }));
});

test("backup freshness, snapshot drift, and the shared attempt sentinel prevent apply or retry", () => {
  const now = Date.now();
  const snapshot = { ...current(buildNativeDirectory196To198Plan(root)), data: { immutable: ["row"] } };
  const saved = { snapshot, createdAt: new Date(now).toISOString() };
  assert.doesNotThrow(() => assertApplyReady(snapshot, saved, false, now));
  assert.throws(() => assertApplyReady(snapshot, saved, true, now), /existing attempt/u);
  assert.throws(() => assertApplyReady(snapshot, { ...saved, createdAt: new Date(now - 31 * 60_000).toISOString() }, false, now), /fresh backup/u);
  assert.throws(() => assertApplyReady(snapshot, { ...saved, createdAt: new Date(now + 1).toISOString() }, false, now), /fresh backup/u);
  assert.throws(() => assertApplyReady({ ...snapshot, data: { immutable: [] } }, saved, false, now), /moved after backup/u);
  const first = buildNativeDirectory196To198Plan(root, "evidence-a");
  const second = buildNativeDirectory196To198Plan(root, "evidence-b");
  assert.equal(first.marker, second.marker, "artifact labels cannot namespace retry authority");
  assert.notEqual(first.backup, second.backup);
  const marker = { application: "operations", database: SPEC.database, from: 196, to: 198,
    artifactSet: "evidence-a", migrations: first.migrations, attemptedAt: new Date(now).toISOString(), retryAllowed: false };
  assert.doesNotThrow(() => assertAttemptMarker(marker, first));
  assert.throws(() => assertAttemptMarker({ ...marker, retryAllowed: true }, first));
  assert.throws(() => assertAttemptMarker({ ...marker, database: "wrong" }, first));
  assert.throws(() => assertAttemptMarker(marker, second));
});

test("an uncertain injected apply writes one durable shared sentinel and never retries", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "native-directory-196-198-attempt-"));
  let providerCalls = 0;
  try {
    const source = path.join(temporary, "apps/operations/migrations");
    fs.mkdirSync(source, { recursive: true });
    fs.cpSync(path.join(root, "apps/operations/migrations"), source, { recursive: true });
    const plan = buildNativeDirectory196To198Plan(temporary, "attempt-a");
    fs.mkdirSync(plan.directory, { recursive: true });
    for (const item of plan.migrations) fs.copyFileSync(path.join(source, item.name), path.join(plan.directory, item.name));
    const config = {
      name: "migration-only-ltds-ops-staging-196-198-attempt-a",
      account_id: "846c924bf17bf4f3dd15c97a4c5d1d51",
      d1_databases: [{ binding: "OPS_DB", database_name: "ltds-ops-staging", database_id: SPEC.database,
        migrations_dir: path.relative(path.dirname(plan.config), plan.directory).replaceAll("\\", "/") }],
    };
    fs.mkdirSync(path.dirname(plan.config), { recursive: true });
    fs.writeFileSync(plan.config, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
    fs.mkdirSync(path.dirname(plan.backup), { recursive: true });
    const bytes = Buffer.from("synthetic private backup fixture");
    fs.writeFileSync(plan.backup, bytes, { flag: "wx" });
    const snapshot = current(plan);
    fs.writeFileSync(plan.evidence, JSON.stringify({ application: "operations", database: SPEC.database, artifactSet: "attempt-a",
      createdAt: new Date().toISOString(), backupSha256: sha(bytes), migrations: plan.migrations, snapshot }), { flag: "wx" });
    const dependencies = { root: temporary, credential: () => "synthetic", remoteState: async () => structuredClone(snapshot),
      wrangler: () => {
        providerCalls += 1;
        if (process.platform !== "win32") {
          assert.equal(fs.statSync(plan.marker).mode & 0o777, 0o600, "sentinel must be owner-only before provider call");
        }
        throw Error("unknown outcome sentinel fixture");
      } };
    await assert.rejects(runNativeDirectory196To198(["apply", "attempt-a"], dependencies), /unknown outcome sentinel fixture/u);
    assert(fs.existsSync(plan.marker), "apply attempt marker must persist after uncertain provider outcome");
    assert.equal(providerCalls, 1);
    await assert.rejects(runNativeDirectory196To198(["apply", "attempt-a"], dependencies), /existing attempt|reconcile only/u);
    assert.equal(providerCalls, 1, "a failed/uncertain apply must not be retried");
    const otherLabel = buildNativeDirectory196To198Plan(temporary, "attempt-b");
    assert.equal(otherLabel.marker, plan.marker, "alternate artifact label shares the no-retry marker");
  } finally {
    assert(path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith("native-directory-196-198-attempt-"));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("strict reconciliation preserves all historical schema/data and requires new tables empty", () => {
  const before = { foreignKeys: [], schema: [{ type: "table", name: "legacy", sql: "CREATE TABLE legacy(id)" }], data: { legacy: ['{"id":1}'] } };
  const reviewed = new Map([ ["new_table", { type: "table", sql: "CREATE TABLE new_table(id)" }] ]);
  const after = { foreignKeys: [], schema: [...before.schema, { type: "table", name: "new_table", sql: "CREATE TABLE new_table(id)" }], data: { legacy: before.data.legacy, new_table: [] } };
  assert.doesNotThrow(() => assertPreserved(before, after, reviewed, "strict"));
  assert.throws(() => assertPreserved(before, { ...after, foreignKeys: [{}] }, reviewed, "strict"));
  assert.throws(() => assertPreserved(before, { ...after, data: { ...after.data, legacy: [] } }, reviewed, "strict"), /pre-existing table changed/u);
  assert.throws(() => assertPreserved(before, { ...after, data: { ...after.data, new_table: ['{"id":1}'] } }, reviewed, "strict"), /new table unexpectedly populated/u);
  assert.throws(() => assertPreserved(before, { ...after, schema: [...after.schema, { type: "view", name: "drift", sql: "CREATE VIEW drift AS SELECT 1" }] }, reviewed, "strict"), /schema changed/u);
});

test("read-only query transport is pinned, bounded, and rejects any mutation claim", async () => {
  const calls = [];
  const fake = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ success: true, result: [{ success: true, results: [{ ok: 1 }], meta: { changed_db: false } }] }) };
  };
  assert.deepEqual(await nativeDirectory196To198ReadOnlyQueries("synthetic", SPEC, ["SELECT 1"], fake), [[{ ok: 1 }]]);
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/846c924bf17bf4f3dd15c97a4c5d1d51/d1/database/78b34173-b168-4e3d-9832-bb9d245cc6b8/query");
  assert.equal(calls[0].options.redirect, "error");
  for (const queries of [["DELETE FROM x"], ["SELECT 1; DELETE FROM x"], ["SELECT 1", "SELECT 2", "SELECT 3"]])
    await assert.rejects(nativeDirectory196To198ReadOnlyQueries("synthetic", SPEC, queries, fake));
  await assert.rejects(nativeDirectory196To198ReadOnlyQueries("synthetic", SPEC, ["SELECT 1"], async () => ({
    ok: true, json: async () => ({ success: true, result: [{ success: true, results: [], meta: { changed_db: true } }] }),
  })));
  assert.equal(calls.length, 1);
  assert.equal(safeNativeDirectory196To198Failure(), '{"error":"staging migration boundary rejected; inspect private local evidence","retryAllowed":false}');
});

async function applyMigration(db, name) {
  let sql = fs.readFileSync(path.join(root, "apps/operations/migrations", name), "utf8");
  if (name === "0002_seed_acl.sql") sql = transformSeed("operations", sql, syntheticOwner);
  const statements = unstable_splitSqlQuery(sql.replace(/\r\n/gu, "\n")).map(value => value.trim())
    .filter(value => value && !/^PRAGMA\s+foreign_keys\s*=\s*ON/iu.test(value));
  await db.batch(statements.map(value => db.prepare(value)));
  await db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name).run();
}

test("genuine SQLite accepts 0197/0198 after exact 196 chain and strict snapshot is preserved", { timeout: 240000, skip: process.env.SKIP_REAL_SQL === "1" }, async () => {
  const plan = buildNativeDirectory196To198Plan(root);
  const mf = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}", compatibilityDate: "2026-08-06", d1Databases: { DB: crypto.randomUUID() } });
  try {
    const db = await mf.getD1Database("DB");
    await db.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
    for (const name of plan.priorNames) await applyMigration(db, name);
    const capture = async () => {
      const schema = (await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger','view','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results;
      const data = {};
      for (const table of applicationTableNames(schema).filter(name => name !== "_cf_METADATA"))
        data[table] = (await db.prepare(`SELECT * FROM ${quoteSqlIdentifier(table)}`).all()).results.map(row => JSON.stringify(row)).sort();
      return { schema, data, foreignKeys: (await db.prepare("SELECT * FROM pragma_foreign_key_check").all()).results };
    };
    const before = await capture();
    for (const item of plan.migrations) await applyMigration(db, item.name);
    const after = await capture();
    const definitions = reviewedSchemaDefinitions(plan.migrations.map(item => fs.readFileSync(path.join(plan.sourceDirectory, item.name), "utf8")).join("\n"));
    assert(definitions.size > 0);
    assert.doesNotThrow(() => assertPreserved(before, after, definitions, "strict"));
    const applied = (await db.prepare("SELECT name FROM d1_migrations ORDER BY name").all()).results.map(row => row.name);
    assert.deepEqual(applied, plan.finalNames);
    assert.equal(sha(plan.priorNames.join("\n")), SPEC.priorNamesSha256);
    assert.equal(normalizedSql(definitions.get("operations_portal_workspace_delivery_cancellation_checkpoints").sql),
      normalizedSql(after.schema.find(row => row.name === "operations_portal_workspace_delivery_cancellation_checkpoints").sql));
  } finally {
    await mf.dispose();
  }
});
