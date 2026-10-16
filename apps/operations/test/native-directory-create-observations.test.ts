import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Miniflare} from 'miniflare';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {splitD1MigrationStatements} from '../../client/test/helpers/d1-migrations';
import {writeNativeDirectoryProfile,type NativeDirectoryCreateWrite} from '../src/worker/native-directory-profile-writer';
import {dispatchProjectAlphaDirectoryProfileOutboxCommand} from '../src/worker/project-alpha-directory-profile-outbox-dispatcher';
import {enqueueNativeDirectoryCreateObservations,dispatchNativeDirectoryCreateObservation} from '../src/worker/native-directory-create-observations';
import {drainNativeDirectoryOutboxes} from '../src/worker/native-directory-outbox-scheduler';
import {readClientHubNativeProjectCapability} from '../src/worker/client-hub-native-project-management';
import {persistProjectAlphaDirectoryInventoryPage} from '../src/worker/project-alpha-v2-sync';
import type {ClientHubCollectionContext} from '../src/worker/client-hub-collections';
import type {StaffPrincipal} from '../src/worker/types';
import {captureImportQueries,checkImportQueryDepth} from './helpers/native-import-query-depth';

let runtime:Miniflare,db:D1Database;
const sourceInstanceId='11111111-1111-4111-8111-111111111111',applicationId='22222222-2222-4222-8222-222222222222',historyEpoch='33333333-3333-4333-8333-333333333333';
beforeAll(async()=>{
 runtime=new Miniflare({modules:true,compatibilityDate:'2026-07-22',script:"export default {fetch(){return new Response('ok')}}",d1Databases:['OPS_DB']});
 db=await runtime.getD1Database('OPS_DB') as D1Database;
 const directory=new URL('../migrations/',import.meta.url);
 for(const name of readdirSync(directory).filter(n=>/^\d{4}_.+\.sql$/.test(n)&&n.slice(0,4)<='0211').sort())
  await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,directory),'utf8')).map(sql=>db.prepare(sql)));
 await db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area','Synthetic area',1)").run();
 await db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('owner','owner@example.test','Owner','access|owner','active')").run();
},240000);
afterAll(async()=>runtime?.dispose());

async function fixture(kind:'organization'|'client'='organization'){
 const unique=randomUUID(),sourceId=`project-alpha:t_${unique.replaceAll('-','')}`,recordId=kind==='client'?unique:`ops/org/${unique}`,publicId='f'.repeat(32);
 const staffId=`staff-${unique}`,accessSubject=`access|${unique}`,loginEmail=`${unique}@example.test`;
 await db.batch([
  db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')").bind(staffId,loginEmail,staffId,accessSubject),
  db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,'owner')").bind(staffId,accessSubject),
  db.prepare('INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)').bind(staffId,loginEmail,staffId),
  ...['directory.profile.edit','directory.identity.link'].map((permission,index)=>db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global','owner')").bind(`${unique}-${index}`,staffId,permission)),
  db.prepare("INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,active,version,granted_by) VALUES(?,?,'project.shared.sync','allow','global',1,1,?)").bind(`${unique}-project`,staffId,staffId),
 ]);
 const env={OPS_DB:db,NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:'true',PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[sourceId]:{
  sourceId,enabled:true,baseUrl:'https://pa.example.test',apiKey:'synthetic-test-key',sourceInstanceId,applicationId,historyEpoch}}})};
 const profile={name:'Synthetic organization',...(kind==='organization'?{generalEmail:'synthetic@example.test',generalPhone:''}:{email:'synthetic@example.test',phone:'',clientType:'business' as const}),addressLine1:'',addressLine2:'',city:'',state:'',postalCode:'',country:'US'};
 const scopes=[{businessAreaId:'area',divisionId:null}],mutationId=randomUUID(),createAdmissionId=randomUUID();
 const destinations=[{sourceId,sourceInstanceUUID:sourceInstanceId,applicationUUID:applicationId,historyEpoch,origin:'https://pa.example.test',externalCanonicalId:recordId,expectedAuthorizationGeneration:'0'}];
 await db.prepare(`INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
  VALUES(?,?,?,?,?,?,?,?,?)`).bind(createAdmissionId,staffId,accessSubject,recordId,kind,JSON.stringify(scopes),JSON.stringify(profile),
   JSON.stringify(destinations.map(({expectedAuthorizationGeneration:_,...d})=>d)),staffId).run();
 if(kind==='client')await db.prepare('INSERT INTO native_directory_create_admission_relationships(create_admission_id,client_record_id,organization_record_id,organization_record_version) VALUES(?,?,NULL,NULL)').bind(createAdmissionId,recordId).run();
 const written=await writeNativeDirectoryProfile(db,{operation:'create',mutationId,createAdmissionId,recordId,expectedLocalVersion:0,kind,profile,scopes,destinations,...(kind==='client'?{relationship:{organizationRecordId:null,expectedRelationshipVersion:0 as const}}:{}),
  actor:{staffId,accessSubject,admissionVersion:1,profileVersion:1,loginEmail,selectedGrantId:`${unique}-0`,selectedIdentityGrantId:`${unique}-1`}} as NativeDirectoryCreateWrite);
 expect(written,JSON.stringify(written)).toMatchObject({status:'written'});if(written.status!=='written')throw Error('fixture create failed');
 const commandId=written.commandIds[0]!;
 const principal={id:staffId,email:loginEmail,accessSubject} as StaffPrincipal;
 const context={root:{source_id:sourceId,root_namespace:'business',kind:kind==='organization'?'organization':'standalone_client',public_id:recordId}} as ClientHubCollectionContext;
 const target={type:kind,publicId,revision:'1',present:true,lastAction:'upsert' as const,projectionSha256:'b'.repeat(64),binding:{externalId:recordId,status:'active' as const,resourceRevision:'1'}};
 let generation='1',page=0,posts=0,inventoryHook:((url:URL)=>Promise<Response|undefined>)|undefined;
 const requests:URL[]=[];
 const reply=(body:object,status=200)=>{const requestId=randomUUID();return new Response(JSON.stringify({sourceInstanceId,applicationId,historyEpoch,requestId,...body}),{
  status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Request-ID':requestId}});};
 const send:typeof fetch=vi.fn(async(input,init)=>{
  const url=new URL(String(input));requests.push(url);
  if(url.pathname==='/api/v2/capabilities')return reply({apiVersion:'2',grantedCapabilities:['api.capabilities.read','directory.inventory.read','directory.organizations.create','directory.clients.create'].map(name=>({name})),
   implementedEndpoints:[{method:'GET',path:'/api/v2/capabilities',requiredCapability:'api.capabilities.read'},
    {method:'GET',path:'/api/v2/directory/inventory',requiredCapability:'directory.inventory.read',requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true},
    ...(['organizations','clients'] as const).map(plural=>({method:'POST',path:`/api/v2/directory/${plural}/commands`,requiredCapability:`directory.${plural}.create`,requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}))]});
  if(url.pathname===`/api/v2/directory/${kind==='client'?'clients':'organizations'}/commands`){
   posts++;return reply({replayed:false,result:{resource:{type:kind,id:recordId,publicId,revision:'1'},authorizationGeneration:'1'}},201);
  }
  expect(init?.method).toBe('GET');expect(url.pathname).toBe('/api/v2/directory/inventory');page++;
  const hooked=await inventoryHook?.(url);if(hooked)return hooked;
  return reply({authorizationGeneration:generation,resources:[target],nextCursor:null});
 });
 expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env,sourceId,commandId,send)).toMatchObject({status:'acknowledged'});
 const ready=()=>db.prepare('UPDATE native_directory_create_observation_dispatch SET next_attempt_at=0 WHERE command_id=?').bind(commandId).run();
 const dispatch=()=>dispatchNativeDirectoryCreateObservation(env,sourceId,commandId,send);
 const state=()=>db.prepare('SELECT * FROM native_directory_create_observation_dispatch WHERE command_id=?').bind(commandId).first<Record<string,unknown>>();
 return {env,sourceId,recordId,publicId,commandId,principal,context,target,send,reply,requests,ready,dispatch,state,
  posts:()=>posts,page:()=>page,setGeneration:(value:string)=>generation=value,hook:(fn:typeof inventoryHook)=>inventoryHook=fn};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const enqueue=(f:Fixture)=>enqueueNativeDirectoryCreateObservations(db,[f.sourceId]);
const observations=(f:Fixture)=>db.prepare('SELECT count(*) n FROM project_alpha_api_v2_directory_observations WHERE source_id=? AND project_alpha_public_id=?').bind(f.sourceId,f.publicId).first<number>('n');

it.each(['organization','client'] as const)('backfills a real %s create ACK, then the ordinary scheduler enables native project creation without an admin sync or another POST',async kind=>{
 const f=await fixture(kind);expect(await observations(f)).toBe(0);
 expect(await readClientHubNativeProjectCapability(f.env as never,f.principal,f.context)).toMatchObject({available:false,reason:'source_observation_pending'});
 const result=await drainNativeDirectoryOutboxes(f.env,{send:f.send,rotationTime:300000});
 expect(result).toMatchObject({attempted:1,acknowledged:1,failed:0});expect(await f.state()).toMatchObject({state:'complete'});
 expect(await readClientHubNativeProjectCapability(f.env as never,f.principal,f.context)).toMatchObject({available:true});
 expect(f.posts()).toBe(1);expect(await observations(f)).toBe(1);
},120000);

it('finds a target beyond 200 across durable bounded turns using only returned cursors',async()=>{
 const f=await fixture();await enqueue(f);
 const resources=Array.from({length:200},(_,index)=>({...f.target,publicId:(index+1).toString(16).padStart(32,'0'),binding:null}));
 const cursor=`organization:${resources.at(-1)!.publicId}`;
 f.hook(async url=>url.searchParams.get('cursor')===null?f.reply({authorizationGeneration:'1',resources,nextCursor:cursor}):undefined);
 expect(await f.dispatch()).toEqual({status:'uncertain',reason:'inventory_pending'});
 expect(await f.state()).toMatchObject({state:'pending',inventory_cursor:cursor,inventory_generation:'1'});
 expect(await observations(f)).toBe(0);expect(f.page()).toBe(1);
 expect(await f.dispatch()).toEqual({status:'acknowledged'});
 expect(f.requests.filter(url=>url.pathname.endsWith('/inventory')).map(url=>url.searchParams.get('cursor'))).toEqual([null,cursor]);
 expect(f.posts()).toBe(1);
},120000);

async function firstPage(f:Fixture){
 f.hook(async()=>f.reply({authorizationGeneration:'1',resources:[{...f.target,publicId:'1'.repeat(32),binding:null}],nextCursor:`organization:${'1'.repeat(32)}`}));
 await enqueue(f);expect(await f.dispatch()).toMatchObject({status:'uncertain'});
}
it('restarts on generation change rather than missing a newly inserted record before the previous cursor',async()=>{
 const f=await fixture();await firstPage(f);f.setGeneration('2');f.hook(undefined);
 expect(await f.dispatch()).toEqual({status:'uncertain',reason:'generation_changed'});
 expect(await f.state()).toMatchObject({inventory_cursor:null,inventory_generation:null});
 await f.ready();expect(await f.dispatch()).toEqual({status:'acknowledged'});
 expect(f.requests.filter(url=>url.pathname.endsWith('/inventory')).at(-1)!.searchParams.get('cursor')).toBeNull();
},120000);

it.each([400,503] as const)('resets only explicit stale cursor400 and retains checkpoint on HTTP%s',async status=>{
 const f=await fixture();await firstPage(f);f.hook(async()=>new Response('{}',{status}));
 expect(await f.dispatch()).toMatchObject({status:'uncertain'});
 expect((await f.state())!.inventory_cursor).toBe(status===400?null:`organization:${'1'.repeat(32)}`);
},120000);

it('retains progress after a transport failure',async()=>{
 const f=await fixture();await firstPage(f);f.hook(async()=>{throw Error('synthetic timeout');});
 expect(await f.dispatch()).toMatchObject({status:'uncertain'});
 expect(await f.state()).toMatchObject({inventory_cursor:`organization:${'1'.repeat(32)}`,inventory_generation:'1'});
},120000);

it('claims a job once when a second worker competes during its fetch',async()=>{
 const f=await fixture();await enqueue(f);let entered=false;
 f.hook(async()=>{if(!entered){entered=true;expect(await f.dispatch()).toEqual({status:'blocked',reason:'not_eligible'});}return undefined;});
 expect(await f.dispatch()).toEqual({status:'acknowledged'});expect(f.page()).toBe(1);
},120000);

it('rolls back an old receipt and cursor atomically when a concurrent read has advanced the source high water',async()=>{
 const f=await fixture();await enqueue(f);
 f.hook(async()=>{expect(await persistProjectAlphaDirectoryInventoryPage(db,{sourceId:f.sourceId,sourceInstanceId,applicationId,historyEpoch,
  requestId:randomUUID(),authorizationGeneration:'9007199254740993',authoritative:false,resources:[],nextCursor:null},null)).toMatchObject({status:'persisted'});return undefined;});
 expect(await f.dispatch()).toEqual({status:'uncertain',reason:'evidence_superseded'});
 expect(await observations(f)).toBe(0);expect(await f.state()).toMatchObject({inventory_cursor:null,state:'uncertain'});
 expect(await db.prepare('SELECT count(*) n FROM project_alpha_api_v2_inventory_conflicts WHERE source_id=?').bind(f.sourceId).first('n')).toBe(0);
 expect(await db.prepare('SELECT count(*) n FROM project_alpha_api_v2_inventory_receipts WHERE source_id=?').bind(f.sourceId).first('n')).toBe(1);
},120000);

it('losing its lease during fetch leaves no receipt or cursor advancement',async()=>{
 const f=await fixture();await enqueue(f);
 f.hook(async()=>{await db.prepare('UPDATE native_directory_create_observation_dispatch SET lease_token=? WHERE command_id=?').bind(randomUUID(),f.commandId).run();return undefined;});
 expect(await f.dispatch()).toMatchObject({status:'uncertain',reason:'evidence_superseded'});
 expect(await observations(f)).toBe(0);expect(await f.state()).toMatchObject({state:'leased',inventory_cursor:null});
},120000);

it('a concurrent tombstone prevents an old active response restoring project readiness',async()=>{
 const f=await fixture();await enqueue(f);
 f.hook(async()=>{
  expect(await persistProjectAlphaDirectoryInventoryPage(db,{sourceId:f.sourceId,sourceInstanceId,applicationId,historyEpoch,
   requestId:randomUUID(),authorizationGeneration:'2',authoritative:false,resources:[{...f.target,present:false,lastAction:'delete',revision:'2',
    binding:{...f.target.binding,status:'tombstoned',resourceRevision:'2'}}],nextCursor:null},null)).toMatchObject({status:'persisted'});
  return undefined;
 });
 expect(await f.dispatch()).toMatchObject({status:'uncertain',reason:'evidence_superseded'});
 expect(await observations(f)).toBe(1);
 expect(await db.prepare('SELECT present,binding_status FROM project_alpha_api_v2_directory_observations_current WHERE source_id=?').bind(f.sourceId).first())
  .toEqual({present:0,binding_status:'tombstoned'});
 expect(await readClientHubNativeProjectCapability(f.env as never,f.principal,f.context)).toMatchObject({available:false,reason:'source_binding_unavailable'});
},120000);

it('a source identity replacement during fetch rolls back the old identity page',async()=>{
 const f=await fixture();await enqueue(f);
 f.hook(async()=>{
  expect(await persistProjectAlphaDirectoryInventoryPage(db,{sourceId:f.sourceId,sourceInstanceId:randomUUID(),applicationId,historyEpoch,
   requestId:randomUUID(),authorizationGeneration:'1',authoritative:false,resources:[],nextCursor:null},null)).toMatchObject({status:'persisted'});
  return undefined;
 });
 expect(await f.dispatch()).toMatchObject({status:'uncertain',reason:'evidence_superseded'});
 expect(await observations(f)).toBe(0);
 expect(await db.prepare('SELECT count(*) n FROM project_alpha_api_v2_inventory_receipts WHERE source_id=? AND source_instance_id=?').bind(f.sourceId,sourceInstanceId).first('n')).toBe(0);
},120000);

it('retires an obsolete configured identity from the due queue without a PA fetch',async()=>{
 const f=await fixture();await enqueue(f);const captured=captureImportQueries(db),envelope=JSON.parse(f.env.PROJECT_ALPHA_API_V2_CONNECTIONS);
 envelope.instances[f.sourceId].sourceInstanceId=randomUUID();
 const send=vi.fn<typeof fetch>();
 expect(await dispatchNativeDirectoryCreateObservation({...f.env,OPS_DB:captured.database,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify(envelope)},f.sourceId,f.commandId,send))
  .toEqual({status:'blocked',reason:'target_superseded'});
 expect(await f.state()).toMatchObject({state:'conflict',reason:'target_superseded'});
 expect(send).not.toHaveBeenCalled();expect(await observations(f)).toBe(0);
 expect(checkImportQueryDepth(captured.queries)).toMatchObject({failures:[]});
},120000);

it.each(['expired_lease','live_lease','future_retry'] as const)('retires only obsolete due/expired work, preserving %s ownership and retry policy',async mode=>{
 const f=await fixture();await enqueue(f);const envelope=JSON.parse(f.env.PROJECT_ALPHA_API_V2_CONNECTIONS);
 envelope.instances[f.sourceId].sourceInstanceId=randomUUID();const token=randomUUID();
 if(mode==='future_retry')await db.prepare('UPDATE native_directory_create_observation_dispatch SET next_attempt_at=? WHERE command_id=?').bind(Date.now()+60_000,f.commandId).run();
 else await db.prepare("UPDATE native_directory_create_observation_dispatch SET state='leased',lease_token=?,lease_expires_at=? WHERE command_id=?")
  .bind(token,Date.now()+(mode==='expired_lease'?-60_000:60_000),f.commandId).run();
 const send=vi.fn<typeof fetch>(),captured=captureImportQueries(db);
 expect(await dispatchNativeDirectoryCreateObservation({...f.env,OPS_DB:captured.database,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify(envelope)},f.sourceId,f.commandId,send))
  .toEqual({status:'blocked',reason:mode==='expired_lease'?'target_superseded':'not_eligible'});
 expect(await f.state()).toMatchObject(mode==='expired_lease'?{state:'conflict',lease_token:null,lease_expires_at:null}
  :mode==='live_lease'?{state:'leased',lease_token:token}:{state:'pending'});
 expect(send).not.toHaveBeenCalled();expect(await observations(f)).toBe(0);
 expect(checkImportQueryDepth(captured.queries)).toMatchObject({failures:[]});
},120000);

it('expired lease at commit time rolls back canonical observations',async()=>{
 const f=await fixture();await enqueue(f);
 f.hook(async()=>{await db.prepare('UPDATE native_directory_create_observation_dispatch SET lease_expires_at=? WHERE command_id=?').bind(Date.now()-1,f.commandId).run();return undefined;});
 expect(await f.dispatch()).toMatchObject({status:'uncertain',reason:'evidence_superseded'});
 expect(await observations(f)).toBe(0);
},120000);

it('rolls back receipt, target observation, cursor and completion when the final write fails',async()=>{
 const f=await fixture();await enqueue(f);
 await db.prepare(`CREATE TRIGGER injected_create_observation_failure AFTER UPDATE ON native_directory_create_observation_dispatch
  WHEN NEW.command_id='${f.commandId}' AND NEW.state='complete' BEGIN SELECT RAISE(ABORT,'synthetic completion failure'); END`).run();
 try{
  expect(await f.dispatch()).toMatchObject({status:'uncertain',reason:'evidence_superseded'});
  expect(await observations(f)).toBe(0);
  expect(await db.prepare('SELECT count(*) n FROM project_alpha_api_v2_inventory_receipts WHERE source_id=?').bind(f.sourceId).first('n')).toBe(0);
  expect(await f.state()).toMatchObject({state:'uncertain',inventory_cursor:null,inventory_generation:null});
  expect(await db.prepare('SELECT count(*) n FROM native_directory_create_observation_guards').first('n')).toBe(0);
 }finally{await db.prepare('DROP TRIGGER injected_create_observation_failure').run();}
},120000);

it('retains real request-reuse conflict evidence without adopting the mismatched page cursor',async()=>{
 const f=await fixture();await enqueue(f);const requestId=randomUUID();
 expect(await persistProjectAlphaDirectoryInventoryPage(db,{sourceId:f.sourceId,sourceInstanceId,applicationId,historyEpoch,
  requestId,authorizationGeneration:'1',authoritative:false,resources:[],nextCursor:null},null)).toMatchObject({status:'persisted'});
 f.hook(async()=>new Response(JSON.stringify({sourceInstanceId,applicationId,historyEpoch,requestId,authorizationGeneration:'1',
  resources:[{...f.target,publicId:'1'.repeat(32),binding:null}],nextCursor:`organization:${'1'.repeat(32)}`}),
  {headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Request-ID':requestId}}));
 expect(await f.dispatch()).toEqual({status:'conflict',reason:'inventory_conflict'});
 expect(await f.state()).toMatchObject({state:'conflict',inventory_cursor:null,inventory_generation:null});
 expect(await db.prepare("SELECT conflict_kind FROM project_alpha_api_v2_inventory_conflicts WHERE source_id=?").bind(f.sourceId).first('conflict_kind')).toBe('request_reuse_mismatch');
 expect(await observations(f)).toBe(0);
},120000);

it('compiles actual enqueue, lease, canonical persistence and completion statements against full211 at production expression depth100',async()=>{
 const f=await fixture(),captured=captureImportQueries(db);
 await enqueueNativeDirectoryCreateObservations(captured.database,[f.sourceId]);
 expect(await dispatchNativeDirectoryCreateObservation({...f.env,OPS_DB:captured.database},f.sourceId,f.commandId,f.send)).toEqual({status:'acknowledged'});
 expect(captured.queries.length).toBeGreaterThan(10);
 expect(checkImportQueryDepth(captured.queries)).toMatchObject({failures:[]});
},120000);

it.each(['inactive','revision','external','absent'] as const)('never completes for %s target binding',async mode=>{
 const f=await fixture();await enqueue(f);
 f.hook(async()=>f.reply({authorizationGeneration:'1',resources:mode==='absent'?[]:[{...f.target,binding:{...f.target.binding,
  ...(mode==='inactive'?{status:'tombstoned'}:mode==='revision'?{resourceRevision:'2'}:{externalId:'different-external'})}}],nextCursor:null}));
 expect(await f.dispatch()).toMatchObject({status:mode==='external'?'conflict':'uncertain'});expect((await f.state())!.state).not.toBe('complete');
 expect(await readClientHubNativeProjectCapability(f.env as never,f.principal,f.context)).toMatchObject({available:false});
 expect(f.posts()).toBe(1);
},120000);
