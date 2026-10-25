import type { StaffTenantView } from "@ltds/shared/competitor-intel";
import { ApiError, api } from "./api";

/** Ledge Top's own businesses, as the server lets this person see them. Intel is internal: clients never see it. */
export type IntelBusiness = { key: string; name: string };
export type IntelRange = "7d" | "28d" | "90d";
export const INTEL_RANGES: ReadonlyArray<{ value: IntelRange; label: string }> = [
  { value: "7d", label: "7 days" }, { value: "28d", label: "28 days" }, { value: "90d", label: "90 days" },
];
type Freshness = { fetchedAt: string; stale: boolean };
type Span = { start: string; end: string };

/** A null total is one the source doesn't report; it is shown as not tracked, never as zero. */
export type WebsiteTotals = { users: number | null; sessions: number | null; pageViews: number | null; engagementRate: number | null; conversions: number | null };
export type WebsiteStats = {
  property: { name: string }; range: Span; freshness: Freshness; totals: WebsiteTotals; previous: WebsiteTotals | null;
  topPages: Array<{ path: string; title: string; pageViews: number; users: number }>;
  sources: Array<{ channel: string; sessions: number }>;
};
export type SearchRow = { clicks: number; impressions: number; ctr: number; position: number };
export type SearchStats = {
  site: { url: string }; range: Span; freshness: Freshness;
  totals: { [K in keyof SearchRow]: number | null }; previous: { [K in keyof SearchRow]: number | null } | null;
  queries: Array<SearchRow & { query: string }>; pages: Array<SearchRow & { url: string }>;
};

/** A section that has nothing to show yet: not set up or not connected for this business. */
export class IntelUnavailable extends Error {}

/** A reply that isn't the documented shape; the view shows it couldn't be loaded instead of rendering it. */
export class IntelMalformed extends Error {}

type Check = (value: unknown) => boolean;
const obj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str: Check = value => typeof value === "string" && value.length > 0;
const num: Check = value => typeof value === "number" && Number.isFinite(value);
const numOrNull: Check = value => value === null || num(value);
const list = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const shape = (fields: Record<string, Check>): Check => value => obj(value) && Object.entries(fields).every(([key, check]) => check(value[key]));
const orNull = (check: Check): Check => value => value === null || check(value);

const span = shape({ start: str, end: str }), freshness = shape({ fetchedAt: str, stale: value => typeof value === "boolean" });
const websiteTotals = shape({ users: numOrNull, sessions: numOrNull, pageViews: numOrNull, engagementRate: numOrNull, conversions: numOrNull });
const searchTotals = shape({ clicks: numOrNull, impressions: numOrNull, ctr: numOrNull, position: numOrNull });
const searchRow = { clicks: num, impressions: num, ctr: num, position: num };
const isWebsite = shape({ property: shape({ name: str }), range: span, freshness, totals: websiteTotals, previous: orNull(websiteTotals),
  topPages: list(shape({ path: str, title: value => typeof value === "string", pageViews: num, users: num })), sources: list(shape({ channel: str, sessions: num })) });
const isSearch = shape({ site: shape({ url: str }), range: span, freshness, totals: searchTotals, previous: orNull(searchTotals),
  queries: list(shape({ ...searchRow, query: str })), pages: list(shape({ ...searchRow, url: str })) });
// The fields the competitor view reads directly; nested evidence is rendered defensively by the shared components.
const isTenant = shape({ tenantKey: str, tenantName: str, monitoring: value => value === "active" || value === "paused" || value === "not_configured",
  competitors: list(shape({ subjectKey: str, name: str })), changes: list(shape({ operationId: str, competitorSubjectKey: str, detectedAt: str, summary: value => typeof value === "string", significance: obj, pageUrl: shape({ url: str }) })),
  intents: Array.isArray, providerAccountRef: orNull(str), scopeKey: orNull(str) });
const isBusinesses = shape({ businesses: list(shape({ key: str, name: str })) });

const base = (key: string) => `/api/intel/${encodeURIComponent(key)}`;
async function read<T>(path: string, check: Check, signal?: AbortSignal, missingIsUnavailable = true): Promise<T> {
  let value: unknown;
  try { value = await api<unknown>(path, { signal }); }
  catch (caught) { if (missingIsUnavailable && caught instanceof ApiError && caught.status === 404) throw new IntelUnavailable(caught.message); throw caught; }
  if (!check(value)) throw new IntelMalformed("Intel answered in an unexpected shape.");
  return value as T;
}

export const loadIntelBusinesses = (signal?: AbortSignal) => read<{ businesses: IntelBusiness[] }>("/api/intel/businesses", isBusinesses, signal, false);
export const loadCompetitors = (key: string, signal?: AbortSignal) => read<StaffTenantView>(`${base(key)}/competitors`, isTenant, signal);
export const loadWebsiteStats = (key: string, range: IntelRange, signal?: AbortSignal) => read<WebsiteStats>(`${base(key)}/website?range=${range}`, isWebsite, signal);
export const loadSearchStats = (key: string, range: IntelRange, signal?: AbortSignal) => read<SearchStats>(`${base(key)}/search-console?range=${range}`, isSearch, signal);

