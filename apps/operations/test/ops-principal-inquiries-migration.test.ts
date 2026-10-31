import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { reviewedOperationsMigrationNames } from "./helpers/reviewed-operations-migration-chain";
import { listOpsPrincipalInquiries, submitOpsPrincipalInquiry } from "../src/worker/operations-native-principal-inquiries";
import { listStaffInboxInquiries, registerStaffInboxRequestRoutes } from "../src/worker/staff-inbox-requests";
import { Hono } from "hono";
import type { Env, StaffPrincipal } from "../src/worker/types";

let mf:Miniflare,db:D1Database,delivery:D1Database;
beforeAll(async()=>{
 mf=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {fetch(){return new Response('ok')}}",d1Databases:{OPS_DB:"ops-principal-inquiry-migration",DELIVERY_DB:"ops-principal-inquiry-delivery"}});
 db=await mf.getD1Database("OPS_DB") as unknown as D1Database;
 delivery=await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
 await db.exec(`CREATE TABLE client_onboarding_recipient_identity_bindings(binding_id TEXT PRIMARY KEY);
 CREATE TABLE operations_portal_workspace_reservation_heads(target_id TEXT PRIMARY KEY);
 CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY);
 CREATE TABLE operations_portal_native_authority_commands(operation_id TEXT PRIMARY KEY,request_fingerprint TEXT,action TEXT,permissions_json TEXT,target_id TEXT,recipient_binding_id TEXT,enrollment_intent_id TEXT,target_client_record_id TEXT,issuer TEXT,subject TEXT);
 CREATE TABLE operations_portal_native_authority_receipts(operation_id TEXT PRIMARY KEY,ownership_epoch INTEGER,grant_revision INTEGER,state TEXT,request_fingerprint TEXT);
 CREATE TABLE operations_portal_native_recipient_authority_heads(recipient_binding_id TEXT,target_id TEXT,latest_operation_id TEXT,ownership_epoch INTEGER,grant_revision INTEGER,state TEXT,expires_at TEXT);
 CREATE TABLE operations_portal_native_workspace_authority_heads(target_id TEXT,ownership_epoch INTEGER,state TEXT,root_kind TEXT,root_record_id TEXT);
 CREATE TABLE operations_portal_native_inquiry_capability_heads(intent_id TEXT,target_id TEXT,recipient_binding_id TEXT,state TEXT,latest_operation_id TEXT,revision INTEGER);
 CREATE TABLE operations_portal_native_inquiry_capability_commands(operation_id TEXT PRIMARY KEY,intent_id TEXT,action TEXT,resulting_revision INTEGER,target_id TEXT,target_revision INTEGER,client_authority_id TEXT,workspace_id TEXT,target_client_record_id TEXT,recipient_binding_id TEXT,issuer TEXT,subject TEXT,base_operation_id TEXT,base_ownership_epoch INTEGER,base_grant_revision INTEGER,permission TEXT,publication_operation_id TEXT,publication_revision INTEGER,publication_source_sequence INTEGER,publication_snapshot_id TEXT,publication_snapshot_sha256 TEXT,expires_at TEXT,request_fingerprint TEXT);
 CREATE TABLE operations_portal_native_inquiry_capability_receipts(operation_id TEXT,request_fingerprint TEXT,state TEXT);
 CREATE TABLE operations_portal_native_inquiry_capability_closures(operation_id TEXT,request_fingerprint TEXT,client_receipt_fingerprint TEXT,resulting_state TEXT,operations_receipt_fingerprint TEXT);
 CREATE TABLE operations_portal_workspace_publication_commands(operation_id TEXT PRIMARY KEY);
 CREATE TABLE operations_portal_workspace_publication_heads(target_id TEXT,target_revision INTEGER,client_authority_id TEXT,workspace_id TEXT,latest_operation_id TEXT,revision INTEGER,source_sequence INTEGER,snapshot_id TEXT,snapshot_sha256 TEXT);
 CREATE TABLE operations_portal_workspace_publication_snapshots(snapshot_id TEXT PRIMARY KEY,operation_id TEXT,snapshot_sha256 TEXT,snapshot_json TEXT);
 CREATE TABLE audit_log(actor_type TEXT,actor_id TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details_json TEXT);
 CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,access_subject TEXT,project_alpha_user_id TEXT,status TEXT);
 CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
 CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
 CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
 CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);
 CREATE TABLE client_ops_triage_inquiries(id TEXT PRIMARY KEY,kind TEXT,title TEXT,details TEXT,location TEXT,status TEXT,created_at TEXT);`);
 await delivery.exec(`CREATE TABLE client_ops_triage_inquiries(id TEXT PRIMARY KEY,kind TEXT,title TEXT,details TEXT,location TEXT,status TEXT,created_at TEXT);`);
 const sql=readFileSync(new URL("../migrations/0235_ops_principal_inquiries.sql",import.meta.url),"utf8");
 for(const statement of splitD1MigrationStatements(sql))await db.prepare(statement).run();
});
afterAll(async()=>mf?.dispose());
describe("Operations principal inquiry migration",()=>{
 it("admits the exact successor without changing the frozen source chain",()=>{
  expect(reviewedOperationsMigrationNames(new URL("../migrations/",import.meta.url))).toHaveLength(199);
 });
 it("executes on SQLite with immutable authority pins, valid status history and FK integrity",async()=>{
  const ids={binding:"10000000-0000-4000-8000-000000000001",target:"10000000-0000-4000-8000-000000000002",
   client:"client-record",base:"10000000-0000-4000-8000-000000000003",cap:"10000000-0000-4000-8000-000000000004",
   pub:"10000000-0000-4000-8000-000000000005",snapshot:"10000000-0000-4000-8000-000000000006",id:"10000000-0000-4000-8000-000000000007"};
  await db.batch([
   db.prepare("INSERT INTO client_onboarding_recipient_identity_bindings VALUES(?)").bind(ids.binding),
   db.prepare("INSERT INTO operations_portal_workspace_reservation_heads VALUES(?)").bind(ids.target),
   db.prepare("INSERT INTO operations_directory_records VALUES(?)").bind(ids.client),
   db.prepare("INSERT INTO operations_portal_native_authority_commands(operation_id) VALUES(?)").bind(ids.base),
   db.prepare("INSERT INTO operations_portal_native_inquiry_capability_commands(operation_id) VALUES(?)").bind(ids.cap),
   db.prepare("INSERT INTO operations_portal_workspace_publication_commands VALUES(?)").bind(ids.pub),
   db.prepare("INSERT INTO operations_portal_workspace_publication_snapshots(snapshot_id) VALUES(?)").bind(ids.snapshot),
  ]);
  await db.prepare(`INSERT INTO operations_native_principal_inquiries(inquiry_id,issuer,subject,authority_set_json,authority_set_sha256,
   idempotency_key,request_fingerprint,kind,title,details,location) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
   .bind(ids.id,"https://identity.example","subject-opaque","[\"proof\"]","b".repeat(64),"inquiry-idempotency-0001","c".repeat(64),"website","Help","Details",null).run();
  await expect(db.prepare("UPDATE operations_native_principal_inquiries SET title='rewritten' WHERE inquiry_id=?").bind(ids.id).run()).rejects.toThrow();
  await expect(db.prepare("UPDATE operations_native_principal_inquiries SET status='closed' WHERE inquiry_id=?").bind(ids.id).run()).rejects.toThrow();
  await db.prepare("UPDATE operations_native_principal_inquiries SET status='under_review' WHERE inquiry_id=?").bind(ids.id).run();
  await expect(db.prepare("DELETE FROM operations_native_principal_inquiries WHERE inquiry_id=?").bind(ids.id).run()).rejects.toThrow();
  await db.prepare(`INSERT INTO operations_native_principal_inquiry_outbox(outbox_id,inquiry_id,event_type,dedupe_key,payload_json)
   VALUES(?,?,'inquiry_submitted',?,json_object('kind','website','title','Help'))`).bind("10000000-0000-4000-8000-000000000009",ids.id,"idempotency:digest").run();
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
 });
 it("accepts only a fully closed current home-plus-create witness and scopes replay/history to the bound principal",async()=>{
  const ids={target:"20000000-0000-4000-8000-000000000001",binding:"20000000-0000-4000-8000-000000000002",base:"20000000-0000-4000-8000-000000000003",
   cap:"20000000-0000-4000-8000-000000000004",pub:"20000000-0000-4000-8000-000000000005",snapshot:"20000000-0000-4000-8000-000000000006",
   authority:"20000000-0000-4000-8000-000000000007",intent:"20000000-0000-4000-8000-000000000008"};
  const expiresAt=new Date(Date.now()+2*60*60_000).toISOString(),hash="c".repeat(64),baseFp="d".repeat(64),capFp="e".repeat(64);
  const snapshot=JSON.stringify({directoryRecords:[{recordId:"client-record-ops",kind:"client",parentRecordId:null}]});
  await db.batch([
   db.prepare("INSERT INTO client_onboarding_recipient_identity_bindings(binding_id) VALUES(?)").bind(ids.binding),
   db.prepare("INSERT INTO operations_portal_workspace_reservation_heads(target_id) VALUES(?)").bind(ids.target),
   db.prepare("INSERT INTO operations_directory_records(record_id) VALUES('client-record-ops')"),
   db.prepare("INSERT INTO operations_portal_native_authority_commands(operation_id,request_fingerprint,action,permissions_json,target_id,recipient_binding_id,enrollment_intent_id,target_client_record_id,issuer,subject) VALUES(?,?,'recipient.grant','[\"operations.service_home.read\"]',?,?,?,?,?,?)")
    .bind(ids.base,baseFp,ids.target,ids.binding,ids.intent,"client-record-ops","issuer","subject"),
   db.prepare("INSERT INTO operations_portal_native_authority_receipts(operation_id,ownership_epoch,grant_revision,state,request_fingerprint) VALUES(?,1,1,'active',?)").bind(ids.base,baseFp),
   db.prepare("INSERT INTO operations_portal_native_recipient_authority_heads(recipient_binding_id,target_id,latest_operation_id,ownership_epoch,grant_revision,state,expires_at) VALUES(?,?,?,1,1,'active',NULL)").bind(ids.binding,ids.target,ids.base),
   db.prepare("INSERT INTO operations_portal_native_workspace_authority_heads(target_id,ownership_epoch,state,root_kind,root_record_id) VALUES(?,1,'active','standalone_client','client-record-ops')").bind(ids.target),
   db.prepare("INSERT INTO operations_portal_workspace_publication_commands(operation_id) VALUES(?)").bind(ids.pub),
   db.prepare("INSERT INTO operations_portal_workspace_publication_snapshots(snapshot_id,operation_id,snapshot_sha256,snapshot_json) VALUES(?,?,?,?)").bind(ids.snapshot,ids.pub,hash,snapshot),
   db.prepare("INSERT INTO operations_portal_workspace_publication_heads(target_id,target_revision,client_authority_id,workspace_id,latest_operation_id,revision,source_sequence,snapshot_id,snapshot_sha256) VALUES(?,1,?,'workspace-ops',?,1,1,?,?)").bind(ids.target,ids.authority,ids.pub,ids.snapshot,hash),
   db.prepare("INSERT INTO operations_portal_native_inquiry_capability_heads(intent_id,target_id,recipient_binding_id,state,latest_operation_id,revision) VALUES(?,?,?,'active',?,1)").bind(ids.intent,ids.target,ids.binding,ids.cap),
   db.prepare(`INSERT INTO operations_portal_native_inquiry_capability_commands(operation_id,intent_id,action,resulting_revision,target_id,target_revision,client_authority_id,workspace_id,target_client_record_id,recipient_binding_id,issuer,subject,base_operation_id,base_ownership_epoch,base_grant_revision,permission,publication_operation_id,publication_revision,publication_source_sequence,publication_snapshot_id,publication_snapshot_sha256,expires_at,request_fingerprint)
    VALUES(?,?,'grant',1,?,1,?,'workspace-ops','client-record-ops',?,'issuer','subject',?,1,1,'operations.request.create',?,1,1,?,?,?,?)`)
    .bind(ids.cap,ids.intent,ids.target,ids.authority,ids.binding,ids.base,ids.pub,ids.snapshot,hash,expiresAt,capFp),
   db.prepare("INSERT INTO operations_portal_native_inquiry_capability_receipts(operation_id,request_fingerprint,state) VALUES(?,?,'prepared')").bind(ids.cap,capFp),
  ]);
  const proof={targetId:ids.target,targetRevision:1,clientAuthorityId:ids.authority,workspaceId:"workspace-ops",targetClientRecordId:"client-record-ops",recipientBindingId:ids.binding,
   issuer:"issuer",subject:"subject",baseOperationId:ids.base,ownershipEpoch:1,grantRevision:1,capabilityOperationId:ids.cap,capabilityRevision:1,
   publicationOperationId:ids.pub,publicationRevision:1,publicationSourceSequence:1,publicationSnapshotId:ids.snapshot,publicationSnapshotSha256:hash,expiresAt};
  const env={OPS_DB:db,DELIVERY_DB:delivery,OPERATIONS_SESSION_SECRET:"private-inbox-cursor-secret-0123456789",CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED:"true"} as Env;
  const body={protocolVersion:1,proofs:[proof],input:{kind:"website",title:"Website help",details:"Please contact me.",location:null,idempotencyKey:"ops-request-create-key-1"}};
  expect(JSON.parse(await submitOpsPrincipalInquiry(env,JSON.stringify(body)))).toEqual({ok:false,code:"unavailable"});
  await db.prepare("INSERT INTO operations_portal_native_inquiry_capability_closures(operation_id,request_fingerprint,client_receipt_fingerprint,resulting_state,operations_receipt_fingerprint) VALUES(?,?,?,'active',?)").bind(ids.cap,capFp,capFp,capFp).run();
  const created=JSON.parse(await submitOpsPrincipalInquiry(env,JSON.stringify(body)));
  expect(created).toMatchObject({ok:true,replayed:false,inquiry:{kind:"website",status:"received"}});
  expect(JSON.parse(await submitOpsPrincipalInquiry(env,JSON.stringify(body)))).toMatchObject({ok:true,replayed:true});
  expect(JSON.parse(await submitOpsPrincipalInquiry(env,JSON.stringify({...body,input:{...body.input,title:"Changed"}})))).toEqual({ok:false,code:"conflict"});
  expect(JSON.parse(await listOpsPrincipalInquiries(env,JSON.stringify({protocolVersion:1,proofs:[proof]})))).toMatchObject({ok:true,inquiries:[{title:"Website help"}]});
  expect(JSON.parse(await listOpsPrincipalInquiries(env,JSON.stringify({protocolVersion:1,proofs:[{...proof,subject:"other"}]})))).toEqual({ok:false,code:"unavailable"});
  const b={target:"30000000-0000-4000-8000-000000000001",binding:"30000000-0000-4000-8000-000000000002",base:"30000000-0000-4000-8000-000000000003",cap:"30000000-0000-4000-8000-000000000004",pub:"30000000-0000-4000-8000-000000000005",snapshot:"30000000-0000-4000-8000-000000000006",authority:"30000000-0000-4000-8000-000000000007",intent:"30000000-0000-4000-8000-000000000008"};
  const bHash="f".repeat(64),bBaseFp="1".repeat(64),bCapFp="2".repeat(64),bSnapshot=JSON.stringify({directoryRecords:[{recordId:"client-record-b",kind:"client",parentRecordId:null}]});
  await db.batch([
   db.prepare("INSERT INTO client_onboarding_recipient_identity_bindings(binding_id) VALUES(?)").bind(b.binding),
   db.prepare("INSERT INTO operations_portal_workspace_reservation_heads(target_id) VALUES(?)").bind(b.target),
   db.prepare("INSERT INTO operations_directory_records(record_id) VALUES('client-record-b')"),
   db.prepare("INSERT INTO operations_portal_native_authority_commands(operation_id,request_fingerprint,action,permissions_json,target_id,recipient_binding_id,enrollment_intent_id,target_client_record_id,issuer,subject) VALUES(?,?,'recipient.grant','[\"operations.service_home.read\"]',?,?,?,?,?,?)").bind(b.base,bBaseFp,b.target,b.binding,b.intent,"client-record-b","issuer","subject"),
   db.prepare("INSERT INTO operations_portal_native_authority_receipts(operation_id,ownership_epoch,grant_revision,state,request_fingerprint) VALUES(?,1,1,'active',?)").bind(b.base,bBaseFp),
   db.prepare("INSERT INTO operations_portal_native_recipient_authority_heads(recipient_binding_id,target_id,latest_operation_id,ownership_epoch,grant_revision,state,expires_at) VALUES(?,?,?,1,1,'active',NULL)").bind(b.binding,b.target,b.base),
   db.prepare("INSERT INTO operations_portal_native_workspace_authority_heads(target_id,ownership_epoch,state,root_kind,root_record_id) VALUES(?,1,'active','standalone_client','client-record-b')").bind(b.target),
   db.prepare("INSERT INTO operations_portal_workspace_publication_commands(operation_id) VALUES(?)").bind(b.pub),
   db.prepare("INSERT INTO operations_portal_workspace_publication_snapshots(snapshot_id,operation_id,snapshot_sha256,snapshot_json) VALUES(?,?,?,?)").bind(b.snapshot,b.pub,bHash,bSnapshot),
   db.prepare("INSERT INTO operations_portal_workspace_publication_heads(target_id,target_revision,client_authority_id,workspace_id,latest_operation_id,revision,source_sequence,snapshot_id,snapshot_sha256) VALUES(?,1,?,'workspace-b',?,1,1,?,?)").bind(b.target,b.authority,b.pub,b.snapshot,bHash),
   db.prepare("INSERT INTO operations_portal_native_inquiry_capability_heads(intent_id,target_id,recipient_binding_id,state,latest_operation_id,revision) VALUES(?,?,?,'active',?,1)").bind(b.intent,b.target,b.binding,b.cap),
   db.prepare(`INSERT INTO operations_portal_native_inquiry_capability_commands(operation_id,intent_id,action,resulting_revision,target_id,target_revision,client_authority_id,workspace_id,target_client_record_id,recipient_binding_id,issuer,subject,base_operation_id,base_ownership_epoch,base_grant_revision,permission,publication_operation_id,publication_revision,publication_source_sequence,publication_snapshot_id,publication_snapshot_sha256,expires_at,request_fingerprint)
    VALUES(?,?,'grant',1,?,1,?,'workspace-b','client-record-b',?,'issuer','subject',?,1,1,'operations.request.create',?,1,1,?,?,?,?)`).bind(b.cap,b.intent,b.target,b.authority,b.binding,b.base,b.pub,b.snapshot,bHash,expiresAt,bCapFp),
   db.prepare("INSERT INTO operations_portal_native_inquiry_capability_receipts(operation_id,request_fingerprint,state) VALUES(?,?,'prepared')").bind(b.cap,bCapFp),
   db.prepare("INSERT INTO operations_portal_native_inquiry_capability_closures(operation_id,request_fingerprint,client_receipt_fingerprint,resulting_state,operations_receipt_fingerprint) VALUES(?,?,?,'active',?)").bind(b.cap,bCapFp,bCapFp,bCapFp),
  ]);
  const proofB={targetId:b.target,targetRevision:1,clientAuthorityId:b.authority,workspaceId:"workspace-b",targetClientRecordId:"client-record-b",recipientBindingId:b.binding,
   issuer:"issuer",subject:"subject",baseOperationId:b.base,ownershipEpoch:1,grantRevision:1,capabilityOperationId:b.cap,capabilityRevision:1,
   publicationOperationId:b.pub,publicationRevision:1,publicationSourceSequence:1,publicationSnapshotId:b.snapshot,publicationSnapshotSha256:bHash,expiresAt};
  const multiBody={protocolVersion:1,proofs:[proofB,proof],input:{kind:"other",title:"Both business contexts",details:"One general inquiry across both linked businesses.",location:null,idempotencyKey:"ops-request-create-key-2"}};
  const multiCreated=JSON.parse(await submitOpsPrincipalInquiry(env,JSON.stringify(multiBody)));
  expect(multiCreated).toMatchObject({ok:true,replayed:false,inquiry:{title:"Both business contexts"}});
  expect(JSON.parse(await listOpsPrincipalInquiries(env,JSON.stringify({protocolVersion:1,proofs:[proof,proofB]})))).toMatchObject({ok:true,inquiries:[{title:"Both business contexts"},{title:"Website help"}]});
  expect(JSON.parse(await listOpsPrincipalInquiries(env,JSON.stringify({protocolVersion:1,proofs:[proofB]})))).toEqual({ok:true,inquiries:[]});
  const actor:StaffPrincipal={id:"staff-inbox-owner",email:"staff@example.test",displayName:"Inbox owner",accessSubject:"staff-access",projectAlphaUserId:null};
  await db.batch([
   db.prepare("INSERT INTO staff_users(id,email,access_subject,project_alpha_user_id,status) VALUES(?,?,?,?,'active')").bind(actor.id,actor.email,actor.accessSubject,null),
   db.prepare("INSERT INTO staff_role_assignments(staff_id,role_id,scope,division_id) VALUES(?,'role-admin','global',NULL)").bind(actor.id),
   db.prepare("INSERT INTO role_permissions(role_id,permission_key) VALUES('role-admin','operations.manage')"),
  ]);
  const staffEnv={...env,ENVIRONMENT:"staging"} as Env;
  const legacyId="40000000-0000-4000-8000-000000000001";
  await delivery.prepare("INSERT INTO client_ops_triage_inquiries(id,kind,title,details,location,status,created_at) VALUES(?,'drone','Existing PA inquiry','Legacy path remains visible.',NULL,'received','2026-10-30 00:00:00')").bind(legacyId).run();
  const page=await listStaffInboxInquiries(staffEnv,actor);
  expect(page.items).toContainEqual(expect.objectContaining({id:"ops:"+created.inquiry.id,title:"Website help",status:"received"}));
  expect(page.items).toContainEqual(expect.objectContaining({id:legacyId,title:"Existing PA inquiry",status:"received"}));
  expect(JSON.stringify(page.items)).not.toMatch(/recipient_binding_id|issuer|subject|workspace-ops/);
  const inbox=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();
  inbox.use("*",async(c,next)=>{c.set("principal",actor);c.set("administrator",true);await next();});
  registerStaffInboxRequestRoutes(inbox);
  const changed=await inbox.request("https://ops.example.test/api/operations/inbox/inquiries/ops:"+created.inquiry.id,
   {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:"under_review"})},staffEnv);
  expect(changed.status).toBe(200);expect((await changed.json() as any).inquiry.status).toBe("under_review");
  expect(await db.prepare("SELECT COUNT(*) n FROM operations_native_principal_inquiry_outbox WHERE event_type='inquiry_status_changed'").first("n")).toBe(0);
  await db.prepare("UPDATE operations_portal_workspace_publication_heads SET revision=2 WHERE target_id=?").bind(ids.target).run();
  expect(JSON.parse(await listOpsPrincipalInquiries(env,JSON.stringify({protocolVersion:1,proofs:[proof,proofB]})))).toEqual({ok:false,code:"unavailable"});
  await db.prepare("UPDATE operations_portal_workspace_publication_heads SET revision=1 WHERE target_id=?").bind(ids.target).run();
  await db.prepare("UPDATE operations_portal_native_inquiry_capability_commands SET expires_at='2000-01-01T00:00:00.000Z' WHERE operation_id=?").bind(ids.cap).run();
  expect(JSON.parse(await listOpsPrincipalInquiries(env,JSON.stringify({protocolVersion:1,proofs:[proof,proofB]})))).toEqual({ok:false,code:"unavailable"});
  await db.prepare("UPDATE operations_portal_native_inquiry_capability_commands SET expires_at=? WHERE operation_id=?").bind(expiresAt,ids.cap).run();
  await db.prepare("UPDATE operations_portal_native_recipient_authority_heads SET state='revoked' WHERE recipient_binding_id=?").bind(ids.binding).run();
  expect(JSON.parse(await listOpsPrincipalInquiries(env,JSON.stringify({protocolVersion:1,proofs:[proofB]})))).toMatchObject({ok:true,inquiries:[]});
  const opsQueueRows=Array.from({length:13},(_,index)=>db.prepare(`INSERT INTO operations_native_principal_inquiries(inquiry_id,issuer,subject,authority_set_json,authority_set_sha256,idempotency_key,request_fingerprint,kind,title,details,location,created_at,updated_at)
   VALUES(?,?,?, '["proof"]', ?, ?, ?, 'other', ?, 'A queued Operations inquiry.', NULL, ?, ?)`)
   .bind(crypto.randomUUID(),"issuer","subject","f".repeat(64),`queue-ops-key-${index.toString().padStart(8,"0")}`,"e".repeat(64),`Ops queue ${index}`,
    `2026-10-30T00:00:${String(index+1).padStart(2,"0")}.${String(index*37%1000).padStart(3,"0")}Z`,`2026-10-30T00:00:${String(index+1).padStart(2,"0")}.${String(index*37%1000).padStart(3,"0")}Z`));
  const legacyQueueRows=Array.from({length:13},(_,index)=>delivery.prepare("INSERT INTO client_ops_triage_inquiries(id,kind,title,details,location,status,created_at) VALUES(?,'other',?,'A queued legacy inquiry.',NULL,'received',?)")
   .bind(crypto.randomUUID(),`Legacy queue ${index}`,`2026-10-30 00:00:${String(index+1).padStart(2,"0")}.${String((index*37+19)%1000).padStart(3,"0")}`));
  await Promise.all([db.batch(opsQueueRows),delivery.batch(legacyQueueRows)]);
  const firstPage=await listStaffInboxInquiries(staffEnv,actor),secondPage=await listStaffInboxInquiries(staffEnv,actor,{cursor:firstPage.nextCursor??undefined});
  const merged=[...firstPage.items,...secondPage.items];
  expect(firstPage.items).toHaveLength(25);expect(firstPage.nextCursor).toBeTruthy();expect(secondPage.nextCursor).toBeNull();
  expect(merged).toHaveLength(30);expect(new Set(merged.map(item=>item.id)).size).toBe(30);
  expect(merged.map(item=>item.createdAt)).toEqual([...merged.map(item=>item.createdAt)].sort());
 });
});
