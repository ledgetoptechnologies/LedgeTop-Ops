/**
 * Competitor Intel v1 display models and rules. Design only: no route reads or
 * writes these yet. Value shapes follow the frozen planning contracts in the
 * ledge-top-ops knowledge project:
 *   competitor-intel/frozen/ingest-wire-envelope-v1.md (sha256 a60a11dd…7b675b32)
 *   competitor-intel/frozen/command-intents-and-read-surface-v1.md (sha256 faf08a4a…780fc43e)
 * The staff and portal read DTOs (companion section E) are Codex-owned; the
 * interfaces below are the UI's expectation of them and must be reconciled
 * before activation. A valid shape is never proof of tenant authority.
 */

export type Decimal = string;
export type Timestamp = string;
export type Freshness = "current" | "stale";

export type EvidenceState = "observed" | "none_found" | "unknown" | "blocked" | "failed" | "not_connected";
export type UnknownReason = "not_configured" | "not_checked" | "robots_blocked" | "bot_challenge" | "fetch_timeout" | "http_error"
  | "parked" | "redirected_offsite" | "too_little_content" | "insufficient_ad_copy" | "page_unreadable" | "no_ads_account"
  | "provider_error" | "provider_metrics_failed" | "too_old" | "legacy_semantics" | "ssrf_blocked";
export type ScoreScale = "concern_0_10" | "overlap_0_10" | "activity_evidence_0_10";

export interface Score { value: Decimal | null; scale: ScoreScale; state: EvidenceState; reason: UnknownReason | null; confidence: Decimal | null }
export interface Probability { value: Decimal | null; state: EvidenceState; reason: UnknownReason | null }
export interface Stated<T> { value: T | null; state: EvidenceState; reason: UnknownReason | null }
export type Money = { micros: string; currency: string } | null;
export interface Count { attempted: number; succeeded: number }
export type FetchStatus = "ok" | "parked" | "redirect" | "blocked" | "error" | "not_checked";
export interface SourceRef { url: string; title: string | null; observedAt: Timestamp; fetchStatus: FetchStatus }

export type Significance = "critical" | "notable" | "minor" | "noise";
export type ChangeCategory = "new_service" | "new_content" | "pricing_update" | "rebrand" | "site_down" | "other";
export type ChangeType = "content_changed" | "redirect_external" | "website_parked" | "site_unavailable";
export type MarketPosition = "small" | "startup" | "established" | "enterprise";
export type ConfidenceBand = "low" | "medium" | "high";
/** A pinned observation the staff publish intent names (command intents section B). */
export interface ObservationRef { operationId: string; payloadSha256: string }

// ---- Staff (all-tenant) read view ----

export interface CompetitorIntelTriageRow {
  tenantKey: string;
  tenantName: string;
  monitoring: "active" | "paused" | "not_configured";
  activeCompetitors: number;
  unreviewedChanges: Record<Significance, number>;
  unpublishedReviewed: number;
  latestScan: { state: "completed" | "partial" | "failed"; completedAt: Timestamp | null; freshness: Freshness } | null;
  adsCheckup: Freshness | "not_connected";
  lastPublication: { publishedAt: Timestamp; status: "published" | "withdrawn" } | null;
}

export interface StaffBaseline extends ObservationRef {
  assessedAt: Timestamp; freshness: Freshness; threat: Score; serviceOverlap: Score; geographicOverlap: Probability;
  hasPricing: Stated<boolean>; marketPosition: Stated<MarketPosition>; explanation: string; factors: { helps: string[]; hurts: string[] };
}
export interface StaffAdActivity extends ObservationRef {
  checkedAt: Timestamp; freshness: Freshness; status: EvidenceState; reason: UnknownReason | null;
  adCount: { value: number | null; approximate: boolean }; lastShownDate: string | null;
  formats: ("text" | "image" | "video" | "unknown")[]; activityEvidence: Score; adCopyConcern: Score; sourceUrl: SourceRef;
}
export interface StaffCompetitor extends ObservationRef {
  subjectKey: string; name: string; canonicalDomain: string; verifiedHomeUrl: SourceRef | null; homepageStatus: SourceRef;
  monitoringSince: Timestamp | null; lastSuccessfulCheckAt: Timestamp | null; freshness: Freshness;
  sitePageCount: Stated<number>; monitoredPageCount: number; active: boolean;
  baseline: StaffBaseline | null; adActivity: StaffAdActivity | null;
}
export interface StaffChange extends ObservationRef {
  competitorSubjectKey: string; detectedAt: Timestamp; pageUrl: SourceRef; pageTitle: string | null; changeType: ChangeType;
  significance: { value: Significance | null; confidence: Decimal | null };
  category: { value: ChangeCategory | null; confidence: Decimal | null };
  isNewService: Probability; isPricingChange: Probability; impact: Score; summary: string;
  addedSentences: string[]; removedSentences: string[];
  verdict: { verdict: "accurate" | "inaccurate"; note: string; decidedAt: Timestamp; decidedBy: string } | null;
  published: boolean;
}
export interface AdsCampaign { name: string; status: string; type: string; cost: Money; clicks: number; impressions: number; conversions: Decimal }
export interface ActiveSearchAd { campaign: string; adGroup: string; headlines: string[]; descriptions: string[]; finalUrl: string; impressions: number; clicks: number; conversions: Decimal; cost: Money }
export interface OwnAdsCheckup extends ObservationRef {
  period: { start: string; end: string; daysWithData: number };
  /** Envelope completedAt of the checkup; scores age on their own 30-day window. */
  checkedAt: Timestamp; totalsFreshness: Freshness; scoresFreshness: Freshness;
  totals: { spend: Money; clicks: number | null; impressions: number | null; conversions: Decimal | null; ctrPercent: Decimal | null; costPerConversion: Money;
    metricsState: EvidenceState; metricsReason: UnknownReason | null };
  campaigns: AdsCampaign[];
  activeSearchAds: ActiveSearchAd[];
  scores: { performance: Score; measurementGap: Score; adCopy: Score; landingPageMismatch: Score };
  focus: { label: string | null }; findings: { copyDriver: string | null; landingPageDriver: string | null }; campaignScopeNote: string;
}
export interface SelfAssessment {
  assessedAt: Timestamp; freshness: Freshness;
  scores: Record<"positioning" | "serviceCoverage" | "geographicMessaging" | "pricingClarity" | "differentiation" | "competitiveReadiness" | "overall", Score>;
  strengths: string[]; weaknesses: string[]; recommendedActions: string[];
}
export interface StaffManifest { manifestId: string; revision: number; reportTitle: string; publishedAt: Timestamp; publishedBy: string; status: "published" | "withdrawn"; itemCount: number }
export type WorkerIntentKind = "run_scan" | "run_ads_review" | "run_self_assessment";
export interface StaffIntent { kind: WorkerIntentKind; state: "queued" | "leased" | "succeeded" | "failed" | "rejected" | "expired"; requestedAt: Timestamp }
export interface StaffTenantView {
  tenantKey: string; tenantName: string; monitoring: CompetitorIntelTriageRow["monitoring"];
  latestScan: CompetitorIntelTriageRow["latestScan"];
  competitors: StaffCompetitor[]; changes: StaffChange[]; ownAds: OwnAdsCheckup | null; selfAssessment: SelfAssessment | null;
  manifest: StaffManifest | null; intents: StaffIntent[]; providerAccountRef: string | null; scopeKey: string | null;
}

/** Ops-owned command intents the staff UI may request (command intents section B). */
export type CompetitorIntelCommand =
  | { kind: "run_scan"; params: { scanType: "full" | "website" | "ads"; competitorSubjectKeys: string[] } }
  | { kind: "run_ads_review"; params: { providerAccountRef: string } }
  | { kind: "run_self_assessment"; params: { scopeKey: string } }
  | { kind: "set_verdict"; params: { changeOperationId: string; verdict: "accurate" | "inaccurate"; note: string } }
  | { kind: "publish"; params: { items: ObservationRef[]; reportTitle: string } }
  | { kind: "withdraw"; params: { manifestId: string; reason: string } };
export const DAILY_INTENT_LIMITS: Record<WorkerIntentKind, number> = { run_scan: 3, run_ads_review: 3, run_self_assessment: 2 };

// ---- Portal (client.v1) read view: only pinned manifest items, labels not numbers ----

export interface ClientScore { value: Decimal | null; scale: ScoreScale; state: EvidenceState; reason: UnknownReason | null; confidence: ConfidenceBand | null }
export interface ClientCompetitorReport {
  reportTitle: string; publishedAt: Timestamp;
  coverage: { competitorsMonitored: number; lastWebsiteCheckAt: Timestamp | null; freshness: Freshness };
  competitors: {
    name: string; canonicalDomain: string; verifiedHomeUrl: { url: string; title: string | null } | null;
    threat: ClientScore | null; serviceOverlap: ClientScore | null; geographicOverlap: Probability | null;
    explanation: string | null; factors: { helps: string[]; hurts: string[] } | null;
    /** Baseline assessment age; null with no pinned baseline. */
    baseline: { assessedAt: Timestamp; freshness: Freshness } | null;
    adActivity: { checkedAt: Timestamp; status: EvidenceState; reason: UnknownReason | null; adCount: { value: number | null; approximate: boolean };
      lastShownDate: string | null; sourceUrl: string; freshness: Freshness } | null;
  }[];
  changes: { competitorName: string; detectedAt: Timestamp; pageUrl: string; pageTitle: string | null; summary: string;
    significance: Significance | null; category: ChangeCategory | null; addedSentences: string[]; removedSentences: string[] }[];
  ownAds: { period: { start: string; end: string }; checkedAt: Timestamp; totalsFreshness: Freshness; scoresFreshness: Freshness;
    totals: { spend: Money; clicks: number | null; impressions: number | null; conversions: Decimal | null; costPerConversion: Money; metricsState: EvidenceState; metricsReason: UnknownReason | null };
    scores: { performance: ClientScore; measurementGap: ClientScore; adCopy: ClientScore; landingPageMismatch: ClientScore };
    focus: string | null; findings: { copyDriver: string | null; landingPageDriver: string | null };
    campaigns: { name: string; status: string; cost: Money; clicks: number; conversions: Decimal }[] } | null;
}

// ---- Display rules ----

const DECIMAL = /^(-?)(\d{1,15})(?:\.(\d{1,6}))?$/;
/** Exact decimal string -> integer millionths, so bands never depend on float rounding. */
export function decimalMicros(value: Decimal): bigint {
  const match = DECIMAL.exec(value);
  if (!match) throw new TypeError("Invalid decimal");
  const micros = BigInt(match[2]!) * 1_000_000n + BigInt((match[3] ?? "").padEnd(6, "0"));
  return match[1] ? -micros : micros;
}

/** Frozen half-open bands: Low [0, .50), Medium [.50, .80), High [.80, 1]. */
export function confidenceBand(confidence: Decimal | null): ConfidenceBand | null {
  if (confidence === null) return null;
  const micros = decimalMicros(confidence);
  return micros < 500_000n ? "low" : micros < 800_000n ? "medium" : "high";
}
export function confidenceText(band: ConfidenceBand | null): string {
  return band ? `${band[0]!.toUpperCase()}${band.slice(1)} confidence` : "Confidence unavailable";
}

const MEANINGS: Record<ScoreScale, [string, string, string]> = {
  concern_0_10: ["Low concern", "Moderate concern", "High concern"],
  overlap_0_10: ["Limited overlap", "Partial overlap", "Strong overlap"],
  activity_evidence_0_10: ["Little ad activity", "Some ad activity", "Strong ad activity"],
};
export type ScoreLevel = 0 | 1 | 2;
/** UI bands on the 0-10 scales: [0, 4), [4, 7), [7, 10]. Display copy, not part of the frozen wire. */
export function scoreLevel(value: Decimal): ScoreLevel {
  const micros = decimalMicros(value);
  return micros < 4_000_000n ? 0 : micros < 7_000_000n ? 1 : 2;
}
export function scoreMeaning(score: Pick<Score, "value" | "scale" | "state" | "reason">): string {
  if (score.state !== "observed" || score.value === null) return evidenceText(score.state, score.reason);
  return MEANINGS[score.scale][scoreLevel(score.value)];
}
/** One decimal place, rounded half-up from the exact decimal: "7.4". */
export function scoreNumber(value: Decimal): string {
  const tenths = (decimalMicros(value) + 50_000n) / 100_000n;
  return `${tenths / 10n}.${tenths % 10n}`;
}
export function percentText(probability: Probability): string {
  if (probability.state !== "observed" || probability.value === null) return evidenceText(probability.state, probability.reason);
  return `${(decimalMicros(probability.value) + 5_000n) / 10_000n}%`;
}

export const UNKNOWN_REASON_TEXT: Record<UnknownReason, string> = {
  not_configured: "Not set up yet",
  not_checked: "Not checked yet",
  robots_blocked: "The site asks automated checks not to read this page",
  bot_challenge: "The site blocked the automated check",
  fetch_timeout: "The site took too long to respond",
  http_error: "The site returned an error",
  parked: "The domain is parked",
  redirected_offsite: "The site redirects to another domain",
  too_little_content: "Not enough page content to assess",
  insufficient_ad_copy: "Not enough ad text to assess",
  page_unreadable: "The page could not be read",
  no_ads_account: "No Google Ads account connected",
  provider_error: "Google Ads did not respond",
  provider_metrics_failed: "Google Ads metrics were unavailable",
  too_old: "The last result is too old to use",
  legacy_semantics: "Older result in a format we no longer show",
  ssrf_blocked: "The address was not safe to check",
};
export function evidenceText(state: EvidenceState, reason: UnknownReason | null): string {
  if (state === "none_found") return "None found";
  if (state === "observed") return "Observed";
  if (reason) return UNKNOWN_REASON_TEXT[reason];
  return state === "not_connected" ? "Not connected" : state === "blocked" ? "Blocked" : state === "failed" ? "Check failed" : "Unknown";
}

export const SIGNIFICANCE_TEXT: Record<Significance, string> = { critical: "Critical", notable: "Notable", minor: "Minor", noise: "Noise" };
export const CATEGORY_TEXT: Record<ChangeCategory, string> = {
  new_service: "New service", new_content: "New content", pricing_update: "Pricing update", rebrand: "Rebrand", site_down: "Site down", other: "Other change",
};

/**
 * The frozen wire only requires a null cost when conversions are exactly zero;
 * a null cost with unknown or positive conversions is merely unavailable.
 */
export function costPerConversionText(totals: { conversions: Decimal | null; costPerConversion: Money }): string {
  if (totals.costPerConversion) return moneyText(totals.costPerConversion);
  return totals.conversions !== null && decimalMicros(totals.conversions) === 0n ? "No conversions yet" : "Unavailable";
}

const minorDigits = (currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
/** Integer micros -> currency text, rounded half-up (away from zero) at the currency's minor unit. */
export function moneyText(money: Money, locale = "en-US"): string {
  if (!money) return "—";
  if (!/^-?\d{1,19}$/.test(money.micros)) throw new TypeError("Invalid micros");
  const digits = minorDigits(money.currency), raw = BigInt(money.micros), negative = raw < 0n, magnitude = negative ? -raw : raw;
  const step = 10n ** BigInt(6 - digits), minor = (magnitude + step / 2n) / step, unit = 10n ** BigInt(digits);
  const whole = minor / unit, fraction = digits ? `.${String(minor % unit).padStart(digits, "0")}` : "";
  const exact = `${negative && minor ? "-" : ""}${whole}${fraction}`;
  return new Intl.NumberFormat(locale, { style: "currency", currency: money.currency, minimumFractionDigits: digits, maximumFractionDigits: digits })
    .format(exact as unknown as number);
}
