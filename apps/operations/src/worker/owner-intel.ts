import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Env, StaffPrincipal } from './types';
import { ownerCompetitorProjection, refreshOwnerIntel } from './owner-intel-model';
import { parseDuplicateFreeJson } from './bounded-json';

type Bindings={Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}};
const CONTRACT='a60a11ddd68df90da80a1e2eaf298434369653d8e8f390b814ed906e7b675b32';
const tables=['owner_intel_control','owner_intel_businesses','owner_intel_business_aliases','owner_intel_read_grants','owner_intel_bindings','owner_intel_competitor_projections'];
const triggers=['owner_intel_alias_identity','owner_intel_alias_retained','owner_intel_binding_identity','owner_intel_projection_immutable','owner_intel_projection_retained'];
type Authority={profileVersion:number;admissionVersion:number};
type Business={key:string;name:string;businessId:string;version:number;bindingId:string|null;configurationRevision:number|null;bindingStatus:string|null};
const readable=`EXISTS(SELECT 1 FROM owner_intel_read_grants g WHERE g.staff_id=? AND g.business_id=b.business_id AND g.permission_key='intel.owner.read' AND g.effect='allow' AND g.active=1)
 AND NOT EXISTS(SELECT 1 FROM owner_intel_read_grants d WHERE d.staff_id=? AND d.business_id=b.business_id AND d.permission_key='intel.owner.read' AND d.effect='deny' AND d.active=1)`;
const unavailable=(code:string,status:404|503=404)=>new HTTPException(status,{message:code});

/** Whole-business intelligence cannot honor a division-scoped denial. A
 * global owner role is mandatory; a generic administrator is insufficient. */
export async function ownerIntelAuthority(db:D1Database,principal:StaffPrincipal,now=Date.now(),businessId:string|null=null):Promise<Authority|null>{
 if(!principal.accessExpiresAt||!Number.isSafeInteger(principal.accessExpiresAt)||principal.accessExpiresAt<=Math.floor(now/1000))return null;
 const row=await db.withSession('first-primary').prepare(`SELECT p.version profileVersion,a.version admissionVersion
 FROM staff_users s JOIN native_staff_profiles p ON p.staff_id=s.id AND p.login_email=s.email COLLATE BINARY
 JOIN native_staff_admissions a ON a.staff_id=s.id AND a.active=1 AND a.bound_access_subject=s.access_subject
 WHERE s.id=? AND s.access_subject=? AND s.email=? COLLATE BINARY AND s.status='active'
 AND EXISTS(SELECT 1 FROM staff_role_assignments r WHERE r.staff_id=s.id AND r.scope='global' AND r.role_id='role-owner')
 AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides d WHERE d.staff_id=s.id AND d.permission_key IN('administration.view','intel.owner.read') AND d.effect='deny')
 AND EXISTS(SELECT 1 FROM owner_intel_businesses b WHERE b.status='reviewed' AND (? IS NULL OR b.business_id=?) AND ${readable})
 LIMIT 1`).bind(principal.id,principal.accessSubject,principal.email,businessId,businessId,principal.id,principal.id).first<Authority>();
 return row&&Number.isSafeInteger(row.profileVersion)&&row.profileVersion>=1&&Number.isSafeInteger(row.admissionVersion)&&row.admissionVersion>=1?row:null;
}

async function configured(db:D1Database):Promise<boolean>{
 const inventory=await db.withSession('first-primary').prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${tables.map(()=>'?').join(',')})`).bind(...tables).all<{name:string}>();
 if(inventory.results.length===0)return false;
 if(inventory.results.length!==tables.length)throw unavailable('intel_storage_unavailable',503);
 const guards=await db.withSession('first-primary').prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (${triggers.map(()=>'?').join(',')})`).bind(...triggers).all<{name:string}>();
 if(guards.results.length!==triggers.length)throw unavailable('intel_storage_unavailable',503);
 const row=await db.withSession('first-primary').prepare('SELECT schema_version,enabled,storage_accepted FROM owner_intel_control WHERE singleton=1').first<{schema_version:number;enabled:number;storage_accepted:number}>();
 if(!row||row.schema_version!==1||![0,1].includes(row.enabled)||![0,1].includes(row.storage_accepted)||row.enabled===1&&row.storage_accepted!==1)throw unavailable('intel_storage_unavailable',503);
 return row.enabled===1&&row.storage_accepted===1;
}

export async function ownerIntelCapability(env:Pick<Env,'OPS_DB'>,principal:StaffPrincipal):Promise<boolean>{
 try{return await configured(env.OPS_DB)&&await ownerIntelAuthority(env.OPS_DB,principal)!==null;}
 catch{return false;}
}

async function business(db:D1Database,key:string,staffId:string):Promise<Business|null>{
 if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key))return null;
 const row=await db.withSession('first-primary').prepare(`SELECT x.route_key key,b.display_name name,b.business_id businessId,b.version,
 m.binding_id bindingId,m.configuration_revision configurationRevision,m.status bindingStatus
 FROM owner_intel_business_aliases x JOIN owner_intel_businesses b ON b.business_id=x.business_id
 LEFT JOIN owner_intel_bindings m ON m.business_id=b.business_id AND m.status IN('reviewed','paused')
 WHERE x.route_key=? AND x.status='active' AND b.status='reviewed' AND ${readable}`).bind(key,staffId,staffId).first<Business>();
 if(row&&(!validCatalogEntry(row)||!Number.isSafeInteger(row.version)||row.version<1||typeof row.businessId!=='string'||!row.businessId
  ||row.bindingId!==null&&(typeof row.bindingId!=='string'||!row.bindingId||!Number.isSafeInteger(row.configurationRevision)||Number(row.configurationRevision)<1)))throw unavailable('intel_storage_unavailable',503);
 return row;
}
function validCatalogEntry(value:{key:string;name:string}){
 return typeof value.key==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.key)&&typeof value.name==='string'
  &&value.name.trim().length>0&&value.name.length<=200&&!/[\p{C}]/u.test(value.name);
}

async function stillCurrent(db:D1Database,principal:StaffPrincipal,expected:Authority,businessId:string|null=null){
 const current=await ownerIntelAuthority(db,principal,Date.now(),businessId);
 if(!current||current.profileVersion!==expected.profileVersion||current.admissionVersion!==expected.admissionVersion)
  throw new HTTPException(403,{message:'intel_owner_required'});
 if(!await configured(db))throw unavailable('intel_not_configured');
}

/** Registered only after ordinary human Access authentication. No producer,
 * portal, PA, public-link or service credential is accepted here. */
export function registerOwnerIntelRoutes(app:Hono<Bindings>){
 const routes=new Hono<Bindings>();
 routes.onError((error,c)=>error instanceof HTTPException?c.json({error:error.message},error.status):c.json({error:'intel_storage_unavailable'},503));
 routes.use('*',async(c,next)=>{
  c.header('Cache-Control','private, no-store');c.header('Pragma','no-cache');
  try {
   if(!await configured(c.env.OPS_DB))throw unavailable('intel_not_configured');
   const authority=await ownerIntelAuthority(c.env.OPS_DB,c.get('principal'));
   if(!authority)throw new HTTPException(403,{message:'intel_owner_required'});
   await next();
  }catch(error){
   if(error instanceof HTTPException)return c.json({error:error.message},error.status);
   return c.json({error:'intel_storage_unavailable'},503);
  }
 });
 routes.get('/businesses',async c=>{
  if(new URL(c.req.url).search)throw new HTTPException(400,{message:'intel_query_invalid'});
  const principal=c.get('principal'),authority=await ownerIntelAuthority(c.env.OPS_DB,principal);
  if(!authority)throw new HTTPException(403,{message:'intel_owner_required'});
  const rows=await c.env.OPS_DB.withSession('first-primary').prepare(`SELECT x.route_key key,b.display_name name FROM owner_intel_business_aliases x
   JOIN owner_intel_businesses b ON b.business_id=x.business_id WHERE x.status='active' AND b.status='reviewed' AND ${readable} ORDER BY x.route_key LIMIT 51`).bind(principal.id,principal.id).all<{key:string;name:string}>();
  if(rows.results.length>50||!rows.results.every(validCatalogEntry))throw unavailable('intel_storage_unavailable',503);
  await stillCurrent(c.env.OPS_DB,principal,authority);
  // A grant may have changed while the catalog was being evaluated, even if
  // another business remains permitted. Re-read that exact permitted list.
  const current=await c.env.OPS_DB.withSession('first-primary').prepare(`SELECT x.route_key key,b.display_name name FROM owner_intel_business_aliases x
   JOIN owner_intel_businesses b ON b.business_id=x.business_id WHERE x.status='active' AND b.status='reviewed' AND ${readable} ORDER BY x.route_key LIMIT 51`).bind(principal.id,principal.id).all<{key:string;name:string}>();
  if(JSON.stringify(current.results)!==JSON.stringify(rows.results))throw unavailable('intel_catalog_changed',503);
  await stillCurrent(c.env.OPS_DB,principal,authority);
  return c.json({businesses:rows.results});
 });
 routes.get('/:key/:section',async c=>{
  const principal=c.get('principal'),authority=await ownerIntelAuthority(c.env.OPS_DB,principal);
  if(!authority)throw new HTTPException(403,{message:'intel_owner_required'});
  const key=c.req.param('key'),section=c.req.param('section');
  if(!['competitors','website','search-console'].includes(section))throw unavailable('intel_section_not_found');
  const query=new URL(c.req.url).searchParams;
  if(section==='competitors'?query.size!==0:[...query.keys()].some(k=>k!=='range')||query.getAll('range').length!==1||!['7d','28d','90d'].includes(query.get('range')??''))
   throw new HTTPException(400,{message:'intel_query_invalid'});
  const selected=await business(c.env.OPS_DB,key,principal.id);
  if(!selected)throw unavailable('intel_business_not_found');
  if(section!=='competitors'){
   await stillCurrent(c.env.OPS_DB,principal,authority,selected.businessId);
   throw unavailable(section==='website'?'intel_website_not_connected':'intel_search_console_not_connected');
  }
  if(!selected.bindingId||selected.configurationRevision===null)throw unavailable('intel_monitoring_not_configured');
  const row=await c.env.OPS_DB.withSession('first-primary').prepare(`SELECT projection_id id,revision,dto_json dto,dto_sha256 digest,source_contract_sha256 contract,read_schema schema
   FROM owner_intel_competitor_projections WHERE binding_id=? AND configuration_revision=? ORDER BY revision DESC LIMIT 1`)
   .bind(selected.bindingId,selected.configurationRevision).first<{id:string;revision:number;dto:string;digest:string;contract:string;schema:string}>();
  if(!row)throw unavailable('intel_awaiting_first_data');
  if(row.contract!==CONTRACT||row.schema!=='ops.intel.competitors.v1'||typeof row.dto!=='string'||new TextEncoder().encode(row.dto).length>262144)
   throw unavailable('intel_projection_unavailable',503);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(row.dto))),n=>n.toString(16).padStart(2,'0')).join('');
  if(hash!==row.digest)throw unavailable('intel_projection_unavailable',503);
  let stored:unknown;
  try{stored=parseDuplicateFreeJson(row.dto);}catch{throw unavailable('intel_projection_unavailable',503);}
  const parsed=ownerCompetitorProjection.safeParse(stored);
  if(!parsed.success||parsed.data.tenantKey!==key||parsed.data.tenantName!==selected.name)throw unavailable('intel_projection_unavailable',503);
  const view=refreshOwnerIntel({...parsed.data,monitoring:selected.bindingStatus==='paused'?'paused':parsed.data.monitoring});
  await stillCurrent(c.env.OPS_DB,principal,authority,selected.businessId);
  const current=await business(c.env.OPS_DB,key,principal.id);
  if(!current||JSON.stringify(current)!==JSON.stringify(selected))throw unavailable('intel_binding_changed',503);
  const head=await c.env.OPS_DB.withSession('first-primary').prepare(`SELECT projection_id FROM owner_intel_competitor_projections
   WHERE binding_id=? AND configuration_revision=? ORDER BY revision DESC LIMIT 1`).bind(selected.bindingId,selected.configurationRevision).first<string>('projection_id');
  if(head!==row.id)throw unavailable('intel_projection_changed',503);
  // Final identity/config recheck follows all data awaits.
  await stillCurrent(c.env.OPS_DB,principal,authority,selected.businessId);
  return c.json(view);
 });
 app.route('/api/intel',routes);
}
