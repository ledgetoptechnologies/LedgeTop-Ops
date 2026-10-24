import { useEffect, useState, type ReactNode } from "react";
import { EmptyState, Skeleton } from "@ltds/ui";
import type { StaffTenantView } from "@ltds/shared/competitor-intel";
import { ApiError } from "./api";
import { CompetitorIntelTenant } from "./CompetitorIntel";
import {
  INTEL_RANGES, IntelUnavailable, loadCompetitors, loadIntelBusinesses, loadSearchStats, loadWebsiteStats, sendCompetitorCommand,
  type IntelBusiness, type IntelRange, type SearchRow, type SearchStats, type WebsiteStats, type WebsiteTotals,
} from "./intel-api";
import "./IntelPage.css";

type View = "competitors" | "website" | "search";
const VIEWS: ReadonlyArray<{ value: View; label: string }> = [
  { value: "competitors", label: "Competitor Intel" }, { value: "website", label: "Website" }, { value: "search", label: "Search Console" },
];
const isView = (value: string | null): value is View => VIEWS.some(view => view.value === value);
const isRange = (value: string | null): value is IntelRange => INTEL_RANGES.some(range => range.value === value);

const count = (value: number) => Math.round(value).toLocaleString();
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const day = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
};
const stamp = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
};

/** Reads business/view/range from the address so a refresh or shared link opens the same Intel view. */
function readLocation() {
  const params = new URLSearchParams(location.search);
  const view = params.get("view"), range = params.get("range");
  return { business: params.get("business"), view: isView(view) ? view : "competitors", range: isRange(range) ? range : "28d" as IntelRange };
}

type Load<T> = { kind: "loading" } | { kind: "unavailable" } | { kind: "error"; message: string } | { kind: "ready"; value: T };

function useSection<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<Load<T>>({ kind: "loading" });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    load(controller.signal)
      .then(value => { if (!controller.signal.aborted) setState({ kind: "ready", value }); })
      .catch(caught => {
        if (controller.signal.aborted) return;
        setState(caught instanceof IntelUnavailable ? { kind: "unavailable" }
          : { kind: "error", message: caught instanceof ApiError && caught.status === 403 ? "You don't have access to this view." : "This view couldn't be loaded." });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, retry]);
  return [state, () => setRetry(value => value + 1)] as const;
}

/**
 * Internal Intel for Ledge Top's own businesses: pick Drone Services or Technologies, then competitor monitoring,
 * website analytics or Search Console. Read-only apart from Competitor Intel's existing review commands.
 */
export function IntelPage() {
  const [businesses, setBusinesses] = useState<Load<IntelBusiness[]>>({ kind: "loading" });
  const [selection, setSelection] = useState(readLocation);
  useEffect(() => {
    const controller = new AbortController();
    loadIntelBusinesses(controller.signal)
      .then(value => setBusinesses({ kind: "ready", value: value.businesses }))
      .catch(caught => {
        if (controller.signal.aborted) return;
        setBusinesses(caught instanceof ApiError && (caught.status === 403 || caught.status === 404)
          ? { kind: "unavailable" } : { kind: "error", message: "Intel couldn't be loaded." });
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const pop = () => setSelection(readLocation());
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);

  if (businesses.kind === "loading") return <Skeleton variant="list" rows={3} label="Loading Intel…" />;
  if (businesses.kind === "error") return <div className="notice error">{businesses.message} Reload to try again.</div>;
  if (businesses.kind === "unavailable" || !businesses.value.length)
    return <EmptyState title="Intel isn't available" detail="No Ledge Top business is set up for Intel on your account yet." />;

  const list = businesses.value;
  const business = list.find(item => item.key === selection.business) ?? list[0]!;
  const choose = (next: Partial<typeof selection>) => {
    const merged = { ...selection, business: business.key, ...next };
    setSelection(merged);
    const params = new URLSearchParams({ business: merged.business!, view: merged.view, range: merged.range });
    history.replaceState(null, "", `/intel?${params}`);
  };

  return <div className="intel-page">
    <div className="intel-controls">
      {list.length > 1 && <div className="ltds-segmented intel-business" role="group" aria-label="Business">
        {list.map(item => <button key={item.key} type="button" aria-pressed={item.key === business.key}
          onClick={() => choose({ business: item.key })}>{item.name}</button>)}
      </div>}
      <nav className="ltds-segmented intel-views" aria-label="Intel views">
        {VIEWS.map(view => <button key={view.value} type="button" aria-current={view.value === selection.view ? "page" : undefined}
          onClick={() => choose({ view: view.value })}>{view.label}</button>)}
      </nav>
      {selection.view !== "competitors" && <label className="intel-range">Period
        <select value={selection.range} onChange={event => choose({ range: event.target.value as IntelRange })}>
          {INTEL_RANGES.map(range => <option key={range.value} value={range.value}>Last {range.label}</option>)}
        </select>
      </label>}
    </div>
    <section aria-label={`${business.name} ${VIEWS.find(view => view.value === selection.view)!.label}`}>
      {selection.view === "competitors" && <Competitors key={business.key} business={business} />}
      {selection.view === "website" && <Website key={`${business.key}-${selection.range}`} business={business} range={selection.range} />}
      {selection.view === "search" && <Search key={`${business.key}-${selection.range}`} business={business} range={selection.range} />}
    </section>
  </div>;
}

function Status<T>({ state, retry, unavailable, children }: { state: Load<T>; retry: () => void; unavailable: [string, string]; children: (value: T) => ReactNode }) {
  if (state.kind === "loading") return <Skeleton variant="list" rows={4} label="Loading…" />;
  if (state.kind === "unavailable") return <EmptyState title={unavailable[0]} detail={unavailable[1]} />;
  if (state.kind === "error") return <div className="notice error">{state.message} <button type="button" className="button-ghost" onClick={retry}>Try again</button></div>;
  return <>{children(state.value)}</>;
}

function Competitors({ business }: { business: IntelBusiness }) {
  const [state, retry] = useSection<StaffTenantView>(signal => loadCompetitors(business.key, signal), [business.key]);
  return <Status state={state} retry={retry} unavailable={["Competitor monitoring isn't set up", `Competitors for ${business.name} haven't been added yet.`]}>
    {view => <CompetitorIntelTenant view={view} onCommand={command => sendCompetitorCommand(business.key, command)} />}
  </Status>;
}

function Freshness({ range, fetchedAt, stale, source }: { range: { start: string; end: string }; fetchedAt: string; stale: boolean; source: string }) {
  return <p className={`intel-freshness${stale ? " intel-stale" : ""}`}>
    {day(range.start)} – {day(range.end)} · {source} · {stale ? "Out of date, last updated" : "Updated"} {stamp(fetchedAt)}
  </p>;
}

/** A headline number with its change from the previous period; for `lowerIsBetter`, a drop reads as good. */
function Metric({ label, value, previous, format, lowerIsBetter = false }: { label: string; value: number | null; previous?: number | null; format: (value: number) => string; lowerIsBetter?: boolean }) {
  let change: ReactNode = null;
  if (value !== null && previous !== null && previous !== undefined && previous !== 0) {
    const ratio = (value - previous) / Math.abs(previous), better = lowerIsBetter ? ratio < 0 : ratio > 0;
    change = Math.abs(ratio) < 0.0005 ? <small className="intel-change">No change</small>
      : <small className={`intel-change ${better ? "intel-up" : "intel-down"}`}>{ratio > 0 ? "▲" : "▼"} {percent(Math.abs(ratio))} vs previous period</small>;
  }
  return <div role="listitem" className="intel-metric"><span>{label}</span><strong>{value === null ? "Not tracked" : format(value)}</strong>{change}</div>;
}

function Table<T>({ caption, columns, rows, empty }: { caption: string; columns: Array<{ label: string; numeric?: boolean; cell: (row: T) => ReactNode }>; rows: T[]; empty: string }) {
  return <div className="intel-table-wrap">
    <table className="intel-table">
      <caption>{caption}</caption>
      <thead><tr>{columns.map(column => <th key={column.label} scope="col" className={column.numeric ? "intel-num" : undefined}>{column.label}</th>)}</tr></thead>
      <tbody>{rows.length ? rows.map((row, index) => <tr key={index}>{columns.map(column =>
        <td key={column.label} className={column.numeric ? "intel-num" : undefined}>{column.cell(row)}</td>)}</tr>)
        : <tr><td colSpan={columns.length} className="intel-empty">{empty}</td></tr>}</tbody>
    </table>
  </div>;
}

function Website({ business, range }: { business: IntelBusiness; range: IntelRange }) {
  const [state, retry] = useSection<WebsiteStats>(signal => loadWebsiteStats(business.key, range, signal), [business.key, range]);
  return <Status state={state} retry={retry} unavailable={["Website stats aren't connected", `Google Analytics isn't connected for ${business.name} yet.`]}>
    {stats => {
      const prior = (key: keyof WebsiteTotals) => stats.previous?.[key] ?? null;
      return <>
        <Freshness range={stats.range} fetchedAt={stats.freshness.fetchedAt} stale={stats.freshness.stale} source={`Google Analytics · ${stats.property.name}`} />
        <div className="intel-metrics" role="list" aria-label="Website totals">
          <Metric label="Visitors" value={stats.totals.users} previous={prior("users")} format={count} />
          <Metric label="Visits" value={stats.totals.sessions} previous={prior("sessions")} format={count} />
          <Metric label="Page views" value={stats.totals.pageViews} previous={prior("pageViews")} format={count} />
          <Metric label="Engaged visits" value={stats.totals.engagementRate} previous={prior("engagementRate")} format={percent} />
          <Metric label="Conversions" value={stats.totals.conversions} previous={prior("conversions")} format={count} />
        </div>
        <div className="intel-tables">
          <Table caption="Top pages" rows={stats.topPages} empty="No page views in this period."
            columns={[{ label: "Page", cell: row => <span className="intel-page-cell"><strong>{row.title || row.path}</strong>{row.title && <small>{row.path}</small>}</span> },
              { label: "Views", numeric: true, cell: row => count(row.pageViews) }, { label: "Visitors", numeric: true, cell: row => count(row.users) }]} />
          <Table caption="Where visits came from" rows={stats.sources} empty="No visits in this period."
            columns={[{ label: "Channel", cell: row => row.channel }, { label: "Visits", numeric: true, cell: row => count(row.sessions) }]} />
        </div>
      </>;
    }}
  </Status>;
}

function Search({ business, range }: { business: IntelBusiness; range: IntelRange }) {
  const [state, retry] = useSection<SearchStats>(signal => loadSearchStats(business.key, range, signal), [business.key, range]);
  const searchColumns = <T extends SearchRow>(first: { label: string; cell: (row: T) => ReactNode }) => [first,
    { label: "Clicks", numeric: true, cell: (row: T) => count(row.clicks) }, { label: "Impressions", numeric: true, cell: (row: T) => count(row.impressions) },
    { label: "CTR", numeric: true, cell: (row: T) => percent(row.ctr) }, { label: "Position", numeric: true, cell: (row: T) => row.position.toFixed(1) }];
  return <Status state={state} retry={retry} unavailable={["Search Console isn't connected", `Google Search Console isn't connected for ${business.name} yet.`]}>
    {stats => <>
      <Freshness range={stats.range} fetchedAt={stats.freshness.fetchedAt} stale={stats.freshness.stale} source={`Search Console · ${stats.site.url}`} />
      <div className="intel-metrics" role="list" aria-label="Search totals">
        <Metric label="Clicks" value={stats.totals.clicks} previous={stats.previous?.clicks} format={count} />
        <Metric label="Impressions" value={stats.totals.impressions} previous={stats.previous?.impressions} format={count} />
        <Metric label="Click-through rate" value={stats.totals.ctr} previous={stats.previous?.ctr} format={percent} />
        <Metric label="Average position" value={stats.totals.position} previous={stats.previous?.position} format={value => value.toFixed(1)} lowerIsBetter />
      </div>
      <div className="intel-tables">
        <Table caption="Top searches" rows={stats.queries} empty="No searches in this period." columns={searchColumns<SearchStats["queries"][number]>({ label: "Search", cell: row => row.query })} />
        <Table caption="Top pages in search" rows={stats.pages} empty="No pages in search this period." columns={searchColumns<SearchStats["pages"][number]>({ label: "Page", cell: row => row.url })} />
      </div>
    </>}
  </Status>;
}
