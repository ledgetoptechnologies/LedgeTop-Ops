import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
// @ts-expect-error Reviewed ESM full-schema fixture helper.
import { migrateProjectOrganizationFullSchema } from '../../../scripts/staging-project-organization-fullschema-migrations.mjs';
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite } from '../src/worker/native-directory-profile-writer';
import { dispatchProjectAlphaDirectoryProfileOutboxCommand } from '../src/worker/project-alpha-directory-profile-outbox-dispatcher';
import { reviewDirectoryBindingRefresh, executeDirectoryBindingRefresh, settleDirectoryBindingRefresh,
  reviewDirectoryBindingRefreshRecovery,executeDirectoryBindingRefreshSuccessor } from '../src/worker/native-directory-binding-refresh';
import type { Env } from '../src/worker/types';
import type { AuthenticatedNativeStaffWithAdmissionVersion } from '../src/worker/native-staff-auth';
import { readConfiguredProjectAlphaDirectoryInventory } from '../src/worker/project-alpha-directory-inventory-api-v2';
import { persistProjectAlphaDirectoryInventoryPage } from '../src/worker/project-alpha-v2-sync';
import { resolveTrustedNativeFinancialMapping } from '../src/worker/project-alpha-financial-mapping';
import { dispatchNativeDirectoryProfileBindingContinuation } from '../src/worker/native-directory-profile-binding-continuation';
import { drainNativeDirectoryOutboxes } from '../src/worker/native-directory-outbox-scheduler';

let runtime: Miniflare, db: D1Database;
let sourceId='project-alpha:primary';
const source='11111111-1111-4111-8111-111111111111';
const application='22222222-2222-4222-8222-222222222222', epoch='33333333-3333-4333-8333-333333333333';
const origin='https://pa.example.test', staffId='staff-beau-koltz';
const profile={name:'Refresh fixture',generalEmail:'fixture@example.test',generalPhone:'512-555-0100',addressLine1:'1 Main',addressLine2:'',city:'Austin',state:'Texas',postalCode:'78701',country:'US'};
const env=()=>({OPS_DB:db,ENVIRONMENT:'local',NATIVE_DIRECTORY_BINDING_REFRESH_ENABLED:'true',NATIVE_DIRECTORY_BINDING_REFRESH_RECOVERY_ENABLED:'true',PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify({version:1,instances:{[sourceId]:{sourceId,enabled:true,baseUrl:origin,apiKey:'fixture-secret',sourceInstanceId:source,applicationId:application,historyEpoch:epoch}}})}) as Env;
const actor=():AuthenticatedNativeStaffWithAdmissionVersion=>({identity:{kind:'native',staffId,verifiedAccessSubject:'access|owner',email:'owner@example.test',displayName:'Owner',profileVersion:1},admissionVersion:1,verifiedUntil:new Date(Date.now()+3600000).toISOString()});
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Request-ID':(value as {requestId:string}).requestId}});}
const envelope={sourceInstanceId:source,applicationId:application,historyEpoch:epoch,requestId:'44444444-4444-4444-8444-444444444444'};
function capabilities(){
  const endpoints:Array<[string,string,string]>=[['POST','/api/v2/directory/organizations/commands','directory.organizations.create'],['POST','/api/v2/directory/organizations/{publicId}/profile/commands','directory.organizations.write'],['GET','/api/v2/directory/inventory','directory.inventory.read'],['POST','/api/v2/directory/organizations/bindings/revisions/commands','directory.organizations.binding.revision.refresh']];
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
  for(const name of readdirSync(directory).filter(name=>/^\d{4}_.+\.sql$/.test(name)&&name.slice(0,4)>'0161'&&name.slice(0,4)<='0203').sort()){
    await db.batch([...splitD1MigrationStatements(readFileSync(new URL(name,directory),'utf8')).map(sql=>db.prepare(sql)),db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(name)]);
  }
  await db.batch(splitD1MigrationStatements(readFileSync(new URL('0211_native_directory_create_observations.sql', directory),'utf8')).map(sql=>db.prepare(sql)));
  await db.batch([
    db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('refresh-area','Refresh fixtures',1)"),
    ...['directory.profile.edit','directory.identity.link'].map((permission,index)=>db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global',?)").bind(`refresh-global-${index}`,staffId,permission,staffId)),
  ]);
},240000);
afterAll(async()=>{await runtime?.dispose();});

async function fixture(automatic=false,updateRevision='2'){
  sourceId=automatic?`project-alpha:fixture_${randomUUID().replaceAll('-','')}`:'project-alpha:primary';
  const recordId=`refresh-org-${randomUUID()}`,publicId=randomUUID().replaceAll('-','');
  const writer={staffId,accessSubject:'access|owner',admissionVersion:1,selectedGrantId:'refresh-global-0',selectedIdentityGrantId:'refresh-global-1',loginEmail:'owner@example.test',profileVersion:1};
  const destinations=[{sourceId,sourceInstanceUUID:source,applicationUUID:application,historyEpoch:epoch,origin,externalCanonicalId:recordId,expectedAuthorizationGeneration:'0'}];
  const input:NativeDirectoryCreateWrite={operation:'create',mutationId:randomUUID(),createAdmissionId:randomUUID(),recordId,expectedLocalVersion:0,kind:'organization',profile,scopes:[{businessAreaId:'refresh-area',divisionId:null}],destinations,actor:writer};
  await db.prepare('INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by) VALUES(?,?,?,?,?,?,?,?,?)').bind(input.createAdmissionId,staffId,writer.accessSubject,recordId,'organization',JSON.stringify(input.scopes),JSON.stringify(profile),JSON.stringify(destinations.map(({expectedAuthorizationGeneration:_,...rest})=>rest)),staffId).run();
  const normal=vi.fn<typeof fetch>(async(url,init)=>{
    const path=new URL(String(url)).pathname;if(path.endsWith('/capabilities'))return json(capabilities());
    const body=JSON.parse(String(init?.body)),update=path.endsWith('/profile/commands');
    return json({...envelope,replayed:false,result:{resource:update?{type:'organization',publicId,revision:updateRevision}:{type:'organization',id:body.externalId,publicId,revision:'1'},authorizationGeneration:'1'}},update?200:201);
  });
  const created=await writeNativeDirectoryProfile(db,input);expect(created.status).toBe('written');if(created.status!=='written')throw Error(created.reason);
  expect((await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,created.commandIds[0]!,normal)).status).toBe('acknowledged');
  const update={operation:'update' as const,mutationId:randomUUID(),recordId,expectedLocalVersion:1,kind:'organization' as const,profile:{...profile,name:updateRevision==='1'?profile.name:'Updated fixture'},destinations:destinations.map(x=>({...x,expectedAuthorizationGeneration:'1'})),actor:writer};
  const written=await writeNativeDirectoryProfile(db,update);expect(written.status).toBe('written');if(written.status!=='written')throw Error(written.reason);
  const settled=await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,written.commandIds[0]!,normal);
  if(settled.status!=='acknowledged')throw new Error(JSON.stringify(settled));
  let binding='1',generation='1',revision=updateRevision,projectionSha256='a'.repeat(64);const posts:string[]=[];
  let postHook:(()=>Promise<void>)|undefined;
  const send=vi.fn<typeof fetch>(async(url,init)=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/capabilities'))return json(capabilities());
    if(path.endsWith('/inventory'))return json({...envelope,requestId:randomUUID(),authorizationGeneration:generation,resources:[{type:'organization',publicId,revision,present:true,lastAction:'upsert',projectionSha256,binding:{externalId:recordId,status:'active',resourceRevision:binding}}],nextCursor:null});
    posts.push(String(init?.body));const replayed=binding==='2',command=JSON.parse(String(init?.body));binding='2';
    const acknowledgedGeneration=(BigInt(command.expectedAuthorizationGeneration)+1n).toString();if(!replayed)generation=acknowledgedGeneration;if(postHook)await postHook();
    return json({...envelope,replayed,result:{resource:{type:'organization',id:recordId,revision:'2'},binding:{publicId,previousRevision:'1',authorizationGeneration:acknowledgedGeneration}}});
  });
  return {recordId,publicId,writer,update,send,posts,commandId:written.commandIds[0]!,setHook:(hook?:()=>Promise<void>)=>{postHook=hook;},setFresh:(next:{revision?:string;hash?:string;generation?:string;binding?:string})=>{revision=next.revision??revision;projectionSha256=next.hash??projectionSha256;generation=next.generation??generation;binding=next.binding??binding;}};
}
async function count(table:string,commandId:string){return db.prepare(`SELECT count(*) n FROM ${table} WHERE command_id=?`).bind(commandId).first<number>('n');}

const automaticEnv=()=>({...env(),NATIVE_DIRECTORY_PROFILE_BINDING_CONTINUATION_ENABLED:'true'});
const productionAutomaticEnv=()=>({...automaticEnv(),ENVIRONMENT:'production'});
it('atomically derives an immutable destination job and completes and replays it under explicit production opt-in',async()=>{
  const f=await fixture(true);
  const job=await db.prepare('SELECT * FROM native_directory_profile_binding_jobs WHERE command_id=?').bind(f.commandId).first();
  expect(job).toMatchObject({record_id:f.recordId,local_version:2,source_id:sourceId,actor_id:staffId,access_subject:'access|owner',live_revision:'2',authorization_generation:'1'});
  await expect(db.prepare("UPDATE native_directory_profile_binding_jobs SET actor_id='other' WHERE command_id=?").bind(f.commandId).run()).rejects.toThrow();
  expect(await dispatchNativeDirectoryProfileBindingContinuation(productionAutomaticEnv(),sourceId,f.commandId,f.send)).toEqual({status:'acknowledged'});
  expect(f.posts).toHaveLength(1);
  expect(await resolveTrustedNativeFinancialMapping(env(),{kind:'organization',recordId:f.recordId,sourceId})).toMatchObject({revision:'2',authorizationGeneration:'2'});
  expect(await dispatchNativeDirectoryProfileBindingContinuation(productionAutomaticEnv(),sourceId,f.commandId,f.send)).toEqual({status:'acknowledged'});
  expect(f.posts).toHaveLength(1);
},30000);
it('keeps automatic authority default off in production and fails closed for unknown environments',async()=>{
  const f=await fixture(true);
  expect(await dispatchNativeDirectoryProfileBindingContinuation({...env(),ENVIRONMENT:'production'},sourceId,f.commandId,f.send)).toMatchObject({status:'blocked',reason:'disabled'});
  expect(await dispatchNativeDirectoryProfileBindingContinuation({...automaticEnv(),ENVIRONMENT:'preview'},sourceId,f.commandId,f.send)).toMatchObject({status:'blocked',reason:'disabled'});
  expect(f.send).not.toHaveBeenCalled();
});

async function uncertainRecoveryFixture(options:{attempts?:number;authorizationGeneration?:string;priorRevision?:string;liveRevision?:string}={}){
  const attempts=options.attempts??1,authorizationGeneration=options.authorizationGeneration??'1',priorRevision=options.priorRevision??'1',liveRevision=options.liveRevision??'2';
  const f=await fixture(true,liveRevision);f.setFresh({generation:authorizationGeneration,binding:priorRevision,revision:liveRevision});
  const reviewed=await reviewDirectoryBindingRefresh(env(),actor(),f.recordId,sourceId,f.send);
  const uncertain=vi.fn<typeof fetch>(async(url,init)=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/bindings/revisions/commands'))throw new Error('lost response');
    return f.send(url,init);
  });
  for(let attempt=0;attempt<attempts;attempt++)expect(await executeDirectoryBindingRefresh(env(),actor(),reviewed.commandId,uncertain)).toMatchObject({status:'uncertain'});
  const old=await db.prepare('SELECT command_json,request_sha256,projection_sha256,prior_revision,live_revision,authorization_generation FROM native_directory_active_binding_refresh_commands WHERE command_id=?')
    .bind(reviewed.commandId).first<{command_json:string;request_sha256:string;projection_sha256:string;prior_revision:string;live_revision:string;authorization_generation:string}>();if(!old)throw new Error('missing frozen command');
  await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='refresh-global-0'").run();
  await db.prepare("UPDATE native_directory_grants SET active=1 WHERE id='refresh-global-0'").run();
  const observedGeneration=(BigInt(old.authorization_generation)+1n).toString();f.setFresh({generation:observedGeneration,binding:old.prior_revision,revision:old.live_revision});
  const requestId=randomUUID(),reconcilePath='/api/v2/directory/organizations/bindings/revisions/commands/reconcile';
  const terminal={...envelope,requestId,status:'terminal_conflict' as const,command:{commandId:reviewed.commandId,requestSha256:old.request_sha256},
    observation:{resource:{type:'organization' as const,id:f.recordId,revision:old.live_revision,projectionSha256:old.projection_sha256},
      binding:{publicId:f.publicId,revision:old.prior_revision,projectionSha256:'d'.repeat(64)},authorizationGeneration:observedGeneration},acknowledgement:null};
  const reconciliationCapabilities={...capabilities(),requestId,implementedEndpoints:[capabilities().implementedEndpoints[0],
    {method:'POST',path:reconcilePath,requiredCapability:'directory.organizations.binding.revision.refresh',requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}]};
  const recovery=vi.fn<typeof fetch>(async url=>new URL(String(url)).pathname.endsWith('/capabilities')?json(reconciliationCapabilities):json(terminal));
  return{f,reviewed,old,terminal,recovery};
}

async function directSupersession(x:Awaited<ReturnType<typeof uncertainRecoveryFixture>>,response:Record<string,unknown>,command:Record<string,unknown>){
  const id=String(command.commandId),generation=await db.prepare('SELECT generation FROM native_directory_grant_generations WHERE staff_id=?').bind(staffId).first<number>('generation');
  return db.prepare(`INSERT INTO native_directory_active_binding_refresh_supersessions(successor_command_id,superseded_command_id,captured_attempts,reason,
    reconciliation_request_id,reconciliation_response_json,reconciliation_response_sha256,observed_resource_revision,observed_resource_projection_sha256,
    observed_binding_revision,observed_binding_projection_sha256,observed_authorization_generation,actor_id,access_subject,actor_login_email,
    admission_version,profile_version,grant_generation,command_json,request_sha256) VALUES(${Array.from({length:20},()=>'?').join(',')})`).bind(
      id,x.reviewed.commandId,1,'remote_receipt_absent_generation_advanced',String(response.requestId),JSON.stringify(response),'e'.repeat(64),'2',x.old.projection_sha256,
      '1','d'.repeat(64),'2',staffId,'access|owner','owner@example.test',1,1,generation,JSON.stringify(command),'f'.repeat(64)).run();
}

it('records one terminal conflict and successor without rewriting the uncertain predecessor, then executes only the successor',async()=>{
  const x=await uncertainRecoveryFixture(),before=await db.prepare('SELECT * FROM native_directory_active_binding_refresh_dispatch WHERE command_id=?').bind(x.reviewed.commandId).first();
  const candidate=await reviewDirectoryBindingRefresh(env(),actor(),x.f.recordId,sourceId,x.f.send);
  expect(candidate).toEqual({...x.reviewed,recoveryCandidate:true,capturedAttempts:1});expect(x.f.posts).toEqual([]);
  const successor=await reviewDirectoryBindingRefreshRecovery(env(),actor(),x.reviewed.commandId,x.recovery);
  expect(successor).toMatchObject({supersededCommandId:x.reviewed.commandId,capturedAttempts:1,priorRevision:'1',liveRevision:'2'});
  expect(await db.prepare('SELECT * FROM native_directory_active_binding_refresh_dispatch WHERE command_id=?').bind(x.reviewed.commandId).first()).toEqual(before);
  expect(await db.prepare('SELECT observed_authorization_generation,captured_attempts FROM native_directory_active_binding_refresh_supersessions WHERE successor_command_id=?')
    .bind(successor.commandId).first()).toEqual({observed_authorization_generation:'2',captured_attempts:1});
  const authority=await db.prepare(`SELECT old.grant_generation old_generation,s.grant_generation fresh_generation
    FROM native_directory_active_binding_refresh_supersessions s JOIN native_directory_active_binding_refresh_commands old ON old.command_id=s.superseded_command_id
    WHERE s.successor_command_id=?`).bind(successor.commandId).first<{old_generation:number;fresh_generation:number}>();
  expect(authority?.fresh_generation).toBe((authority?.old_generation??0)+2);
  expect(await reviewDirectoryBindingRefresh(env(),actor(),x.f.recordId,sourceId,x.f.send)).toEqual(successor);
  const stateProbe=vi.fn<typeof fetch>();
  await expect(executeDirectoryBindingRefresh(env(),{...actor(),identity:{...actor().identity,verifiedAccessSubject:'access|foreign'}},x.reviewed.commandId,stateProbe))
    .rejects.toThrow('directory_binding_refresh_denied');expect(stateProbe).not.toHaveBeenCalled();
  expect(await executeDirectoryBindingRefresh(env(),actor(),x.reviewed.commandId,x.f.send)).toEqual({status:'conflict',commandId:x.reviewed.commandId,
    reason:'terminally_superseded',successorCommandId:successor.commandId});
  expect(await executeDirectoryBindingRefreshSuccessor(env(),actor(),successor.commandId,x.f.send)).toMatchObject({status:'acknowledged',revision:'2'});
  expect(await db.prepare('SELECT state,attempts FROM native_directory_active_binding_refresh_successor_dispatch WHERE command_id=?').bind(successor.commandId).first())
    .toEqual({state:'acknowledged',attempts:1});
  const refreshed=await readConfiguredProjectAlphaDirectoryInventory(env(),sourceId,{type:'organization',cursor:null,limit:200},x.f.send);
  expect(refreshed.status).toBe('observed');if(refreshed.status!=='observed')throw new Error('missing successor inventory');
  expect((await persistProjectAlphaDirectoryInventoryPage(db,refreshed.inventory,null)).status).toBe('persisted');
  const next={...x.f.update,mutationId:randomUUID(),expectedLocalVersion:2,profile:{...profile,name:'Post-successor profile'},
    destinations:x.f.update.destinations.map(destination=>({...destination,expectedAuthorizationGeneration:'3'}))};
  const written=await writeNativeDirectoryProfile(db,next);expect(written.status).toBe('written');if(written.status!=='written')throw new Error(written.reason);
  const profileSend=vi.fn<typeof fetch>(async(url,init)=>{
    if(new URL(String(url)).pathname.endsWith('/capabilities'))return json(capabilities());const body=JSON.parse(String(init?.body));
    return json({...envelope,requestId:randomUUID(),replayed:false,result:{resource:{type:'organization',publicId:x.f.publicId,revision:'3'},
      authorizationGeneration:body.expectedAuthorizationGeneration}});
  });
  expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,written.commandIds[0]!,profileSend)).toMatchObject({status:'acknowledged',revision:'3'});
  let continuationBinding='2',continuationGeneration='3';
  const continuation=vi.fn<typeof fetch>(async(url,init)=>{const path=new URL(String(url)).pathname;
    if(path.endsWith('/capabilities'))return json(capabilities());
    if(path.endsWith('/inventory'))return json({...envelope,requestId:randomUUID(),authorizationGeneration:continuationGeneration,resources:[{type:'organization',publicId:x.f.publicId,
      revision:'3',present:true,lastAction:'upsert',projectionSha256:'9'.repeat(64),binding:{externalId:x.f.recordId,status:'active',resourceRevision:continuationBinding}}],nextCursor:null});
    const body=JSON.parse(String(init?.body));continuationBinding='3';continuationGeneration=(BigInt(body.expectedAuthorizationGeneration)+1n).toString();
    return json({...envelope,requestId:randomUUID(),replayed:false,result:{resource:{type:'organization',id:x.f.recordId,revision:'3'},
      binding:{publicId:x.f.publicId,previousRevision:'2',authorizationGeneration:continuationGeneration}}});});
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,written.commandIds[0]!,continuation)).toEqual({status:'acknowledged'});
  expect(await db.prepare('PRAGMA foreign_key_check').all()).toMatchObject({results:[]});
},30000);

it('keeps unresolved reconciliation read-only and recovery default-off',async()=>{
  const x=await uncertainRecoveryFixture(),unresolved={...x.terminal,status:'unresolved' as const};
  const send=vi.fn<typeof fetch>(async url=>new URL(String(url)).pathname.endsWith('/capabilities')?x.recovery(url):json(unresolved));
  await expect(reviewDirectoryBindingRefreshRecovery(env(),actor(),x.reviewed.commandId,send)).rejects.toThrow('directory_binding_refresh_denied');
  await expect(reviewDirectoryBindingRefreshRecovery({...env(),NATIVE_DIRECTORY_BINDING_REFRESH_RECOVERY_ENABLED:undefined},actor(),x.reviewed.commandId,x.recovery)).rejects.toThrow('directory_binding_refresh_denied');
  expect(await db.prepare('SELECT count(*) n FROM native_directory_active_binding_refresh_supersessions WHERE superseded_command_id=?').bind(x.reviewed.commandId).first('n')).toBe(0);
});

it('rolls back when current authority changes after PA terminal evidence and converges concurrent reviews to one successor',async()=>{
  const drift=await uncertainRecoveryFixture(),drifting=vi.fn<typeof fetch>(async(url,init)=>{
    if(new URL(String(url)).pathname.endsWith('/reconcile')){
      await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='refresh-global-1'").run();
      await db.prepare("UPDATE native_directory_grants SET active=1 WHERE id='refresh-global-1'").run();
    }return drift.recovery(url,init);
  });
  await expect(reviewDirectoryBindingRefreshRecovery(env(),actor(),drift.reviewed.commandId,drifting)).rejects.toThrow('directory_binding_refresh_denied');
  expect(await db.prepare('SELECT count(*) n FROM native_directory_active_binding_refresh_supersessions WHERE superseded_command_id=?').bind(drift.reviewed.commandId).first('n')).toBe(0);
  const concurrent=await uncertainRecoveryFixture(),results=await Promise.all([
    reviewDirectoryBindingRefreshRecovery(env(),actor(),concurrent.reviewed.commandId,concurrent.recovery),
    reviewDirectoryBindingRefreshRecovery(env(),actor(),concurrent.reviewed.commandId,concurrent.recovery),
  ]);
  expect(results[0]!.commandId).toBe(results[1]!.commandId);
  expect(await db.prepare('SELECT count(*) n FROM native_directory_active_binding_refresh_supersessions WHERE superseded_command_id=?').bind(concurrent.reviewed.commandId).first('n')).toBe(1);
},30000);

it('durably rejects foreign reconciliation identity and a successor command with extra keys',async()=>{
  const foreign=await uncertainRecoveryFixture(),foreignId=randomUUID(),foreignCommand={commandId:foreignId,externalId:foreign.f.recordId,expectedPriorRevision:'1',expectedLiveRevision:'2',expectedAuthorizationGeneration:'2'};
  await expect(directSupersession(foreign,{...foreign.terminal,sourceInstanceId:randomUUID()},foreignCommand)).rejects.toThrow('active binding refresh supersession is not exact');
  await expect(directSupersession(foreign,{...foreign.terminal,privateError:'no'},foreignCommand)).rejects.toThrow();
  const extra=await uncertainRecoveryFixture(),extraId=randomUUID(),extraCommand={commandId:extraId,externalId:extra.f.recordId,expectedPriorRevision:'1',expectedLiveRevision:'2',expectedAuthorizationGeneration:'2',retry:true};
  await expect(directSupersession(extra,{...extra.terminal,command:{commandId:extra.reviewed.commandId,requestSha256:extra.old.request_sha256}},extraCommand)).rejects.toThrow();
  expect(await db.prepare('SELECT count(*) n FROM native_directory_active_binding_refresh_supersessions WHERE superseded_command_id IN(?,?)')
    .bind(foreign.reviewed.commandId,extra.reviewed.commandId).first('n')).toBe(0);
});
it('completes an already aligned binding without POST',async()=>{
  const f=await fixture(true);f.setFresh({binding:'2'});
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,f.send)).toEqual({status:'acknowledged'});
  expect(f.posts).toHaveLength(0);
  expect(await db.prepare('SELECT count(*) n FROM native_directory_profile_binding_commands WHERE job_command_id=?').bind(f.commandId).first('n')).toBe(0);
});
it('settles an equal-revision no-op profile ACK and completes its aligned continuation without POST',async()=>{
  // PA records an idempotent no-op receipt without advancing its canonical projection revision.
  const f=await fixture(true,'1');
  expect(await db.prepare('SELECT live_revision,local_version FROM native_directory_profile_binding_jobs WHERE command_id=?')
    .bind(f.commandId).first()).toMatchObject({live_revision:'1',local_version:2});
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,f.send)).toEqual({status:'acknowledged'});
  expect(f.posts).toHaveLength(0);
  expect(await db.prepare('SELECT count(*) n FROM native_directory_profile_binding_commands WHERE job_command_id=?').bind(f.commandId).first('n')).toBe(0);
});
it('rejects a regressing profile ACK both at transport and the atomic continuation enqueue guard',async()=>{
  const f=await fixture(true);
  const updated=await writeNativeDirectoryProfile(db,{...f.update,mutationId:randomUUID(),expectedLocalVersion:2,
    profile:{...profile,name:'Regressing response fixture'}});
  if(updated.status!=='written')throw Error(updated.reason);
  const commandId=updated.commandIds[0]!;
  const regressing=vi.fn<typeof fetch>(async url=>new URL(String(url)).pathname.endsWith('/capabilities')?json(capabilities()):
    json({...envelope,replayed:false,result:{resource:{type:'organization',publicId:f.publicId,revision:'1'},authorizationGeneration:'1'}}));
  expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,commandId,regressing)).toMatchObject({status:'uncertain',reason:'invalid_contract'});
  expect(await count('native_directory_profile_binding_jobs',commandId)).toBe(0);
  await db.prepare("UPDATE project_alpha_directory_outbox SET state='leased',lease_token='regression-guard',lease_expires_at=? WHERE command_id=?")
    .bind(Date.now()+60_000,commandId).run();
  const outcomeValue=JSON.parse((await db.prepare('SELECT acknowledged_outcome_json FROM native_directory_profile_binding_jobs WHERE command_id=?')
    .bind(f.commandId).first<string>('acknowledged_outcome_json'))!);
  outcomeValue.response.result.resource.revision='1';
  const outcome=JSON.stringify(outcomeValue);
  await expect(db.prepare("UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased' AND lease_token='regression-guard'")
    .bind(outcome,commandId).run()).rejects.toThrow();
  expect(await count('native_directory_profile_binding_jobs',commandId)).toBe(0);
  expect(await db.prepare('SELECT state FROM project_alpha_directory_outbox WHERE command_id=?').bind(commandId).first('state')).toBe('leased');
});
it('refreshes a stale owned binding after an equal-revision second no-op profile ACK',async()=>{
  const f=await fixture(true);
  const written=await writeNativeDirectoryProfile(db,{...f.update,mutationId:randomUUID(),expectedLocalVersion:2});
  if(written.status!=='written')throw Error(written.reason);
  const commandId=written.commandIds[0]!;
  const noOp=vi.fn<typeof fetch>(async url=>new URL(String(url)).pathname.endsWith('/capabilities')?json(capabilities()):
    json({...envelope,replayed:false,result:{resource:{type:'organization',publicId:f.publicId,revision:'2'},authorizationGeneration:'1'}}));
  expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,commandId,noOp)).toMatchObject({status:'acknowledged',revision:'2'});
  expect(await db.prepare('SELECT live_revision,local_version FROM native_directory_profile_binding_jobs WHERE command_id=?')
    .bind(commandId).first()).toMatchObject({live_revision:'2',local_version:3});
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,commandId,f.send)).toEqual({status:'acknowledged'});
  expect(f.posts).toHaveLength(1);
  expect(JSON.parse(f.posts[0]!)).toMatchObject({expectedPriorRevision:'1',expectedLiveRevision:'2'});
});
it('retains the exact ID and body after an unknown successful POST and recovers its receipt',async()=>{
  const f=await fixture(true);f.setHook(async()=>{throw new Error('lost successful response');});
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,f.send)).toMatchObject({status:'uncertain'});
  const frozen=await db.prepare('SELECT * FROM native_directory_profile_binding_commands WHERE job_command_id=?').bind(f.commandId).first();
  f.setHook();await db.prepare('UPDATE native_directory_profile_binding_dispatch SET next_attempt_at=0 WHERE command_id=?').bind(f.commandId).run();
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,f.send)).toEqual({status:'acknowledged'});
  expect(f.posts).toHaveLength(2);expect(f.posts[0]).toBe(f.posts[1]);
  expect(await db.prepare('SELECT * FROM native_directory_profile_binding_commands WHERE job_command_id=?').bind(f.commandId).first()).toEqual(frozen);
},30000);
it('does not revalidate or impersonate the original actor after durable ACK',async()=>{
  const f=await fixture(true);
  await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='refresh-global-0'").run();
  try{expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,f.send)).toEqual({status:'acknowledged'});}
  finally{await db.prepare("UPDATE native_directory_grants SET active=1 WHERE id='refresh-global-0'").run();}
});
it('freezes fresh nonregressed authorization generation under exact owned-binding authority before its first POST',async()=>{
  const f=await fixture(true);f.setFresh({generation:'3'});
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,f.send)).toEqual({status:'acknowledged'});
  expect(f.posts).toHaveLength(1);expect(JSON.parse(f.posts[0]!)).toMatchObject({expectedAuthorizationGeneration:'3'});
});
it('parks unrelated generation advance after freezing without rebasing or replacing the uncertain command',async()=>{
  const f=await fixture(true);f.setHook(async()=>{throw new Error('lost response');});
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,f.send)).toMatchObject({status:'uncertain'});
  const frozen=await db.prepare('SELECT * FROM native_directory_profile_binding_commands WHERE job_command_id=?').bind(f.commandId).first();
  f.setFresh({generation:'4'});f.setHook();await db.prepare('UPDATE native_directory_profile_binding_dispatch SET next_attempt_at=0 WHERE command_id=?').bind(f.commandId).run();
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,f.send)).toMatchObject({status:'conflict'});
  expect(f.posts).toHaveLength(1);
  expect(await db.prepare('SELECT * FROM native_directory_profile_binding_commands WHERE job_command_id=?').bind(f.commandId).first()).toEqual(frozen);
});
it('parks exhausted authorization generation before freezing but completes an already aligned maximum',async()=>{
  const stale=await fixture(true);stale.setFresh({generation:'9223372036854775807'});
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,stale.commandId,stale.send))
    .toEqual({status:'conflict',reason:'authorization_generation_exhausted'});
  expect(stale.posts).toHaveLength(0);
  expect(await db.prepare('SELECT 1 FROM native_directory_profile_binding_commands WHERE job_command_id=?').bind(stale.commandId).first()).toBeNull();
  const aligned=await fixture(true);aligned.setFresh({generation:'9223372036854775807',binding:'2'});
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,aligned.commandId,aligned.send)).toEqual({status:'acknowledged'});
  expect(aligned.posts).toHaveLength(0);
},60000);
it('resumes bounded genuine inventory pages beyond 1000 resources and resets invalid or generation-drifted cursors',async()=>{
  const f=await fixture(true),target=BigInt(`0x${f.publicId}`),cursors:(string|null)[]=[];let invalid=false;
  expect(target).toBeGreaterThan(1001n);
  const preceding=Array.from({length:1001},(_,i)=>({type:'organization',publicId:(target-1001n+BigInt(i)).toString(16).padStart(32,'0'),revision:'1',
    present:true,lastAction:'upsert',projectionSha256:'b'.repeat(64),binding:null}));
  const send=vi.fn<typeof fetch>(async(url,init)=>{
    const parsed=new URL(String(url));if(!parsed.pathname.endsWith('/inventory'))return f.send(url,init);
    const cursor=parsed.searchParams.get('cursor');cursors.push(cursor);
    if(invalid&&cursor){invalid=false;return new Response(null,{status:400});}
    const response=await f.send(url,init),body=await response.json() as {resources:typeof preceding;authorizationGeneration:string};
    const rows=[...preceding,...body.resources].filter(r=>!cursor||`organization:${r.publicId}`>cursor),page=rows.slice(0,200);
    return json({...body,resources:page,nextCursor:rows.length>page.length?`organization:${page.at(-1)!.publicId}`:null});
  });
  const attempt=async()=>{await db.prepare('UPDATE native_directory_profile_binding_dispatch SET next_attempt_at=0 WHERE command_id=?').bind(f.commandId).run();
    return dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,send);};
  expect(await attempt()).toMatchObject({status:'uncertain'});expect(cursors).toHaveLength(5);expect(f.posts).toHaveLength(0);
  expect(await db.prepare('SELECT inventory_cursor FROM native_directory_profile_binding_dispatch WHERE command_id=?').bind(f.commandId).first('inventory_cursor')).toBeTruthy();
  invalid=true;expect(await attempt()).toMatchObject({status:'uncertain'});
  expect(await db.prepare('SELECT inventory_cursor FROM native_directory_profile_binding_dispatch WHERE command_id=?').bind(f.commandId).first('inventory_cursor')).toBeNull();
  expect(await attempt()).toMatchObject({status:'uncertain'});
  f.setFresh({generation:'3'});expect(await attempt()).toMatchObject({status:'uncertain'});
  expect(await db.prepare('SELECT inventory_cursor FROM native_directory_profile_binding_dispatch WHERE command_id=?').bind(f.commandId).first('inventory_cursor')).toBeNull();
  let outcome=await attempt();for(let i=0;i<4&&outcome.status==='uncertain';i++)outcome=await attempt();
  expect(outcome).toEqual({status:'acknowledged'});expect(f.posts).toHaveLength(1);
  expect(JSON.parse(f.posts[0]!)).toMatchObject({expectedAuthorizationGeneration:'3'});
},300000);
it('scheduler drains the derived lane through its separate explicit policy',async()=>{
  const f=await fixture(true);
  const result=await drainNativeDirectoryOutboxes({...automaticEnv(),NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:'true'},
    {send:f.send,rotationTime:300_000,maxCommands:12});
  expect(result.attempted).toBeGreaterThan(0);
  expect(await db.prepare('SELECT state FROM native_directory_profile_binding_dispatch WHERE command_id=?').bind(f.commandId).first('state')).toBe('complete');
});
for(const interruption of ['503','scheduler_deadline'] as const)it(`checkpoints each persisted page and resumes after mid-scan ${interruption}`,async()=>{
  const f=await fixture(true),prefix=(BigInt(`0x${f.publicId}`)-1n).toString(16).padStart(32,'0'),checkpoint=`organization:${prefix}`;
  const cursors:(string|null)[]=[];let interrupted=false,inventoryCalls=0,now=Date.now();const started=now;
  const send=vi.fn<typeof fetch>(async(url,init)=>{
    const parsed=new URL(String(url));if(!parsed.pathname.endsWith('/inventory'))return f.send(url,init);
    const cursor=parsed.searchParams.get('cursor');cursors.push(cursor);inventoryCalls++;
    if(!interrupted&&inventoryCalls===2&&interruption==='503'){interrupted=true;return new Response(null,{status:503});}
    const response=await f.send(url,init),body=await response.json() as {resources:unknown[]};
    if(!cursor){
      if(!interrupted&&interruption==='scheduler_deadline'){interrupted=true;now=started+20_001;}
      return json({...body,resources:[{type:'organization',publicId:prefix,revision:'1',present:true,lastAction:'upsert',projectionSha256:'b'.repeat(64),binding:null}],nextCursor:checkpoint});
    }
    return json({...body,nextCursor:null});
  });
  const result=await drainNativeDirectoryOutboxes({...automaticEnv(),NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED:'true'},
    {send,rotationTime:0,maxCommands:1,now:()=>now});
  expect(result.uncertain).toBe(1);expect(f.posts).toHaveLength(0);
  expect(await db.prepare('SELECT inventory_cursor FROM native_directory_profile_binding_dispatch WHERE command_id=?').bind(f.commandId).first('inventory_cursor')).toBe(checkpoint);
  const prior=cursors.length;await db.prepare('UPDATE native_directory_profile_binding_dispatch SET next_attempt_at=0 WHERE command_id=?').bind(f.commandId).run();
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,send)).toMatchObject({status:'uncertain'});
  expect(cursors[prior]).toBe(checkpoint);expect(f.posts).toHaveLength(1);
  await db.prepare('UPDATE native_directory_profile_binding_dispatch SET next_attempt_at=0 WHERE command_id=?').bind(f.commandId).run();
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,send)).toEqual({status:'acknowledged'});
  expect(f.posts).toHaveLength(1);
},60000);
it('parks current local-version drift without retargeting the durable ACK job',async()=>{
  const f=await fixture(true);
  expect((await writeNativeDirectoryProfile(db,{...f.update,mutationId:randomUUID(),expectedLocalVersion:2,
    profile:{...profile,name:'A newer local revision'}})).status).toBe('written');
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,f.send)).toMatchObject({status:'conflict'});
  expect(f.posts).toHaveLength(0);
});
it('parks a changed projection after an unknown POST, without minting or sending another command',async()=>{
  const f=await fixture(true);f.setHook(async()=>{throw new Error('lost response');});
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,f.send)).toMatchObject({status:'uncertain'});
  f.setFresh({hash:'c'.repeat(64)});f.setHook();
  await db.prepare('UPDATE native_directory_profile_binding_dispatch SET next_attempt_at=0 WHERE command_id=?').bind(f.commandId).run();
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,f.send)).toMatchObject({status:'conflict'});
  expect(f.posts).toHaveLength(1);
});
it('rejects premature completion and invented receipt evidence in the full schema',async()=>{
  const f=await fixture(true);
  await expect(db.prepare("UPDATE native_directory_profile_binding_dispatch SET state='complete' WHERE command_id=?").bind(f.commandId).run()).rejects.toThrow();
  await expect(db.prepare(`INSERT INTO native_directory_profile_binding_receipts(job_command_id,response_json,response_sha256,pa_request_id,authorization_generation)
    VALUES(?,'{}',?,?, '2')`).bind(f.commandId,'a'.repeat(64),randomUUID()).run()).rejects.toThrow();
  expect(f.posts).toHaveLength(0);
});
it('replays the frozen command after a transient receipt persistence failure',async()=>{
  const f=await fixture(true),session=db.withSession('first-primary');let injected=false;
  const flaky:D1Database={prepare:sql=>session.prepare(sql),batch:statements=>session.batch(statements),exec:sql=>db.exec(sql),dump:()=>db.dump(),
    withSession:()=>({prepare:sql=>{
      if(!injected&&sql.includes('INSERT INTO native_directory_profile_binding_receipts')){injected=true;throw new Error('temporary receipt storage failure');}
      return session.prepare(sql);
    },batch:statements=>session.batch(statements),getBookmark:()=>session.getBookmark()})};
  expect(await dispatchNativeDirectoryProfileBindingContinuation({...automaticEnv(),OPS_DB:flaky},sourceId,f.commandId,f.send)).toMatchObject({status:'uncertain'});
  expect(injected).toBe(true);expect(f.posts).toHaveLength(1);
  await db.prepare('UPDATE native_directory_profile_binding_dispatch SET next_attempt_at=0 WHERE command_id=?').bind(f.commandId).run();
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,f.send)).toEqual({status:'acknowledged'});
  expect(f.posts).toHaveLength(2);expect(f.posts[0]).toBe(f.posts[1]);
},30000);
it('keeps an expired settlement lease replayable with its original frozen body',async()=>{
  const f=await fixture(true),start=Date.now();let clock:ReturnType<typeof vi.spyOn>|undefined;
  f.setHook(async()=>{clock=vi.spyOn(Date,'now').mockReturnValue(start+120_000);});
  try{expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,f.send)).toMatchObject({status:'uncertain'});}
  finally{clock?.mockRestore();}
  f.setHook();await db.prepare('UPDATE native_directory_profile_binding_dispatch SET next_attempt_at=0 WHERE command_id=?').bind(f.commandId).run();
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,f.send)).toEqual({status:'acknowledged'});
  expect(f.posts).toHaveLength(2);expect(f.posts[0]).toBe(f.posts[1]);
},30000);
it('retries normal inventory persistence after a durable receipt without another POST',async()=>{
  const f=await fixture(true);
  const unavailable=vi.fn<typeof fetch>(async(url,init)=>new URL(String(url)).pathname.endsWith('/inventory')&&f.posts.length
    ?new Response(null,{status:503}):f.send(url,init));
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,unavailable)).toMatchObject({status:'uncertain'});
  expect(f.posts).toHaveLength(1);
  expect(await db.prepare('SELECT count(*) n FROM native_directory_profile_binding_receipts WHERE job_command_id=?').bind(f.commandId).first('n')).toBe(1);
  await db.prepare('UPDATE native_directory_profile_binding_dispatch SET next_attempt_at=0 WHERE command_id=?').bind(f.commandId).run();
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,f.commandId,f.send)).toEqual({status:'acknowledged'});
  expect(f.posts).toHaveLength(1);
},30000);
it.each(['sourceInstanceId','applicationId','historyEpoch'] as const)('parks configured %s drift before any PA request',async field=>{
  const f=await fixture(true),configured=productionAutomaticEnv(),connections=JSON.parse(configured.PROJECT_ALPHA_API_V2_CONNECTIONS!);
  connections.instances[sourceId][field]=randomUUID();
  expect(await dispatchNativeDirectoryProfileBindingContinuation({...configured,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify(connections)},sourceId,f.commandId,f.send))
    .toMatchObject({status:'conflict',reason:'destination_changed'});
  expect(f.send).not.toHaveBeenCalled();expect(f.posts).toHaveLength(0);
});
it.each(['publicId','externalId','revision'] as const)('parks fresh inventory %s identity drift without creating a refresh command',async field=>{
  const f=await fixture(true);
  const wrong=vi.fn<typeof fetch>(async(url,init)=>{
    const response=await f.send(url,init);if(!new URL(String(url)).pathname.endsWith('/inventory'))return response;
    const body=await response.json() as {requestId:string;resources:Array<{publicId:string;revision:string;binding:{externalId:string}}>};
    if(field==='publicId')body.resources[0]!.publicId='b'.repeat(32);
    else if(field==='externalId')body.resources[0]!.binding.externalId='wrong-external-id';else body.resources[0]!.revision='3';
    return json(body);
  });
  expect(await dispatchNativeDirectoryProfileBindingContinuation(productionAutomaticEnv(),sourceId,f.commandId,wrong)).toMatchObject({status:'conflict'});
  expect(f.posts).toHaveLength(0);
  expect(await db.prepare('SELECT count(*) n FROM native_directory_profile_binding_commands WHERE job_command_id=?').bind(f.commandId).first('n')).toBe(0);
});
it('preserves ordinary flag-off client ACK settlement and derives safe automatic completion under the canonical schema',async()=>{
  sourceId=`project-alpha:client_${randomUUID().replaceAll('-','')}`;
  const recordId=`client-${randomUUID()}`,publicId=randomUUID().replaceAll('-','');
  const writer={staffId,accessSubject:'access|owner',admissionVersion:1,selectedGrantId:'refresh-global-0',selectedIdentityGrantId:'refresh-global-1',loginEmail:'owner@example.test',profileVersion:1};
  const clientProfile={name:'Client fixture',email:'client@example.test',phone:'512-555-0100',addressLine1:'1 Main',addressLine2:'',city:'Austin',state:'TX',postalCode:'78701',country:'US'};
  const destinations=[{sourceId,sourceInstanceUUID:source,applicationUUID:application,historyEpoch:epoch,origin,externalCanonicalId:recordId,expectedAuthorizationGeneration:'0'}];
  const input:NativeDirectoryCreateWrite={operation:'create',mutationId:randomUUID(),createAdmissionId:randomUUID(),recordId,expectedLocalVersion:0,kind:'client',
    profile:{...clientProfile,clientType:'business'},relationship:{organizationRecordId:null,expectedRelationshipVersion:0},scopes:[{businessAreaId:'refresh-area',divisionId:null}],destinations,actor:writer};
  await db.prepare('INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(input.createAdmissionId,staffId,writer.accessSubject,recordId,'client',JSON.stringify(input.scopes),JSON.stringify(input.profile),JSON.stringify(destinations.map(({expectedAuthorizationGeneration:_,...rest})=>rest)),staffId).run();
  await db.prepare('INSERT INTO native_directory_create_admission_relationships(create_admission_id,client_record_id,organization_record_id,organization_record_version) VALUES(?,?,NULL,NULL)')
    .bind(input.createAdmissionId,recordId).run();
  let binding='1',generation='1';const posts:string[]=[];
  const send=vi.fn<typeof fetch>(async(url,init)=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/capabilities')){const c=capabilities();return json({...c,grantedCapabilities:c.grantedCapabilities.map(x=>({name:x.name.replaceAll('organizations','clients')})),
      implementedEndpoints:c.implementedEndpoints.map(x=>({...x,path:x.path.replaceAll('organizations','clients'),requiredCapability:x.requiredCapability.replaceAll('organizations','clients')}))});}
    if(path.endsWith('/inventory'))return json({...envelope,requestId:randomUUID(),authorizationGeneration:generation,resources:[{type:'client',publicId,revision:'2',present:true,lastAction:'upsert',projectionSha256:'a'.repeat(64),binding:{externalId:recordId,status:'active',resourceRevision:binding}}],nextCursor:null});
    const body=JSON.parse(String(init?.body));
    if(path.endsWith('/bindings/revisions/commands')){posts.push(String(init?.body));binding='2';generation='2';return json({...envelope,replayed:false,result:{resource:{type:'client',id:recordId,revision:'2'},binding:{publicId,previousRevision:'1',authorizationGeneration:'2'}}});}
    const update=path.endsWith('/profile/commands');
    return json({...envelope,replayed:false,result:{resource:update?{type:'client',publicId,revision:'2'}:{type:'client',id:body.externalId,publicId,revision:'1'},authorizationGeneration:'1'}},update?200:201);
  });
  const created=await writeNativeDirectoryProfile(db,input);if(created.status!=='written')throw Error(created.reason);
  expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,created.commandIds[0]!,send)).toMatchObject({status:'acknowledged'});
  const updated=await writeNativeDirectoryProfile(db,{operation:'update',mutationId:randomUUID(),recordId,expectedLocalVersion:1,kind:'client',profile:{...clientProfile,name:'Updated client'},
    relationship:{organizationRecordId:null,expectedRelationshipVersion:1},destinations:destinations.map(d=>({...d,expectedAuthorizationGeneration:'1'})),actor:writer});
  if(updated.status!=='written')throw Error(updated.reason);
  expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,updated.commandIds[0]!,send)).toMatchObject({status:'acknowledged'});
  expect(await db.prepare('SELECT resource_type FROM native_directory_profile_binding_jobs WHERE command_id=?').bind(updated.commandIds[0]).first('resource_type')).toBe('client');
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,updated.commandIds[0]!,send)).toEqual({status:'acknowledged'});
  expect(posts).toHaveLength(1);
},30000);
it('drains two owned records acknowledged at the same source generation without stalling the second first-freeze',async()=>{
  const first=await fixture(true),secondId=`second-${randomUUID()}`,secondPublic=randomUUID().replaceAll('-','');
  const destinations=[{sourceId,sourceInstanceUUID:source,applicationUUID:application,historyEpoch:epoch,origin,externalCanonicalId:secondId,expectedAuthorizationGeneration:'1'}];
  const create:NativeDirectoryCreateWrite={operation:'create',mutationId:randomUUID(),createAdmissionId:randomUUID(),recordId:secondId,expectedLocalVersion:0,
    kind:'organization',profile,scopes:[{businessAreaId:'refresh-area',divisionId:null}],destinations,actor:first.writer};
  await db.prepare('INSERT INTO native_directory_create_admissions(id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(create.createAdmissionId,staffId,first.writer.accessSubject,secondId,'organization',JSON.stringify(create.scopes),JSON.stringify(profile),JSON.stringify(destinations.map(({expectedAuthorizationGeneration:_,...rest})=>rest)),staffId).run();
  let generation='1';const bindings=new Map([[first.recordId,'1'],[secondId,'1']]),posts:string[]=[];
  const resources=[{id:first.recordId,publicId:first.publicId,revision:'3'},{id:secondId,publicId:secondPublic,revision:'2'}].sort((a,b)=>a.publicId.localeCompare(b.publicId));
  const send=vi.fn<typeof fetch>(async(url,init)=>{
    const path=new URL(String(url)).pathname;if(path.endsWith('/capabilities'))return json(capabilities());
    if(path.endsWith('/inventory'))return json({...envelope,requestId:randomUUID(),authorizationGeneration:generation,resources:resources.map(r=>({type:'organization',publicId:r.publicId,
      revision:r.revision,present:true,lastAction:'upsert',projectionSha256:'a'.repeat(64),binding:{externalId:r.id,status:'active',resourceRevision:bindings.get(r.id)}})),nextCursor:null});
    const command=JSON.parse(String(init?.body));
    expect(command.expectedAuthorizationGeneration).toBe(generation);
    if(path.endsWith('/bindings/revisions/commands')){
      posts.push(String(init?.body));const r=resources.find(r=>r.id===command.externalId)!;
      expect(command.expectedPriorRevision).toBe(bindings.get(r.id));expect(command.expectedLiveRevision).toBe(r.revision);
      generation=(BigInt(generation)+1n).toString();bindings.set(r.id,r.revision);
      return json({...envelope,replayed:false,result:{resource:{type:'organization',id:r.id,revision:r.revision},binding:{publicId:r.publicId,previousRevision:command.expectedPriorRevision,authorizationGeneration:generation}}});
    }
    if(path.endsWith('/profile/commands')){const r=resources.find(r=>path.includes(r.publicId))!;
      return json({...envelope,replayed:false,result:{resource:{type:'organization',publicId:r.publicId,revision:r.revision},authorizationGeneration:generation}});}
    generation=(BigInt(generation)+1n).toString();
    return json({...envelope,replayed:false,result:{resource:{type:'organization',id:secondId,publicId:secondPublic,revision:'1'},authorizationGeneration:generation}},201);
  });
  const created=await writeNativeDirectoryProfile(db,create);if(created.status!=='written')throw Error(created.reason);
  expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,created.commandIds[0]!,send)).toMatchObject({status:'acknowledged'});
  const second=await writeNativeDirectoryProfile(db,{operation:'update',mutationId:randomUUID(),recordId:secondId,expectedLocalVersion:1,kind:'organization',profile:{...profile,name:'Second updated'},
    destinations:destinations.map(d=>({...d,expectedAuthorizationGeneration:'2'})),actor:first.writer});if(second.status!=='written')throw Error(second.reason);
  expect(await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,second.commandIds[0]!,send)).toMatchObject({status:'acknowledged'});
  const newerFirst=await writeNativeDirectoryProfile(db,{...first.update,mutationId:randomUUID(),expectedLocalVersion:2,profile:{...profile,name:'First updated again'},
    destinations:first.update.destinations.map(d=>({...d,expectedAuthorizationGeneration:'2'}))});if(newerFirst.status!=='written')throw Error(newerFirst.reason);
  const firstAck=await dispatchProjectAlphaDirectoryProfileOutboxCommand(env(),sourceId,newerFirst.commandIds[0]!,send);
  expect(firstAck,'reason' in firstAck?firstAck.reason:firstAck.status).toMatchObject({status:'acknowledged'});
  for(const id of [newerFirst.commandIds[0]!,second.commandIds[0]!])
    expect(await db.prepare('SELECT authorization_generation FROM native_directory_profile_binding_jobs WHERE command_id=?').bind(id).first('authorization_generation')).toBe('2');
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,newerFirst.commandIds[0]!,send)).toEqual({status:'acknowledged'});
  expect(await dispatchNativeDirectoryProfileBindingContinuation(automaticEnv(),sourceId,second.commandIds[0]!,send)).toEqual({status:'acknowledged'});
  expect(posts).toHaveLength(2);expect(posts.map(body=>JSON.parse(body).expectedAuthorizationGeneration)).toEqual(['2','3']);
},60000);

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

it.each([0,2])('capability preflight preserves the entire frozen dispatch at attempts %s without POST',async attempts=>{
  const f=await fixture(),review=await reviewDirectoryBindingRefresh(env(),actor(),f.recordId,sourceId,f.send);
  if(attempts){
    // Establish genuine uncertain attempts through the ordinary transition guards.
    f.setHook(async()=>{throw new TypeError('lost fixture response');});
    for(let attempt=0;attempt<attempts;attempt++)expect(await executeDirectoryBindingRefresh(env(),actor(),review.commandId,f.send)).toMatchObject({status:'uncertain'});
  }
  const snapshot=async()=>Promise.all(['native_directory_active_binding_refresh_commands','native_directory_active_binding_refresh_dispatch','native_directory_active_binding_refresh_receipts'].map(async table=>(await db.prepare(`SELECT * FROM ${table} WHERE command_id=?`).bind(review.commandId).all()).results));
  const authorityAndMappings=async()=>Promise.all(['native_directory_grants','native_directory_grant_history','native_directory_grant_generations','project_alpha_active_directory_mappings','project_alpha_api_v2_directory_observations'].map(async table=>(await db.prepare(`SELECT * FROM ${table}`).all()).results));
  const before=await snapshot(),unchanged=await authorityAndMappings(),priorPosts=[...f.posts];
  const send=vi.fn<typeof fetch>(async(url,init)=>{
    if(new URL(String(url)).pathname.endsWith('/capabilities')){const meta=capabilities();meta.grantedCapabilities=meta.grantedCapabilities.filter(c=>!c.name.endsWith('.binding.revision.refresh'));return json(meta);}
    return f.send(url,init);
  });
  expect(await executeDirectoryBindingRefresh(env(),actor(),review.commandId,send)).toEqual({status:attempts?'uncertain':'blocked',commandId:review.commandId,reason:'refresh_capability_unavailable',frozenCommandRetained:true,latestAttemptSent:false});
  expect(await snapshot()).toEqual(before);expect(await authorityAndMappings()).toEqual(unchanged);expect(f.posts).toEqual(priorPosts);
},30000);

it('send-time capability drift remains conservatively uncertain without a PA POST',async()=>{
  const f=await fixture(),review=await reviewDirectoryBindingRefresh(env(),actor(),f.recordId,sourceId,f.send);
  let inventorySeen=false,probes=0;
  const send=vi.fn<typeof fetch>(async(url,init)=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/capabilities')&&inventorySeen&&++probes===2){const meta=capabilities();meta.grantedCapabilities=meta.grantedCapabilities.filter(c=>!c.name.endsWith('.binding.revision.refresh'));return json(meta);}
    const result=await f.send(url,init);if(path.endsWith('/inventory'))inventorySeen=true;return result;
  });
  expect(await executeDirectoryBindingRefresh(env(),actor(),review.commandId,send)).toEqual({status:'uncertain',commandId:review.commandId,reason:'refresh_capability_unavailable',frozenCommandRetained:true,latestAttemptSent:false});
  expect(await db.prepare('SELECT state,attempts,lease_token,lease_until FROM native_directory_active_binding_refresh_dispatch WHERE command_id=?').bind(review.commandId).first()).toEqual({state:'uncertain',attempts:1,lease_token:null,lease_until:null});expect(f.posts).toEqual([]);
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

it('recovers the exact two-attempt generation-60 incident shape under renewed staff authority',async()=>{
  const x=await uncertainRecoveryFixture({attempts:2,authorizationGeneration:'60',priorRevision:'3',liveRevision:'4'});
  const successor=await reviewDirectoryBindingRefreshRecovery(env(),actor(),x.reviewed.commandId,x.recovery);
  expect(successor).toMatchObject({supersededCommandId:x.reviewed.commandId,capturedAttempts:2,priorRevision:'3',liveRevision:'4'});
  const durable=await db.prepare(`SELECT s.captured_attempts,s.observed_authorization_generation,s.observed_resource_revision,s.observed_binding_revision,
    old.authorization_generation old_authorization_generation,old.grant_generation old_grant_generation,s.grant_generation fresh_grant_generation
    FROM native_directory_active_binding_refresh_supersessions s JOIN native_directory_active_binding_refresh_commands old
      ON old.command_id=s.superseded_command_id WHERE s.successor_command_id=?`).bind(successor.commandId).first<{captured_attempts:number;observed_authorization_generation:string;
        observed_resource_revision:string;observed_binding_revision:string;old_authorization_generation:string;old_grant_generation:number;fresh_grant_generation:number}>();
  expect(durable).toMatchObject({
      captured_attempts:2,observed_authorization_generation:'61',observed_resource_revision:'4',observed_binding_revision:'3',
      old_authorization_generation:'60',
    });
  expect(durable?.fresh_grant_generation).toBe((durable?.old_grant_generation??0)+2);
  expect(await db.prepare('SELECT state,attempts FROM native_directory_active_binding_refresh_dispatch WHERE command_id=?').bind(x.reviewed.commandId).first())
    .toEqual({state:'uncertain',attempts:2});
},30000);

// Global protected-owner policy is intentionally changed only in the last case.
it('honors protected-owner integrations.manage global policy deny',async()=>{
  const f=await fixture(),review=await reviewDirectoryBindingRefresh(env(),actor(),f.recordId,sourceId,f.send);
  await db.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES(?,?,'integrations.manage','deny','global','global',?)").bind(randomUUID(),staffId,staffId).run();
  await expect(executeDirectoryBindingRefresh(env(),actor(),review.commandId,f.send)).rejects.toThrow();expect(f.posts).toEqual([]);
},30000);
