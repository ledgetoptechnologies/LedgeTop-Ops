import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite } from "../src/worker/native-directory-profile-writer";
import { writeNativeDirectoryLifecycle, type NativeDirectoryLifecycleWrite } from "../src/worker/native-directory-lifecycle-writer";
import { persistProjectAlphaDirectoryInventoryPage } from "../src/worker/project-alpha-v2-sync";
import { dispatchProjectAlphaDirectoryLifecycleCommand } from "../src/worker/project-alpha-directory-lifecycle-outbox-dispatcher";

let runtime:Miniflare,db:D1Database,sequence=1,legacyRecord:Awaited<ReturnType<typeof createRecord>>;
const source="project-alpha:primary",source2="project-alpha:ltt",instance="11111111-1111-4111-8111-111111111111",
  instance2="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",application="22222222-2222-4222-8222-222222222222",
  application2="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",epoch="33333333-3333-4333-8333-333333333333",
  epoch2="cccccccc-cccc-4ccc-8ccc-cccccccccccc",origin="https://pa.example.test",origin2="https://ltt-pa.example.test";
const uuid=()=>`00000000-0000-4000-8000-${String(sequence++).padStart(12,"0")}`;
const publicId=()=>String(sequence++).padStart(32,"0");
const actor={staffId:"staff-lifecycle",accessSubject:"access|lifecycle",admissionVersion:1,loginEmail:"life@example.test",profileVersion:1,
  selectedGrantId:"grant-profile",selectedIdentityGrantId:"grant-identity",selectedProfileGrantId:"grant-profile",selectedEnrollmentGrantId:"grant-enrollment",
  verifiedUntil:new Date(Date.now()+60*60_000).toISOString()} as const;
const profileActor={staffId:actor.staffId,accessSubject:actor.accessSubject,admissionVersion:actor.admissionVersion,
  selectedGrantId:actor.selectedGrantId,loginEmail:actor.loginEmail,profileVersion:actor.profileVersion,
  selectedIdentityGrantId:actor.selectedIdentityGrantId} as const;
const destination=(recordId:string,second=false)=>({sourceId:second?source2:source,sourceInstanceUUID:second?instance2:instance,
  applicationUUID:second?application2:application,historyEpoch:second?epoch2:epoch,origin:second?origin2:origin,
  externalCanonicalId:recordId,expectedAuthorizationGeneration:"0"});
const profile={name:"Lifecycle Organization",generalEmail:"life@example.test",generalPhone:"512-555-0100",addressLine1:"1 Main",
  addressLine2:"",city:"Austin",state:"TX",postalCode:"78701",country:"US"} as const;

async function migrationsThrough(max:string){const directory=new URL("../migrations/",import.meta.url);
  for(const migration of readdirSync(directory).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&name.slice(0,4)<=max).sort())
    await db.batch(splitD1MigrationStatements(readFileSync(new URL(migration,directory),"utf8")).map(sql=>db.prepare(sql)));
}
async function applyMigration(name:string){const url=new URL(`../migrations/${name}`,import.meta.url);
  await db.batch(splitD1MigrationStatements(readFileSync(url,"utf8")).map(sql=>db.prepare(sql)));}
async function createRecord(two=false){const recordId=uuid(),mutationId=uuid(),admission=`admission-${mutationId}`;
  const destinations=[destination(recordId),...(two?[destination(recordId,true)]:[])]
    .sort((left,right)=>`${left.sourceId}\0${left.sourceInstanceUUID}\0${left.applicationUUID}`.localeCompare(`${right.sourceId}\0${right.sourceInstanceUUID}\0${right.applicationUUID}`));
  const input={operation:"create",mutationId,recordId,expectedLocalVersion:0,kind:"organization",createAdmissionId:admission,profile,
    scopes:[{businessAreaId:"area",divisionId:"division"}],destinations,actor:profileActor} as NativeDirectoryCreateWrite;
  await db.prepare(`INSERT INTO native_directory_create_admissions
    (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(admission,actor.staffId,actor.accessSubject,recordId,"organization",JSON.stringify(input.scopes),
      JSON.stringify(profile),JSON.stringify(destinations.map(({expectedAuthorizationGeneration:_,...value})=>value)),actor.staffId).run();
  const result=await writeNativeDirectoryProfile(db,input);if(result.status!=="written")throw new Error(JSON.stringify(result));
  for(let index=0;index<result.commandIds.length;index++){const commandId=result.commandIds[index]!,row=await db.prepare(`SELECT source_id,
      expected_source_instance_id,application_id,expected_history_epoch_id,destination_base_url FROM project_alpha_directory_outbox WHERE command_id=?`)
      .bind(commandId).first<Record<string,string>>(),d=destinations.find(value=>value.sourceId===row!.source_id
        &&value.sourceInstanceUUID===row!.expected_source_instance_id&&value.applicationUUID===row!.application_id)!,id=publicId(),generation="1";
    await db.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',lease_token='lease',lease_expires_at=9999999999999 WHERE command_id=?`).bind(commandId).run();
    await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,
      source_instance_id,application_id,history_epoch_id,command_id) VALUES(?,'organization',?,?,?,?,?,?)`)
      .bind(d.sourceId,recordId,id,d.sourceInstanceUUID,d.applicationUUID,d.historyEpoch,commandId).run();
    const response={status:"acknowledged",response:{requestId:commandId,replayed:false,sourceInstanceId:d.sourceInstanceUUID,
      applicationId:d.applicationUUID,historyEpoch:d.historyEpoch,result:{resource:{type:"organization",id:recordId,publicId:id,revision:"1"},
      data:{publicId:id},authorizationGeneration:generation}}};
    await db.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=?`)
      .bind(JSON.stringify(response),commandId).run();
    const requestId=uuid();
    const observed=await persistProjectAlphaDirectoryInventoryPage(db,{authoritative:false,sourceId:d.sourceId,
      sourceInstanceId:d.sourceInstanceUUID,applicationId:d.applicationUUID,historyEpoch:d.historyEpoch,requestId,
      authorizationGeneration:generation,nextCursor:null,resources:[{type:"organization",publicId:id,revision:"1",present:true,
        lastAction:"upsert",projectionSha256:"a".repeat(64),binding:{externalId:recordId,status:"active",resourceRevision:"1"}}]},null);
    if(observed.status==="blocked")throw new Error(JSON.stringify(observed));
  }
  await db.prepare("UPDATE operations_directory_intents SET state='acknowledged' WHERE mutation_id=?").bind(mutationId).run();
  return{recordId,input};
}
async function refreshObservation(created:Awaited<ReturnType<typeof createRecord>>,generation:string){
  for(const d of created.input.destinations){const id=await db.prepare(`SELECT project_alpha_public_id FROM project_alpha_active_directory_mappings
      WHERE record_id=? AND source_id=? AND source_instance_id=? AND application_id=?`).bind(created.recordId,d.sourceId,d.sourceInstanceUUID,d.applicationUUID)
      .first<string>("project_alpha_public_id"),requestId=uuid();
    if(!id)throw new Error("missing fixture mapping");
    const observed=await persistProjectAlphaDirectoryInventoryPage(db,{authoritative:false,sourceId:d.sourceId,
      sourceInstanceId:d.sourceInstanceUUID,applicationId:d.applicationUUID,historyEpoch:d.historyEpoch,requestId,
      authorizationGeneration:generation,nextCursor:null,resources:[{type:"organization",publicId:id,revision:"1",present:true,
        lastAction:"upsert",projectionSha256:"a".repeat(64),binding:{externalId:created.recordId,status:"active",resourceRevision:"1"}}]},null);
    if(observed.status==="blocked")throw new Error(JSON.stringify(observed));
  }
}
function lifecycle(recordId:string,action:"archive"|"restore"="archive",mutationId=uuid()):NativeDirectoryLifecycleWrite{return{mutationId,recordId,
  kind:"organization",action,expectedLifecycleVersion:0,expectedRecordVersion:1,actor:{staffId:actor.staffId,accessSubject:actor.accessSubject,
    admissionVersion:1,loginEmail:actor.loginEmail,profileVersion:1,selectedProfileGrantId:actor.selectedProfileGrantId,
    selectedEnrollmentGrantId:actor.selectedEnrollmentGrantId,verifiedUntil:actor.verifiedUntil}};}

beforeAll(async()=>{runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});
  db=await runtime.getD1Database("OPS_DB") as D1Database;await migrationsThrough("0200");
  await db.batch([db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('owner','owner@example.test','Owner','access|owner','active')"),
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')").bind(actor.staffId,actor.loginEmail,"Lifecycle",actor.accessSubject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,'owner')").bind(actor.staffId,actor.accessSubject),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(actor.staffId,actor.loginEmail,"Lifecycle"),
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area','Area',1)"),
    db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES('division','area','Division',1)"),
    ...[[actor.selectedGrantId,"directory.profile.edit"],[actor.selectedIdentityGrantId,"directory.identity.link"],[actor.selectedEnrollmentGrantId,"directory.enrollment.manage"]]
      .map(([id,permission])=>db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by)
        VALUES(?, ?, ?, 'allow','global','owner')`).bind(id,actor.staffId,permission)),
    db.prepare("CREATE TABLE lifecycle_delivery_fixture(id TEXT PRIMARY KEY,payload BLOB)"),
    db.prepare("CREATE TABLE lifecycle_public_link_fixture(id TEXT PRIMARY KEY,url TEXT,payload BLOB)"),
    db.prepare("INSERT INTO lifecycle_delivery_fixture VALUES('keep',x'ff0080')"),
    db.prepare("INSERT INTO lifecycle_public_link_fixture VALUES('keep','https://public.example.test/keep',x'00ff80')")]);
  legacyRecord=await createRecord(true);
  await applyMigration("0201_native_directory_lifecycle.sql");
  await db.prepare(`CREATE VIEW effective_native_directory_enrollments AS
    SELECT record_id,destinations_json,0 enrollment_version,'native_create' enrollment_kind,
      create_admission_id provenance_id,created_at
    FROM native_directory_enrollments`).run();
},240_000);
afterAll(async()=>runtime.dispose());

describe("native Directory lifecycle writer",()=>{
  it("enrolls a pre-migration record only from fresh exact PA observations without changing related data",async()=>{
    const created=legacyRecord,relationshipBefore=(await db.prepare("SELECT * FROM operations_directory_client_organizations").all()).results,
      deliveryBefore=(await db.prepare("SELECT id,hex(payload) payload FROM lifecycle_delivery_fixture").all()).results,
      linkBefore=(await db.prepare("SELECT id,url,hex(payload) payload FROM lifecycle_public_link_fixture").all()).results;
    expect(await db.prepare("SELECT * FROM operations_directory_lifecycle_state WHERE record_id=?").bind(created.recordId).first()).toBeNull();
    const input=lifecycle(created.recordId),result=await writeNativeDirectoryLifecycle(db,input);
    expect(result).toMatchObject({status:"written",replayed:false,lifecycleVersion:1,lifecycleStatus:"archive_pending",
      reservations:[{sourceId:source2},{sourceId:source}]});
    await expect(writeNativeDirectoryLifecycle(db,{...input,actor:{...input.actor,
      verifiedUntil:new Date(Date.parse(input.actor.verifiedUntil)+60_000).toISOString()}})).resolves.toMatchObject({status:"written",replayed:true});
    expect(await db.prepare("SELECT status,lifecycle_version FROM operations_directory_lifecycle_state WHERE record_id=?").bind(created.recordId).first())
      .toEqual({status:"archive_pending",lifecycle_version:1});
    await expect(db.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_commands(command_id,record_id,external_id)
      VALUES(?,?,?)`).bind(uuid(),created.recordId,`pa/external/${uuid()}`).run()).rejects.toThrow(/lifecycle blocks binding acquisition command/);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_lifecycle_outbox WHERE mutation_id=?").bind(input.mutationId).first("n")).toBe(2);
    expect((await db.prepare("SELECT * FROM operations_directory_client_organizations").all()).results).toEqual(relationshipBefore);
    expect((await db.prepare("SELECT id,hex(payload) payload FROM lifecycle_delivery_fixture").all()).results).toEqual(deliveryBefore);
    expect((await db.prepare("SELECT id,url,hex(payload) payload FROM lifecycle_public_link_fixture").all()).results).toEqual(linkBefore);
  },180_000);

  it("initializes new native records active and applies the maximum known destination generation",async()=>{
    const newer=await createRecord(),target=await createRecord();
    expect(await db.prepare("SELECT lifecycle_version,status FROM operations_directory_lifecycle_state WHERE record_id=?").bind(target.recordId).first())
      .toEqual({lifecycle_version:0,status:"active"});
    expect(newer.recordId).not.toBe(target.recordId);
    await refreshObservation(target,"9");
    const result=await writeNativeDirectoryLifecycle(db,lifecycle(target.recordId));
    expect(result).toMatchObject({status:"written",reservations:[{command:{expectedAuthorizationGeneration:"9"}}]});
  },180_000);

  it("fails atomically when authority changes at the batch boundary",async()=>{
    const target=await createRecord(),input=lifecycle(target.recordId);let batches=0;
    await expect(writeNativeDirectoryLifecycle(db,{...input,mutationId:uuid(),actor:{...input.actor,verifiedUntil:"2026-01-01T00:00:00.000Z"}}))
      .resolves.toEqual({status:"rejected",reason:"invalid_write"});
    await expect(writeNativeDirectoryLifecycle(db,{...input,mutationId:uuid(),actor:{...input.actor,verifiedUntil:"2026-10-12T00:00:00Z"}}))
      .resolves.toEqual({status:"rejected",reason:"invalid_write"});
    const racing=new Proxy(db,{get(value,key){if(key==="batch")return async(statements:D1PreparedStatement[])=>{
      if(++batches===1)await value.prepare("UPDATE native_directory_grants SET active=0 WHERE id=?").bind(actor.selectedEnrollmentGrantId).run();
      return value.batch(statements);};const member=value[key as keyof D1Database];return typeof member==="function"?member.bind(value):member;}}) as D1Database;
    await expect(writeNativeDirectoryLifecycle(racing,input)).resolves.toEqual({status:"blocked",reason:"atomic_write"});
    expect(await db.prepare("SELECT 1 FROM operations_directory_lifecycle_events WHERE mutation_id=?").bind(input.mutationId).first()).toBeNull();
    expect(await db.prepare("SELECT lifecycle_version,status FROM operations_directory_lifecycle_state WHERE record_id=?").bind(target.recordId).first())
      .toEqual({lifecycle_version:0,status:"active"});
    await db.prepare("UPDATE native_directory_grants SET active=1 WHERE id=?").bind(actor.selectedEnrollmentGrantId).run();
  },180_000);

  it("keeps partial terminal lifecycle work pending and blocks successor profile/lifecycle writes",async()=>{
    const target=await createRecord(true),input=lifecycle(target.recordId),result=await writeNativeDirectoryLifecycle(db,input);
    if(result.status!=="written")throw new Error(JSON.stringify(result));
    const [first]=result.reservations;
    await db.prepare(`UPDATE project_alpha_directory_lifecycle_outbox SET state='leased',attempts=attempts+1,lease_token='conflict-lease',
      lease_expires_at=9999999999999 WHERE command_id=?`).bind(first!.commandId).run();
    await db.prepare(`UPDATE project_alpha_directory_lifecycle_outbox SET state='terminal',outcome_json='{"status":"conflict"}',
      lease_token=NULL,lease_expires_at=NULL WHERE command_id=?`)
      .bind(first!.commandId).run();
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_lifecycle_outbox WHERE mutation_id=? AND state='pending'")
      .bind(input.mutationId).first("n")).toBe(1);
    const remaining=result.reservations.find(reservation=>reservation.commandId!==first!.commandId)!,send=vi.fn();
    await expect(dispatchProjectAlphaDirectoryLifecycleCommand({OPS_DB:db,PROJECT_ALPHA_DIRECTORY_LIFECYCLE_ENABLED:"true"},
      remaining.sourceId,remaining.commandId,send)).resolves.toEqual({status:"conflict"});
    expect(send).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT state,attempts,lease_token FROM project_alpha_directory_lifecycle_outbox WHERE command_id=?")
      .bind(remaining.commandId).first()).toEqual({state:"pending",attempts:0,lease_token:null});
    await expect(writeNativeDirectoryLifecycle(db,{...lifecycle(target.recordId),expectedLifecycleVersion:1})).resolves.toEqual({status:"conflict",reason:"state"});
    const update={...target.input,operation:"update" as const,mutationId:uuid(),expectedLocalVersion:1,createAdmissionId:null,
      destinations:target.input.destinations,actor:profileActor};
    await expect(writeNativeDirectoryProfile(db,update)).resolves.toMatchObject({status:"blocked"});
    expect(await db.prepare("SELECT status FROM operations_directory_lifecycle_state WHERE record_id=?").bind(target.recordId).first("status"))
      .toBe("archive_pending");
  },180_000);

  it("loses the lease CAS without sending when a sibling becomes terminal after the initial read",async()=>{
    const target=await createRecord(true),written=await writeNativeDirectoryLifecycle(db,lifecycle(target.recordId));
    if(written.status!=="written")throw new Error(JSON.stringify(written));
    const candidate=written.reservations[0]!,sibling=written.reservations[1]!;
    let injected=false;
    const racing=new Proxy(db,{get(value,key){if(key==="prepare")return(sql:string)=>{
      const prepared=value.prepare(sql);
      if(!sql.includes("terminal_sibling"))return prepared;
      return{bind(...bindings:unknown[]){const bound=prepared.bind(...bindings);return{async first<T>(column?:string){
        const selected=await (column===undefined?bound.first<T>():bound.first<T>(column));if(!injected){injected=true;
          await value.prepare(`UPDATE project_alpha_directory_lifecycle_outbox SET state='leased',attempts=attempts+1,
            lease_token='racing-terminal',lease_expires_at=9999999999999 WHERE command_id=?`).bind(sibling.commandId).run();
          await value.prepare(`UPDATE project_alpha_directory_lifecycle_outbox SET state='terminal',outcome_json='{"status":"conflict"}',
            lease_token=NULL,lease_expires_at=NULL WHERE command_id=?`).bind(sibling.commandId).run();}
        return selected;}} as D1PreparedStatement;}} as D1PreparedStatement;};
      const member=value[key as keyof D1Database];return typeof member==="function"?member.bind(value):member;}}) as D1Database;
    const connections={version:1,instances:{[source]:{sourceId:source,enabled:true,baseUrl:origin,apiKey:"secret",
      sourceInstanceId:instance,applicationId:application,historyEpoch:epoch},[source2]:{sourceId:source2,enabled:true,baseUrl:origin2,
      apiKey:"secret",sourceInstanceId:instance2,applicationId:application2,historyEpoch:epoch2}}},send=vi.fn();
    await expect(dispatchProjectAlphaDirectoryLifecycleCommand({OPS_DB:racing,PROJECT_ALPHA_DIRECTORY_LIFECYCLE_ENABLED:"true",
      PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify(connections)},candidate.sourceId,candidate.commandId,send))
      .resolves.toEqual({status:"blocked",reason:"in_progress"});
    expect(injected).toBe(true);expect(send).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT state,attempts,lease_token FROM project_alpha_directory_lifecycle_outbox WHERE command_id=?")
      .bind(candidate.commandId).first()).toEqual({state:"pending",attempts:0,lease_token:null});
  },180_000);

  it("dispatches the candidate PA archive contract and settles the final archived state",async()=>{
    const target=await createRecord(),input=lifecycle(target.recordId),written=await writeNativeDirectoryLifecycle(db,input);
    if(written.status!=="written")throw new Error(JSON.stringify(written));
    const reservation=written.reservations[0]!,requestId=uuid(),send=async(url:RequestInfo|URL,init?:RequestInit)=>{
      expect(String(url)).toBe(`${origin}/api/v2/directory/organizations/${(await db.prepare("SELECT project_alpha_public_id FROM project_alpha_directory_lifecycle_outbox WHERE command_id=?").bind(reservation.commandId).first("project_alpha_public_id"))}/archive/commands`);
      expect(init?.body).toBe(JSON.stringify(reservation.command));
      return new Response(JSON.stringify({sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,requestId,replayed:false,
        result:{action:"archive",resource:{type:"organization",publicId:await db.prepare("SELECT project_alpha_public_id FROM project_alpha_directory_lifecycle_outbox WHERE command_id=?").bind(reservation.commandId).first("project_alpha_public_id"),revision:"2",present:false},authorizationGeneration:"2"}}),
        {status:200,headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Request-ID":requestId}});
    };
    const env={OPS_DB:db,PROJECT_ALPHA_DIRECTORY_LIFECYCLE_ENABLED:"true",PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[source]:{sourceId:source,enabled:true,
      baseUrl:origin,apiKey:"secret",sourceInstanceId:instance,applicationId:application,historyEpoch:epoch}}})};
    await expect(dispatchProjectAlphaDirectoryLifecycleCommand(env,source,reservation.commandId,send)).resolves.toMatchObject({status:"acknowledged",revision:"2"});
    expect(await db.prepare("SELECT status FROM operations_directory_lifecycle_state WHERE record_id=?").bind(target.recordId).first("status")).toBe("archived");
    const restoreInput={...lifecycle(target.recordId,"restore"),expectedLifecycleVersion:1},restore=await writeNativeDirectoryLifecycle(db,restoreInput);
    if(restore.status!=="written")throw new Error(JSON.stringify(restore));
    const restoreReservation=restore.reservations[0]!,restoreRequestId=uuid(),restoreSend=async()=>new Response(JSON.stringify({sourceInstanceId:instance,
      applicationId:application,historyEpoch:epoch,requestId:restoreRequestId,replayed:false,result:{action:"restore",
        resource:{type:"organization",publicId:await db.prepare("SELECT project_alpha_public_id FROM project_alpha_directory_lifecycle_outbox WHERE command_id=?")
          .bind(restoreReservation.commandId).first("project_alpha_public_id"),revision:"3",present:true},authorizationGeneration:"2"}}),
      {status:200,headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Request-ID":restoreRequestId}});
    await expect(dispatchProjectAlphaDirectoryLifecycleCommand(env,source,restoreReservation.commandId,restoreSend)).resolves.toMatchObject({status:"acknowledged",revision:"3"});
    expect(await db.prepare("SELECT status FROM operations_directory_lifecycle_state WHERE record_id=?").bind(target.recordId).first("status")).toBe("restored_unbound");
    await expect(db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts(activation_id,record_id,external_id)
      VALUES(?,?,?)`).bind(uuid(),target.recordId,`pa/external/${uuid()}`).run()).rejects.toThrow(/lifecycle blocks acquired binding activation/);
    await expect(dispatchProjectAlphaDirectoryLifecycleCommand(env,source2,restoreReservation.commandId,restoreSend)).resolves.toEqual({status:"conflict"});
  },180_000);

  it("fails closed on malformed, oversized, timed-out, and lost-lease acknowledgements",async()=>{
    const env={OPS_DB:db,PROJECT_ALPHA_DIRECTORY_LIFECYCLE_ENABLED:"true",
      PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[source]:{sourceId:source,enabled:true,baseUrl:origin,apiKey:"secret",
        sourceInstanceId:instance,applicationId:application,historyEpoch:epoch}}})},reservation=async()=>{
      const target=await createRecord();await refreshObservation(target,"9");const written=await writeNativeDirectoryLifecycle(db,lifecycle(target.recordId));
      if(written.status!=="written")throw new Error(JSON.stringify(written));
      const commandId=written.reservations[0]!.commandId,publicValue=await db.prepare("SELECT project_alpha_public_id FROM project_alpha_directory_lifecycle_outbox WHERE command_id=?")
        .bind(commandId).first<string>("project_alpha_public_id");
      return{target,commandId,response:(requestId:string,generation:string)=>new Response(JSON.stringify({sourceInstanceId:instance,
        applicationId:application,historyEpoch:epoch,requestId,replayed:false,result:{action:"archive",resource:{type:"organization",
          publicId:publicValue,revision:"2",present:false},authorizationGeneration:generation}}),
        {status:200,headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Request-ID":requestId}})};};
    let current=await reservation();
    const malformedId=uuid();
    await expect(dispatchProjectAlphaDirectoryLifecycleCommand(env,source,current.commandId,async()=>current.response(malformedId,"01"))).resolves
      .toEqual({status:"uncertain",reason:"contract"});
    current=await reservation();
    await expect(dispatchProjectAlphaDirectoryLifecycleCommand(env,source,current.commandId,async()=>new Response("{}",{status:200,
      headers:{"Content-Length":"70000","X-Request-ID":uuid()}}))).resolves.toEqual({status:"uncertain",reason:"response_limit"});
    current=await reservation();
    await expect(dispatchProjectAlphaDirectoryLifecycleCommand(env,source,current.commandId,async(_url,init)=>new Promise<Response>((_resolve,reject)=>{
      init?.signal?.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError")),{once:true});}))).resolves
      .toEqual({status:"uncertain",reason:"transport"});
    current=await reservation();
    const stalledId=uuid();
    await expect(dispatchProjectAlphaDirectoryLifecycleCommand(env,source,current.commandId,async(_url,init)=>new Response(new ReadableStream<Uint8Array>({
      start(controller){init?.signal?.addEventListener("abort",()=>controller.error(new DOMException("Aborted","AbortError")),{once:true});
        controller.enqueue(new TextEncoder().encode("{"));}}),{status:200,headers:{"Content-Type":"application/json","Cache-Control":"no-store","X-Request-ID":stalledId}})))
      .resolves.toEqual({status:"uncertain",reason:"transport"});
    current=await reservation();
    const lateId=uuid();
    const lostLeaseDb=new Proxy(db,{get(value,key){if(key==="batch")return async(_statements:D1PreparedStatement[])=>
      [{meta:{changes:0}},{meta:{changes:0}}] as unknown as D1Result<unknown>[];
      const member=value[key as keyof D1Database];return typeof member==="function"?member.bind(value):member;}}) as D1Database;
    await expect(dispatchProjectAlphaDirectoryLifecycleCommand({...env,OPS_DB:lostLeaseDb},source,current.commandId,
      async()=>current.response(lateId,"9"))).resolves.toEqual({status:"uncertain",reason:"lost_lease"});
    expect(await db.prepare("SELECT status FROM operations_directory_lifecycle_state WHERE record_id=?").bind(current.target.recordId).first("status")).toBe("archive_pending");
  },180_000);

  it("rejects incomplete and non-canonical direct-SQL acknowledgements without losing the lease",async()=>{
    const target=await createRecord();await refreshObservation(target,"9");
    const written=await writeNativeDirectoryLifecycle(db,lifecycle(target.recordId));
    if(written.status!=="written")throw new Error(JSON.stringify(written));
    const commandId=written.reservations[0]!.commandId,row=await db.prepare(`SELECT source_instance_id,application_id,history_epoch_id,
      project_alpha_public_id,expected_revision,expected_authorization_generation FROM project_alpha_directory_lifecycle_outbox WHERE command_id=?`)
      .bind(commandId).first<Record<string,string>>();
    if(!row)throw new Error("missing lifecycle reservation");
    const sourceInstanceId=row.source_instance_id!,applicationId=row.application_id!,historyEpoch=row.history_epoch_id!,
      projectAlphaPublicId=row.project_alpha_public_id!,expectedRevision=row.expected_revision!,
      expectedAuthorizationGeneration=row.expected_authorization_generation!;
    await db.prepare(`UPDATE project_alpha_directory_lifecycle_outbox SET state='leased',attempts=attempts+1,lease_token='direct-sql-lease',
      lease_expires_at=9999999999999 WHERE command_id=?`).bind(commandId).run();
    const valid={status:"acknowledged",response:{sourceInstanceId,applicationId,historyEpoch,requestId:uuid(),replayed:false,
      result:{action:"archive",resource:{type:"organization",publicId:projectAlphaPublicId,
        revision:String(BigInt(expectedRevision)+1n),present:false},authorizationGeneration:expectedAuthorizationGeneration}}};
    const invalid:Array<unknown>=[
      (()=>{const value=structuredClone(valid);delete (value.response as Partial<typeof valid.response>).sourceInstanceId;return value;})(),
      (()=>{const value=structuredClone(valid),response=value.response as unknown as Record<string,unknown>;
        response.sourceInstance=response.sourceInstanceId;delete response.sourceInstanceId;return value;})(),
      (()=>{const value=structuredClone(valid);(value.response as unknown as Record<string,unknown>).sourceInstanceId=null;return value;})(),
      (()=>{const value=structuredClone(valid);value.response.result.authorizationGeneration="1junk";return value;})(),
      (()=>{const value=structuredClone(valid);value.response.result.authorizationGeneration="01";return value;})(),
      (()=>{const value=structuredClone(valid);value.response.result.resource.revision=expectedRevision;return value;})(),
      (()=>{const value=structuredClone(valid);delete (value.response as Partial<typeof valid.response>).requestId;return value;})(),
      (()=>{const value=structuredClone(valid);value.response.requestId=null as unknown as string;return value;})()
    ];
    for(const outcome of invalid){
      await expect(db.prepare(`UPDATE project_alpha_directory_lifecycle_outbox SET state='acknowledged',outcome_json=?,
        lease_token=NULL,lease_expires_at=NULL WHERE command_id=?`).bind(JSON.stringify(outcome),commandId).run()).rejects.toThrow();
      expect(await db.prepare(`SELECT state,lease_token FROM project_alpha_directory_lifecycle_outbox WHERE command_id=?`).bind(commandId).first())
        .toEqual({state:"leased",lease_token:"direct-sql-lease"});
    }
    const validJson=JSON.stringify(valid);
    await db.prepare(`UPDATE project_alpha_directory_lifecycle_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,
      lease_expires_at=NULL WHERE command_id=?`).bind(validJson,commandId).run();
    expect(await db.prepare("SELECT status FROM operations_directory_lifecycle_state WHERE record_id=?").bind(target.recordId).first("status")).toBe("archive_pending");
    await expect(db.prepare(`UPDATE project_alpha_directory_lifecycle_outbox SET outcome_json=? WHERE command_id=?`)
      .bind(JSON.stringify({...valid,status:"rewritten"}),commandId).run()).rejects.toThrow();
    await expect(db.prepare(`UPDATE project_alpha_directory_lifecycle_outbox SET state='pending',outcome_json=NULL WHERE command_id=?`)
      .bind(commandId).run()).rejects.toThrow();
    await expect(db.prepare(`UPDATE project_alpha_directory_lifecycle_outbox SET attempts=attempts+1 WHERE command_id=?`)
      .bind(commandId).run()).rejects.toThrow();
    expect(await db.prepare(`SELECT state,attempts,outcome_json FROM project_alpha_directory_lifecycle_outbox WHERE command_id=?`)
      .bind(commandId).first()).toEqual({state:"acknowledged",attempts:1,outcome_json:validJson});
  },180_000);
});
