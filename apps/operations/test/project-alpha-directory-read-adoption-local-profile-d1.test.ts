import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { applyProjectAlphaDirectoryReadAdoptionLocalProfile } from "../src/worker/project-alpha-directory-read-adoption-local-profile";

const finalizationId="10000000-0000-4000-8000-000000000001",receiptId="20000000-0000-4000-8000-000000000002";
const recordId="local-client",publicId="a".repeat(32),key="30000000-0000-4000-8000-000000000003";
const sourceId="project-alpha:local",sourceInstance="80000000-0000-4000-8000-000000000008",application="90000000-0000-4000-8000-000000000009",epoch="a0000000-0000-4000-8000-00000000000a",requestId="b0000000-0000-4000-8000-00000000000b";
const actor={staffId:"staff",accessSubject:"native:staff",admissionVersion:1,profileVersion:1,grantGeneration:1,selectedProfileGrantId:"profile-edit"};
const local={name:"Local",generalEmail:"local@example.test",generalPhone:"",addressLine1:"1 Local Way",addressLine2:"",city:"Local",state:"IL",postalCode:"60000",country:"US",clientType:"business",organizationPublicId:null};
const remote={publicId,name:"Remote",email:"remote@example.test",phone:null,address:{line1:"2 Remote Way",line2:null,city:"Remote",state:"WI",postalCode:"50000",country:"US"},clientType:"business" as const,organizationPublicId:null};
let runtime:Miniflare,db:D1Database;
async function hash(value:unknown){return[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value))))].map(v=>v.toString(16).padStart(2,"0")).join("");}

async function schema(){
  const prerequisites=`
    CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT,current_version INTEGER,updated_at TEXT);
    CREATE TABLE operations_directory_revisions(record_id TEXT,version INTEGER,mutation_id TEXT UNIQUE,profile_json TEXT,PRIMARY KEY(record_id,version));
    CREATE TABLE operations_directory_audit(audit_id TEXT PRIMARY KEY,mutation_id TEXT UNIQUE,record_id TEXT,record_version INTEGER,actor_type TEXT,actor_id TEXT,command_json TEXT,original_verified_access_subject TEXT);
    CREATE TABLE operations_directory_live_write_fences(operation_kind TEXT,record_id TEXT,record_kind TEXT,expected_version INTEGER,record_writes INTEGER,mutation_id TEXT,revision_writes INTEGER,profile_json TEXT,actor_id TEXT,audit_writes INTEGER,command_json TEXT);
    CREATE TRIGGER operations_directory_records_write_guard_update BEFORE UPDATE ON operations_directory_records WHEN 0 BEGIN SELECT RAISE(ABORT,'old'); END;
    CREATE TRIGGER operations_directory_revisions_write_guard BEFORE INSERT ON operations_directory_revisions WHEN 0 BEGIN SELECT RAISE(ABORT,'old'); END;
    CREATE TRIGGER operations_directory_audit_write_guard BEFORE INSERT ON operations_directory_audit WHEN 0 BEGIN SELECT RAISE(ABORT,'old'); END;
    CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,version INTEGER);
    CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER);
    CREATE TABLE native_directory_grant_generations(staff_id TEXT PRIMARY KEY,generation INTEGER);
    CREATE TABLE native_directory_grants(id TEXT PRIMARY KEY,staff_id TEXT,permission TEXT,effect TEXT,scope_kind TEXT,business_area_id TEXT,division_id TEXT,resource_id TEXT,active INTEGER);
    CREATE TABLE native_directory_assignments(record_id TEXT,staff_id TEXT,active INTEGER);
    CREATE TABLE native_directory_resource_scopes(record_id TEXT,active INTEGER,business_area_id TEXT,division_id TEXT);
    CREATE TABLE project_alpha_directory_read_adoption_field_review_receipts(receipt_id TEXT PRIMARY KEY,record_id TEXT,resource_type TEXT,local_record_version INTEGER,local_profile_sha256 TEXT,project_alpha_profile_sha256 TEXT,reviewer_staff_id TEXT,reviewer_access_subject TEXT,reviewer_admission_version INTEGER,reviewer_profile_version INTEGER,decision_count INTEGER);
    CREATE TABLE project_alpha_directory_read_adoption_field_review_audit(receipt_id TEXT,actor_staff_id TEXT);
    CREATE TABLE project_alpha_directory_read_adoption_field_decisions(receipt_id TEXT,field_name TEXT,decision TEXT,PRIMARY KEY(receipt_id,field_name));
    CREATE TABLE project_alpha_directory_read_adoption_finalizations(finalization_id TEXT PRIMARY KEY,field_review_receipt_id TEXT,record_id TEXT,resource_type TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,reviewed_external_id TEXT,project_alpha_public_id TEXT,project_alpha_revision TEXT,authorization_generation TEXT,local_record_version INTEGER,local_profile_sha256 TEXT,project_alpha_profile_sha256 TEXT,reviewer_staff_id TEXT,reviewer_access_subject TEXT,reviewer_admission_version INTEGER,reviewer_profile_version INTEGER,reviewer_grant_generation INTEGER,adopted_field_count INTEGER,state TEXT);
    CREATE TABLE project_alpha_api_v2_inventory_receipts(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,inventory_kind TEXT,request_id TEXT,authorization_generation TEXT);
    CREATE TABLE project_alpha_api_v2_directory_observations_current(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,request_id TEXT,resource_type TEXT,project_alpha_public_id TEXT,resource_revision TEXT,binding_external_id TEXT,binding_status TEXT,binding_resource_revision TEXT,present INTEGER,last_action TEXT,has_conflict INTEGER);
    CREATE TABLE project_alpha_api_v2_inventory_conflicts(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,inventory_kind TEXT,resource_type TEXT,project_alpha_public_id TEXT,external_id TEXT);
    CREATE TABLE project_alpha_directory_outbox(command_id TEXT PRIMARY KEY);
  `;
  await db.batch(splitD1MigrationStatements(prerequisites).map(s=>db.prepare(s)));
  const migration=readFileSync(new URL("../migrations/0168_project_alpha_directory_read_adoption_local_profiles.sql",import.meta.url),"utf8");
  await db.batch(splitD1MigrationStatements(migration).map(s=>db.prepare(s)));
}
async function seed(options:{deny?:boolean;stale?:boolean;unsupported?:boolean}={}){
  const localHash=await hash(local),remoteHash=await hash(remote),fields=["name","email","phone","address_line1","address_line2","city","state","postal_code","country","client_type","organization_public_id"];
  await db.batch([
    db.prepare("INSERT INTO operations_directory_records VALUES(?,'client',?,?)").bind(recordId,options.stale?2:1,"2026-10-03T12:00:00.000Z"),
    db.prepare("INSERT INTO operations_directory_live_write_fences(operation_kind,record_id,record_kind,expected_version,record_writes,mutation_id,revision_writes,profile_json) VALUES('seed',?,'client',0,0,'prior',1,?)").bind(recordId,JSON.stringify(local)),
    db.prepare("INSERT INTO operations_directory_revisions VALUES(?,1,'prior',?)").bind(recordId,JSON.stringify(local)),
    ...(options.stale?[
      db.prepare("INSERT INTO operations_directory_live_write_fences(operation_kind,record_id,record_kind,expected_version,record_writes,mutation_id,revision_writes,profile_json) VALUES('seed',?,'client',1,0,'other',1,?)").bind(recordId,JSON.stringify({...local,city:"Changed"})),
      db.prepare("INSERT INTO operations_directory_revisions VALUES(?,2,'other',?)").bind(recordId,JSON.stringify({...local,city:"Changed"}))]:[]),
    db.prepare("INSERT INTO native_staff_admissions VALUES(?,?,1,1)").bind(actor.staffId,actor.accessSubject),
    db.prepare("INSERT INTO native_staff_profiles VALUES(?,1)").bind(actor.staffId),
    db.prepare("INSERT INTO native_directory_grant_generations VALUES(?,1)").bind(actor.staffId),
    db.prepare("INSERT INTO native_directory_grants VALUES('profile-edit',?,'directory.profile.edit','allow','resource',NULL,NULL,?,1)").bind(actor.staffId,recordId),
    ...(options.deny?[db.prepare("INSERT INTO native_directory_grants VALUES('deny',?,'directory.profile.edit','deny','global',NULL,NULL,NULL,1)").bind(actor.staffId)]:[]),
    db.prepare("INSERT INTO project_alpha_directory_read_adoption_field_review_receipts VALUES(?,?,?,?,?,?,?,?,?,?,11)")
      .bind(receiptId,recordId,"client",1,localHash,remoteHash,actor.staffId,actor.accessSubject,1,1),
    db.prepare("INSERT INTO project_alpha_directory_read_adoption_field_review_audit VALUES(?,?)").bind(receiptId,actor.staffId),
    ...fields.map(field=>db.prepare("INSERT INTO project_alpha_directory_read_adoption_field_decisions VALUES(?,?,?)")
      .bind(receiptId,field,field===(options.unsupported?"client_type":"email")?"adopt_project_alpha":"retain_local")),
    db.prepare("INSERT INTO project_alpha_directory_read_adoption_finalizations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared')")
      .bind(finalizationId,receiptId,recordId,"client",sourceId,sourceInstance,application,epoch,"pa-client",publicId,"3","7",1,localHash,remoteHash,actor.staffId,actor.accessSubject,1,1,1,1),
    db.prepare("INSERT INTO project_alpha_api_v2_inventory_receipts VALUES(?,?,?,?, 'directory',?,'7')").bind(sourceId,sourceInstance,application,epoch,requestId),
    db.prepare("INSERT INTO project_alpha_api_v2_directory_observations_current VALUES(?,?,?,?,?,'client',?,'3','pa-client','active','3',1,'upsert',0)").bind(sourceId,sourceInstance,application,epoch,requestId,publicId),
  ]);
  return localHash;
}
function env(flag="true"){return{ENVIRONMENT:"staging",PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED:flag,OPS_DB:db};}
function input(localHash:string,overrides:Record<string,unknown>={}){return{finalizationId,idempotencyKey:key,expectedRecordVersion:1,expectedLocalProfileSha256:localHash,projectAlphaProfile:remote,actor,...overrides};}
const ids=["40000000-0000-4000-8000-000000000004","50000000-0000-4000-8000-000000000005","60000000-0000-4000-8000-000000000006","70000000-0000-4000-8000-000000000007"];
function deps(){let i=0;return{uuid:()=>ids[i++]!,now:()=>"2026-10-03T12:00:00.000Z"};}

beforeEach(async()=>{await runtime?.dispose();runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {fetch(){return new Response('test')}}",d1Databases:["OPS_DB"]});db=await runtime.getD1Database("OPS_DB") as D1Database;await schema();});
afterAll(async()=>{await runtime?.dispose();});

describe("local-only PA field adoption",()=>{
  it("is staging-only and default-off",async()=>{const localHash=await seed();await expect(applyProjectAlphaDirectoryReadAdoptionLocalProfile(env("false"),input(localHash),deps())).resolves.toEqual({status:"disabled"});});
  it("atomically applies allowed scalar decisions, appends evidence, replays, and emits no PA outbox",async()=>{
    const localHash=await seed(),first=await applyProjectAlphaDirectoryReadAdoptionLocalProfile(env(),input(localHash),deps());
    expect(first).toEqual(expect.objectContaining({status:"applied",recordVersion:2,adoptedFields:["email"]}));
    await expect(applyProjectAlphaDirectoryReadAdoptionLocalProfile(env(),input(localHash),deps())).resolves.toEqual({...first,status:"replayed"});
    const profile=JSON.parse((await db.prepare("SELECT profile_json FROM operations_directory_revisions WHERE version=2").first<string>("profile_json"))!);
    expect(profile).toEqual({...local,generalEmail:"remote@example.test"});
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_read_adoption_local_profile_receipts").first<number>("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_read_adoption_local_profile_events").first<number>("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_outbox").first<number>("n")).toBe(0);
  });
  it("honors deny precedence and leaves the record untouched",async()=>{const localHash=await seed({deny:true});await expect(applyProjectAlphaDirectoryReadAdoptionLocalProfile(env(),input(localHash),deps())).resolves.toEqual({status:"blocked",reason:"authority"});expect(await db.prepare("SELECT current_version FROM operations_directory_records").first<number>("current_version")).toBe(1);});
  it("conflicts on stale local state",async()=>{const localHash=await seed({stale:true});await expect(applyProjectAlphaDirectoryReadAdoptionLocalProfile(env(),input(localHash),deps())).resolves.toEqual({status:"blocked",reason:"stale_local"});});
  it("blocks when the current PA revision or authorization generation moved after preparation",async()=>{
    const localHash=await seed();
    await db.prepare("UPDATE project_alpha_api_v2_directory_observations_current SET resource_revision='4',binding_resource_revision='4'").run();
    await expect(applyProjectAlphaDirectoryReadAdoptionLocalProfile(env(),input(localHash),deps())).resolves.toEqual({status:"blocked",reason:"stale_source"});
    await db.prepare("UPDATE project_alpha_api_v2_directory_observations_current SET resource_revision='3',binding_resource_revision='3'").run();
    await db.prepare("UPDATE project_alpha_api_v2_inventory_receipts SET authorization_generation='8'").run();
    await expect(applyProjectAlphaDirectoryReadAdoptionLocalProfile(env(),input(localHash),deps())).resolves.toEqual({status:"blocked",reason:"stale_source"});
  });
  it("rejects unknown/injected input and blocks unsupported decisions",async()=>{
    let localHash=await seed();
    await expect(applyProjectAlphaDirectoryReadAdoptionLocalProfile(env(),{...input(localHash),injected:"x"},deps())).resolves.toEqual({status:"rejected",reason:"invalid_input"});
    await expect(applyProjectAlphaDirectoryReadAdoptionLocalProfile(env(),input(localHash,{projectAlphaProfile:{...remote,unknown:"x"}}),deps())).resolves.toEqual({status:"rejected",reason:"invalid_profile"});
    await expect(applyProjectAlphaDirectoryReadAdoptionLocalProfile(env(),input(localHash,{actor:{...actor,selectedProfileGrantId:"profile-edit' OR 1=1 --"}}),deps())).resolves.toEqual({status:"blocked",reason:"authority"});
    await runtime.dispose();runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {fetch(){return new Response('test')}}",d1Databases:["OPS_DB"]});db=await runtime.getD1Database("OPS_DB") as D1Database;await schema();localHash=await seed({unsupported:true});
    await expect(applyProjectAlphaDirectoryReadAdoptionLocalProfile(env(),input(localHash),deps())).resolves.toEqual({status:"blocked",reason:"unsupported_decision"});
  });
});
