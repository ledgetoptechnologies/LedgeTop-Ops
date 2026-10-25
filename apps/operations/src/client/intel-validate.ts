/**
 * Structural checks for the Intel replies the Ops UI renders. They follow the display shapes in
 * @ltds/shared/competitor-intel field by field, so a reply that passes can be rendered without
 * reading through a missing object. Values are checked for type and enum membership only; digests
 * and identifiers stay opaque strings (their encoding is the server's concern).
 */
export type Check = (value: unknown) => boolean;

const obj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const text: Check = value => typeof value === "string";
export const str: Check = value => typeof value === "string" && value.length > 0;
export const num: Check = value => typeof value === "number" && Number.isFinite(value);
export const bool: Check = value => typeof value === "boolean";
export const orNull = (check: Check): Check => value => value === null || check(value);
export const list = (check: Check): Check => value => Array.isArray(value) && value.every(check);
export const oneOf = (...values: readonly string[]): Check => value => typeof value === "string" && values.includes(value);
export const shape = (fields: Record<string, Check>): Check => value => obj(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
const both = (...checks: Check[]): Check => value => checks.every(check => check(value));

const freshness = oneOf("current", "stale");
const evidence = oneOf("observed", "none_found", "unknown", "blocked", "failed", "not_connected");
const reason = orNull(str);
const decimal = orNull(text);
const score = shape({ value: decimal, scale: oneOf("concern_0_10", "overlap_0_10", "activity_evidence_0_10"), state: evidence, reason, confidence: decimal });
const probability = shape({ value: decimal, state: evidence, reason });
const stated = (check: Check) => shape({ value: orNull(check), state: evidence, reason });
const money = orNull(shape({ micros: text, currency: str }));
const sourceRef = shape({ url: str, title: orNull(text), observedAt: str, fetchStatus: oneOf("ok", "parked", "redirect", "blocked", "error", "not_checked") });
const observationRef = shape({ operationId: str, payloadSha256: str });

const baseline = both(observationRef, shape({
  assessedAt: str, freshness, threat: score, serviceOverlap: score, geographicOverlap: probability,
  hasPricing: stated(bool), marketPosition: stated(oneOf("small", "startup", "established", "enterprise")),
  explanation: text, factors: shape({ helps: list(text), hurts: list(text) }),
}));
const adActivity = both(observationRef, shape({
  checkedAt: str, freshness, status: evidence, reason, adCount: shape({ value: orNull(num), approximate: bool }), lastShownDate: orNull(text),
  formats: list(oneOf("text", "image", "video", "unknown")), activityEvidence: score, adCopyConcern: score, sourceUrl: sourceRef,
}));
const competitor = both(observationRef, shape({
  subjectKey: str, name: str, canonicalDomain: text, verifiedHomeUrl: orNull(sourceRef), homepageStatus: sourceRef,
  monitoringSince: orNull(str), lastSuccessfulCheckAt: orNull(str), freshness, sitePageCount: stated(num), monitoredPageCount: num, active: bool,
  baseline: orNull(baseline), adActivity: orNull(adActivity),
}));
const change = both(observationRef, shape({
  competitorSubjectKey: str, detectedAt: str, pageUrl: sourceRef, pageTitle: orNull(text),
  changeType: oneOf("content_changed", "redirect_external", "website_parked", "site_unavailable"),
  significance: shape({ value: orNull(oneOf("critical", "notable", "minor", "noise")), confidence: decimal }),
  category: shape({ value: orNull(oneOf("new_service", "new_content", "pricing_update", "rebrand", "site_down", "other")), confidence: decimal }),
  isNewService: probability, isPricingChange: probability, impact: score, summary: text, addedSentences: list(text), removedSentences: list(text),
  verdict: orNull(shape({ verdict: oneOf("accurate", "inaccurate"), note: text, decidedAt: str, decidedBy: text })), published: bool,
}));
const campaign = shape({ name: text, status: text, type: text, cost: money, clicks: num, impressions: num, conversions: text });
const searchAd = shape({ campaign: text, adGroup: text, headlines: list(text), descriptions: list(text), finalUrl: text, impressions: num, clicks: num, conversions: text, cost: money });
const ownAds = both(observationRef, shape({
  period: shape({ start: str, end: str, daysWithData: num }), checkedAt: str, totalsFreshness: freshness, scoresFreshness: freshness,
  totals: shape({ spend: money, clicks: orNull(num), impressions: orNull(num), conversions: decimal, ctrPercent: decimal, costPerConversion: money, metricsState: evidence, metricsReason: reason }),
  campaigns: list(campaign), activeSearchAds: list(searchAd),
  scores: shape({ performance: score, measurementGap: score, adCopy: score, landingPageMismatch: score }),
  focus: shape({ label: orNull(text) }), findings: shape({ copyDriver: orNull(text), landingPageDriver: orNull(text) }), campaignScopeNote: text,
}));
const selfAssessment = shape({
  assessedAt: str, freshness,
  scores: shape(Object.fromEntries(["positioning", "serviceCoverage", "geographicMessaging", "pricingClarity", "differentiation", "competitiveReadiness", "overall"].map(key => [key, score]))),
  strengths: list(text), weaknesses: list(text), recommendedActions: list(text),
});
const manifest = shape({ manifestId: str, revision: num, reportTitle: text, publishedAt: str, publishedBy: text, status: oneOf("published", "withdrawn"), itemCount: num });
const intent = shape({ kind: oneOf("run_scan", "run_ads_review", "run_self_assessment"), state: oneOf("queued", "leased", "succeeded", "failed", "rejected", "expired"), requestedAt: str });

export const isTenantView = shape({
  tenantKey: str, tenantName: str, monitoring: oneOf("active", "paused", "not_configured"),
  latestScan: orNull(shape({ state: oneOf("completed", "partial", "failed"), completedAt: orNull(str), freshness })),
  competitors: list(competitor), changes: list(change), ownAds: orNull(ownAds), selfAssessment: orNull(selfAssessment),
  manifest: orNull(manifest), intents: list(intent), providerAccountRef: orNull(str), scopeKey: orNull(str),
});
