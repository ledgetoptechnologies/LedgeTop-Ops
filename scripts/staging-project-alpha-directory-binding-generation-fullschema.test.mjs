import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {createRequire} from "node:module";

import {migrateProjectOrganizationFullSchema as migrate} from "./staging-project-organization-fullschema-migrations.mjs";

const root=path.resolve(import.meta.dirname,".."),requireOperations=createRequire(path.join(root,"apps/operations/package.json"));
const {Miniflare}=requireOperations("miniflare"),{unstable_splitSqlQuery}=requireOperations("wrangler"),{build}=requireOperations("esbuild");
const identity={sourceId:"project-alpha:staging",sourceInstanceId:"10000000-0000-4000-8000-000000000001",applicationId:"20000000-0000-4000-8000-000000000002",historyEpoch:"30000000-0000-4000-8000-000000000003"};
const publicId="a".repeat(32),projection="b".repeat(64),externalId="pa/client/acquired";
async function loadPersist(){const built=await build({entryPoints:[path.join(root,"apps/operations/src/worker/project-alpha-v2-sync.ts")],bundle:true,platform:"node",format:"esm",write:false,target:"node22"});return(await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`)).persistProjectAlphaDirectoryInventoryPage}
const page=(generation,bindingRevision,requestId=crypto.randomUUID(),projectionSha256=projection)=>({...identity,requestId,authorizationGeneration:generation,nextCursor:null,resources:[{type:"client",publicId,revision:"2",present:true,lastAction:"upsert",projectionSha256,binding:{externalId,status:"active",resourceRevision:bindingRevision}}]});
const first=(db,sql,...params)=>db.prepare(sql).bind(...params).first();
const splitMigration=name=>unstable_splitSqlQuery(fs.readFileSync(path.join(root,"apps/operations/migrations",name),"utf8"));
async function applyMigration(db,name){await db.batch(splitMigration(name).map(statement=>db.prepare(statement)))}
async function receipt(db,source,request,generation){await db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,authorization_generation,page_sha256,item_count) VALUES(?,?,?,?,'directory',?,?,?,1)`).bind(source,identity.sourceInstanceId,identity.applicationId,identity.historyEpoch,request,generation,request.replaceAll("-","").padEnd(64,"0").slice(0,64)).run()}
async function observation(db,source,request,id,bindingRevision,hash=projection,external=externalId){await db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256,binding_external_id,binding_status,binding_resource_revision) VALUES(?,?,?,?,?,'client',?,'2',1,'upsert',?,?,'active',?)`).bind(source,identity.sourceInstanceId,identity.applicationId,identity.historyEpoch,request,id,hash,external,bindingRevision).run()}
async function conflictCount(db,source){return(await first(db,"SELECT count(*) n FROM project_alpha_api_v2_inventory_conflicts WHERE source_id=? AND conflict_kind='revision_reuse_mismatch'",source)).n}

test("actual 0001-0185 persistence accepts only binding-only advances into a newer authorization era",{timeout:240000},async()=>{
 const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DB:`binding-generation-fullschema-${crypto.randomUUID()}`}});
 try{
  const db=await mf.getD1Database("DB");await migrate(db,"0184");const persist=await loadPersist();
  assert.equal((await persist(db,page("55","1"),null)).status,"persisted");
  assert.equal((await persist(db,page("58","2"),null)).status,"conflicted");
  assert.equal((await first(db,"SELECT count(*) n FROM project_alpha_api_v2_inventory_conflicts WHERE conflict_kind='revision_reuse_mismatch'")).n,1);
  await applyMigration(db,"0185_project_alpha_directory_binding_generation_epochs.sql");
  assert.equal((await first(db,"SELECT has_conflict FROM project_alpha_api_v2_directory_observations_current WHERE source_id=?",identity.sourceId)).has_conflict,0);
  assert.equal((await persist(db,page("59","3"),null)).status,"persisted");
  assert.equal((await persist(db,page("59","4"),null)).status,"conflicted");
  assert.equal((await persist(db,page("60","3",crypto.randomUUID(),"c".repeat(64)),null)).status,"conflicted");
  assert.equal((await first(db,"SELECT count(*) n FROM d1_migrations WHERE name LIKE '0185_%'")).n,0);
 }finally{await mf.dispose()}
});

test("actual 0001-0184 persistence retains legacy evidence and 0186 discounts only exact binding-only conflicts",{timeout:240000},async()=>{
 const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DB:`binding-evidence-fullschema-${crypto.randomUUID()}`}});
 try{
  const db=await mf.getD1Database("DB");await migrate(db,"0184");
  const validSource="project-alpha:full-valid",validId="e".repeat(32),validPrior="81000000-0000-4000-8000-000000000001",validCurrent="82000000-0000-4000-8000-000000000002";
  await receipt(db,validSource,validPrior,"55");await observation(db,validSource,validPrior,validId,"1");
  await receipt(db,validSource,validCurrent,"58");await observation(db,validSource,validCurrent,validId,"2");
  assert.equal(await conflictCount(db,validSource),1);
  const legacy=await first(db,"SELECT * FROM project_alpha_api_v2_inventory_conflicts WHERE source_id=?",validSource);

  await applyMigration(db,"0185_project_alpha_directory_binding_generation_epochs.sql");
  await applyMigration(db,"0186_project_alpha_directory_conflict_evidence_binding.sql");
  assert.deepEqual(await first(db,"SELECT * FROM project_alpha_api_v2_inventory_conflicts WHERE source_id=?",validSource),legacy);
  assert.equal((await first(db,"SELECT has_conflict FROM project_alpha_api_v2_directory_observations_current WHERE source_id=?",validSource)).has_conflict,0);

  const newer="83000000-0000-4000-8000-000000000003";
  await receipt(db,validSource,newer,"59");await observation(db,validSource,newer,validId,"3");
  assert.equal(await conflictCount(db,validSource),1,"strictly newer binding-only delta must not add a conflict");

  const cases=[
   {source:"project-alpha:full-forged-external",id:"f".repeat(32),prior:"84000000-0000-4000-8000-000000000004",current:"85000000-0000-4000-8000-000000000005",external:"forged/external",details:JSON.stringify({observedProjectionSha256:projection,priorProjectionSha256:projection})},
   {source:"project-alpha:full-forged-hash",id:"0".repeat(32),prior:"86000000-0000-4000-8000-000000000006",current:"87000000-0000-4000-8000-000000000007",external:externalId,details:JSON.stringify({observedProjectionSha256:"c".repeat(64),priorProjectionSha256:projection})},
  ];
  for(const item of cases){
   await receipt(db,item.source,item.prior,"55");await observation(db,item.source,item.prior,item.id,"1");
   await receipt(db,item.source,item.current,"58");await observation(db,item.source,item.current,item.id,"2");
   assert.equal(await conflictCount(db,item.source),0);
   await db.prepare(`INSERT INTO project_alpha_api_v2_inventory_conflicts(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,observed_revision,details_json) VALUES(?,?,?,?, 'directory','client',?,?,?,?, 'revision_reuse_mismatch','2',?)`).bind(item.source,identity.sourceInstanceId,identity.applicationId,identity.historyEpoch,item.id,item.external,item.current,item.prior,item.details).run();
   assert.equal((await first(db,"SELECT has_conflict FROM project_alpha_api_v2_directory_observations_current WHERE source_id=?",item.source)).has_conflict,1);
  }

  for(const item of[
   {source:"project-alpha:full-same-generation",id:"1".repeat(32),prior:"88000000-0000-4000-8000-000000000008",current:"89000000-0000-4000-8000-000000000009",priorGeneration:"55",currentGeneration:"55",hash:projection},
   {source:"project-alpha:full-content-change",id:"2".repeat(32),prior:"90000000-0000-4000-8000-000000000010",current:"91000000-0000-4000-8000-000000000011",priorGeneration:"55",currentGeneration:"58",hash:"d".repeat(64)},
  ]){
   await receipt(db,item.source,item.prior,item.priorGeneration);await observation(db,item.source,item.prior,item.id,"1");
   await receipt(db,item.source,item.current,item.currentGeneration);await observation(db,item.source,item.current,item.id,"2",item.hash);
   assert.equal(await conflictCount(db,item.source),1);
   assert.equal((await first(db,"SELECT has_conflict FROM project_alpha_api_v2_directory_observations_current WHERE source_id=?",item.source)).has_conflict,1);
  }
 }finally{await mf.dispose()}
});
