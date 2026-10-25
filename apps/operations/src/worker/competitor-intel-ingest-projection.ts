import { ownerCompetitorProjection } from './owner-intel-model';
import { IntelIngestError, type IntelObservation } from './competitor-intel-ingest-schema';
export const INTEL_FROZEN_CONTRACT='a60a11ddd68df90da80a1e2eaf298434369653d8e8f390b814ed906e7b675b32';
export type AcceptedIntel={observation:IntelObservation;digest:string};
export function projectOwnerIntel(rows:AcceptedIntel[],business:{route_key:string;display_name:string}) {
 const reference=(row:AcceptedIntel)=>({operationId:row.observation.operationId,payloadSha256:row.digest});
 const baselines=new Map(rows.filter(r=>r.observation.observationKind==='baseline_assessment').map(r=>[r.observation.subjectKey,r]));
 const ads=new Map(rows.filter(r=>r.observation.observationKind==='ad_activity').map(r=>[r.observation.subjectKey,r]));
 const competitors=rows.flatMap(row=>{
  const o=row.observation;if(o.observationKind!=='competitor_profile')return [];
  const p=o.payload,b=baselines.get(o.subjectKey),a=ads.get(o.subjectKey);
  const bp=b?.observation.observationKind==='baseline_assessment'?b.observation.payload:null;
  const ap=a?.observation.observationKind==='ad_activity'?a.observation.payload:null;
  return [{...reference(row),subjectKey:o.subjectKey,name:p.name,canonicalDomain:p.canonicalDomain,verifiedHomeUrl:p.verifiedHomeUrl,
   homepageStatus:p.homepageStatus,monitoringSince:p.monitoringSince,lastSuccessfulCheckAt:p.lastSuccessfulCheckAt,freshness:'stale' as const,
   sitePageCount:{value:p.sitePageCount.value,state:p.sitePageCount.state,reason:p.sitePageCount.reason},monitoredPageCount:p.monitoredPageCount,active:p.active,
   baseline:bp&&b?{...reference(b),assessedAt:bp.assessedAt,freshness:'stale' as const,threat:bp.threat,serviceOverlap:bp.serviceOverlap,
    geographicOverlap:bp.geographicOverlap,hasPricing:bp.hasPricing,marketPosition:bp.marketPosition,explanation:bp.explanation,factors:bp.factors}:null,
   adActivity:ap&&a?{...reference(a),checkedAt:ap.checkedAt,freshness:'stale' as const,status:ap.status,reason:ap.reason,adCount:ap.adCount,
    lastShownDate:ap.lastShownDate,formats:ap.formats,activityEvidence:ap.activityEvidence,adCopyConcern:ap.adCopyConcern,sourceUrl:ap.sourceUrl}:null}];
 });
 const changes=rows.flatMap(row=>{const o=row.observation;if(o.observationKind!=='change')return [];
  const {producerReview:_review,...p}=o.payload;return [{...reference(row),...p,verdict:null,published:false as const}];});
 const latest=(kind:'scan_run'|'self_assessment')=>rows.filter(r=>r.observation.observationKind===kind)
  .sort((a,b)=>b.observation.completedAt.localeCompare(a.observation.completedAt)||b.observation.operationId.localeCompare(a.observation.operationId))[0];
 const scan=latest('scan_run')?.observation,self=latest('self_assessment')?.observation;
 const s=self?.observationKind==='self_assessment'?self.payload:null;
 const dto={tenantKey:business.route_key,tenantName:business.display_name,monitoring:'active',
  latestScan:scan?.observationKind==='scan_run'?{state:scan.payload.state,completedAt:scan.payload.completedAt,freshness:'stale'}:null,
  competitors,changes,ownAds:null,selfAssessment:s?{assessedAt:s.assessedAt,freshness:'stale',scores:{positioning:s.positioning,serviceCoverage:s.serviceCoverage,
   geographicMessaging:s.geographicMessaging,pricingClarity:s.pricingClarity,differentiation:s.differentiation,competitiveReadiness:s.competitiveReadiness,overall:s.overall},
   strengths:s.strengths,weaknesses:s.weaknesses,recommendedActions:s.recommendedActions}:null,
  manifest:null,intents:[],providerAccountRef:null,scopeKey:null};
 const parsed=ownerCompetitorProjection.safeParse(dto);
 if(!parsed.success)throw new IntelIngestError('retryable',503);
 const json=JSON.stringify(parsed.data);
 if(new TextEncoder().encode(json).byteLength>262144)throw new IntelIngestError('retryable',503);
 return json;
}
