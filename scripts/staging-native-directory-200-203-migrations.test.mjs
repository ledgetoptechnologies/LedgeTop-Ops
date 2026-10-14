import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createNativeDirectoryMigrationWindow } from "./staging-native-directory-migration-window.mjs";
import {
  applicationTableNames, assertNativeDirectory200To203PrivateArtifact, assertNativeDirectory203SourceCi, assertPreserved,
  buildNativeDirectory200To203Plan, materializeNativeDirectory200To203,
  nativeDirectory200To203ReadOnlyQueries, reviewedNativeDirectorySchemaDefinitions,
  runNativeDirectory200To203, safeNativeDirectory200To203Failure,
  SOURCE_CI_JOBS, SPEC, verifyNativeDirectory203SourceCi,
} from "./staging-native-directory-200-203-migrations.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const successfulCi = (headSha = "a".repeat(40), now = Date.now()) => ({ workflowName: "CI", headSha,
  status: "completed", conclusion: "success", event: "push", updatedAt: new Date(now).toISOString(),
  jobs: SOURCE_CI_JOBS.map(name => ({ name, status: "completed", conclusion: "success" })) });
const current = plan => ({ ledger: plan.priorNames.map(name => ({ name })), foreignKeys: [], schema: [], data: {} });

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "native-directory-200-203-"));
  const target = path.join(base, "apps/operations/migrations");
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(path.join(root, "apps/operations/migrations"), target, { recursive: true });
  return base;
}
function cleanup(base) {
  assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
  assert(path.basename(base).startsWith("native-directory-200-203-"));
  fs.rmSync(base, { recursive: true, force: true });
}
function makePrivate(file) {
  if (process.platform !== "win32") { fs.chmodSync(file, 0o600); return; }
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File",
    path.join(root, "scripts/restrict-private-authority-file.ps1"), "-LiteralFile", file], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

test("factory permits only the three reviewed windows and rejects production identities", () => {
  assert.doesNotThrow(() => createNativeDirectoryMigrationWindow(SPEC, async () => ({ headSha: "a".repeat(40), runId: "1" })));
  for (const [from, to] of [[199, 203], [200, 202], [201, 203], [200, 204]])
    assert.throws(() => createNativeDirectoryMigrationWindow({ ...SPEC, from, to }, async () => ({})), /only reviewed/u);
  for (const database of ["6ebf7514-d306-4615-ae56-ad869c874dbd", "7f40a7b7-c3ec-470e-a626-e798867f71f8"])
    assert.throws(() => createNativeDirectoryMigrationWindow({ ...SPEC, database }, async () => ({})), /pinned Operations staging/u);
  assert.throws(() => createNativeDirectoryMigrationWindow(SPEC), /0203 source CI execution gate/u);
});

test("source CI requires the exact SHA, freshness, and exactly ten successful jobs", () => {
  const now = Date.now(), head = "a".repeat(40), good = successfulCi(head, now);
  assert.doesNotThrow(() => assertNativeDirectory203SourceCi(good, head, now));
  const mutations = [
    run => { run.headSha = "b".repeat(40); }, run => { run.workflowName = "Deploy"; },
    run => { run.status = "in_progress"; }, run => { run.conclusion = "failure"; },
    run => { run.event = "workflow_dispatch"; }, run => { run.updatedAt = new Date(now - 31 * 60_000).toISOString(); },
    run => { run.updatedAt = new Date(now + 1).toISOString(); }, run => { run.jobs.pop(); },
    run => { run.jobs[0].name = "unexpected"; }, run => { run.jobs[0].conclusion = "failure"; },
    run => { run.jobs[0].status = "queued"; }, run => { run.jobs[1].name = run.jobs[0].name; },
  ];
  for (const mutate of mutations) { const bad = structuredClone(good); mutate(bad); assert.throws(() => assertNativeDirectory203SourceCi(bad, head, now)); }
  assert.throws(() => assertNativeDirectory203SourceCi(good, "bad", now), /exact reviewed source SHA/u);
});

test("source CI reader uses only injected git and gh reads and requires explicit exact SHA", async () => {
  const priorRun = process.env.STAGING_SOURCE_CI_RUN_ID, priorSha = process.env.STAGING_SOURCE_COMMIT_SHA;
  const head = "a".repeat(40), run = successfulCi(head), calls = [];
  try {
    process.env.STAGING_SOURCE_CI_RUN_ID = "123"; process.env.STAGING_SOURCE_COMMIT_SHA = head;
    const read = (command, args) => { calls.push([command, args]); return command === "gh" ? JSON.stringify(run) : args[0] === "rev-parse" ? head : ""; };
    assert.deepEqual(await verifyNativeDirectory203SourceCi(root, { readSourceCiCommand: read }), { headSha: head, runId: "123" });
    assert.deepEqual(calls.map(call => call[0]), ["git", "git", "gh", "git", "git"]);
    process.env.STAGING_SOURCE_COMMIT_SHA = "b".repeat(40);
    await assert.rejects(verifyNativeDirectory203SourceCi(root, { readSourceCiCommand: read }), /exact final reviewed source SHA|exact final reviewed/u);
    delete process.env.STAGING_SOURCE_COMMIT_SHA;
    await assert.rejects(verifyNativeDirectory203SourceCi(root, { readSourceCiCommand: read }), /explicit final reviewed source SHA/u);
  } finally {
    if (priorRun === undefined) delete process.env.STAGING_SOURCE_CI_RUN_ID; else process.env.STAGING_SOURCE_CI_RUN_ID = priorRun;
    if (priorSha === undefined) delete process.env.STAGING_SOURCE_COMMIT_SHA; else process.env.STAGING_SOURCE_COMMIT_SHA = priorSha;
  }
});

test("plan freezes the exact prior 200 chain and three migration bytes", () => {
  const plan = buildNativeDirectory200To203Plan(root);
  assert.equal(plan.priorNames.length, 200); assert.equal(plan.finalNames.length, 203);
  assert.equal(plan.priorNames.at(-1), "0200_native_directory_active_binding_refresh_supersessions.sql");
  assert.deepEqual(plan.migrations, SPEC.suffix);
  assert.equal(SPEC.priorNamesSha256, "33b6dbc6d8270cc82b7af0c315c5d874a5e8369ad0884185a60085218e75601f");
  assert.equal(SPEC.priorContentsSha256, "8544d12cba6a51f3ab909c85d02e5fb8b48c54f054f1ca30d426ea17be924138");
});

test("backup and apply reject source CI before credentials or provider I/O", async () => {
  for (const mode of ["backup", "apply"]) {
    let gates = 0;
    await assert.rejects(runNativeDirectory200To203([mode, "ci-red"], {
      sourceCiGate: async () => { gates++; throw Error("CI red"); },
      credential: () => assert.fail("credential reached"), remoteState: () => assert.fail("provider read reached"),
      wrangler: () => assert.fail("provider write reached"),
    }), /CI red/u);
    assert.equal(gates, 1);
  }
});

test("preflight remains read-only diagnostic and does not claim source authorization", async () => {
  const plan = buildNativeDirectory200To203Plan(root);
  let gates = 0;
  const result = await runNativeDirectory200To203(["preflight"], {
    sourceCiGate: async () => { gates++; throw Error("must not run"); }, credential: () => "synthetic",
    remoteState: async () => current(plan), wrangler: () => assert.fail("preflight must not invoke Wrangler"),
  });
  assert.equal(gates, 0); assert.equal(result.mutationsPerformed, false); assert.deepEqual(result.pending, plan.migrations);
});

test("read-only transport pins staging, bounds statements, and rejects mutation claims", async () => {
  const calls = [], request = async (url, options) => { calls.push({ url, options }); return { ok: true,
    json: async () => ({ success: true, result: [{ success: true, results: [{ ok: 1 }], meta: { changed_db: false, served_by_primary: true } }] }) }; };
  assert.deepEqual(await nativeDirectory200To203ReadOnlyQueries("synthetic", SPEC, ["SELECT 1"], request), [[{ ok: 1 }]]);
  assert.match(calls[0].url, /78b34173-b168-4e3d-9832-bb9d245cc6b8\/query$/u); assert.equal(calls[0].options.redirect, "error");
  for (const queries of [["DELETE FROM x"], ["SELECT 1; DELETE FROM x"], ["SELECT 1", "SELECT 2", "SELECT 3"]])
    await assert.rejects(nativeDirectory200To203ReadOnlyQueries("synthetic", SPEC, queries, request));
  await assert.rejects(nativeDirectory200To203ReadOnlyQueries("synthetic", SPEC, ["SELECT 1"], async () => ({ ok: true,
    json: async () => ({ success: true, result: [{ success: true, results: [], meta: { changed_db: true, served_by_primary: true } }] }) })));
  for (const meta of [{ changed_db: false }, { changed_db: false, served_by_primary: false }])
    await assert.rejects(nativeDirectory200To203ReadOnlyQueries("synthetic", SPEC, ["SELECT 1"], async () => ({ ok: true,
      json: async () => ({ success: true, result: [{ success: true, results: [], meta }] }) })), /served by D1 primary/u);
  assert.equal(safeNativeDirectory200To203Failure(), '{"error":"staging migration boundary rejected; inspect private local evidence","retryAllowed":false}');
});

test("an uncertain apply writes the shared sentinel once and can never retry", async () => {
  const base = fixture(); let providerCalls = 0;
  try {
    const plan = buildNativeDirectory200To203Plan(base, "attempt-a"); materializeNativeDirectory200To203(plan);
    fs.mkdirSync(path.dirname(plan.backup), { recursive: true }); fs.writeFileSync(plan.backup, "synthetic private backup\n".repeat(100));
    const snapshot = current(plan), sourceCi = { headSha: "a".repeat(40), runId: "123" };
    fs.writeFileSync(plan.evidence, JSON.stringify({ application: "operations", database: SPEC.database, artifactSet: "attempt-a",
      createdAt: new Date().toISOString(), sourceCi, backupSha256: sha(fs.readFileSync(plan.backup)), migrations: plan.migrations, snapshot }));
    makePrivate(plan.backup); makePrivate(plan.evidence);
    const dependencies = { root: base, sourceCiGate: async () => sourceCi, credential: () => "synthetic",
      remoteState: async () => structuredClone(snapshot), wrangler: () => { providerCalls++; throw Error("uncertain provider outcome"); } };
    await assert.rejects(runNativeDirectory200To203(["apply", "attempt-a"], dependencies), /uncertain provider outcome/u);
    assert.equal(providerCalls, 1); assert(fs.existsSync(plan.marker));
    const marker = JSON.parse(fs.readFileSync(plan.marker, "utf8")); assert.equal(marker.retryAllowed, false); assert.deepEqual(marker.sourceCi, sourceCi);
    await assert.rejects(runNativeDirectory200To203(["apply", "attempt-a"], dependencies), /existing attempt|reconcile only/u);
    assert.equal(providerCalls, 1);
    assert.equal(buildNativeDirectory200To203Plan(base, "attempt-b").marker, plan.marker);
  } finally { cleanup(base); }
});

test("apply re-verifies private artifacts and rejects permissions widened after creation", async () => {
  const base = fixture(); let providerCalls = 0;
  try {
    const plan = buildNativeDirectory200To203Plan(base, "permissions"); materializeNativeDirectory200To203(plan);
    fs.mkdirSync(path.dirname(plan.backup), { recursive: true }); fs.writeFileSync(plan.backup, "synthetic private backup\n".repeat(100));
    const snapshot = current(plan), sourceCi = { headSha: "a".repeat(40), runId: "123" };
    fs.writeFileSync(plan.evidence, JSON.stringify({ application: "operations", database: SPEC.database, artifactSet: "permissions",
      createdAt: new Date().toISOString(), sourceCi, backupSha256: sha(fs.readFileSync(plan.backup)), migrations: plan.migrations, snapshot }));
    makePrivate(plan.backup); makePrivate(plan.evidence); assert.doesNotThrow(() => assertNativeDirectory200To203PrivateArtifact(plan.evidence));
    if (process.platform === "win32") {
      const widened = spawnSync("icacls.exe", [plan.evidence, "/grant", "*S-1-1-0:R"], { encoding: "utf8", windowsHide: true });
      assert.equal(widened.status, 0, widened.stderr);
    } else fs.chmodSync(plan.evidence, 0o644);
    const dependencies = { root: base, sourceCiGate: async () => sourceCi, credential: () => "synthetic",
      remoteState: async () => structuredClone(snapshot), wrangler: () => { providerCalls++; } };
    await assert.rejects(runNativeDirectory200To203(["apply", "permissions"], dependencies), /private artifact .*widened/u);
    assert.equal(providerCalls, 0, "widened artifacts must be rejected before provider mutation");
  } finally {
    const evidence = path.join(base, "apps/operations/.backups/native-directory-before-203-permissions.json");
    if (fs.existsSync(evidence)) {
      if (process.platform === "win32") spawnSync("icacls.exe", [evidence, "/remove:g", "*S-1-1-0"], { windowsHide: true });
      makePrivate(evidence);
    }
    cleanup(base);
  }
});

test("reconcile rejects an attempt marker whose private permissions were widened", async () => {
  const base = fixture();
  let marker;
  try {
    const plan = buildNativeDirectory200To203Plan(base, "reconcile-permissions");
    materializeNativeDirectory200To203(plan);
    marker = plan.marker;
    fs.mkdirSync(path.dirname(plan.backup), { recursive: true });
    fs.writeFileSync(plan.backup, "synthetic private backup\n".repeat(100));
    fs.writeFileSync(plan.evidence, JSON.stringify({ application: "operations", database: SPEC.database,
      artifactSet: "reconcile-permissions", backupSha256: sha(fs.readFileSync(plan.backup)), migrations: plan.migrations }));
    fs.writeFileSync(marker, "{}");
    for (const file of [plan.backup, plan.evidence, marker]) makePrivate(file);
    if (process.platform === "win32") {
      const widened = spawnSync("icacls.exe", [marker, "/grant", "*S-1-1-0:R"], { encoding: "utf8", windowsHide: true });
      assert.equal(widened.status, 0, widened.stderr);
    } else fs.chmodSync(marker, 0o644);
    await assert.rejects(runNativeDirectory200To203(["reconcile", "reconcile-permissions"], {
      root: base, credential: () => "synthetic",
      remoteState: async () => ({ ...current(plan), ledger: plan.finalNames.map(name => ({ name })) }),
      wrangler: () => assert.fail("reconcile must never invoke provider writes"),
    }), /private artifact .*widened/u);
  } finally {
    if (marker && fs.existsSync(marker)) {
      if (process.platform === "win32") spawnSync("icacls.exe", [marker, "/remove:g", "*S-1-1-0"], { windowsHide: true });
      makePrivate(marker);
    }
    cleanup(base);
  }
});

test("real SQLite full chain preserves every prior row and exact reviewed schema", { timeout: 240_000 }, () => {
  const plan = buildNativeDirectory200To203Plan(root), db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  const apply = name => { db.exec("BEGIN"); try { db.exec(fs.readFileSync(path.join(plan.sourceDirectory, name), "utf8")); db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").run(name); db.exec("COMMIT"); } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; } };
  const capture = () => { const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger','view','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(row => ({ ...row }));
    const data = {}; for (const table of applicationTableNames(schema).filter(name => name !== "d1_migrations")) {
      const quoted = `"${table.replaceAll('"', '""')}"`; data[table] = db.prepare(`SELECT * FROM ${quoted}`).all().map(row => JSON.stringify({ ...row })).sort(); }
    return { schema, data, foreignKeys: db.prepare("PRAGMA foreign_key_check").all().map(row => ({ ...row })) }; };
  for (const name of plan.priorNames) apply(name);
  assert(db.prepare("SELECT count(*) count FROM staff_users").get().count > 0, "canonical seed must make preservation non-vacuous");
  db.prepare(`INSERT INTO integration_event_receipts(event_id,integration,event_type,user_id,occurred_at,payload_hash,status)
    VALUES('migration-203-preserved-event','synthetic-rehearsal','preservation','staff-beau-koltz','2026-10-13T00:00:00.000Z',?,'completed')`).run("a".repeat(64));
  db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('migration-203-preserved-area','Migration 203 preserved area',1)").run();
  const before = capture();
  assert.equal(before.data.integration_event_receipts.length, 1);
  assert.equal(before.data.native_business_areas.length, 1);
  db.exec("BEGIN");
  assert.throws(() => {
    db.exec(fs.readFileSync(path.join(plan.sourceDirectory, plan.migrations[0].name), "utf8"));
    db.exec("SELECT * FROM deliberately_missing_rollback_guard");
  });
  db.exec("ROLLBACK");
  assert.equal(db.prepare("SELECT count(*) count FROM sqlite_master WHERE name='operations_directory_lifecycle_state'").get().count, 0,
    "failed migration transaction must not leave suffix schema");
  assert.equal(db.prepare("SELECT count(*) count FROM d1_migrations").get().count, 200,
    "failed migration transaction must not advance the ledger");
  for (const item of plan.migrations) apply(item.name); const after = capture();
  const definitions = reviewedNativeDirectorySchemaDefinitions(plan.migrations.map(item => fs.readFileSync(path.join(plan.sourceDirectory, item.name), "utf8")).join("\n"));
  assert.doesNotThrow(() => assertPreserved(before, after, definitions, "strict"));
  const tampered = structuredClone(after);
  tampered.data.integration_event_receipts = [];
  assert.throws(() => assertPreserved(before, tampered, definitions, "strict"), /pre-existing table changed: integration_event_receipts/u);
  assert.deepEqual(db.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map(row => row.name), plan.finalNames);
  db.close();
});
