import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { ownerIntelAuthority,ownerIntelCapability,registerOwnerIntelRoutes } from '../src/worker/owner-intel';
import { ownerCompetitorProjection } from '../src/worker/owner-intel-model';
import type { Env,StaffPrincipal } from '../src/worker/types';

const CONTRACT='a60a11ddd68df90da80a1e2eaf298434369653d8e8f390b814ed906e7b675b32';
const baseline=`CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,access_subject TEXT,status TEXT);
 CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,login_email TEXT,version INTEGER);
 CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER,version INTEGER);
 CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT);
 CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT);`;
type TestBindings={Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}};
let runtime:Miniflare,db:D1Database,legacy:D1Database,serial=0;
const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),n=>n.toString(16).padStart(2,'0')).join('');

async function seed(options:{grant?:boolean;role?:string;binding?:boolean}={}){
 const n=++serial,key=`business-${n}`,id=`staff:${n}`,business=`internal:${n}`,binding=`binding:${n}`;
 const principal:StaffPrincipal={id,email:`owner${n}@example.test`,accessSubject:`access:${n}`,displayName:'Synthetic Owner',projectAlphaUserId:null,accessExpiresAt:Math.floor(Date.now()/1000)+3600};
 await db.batch([
  db.prepare("INSERT INTO staff_users VALUES(?,?,?,'active')").bind(id,principal.email,principal.accessSubject),
  db.prepare('INSERT INTO native_staff_profiles VALUES(?,?,1)').bind(id,principal.email),
  db.prepare('INSERT INTO native_staff_admissions VALUES(?,?,1,1)').bind(id,principal.accessSubject),
  db.prepare("INSERT INTO staff_role_assignments VALUES(?,?,'global')").bind(id,options.role??'role-owner'),
  db.prepare("INSERT INTO owner_intel_businesses VALUES(?, 'Synthetic Business',1,'reviewed')").bind(business),
  db.prepare("INSERT INTO owner_intel_business_aliases VALUES(?,?,'active')").bind(key,business),
 ]);
 if(options.grant!==false)await db.prepare("INSERT INTO owner_intel_read_grants VALUES(?,?,?,'intel.owner.read','allow',1)").bind(`grant:${n}`,id,business).run();
 if(options.binding!==false)await db.prepare("INSERT INTO owner_intel_bindings VALUES(?,?,1,'reviewed')").bind(binding,business).run();
 const request=(path:string,method='GET',database=db)=>{
  const app=new Hono<TestBindings>();
  // Production index registers these routes AFTER authenticateStaff. This
  // isolated fixture supplies that already-verified human principal only.
  app.use('*',async(c,next)=>{c.set('principal',principal);c.set('administrator',true);await next();});
  registerOwnerIntelRoutes(app);
  return app.request(`https://ops.example.test/api/intel${path}`,{method},{OPS_DB:database} as Env);
 };
 return {key,id,business,binding,principal,request};
}
function projection(key:string){
 return {tenantKey:key,tenantName:'Synthetic Business',monitoring:'active',latestScan:null,
  competitors:[{operationId:'10000000-0000-4000-8000-000000000001',payloadSha256:'A'.repeat(43),subjectKey:'comp:synthetic',name:'Synthetic Competitor',canonicalDomain:'example.test',verifiedHomeUrl:null,
   homepageStatus:{url:'https://example.test/',title:null,observedAt:'2026-01-01T00:00:00Z',fetchStatus:'not_checked'},monitoringSince:'2026-01-01T00:00:00Z',lastSuccessfulCheckAt:'2026-01-01T00:00:00Z',freshness:'current',sitePageCount:{value:null,state:'unknown',reason:'not_checked'},monitoredPageCount:0,active:true,baseline:null,adActivity:null}],
  changes:[],ownAds:null,selfAssessment:null,manifest:null,intents:[],providerAccountRef:null,scopeKey:null};
}
async function accept(f:Awaited<ReturnType<typeof seed>>,value:unknown=projection(f.key),digest?:string){
 const dto=JSON.stringify(value);
 await db.prepare("INSERT INTO owner_intel_competitor_projections VALUES(?,?,1,1,?,'ops.intel.competitors.v1',?,?,?)")
  .bind(crypto.randomUUID(),f.binding,CONTRACT,dto,digest??await hash(dto),new Date().toISOString()).run();
}

describe('owner Intel: explicit internal-business read authority and durable adapter',()=>{
 beforeAll(async()=>{
  runtime=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:'export default {fetch(){return new Response("ok")}}',d1Databases:['OPS_DB','LEGACY_DB']});
  db=await runtime.getD1Database('OPS_DB') as D1Database;legacy=await runtime.getD1Database('LEGACY_DB') as D1Database;
  for(const database of [db,legacy])await database.batch(splitD1MigrationStatements(baseline).map(s=>database.prepare(s)));
  const migration=readFileSync(new URL('../migrations/0227_owner_intel_reads.sql',import.meta.url),'utf8');
  await db.batch(splitD1MigrationStatements(migration).map(s=>db.prepare(s)));
 },180_000);
 afterAll(async()=>runtime?.dispose());
 beforeEach(async()=>{await db.prepare('UPDATE owner_intel_control SET enabled=1,storage_accepted=1').run();});

 it('defaults off without installing businesses, bindings, grants or data',async()=>{
  // Check the migration itself, then explicitly exercise the off state.
  const sql=readFileSync(new URL('../migrations/0227_owner_intel_reads.sql',import.meta.url),'utf8');
  expect(sql).toContain('enabled INTEGER NOT NULL DEFAULT 0');expect(sql).not.toMatch(/INSERT INTO owner_intel_(?:businesses|read_grants|bindings|competitor_projections)/);
  const f=await seed();await db.prepare('UPDATE owner_intel_control SET enabled=0,storage_accepted=0').run();
  expect(await ownerIntelCapability({OPS_DB:db},f.principal)).toBe(false);
  const result=await f.request('/businesses');expect(result.status).toBe(404);expect(await result.json()).toEqual({error:'intel_not_configured'});
 });
 it('preserves primary-only deployments with absent Intel schema',async()=>{
  const f=await seed();expect(await ownerIntelCapability({OPS_DB:legacy},f.principal)).toBe(false);
  expect((await f.request('/businesses','GET',legacy)).status).toBe(404);
 });
 it.each([{role:'role-admin',grant:true},{role:'role-owner',grant:false}])('rejects roles without both owner and explicit permission: %j',async options=>{
  const f=await seed(options);expect(await ownerIntelCapability({OPS_DB:db},f.principal)).toBe(false);
  const result=await f.request('/businesses');expect(result.status).toBe(403);expect(result.headers.get('cache-control')).toBe('private, no-store');
 });
 it('returns only exact permitted business aliases, never other owners businesses',async()=>{
  const f=await seed(),other=await seed();expect(await ownerIntelCapability({OPS_DB:db},f.principal)).toBe(true);
  expect(await (await f.request('/businesses')).json()).toEqual({businesses:[{key:f.key,name:'Synthetic Business'}]});
  expect((await f.request(`/${other.key}/competitors`)).status).toBe(404);
  expect((await f.request('/unknown/competitors')).status).toBe(404);
 });
 it('denies an exact explicit Intel deny even alongside allow',async()=>{
  const f=await seed();await db.prepare("INSERT INTO owner_intel_read_grants VALUES(?,?,?,'intel.owner.read','deny',1)").bind(crypto.randomUUID(),f.id,f.business).run();
  expect(await ownerIntelAuthority(db,f.principal)).toBeNull();expect((await f.request('/businesses')).status).toBe(403);
 });
 it.each(['global','division','assigned'])('honors administration deny at %s scope',async scope=>{
  const f=await seed();await db.prepare("INSERT INTO staff_permission_overrides VALUES(?,'administration.view','deny',?)").bind(f.id,scope).run();
  expect((await f.request('/businesses')).status).toBe(403);
 });
 it('requires current active native admission, canonical identity and unexpired JWT',async()=>{
  const f=await seed();expect(await ownerIntelAuthority(db,{...f.principal,accessExpiresAt:1})).toBeNull();
  expect(await ownerIntelAuthority(db,{...f.principal,accessSubject:'other-subject'})).toBeNull();
  await db.prepare('UPDATE native_staff_admissions SET active=0 WHERE staff_id=?').bind(f.id).run();
  expect((await f.request('/businesses')).status).toBe(403);
 });
 it('distinguishes missing monitoring, awaiting first data and unsupported source without fake zeros',async()=>{
  const absent=await seed({binding:false}),pending=await seed();
  expect(await (await absent.request(`/${absent.key}/competitors`)).json()).toEqual({error:'intel_monitoring_not_configured'});
  expect(await (await pending.request(`/${pending.key}/competitors`)).json()).toEqual({error:'intel_awaiting_first_data'});
  for(const [section,error] of [['website','intel_website_not_connected'],['search-console','intel_search_console_not_connected']]){
   const result=await pending.request(`/${pending.key}/${section}?range=28d`);expect(result.status).toBe(404);expect(await result.json()).toEqual({error});
  }
 });
 it('reads accepted exact-binding DTOs, recalculates freshness and retains immutable evidence',async()=>{
  const f=await seed();await accept(f);const response=await f.request(`/${f.key}/competitors`);
  expect(response.status).toBe(200);const value=await response.json() as {competitors:Array<{freshness:string}>};
  expect(value.competitors[0]!.freshness).toBe('stale');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect((await db.prepare('SELECT dto_json FROM owner_intel_competitor_projections WHERE binding_id=?').bind(f.binding).first<string>('dto_json'))).toContain('"freshness":"current"');
 });
 it('rejects corrupted hashes, cross-business DTOs and malformed data',async()=>{
  const corrupt=await seed(),cross=await seed(),malformed=await seed();
  await accept(corrupt,projection(corrupt.key),'0'.repeat(64));await accept(cross,projection('another-business'));
  await accept(malformed,{...projection(malformed.key),unreviewedSecret:'must not escape'});
  for(const f of [corrupt,cross,malformed]){const response=await f.request(`/${f.key}/competitors`);expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'intel_projection_unavailable'});}
 });
 it('has no command/ingest activation surface and accepts only defined GET query shapes',async()=>{
  const f=await seed();for(const path of [`/${f.key}/competitors?extra=1`,`/${f.key}/website?range=1d`,`/${f.key}/website?range=7d&range=28d`,'/businesses?extra=1'])expect((await f.request(path)).status).toBe(400);
  expect((await f.request(`/${f.key}/competitors/commands`,'POST')).status).toBe(404);
  expect((await f.request('/ingest/v1/observations','POST')).status).toBe(404);
 });
 it('rechecks the exact business permission after the projection hashing await',async()=>{
  const f=await seed(),other=await seed();await accept(f);
  await db.prepare("INSERT INTO owner_intel_read_grants VALUES(?,?,?,'intel.owner.read','allow',1)").bind(crypto.randomUUID(),f.id,other.business).run();
  const original=crypto.subtle.digest.bind(crypto.subtle);
  const spy=vi.spyOn(crypto.subtle,'digest').mockImplementationOnce(async(...args)=>{
   await db.prepare("UPDATE owner_intel_read_grants SET active=0 WHERE staff_id=? AND business_id=? AND effect='allow'").bind(f.id,f.business).run();
   return original(...args);
  });
  try{expect((await f.request(`/${f.key}/competitors`)).status).toBe(403);}
  finally{spy.mockRestore();}
 });
 it('retains aliases and projection history and does not allow reassignment',async()=>{
  const f=await seed(),other=await seed();await accept(f);
  await expect(db.prepare('UPDATE owner_intel_business_aliases SET business_id=? WHERE route_key=?').bind(other.business,f.key).run()).rejects.toThrow();
  await expect(db.prepare('DELETE FROM owner_intel_competitor_projections WHERE binding_id=?').bind(f.binding).run()).rejects.toThrow();
  await expect(db.prepare("UPDATE owner_intel_competitor_projections SET dto_json='{}' WHERE binding_id=?").bind(f.binding).run()).rejects.toThrow();
 });
 it('does not accept Ads/provider/publication facts or impossible evidence state as a projection',()=>{
  const value=projection('synthetic');expect(ownerCompetitorProjection.safeParse(value).success).toBe(true);
  expect(ownerCompetitorProjection.safeParse({...value,ownAds:{spend:0}}).success).toBe(false);
  value.competitors[0]!.sitePageCount={value:null,state:'observed',reason:'not_checked'};
  expect(ownerCompetitorProjection.safeParse(value).success).toBe(false);
 });
});
