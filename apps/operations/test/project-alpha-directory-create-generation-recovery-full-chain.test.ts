import { readFileSync,readdirSync } from "node:fs";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { writeNativeDirectoryProfile,type NativeDirectoryCreateWrite,type NativeDirectoryProfileWrite } from "../src/worker/native-directory-profile-writer";
import { prepareDirectoryCreateGenerationRecovery } from "../src/worker/project-alpha-directory-create-generation-recovery";
import { dispatchProjectAlphaDirectoryProfileOutboxCommand } from "../src/worker/project-alpha-directory-profile-outbox-dispatcher";
import { readConfiguredProjectAlphaDirectoryInventory } from "../src/worker/project-alpha-directory-command-api-v2";
import { persistProjectAlphaDirectoryInventoryPage } from "../src/worker/project-alpha-v2-sync";

let runtime:Miniflare,db:D1Database,sequence=1;
const sourceId="project-alpha:staging",instance="11111111-1111-4111-8111-111111111111";
const application="22222222-2222-4222-8222-222222222222",epoch="33333333-3333-4333-8333-333333333333";
const origin="https://pa.example.test",requestId="44444444-4444-4444-8444-444444444444";
const profile={name:"Recovered client",email:"",phone:"",clientType:"unknown" as const,addressLine1:"",addressLine2:"",
  city:"",state:"",postalCode:"",country:""};
const organizationProfile={name:"Recovered parent",generalEmail:"parent@example.test",generalPhone:"",addressLine1:"",addressLine2:"",
  city:"",state:"",postalCode:"",country:""};
const id=()=>`00000000-0000-4000-8000-${String(sequence++).padStart(12,"0")}`;
const env=(extra:Record<string,unknown>={})=>({OPS_DB:db,PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED:"true",
  PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[sourceId]:{sourceId,enabled:true,baseUrl:origin,
    apiKey:"secret",sourceInstanceId:instance,applicationId:application,historyEpoch:epoch}}}),...extra});
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json; charset=utf-8",
  "Cache-Control":"no-store","X-Request-ID":requestId}});
function capabilities(){return{apiVersion:"2",sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,requestId,
    grantedCapabilities:["api.capabilities.read","directory.inventory.read","directory.clients.create","directory.clients.write",
      "directory.organizations.create","directory.organizations.write"]
    .map(name=>({name})),implementedEndpoints:[
      {method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},
      {method:"GET",path:"/api/v2/directory/inventory",requiredCapability:"directory.inventory.read",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
      {method:"POST",path:"/api/v2/directory/clients/commands",requiredCapability:"directory.clients.create",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
      {method:"POST",path:"/api/v2/directory/clients/{publicId}/profile/commands",requiredCapability:"directory.clients.write",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
      {method:"POST",path:"/api/v2/directory/organizations/commands",requiredCapability:"directory.organizations.create",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
      {method:"POST",path:"/api/v2/directory/organizations/{publicId}/profile/commands",requiredCapability:"directory.organizations.write",requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}]};}
function generationTransport(generation:string){return vi.fn<typeof fetch>(async url=>{
  const path=new URL(String(url)).pathname;if(path.endsWith("/capabilities"))return response(capabilities());
  if(path.endsWith("/inventory")){const inventoryRequestId=id();return new Response(JSON.stringify({sourceInstanceId:instance,
    applicationId:application,historyEpoch:epoch,requestId:inventoryRequestId,
    authorizationGeneration:generation,resources:[],nextCursor:null}),{status:200,headers:{"Content-Type":"application/json; charset=utf-8",
      "Cache-Control":"no-store","X-Request-ID":inventoryRequestId}});}return response({},404);});}
function generationRecoveryTransport(generation:string){return vi.fn<typeof fetch>(async url=>{
  const path=new URL(String(url)).pathname;if(path.endsWith("/capabilities"))return response(capabilities());
  if(path.endsWith("/inventory")){const inventoryRequestId=id();return new Response(JSON.stringify({sourceInstanceId:instance,
    applicationId:application,historyEpoch:epoch,requestId:inventoryRequestId,authorizationGeneration:generation,resources:[],nextCursor:null}),
    {status:200,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Request-ID":inventoryRequestId}});}
  return response({apiVersion:"2",sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,requestId,
    error:{code:"authorization_generation_conflict"}},409);});}
function acknowledgement(publicId:string,generation:string){return vi.fn<typeof fetch>(async(url,init)=>{
  const path=new URL(String(url)).pathname;if(path.endsWith("/capabilities"))return response(capabilities());
  const body=JSON.parse(String(init?.body)),update=path.includes("/profile/commands"),resourceType=path.includes("/organizations/")?"organization":"client";return response({sourceInstanceId:instance,
    applicationId:application,historyEpoch:epoch,requestId,replayed:false,result:{resource:update
      ?{type:resourceType,publicId,revision:"2"}:{type:resourceType,id:body.externalId,publicId,revision:"1"},authorizationGeneration:generation}},update?200:201);});}
const terminal409=vi.fn<typeof fetch>(async url=>new URL(String(url)).pathname.endsWith("/capabilities")
  ?response(capabilities()):response({},409));
async function terminalizeTrustedGenerationConflict(commandId:string){
  await db.batch([db.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',lease_token='trusted-fixture',
      lease_expires_at=?,attempts=attempts+1 WHERE command_id=? AND state='pending'`).bind(Date.now()+60_000,commandId),
    db.prepare(`UPDATE project_alpha_directory_outbox SET state='terminal',outcome_json=?,lease_token=NULL,lease_expires_at=NULL
      WHERE command_id=? AND state='leased' AND lease_token='trusted-fixture'`).bind(JSON.stringify({status:"conflict",reason:"remote",
        httpStatus:409,errorCode:"authorization_generation_conflict"}),commandId)]);
}

beforeAll(async()=>{runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});
  db=await runtime.getD1Database("OPS_DB") as D1Database;const directory=new URL("../migrations/",import.meta.url);
  for(const name of readdirSync(directory).filter(name=>/^\d{4}_.+\.sql$/.test(name)).sort())
    await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,directory),"utf8")).map(sql=>db.prepare(sql)));
  await db.batch([db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('owner','owner@example.test','Owner','access|owner','active')"),
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('staff','staff@example.test','Staff','access|staff','active')"),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES('staff','access|staff',1,'owner')"),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES('staff','staff@example.test','Staff')"),
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area','Area',1)")]);
},240_000);afterAll(async()=>runtime.dispose());

describe("Directory create-generation recovery full chain",()=>{
  it("preserves the root terminal command and settles a fresh successor before a normal profile update",async()=>{
    const record=id(),mutation=id(),admission=`admission-${mutation}`;
    for(const [suffix,permission] of [["edit","directory.profile.edit"],["identity","directory.identity.link"],["enroll","directory.enrollment.manage"]])
      await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?, 'staff',?,'allow','global','owner')")
        .bind(`old-${suffix}`,permission).run();
    const actor={staffId:"staff",accessSubject:"access|staff",admissionVersion:1,selectedGrantId:"old-edit",loginEmail:"staff@example.test",
      profileVersion:1,selectedIdentityGrantId:"old-identity"};
    const destination={sourceId,sourceInstanceUUID:instance,applicationUUID:application,historyEpoch:epoch,origin,
      externalCanonicalId:record,expectedAuthorizationGeneration:"52"};
    const scopes=[{businessAreaId:"area",divisionId:null}];
    await db.prepare(`INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,
      scopes_json,profile_json,destinations_json,issued_by) VALUES(?,?,?,?, 'client',?,?,?, 'staff')`)
      .bind(admission,"staff","access|staff",record,JSON.stringify(scopes),JSON.stringify(profile),JSON.stringify([{...destination,expectedAuthorizationGeneration:undefined}],(_,v)=>v)).run();
    await db.prepare(`INSERT INTO native_directory_create_admission_relationships(create_admission_id,client_record_id,
      organization_record_id,organization_record_version) VALUES(?,?,NULL,NULL)`).bind(admission,record).run();
    const created=await writeNativeDirectoryProfile(db,{operation:"create",mutationId:mutation,createAdmissionId:admission,recordId:record,
      expectedLocalVersion:0,kind:"client",profile,scopes,destinations:[destination],actor,
      relationship:{organizationRecordId:null,expectedRelationshipVersion:0}} as NativeDirectoryCreateWrite);
    if(created.status!=="written")throw Error(created.reason);const root=created.commandIds[0]!;
    await terminalizeTrustedGenerationConflict(root);
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE staff_id='staff'").run();
    for(const [suffix,permission] of [["edit","directory.profile.edit"],["identity","directory.identity.link"],["enroll","directory.enrollment.manage"]])
      await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,granted_by) VALUES(?, 'staff',?,'allow','resource',?,'owner')")
        .bind(`fresh-${suffix}`,permission,record).run();
    const maxAuthorization=id(),maxSuccessor=id(),rootRow=await db.prepare("SELECT command_json,origin_snapshot_json FROM project_alpha_directory_outbox WHERE command_id=?").bind(root).first<{ command_json: string; origin_snapshot_json: string }>();
    if (!rootRow) throw new Error("missing root command fixture");
    const maxCommand=JSON.stringify({...JSON.parse(rootRow.command_json),commandId:maxSuccessor,expectedAuthorizationGeneration:"9223372036854775807"});
    const maxRecovery=db.prepare(`INSERT INTO project_alpha_directory_create_generation_recoveries(
      authorization_id,root_command_id,predecessor_command_id,successor_command_id,recovery_depth,intent_id,source_id,
      source_instance_id,application_id,history_epoch_id,destination_origin,resource_type,record_id,external_id,
      predecessor_command_json,successor_command_json,generation_conflict_request_id,generation_conflict_code,
      observed_inventory_request_id,observed_authorization_generation,actor_staff_id,actor_access_subject,actor_email,
      actor_admission_version,actor_profile_version,original_profile_grant_id,original_identity_grant_id,profile_grant_id,
      identity_grant_id,enrollment_grant_id,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(maxAuthorization,root,root,maxSuccessor,1,`${mutation}:intent:0`,sourceId,instance,application,epoch,origin,"client",record,record,
        rootRow!.command_json,maxCommand,id(),"authorization_generation_conflict",id(),"9223372036854775807","staff","access|staff",
        "staff@example.test",1,1,"old-edit","old-identity","fresh-edit","fresh-identity","fresh-enroll","MAX must fail");
    const maxOutbox=db.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,
      external_id,command_json,destination_base_url,expected_source_instance_id,origin_snapshot_json,next_attempt_at,
      expected_history_epoch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(maxSuccessor,sourceId,application,"client",record,maxCommand,
        origin,instance,rootRow!.origin_snapshot_json,Date.now(),epoch);
    await expect(db.batch([maxRecovery,maxOutbox])).rejects.toThrow();
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_create_generation_recoveries WHERE authorization_id=?")
      .bind(maxAuthorization).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_outbox WHERE command_id=?").bind(maxSuccessor).first("n")).toBe(0);
    const successor=id(),authorization=id();
    const probe=await readConfiguredProjectAlphaDirectoryInventory(env(),sourceId,{type:"all",limit:1},generationTransport("53"));
    expect(probe.status).toBe("observed");if(probe.status!=="observed")throw Error(probe.status);
    expect(await persistProjectAlphaDirectoryInventoryPage(db,probe.inventory,null)).toMatchObject({status:"persisted"});
    await expect(prepareDirectoryCreateGenerationRecovery(env(),{authorizationId:authorization,predecessorCommandId:root,
      successorCommandId:successor,sourceId,reason:"Reviewed generation race"},{staffId:"staff",accessSubject:"access|staff",
      email:"staff@example.test",admissionVersion:1,profileVersion:1,verifiedUntil:"2999-01-01T00:00:00.000Z"},generationRecoveryTransport("53")))
      .resolves.toEqual({status:"prepared",successorCommandId:successor,generation:"53",replayed:false});
    const original=await db.prepare("SELECT state,command_json,outcome_json FROM project_alpha_directory_outbox WHERE command_id=?").bind(root).first();
    expect(original).toMatchObject({state:"terminal"});
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,successor,acknowledgement("a".repeat(32),"54")))
      .resolves.toMatchObject({status:"acknowledged",revision:"1"});
    expect(await db.prepare("SELECT state FROM operations_directory_intents WHERE mutation_id=?").bind(mutation).first("state")).toBe("acknowledged");
    expect(await db.prepare("SELECT command_id FROM project_alpha_directory_mappings WHERE external_id=?").bind(record).first("command_id")).toBe(successor);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_unsettled_commands WHERE command_id=?").bind(root).first("n")).toBe(0);
    expect(await db.prepare("SELECT state,command_json,outcome_json FROM project_alpha_directory_outbox WHERE command_id=?").bind(root).first()).toEqual(original);
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,root,terminal409))
      .resolves.toMatchObject({status:"conflict",reason:"remote",httpStatus:409});
    const updateActor={...actor,selectedGrantId:"fresh-edit",selectedIdentityGrantId:"fresh-identity"};
    const {clientType:_clientType,...updateProfile}=profile;
    const updateMutation=id();
    const updated=await writeNativeDirectoryProfile(db,{operation:"update",mutationId:updateMutation,recordId:record,expectedLocalVersion:1,
      kind:"client",profile:{...updateProfile,name:"Recovered client updated"},destinations:[{...destination,expectedAuthorizationGeneration:"54"}],
      actor:updateActor,relationship:{organizationRecordId:null,expectedRelationshipVersion:1}} as NativeDirectoryProfileWrite);
    if(updated.status!=="written")throw Error(JSON.stringify(updated));
    expect(updated).toMatchObject({status:"written",version:2});
    expect(await db.prepare("SELECT evidence_kind FROM operations_directory_intent_relationship_dependencies WHERE intent_id=?")
      .bind(`${updateMutation}:intent:0`).first("evidence_kind")).toBe("unlinked");
  },120_000);

  it("resolves a linked client parent_intent through an acknowledged recovered organization successor",async()=>{
    const parent=id(),parentMutation=id(),parentAdmission=`admission-${parentMutation}`;
    const parentScopes=[{businessAreaId:"area",divisionId:null}],parentDestination={sourceId,sourceInstanceUUID:instance,
      applicationUUID:application,historyEpoch:epoch,origin,externalCanonicalId:parent,expectedAuthorizationGeneration:"61"};
    await db.prepare("UPDATE native_directory_grants SET active=1 WHERE id IN ('old-edit','old-identity','old-enroll')").run();
    const parentActor={staffId:"staff",accessSubject:"access|staff",admissionVersion:1,selectedGrantId:"old-edit",
      loginEmail:"staff@example.test",profileVersion:1,selectedIdentityGrantId:"old-identity"};
    await db.prepare(`INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,
      scopes_json,profile_json,destinations_json,issued_by) VALUES(?,?,?,?, 'organization',?,?,?, 'staff')`)
      .bind(parentAdmission,"staff","access|staff",parent,JSON.stringify(parentScopes),JSON.stringify(organizationProfile),
        JSON.stringify([{...parentDestination,expectedAuthorizationGeneration:undefined}],(_,value)=>value)).run();
    const parentCreated=await writeNativeDirectoryProfile(db,{operation:"create",mutationId:parentMutation,
      createAdmissionId:parentAdmission,recordId:parent,expectedLocalVersion:0,kind:"organization",profile:organizationProfile,
      scopes:parentScopes,destinations:[parentDestination],actor:parentActor} as NativeDirectoryCreateWrite);
    if(parentCreated.status!=="written")throw Error(JSON.stringify(parentCreated));
    const parentRoot=parentCreated.commandIds[0]!;
    await terminalizeTrustedGenerationConflict(parentRoot);
    const parentSuccessor=id(),parentAuthorization=id();
    const parentProbe=await readConfiguredProjectAlphaDirectoryInventory(env(),sourceId,{type:"all",limit:1},generationTransport("62"));
    expect(parentProbe.status).toBe("observed");if(parentProbe.status!=="observed")throw Error(parentProbe.status);
    expect(await persistProjectAlphaDirectoryInventoryPage(db,parentProbe.inventory,null)).toMatchObject({status:"persisted"});
    await expect(prepareDirectoryCreateGenerationRecovery(env(),{authorizationId:parentAuthorization,predecessorCommandId:parentRoot,
      successorCommandId:parentSuccessor,sourceId,reason:"Reviewed parent generation race"},{staffId:"staff",accessSubject:"access|staff",
      email:"staff@example.test",admissionVersion:1,profileVersion:1,verifiedUntil:"2999-01-01T00:00:00.000Z"},generationRecoveryTransport("62")))
      .resolves.toMatchObject({status:"prepared",successorCommandId:parentSuccessor,generation:"62"});
    const parentPublicId="b".repeat(32);
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,parentSuccessor,acknowledgement(parentPublicId,"63")))
      .resolves.toMatchObject({status:"acknowledged",revision:"1"});

    const client=id(),clientMutation=id(),clientAdmission=`admission-${clientMutation}`;
    const clientDestination={...parentDestination,externalCanonicalId:client,expectedAuthorizationGeneration:"63"};
    await db.prepare(`INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,
      scopes_json,profile_json,destinations_json,issued_by) VALUES(?,?,?,?, 'client',?,?,?, 'staff')`)
      .bind(clientAdmission,"staff","access|staff",client,JSON.stringify(parentScopes),JSON.stringify(profile),
        JSON.stringify([{...clientDestination,expectedAuthorizationGeneration:undefined}],(_,value)=>value)).run();
    await db.prepare(`INSERT INTO native_directory_create_admission_relationships(create_admission_id,client_record_id,
      organization_record_id,organization_record_version) VALUES(?,?,?,1)`).bind(clientAdmission,client,parent).run();
    const clientWrite={operation:"create",mutationId:clientMutation,createAdmissionId:clientAdmission,recordId:client,
      expectedLocalVersion:0,kind:"client",profile,scopes:parentScopes,destinations:[clientDestination],actor:parentActor,
      relationship:{organizationRecordId:parent,expectedRelationshipVersion:0}} satisfies Extract<NativeDirectoryCreateWrite,{kind:"client"}>;
    await expect(writeNativeDirectoryProfile(db,{...clientWrite,relationship:{organizationRecordId:id(),expectedRelationshipVersion:0}}))
      .resolves.toEqual({status:"blocked",reason:"create_admission"});
    const clientCreated=await writeNativeDirectoryProfile(db,clientWrite);
    if(clientCreated.status!=="written")throw Error(JSON.stringify(clientCreated));
    const dependency=await db.prepare(`SELECT evidence_kind,parent_intent_id,parent_public_id
      FROM operations_directory_intent_relationship_dependencies WHERE intent_id=?`).bind(`${clientMutation}:intent:0`).first();
    expect(dependency).toEqual({evidence_kind:"parent_intent",parent_intent_id:`${parentMutation}:intent:0`,parent_public_id:null});
    expect(await db.prepare(`SELECT public_id,revision,identity_valid FROM project_alpha_directory_relationship_revision_evidence
      WHERE record_id=? AND record_kind='organization' AND record_version=1`).bind(parent).first())
      .toEqual({public_id:parentPublicId,revision:"1",identity_valid:1});
  },120_000);

  it("leaves a stale-generation recovery terminal and unmapped when PA uniqueness rejects the successor",async()=>{
    for(const [suffix,permission] of [["chain-edit","directory.profile.edit"],["chain-identity","directory.identity.link"],["chain-enroll","directory.enrollment.manage"]]){
      await db.prepare("INSERT OR IGNORE INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?, 'staff',?,'allow','global','owner')")
        .bind(suffix,permission).run();await db.prepare("UPDATE native_directory_grants SET active=1 WHERE staff_id='staff' AND permission=? AND effect='allow' AND scope_kind='global'")
        .bind(permission).run();}
    const profileGrant=await db.prepare("SELECT id FROM native_directory_grants WHERE staff_id='staff' AND permission='directory.profile.edit' AND effect='allow' AND scope_kind='global'").first<string>("id");
    const identityGrant=await db.prepare("SELECT id FROM native_directory_grants WHERE staff_id='staff' AND permission='directory.identity.link' AND effect='allow' AND scope_kind='global'").first<string>("id");
    const record=id(),mutation=id(),admission=`admission-${mutation}`,scopes=[{businessAreaId:"area",divisionId:null}];
    const actor={staffId:"staff",accessSubject:"access|staff",admissionVersion:1,selectedGrantId:profileGrant!,
      loginEmail:"staff@example.test",profileVersion:1,selectedIdentityGrantId:identityGrant!};
    const destination={sourceId,sourceInstanceUUID:instance,applicationUUID:application,historyEpoch:epoch,origin,
      externalCanonicalId:record,expectedAuthorizationGeneration:"70"};
    await db.prepare(`INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,
      scopes_json,profile_json,destinations_json,issued_by) VALUES(?,?,?,?, 'client',?,?,?, 'staff')`)
      .bind(admission,"staff","access|staff",record,JSON.stringify(scopes),JSON.stringify(profile),
        JSON.stringify([{...destination,expectedAuthorizationGeneration:undefined}],(_,value)=>value)).run();
    await db.prepare(`INSERT INTO native_directory_create_admission_relationships(create_admission_id,client_record_id,
      organization_record_id,organization_record_version) VALUES(?,?,NULL,NULL)`).bind(admission,record).run();
    const created=await writeNativeDirectoryProfile(db,{operation:"create",mutationId:mutation,createAdmissionId:admission,
      recordId:record,expectedLocalVersion:0,kind:"client",profile,scopes,destinations:[destination],actor,
      relationship:{organizationRecordId:null,expectedRelationshipVersion:0}} as NativeDirectoryCreateWrite);
    if(created.status!=="written")throw Error(JSON.stringify(created));const root=created.commandIds[0]!;
    await terminalizeTrustedGenerationConflict(root);
    const immutableRoot=await db.prepare("SELECT state,command_json,outcome_json FROM project_alpha_directory_outbox WHERE command_id=?").bind(root).first();
    const probe=await readConfiguredProjectAlphaDirectoryInventory(env(),sourceId,{type:"all",limit:1},generationTransport("71"));
    expect(probe.status).toBe("observed");if(probe.status!=="observed")throw Error(probe.status);
    expect(await persistProjectAlphaDirectoryInventoryPage(db,probe.inventory,null)).toMatchObject({status:"persisted"});
    const successor=id();
    await expect(prepareDirectoryCreateGenerationRecovery(env(),{authorizationId:id(),predecessorCommandId:root,
      successorCommandId:successor,sourceId,reason:"Reviewed stale generation before duplicate rejection"},{staffId:"staff",
      accessSubject:"access|staff",email:"staff@example.test",admissionVersion:1,profileVersion:1,
      verifiedUntil:"2999-01-01T00:00:00.000Z"},generationRecoveryTransport("71"))).resolves.toMatchObject({status:"prepared",successorCommandId:successor});
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,successor,terminal409))
      .resolves.toMatchObject({status:"conflict",reason:"remote",httpStatus:409});
    expect(await db.prepare("SELECT state FROM project_alpha_directory_outbox WHERE command_id=?").bind(successor).first("state")).toBe("terminal");
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_mappings WHERE command_id=?").bind(successor).first("n")).toBe(0);
    expect(await db.prepare("SELECT state FROM operations_directory_intents WHERE mutation_id=?").bind(mutation).first("state")).toBe("materialized");
    expect(await db.prepare("SELECT recovery_depth FROM project_alpha_directory_create_generation_recoveries WHERE successor_command_id=?")
      .bind(successor).first("recovery_depth")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_unsettled_commands WHERE command_id IN (?,?)")
      .bind(root,successor).first("n")).toBe(2);

    const successor2=id();
    await expect(prepareDirectoryCreateGenerationRecovery(env(),{authorizationId:id(),predecessorCommandId:successor,
      successorCommandId:successor2,sourceId,reason:"Reviewed second stale generation before duplicate rejection"},{staffId:"staff",
      accessSubject:"access|staff",email:"staff@example.test",admissionVersion:1,profileVersion:1,
      verifiedUntil:"2999-01-01T00:00:00.000Z"},generationRecoveryTransport("72"))).resolves.toMatchObject({status:"prepared",successorCommandId:successor2});
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,successor2,terminal409))
      .resolves.toMatchObject({status:"conflict",reason:"remote",httpStatus:409});
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_unsettled_commands WHERE command_id IN (?,?,?)")
      .bind(root,successor,successor2).first("n")).toBe(3);

    const successor3=id();
    await expect(prepareDirectoryCreateGenerationRecovery(env(),{authorizationId:id(),predecessorCommandId:successor2,
      successorCommandId:successor3,sourceId,reason:"Reviewed third stale generation after duplicate cleared"},{staffId:"staff",
      accessSubject:"access|staff",email:"staff@example.test",admissionVersion:1,profileVersion:1,
      verifiedUntil:"2999-01-01T00:00:00.000Z"},generationRecoveryTransport("73"))).resolves.toMatchObject({status:"prepared",successorCommandId:successor3});
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,successor3,acknowledgement("c".repeat(32),"74")))
      .resolves.toMatchObject({status:"acknowledged",revision:"1"});
    expect(await db.prepare("SELECT command_id FROM project_alpha_directory_mappings WHERE external_id=?").bind(record).first("command_id")).toBe(successor3);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_directory_unsettled_commands WHERE command_id IN (?,?,?)")
      .bind(root,successor,successor2).first("n")).toBe(0);
    expect(await db.prepare("SELECT max(recovery_depth) depth FROM project_alpha_directory_create_generation_recoveries WHERE root_command_id=?")
      .bind(root).first("depth")).toBe(3);
    expect(await db.prepare("SELECT state,command_json,outcome_json FROM project_alpha_directory_outbox WHERE command_id=?").bind(root).first()).toEqual(immutableRoot);
    const sendsBefore=terminal409.mock.calls.length;
    await expect(dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,root,terminal409))
      .resolves.toMatchObject({status:"conflict",reason:"remote",httpStatus:409});
    expect(terminal409.mock.calls.length).toBe(sendsBefore);
  },120_000);
});
