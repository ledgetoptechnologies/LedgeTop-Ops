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
  buildNativeDirectory198To199Plan,
  nativeDirectory198To199ReadOnlyQueries,
  normalizedSql,
  reviewedSchemaDefinitions,
  quoteSqlIdentifier,
  runNativeDirectory198To199,
  safeNativeDirectory198To199Failure,
  SPEC,
  assertNativeDirectory199SourceCi,
  verifyNativeDirectory199SourceCi,
} from "./staging-native-directory-198-199-migrations.mjs";
import { transformSeed } from "./staging-bootstrap.mjs";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(root, "apps/operations/package.json"));
const { Miniflare } = require("miniflare");
const { unstable_splitSqlQuery } = require("wrangler");
const syntheticOwner = { email: "owner@staging.example.test", displayName: "Synthetic Staging Owner",
  clientStaffId: "staging-client-owner", operationsStaffId: "staging-operations-owner" };
const current = plan => ({ ledger: plan.priorNames.map(name => ({ name })), foreignKeys: [], schema: [], data: {} });
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

const ciJobs = ["source-invariants","incoming-pickup-alpine","client","operations","ops-sync","thumbnail-renderer",
  "operations-browser-desktop-edge","operations-browser-mobile-edge","client-browser-desktop-edge","client-browser-mobile-edge"];
const successfulCi = (now=Date.now()) => ({workflowName:"CI",headSha:"a".repeat(40),status:"completed",conclusion:"success",
  event:"push",updatedAt:new Date(now).toISOString(),jobs:ciJobs.map(name=>({name,status:"completed",conclusion:"success"}))});
test("source CI validation requires fresh exact HEAD and all ten successful jobs", () => {
  const now=Date.now(),run=successfulCi(now);
  assert.doesNotThrow(()=>assertNativeDirectory199SourceCi(run,run.headSha,now));
  for(const mutate of [r=>{r.headSha="b".repeat(40);},r=>{r.workflowName="Deploy";},r=>{r.status="in_progress";},
    r=>{r.conclusion="failure";},r=>{r.event="workflow_dispatch";},r=>{r.updatedAt=new Date(now-31*60_000).toISOString();},
    r=>{r.updatedAt=new Date(now+1).toISOString();},r=>{r.jobs.pop();},r=>{r.jobs[0].name="unexpected";},
    r=>{r.jobs[0].conclusion="skipped";},r=>{r.jobs[0].status="queued";},r=>{r.jobs[1].name=r.jobs[0].name;}]){
    const bad=structuredClone(run);mutate(bad);assert.throws(()=>assertNativeDirectory199SourceCi(bad,run.headSha,now));
  }
});
test("source CI reader performs only injected git and gh reads and rejects checkout drift", async () => {
  const prior=process.env.STAGING_SOURCE_CI_RUN_ID;process.env.STAGING_SOURCE_CI_RUN_ID="123";
  try{
    const calls=[],run=successfulCi();
    const reader=(command,args)=>{calls.push([command,args]);return command==="gh"?JSON.stringify(run):args[0]==="rev-parse"?run.headSha:"";};
    assert.deepEqual(await verifyNativeDirectory199SourceCi(root,{readSourceCiCommand:reader}),{headSha:run.headSha,runId:"123"});
    assert.deepEqual(calls.map(x=>x[0]),["git","git","gh","git","git"]);
    let heads=0;await assert.rejects(verifyNativeDirectory199SourceCi(root,{readSourceCiCommand:(command,args)=>
      command==="gh"?JSON.stringify(run):args[0]==="rev-parse"?(++heads===1?run.headSha:"b".repeat(40)):""}),/HEAD changed/u);
    await assert.rejects(verifyNativeDirectory199SourceCi(root,{readSourceCiCommand:(_command,args)=>args[0]==="rev-parse"?run.headSha:" M tracked"}),/clean exact source/u);
  }finally{if(prior===undefined)delete process.env.STAGING_SOURCE_CI_RUN_ID;else process.env.STAGING_SOURCE_CI_RUN_ID=prior;}
});

test("dry-run pins exact Ops staging 198-to-199 chain and performs no I/O", async () => {
  const plan = buildNativeDirectory198To199Plan(root);
  const result = await runNativeDirectory198To199(["dry-run"], {
    credential: () => assert.fail("dry-run must not read credentials"),
    remoteState: () => assert.fail("dry-run must not call provider"),
  });
  assert.equal(result.account, "846c924bf17bf4f3dd15c97a4c5d1d51");
  assert.equal(result.database, "78b34173-b168-4e3d-9832-bb9d245cc6b8");
  assert.equal(result.from, 198);
  assert.equal(result.to, 199);
  assert.equal(SPEC.priorNamesSha256, "d88ba83a54c045e5eb416fb912324047d68160f9f198e6b56591f0f0909788f2");
  assert.equal(SPEC.priorContentsSha256, "47369a1c36e64853cf8e82c874af734ff0c2745bef416cca9c3a01cae16f8409");
  assert.deepEqual(result.migrations, [
    { name: "0199_native_directory_profile_binding_continuations.sql", sha256: "e5847ab76b50b1a40b64b9663e7934a78a9d2961a52a6158ac7d65a27faf7568" },
  ]);
  assert.deepEqual(plan.migrations, result.migrations);
  assert.equal(result.mutationsPerformed, false);
});

test("backup and apply fail closed at the source CI gate before credentials or provider I/O", async () => {
  for (const mode of ["backup", "apply"]) {
    let gates = 0;
    await assert.rejects(runNativeDirectory198To199([mode, "ci-denied"], {
      sourceCiGate: async () => { gates++; throw Error("exact candidate source CI unavailable"); },
      credential: () => assert.fail("CI rejection must precede credentials"),
      remoteState: () => assert.fail("CI rejection must precede remote reads"),
      wrangler: () => assert.fail("CI rejection must precede provider commands"),
    }), /exact candidate source CI unavailable/u);
    assert.equal(gates, 1);
  }
});
test("invalid injected CI grants cannot reach credentials or provider I/O", async () => {
  for(const value of [undefined,null,{}, {headSha:"bad",runId:"123"},{headSha:"a".repeat(40),runId:"0"}]){
    let reached=0;
    await assert.rejects(runNativeDirectory198To199(["backup","invalid-ci"],{
      sourceCiGate:async()=>value,credential:()=>{reached++;throw Error("invalid CI grant reached credentials");},
      remoteState:()=>assert.fail("invalid CI grant reached provider"),wrangler:()=>assert.fail("invalid CI grant reached export"),
    }));
    assert.equal(reached,0,"invalid injected CI must be rejected before credentials");
  }
});

test("wrong target, extra SQL, and source drift fail closed", async () => {
  let requested = false;
  await assert.rejects(nativeDirectory198To199ReadOnlyQueries("synthetic", { ...SPEC, database: "wrong" }, ["SELECT 1"], async () => {
    requested = true;
    throw new Error("must not reach transport");
  }));
  assert.equal(requested, false);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "native-directory-198-199-inventory-"));
  try {
    const destination = path.join(temporary, "apps/operations/migrations");
    fs.mkdirSync(destination, { recursive: true });
    fs.cpSync(path.join(root, "apps/operations/migrations"), destination, { recursive: true });
    assert.equal(buildNativeDirectory198To199Plan(temporary).finalNames.length, 199);
    fs.writeFileSync(path.join(destination, "0200_unreviewed.sql"), "SELECT 1;\n", { flag: "wx" });
    assert.throws(() => buildNativeDirectory198To199Plan(temporary), /exact 0199 source profile|exact current Operations bootstrap inventory/u);
    fs.unlinkSync(path.join(destination, "0200_unreviewed.sql"));
    const last = path.join(destination, SPEC.suffix[0].name);
    fs.appendFileSync(last, "\n-- local drift\n");
    assert.throws(() => buildNativeDirectory198To199Plan(temporary), /content drifted/u);
  } finally {
    assert(path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith("native-directory-198-199-inventory-"));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("preflight accepts only exact 198 ledger and zero FK violations", async () => {
  const plan = buildNativeDirectory198To199Plan(root);
  const dependencies = { credential: () => "synthetic", remoteState: async () => current(plan), wrangler: () => assert.fail("preflight attempted a provider command") };
  const result = await runNativeDirectory198To199(["preflight"], dependencies);
  assert.equal(result.mutationsPerformed, false);
  assert.deepEqual(result.pending.map(item => item.name), SPEC.suffix.map(item => item.name));
  for (const bad of [
    { ...current(plan), ledger: plan.finalNames.map(name => ({ name })) },
    { ...current(plan), ledger: plan.priorNames.slice(0, -1).map(name => ({ name })) },
    { ...current(plan), foreignKeys: [{ table: "bad" }] },
  ]) await assert.rejects(runNativeDirectory198To199(["preflight"], { ...dependencies, remoteState: async () => bad }));
});

test("backup freshness, snapshot drift, and the shared attempt sentinel prevent apply or retry", () => {
  const now = Date.now();
  const snapshot = { ...current(buildNativeDirectory198To199Plan(root)), data: { immutable: ["row"] } };
  const saved = { snapshot, createdAt: new Date(now).toISOString() };
  assert.doesNotThrow(() => assertApplyReady(snapshot, saved, false, now));
  assert.throws(() => assertApplyReady(snapshot, saved, true, now), /existing attempt/u);
  assert.throws(() => assertApplyReady(snapshot, { ...saved, createdAt: new Date(now - 31 * 60_000).toISOString() }, false, now), /fresh backup/u);
  assert.throws(() => assertApplyReady(snapshot, { ...saved, createdAt: new Date(now + 1).toISOString() }, false, now), /fresh backup/u);
  assert.throws(() => assertApplyReady({ ...snapshot, data: { immutable: [] } }, saved, false, now), /moved after backup/u);
  const first = buildNativeDirectory198To199Plan(root, "evidence-a");
  const second = buildNativeDirectory198To199Plan(root, "evidence-b");
  assert.equal(first.marker, second.marker, "artifact labels cannot namespace retry authority");
  assert.notEqual(first.backup, second.backup);
  const marker = { application: "operations", database: SPEC.database, from: 198, to: 199,
    artifactSet: "evidence-a", migrations: first.migrations, attemptedAt: new Date(now).toISOString(), retryAllowed: false };
  assert.doesNotThrow(() => assertAttemptMarker(marker, first));
  assert.throws(() => assertAttemptMarker({ ...marker, retryAllowed: true }, first));
  assert.throws(() => assertAttemptMarker({ ...marker, database: "wrong" }, first));
  assert.throws(() => assertAttemptMarker(marker, second));
});

test("an uncertain injected apply writes one durable shared sentinel and never retries", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "native-directory-198-199-attempt-"));
  let providerCalls = 0;
  try {
    const source = path.join(temporary, "apps/operations/migrations");
    fs.mkdirSync(source, { recursive: true });
    fs.cpSync(path.join(root, "apps/operations/migrations"), source, { recursive: true });
    const plan = buildNativeDirectory198To199Plan(temporary, "attempt-a");
    fs.mkdirSync(plan.directory, { recursive: true });
    for (const item of plan.migrations) fs.copyFileSync(path.join(source, item.name), path.join(plan.directory, item.name));
    const config = {
      name: "migration-only-ltds-ops-staging-198-199-attempt-a",
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
      createdAt: new Date().toISOString(), sourceCi: { headSha: "a".repeat(40), runId: "123" },
      backupSha256: sha(bytes), migrations: plan.migrations, snapshot }), { flag: "wx" });
    const dependencies = { root: temporary, sourceCiGate: async () => ({ headSha: "a".repeat(40), runId: "123" }), credential: () => "synthetic", remoteState: async () => structuredClone(snapshot),
      wrangler: () => {
        providerCalls += 1;
        if (process.platform !== "win32") {
          assert.equal(fs.statSync(plan.marker).mode & 0o777, 0o600, "sentinel must be owner-only before provider call");
        }
        throw Error("unknown outcome sentinel fixture");
      } };
    await assert.rejects(runNativeDirectory198To199(["apply", "attempt-a"], dependencies), /unknown outcome sentinel fixture/u);
    assert(fs.existsSync(plan.marker), "apply attempt marker must persist after uncertain provider outcome");
    assert.equal(providerCalls, 1);
    await assert.rejects(runNativeDirectory198To199(["apply", "attempt-a"], dependencies), /existing attempt|reconcile only/u);
    assert.equal(providerCalls, 1, "a failed/uncertain apply must not be retried");
    const otherLabel = buildNativeDirectory198To199Plan(temporary, "attempt-b");
    assert.equal(otherLabel.marker, plan.marker, "alternate artifact label shares the no-retry marker");
    const definitions = reviewedSchemaDefinitions(plan.migrations.map(item => fs.readFileSync(path.join(source,item.name),"utf8")).join("\n"));
    const schema = [...definitions].map(([name,value])=>({name,type:value.type,sql:value.sql}));
    const after = {ledger:plan.finalNames.map(name=>({name})),foreignKeys:[],schema,
      data:Object.fromEntries(applicationTableNames(schema).map(name=>[name,[]]))};
    const marker=JSON.parse(fs.readFileSync(plan.marker,"utf8"));
    fs.writeFileSync(plan.marker,JSON.stringify({...marker,sourceCi:{...marker.sourceCi,runId:"456"}}));
    await assert.rejects(runNativeDirectory198To199(["reconcile","attempt-a"],{...dependencies,remoteState:async()=>after}),/attempt source CI must match backup/u);
    fs.writeFileSync(plan.marker,JSON.stringify(marker));
    assert.deepEqual(await runNativeDirectory198To199(["reconcile","attempt-a"],{...dependencies,remoteState:async()=>after}),
      {application:"operations",mode:"reconcile",applied:199,mutationsPerformed:false,retryAllowed:false});
    assert.equal(providerCalls,1,"reconciliation must never retry or invoke provider commands");
  } finally {
    assert(path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith("native-directory-198-199-attempt-"));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("injected backup records exact source CI without performing a provider export", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "native-directory-198-199-backup-"));
  try {
    const source = path.join(temporary, "apps/operations/migrations");
    fs.mkdirSync(source, { recursive: true });
    fs.cpSync(path.join(root, "apps/operations/migrations"), source, { recursive: true });
    const plan = buildNativeDirectory198To199Plan(temporary, "backup-a");
    const ci = { headSha: "b".repeat(40), runId: "123" };
    let exports = 0;
    let gates=0;
    await assert.rejects(runNativeDirectory198To199(["backup","backup-a"],{
      root:temporary,sourceCiGate:async()=>++gates===1?ci:{headSha:"c".repeat(40),runId:"123"},
      credential:()=>"synthetic",remoteState:async()=>current(plan),wrangler:()=>{exports++;throw Error("must not export after CI changed");},
    }),/source CI changed during preflight/u);
    assert.equal(gates,2);assert.equal(exports,0);assert.equal(fs.existsSync(plan.backup),false);
    const result = await runNativeDirectory198To199(["backup", "backup-a"], {
      root: temporary, sourceCiGate: async () => ci, credential: () => "synthetic",
      remoteState: async () => current(plan),
      wrangler: (_token, actualPlan, args) => {
        exports++;
        assert.equal(actualPlan.backup, plan.backup);
        assert.deepEqual(args, ["export", SPEC.databaseName, "--remote", "--output", plan.backup]);
        fs.writeFileSync(plan.backup, "synthetic offline export fixture\n".repeat(100));
      },
    });
    assert.equal(exports, 1);
    assert.equal(result.mutationsPerformed, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(plan.evidence, "utf8")).sourceCi, ci);
    assert.equal(fs.existsSync(plan.marker), false);
  } finally {
    assert(path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith("native-directory-198-199-backup-"));
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
  assert.deepEqual(await nativeDirectory198To199ReadOnlyQueries("synthetic", SPEC, ["SELECT 1"], fake), [[{ ok: 1 }]]);
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/846c924bf17bf4f3dd15c97a4c5d1d51/d1/database/78b34173-b168-4e3d-9832-bb9d245cc6b8/query");
  assert.equal(calls[0].options.redirect, "error");
  for (const queries of [["DELETE FROM x"], ["SELECT 1; DELETE FROM x"], ["SELECT 1", "SELECT 2", "SELECT 3"]])
    await assert.rejects(nativeDirectory198To199ReadOnlyQueries("synthetic", SPEC, queries, fake));
  await assert.rejects(nativeDirectory198To199ReadOnlyQueries("synthetic", SPEC, ["SELECT 1"], async () => ({
    ok: true, json: async () => ({ success: true, result: [{ success: true, results: [], meta: { changed_db: true } }] }),
  })));
  assert.equal(calls.length, 1);
  assert.equal(safeNativeDirectory198To199Failure(), '{"error":"staging migration boundary rejected; inspect private local evidence","retryAllowed":false}');
});

async function applyMigration(db, name) {
  let sql = fs.readFileSync(path.join(root, "apps/operations/migrations", name), "utf8");
  if (name === "0002_seed_acl.sql") sql = transformSeed("operations", sql, syntheticOwner);
  const statements = unstable_splitSqlQuery(sql.replace(/\r\n/gu, "\n")).map(value => value.trim())
    .filter(value => value && !/^PRAGMA\s+foreign_keys\s*=\s*ON/iu.test(value));
  await db.batch(statements.map(value => db.prepare(value)));
  await db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name).run();
}

test("genuine SQLite accepts 0199 after exact 198 chain and strict snapshot is preserved", { timeout: 240000, skip: process.env.SKIP_REAL_SQL === "1" }, async () => {
  const plan = buildNativeDirectory198To199Plan(root);
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
    assert.equal(normalizedSql(definitions.get("native_directory_profile_binding_commands").sql),
      normalizedSql(after.schema.find(row => row.name === "native_directory_profile_binding_commands").sql));
  } finally {
    await mf.dispose();
  }
});
