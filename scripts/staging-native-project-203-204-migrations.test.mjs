import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createNativeDirectoryMigrationWindow, applicationTableNames, assertPreserved,
  reviewedNativeDirectorySchemaDefinitions } from "./staging-native-directory-migration-window.mjs";
import { SPEC, buildNativeProject203To204Plan, runNativeProject203To204,
  materializeNativeProject203To204, nativeProject203To204ReadOnlyQueries,
  assertNativeProject204Preserved, assertNativeProject204SourceCi, SOURCE_CI_JOBS } from "./staging-native-project-203-204-migrations.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "native-project-203-204-"));
  const destination = path.join(base, "apps/operations/migrations");
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(path.join(root, "apps/operations/migrations"), destination, { recursive: true });
  return base;
}
function cleanup(base) {
  assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
  assert(path.basename(base).startsWith("native-project-203-204-"));
  fs.rmSync(base, { recursive: true, force: true });
}

test("204 window pins the exact staging target and a single additive migration", async () => {
  const plan = buildNativeProject203To204Plan(root);
  assert.equal(plan.priorNames.length, 203); assert.equal(plan.finalNames.length, 204);
  assert.deepEqual(plan.migrations, SPEC.suffix);
  assert.deepEqual(plan.migrations.map(row => row.name), ["0204_native_project_archive_restore.sql"]);
  for (const [from, to] of [[200, 204], [202, 204], [203, 205], [204, 205]])
    assert.throws(() => createNativeDirectoryMigrationWindow({ ...SPEC, from, to }, async () => ({})), /only reviewed/);
  assert.throws(() => createNativeDirectoryMigrationWindow(SPEC), /0204 source CI/);
  assert.throws(() => createNativeDirectoryMigrationWindow({ ...SPEC, database: "production" }, async () => ({})), /pinned Operations staging/);
  const result = await runNativeProject203To204(["dry-run"], { root,
    credential: () => assert.fail("dry-run must not read credentials"), remoteState: () => assert.fail("dry-run must not connect") });
  assert.equal(result.mutationsPerformed, false);
});

test("204 requires fresh ten-job CI for the actual candidate before reading credentials", async () => {
  const now = Date.now(), head = "a".repeat(40);
  const good = { workflowName: "CI", headSha: head, event: "pull_request", status: "completed", conclusion: "success",
    updatedAt: new Date(now).toISOString(), jobs: SOURCE_CI_JOBS.map(name => ({ name, status: "completed", conclusion: "success" })) };
  assert.doesNotThrow(() => assertNativeProject204SourceCi(good, head, now));
  for (const bad of [{ ...good, headSha: "b".repeat(40) }, { ...good, jobs: good.jobs.slice(1) },
    { ...good, updatedAt: new Date(now - 31 * 60_000).toISOString() }])
    assert.throws(() => assertNativeProject204SourceCi(bad, head, now));
  await assert.rejects(runNativeProject203To204(["apply"], { root,
    sourceCiGate: async () => { throw Error("candidate CI not approved"); },
    credential: () => assert.fail("no credential access before CI gate") }), /candidate CI not approved/);
});

test("204 preconditions require D1 primary reads and cannot use a mutation or replica result", async () => {
  for (const meta of [{ changed_db: true, served_by_primary: true },
    { changed_db: false, served_by_primary: false }, { changed_db: false }])
    await assert.rejects(nativeProject203To204ReadOnlyQueries("synthetic", SPEC, ["SELECT 1"], async () => ({ ok: true,
      json: async () => ({ success: true, result: [{ success: true, results: [], meta }] }) })));
});

test("204 unknown apply outcome preserves an exclusive marker and prevents blind retry under another label", async () => {
  const base = fixture(); let attempts = 0;
  try {
    const plan = buildNativeProject203To204Plan(base, "first");
    materializeNativeProject203To204(plan);
    fs.mkdirSync(path.dirname(plan.backup), { recursive: true });
    fs.writeFileSync(plan.backup, "synthetic private backup\n".repeat(100));
    const snapshot = { ledger: plan.priorNames.map(name => ({ name })), foreignKeys: [], schema: [], data: {} };
    const sourceCi = { headSha: "a".repeat(40), runId: "123" };
    fs.writeFileSync(plan.evidence, JSON.stringify({ application: "operations", database: SPEC.database,
      artifactSet: "first", createdAt: new Date().toISOString(), sourceCi,
      backupSha256: sha(fs.readFileSync(plan.backup)), migrations: plan.migrations, snapshot }));
    const dependencies = { root: base, sourceCiGate: async () => sourceCi, credential: () => "synthetic",
      assertPrivate: () => {}, // ACL implementation is covered by the shared runner suite; these fixtures contain no secrets.
      remoteState: async () => structuredClone(snapshot), wrangler: () => { attempts++; throw Error("unknown provider outcome"); } };
    await assert.rejects(runNativeProject203To204(["apply", "first"], dependencies), /unknown provider outcome/);
    assert.equal(attempts, 1);
    const marker = JSON.parse(fs.readFileSync(plan.marker, "utf8"));
    assert.equal(marker.from, 203); assert.equal(marker.to, 204); assert.equal(marker.retryAllowed, false);
    assert.deepEqual(marker.sourceCi, sourceCi);
    await assert.rejects(runNativeProject203To204(["apply", "first"], dependencies), /existing attempt|reconcile only/);
    assert.equal(attempts, 1);
    assert.equal(buildNativeProject203To204Plan(base, "second").marker, plan.marker);
  } finally { cleanup(base); }
});

test("204 strict reconciliation recognizes only reviewed trigger replacements and preserves existing data", () => {
  const plan = buildNativeProject203To204Plan(root), db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE)");
    const apply = name => {
      db.exec("BEGIN");
      try {
        db.exec(fs.readFileSync(path.join(plan.sourceDirectory, name), "utf8"));
        db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").run(name);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    };
    const capture = () => {
      const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger','view','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name")
        .all().map(row => ({ ...row }));
      const data = Object.fromEntries(applicationTableNames(schema).filter(name => name !== "d1_migrations").map(name => [name,
        db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify({ ...row })).sort()]));
      return { schema, data, foreignKeys: db.prepare("PRAGMA foreign_key_check").all().map(row => ({ ...row })) };
    };
    for (const name of plan.priorNames) apply(name);
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('preserved204-area','Preserved204 area',1)").run();
    assert(db.prepare("SELECT count(*) count FROM staff_users").get().count > 0);
    const before = capture();
    const sql = fs.readFileSync(path.join(plan.sourceDirectory, plan.migrations[0].name), "utf8");
    db.exec("BEGIN");
    db.exec(sql);
    db.exec("ROLLBACK");
    assert.deepEqual(capture(), before, "migration transaction rollback retains every original schema object and row");
    apply(plan.migrations[0].name);
    const after = capture();
    assert.throws(() => assertNativeProject204Preserved(before, after, `${sql}\nCREATE TABLE unreviewed(value TEXT);`), /exact frozen204 SQL/);
    assert.doesNotThrow(() => assertNativeProject204Preserved(before, after, sql));
    const tampered = structuredClone(after);
    tampered.data.native_business_areas = [];
    assert.throws(() => assertNativeProject204Preserved(before, tampered, sql), /pre-existing table changed: native_business_areas/);
    const retainedBefore = structuredClone(before), retainedAfter = structuredClone(after);
    retainedBefore.data.operations_shared_project_revisions = [JSON.stringify({ external_project_id: "retained", version: 7, content_hash: "original" })];
    retainedAfter.data.operations_shared_project_revisions = [JSON.stringify({ external_project_id: "retained", version: 7, content_hash: "original", lifecycle_settlement_id: null })];
    assert.doesNotThrow(() => assertNativeProject204Preserved(retainedBefore, retainedAfter, sql));
    for (const patch of [{ lifecycle_settlement_id: "unexpected" }, { version: 8 }, { extra: null }]) {
      const changed = structuredClone(retainedAfter);
      changed.data.operations_shared_project_revisions = [JSON.stringify({ ...JSON.parse(changed.data.operations_shared_project_revisions[0]), ...patch })];
      assert.throws(() => assertNativeProject204Preserved(retainedBefore, changed, sql), /pre-existing table changed/);
    }
    const extraColumn = structuredClone(after);
    extraColumn.schema.find(row => row.name === "operations_shared_project_revisions").sql += " /* unreviewed */";
    assert.throws(() => assertNativeProject204Preserved(before, extraColumn, sql), /reviewed schema definition changed/);
    assert.deepEqual(db.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map(row => row.name), plan.finalNames);
  } finally { db.close(); }
});

test("204 current inventory refuses hidden uppercase SQL", () => {
  const base = fixture();
  try {
    fs.writeFileSync(path.join(base, "apps/operations/migrations/unreviewed.SQL"), "SELECT 1;");
    assert.throws(() => buildNativeProject203To204Plan(base), /canonical migration names/);
  } finally { cleanup(base); }
});
