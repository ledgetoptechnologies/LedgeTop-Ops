import {readFileSync,readdirSync} from 'node:fs';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {Miniflare} from 'miniflare';
import type {Env} from '../src/worker/types';
import type {SharedProfilePortalProof} from '../../../packages/shared/src/shared-business-profile';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import {writeNativeDirectoryProfile,writeNativeDirectorySharedProfiles,writeNativeDirectorySharedPortalProfiles,type NativeDirectoryCreateWrite,type NativeDirectoryDestinationAuthority,type NativeDirectoryProfileWrite,type NativeDirectoryProfileWriteOutcome,type NativeDirectoryPortalWriterActor,type NativeDirectoryPortalUpdateWrite} from '../src/worker/native-directory-profile-writer';
import {sharedProfileCreationFence} from '../src/worker/native-directory-shared-profile-routes';
import {prepareSharedProfilePortalWrite,normalizePortalBusinessProfile} from '../src/worker/shared-profile-portal-authority';
import {dispatchProjectAlphaDirectoryProfileOutboxCommand} from '../src/worker/project-alpha-directory-profile-outbox-dispatcher';
import {drainNativeDirectoryOutboxes} from '../src/worker/native-directory-outbox-scheduler';
import {PROJECT_ALPHA_DIRECTORY_CLIENT_CONTACT_PROFILE_ENDPOINT} from '../src/worker/project-alpha-directory-profile-api-v2';
import {recoverDirectoryProfileGeneration} from '../src/worker/project-alpha-directory-profile-generation-recovery';
import {dispatchNativeDirectoryProfileBindingContinuation} from '../src/worker/native-directory-profile-binding-continuation';
let runtime: Miniflare;
let db: D1Database;
let sequence = 1;
let sourceId = "project-alpha:primary";
const sourceInstanceUUID = "11111111-1111-4111-8111-111111111111";
const applicationUUID = "22222222-2222-4222-8222-222222222222";
const historyEpoch = "33333333-3333-4333-8333-333333333333";
const origin = "https://pa.example.test";
const organizationProfile = { name: "Example Organization", generalEmail: "org@example.test", generalPhone: "512-555-0100",
  addressLine1: "1 Main Street", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" } as const;
const clientProfile = { name: "Standalone Client", email: "client@example.test", phone: "512-555-0101", clientType: "business" as const,
  addressLine1: "2 Main Street", addressLine2: "Suite 2", city: "Austin", state: "TX", postalCode: "78702", country: "US" } as const;

function uuid(): string { return `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`; }
function publicId(): string { return (sequence++).toString(16).padStart(32, "0"); }
function destination(recordId: string, expectedAuthorizationGeneration = "0"): NativeDirectoryDestinationAuthority {
  return { sourceId, sourceInstanceUUID, applicationUUID, historyEpoch, origin, externalCanonicalId: recordId, expectedAuthorizationGeneration };
}
async function seedActor(scope: "global" | "business_area" = "global") {
  const id = `actor-${sequence++}`, accessSubject = `access|${id}`, grantId = `grant-${id}`, identityGrantId = `identity-${id}`, loginEmail = `${id}@example.test`;
  await db.batch([
    db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')`).bind(id, loginEmail, id, accessSubject),
    db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,'owner')`).bind(id, accessSubject),
    db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)`).bind(id, loginEmail, id),
    db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,granted_by)
      VALUES(?,?,'directory.profile.edit','allow',?,?,'owner')`).bind(grantId, id, scope, scope === "business_area" ? "area" : null),
    db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,granted_by)
      VALUES(?,?,'directory.identity.link','allow',?,?,'owner')`).bind(identityGrantId, id, scope, scope === "business_area" ? "area" : null),
    db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?,?,'directory.profile.view','allow','global','owner')`).bind(`view-${id}`,id),
  ]);
  return { staffId: id, accessSubject, admissionVersion: 1, selectedGrantId: grantId,
    loginEmail, profileVersion: 1, selectedIdentityGrantId: identityGrantId } as const;
}
async function create(kind: "organization" | "client", actor?: Awaited<ReturnType<typeof seedActor>>, requestedRecordId?: string,
  organizationRecordId: string | null = null, admittedOrganizationRecordId: string | null = organizationRecordId) {
  actor ??= await seedActor();
  const recordId = requestedRecordId ?? (kind === "client" ? uuid() : `ops/${kind}/${sequence++}`), mutationId = uuid();
  const createAdmissionId = `admission-${mutationId}`;
  const input = { operation: "create", mutationId, recordId, expectedLocalVersion: 0, kind, createAdmissionId,
    profile: kind === "organization" ? organizationProfile : clientProfile, scopes: [{ businessAreaId: "area", divisionId: "division" }],
    destinations: [destination(recordId)], actor,
    ...(kind === "client" ? { relationship: { organizationRecordId, expectedRelationshipVersion: 0 } } : {}) } as NativeDirectoryCreateWrite;
  const admission = db.prepare(`INSERT INTO native_directory_create_admissions
    (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(createAdmissionId, actor.staffId, actor.accessSubject, recordId, kind,
      JSON.stringify(input.scopes), JSON.stringify(input.profile), JSON.stringify(input.destinations.map(({ expectedAuthorizationGeneration: _, ...value }) => value)), actor.staffId);
  if (kind === "client") {
    const admittedVersion = admittedOrganizationRecordId === null ? null : await db.prepare(`SELECT current_version
      FROM operations_directory_records WHERE record_id=? AND record_kind='organization'`).bind(admittedOrganizationRecordId).first<number>("current_version");
    await db.batch([admission, db.prepare(`INSERT INTO native_directory_create_admission_relationships
      (create_admission_id,client_record_id,organization_record_id,organization_record_version) VALUES(?,?,?,?)`)
      .bind(createAdmissionId, recordId, admittedOrganizationRecordId, admittedVersion)]);
  } else await admission.run();
  const outcome = await writeNativeDirectoryProfile(db, input);
  return { input, outcome, actor };
}
function written(outcome: NativeDirectoryProfileWriteOutcome) {
  expect(outcome.status).toBe("written");
  if (outcome.status !== "written") throw new Error(`write failed: ${outcome.reason}`);
  return outcome;
}
async function acknowledgeCreate(input: NativeDirectoryProfileWrite, outcome: NativeDirectoryProfileWriteOutcome, generation = "1", acknowledgeIntent = true) {
  const result = written(outcome), id = publicId();
  for (const commandId of result.commandIds) {
    await db.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='lease',lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'`).bind(commandId).run();
    await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,
      source_instance_id,application_id,history_epoch_id,command_id) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(sourceId, input.kind, input.recordId, id, sourceInstanceUUID, applicationUUID, historyEpoch, commandId).run();
    const response = { status: "acknowledged", response: { requestId: commandId, replayed: false,
      sourceInstanceId: sourceInstanceUUID, applicationId: applicationUUID,
      historyEpoch, result: { resource: { type: input.kind, id: input.recordId, publicId: id, revision: "1" },
        data: { publicId: id }, authorizationGeneration: generation } } };
    await db.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased'`)
      .bind(JSON.stringify(response), commandId).run();
  }
  if (acknowledgeIntent) await db.prepare(`UPDATE operations_directory_intents SET state='acknowledged' WHERE mutation_id=? AND state='materialized'`).bind(input.mutationId).run();
  return id;
}
beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  const migrations = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0220").sort();
  for (const migration of migrations) await db.batch(splitD1MigrationStatements(readFileSync(new URL(migration, directory), "utf8")).map(sql => db.prepare(sql)));


  await db.batch([
    db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('owner','owner@example.test','Owner','access|owner','active')`),
    db.prepare(`INSERT INTO native_business_areas(id,name,active) VALUES('area','Area',1)`),
    db.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES('division','area','Division',1)`),
    db.prepare(`CREATE TABLE delivery_rows(id TEXT PRIMARY KEY,payload BLOB NOT NULL)`),
    db.prepare(`CREATE TABLE delivery_public_links(id TEXT PRIMARY KEY,url TEXT NOT NULL,payload BLOB NOT NULL)`),
    db.prepare(`INSERT INTO delivery_rows VALUES('delivery',x'ff0080')`),
    db.prepare(`INSERT INTO delivery_public_links VALUES('link','https://public.example.test/keep',x'00ff80')`),
  ]);
}, 240_000);

afterAll(async () => { await runtime.dispose(); });

async function reviewedCreation(groupId:string,records:Awaited<ReturnType<typeof create>>[],actor:Awaited<ReturnType<typeof seedActor>>,
  kind:'organization'|'client',profile:Record<string,string>,mode:'pair'|'single'='pair') {
  const members=await Promise.all(records.map(async r=>{
    const relation=kind==='client'?await db.prepare('SELECT organization_record_id,relationship_version FROM operations_directory_client_organizations WHERE client_record_id=?')
      .bind(r.input.recordId).first<{organization_record_id:string|null;relationship_version:number}>():null;
    const parentRecordId=relation?.organization_record_id??null;
    const parentVersion=parentRecordId?await db.prepare('SELECT current_version FROM operations_directory_records WHERE record_id=?').bind(parentRecordId).first<number>('current_version'):null;
    return {recordId:r.input.recordId,kind,version:1,profile,sourceIds:r.input.destinations.map(d=>d.sourceId),parentRecordId,
      relationshipVersion:relation?.relationship_version??null,parentVersion};
  }));
  const previewToken=mode==='pair'?uuid():null;
  if(previewToken)await db.prepare('INSERT INTO native_directory_shared_profile_previews(token,actor_id,proof_json,expires_at) VALUES(?,?,?,?)')
    .bind(previewToken,actor.staffId,JSON.stringify({members,profile,kind,differences:[],actor}),new Date(Date.now()+600_000).toISOString()).run();
  return {members,previewToken,statement:sharedProfileCreationFence(db,{groupId,mutationId:uuid(),mode,requestSha256:'a'.repeat(64),actor,kind,profile,members,previewToken})};
}

async function portalFixture(){
  const actor=await seedActor(),records=[] as Awaited<ReturnType<typeof create>>[],publicIds=new Map<string,string>();
  for(const source of ['project-alpha:primary','project-alpha:secondary']){sourceId=source;const record=await create('client',actor);
    publicIds.set(record.input.recordId,await acknowledgeCreate(record.input,record.outcome));records.push(record);}
  sourceId='project-alpha:primary';records.sort((a,b)=>a.input.recordId.localeCompare(b.input.recordId));
  const groupId=uuid(),{clientType:_,...profile}=clientProfile,creation=await reviewedCreation(groupId,records,actor,'client',profile);
  await db.batch([creation.statement,
    db.prepare("INSERT INTO native_directory_shared_profiles(id,kind,profile_json,membership_json,created_by) VALUES(?,'client',?,?,?)").bind(groupId,JSON.stringify(profile),JSON.stringify(records.map(r=>r.input.recordId)),actor.staffId),
    ...creation.members.map(m=>db.prepare('INSERT INTO native_directory_shared_profile_members(record_id,group_id,initial_version,initial_parent_record_id,initial_relationship_version) VALUES(?,?,1,NULL,1)').bind(m.recordId,groupId)),
    db.prepare('INSERT INTO native_directory_shared_profile_revisions(group_id,version,profile_json) VALUES(?,1,?)').bind(groupId,JSON.stringify(profile))]);
  const workspaceId=uuid(),grantId=uuid(),record=records.find(r=>r.input.destinations[0]!.sourceId==='project-alpha:primary')!,principalPublicId=publicId();
  await db.batch([
    db.prepare("INSERT INTO shared_profile_portal_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES(?,'project-alpha:primary',1,'active',?)").bind(workspaceId,uuid()),
    db.prepare(`INSERT INTO shared_profile_portal_grants(id,workspace_id,source_id,source_instance_id,application_id,history_epoch_id,issuer,subject,principal_public_id,target_type,target_public_id,record_id,group_id,group_membership_json,revision,state,issued_by)
      VALUES(?,?,'project-alpha:primary',?,?,?,'https://access.example.test','portal-user',?,'client',?,?,?,?,1,'active',?)`)
      .bind(grantId,workspaceId,sourceInstanceUUID,applicationUUID,historyEpoch,principalPublicId,publicIds.get(record.input.recordId),record.input.recordId,groupId,JSON.stringify(records.map(r=>r.input.recordId)),actor.staffId)]);
  const proof:SharedProfilePortalProof={protocolVersion:1,workspaceId,sourceId:'project-alpha:primary',issuer:'https://access.example.test',subject:'portal-user',
    authorityRevision:1,contextVersion:'a'.repeat(64),verifiedUntil:new Date(Date.now()+45_000).toISOString(),targets:[{principalPublicId,scopeType:'client',publicId:publicIds.get(record.input.recordId)!}]};
  return {actor,records,publicIds,groupId,grantId,profile,proof,env:{OPS_DB:db} as Env};
}
async function pendingPortal(originalTtl=45_000){
 const f=await portalFixture(),mutationId=uuid(),profile=normalizePortalBusinessProfile({...f.profile,email:'new-contact@example.test'});
 f.proof={...f.proof,verifiedUntil:new Date(Date.now()+originalTtl).toISOString()};
 const input={...f.proof,grantId:f.grantId,expectedVersion:1,mutationId,profile},prepared=await prepareSharedProfilePortalWrite(f.env,input);expect(prepared).not.toBeNull();
 const actor:NativeDirectoryPortalWriterActor={kind:'portal',actorId:`portal:${f.grantId}`,issuer:f.proof.issuer,subject:f.proof.subject,grantId:f.grantId,grantRevision:1,workspaceId:f.proof.workspaceId,sourceId:f.proof.sourceId,groupId:f.groupId,groupVersion:1,sharedMutationId:mutationId,authorityRevision:1,contextVersion:f.proof.contextVersion,verifiedUntil:f.proof.verifiedUntil};
 const writes:NativeDirectoryPortalUpdateWrite[]=f.records.map(r=>({operation:'update',mutationId:uuid(),recordId:r.input.recordId,expectedLocalVersion:1,kind:'client',profile:profile as Extract<NativeDirectoryPortalUpdateWrite,{kind:'client'}>['profile'],actor,destinations:r.input.destinations.map(d=>({...d,expectedAuthorizationGeneration:'1'})),relationship:{organizationRecordId:null,expectedRelationshipVersion:1}}));
 const outcome=await writeNativeDirectorySharedPortalProfiles(db,{groupId:f.groupId,mutationId,expectedVersion:1,requestSha256:prepared!.requestSha256,profile,writes,authorityFence:prepared!.statement});expect(outcome).toMatchObject({status:'written'});if(outcome.status!=='written')throw Error(JSON.stringify(outcome));
 const commands=await Promise.all(writes.map(w=>db.prepare('SELECT o.command_id,o.source_id FROM project_alpha_directory_outbox o JOIN operations_directory_materializations m ON m.command_id=o.command_id JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.mutation_id=?').bind(w.mutationId).first<{command_id:string;source_id:string}>()));
 const proofReader=vi.fn(async()=>({ok:true as const,proof:{...f.proof,authorityRevision:(await db.prepare('SELECT revision FROM shared_profile_portal_authority_heads WHERE workspace_id=?').bind(f.proof.workspaceId).first<number>('revision'))!,contextVersion:'b'.repeat(64),verifiedUntil:new Date(Date.now()+45_000).toISOString()}}));
 const configured={OPS_DB:db,SHARED_PROFILE_PORTAL_AUTHORITY:{readAuthority:proofReader},PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:Object.fromEntries(['project-alpha:primary'].map(sourceId=>[sourceId,{sourceId,enabled:true,baseUrl:origin,apiKey:'test-secret',sourceInstanceId:sourceInstanceUUID,applicationId:applicationUUID,historyEpoch}]))})};
 const posts:string[]=[];let duringProbe:(()=>Promise<void>)|undefined,duringPost:(()=>Promise<void>)|undefined;
 const send=vi.fn<typeof fetch>(async(url,init)=>{const path=new URL(String(url)).pathname,requestId=uuid();const json=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Request-ID':requestId}});
  if(path.endsWith('/capabilities')){if(duringProbe)await duringProbe();return json({apiVersion:'2',sourceInstanceId:sourceInstanceUUID,applicationId:applicationUUID,historyEpoch,requestId,grantedCapabilities:[{name:'api.capabilities.read'},{name:'directory.clients.write'}],implementedEndpoints:[{method:'GET',path:'/api/v2/capabilities',requiredCapability:'api.capabilities.read'},PROJECT_ALPHA_DIRECTORY_CLIENT_CONTACT_PROFILE_ENDPOINT]});}
  posts.push(path);if(duringPost)await duringPost();expect(path).toContain('/contact-profile/commands');return json({sourceInstanceId:sourceInstanceUUID,applicationId:applicationUUID,historyEpoch,requestId,replayed:false,result:{resource:{type:'client',publicId:path.split('/')[5],revision:'2'},authorizationGeneration:'1'}});
 });
 const configuredFor=(sourceId:string)=>({...configured,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[sourceId]:{sourceId,enabled:true,baseUrl:origin,apiKey:'test-secret',sourceInstanceId:sourceInstanceUUID,applicationId:applicationUUID,historyEpoch}}})});
 return {...f,configured,configuredFor,commands:commands.map(c=>c!),posts,send,proofReader,setProbe:(f:()=>Promise<void>)=>{duringProbe=f;},setPost:(f:()=>Promise<void>)=>{duringPost=f;}};
}
async function revoke(f:Awaited<ReturnType<typeof pendingPortal>>){await db.prepare("UPDATE shared_profile_portal_grants SET state='revoked',revision=revision+1 WHERE id=?").bind(f.grantId).run();}

async function pendingStaff(){
 const f=await portalFixture(),profile={...f.profile,phone:'512-555-0199'},mutationId=uuid();
 const writes=f.records.map(r=>({operation:'update' as const,mutationId:uuid(),recordId:r.input.recordId,expectedLocalVersion:1,kind:'client' as const,
  profile,actor:f.actor,destinations:r.input.destinations.map(d=>({...d,expectedAuthorizationGeneration:'1'})),relationship:{organizationRecordId:null,expectedRelationshipVersion:1}}));
 expect(await writeNativeDirectorySharedProfiles(db,{groupId:f.groupId,mutationId,expectedVersion:1,requestSha256:'a'.repeat(64),profile,writes})).toMatchObject({status:'written'});
 const commands=(await db.prepare(`SELECT o.command_id,o.source_id FROM project_alpha_directory_outbox o JOIN operations_directory_materializations m ON m.command_id=o.command_id
 JOIN operations_directory_intents i ON i.intent_id=m.intent_id WHERE i.record_id IN(SELECT value FROM json_each(?)) AND i.record_version=2 ORDER BY i.source_id`)
 .bind(JSON.stringify(f.records.map(r=>r.input.recordId))).all<{command_id:string;source_id:string}>()).results;
 const configuredFor=(id:string)=>({OPS_DB:db,NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:'true',PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[id]:{sourceId:id,enabled:true,baseUrl:origin,apiKey:'test-secret',sourceInstanceId:sourceInstanceUUID,applicationId:applicationUUID,historyEpoch}}})});
 return{...f,commands,configuredFor};
}
function engine(f:Awaited<ReturnType<typeof pendingStaff>>|Awaited<ReturnType<typeof pendingPortal>>){
 const state=new Map(f.records.map(r=>[r.input.recordId,{publicId:f.publicIds.get(r.input.recordId)!,revision:'1',generation:'1',phone:clientProfile.phone,organizationPublicId:null as string|null}]));
 const receipts=new Map<string,{body:string;result:unknown}>(),posts:Array<{id:string;body:any}>=[];
 let conflict='authorization_generation_conflict',loseAck=false,advanceWhenCurrent=false;let onProbe:(()=>Promise<void>)|null=null;
 const send:typeof fetch=async(input,init)=>{
  const path=new URL(String(input)).pathname,requestId=uuid(),base={sourceInstanceId:sourceInstanceUUID,applicationId:applicationUUID,historyEpoch,requestId};
  const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Request-ID':requestId}});
  if(path==='/api/v2/capabilities'){
   if(onProbe){const hook=onProbe;onProbe=null;await hook();}
   const endpoints=[PROJECT_ALPHA_DIRECTORY_CLIENT_CONTACT_PROFILE_ENDPOINT,
    {method:'POST',path:'/api/v2/directory/clients/{publicId}/profile/commands',requiredCapability:'directory.clients.write'},
    {method:'GET',path:'/api/v2/directory/clients/{publicId}',requiredCapability:'directory.clients.read'},
    {method:'GET',path:'/api/v2/bindings/client/status/{base64urlExternalId}',requiredCapability:'directory.clients.binding_status.read'}];
   return reply({...base,apiVersion:'2',grantedCapabilities:[...new Set(['api.capabilities.read',...endpoints.map(e=>e.requiredCapability)])].map(name=>({name})),
    implementedEndpoints:[{method:'GET',path:'/api/v2/capabilities',requiredCapability:'api.capabilities.read'},...endpoints.map(e=>({...e,requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}))]});
  }
  if(path.startsWith('/api/v2/bindings/client/status/')){
   const external=Buffer.from(path.split('/').at(-1)!,'base64url').toString(),v=state.get(external);if(!v)return reply({},404);
   return reply({...base,apiVersion:'2',authorizationGeneration:v.generation,binding:{type:'client',externalId:external,publicId:v.publicId,createdAt:'2026-10-19T00:00:00.000Z'},resource:{present:true,revision:v.revision}});
  }
  const pub=path.split('/')[5],found=[...state.entries()].find(([,v])=>v.publicId===pub);if(!found)return reply({},404);const[id,v]=found;
  if(init?.method!=='POST')return reply({...base,apiVersion:'2',authorizationGeneration:v.generation,resource:{type:'client',id:pub,revision:v.revision},data:{publicId:pub,name:clientProfile.name,email:clientProfile.email,phone:v.phone,clientType:'business',organizationPublicId:v.organizationPublicId,
   address:{line1:clientProfile.addressLine1,line2:clientProfile.addressLine2,city:clientProfile.city,state:clientProfile.state,postalCode:clientProfile.postalCode,country:clientProfile.country}}});
  const body=JSON.parse(String(init.body));posts.push({id,body});const prior=receipts.get(body.commandId);
  if(prior){expect(prior.body).toBe(String(init.body));return reply({...base,replayed:true,result:prior.result});}
  if(advanceWhenCurrent&&body.expectedAuthorizationGeneration===v.generation){advanceWhenCurrent=false;v.generation=String(BigInt(v.generation)+1n);}
  if(body.expectedAuthorizationGeneration!==v.generation)return reply({...base,apiVersion:'2',error:{code:conflict}},409);
  if(body.expectedRevision!==v.revision)return reply({},409);
  v.revision=String(Number(v.revision)+1);v.phone=body.profile.phone;
  const result={resource:{type:'client',publicId:pub,revision:v.revision},authorizationGeneration:v.generation};receipts.set(body.commandId,{body:String(init.body),result});
  if(loseAck){loseAck=false;throw Error('synthetic lost ACK');}return reply({...base,replayed:false,result});
 };
 return{send,state,posts,receipts,set conflict(v:string){conflict=v;},set loseAck(v:boolean){loseAck=v;},set advanceWhenCurrent(v:boolean){advanceWhenCurrent=v;},set onProbe(v:(()=>Promise<void>)|null){onProbe=v;}};
}
async function stale(mode:'staff'|'portal'='staff'){
 const f=mode==='staff'?await pendingStaff():await pendingPortal(),e=engine(f),c=f.commands[1]!,record=f.records.find(r=>r.input.destinations[0]!.sourceId===c.source_id)!;
 const env={...f.configuredFor(c.source_id),NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:'true'};e.state.get(record.input.recordId)!.generation='2';
 expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env,c.source_id,c.command_id,e.send)).toMatchObject({status:'conflict',httpStatus:409});
 const original=await db.prepare('SELECT command_json,outcome_json,state FROM project_alpha_directory_outbox WHERE command_id=?').bind(c.command_id).first();
 return{f,e,c,record,env,original};
}
async function unchanged(t:Awaited<ReturnType<typeof stale>>,edges=0){
 expect(await db.prepare('SELECT command_json,outcome_json,state FROM project_alpha_directory_outbox WHERE command_id=?').bind(t.c.command_id).first()).toEqual(t.original);
 expect(await db.prepare('SELECT count(*) n FROM project_alpha_directory_profile_generation_recoveries WHERE predecessor_command_id=?').bind(t.c.command_id).first('n')).toBe(edges);
}
function atAppend(database:D1Database,change:()=>Promise<unknown>,after=false){
 const sql=new WeakMap<object,string>();let changed=false;
 return new Proxy(database,{get(target,key){
  if(key==='prepare')return(text:string)=>{const wrap=(s:D1PreparedStatement):D1PreparedStatement=>{const p=new Proxy(s,{get(v,k){if(k==='bind')return(...args:any[])=>wrap(v.bind(...args));const member=Reflect.get(v,k);return typeof member==='function'?member.bind(v):member;}});sql.set(p,text);return p;};return wrap(target.prepare(text));};
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{const hit=!changed&&statements.some(s=>sql.get(s)?.includes('INSERT INTO project_alpha_directory_profile_generation_recoveries'));
   if(hit){changed=true;if(!after)await change();}const result=await target.batch(statements);if(hit&&after)await change();return result;};
  const member=Reflect.get(target,key);return typeof member==='function'?member.bind(target):member;
 }});
}
describe('immutable profile update generation recovery with actual D1',()=>{
 for(const mode of ['staff','portal']as const)it(`finishes a two-source ${mode} edit after one ACK and unrelated generation drift`,async()=>{
  const f=mode==='staff'?await pendingStaff():await pendingPortal(),e=engine(f),[first,second]=f.commands;
  expect(first&&second).toBeTruthy();const env=(c:typeof first)=>({...f.configuredFor(c!.source_id),NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:'true'});
  const firstAck=await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(first),first!.source_id,first!.command_id,e.send);
  expect(firstAck,JSON.stringify(firstAck)).toMatchObject({status:'acknowledged'});
  const target=f.records.find(r=>r.input.destinations[0]!.sourceId===second!.source_id)!;e.state.get(target.input.recordId)!.generation='2';
  expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(second),second!.source_id,second!.command_id,e.send)).toMatchObject({status:'conflict',httpStatus:409});
  const original=await db.prepare('SELECT command_json FROM project_alpha_directory_outbox WHERE command_id=?').bind(second!.command_id).first<string>('command_json');
  const recovered=await recoverDirectoryProfileGeneration(env(second),second!.source_id,second!.command_id,e.send);
  expect(recovered,JSON.stringify(recovered)).toMatchObject({status:'acknowledged'});
  expect(await db.prepare('SELECT state FROM project_alpha_directory_outbox WHERE command_id=?').bind(second!.command_id).first('state')).toBe('terminal');
  expect(await db.prepare('SELECT command_json FROM project_alpha_directory_outbox WHERE command_id=?').bind(second!.command_id).first('command_json')).toBe(original);
  expect(await db.prepare('SELECT count(*) n FROM project_alpha_directory_profile_generation_recoveries WHERE predecessor_command_id=?').bind(second!.command_id).first('n')).toBe(1);
 },180000);
 it.each(['generic','revision','association','public']as const)('does not create a successor for a %s conflict',async kind=>{
  const t=await stale(),v=t.e.state.get(t.record.input.recordId)!;
  if(kind==='generic')t.e.conflict='revision_conflict';if(kind==='revision')v.revision='2';
  if(kind==='association')v.organizationPublicId='f'.repeat(32);if(kind==='public')v.publicId='e'.repeat(32);
  expect(await recoverDirectoryProfileGeneration(t.env,t.c.source_id,t.c.command_id,t.e.send)).toMatchObject({status:'blocked'});
  await unchanged(t);expect(t.e.receipts.size).toBe(0);
 },180000);
 it('rechecks remaining-target grants after the PA capability await',async()=>{
  const t=await stale();t.e.onProbe=async()=>{await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,granted_by) VALUES(?,?,'directory.profile.edit','deny','resource',?,'owner')").bind(uuid(),t.f.actor.staffId,t.record.input.recordId).run();};
  const posts=t.e.posts.length;expect(await recoverDirectoryProfileGeneration(t.env,t.c.source_id,t.c.command_id,t.e.send)).toMatchObject({status:'blocked',reason:'authority'});
  expect(t.e.posts).toHaveLength(posts);await unchanged(t);
 },180000);
 it.each(['staff','portal']as const)('atomically rejects a %s authority change between validation and append',async mode=>{
  const t=await stale(mode),changed=async()=>mode==='portal'?revoke(t.f as Awaited<ReturnType<typeof pendingPortal>>):db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,granted_by) VALUES(?,?,'directory.profile.edit','deny','resource',?,'owner')").bind(uuid(),t.f.actor.staffId,t.record.input.recordId).run();
  const hooked=atAppend(db,changed),result=await recoverDirectoryProfileGeneration({...t.env,OPS_DB:hooked},t.c.source_id,t.c.command_id,t.e.send);
  expect(result,JSON.stringify(result)).toMatchObject({status:'uncertain'});await unchanged(t);expect(t.e.receipts.size).toBe(0);
 },180000);
 it('does not POST a successor after target authority is revoked after append',async()=>{
  const t=await stale(),hooked=atAppend(db,()=>db.prepare("UPDATE native_directory_grants SET active=0 WHERE id=?").bind(t.f.actor.selectedGrantId).run(),true);
  expect(await recoverDirectoryProfileGeneration({...t.env,OPS_DB:hooked},t.c.source_id,t.c.command_id,t.e.send)).toMatchObject({status:'blocked',reason:'authority'});
  await unchanged(t,1);expect(t.e.posts.every(p=>p.body.commandId===t.c.command_id)).toBe(true);expect(t.e.receipts.size).toBe(0);
 },180000);
 it('atomically rejects a substantive portal authority-head change before append',async()=>{
  const t=await stale('portal'),hooked=atAppend(db,()=>db.prepare("UPDATE shared_profile_portal_authority_heads SET state='blocked',revision=revision+1 WHERE workspace_id=?").bind((t.f as Awaited<ReturnType<typeof pendingPortal>>).proof.workspaceId).run());
  expect(await recoverDirectoryProfileGeneration({...t.env,OPS_DB:hooked},t.c.source_id,t.c.command_id,t.e.send)).toMatchObject({status:'uncertain'});
  await unchanged(t);expect(t.e.receipts.size).toBe(0);
 },180000);
 it('does not reopen an acknowledged sibling staff permission',async()=>{
  const f=await pendingStaff(),e=engine(f),[first,second]=f.commands;const firstEnv={...f.configuredFor(first!.source_id),NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:'true'};
  expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(firstEnv,first!.source_id,first!.command_id,e.send)).toMatchObject({status:'acknowledged'});
  const sibling=f.records.find(r=>r.input.destinations[0]!.sourceId===first!.source_id)!,record=f.records.find(r=>r.input.destinations[0]!.sourceId===second!.source_id)!;
  await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,granted_by) VALUES(?,?,'directory.profile.edit','deny','resource',?,'owner')").bind(uuid(),f.actor.staffId,sibling.input.recordId).run();e.state.get(record.input.recordId)!.generation='2';
  const env={...f.configuredFor(second!.source_id),NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:'true'};
  expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env,second!.source_id,second!.command_id,e.send)).toMatchObject({status:'conflict'});
  const result=await recoverDirectoryProfileGeneration(env,second!.source_id,second!.command_id,e.send);expect(result,JSON.stringify(result)).toMatchObject({status:'acknowledged'});
 },180000);
 it('replays the same accepted successor after a lost ACK without another recovery edge',async()=>{
  const t=await stale();t.e.loseAck=true;
  expect(await recoverDirectoryProfileGeneration(t.env,t.c.source_id,t.c.command_id,t.e.send)).toMatchObject({status:'uncertain'});await unchanged(t,1);
  const successor=await db.prepare('SELECT successor_command_id FROM project_alpha_directory_profile_generation_recoveries WHERE predecessor_command_id=?').bind(t.c.command_id).first<string>('successor_command_id');
  await new Promise(resolve=>setTimeout(resolve,2100));
  expect(await recoverDirectoryProfileGeneration(t.env,t.c.source_id,t.c.command_id,t.e.send)).toMatchObject({status:'acknowledged'});
  await unchanged(t,1);expect(t.e.receipts.size).toBe(1);expect(t.e.posts.filter(p=>p.body.commandId===successor)).toHaveLength(2);
 },180000);
 it('retains the same association when only its parent company profile version advances',async()=>{
  sourceId='project-alpha:primary';const actor=await seedActor(),parent=await create('organization',actor),parentPublic=await acknowledgeCreate(parent.input,parent.outcome);
  const record=await create('client',actor,undefined,parent.input.recordId),clientPublic=await acknowledgeCreate(record.input,record.outcome);
  const {clientType:_,...profile}=clientProfile;
  const edited=await writeNativeDirectoryProfile(db,{operation:'update',mutationId:uuid(),recordId:record.input.recordId,expectedLocalVersion:1,kind:'client',
   actor,profile:{...profile,phone:'512-555-0199'},destinations:[destination(record.input.recordId,'1')],relationship:{organizationRecordId:parent.input.recordId,expectedRelationshipVersion:1}});
  const command=written(edited).commandIds[0]!;
  expect(await writeNativeDirectoryProfile(db,{operation:'update',mutationId:uuid(),recordId:parent.input.recordId,expectedLocalVersion:1,kind:'organization',actor,
   profile:{...organizationProfile,generalPhone:'512-555-0198'},destinations:[destination(parent.input.recordId,'1')]})).toMatchObject({status:'written'});
  const fake={records:[record],publicIds:new Map([[record.input.recordId,clientPublic]])}as Awaited<ReturnType<typeof pendingStaff>>,e=engine(fake);
  e.state.get(record.input.recordId)!.generation='2';e.state.get(record.input.recordId)!.organizationPublicId=parentPublic;
  const env={OPS_DB:db,NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:'true',PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[sourceId]:{sourceId,enabled:true,baseUrl:origin,apiKey:'test-secret',sourceInstanceId:sourceInstanceUUID,applicationId:applicationUUID,historyEpoch}}})};
  expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env,sourceId,command,e.send)).toMatchObject({status:'conflict'});
  const recovered=await recoverDirectoryProfileGeneration(env,sourceId,command,e.send);expect(recovered,JSON.stringify(recovered)).toMatchObject({status:'acknowledged'});
  expect(await db.prepare('SELECT current_version FROM operations_directory_records WHERE record_id=?').bind(parent.input.recordId).first('current_version')).toBe(2);
 },180000);
 it('bounds immutable successor chains at depth three without resetting any predecessor',async()=>{
  const t=await stale();let predecessor=t.c.command_id;
  for(let depth=1;depth<=3;depth++){
   t.e.advanceWhenCurrent=true;
   expect(await recoverDirectoryProfileGeneration(t.env,t.c.source_id,predecessor,t.e.send)).toMatchObject({status:'conflict',httpStatus:409});
   const edge=await db.prepare('SELECT successor_command_id,recovery_depth FROM project_alpha_directory_profile_generation_recoveries WHERE predecessor_command_id=?').bind(predecessor).first<{successor_command_id:string;recovery_depth:number}>();
   expect(edge?.recovery_depth).toBe(depth);predecessor=edge!.successor_command_id;
  }
  const posts=t.e.posts.length;
  expect(await recoverDirectoryProfileGeneration(t.env,t.c.source_id,predecessor,t.e.send)).toMatchObject({status:'blocked',reason:'depth'});
  expect(t.e.posts).toHaveLength(posts);await unchanged(t,1);
  expect(await db.prepare('SELECT count(*) FROM project_alpha_directory_profile_generation_recoveries WHERE root_command_id=?').bind(t.c.command_id).first('count(*)')).toBe(3);
  expect(t.e.receipts.size).toBe(0);
 },240000);
 it('does not append when the freshly observed authorization generation is exhausted',async()=>{
  const t=await stale();t.e.state.get(t.record.input.recordId)!.generation='9223372036854775807';
  expect(await recoverDirectoryProfileGeneration(t.env,t.c.source_id,t.c.command_id,t.e.send)).toMatchObject({status:'blocked'});
  await unchanged(t);expect(t.e.receipts.size).toBe(0);
 },180000);
 it('ignores more than 512 unrelated historical source commands when fencing current authority',async()=>{
  const t=await stale();
  // These are unrelated terminal transport history, not fabricated authority,
  // materializations, mappings, PA acknowledgements, or recovery proofs.
  for(let offset=0;offset<513;offset+=100){
   await db.batch(Array.from({length:Math.min(100,513-offset)},()=>{
    const id=uuid(),external=uuid();
    return db.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,external_id,command_json,
     destination_base_url,expected_source_instance_id,origin_snapshot_json,expected_history_epoch_id,state,outcome_json,next_attempt_at)
     VALUES(?,?,?,'client',?,?,?,?,?,?,'terminal','{"httpStatus":409}',0)`)
     .bind(id,t.c.source_id,applicationUUID,external,JSON.stringify({commandId:id,operation:'update',externalId:external}),origin,sourceInstanceUUID,'{}',historyEpoch);
   }));
  }
  expect(await db.prepare('SELECT count(*) n FROM project_alpha_directory_outbox WHERE source_id=?').bind(t.c.source_id).first('n')).toBeGreaterThan(512);
  expect(await recoverDirectoryProfileGeneration(t.env,t.c.source_id,t.c.command_id,t.e.send)).toMatchObject({status:'acknowledged'});
  await unchanged(t,1);
 },180000);
});
