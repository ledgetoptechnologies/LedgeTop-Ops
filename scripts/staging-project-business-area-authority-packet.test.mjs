import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";
import { PURPOSE,PINNED_OPERATOR,PINNED_BUSINESS_AREA,compileBusinessAreaAuthorityPair,applyBusinessAreaAuthorityPhase } from "./staging-project-business-area-authority-packet.mjs";
const root=path.resolve(import.meta.dirname,"..");
const requireOperations=createRequire(path.join(root,"apps/operations/package.json"));
const {Miniflare}=requireOperations("miniflare");
const {unstable_splitSqlQuery}=requireOperations("wrangler");
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const fixture=()=>({schemaVersion:1,purpose:PURPOSE,staging:{...STAGING_TARGET},admission:{staff_id:PINNED_OPERATOR.staffId,bound_access_subject:PINNED_OPERATOR.accessSubject,active:1,version:2},profile:{staff_id:PINNED_OPERATOR.staffId,login_email:PINNED_OPERATOR.email,display_name:PINNED_OPERATOR.displayName,version:3},businessArea:{...PINNED_BUSINESS_AREA,active:1},generation:{staff_id:PINNED_OPERATOR.staffId,generation:4},grants:[],approval:{approvalId:id(1),commandId:id(2),revokeApprovalId:id(3),revokeCommandId:id(4),grantId:id(5),issuedAt:"2026-10-08T20:00:00.000Z",expiresAt:"2026-10-08T21:00:00.000Z",provisionExecutedAt:"2026-10-08T20:01:00.000Z",revokeExecutedAt:"2026-10-08T20:30:00.000Z",changeTicket:"staging-window-20261008",reviewer:"reviewed-operator"}});
test("business-area packet rejects missing, extra, renamed, or modified 0183 migration",()=>{
 const migrationName="0183_project_alpha_binding_standalone_relationship_rows.sql";
 const cases=[
  ["missing",directory=>fs.rmSync(path.join(directory,migrationName))],
  ["extra",directory=>fs.writeFileSync(path.join(directory,"0184_unreviewed.sql"),"SELECT 1;\n")],
  ["renamed",directory=>fs.renameSync(path.join(directory,migrationName),path.join(directory,"0183_wrong_name.sql"))],
  ["modified",directory=>fs.appendFileSync(path.join(directory,migrationName),"-- drift\n")],
 ];
 for(const [label,mutate] of cases){
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),"business-area-authority-chain-"));
  try{
   const directory=path.join(temporary,"apps","operations","migrations");
   fs.mkdirSync(path.dirname(directory),{recursive:true});
   fs.cpSync(path.join(root,"apps","operations","migrations"),directory,{recursive:true});
   mutate(directory);
   assert.throws(()=>compileBusinessAreaAuthorityPair(fixture(),{root:temporary}),/exact reviewed migration chain required/,label);
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
 }
});
test("compiles immutable paired statements for trusted module-only apply",()=>{const pair=compileBusinessAreaAuthorityPair(fixture());assert.equal(pair.trustedApplyOnly,true);assert.equal(pair.provision.approval.canonical_plan_sha256,pair.planHash);assert.equal(pair.revoke.approval.canonical_plan_sha256,pair.planHash);assert.ok(pair.revoke.statements.some(s=>/changes\(\)=1/.test(s.sql)));assert.ok(pair.revoke.statements.some(s=>/revoke-poststate/.test(s.sql)));assert.ok(pair.provision.statements.every(s=>Array.isArray(s.params)&&!s.sql.includes("BEGIN")));});
test("canonical plan binds the complete reviewed window",()=>{const base=compileBusinessAreaAuthorityPair(fixture());for(const mutate of [v=>v.approval.expiresAt="2026-10-08T20:59:00.000Z",v=>v.approval.changeTicket="different-ticket",v=>v.approval.reviewer="different-reviewer"]){const changed=fixture();mutate(changed);assert.notEqual(compileBusinessAreaAuthorityPair(changed).planHash,base.planHash);}});
test("rejects wrong target, actor, area, malformed scope, and reversed pair",()=>{const wrong=fixture();wrong.staging={...wrong.staging,environment:"production"};assert.throws(()=>compileBusinessAreaAuthorityPair(wrong),/staging contract/);for(const mutate of [v=>v.admission.staff_id="staff-other",v=>v.admission.bound_access_subject="other-subject",v=>v.profile.login_email="other@example.test",v=>v.businessArea.id="staging-native-only-other"]){const value=fixture();mutate(value);assert.throws(()=>compileBusinessAreaAuthorityPair(value),/exact pinned operator and synthetic area required/);}const malformed=fixture();malformed.grants=[{id:"existing",staff_id:malformed.admission.staff_id,capability:"project.shared.sync",effect:"allow",scope_kind:"business_area",business_area_id:null,division_id:null,external_project_id:null,active:1,version:1,granted_by:malformed.admission.staff_id,created_at:"2026-10-08T19:00:00.000Z"}];assert.throws(()=>compileBusinessAreaAuthorityPair(malformed),/scope tuple/);const reversed=fixture();reversed.approval.revokeExecutedAt="2026-10-08T20:00:30.000Z";assert.throws(()=>compileBusinessAreaAuthorityPair(reversed),/bounded paired window/);});
test("late recovery revoke remains compilable without an expiry guard",()=>{const late=fixture();late.approval.revokeExecutedAt="2026-10-09T20:30:00.000Z";const pair=compileBusinessAreaAuthorityPair(late);assert.ok(pair.provision.statements.some(s=>/expiry-guard-failed/.test(s.sql)));assert.ok(pair.revoke.statements.every(s=>!/expiry-guard-failed/.test(s.sql)));assert.equal(pair.revoke.receipt.executed_at,late.approval.revokeExecutedAt);});
test("stale planned timestamps remain canonical evidence but are never persisted as execution time",()=>{const value=fixture(),pair=compileBusinessAreaAuthorityPair(value);for(const phase of [pair.provision,pair.revoke]){const receipt=phase.statements.at(-1);assert.match(receipt.sql,/executed_at\) VALUES\(.+strftime\('%Y-%m-%dT%H:%M:%fZ','now'\)\)$/);assert.ok(!receipt.params.includes(phase.receipt.executed_at));}assert.ok(pair.revoke.statements.some(statement=>/revoked_at=strftime\('%Y-%m-%dT%H:%M:%fZ','now'\)/.test(statement.sql)));});
test("rejects prototype-bearing input before cloning, including nested grants",()=>{class Packet{}const root=Object.assign(new Packet(),fixture());assert.throws(()=>compileBusinessAreaAuthorityPair(root),/input plain object required/);const nested=fixture();nested.grants=[Object.assign(Object.create({inherited:true}),{id:"existing",staff_id:nested.admission.staff_id,capability:"project.shared.sync",effect:"allow",scope_kind:"global",business_area_id:null,division_id:null,external_project_id:null,active:1,version:1,granted_by:nested.admission.staff_id,created_at:"2026-10-08T19:00:00.000Z"})];assert.throws(()=>compileBusinessAreaAuthorityPair(nested),/input\.grants\[0\] plain object required/);});
test("trusted apply rejects target drift and altered compiled artifacts before D1",async()=>{const pair=compileBusinessAreaAuthorityPair(fixture()),db={prepare(){throw new Error("D1 must not be reached");}};await assert.rejects(applyBusinessAreaAuthorityPhase(db,pair,"provision",{target:{...STAGING_TARGET,databaseId:"production"}}),/trusted staging binding context required/);const altered=structuredClone(pair);altered.provision.statements.pop();await assert.rejects(applyBusinessAreaAuthorityPhase(db,altered,"provision",{target:STAGING_TARGET}),/compiled pair altered/);});
test("revoke replay rejects malformed prior execution and revocation timestamps",async()=>{const pair=compileBusinessAreaAuthorityPair(fixture()),receipt={...pair.revoke.receipt,executed_at:"2026-10-09T20:31:00.000Z"};let reads=0;const db={prepare(){return{bind(){return{async first(){return reads++===0?receipt:{provision_executed_at:"not-a-time",revoked_at:"2026-10-09T20:30:00.000Z"};}};}};}};await assert.rejects(applyBusinessAreaAuthorityPhase(db,pair,"revoke",{target:STAGING_TARGET}),/replay receipt chronology/);});

const first=(db,sql,...params)=>db.prepare(sql).bind(...params).first();
const applyStatements=(db,statements)=>db.batch(statements.map(statement=>db.prepare(statement.sql).bind(...statement.params)));
async function migratedDatabase(){
 const mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DB:`${id(900)}-${crypto.randomUUID()}`},d1Persist:false});
 const db=await mf.getD1Database("DB"),dir=path.join(root,"apps","operations","migrations");
 await db.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
 for(const name of fs.readdirSync(dir).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort()){
  const sql=fs.readFileSync(path.join(dir,name),"utf8").replace(/\r\n/g,"\n");
  const parts=unstable_splitSqlQuery(sql).map(part=>part.trim()).filter(part=>part&&!/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?$/i.test(part));
  await db.batch([...parts.map(part=>db.prepare(part)),db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
 }
 return {mf,db};
}
async function liveFixture(db,{lateRevoke=false}={}){
 const value=fixture(),staff=value.admission.staff_id,area=value.businessArea.id;
 await db.prepare("UPDATE staff_users SET email='initial-beau-local-fixture@example.test' WHERE email=? AND id<>?").bind(value.profile.login_email,staff).run();
 await db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,access_subject=excluded.access_subject").bind(staff,value.profile.login_email,value.profile.display_name,value.admission.bound_access_subject).run();
 await db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(staff,value.admission.bound_access_subject,staff).run();
 await db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(staff,value.profile.login_email,value.profile.display_name).run();
 await db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES(?,?,1)").bind(area,value.businessArea.name).run();
 await db.prepare("INSERT INTO native_project_grant_generations(staff_id,generation) VALUES(?,0)").bind(staff).run();
 const admission=await first(db,"SELECT staff_id,bound_access_subject,active,version FROM native_staff_admissions WHERE staff_id=?",staff);
 const profile=await first(db,"SELECT staff_id,login_email,display_name,version FROM native_staff_profiles WHERE staff_id=?",staff);
 const generation=await first(db,"SELECT staff_id,generation FROM native_project_grant_generations WHERE staff_id=?",staff);
 const now=Date.now(),issued=new Date(now-60_000).toISOString(),expires=new Date(now+(lateRevoke?5_000:3_600_000)).toISOString();
 return {...value,admission,profile,generation,approval:{...value.approval,issuedAt:issued,expiresAt:expires,provisionExecutedAt:new Date(now-1_000).toISOString(),revokeExecutedAt:new Date(now+(lateRevoke?6_000:1_000)).toISOString()}};
}

test("full D1 chain applies each phase atomically, rejects replay, and rolls back failed guards",async()=>{
 const {mf,db}=await migratedDatabase();
 try{
  const input=await liveFixture(db,{lateRevoke:true}),pair=compileBusinessAreaAuthorityPair(input),staff=input.admission.staff_id;
  const poison={sql:"SELECT json('deliberate-rollback-after-mutation')",params:[]};
  await assert.rejects(applyStatements(db,[...pair.provision.statements,poison]));
  assert.equal((await first(db,"SELECT count(*) count FROM native_project_grants WHERE id=?",input.approval.grantId)).count,0);
  assert.deepEqual(await first(db,"SELECT generation FROM native_project_grant_generations WHERE staff_id=?",staff),{generation:0});
  assert.equal((await first(db,"SELECT count(*) count FROM native_staff_bootstrap_approvals WHERE approval_id=?",input.approval.approvalId)).count,0);
  assert.equal((await first(db,"SELECT count(*) count FROM native_staff_bootstrap_receipts WHERE command_id=?",input.approval.commandId)).count,0);
  const provisionBefore=Date.now();
  assert.deepEqual(await applyBusinessAreaAuthorityPhase(db,pair,"provision",{target:STAGING_TARGET}),{replayed:false,phase:"provision"});
  const provisionAfter=Date.now(),provisionReceipt=await first(db,"SELECT executed_at FROM native_staff_bootstrap_receipts WHERE command_id=?",input.approval.commandId);
  assert.ok(Date.parse(provisionReceipt.executed_at)>=provisionBefore-1_000&&Date.parse(provisionReceipt.executed_at)<=provisionAfter+1_000);
  assert.notEqual(provisionReceipt.executed_at,input.approval.provisionExecutedAt);
  assert.deepEqual(await first(db,"SELECT active,version FROM native_project_grants WHERE id=?",input.approval.grantId),{active:1,version:1});
  assert.deepEqual(await first(db,"SELECT generation FROM native_project_grant_generations WHERE staff_id=?",staff),{generation:1});
  assert.deepEqual(await applyBusinessAreaAuthorityPhase(db,pair,"provision",{target:STAGING_TARGET}),{replayed:true,phase:"provision"});
  assert.equal((await first(db,"SELECT count(*) count FROM native_project_grants WHERE id=?",input.approval.grantId)).count,1);
  assert.equal((await first(db,"SELECT count(*) count FROM native_staff_bootstrap_receipts WHERE command_id=?",input.approval.commandId)).count,1);
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(input.approval.expiresAt)-Date.now()+100)));
  assert.ok(Date.now()>Date.parse(input.approval.expiresAt));
  await assert.rejects(applyStatements(db,[...pair.revoke.statements,poison]));
  assert.deepEqual(await first(db,"SELECT active,version FROM native_project_grants WHERE id=?",input.approval.grantId),{active:1,version:1});
  assert.deepEqual(await first(db,"SELECT generation FROM native_project_grant_generations WHERE staff_id=?",staff),{generation:1});
  assert.deepEqual(await first(db,"SELECT revoked_at FROM native_staff_bootstrap_approvals WHERE approval_id=?",input.approval.approvalId),{revoked_at:null});
  assert.equal((await first(db,"SELECT count(*) count FROM native_staff_bootstrap_approvals WHERE approval_id=?",input.approval.revokeApprovalId)).count,0);
  assert.equal((await first(db,"SELECT count(*) count FROM native_staff_bootstrap_receipts WHERE command_id=?",input.approval.revokeCommandId)).count,0);
  const revokeBefore=Date.now();
  assert.deepEqual(await applyBusinessAreaAuthorityPhase(db,pair,"revoke",{target:STAGING_TARGET}),{replayed:false,phase:"revoke"});
  const revokeAfter=Date.now(),revokeAudit=await first(db,`SELECT receipt.executed_at,approval.revoked_at FROM native_staff_bootstrap_receipts receipt
    JOIN native_staff_bootstrap_approvals approval ON approval.approval_id=? WHERE receipt.command_id=?`,input.approval.approvalId,input.approval.revokeCommandId);
  assert.ok(Date.parse(revokeAudit.executed_at)>=revokeBefore-1_000&&Date.parse(revokeAudit.executed_at)<=revokeAfter+1_000);
  assert.ok(Date.parse(revokeAudit.revoked_at)>=revokeBefore-1_000&&Date.parse(revokeAudit.revoked_at)<=Date.parse(revokeAudit.executed_at));
  assert.ok(Date.parse(revokeAudit.executed_at)>=Date.parse(provisionReceipt.executed_at));
  assert.notEqual(revokeAudit.executed_at,input.approval.revokeExecutedAt);
  assert.deepEqual(await first(db,"SELECT active,version FROM native_project_grants WHERE id=?",input.approval.grantId),{active:0,version:2});
  assert.deepEqual(await first(db,"SELECT generation FROM native_project_grant_generations WHERE staff_id=?",staff),{generation:2});
  assert.deepEqual(await applyBusinessAreaAuthorityPhase(db,pair,"revoke",{target:STAGING_TARGET}),{replayed:true,phase:"revoke"});
  assert.equal((await first(db,"SELECT count(*) count FROM native_staff_bootstrap_receipts WHERE command_id=?",input.approval.revokeCommandId)).count,1);
  const conflicting=compileBusinessAreaAuthorityPair({...input,approval:{...input.approval,approvalId:id(11),commandId:id(12),revokeApprovalId:id(13),revokeCommandId:id(14),grantId:id(15)}});
  await assert.rejects(applyStatements(db,conflicting.provision.statements));
  assert.equal((await first(db,"SELECT count(*) count FROM native_project_grants WHERE id=?",id(15))).count,0);
 }finally{await mf.dispose();}
});
