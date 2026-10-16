import {readFileSync,readdirSync} from 'node:fs';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {Miniflare} from 'miniflare';
import type {Env} from '../src/worker/types';
import type {SharedProfilePortalProof} from '../../../packages/shared/src/shared-business-profile';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import {writeNativeDirectoryProfile,writeNativeDirectorySharedPortalProfiles,type NativeDirectoryCreateWrite,type NativeDirectoryDestinationAuthority,type NativeDirectoryProfileWrite,type NativeDirectoryProfileWriteOutcome,type NativeDirectoryPortalWriterActor,type NativeDirectoryPortalUpdateWrite} from '../src/worker/native-directory-profile-writer';
import {sharedProfileCreationFence} from '../src/worker/native-directory-shared-profile-routes';
import {prepareSharedProfilePortalWrite,normalizePortalBusinessProfile} from '../src/worker/shared-profile-portal-authority';
import {dispatchProjectAlphaDirectoryProfileOutboxCommand} from '../src/worker/project-alpha-directory-profile-outbox-dispatcher';
import {PROJECT_ALPHA_DIRECTORY_CLIENT_CONTACT_PROFILE_ENDPOINT} from '../src/worker/project-alpha-directory-profile-api-v2';
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
  const migrations = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0209").sort();
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
  return {actor,records,groupId,grantId,profile,proof,env:{OPS_DB:db} as Env};
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
describe('portal dispatch fresh authority and neutral transport',()=>{
 it('dispatches both members across a refreshed head with system audit',async()=>{
  const f=await pendingPortal(5_000);await new Promise(resolve=>setTimeout(resolve,5_100));for(const [index,c] of f.commands.entries()){
   if(index)await db.prepare('UPDATE shared_profile_portal_authority_heads SET revision=revision+1,operation_id=? WHERE workspace_id=?').bind(uuid(),f.proof.workspaceId).run();
   const result=await dispatchProjectAlphaDirectoryProfileOutboxCommand(f.configuredFor(c.source_id),c.source_id,c.command_id,f.send);expect(result,JSON.stringify(result)).toMatchObject({status:'acknowledged'});
  }expect(f.posts).toHaveLength(2);
  for(const c of f.commands){expect(await db.prepare('SELECT count(*) n FROM native_directory_profile_binding_jobs WHERE command_id=?').bind(c.command_id).first('n')).toBe(1);}
  const audits=await db.prepare("SELECT actor_kind,actor_id,detail_json FROM shared_profile_portal_audit WHERE grant_id=? AND action='profile.delivery_authority'").bind(f.grantId).all<{actor_kind:string;actor_id:string;detail_json:string}>();expect(audits.results.map(a=>JSON.parse(a.detail_json).authorityRevision)).toEqual([1,2]);expect(audits.results.every(a=>a.actor_kind==='system'&&a.actor_id===`portal:${f.grantId}`)).toBe(true);
 });
 it('blocks revoked authority without a network request',async()=>{const f=await pendingPortal(),c=f.commands[0]!;await revoke(f);expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(f.configuredFor(c.source_id),c.source_id,c.command_id,f.send)).toMatchObject({status:'blocked',reason:'authority'});expect(f.send).not.toHaveBeenCalled();});
 it('rechecks after capability probe immediately before POST',async()=>{const f=await pendingPortal(),c=f.commands[0]!;f.setProbe(()=>revoke(f));expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(f.configuredFor(c.source_id),c.source_id,c.command_id,f.send)).toMatchObject({status:'blocked',reason:'authority'});expect(f.posts).toHaveLength(0);});
 it('rejects a stale fresh head or a foreign principal',async()=>{for(const mode of ['head','principal']){const f=await pendingPortal(),c=f.commands[0]!;f.proofReader.mockImplementation(async()=>({ok:true,proof:{...f.proof,...(mode==='head'?{authorityRevision:99}:{targets:[{...f.proof.targets[0]!,principalPublicId:'foreign'}]})}}));expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(f.configuredFor(c.source_id),c.source_id,c.command_id,f.send)).toMatchObject({status:'blocked',reason:'authority'});expect(f.send).not.toHaveBeenCalled();}});
});
it('denies a missing Client binding and a rejected live authority response',async()=>{
 const f=await pendingPortal(),c=f.commands[0]!;
 expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand({...f.configured,SHARED_PROFILE_PORTAL_AUTHORITY:undefined},c.source_id,c.command_id,f.send)).toMatchObject({status:'blocked',reason:'authority'});
 const denied={...f.configured,SHARED_PROFILE_PORTAL_AUTHORITY:{readAuthority:async()=>({ok:false as const,code:'denied' as const})}};
 expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(denied,c.source_id,c.command_id,f.send)).toMatchObject({status:'blocked',reason:'authority'});expect(f.send).not.toHaveBeenCalled();
});

it('completes an already acknowledged portal binding repair after the edit grant is revoked',async()=>{
 const f=await pendingPortal(),c=f.commands[0]!,configured=f.configuredFor(c.source_id);
 expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(configured,c.source_id,c.command_id,f.send)).toMatchObject({status:'acknowledged'});
 const job=await db.prepare('SELECT external_id,public_id,resource_type,live_revision FROM native_directory_profile_binding_jobs WHERE command_id=?')
  .bind(c.command_id).first<{external_id:string;public_id:string;resource_type:string;live_revision:string}>();
 expect(job).not.toBeNull();if(!job)throw Error('Portal ACK must create the exact continuation job');
 await revoke(f);await db.prepare("UPDATE shared_profile_portal_authority_heads SET state='blocked',revision=revision+1,operation_id=? WHERE workspace_id=?")
  .bind(uuid(),f.proof.workspaceId).run();
 let generation='1',bindingRevision='1',refreshes=0;
 const send:typeof fetch=async(input,init)=>{
  const path=new URL(String(input)).pathname,requestId=uuid();
  const reply=(body:Record<string,unknown>)=>Response.json({sourceInstanceId:sourceInstanceUUID,applicationId:applicationUUID,historyEpoch,requestId,...body},
   {headers:{'Cache-Control':'no-store','X-Request-ID':requestId}});
  if(path==='/api/v2/capabilities'){
   const endpoints=[['GET','/api/v2/directory/inventory','directory.inventory.read'],
    ['POST','/api/v2/directory/clients/bindings/revisions/commands','directory.clients.binding.revision.refresh']];
   return reply({apiVersion:'2',grantedCapabilities:[{name:'api.capabilities.read'},...endpoints.map(e=>({name:e[2]}))],
    implementedEndpoints:[{method:'GET',path:'/api/v2/capabilities',requiredCapability:'api.capabilities.read'},...endpoints.map(([method,path,requiredCapability])=>({method,path,requiredCapability,requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}))]});
  }
  if(path==='/api/v2/directory/inventory')return reply({authorizationGeneration:generation,resources:[{type:'client',publicId:job.public_id,
   revision:job.live_revision,present:true,lastAction:'upsert',projectionSha256:'b'.repeat(64),binding:{status:'active',externalId:job.external_id,resourceRevision:bindingRevision}}],nextCursor:null});
  if(path==='/api/v2/directory/clients/bindings/revisions/commands'){
   const command=JSON.parse(String(init?.body));expect(command.externalId).toBe(job.external_id);expect(command.expectedPriorRevision).toBe('1');
   refreshes++;generation='2';bindingRevision=job.live_revision;
   return reply({replayed:false,result:{resource:{type:'client',id:job.external_id,revision:job.live_revision},binding:{publicId:job.public_id,previousRevision:'1',authorizationGeneration:generation}}});
  }
  throw Error(`Unexpected binding repair request ${path}`);
 };
 const {SHARED_PROFILE_PORTAL_AUTHORITY:_,...withoutPortalBinding}=configured;
 const result=await dispatchNativeDirectoryProfileBindingContinuation({...withoutPortalBinding,ENVIRONMENT:'local',NATIVE_DIRECTORY_PROFILE_BINDING_CONTINUATION_ENABLED:'true'},c.source_id,c.command_id,send);
 expect(result).toEqual({status:'acknowledged'});expect(refreshes).toBe(1);
 expect(await db.prepare('SELECT state FROM native_directory_profile_binding_dispatch WHERE command_id=?').bind(c.command_id).first('state')).toBe('complete');
 expect(await db.prepare('SELECT state FROM shared_profile_portal_grants WHERE id=?').bind(f.grantId).first('state')).toBe('revoked');
});

it('does not persist an ACK after authority is revoked during the remote mutation',async()=>{
 const f=await pendingPortal(),c=f.commands[0]!;f.setPost(()=>revoke(f));
 expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(f.configuredFor(c.source_id),c.source_id,c.command_id,f.send)).toMatchObject({status:'blocked',reason:'authority'});expect(f.posts).toHaveLength(1);
 expect(await db.prepare('SELECT state FROM project_alpha_directory_outbox WHERE command_id=?').bind(c.command_id).first('state')).toBe('pending');
 expect(await db.prepare('SELECT count(*) n FROM native_directory_profile_binding_jobs WHERE command_id=?').bind(c.command_id).first('n')).toBe(0);
});
