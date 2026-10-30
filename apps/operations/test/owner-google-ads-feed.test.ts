import { readFileSync } from 'node:fs';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { Hono } from 'hono';
import { Miniflare } from 'miniflare';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { dispatchIntelIngest } from '../src/worker/intel-ingest-routes';
import { intelDigest,intelSigningBytes,base64url,type ProducerKey } from '../src/worker/competitor-intel-ingest-security';
import { INTEL_INGEST_PATH } from '../src/worker/competitor-intel-ingest-security';
import { registerOwnerIntelRoutes } from '../src/worker/owner-intel';
import type { Env,StaffPrincipal } from '../src/worker/types';

const TS=new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),NOW=Date.parse(TS),ORIGIN='https://incoming.ledgetopdroneservices.com',PRODUCER='hermes-competitor-intel';
const key:ProducerKey={producer_id:PRODUCER,key_id:'test-key-1',public_key:'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',key_revision:1,state:'active'};
const encoder=new TextEncoder();
const journalVectors=JSON.parse(readFileSync(new URL('./fixtures/hermes-journal-v4-staged-vectors.json',import.meta.url),'utf8')) as {sourceArtifactSha256:string;cases:Array<{id:string;body:string;context:Record<string,unknown>;receiverExpected:boolean;bodySha256:string}>};
let runtime:Miniflare,db:D1Database,privateKey:CryptoKey,serial=0,bindingId='binding-one',businessId='business-one',routeKey='synthetic';
const id=()=>`00000000-0000-4000-8000-${(++serial).toString(16).padStart(12,'0')}`;
const account={managerCustomerRef:'1234567890',advertiserCustomerRef:'0987654321',currencyCode:'USD',timeZone:'America/Chicago'};
function shiftDate(value:string,days:number){const date=new Date(`${value}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);}
function localDate(timestamp:string,zone:string){const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(timestamp));const get=(type:Intl.DateTimeFormatPartTypes)=>parts.find(part=>part.type===type)?.value;return `${get('year')}-${get('month')}-${get('day')}`;}
const currentWindowEnd=shiftDate(localDate(TS,account.timeZone),-1);
function observation(options:{counter?:string;operationId?:string;binding?:string;accountState?:'connected'|'no_account'}={}){
 const noAccount=options.accountState==='no_account';
 return {schemaVersion:'ci.observation.v1',producerId:PRODUCER,operationId:options.operationId??id(),monitoringBindingId:options.binding??bindingId,configurationRevision:1,
  observationKind:'google_ads_summary',subjectKey:'own:google-ads',sourceSequence:{epoch:'1',counter:options.counter??'1'},commandBinding:null,observedAt:'2026-10-25T11:00:00Z',completedAt:TS,
  semantics:{observation:'ci.google_ads_owner.v1'},payload:{account:noAccount?null:{...account},period:noAccount?null:{start:shiftDate(currentWindowEnd,-6),end:currentWindowEnd,days:7,timeZone:account.timeZone},currencyCode:noAccount?null:account.currencyCode,
   totals:noAccount?{costMicros:null,impressions:null,clicks:null,conversions:null,state:'no_account',reason:'no_account'}:
    {costMicros:'1234567',impressions:'100',clicks:'5',conversions:'1.25',state:'observed',reason:null},
   provenance:{source:'google_ads_api',sourceAccountRef:noAccount?null:account.advertiserCustomerRef,collectedBy:'hermes-google-ads',collectedAt:TS,asOf:noAccount?null:TS,partial:false,partialReason:null,limits:[]}}};
}
function legacyV1(operationId=id()){
 return {schemaVersion:'ci.observation.v1',producerId:PRODUCER,operationId,monitoringBindingId:bindingId,configurationRevision:1,observationKind:'scan_run',subjectKey:'scan:synthetic',
  sourceSequence:{epoch:'1',counter:'1'},commandBinding:null,observedAt:TS,completedAt:TS,semantics:{observation:'ci.obs.v1',scoring:'concern_0_10.v1'},
  payload:{scanType:'full',trigger:'manual',startedAt:TS,completedAt:TS,nextScheduledAt:null,competitorsScanned:0,pages:{attempted:0,succeeded:0},changesDetected:0,errors:0,state:'completed'}};
}
function gscObservation(operationId=id()){
 const dates=Array.from({length:7},(_,index)=>new Date(Date.parse('2026-10-18T00:00:00Z')+index*86400000).toISOString().slice(0,10));
 return {schemaVersion:'ci.observation.v1',producerId:PRODUCER,operationId,monitoringBindingId:bindingId,configurationRevision:1,observationKind:'search_console_summary',subjectKey:'gsc:ltds',
  sourceSequence:{epoch:'1',counter:'1'},commandBinding:null,observedAt:'2026-10-24T11:00:00Z',completedAt:TS,semantics:{observation:'ci.obs.v2',scoring:'concern_0_10.v1'},
  payload:{siteUrl:'https://ltds.example/',period:{start:'2026-10-18',end:'2026-10-24',days:7},totals:{clicks:10,impressions:100,ctrPercent:'10',avgPosition:'2',state:'observed',reason:null},daily:dates.map(date=>({date,clicks:1,impressions:10})),topQueries:[],topPages:[],comparison:null,
   provenance:{source:'google_search_console',sourceAccountRef:'source-account',collectedBy:PRODUCER,collectedAt:TS,asOf:'2026-10-24T11:00:00Z',lastDataDate:'2026-10-24',dataRange:{start:'2026-10-24',end:'2026-10-24'},partial:false,partialReason:null,limits:[]}}};
}
async function signed(value:unknown,producer=PRODUCER){
 return signedBody(JSON.stringify(value),TS,producer);
}
async function signedBody(body:string,timestamp:string,producer=PRODUCER){
 const digest=await intelDigest(encoder.encode(body)),headers={producer,keyId:key.key_id,timestamp,digest};
 const signature=base64url(new Uint8Array(await crypto.subtle.sign('Ed25519',privateKey,intelSigningBytes(headers) as BufferSource)));
 return new Request(`${ORIGIN}${INTEL_INGEST_PATH}`,{method:'POST',headers:{'Content-Type':'application/json','X-CI-Producer':producer,'X-CI-Key-Id':key.key_id,'X-CI-Timestamp':timestamp,'X-CI-Content-SHA256':digest,'X-CI-Signature':signature},body});
}
function env():Env{return {OPS_DB:db,ENVIRONMENT:'production',INCOMING_BASE_URL:ORIGIN,INCOMING_EXPECTED_HOST:'incoming.ledgetopdroneservices.com',COMPETITOR_INTEL_INGEST_ENABLED:'true'} as Env;}
async function post(value:unknown){return dispatchIntelIngest(await signed(value),env(),NOW);}
async function count(table:string){return db.prepare(`SELECT COUNT(*) count FROM ${table} WHERE binding_id=?`).bind(bindingId).first<number>('count');}
async function installAdsBinding(options:{accountState?:'connected'|'no_account';binding?:string;business?:string;alias?:string;producer?:string}={}){
 const selectedBinding=options.binding??bindingId,selectedBusiness=options.business??businessId,alias=options.alias??routeKey,producer=options.producer??PRODUCER,noAccount=options.accountState==='no_account';
 await db.prepare("INSERT INTO owner_intel_businesses VALUES(?,'Synthetic Business',1,'reviewed')").bind(selectedBusiness).run();
 await db.prepare("INSERT INTO owner_intel_business_aliases VALUES(?,?,'active')").bind(alias,selectedBusiness).run();
 await db.prepare("INSERT INTO owner_intel_bindings VALUES(?,?,1,'reviewed')").bind(selectedBinding,selectedBusiness).run();
 await db.prepare('INSERT INTO ci_ingest_producer_bindings VALUES(?,?,1,1)').bind(producer,selectedBinding).run();
 await db.prepare('INSERT INTO owner_intel_google_ads_bindings(producer_id,binding_id,configuration_revision,subject_key,observation_kind,account_state,manager_customer_ref,advertiser_customer_ref,source_account_ref,currency_code,time_zone,collected_by,active) VALUES(?,?,1,\'own:google-ads\',\'google_ads_summary\',?,?,?,?,?,?,?,1)')
  .bind(producer,selectedBinding,noAccount?'no_account':'connected',noAccount?null:account.managerCustomerRef,noAccount?null:account.advertiserCustomerRef,noAccount?null:account.advertiserCustomerRef,noAccount?null:account.currencyCode,noAccount?null:account.timeZone,'hermes-google-ads').run();
 const gscContext={producerId:producer,monitoringBindingId:selectedBinding,configurationRevision:1,observationKind:'search_console_summary',subjectKey:'gsc:ltds',source:'google_search_console',sourceAccountRef:'source-account',collectedBy:PRODUCER,
  searchProperties:[{kind:'url_prefix',siteUrl:'https://ltds.example/',origin:'https://ltds.example',pathPrefix:'/'}],propertyRefs:[],canonicalDomains:[],pageUrls:['https://ltds.example/'],ownerSubjectKeys:[],socialProfileUrls:[],providerLagDays:3};
 await db.prepare('INSERT INTO owner_intel_source_bindings VALUES(?,?,1,\'search_console_summary\',\'gsc:ltds\',\'google_search_console\',\'source-account\',?,?,1)')
  .bind(producer,selectedBinding,PRODUCER,JSON.stringify(gscContext)).run();
}

beforeAll(async()=>{
 const der=new Uint8Array(48);der.set(Uint8Array.from([0x30,0x2e,0x02,0x01,0,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]));der.set(Uint8Array.from({length:32},(_,n)=>n),16);
 privateKey=await crypto.subtle.importKey('pkcs8',der,{name:'Ed25519'},false,['sign']);
 runtime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:'export default {fetch(){return new Response("ok")}}',d1Databases:{OPS_DB:'owner-google-ads-test'}});
 db=await runtime.getD1Database('OPS_DB') as unknown as D1Database;
 await db.exec(`CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,access_subject TEXT,status TEXT);
 CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,login_email TEXT,version INTEGER);
 CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,version INTEGER);
 CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT);
 CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT);`);
 for(const name of ['0227_owner_intel_reads.sql','0228_competitor_intel_ingest.sql','0229_owner_intel_source_feed.sql','0230_app_release_pilot.sql','0231_owner_google_ads_summary.sql'])
  await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8')).map(sql=>db.prepare(sql)));
});
afterAll(async()=>runtime?.dispose());
beforeEach(async()=>{
 serial+=100;bindingId=`binding-${serial}`;businessId=`business-${serial}`;routeKey=`synthetic-${serial}`;
 await db.prepare('INSERT OR REPLACE INTO ci_ingest_control VALUES(1,1)').run();await db.prepare('UPDATE owner_intel_control SET enabled=1,storage_accepted=1').run();await db.prepare('UPDATE owner_intel_source_control SET enabled=1,storage_accepted=1').run();
 await db.prepare('UPDATE owner_intel_google_ads_control SET enabled=0,storage_accepted=0').run();
 await db.prepare('INSERT OR REPLACE INTO ci_ingest_producer_keys VALUES(?,?,?,?,?)').bind(key.producer_id,key.key_id,key.public_key,key.key_revision,key.state).run();
});

describe('proposed owner Google Ads source lane',()=>{
 it('accepts the exact persisted stale Hermes Ads journal body, replays its receipt, and retains unknown metrics as null',async()=>{
  const item=journalVectors.cases.find(entry=>entry.id==='persisted-d7e3bdf00d29');
  expect(journalVectors.sourceArtifactSha256).toBe('9309157056727e83f801546867cfe596a3a500cb288c1e930ec4f8d875a4843f');
  expect(item?.receiverExpected).toBe(true);expect(item?.context).toMatchObject({configurationRevision:3,accountState:'connected',subjectKey:'own:google-ads'});
  const binding='binding-ads-window-heads',business='business-ads-window-heads',alias='journal-ads-fixture',context=item!.context;
  await db.batch([
   db.prepare("INSERT INTO owner_intel_businesses VALUES(?,'Synthetic Ads Journal Fixture',1,'reviewed')").bind(business),
   db.prepare("INSERT INTO owner_intel_business_aliases VALUES(?,?,'active')").bind(alias,business),
   db.prepare("INSERT INTO owner_intel_bindings VALUES(?,?,3,'reviewed')").bind(binding,business),
   db.prepare('INSERT INTO ci_ingest_producer_bindings VALUES(?,?,3,1)').bind(PRODUCER,binding),
   db.prepare('INSERT INTO owner_intel_google_ads_bindings(producer_id,binding_id,configuration_revision,subject_key,observation_kind,account_state,manager_customer_ref,advertiser_customer_ref,source_account_ref,currency_code,time_zone,collected_by,active) VALUES(?,?,3,?,?,?,?,?,?,?,?,?,1)')
    .bind(PRODUCER,binding,context.subjectKey,context.observationKind,context.accountState,context.managerCustomerRef,context.advertiserCustomerRef,context.sourceAccountRef,context.currencyCode,context.timeZone,context.collectedBy),
   db.prepare('UPDATE owner_intel_google_ads_control SET enabled=1,storage_accepted=1')
  ]);
  const signatureTime='2026-10-26T07:15:00Z',now=Date.parse(signatureTime),digest=await intelDigest(encoder.encode(item!.body));
  expect(digest).toBe(Buffer.from(item!.bodySha256,'hex').toString('base64url'));
  const firstResponse=await dispatchIntelIngest(await signedBody(item!.body,signatureTime),env(),now);
  expect(firstResponse?.status,firstResponse?await firstResponse.clone().text():'no response').toBe(200);
  const first=await firstResponse!.json() as {delivery:string;receipt:unknown};expect(first.delivery).toBe('first');
  const replay=await dispatchIntelIngest(await signedBody(item!.body,signatureTime),env(),now);
  expect(replay?.status).toBe(200);expect(await replay?.json()).toEqual({delivery:'duplicate',receipt:first.receipt});
  const stored=await db.prepare('SELECT raw_body,payload_sha256 FROM owner_intel_google_ads_inbox WHERE operation_id=?').bind(JSON.parse(item!.body).operationId).first<{raw_body:string;payload_sha256:string}>();
  expect(stored?.raw_body).toBe(item!.body);expect(stored?.payload_sha256).toBe(digest);
  const projection=await db.prepare('SELECT period_key,period_days,dto_json FROM owner_intel_google_ads_projections WHERE source_operation_id=?')
   .bind(JSON.parse(item!.body).operationId).first<{period_key:string;period_days:number|null;dto_json:string}>();
  expect(projection?.period_key).toBe('7d');expect(projection?.period_days).toBe(7);
  expect(JSON.parse(projection!.dto_json).observation.payload.totals).toEqual({clicks:null,conversions:null,costMicros:null,impressions:null,reason:'source_stale',state:'source_stale'});
 });

 it('migrates append-only storage without widening v1 or 0229, and starts disabled with no key, binding, or grant',async()=>{
  expect(await db.prepare('SELECT enabled,storage_accepted FROM owner_intel_google_ads_control').first()).toEqual({enabled:0,storage_accepted:0});
  for(const table of ['owner_intel_google_ads_bindings','owner_intel_google_ads_inbox','owner_intel_google_ads_projections','owner_intel_read_grants'])expect(await db.prepare(`SELECT COUNT(*) count FROM ${table}`).first<number>('count')).toBe(0);
  await expect(db.prepare("INSERT INTO owner_intel_source_bindings VALUES('p','b',1,'google_ads_summary','own:google-ads','google_ads_api','1234567890','c','{}',1)").run()).rejects.toThrow();
  await expect(db.prepare("INSERT INTO ci_ingest_inbox(operation_id,producer_id,key_id,key_revision,binding_id,configuration_revision,subject_key,observation_kind,epoch,counter,payload_sha256,raw_body,observation_json,receipt_json,accepted_at,outcome) VALUES('00000000-0000-4000-8000-000000000001','p','k',1,'b',1,'own:google-ads','google_ads_summary','1','1',?,'{}','{}','{}','2026-10-25T12:00:00Z','accepted_head')").bind('A'.repeat(43)).run()).rejects.toThrow();
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
 });

 it('keeps the Ads receiver default-off and returns no account/schema details before gates',async()=>{
  await installAdsBinding();expect(await db.prepare("SELECT COUNT(*) count FROM sqlite_schema WHERE type='table' AND name IN('owner_intel_google_ads_control','owner_intel_google_ads_bindings','owner_intel_google_ads_inbox','owner_intel_google_ads_epochs','owner_intel_google_ads_subject_heads','owner_intel_google_ads_range_heads','owner_intel_google_ads_epoch_audit','owner_intel_google_ads_projections','owner_intel_google_ads_batch_guards')").first<number>('count')).toBe(9);
  const blocked=await post(observation());expect(blocked?.status).toBe(404);expect(await count('owner_intel_google_ads_inbox')).toBe(0);
 await db.prepare('UPDATE owner_intel_google_ads_control SET enabled=1,storage_accepted=1').run();
  expect(await db.prepare('SELECT enabled,storage_accepted FROM owner_intel_google_ads_control').first()).toEqual({enabled:1,storage_accepted:1});
  const first=await post(observation());expect(first?.status,first?await first.clone().text():'no response').toBe(200);
 });

 it('fails closed as unavailable on an existing v1/v2 database before the additive 0231 migration',async()=>{
  const oldRuntime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:'export default {}',d1Databases:{OPS_DB:crypto.randomUUID()}});
  try{
   const oldDb=await oldRuntime.getD1Database('OPS_DB') as unknown as D1Database;
   await oldDb.prepare('CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,access_subject TEXT,status TEXT)').run();
   for(const name of ['0227_owner_intel_reads.sql','0228_competitor_intel_ingest.sql','0229_owner_intel_source_feed.sql','0230_app_release_pilot.sql'])
    await oldDb.batch(splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8')).map(sql=>oldDb.prepare(sql)));
   await oldDb.prepare('INSERT INTO ci_ingest_control VALUES(1,1)').run();
   await oldDb.prepare('INSERT INTO ci_ingest_producer_keys VALUES(?,?,?,?,?)').bind(key.producer_id,key.key_id,key.public_key,key.key_revision,key.state).run();
   const response=await dispatchIntelIngest(await signed(observation()),{...env(),OPS_DB:oldDb},NOW);
   expect(response?.status).toBe(404);expect(await response?.json()).toEqual({error:'not_found'});
  }finally{await oldRuntime.dispose();}
 });

 it('rejects wrong account scope, unsupported currency/timezone, incomplete current-day range and unsafe numeric encodings',async()=>{
 await installAdsBinding();await db.prepare('UPDATE owner_intel_google_ads_control SET enabled=1,storage_accepted=1').run();
 const wrong=observation();if(wrong.payload.account)wrong.payload.account.advertiserCustomerRef='1111111111';expect((await post(wrong))?.status).toBe(403);
 for(const mutate of [
  (value:any)=>{const today=shiftDate(currentWindowEnd,1);value.payload.period={start:shiftDate(today,-6),end:today,days:7,timeZone:'America/Chicago'};},
  (value:any)=>{value.payload.totals.costMicros='9223372036854775808';},
  (value:any)=>{value.payload.totals.clicks='1e2';},
  (value:any)=>{value.payload.totals.conversions='1.1234567';},
  (value:any)=>{value.payload.totals.conversions=1.5;},
  (value:any)=>{value.payload.extra='ignored';},
 ]){const value=observation();mutate(value);const response=await post(value);expect(response?.status,JSON.stringify(value.payload)).toBe(400);}
  for(const mutate of [(value:any)=>{value.payload.account.managerCustomerRef='2222222222';},(value:any)=>{value.payload.currencyCode='CAD';},(value:any)=>{value.payload.period.timeZone='America/New_York';}]){
   const value=observation();mutate(value);expect((await post(value))?.status).toBe(403);
  }
 });

 it('stores immutable per-range history, returns exact duplicates, and preserves stale/unknown values as null',async()=>{
 await installAdsBinding();await db.prepare('UPDATE owner_intel_google_ads_control SET enabled=1,storage_accepted=1').run();
 const value=observation(),first=await post(value),duplicate=await post(value);expect(first?.status).toBe(200);expect(await duplicate?.json()).toMatchObject({delivery:'duplicate',receipt:{operationId:value.operationId}});
 const unknown=observation({counter:'2'});unknown.payload.totals={costMicros:null,impressions:null,clicks:null,conversions:null,state:'source_stale',reason:'source_stale'};unknown.payload.provenance.asOf=null;
 expect((await post(unknown))?.status).toBe(200);expect(await count('owner_intel_google_ads_inbox')).toBe(2);expect(await count('owner_intel_google_ads_projections')).toBe(2);
 await expect(db.prepare("UPDATE owner_intel_google_ads_inbox SET raw_body='{}' WHERE operation_id=?").bind(value.operationId).run()).rejects.toThrow();
 await expect(db.prepare('DELETE FROM owner_intel_google_ads_projections WHERE binding_id=?').bind(bindingId).run()).rejects.toThrow();
 const projections=await db.prepare('SELECT dto_json FROM owner_intel_google_ads_projections WHERE binding_id=? ORDER BY revision DESC').bind(bindingId).all<{dto_json:string}>();
 expect(JSON.parse(projections.results[0]!.dto_json).observation.payload.totals).toEqual({costMicros:null,impressions:null,clicks:null,conversions:null,state:'source_stale',reason:'source_stale'});
 });

 it('uses an explicit no-account binding/state and never infers it from missing account data',async()=>{
 await installAdsBinding({accountState:'no_account'});await db.prepare('UPDATE owner_intel_google_ads_control SET enabled=1,storage_accepted=1').run();
 const noAccount=observation({accountState:'no_account'});expect((await post(noAccount))?.status).toBe(200);
 const invented=observation({accountState:'no_account'});invented.payload.account=account;invented.payload.currencyCode='USD';invented.payload.period={start:'2026-10-18',end:'2026-10-24',days:7,timeZone:'America/Chicago'};invented.payload.totals={costMicros:'0',impressions:'0',clicks:'0',conversions:'0',state:'observed',reason:null};invented.payload.provenance.sourceAccountRef=account.advertiserCustomerRef;invented.payload.provenance.asOf=TS;
 expect((await post(invented))?.status).toBe(403);
 });

 it('rejects same operation IDs across Ads, v1 and GSC v2 in both directions after signature verification',async()=>{
 await installAdsBinding();await db.prepare('UPDATE owner_intel_google_ads_control SET enabled=1,storage_accepted=1').run();
 const value=observation(),accepted=await post(value);expect(accepted?.status).toBe(200);
  const reused=legacyV1(value.operationId);const conflict=await post(reused);expect(conflict?.status).toBe(409);expect(await conflict?.json()).toEqual({error:'operation_hash_conflict'});
  expect((await post(gscObservation(value.operationId)))?.status).toBe(409);
 const otherId=id(),legacy=legacyV1(otherId);expect((await post(legacy))?.status).toBe(200);
 const adsReuse=observation({operationId:otherId,counter:'2'});expect((await post(adsReuse))?.status).toBe(409);
  const otherGscId=id();expect((await post(gscObservation(otherGscId)))?.status).toBe(200);
  const adsFromGsc=observation({operationId:otherGscId,counter:'3'});expect((await post(adsFromGsc))?.status).toBe(409);
  await db.prepare('INSERT INTO ci_ingest_producer_keys VALUES(?,?,?,?,?)').bind('hermes-alt-producer',key.key_id,key.public_key,key.key_revision,key.state).run();
  const altBinding=`binding-alt-${serial}`,altBusiness=`business-alt-${serial}`,altAlias=`synthetic-alt-${serial}`;
  await installAdsBinding({binding:altBinding,business:altBusiness,alias:altAlias,producer:'hermes-alt-producer'});
  const differentProducer={...observation({operationId:value.operationId,counter:'1',binding:altBinding}),producerId:'hermes-alt-producer'};
  expect((await dispatchIntelIngest(await signed(differentProducer,'hermes-alt-producer'),env(),NOW))?.status).toBe(409);
 const bad=await signed(observation({operationId:value.operationId}),PRODUCER);bad.headers.set('X-CI-Signature','A'.repeat(86));const denied=await dispatchIntelIngest(bad,env(),NOW);
 expect(denied?.status).toBe(401);expect(await count('owner_intel_google_ads_inbox')).toBe(1);
 });

 it('serves an owner-only summary without account IDs and rechecks explicit authority',async()=>{
 await installAdsBinding();await db.prepare('UPDATE owner_intel_google_ads_control SET enabled=1,storage_accepted=1').run();await post(observation());
 const staff=`staff-${serial}`,email=`owner-${serial}@example.test`,subject=`access-${serial}`;
 await db.batch([db.prepare("INSERT INTO staff_users VALUES(?,?,?,'active')").bind(staff,email,subject),db.prepare('INSERT INTO native_staff_profiles VALUES(?,?,1)').bind(staff,email),
  db.prepare('INSERT INTO native_staff_admissions VALUES(?,?,1,1)').bind(staff,subject),db.prepare("INSERT INTO staff_role_assignments VALUES(?,'role-owner','global')").bind(staff),
  db.prepare("INSERT INTO owner_intel_read_grants VALUES(?,?,?,'intel.owner.read','allow',1)").bind(`grant-${serial}`,staff,businessId)]);
 const principal:StaffPrincipal={id:staff,email,accessSubject:subject,displayName:'Synthetic Owner',projectAlphaUserId:null,accessExpiresAt:Math.floor(Date.now()/1000)+3600};
 const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();app.use('*',async(c,next)=>{c.set('principal',principal);c.set('administrator',false);await next();});registerOwnerIntelRoutes(app);
 const get=(range:'7d'|'28d'|'90d'='7d')=>app.request(`https://ops.example.test/api/intel/${routeKey}/google-ads?range=${range}`,{method:'GET'},{OPS_DB:db} as Env);
 const response=await get();expect(response.status).toBe(200);const dto=await response.json() as any;
 expect(dto).toMatchObject({schema:'ops.intel.owner-google-ads.v1',rangeSelection:'7d',currencyCode:'USD',totals:{costMicros:'1234567',impressions:'100',clicks:'5',conversions:'1.25',state:'observed'}});
 expect(JSON.stringify(dto)).not.toContain(account.advertiserCustomerRef);expect(JSON.stringify(dto)).not.toContain(account.managerCustomerRef);
 const unavailableRange=await get('28d');expect(unavailableRange.status).toBe(404);expect(await unavailableRange.json()).toEqual({error:'intel_google_ads_range_unavailable'});
 const historical=observation({counter:'2'}),historicalEnd=shiftDate(currentWindowEnd,-2);
 historical.payload.period={start:shiftDate(historicalEnd,-6),end:historicalEnd,days:7,timeZone:account.timeZone};
 expect((await post(historical))?.status).toBe(200); // retain the authentic, but older, observation
 const latestRead=await get();expect(latestRead.status).toBe(404);expect(await latestRead.json()).toEqual({error:'intel_google_ads_range_unavailable'});
 expect(await count('owner_intel_google_ads_inbox')).toBe(2);expect(await count('owner_intel_google_ads_projections')).toBe(2);
 await db.prepare("INSERT INTO owner_intel_read_grants VALUES(?,?,?,'intel.owner.read','deny',1)").bind(`deny-${serial}`,staff,businessId).run();expect((await get()).status).toBe(403);
 });
});
