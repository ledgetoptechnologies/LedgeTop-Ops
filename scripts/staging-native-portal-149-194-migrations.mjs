import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual as same } from "node:util";
import { BOOTSTRAP_APPS } from "./staging-bootstrap.mjs";
import { collectOrderedReadOnlySnapshot } from "./ordered-read-only-snapshot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root,"apps/operations/package.json"));
const { unstable_splitSqlQuery: splitSql } = require("wrangler");
const account = "846c924bf17bf4f3dd15c97a4c5d1d51";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const SPECS = Object.freeze({
  client: Object.freeze({ application: "client", from: 147, to: 149,
    database: "b6f653ab-9acd-4421-9ad0-207754b59aeb", databaseName: "client-data-staging", binding: "DELIVERY_DB",
    migrationNamesSha256: "adec3554555949068ac785d0720c6dcddc8813489c98b5c88e88c0afd23ee659",
    migrationContentsSha256: "f0131c4467cbe6046c5da7c54f0bcd604cc39f743d9a98082d3ff59a7d34c1f1",
    suffix: Object.freeze(["0229_operations_portal_native_delivery_regrant.sql",
      "0230_operations_portal_native_delivery_terminal_cancellations.sql"]),
  }),
  operations: Object.freeze({ application: "operations", from: 190, to: 194,
    database: "78b34173-b168-4e3d-9832-bb9d245cc6b8", databaseName: "ltds-ops-staging", binding: "OPS_DB",
    migrationNamesSha256: "21797f48e9c38621119a6e78eb431594609ae5520aea9036f1e5db288a984a10",
    migrationContentsSha256: "156c845b6185e89ae18533015055b0c0e09f6939348a165da68a1a3c10eabc25",
    suffix: Object.freeze(["0191_operations_portal_native_billing_authority.sql","0192_ops_service_definition_authority.sql",
      "0193_operations_portal_native_delivery_dead_conflict_recovery.sql",
      "0194_operations_portal_native_delivery_terminal_cancellations.sql"]),
  }),
});

const artifactSetLabel = value => { if(value===undefined)return null;
  assert(typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value),"artifact-set label must be 1-64 safe ASCII characters");return value;};
const locations = (base, spec, artifactSet = null) => { const suffix=artifactSet?`-${artifactSet}`:"";return ({
  directory: path.join(base, `apps/${spec.application}/.tmp-checks/native-portal-${spec.from}-${spec.to}-migrations${suffix}`),
  config: path.join(base, `apps/${spec.application}/.tmp-checks/native-portal-${spec.from}-${spec.to}-config${suffix}.json`),
  backup: path.join(base, `apps/${spec.application}/.backups/native-portal-before-${spec.to}${suffix}.sql`),
  evidence: path.join(base, `apps/${spec.application}/.backups/native-portal-before-${spec.to}${suffix}.json`),
  // The attempt sentinel is deliberately shared by every artifact set for this
  // exact migration window. Labels may namespace backups, never retry authority.
  marker: path.join(base, `apps/${spec.application}/.backups/native-portal-${spec.from}-${spec.to}-apply-attempt.json`),
  artifactSet,
});};
function regular(file, label) { const stat = fs.lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular non-symlink file`); }
function restrictPrivate(file) {
  const result = spawnSync("powershell.exe", ["-NoProfile","-ExecutionPolicy","RemoteSigned","-File",
    path.join(root,"scripts/restrict-private-authority-file.ps1"),"-LiteralFile",file],
  { windowsHide: true, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, "private artifact ACL failed; no remote write attempted");
}
function privateFile(file, contents = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "", { flag: "wx" });
  restrictPrivate(file); fs.writeFileSync(file, contents);
}
const canonicalRows = rows => [...rows].map(row => JSON.stringify(row)).sort();
const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger','view','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name";
export const quoteSqlIdentifier = value => `"${String(value).replaceAll('"','""')}"`;
export function applicationTableNames(schema) {
  return schema.filter(row=>row.type==="table"&&row.name!=="d1_migrations"&&row.name!=="_cf_KV").map(row=>row.name).sort();
}
export function normalizedSql(sql) {
  let result="",space=false;
  for(let index=0;index<sql.length;index+=1){const character=sql[index];
    if(character==="'"){if(space&&result&&!result.endsWith(" "))result+=" ";space=false;result+=character;
      for(index+=1;index<sql.length;index+=1){result+=sql[index];if(sql[index]==="'"&&sql[index+1]==="'"){result+=sql[index+1];index+=1;}else if(sql[index]==="'")break;}continue;}
    if(character==='"'){let quoted="";for(index+=1;index<sql.length;index+=1){if(sql[index]==='"'&&sql[index+1]==='"'){quoted+='"';index+=1;}else if(sql[index]==='"')break;else quoted+=sql[index];}
      if(space&&result&&!result.endsWith(" "))result+=" ";space=false;result+=/^[A-Za-z_][A-Za-z0-9_]*$/u.test(quoted)?quoted:`"${quoted.replaceAll('"','""')}"`;continue;}
    if(/\s/u.test(character)){space=true;continue;}if(space&&result&&!result.endsWith(" "))result+=" ";space=false;result+=character;
  }
  return result.trim().replace(/;$/u,"").trim();
}
export function reviewedSchemaDefinitions(sql) {
  const definitions=new Map();
  for(const raw of splitSql(sql.replace(/\r\n/gu,"\n"))){
    const statement=raw.trim().replace(/;$/u,"").trim();
    const create=statement.match(/^CREATE\s+(?:UNIQUE\s+)?(TABLE|TRIGGER|VIEW|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/iu);
    if(create){definitions.set(create[2],{type:create[1].toLowerCase(),sql:normalizedSql(statement)});continue;}
    const drop=statement.match(/^DROP\s+(?:TABLE|TRIGGER|VIEW|INDEX)\s+(?:IF\s+EXISTS\s+)?([A-Za-z0-9_]+)/iu);
    if(drop){definitions.delete(drop[1]);continue;}
    const rename=statement.match(/^ALTER\s+TABLE\s+([A-Za-z0-9_]+)\s+RENAME\s+TO\s+([A-Za-z0-9_]+)/iu);
    if(rename&&definitions.has(rename[1])){const prior=definitions.get(rename[1]);definitions.delete(rename[1]);definitions.set(rename[2],{...prior,sql:prior.sql.replace(new RegExp(`^(CREATE\\s+(?:TABLE)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)${rename[1]}\\b`,`iu`),`$1${rename[2]}`)});}
  }
  return definitions;
}
export function buildPairedMigrationPlan(application, base = root, label) {
  const artifactSet=artifactSetLabel(label);
  const spec = SPECS[application]; assert(spec, "application must be client or operations");
  const sourceDirectory = path.join(base,`apps/${application}/migrations`);
  const entries=fs.readdirSync(sourceDirectory,{withFileTypes:true}).filter(entry=>entry.name.endsWith(".sql"));
  assert(entries.every(entry=>entry.isFile()&&!entry.isSymbolicLink()),"migration chain must contain regular files");
  const finalNames=entries.map(entry=>entry.name).sort(),chain=application==="client"?BOOTSTRAP_APPS.delivery:BOOTSTRAP_APPS.operations;
  assert.equal(chain.migrationCount,spec.to); assert.equal(chain.migrationNamesSha256,spec.migrationNamesSha256);
  assert.equal(chain.migrationContentsSha256,spec.migrationContentsSha256);
  assert.equal(finalNames.length,spec.to);assert.equal(sha(finalNames.join("\n")),spec.migrationNamesSha256);
  assert.equal(sha(finalNames.map(name=>`${name}\0${sha(fs.readFileSync(path.join(sourceDirectory,name)))}`).join("\n")),spec.migrationContentsSha256);
  assert.deepEqual(finalNames.slice(spec.from), spec.suffix);
  const migrations = spec.suffix.map(name => Object.freeze({ name, sha256: sha(fs.readFileSync(path.join(sourceDirectory,name))) }));
  return Object.freeze({ spec, sourceDirectory, priorNames:Object.freeze(finalNames.slice(0,spec.from)),
    finalNames:Object.freeze(finalNames), migrations:Object.freeze(migrations), ...locations(base,spec,artifactSet) });
}
export function assertExactLedger(rows, names, label) { assert.deepEqual(rows.map(row => row.name), names, `exact ${label} ledger required`); }
export function assertClientReadyForOperations(state, clientPlan) {
  assertExactLedger(state.ledger, clientPlan.finalNames, "Client 0149"); assert.deepEqual(state.foreignKeys, [], "Client FK violations");
}
const CLIENT_HEARTBEAT_SOURCES = new Set(["reconciliation", "thumbnail-fallback-republisher", "truenas"]);
const CLIENT_IDLE_RECONCILIATION_TABLES = new Set([
  "image_thumbnail_managed_orphan_reconciliation",
  "image_thumbnail_registration_reconciliation",
]);
const DB_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u;
function dbUtc(value, now, label) {
  assert(typeof value === "string" && DB_UTC.test(value), `${label} must be a DB UTC timestamp`);
  const instant = Date.parse(`${value.replace(" ", "T")}Z`);
  assert(Number.isFinite(instant) && instant <= now, `${label} must not be in the future`);
  assert.equal(new Date(instant).toISOString().slice(0,19).replace("T"," "),value,`${label} must be a real DB UTC date`);
  return instant;
}
function parsedRows(rows, label) {
  return rows.map((row, index) => {
    try { return JSON.parse(row); }
    catch { assert.fail(`${label}[${index}] must be canonical JSON`); }
  });
}
export function assertClientReconciliationDrift(table, beforeRows, afterRows, now = Date.now()) {
  const nowMs = now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : now;
  assert(Number.isFinite(nowMs), "reconciliation observation time must be valid");
  const before = parsedRows(beforeRows, `${table} before`), after = parsedRows(afterRows, `${table} after`);
  assert.equal(after.length, before.length, `${table} row count changed`);
  if (table === "delivery_sync_health") {
    const bySource = new Map(after.map(row => [row.source, row]));
    assert.equal(bySource.size, after.length, "delivery_sync_health sources must remain unique");
    for (const prior of before) {
      assert(CLIENT_HEARTBEAT_SOURCES.has(prior.source), "delivery_sync_health changed for an unreviewed source");
      const current = bySource.get(prior.source);
      assert(current, "delivery_sync_health source was deleted or replaced");
      if (same(current, prior)) { bySource.delete(prior.source); continue; }
      assert.deepEqual(Object.keys(current).sort(), Object.keys(prior).sort(), "delivery_sync_health row shape changed");
      for (const key of Object.keys(prior)) if (!["last_attempt_at", "last_success_at", "updated_at"].includes(key))
        assert.deepEqual(current[key], prior[key], `delivery_sync_health.${prior.source}.${key} changed`);
      assert.notEqual(current.updated_at, prior.updated_at, "delivery_sync_health heartbeat must advance updated_at");
      for (const key of ["last_attempt_at", "last_success_at", "updated_at"]) {
        if (current[key] === null) { assert.equal(prior[key], null, `delivery_sync_health.${prior.source}.${key} was cleared`); continue; }
        const currentMs = dbUtc(current[key], nowMs, `delivery_sync_health.${prior.source}.${key}`);
        if (prior[key] !== null) assert(currentMs >= dbUtc(prior[key], nowMs, `delivery_sync_health.${prior.source}.${key} prior`),
          `delivery_sync_health.${prior.source}.${key} regressed`);
      }
      bySource.delete(prior.source);
    }
    assert.equal(bySource.size, 0, "delivery_sync_health source was inserted");
    return;
  }
  assert(CLIENT_IDLE_RECONCILIATION_TABLES.has(table), "unreviewed reconciliation table");
  assert.equal(before.length, 1, `${table} must retain its singleton row`);
  const [prior] = before, [current] = after;
  if (same(current, prior)) return;
  assert.deepEqual(Object.keys(current).sort(), Object.keys(prior).sort(), `${table} row shape changed`);
  assert.equal(prior.singleton, 1); assert.equal(current.singleton, 1);
  assert.equal(prior.cursor, null, `${table} prior cursor must be idle`); assert.equal(current.cursor, null, `${table} cursor must remain idle`);
  for (const key of Object.keys(prior)) if (!["completed_cycles", "updated_at"].includes(key))
    assert.deepEqual(current[key], prior[key], `${table}.${key} changed`);
  assert(Number.isSafeInteger(prior.completed_cycles) && prior.completed_cycles >= 0, `${table} prior completed_cycles is invalid`);
  assert(Number.isSafeInteger(current.completed_cycles) && current.completed_cycles >= prior.completed_cycles,
    `${table} completed_cycles regressed or is invalid`);
  const priorUpdated = dbUtc(prior.updated_at, nowMs, `${table}.updated_at prior`);
  assert(dbUtc(current.updated_at, nowMs, `${table}.updated_at`) >= priorUpdated, `${table}.updated_at regressed`);
}
export function assertPreserved(before, after, reviewedDefinitions, application, now = Date.now()) {
  assert.deepEqual(after.foreignKeys, []); const reviewed = new Set(reviewedDefinitions.keys());
  assert.deepEqual(after.schema.filter(row => !reviewed.has(row.name)), before.schema.filter(row => !reviewed.has(row.name)),
    "pre-existing schema changed outside reviewed migration objects");
  const afterByName=new Map(after.schema.map(row=>[row.name,row]));
  for(const [name,expected] of reviewedDefinitions){const actual=afterByName.get(name);assert(actual,`reviewed schema object missing: ${name}`);assert.equal(actual.type,expected.type,`reviewed schema type changed: ${name}`);assert.equal(normalizedSql(actual.sql),expected.sql,`reviewed schema definition changed: ${name}`);}
  for(const [table,rows] of Object.entries(before.data)){
    if(application==="operations"&&table==="permissions"){
      const expected=[...rows,JSON.stringify({key:"billing.portal_access.manage",description:"Grant or revoke one explicit native billing entity in an enrolled client portal"})].sort();
      assert.deepEqual(after.data[table],expected,"permissions changed outside exact reviewed billing capability");
    }else if(application === "client" && (table === "delivery_sync_health" || CLIENT_IDLE_RECONCILIATION_TABLES.has(table)))
      assertClientReconciliationDrift(table, rows, after.data[table], now);
    else assert.deepEqual(after.data[table],rows,`pre-existing table changed: ${table}`);
  }
  const priorTables=new Set(Object.keys(before.data));
  for(const [table,rows] of Object.entries(after.data))if(!priorTables.has(table))assert.deepEqual(rows,[],`new table unexpectedly populated: ${table}`);
}
export function assertApplyReady(current, saved, markerExists, now = Date.now()) {
  assert.equal(markerExists, false, "existing attempt; reconcile only");
  assert.deepEqual(current, saved.snapshot, "remote state moved after backup");
  const createdAt = Date.parse(saved.createdAt);
  assert(Number.isFinite(createdAt) && createdAt <= now && now - createdAt < 30 * 60 * 1000, "fresh backup required");
}
export function assertAttemptMarker(marker, plan) {
  assert.deepEqual(Object.keys(marker).sort(), ["application","attemptedAt","database","from","migrations","retryAllowed","to",...(plan.artifactSet?["artifactSet"]:[])].sort());
  assert.equal(marker.application, plan.spec.application); assert.equal(marker.database, plan.spec.database);
  assert.equal(marker.from, plan.spec.from); assert.equal(marker.to, plan.spec.to);
  assert.deepEqual(marker.migrations, plan.migrations); assert.equal(marker.retryAllowed, false);
  if(plan.artifactSet)assert.equal(marker.artifactSet,plan.artifactSet);
  assert(Number.isFinite(Date.parse(marker.attemptedAt)), "attempt marker timestamp required");
}
function config(plan) { return { name:`migration-only-${plan.spec.databaseName}-${plan.spec.from}-${plan.spec.to}${plan.artifactSet?`-${plan.artifactSet}`:""}`,
  account_id:account,d1_databases:[{binding:plan.spec.binding,database_name:plan.spec.databaseName,
    database_id:plan.spec.database,migrations_dir:path.relative(path.dirname(plan.config),plan.directory).replaceAll("\\","/")}]}; }
export function materialize(plan) {
  assert(!fs.existsSync(plan.directory) && !fs.existsSync(plan.config)); fs.mkdirSync(plan.directory,{recursive:true});
  for(const item of plan.migrations) fs.copyFileSync(path.join(plan.sourceDirectory,item.name),path.join(plan.directory,item.name),fs.constants.COPYFILE_EXCL);
  privateFile(plan.config,`${JSON.stringify(config(plan),null,2)}\n`); return plan;
}
function credential(){const values=fs.readFileSync("C:/Users/fstor/Downloads/prompt.md","utf8").split(/\r?\n/u).map(v=>v.trim()).filter(v=>/^cfat_[A-Za-z0-9_-]+$/u.test(v));assert.equal(values.length,1);return values[0];}
async function select(token,spec,sql){assert.match(sql,/^SELECT\s/u);const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${spec.database}/query`,{method:"POST",redirect:"error",signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({sql})});const body=await response.json();assert(response.ok&&body.success&&body.result?.length===1&&body.result[0].success,"read-only D1 query failed");assert.equal(body.result[0].meta.changed_db,false);return body.result[0].results;}
async function remoteState(token,plan){const schema=await select(token,plan.spec,schemaSql),data=await collectOrderedReadOnlySnapshot(applicationTableNames(schema),async table=>canonicalRows(await select(token,plan.spec,`SELECT * FROM ${quoteSqlIdentifier(table)}`)));return{ledger:await select(token,plan.spec,"SELECT name FROM d1_migrations ORDER BY name"),foreignKeys:await select(token,plan.spec,'SELECT * FROM pragma_foreign_key_check ORDER BY "table", rowid, parent, fkid'),schema,data};}
const wranglerFailure = outcomeCode => { const error=Error("provider command outcome unavailable; reconcile before any retry");error.outcomeCode=outcomeCode;return error;};
export function assertPinnedWranglerVersion(lockfile, installedPackage) {
  const expected=lockfile?.packages?.["node_modules/wrangler"]?.version,actual=installedPackage?.version;
  assert.equal(installedPackage?.name,"wrangler","installed Wrangler package identity mismatch");
  assert(typeof expected==="string"&&expected.length>0,"Wrangler lockfile pin required");
  assert(typeof actual==="string"&&actual.length>0,"installed Wrangler version required");
  assert.equal(actual,expected,"installed Wrangler version differs from application lockfile");
  return actual;
}
function wrangler(token,plan,args){const appDirectory=path.join(root,"apps",plan.spec.application),launcher=path.join(appDirectory,"node_modules/wrangler/bin/wrangler.js");
  try{const lockfilePath=path.join(appDirectory,"package-lock.json"),installedPath=path.join(appDirectory,"node_modules/wrangler/package.json");
    regular(lockfilePath,"application lockfile");regular(installedPath,"installed Wrangler package metadata");
    assertPinnedWranglerVersion(JSON.parse(fs.readFileSync(lockfilePath,"utf8")),JSON.parse(fs.readFileSync(installedPath,"utf8")));
  }catch{throw wranglerFailure("dependency-mismatch");}
  try{regular(launcher,"Wrangler launcher");}catch{throw wranglerFailure("launcher-invalid");}
  const child=spawnSync(process.execPath,[launcher,"d1",...args,"--config",plan.config],{cwd:root,windowsHide:true,timeout:180000,encoding:"utf8",stdio:["ignore","pipe","pipe"],env:{...process.env,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:account,CI:"true",WRANGLER_SEND_METRICS:"false"}});
  if(child.error)throw wranglerFailure(child.error.code==="ETIMEDOUT"?"timeout":"spawn-failed");
  if(child.status===null)throw wranglerFailure("timeout-or-signal");
  if(child.status!==0)throw wranglerFailure("exit-nonzero");
}
export async function runPairedMigration(argv=process.argv.slice(2),dependencies={}){
  assert([2,3].includes(argv.length),"usage: <client|operations> <preflight|backup|apply|reconcile> [artifact-set]");const [application,mode,label]=argv;assert(["preflight","backup","apply","reconcile"].includes(mode));
  const plan=buildPairedMigrationPlan(application,root,label),clientPlan=buildPairedMigrationPlan("client",root,label),token=(dependencies.credential??credential)();
  const read=dependencies.remoteState??remoteState;
  if(application==="operations")assertClientReadyForOperations(await read(token,clientPlan),clientPlan);
  const current=await read(token,plan);assert.deepEqual(current.foreignKeys,[]);
  assertExactLedger(current.ledger,mode==="reconcile"?plan.finalNames:plan.priorNames,`${application} ${mode==="reconcile"?plan.spec.to:plan.spec.from}`);
  if(mode==="preflight")return{application,mode,pending:plan.migrations.map(x=>x.name),mutationsPerformed:false};
  if(mode==="backup"){
    for(const file of[plan.backup,plan.evidence,plan.marker,plan.config])assert(!fs.existsSync(file));materialize(plan);privateFile(plan.backup);
    try{(dependencies.wrangler??wrangler)(token,plan,["export",plan.spec.databaseName,"--remote","--output",plan.backup]);}
    catch(error){const failure=Error("provider export failed");failure.stage="provider-export";failure.outcomeCode=error?.outcomeCode;throw failure;}
    try{restrictPrivate(plan.backup);regular(plan.backup,"backup");assert(fs.statSync(plan.backup).size>1000);}
    catch(error){error.stage="export-verification";throw error;}
    try{privateFile(plan.evidence,JSON.stringify({application,database:plan.spec.database,...(plan.artifactSet?{artifactSet:plan.artifactSet}:{}),createdAt:new Date().toISOString(),backupSha256:sha(fs.readFileSync(plan.backup)),migrations:plan.migrations,snapshot:current}));}
    catch(error){error.stage="evidence-write";throw error;}
    return{application,mode,mutationsPerformed:false,backupBytes:fs.statSync(plan.backup).size};
  }
  for(const file of[plan.config,plan.backup,plan.evidence])regular(file,"private release artifact");const saved=JSON.parse(fs.readFileSync(plan.evidence,"utf8"));assert.equal(saved.application,application);assert.equal(saved.database,plan.spec.database);assert.equal(saved.artifactSet??null,plan.artifactSet);assert.equal(saved.backupSha256,sha(fs.readFileSync(plan.backup)));assert.deepEqual(saved.migrations,plan.migrations);
  assert.deepEqual(JSON.parse(fs.readFileSync(plan.config,"utf8")),config(plan));assert.deepEqual(fs.readdirSync(plan.directory).sort(),plan.migrations.map(item=>item.name));for(const item of plan.migrations)assert.equal(sha(fs.readFileSync(path.join(plan.directory,item.name))),item.sha256);
  if(mode==="apply"){
    assertApplyReady(current,saved,fs.existsSync(plan.marker));
    assert.equal(fs.existsSync(plan.marker),false,"existing attempt; reconcile only");
    privateFile(plan.marker,JSON.stringify({application,database:plan.spec.database,from:plan.spec.from,to:plan.spec.to,...(plan.artifactSet?{artifactSet:plan.artifactSet}:{}),migrations:plan.migrations,attemptedAt:new Date().toISOString(),retryAllowed:false}));
    (dependencies.wrangler??wrangler)(token,plan,["migrations","apply",plan.spec.databaseName,"--remote"]);return{application,mode,retryAllowed:false,next:"reconcile"};
  }
  regular(plan.marker,"attempt marker");assertAttemptMarker(JSON.parse(fs.readFileSync(plan.marker,"utf8")),plan);
  const after=current;const sql=plan.migrations.map(item=>fs.readFileSync(path.join(plan.directory,item.name),"utf8")).join("\n");assertPreserved(saved.snapshot,after,reviewedSchemaDefinitions(sql),application);return{application,mode,applied:plan.spec.to,mutationsPerformed:false,retryAllowed:false};
}
export { SPECS };
const SAFE_STAGES=new Set(["provider-export","export-verification","evidence-write"]);
const SAFE_EXPORT_OUTCOMES=new Set(["dependency-mismatch","launcher-invalid","spawn-failed","timeout","timeout-or-signal","exit-nonzero"]);
export const safeFailure = error => JSON.stringify({error:"staging migration boundary rejected; inspect private local evidence",...(SAFE_STAGES.has(error?.stage)?{stage:error.stage}:{}),...(error?.stage==="provider-export"&&SAFE_EXPORT_OUTCOMES.has(error?.outcomeCode)?{outcomeCode:error.outcomeCode}:{}),retryAllowed:false});
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runPairedMigration().then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(safeFailure(error));process.exitCode=1;});
