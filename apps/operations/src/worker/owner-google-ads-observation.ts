import { z } from 'zod';
import { IntelIngestError,int63,strictIntelJson,text,timestamp } from './competitor-intel-ingest-schema';

/** Independent proposed contract: this discriminator is not in draft3 or v1. */
export const OWNER_GOOGLE_ADS_CONTRACT='ops.owner-google-ads-observation.v1';
const maxInt64=9223372036854775807n;
const decimalInt=z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/).refine(value=>BigInt(value)<=maxInt64);
const decimalMetric=z.string().regex(/^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,6})?$/);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value);
const customerRef=z.string().regex(/^[0-9]{10}$/);
const currency=z.string().regex(/^[A-Z]{3}$/);
const timeZone=z.string().min(1).max(64).refine(value=>{
 try{return new Intl.DateTimeFormat('en-US',{timeZone:value}).resolvedOptions().timeZone===value;}catch{return false;}
});
const periodDays=z.union([z.literal(7),z.literal(28),z.literal(90)]);
const period=z.object({start:date,end:date,days:periodDays,timeZone}).strict().refine(value=>
 value.start<=value.end&&value.days===(Date.parse(`${value.end}T00:00:00Z`)-Date.parse(`${value.start}T00:00:00Z`))/86400000+1);
const account=z.object({managerCustomerRef:customerRef,advertiserCustomerRef:customerRef,currencyCode:currency,timeZone}).strict();
const metrics=z.object({costMicros:decimalInt.nullable(),impressions:decimalInt.nullable(),clicks:decimalInt.nullable(),conversions:decimalMetric.nullable(),state:z.enum(['observed','unknown','failed','source_stale','no_account']),reason:z.enum(['not_checked','provider_metrics_failed','provider_error','source_stale','consent_missing','no_account']).nullable()}).strict();
const provenance=z.object({source:z.literal('google_ads_api'),sourceAccountRef:customerRef.nullable(),collectedBy:text(64).min(1),collectedAt:timestamp,asOf:timestamp.nullable(),partial:z.literal(false),partialReason:z.null(),limits:z.array(text(300)).max(5)}).strict();
const common={
 schemaVersion:z.literal('ci.observation.v1'),producerId:z.string().regex(/^[a-z0-9-]{3,64}$/),
 operationId:z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
 monitoringBindingId:text(191).min(1),configurationRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 subjectKey:z.literal('own:google-ads'),sourceSequence:z.object({epoch:int63,counter:int63}).strict(),commandBinding:z.null(),
 observedAt:timestamp,completedAt:timestamp,semantics:z.object({observation:z.literal('ci.google_ads_owner.v1')}).strict(),
 observationKind:z.literal('google_ads_summary'),
};
const observation=z.object({...common,payload:z.object({account:account.nullable(),period:period.nullable(),currencyCode:currency.nullable(),totals:metrics,provenance}).strict()}).strict();
export type OwnerGoogleAdsObservation=z.infer<typeof observation>;
export type OwnerGoogleAdsAccount=z.infer<typeof account>;
export type OwnerGoogleAdsReviewedContext={
 producerId:string;monitoringBindingId:string;configurationRevision:number;observationKind:'google_ads_summary';subjectKey:'own:google-ads';
 accountState:'connected'|'no_account';managerCustomerRef:string|null;advertiserCustomerRef:string|null;currencyCode:string|null;timeZone:string|null;sourceAccountRef:string|null;collectedBy:string;
};

export function parseStrictOwnerGoogleAdsObservation(raw:Uint8Array):OwnerGoogleAdsObservation {
 if(raw.byteLength>262144)throw new IntelIngestError('body_too_large',413);
 const parsed=observation.safeParse(strictIntelJson(raw));
 if(!parsed.success)throw new IntelIngestError('schema_invalid',400);
 return parsed.data;
}

function localDate(timestampValue:string,zone:string){
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(timestampValue));
 const part=(type:Intl.DateTimeFormatPartTypes)=>parts.find(item=>item.type===type)?.value;
 return `${part('year')}-${part('month')}-${part('day')}`;
}

export function validateOwnerGoogleAdsObservation(raw:Uint8Array,context:OwnerGoogleAdsReviewedContext,now=Date.now()):OwnerGoogleAdsObservation {
 const o=parseStrictOwnerGoogleAdsObservation(raw),p=o.payload, t=p.totals;
 if(!context||o.producerId!==context.producerId||o.monitoringBindingId!==context.monitoringBindingId||o.configurationRevision!==context.configurationRevision
  ||o.observationKind!==context.observationKind||o.subjectKey!==context.subjectKey||o.observedAt>o.completedAt
  ||Date.parse(o.completedAt)>now+300000||p.provenance.collectedAt>o.completedAt||p.provenance.asOf!==null&&p.provenance.asOf>p.provenance.collectedAt
  ||p.provenance.collectedBy!==context.collectedBy||p.provenance.sourceAccountRef!==context.sourceAccountRef)throw new IntelIngestError('schema_invalid',400);
 const allNull=[t.costMicros,t.impressions,t.clicks,t.conversions].every(value=>value===null);
 if(context.accountState==='no_account'){
  if(context.managerCustomerRef!==null||context.advertiserCustomerRef!==null||context.currencyCode!==null||context.timeZone!==null||context.sourceAccountRef!==null
   ||p.account!==null||p.period!==null||p.currencyCode!==null||t.state!=='no_account'||t.reason!=='no_account'||!allNull||p.provenance.asOf!==null)
   throw new IntelIngestError('schema_invalid',400);
 }else{
  if(context.managerCustomerRef===null||context.advertiserCustomerRef===null||context.currencyCode===null||context.timeZone===null||p.account===null||p.period===null||p.currencyCode!==context.currencyCode
   ||p.provenance.sourceAccountRef!==context.advertiserCustomerRef||p.account.managerCustomerRef!==context.managerCustomerRef||p.account.advertiserCustomerRef!==context.advertiserCustomerRef
   ||p.account.currencyCode!==context.currencyCode||p.account.timeZone!==context.timeZone
   ||p.period.timeZone!==context.timeZone||p.period.end>=localDate(o.completedAt,p.period.timeZone))throw new IntelIngestError('schema_invalid',400);
  if(t.state==='no_account'||t.reason==='no_account'||t.state==='observed'&&(![t.costMicros,t.impressions,t.clicks,t.conversions].every(value=>value!==null)||t.reason!==null||p.provenance.asOf===null||localDate(p.provenance.asOf,p.period.timeZone)<=p.period.end)
   ||t.state==='unknown'&&(!allNull||!['not_checked','provider_metrics_failed'].includes(t.reason??'')||p.provenance.asOf!==null)
   ||t.state==='failed'&&(!allNull||!['provider_error','consent_missing','provider_metrics_failed'].includes(t.reason??'')||p.provenance.asOf!==null)
   ||t.state==='source_stale'&&(!allNull||t.reason!=='source_stale'||p.provenance.asOf!==null))throw new IntelIngestError('schema_invalid',400);
 }
 return o;
}

