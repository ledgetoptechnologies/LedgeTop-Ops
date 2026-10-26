import { readFileSync } from 'node:fs';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { Hono } from 'hono';
import { Miniflare } from 'miniflare';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { dispatchOwnerIntelSourceIngest,type OwnerIntelSourceEnvironment } from '../src/worker/owner-intel-source-ingest';
import { intelDigest,intelSigningBytes,base64url,type ProducerKey } from '../src/worker/competitor-intel-ingest-security';
import { INTEL_INGEST_PATH } from '../src/worker/competitor-intel-ingest-security';
import { strictIntelJson,validateIntelObservation } from '../src/worker/competitor-intel-ingest-schema';
import { registerOwnerIntelRoutes } from '../src/worker/owner-intel';
import type { Env,StaffPrincipal } from '../src/worker/types';

const ORIGIN='https://incoming.ledgetopdroneservices.com',TS='2026-10-25T12:00:00Z',NOW=Date.parse(TS),PRODUCER='hermes-competitor-intel';
const key:ProducerKey={producer_id:PRODUCER,key_id:'test-key-1',public_key:'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',key_revision:1,state:'active'};
const encoder=new TextEncoder(),page='https://ltds.example/';
let runtime:Miniflare,db:D1Database,privateKey:CryptoKey,serial=0,bindingId='binding-one',businessId='business-one',routeKey='synthetic';
const id=()=>`00000000-0000-4000-8000-${(++serial).toString(16).padStart(12,'0')}`;
const unknown={value:null,state:'unknown',reason:'not_checked'};
function context(bindingId:string,kind:'search_console_summary'|'own_site',subjectKey:string):Record<string,unknown>{
 const gsc=kind==='search_console_summary';return {producerId:PRODUCER,monitoringBindingId:bindingId,configurationRevision:1,observationKind:kind,subjectKey,
  source:gsc?'google_search_console':'hermes_site_monitor',sourceAccountRef:gsc?'source-account':null,collectedBy:gsc?'hermes-competitor-intel':'hermes-site-monitor',
  searchProperties:gsc?[{kind:'url_prefix',siteUrl:page,origin:'https://ltds.example',pathPrefix:'/'}]:[],propertyRefs:[],canonicalDomains:['ltds.example'],pageUrls:[page],ownerSubjectKeys:[],socialProfileUrls:[],providerLagDays:3};
}
function observation(kind:'search_console_summary'|'own_site'='search_console_summary',counter='1',binding=bindingId,subject=kind==='search_console_summary'?'gsc:ltds':'own:ltds'){
 const provenance={source:kind==='search_console_summary'?'google_search_console':'hermes_site_monitor',sourceAccountRef:kind==='search_console_summary'?'source-account':null,
  collectedBy:kind==='search_console_summary'?'hermes-competitor-intel':'hermes-site-monitor',collectedAt:TS,asOf:'2026-10-24T11:00:00Z',lastDataDate:'2026-10-24',
  dataRange:{start:'2026-10-24',end:'2026-10-24'},partial:false,partialReason:null,limits:[]};
 const payload=kind==='search_console_summary'?{siteUrl:page,period:{start:'2026-10-18',end:'2026-10-24',days:7},totals:{clicks:10,impressions:100,ctrPercent:'10',avgPosition:'2',state:'observed',reason:null},
  daily:Array.from({length:7},(_,n)=>({date:new Date(Date.parse('2026-10-18T00:00:00Z')+n*86400000).toISOString().slice(0,10),clicks:1,impressions:10})),topQueries:[],topPages:[],comparison:null,provenance}:
  {canonicalDomain:'ltds.example',monitoredPages:[{url:page,title:'Home',observedAt:TS,fetchStatus:'ok',contentSha256:'A'.repeat(43),contentLength:10}],changesSincePrevious:[],
   technical:{httpsOk:{value:true,state:'observed',reason:null},sitemapPageCount:unknown,robotsAllowsIndexing:unknown,avgFetchMs:0},provenance};
 return {schemaVersion:'ci.observation.v1',producerId:PRODUCER,operationId:id(),monitoringBindingId:binding,configurationRevision:1,observationKind:kind,subjectKey:subject,
  sourceSequence:{epoch:'1',counter},commandBinding:null,observedAt:'2026-10-24T11:00:00Z',completedAt:TS,semantics:{observation:'ci.obs.v2',scoring:'concern_0_10.v1'},payload};
}
async function signed(value:unknown){
 const body=JSON.stringify(value),digest=await intelDigest(encoder.encode(body)),headers={producer:PRODUCER,keyId:key.key_id,timestamp:TS,digest};
 const signature=base64url(new Uint8Array(await crypto.subtle.sign('Ed25519',privateKey,intelSigningBytes(headers) as BufferSource)));
 return new Request(`${ORIGIN}${INTEL_INGEST_PATH}`,{method:'POST',headers:{'Content-Type':'application/json','X-CI-Producer':headers.producer,'X-CI-Key-Id':headers.keyId,'X-CI-Timestamp':headers.timestamp,'X-CI-Content-SHA256':digest,'X-CI-Signature':signature},body});
}
function env():OwnerIntelSourceEnvironment{return {OPS_DB:db,ENVIRONMENT:'production',INCOMING_BASE_URL:ORIGIN,INCOMING_EXPECTED_HOST:'incoming.ledgetopdroneservices.com',COMPETITOR_INTEL_INGEST_ENABLED:'true'};}
async function post(value:unknown){const response=dispatchOwnerIntelSourceIngest(await signed(value),env(),NOW);return response?await response:null;}
async function count(table:string){return db.prepare(`SELECT COUNT(*) count FROM ${table} WHERE binding_id=?`).bind(bindingId).first<number>('count');}

beforeAll(async()=>{
 const der=new Uint8Array(48);der.set(Uint8Array.from([0x30,0x2e,0x02,0x01,0,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]));der.set(Uint8Array.from({length:32},(_,n)=>n),16);
 privateKey=await crypto.subtle.importKey('pkcs8',der,{name:'Ed25519'},false,['sign']);
 runtime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:'export default {fetch(){return new Response("ok")}}',d1Databases:{OPS_DB:'owner-source-test'}});
 db=await runtime.getD1Database('OPS_DB') as unknown as D1Database;
 await db.exec(`CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,access_subject TEXT,status TEXT);
 CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,login_email TEXT,version INTEGER);
 CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,version INTEGER);
 CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT);
 CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT);`);
 for(const name of ['0227_owner_intel_reads.sql','0228_competitor_intel_ingest.sql','0229_owner_intel_source_feed.sql']){
  for(const statement of splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8')))await db.prepare(statement).run();
 }
});
afterAll(async()=>runtime?.dispose());
beforeEach(async()=>{
 serial+=100;bindingId=`binding-${serial}`;businessId=`business-${serial}`;routeKey=`synthetic-${serial}`;
 await db.prepare('INSERT OR REPLACE INTO ci_ingest_control VALUES(1,1)').run();await db.prepare('UPDATE owner_intel_source_control SET enabled=1,storage_accepted=1').run();
 await db.prepare('UPDATE owner_intel_control SET enabled=1,storage_accepted=1').run();
 await db.prepare('INSERT OR REPLACE INTO ci_ingest_producer_keys VALUES(?,?,?,?,?)').bind(key.producer_id,key.key_id,key.public_key,key.key_revision,key.state).run();
 await db.prepare("INSERT INTO owner_intel_businesses VALUES(?,'Synthetic Business',1,'reviewed')").bind(businessId).run();
 await db.prepare("INSERT INTO owner_intel_business_aliases VALUES(?,?,'active')").bind(routeKey,businessId).run();
 await db.prepare("INSERT INTO owner_intel_bindings VALUES(?,?,1,'reviewed')").bind(bindingId,businessId).run();
 await db.prepare("INSERT INTO ci_ingest_producer_bindings VALUES(?,?,1,1)").bind(PRODUCER,bindingId).run();
 for(const [kind,subject] of [['search_console_summary','gsc:ltds'],['own_site','own:ltds']] as const){
  const c=context(bindingId,kind,subject);
  await db.prepare('INSERT INTO owner_intel_source_bindings VALUES(?,?,?,?,?,?,?,?,?,1)').bind(PRODUCER,bindingId,1,kind,subject,c.source,c.sourceAccountRef,c.collectedBy,JSON.stringify(c)).run();
 }
});

describe('source-only Hermes feed, immutable history and authorized reads',()=>{
 it('keeps the frozen v1 validator route available and rejects source kinds when the source gate is off',async()=>{
  const v2=observation(),disabled={...env(),COMPETITOR_INTEL_INGEST_ENABLED:undefined};
  const pending=dispatchOwnerIntelSourceIngest(await signed(v2),disabled,NOW);expect(pending).not.toBeNull();const response=await pending!;expect(response).not.toBeNull();expect(response!.status).toBe(404);
  expect(()=>validateIntelObservation(strictIntelJson(encoder.encode(JSON.stringify(v2))),PRODUCER,NOW)).toThrow('schema_invalid');
  const v1={...v2,semantics:{observation:'ci.obs.v1',scoring:'concern_0_10.v1'}};
  const fallsThrough=dispatchOwnerIntelSourceIngest(await signed(v1),env(),NOW);expect(fallsThrough).not.toBeNull();expect(await fallsThrough!).toBeNull();
  expect(await count('owner_intel_source_inbox')).toBe(0);
 });
 it('authenticates, projects and reads GSC with stale and unknown metrics preserved',async()=>{
  const staff=`staff-${serial}`,email=`owner-${serial}@example.test`,access=`access-${serial}`,expires=Math.floor(Date.now()/1000)+3600;
  await db.batch([db.prepare("INSERT INTO staff_users VALUES(?,?,?,'active')").bind(staff,email,access),db.prepare('INSERT INTO native_staff_profiles VALUES(?,?,1)').bind(staff,email),
   db.prepare('INSERT INTO native_staff_admissions VALUES(?,?,1,1)').bind(staff,access),db.prepare("INSERT INTO staff_role_assignments VALUES(?,'role-owner','global')").bind(staff),
   db.prepare("INSERT INTO owner_intel_read_grants VALUES(?,?,?,'intel.owner.read','allow',1)").bind(`grant-${serial}`,staff,businessId)]);
  const principal:StaffPrincipal={id:staff,email,accessSubject:access,displayName:'Owner',projectAlphaUserId:null,accessExpiresAt:expires};
  const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();app.use('*',async(c,next)=>{c.set('principal',principal);c.set('administrator',false);await next();});registerOwnerIntelRoutes(app);
  const get=()=>app.request(`https://ops.example.test/api/intel/${routeKey}/search-console?range=7d`,{method:'GET'},{OPS_DB:db} as Env);
  const value=observation(),first=await post(value);expect(first?.status).toBe(200);
  const firstRead=await get();expect(firstRead.status).toBe(200);expect((await firstRead.json() as any).totals.ctr).toBe(0.1);
  const p=value.payload as Record<string,any>;p.provenance={...p.provenance,asOf:null,lastDataDate:'2026-10-17',dataRange:{start:'2026-10-01',end:'2026-10-17'},partial:true,partialReason:'source_stale',limits:['LTT source stopped updating after 2026-10-17; cause unknown.']};
  p.daily=[];p.totals={clicks:null,impressions:null,ctrPercent:null,avgPosition:null,state:'unknown',reason:'source_stale'};
  value.operationId=id();value.sourceSequence={epoch:'1',counter:'2'};const second=await post(value);expect(second?.status).toBe(200);
  const response=await get();
  expect(response.status).toBe(200);const view=await response.json() as any;
  expect(view.totals).toEqual({clicks:null,impressions:null,ctr:null,position:null});expect(view.freshness.stale).toBe(true);
  expect(view.coverage.partialReason).toBe('source_stale');expect(view.coverage.lastDataDate).toBe('2026-10-17');
  expect(view.daily).toEqual([]);expect(view.receipt.operationId).toBe(value.operationId);
  expect(await count('owner_intel_source_inbox')).toBe(2);expect(await count('owner_intel_source_projections')).toBe(2);
  await expect(db.prepare("UPDATE owner_intel_source_inbox SET raw_body='{}' WHERE operation_id=?").bind(value.operationId).run()).rejects.toThrow();
  await expect(db.prepare('DELETE FROM owner_intel_source_projections WHERE binding_id=?').bind(bindingId).run()).rejects.toThrow();
  const original=crypto.subtle.digest.bind(crypto.subtle),spy=vi.spyOn(crypto.subtle,'digest').mockImplementationOnce(async(...args)=>{
   await db.prepare('UPDATE owner_intel_source_bindings SET active=0 WHERE binding_id=? AND observation_kind=\'search_console_summary\'').bind(bindingId).run();
   return original(...args);
  });
  try{expect((await get()).status).toBe(503);}finally{spy.mockRestore();}
 });
 it('returns exact duplicate receipt, retains ordered history and rejects replay conflicts',async()=>{
  const value=observation(),first=await post(value),duplicate=await post(value);expect(await first!.json()).toMatchObject({delivery:'first'});expect(await duplicate!.json()).toMatchObject({delivery:'duplicate'});
  const old={...observation('search_console_summary','2'),operationId:id()};
  // Counter 2 is the current head, so this is a same-tuple conflict.
  old.sourceSequence={epoch:'1',counter:'1'};old.operationId=id();const conflict=await post(old);expect(conflict?.status).toBe(409);
  const newer=observation('search_console_summary','3');newer.operationId=id();expect((await post(newer))?.status).toBe(200);
  const history=observation('search_console_summary','2');history.operationId=id();expect((await post(history))?.status).toBe(200);
  const prior=await db.prepare('SELECT outcome FROM owner_intel_source_inbox WHERE operation_id=?').bind(history.operationId).first<string>('outcome');expect(prior).toBe('accepted_history');
  expect(await count('owner_intel_source_projections')).toBe(2);
 });
 it('denies wrong business membership and exact reviewed property mismatches',async()=>{
  const unreviewed=observation();unreviewed.monitoringBindingId='binding-other';unreviewed.operationId=id();
  expect((await post(unreviewed))?.status).toBe(403);
  const wrongProperty=observation();wrongProperty.operationId=id();(wrongProperty.payload as Record<string,unknown>).siteUrl='https://other.example/';
  expect((await post(wrongProperty))?.status).toBe(400);expect(await count('owner_intel_source_inbox')).toBe(0);
  await db.prepare("UPDATE owner_intel_business_aliases SET status='retired' WHERE route_key=?").bind(routeKey).run();
  const noMembership=observation();noMembership.operationId=id();expect((await post(noMembership))?.status).toBe(403);
 });
 it('does not relabel a different GSC period as the requested range',async()=>{
  const value=observation(),posted=await post(value);expect(posted?.status).toBe(200);
  const staff=`staff-${serial}`,email=`owner-${serial}@example.test`,access=`access-${serial}`;
  await db.batch([db.prepare("INSERT INTO staff_users VALUES(?,?,?,'active')").bind(staff,email,access),db.prepare('INSERT INTO native_staff_profiles VALUES(?,?,1)').bind(staff,email),
   db.prepare('INSERT INTO native_staff_admissions VALUES(?,?,1,1)').bind(staff,access),db.prepare("INSERT INTO staff_role_assignments VALUES(?,'role-owner','global')").bind(staff),
   db.prepare("INSERT INTO owner_intel_read_grants VALUES(?,?,?,'intel.owner.read','allow',1)").bind(`grant-${serial}`,staff,businessId)]);
  const principal:StaffPrincipal={id:staff,email,accessSubject:access,displayName:'Owner',projectAlphaUserId:null,accessExpiresAt:Math.floor(Date.now()/1000)+3600};
  const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();app.use('*',async(c,next)=>{c.set('principal',principal);c.set('administrator',false);await next();});registerOwnerIntelRoutes(app);
  const response=await app.request(`https://ops.example.test/api/intel/${routeKey}/search-console?range=28d`,{method:'GET'},{OPS_DB:db} as Env);
  expect(response.status).toBe(404);expect(await response.json()).toEqual({error:'intel_range_unavailable'});
 });
 it('accepts the reviewed own-site source without converting it into GA4 metrics',async()=>{
  const value=observation('own_site');const ingestResponse=await post(value);expect(ingestResponse?.status).toBe(200);
  const {receipt}=await ingestResponse!.json() as {receipt:{operationId:string}};
  const row=await db.prepare('SELECT dto_json FROM owner_intel_source_projections WHERE observation_kind=? AND binding_id=?').bind('own_site',bindingId).first<string>('dto_json');
  const stored=JSON.parse(row!);expect(stored.observation.payload.technical.avgFetchMs).toBe(0);expect(stored.observation.payload.technical.sitemapPageCount.value).toBeNull();
  expect(stored.observation.observationKind).toBe('own_site');expect(receipt.operationId).toBe(value.operationId);
  await expect(db.prepare("UPDATE owner_intel_source_bindings SET reviewed_context_json='{}' WHERE binding_id=? AND observation_kind='own_site'").bind(bindingId).run()).rejects.toThrow();
  const staff='staff-own-site',email='site-owner@example.test',access='access-own-site';
  await db.batch([db.prepare("INSERT INTO staff_users VALUES(?,?,?,'active')").bind(staff,email,access),db.prepare('INSERT INTO native_staff_profiles VALUES(?,?,1)').bind(staff,email),
   db.prepare('INSERT INTO native_staff_admissions VALUES(?,?,1,1)').bind(staff,access),db.prepare("INSERT INTO staff_role_assignments VALUES(?,'role-owner','global')").bind(staff),
   db.prepare("INSERT INTO owner_intel_read_grants VALUES('grant-own-site',?,?,'intel.owner.read','allow',1)").bind(staff,businessId)]);
  const principal:StaffPrincipal={id:staff,email,accessSubject:access,displayName:'Owner',projectAlphaUserId:null,accessExpiresAt:Math.floor(Date.now()/1000)+3600};
  const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();app.use('*',async(c,next)=>{c.set('principal',principal);c.set('administrator',false);await next();});registerOwnerIntelRoutes(app);
  const siteResponse=await app.request(`https://ops.example.test/api/intel/${routeKey}/website?range=7d`,{method:'GET'},{OPS_DB:db} as Env),view=await siteResponse.json() as any;
  expect(siteResponse.status).toBe(200);expect(view.schema).toBe('ops.intel.website-monitor.v1');expect(view.site.canonicalDomain).toBe('ltds.example');
  expect(view.technical.avgFetchMs).toBe(0);expect(view.technical.sitemapPageCount.value).toBeNull();expect(view.totals).toBeUndefined();
 });
});
