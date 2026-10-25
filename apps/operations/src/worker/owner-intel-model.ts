import { z } from 'zod';
import type { StaffTenantView } from '@ltds/shared/competitor-intel';

const text = (max=200) => z.string().max(max).refine(v => v.normalize('NFC')===v && !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(v));
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/).refine(v => Number.isFinite(Date.parse(v))&&new Date(v).toISOString().replace('.000Z','Z')===v);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const decimal = z.string().regex(/^-?\d{1,15}(\.\d{1,6})?$/);
const reason = z.enum(['not_configured','not_checked','robots_blocked','bot_challenge','fetch_timeout','http_error','parked','redirected_offsite','too_little_content','insufficient_ad_copy','page_unreadable','no_ads_account','provider_error','provider_metrics_failed','too_old','legacy_semantics','ssrf_blocked']);
const state = z.enum(['observed','none_found','unknown','blocked','failed','not_connected']);
const freshness = z.enum(['current','stale']);
const url = text(2048).refine(v => {try { const u=new URL(v);return !/[\s\p{C}]/u.test(v)&&['http:','https:'].includes(u.protocol)&&!u.username&&!u.password; } catch { return false; }});
const source = z.object({url,title:text().nullable(),observedAt:timestamp,fetchStatus:z.enum(['ok','parked','redirect','blocked','error','not_checked'])}).strict();
const probabilityValue = decimal.refine(v => Number(v)>=0&&Number(v)<=1);
const stated = <T extends z.ZodType>(value:T) => z.object({value:value.nullable(),state,reason:reason.nullable()}).strict()
 .refine((v:{value?:unknown;state:string;reason:unknown}) => v.state==='observed' ? v.value!==null&&v.reason===null : v.value===null&&(v.state==='none_found' ? v.reason===null : v.reason!==null));
const score = z.object({value:decimal.refine(v => Number(v)>=0&&Number(v)<=10).nullable(),scale:z.enum(['concern_0_10','overlap_0_10','activity_evidence_0_10']),state,reason:reason.nullable(),confidence:probabilityValue.nullable()}).strict()
 .refine(v => v.state==='observed' ? v.value!==null&&v.reason===null : v.value===null&&v.confidence===null&&(v.state==='none_found'?v.reason===null:v.reason!==null));
const reference = {operationId:z.string().uuid(),payloadSha256:z.string().regex(/^[A-Za-z0-9_-]{43}$/)};
const baseline = z.object({...reference,assessedAt:timestamp,freshness,threat:score,serviceOverlap:score,geographicOverlap:stated(probabilityValue),hasPricing:stated(z.boolean()),marketPosition:stated(z.enum(['small','startup','established','enterprise'])),explanation:text(500),factors:z.object({helps:z.array(text()).max(5),hurts:z.array(text()).max(5)}).strict()}).strict();
const adActivity = z.object({...reference,checkedAt:timestamp,freshness,status:state,reason:reason.nullable(),adCount:z.object({value:count.nullable(),approximate:z.boolean()}).strict(),lastShownDate:date.nullable(),formats:z.array(z.enum(['text','image','video','unknown'])).max(5),activityEvidence:score,adCopyConcern:score,sourceUrl:source}).strict();
const competitor = z.object({...reference,subjectKey:text(120),name:text(),canonicalDomain:text(253),verifiedHomeUrl:source.nullable(),homepageStatus:source,monitoringSince:timestamp.nullable(),lastSuccessfulCheckAt:timestamp.nullable(),freshness,sitePageCount:stated(count),monitoredPageCount:count.max(10),active:z.boolean(),baseline:baseline.nullable(),adActivity:adActivity.nullable()}).strict();
const significance = z.enum(['critical','notable','minor','noise']);
const change = z.object({...reference,competitorSubjectKey:text(120),detectedAt:timestamp,pageUrl:source,pageTitle:text().nullable(),changeType:z.enum(['content_changed','redirect_external','website_parked','site_unavailable']),significance:z.object({value:significance.nullable(),confidence:probabilityValue.nullable()}).strict(),category:z.object({value:z.enum(['new_service','new_content','pricing_update','rebrand','site_down','other']).nullable(),confidence:probabilityValue.nullable()}).strict(),isNewService:stated(probabilityValue),isPricingChange:stated(probabilityValue),impact:score,summary:text(1000),addedSentences:z.array(text(500)).max(20),removedSentences:z.array(text(500)).max(20),verdict:z.null(),published:z.literal(false)}).strict();
const scores = z.object({positioning:score,serviceCoverage:score,geographicMessaging:score,pricingClarity:score,differentiation:score,competitiveReadiness:score,overall:score}).strict();

// Internal initial reader deliberately omits Ads provider data, client
// publications, verdicts and command capabilities until their live authority
// contracts are implemented. It does not turn those missing facts into zeros.
export const ownerCompetitorProjection = z.object({tenantKey:text(64),tenantName:text(),monitoring:z.enum(['active','paused','not_configured']),latestScan:z.object({state:z.enum(['completed','partial','failed']),completedAt:timestamp.nullable(),freshness}).strict().nullable(),competitors:z.array(competitor).max(50),changes:z.array(change).max(200),ownAds:z.null(),selfAssessment:z.object({assessedAt:timestamp,freshness,scores,strengths:z.array(text(300)).max(5),weaknesses:z.array(text(300)).max(5),recommendedActions:z.array(text(300)).max(5)}).strict().nullable(),manifest:z.null(),intents:z.array(z.never()).max(0),providerAccountRef:z.null(),scopeKey:z.null()}).strict();

export function refreshOwnerIntel(view:z.infer<typeof ownerCompetitorProjection>,now=Date.now()):StaffTenantView {
 const fresh=(at:string|null,days:number):'current'|'stale' => at!==null&&Date.parse(at)<=now&&now-Date.parse(at)<=days*86400000?'current':'stale';
 return {...view,latestScan:view.latestScan?{...view.latestScan,freshness:fresh(view.latestScan.completedAt,9)}:null,
  competitors:view.competitors.map(c=>({...c,freshness:fresh(c.lastSuccessfulCheckAt,9),baseline:c.baseline?{...c.baseline,freshness:fresh(c.baseline.assessedAt,100)}:null,adActivity:c.adActivity?{...c.adActivity,freshness:fresh(c.adActivity.checkedAt,['none_found','unknown'].includes(c.adActivity.status)?16:9)}:null})),
  selfAssessment:view.selfAssessment?{...view.selfAssessment,freshness:fresh(view.selfAssessment.assessedAt,30)}:null};
}
