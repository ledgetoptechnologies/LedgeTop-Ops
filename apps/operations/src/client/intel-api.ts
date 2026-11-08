import type { EvidenceState, FetchStatus, StaffTenantView } from "@ltds/shared/competitor-intel";
import { ApiError, api } from "./api";
import { bool, isTenantView, list, num, oneOf, orNull, shape, str, text, type Check } from "./intel-validate";
import { isGoogleAdsInt63 } from "./intel-format";

/** Ledge Top's own businesses, as the server lets this person see them. Intel is internal: clients never see it. */
export type IntelBusiness = { key: string; name: string };
export type IntelRange = "7d" | "28d" | "90d";
export const INTEL_RANGES: ReadonlyArray<{ value: IntelRange; label: string }> = [
  { value: "7d", label: "7 days" }, { value: "28d", label: "28 days" }, { value: "90d", label: "90 days" },
];
type Freshness = { fetchedAt: string; stale: boolean };
type Span = { start: string; end: string };
type Receipt = { operationId: string; payloadSha256: string; completedAt: string; acceptedAt: string };

/** Why a source fact is missing, as the signed Intel feed reports it. */
export type SourceReason = "not_configured" | "not_checked" | "robots_blocked" | "bot_challenge" | "fetch_timeout" | "http_error" | "parked"
  | "redirected_offsite" | "too_little_content" | "insufficient_ad_copy" | "page_unreadable" | "no_ads_account" | "provider_error"
  | "provider_metrics_failed" | "too_old" | "legacy_semantics" | "ssrf_blocked" | "consent_missing" | "no_property_selected"
  | "provider_data_delay" | "no_account" | "data_limited" | "source_stale";
/** A monitored fact: `value` is only present when `state` is observed; otherwise `reason` says why it is unknown. */
export type StatedFact<T> = { value: T | null; state: EvidenceState; reason: SourceReason | null };

/**
 * Google Search Console for one exact source period. CTR is a fraction (0.1 is 10%). A null total, CTR or position is one
 * Google didn't report and is shown as not available, never as zero. There are no prior-period totals, only the
 * percentage changes the source itself reported.
 */
export type SearchRow = { clicks: number; impressions: number; ctr: number | null; position: number | null };
export type SearchStats = {
  site: { url: string }; range: Span; freshness: Freshness;
  totals: { clicks: number | null; impressions: number | null; ctr: number | null; position: number | null }; previous: null;
  queries: Array<SearchRow & { query: string }>; pages: Array<SearchRow & { url: string }>;
  daily: Array<{ date: string; clicks: number; impressions: number }>;
  comparison: { previousPeriod: Span & { days: number }; clicksDeltaPercent: string | null; impressionsDeltaPercent: string | null } | null;
  coverage: { state: EvidenceState; reason: SourceReason | null; lastDataDate: string | null; dataRange: Span | null; partial: boolean;
    partialReason: SourceReason | null; limits: string[]; asOf: string | null; rangeSelection: IntelRange };
  receipt: Receipt;
};

/** Ledge Top's own site as the Hermes monitor sees it: pages, technical health and content changes. It is not visitor analytics. */
export type SourceRef = { url: string; title: string | null; observedAt: string; fetchStatus: FetchStatus };
export type SiteChangeType = "content_changed" | "redirect_external" | "website_parked" | "site_unavailable";
export type SiteChange = { pageUrl: SourceRef; changeType: SiteChangeType; summary: string; addedSentences: string[]; removedSentences: string[]; detectedAt: string };
export type WebsiteMonitor = {
  schema: "ops.intel.website-monitor.v1"; site: { canonicalDomain: string }; range: Span; freshness: Freshness;
  monitoredPages: Array<SourceRef & { contentSha256: string; contentLength: number }>;
  changesSincePrevious: SiteChange[];
  technical: { httpsOk: StatedFact<boolean>; sitemapPageCount: StatedFact<number>; robotsAllowsIndexing: StatedFact<boolean>; avgFetchMs: number | null };
  provenance: { source: string; sourceAccountRef: string | null; collectedBy: string; collectedAt: string; asOf: string | null; lastDataDate: string | null;
    dataRange: Span | null; partial: boolean; partialReason: SourceReason | null; limits: string[] };
  receipt: Receipt;
};

/**
 * Google Ads totals for Ledge Top's own advertising over one exact period, as the signed feed reported them. Amounts
 * are exact decimal strings: cost in micros of `currencyCode`, impressions and clicks as whole numbers, conversions
 * with up to six decimals. When `totals.state` isn't "observed" every figure is null and `reason` says why: nothing is
 * shown as zero. `period` and `currencyCode` are null only when no Ads account is connected.
 */
export type GoogleAdsState = "observed" | "unknown" | "failed" | "source_stale" | "no_account";
export type GoogleAdsSummary = {
  schema: "ops.intel.owner-google-ads.v1"; rangeSelection: IntelRange;
  period: { start: string; end: string; days: 7 | 28 | 90; timeZone: string } | null; currencyCode: string | null;
  totals: { costMicros: string | null; impressions: string | null; clicks: string | null; conversions: string | null; state: GoogleAdsState; reason: SourceReason | null };
  freshness: { collectedAt: string; asOf: string | null; state: GoogleAdsState };
  receipt: Receipt;
};

export type OwnerIntelSummarySourceId = "google_ads" | "search_console" | "own_site" | "ga4";
export type OwnerIntelSummarySourceState = "available" | "partial" | "unavailable" | "unconfigured" | "stale";
export type OwnerIntelSummaryMetrics =
  | { currencyCode: string | null; costMicros: string | null; impressions: string | null; clicks: string | null; conversions: string | null }
  | { clicks: number | null; impressions: number | null; ctr: number | null; position: number | null }
  | { monitoredPages: number; changesSincePrevious: number };
export type OwnerIntelSummarySource = {
  id: OwnerIntelSummarySourceId; businessId: string; range: IntelRange; state: OwnerIntelSummarySourceState; reason: string | null;
  metrics: OwnerIntelSummaryMetrics | null;
};
export type OwnerIntelSummary = {
  schema: "ops.intel.owner-summary.v1"; business: { id: string; key: string; name: string }; range: IntelRange; sources: OwnerIntelSummarySource[];
};

/** A section that has nothing to show yet; `code` is the server's reason (not connected, awaiting first data, no data for this period). */
export class IntelUnavailable extends Error {
  constructor(readonly code: string) { super(code); }
}

/** A reply that isn't the documented shape; the view shows it couldn't be loaded instead of rendering it. */
export class IntelMalformed extends Error {}

const day: Check = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const instant: Check = value => typeof value === "string" && !Number.isNaN(Date.parse(value));
const count: Check = value => Number.isSafeInteger(value) && (value as number) >= 0;
const fraction: Check = value => num(value) && (value as number) >= 0 && (value as number) <= 1;
const position: Check = value => num(value) && (value as number) >= 1;
const decimal: Check = value => typeof value === "string" && /^-?\d{1,15}(?:\.\d{1,6})?$/.test(value);
const digest: Check = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const evidence = oneOf("observed", "none_found", "unknown", "blocked", "failed", "not_connected");
const reason = orNull(oneOf("not_configured", "not_checked", "robots_blocked", "bot_challenge", "fetch_timeout", "http_error", "parked",
  "redirected_offsite", "too_little_content", "insufficient_ad_copy", "page_unreadable", "no_ads_account", "provider_error",
  "provider_metrics_failed", "too_old", "legacy_semantics", "ssrf_blocked", "consent_missing", "no_property_selected",
  "provider_data_delay", "no_account", "data_limited", "source_stale"));
const span = shape({ start: day, end: day }), freshness = shape({ fetchedAt: instant, stale: bool });
const receipt = shape({ operationId: str, payloadSha256: digest, completedAt: instant, acceptedAt: instant });
const searchRow = { clicks: count, impressions: count, ctr: orNull(fraction), position: orNull(position) };
const isSearch = shape({
  site: shape({ url: str }), range: span, freshness,
  totals: shape({ clicks: orNull(count), impressions: orNull(count), ctr: orNull(fraction), position: orNull(position) }), previous: value => value === null,
  queries: list(shape({ ...searchRow, query: str })), pages: list(shape({ ...searchRow, url: str })),
  daily: list(shape({ date: day, clicks: count, impressions: count })),
  comparison: orNull(shape({ previousPeriod: shape({ start: day, end: day, days: count }), clicksDeltaPercent: orNull(decimal), impressionsDeltaPercent: orNull(decimal) })),
  coverage: shape({ state: evidence, reason, lastDataDate: orNull(day), dataRange: orNull(span), partial: bool, partialReason: reason,
    limits: list(text), asOf: orNull(instant), rangeSelection: oneOf("7d", "28d", "90d") }),
  receipt,
});
const sourceRef = { url: str, title: orNull(text), observedAt: instant, fetchStatus: oneOf("ok", "parked", "redirect", "blocked", "error", "not_checked") };
const stated = (check: Check) => shape({ value: orNull(check), state: evidence, reason });
const isWebsite = shape({
  schema: value => value === "ops.intel.website-monitor.v1", site: shape({ canonicalDomain: str }), range: span, freshness,
  monitoredPages: list(shape({ ...sourceRef, contentSha256: digest, contentLength: count })),
  changesSincePrevious: list(shape({ pageUrl: shape(sourceRef), changeType: oneOf("content_changed", "redirect_external", "website_parked", "site_unavailable"),
    summary: text, addedSentences: list(text), removedSentences: list(text), detectedAt: instant })),
  technical: shape({ httpsOk: stated(bool), sitemapPageCount: stated(count), robotsAllowsIndexing: stated(bool), avgFetchMs: orNull(count) }),
  provenance: shape({ source: str, sourceAccountRef: orNull(str), collectedBy: str, collectedAt: instant, asOf: orNull(instant), lastDataDate: orNull(day),
    dataRange: orNull(span), partial: bool, partialReason: reason, limits: list(text) }),
  receipt,
});
const whole: Check = isGoogleAdsInt63;
const metric: Check = value => typeof value === "string" && /^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,6})?$/.test(value);
const zone: Check = value => {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try { return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone === value; } catch { return false; }
};
const adsState = oneOf("observed", "unknown", "failed", "source_stale", "no_account");
const adsReason = orNull(oneOf("not_checked", "provider_metrics_failed", "provider_error", "source_stale", "consent_missing", "no_account"));
const isAdsShape = shape({
  schema: value => value === "ops.intel.owner-google-ads.v1", rangeSelection: oneOf("7d", "28d", "90d"),
  period: orNull(shape({ start: day, end: day, days: value => value === 7 || value === 28 || value === 90, timeZone: zone })),
  currencyCode: orNull(value => typeof value === "string" && /^[A-Z]{3}$/.test(value)),
  totals: shape({ costMicros: orNull(whole), impressions: orNull(whole), clicks: orNull(whole), conversions: orNull(metric), state: adsState, reason: adsReason }),
  freshness: shape({ collectedAt: instant, asOf: orNull(instant), state: adsState }),
  receipt,
});
/** Figures and their state must agree: observed has every figure and an account, anything else has none. */
function adsConsistent(value: GoogleAdsSummary) {
  const t = value.totals, figures = [t.costMicros, t.impressions, t.clicks, t.conversions];
  if (value.freshness.state !== t.state) return false;
  if (t.state === "no_account") return value.period === null && value.currencyCode === null && t.reason === "no_account" && figures.every(item => item === null);
  if (value.period === null || value.currencyCode === null) return false;
  return t.state === "observed" ? t.reason === null && figures.every(item => item !== null) : t.reason !== null && figures.every(item => item === null);
}

const isBusinesses = shape({ businesses: list(shape({ key: str, name: str })) });

const ownerSummaryRange = oneOf("7d", "28d", "90d");
const ownerSummaryState = oneOf("available", "partial", "unavailable", "unconfigured", "stale");
const ownerSummarySourceId = oneOf("google_ads", "search_console", "own_site", "ga4");
const ownerSummaryAdsMetrics = shape({ currencyCode: orNull(value => typeof value === "string" && /^[A-Z]{3}$/.test(value)),
  costMicros: orNull(whole), impressions: orNull(whole), clicks: orNull(whole), conversions: orNull(metric) });
const ownerSummarySearchMetrics = shape({ clicks: orNull(count), impressions: orNull(count), ctr: orNull(fraction), position: orNull(position) });
const ownerSummarySiteMetrics = shape({ monitoredPages: count, changesSincePrevious: count });
const ownerSummaryMetrics: Check = value => ownerSummaryAdsMetrics(value) || ownerSummarySearchMetrics(value) || ownerSummarySiteMetrics(value);
const isOwnerSummaryShape = shape({
  schema: value => value === "ops.intel.owner-summary.v1", business: shape({ id: str, key: str, name: str }), range: ownerSummaryRange,
  sources: list(shape({ id: ownerSummarySourceId, businessId: str, range: ownerSummaryRange, state: ownerSummaryState, reason: orNull(str), metrics: orNull(ownerSummaryMetrics) })),
});

/** True when a span covers exactly the requested number of days, so a 28-day answer can never be shown as the last 7 days. */
const covers = (range: Span, requested: IntelRange) =>
  (Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.start}T00:00:00Z`)) / 86_400_000 + 1 === Number(requested.slice(0, -1));

const base = (key: string) => `/api/intel/${encodeURIComponent(key)}`;
async function read<T>(path: string, check: Check, signal?: AbortSignal, missingIsUnavailable = true): Promise<T> {
  let value: unknown;
  try { value = await api<unknown>(path, { signal }); }
  catch (caught) { if (missingIsUnavailable && caught instanceof ApiError && caught.status === 404) throw new IntelUnavailable(caught.message); throw caught; }
  if (!check(value)) throw new IntelMalformed("Intel answered in an unexpected shape.");
  return value as T;
}

export const loadIntelBusinesses = (signal?: AbortSignal) => read<{ businesses: IntelBusiness[] }>("/api/intel/businesses", isBusinesses, signal, false);
export const loadCompetitors = (key: string, signal?: AbortSignal) => read<StaffTenantView>(`${base(key)}/competitors`, isTenantView, signal);
export async function loadOwnerIntelSummary(key: string, range: IntelRange, signal?: AbortSignal) {
  const value = await read<OwnerIntelSummary>(`${base(key)}/summary?range=${range}`, isOwnerSummaryShape, signal);
  const expectedIds = ["google_ads", "search_console", "own_site", "ga4"];
  const ids = value.sources.map(source => source.id);
  const metricsMatchSource = value.sources.every(source => source.metrics === null || (source.id === "google_ads" ? ownerSummaryAdsMetrics(source.metrics)
    : source.id === "search_console" ? ownerSummarySearchMetrics(source.metrics) : source.id === "own_site" ? ownerSummarySiteMetrics(source.metrics) : false));
  if (value.business.key !== key || value.range !== range || value.sources.length !== expectedIds.length
    || new Set(ids).size !== expectedIds.length || expectedIds.some(id => !ids.includes(id as OwnerIntelSummarySourceId))
    || value.sources.some(source => source.businessId !== value.business.id || source.range !== range) || !metricsMatchSource)
    throw new IntelMalformed("Intel answered for a different business or period.");
  return value;
}
export async function loadWebsiteMonitor(key: string, range: IntelRange, signal?: AbortSignal) {
  const value = await read<WebsiteMonitor>(`${base(key)}/website?range=${range}`, isWebsite, signal);
  if (!covers(value.range, range)) throw new IntelMalformed("Intel answered for a different period.");
  return value;
}
export async function loadSearchStats(key: string, range: IntelRange, signal?: AbortSignal) {
  const value = await read<SearchStats>(`${base(key)}/search-console?range=${range}`, isSearch, signal);
  if (value.coverage.rangeSelection !== range || !covers(value.range, range)) throw new IntelMalformed("Intel answered for a different period.");
  return value;
}
export async function loadGoogleAds(key: string, range: IntelRange, signal?: AbortSignal) {
  const value = await read<GoogleAdsSummary>(`${base(key)}/google-ads?range=${range}`, isAdsShape, signal);
  if (!adsConsistent(value)) throw new IntelMalformed("Intel answered in an unexpected shape.");
  if (value.rangeSelection !== range || value.period && (value.period.days !== Number(range.slice(0, -1)) || !covers(value.period, range)))
    throw new IntelMalformed("Intel answered for a different period.");
  return value;
}
