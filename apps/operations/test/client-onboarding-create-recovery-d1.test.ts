import {readFileSync,readdirSync} from 'node:fs';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {Miniflare} from 'miniflare';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import {approveNewNativeOnlyClientOnboarding} from '../src/worker/client-onboarding-approval';
import {drainNativeDirectoryOutboxes} from '../src/worker/native-directory-outbox-scheduler';
import {writeNativeDirectoryProfile} from '../src/worker/native-directory-profile-writer';
const inventoryRead=vi.hoisted(()=>vi.fn());
vi.mock('../src/worker/project-alpha-directory-inventory-api-v2',()=>({readConfiguredProjectAlphaDirectoryInventory:inventoryRead}));
let mf:Miniflare,db:D1Database,seq=0;
const uuid=()=>`70000000-0000-4000-8000-${(++seq).toString(16).padStart(12,'0')}`;
const instance='a0000000-0000-4000-8000-000000000001',application='b0000000-0000-4000-8000-000000000002',epoch='c0000000-0000-4000-8000-000000000003';
const fields={clientType:'consumer',name:'Synthetic client',email:'synthetic@example.test',phone:'',organizationName:'',organizationEmail:'',organizationPhone:'',addressLine1:'',addressLine2:'',city:'',state:'',postalCode:'',country:''};
beforeAll(async()=>{mf=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:"export default {fetch(){return new Response('ok')}}",d1Databases:['OPS_DB']});db=await mf.getD1Database('OPS_DB')as D1Database;
 const root=new URL('../migrations/',import.meta.url);for(const name of readdirSync(root).filter(n=>/^\d{4}_.+\.sql$/.test(n)&&n.slice(0,4)<='0219').sort())await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,root),'utf8')).map(sql=>db.prepare(sql)));
},240000);
afterAll(async()=>mf?.dispose());
async function fixture(){
 const staff=uuid(),area=uuid(),source=`project-alpha:batch-${seq}`,origin=`https://batch-${seq}.example.test`,subject='test|'+staff,email='owner-'+seq+'@example.test';
 await db.batch([
  db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,'Synthetic',?,'active')").bind(staff,email,subject),
  db.prepare('INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)').bind(staff,subject,staff),
  db.prepare('INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)').bind(staff,email,'Synthetic'),
  db.prepare('INSERT INTO native_business_areas(id,name,active) VALUES(?,?,1)').bind(area,area),
  ...['directory.profile.edit','directory.identity.link','directory.enrollment.manage'].map(permission=>db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by) VALUES(?,?,?,'allow','global',1,?)").bind(staff+permission,staff,permission,staff))]);
 const actor={identity:{kind:'native'as const,staffId:staff,verifiedAccessSubject:subject,email,displayName:'Synthetic',profileVersion:1},admissionVersion:1,verifiedUntil:new Date(Date.now()+3600000).toISOString()};
 const connections=JSON.stringify({version:1,instances:{[source]:{sourceId:source,enabled:true,baseUrl:origin,apiKey:'test-only',sourceInstanceId:instance,applicationId:application,historyEpoch:epoch}}});
 const env={OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:connections,NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:'true',CLIENT_ONBOARDING_ADMIN_ENABLED:'true',PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED:'true'};
 inventoryRead.mockResolvedValue({status:'observed',inventory:{authorizationGeneration:'8'}});
 async function approve(business=false){const invitationId=uuid(),submissionId=uuid(),hash='a'.repeat(64);
  await db.batch([db.prepare("INSERT INTO client_onboarding_invitations(invitation_id,secret_sha256,issued_by,bound_access_subject,expires_at,target_client_record_id,state,version) VALUES(?,?,?,?,?,NULL,'pending',1)").bind(invitationId,hash,staff,subject,actor.verifiedUntil),
   db.prepare('INSERT INTO client_onboarding_issuance_commands(invitation_id,command_id,request_sha256,scopes_json,issuer_admission_version,issuer_profile_version,issuer_email,verified_until) VALUES(?,?,?,?,1,1,?,?)').bind(invitationId,uuid(),hash,JSON.stringify([{businessAreaId:area,divisionId:null}]),email,actor.verifiedUntil),
   db.prepare('INSERT INTO client_onboarding_submissions(invitation_id,submission_id,fields_json,fields_sha256) VALUES(?,?,?,?)').bind(invitationId,submissionId,JSON.stringify({...fields,...(business?{clientType:'business',organizationName:'Synthetic company'}:{})}),hash)]);
  return approveNewNativeOnlyClientOnboarding(db,actor,submissionId,hash,[source],connections,business?{kind:'new'}:undefined);
 }
 let generation=8,publicSequence=0;const receipts=new Map<string,{body:string;result:unknown}>(),created=new Map<string,{publicId:string;kind:string;revision:string}>(),posts:Array<{body:Record<string,any>;path:string}>=[];
 let conflictCode='authorization_generation_conflict',networkFailure=false,loseNextAcknowledgement=false;let capabilityHook:(()=>Promise<void>)|null=null;
 const response=(v:unknown,status=200)=>{const requestId=(v as any).requestId;return new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Request-ID':requestId}});};
 const send=vi.fn<typeof fetch>(async(url,init)=>{const path=new URL(String(url)).pathname,requestId=uuid();const base={sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,requestId};
  if(path.endsWith('/capabilities')){if(capabilityHook){const hook=capabilityHook;capabilityHook=null;await hook();}return response({...base,apiVersion:'2',grantedCapabilities:['api.capabilities.read','directory.inventory.read','directory.clients.create','directory.organizations.create','directory.clients.organization.assign'].map(name=>({name})),implementedEndpoints:[{method:'GET',path:'/api/v2/capabilities',requiredCapability:'api.capabilities.read'},{method:'GET',path:'/api/v2/directory/inventory',requiredCapability:'directory.inventory.read',requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},...['clients','organizations'].map(plural=>({method:'POST',path:`/api/v2/directory/${plural}/commands`,requiredCapability:`directory.${plural}.create`,requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}))]});}
  if(path.endsWith('/inventory'))return response({...base,authorizationGeneration:String(generation),resources:[],nextCursor:null});
  if(init?.method!=='POST')return response({...base},404);
  const body=JSON.parse(String(init.body));posts.push({body,path});if(networkFailure)throw Error('synthetic network uncertainty');
  const prior=receipts.get(body.commandId);if(prior){expect(prior.body).toBe(String(init.body));return response({...base,replayed:true,result:prior.result},200);}
  if(body.expectedAuthorizationGeneration!==String(generation))return response({...base,apiVersion:'2',error:{code:conflictCode}},409);
  if(created.has(body.externalId))return response({...base,error:{code:'binding_exists'}},409);
  if(body.organization){const parent=created.get(body.organization.externalId);expect(parent?.kind).toBe('organization');expect(body.organization.expectedRevision).toBe(parent?.revision);}
  const kind=path.includes('/organizations/')?'organization':'client',publicId=(++publicSequence).toString(16).padStart(32,'0');created.set(body.externalId,{publicId,kind,revision:'1'});generation++;
  const result={resource:{type:kind,id:body.externalId,publicId,revision:'1'},authorizationGeneration:String(generation)};receipts.set(body.commandId,{body:String(init.body),result});if(loseNextAcknowledgement){loseNextAcknowledgement=false;throw Error('synthetic lost accepted response');}return response({...base,replayed:false,result},201);
 });
 const writerActor={staffId:staff,accessSubject:subject,admissionVersion:1,profileVersion:1,loginEmail:email,
  selectedGrantId:staff+'directory.profile.edit',selectedIdentityGrantId:staff+'directory.identity.link'};
 return {staff,area,source,origin,actor,writerActor,env,approve,send,posts,created,
  set onCapabilities(value:(()=>Promise<void>)|null){capabilityHook=value;},set loseNextAcknowledgement(value:boolean){loseNextAcknowledgement=value;},get generation(){return generation;},set conflictCode(value:string){conflictCode=value;},set networkFailure(value:boolean){networkFailure=value;}};
}
async function drain(f:Awaited<ReturnType<typeof fixture>>){return drainNativeDirectoryOutboxes(f.env,{send:f.send,rotationTime:0,maxCommands:12});}
async function state(record:string){return(await db.prepare('SELECT state FROM operations_directory_intents WHERE record_id=? ORDER BY source_id').bind(record).all<{state:string}>()).results.map(x=>x.state);}
describe('automatic approved onboarding create recovery against actual migrated D1',()=>{
 it('sequentially completes several same-generation consumer creates and a linked business parent/client without changing approved bytes',async()=>{
  const f=await fixture(),one=await f.approve(),two=await f.approve(),business=await f.approve(true);
  expect(one.status).toBe('written');expect(two.status).toBe('written');expect(business.status).toBe('written');
  const history=[];for(let tick=0;tick<3;tick++)history.push(await drain(f));
  expect(history[0]!.acknowledged).toBe(3);expect(history[0]!.attempted).toBeLessThanOrEqual(12);
  for(const record of [one.clientRecordId,two.clientRecordId,business.organizationRecordId!,business.clientRecordId])expect(await state(record),JSON.stringify({record,history,outbox:(await db.prepare('SELECT source_id,state,attempts,outcome_json FROM project_alpha_directory_outbox WHERE source_id=?').bind(f.source).all()).results})).toEqual(['acknowledged']);
  expect(f.created.size).toBe(4);expect(f.generation).toBe(12);
  const recovery=(await db.prepare(`SELECT predecessor_command_json,successor_command_json,resource_type FROM project_alpha_directory_create_generation_recoveries WHERE source_id=? ORDER BY rowid`).bind(f.source).all<{predecessor_command_json:string;successor_command_json:string;resource_type:string}>()).results;
  expect(recovery.length).toBe(3);expect(recovery.some(r=>r.resource_type==='organization')).toBe(true);
  for(const row of recovery){const old=JSON.parse(row.predecessor_command_json),next=JSON.parse(row.successor_command_json);expect(next).toEqual({...old,commandId:next.commandId,expectedAuthorizationGeneration:next.expectedAuthorizationGeneration});expect(next.commandId).not.toBe(old.commandId);}
  const linked=f.posts.filter(x=>x.body.externalId===business.clientRecordId);expect(linked.length).toBeGreaterThan(1);expect(linked.every(x=>x.body.organization?.externalId===business.organizationRecordId&&x.body.organization?.expectedRevision==='1')).toBe(true);
  const before=f.posts.length;await drain(f);expect(f.created.size).toBe(4);expect(f.posts.length).toBe(before);
 },180000);
 it('never auto-recovers undifferentiated or wrong-code409 responses',async()=>{const f=await fixture();const one=await f.approve(),two=await f.approve();f.conflictCode='revision_conflict';await drain(f);const before=f.posts.length;await drain(f);expect(f.posts.length).toBe(before+1);expect(await state(one.clientRecordId)).toEqual(['acknowledged']);expect(await state(two.clientRecordId)).toEqual(['materialized']);expect(await db.prepare('SELECT count(*) n FROM project_alpha_directory_create_generation_recoveries WHERE source_id=?').bind(f.source).first('n')).toBe(0);expect(f.created.size).toBe(1);},90000);
 it('denies a revoked original reviewer before any recovery replay',async()=>{const f=await fixture();await f.approve();await f.approve();f.env.CLIENT_ONBOARDING_ADMIN_ENABLED='false';await drain(f);f.env.CLIENT_ONBOARDING_ADMIN_ENABLED='true';await db.prepare('UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?').bind(f.staff).run();const before=f.posts.length;await drain(f);expect(f.posts.length).toBe(before);expect(await db.prepare('SELECT count(*) n FROM project_alpha_directory_create_generation_recoveries WHERE source_id=?').bind(f.source).first('n')).toBe(0);},90000);
 it('does not retry an uncertain recovery replay or append another command',async()=>{const f=await fixture();await f.approve();await f.approve();f.env.CLIENT_ONBOARDING_ADMIN_ENABLED='false';await drain(f);f.env.CLIENT_ONBOARDING_ADMIN_ENABLED='true';f.networkFailure=true;const before=f.posts.length;await drain(f);expect(f.posts.length).toBe(before+1);expect(await db.prepare('SELECT count(*) n FROM project_alpha_directory_create_generation_recoveries WHERE source_id=?').bind(f.source).first('n')).toBe(0);expect(f.created.size).toBe(1);},90000);
 it('checks current native authority after the capability await before normal create POST',async()=>{
  const f=await fixture();await f.approve();f.onCapabilities=async()=>{await db.prepare('UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?').bind(f.staff).run();};
  await drain(f);expect(f.posts).toHaveLength(0);expect(f.created.size).toBe(0);
 },90000);
 it('preserves native deny precedence for a previously approved create',async()=>{
  const f=await fixture();await f.approve();const two=await f.approve();f.env.CLIENT_ONBOARDING_ADMIN_ENABLED='false';await drain(f);f.env.CLIENT_ONBOARDING_ADMIN_ENABLED='true';
  await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,active,granted_by) VALUES(?,?,'directory.profile.edit','deny','resource',?,1,?)").bind(uuid(),f.staff,two.clientRecordId,f.staff).run();
  const before=f.posts.length;await drain(f);expect(f.posts.length).toBe(before);expect(await state(two.clientRecordId)).toEqual(['materialized']);
 },90000);
 it('denies a changed source epoch without replaying the old command',async()=>{
  const f=await fixture();await f.approve();await f.approve();f.env.CLIENT_ONBOARDING_ADMIN_ENABLED='false';await drain(f);f.env.CLIENT_ONBOARDING_ADMIN_ENABLED='true';
  const config=JSON.parse(f.env.PROJECT_ALPHA_API_V2_CONNECTIONS);config.instances[f.source].historyEpoch=uuid();f.env.PROJECT_ALPHA_API_V2_CONNECTIONS=JSON.stringify(config);
  const before=f.posts.length;await drain(f);expect(f.posts.length).toBe(before);
 },90000);
 it('revalidates an unchanged linked parent after recovery capability await',async()=>{
  const f=await fixture(),item=await f.approve(true);f.env.CLIENT_ONBOARDING_ADMIN_ENABLED='false';await drain(f);await drain(f);f.env.CLIENT_ONBOARDING_ADMIN_ENABLED='true';
  expect(await state(item.organizationRecordId!)).toEqual(['acknowledged']);expect(await state(item.clientRecordId)).toEqual(['materialized']);
  let parentChange:unknown;f.onCapabilities=async()=>{const raw=await db.prepare('SELECT profile_json FROM operations_directory_revisions WHERE record_id=? AND version=1').bind(item.organizationRecordId!).first<string>('profile_json');
   parentChange=await writeNativeDirectoryProfile(db,{operation:'update',mutationId:uuid(),recordId:item.organizationRecordId!,expectedLocalVersion:1,kind:'organization',profile:{...JSON.parse(raw!),name:'Changed after approval'},destinations:[{sourceId:f.source,sourceInstanceUUID:instance,applicationUUID:application,historyEpoch:epoch,origin:f.origin,externalCanonicalId:item.organizationRecordId!,expectedAuthorizationGeneration:'9'}],actor:f.writerActor});};
  const before=f.posts.length;await drain(f);expect(parentChange,JSON.stringify(parentChange)).toMatchObject({status:'written'});expect(f.posts.length).toBe(before);expect(await db.prepare('SELECT current_version FROM operations_directory_records WHERE record_id=?').bind(item.organizationRecordId!).first('current_version')).toBe(2);expect(await db.prepare('SELECT count(*) n FROM project_alpha_directory_create_generation_recoveries WHERE source_id=?').bind(f.source).first('n')).toBe(0);
 },90000);
 it('replays a lost accepted response under its original command without another PA creation',async()=>{
  const f=await fixture(),item=await f.approve();f.loseNextAcknowledgement=true;await drain(f);expect(f.posts).toHaveLength(1);expect(f.created.size).toBe(1);
  // Advance only this synthetic pending command's supported retry timestamp;
  // never alter its bytes, state, authority or receipt.
  await db.prepare("UPDATE project_alpha_directory_outbox SET next_attempt_at=0 WHERE source_id=? AND state='pending'").bind(f.source).run();
  await drain(f);expect(f.posts).toHaveLength(2);expect(f.posts[1]!.body).toEqual(f.posts[0]!.body);expect(f.created.size).toBe(1);expect(await state(item.clientRecordId)).toEqual(['acknowledged']);
 },90000);
 it('does not auto-recover a non-onboarding staff create even when its generation conflict is typed',async()=>{
  const f=await fixture(),record=uuid(),mutation=uuid(),admission=uuid();
  const profile={name:'Ordinary native company',generalEmail:'',generalPhone:'',addressLine1:'',addressLine2:'',city:'',state:'',postalCode:'',country:''};
  const destination={sourceId:f.source,sourceInstanceUUID:instance,applicationUUID:application,historyEpoch:epoch,origin:f.origin,externalCanonicalId:record,expectedAuthorizationGeneration:'7'};
  const {expectedAuthorizationGeneration,...enrolled}=destination;
  await db.prepare("INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by) VALUES(?,?,?,?,'organization',?,?,?,?)").bind(admission,f.staff,f.actor.identity.verifiedAccessSubject,record,JSON.stringify([{businessAreaId:f.area,divisionId:null}]),JSON.stringify(profile),JSON.stringify([enrolled]),f.staff).run();
  expect((await writeNativeDirectoryProfile(db,{operation:'create',mutationId:mutation,createAdmissionId:admission,recordId:record,expectedLocalVersion:0,kind:'organization',profile,scopes:[{businessAreaId:f.area,divisionId:null}],destinations:[destination],actor:f.writerActor})).status).toBe('written');
  await drain(f);await drain(f);expect(f.posts).toHaveLength(1);expect(await db.prepare('SELECT count(*) n FROM project_alpha_directory_create_generation_recoveries WHERE source_id=?').bind(f.source).first('n')).toBe(0);
 },90000);

});
