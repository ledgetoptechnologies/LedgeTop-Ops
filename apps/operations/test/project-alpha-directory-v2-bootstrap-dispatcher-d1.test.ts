import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import type { Env } from "../src/worker/types";

const mocks=vi.hoisted(()=>({resolve:vi.fn(),enabled:vi.fn(),probe:vi.fn(),profile:vi.fn(),binding:vi.fn(),inventory:vi.fn()}));
vi.mock("../src/worker/project-alpha-api-v2-connections",()=>({resolveProjectAlphaApiV2Connection:mocks.resolve,withEnabledConfiguredProjectAlphaApiV2Connection:mocks.enabled}));
vi.mock("../src/worker/project-alpha-api-v2",()=>({probeProjectAlphaApiV2:mocks.probe}));
vi.mock("../src/worker/project-alpha-directory-read-api-v2",()=>({readConfiguredProjectAlphaDirectoryProfile:mocks.profile,readConfiguredProjectAlphaDirectoryBindingStatus:mocks.binding}));
vi.mock("../src/worker/project-alpha-directory-inventory-api-v2",()=>({readConfiguredProjectAlphaDirectoryInventory:mocks.inventory}));
import { bootstrapProjectAlphaDirectoryOrganization } from "../src/worker/project-alpha-directory-v2-bootstrap-dispatcher";
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite,
  type NativeDirectoryProfileWrite } from "../src/worker/native-directory-profile-writer";
import { dispatchProjectAlphaDirectoryProfileOutboxCommand } from "../src/worker/project-alpha-directory-profile-outbox-dispatcher";

const sourceId="project-alpha:directory-staging",sourceInstance="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",applicationId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",epoch="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const connection={baseUrl:"https://pa.example.test",apiKey:"test-only",expectedSourceInstanceId:sourceInstance,expectedApplicationId:applicationId,expectedHistoryEpoch:epoch};
let runtime:Miniflare,db:D1Database,env:Env,number=0;
const uuid=()=>`10000000-0000-4000-8000-${String(++number).padStart(12,"0")}`;
async function migrate(){const directory=new URL("../migrations/",import.meta.url);for(const name of readdirSync(directory).filter(n=>/^\d{4}_.+\.sql$/.test(n)&&n.slice(0,4)<="0181").sort())await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,directory),"utf8")).map(sql=>db.prepare(sql)));}
async function applyRelationshipRecoveryMigration(){const present=await db.prepare("SELECT 1 ok FROM sqlite_master WHERE type='view' AND name='project_alpha_directory_validated_materialized_acknowledgements'").first("ok");if(present)return;const migration=readFileSync(new URL("../migrations/0182_project_alpha_directory_relationship_recovery_guard.sql",import.meta.url),"utf8");await db.batch(splitD1MigrationStatements(migration).map(sql=>db.prepare(sql)));}
async function seed(){await db.batch([
 db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES('staff','staff@example.test','Staff','subject')"),
 db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES('staff','subject',1,'staff')"),
 db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('drone','Drone',1)"),
 db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by) VALUES('directory-grant','staff','directory.profile.edit','allow','global',1,'staff')"),
]);}
function input(commandId=uuid(),recordId=`staging-directory-acceptance-fixture-${number}`){return{sourceId,expectedApplicationId:applicationId,commandId,recordId,scopes:[{businessAreaId:"drone",divisionId:null}],profile:{name:"Fixture",generalEmail:"",generalPhone:"",addressLine1:"",addressLine2:"",city:"",state:"",postalCode:"",country:""},actor:{staffId:"staff",accessSubject:"subject",admissionVersion:1}} as const;}
const publicFor=(id:string)=>id.replace(/[^0-9a-f]/g,"").slice(-32).padStart(32,"a");
function created(id:string,generation="0",replayed=false){const publicId=publicFor(id),next=String(BigInt(generation)+1n);return Response.json({sourceInstanceId:sourceInstance,applicationId,historyEpoch:epoch,requestId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",replayed,result:{resource:{type:"organization",id,publicId,revision:"1"},authorizationGeneration:next}},{status:replayed?200:201,headers:{"Cache-Control":"no-store","X-Request-ID":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}});}
beforeAll(async()=>{runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});db=await runtime.getD1Database("OPS_DB") as D1Database;await migrate();await seed();env={OPS_DB:db,PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_SOURCE_ID:sourceId,PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_ORIGIN:connection.baseUrl} as Env;mocks.resolve.mockReturnValue({sourceId,enabled:true,connection:{...connection}});mocks.enabled.mockImplementation(async(_e:unknown,_s:unknown,fn:(c:typeof connection)=>unknown)=>({status:"enabled",value:await fn(connection)}));mocks.probe.mockResolvedValue({status:"verified"});mocks.inventory.mockResolvedValue({status:"observed",inventory:{authorizationGeneration:"0"}});mocks.profile.mockImplementation(async(_e:unknown,_s:unknown,_k:unknown,id:string)=>({status:"observed",observation:{resource:{revision:"1"},authorizationGeneration:"1",profile:{publicId:id}}}));mocks.binding.mockResolvedValue({status:"observed",observation:{resource:{revision:"1"},authorizationGeneration:"1"}});},240000);
afterAll(async()=>{await runtime?.dispose();});

describe("Directory bootstrap dispatcher — migrated D1",()=>{
 it("creates through native guards then leases, maps, and acknowledges",async()=>{const value=input();const publicId=publicFor(value.recordId),result=await bootstrapProjectAlphaDirectoryOrganization(env,value,async()=>created(value.recordId));expect(result).toEqual({status:"acknowledged",publicId,revision:"1"});expect(await db.prepare("SELECT state FROM project_alpha_directory_outbox WHERE command_id=?").bind(value.commandId).first()).toEqual({state:"acknowledged"});expect(await db.prepare("SELECT project_alpha_public_id FROM project_alpha_directory_mappings WHERE command_id=?").bind(value.commandId).first()).toEqual({project_alpha_public_id:publicId});expect(await db.prepare("SELECT version,mutation_id FROM operations_directory_revisions WHERE record_id=?").bind(value.recordId).first()).toEqual({version:1,mutation_id:`${value.commandId}:directory-bootstrap`});expect(await db.prepare("SELECT record_version,actor_type,actor_id,mutation_id FROM operations_directory_audit WHERE record_id=?").bind(value.recordId).first()).toEqual({record_version:1,actor_type:"staff",actor_id:value.actor.staffId,mutation_id:`${value.commandId}:directory-bootstrap`});expect(await db.prepare("SELECT count(*) n FROM operations_directory_write_fences").first<number>("n")).toBe(0);});
 it("replays an acknowledged exact body without inventory or PA, while changed body or scopes conflict locally",async()=>{const value=input();await expect(bootstrapProjectAlphaDirectoryOrganization(env,value,async()=>created(value.recordId))).resolves.toMatchObject({status:"acknowledged"});await expect(bootstrapProjectAlphaDirectoryOrganization(env,value,async()=>{throw new Error("must not dispatch");})).resolves.toMatchObject({status:"replayed"});const inventoryCalls=mocks.inventory.mock.calls.length,send=vi.fn(async()=>created(value.recordId));await expect(bootstrapProjectAlphaDirectoryOrganization(env,{...value,profile:{...value.profile,name:"Changed"}},send)).resolves.toEqual({status:"conflict",reason:"command_id_body_conflict"});await expect(bootstrapProjectAlphaDirectoryOrganization(env,{...value,scopes:[{businessAreaId:"drone",divisionId:"different"}]},send)).resolves.toEqual({status:"conflict",reason:"command_id_body_conflict"});expect(mocks.inventory).toHaveBeenCalledTimes(inventoryCalls);expect(send).not.toHaveBeenCalled();});
 it("rejects a globally reused command ID under another PA identity before inventory or PA",async()=>{const value=input(),command={operation:"create",commandId:value.commandId,resourceType:"organization",externalId:value.recordId,expectedRevision:"0",expectedAuthorizationGeneration:"0",fields:value.profile};await db.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,external_id,command_json,destination_base_url,expected_source_instance_id,expected_history_epoch_id,origin_snapshot_json,next_attempt_at) VALUES(?,?,?,?,?,?,?,?,?,?,0)`).bind(value.commandId,"project-alpha:other",applicationId,"organization",value.recordId,JSON.stringify(command),"https://other.example.test",sourceInstance,epoch,"{}").run();const inventoryCalls=mocks.inventory.mock.calls.length,send=vi.fn(async()=>created(value.recordId));await expect(bootstrapProjectAlphaDirectoryOrganization(env,value,send)).resolves.toEqual({status:"conflict",reason:"command_id_identity_conflict"});expect(mocks.inventory).toHaveBeenCalledTimes(inventoryCalls);expect(send).not.toHaveBeenCalled();});
 it("requires exact staging source and origin pins before inventory or PA",async()=>{const value=input(),send=vi.fn(async()=>created(value.recordId)),inventoryCalls=mocks.inventory.mock.calls.length;await expect(bootstrapProjectAlphaDirectoryOrganization(env,{...value,sourceId:"project-alpha:other"},send)).resolves.toEqual({status:"blocked",reason:"acceptance_target_pin"});mocks.resolve.mockReturnValueOnce({sourceId,enabled:true,connection:{...connection,baseUrl:"https://other.example.test"}});await expect(bootstrapProjectAlphaDirectoryOrganization(env,value,send)).resolves.toEqual({status:"blocked",reason:"acceptance_target_pin"});expect(mocks.inventory).toHaveBeenCalledTimes(inventoryCalls);expect(send).not.toHaveBeenCalled();});
 it("does not map on capability, malformed/oversized/mismatched receipts, or profile/binding uncertainty",async()=>{for(const kind of ["capability","oversized","mismatched","profile","binding"] as const){const value=input();if(kind==="capability")mocks.probe.mockResolvedValueOnce({status:"unauthorized"});if(kind==="profile")mocks.profile.mockResolvedValueOnce({status:"uncertain"});if(kind==="binding")mocks.binding.mockResolvedValueOnce({status:"uncertain"});const target=kind==="oversized"?async()=>new Response("x".repeat(65*1024),{status:201,headers:{"Cache-Control":"no-store","Content-Type":"application/json"}}):kind==="mismatched"?async()=>Response.json({sourceInstanceId:"wrong",applicationId,historyEpoch:epoch,result:{resource:{type:"organization",id:value.recordId,publicId:publicFor(value.recordId),revision:"1"}}},{status:201,headers:{"Cache-Control":"no-store","X-Request-ID":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}}):async()=>created(value.recordId);const result=await bootstrapProjectAlphaDirectoryOrganization(env,value,target as typeof fetch);expect(result.status).not.toBe("acknowledged");expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_mappings WHERE command_id=?").bind(value.commandId).first<number>("n")).toBe(0);}});
 it("returns bounded inventory transport diagnostics without exposing request identifiers",async()=>{const value=input();mocks.inventory.mockResolvedValueOnce({status:"uncertain",reason:"http_status",httpStatus:503,requestId:"ffffffff-ffff-4fff-8fff-ffffffffffff"});const send=vi.fn(async()=>created(value.recordId));await expect(bootstrapProjectAlphaDirectoryOrganization(env,value,send)).resolves.toEqual({status:"blocked",reason:"directory_inventory",diagnostic:{status:"uncertain",reason:"http_status",httpStatus:503}});expect(send).not.toHaveBeenCalled();});
 it("returns bounded preflight diagnostics without copying provider request identifiers",async()=>{const value=input();mocks.inventory.mockResolvedValueOnce({status:"blocked",reason:"credentials_or_scope",preflight:{status:"unauthorized",reason:"credentials_or_scope",httpStatus:401,requestId:"ffffffff-ffff-4fff-8fff-ffffffffffff"}});const send=vi.fn(async()=>created(value.recordId));await expect(bootstrapProjectAlphaDirectoryOrganization(env,value,send)).resolves.toEqual({status:"blocked",reason:"directory_inventory",diagnostic:{status:"blocked",reason:"credentials_or_scope",preflightStatus:"unauthorized",preflightReason:"credentials_or_scope"}});expect(send).not.toHaveBeenCalled();});
 it("times out a stalled PA receipt without creating a mapping",async()=>{const value=input();const pending=bootstrapProjectAlphaDirectoryOrganization(env,value,async(_input,options)=>await new Promise<Response>((_resolve,reject)=>(options?.signal as AbortSignal).addEventListener("abort",()=>reject(new Error("aborted")))),1);await expect(pending).resolves.toEqual({status:"uncertain",reason:"timeout"});expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_mappings WHERE command_id=?").bind(value.commandId).first<number>("n")).toBe(0);});
 it("rejects receipt request-ID, shape, replay, redirect/cookie, and status contract drift",async()=>{for(const kind of ["requestId","extra","replayed","cookie","location","status"] as const){const value=input();const target=async()=>{const payload=await created(value.recordId).json() as Record<string,unknown>;if(kind==="requestId")payload.requestId="ffffffff-ffff-4fff-8fff-ffffffffffff";if(kind==="extra")payload.extra=true;if(kind==="replayed")payload.replayed="true";const headers:Record<string,string>={"Cache-Control":"no-store","X-Request-ID":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"};if(kind==="cookie")headers["Set-Cookie"]="private=1";if(kind==="location")headers.Location="https://wrong.example.test";return Response.json(payload,{status:kind==="status"?200:201,headers});};await expect(bootstrapProjectAlphaDirectoryOrganization(env,value,target)).resolves.toEqual({status:"uncertain",reason:"pa_receipt"});expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_mappings WHERE command_id=?").bind(value.commandId).first<number>("n")).toBe(0);}});
 it("pins a nonzero inventory generation in the PA command",async()=>{const value=input();mocks.inventory.mockResolvedValueOnce({status:"observed",inventory:{authorizationGeneration:"7"}});mocks.profile.mockResolvedValueOnce({status:"observed",observation:{resource:{revision:"1"},authorizationGeneration:"8"}});mocks.binding.mockResolvedValueOnce({status:"observed",observation:{resource:{revision:"1"},authorizationGeneration:"8"}});await expect(bootstrapProjectAlphaDirectoryOrganization(env,value,async()=>created(value.recordId,"7"))).resolves.toMatchObject({status:"acknowledged"});expect(await db.prepare("SELECT json_extract(command_json,'$.expectedAuthorizationGeneration') generation FROM project_alpha_directory_outbox WHERE command_id=?").bind(value.commandId).first()).toEqual({generation:"7"});});
 it("recovers a PA success after acknowledgement persistence fails by replaying the exact command without inventory",async()=>{const value=input(),publicId=publicFor(value.recordId);let batches=0;const guarded=new Proxy(db,{get(target,key){if(key==="batch")return async(statements:D1PreparedStatement[])=>{if(++batches===2)throw new Error("synthetic acknowledgement failure");return target.batch(statements);};const member=target[key as keyof D1Database];return typeof member==="function"?member.bind(target):member;}}) as D1Database;const first=await bootstrapProjectAlphaDirectoryOrganization({...env,OPS_DB:guarded},value,async()=>created(value.recordId));expect(first).toEqual({status:"uncertain",reason:"acknowledgement_persistence"});expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_mappings WHERE command_id=?").bind(value.commandId).first<number>("n")).toBe(0);await expect(bootstrapProjectAlphaDirectoryOrganization(env,value,async()=>created(value.recordId,"0",true))).resolves.toMatchObject({status:"acknowledged",publicId});});
 it("fails closed when a partial command is retried after its configured connection rotates",async()=>{const value=input();let batches=0;const guarded=new Proxy(db,{get(target,key){if(key==="batch")return async(statements:D1PreparedStatement[])=>{if(++batches===2)throw new Error("synthetic acknowledgement failure");return target.batch(statements);};const member=target[key as keyof D1Database];return typeof member==="function"?member.bind(target):member;}}) as D1Database;await expect(bootstrapProjectAlphaDirectoryOrganization({...env,OPS_DB:guarded},value,async()=>created(value.recordId))).resolves.toEqual({status:"uncertain",reason:"acknowledgement_persistence"});const rotated={...connection,baseUrl:"https://rotated.example.test",expectedSourceInstanceId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",expectedApplicationId:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",expectedHistoryEpoch:"ffffffff-ffff-4fff-8fff-ffffffffffff"},rotatedEnv={...env,PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_ORIGIN:rotated.baseUrl},rotatedInput={...value,expectedApplicationId:rotated.expectedApplicationId},inventoryCalls=mocks.inventory.mock.calls.length,send=vi.fn(async()=>created(value.recordId,"0",true));mocks.resolve.mockReturnValueOnce({sourceId,enabled:true,connection:rotated});await expect(bootstrapProjectAlphaDirectoryOrganization(rotatedEnv,rotatedInput,send)).resolves.toEqual({status:"conflict",reason:"command_id_identity_conflict"});expect(mocks.inventory).toHaveBeenCalledTimes(inventoryCalls);expect(send).not.toHaveBeenCalled();expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_mappings WHERE command_id=?").bind(value.commandId).first<number>("n")).toBe(0);});
 it("authenticates a real bootstrap acknowledgement through the proposed relationship evidence without rewriting it",async()=>{
  const value=input();
  await expect(bootstrapProjectAlphaDirectoryOrganization(env,value,async()=>created(value.recordId)))
    .resolves.toMatchObject({status:"acknowledged"});
  const stored=await db.prepare("SELECT outcome_json FROM project_alpha_directory_outbox WHERE command_id=?")
    .bind(value.commandId).first<{outcome_json:string}>();
  expect(stored).not.toBeNull();
  const persisted:unknown=JSON.parse(stored!.outcome_json);
  expect(persisted).toMatchObject({status:"acknowledged",response:{result:{resource:{type:"organization",id:value.recordId}}}});
  const evidence=()=>db.prepare("SELECT identity_valid FROM project_alpha_directory_relationship_revision_evidence WHERE record_id=? AND record_kind='organization' AND record_version=1")
    .bind(value.recordId).all<{identity_valid:number}>();
  expect((await evidence()).results).toEqual([{identity_valid:0}]);
  await applyRelationshipRecoveryMigration();
  expect((await evidence()).results).toEqual([{identity_valid:1}]);
  expect(await db.prepare("SELECT outcome_json FROM project_alpha_directory_outbox WHERE command_id=?")
    .bind(value.commandId).first()).toEqual(stored);
 });
 it("carries a native bootstrap ACK through a real parent update and linked-client dispatch",async()=>{
  await applyRelationshipRecoveryMigration();
  const organization=input(),organizationPublicId=publicFor(organization.recordId);
  await expect(bootstrapProjectAlphaDirectoryOrganization(env,organization,async()=>created(organization.recordId)))
    .resolves.toEqual({status:"acknowledged",publicId:organizationPublicId,revision:"1"});
  const bootstrapOutcome=await db.prepare("SELECT outcome_json FROM project_alpha_directory_outbox WHERE command_id=?")
    .bind(organization.commandId).first<string>("outcome_json");

  await db.batch([
    db.prepare("UPDATE staff_users SET status='active' WHERE id='staff'"),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES('staff','staff@example.test','Staff')"),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by) VALUES('identity-grant','staff','directory.identity.link','allow','global',1,'staff')"),
  ]);
  const actor={staffId:"staff",accessSubject:"subject",admissionVersion:1,selectedGrantId:"directory-grant",
    loginEmail:"staff@example.test",profileVersion:1,selectedIdentityGrantId:"identity-grant"} as const;
  const destination={sourceId,sourceInstanceUUID:sourceInstance,applicationUUID:applicationId,historyEpoch:epoch,
    origin:connection.baseUrl,externalCanonicalId:organization.recordId,expectedAuthorizationGeneration:"1"} as const;
  const updatedProfile={...organization.profile,name:"Fixture updated"},updateMutation=uuid();
  const update=await writeNativeDirectoryProfile(db,{operation:"update",mutationId:updateMutation,
    recordId:organization.recordId,expectedLocalVersion:1,kind:"organization",profile:updatedProfile,
    destinations:[destination],actor} as NativeDirectoryProfileWrite);
  expect(update.status).toBe("written");
  if(update.status!=="written")throw new Error(update.reason);
  const pendingClientRecordId=`staging-pending-parent-client-${number}`,pendingClientMutation=uuid();
  const pendingAdmissionId=`admission-${pendingClientMutation}`;
  const clientProfile={name:"Linked client",email:"client@example.test",phone:"",clientType:"business" as const,
    addressLine1:"",addressLine2:"",city:"",state:"",postalCode:"",country:""};
  const makeClientInput=(recordId:string,mutationId:string,createAdmissionId:string)=>({operation:"create",mutationId,recordId,
    expectedLocalVersion:0,kind:"client",createAdmissionId,profile:clientProfile,scopes:organization.scopes,
    destinations:[{...destination,externalCanonicalId:recordId}],actor,
    relationship:{organizationRecordId:organization.recordId,expectedRelationshipVersion:0}} as NativeDirectoryCreateWrite);
  const admitClient=async(recordId:string,createAdmissionId:string)=>db.batch([
    db.prepare(`INSERT INTO native_directory_create_admissions
      (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(createAdmissionId,actor.staffId,actor.accessSubject,recordId,"client",
        JSON.stringify(organization.scopes),JSON.stringify(clientProfile),JSON.stringify([{sourceId,sourceInstanceUUID:sourceInstance,
          applicationUUID:applicationId,historyEpoch:epoch,origin:connection.baseUrl,externalCanonicalId:recordId}]),actor.staffId),
    db.prepare(`INSERT INTO native_directory_create_admission_relationships
      (create_admission_id,client_record_id,organization_record_id,organization_record_version) VALUES(?,?,?,2)`)
      .bind(createAdmissionId,recordId,organization.recordId),
  ]);
  await admitClient(pendingClientRecordId,pendingAdmissionId);
  await expect(writeNativeDirectoryProfile(db,makeClientInput(pendingClientRecordId,pendingClientMutation,pendingAdmissionId)))
    .resolves.toEqual({status:"blocked",reason:"client_relationship_evidence"});
  expect(await db.prepare("SELECT count(*) n FROM operations_directory_intents WHERE mutation_id=?")
    .bind(pendingClientMutation).first<number>("n")).toBe(0);
  expect(await db.prepare("SELECT count(*) n FROM operations_directory_intent_relationship_dependencies WHERE client_record_id=?")
    .bind(pendingClientRecordId).first<number>("n")).toBe(0);
  expect(await db.prepare("SELECT count(*) n FROM operations_directory_write_fences WHERE mutation_id=?")
    .bind(pendingClientMutation).first<number>("n")).toBe(0);
  const updateSend=vi.fn(async(_url:URL|RequestInfo,options?:RequestInit)=>{
    JSON.parse(String(options?.body));
    return Response.json({sourceInstanceId:sourceInstance,applicationId,historyEpoch:epoch,
      requestId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",replayed:false,
      result:{resource:{type:"organization",publicId:organizationPublicId,revision:"2"},authorizationGeneration:"1"}},
    {status:200,headers:{"Cache-Control":"no-store","X-Request-ID":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}});
  });
  await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env,sourceId,update.commandIds[0]!,updateSend as typeof fetch))
    .resolves.toMatchObject({status:"acknowledged",publicId:organizationPublicId,revision:"2"});
  expect((await db.prepare(`SELECT command_id,record_version,public_id,revision,identity_valid
    FROM project_alpha_directory_validated_materialized_acknowledgements WHERE record_id=? ORDER BY record_version`)
    .bind(organization.recordId).all()).results).toEqual([
      {command_id:organization.commandId,record_version:1,public_id:organizationPublicId,revision:"1",identity_valid:1},
      {command_id:update.commandIds[0],record_version:2,public_id:organizationPublicId,revision:"2",identity_valid:1},
    ]);

  const clientRecordId=`staging-linked-client-${number}`,clientMutation=uuid(),createAdmissionId=`admission-${clientMutation}`;
  const clientInput=makeClientInput(clientRecordId,clientMutation,createAdmissionId);
  await admitClient(clientRecordId,createAdmissionId);
  let clientWriteError:unknown;
  const observedDb=new Proxy(db,{get(target,key){if(key==="batch")return async(statements:D1PreparedStatement[])=>{
    try{return await target.batch(statements);}catch(error){clientWriteError=error;throw error;}}
  const member=target[key as keyof D1Database];return typeof member==="function"?member.bind(target):member;}}) as D1Database;
  const client=await writeNativeDirectoryProfile(observedDb,clientInput);
  if(client.status!=="written")throw new Error(`${client.reason}: ${String(clientWriteError)}`);
  expect(await db.prepare(`SELECT dependency.evidence_kind,resolved.resolved_parent_public_id
    FROM operations_directory_intents intent
    JOIN operations_directory_intent_relationship_dependencies dependency ON dependency.intent_id=intent.intent_id
    JOIN operations_directory_intent_relationship_resolved resolved ON resolved.intent_id=dependency.intent_id
    WHERE intent.mutation_id=?`).bind(clientMutation).first()).toEqual({
      evidence_kind:"parent_intent",resolved_parent_public_id:organizationPublicId,
    });
  const clientPublicId=publicFor(clientRecordId),posts:unknown[]=[];
  const clientSend=vi.fn(async(_url:URL|RequestInfo,options?:RequestInit)=>{
    const command=JSON.parse(String(options?.body)) as Record<string,unknown>;posts.push(command);
    return Response.json({sourceInstanceId:sourceInstance,applicationId,historyEpoch:epoch,
      requestId:"ffffffff-ffff-4fff-8fff-ffffffffffff",replayed:false,
      result:{resource:{type:"client",id:clientRecordId,publicId:clientPublicId,revision:"1"},authorizationGeneration:"2"}},
    {status:201,headers:{"Cache-Control":"no-store","X-Request-ID":"ffffffff-ffff-4fff-8fff-ffffffffffff"}});
  });
  await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env,sourceId,client.commandIds[0]!,clientSend as typeof fetch))
    .resolves.toMatchObject({status:"acknowledged",publicId:clientPublicId,revision:"1"});
  expect(posts).toEqual([expect.objectContaining({externalId:clientRecordId,organization:{externalId:organization.recordId,expectedRevision:"2"}})]);
  expect(await db.prepare("SELECT state FROM operations_directory_intents WHERE mutation_id=?")
    .bind(clientMutation).first("state")).toBe("acknowledged");
  expect(await db.prepare("SELECT outcome_json FROM project_alpha_directory_outbox WHERE command_id=?")
    .bind(organization.commandId).first("outcome_json")).toBe(bootstrapOutcome);
 });
 it("rolls back the whole D1 batch when an existing-mapping dependency has no canonical proof",async()=>{
  await applyRelationshipRecoveryMigration();
  const sentinel=`rollback-${uuid()}`,intentId=uuid(),recordId=`missing-client-${number}`,parentId=`missing-parent-${number}`;
  await expect(db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,status) VALUES(?,?,?,'active')")
      .bind(sentinel,`${sentinel}@example.test`,"Must roll back"),
    db.prepare(`INSERT INTO operations_directory_intent_relationship_dependencies
      (intent_id,client_record_id,client_record_version,relationship_version,relationship_mutation_id,
       organization_record_id,organization_record_version,source_id,source_instance_uuid,application_uuid,
       history_epoch_id,destination_origin,parent_external_canonical_id,evidence_kind,parent_mapping_command_id,
       parent_public_id,parent_ack_revision,parent_ack_command_json,parent_ack_outcome_json)
      VALUES(?,?,1,1,?,?,1,?,?,?,?,?,?,'existing_mapping',?,?,?,?,?)`)
      .bind(intentId,recordId,uuid(),parentId,sourceId,sourceInstance,applicationId,epoch,connection.baseUrl,parentId,
        uuid(),"a".repeat(32),"1","{}","{}"),
  ])).rejects.toThrow();
  expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE id=?").bind(sentinel).first<number>("n")).toBe(0);
  expect(await db.prepare("SELECT count(*) n FROM operations_directory_intent_relationship_dependencies WHERE intent_id=?")
    .bind(intentId).first<number>("n")).toBe(0);
  expect(await db.prepare("SELECT count(*) n FROM operations_directory_write_fences WHERE mutation_id=?")
    .bind(intentId).first<number>("n")).toBe(0);
 });
});
