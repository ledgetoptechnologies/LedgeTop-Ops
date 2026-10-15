import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { applicationTableNames, assertApplyReady, assertAttemptMarker, assertClientReadyForOperations, assertClientReconciliationDrift, assertExactLedger, assertPinnedWranglerVersion, assertPreserved, buildPairedMigrationPlan,
  normalizedSql, quoteSqlIdentifier, readOnlyQueries, reviewedSchemaDefinitions, safeFailure, SPECS } from "./staging-native-portal-149-194-migrations.mjs";
import { transformSeed, OPERATIONS_LATEST_SOURCE_MIGRATION_CHAIN } from "./staging-bootstrap.mjs";

const repositoryRoot=path.resolve(import.meta.dirname,"..");
// These older migration tools keep their exact205 source authority. Exercise
// their positive contracts against that immutable prefix, not future206 SQL.
const root=fs.mkdtempSync(path.join(os.tmpdir(),"paired-reviewed205-fixture-"));
for(const application of ["client","operations"]){
  const source=path.join(repositoryRoot,`apps/${application}/migrations`),destination=path.join(root,`apps/${application}/migrations`);
  fs.mkdirSync(destination,{recursive:true});
  for(const name of fs.readdirSync(source)){
    if(application==="operations"&&/^\d{4}_/.test(name)&&Number(name.slice(0,4))>OPERATIONS_LATEST_SOURCE_MIGRATION_CHAIN.count)continue;
    fs.copyFileSync(path.join(source,name),path.join(destination,name));
  }
}
// The CLI derives its source root from import.meta.url. Copy its unchanged
// scripts so mocked preflight calls exercise the same frozen fixture as plans.
const fixtureScripts=path.join(root,"scripts");fs.mkdirSync(fixtureScripts);
for(const name of fs.readdirSync(path.join(repositoryRoot,"scripts")))
  if(name.endsWith(".mjs"))fs.copyFileSync(path.join(repositoryRoot,"scripts",name),path.join(fixtureScripts,name));
fs.symlinkSync(path.join(repositoryRoot,"apps/operations/node_modules"),path.join(root,"apps/operations/node_modules"),process.platform==="win32"?"junction":"dir");
assert.deepEqual(fs.readFileSync(path.join(fixtureScripts,"staging-native-portal-149-194-migrations.mjs")),fs.readFileSync(path.join(repositoryRoot,"scripts/staging-native-portal-149-194-migrations.mjs")));
const {runPairedMigration}=await import(pathToFileURL(path.join(fixtureScripts,"staging-native-portal-149-194-migrations.mjs")).href);
after(()=>{
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith("paired-reviewed205-fixture-"));
  fs.rmSync(root,{recursive:true,force:true});
});
const require=createRequire(path.join(repositoryRoot,"apps/operations/package.json")),{Miniflare}=require("miniflare"),{unstable_splitSqlQuery}=require("wrangler");
const syntheticOwner={email:"owner@staging.example.test",displayName:"Synthetic Staging Owner",clientStaffId:"staging-client-owner",operationsStaffId:"staging-operations-owner"};
async function applyMigration(db,application,name){let sql=fs.readFileSync(path.join(root,"apps",application,"migrations",name),"utf8");if(name===(application==="client"?"0002_seed_initial_staff.sql":"0002_seed_acl.sql"))sql=transformSeed(application==="client"?"delivery":"operations",sql,syntheticOwner);const statements=unstable_splitSqlQuery(sql.replace(/\r\n/gu,"\n")).map(value=>value.trim()).filter(value=>value&&!/^PRAGMA\s+foreign_keys\s*=\s*ON/iu.test(value));await db.batch(statements.map(value=>db.prepare(value)));}
test("frozen paired tools refuse actual206 source instead of broadening149/194 authority",()=>{
  assert(fs.existsSync(path.join(repositoryRoot,"apps/operations/migrations/0206_native_directory_existing_import.sql")));
  for(const application of ["operations","project-guard"])
    assert.throws(()=>buildPairedMigrationPlan(application,repositoryRoot));
});

test("pins exact Client 147->149 and Ops 190->194 suffixes and targets",()=>{
  const client=buildPairedMigrationPlan("client",root),ops=buildPairedMigrationPlan("operations",root);
  assert.equal(client.priorNames.length,147);assert.equal(client.finalNames.length,149);assert.deepEqual(client.migrations.map(x=>x.name),SPECS.client.suffix);
  assert.equal(ops.priorNames.length,190);assert.equal(ops.finalNames.length,194);assert.deepEqual(ops.migrations.map(x=>x.name),SPECS.operations.suffix);
  assert.equal(client.spec.database,"b6f653ab-9acd-4421-9ad0-207754b59aeb");assert.equal(ops.spec.database,"78b34173-b168-4e3d-9832-bb9d245cc6b8");
  assert.equal(client.spec.migrationContentsSha256,"f0131c4467cbe6046c5da7c54f0bcd604cc39f743d9a98082d3ff59a7d34c1f1");
  assert.equal(ops.spec.migrationContentsSha256,"156c845b6185e89ae18533015055b0c0e09f6939348a165da68a1a3c10eabc25");
});
test("frozen 194 plan validates the entire reviewed source and excludes later SQL from apply",()=>{
  const plan=buildPairedMigrationPlan("operations",root);
  const names=fs.readdirSync(plan.sourceDirectory).filter(name=>name.endsWith(".sql")).sort();
  assert.deepEqual(plan.finalNames,names.slice(0,194));
  assert.deepEqual(plan.migrations.map(item=>item.name),SPECS.operations.suffix);
  assert(!plan.migrations.some(item=>item.name.startsWith("0195_")));
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"paired-frozen-chain-"));
  try{
    const destination=path.join(temporary,"apps/operations/migrations");
    fs.cpSync(plan.sourceDirectory,destination,{recursive:true});
    fs.writeFileSync(path.join(destination,"9999_unreviewed.sql"),"SELECT 1;\n",{flag:"wx"});
    assert.throws(()=>buildPairedMigrationPlan("operations",temporary));
    fs.unlinkSync(path.join(destination,"9999_unreviewed.sql"));
    const latest=names.at(-1);fs.appendFileSync(path.join(destination,latest),"\n-- unreviewed source change\n");
    assert.throws(()=>buildPairedMigrationPlan("operations",temporary));
  }finally{
    assert(path.dirname(temporary)===path.resolve(os.tmpdir())&&path.basename(temporary).startsWith("paired-frozen-chain-"));
    fs.rmSync(temporary,{recursive:true,force:true});
  }
});
test("frozen Client149 window verifies Client150 source without applying primary private ingress candidate",()=>{
  const plan=buildPairedMigrationPlan("client",root);
  const candidate="0231_portal_primary_private_ingress_authority.sql";
  assert(fs.existsSync(path.join(plan.sourceDirectory,candidate)));
  assert.equal(plan.finalNames.length,149);
  assert(!plan.finalNames.includes(candidate));
  assert(!plan.migrations.some(item=>item.name===candidate));
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"paired-client-candidate-"));
  try{
    const destination=path.join(temporary,"apps/client/migrations");
    fs.cpSync(plan.sourceDirectory,destination,{recursive:true});
    fs.appendFileSync(path.join(destination,candidate),"\n-- unreviewed candidate drift\n");
    assert.throws(()=>buildPairedMigrationPlan("client",temporary));
  }finally{
    assert(path.dirname(temporary)===path.resolve(os.tmpdir())&&path.basename(temporary).startsWith("paired-client-candidate-"));
    fs.rmSync(temporary,{recursive:true,force:true});
  }
});
test("exact ledgers and Client-first dependency fail closed",()=>{
  const client=buildPairedMigrationPlan("client",root);assert.doesNotThrow(()=>assertExactLedger(client.finalNames.map(name=>({name})),client.finalNames,"Client"));
  assert.throws(()=>assertExactLedger(client.finalNames.slice(0,-1).map(name=>({name})),client.finalNames,"Client"));
  assert.doesNotThrow(()=>assertClientReadyForOperations({ledger:client.finalNames.map(name=>({name})),foreignKeys:[]},client));
  assert.throws(()=>assertClientReadyForOperations({ledger:client.priorNames.map(name=>({name})),foreignKeys:[]},client));
  assert.throws(()=>assertClientReadyForOperations({ledger:client.finalNames.map(name=>({name})),foreignKeys:[{}]},client));
});
test("schema preservation allows only reviewed created objects and preserves authority rows",()=>{
  const reviewed=reviewedSchemaDefinitions("CREATE TABLE x(a); CREATE TRIGGER y BEFORE INSERT ON x BEGIN SELECT 1; SELECT 2; END;");
  const before={foreignKeys:[],schema:[{type:"table",name:"old",sql:"same"}],data:{heads:["a"]}},after={foreignKeys:[],schema:[{type:"table",name:"old",sql:"same"},{type:"table",name:"x",sql:"CREATE TABLE x(a)"},{type:"trigger",name:"y",sql:"CREATE TRIGGER y BEFORE INSERT ON x BEGIN SELECT 1; SELECT 2; END"}],data:{heads:["a"],x:[]}};
  assert.doesNotThrow(()=>assertPreserved(before,after,reviewed,"client"));
  assert.throws(()=>assertPreserved(before,{...after,data:{...after.data,heads:["b"]}},reviewed,"client"));
  assert.throws(()=>assertPreserved(before,{...after,schema:after.schema.filter(row=>row.name!=="y")},reviewed,"client"),/missing/u);
  assert.throws(()=>assertPreserved(before,{...after,schema:after.schema.map(row=>row.name==="y"?{...row,sql:"CREATE TRIGGER y BEFORE INSERT ON x BEGIN SELECT 9; END"}:row)},reviewed,"client"),/definition/u);
  assert.throws(()=>assertPreserved(before,{...after,schema:[...after.schema,{type:"view",name:"z",sql:"CREATE VIEW z AS SELECT 1"}]},reviewed,"client"));
});
const row=value=>JSON.stringify(value);
const health=(source,overrides={})=>row({source,last_attempt_at:"2026-10-11 10:00:00",last_success_at:"2026-10-11 10:00:00",status:"healthy",object_count:7,details_json:"{}",updated_at:"2026-10-11 10:00:00",...overrides});
const idle=(overrides={})=>row({singleton:1,cursor:null,scanned_count:0,cleaned_count:0,completed_cycles:4,updated_at:"2026-10-11 10:00:00",...overrides});
const observation="2026-10-11T10:10:00Z";
test("permits only observed timestamp-only health heartbeats for the exact existing sources",()=>{
  const before=[health("reconciliation"),health("thumbnail-fallback-republisher"),health("truenas")];
  const after=[health("reconciliation",{last_attempt_at:"2026-10-11 10:01:00",updated_at:"2026-10-11 10:01:00"}),health("thumbnail-fallback-republisher",{last_attempt_at:"2026-10-11 10:02:00",last_success_at:"2026-10-11 10:02:00",updated_at:"2026-10-11 10:02:00"}),health("truenas",{last_success_at:"2026-10-11 10:03:00",updated_at:"2026-10-11 10:03:00"})];
  assert.doesNotThrow(()=>assertClientReconciliationDrift("delivery_sync_health",before,after,observation));
  assert.throws(()=>assertClientReconciliationDrift("delivery_sync_health",before,after.slice(1),observation),/row count/u);
  assert.throws(()=>assertClientReconciliationDrift("delivery_sync_health",before,[...after.slice(0,2),health("other",{updated_at:"2026-10-11 10:03:00"})],observation),/deleted or replaced|unreviewed/u);
  assert.throws(()=>assertClientReconciliationDrift("delivery_sync_health",before,[health("reconciliation",{status:"error",updated_at:"2026-10-11 10:01:00"}),...after.slice(1)],observation),/status changed/u);
  assert.throws(()=>assertClientReconciliationDrift("delivery_sync_health",before,[health("reconciliation",{updated_at:"2026-10-11 09:59:59"}),...after.slice(1)],observation),/regressed/u);
  assert.throws(()=>assertClientReconciliationDrift("delivery_sync_health",before,[health("reconciliation",{updated_at:"2026-10-11 10:11:00"}),...after.slice(1)],observation),/future/u);
});
test("permits only an idle singleton reconciliation cycle heartbeat",()=>{
  for(const table of ["image_thumbnail_managed_orphan_reconciliation","image_thumbnail_registration_reconciliation"])
    assert.doesNotThrow(()=>assertClientReconciliationDrift(table,[idle()],[idle({completed_cycles:5,updated_at:"2026-10-11 10:01:00"})],observation));
  assert.throws(()=>assertClientReconciliationDrift("image_thumbnail_registration_reconciliation",[idle()],[idle({cursor:"next",completed_cycles:5,updated_at:"2026-10-11 10:01:00"})],observation),/cursor/u);
  assert.throws(()=>assertClientReconciliationDrift("image_thumbnail_registration_reconciliation",[idle()],[idle({scanned_count:1,completed_cycles:5,updated_at:"2026-10-11 10:01:00"})],observation),/scanned_count/u);
  assert.throws(()=>assertClientReconciliationDrift("image_thumbnail_registration_reconciliation",[idle()],[idle({completed_cycles:3,updated_at:"2026-10-11 10:01:00"})],observation),/completed_cycles/u);
});
test("live heartbeat policy cannot conceal authorization, row-shape or malformed-time changes",()=>{
  const prior=health("reconciliation"),advance={updated_at:"2026-10-11 10:01:00"};
  for(const overrides of [{...advance,object_count:8},{...advance,details_json:'{"changed":true}'},{...advance,extra:1},
    {...advance,last_success_at:null},{updated_at:"2026-02-30 10:01:00"}])
    assert.throws(()=>assertClientReconciliationDrift("delivery_sync_health",[prior],[health("reconciliation",overrides)],observation));
  assert.throws(()=>assertClientReconciliationDrift("delivery_sync_health",[prior],[prior,health("truenas")],observation));
  for(const overrides of [{completed_cycles:NaN},{completed_cycles:1.5},{updated_at:"2026-10-11 10:11:00"},{singleton:2},{cleaned_count:1}])
    assert.throws(()=>assertClientReconciliationDrift("image_thumbnail_registration_reconciliation",[idle()],[idle(overrides)],observation));
  const before={foreignKeys:[],schema:[],data:{delivery_sync_health:[prior],authority:['{"state":"private"}']}};
  const after={foreignKeys:[],schema:[],data:{delivery_sync_health:[health("reconciliation",advance)],authority:['{"state":"active"}']}};
  assert.throws(()=>assertPreserved(before,after,new Map(),"client",observation),/pre-existing table changed: authority/u);
  assert.throws(()=>assertPreserved(before,{...after,data:{...after.data,authority:before.data.authority},schema:[{name:"unreviewed"}]},new Map(),"client",observation),/schema changed/u);
});
test("models Client heads rebuild and the single reviewed Ops permission seed exactly",()=>{
  const clientSql=SPECS.client.suffix.map(name=>fs.readFileSync(path.join(root,"apps/client/migrations",name),"utf8")).join("\n");
  const reviewed=reviewedSchemaDefinitions(clientSql);
  assert.equal(reviewed.has("operations_portal_native_delivery_heads_next"),false);
  assert.equal(reviewed.has("operations_portal_native_delivery_heads"),true);
  assert.match(reviewed.get("operations_portal_native_delivery_heads").sql,/^CREATE TABLE operations_portal_native_delivery_heads \(/u);
  const before={foreignKeys:[],schema:[],data:{permissions:[JSON.stringify({key:"existing",description:"Existing"})]}},after={foreignKeys:[],schema:[],data:{permissions:[JSON.stringify({key:"billing.portal_access.manage",description:"Grant or revoke one explicit native billing entity in an enrolled client portal"}),JSON.stringify({key:"existing",description:"Existing"})].sort()}};
  assert.doesNotThrow(()=>assertPreserved(before,after,new Map(),"operations"));
  assert.throws(()=>assertPreserved(before,after,new Map(),"client"),/pre-existing table/u);
  assert.throws(()=>assertPreserved(before,{...after,data:{permissions:[...after.data.permissions,JSON.stringify({key:"extra",description:"Extra"})].sort()}},new Map(),"operations"),/permissions/u);
});
test("SQL normalization preserves quoted literal bytes",()=>{
  assert.equal(normalizedSql("CREATE VIEW x AS SELECT  'a  b' AS \"value\";"),"CREATE VIEW x AS SELECT 'a  b' AS value");
  assert.notEqual(normalizedSql("CREATE VIEW x AS SELECT 'a  b'"),normalizedSql("CREATE VIEW x AS SELECT 'a b'"));
  const reviewed=reviewedSchemaDefinitions("CREATE VIEW literal_guard AS SELECT 'PRIVATE  SENTINEL' value;");
  const before={foreignKeys:[],schema:[],data:{}},after={foreignKeys:[],schema:[{type:"view",name:"literal_guard",tbl_name:"literal_guard",sql:"CREATE VIEW literal_guard AS SELECT 'PRIVATE SENTINEL' value"}],data:{}};
  assert.throws(()=>assertPreserved(before,after,reviewed,"client"),/definition/u);
});
test("captures every application table while excluding only provider and ledger internals",()=>{
  const schema=[{type:"table",name:"d1_migrations"},{type:"table",name:"_cf_KV"},{type:"table",name:"known"},{type:"table",name:'odd"table'},{type:"view",name:"not_a_table"}];
  assert.deepEqual(applicationTableNames(schema),["known",'odd"table']);
  assert.equal(quoteSqlIdentifier('odd"table'),'"odd""table"');
});
for(const application of ["client","operations","project-guard"]){test(`schema model matches genuine SQLite ${application} suffix`,{timeout:180000,skip:process.env.SKIP_REAL_SQL==="1"},async()=>{
  const plan=buildPairedMigrationPlan(application,root),mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",compatibilityDate:"2026-08-06",d1Databases:{DB:crypto.randomUUID()}});
  try{const db=await mf.getD1Database("DB");for(const name of plan.priorNames)await applyMigration(db,plan.spec.application,name);
    const capture=async()=>{const schema=(await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger','view','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results,data={};
      // Miniflare's private metadata table is not application state and rejects SELECT.
      for(const table of applicationTableNames(schema).filter(name=>name!=="_cf_METADATA"))data[table]=(await db.prepare(`SELECT * FROM ${quoteSqlIdentifier(table)}`).all()).results.map(value=>JSON.stringify(value)).sort();
      return {schema,data,foreignKeys:(await db.prepare("SELECT * FROM pragma_foreign_key_check").all()).results};};
    const before=application==="project-guard"?await capture():null;
    for(const item of plan.migrations)await applyMigration(db,plan.spec.application,item.name);
    const schema=(await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger','view','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all()).results;
    const actual=new Map(schema.map(row=>[row.name,row])),sql=plan.migrations.map(item=>fs.readFileSync(path.join(plan.sourceDirectory,item.name),"utf8")).join("\n"),reviewed=reviewedSchemaDefinitions(sql);
    for(const [name,expected] of reviewed){const found=actual.get(name);assert(found,`missing ${application} ${name}`);assert.equal(found.type,expected.type);assert.equal(normalizedSql(found.sql),expected.sql,`definition ${application} ${name}`);}
    if(before)assertPreserved(before,await capture(),reviewed,plan.spec.preservationPolicy);
  }finally{await mf.dispose();}
});}
test("project guard window is isolated and cannot inherit the earlier permission-seed exception",async()=>{
  const guard=buildPairedMigrationPlan("project-guard",root,"guard01"),old=buildPairedMigrationPlan("operations",root,"guard01"),client=buildPairedMigrationPlan("client",root,"guard01");
  assert.equal(guard.spec.application,"operations");assert.equal(guard.spec.from,194);assert.equal(guard.spec.to,195);
  assert.equal(guard.priorNames.length,194);assert.equal(guard.finalNames.length,195);
  assert.deepEqual(guard.migrations.map(item=>item.name),["0195_client_hub_native_project_current_owner_observation.sql"]);
  assert.equal(guard.migrations[0].sha256,"aaa8b35e502ed634cd38ed16c5a870a91f63c0ee578a031aec15744e7947ea44");
  for(const file of [guard.sourceDirectory,guard.config,guard.backup,guard.marker])assert(file.startsWith(path.join(root,"apps/operations")));
  assert.notEqual(guard.marker,old.marker);assert.equal(guard.spec.preservationPolicy,"strict");
  const marker={application:"operations",window:"project-guard",database:guard.spec.database,from:194,to:195,artifactSet:"guard01",migrations:guard.migrations,retryAllowed:false,attemptedAt:"2026-10-11T11:00:00Z"};
  assert.doesNotThrow(()=>assertAttemptMarker(marker,guard));
  assert.throws(()=>assertAttemptMarker({...marker,window:"operations"},guard));
  assert.throws(()=>assertAttemptMarker({...marker,application:"project-guard"},guard));
  assert.throws(()=>assertAttemptMarker(marker,old));
  const before={foreignKeys:[],schema:[],data:{permissions:[]}},after={...before,data:{permissions:[JSON.stringify({key:"billing.portal_access.manage",description:"Grant or revoke one explicit native billing entity in an enrolled client portal"})]}};
  assert.throws(()=>assertPreserved(before,after,new Map(),guard.spec.preservationPolicy),/pre-existing table changed/u);
  const calls=[],states={client:{ledger:client.finalNames.map(name=>({name})),foreignKeys:[],schema:[],data:{}},operations:{ledger:guard.priorNames.map(name=>({name})),foreignKeys:[],schema:[],data:{}}};
  const dependencies={credential:()=>"synthetic",remoteState:async(_token,plan)=>{calls.push(plan.spec.application);return states[plan.spec.application];},wrangler:()=>assert.fail("read-only preflight attempted a write")};
  assert.deepEqual(await runPairedMigration(["project-guard","preflight"],dependencies),{application:"operations",window:"project-guard",mode:"preflight",pending:guard.migrations.map(item=>item.name),mutationsPerformed:false});
  assert.deepEqual(calls,["client","operations"]);
  states.client.ledger=states.client.ledger.slice(0,-1);await assert.rejects(runPairedMigration(["project-guard","preflight"],dependencies),/Client 0149/u);
  states.client.ledger=client.finalNames.map(name=>({name}));states.client.foreignKeys=[{}];await assert.rejects(runPairedMigration(["project-guard","preflight"],dependencies),/FK/u);
  states.client.foreignKeys=[];
  for(const names of [guard.priorNames.slice(0,-1),guard.finalNames]){states.operations.ledger=names.map(name=>({name}));await assert.rejects(runPairedMigration(["project-guard","preflight"],dependencies),/exact operations|exact project-guard/u);}
});
test("failure output is fixed and cannot disclose assertion snapshots",()=>{
  const sentinel="PRIVATE_ROW_SENTINEL_DO_NOT_LOG",output=safeFailure(new Error(`actual ${sentinel}`));
  assert.equal(output,'{"error":"staging migration boundary rejected; inspect private local evidence","retryAllowed":false}');assert(!output.includes(sentinel));
});
test("read-only API batches require every bounded result to report no database change",async()=>{
  const queries=["SELECT COUNT(*) AS snapshot_count FROM x","SELECT * FROM x"],calls=[];
  const response=results=>({ok:true,json:async()=>({success:true,result:results})});
  const results=[{success:true,meta:{changed_db:false},results:[{snapshot_count:1}]},{success:true,meta:{changed_db:false},results:[{id:1}]}];
  const request=async(_url,options)=>{calls.push(JSON.parse(options.body));return response(results);};
  assert.deepEqual(await readOnlyQueries("synthetic-token",SPECS.client,queries,request),results.map(result=>result.results));
  assert.deepEqual(calls,[{batch:queries.map(sql=>({sql}))}]);
  for(const invalid of [results.slice(0,1),[results[0],{...results[1],success:false}],[results[0],{...results[1],meta:{changed_db:true}}]])
    await assert.rejects(readOnlyQueries("synthetic-token",SPECS.client,queries,async()=>response(invalid)));
  await assert.rejects(readOnlyQueries("synthetic-token",SPECS.client,["DELETE FROM x"],request));
  await assert.rejects(readOnlyQueries("synthetic-token",SPECS.client,[...queries,"SELECT 1"],request));
  assert.equal(calls.length,1);
});
test("preflight is read-only and Operations refuses an unverified Client ledger",async()=>{
  const client=buildPairedMigrationPlan("client",root),ops=buildPairedMigrationPlan("operations",root),calls=[];
  const states=new Map([[client.spec.database,{ledger:client.priorNames.map(name=>({name})),foreignKeys:[],schema:[],data:{}}],[ops.spec.database,{ledger:ops.priorNames.map(name=>({name})),foreignKeys:[],schema:[],data:{}}]]);
  const dependencies={credential:()=>"private",remoteState:async(_token,plan)=>{calls.push(plan.spec.application);return states.get(plan.spec.database);},wrangler:()=>assert.fail("preflight mutated")};
  assert.deepEqual((await runPairedMigration(["client","preflight"],dependencies)).mutationsPerformed,false);
  await assert.rejects(runPairedMigration(["operations","preflight"],dependencies),/Client 0149/u);assert.deepEqual(calls,["client","client"]);
});
test("apply boundary requires a fresh identical snapshot and no prior attempt",()=>{
  const plan=buildPairedMigrationPlan("client",root),now=Date.parse("2026-10-11T12:00:00.000Z");
  const current={ledger:[{name:"x"}],foreignKeys:[],schema:[],data:{}},saved={createdAt:"2026-10-11T11:45:00.000Z",snapshot:current};
  assert.doesNotThrow(()=>assertApplyReady(current,saved,false,now));
  assert.throws(()=>assertApplyReady(current,saved,true,now),/reconcile only/u);
  assert.throws(()=>assertApplyReady({...current,data:{changed:[]}},saved,false,now),/moved/u);
  assert.throws(()=>assertApplyReady(current,{...saved,createdAt:"2026-10-11T11:29:59.000Z"},false,now),/fresh backup/u);
  assert.throws(()=>assertApplyReady(current,{...saved,createdAt:"invalid"},false,now),/fresh backup/u);
  const marker={application:"client",database:plan.spec.database,from:147,to:149,migrations:plan.migrations,attemptedAt:"2026-10-11T11:50:00.000Z",retryAllowed:false};
  assert.doesNotThrow(()=>assertAttemptMarker(marker,plan));
  assert.throws(()=>assertAttemptMarker({...marker,retryAllowed:true},plan));
  assert.throws(()=>assertAttemptMarker({...marker,extra:true},plan));
});
test("artifact-set labels namespace recoverable artifacts while sharing the default-compatible attempt sentinel",()=>{
  const defaultPlan=buildPairedMigrationPlan("client",root),labeled=buildPairedMigrationPlan("client",root,"successor01");
  assert.equal(defaultPlan.artifactSet,null);assert.match(defaultPlan.backup,/native-portal-before-149\.sql$/u);
  assert.match(defaultPlan.evidence,/native-portal-before-149\.json$/u);assert.match(defaultPlan.config,/native-portal-147-149-config\.json$/u);
  assert.match(defaultPlan.directory,/native-portal-147-149-migrations$/u);assert.match(defaultPlan.marker,/native-portal-147-149-apply-attempt\.json$/u);
  for(const file of[labeled.directory,labeled.config,labeled.backup,labeled.evidence]){
    assert(file.startsWith(path.join(root,"apps","client")));assert(file.includes("successor01"));
  }
  assert.equal(labeled.marker,defaultPlan.marker);
  assert.equal(labeled.artifactSet,"successor01");
});
test("artifact-set labels are path confined strict safe ASCII",()=>{
  for(const label of[null,{},[],42,"","../escape","a/b","a\\b",".hidden","space value","é","a".repeat(65)])
    assert.throws(()=>buildPairedMigrationPlan("client",root,label),/safe ASCII/u);
  for(const label of["a","A_1","successor-20261011","x".repeat(64)])
    assert.doesNotThrow(()=>buildPairedMigrationPlan("client",root,label));
});
test("labeled modes share one migration-window attempt sentinel across labels",async()=>{
  const plan=buildPairedMigrationPlan("client",root,"successor01"),state={ledger:plan.priorNames.map(name=>({name})),foreignKeys:[],schema:[],data:{}},seen=[];
  const dependencies={credential:()=>"private",remoteState:async(_token,value)=>{seen.push(value);return state;},wrangler:()=>assert.fail("preflight mutated")};
  const result=await runPairedMigration(["client","preflight","successor01"],dependencies);assert.equal(result.mutationsPerformed,false);
  assert.equal(seen[0].artifactSet,"successor01");assert.equal(seen[0].backup,plan.backup);
  assert.equal(plan.marker,buildPairedMigrationPlan("client",root,"other-set").marker);
  const saved={createdAt:"2026-10-11T11:45:00.000Z",snapshot:state},now=Date.parse("2026-10-11T12:00:00.000Z");
  assert.doesNotThrow(()=>assertApplyReady(state,saved,false,now),"no sentinel permits the first labeled attempt");
  assert.throws(()=>assertApplyReady(state,saved,true,now),/reconcile only/u,"a sentinel from any label blocks every other label");
  const marker={application:"client",database:plan.spec.database,from:147,to:149,artifactSet:"successor01",migrations:plan.migrations,attemptedAt:"2026-10-11T12:00:00.000Z",retryAllowed:false};
  assert.doesNotThrow(()=>assertAttemptMarker(marker,plan));assert.throws(()=>assertAttemptMarker({...marker,artifactSet:"other"},plan));
});
test("stage diagnostics are allowlisted and never disclose raw errors, tokens, or snapshots",()=>{
  const secret="cfat_PRIVATE_ROW_SENTINEL",staged=Error(secret);staged.stage="provider-export";
  assert.deepEqual(JSON.parse(safeFailure(staged)),{error:"staging migration boundary rejected; inspect private local evidence",stage:"provider-export",retryAllowed:false});
  const unknown=Error(secret);unknown.stage=secret;const output=safeFailure(unknown);
  assert.deepEqual(JSON.parse(output),{error:"staging migration boundary rejected; inspect private local evidence",retryAllowed:false});assert(!output.includes(secret));
  const attributable=Error(secret);attributable.stage="provider-export";attributable.outcomeCode="exit-nonzero";
  assert.deepEqual(JSON.parse(safeFailure(attributable)),{error:"staging migration boundary rejected; inspect private local evidence",stage:"provider-export",outcomeCode:"exit-nonzero",retryAllowed:false});
  attributable.outcomeCode=secret;assert(!safeFailure(attributable).includes(secret));
});
test("Wrangler command dependency must exactly match the selected application lockfile",()=>{
  const lockfile={packages:{"node_modules/wrangler":{version:"4.118.0"}}};
  assert.equal(assertPinnedWranglerVersion(lockfile,{name:"wrangler",version:"4.118.0"}),"4.118.0");
  assert.throws(()=>assertPinnedWranglerVersion(lockfile,{name:"wrangler",version:"4.149.0"}),/differs/u);
  assert.throws(()=>assertPinnedWranglerVersion(lockfile,{name:"other",version:"4.118.0"}),/identity/u);
  assert.throws(()=>assertPinnedWranglerVersion({}, {name:"wrangler",version:"4.118.0"}),/lockfile pin/u);
  const mismatch=Error("private dependency details");mismatch.stage="provider-export";mismatch.outcomeCode="dependency-mismatch";
  assert.deepEqual(JSON.parse(safeFailure(mismatch)),{error:"staging migration boundary rejected; inspect private local evidence",stage:"provider-export",outcomeCode:"dependency-mismatch",retryAllowed:false});
});


test("paired current source inventory rejects uppercase, noncanonical and nonregular SQL",()=>{
  for(const application of ["client","operations"]){
    const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"paired-inventory-"));
    try{
      const destination=path.join(temporary,`apps/${application}/migrations`);
      fs.cpSync(path.join(root,`apps/${application}/migrations`),destination,{recursive:true});
      for(const name of ["unreviewed.SQL","9999_unreviewed.SQL","unreviewed.sql"]){
        const file=path.join(destination,name);
        fs.writeFileSync(file,"SELECT 1;\n",{flag:"wx"});
        assert.throws(()=>buildPairedMigrationPlan(application,temporary),/canonical migration names/);
        fs.unlinkSync(file);
      }
      const directory=path.join(destination,"9999_directory.sql");
      fs.mkdirSync(directory);
      assert.throws(()=>buildPairedMigrationPlan(application,temporary),/migration chain must contain regular files/);
      fs.rmdirSync(directory);
      assert.doesNotThrow(()=>buildPairedMigrationPlan(application,temporary));
    }finally{
      assert(path.dirname(temporary)===path.resolve(os.tmpdir())&&path.basename(temporary).startsWith("paired-inventory-"));
      fs.rmSync(temporary,{recursive:true,force:true});
    }
  }
});

test("paired current source inventory rejects a migration directory junction",()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"paired-directory-"));
  try{
    const parent=path.join(temporary,"apps/operations"), actual=path.join(temporary,"actual-migrations");
    fs.mkdirSync(parent,{recursive:true});
    fs.cpSync(path.join(root,"apps/operations/migrations"),actual,{recursive:true});
    fs.symlinkSync(actual,path.join(parent,"migrations"),process.platform==="win32"?"junction":"dir");
    assert.throws(()=>buildPairedMigrationPlan("operations",temporary),/regular migration directory/);
  }finally{
    assert(path.dirname(temporary)===path.resolve(os.tmpdir())&&path.basename(temporary).startsWith("paired-directory-"));
    fs.rmSync(temporary,{recursive:true,force:true});
  }
});
