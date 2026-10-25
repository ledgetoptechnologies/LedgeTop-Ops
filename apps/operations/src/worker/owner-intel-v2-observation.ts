import { z } from 'zod';
import { IntelIngestError,int63,strictIntelJson,text,timestamp } from './competitor-intel-ingest-schema';

// Preparation only: nothing imports this module from the deployed ingest path.
export const OWNER_INTEL_V2_DRAFT_SHA='ff354e29fbb8e751317db502e18b3654af42f24652a30e67eb61bb60cde0e567';
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimal=z.string().regex(/^-?\d{1,15}(\.\d{1,6})?$/);
const nonnegative=decimal.refine(v=>Number(v)>=0);
const percent=nonnegative.refine(v=>Number(v)<=100);
const position=decimal.refine(v=>Number(v)>=1);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v);
const state=z.enum(['observed','none_found','unknown','blocked','failed','not_connected']);
const reason=z.enum(['not_configured','not_checked','robots_blocked','bot_challenge','fetch_timeout','http_error','parked','redirected_offsite','too_little_content','insufficient_ad_copy','page_unreadable','no_ads_account','provider_error','provider_metrics_failed','too_old','legacy_semantics','ssrf_blocked','consent_missing','no_property_selected','provider_data_delay','no_account','data_limited','source_stale']);
const url=text(2048).refine(v=>{try{const u=new URL(v);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!/[\s\p{C}]/u.test(v);}catch{return false;}});
const sourceRef=z.object({url,title:text().nullable(),observedAt:timestamp,fetchStatus:z.enum(['ok','parked','redirect','blocked','error','not_checked'])}).strict();
const stated=<T extends z.ZodType>(value:T)=>z.object({value:value.nullable(),state,reason:reason.nullable()}).strict().refine((v:{value?:unknown;state:string;reason:unknown})=>v.state==='observed'?v.value!==null&&v.value!==undefined&&v.reason===null:v.value===null&&(v.state==='none_found'?v.reason===null:v.reason!==null));
const range=z.object({start:date,end:date}).strict().refine(v=>v.start<=v.end);
const period=z.object({start:date,end:date,days:count.min(1).max(93)}).strict().refine(v=>v.start<=v.end&&v.days===(Date.parse(v.end)-Date.parse(v.start))/86400000+1);
const provenance=z.object({source:z.enum(['google_search_console','google_analytics_4','hermes_site_monitor','public_web']),sourceAccountRef:text(120).min(1).nullable(),collectedBy:text(64).min(1),collectedAt:timestamp,asOf:timestamp.nullable(),lastDataDate:date.nullable(),dataRange:range.nullable(),partial:z.boolean(),partialReason:reason.nullable(),limits:z.array(text()).max(5)}).strict().refine(v=>(v.partial===(v.partialReason!==null))&&(v.asOf===null||v.asOf<=v.collectedAt)&&(v.lastDataDate===null||v.dataRange===null||v.lastDataDate<=v.dataRange.end));
const gscMetrics={clicks:count,impressions:count,ctrPercent:percent.nullable(),avgPosition:position.nullable()};
const totals=z.object({clicks:count.nullable(),impressions:count.nullable(),ctrPercent:percent.nullable(),avgPosition:position.nullable(),state,reason:reason.nullable()}).strict().refine(v=>v.state==='observed'?v.clicks!==null&&v.impressions!==null&&v.reason===null:[v.clicks,v.impressions,v.ctrPercent,v.avgPosition].every(x=>x===null)&&(v.state==='none_found'?v.reason===null:v.reason!==null));
const search=z.object({siteUrl:text(2048).min(1),period,totals,
 daily:z.array(z.object({date,clicks:count,impressions:count}).strict()).max(93),
 topQueries:z.array(z.object({query:text(),...gscMetrics}).strict()).max(25),
 topPages:z.array(z.object({url,...gscMetrics}).strict()).max(25),
 comparison:z.object({previousPeriod:period,clicksDeltaPercent:decimal.nullable(),impressionsDeltaPercent:decimal.nullable()}).strict().nullable(),provenance}).strict();
const gaMetrics={activeUsers:count.nullable(),newUsers:count.nullable(),sessions:count.nullable(),engagedSessions:count.nullable(),engagementRatePercent:percent.nullable(),avgEngagementSeconds:nonnegative.nullable(),keyEvents:nonnegative.nullable()};
const analytics=z.object({propertyRef:text(120).min(1).nullable(),propertyDisplayName:text().nullable(),
 providerLimits:z.object({thresholded:z.boolean().nullable(),sampled:z.boolean().nullable()}).strict(),period,
 totals:z.object({...gaMetrics,state,reason:reason.nullable()}).strict().refine(v=>{
  const metrics=[v.activeUsers,v.newUsers,v.sessions,v.engagedSessions,v.engagementRatePercent,v.avgEngagementSeconds,v.keyEvents];
  return v.state==='observed'?metrics.some(x=>x!==null)&&v.reason===null:metrics.every(x=>x===null)&&(v.state==='none_found'?v.reason===null:v.reason!==null);
 }),
 daily:z.array(z.object({date,activeUsers:count.nullable(),sessions:count.nullable()}).strict()).max(93),
 channels:z.array(z.object({channelGroup:text(60),sessions:count.nullable(),keyEvents:nonnegative.nullable()}).strict()).max(10),
 topLandingPages:z.array(z.object({path:text(500),sessions:count.nullable(),keyEvents:nonnegative.nullable()}).strict()).max(25),
 keyEventNames:z.array(text(100)).max(20),provenance}).strict();
const ownSite=z.object({canonicalDomain:text(253).min(1),monitoredPages:z.array(sourceRef.extend({contentSha256:z.string().regex(/^[A-Za-z0-9_-]{43}$/),contentLength:count}).strict()).max(25),
 changesSincePrevious:z.array(z.object({pageUrl:sourceRef,changeType:z.enum(['content_changed','redirect_external','website_parked','site_unavailable']),summary:text(1000,true),addedSentences:z.array(text(500,true)).max(20),removedSentences:z.array(text(500,true)).max(20),detectedAt:timestamp}).strict()).max(20),
 technical:z.object({httpsOk:stated(z.boolean()),sitemapPageCount:stated(count),robotsAllowsIndexing:stated(z.boolean()),avgFetchMs:count.nullable()}).strict(),provenance}).strict();
const social=z.object({ownerSubjectKey:z.string().regex(/^(?:comp|own):[A-Za-z0-9:_-]+$/).max(113),profiles:z.array(z.object({platform:z.enum(['facebook','instagram','linkedin','youtube','x','tiktok','other']),url,handle:text(100).nullable(),followers:stated(count),lastPublicPostDate:stated(date),profileFound:stated(z.boolean()),sourceUrl:sourceRef}).strict()).max(10),provenance}).strict();
const common={schemaVersion:z.literal('ci.observation.v1'),producerId:z.string().regex(/^[a-z0-9-]{3,64}$/),operationId:z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),monitoringBindingId:text(191).min(1),configurationRevision:count.min(1),subjectKey:z.string().regex(/^[A-Za-z0-9:_-]{3,120}$/),sourceSequence:z.object({epoch:int63,counter:int63}).strict(),commandBinding:z.null(),observedAt:timestamp,completedAt:timestamp,semantics:z.object({observation:z.literal('ci.obs.v2'),scoring:z.literal('concern_0_10.v1')}).strict()};
const observation=z.discriminatedUnion('observationKind',[
 z.object({...common,observationKind:z.literal('search_console_summary'),payload:search}).strict(),
 z.object({...common,observationKind:z.literal('ga4_summary'),payload:analytics}).strict(),
 z.object({...common,observationKind:z.literal('own_site'),payload:ownSite}).strict(),
 z.object({...common,observationKind:z.literal('social_presence'),payload:social}).strict(),
]);
export type OwnerIntelV2Observation=z.infer<typeof observation>;
const propertyScope=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('domain'),siteUrl:text(2048).min(1),domain:text(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)}).strict(),
 z.object({kind:z.literal('url_prefix'),siteUrl:url,origin:url,pathPrefix:text(2048).min(1)}).strict(),
]);
const policySchema=z.object({producerId:common.producerId,monitoringBindingId:common.monitoringBindingId,configurationRevision:common.configurationRevision,
 observationKind:z.enum(['search_console_summary','own_site','social_presence','ga4_summary']),subjectKey:common.subjectKey,
 source:provenance.shape.source,sourceAccountRef:provenance.shape.sourceAccountRef,collectedBy:provenance.shape.collectedBy,
 searchProperties:z.array(propertyScope).max(50),propertyRefs:z.array(text(120).min(1)).max(50),canonicalDomains:z.array(text(253).min(1)).max(50),
 pageUrls:z.array(url).max(50),ownerSubjectKeys:z.array(social.shape.ownerSubjectKey).max(50),socialProfileUrls:z.array(url).max(50),providerLagDays:z.literal(3),
}).strict();
/** These parameters come from an independently reviewed control plane, never
 * from producer payloads. This pure function cannot establish that review or
 * provider facts, and does not confer routing, ingest, read or fetch authority. */
export type ReviewedOwnerIntelV2Context=z.infer<typeof policySchema>;
function invalid():never {throw new IntelIngestError('schema_invalid',400);}
const day=(value:string)=>Date.parse(value.slice(0,10));
function hasLimits(p:z.infer<typeof provenance>){return p.limits.some(v=>v.trim().length>0);}
function ctr(clicks:number,impressions:number,value:string|null){
 if(clicks>impressions)invalid();
 if(impressions===0){if(value!==null)invalid();return;}
 if(value===null)invalid();
 // Exact HALF-UP rounding to six percentage decimal places, including at
 // MAX_SAFE_INTEGER counts. Equivalent trailing-zero representations agree.
 const [whole,fraction='']=value.split('.');
 const micros=BigInt(whole!)*1000000n+BigInt(fraction.padEnd(6,'0'));
 const numerator=BigInt(clicks)*100000000n,denominator=BigInt(impressions);
 const rounded=numerator/denominator+(numerator%denominator*2n>=denominator?1n:0n);
 if(micros!==rounded)invalid();
}
function pageWithinProperty(value:string,scope:z.infer<typeof propertyScope>){
 const page=new URL(value);
 if(scope.kind==='domain')return scope.siteUrl===`sc-domain:${scope.domain}`&&(page.hostname===scope.domain||page.hostname.endsWith(`.${scope.domain}`));
 const approved=new URL(scope.siteUrl),origin=new URL(scope.origin);
 return origin.origin===scope.origin&&approved.origin===scope.origin&&approved.pathname===scope.pathPrefix&&!approved.search&&!approved.hash
  &&page.origin===scope.origin&&page.pathname.startsWith(scope.pathPrefix);
}
function canonicalDigest(value:string){try{const bytes=atob(value.replace(/-/g,'+').replace(/_/g,'/'));return bytes.length===32&&btoa(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'')===value;}catch{return false;}}

export function validateOwnerIntelV2Observation(raw:Uint8Array,reviewed:ReviewedOwnerIntelV2Context,now=Date.now()):OwnerIntelV2Observation {
 if(raw.byteLength>262144)throw new IntelIngestError('body_too_large',413);
 const context=policySchema.safeParse(reviewed);if(!context.success)invalid();
 const value=observation.safeParse(strictIntelJson(raw));if(!value.success)invalid();
 const o=value.data,c=context.data,p=o.payload.provenance;
 if(o.producerId!==c.producerId||o.monitoringBindingId!==c.monitoringBindingId||o.configurationRevision!==c.configurationRevision
  ||o.subjectKey!==c.subjectKey||o.observationKind!==c.observationKind||p.source!==c.source||p.sourceAccountRef!==c.sourceAccountRef||p.collectedBy!==c.collectedBy
  ||o.observedAt>o.completedAt||Date.parse(o.completedAt)>now+300000||p.collectedAt>o.completedAt)invalid();
 let data=false;
 if(o.observationKind==='search_console_summary'){
  const q=o.payload,scope=c.searchProperties.find(s=>s.siteUrl===q.siteUrl);
  if(c.source!=='google_search_console'||!/^gsc:[A-Za-z0-9:_-]+$/.test(o.subjectKey)||!scope)invalid();
  // Validate even an empty report's reviewed property configuration.
  if(scope.kind==='domain'?scope.siteUrl!==`sc-domain:${scope.domain}`:!pageWithinProperty(scope.siteUrl,scope))invalid();
  data=q.totals.state==='observed'||q.daily.length>0||q.topQueries.length>0||q.topPages.length>0;
  if(data&&q.daily.length<q.period.days&&!hasLimits(p))invalid();
  if(q.totals.state==='observed'){
   ctr(q.totals.clicks!,q.totals.impressions!,q.totals.ctrPercent);
   if(q.totals.impressions!>0&&q.totals.avgPosition===null&&!hasLimits(p))invalid();
  }
  let prior='';
  for(const row of q.daily){if(row.date<q.period.start||row.date>q.period.end||row.date<=prior||row.clicks>row.impressions)invalid();prior=row.date;}
  for(const row of [...q.topQueries,...q.topPages]){ctr(row.clicks,row.impressions,row.ctrPercent);if(row.impressions>0&&row.avgPosition===null&&!hasLimits(p))invalid();}
  for(const row of q.topPages)if(!pageWithinProperty(row.url,scope))invalid();
  if(q.comparison&&(q.comparison.previousPeriod.days!==q.period.days||day(q.comparison.previousPeriod.end)!==day(q.period.start)-86400000))invalid();
  if(p.partialReason==='provider_data_delay'||q.totals.reason==='provider_data_delay'){
   const recent=day(p.collectedAt)-c.providerLagDays*86400000;
   if(!p.partial||p.partialReason!=='provider_data_delay'
    ||day(q.period.end)<recent||day(q.period.start)>day(p.collectedAt)||!hasLimits(p))invalid();
   const known=new Set(q.daily.map(row=>row.date));
   for(let when=day(q.period.start);when<=day(q.period.end);when+=86400000){
    if(!known.has(new Date(when).toISOString().slice(0,10))&&(when<recent||when>day(p.collectedAt)))invalid();
   }
  }
  if(p.partialReason==='source_stale'){
   if(p.lastDataDate===null||p.lastDataDate>=q.period.end||!hasLimits(p))invalid();
   if(p.lastDataDate<q.period.start&&(q.totals.state!=='unknown'||q.totals.reason!=='source_stale'||q.daily.length||q.topQueries.length||q.topPages.length))invalid();
  }
 }else if(o.observationKind==='ga4_summary'){
  const q=o.payload,t=q.totals,flags=q.providerLimits;
  if(c.source!=='google_analytics_4'||!/^ga4:[A-Za-z0-9:_-]+$/.test(o.subjectKey)||p.partialReason==='provider_data_delay'||t.reason==='provider_data_delay')invalid();
  data=t.state==='observed'||q.daily.length>0||q.channels.length>0||q.topLandingPages.length>0||q.keyEventNames.length>0;
  const noResponse=t.state==='not_connected'||t.state==='failed'||t.reason==='consent_missing'||t.reason==='no_property_selected';
  const noFlags=flags.thresholded===null&&flags.sampled===null;
  if((flags.thresholded===null)!==(flags.sampled===null))invalid();
  if(noResponse){if(data||!noFlags||p.asOf!==null||p.lastDataDate!==null||p.dataRange!==null)invalid();}
  if((t.state==='not_connected'||t.reason==='consent_missing'||t.reason==='no_property_selected')&&p.partial)invalid();
  else if(data&&noFlags)invalid();
  if(q.propertyRef===null){
   if(t.state!=='not_connected'||!['consent_missing','no_property_selected'].includes(t.reason??'')||data||!noFlags
    ||q.propertyDisplayName!==null||p.asOf!==null||p.lastDataDate!==null||p.dataRange!==null||p.partial)invalid();
  }else if(!c.propertyRefs.includes(q.propertyRef))invalid();
  if(flags.thresholded===true||flags.sampled===true){if(!p.partial||p.partialReason!=='data_limited'||!hasLimits(p))invalid();}
  if(t.newUsers!==null&&t.activeUsers!==null&&t.newUsers>t.activeUsers||t.engagedSessions!==null&&t.sessions!==null&&t.engagedSessions>t.sessions)invalid();
  if(data&&q.daily.length<q.period.days&&!hasLimits(p))invalid();
  let prior='';for(const row of q.daily){if(row.date<q.period.start||row.date>q.period.end||row.date<=prior)invalid();prior=row.date;}
 }else if(o.observationKind==='own_site'){
  const q=o.payload;
  if(c.source!=='hermes_site_monitor'||!/^own:[A-Za-z0-9:_-]+$/.test(o.subjectKey)||!c.canonicalDomains.includes(q.canonicalDomain))invalid();
  for(const row of q.monitoredPages)if(!c.pageUrls.includes(row.url)||!canonicalDigest(row.contentSha256))invalid();
  for(const row of q.changesSincePrevious)if(!c.pageUrls.includes(row.pageUrl.url)||row.detectedAt>o.completedAt)invalid();
  data=q.monitoredPages.some(row=>row.fetchStatus==='ok')||q.changesSincePrevious.length>0||q.technical.avgFetchMs!==null
   ||[q.technical.httpsOk,q.technical.sitemapPageCount,q.technical.robotsAllowsIndexing].some(v=>v.state==='observed');
 }else{
  const q=o.payload;
  if(c.source!=='public_web'||o.subjectKey!==`social:${q.ownerSubjectKey}`||!c.ownerSubjectKeys.includes(q.ownerSubjectKey))invalid();
  for(const row of q.profiles)if(!c.socialProfileUrls.includes(row.url)||!c.pageUrls.includes(row.sourceUrl.url))invalid();
  data=q.profiles.some(row=>[row.profileFound,row.followers,row.lastPublicPostDate].some(v=>v.state==='observed'));
 }
 if(data&&p.asOf===null)invalid();
 return o;
}
