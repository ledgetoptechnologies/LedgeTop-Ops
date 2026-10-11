import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
// @ts-expect-error Reviewed ESM full-schema fixture helper.
import { migrateProjectOrganizationFullSchema } from '../../../scripts/staging-project-organization-fullschema-migrations.mjs';
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite } from '../src/worker/native-directory-profile-writer';
import { dispatchProjectAlphaDirectoryProfileOutboxCommand } from '../src/worker/project-alpha-directory-profile-outbox-dispatcher';
import { reviewDirectoryBindingRefresh, executeDirectoryBindingRefresh, settleDirectoryBindingRefresh } from '../src/worker/native-directory-binding-refresh';
import type { Env } from '../src/worker/types';
import type { AuthenticatedNativeStaffWithAdmissionVersion } from '../src/worker/native-staff-auth';
import { readConfiguredProjectAlphaDirectoryInventory } from '../src/worker/project-alpha-directory-inventory-api-v2';
import { persistProjectAlphaDirectoryInventoryPage } from '../src/worker/project-alpha-v2-sync';
import { resolveTrustedNativeFinancialMapping } from '../src/worker/project-alpha-financial-mapping';

let runtime: Miniflare, db: D1Database;
const sourceId='project-alpha:primary', source='11111111-1111-4111-8111-111111111111';
const application='22222222-2222-4222-8222-222222222222', epoch='33333333-3333-4333-8333-333333333333';
const origin='https://pa.example.test', staffId='staff-beau-koltz';
const profile={name:'Refresh fixture',generalEmail:'fixture@example.test',generalPhone:'512-555-0100',addressLine1:'1 Main',addressLine2:'',city:'Austin',state:'Texas',postalCode:'78701',country:'US'};
const env=()=>({OPS_DB:db,ENVIRONMENT:'local',NATIVE_DIRECTORY_BINDING_REFRESH_ENABLED:'true',PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[sourceId]:{sourceId,enabled:true,baseUrl:origin,apiKey:'fixture-secret',sourceInstanceId:source,applicationId:application,historyEpoch:epoch}}})}) as Env;
const actor=():AuthenticatedNativeStaffWithAdmissionVersion=>({identity:{kind:'native',staffId,verifiedAccessSubject:'access|owner',email:'owner@example.test',displayName:'Owner',profileVersion:1},admissionVersion:1,verifiedUntil:new Date(Date.now()+3600000).toISOString()});
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Request-ID':(value as {requestId:string}).requestId}});}
const envelope={sourceInstanceId:source,applicationId:application,historyEpoch:epoch,requestId:'44444444-4444-4444-8444-444444444444'};
function capabilities(){
  const endpoints=[['POST','/api/v2/directory/organizations/commands','directory.organizations.create'],['POST','/api/v2/directory/organizations/{publicId}/profile/commands','directory.organizations.write'],['GET','/api/v2/directory/inventory','directory.inventory.read'],['POST','/api/v2/directory/organizations/bindings/revisions/commands','directory.organizations.binding.revision.refresh']];
  return {...envelope,apiVersion:'2',grantedCapabilities:['api.capabilities.read',...endpoints.map(x=>x[2])].map(name=>({name})),implementedEndpoints:[{method:'GET',path:'/api/v2/capabilities',requiredCapability:'api.capabilities.read'},...endpoints.map(([method,path,requiredCapability])=>({method,path,requiredCapability,requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}))]};
}
beforeAll(async()=>{
  runtime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:"export default {fetch(){return new Response('ok')}}",d1Databases:['OPS_DB']});
  db=await runtime.getD1Database('OPS_DB') as D1Database;
  await migrateProjectOrganizationFullSchema(db,'0161');
  // Emit the genuine historical0161 cross-surface false positive. Do not forge
  // a conflict or remove immutable history guards to make the positive pass.
  for(const [surface,generation] of [['project','2'],['directory','1']]){
    await db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,
      history_epoch_id,inventory_kind,request_id,authorization_generation,page_sha256,item_count,observed_at)
      VALUES(?,?,?,?,?,?,?,?,0,'2020-01-01T00:00:00.000Z')`).bind(sourceId,source,application,epoch,surface,randomUUID(),generation,'b'.repeat(64)).run();
  }
  expect(await db.prepare("SELECT count(*) n FROM project_alpha_api_v2_inventory_conflicts WHERE source_id=? AND inventory_kind='directory' AND resource_type='source' AND conflict_kind='authorization_generation_regressed'").bind(sourceId).first('n')).toBe(1);
  const directory=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(directory).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&name.slice(0,4)>'0161'&&name.slice(0,4)<='0198').sort()){
    await db.batch([...splitD1MigrationStatements(readFileSync(new URL(name,directory),'utf8')).map(sql=>db.prepare(sql)),db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(name)]);
  }
  await db.batch([
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('refresh-area','Refresh fixtures',1)"),
    ...['directory.profile.edit','directory.identity.link'].map((permission,index)=>db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global',?)").bind(`refresh-global-${index}`,staffId,permission,staffId)),
  ]);
},240000);
afterAll(async()=>{await runtime?.dispose();});

async function fixture(){
  const recordId=`refresh-org-${randomUUID()}`,publicId=randomUUID().replaceAll('-','');
  const writer={staffId,accessSubject:'access|owner',admissionVersion:1,selectedGrantId:'refresh-global-0',selectedIdentityGrantId:'refresh-global-1',loginEmail:'owner@example.test',profileVersion:1};
  const destinations=[{sourceId,sourceInstanceUUID:source,applicationUUID:application,historyEpoch:epoch,origin,externalCanonicalId:recordId,expectedAuthorizationGeneration:'0'}];
  const input:NativeDirectoryCreateWrite={operation:'create',mutationId:randomUUID(),createAdmissionId:randomUUID(),recordId,expectedLocalVersion:0,kind:'organization',profile,scopes:[{businessAreaId:'refresh-area',divisionId:null}],destinations,actor:writer};
  await db.prepare('INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by) VALUES(?,?,?,?,?,?,?,?,?)').bind(input.createAdmissionId,staffId,writer.accessSubject,recordId,'organization',JSON.stringify(input.scopes),JSON.stringify(profile),JSON.stringify(destinations.map(({expectedAuthorizationGeneration:_,...rest})=>rest)),staffId).run();
  const normal=vi.fn<typeof fetch>(async(url,init)=>{
    const path=new URL(String(url)).pathname;if(path.endsWith('/capabilities'))return json(capabilities());
    const body=JSON.parse(String(init?.body)),update=path.endsWith('/profile/commands');
    return json({...envelope,replayed:false,result:{resource:update?{type:'organization',publicId,revision:'2'}:{type:'organization',id:body.externalId,publicId,revision:'1'},authorizationGeneration:'1'}},update?200:201);
  });
  const created=await writeNativeDirectoryProfile(db,input);expect(created.status).toBe('written');if(created.status!=='written')throw Error(created.reason);
  expect((await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,created.commandIds[0]!,normal)).status).toBe('acknowledged');
  const update={operation:'update' as const,mutationId:randomUUID(),recordId,expectedLocalVersion:1,kind:'organization' as const,profile:{...profile,name:'Updated fixture'},destinations:destinations.map(x=>({...x,expectedAuthorizationGeneration:'1'})),actor:writer};
  const written=await writeNativeDirectoryProfile(db,update);expect(written.status).toBe('written');if(written.status!=='written')throw Error(written.reason);
  expect((await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,written.commandIds[0]!,normal)).status).toBe('acknowledged');
  let binding='1',generation='1',revision='2',projectionSha256='a'.repeat(64);const posts:string[]=[];
  let postHook:(()=>Promise<void>)|undefined;
  const send=vi.fn<typeof fetch>(async(url,init)=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/capabilities'))return json(capabilities());
    if(path.endsWith('/inventory'))return json({...envelope,requestId:randomUUID(),authorizationGeneration:generation,resources:[{type:'organization',publicId,revision,present:true,lastAction:'upsert',projectionSha256,binding:{externalId:recordId,status:'active',resourceRevision:binding}}],nextCursor:null});
    posts.push(String(init?.body));const replayed=binding==='2';binding='2';generation='2';if(postHook)await postHook();
    return json({...envelope,replayed,result:{resource:{type:'organization',id:recordId,revision:'2'},binding:{publicId,previousRevision:'1',authorizationGeneration:'2'}}});
  });
  return {recordId,publicId,writer,update,send,posts,setHook:(hook:()=>Promise<void>)=>{postHook=hook;},setFresh:(next:{revision?:string;hash?:string;generation?:string})=>{revision=next.revision??revision;projectionSha256=next.hash??projectionSha256;generation=next.generation??generation;}};
}
async function count(table:string,commandId:string){return db.prepare(`SELECT count(*) n FROM ${table} WHERE command_id=?`).bind(commandId).first<number>('n');}

it('reserves without a PA POST, preserves a declined review, settles trusted transport and replays without POST',async()=>{
  const f=await fixture(),review=await reviewDirectoryBindingRefresh(env(),actor(),f.recordId,sourceId,f.send);
  expect(review).toMatchObject({recordId:f.recordId,localVersion:2,priorRevision:'1',liveRevision:'2'});expect(f.posts).toEqual([]);
  expect(await reviewDirectoryBindingRefresh(env(),actor(),f.recordId,sourceId,f.send)).toEqual(review);expect(f.posts).toEqual([]);
  const persistInventory=async()=>{const observed=await readConfiguredProjectAlphaDirectoryInventory(env(),sourceId,{type:'organization'},f.send);expect(observed.status).toBe('observed');if(observed.status==='observed')await persistProjectAlphaDirectoryInventoryPage(db,observed.inventory,null);};
  await persistInventory();
  const financial=()=>resolveTrustedNativeFinancialMapping(env(),{kind:'organization',recordId:f.recordId,sourceId});
  expect(await financial()).toBeNull();
  const before=(await db.prepare('SELECT * FROM project_alpha_api_v2_directory_observations').all()).results;
  const conflicts=(await db.prepare('SELECT * FROM project_alpha_api_v2_inventory_conflicts ORDER BY conflict_id').all()).results;
  expect(await executeDirectoryBindingRefresh(env(),actor(),review.commandId,f.send)).toMatchObject({status:'acknowledged',revision:'2'});
  expect(await count('native_directory_active_binding_refresh_receipts',review.commandId)).toBe(1);
  expect((await db.prepare('SELECT * FROM project_alpha_api_v2_directory_observations').all()).results).toEqual(before);
  expect((await db.prepare('SELECT * FROM project_alpha_api_v2_inventory_conflicts ORDER BY conflict_id').all()).results).toEqual(conflicts);
  expect(await financial()).toBeNull();
  await persistInventory();
  expect(await financial()).toMatchObject({revision:'2',authorizationGeneration:'2'});
  expect(await executeDirectoryBindingRefresh(env(),actor(),review.commandId,f.send)).toMatchObject({status:'acknowledged',revision:'2'});expect(f.posts).toHaveLength(1);
},30000);

it('retries a lost committed response with the exact frozen command body',async()=>{
  const f=await fixture(),review=await reviewDirectoryBindingRefresh(env(),actor(),f.recordId,sourceId,f.send);
  let first=true;f.setHook(async()=>{if(first){first=false;throw new TypeError('lost response');}});
  expect(await executeDirectoryBindingRefresh(env(),actor(),review.commandId,f.send)).toMatchObject({status:'uncertain'});
  expect(await count('native_directory_active_binding_refresh_receipts',review.commandId)).toBe(0);
  expect(await reviewDirectoryBindingRefresh(env(),actor(),f.recordId,sourceId,f.send)).toEqual(review);
  expect(await executeDirectoryBindingRefresh(env(),actor(),review.commandId,f.send)).toMatchObject({status:'acknowledged'});
  expect(f.posts).toHaveLength(2);expect(f.posts[1]).toBe(f.posts[0]);
},30000);

it('leases concurrent execution so only one PA POST occurs',async()=>{
  const f=await fixture(),review=await reviewDirectoryBindingRefresh(env(),actor(),f.recordId,sourceId,f.send);
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  f.setHook(async()=>{entered();await gate;});
  const first=executeDirectoryBindingRefresh(env(),actor(),review.commandId,f.send);await started;
  try{expect(await executeDirectoryBindingRefresh(env(),actor(),review.commandId,f.send)).toMatchObject({status:'conflict'});expect(f.posts).toHaveLength(1);}finally{release();}
  expect(await first).toMatchObject({status:'acknowledged'});
},30000);

it('does not accept a JSON-shaped forged trusted acknowledgement',async()=>{
  const f=await fixture(),review=await reviewDirectoryBindingRefresh(env(),actor(),f.recordId,sourceId,f.send);
  await expect(settleDirectoryBindingRefresh(env(),actor(),review.commandId,randomUUID(),{status:'acknowledged',httpStatus:200,response:{...envelope,replayed:false,result:{resource:{type:'organization',id:f.recordId,revision:'2'},binding:{publicId:f.publicId,previousRevision:'1',authorizationGeneration:'2'}}}})).rejects.toThrow('directory_binding_refresh_denied');
  expect(await count('native_directory_active_binding_refresh_receipts',review.commandId)).toBe(0);expect(f.posts).toEqual([]);
},30000);

it('denies frozen actor and local-version drift before POST',async()=>{
  const f=await fixture(),review=await reviewDirectoryBindingRefresh(env(),actor(),f.recordId,sourceId,f.send);
  await expect(executeDirectoryBindingRefresh(env(),{...actor(),identity:{...actor().identity,staffId:'foreign-owner'}},review.commandId,f.send)).rejects.toThrow();
  await expect(executeDirectoryBindingRefresh(env(),{...actor(),verifiedUntil:'2020-01-01T00:00:00.000Z'},review.commandId,f.send)).rejects.toThrow();
  await expect(executeDirectoryBindingRefresh(env(),{...actor(),admissionVersion:2},review.commandId,f.send)).rejects.toThrow('directory_binding_refresh_denied');
  expect((await writeNativeDirectoryProfile(db,{...f.update,mutationId:randomUUID(),expectedLocalVersion:2,profile:{...profile,name:'New local head'}})).status).toBe('written');
  await expect(executeDirectoryBindingRefresh(env(),actor(),review.commandId,f.send)).rejects.toThrow();expect(f.posts).toEqual([]);
},30000);

it('refuses default-off, production and foreign configured identity before dispatch',async()=>{
  const f=await fixture();
  for(const configuration of [{...env(),NATIVE_DIRECTORY_BINDING_REFRESH_ENABLED:undefined},{...env(),ENVIRONMENT:'production'},
    {...env(),PROJECT_ALPHA_API_V2_CONNECTIONS:env().PROJECT_ALPHA_API_V2_CONNECTIONS!.replace(source,'99999999-9999-4999-8999-999999999999')}]){
    await expect(reviewDirectoryBindingRefresh(configuration,actor(),f.recordId,sourceId,f.send)).rejects.toThrow();
  }
  expect(f.posts).toEqual([]);
},30000);

it('blocks fresh projection, revision and never-sent generation drift without replacing the command',async()=>{
  const f=await fixture(),review=await reviewDirectoryBindingRefresh(env(),actor(),f.recordId,sourceId,f.send);
  for(const change of [{hash:'b'.repeat(64)},{hash:'a'.repeat(64),revision:'3'},{revision:'2',generation:'2'}]){
    f.setFresh(change);expect(await executeDirectoryBindingRefresh(env(),actor(),review.commandId,f.send)).toMatchObject({status:'blocked',commandId:review.commandId});
  }
  expect(f.posts).toEqual([]);expect(await count('native_directory_active_binding_refresh_commands',review.commandId)).toBe(1);
},30000);

it.each(['directory.profile.edit','directory.identity.link'])('applies a resource %s deny before POST',async permission=>{
  const f=await fixture(),review=await reviewDirectoryBindingRefresh(env(),actor(),f.recordId,sourceId,f.send);
  await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,granted_by) VALUES(?,?,?,'deny','resource',?,?)").bind(randomUUID(),staffId,permission,f.recordId,staffId).run();
  await expect(executeDirectoryBindingRefresh(env(),actor(),review.commandId,f.send)).rejects.toThrow();expect(f.posts).toEqual([]);
},30000);

it('denies authority-generation drift even when permissions remain allowed',async()=>{
  const f=await fixture(),review=await reviewDirectoryBindingRefresh(env(),actor(),f.recordId,sourceId,f.send);
  await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,granted_by) VALUES(?,?,'directory.profile.edit','allow','resource',?,?)").bind(randomUUID(),staffId,f.recordId,staffId).run();
  await expect(executeDirectoryBindingRefresh(env(),actor(),review.commandId,f.send)).rejects.toThrow();expect(f.posts).toEqual([]);
},30000);

it('denies a newly effective resource inventory conflict before POST',async()=>{
  const f=await fixture(),review=await reviewDirectoryBindingRefresh(env(),actor(),f.recordId,sourceId,f.send);
  await db.prepare(`INSERT INTO project_alpha_api_v2_inventory_conflicts(source_id,source_instance_id,application_id,
    history_epoch_id,inventory_kind,resource_type,project_alpha_public_id,external_id,request_id,prior_reference,
    conflict_kind,observed_revision,details_json) VALUES(?,?,?,?,'directory','organization',?,?,?,?,
    'revision_reuse_mismatch','2','{}')`).bind(sourceId,source,application,epoch,f.publicId,f.recordId,randomUUID(),randomUUID()).run();
  await expect(executeDirectoryBindingRefresh(env(),actor(),review.commandId,f.send)).rejects.toThrow();expect(f.posts).toEqual([]);
},30000);

// Global protected-owner policy is intentionally changed only in the last case.
it('honors protected-owner integrations.manage global policy deny',async()=>{
  const f=await fixture(),review=await reviewDirectoryBindingRefresh(env(),actor(),f.recordId,sourceId,f.send);
  await db.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES(?,?,'integrations.manage','deny','global','global',?)").bind(randomUUID(),staffId,staffId).run();
  await expect(executeDirectoryBindingRefresh(env(),actor(),review.commandId,f.send)).rejects.toThrow();expect(f.posts).toEqual([]);
},30000);
