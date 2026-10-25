import { z } from 'zod';

export class IntelIngestError extends Error {
  constructor(readonly code:string, readonly status:400|401|403|409|413|429|503) { super(code); }
}
export const text=(max=200,free=false)=>z.string().max(max).refine(v=>v.normalize('NFC')===v && !(free ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u : /[\u0000-\u001f\u007f-\u009f]/u).test(v));
export const timestamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString().replace('.000Z','Z')===v);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v);
export const int63=z.string().regex(/^[1-9][0-9]{0,18}$/).refine(v=>BigInt(v)<=9223372036854775807n);
const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const subject=z.string().regex(/^[A-Za-z0-9:_-]{3,120}$/);
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimal=z.string().regex(/^-?\d{1,15}(\.\d{1,6})?$/);
const probability=decimal.refine(v=>Number(v)>=0&&Number(v)<=1);
const state=z.enum(['observed','none_found','unknown','blocked','failed','not_connected']);
const reason=z.enum(['not_configured','not_checked','robots_blocked','bot_challenge','fetch_timeout','http_error','parked','redirected_offsite','too_little_content','insufficient_ad_copy','page_unreadable','no_ads_account','provider_error','provider_metrics_failed','too_old','legacy_semantics','ssrf_blocked']);
const url=text(2048).refine(v=>{try {const u=new URL(v);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&!/[\s\p{C}]/u.test(v);}catch{return false;}});
const fetchStatus=z.enum(['ok','parked','redirect','blocked','error','not_checked']);
const source=z.object({url,title:text().nullable(),observedAt:timestamp,fetchStatus}).strict();
function consistent(v:{value?:unknown;state:string;reason:unknown}) {return v.state==='observed'?v.value!==null&&v.value!==undefined&&v.reason===null:v.value===null&&(v.state==='none_found'?v.reason===null:v.reason!==null);}
const stated=<T extends z.ZodType>(value:T)=>z.object({value:value.nullable(),state,reason:reason.nullable()}).strict().refine(consistent);
const score=(scale:'concern_0_10'|'overlap_0_10'|'activity_evidence_0_10')=>z.object({value:decimal.refine(v=>Number(v)>=0&&Number(v)<=10).nullable(),scale:z.literal(scale),state,reason:reason.nullable(),confidence:probability.nullable()}).strict().refine(v=>consistent(v)&&(v.state==='observed'||v.confidence===null));
const scores=z.object({positioning:score('concern_0_10'),serviceCoverage:score('concern_0_10'),geographicMessaging:score('concern_0_10'),pricingClarity:score('concern_0_10'),differentiation:score('concern_0_10'),competitiveReadiness:score('concern_0_10'),overall:score('concern_0_10')}).strict();
const profile=z.object({name:text().min(1),canonicalDomain:text(253).min(1),verifiedHomeUrl:source.nullable(),homepageStatus:source,monitoringSince:timestamp.nullable(),lastSuccessfulCheckAt:timestamp.nullable(),sitePageCount:z.object({value:count.nullable(),source:z.enum(['sitemap','robots_sitemap']).nullable(),checkedAt:timestamp.nullable(),state,reason:reason.nullable()}).strict().refine(consistent),monitoredPageCount:count.max(10),socialProfiles:z.array(z.object({platform:z.enum(['facebook','instagram','linkedin','youtube','x','tiktok','other']),url}).strict()).max(10),active:z.boolean(),scopeKey:text(50)}).strict().refine(v=>v.active ? v.monitoringSince!==null : v.monitoringSince===null);
const baseline=z.object({competitorSubjectKey:subject.regex(/^comp:/),assessedAt:timestamp,threat:score('concern_0_10'),serviceOverlap:score('overlap_0_10'),geographicOverlap:stated(probability),hasPricing:stated(z.boolean()),marketPosition:stated(z.enum(['small','startup','established','enterprise'])),explanation:text(500,true),factors:z.object({helps:z.array(text(200,true)).max(5),hurts:z.array(text(200,true)).max(5)}).strict(),basisSnapshotCount:count.max(10),homepageStateAtAssessment:fetchStatus}).strict();
const change=z.object({competitorSubjectKey:subject.regex(/^comp:/),detectedAt:timestamp,pageUrl:source,pageTitle:text().nullable(),changeType:z.enum(['content_changed','redirect_external','website_parked','site_unavailable']),significance:z.object({value:z.enum(['critical','notable','minor','noise']).nullable(),confidence:probability.nullable()}).strict(),category:z.object({value:z.enum(['new_service','new_content','pricing_update','rebrand','site_down','other']).nullable(),confidence:probability.nullable()}).strict(),isNewService:stated(probability),isPricingChange:stated(probability),impact:score('concern_0_10'),summary:text(1000,true),addedSentences:z.array(text(500,true)).max(20),removedSentences:z.array(text(500,true)).max(20),producerReview:z.object({state:z.enum(['unreviewed','reviewed']),verdict:z.enum(['accurate','inaccurate']).nullable(),reviewedAt:timestamp.nullable()}).strict()}).strict();
const ad=z.object({competitorSubjectKey:subject.regex(/^comp:/),checkedAt:timestamp,status:state,reason:reason.nullable(),adCount:z.object({value:count.nullable(),approximate:z.boolean()}).strict(),lastShownDate:date.nullable(),formats:z.array(z.enum(['text','image','video','unknown'])).max(5),policyRemovalNotice:z.boolean().nullable(),activityEvidence:score('activity_evidence_0_10'),adCopyConcern:score('concern_0_10'),sampledCreatives:z.array(z.object({transparencyUrl:url,lastShown:date.nullable(),format:z.enum(['text','image','video','unknown'])}).strict()).max(2),sourceUrl:source}).strict().refine(v=>consistent({value:v.adCount.value,state:v.status,reason:v.reason}));
const counts=z.object({attempted:count,succeeded:count}).strict().refine(v=>v.succeeded<=v.attempted);
const scan=z.object({scanType:z.enum(['full','website','ads','onboarding']),trigger:z.enum(['schedule','manual']),startedAt:timestamp,completedAt:timestamp.nullable(),nextScheduledAt:timestamp.nullable(),competitorsScanned:count.max(10),pages:counts,changesDetected:count,errors:count,state:z.enum(['completed','partial','failed'])}).strict().refine(v=>(v.completedAt===null?v.state==='failed':v.startedAt<=v.completedAt)&&(v.nextScheduledAt===null||v.nextScheduledAt>v.startedAt));
const self=z.object({scopeKey:text(),assessedAt:timestamp,...scores.shape,strengths:z.array(text(300,true)).max(5),weaknesses:z.array(text(300,true)).max(5),recommendedActions:z.array(text(300,true)).max(5)}).strict();
const common={schemaVersion:z.literal('ci.observation.v1'),producerId:z.string().regex(/^[a-z0-9-]{3,64}$/),operationId:uuid,monitoringBindingId:text(191).min(1),configurationRevision:count.min(1),subjectKey:subject,sourceSequence:z.object({epoch:int63,counter:int63}).strict(),commandBinding:z.union([z.null(),z.object({intentId:uuid,leaseId:uuid,fencingToken:int63}).strict()]),observedAt:timestamp,completedAt:timestamp,semantics:z.object({observation:z.literal('ci.obs.v1'),scoring:z.literal('concern_0_10.v1')}).strict()};
export const envelopeSchema=z.discriminatedUnion('observationKind',[
 z.object({...common,observationKind:z.literal('competitor_profile'),payload:profile}).strict(),
 z.object({...common,observationKind:z.literal('baseline_assessment'),payload:baseline}).strict(),
 z.object({...common,observationKind:z.literal('change'),payload:change}).strict(),
 z.object({...common,observationKind:z.literal('ad_activity'),payload:ad}).strict(),
 z.object({...common,observationKind:z.literal('scan_run'),payload:scan}).strict(),
 z.object({...common,observationKind:z.literal('self_assessment'),payload:self}).strict(),
]);
export type IntelObservation=z.infer<typeof envelopeSchema>;

/** Parse JSON without losing duplicate members (including escaped names).
 * Container depth is counted from the root object at depth one. */
export function strictIntelJson(raw:Uint8Array):unknown {
 let value:string;try {value=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);}catch{throw new IntelIngestError('encoding_invalid',400);}
 if(value.startsWith('\uFEFF')||value.includes('\0'))throw new IntelIngestError('encoding_invalid',400);
 let at=0;
 const white=()=>{while(/[\x20\t\r\n]/.test(value[at]??'!'))at++;};
 const string=()=>{const start=at++;while(at<value.length){const c=value[at++];if(c==='"')return JSON.parse(value.slice(start,at)) as string;if(c==='\\')at++;}throw Error('string');};
 const parse=(depth:number):unknown=>{white();const c=value[at];if(c==='{'||c==='['){if(depth>6)throw Error('depth');at++;white();const object=c==='{',out:Record<string,unknown>|unknown[]=object?Object.create(null):[],keys=new Set<string>();if(value[at]===(object?'}':']')){at++;return out;}for(;;){white();let key='';if(object){if(value[at]!== '"')throw Error('key');key=string();if(keys.has(key))throw Error('duplicate');keys.add(key);white();if(value[at++]!==':')throw Error('colon');}const item=parse(depth+1);if(object)(out as Record<string,unknown>)[key]=item;else(out as unknown[]).push(item);white();const separator=value[at++];if(separator===(object?'}':']'))return out;if(separator!==',')throw Error('separator');}}
  if(c==='"')return string();const token=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(value.slice(at));if(!token)throw Error('token');at+=token[0].length;return JSON.parse(token[0]);};
 try{const result=parse(1);white();if(at!==value.length||!result||typeof result!=='object'||Array.isArray(result))throw Error('root');return result;}catch{throw new IntelIngestError('schema_invalid',400);}
}
export function validateIntelObservation(value:unknown,producerId:string,now:number):IntelObservation {
 if(value&&typeof value==='object'&&'schemaVersion'in value&&(value as {schemaVersion:unknown}).schemaVersion!=='ci.observation.v1')throw new IntelIngestError('schema_version_unsupported',400);
 const parsed=envelopeSchema.safeParse(value);if(!parsed.success)throw new IntelIngestError('schema_invalid',400);
 const v=parsed.data;if(v.producerId!==producerId||v.observedAt>v.completedAt||Date.parse(v.completedAt)>now+300_000)throw new IntelIngestError('schema_invalid',400);
 if(v.commandBinding!==null)throw new IntelIngestError('command_binding_stale',409);
 const prefix=v.observationKind==='change'?'change:':v.observationKind==='scan_run'?'scan:':v.observationKind==='self_assessment'?'self:':'comp:';
 if(!v.subjectKey.startsWith(prefix)||((v.observationKind==='baseline_assessment'||v.observationKind==='ad_activity')&&v.subjectKey!==v.payload.competitorSubjectKey)
  ||v.observationKind==='self_assessment'&&v.subjectKey!==`self:${v.payload.scopeKey}`
  ||v.observationKind==='change'&&v.payload.detectedAt>v.completedAt)throw new IntelIngestError('schema_invalid',400);
 return v;
}
