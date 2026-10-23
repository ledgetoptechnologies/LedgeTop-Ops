// Synthetic Competitor Intel sample data for UI fixtures only. Every business
// is invented and every domain uses the reserved .example TLD.
import type {
  ClientCompetitorReport, ClientScore, CompetitorIntelTriageRow, Probability, Score, ScoreScale, StaffChange, StaffCompetitor, StaffTenantView,
} from "../src/competitor-intel";
import { confidenceBand } from "../src/competitor-intel";

const hex = (seed: number) => seed.toString(16).padStart(2, "0").repeat(32);
const op = (n: number) => ({ operationId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, payloadSha256: hex(n) });
const score = (value: string | null, scale: ScoreScale = "concern_0_10", confidence: string | null = "0.72"): Score =>
  value === null ? { value: null, scale, state: "unknown", reason: "too_little_content", confidence: null } : { value, scale, state: "observed", reason: null, confidence };
const probability = (value: string): Probability => ({ value, state: "observed", reason: null });
const source = (url: string, title: string | null = null) => ({ url, title, observedAt: "2026-10-20T14:05:00Z", fetchStatus: "ok" as const });

const competitors: StaffCompetitor[] = [
  { ...op(1), subjectKey: "comp:summit", name: "Summit Ridge Roofing", canonicalDomain: "summitridge.example",
    verifiedHomeUrl: source("https://summitridge.example/", "Summit Ridge Roofing"), homepageStatus: source("https://summitridge.example/"),
    monitoringSince: "2026-06-02T15:00:00Z", lastSuccessfulCheckAt: "2026-10-20T14:05:00Z", freshness: "current",
    sitePageCount: { value: 48, state: "observed", reason: null }, monitoredPageCount: 8, active: true,
    baseline: { ...op(2), assessedAt: "2026-09-14T16:00:00Z", freshness: "current", threat: score("7.4", "concern_0_10", "0.83"),
      serviceOverlap: score("8.1", "overlap_0_10", "0.77"), geographicOverlap: probability("0.86"),
      hasPricing: { value: true, state: "observed", reason: null }, marketPosition: { value: "established", state: "observed", reason: null },
      explanation: "Offers the same storm-damage inspections in the same three counties and now advertises drone roof reports.",
      factors: { helps: ["Publishes starting prices", "Strong review count on its homepage"], hurts: ["No financing options listed"] } },
    adActivity: { ...op(3), checkedAt: "2026-10-19T09:00:00Z", freshness: "current", status: "observed", reason: null,
      adCount: { value: 14, approximate: true }, lastShownDate: "2026-10-18", formats: ["text", "image"],
      activityEvidence: score("6.8", "activity_evidence_0_10"), adCopyConcern: score("5.2"),
      sourceUrl: source("https://adstransparency.google.com/?region=US&domain=summitridge.example") } },
  { ...op(4), subjectKey: "comp:lakeside", name: "Lakeside Exteriors", canonicalDomain: "lakeside-exteriors.example",
    verifiedHomeUrl: source("https://lakeside-exteriors.example/"), homepageStatus: source("https://lakeside-exteriors.example/"),
    monitoringSince: "2026-06-02T15:00:00Z", lastSuccessfulCheckAt: "2026-10-08T14:05:00Z", freshness: "stale",
    sitePageCount: { value: null, state: "unknown", reason: "not_checked" }, monitoredPageCount: 5, active: true,
    baseline: { ...op(5), assessedAt: "2026-07-01T16:00:00Z", freshness: "stale", threat: score("4.6", "concern_0_10", "0.55"),
      serviceOverlap: score("5.0", "overlap_0_10", "0.61"), geographicOverlap: probability("0.42"),
      hasPricing: { value: false, state: "observed", reason: null }, marketPosition: { value: "small", state: "observed", reason: null },
      explanation: "Mostly siding and gutters; roofing is a secondary service and their service area only partly overlaps.",
      factors: { helps: ["Fast quote turnaround promised"], hurts: ["Roofing pages are thin", "No pricing shown"] } },
    adActivity: { ...op(6), checkedAt: "2026-10-01T09:00:00Z", freshness: "stale", status: "none_found", reason: null,
      adCount: { value: null, approximate: false }, lastShownDate: null, formats: [],
      activityEvidence: { value: null, scale: "activity_evidence_0_10", state: "none_found", reason: null, confidence: null },
      adCopyConcern: { value: null, scale: "concern_0_10", state: "none_found", reason: null, confidence: null },
      sourceUrl: source("https://adstransparency.google.com/?region=US&domain=lakeside-exteriors.example") } },
  { ...op(7), subjectKey: "comp:northpine", name: "North Pine Home Pros", canonicalDomain: "northpine.example",
    verifiedHomeUrl: null, homepageStatus: { ...source("https://northpine.example/"), fetchStatus: "blocked" },
    monitoringSince: "2026-09-20T15:00:00Z", lastSuccessfulCheckAt: null, freshness: "stale",
    sitePageCount: { value: null, state: "blocked", reason: "bot_challenge" }, monitoredPageCount: 0, active: true,
    baseline: null, adActivity: null },
];

const change = (n: number, partial: Partial<StaffChange>): StaffChange => ({ ...op(n), competitorSubjectKey: "comp:summit", detectedAt: "2026-10-20T14:05:00Z",
  pageUrl: source("https://summitridge.example/services/drone-inspections", "Drone roof inspections"), pageTitle: "Drone roof inspections",
  changeType: "content_changed", significance: { value: "notable", confidence: "0.81" }, category: { value: "new_service", confidence: "0.77" },
  isNewService: probability("0.88"), isPricingChange: probability("0.12"), impact: score("7.1"),
  summary: "Added a drone roof inspection service with same-day photo reports.",
  addedSentences: ["Same-day drone roof inspections with a full photo report.", "Free for insurance claims over $5,000."],
  removedSentences: ["Call for a ladder inspection appointment."], verdict: null, published: false, ...partial });

const changes: StaffChange[] = [
  change(10, {}),
  change(11, { significance: { value: "critical", confidence: "0.9" }, category: { value: "pricing_update", confidence: "0.84" },
    pageUrl: source("https://summitridge.example/pricing", "Pricing"), pageTitle: "Pricing", detectedAt: "2026-10-19T14:05:00Z",
    isNewService: probability("0.05"), isPricingChange: probability("0.94"), impact: score("8.3"),
    summary: "Cut the advertised starting price for a full roof replacement by about 12%.",
    addedSentences: ["Full replacements starting at $8,900."], removedSentences: ["Full replacements starting at $9,950."] }),
  change(12, { competitorSubjectKey: "comp:lakeside", significance: { value: "minor", confidence: "0.58" }, category: { value: "new_content", confidence: "0.62" },
    pageUrl: source("https://lakeside-exteriors.example/blog/fall-gutters", "Fall gutter checklist"), pageTitle: "Fall gutter checklist",
    detectedAt: "2026-10-07T14:05:00Z", impact: score("2.1"), isNewService: probability("0.03"), isPricingChange: probability("0.01"),
    summary: "Published a seasonal gutter-cleaning blog post.", addedSentences: [], removedSentences: [],
    verdict: { verdict: "accurate", note: "", decidedAt: "2026-10-08T15:00:00Z", decidedBy: "Beau Koltz" } }),
  change(13, { significance: { value: "noise", confidence: "0.45" }, category: { value: "other", confidence: "0.4" }, impact: score("0.6"),
    detectedAt: "2026-10-05T14:05:00Z", summary: "Footer copyright year changed.", addedSentences: [], removedSentences: [],
    verdict: { verdict: "inaccurate", note: "Not a real change.", decidedAt: "2026-10-06T15:00:00Z", decidedBy: "Beau Koltz" } }),
  change(14, { significance: { value: "notable", confidence: "0.79" }, category: { value: "new_service", confidence: "0.71" },
    pageUrl: source("https://summitridge.example/commercial", "Commercial roofing"), pageTitle: "Commercial roofing",
    detectedAt: "2026-09-28T14:05:00Z", summary: "Launched a commercial flat-roof maintenance plan.", impact: score("6.2"),
    verdict: { verdict: "accurate", note: "Confirmed on their site.", decidedAt: "2026-09-29T15:00:00Z", decidedBy: "Beau Koltz" }, published: true }),
];

export const sampleStaffTenant: StaffTenantView = {
  tenantKey: "sample-riverbend", tenantName: "Riverbend Roofing (sample)", monitoring: "active",
  latestScan: { state: "partial", completedAt: "2026-10-20T14:20:00Z", freshness: "current" },
  competitors, changes,
  ownAds: { ...op(20), period: { start: "2026-09-21", end: "2026-10-20", daysWithData: 30 }, checkedAt: "2026-09-12T08:00:00Z", totalsFreshness: "current", scoresFreshness: "stale",
    totals: { spend: { micros: "1842375000", currency: "USD" }, clicks: 1236, impressions: 28410, conversions: "41.00", ctrPercent: "4.35",
      costPerConversion: { micros: "44935975", currency: "USD" }, metricsState: "observed", metricsReason: null },
    campaigns: [
      { name: "Storm damage – Search", status: "Enabled", type: "Search", cost: { micros: "1210400000", currency: "USD" }, clicks: 842, impressions: 17320, conversions: "31.00" },
      { name: "Brand – Search", status: "Enabled", type: "Search", cost: { micros: "631975000", currency: "USD" }, clicks: 394, impressions: 11090, conversions: "10.00" },
    ],
    activeSearchAds: [{ campaign: "Storm damage – Search", adGroup: "Hail repair", headlines: ["Hail Damage Roof Repair", "Free Same-Week Inspection", "Local Since 1998"],
      descriptions: ["Licensed local roofers. Insurance claim help included."], finalUrl: "https://riverbend.example/hail-repair",
      impressions: 9120, clicks: 488, conversions: "19.00", cost: { micros: "702300000", currency: "USD" } }],
    scores: { performance: score("3.2"), measurementGap: score("6.4", "concern_0_10", "0.66"), adCopy: score("2.8"), landingPageMismatch: score("4.1") },
    focus: { label: "Check that phone calls from ads are counted as leads" },
    findings: { copyDriver: "Ads mention insurance help, which matches what searchers ask for.", landingPageDriver: "The hail repair page does not repeat the same-week inspection promise." },
    campaignScopeNote: "Totals cover search campaigns only; no video or display campaigns were active." },
  selfAssessment: { assessedAt: "2026-10-01T16:00:00Z", freshness: "current",
    scores: { positioning: score("3.5"), serviceCoverage: score("4.8"), geographicMessaging: score("6.9"), pricingClarity: score("7.6"),
      differentiation: score("4.2"), competitiveReadiness: score("5.1"), overall: score("5.4") },
    strengths: ["Long local track record", "Clear insurance-claim help"], weaknesses: ["No prices on the site", "Service area is not listed clearly"],
    recommendedActions: ["Add a starting-price range for replacements", "List the counties served on the homepage"] },
  manifest: { manifestId: "11111111-1111-4111-8111-111111111111", revision: 2, reportTitle: "Competitor report · September 2026",
    publishedAt: "2026-09-30T17:00:00Z", publishedBy: "Beau Koltz", status: "published", itemCount: 11 },
  intents: [], providerAccountRef: "ads-sample-1", scopeKey: "self:riverbend",
};

export const sampleTriageRows: CompetitorIntelTriageRow[] = [
  { tenantKey: "sample-riverbend", tenantName: "Riverbend Roofing (sample)", monitoring: "active", activeCompetitors: 3,
    unreviewedChanges: { critical: 1, notable: 1, minor: 0, noise: 0 }, unpublishedReviewed: 1,
    latestScan: { state: "partial", completedAt: "2026-10-20T14:20:00Z", freshness: "current" }, adsCheckup: "current",
    lastPublication: { publishedAt: "2026-09-30T17:00:00Z", status: "published" } },
  { tenantKey: "sample-ledge-top", tenantName: "Ledge Top (sample)", monitoring: "active", activeCompetitors: 6,
    unreviewedChanges: { critical: 0, notable: 2, minor: 5, noise: 3 }, unpublishedReviewed: 0,
    latestScan: { state: "completed", completedAt: "2026-10-20T11:00:00Z", freshness: "current" }, adsCheckup: "stale", lastPublication: null },
  { tenantKey: "sample-harbor", tenantName: "Harbor Dental (sample)", monitoring: "active", activeCompetitors: 4,
    unreviewedChanges: { critical: 0, notable: 0, minor: 0, noise: 0 }, unpublishedReviewed: 0,
    latestScan: { state: "failed", completedAt: null, freshness: "stale" }, adsCheckup: "not_connected",
    lastPublication: { publishedAt: "2026-08-31T17:00:00Z", status: "withdrawn" } },
  { tenantKey: "sample-oak", tenantName: "Oak Street Bakery (sample)", monitoring: "not_configured", activeCompetitors: 0,
    unreviewedChanges: { critical: 0, notable: 0, minor: 0, noise: 0 }, unpublishedReviewed: 0, latestScan: null, adsCheckup: "not_connected", lastPublication: null },
];

const label = (value: Score): ClientScore => ({ value: value.value, scale: value.scale, state: value.state, reason: value.reason,
  confidence: confidenceBand(value.confidence) });

/** The client.v1 projection of the sample's published manifest. */
export const sampleClientReport: ClientCompetitorReport = {
  reportTitle: "Competitor report · October 2026", publishedAt: "2026-10-21T17:00:00Z",
  coverage: { competitorsMonitored: 3, lastWebsiteCheckAt: "2026-10-20T14:05:00Z", freshness: "current" },
  competitors: competitors.filter(item => item.baseline).map(item => ({ name: item.name, canonicalDomain: item.canonicalDomain,
    verifiedHomeUrl: item.verifiedHomeUrl && { url: item.verifiedHomeUrl.url, title: item.verifiedHomeUrl.title },
    threat: label(item.baseline!.threat), serviceOverlap: label(item.baseline!.serviceOverlap), geographicOverlap: item.baseline!.geographicOverlap,
    explanation: item.baseline!.explanation, factors: item.baseline!.factors,
    baseline: { assessedAt: item.baseline!.assessedAt, freshness: item.baseline!.freshness },
    adActivity: item.adActivity && { checkedAt: item.adActivity.checkedAt, status: item.adActivity.status, reason: item.adActivity.reason, adCount: item.adActivity.adCount,
      lastShownDate: item.adActivity.lastShownDate, sourceUrl: item.adActivity.sourceUrl.url, freshness: item.adActivity.freshness } })),
  changes: changes.filter(item => item.verdict?.verdict === "accurate").map(item => ({ competitorName: competitors.find(c => c.subjectKey === item.competitorSubjectKey)!.name,
    detectedAt: item.detectedAt, pageUrl: item.pageUrl.url, pageTitle: item.pageTitle, summary: item.summary, significance: item.significance.value,
    category: item.category.value, addedSentences: item.addedSentences, removedSentences: item.removedSentences })),
  ownAds: { period: { start: "2026-09-21", end: "2026-10-20" }, checkedAt: "2026-09-12T08:00:00Z", totalsFreshness: "current", scoresFreshness: "stale",
    totals: { spend: { micros: "1842375000", currency: "USD" }, clicks: 1236, impressions: 28410, conversions: "41.00",
      costPerConversion: { micros: "44935975", currency: "USD" }, metricsState: "observed", metricsReason: null },
    scores: { performance: label(score("3.2")), measurementGap: label(score("6.4", "concern_0_10", "0.66")), adCopy: label(score("2.8")), landingPageMismatch: label(score("4.1")) },
    focus: "Check that phone calls from ads are counted as leads",
    findings: { copyDriver: "Ads mention insurance help, which matches what searchers ask for.", landingPageDriver: "The hail repair page does not repeat the same-week inspection promise." },
    campaigns: [
      { name: "Storm damage – Search", status: "Enabled", cost: { micros: "1210400000", currency: "USD" }, clicks: 842, conversions: "31.00" },
      { name: "Brand – Search", status: "Enabled", cost: { micros: "631975000", currency: "USD" }, clicks: 394, conversions: "10.00" },
    ] },
};
