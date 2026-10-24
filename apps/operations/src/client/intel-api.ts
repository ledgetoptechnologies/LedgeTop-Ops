import type { CompetitorIntelCommand, StaffTenantView } from "@ltds/shared/competitor-intel";
import { ApiError, api } from "./api";

/** Ledge Top's own businesses, as the server lets this person see them. Intel is internal: clients never see it. */
export type IntelBusiness = { key: string; name: string };
export type IntelRange = "7d" | "28d" | "90d";
export const INTEL_RANGES: ReadonlyArray<{ value: IntelRange; label: string }> = [
  { value: "7d", label: "7 days" }, { value: "28d", label: "28 days" }, { value: "90d", label: "90 days" },
];
type Freshness = { fetchedAt: string; stale: boolean };
type Span = { start: string; end: string };

export type WebsiteTotals = { users: number; sessions: number; pageViews: number; engagementRate: number; conversions: number | null };
export type WebsiteStats = {
  property: { name: string }; range: Span; freshness: Freshness; totals: WebsiteTotals; previous: WebsiteTotals | null;
  topPages: Array<{ path: string; title: string; pageViews: number; users: number }>;
  sources: Array<{ channel: string; sessions: number }>;
};
export type SearchRow = { clicks: number; impressions: number; ctr: number; position: number };
export type SearchStats = {
  site: { url: string }; range: Span; freshness: Freshness; totals: SearchRow; previous: SearchRow | null;
  queries: Array<SearchRow & { query: string }>; pages: Array<SearchRow & { url: string }>;
};

/** A section that has nothing to show yet: not set up or not connected for this business. */
export class IntelUnavailable extends Error {}

const base = (key: string) => `/api/intel/${encodeURIComponent(key)}`;
async function section<T>(path: string, signal?: AbortSignal) {
  try { return await api<T>(path, { signal }); }
  catch (caught) { if (caught instanceof ApiError && caught.status === 404) throw new IntelUnavailable(caught.message); throw caught; }
}

export const loadIntelBusinesses = (signal?: AbortSignal) => api<{ businesses: IntelBusiness[] }>("/api/intel/businesses", { signal });
export const loadCompetitors = (key: string, signal?: AbortSignal) => section<StaffTenantView>(`${base(key)}/competitors`, signal);
export const loadWebsiteStats = (key: string, range: IntelRange, signal?: AbortSignal) => section<WebsiteStats>(`${base(key)}/website?range=${range}`, signal);
export const loadSearchStats = (key: string, range: IntelRange, signal?: AbortSignal) => section<SearchStats>(`${base(key)}/search-console?range=${range}`, signal);
export const sendCompetitorCommand = (key: string, command: CompetitorIntelCommand) =>
  api<unknown>(`${base(key)}/competitors/commands`, { method: "POST", body: JSON.stringify(command) }).then(() => undefined);
