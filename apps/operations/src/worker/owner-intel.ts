import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Env, StaffPrincipal } from './types';
import { ownerCompetitorProjection, refreshOwnerIntel } from './owner-intel-model';
import { parseDuplicateFreeJson } from './bounded-json';
import { ownerIntelSourceProjectionStillCurrent,readOwnerIntelSourceProjection } from './owner-intel-source-ingest';
import { ownerGoogleAdsProjectionStillCurrent,ownerGoogleAdsReadState,readOwnerGoogleAdsProjection } from './owner-google-ads-ingest';

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

const asNumber=(value:string|null)=>value===null?null:Number(value);
const asFraction=(value:string|null)=>value===null?null:Number(value)/100;
function ownerSearchConsoleDto(source:NonNullable<Awaited<ReturnType<typeof readOwnerIntelSourceProjection>>>,range:'7d'|'28d'|'90d'){
 if(source.sourceKind!=='search_console_summary'||source.observation.observationKind!=='search_console_summary')throw unavailable('intel_projection_unavailable',503);
 const p=source.observation.payload,provenance=p.provenance;
 return {site:{url:p.siteUrl},range:{start:p.period.start,end:p.period.end},freshness:{fetchedAt:provenance.collectedAt,stale:provenance.partialReason==='source_stale'},
  totals:{clicks:p.totals.clicks,impressions:p.totals.impressions,ctr:asFraction(p.totals.ctrPercent),position:asNumber(p.totals.avgPosition)},previous:null,
  queries:p.topQueries.map(row=>({query:row.query,clicks:row.clicks,impressions:row.impressions,ctr:asFraction(row.ctrPercent),position:asNumber(row.avgPosition)})),
  pages:p.topPages.map(row=>({url:row.url,clicks:row.clicks,impressions:row.impressions,ctr:asFraction(row.ctrPercent),position:asNumber(row.avgPosition)})),
  daily:p.daily.map(row=>({date:row.date,clicks:row.clicks,impressions:row.impressions})),comparison:p.comparison,coverage:{state:p.totals.state,reason:p.totals.reason,lastDataDate:provenance.lastDataDate,
   dataRange:provenance.dataRange,partial:provenance.partial,partialReason:provenance.partialReason,limits:provenance.limits,asOf:provenance.asOf,rangeSelection:range},
  receipt:{operationId:source.operationId,payloadSha256:source.payloadSha256,completedAt:source.completedAt,acceptedAt:source.acceptedAt}};
}
function ownerWebsiteDto(source:NonNullable<Awaited<ReturnType<typeof readOwnerIntelSourceProjection>>>,range:'7d'|'28d'|'90d',now=Date.now()){
 if(source.sourceKind!=='own_site'||source.observation.observationKind!=='own_site')throw unavailable('intel_projection_unavailable',503);
 const p=source.observation.payload,provenance=p.provenance;
 const days=Number(range.slice(0,-1)),today=new Date(now).toISOString().slice(0,10),start=new Date(Date.parse(`${today}T00:00:00Z`)-(days-1)*86400000).toISOString().slice(0,10);
 const changes=p.changesSincePrevious.filter(change=>change.detectedAt.slice(0,10)>=start&&change.detectedAt.slice(0,10)<=today);
 // This endpoint reports the approved Hermes site monitor. It does not map
 // missing GA4 metrics to zeros or claim that a GA4 property is connected.
 return {schema:'ops.intel.website-monitor.v1',site:{canonicalDomain:p.canonicalDomain},range:{start,end:today},freshness:{fetchedAt:provenance.collectedAt,stale:provenance.partialReason==='source_stale'},
  monitoredPages:p.monitoredPages,changesSincePrevious:changes,technical:p.technical,
  provenance:{source:provenance.source,sourceAccountRef:provenance.sourceAccountRef,collectedBy:provenance.collectedBy,collectedAt:provenance.collectedAt,asOf:provenance.asOf,
   lastDataDate:provenance.lastDataDate,dataRange:provenance.dataRange,partial:provenance.partial,partialReason:provenance.partialReason,limits:provenance.limits},
  receipt:{operationId:source.operationId,payloadSha256:source.payloadSha256,completedAt:source.completedAt,acceptedAt:source.acceptedAt}};
}
function ownerGoogleAdsDto(source:NonNullable<Awaited<ReturnType<typeof readOwnerGoogleAdsProjection>>>,range:'7d'|'28d'|'90d'){
 if(source.observation.observationKind!=='google_ads_summary'||source.observation.semantics.observation!=='ci.google_ads_owner.v1')throw unavailable('intel_projection_unavailable',503);
 const p=source.observation.payload;
 return {schema:'ops.intel.owner-google-ads.v1',rangeSelection:range,
  period:p.period?{start:p.period.start,end:p.period.end,days:p.period.days,timeZone:p.period.timeZone}:null,
  currencyCode:p.currencyCode,totals:{costMicros:p.totals.costMicros,impressions:p.totals.impressions,clicks:p.totals.clicks,conversions:p.totals.conversions,state:p.totals.state,reason:p.totals.reason},
  freshness:{collectedAt:p.provenance.collectedAt,asOf:p.provenance.asOf,state:p.totals.state},
  receipt:{operationId:source.operationId,payloadSha256:source.payloadSha256,completedAt:source.completedAt,acceptedAt:source.acceptedAt}};
}

export type OwnerIntelSummaryRange='7d'|'28d'|'90d';
export type OwnerIntelSummaryState='unavailable'|'unconfigured'|'stale'|'partial'|'available';
export type OwnerIntelSummarySourceId='google_ads'|'search_console'|'own_site'|'ga4';
export type OwnerIntelSummaryMetrics=
 |{currencyCode:string|null;costMicros:string|null;impressions:string|null;clicks:string|null;conversions:string|null}
 |{clicks:number|null;impressions:number|null;ctr:number|null;position:number|null}
 |{monitoredPages:number;changesSincePrevious:number};
export type OwnerIntelSummarySource={id:OwnerIntelSummarySourceId;businessId:string;range:OwnerIntelSummaryRange} & (
 |{state:'available'|'partial';reason:string|null;metrics:OwnerIntelSummaryMetrics|null}
 |{state:'unavailable'|'unconfigured'|'stale';reason:string;metrics:null});
export type OwnerIntelSummary={schema:'ops.intel.owner-summary.v1';business:{id:string;key:string;name:string};range:OwnerIntelSummaryRange;sources:OwnerIntelSummarySource[]};
type OwnerIntelSummaryEvidence={kind:'google_ads';source:NonNullable<Awaited<ReturnType<typeof readOwnerGoogleAdsProjection>>>}|{kind:'owner_source';source:NonNullable<Awaited<ReturnType<typeof readOwnerIntelSourceProjection>>>};
const ownerSourceTables=['owner_intel_source_control','owner_intel_source_bindings','owner_intel_source_inbox','owner_intel_source_epochs','owner_intel_source_subject_heads','owner_intel_source_kind_heads','owner_intel_source_range_heads','owner_intel_source_epoch_audit','owner_intel_source_projections','owner_intel_source_batch_guards'] as const;
function summarySource(id:OwnerIntelSummarySourceId,businessId:string,range:OwnerIntelSummaryRange,state:'available'|'partial',reason:string|null,metrics:OwnerIntelSummaryMetrics|null):OwnerIntelSummarySource;
function summarySource(id:OwnerIntelSummarySourceId,businessId:string,range:OwnerIntelSummaryRange,state:'unavailable'|'unconfigured'|'stale',reason:string,metrics:null):OwnerIntelSummarySource;
function summarySource(id:OwnerIntelSummarySourceId,businessId:string,range:OwnerIntelSummaryRange,state:OwnerIntelSummaryState,reason:string|null,metrics:OwnerIntelSummaryMetrics|null):OwnerIntelSummarySource{
 if(state==='unavailable'||state==='unconfigured'||state==='stale'){
  if(reason===null||metrics!==null)throw unavailable('intel_projection_unavailable',503);
  return {id,businessId,range,state,reason,metrics:null};
 }
 return {id,businessId,range,state,reason,metrics};
}
async function ownerIntelSummary(db:D1Database,selected:Business,range:OwnerIntelSummaryRange):Promise<{view:OwnerIntelSummary;evidence:OwnerIntelSummaryEvidence[]}>{
 const businessId=selected.businessId,evidence:OwnerIntelSummaryEvidence[]=[],sources:OwnerIntelSummarySource[]=[];
 if(!selected.bindingId||selected.configurationRevision===null){
  sources.push(summarySource('google_ads',businessId,range,'unconfigured','source_binding_not_configured',null));
  sources.push(summarySource('search_console',businessId,range,'unconfigured','source_binding_not_configured',null));
  sources.push(summarySource('own_site',businessId,range,'unconfigured','source_binding_not_configured',null));
 }else{
  const adsState=await ownerGoogleAdsReadState(db,selected.bindingId,selected.configurationRevision);
  if(adsState==='schema_missing')sources.push(summarySource('google_ads',businessId,range,'unavailable','source_schema_unavailable',null));
  else if(adsState==='disabled')sources.push(summarySource('google_ads',businessId,range,'unconfigured','source_disabled',null));
  else if(adsState==='binding_missing')sources.push(summarySource('google_ads',businessId,range,'unconfigured','source_binding_not_configured',null));
  else if(adsState==='manager_only')sources.push(summarySource('google_ads',businessId,range,'unconfigured','owner_advertiser_not_confirmed',null));
  else{
   const ads=await readOwnerGoogleAdsProjection(db,selected.bindingId,selected.configurationRevision,range);
   if(!ads){
    const count=await db.withSession('first-primary').prepare("SELECT COUNT(*) count FROM owner_intel_google_ads_projections WHERE binding_id=? AND configuration_revision=? AND subject_key='own:google-ads'")
     .bind(selected.bindingId,selected.configurationRevision).first<number>('count');
    sources.push(summarySource('google_ads',businessId,range,'unavailable',count&&count>0?'range_unavailable':'awaiting_first_data',null));
   }else{
    evidence.push({kind:'google_ads',source:ads});
    const totals=ads.observation.payload.totals;
    if(totals.state==='source_stale')sources.push(summarySource('google_ads',businessId,range,'stale','source_stale',null));
    else if(totals.state==='observed')sources.push(summarySource('google_ads',businessId,range,'available',null,{currencyCode:ads.observation.payload.currencyCode,costMicros:totals.costMicros,impressions:totals.impressions,clicks:totals.clicks,conversions:totals.conversions}));
    else if(totals.state==='no_account')sources.push(summarySource('google_ads',businessId,range,'unconfigured','no_account',null));
    else sources.push(summarySource('google_ads',businessId,range,'partial',totals.reason??totals.state,null));
   }
  }
  const tableCount=await db.withSession('first-primary').prepare(`SELECT COUNT(*) count FROM sqlite_schema WHERE type='table' AND name IN(${ownerSourceTables.map(()=>'?').join(',')})`).bind(...ownerSourceTables).first<number>('count');
  if(tableCount!==ownerSourceTables.length){
   sources.push(summarySource('search_console',businessId,range,'unavailable','source_schema_unavailable',null));
   sources.push(summarySource('own_site',businessId,range,'unavailable','source_schema_unavailable',null));
  }else{
   const control=await db.withSession('first-primary').prepare('SELECT enabled,storage_accepted FROM owner_intel_source_control WHERE singleton=1').first<{enabled:number;storage_accepted:number}>();
   if(!control||control.enabled!==1||control.storage_accepted!==1){
    sources.push(summarySource('search_console',businessId,range,'unconfigured','source_disabled',null));
    sources.push(summarySource('own_site',businessId,range,'unconfigured','source_disabled',null));
   }else{
    for(const [id,kind,days] of [['search_console','search_console_summary',Number(range.slice(0,-1))] as const,['own_site','own_site',null] as const]){
     const bindingRows=await db.withSession('first-primary').prepare('SELECT subject_key FROM owner_intel_source_bindings WHERE binding_id=? AND configuration_revision=? AND observation_kind=? AND active=1 LIMIT 2')
      .bind(selected.bindingId,selected.configurationRevision,kind).all<{subject_key:string}>();
     if(bindingRows.results.length>1)throw unavailable('intel_storage_unavailable',503);
     if(bindingRows.results.length===0){sources.push(summarySource(id,businessId,range,'unconfigured','source_binding_not_configured',null));continue;}
     const source=await readOwnerIntelSourceProjection(db,selected.bindingId,selected.configurationRevision,kind,days as 7|28|90|undefined);
     if(!source){
      const count=await db.withSession('first-primary').prepare('SELECT COUNT(*) count FROM owner_intel_source_projections WHERE binding_id=? AND configuration_revision=? AND observation_kind=?')
       .bind(selected.bindingId,selected.configurationRevision,kind).first<number>('count');
      sources.push(summarySource(id,businessId,range,'unavailable',count&&count>0?'range_unavailable':'awaiting_first_data',null));continue;
     }
     evidence.push({kind:'owner_source',source});
     const provenance=source.observation.payload.provenance;
     if(provenance.partialReason==='source_stale'){
      sources.push(summarySource(id,businessId,range,'stale','source_stale',null));continue;
     }
     if(source.observation.observationKind==='search_console_summary'){
      const payload=source.observation.payload;
      if(payload.totals.reason==='source_stale')sources.push(summarySource(id,businessId,range,'stale','source_stale',null));
      else if(payload.totals.state==='not_connected')sources.push(summarySource(id,businessId,range,'unconfigured',payload.totals.reason??'not_connected',null));
      else{
       const partial=provenance.partial||payload.totals.state!=='observed';
       sources.push(summarySource(id,businessId,range,partial?'partial':'available',partial?(provenance.partialReason??payload.totals.reason??'incomplete_source_data'):null,
        {clicks:payload.totals.clicks,impressions:payload.totals.impressions,ctr:asFraction(payload.totals.ctrPercent),position:asNumber(payload.totals.avgPosition)}));
      }
     }else{
      const view=ownerWebsiteDto(source,range);
      sources.push(summarySource(id,businessId,range,provenance.partial?'partial':'available',provenance.partial?(provenance.partialReason??'incomplete_source_data'):null,
       {monitoredPages:view.monitoredPages.length,changesSincePrevious:view.changesSincePrevious.length}));
     }
    }
   }
  }
 }
 // This lane has no accepted owner binding/read model. Never substitute a
 // managed-client account or an MCA total for the internal owner business.
 sources.push(summarySource('ga4',businessId,range,'unconfigured','ga4_not_connected',null));
 return {view:{schema:'ops.intel.owner-summary.v1',business:{id:businessId,key:selected.key,name:selected.name},range,sources},evidence};
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
  if(!['competitors','website','search-console','google-ads','summary'].includes(section))throw unavailable('intel_section_not_found');
  const query=new URL(c.req.url).searchParams;
  if(section==='competitors'?query.size!==0:[...query.keys()].some(k=>k!=='range')||query.getAll('range').length!==1||!['7d','28d','90d'].includes(query.get('range')??''))
   throw new HTTPException(400,{message:'intel_query_invalid'});
  const selected=await business(c.env.OPS_DB,key,principal.id);
  if(!selected)throw unavailable('intel_business_not_found');
  if(section==='summary'){
   const result=await ownerIntelSummary(c.env.OPS_DB,selected,query.get('range') as OwnerIntelSummaryRange);
   await stillCurrent(c.env.OPS_DB,principal,authority,selected.businessId);
   const current=await business(c.env.OPS_DB,key,principal.id);
   if(!current||JSON.stringify(current)!==JSON.stringify(selected))throw unavailable('intel_binding_changed',503);
   for(const item of result.evidence){
    const currentEvidence=item.kind==='google_ads'
     ?await ownerGoogleAdsProjectionStillCurrent(c.env.OPS_DB,item.source)
     :await ownerIntelSourceProjectionStillCurrent(c.env.OPS_DB,item.source);
    if(!currentEvidence)throw unavailable('intel_binding_changed',503);
   }
   await stillCurrent(c.env.OPS_DB,principal,authority,selected.businessId);
   return c.json(result.view);
  }
  if(section!=='competitors'){
   await stillCurrent(c.env.OPS_DB,principal,authority,selected.businessId);
   if(section==='google-ads'){
    const state=await ownerGoogleAdsReadState(c.env.OPS_DB,selected.bindingId??'',selected.configurationRevision??0);
    if(state==='schema_missing')throw unavailable('intel_google_ads_not_configured');
    if(state==='disabled'||state==='binding_missing')throw unavailable('intel_google_ads_not_connected');
    if(state==='manager_only')throw unavailable('intel_google_ads_manager_only');
    const requestedRange=query.get('range') as '7d'|'28d'|'90d';
    const source=await readOwnerGoogleAdsProjection(c.env.OPS_DB,selected.bindingId!,selected.configurationRevision!,requestedRange);
    if(!source){
     const prior=await c.env.OPS_DB.withSession('first-primary').prepare('SELECT COUNT(*) count FROM owner_intel_google_ads_projections WHERE binding_id=? AND configuration_revision=? AND subject_key=\'own:google-ads\'')
      .bind(selected.bindingId,selected.configurationRevision).first<number>('count');
     throw unavailable(prior&&prior>0?'intel_google_ads_range_unavailable':'intel_google_ads_awaiting_first_data');
    }
    const view=ownerGoogleAdsDto(source,requestedRange);
    await stillCurrent(c.env.OPS_DB,principal,authority,selected.businessId);
    const current=await business(c.env.OPS_DB,key,principal.id);
    if(!current||JSON.stringify(current)!==JSON.stringify(selected))throw unavailable('intel_binding_changed',503);
    if(!await ownerGoogleAdsProjectionStillCurrent(c.env.OPS_DB,source))throw unavailable('intel_binding_changed',503);
    return c.json(view);
   }
   if(!selected.bindingId||selected.configurationRevision===null)throw unavailable('intel_monitoring_not_configured');
   let sourceControl:{enabled:number;storage_accepted:number}|null;
   try{sourceControl=await c.env.OPS_DB.withSession('first-primary').prepare('SELECT enabled,storage_accepted FROM owner_intel_source_control WHERE singleton=1').first<{enabled:number;storage_accepted:number}>();}
   catch{throw unavailable(section==='website'?'intel_website_not_connected':'intel_search_console_not_connected');}
   if(!sourceControl||sourceControl.enabled!==1||sourceControl.storage_accepted!==1)
    throw unavailable(section==='website'?'intel_website_not_connected':'intel_search_console_not_connected');
   const kind=section==='website'?'own_site':'search_console_summary';
   const requestedRange=query.get('range') as '7d'|'28d'|'90d',days=Number(requestedRange.slice(0,-1)) as 7|28|90;
   const source=await readOwnerIntelSourceProjection(c.env.OPS_DB,selected.bindingId,selected.configurationRevision,kind,section==='website'?undefined:days);
   if(!source){
    const any=await c.env.OPS_DB.withSession('first-primary').prepare('SELECT COUNT(*) count FROM owner_intel_source_projections WHERE binding_id=? AND configuration_revision=? AND observation_kind=?')
     .bind(selected.bindingId,selected.configurationRevision,kind).first<number>('count');
    throw unavailable(any&&any>0?'intel_range_unavailable':'intel_awaiting_first_data');
   }
   const view=section==='website'?ownerWebsiteDto(source,query.get('range') as '7d'|'28d'|'90d'):ownerSearchConsoleDto(source,query.get('range') as '7d'|'28d'|'90d');
   await stillCurrent(c.env.OPS_DB,principal,authority,selected.businessId);
   const current=await business(c.env.OPS_DB,key,principal.id);
   if(!current||JSON.stringify(current)!==JSON.stringify(selected))throw unavailable('intel_binding_changed',503);
   if(!await ownerIntelSourceProjectionStillCurrent(c.env.OPS_DB,source))throw unavailable('intel_binding_changed',503);
   return c.json(view);
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
