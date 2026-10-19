import {readFileSync,readdirSync} from 'node:fs';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {Miniflare} from 'miniflare';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import {approveNewNativeOnlyClientOnboarding} from '../src/worker/client-onboarding-approval';
import {drainNativeDirectoryOutboxes} from '../src/worker/native-directory-outbox-scheduler';
import {writeNativeDirectoryProfile} from '../src/worker/native-directory-profile-writer';
const inventoryRead=vi.hoisted(()=>vi.fn());
const bindingRead=vi.hoisted(()=>vi.fn());
vi.mock('../src/worker/project-alpha-directory-read-api-v2',async original=>({...await original<typeof import('../src/worker/project-alpha-directory-read-api-v2')>(),readConfiguredProjectAlphaDirectoryBindingStatus:bindingRead}));
vi.mock('../src/worker/project-alpha-directory-inventory-api-v2',()=>({readConfiguredProjectAlphaDirectoryInventory:inventoryRead}));
let mf:Miniflare,db:D1Database,seq=0;
const uuid=()=>`70000000-0000-4000-8000-${(++seq).toString(16).padStart(12,'0')}`;
const instance='a0000000-0000-4000-8000-000000000001',application='b0000000-0000-4000-8000-000000000002',epoch='c0000000-0000-4000-8000-000000000003';
const fields={clientType:'consumer',name:'Synthetic client',email:'synthetic@example.test',phone:'',organizationName:'',organizationEmail:'',organizationPhone:'',addressLine1:'',addressLine2:'',city:'',state:'',postalCode:'',country:''};
beforeAll(async()=>{mf=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:"export default {fetch(){return new Response('ok')}}",d1Databases:['OPS_DB']});db=await mf.getD1Database('OPS_DB')as D1Database;
 const root=new URL('../migrations/',import.meta.url);for(const name of readdirSync(root).filter(n=>/^\d{4}_.+\.sql$/.test(n)&&n.slice(0,4)<='0220').sort())await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,root),'utf8')).map(sql=>db.prepare(sql)));
},240000);
afterAll(async()=>mf?.dispose());
async function fixture(){
 const staff=uuid(),area=uuid(),source=`project-alpha:batch-${seq}`,origin=`https://batch-${seq}.example.test`,subject='test|'+staff,email='owner-'+seq+'@example.test';
 await db.batch([
  db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,'Synthetic',?,'active')").bind(staff,email,subject),
  db.prepare('INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)').bind(staff,subject,staff),
  db.prepare('INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)').bind(staff,email,'Synthetic'),
  db.prepare('INSERT INTO native_business_areas(id,name,active) VALUES(?,?,1)').bind(area,area),
  ...['directory.profile.view','directory.profile.edit','directory.identity.link','directory.enrollment.manage'].map(permission=>db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by) VALUES(?,?,?,'allow','global',1,?)").bind(staff+permission,staff,permission,staff))]);
 const actor={identity:{kind:'native'as const,staffId:staff,verifiedAccessSubject:subject,email,displayName:'Synthetic',profileVersion:1},admissionVersion:1,verifiedUntil:new Date(Date.now()+3600000).toISOString()};
 const connections=JSON.stringify({version:1,instances:{[source]:{sourceId:source,enabled:true,baseUrl:origin,apiKey:'test-only',sourceInstanceId:instance,applicationId:application,historyEpoch:epoch}}});
 const env={OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:connections,NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:'true',CLIENT_ONBOARDING_ADMIN_ENABLED:'true',PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED:'true'};
 async function approve(business=false,existing?:string){const invitationId=uuid(),submissionId=uuid(),hash='a'.repeat(64);
  await db.batch([db.prepare("INSERT INTO client_onboarding_invitations(invitation_id,secret_sha256,issued_by,bound_access_subject,expires_at,target_client_record_id,state,version) VALUES(?,?,?,?,?,NULL,'pending',1)").bind(invitationId,hash,staff,subject,actor.verifiedUntil),
   db.prepare('INSERT INTO client_onboarding_issuance_commands(invitation_id,command_id,request_sha256,scopes_json,issuer_admission_version,issuer_profile_version,issuer_email,verified_until) VALUES(?,?,?,?,1,1,?,?)').bind(invitationId,uuid(),hash,JSON.stringify([{businessAreaId:area,divisionId:null}]),email,actor.verifiedUntil),
   db.prepare('INSERT INTO client_onboarding_submissions(invitation_id,submission_id,fields_json,fields_sha256) VALUES(?,?,?,?)').bind(invitationId,submissionId,JSON.stringify({...fields,...(business?{clientType:'business',organizationName:'Synthetic company'}:{})}),hash)]);
  return approveNewNativeOnlyClientOnboarding(db,actor,submissionId,hash,[source],connections,business?(existing?{kind:'existing',recordId:existing,expectedVersion:1}:{kind:'new'}):undefined);
 }
 let generation=8,publicSequence=0;const receipts=new Map<string,{body:string;result:any;update?:boolean}>(),created=new Map<string,{publicId:string;kind:string;revision:string;profile:Record<string,string>}>(),posts:Array<{body:Record<string,any>;path:string}>=[];
 inventoryRead.mockImplementation(async()=>({status:'observed',inventory:{authoritative:false,sourceId:source,
  sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,requestId:uuid(),
  authorizationGeneration:String(generation),resources:[],nextCursor:null}}));
 let conflictCode='authorization_generation_conflict',networkFailure=false,loseNextAcknowledgement=false;let capabilityHook:(()=>Promise<void>)|null=null;
 const response=(v:unknown,status=200)=>{const requestId=(v as any).requestId;return new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Request-ID':requestId}});};
 const send=vi.fn<typeof fetch>(async(url,init)=>{const path=new URL(String(url)).pathname,requestId=uuid();const base={sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,requestId};
  if(path.endsWith('/capabilities')){if(capabilityHook){const hook=capabilityHook;capabilityHook=null;await hook();}return response({...base,apiVersion:'2',grantedCapabilities:['api.capabilities.read','directory.inventory.read','directory.clients.create','directory.organizations.create','directory.clients.organization.assign','directory.organizations.write','directory.organizations.read','directory.organizations.binding_status.read'].map(name=>({name})),implementedEndpoints:[{method:'GET',path:'/api/v2/capabilities',requiredCapability:'api.capabilities.read'},{method:'GET',path:'/api/v2/directory/inventory',requiredCapability:'directory.inventory.read',requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},{method:'POST',path:'/api/v2/directory/organizations/{publicId}/profile/commands',requiredCapability:'directory.organizations.write',requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},{method:'GET',path:'/api/v2/directory/organizations/{publicId}',requiredCapability:'directory.organizations.read',requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},{method:'GET',path:'/api/v2/bindings/organization/status/{base64urlExternalId}',requiredCapability:'directory.organizations.binding_status.read',requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},...['clients','organizations'].map(plural=>({method:'POST',path:`/api/v2/directory/${plural}/commands`,requiredCapability:`directory.${plural}.create`,requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}))]});}
  if(path.endsWith('/inventory'))return response({...base,authorizationGeneration:String(generation),resources:[],nextCursor:null});
  if(path.includes('/bindings/organization/status/')){const ext=Buffer.from(path.split('/').at(-1)!,'base64url').toString();const item=created.get(ext);return item?response({...base,apiVersion:'2',authorizationGeneration:String(generation),binding:{type:'organization',externalId:ext,publicId:item.publicId,createdAt:'2026-10-19T00:00:00Z'},resource:{present:true,revision:item.revision}}):response({...base},404);}
  if(init?.method!=='POST'&&path.includes('/directory/organizations/')){const pub=path.split('/').at(-1);const item=[...created.values()].find(v=>v.publicId===pub);return item?response({...base,apiVersion:'2',authorizationGeneration:String(generation),resource:{type:'organization',id:pub,revision:item.revision},data:{publicId:pub,name:item.profile.name,email:item.profile.generalEmail||null,phone:item.profile.generalPhone||null,address:{line1:item.profile.addressLine1||null,line2:item.profile.addressLine2||null,city:item.profile.city||null,state:item.profile.state||null,postalCode:item.profile.postalCode||null,country:item.profile.country||null}}}):response({...base},404);}
  if(init?.method!=='POST')return response({...base},404);
  const body=JSON.parse(String(init.body));posts.push({body,path});if(networkFailure)throw Error('synthetic network uncertainty');
  const prior=receipts.get(body.commandId);if(prior){expect(prior.body).toBe(String(init.body));return response({...base,replayed:true,result:prior.result},200);}
  if(body.expectedAuthorizationGeneration!==String(generation))return response({...base,apiVersion:'2',error:{code:conflictCode}},409);
  if(path.endsWith('/profile/commands')){const pub=path.split('/').at(-3);const item=[...created.values()].find(v=>v.publicId===pub);if(!item||item.revision!==body.expectedRevision)return response({...base,error:{code:'revision_conflict'}},409);const result={resource:{type:'organization',publicId:item.publicId,revision:item.revision},authorizationGeneration:String(generation)};receipts.set(body.commandId,{body:String(init.body),result,update:true});return response({...base,replayed:false,result},200);}
  if(created.has(body.externalId))return response({...base,error:{code:'binding_exists'}},409);
  if(body.organization){const parent=created.get(body.organization.externalId);expect(parent?.kind).toBe('organization');expect(body.organization.expectedRevision).toBe(parent?.revision);}
  const kind=path.includes('/organizations/')?'organization':'client',publicId=(++publicSequence).toString(16).padStart(32,'0');created.set(body.externalId,{publicId,kind,revision:'1',profile:body.profile});generation++;
  const result={resource:{type:kind,id:body.externalId,publicId,revision:'1'},authorizationGeneration:String(generation)};receipts.set(body.commandId,{body:String(init.body),result});if(loseNextAcknowledgement){loseNextAcknowledgement=false;throw Error('synthetic lost accepted response');}return response({...base,replayed:false,result},201);
 });
 bindingRead.mockImplementation(async(_env,_source,kind,external,publicId)=>{const item=created.get(external);return item&&item.publicId===publicId?{status:'observed',observation:{authoritative:false,sourceId:source,sourceInstanceId:instance,applicationId:application,historyEpoch:epoch,requestId:uuid(),authorizationGeneration:String(generation),binding:{type:kind,externalId:external,publicId,createdAt:'2026-10-19T00:00:00Z'},resource:{present:true,revision:item.revision}}}:{status:'not_found'};});
 const writerActor={staffId:staff,accessSubject:subject,admissionVersion:1,profileVersion:1,loginEmail:email,
  selectedGrantId:staff+'directory.profile.edit',selectedIdentityGrantId:staff+'directory.identity.link'};
 return {staff,area,source,origin,actor,writerActor,env,approve,send,posts,created,
  set onCapabilities(value:(()=>Promise<void>)|null){capabilityHook=value;},set loseNextAcknowledgement(value:boolean){loseNextAcknowledgement=value;},get generation(){return generation;},set generation(value:number){generation=value;},set conflictCode(value:string){conflictCode=value;},set networkFailure(value:boolean){networkFailure=value;}};
}
async function drain(f:Awaited<ReturnType<typeof fixture>>){return drainNativeDirectoryOutboxes(f.env,{send:f.send,rotationTime:0,maxCommands:12});}
async function state(record:string){return(await db.prepare('SELECT state FROM operations_directory_intents WHERE record_id=? ORDER BY source_id').bind(record).all<{state:string}>()).results.map(x=>x.state);}
describe('approved existing-company no-op generation recovery against actual migrated D1',()=>{
 it('completes only the exact existing organization no-op after stale generation without changing the company or original failure',async()=>{
  const f=await fixture(),first=await f.approve(true);for(let n=0;n<3;n++)await drain(f);
  expect(await state(first.organizationRecordId!)).toEqual(['acknowledged']);expect(await state(first.clientRecordId)).toEqual(['acknowledged']);
  const next=await f.approve(true,first.organizationRecordId!);expect(next.status).toBe('written');expect(next.organizationRecordVersion).toBe(2);
  const original=await db.prepare(`SELECT o.command_id,o.command_json FROM operations_directory_intents i JOIN operations_directory_materializations m ON m.intent_id=i.intent_id JOIN project_alpha_directory_outbox o ON o.command_id=m.command_id WHERE i.record_id=? AND i.record_version=2`).bind(first.organizationRecordId!).first<{command_id:string;command_json:string}>();
  expect(original).not.toBeNull();f.generation=Number(JSON.parse(original!.command_json).expectedAuthorizationGeneration)+1;
  for(let n=0;n<3;n++)await drain(f);
  const diagnostics=(await db.prepare('SELECT reason,state FROM project_alpha_directory_profile_recovery_checks').all()).results;
  expect(await state(first.organizationRecordId!),JSON.stringify(diagnostics)).toEqual(['acknowledged','acknowledged']);expect(await state(next.clientRecordId)).toEqual(['acknowledged']);
  expect(f.created.size).toBe(3);expect(await db.prepare('SELECT state FROM project_alpha_directory_outbox WHERE command_id=?').bind(original!.command_id).first('state')).toBe('terminal');
  expect(await db.prepare('SELECT command_json FROM project_alpha_directory_outbox WHERE command_id=?').bind(original!.command_id).first('command_json')).toBe(original!.command_json);
 },180000);
});
