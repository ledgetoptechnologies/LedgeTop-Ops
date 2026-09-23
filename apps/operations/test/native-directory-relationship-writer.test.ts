import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { writeNativeDirectoryProfile, type NativeDirectoryProfileWrite } from "../src/worker/native-directory-profile-writer";
import { maximumDirectoryRevisionEvidence, writeNativeDirectoryRelationship, type NativeDirectoryRelationshipWrite } from "../src/worker/native-directory-relationship-writer";
import { dispatchProjectAlphaDirectoryRelationshipCommand } from "../src/worker/project-alpha-directory-relationship-outbox-dispatcher";
import type { ProjectAlphaApiV2Endpoint } from "../src/worker/project-alpha-api-v2";

let runtime:Miniflare,db:D1Database,sequence=1;
const source="11111111-1111-4111-8111-111111111111",application="22222222-2222-4222-8222-222222222222";
const epoch="33333333-3333-4333-8333-333333333333",sourceId="project-alpha:primary",baseUrl="https://pa.example.test";
const requestId="44444444-4444-4444-8444-444444444444";
const orgProfile={name:"Organization",generalEmail:"org@example.test",generalPhone:"512-555-0100",addressLine1:"1 Main",addressLine2:"",city:"Austin",state:"TX",postalCode:"78701",country:"US"};
const clientProfile={name:"Client",email:"client@example.test",phone:"512-555-0101",clientType:"business" as const,addressLine1:"2 Main",addressLine2:"",city:"Austin",state:"TX",postalCode:"78702",country:"US"};
const actor={staffId:"relationship-actor",accessSubject:"access|relationship-actor",email:"relationship@example.test",admissionVersion:1,profileVersion:1,
  selectedGrantId:"edit-relationship",loginEmail:"relationship@example.test",selectedIdentityGrantId:"identity-relationship"};
const profileActor={staffId:actor.staffId,accessSubject:actor.accessSubject,admissionVersion:1,selectedGrantId:actor.selectedGrantId,
  loginEmail:actor.loginEmail,profileVersion:1,selectedIdentityGrantId:actor.selectedIdentityGrantId};
function uuid(){return`00000000-0000-4000-8000-${String(sequence++).padStart(12,"0")}`;}
function publicId(){return(sequence++).toString(16).padStart(32,"0");}
function destination(recordId:string,second=false,originOverride=baseUrl){return{sourceId:second?"project-alpha:secondary":sourceId,
  sourceInstanceUUID:second?"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa":source,applicationUUID:second?"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb":application,
  historyEpoch:second?"cccccccc-cccc-4ccc-8ccc-cccccccccccc":epoch,origin:second?"https://pa-secondary.example.test":originOverride,
  externalCanonicalId:recordId,expectedAuthorizationGeneration:"0"};}
function env(second=false){const instances:Record<string,unknown>={[sourceId]:{sourceId,enabled:true,baseUrl,apiKey:"secret",sourceInstanceId:source,applicationId:application,historyEpoch:epoch}};
  if(second)instances["project-alpha:secondary"]={sourceId:"project-alpha:secondary",enabled:true,baseUrl:"https://pa-secondary.example.test",apiKey:"secret2",sourceInstanceId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",applicationId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",historyEpoch:"cccccccc-cccc-4ccc-8ccc-cccccccccccc"};
  return{OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances})};}
async function create(kind:"organization"|"client",two=false,recordId=uuid(),originOverride=baseUrl){const mutationId=uuid(),createAdmissionId=`admission-${mutationId}`;
  const destinations=[destination(recordId,false,originOverride),...(two?[destination(recordId,true)]:[])],scopes=[{businessAreaId:"area",divisionId:"division"}];
  const input={operation:"create",mutationId,createAdmissionId,recordId,expectedLocalVersion:0,kind,profile:kind==="client"?clientProfile:orgProfile,
    scopes,destinations,actor:profileActor,
    ...(kind==="client"?{relationship:{organizationRecordId:null,expectedRelationshipVersion:0}}:{})} as NativeDirectoryProfileWrite;
  await db.prepare(`INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(createAdmissionId,actor.staffId,actor.accessSubject,recordId,kind,JSON.stringify(scopes),JSON.stringify(input.profile),
      JSON.stringify(destinations.map(({expectedAuthorizationGeneration:_,...value})=>value)),actor.staffId).run();
  if(kind==="client")await db.prepare(`INSERT INTO native_directory_create_admission_relationships(create_admission_id,client_record_id)
    VALUES(?,?)`).bind(createAdmissionId,recordId).run();
  const result=await writeNativeDirectoryProfile(db,input);if(result.status!=="written")throw new Error(JSON.stringify(result));
  return{recordId,mutationId,commandIds:result.commandIds,input};}
async function acknowledge(value:Awaited<ReturnType<typeof create>>,kind:"organization"|"client",generation:string){const id=publicId();
  for(const commandId of value.commandIds){const row=await db.prepare("SELECT source_id,expected_source_instance_id,application_id,expected_history_epoch_id FROM project_alpha_directory_outbox WHERE command_id=?").bind(commandId).first<Record<string,string>>();
    await db.batch([db.prepare("UPDATE project_alpha_directory_outbox SET state='leased',lease_token='fixture',lease_expires_at=9999999999999 WHERE command_id=?").bind(commandId),
      db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id,command_id)
        VALUES(?,?,?,?,?,?,?,?)`).bind(row!.source_id,kind,value.recordId,id,row!.expected_source_instance_id,row!.application_id,row!.expected_history_epoch_id,commandId),
      db.prepare("UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=?")
        .bind(JSON.stringify({status:"acknowledged",response:{sourceInstanceId:row!.expected_source_instance_id,applicationId:row!.application_id,
          historyEpoch:row!.expected_history_epoch_id,result:{resource:{type:kind,id:value.recordId,publicId:id,revision:"1"},data:{publicId:id},authorizationGeneration:generation}}}),commandId)]);}
  await db.prepare("UPDATE operations_directory_intents SET state='acknowledged' WHERE mutation_id=?").bind(value.mutationId).run();return id;}
async function updateAndAcknowledge(value:Awaited<ReturnType<typeof create>>,kind:"organization"|"client",publicIdValue:string,
  expectedGeneration:string,revisionValue:string,generation:string,relationship?:{organizationRecordId:string|null;expectedRelationshipVersion:number}){
  const input={operation:"update",mutationId:uuid(),recordId:value.recordId,expectedLocalVersion:1,kind,
    profile:kind==="client"?{name:"Client Updated",email:clientProfile.email,phone:clientProfile.phone,addressLine1:clientProfile.addressLine1,
      addressLine2:clientProfile.addressLine2,city:clientProfile.city,state:clientProfile.state,postalCode:clientProfile.postalCode,country:clientProfile.country}
      :{...orgProfile,name:"Organization Updated"},
    destinations:[{...destination(value.recordId),expectedAuthorizationGeneration:expectedGeneration}],actor:profileActor,
    ...(kind==="client"?{relationship:relationship!}:{})} as NativeDirectoryProfileWrite;
  const result=await writeNativeDirectoryProfile(db,input);if(result.status!=="written")throw new Error(JSON.stringify(result));
  for(const commandId of result.commandIds){const row=await db.prepare("SELECT source_id,expected_source_instance_id,application_id,expected_history_epoch_id FROM project_alpha_directory_outbox WHERE command_id=?").bind(commandId).first<Record<string,string>>();
    await db.batch([db.prepare("UPDATE project_alpha_directory_outbox SET state='leased',lease_token='fixture',lease_expires_at=9999999999999 WHERE command_id=?").bind(commandId),
      db.prepare("UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=?")
        .bind(JSON.stringify({status:"acknowledged",response:{sourceInstanceId:row!.expected_source_instance_id,applicationId:row!.application_id,
          historyEpoch:row!.expected_history_epoch_id,result:{resource:{type:kind,id:value.recordId,publicId:publicIdValue,revision:revisionValue},
            data:{publicId:publicIdValue},authorizationGeneration:generation}}}),commandId)]);}
  await db.prepare("UPDATE operations_directory_intents SET state='acknowledged' WHERE mutation_id=?").bind(result.mutationId).run();return result;}
function writeInput(client:string,version:number,previous:{recordId:string;expectedRecordVersion:number}|null,organization:{recordId:string;expectedRecordVersion:number}|null,mutationId=uuid()):NativeDirectoryRelationshipWrite{
  return{mutationId,clientRecordId:client,expectedRelationshipVersion:version,expectedClientRecordVersion:1,previousOrganization:previous,organization,
    actor:{staffId:actor.staffId,accessSubject:actor.accessSubject,email:actor.email,admissionVersion:1,profileVersion:1}};}
function endpoint(action:"assign"|"move"|"remove"):ProjectAlphaApiV2Endpoint{return{method:"POST",path:`/api/v2/directory/clients/{publicId}/organization/${action}/commands`,requiredCapability:`directory.clients.organization.${action}`,requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true};}
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Request-ID":requestId}});}
function transport(action:"assign"|"move"|"remove",clientId:string,organizationId:string|null,revision:string,generation:string,status=200){return vi.fn<typeof fetch>(async(url,init)=>{
  const configured=String(url).includes("secondary")?{source:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",application:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",epoch:"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}:{source,application,epoch};
  if(String(url).endsWith("/capabilities"))return json({apiVersion:"2",sourceInstanceId:configured.source,applicationId:configured.application,historyEpoch:configured.epoch,requestId,
    grantedCapabilities:[{name:"api.capabilities.read"},{name:endpoint(action).requiredCapability}],implementedEndpoints:[{method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},endpoint(action)]});
  if(status!==200)return json({},status);
  return json({sourceInstanceId:configured.source,applicationId:configured.application,historyEpoch:configured.epoch,requestId,replayed:false,
    result:{action,client:{publicId:clientId,revision},organizationPublicId:organizationId,authorizationGeneration:generation}});});}

beforeAll(async()=>{runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});db=await runtime.getD1Database("OPS_DB") as D1Database;
  const directory=new URL("../migrations/",import.meta.url);for(const migration of readdirSync(directory).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&name.slice(0,4)<="0135").sort())
    try{await db.batch(splitD1MigrationStatements(readFileSync(new URL(migration,directory),"utf8")).map(sql=>db.prepare(sql)));}catch(error){throw new Error(`migration ${migration}: ${String(error)}`);}
  await db.batch([db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('owner','owner@example.test','Owner','access|owner','active')"),
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')").bind(actor.staffId,actor.email,"Relationship Actor",actor.accessSubject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,'owner')").bind(actor.staffId,actor.accessSubject),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(actor.staffId,actor.email,"Relationship Actor"),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?,?,'directory.profile.edit','allow','global','owner')").bind(actor.selectedGrantId,actor.staffId),
    db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?,?,'directory.identity.link','allow','global','owner')").bind(actor.selectedIdentityGrantId,actor.staffId),
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area','Area',1)"),db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES('division','area','Division',1)"),
    db.prepare("CREATE TABLE delivery_public_links(id TEXT PRIMARY KEY,url TEXT,payload BLOB)"),db.prepare("INSERT INTO delivery_public_links VALUES('keep','https://public.example.test/keep',x'00ff80')"),
    db.prepare("CREATE TABLE delivery_rows(id TEXT PRIMARY KEY,payload BLOB)"),db.prepare("INSERT INTO delivery_rows VALUES('keep',x'ff0080')")]);},240_000);
afterAll(async()=>runtime.dispose());

describe("native Directory relationship writer and outbox",()=>{
  it("assigns, moves, and removes with explicit versions, exact replay, and no public-link mutation",async()=>{const first=await create("organization"),second=await create("organization"),client=await create("client");
    const firstPublic=await acknowledge(first,"organization","1"),secondPublic=await acknowledge(second,"organization","2"),clientPublic=await acknowledge(client,"client","3");
    const before=await db.prepare("SELECT url,hex(payload) payload FROM delivery_public_links").first(),beforeDelivery=await db.prepare("SELECT hex(payload) payload FROM delivery_rows").first();
    const assignInput=writeInput(client.recordId,1,null,{recordId:first.recordId,expectedRecordVersion:1}),assigned=await writeNativeDirectoryRelationship(db,assignInput);
    expect(assigned).toMatchObject({status:"written",replayed:false,relationshipVersion:2,reservations:[{action:"assign",command:{expectedClientRevision:"1",expectedAuthorizationGeneration:"3",expectedCurrentOrganizationPublicId:null,organization:{publicId:firstPublic,expectedRevision:"1"}}}]});
    await expect(writeNativeDirectoryRelationship(db,assignInput)).resolves.toMatchObject({status:"written",replayed:true});
    await expect(writeNativeDirectoryRelationship(db,{...assignInput,organization:{recordId:second.recordId,expectedRecordVersion:1}})).resolves.toEqual({status:"conflict",reason:"idempotency_body_conflict"});
    if(assigned.status!=="written")throw new Error();const assignId=assigned.reservations[0]!.commandId;
    await expect(dispatchProjectAlphaDirectoryRelationshipCommand(env(),sourceId,assignId,transport("assign",clientPublic,firstPublic,"2","4"))).resolves.toMatchObject({status:"acknowledged",revision:"2"});
    const moved=await writeNativeDirectoryRelationship(db,writeInput(client.recordId,2,{recordId:first.recordId,expectedRecordVersion:1},{recordId:second.recordId,expectedRecordVersion:1}));
    expect(moved).toMatchObject({status:"written",relationshipVersion:3,reservations:[{action:"move",command:{expectedClientRevision:"2",expectedAuthorizationGeneration:"4",expectedCurrentOrganizationPublicId:firstPublic,organization:{publicId:secondPublic}}}]});
    if(moved.status!=="written")throw new Error();await expect(dispatchProjectAlphaDirectoryRelationshipCommand(env(),sourceId,moved.reservations[0]!.commandId,transport("move",clientPublic,secondPublic,"3","5"))).resolves.toMatchObject({status:"acknowledged"});
    const removed=await writeNativeDirectoryRelationship(db,writeInput(client.recordId,3,{recordId:second.recordId,expectedRecordVersion:1},null));
    expect(removed).toMatchObject({status:"written",relationshipVersion:4,reservations:[{action:"remove",command:{expectedClientRevision:"3",expectedAuthorizationGeneration:"5",expectedCurrentOrganizationPublicId:secondPublic,organization:null}}]});
    if(removed.status!=="written")throw new Error();await expect(dispatchProjectAlphaDirectoryRelationshipCommand(env(),sourceId,removed.reservations[0]!.commandId,transport("remove",clientPublic,null,"4","6"))).resolves.toMatchObject({status:"acknowledged"});
    expect(await db.prepare("SELECT organization_record_id,relationship_version FROM operations_directory_client_organizations WHERE client_record_id=?").bind(client.recordId).first()).toEqual({organization_record_id:null,relationship_version:4});
    expect(await db.prepare("SELECT url,hex(payload) payload FROM delivery_public_links").first()).toEqual(before);
    expect(await db.prepare("SELECT hex(payload) payload FROM delivery_rows").first()).toEqual(beforeDelivery);
  },60_000);

  it("rolls back the local mutation when one enrolled destination lacks matching organization evidence",async()=>{const organization=await create("organization"),client=await create("client",true);await acknowledge(organization,"organization","1");await acknowledge(client,"client","2");
    await expect(writeNativeDirectoryRelationship(db,writeInput(client.recordId,1,null,{recordId:organization.recordId,expectedRecordVersion:1}))).resolves.toEqual({status:"blocked",reason:"destination_mismatch"});
    expect(await db.prepare("SELECT organization_record_id,relationship_version FROM operations_directory_client_organizations WHERE client_record_id=?").bind(client.recordId).first()).toEqual({organization_record_id:null,relationship_version:1});
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_relationship_outbox WHERE client_record_id=?").bind(client.recordId).first("n")).toBe(0);
  });

  it("fails replay closed after a deny-aware grant revocation without returning reservation identifiers",async()=>{
    const organization=await create("organization"),client=await create("client");await acknowledge(organization,"organization","1");await acknowledge(client,"client","2");
    const input=writeInput(client.recordId,1,null,{recordId:organization.recordId,expectedRecordVersion:1});
    const written=await writeNativeDirectoryRelationship(db,input);expect(written).toMatchObject({status:"written",replayed:false});
    const deny=`deny-${uuid()}`;await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,granted_by) VALUES(?,?,'directory.identity.link','deny','business_area','area','owner')").bind(deny,actor.staffId).run();
    await expect(writeNativeDirectoryRelationship(db,input)).resolves.toEqual({status:"blocked",reason:"authority_or_race"});
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id=?").bind(deny).run();
    await expect(writeNativeDirectoryRelationship(db,input)).resolves.toMatchObject({status:"written",replayed:true});
  });

  it("accepts an organization with a superset of client destinations and canonical non-UUID IDs",async()=>{const organization=await create("organization",true,"ops/org/adopted-1001"),client=await create("client",false,"ops/client/adopted-1001");
    const organizationPublic=await acknowledge(organization,"organization","1"),clientPublic=await acknowledge(client,"client","2");
    const written=await writeNativeDirectoryRelationship(db,writeInput(client.recordId,1,null,{recordId:organization.recordId,expectedRecordVersion:1}));
    if(written.status!=="written")throw new Error(JSON.stringify(written));
    expect(written).toMatchObject({status:"written",reservations:[{command:{expectedClientRevision:"1",organization:{externalId:"ops/org/adopted-1001",publicId:organizationPublic}}}]});
    const acknowledgedGeneration=String(BigInt(written.reservations[0]!.command.expectedAuthorizationGeneration)+1n);
    await expect(dispatchProjectAlphaDirectoryRelationshipCommand(env(),sourceId,written.reservations[0]!.commandId,
      transport("assign",clientPublic,organizationPublic,"2",acknowledgedGeneration))).resolves.toMatchObject({status:"acknowledged"});
  });

  it("selects the numeric maximum when a current profile acknowledgement follows relationship evidence",async()=>{const first=await create("organization"),second=await create("organization"),client=await create("client");
    const firstPublic=await acknowledge(first,"organization","1"),secondPublic=await acknowledge(second,"organization","2"),clientPublic=await acknowledge(client,"client","3");
    const assigned=await writeNativeDirectoryRelationship(db,writeInput(client.recordId,1,null,{recordId:first.recordId,expectedRecordVersion:1}));
    if(assigned.status!=="written")throw new Error(JSON.stringify(assigned));
    const relationshipGeneration=String(BigInt(assigned.reservations[0]!.command.expectedAuthorizationGeneration)+1n);
    await dispatchProjectAlphaDirectoryRelationshipCommand(env(),sourceId,assigned.reservations[0]!.commandId,transport("assign",clientPublic,firstPublic,"2",relationshipGeneration));
    const profileGeneration=String(BigInt(relationshipGeneration)+1n);
    await updateAndAcknowledge(client,"client",clientPublic,relationshipGeneration,"10",profileGeneration,{organizationRecordId:first.recordId,expectedRelationshipVersion:2});
    const moved=await writeNativeDirectoryRelationship(db,{...writeInput(client.recordId,2,{recordId:first.recordId,expectedRecordVersion:1},
      {recordId:second.recordId,expectedRecordVersion:1}),expectedClientRecordVersion:2});
    expect(moved).toMatchObject({status:"written",reservations:[{command:{expectedClientRevision:"10",expectedAuthorizationGeneration:profileGeneration,
      organization:{publicId:secondPublic}}}]});
  });

  it("selects a newer bounded refresh revision after profile acknowledgement",()=>{
    expect(maximumDirectoryRevisionEvidence(["9","10"])).toBe("10");
    expect(maximumDirectoryRevisionEvidence(["10","09"])).toBeNull();
    expect(maximumDirectoryRevisionEvidence(["10","9223372036854775808"])).toBeNull();
  });

  it("ignores newer generation evidence from the same identity tuple at a different origin",async()=>{
    const wrongOrigin=await create("organization",false,uuid(),"https://other-pa.example.test");
    await acknowledge(wrongOrigin,"organization","999");
    const organization=await create("organization"),client=await create("client");
    await acknowledge(organization,"organization","100");await acknowledge(client,"client","101");
    const written=await writeNativeDirectoryRelationship(db,writeInput(client.recordId,1,null,
      {recordId:organization.recordId,expectedRecordVersion:1}));
    expect(written).toMatchObject({status:"written",reservations:[{command:{expectedAuthorizationGeneration:"101"}}]});
  });

  it("fails closed before transport when exact newer or incoherent public-ID evidence appears",async()=>{const organization=await create("organization"),client=await create("client"),organizationPublic=await acknowledge(organization,"organization","1");await acknowledge(client,"client","2");
    const pending=await writeNativeDirectoryRelationship(db,writeInput(client.recordId,1,null,{recordId:organization.recordId,expectedRecordVersion:1}));
    if(pending.status!=="written")throw new Error(JSON.stringify(pending));const send=vi.fn<typeof fetch>();
    const clientCommand=client.commandIds[0]!,outcome=JSON.parse(String(await db.prepare("SELECT outcome_json FROM project_alpha_directory_outbox WHERE command_id=?").bind(clientCommand).first("outcome_json")));
    outcome.response.result.resource.revision="2";
    await db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=? WHERE command_id=?").bind(JSON.stringify(outcome),clientCommand).run();
    await expect(dispatchProjectAlphaDirectoryRelationshipCommand(env(),sourceId,pending.reservations[0]!.commandId,send)).resolves.toEqual({status:"blocked",reason:"authority"});
    expect(send).not.toHaveBeenCalled();
    outcome.response.result.resource.publicId=organizationPublic;
    await db.prepare("UPDATE project_alpha_directory_outbox SET outcome_json=? WHERE command_id=?").bind(JSON.stringify(outcome),clientCommand).run();
    await expect(writeNativeDirectoryRelationship(db,writeInput(client.recordId,2,{recordId:organization.recordId,expectedRecordVersion:1},null))).resolves.toEqual({status:"blocked",reason:"mapping_evidence"});
  });

  it("requires and records explicit supersession of a terminal predecessor",async()=>{const first=await create("organization"),second=await create("organization"),client=await create("client");
    const firstPublic=await acknowledge(first,"organization","1"),secondPublic=await acknowledge(second,"organization","2"),clientPublic=await acknowledge(client,"client","3");
    const assigned=await writeNativeDirectoryRelationship(db,writeInput(client.recordId,1,null,{recordId:first.recordId,expectedRecordVersion:1}));
    if(assigned.status!=="written")throw new Error(JSON.stringify(assigned));const terminalId=assigned.reservations[0]!.commandId;
    await expect(dispatchProjectAlphaDirectoryRelationshipCommand(env(),sourceId,terminalId,transport("assign",clientPublic,firstPublic,"2","4",409))).resolves.toMatchObject({status:"conflict"});
    const reconciliation=writeInput(client.recordId,2,{recordId:first.recordId,expectedRecordVersion:1},{recordId:second.recordId,expectedRecordVersion:1});
    await expect(writeNativeDirectoryRelationship(db,reconciliation)).resolves.toEqual({status:"blocked",reason:"terminal_predecessor"});
    await expect(writeNativeDirectoryRelationship(db,{...reconciliation,mutationId:uuid(),supersedeTerminalCommandIds:[uuid()]}))
      .resolves.toEqual({status:"blocked",reason:"terminal_predecessor"});
    const recovered=await writeNativeDirectoryRelationship(db,{...reconciliation,mutationId:uuid(),supersedeTerminalCommandIds:[terminalId]});
    expect(recovered).toMatchObject({status:"written",reservations:[{action:"move"}]});if(recovered.status!=="written")throw new Error(JSON.stringify(recovered));
    expect(await db.prepare("SELECT supersedes_terminal_command_id FROM project_alpha_directory_relationship_outbox WHERE command_id=?")
      .bind(recovered.reservations[0]!.commandId).first("supersedes_terminal_command_id")).toBe(terminalId);
    const recoveredGeneration=String(BigInt(recovered.reservations[0]!.command.expectedAuthorizationGeneration)+1n);
    const dispatched=await dispatchProjectAlphaDirectoryRelationshipCommand(env(),sourceId,recovered.reservations[0]!.commandId,
      transport("move",clientPublic,secondPublic,"2",recoveredGeneration));if(dispatched.status!=="acknowledged")throw new Error(JSON.stringify({dispatched,command:recovered.reservations[0]!.command}));
    expect(await db.prepare("SELECT state FROM project_alpha_directory_relationship_outbox WHERE command_id=?").bind(terminalId).first("state")).toBe("terminal");
  });

  it("retries an outage with the identical command and distinguishes a remote conflict",async()=>{const organization=await create("organization"),client=await create("client"),organizationPublic=await acknowledge(organization,"organization","1"),clientPublic=await acknowledge(client,"client","2");
    const written=await writeNativeDirectoryRelationship(db,writeInput(client.recordId,1,null,{recordId:organization.recordId,expectedRecordVersion:1}));if(written.status!=="written")throw new Error(JSON.stringify(written));const id=written.reservations[0]!.commandId;
    const acknowledgedGeneration=String(BigInt(written.reservations[0]!.command.expectedAuthorizationGeneration)+1n);
    const failed=transport("assign",clientPublic,organizationPublic,"2",acknowledgedGeneration,500);await expect(dispatchProjectAlphaDirectoryRelationshipCommand(env(),sourceId,id,failed)).resolves.toMatchObject({status:"uncertain",reason:"http_status",httpStatus:500});
    const body=await db.prepare("SELECT command_json FROM project_alpha_directory_relationship_outbox WHERE command_id=?").bind(id).first("command_json");await db.prepare("UPDATE project_alpha_directory_relationship_outbox SET next_attempt_at=0 WHERE command_id=?").bind(id).run();
    const recovered=await dispatchProjectAlphaDirectoryRelationshipCommand(env(),sourceId,id,transport("assign",clientPublic,organizationPublic,"2",acknowledgedGeneration));
    expect(recovered).toMatchObject({status:"acknowledged"});
    expect(await db.prepare("SELECT command_json FROM project_alpha_directory_relationship_outbox WHERE command_id=?").bind(id).first("command_json")).toBe(body);
    const otherOrg=await create("organization"),otherClient=await create("client");await acknowledge(otherOrg,"organization","4");await acknowledge(otherClient,"client","5");const conflict=await writeNativeDirectoryRelationship(db,writeInput(otherClient.recordId,1,null,{recordId:otherOrg.recordId,expectedRecordVersion:1}));if(conflict.status!=="written")throw new Error(JSON.stringify(conflict));
    await expect(dispatchProjectAlphaDirectoryRelationshipCommand(env(),sourceId,conflict.reservations[0]!.commandId,transport("assign","f".repeat(32),"e".repeat(32),"2","6",409))).resolves.toMatchObject({status:"conflict",reason:"remote",httpStatus:409});
    expect(await db.prepare("SELECT state FROM project_alpha_directory_relationship_outbox WHERE command_id=?").bind(conflict.reservations[0]!.commandId).first("state")).toBe("terminal");
  },60_000);

  it("dispatcher fails closed when the local relationship becomes stale before send",async()=>{const organization=await create("organization"),client=await create("client");await acknowledge(organization,"organization","1");await acknowledge(client,"client","2");const pending=await writeNativeDirectoryRelationship(db,writeInput(client.recordId,1,null,{recordId:organization.recordId,expectedRecordVersion:1}));if(pending.status!=="written")throw new Error(JSON.stringify(pending));
    const send=vi.fn<typeof fetch>();await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?,?,'directory.identity.link','deny','global','owner')").bind(`deny-${uuid()}`,actor.staffId).run();
    await expect(dispatchProjectAlphaDirectoryRelationshipCommand(env(),sourceId,pending.reservations[0]!.commandId,send)).resolves.toEqual({status:"blocked",reason:"authority"});expect(send).not.toHaveBeenCalled();
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE staff_id=? AND permission='directory.identity.link' AND effect='deny'").bind(actor.staffId).run();
    const mutationId=uuid(),until=new Date(Date.now()+60_000).toISOString();await db.batch([db.prepare(`INSERT INTO operations_directory_relationship_write_fences(mutation_id,client_record_id,expected_relationship_version,previous_organization_record_id,organization_record_id,client_record_version,previous_organization_record_version,organization_record_version,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version,verified_until) VALUES(?,?,2,?,NULL,1,1,NULL,?,?,?,?,?,?)`).bind(mutationId,client.recordId,organization.recordId,actor.staffId,actor.accessSubject,actor.email,1,1,until),
      db.prepare("UPDATE operations_directory_client_organizations SET organization_record_id=NULL,relationship_version=3 WHERE client_record_id=? AND relationship_version=2").bind(client.recordId),db.prepare("DELETE FROM operations_directory_relationship_write_fences WHERE mutation_id=?").bind(mutationId)]);
    await expect(dispatchProjectAlphaDirectoryRelationshipCommand(env(),sourceId,pending.reservations[0]!.commandId,send)).resolves.toEqual({status:"blocked",reason:"authority"});expect(send).not.toHaveBeenCalled();
  });
});
