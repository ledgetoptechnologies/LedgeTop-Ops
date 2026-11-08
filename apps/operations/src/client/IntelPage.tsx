import { useEffect, useId, useState, type MouseEvent, type ReactNode } from "react";
import { EmptyState, Skeleton } from "@ltds/ui";
import { UNKNOWN_REASON_TEXT, type EvidenceState, type FetchStatus, type StaffTenantView, type UnknownReason } from "@ltds/shared/competitor-intel";
import { ApiError } from "./api";
import { CompetitorIntelTenant } from "./CompetitorIntel";
import { formatGoogleAdsConversions, formatGoogleAdsCostMicros, formatGoogleAdsWhole } from "./intel-format";
import {
  INTEL_RANGES, IntelUnavailable, loadCompetitors, loadGoogleAds, loadIntelBusinesses, loadSearchStats, loadWebsiteMonitor,
  type GoogleAdsSummary, type IntelBusiness, type IntelRange, type SearchRow, type SearchStats, type SiteChangeType, type SourceReason, type StatedFact, type WebsiteMonitor,
} from "./intel-api";
import "./IntelPage.css";

type View = "competitors" | "website" | "search" | "ads";
const VIEWS: ReadonlyArray<{ value: View; label: string }> = [
  { value: "competitors", label: "Competitor Intel" }, { value: "website", label: "Site monitor" }, { value: "search", label: "Search Console" },
  { value: "ads", label: "Google Ads" },
];
const isView = (value: string | null): value is View => VIEWS.some(view => view.value === value);
const isRange = (value: string | null): value is IntelRange => INTEL_RANGES.some(range => range.value === value);

const count = (value: number) => Math.round(value).toLocaleString();
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const day = (value: string) => {
  // A plain YYYY-MM-DD is a calendar day in the source's UTC periods; showing it in local time would move it a day earlier.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
};
const stamp = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
};

/** Reads business/view/range from the address so a refresh or shared link opens the same Intel view. No business means the overview. */
function readLocation() {
  const params = new URLSearchParams(location.search);
  const view = params.get("view"), range = params.get("range");
  return { business: params.get("business"), view: isView(view) ? view : "competitors", range: isRange(range) ? range : "28d" as IntelRange,
    overview: !params.has("business") };
}
const detailHref = (business: string, view: View, range: IntelRange) => `/intel?${new URLSearchParams({ business, view, range })}`;
/** A plain click stays in the page and keeps history; a modified click opens the link as the browser would. */
const plainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
type Go = (href: string) => (event: MouseEvent) => void;

type Load<T> = { kind: "loading" } | { kind: "unavailable"; code: string } | { kind: "error"; message: string } | { kind: "ready"; value: T };

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
        setState(caught instanceof IntelUnavailable ? { kind: "unavailable", code: caught.code }
          : { kind: "error", message: caught instanceof ApiError && caught.status === 403 ? "You don't have access to this view." : "This view couldn't be loaded." });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, retry]);
  return [state, () => setRetry(value => value + 1)] as const;
}

/**
 * Internal Intel for Ledge Top's own businesses: an overview of every business, each linking to its competitor
 * monitoring, own-site monitoring or Search Console. Entirely read-only.
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
          ? { kind: "unavailable", code: caught.message } : { kind: "error", message: "Intel couldn't be loaded." });
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
  const go: Go = href => event => {
    if (!plainClick(event)) return;
    event.preventDefault();
    history.pushState(null, "", href);
    setSelection(readLocation());
  };
  if (selection.overview) return <IntelOverview businesses={list} go={go} />;
  const business = list.find(item => item.key === selection.business) ?? list[0]!;
  const choose = (next: Partial<typeof selection>) => {
    const merged = { ...selection, business: business.key, ...next };
    setSelection(merged);
    const params = new URLSearchParams({ business: merged.business!, view: merged.view, range: merged.range });
    history.replaceState(null, "", `/intel?${params}`);
  };

  return <div className="intel-page">
    <a className="intel-back" href="/intel" onClick={go("/intel")}>← All businesses</a>
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
      {selection.view === "ads" && <GoogleAds key={`${business.key}-${selection.range}`} business={business} range={selection.range} />}
    </section>
  </div>;
}

const OVERVIEW_RANGE: IntelRange = "28d";

/** Every business side by side. Each section loads on its own, so one that fails or isn't connected never hides the rest. */
function IntelOverview({ businesses, go }: { businesses: IntelBusiness[]; go: Go }) {
  return <div className="intel-page">
    <p className="intel-note">Each Ledge Top business at a glance. Site and search figures cover the last {rangeLabel(OVERVIEW_RANGE)}.</p>
    <div className="intel-overview">{businesses.map(business => <BusinessSummary key={business.key} business={business} go={go} />)}</div>
  </div>;
}

const plural = (value: number, one: string, many: string) => `${count(value)} ${value === 1 ? one : many}`;

function BusinessSummary({ business, go }: { business: IntelBusiness; go: Go }) {
  const headingId = useId();
  const [competitors, retryCompetitors] = useSection<StaffTenantView>(signal => loadCompetitors(business.key, signal), [business.key]);
  const [site, retrySite] = useSection<WebsiteMonitor>(signal => loadWebsiteMonitor(business.key, OVERVIEW_RANGE, signal), [business.key]);
  const [search, retrySearch] = useSection<SearchStats>(signal => loadSearchStats(business.key, OVERVIEW_RANGE, signal), [business.key]);
  const [ads, retryAds] = useSection<GoogleAdsSummary>(signal => loadGoogleAds(business.key, OVERVIEW_RANGE, signal), [business.key]);
  const row = (view: View) => ({ label: VIEWS.find(item => item.value === view)!.label, href: detailHref(business.key, view, OVERVIEW_RANGE), go });
  return <section className="intel-overview-card" aria-labelledby={headingId}>
    <h2 id={headingId}>{business.name}</h2>
    <ul>
      <SummaryRow {...row("competitors")} state={competitors} retry={retryCompetitors} summary={view => [
        `${plural(view.competitors.length, "competitor", "competitors")} tracked`,
        view.latestScan?.completedAt ? `Last scan ${stamp(view.latestScan.completedAt)}` : "No completed scan yet"]} />
      <SummaryRow {...row("website")} state={site} retry={retrySite} summary={value => [
        `${plural(value.monitoredPages.length, "page", "pages")} monitored`,
        plural(value.changesSincePrevious.length, "change", "changes"),
        value.freshness.stale ? "Out of date" : ""]} />
      <SummaryRow {...row("search")} state={search} retry={retrySearch} summary={value => [
        value.totals.clicks === null ? "Clicks not available" : plural(value.totals.clicks, "click", "clicks"),
        value.totals.impressions === null ? "Impressions not available" : plural(value.totals.impressions, "impression", "impressions"),
        value.freshness.stale ? "Out of date" : ""]} />
      <SummaryRow {...row("ads")} state={ads} retry={retryAds} summary={value => value.totals.state === "observed"
        ? [`${formatGoogleAdsCostMicros(value.totals.costMicros!, value.currencyCode!)} spent`, adsCountText(value.totals.clicks!, "click", "clicks")]
        : [unknownText(adsEvidence(value.totals.state), value.totals.reason)]} />
    </ul>
  </section>;
}

/** What a section says when it has no figures: never a zero. */
const overviewUnavailable = (code: string) => code.endsWith("_awaiting_first_data") ? "Waiting for the first data"
  : code.endsWith("_range_unavailable") ? `Nothing reported for the last ${rangeLabel(OVERVIEW_RANGE)}` : "Not set up yet";

function SummaryRow<T>({ label, href, go, state, retry, summary }: { label: string; href: string; go: Go; state: Load<T>; retry: () => void; summary: (value: T) => string[] }) {
  return <li className="intel-overview-row">
    <a href={href} onClick={go(href)}>{label} →</a>
    {state.kind === "loading" ? <p className="intel-unknown">Loading…</p>
      : state.kind === "unavailable" ? <p className="intel-unknown">{overviewUnavailable(state.code)}</p>
      : state.kind === "error" ? <p className="intel-overview-error">{state.message} <button type="button" className="button-ghost button-small" onClick={retry}>Try again</button></p>
      : <p>{summary(state.value).filter(Boolean).join(" · ")}</p>}
  </li>;
}

function Status<T>({ state, retry, unavailable, children }: { state: Load<T>; retry: () => void; unavailable: (code: string) => [string, string]; children: (value: T) => ReactNode }) {
  if (state.kind === "loading") return <Skeleton variant="list" rows={4} label="Loading…" />;
  if (state.kind === "unavailable") { const [title, detail] = unavailable(state.code); return <EmptyState title={title} detail={detail} />; }
  if (state.kind === "error") return <div className="notice error">{state.message} <button type="button" className="button-ghost" onClick={retry}>Try again</button></div>;
  return <>{children(state.value)}</>;
}

function Competitors({ business }: { business: IntelBusiness }) {
  const [state, retry] = useSection<StaffTenantView>(signal => loadCompetitors(business.key, signal), [business.key]);
  return <Status state={state} retry={retry} unavailable={() => ["Competitor monitoring isn't set up", `Competitors for ${business.name} haven't been added yet.`]}>
    {/* Read-only until the Intel backend accepts commands: no scan, verdict or publish controls. */}
    {view => <CompetitorIntelTenant view={view} />}
  </Status>;
}

function Freshness({ range, fetchedAt, stale, source }: { range: { start: string; end: string }; fetchedAt: string; stale: boolean; source: string }) {
  return <p className={`intel-freshness${stale ? " intel-stale" : ""}`}>
    {day(range.start)} – {day(range.end)} · {source} · {stale ? "Out of date, last updated" : "Updated"} {stamp(fetchedAt)}
  </p>;
}

/** Reasons the signed feed adds beyond the competitor ones. */
const SOURCE_REASON_TEXT: Record<Exclude<SourceReason, UnknownReason>, string> = {
  consent_missing: "Access to this source hasn't been granted",
  no_property_selected: "No Search Console property is selected",
  provider_data_delay: "Google hasn't finished reporting this period yet",
  no_account: "No account is connected",
  data_limited: "Google limited the data it reported",
  source_stale: "The source hasn't been refreshed recently",
};
const reasonText = (reason: SourceReason) => (SOURCE_REASON_TEXT as Record<string, string>)[reason] ?? UNKNOWN_REASON_TEXT[reason as UnknownReason];
/** What an unknown fact says instead of a value: never a zero. */
function unknownText(state: EvidenceState, reason: SourceReason | null) {
  if (reason) return reasonText(reason);
  return state === "none_found" ? "None found" : state === "not_connected" ? "Not connected" : state === "blocked" ? "Blocked" : state === "failed" ? "Check failed" : "Not available";
}
const NOT_AVAILABLE = <span className="intel-unknown">Not available</span>;

/** A headline value; `change` is what the source itself reported against the previous period, if anything. */
function Metric({ label, value, change, note }: { label: string; value: ReactNode; change?: ReactNode; note?: string }) {
  return <div role="listitem" className="intel-metric"><span>{label}</span><strong>{value}</strong>{change}{note && <small className="intel-change">{note}</small>}</div>;
}

/** The source's own percentage change, shown as reported (a rising count reads as good). */
function Delta({ percent: value, days }: { percent: string | null; days: number }) {
  if (value === null) return null;
  const amount = Number(value);
  if (Math.abs(amount) < 0.05) return <small className="intel-change">No change vs previous {days} days</small>;
  return <small className={`intel-change ${amount > 0 ? "intel-up" : "intel-down"}`}>{amount > 0 ? "▲" : "▼"} {Math.abs(amount).toFixed(1)}% vs previous {days} days</small>;
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

/** Partial data, unreported totals and provider limits, stated plainly next to the numbers they qualify. */
function Coverage({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return <ul className="intel-coverage" aria-label="About this data">{notes.map(note => <li key={note}>{note}</li>)}</ul>;
}

const rangeLabel = (range: IntelRange) => INTEL_RANGES.find(item => item.value === range)!.label;
const yesNo = (fact: StatedFact<boolean>, yes: string, no: string) => fact.state === "observed" && fact.value !== null ? (fact.value ? yes : no) : unknownText(fact.state, fact.reason);
const FETCH_TEXT: Record<FetchStatus, string> = { ok: "Reachable", parked: "Domain parked", redirect: "Redirects elsewhere",
  blocked: "Blocked automated checks", error: "Error", not_checked: "Not checked yet" };
const CHANGE_TEXT: Record<SiteChangeType, string> = { content_changed: "Content changed", redirect_external: "Now redirects to another site",
  website_parked: "Domain parked", site_unavailable: "Site unavailable" };

function Website({ business, range }: { business: IntelBusiness; range: IntelRange }) {
  const [state, retry] = useSection<WebsiteMonitor>(signal => loadWebsiteMonitor(business.key, range, signal), [business.key, range]);
  const unavailable = (code: string): [string, string] => code === "intel_awaiting_first_data"
    ? ["Waiting for the first site check", `The site monitor is set up for ${business.name}, but no check has arrived yet.`]
    : code === "intel_range_unavailable" ? ["No site checks for this period", `The site monitor has nothing for the last ${rangeLabel(range)}. Choose another period.`]
    : ["Site monitoring isn't set up", `Ledge Top's site monitor isn't connected for ${business.name} yet.`];
  return <Status state={state} retry={retry} unavailable={unavailable}>
    {site => {
      const { technical, provenance } = site;
      const notes = [provenance.partial && provenance.partialReason ? `Partial check: ${reasonText(provenance.partialReason)}.` : "", ...provenance.limits].filter(Boolean);
      return <>
        <Freshness range={site.range} fetchedAt={site.freshness.fetchedAt} stale={site.freshness.stale} source={`Site monitor · ${site.site.canonicalDomain}`} />
        <p className="intel-note">Checks of {site.site.canonicalDomain}'s own pages and technical health. This is site monitoring, not visitor analytics.</p>
        <Coverage notes={notes} />
        <div className="intel-metrics" role="list" aria-label="Site health">
          <Metric label="Secure (HTTPS)" value={yesNo(technical.httpsOk, "Yes", "No")} />
          <Metric label="Search engines may index" value={yesNo(technical.robotsAllowsIndexing, "Yes", "No")} />
          <Metric label="Pages in sitemap" value={technical.sitemapPageCount.state === "observed" && technical.sitemapPageCount.value !== null
            ? count(technical.sitemapPageCount.value) : unknownText(technical.sitemapPageCount.state, technical.sitemapPageCount.reason)} />
          <Metric label="Average page response" value={technical.avgFetchMs === null ? NOT_AVAILABLE : `${count(technical.avgFetchMs)} ms`} />
        </div>
        <div className="intel-tables">
          <Table caption="Monitored pages" rows={site.monitoredPages} empty="No pages are monitored yet."
            columns={[{ label: "Page", cell: row => <span className="intel-page-cell"><strong>{row.title || row.url}</strong>{row.title && <small>{row.url}</small>}</span> },
              { label: "Status", cell: row => FETCH_TEXT[row.fetchStatus] }, { label: "Checked", cell: row => stamp(row.observedAt) }]} />
        </div>
        <section className="intel-changes" aria-label="Changes in this period">
          <h3>Changes in this period</h3>
          {site.changesSincePrevious.length === 0 ? <p className="intel-empty">No changes were found in this period.</p>
            : <ul>{site.changesSincePrevious.map((change, index) => <li key={index}>
              <p className="intel-change-head"><strong>{CHANGE_TEXT[change.changeType]}</strong> · {change.pageUrl.title || change.pageUrl.url} · {stamp(change.detectedAt)}</p>
              {change.summary && <p>{change.summary}</p>}
              {(change.addedSentences.length > 0 || change.removedSentences.length > 0) && <details>
                <summary>What changed</summary>
                {change.addedSentences.length > 0 && <><h4>Added</h4><ul>{change.addedSentences.map((line, at) => <li key={at}>{line}</li>)}</ul></>}
                {change.removedSentences.length > 0 && <><h4>Removed</h4><ul>{change.removedSentences.map((line, at) => <li key={at}>{line}</li>)}</ul></>}
              </details>}
            </li>)}</ul>}
        </section>
      </>;
    }}
  </Status>;
}

function Search({ business, range }: { business: IntelBusiness; range: IntelRange }) {
  const [state, retry] = useSection<SearchStats>(signal => loadSearchStats(business.key, range, signal), [business.key, range]);
  const unavailable = (code: string): [string, string] => code === "intel_awaiting_first_data"
    ? ["Waiting for Search Console data", `Search Console is set up for ${business.name}, but no data has arrived yet.`]
    : code === "intel_range_unavailable" ? ["No Search Console data for this period", `Search Console hasn't reported the last ${rangeLabel(range)} for ${business.name}. Choose another period.`]
    : ["Search Console isn't connected", `Google Search Console isn't connected for ${business.name} yet.`];
  const searchColumns = <T extends SearchRow>(first: { label: string; cell: (row: T) => ReactNode }) => [first,
    { label: "Clicks", numeric: true, cell: (row: T) => count(row.clicks) }, { label: "Impressions", numeric: true, cell: (row: T) => count(row.impressions) },
    { label: "CTR", numeric: true, cell: (row: T) => row.ctr === null ? NOT_AVAILABLE : percent(row.ctr) },
    { label: "Position", numeric: true, cell: (row: T) => row.position === null ? NOT_AVAILABLE : row.position.toFixed(1) }];
  return <Status state={state} retry={retry} unavailable={unavailable}>
    {stats => {
      const { totals, coverage, comparison } = stats;
      const missing = coverage.state === "observed" ? "" : `Google didn't report totals for this period: ${unknownText(coverage.state, coverage.reason)}.`;
      const notes = [missing, coverage.partial && coverage.partialReason ? `Partial data: ${reasonText(coverage.partialReason)}.` : "",
        coverage.lastDataDate ? `Google data through ${day(coverage.lastDataDate)}.` : "", ...coverage.limits].filter(Boolean);
      const total = (value: number | null, format: (value: number) => string) => value === null ? NOT_AVAILABLE : format(value);
      return <>
        <Freshness range={stats.range} fetchedAt={stats.freshness.fetchedAt} stale={stats.freshness.stale} source={`Search Console · ${stats.site.url}`} />
        <Coverage notes={notes} />
        <div className="intel-metrics" role="list" aria-label="Search totals">
          <Metric label="Clicks" value={total(totals.clicks, count)} change={comparison && <Delta percent={comparison.clicksDeltaPercent} days={comparison.previousPeriod.days} />} />
          <Metric label="Impressions" value={total(totals.impressions, count)} change={comparison && <Delta percent={comparison.impressionsDeltaPercent} days={comparison.previousPeriod.days} />} />
          <Metric label="Click-through rate" value={total(totals.ctr, percent)} />
          <Metric label="Average position" value={total(totals.position, value => value.toFixed(1))} note={totals.position === null ? undefined : "Lower is better"} />
        </div>
        <div className="intel-tables">
          <Table caption="Top searches" rows={stats.queries} empty="No searches in this period." columns={searchColumns<SearchStats["queries"][number]>({ label: "Search", cell: row => row.query })} />
          <Table caption="Top pages in search" rows={stats.pages} empty="No pages in search this period." columns={searchColumns<SearchStats["pages"][number]>({ label: "Page", cell: row => row.url })} />
        </div>
        {stats.daily.length > 0 && <details className="intel-daily">
          <summary>Daily clicks and impressions</summary>
          <Table caption="Daily clicks and impressions" rows={stats.daily} empty=""
            columns={[{ label: "Day", cell: row => day(row.date) }, { label: "Clicks", numeric: true, cell: row => count(row.clicks) },
              { label: "Impressions", numeric: true, cell: row => count(row.impressions) }]} />
        </details>}
      </>;
    }}
  </Status>;
}

/** Exact values from decimal feed strings; currency display rounds once to native minor-unit precision. */
const adsCountText = (value: string, one: string, many: string) => `${formatGoogleAdsWhole(value)} ${value === "1" ? one : many}`;
/** The Ads states, in the wording the other sources use. */
const adsEvidence = (state: GoogleAdsSummary["totals"]["state"]): EvidenceState =>
  state === "observed" ? "observed" : state === "failed" ? "failed" : state === "no_account" ? "not_connected" : "unknown";

/** Ledge Top's own Google Ads totals for one period: read-only, exactly as Google Ads reported them. */
function GoogleAds({ business, range }: { business: IntelBusiness; range: IntelRange }) {
  const [state, retry] = useSection<GoogleAdsSummary>(signal => loadGoogleAds(business.key, range, signal), [business.key, range]);
  const unavailable = (code: string): [string, string] => code === "intel_google_ads_awaiting_first_data"
    ? ["Waiting for Google Ads data", `Google Ads is connected for ${business.name}, but no data has arrived yet.`]
    : code === "intel_google_ads_manager_only" ? ["No advertiser account connected", `${business.name} has a Google Ads manager account, but no separate advertiser account is connected. Manager access alone has no campaign totals to display.`]
    : code === "intel_google_ads_range_unavailable" ? ["No Google Ads data for this period", `Google Ads hasn't reported the last ${rangeLabel(range)} for ${business.name}. Choose another period.`]
    : ["Google Ads isn't connected", `Google Ads isn't connected for ${business.name} yet.`];
  return <Status state={state} retry={retry} unavailable={unavailable}>
    {ads => {
      const { totals, period, currencyCode } = ads;
      if (totals.state === "no_account" || !period || !currencyCode)
        return <EmptyState title="No Google Ads account" detail={`No Google Ads account is connected for ${business.name}.`} />;
      const observed = totals.state === "observed";
      const notes = [observed ? "" : `Google Ads didn't report totals for this period: ${unknownText(adsEvidence(totals.state), totals.reason)}.`,
        `Days and amounts follow the account's time zone (${period.timeZone}) and currency (${currencyCode}).`,
        ads.freshness.asOf ? `Google Ads data as of ${stamp(ads.freshness.asOf)}.` : ""].filter(Boolean);
      const figure = (value: string | null, format: (value: string) => string) => observed && value !== null ? format(value) : NOT_AVAILABLE;
      return <>
        <Freshness range={period} fetchedAt={ads.freshness.collectedAt} stale={totals.state === "source_stale"} source="Google Ads" />
        <Coverage notes={notes} />
        <div className="intel-metrics" role="list" aria-label="Google Ads totals">
          <Metric label="Spend" value={figure(totals.costMicros, value => formatGoogleAdsCostMicros(value, currencyCode))} />
          <Metric label="Impressions" value={figure(totals.impressions, formatGoogleAdsWhole)} />
          <Metric label="Clicks" value={figure(totals.clicks, formatGoogleAdsWhole)} />
          <Metric label="Conversions" value={figure(totals.conversions, formatGoogleAdsConversions)} />
        </div>
      </>;
    }}
  </Status>;
}
