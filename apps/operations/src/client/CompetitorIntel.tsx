import { EmptyState, StatusPill } from "@ltds/ui";
import { CategoryTag, FreshnessTag, PercentDial, ScoreMeter, SentenceDiff, SignificanceBadge, ciDate } from "@ltds/ui/competitor-intel";
import {
  DAILY_INTENT_LIMITS, confidenceBand, confidenceText, decimalMicros, evidenceText, moneyText, percentText,
  type CompetitorIntelCommand, type CompetitorIntelTriageRow, type FetchStatus, type ObservationRef, type Significance,
  type StaffChange, type StaffCompetitor, type StaffTenantView, type WorkerIntentKind,
} from "@ltds/shared/competitor-intel";
import { useMemo, useState, type ReactNode } from "react";
import { confirmAction } from "./confirm-action";
import "./CompetitorIntel.css";

// Design-only staff views for Competitor Intel v1. Callers supply the Ops read
// view and receive command intents; nothing here reads or writes a route yet.

type Send = (command: CompetitorIntelCommand) => Promise<void>;
const SIGNIFICANCE_ORDER: Significance[] = ["critical", "notable", "minor", "noise"];
const MONITORING_TEXT = { active: "Monitoring", paused: "Paused", not_configured: "Not set up" } as const;
const FETCH_TEXT: Record<FetchStatus, string> = { ok: "Website reachable", parked: "Domain parked", redirect: "Redirects elsewhere",
  blocked: "Blocked automated checks", error: "Website error", not_checked: "Not checked yet" };
const INTENT_TEXT: Record<WorkerIntentKind, string> = { run_scan: "Scan", run_ads_review: "Google Ads review", run_self_assessment: "Self-assessment" };
const sumUnreviewed = (row: CompetitorIntelTriageRow) => SIGNIFICANCE_ORDER.reduce((total, key) => total + row.unreviewedChanges[key], 0);
const scoreValue = (competitor: StaffCompetitor) =>
  competitor.baseline?.threat.state === "observed" && competitor.baseline.threat.value ? decimalMicros(competitor.baseline.threat.value) : -1n;

function useCommand(send: Send) {
  const [busy, setBusy] = useState<string | null>(null), [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const run = async (key: string, command: CompetitorIntelCommand, done: string) => {
    if (busy) return false;
    setBusy(key); setNotice(null);
    try { await send(command); setNotice({ tone: "ok", text: done }); return true; }
    catch { setNotice({ tone: "error", text: "That request was not accepted. Nothing was changed; try again." }); return false; }
    finally { setBusy(null); }
  };
  return { busy, notice, run };
}

export function CompetitorIntelIndex({ rows, onOpen }: { rows: CompetitorIntelTriageRow[]; onOpen: (tenantKey: string) => void }) {
  const sorted = useMemo(() => [...rows].sort((a, b) =>
    b.unreviewedChanges.critical - a.unreviewedChanges.critical || b.unreviewedChanges.notable - a.unreviewedChanges.notable
    || sumUnreviewed(b) - sumUnreviewed(a) || a.tenantName.localeCompare(b.tenantName)), [rows]);
  const toReview = rows.reduce((total, row) => total + sumUnreviewed(row), 0);
  const ready = rows.reduce((total, row) => total + row.unpublishedReviewed, 0);
  const staleScans = rows.filter(row => row.monitoring === "active" && (!row.latestScan || row.latestScan.freshness === "stale" || row.latestScan.state === "failed")).length;
  const monitored = rows.filter(row => row.monitoring === "active").length;
  return <section className="ci-staff" aria-labelledby="ci-index-title">
    <header className="ci-staff-heading">
      <div><h2 id="ci-index-title">Competitor Intel</h2>
        <p>Monitoring across every client. Clients see only the reports you publish for them.</p></div>
    </header>
    <div className="ci-tiles" role="list" aria-label="Competitor Intel summary">
      <Tile label="Changes to review" value={toReview} tone={toReview ? "attention" : undefined} />
      <Tile label="Ready to publish" value={ready} />
      <Tile label="Scans out of date" value={staleScans} tone={staleScans ? "warning" : undefined} />
      <Tile label="Clients monitored" value={monitored} detail={`of ${rows.length}`} />
    </div>
    {!rows.length ? <EmptyState title="No clients are monitored yet" detail="Competitor monitoring starts after a client's binding is approved." />
      : <ul className="ci-triage" aria-label="Clients">
        {sorted.map(row => <li key={row.tenantKey}>
          <article className="ci-triage-row" aria-labelledby={`ci-tenant-${row.tenantKey}`}>
            <div className="ci-triage-name">
              <h3 id={`ci-tenant-${row.tenantKey}`}>{row.tenantName}</h3>
              <StatusPill tone={row.monitoring === "active" ? "success" : row.monitoring === "paused" ? "warning" : "neutral"}>{MONITORING_TEXT[row.monitoring]}</StatusPill>
              <span className="ci-muted">{row.activeCompetitors} competitor{row.activeCompetitors === 1 ? "" : "s"}</span>
            </div>
            <div className="ci-triage-review" aria-label="Unreviewed changes">
              {sumUnreviewed(row) === 0 ? <span className="ci-muted">Nothing to review</span>
                : SIGNIFICANCE_ORDER.filter(key => row.unreviewedChanges[key]).map(key =>
                  <span key={key} className={`ci-count ci-count-${key}`}><strong>{row.unreviewedChanges[key]}</strong> {key}</span>)}
              {row.unpublishedReviewed > 0 && <span className="ci-count ci-count-ready"><strong>{row.unpublishedReviewed}</strong> ready to publish</span>}
            </div>
            <dl className="ci-triage-facts">
              <div><dt>Latest scan</dt><dd>{row.latestScan
                ? <><span className={`ci-state ci-state-${row.latestScan.state}`}>{row.latestScan.state === "completed" ? "Completed" : row.latestScan.state === "partial" ? "Partial" : "Failed"}</span>
                  {" "}<FreshnessTag freshness={row.latestScan.freshness} at={row.latestScan.completedAt} label="Finished" /></>
                : "No scan yet"}</dd></div>
              <div><dt>Google Ads</dt><dd>{row.adsCheckup === "not_connected" ? "Not connected" : row.adsCheckup === "stale" ? <span className="ci-warn-text">Out of date</span> : "Current"}</dd></div>
              <div><dt>Client report</dt><dd>{row.lastPublication
                ? row.lastPublication.status === "withdrawn" ? "Withdrawn" : `Published ${ciDate(row.lastPublication.publishedAt)}` : "Never published"}</dd></div>
            </dl>
            <button type="button" className="button-ghost ci-open" onClick={() => onOpen(row.tenantKey)} aria-label={`Open ${row.tenantName}`}>Open</button>
          </article>
        </li>)}
      </ul>}
  </section>;
}

function Tile({ label, value, detail, tone }: { label: string; value: number; detail?: string; tone?: "attention" | "warning" }) {
  return <div role="listitem" className={`ci-tile${tone ? ` ci-tile-${tone}` : ""}`}>
    <span>{label}</span><strong>{value.toLocaleString()}{detail && <small> {detail}</small>}</strong>
  </div>;
}

type Tab = "review" | "competitors" | "ads" | "self" | "publish";

export function CompetitorIntelTenant({ view, onCommand, onBack }: { view: StaffTenantView; onCommand: Send; onBack?: () => void }) {
  const [tab, setTab] = useState<Tab>("review");
  const { busy, notice, run } = useCommand(onCommand);
  const unreviewed = view.changes.filter(change => !change.verdict).length;
  const queued = (kind: WorkerIntentKind) => view.intents.find(intent => intent.kind === kind && (intent.state === "queued" || intent.state === "leased"));
  const tabs: { id: Tab; label: string; badge?: number; internal?: boolean }[] = [
    { id: "review", label: "Review changes", badge: unreviewed }, { id: "competitors", label: "Competitors" },
    { id: "ads", label: "Google Ads" }, { id: "self", label: "Self-assessment", internal: true }, { id: "publish", label: "Client report" },
  ];
  const worker = (kind: WorkerIntentKind, command: CompetitorIntelCommand, label: string) => {
    const pending = queued(kind);
    return <button type="button" className="button-ghost" disabled={Boolean(busy) || Boolean(pending)}
      title={`Up to ${DAILY_INTENT_LIMITS[kind]} per client per day`}
      onClick={() => void run(kind, command, `${INTENT_TEXT[kind]} requested. Hermes picks it up on its next check.`)}>
      {pending ? `${INTENT_TEXT[kind]} ${pending.state === "leased" ? "running" : "queued"}` : busy === kind ? "Requesting…" : label}
    </button>;
  };
  return <section className="ci-staff" aria-labelledby="ci-tenant-title">
    {onBack && <button type="button" className="ci-back" onClick={onBack}>← All clients</button>}
    <header className="ci-staff-heading">
      <div>
        <h2 id="ci-tenant-title">{view.tenantName}</h2>
        <p className="ci-heading-meta">
          <StatusPill tone={view.monitoring === "active" ? "success" : view.monitoring === "paused" ? "warning" : "neutral"}>{MONITORING_TEXT[view.monitoring]}</StatusPill>
          {view.latestScan ? <FreshnessTag freshness={view.latestScan.freshness} at={view.latestScan.completedAt} label="Last scan" /> : <span className="ci-muted">No scan yet</span>}
        </p>
      </div>
      <div className="ci-actions" aria-label="Request work">
        {worker("run_scan", { kind: "run_scan", params: { scanType: "full", competitorSubjectKeys: [] } }, "Run scan")}
        {view.providerAccountRef && worker("run_ads_review", { kind: "run_ads_review", params: { providerAccountRef: view.providerAccountRef } }, "Review Google Ads")}
      </div>
    </header>
    {notice && <p className={`ci-notice ci-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.text}</p>}
    <nav className="ltds-segmented ci-tabs" role="tablist" aria-label="Competitor Intel views">
      {tabs.map(item => <button key={item.id} type="button" role="tab" id={`ci-tab-${item.id}`} aria-controls={`ci-panel-${item.id}`}
        aria-selected={tab === item.id} onClick={() => setTab(item.id)}>
        {item.label}{item.badge ? <span className="ci-tab-badge" aria-label={`${item.badge} to review`}>{item.badge}</span> : null}
        {item.internal && <span className="ci-internal-dot" aria-label="Internal only" title="Internal only" />}
      </button>)}
    </nav>
    <div role="tabpanel" id={`ci-panel-${tab}`} aria-labelledby={`ci-tab-${tab}`} className="ci-panel">
      {tab === "review" && <ReviewPanel view={view} busy={busy} run={run} />}
      {tab === "competitors" && <CompetitorsPanel competitors={view.competitors} />}
      {tab === "ads" && <AdsPanel view={view} />}
      {tab === "self" && <SelfPanel view={view} action={view.scopeKey
        ? worker("run_self_assessment", { kind: "run_self_assessment", params: { scopeKey: view.scopeKey } }, "Run self-assessment") : null} />}
      {tab === "publish" && <PublishPanel view={view} busy={busy} run={run} />}
    </div>
  </section>;
}

type Run = ReturnType<typeof useCommand>["run"];

function ReviewPanel({ view, busy, run }: { view: StaffTenantView; busy: string | null; run: Run }) {
  const [filter, setFilter] = useState<"open" | "reviewed" | "all">("open");
  const names = new Map(view.competitors.map(competitor => [competitor.subjectKey, competitor.name]));
  const rank = (change: StaffChange) => change.significance.value ? SIGNIFICANCE_ORDER.indexOf(change.significance.value) : 4;
  const changes = view.changes
    .filter(change => filter === "all" || (filter === "open" ? !change.verdict : Boolean(change.verdict)))
    .sort((a, b) => (filter === "open" ? rank(a) - rank(b) : 0) || b.detectedAt.localeCompare(a.detectedAt));
  return <div className="ci-review">
    <div className="ci-review-intro">
      <p>Your verdict checks whether Jev classified the change correctly. It never publishes anything to the client.</p>
      <div className="ltds-segmented" role="group" aria-label="Show changes">
        {(["open", "reviewed", "all"] as const).map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
          {value === "open" ? "Needs review" : value === "reviewed" ? "Reviewed" : "All"}</button>)}
      </div>
    </div>
    {!changes.length ? <EmptyState title={filter === "open" ? "Nothing left to review" : "No changes here"} detail={filter === "open" ? "New website changes appear here after each scan." : "Try a different filter."} />
      : <ol className="ci-changes">{changes.map(change => <li key={change.operationId}>
        <ChangeCard change={change} competitor={names.get(change.competitorSubjectKey) ?? "Unknown competitor"} busy={busy} run={run} />
      </li>)}</ol>}
  </div>;
}

function ChangeCard({ change, competitor, busy, run }: { change: StaffChange; competitor: string; busy: string | null; run: Run }) {
  const [editing, setEditing] = useState(!change.verdict), [note, setNote] = useState(change.verdict?.note ?? "");
  const key = `verdict:${change.operationId}`, band = confidenceBand(change.significance.confidence);
  const decide = async (verdict: "accurate" | "inaccurate") => {
    if (await run(key, { kind: "set_verdict", params: { changeOperationId: change.operationId, verdict, note: note.normalize("NFC").trim() } },
      `Marked ${verdict}.`)) setEditing(false);
  };
  return <article className={`ci-change ci-change-${change.significance.value ?? "none"}`} aria-label={`${competitor}: ${change.pageTitle ?? change.pageUrl.url}`}>
    <header>
      <div className="ci-change-tags"><SignificanceBadge value={change.significance.value} /><CategoryTag value={change.category.value} />
        {change.published && <span className="ci-tag ci-tag-published">In client report</span>}</div>
      <time dateTime={change.detectedAt}>{ciDate(change.detectedAt, true)}</time>
    </header>
    <h4>{competitor}</h4>
    <a className="ci-page-link" href={change.pageUrl.url} target="_blank" rel="noopener noreferrer">{change.pageTitle ?? change.pageUrl.url}</a>
    <p className="ci-change-summary">{change.summary}</p>
    <div className="ci-change-signals">
      <ScoreMeter label="Impact on this client" score={change.impact} compact />
      <dl>
        <div><dt>Significance</dt><dd>{confidenceText(band)}</dd></div>
        <div><dt>New service</dt><dd>{percentText(change.isNewService)}</dd></div>
        <div><dt>Pricing change</dt><dd>{percentText(change.isPricingChange)}</dd></div>
      </dl>
    </div>
    <SentenceDiff added={change.addedSentences} removed={change.removedSentences} />
    {!editing && change.verdict ? <div className={`ci-verdict ci-verdict-${change.verdict.verdict}`}>
      <p><strong>{change.verdict.verdict === "accurate" ? "Accurate" : "Inaccurate"}</strong> · {change.verdict.decidedBy}, {ciDate(change.verdict.decidedAt)}
        {change.verdict.note && <span className="ci-verdict-note">“{change.verdict.note}”</span>}</p>
      <button type="button" className="button-ghost" onClick={() => setEditing(true)}>Change verdict</button>
    </div>
      : <div className="ci-verdict-form">
        <label>Note for the team <span className="ci-muted">(optional)</span>
          <textarea rows={2} maxLength={500} value={note} onChange={event => setNote(event.target.value)} placeholder="What Jev got right or wrong" /></label>
        <div className="ci-verdict-buttons" role="group" aria-label="Is Jev's classification right?">
          <button type="button" className="button-orange" disabled={Boolean(busy)} onClick={() => void decide("accurate")}>Accurate</button>
          <button type="button" className="button-ghost" disabled={Boolean(busy)} onClick={() => void decide("inaccurate")}>Inaccurate</button>
          {change.verdict && <button type="button" className="ci-link-button" onClick={() => setEditing(false)}>Cancel</button>}
        </div>
      </div>}
  </article>;
}

function CompetitorsPanel({ competitors }: { competitors: StaffCompetitor[] }) {
  const sorted = [...competitors].sort((a, b) => Number(b.active) - Number(a.active) || (scoreValue(b) > scoreValue(a) ? 1 : scoreValue(b) < scoreValue(a) ? -1 : 0));
  if (!sorted.length) return <EmptyState title="No competitors yet" detail="Add competitors when monitoring is configured for this client." />;
  return <ul className="ci-competitors">{sorted.map(competitor => <li key={competitor.subjectKey}><CompetitorCard competitor={competitor} /></li>)}</ul>;
}

function CompetitorCard({ competitor }: { competitor: StaffCompetitor }) {
  const { baseline, adActivity } = competitor;
  return <article className="ci-competitor" aria-labelledby={`ci-comp-${competitor.subjectKey}`}>
    <header>
      <div><h4 id={`ci-comp-${competitor.subjectKey}`}>{competitor.name}</h4>
        {competitor.verifiedHomeUrl ? <a href={competitor.verifiedHomeUrl.url} target="_blank" rel="noopener noreferrer">{competitor.canonicalDomain}</a>
          : <span className="ci-muted">{competitor.canonicalDomain} · not confirmed</span>}</div>
      {!competitor.active && <StatusPill tone="neutral">Inactive</StatusPill>}
    </header>
    <p className="ci-site-line"><span className={`ci-site ci-site-${competitor.homepageStatus.fetchStatus}`}>{FETCH_TEXT[competitor.homepageStatus.fetchStatus]}</span>
      <FreshnessTag freshness={competitor.freshness} at={competitor.lastSuccessfulCheckAt} label="Checked" /></p>
    {baseline ? <>
      <div className="ci-competitor-scores">
        <ScoreMeter label="Threat" score={baseline.threat} />
        <ScoreMeter label="Service overlap" score={baseline.serviceOverlap} />
        <PercentDial label="Same service area" probability={baseline.geographicOverlap} />
      </div>
      <p className="ci-explanation">{baseline.explanation}</p>
      {(baseline.factors.helps.length > 0 || baseline.factors.hurts.length > 0) && <div className="ci-factors">
        {baseline.factors.helps.length > 0 && <div><h5>Working in their favor</h5><ul>{baseline.factors.helps.map(item => <li key={item}>{item}</li>)}</ul></div>}
        {baseline.factors.hurts.length > 0 && <div><h5>Working against them</h5><ul>{baseline.factors.hurts.map(item => <li key={item}>{item}</li>)}</ul></div>}
      </div>}
      <dl className="ci-facts">
        <div><dt>Market position</dt><dd>{baseline.marketPosition.value ? baseline.marketPosition.value[0]!.toUpperCase() + baseline.marketPosition.value.slice(1) : evidenceText(baseline.marketPosition.state, baseline.marketPosition.reason)}</dd></div>
        <div><dt>Shows pricing</dt><dd>{baseline.hasPricing.value === null ? evidenceText(baseline.hasPricing.state, baseline.hasPricing.reason) : baseline.hasPricing.value ? "Yes" : "No"}</dd></div>
        <div><dt>Pages watched</dt><dd>{competitor.monitoredPageCount}{competitor.sitePageCount.value !== null && ` of ${competitor.sitePageCount.value}`}</dd></div>
        <div><dt>Assessed</dt><dd><FreshnessTag freshness={baseline.freshness} at={baseline.assessedAt} label="On" /></dd></div>
      </dl>
    </> : <p className="ci-muted">No baseline assessment yet.</p>}
    <section className="ci-ads-activity" aria-label={`${competitor.name} Google ads`}>
      <h5>Google ads</h5>
      {!adActivity ? <p className="ci-muted">Not checked yet.</p> : adActivity.status === "observed" ? <>
        <p><strong>{adActivity.adCount.value === null ? "Ads found" : `${adActivity.adCount.approximate ? "About " : ""}${adActivity.adCount.value} ads`}</strong>
          {adActivity.lastShownDate && <> · last shown {ciDate(adActivity.lastShownDate)}</>}
          {adActivity.formats.length > 0 && <> · {adActivity.formats.join(", ")}</>}</p>
        <div className="ci-competitor-scores ci-two">
          <ScoreMeter label="Ad activity" score={adActivity.activityEvidence} compact />
          <ScoreMeter label="Ad message concern" score={adActivity.adCopyConcern} compact />
        </div>
      </> : <p>{evidenceText(adActivity.status, adActivity.reason)}</p>}
      {adActivity && <p className="ci-source"><a href={adActivity.sourceUrl.url} target="_blank" rel="noopener noreferrer">Google Ads Transparency Center</a>
        <FreshnessTag freshness={adActivity.freshness} at={adActivity.checkedAt} label="Checked" /></p>}
    </section>
  </article>;
}

function AdsPanel({ view }: { view: StaffTenantView }) {
  const ads = view.ownAds;
  if (!ads) return <EmptyState title="No Google Ads checkup yet" detail={view.providerAccountRef ? "Request a Google Ads review to get the first checkup." : "This client has no connected Google Ads account."} />;
  const totals = ads.totals, metrics = totals.metricsState === "observed";
  const number = (value: number | null) => value === null ? "—" : value.toLocaleString();
  return <div className="ci-ads">
    <header className="ci-section-head">
      <div><h3>Google Ads checkup</h3><p className="ci-muted">{ciDate(ads.period.start)} – {ciDate(ads.period.end)} · {ads.period.daysWithData} days with data. Read-only; nothing is changed in Google Ads.</p></div>
      <FreshnessTag freshness={ads.totalsFreshness} at={ads.period.end} label="Totals through" />
    </header>
    {metrics ? <div className="ci-tiles ci-tiles-ads" role="list" aria-label="Ads totals">
      <Metric label="Spend" value={moneyText(totals.spend)} /><Metric label="Clicks" value={number(totals.clicks)} />
      <Metric label="Impressions" value={number(totals.impressions)} /><Metric label="Conversions" value={totals.conversions ? scoreNumberless(totals.conversions) : "—"} />
      <Metric label="Cost per conversion" value={totals.costPerConversion ? moneyText(totals.costPerConversion) : "No conversions"} />
      <Metric label="Click-through rate" value={totals.ctrPercent ? `${scoreNumberless(totals.ctrPercent)}%` : "—"} />
    </div> : <p className="ci-notice ci-notice-warn">{evidenceText(totals.metricsState, totals.metricsReason)}</p>}
    <div className="ci-section-head"><h4>Checkup scores</h4><FreshnessTag freshness={ads.scoresFreshness} at={ads.checkedAt} label="Scored" /></div>
    <div className="ci-score-grid">
      <ScoreMeter label="Performance concern" score={ads.scores.performance} />
      <ScoreMeter label="Conversion tracking gap" score={ads.scores.measurementGap} />
      <ScoreMeter label="Ad message concern" score={ads.scores.adCopy} />
      <ScoreMeter label="Ad-to-page mismatch" score={ads.scores.landingPageMismatch} />
    </div>
    {(ads.focus.label || ads.findings.copyDriver || ads.findings.landingPageDriver) && <div className="ci-findings">
      {ads.focus.label && <p><strong>Focus next:</strong> {ads.focus.label}</p>}
      {ads.findings.copyDriver && <p><strong>Ad message:</strong> {ads.findings.copyDriver}</p>}
      {ads.findings.landingPageDriver && <p><strong>Landing page:</strong> {ads.findings.landingPageDriver}</p>}
    </div>}
    {ads.campaigns.length > 0 && <div className="ci-table-wrap"><table className="ci-table">
      <caption>Campaigns</caption>
      <thead><tr><th scope="col">Campaign</th><th scope="col">Status</th><th scope="col">Cost</th><th scope="col">Clicks</th><th scope="col">Conversions</th></tr></thead>
      <tbody>{ads.campaigns.map(campaign => <tr key={campaign.name}><th scope="row">{campaign.name}<small>{campaign.type}</small></th><td>{campaign.status}</td>
        <td>{moneyText(campaign.cost)}</td><td>{campaign.clicks.toLocaleString()}</td><td>{scoreNumberless(campaign.conversions)}</td></tr>)}</tbody>
    </table></div>}
    {ads.campaignScopeNote && <p className="ci-muted ci-small">{ads.campaignScopeNote}</p>}
    {ads.activeSearchAds.length > 0 && <section className="ci-internal" aria-labelledby="ci-search-ads">
      <header><h4 id="ci-search-ads">Active search ads</h4><span className="ci-internal-badge">Internal · never shown to the client</span></header>
      <ul className="ci-search-ads">{ads.activeSearchAds.map((ad, index) => <li key={`${ad.campaign}-${ad.adGroup}-${index}`}>
        <p className="ci-ad-path">{ad.campaign} › {ad.adGroup}</p>
        <p className="ci-ad-headline">{ad.headlines.join(" | ")}</p>
        <p>{ad.descriptions.join(" ")}</p>
        <p className="ci-ad-url">{ad.finalUrl}</p>
        <p className="ci-muted ci-small">{ad.impressions.toLocaleString()} impressions · {ad.clicks.toLocaleString()} clicks · {scoreNumberless(ad.conversions)} conversions · {moneyText(ad.cost)}</p>
      </li>)}</ul>
    </section>}
  </div>;
}

/** Decimal text without trailing zeros, for counts like conversions (12.50 -> 12.5). */
function scoreNumberless(value: string) {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div role="listitem" className="ci-tile"><span>{label}</span><strong>{value}</strong></div>;
}

const SELF_LABELS = { positioning: "Positioning", serviceCoverage: "Service coverage", geographicMessaging: "Service-area messaging",
  pricingClarity: "Pricing clarity", differentiation: "Differentiation", competitiveReadiness: "Competitive readiness" } as const;

function SelfPanel({ view, action }: { view: StaffTenantView; action: ReactNode }) {
  const self = view.selfAssessment;
  return <div className="ci-internal ci-self">
    <header><div><h3>How this client compares</h3><span className="ci-internal-badge">Internal · never shown to the client</span></div>{action}</header>
    {!self ? <EmptyState title="No self-assessment yet" detail="Run a self-assessment to score this client's own positioning." /> : <>
      <div className="ci-self-overall"><ScoreMeter label="Overall concern" score={self.scores.overall} />
        <FreshnessTag freshness={self.freshness} at={self.assessedAt} label="Assessed" /></div>
      <div className="ci-score-grid">{(Object.keys(SELF_LABELS) as (keyof typeof SELF_LABELS)[]).map(key =>
        <ScoreMeter key={key} label={SELF_LABELS[key]} score={self.scores[key]} compact />)}</div>
      <div className="ci-self-lists">
        <List title="Strengths" items={self.strengths} />
        <List title="Weaknesses" items={self.weaknesses} />
        <List title="Recommended next steps" items={self.recommendedActions} ordered />
      </div>
    </>}
  </div>;
}

function List({ title, items, ordered = false }: { title: string; items: string[]; ordered?: boolean }) {
  if (!items.length) return null;
  const body = items.map(item => <li key={item}>{item}</li>);
  return <div><h5>{title}</h5>{ordered ? <ol>{body}</ol> : <ul>{body}</ul>}</div>;
}

const ref = (item: ObservationRef): ObservationRef => ({ operationId: item.operationId, payloadSha256: item.payloadSha256 });
const MAX_ITEMS = 200;

function PublishPanel({ view, busy, run }: { view: StaffTenantView; busy: string | null; run: Run }) {
  const accurate = view.changes.filter(change => change.verdict?.verdict === "accurate");
  const inaccurate = view.changes.filter(change => change.verdict?.verdict === "inaccurate").length;
  const unreviewed = view.changes.filter(change => !change.verdict).length;
  const month = new Date().toLocaleString(undefined, { month: "long", year: "numeric" });
  const [title, setTitle] = useState(`Competitor report · ${month}`);
  const [competitors, setCompetitors] = useState(() => new Set(view.competitors.filter(item => item.active).map(item => item.subjectKey)));
  const [changes, setChanges] = useState(() => new Set(accurate.map(change => change.operationId)));
  const [includeAds, setIncludeAds] = useState(Boolean(view.ownAds));
  const [withdrawing, setWithdrawing] = useState(false), [reason, setReason] = useState("");
  const toggle = (set: Set<string>, update: (next: Set<string>) => void, key: string) => { const next = new Set(set); if (!next.delete(key)) next.add(key); update(next); };
  const items: ObservationRef[] = [
    ...view.competitors.filter(item => competitors.has(item.subjectKey)).flatMap(item => [ref(item), ...(item.baseline ? [ref(item.baseline)] : []), ...(item.adActivity ? [ref(item.adActivity)] : [])]),
    ...accurate.filter(change => changes.has(change.operationId)).map(ref),
    ...(includeAds && view.ownAds ? [ref(view.ownAds)] : []),
  ];
  const cleanTitle = title.normalize("NFC").trim(), tooMany = items.length > MAX_ITEMS;
  const publish = async () => {
    if (!items.length || tooMany || !cleanTitle) return;
    if (!await confirmAction(`Publish “${cleanTitle}” to ${view.tenantName}? They will see exactly these ${items.length} items${view.manifest?.status === "published" ? ", replacing the current report" : ""}.`)) return;
    await run("publish", { kind: "publish", params: { items, reportTitle: cleanTitle } }, "Report publish requested.");
  };
  const withdraw = async () => {
    const text = reason.normalize("NFC").trim();
    if (!view.manifest || !text) return;
    if (!await confirmAction(`Withdraw the current report from ${view.tenantName}? They will see no report until you publish a new one.`)) return;
    if (await run("withdraw", { kind: "withdraw", params: { manifestId: view.manifest.manifestId, reason: text } }, "Withdrawal requested.")) setWithdrawing(false);
  };
  return <div className="ci-publish">
    <section className="ci-current" aria-labelledby="ci-current-title">
      <h3 id="ci-current-title">What the client sees now</h3>
      {!view.manifest ? <p className="ci-muted">Nothing yet. The client's portal shows no competitor report until you publish one.</p>
        : <div className={`ci-manifest ci-manifest-${view.manifest.status}`}>
          <div><strong>{view.manifest.reportTitle}</strong>
            <p className="ci-muted">{view.manifest.status === "published" ? "Published" : "Withdrawn"} {ciDate(view.manifest.publishedAt, true)} by {view.manifest.publishedBy}
              {" "}· revision {view.manifest.revision} · {view.manifest.itemCount} items</p></div>
          {view.manifest.status === "published" && !withdrawing && <button type="button" className="button-ghost" onClick={() => setWithdrawing(true)}>Withdraw report</button>}
        </div>}
      {withdrawing && <div className="ci-withdraw">
        <label>Reason for withdrawing<textarea rows={2} maxLength={300} value={reason} onChange={event => setReason(event.target.value)} /></label>
        <div className="ci-verdict-buttons">
          <button type="button" className="button-danger" disabled={Boolean(busy) || !reason.trim()} onClick={() => void withdraw()}>Withdraw report</button>
          <button type="button" className="ci-link-button" onClick={() => setWithdrawing(false)}>Cancel</button>
        </div>
      </div>}
    </section>
    <section className="ci-builder" aria-labelledby="ci-builder-title">
      <h3 id="ci-builder-title">Publish a new report</h3>
      <p className="ci-muted">Only what you tick goes out. Internal notes, verdicts, the self-assessment and search-ad copy are never included.</p>
      <label className="ci-title-field">Report title<input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /></label>
      <fieldset><legend>Competitors <span className="ci-muted">profile, assessment and ad activity</span></legend>
        {view.competitors.map(item => <label key={item.subjectKey} className="ci-check">
          <input type="checkbox" checked={competitors.has(item.subjectKey)} onChange={() => toggle(competitors, setCompetitors, item.subjectKey)} />
          <span>{item.name}{!item.baseline && <small className="ci-muted"> · no assessment yet</small>}{item.freshness === "stale" && <small className="ci-warn-text"> · out of date</small>}</span>
        </label>)}
      </fieldset>
      <fieldset><legend>Website changes <span className="ci-muted">marked accurate</span></legend>
        {!accurate.length && <p className="ci-muted">No changes are marked accurate yet.</p>}
        {accurate.map(change => <label key={change.operationId} className="ci-check">
          <input type="checkbox" checked={changes.has(change.operationId)} onChange={() => toggle(changes, setChanges, change.operationId)} />
          <span><SignificanceBadge value={change.significance.value} /> {view.competitors.find(item => item.subjectKey === change.competitorSubjectKey)?.name}: {change.summary}
            {change.published && <small className="ci-muted"> · already in the current report</small>}</span>
        </label>)}
        {(unreviewed > 0 || inaccurate > 0) && <p className="ci-muted ci-small">{[unreviewed && `${unreviewed} still need review`, inaccurate && `${inaccurate} marked inaccurate and never published`].filter(Boolean).join(" · ")}</p>}
      </fieldset>
      {view.ownAds && <fieldset><legend>Google Ads</legend>
        <label className="ci-check"><input type="checkbox" checked={includeAds} onChange={event => setIncludeAds(event.target.checked)} />
          <span>Google Ads overview <small className="ci-muted">· totals, scores and campaigns only</small></span></label>
      </fieldset>}
      <div className="ci-publish-bar">
        <span className={tooMany ? "ci-warn-text" : "ci-muted"}>{items.length} item{items.length === 1 ? "" : "s"}{tooMany && ` · limit is ${MAX_ITEMS}`}</span>
        <button type="button" className="button-orange" disabled={Boolean(busy) || !items.length || tooMany || !cleanTitle} onClick={() => void publish()}>
          {busy === "publish" ? "Publishing…" : "Publish to client"}</button>
      </div>
    </section>
  </div>;
}

