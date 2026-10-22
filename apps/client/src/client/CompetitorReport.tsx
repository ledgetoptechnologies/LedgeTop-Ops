import { EmptyState } from "@ltds/ui";
import { CategoryTag, FreshnessTag, PercentDial, ScoreMeter, SentenceDiff, SignificanceBadge, ciDate } from "@ltds/ui/competitor-intel";
import { decimalMicros, evidenceText, moneyText, type ClientCompetitorReport } from "@ltds/shared/competitor-intel";
import "./CompetitorReport.css";

// Design-only portal view of a published Competitor Intel report (client.v1).
// It renders exactly the pinned items it is given and has no actions.

type Competitor = ClientCompetitorReport["competitors"][number];
const threat = (item: Competitor) => item.threat?.state === "observed" && item.threat.value ? decimalMicros(item.threat.value) : -1n;
const trimDecimal = (value: string) => value.includes(".") ? value.replace(/\.?0+$/, "") : value;

export function CompetitorReport({ report }: { report: ClientCompetitorReport | null }) {
  if (!report) return <section className="ci-report" aria-labelledby="ci-report-title">
    <h2 id="ci-report-title">Competitor watch</h2>
    <EmptyState title="No competitor report yet" detail="When Ledge Top finishes reviewing your competitors, the report will appear here." />
  </section>;
  const competitors = [...report.competitors].sort((a, b) => threat(b) > threat(a) ? 1 : threat(b) < threat(a) ? -1 : a.name.localeCompare(b.name));
  return <section className="ci-report" aria-labelledby="ci-report-title">
    <header className="ci-report-head">
      <div>
        <h2 id="ci-report-title">Competitor watch</h2>
        <p>{report.reportTitle}</p>
      </div>
      <div className="ci-report-stamp">
        <span className="ci-reviewed"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>Reviewed by Ledge Top</span>
        <span className="ci-muted">Published {ciDate(report.publishedAt)}</span>
      </div>
    </header>
    <p className="ci-coverage">
      Watching <strong>{report.coverage.competitorsMonitored} competitor{report.coverage.competitorsMonitored === 1 ? "" : "s"}</strong>
      {" · "}<FreshnessTag freshness={report.coverage.freshness} at={report.coverage.lastWebsiteCheckAt} label="Websites checked" />
    </p>

    {competitors.length > 0 && <section className="ci-report-section" aria-labelledby="ci-who">
      <h3 id="ci-who">Who to keep an eye on</h3>
      <ol className="ci-report-competitors">{competitors.map(item => <li key={item.canonicalDomain}><CompetitorSummary item={item} /></li>)}</ol>
    </section>}

    <section className="ci-report-section" aria-labelledby="ci-changes">
      <h3 id="ci-changes">What changed</h3>
      {!report.changes.length ? <p className="ci-muted">No notable changes on competitor websites in this report.</p>
        : <ol className="ci-timeline">{report.changes.map((change, index) => <li key={`${change.pageUrl}-${change.detectedAt}-${index}`}>
          <article aria-label={`${change.competitorName}: ${change.summary}`}>
            <header><span className="ci-timeline-tags"><SignificanceBadge value={change.significance} /><CategoryTag value={change.category} /></span>
              <time dateTime={change.detectedAt}>{ciDate(change.detectedAt)}</time></header>
            <h4>{change.competitorName}</h4>
            <p>{change.summary}</p>
            <a href={change.pageUrl} target="_blank" rel="noopener noreferrer">{change.pageTitle ?? "View the page"}</a>
            <SentenceDiff added={change.addedSentences} removed={change.removedSentences} />
          </article>
        </li>)}</ol>}
    </section>

    {report.ownAds && <OwnAds ads={report.ownAds} />}
  </section>;
}

function CompetitorSummary({ item }: { item: Competitor }) {
  const ads = item.adActivity;
  return <article className="ci-report-card" aria-labelledby={`ci-c-${item.canonicalDomain}`}>
    <header>
      <h4 id={`ci-c-${item.canonicalDomain}`}>{item.name}</h4>
      {item.verifiedHomeUrl ? <a href={item.verifiedHomeUrl.url} target="_blank" rel="noopener noreferrer">{item.canonicalDomain}</a> : <span className="ci-muted">{item.canonicalDomain}</span>}
    </header>
    <div className="ci-report-scores">
      {item.threat && <ScoreMeter label="Threat to your business" score={item.threat} />}
      {item.serviceOverlap && <ScoreMeter label="Services in common" score={item.serviceOverlap} />}
      {item.geographicOverlap && <PercentDial label="Same service area" probability={item.geographicOverlap} />}
    </div>
    {item.explanation && <p className="ci-report-why">{item.explanation}</p>}
    {item.factors && (item.factors.helps.length > 0 || item.factors.hurts.length > 0) && <div className="ci-report-factors">
      {item.factors.helps.length > 0 && <div><h5>Their strengths</h5><ul>{item.factors.helps.map(text => <li key={text}>{text}</li>)}</ul></div>}
      {item.factors.hurts.length > 0 && <div><h5>Their gaps</h5><ul>{item.factors.hurts.map(text => <li key={text}>{text}</li>)}</ul></div>}
    </div>}
    {ads && <p className="ci-report-ads">
      <strong>Google ads: </strong>
      {ads.status === "observed" ? <>{ads.adCount.value === null ? "Running ads" : `${ads.adCount.approximate ? "About " : ""}${ads.adCount.value} ads`}
        {ads.lastShownDate && `, last seen ${ciDate(ads.lastShownDate)}`}</> : ads.status === "none_found" ? "No ads found" : evidenceText(ads.status, ads.reason)}
      <span className="ci-muted"> · From Google's public Ads Transparency Center; counts are approximate. <a href={ads.sourceUrl} target="_blank" rel="noopener noreferrer">See their ads</a></span>
    </p>}
  </article>;
}

function OwnAds({ ads }: { ads: NonNullable<ClientCompetitorReport["ownAds"]> }) {
  const totals = ads.totals, observed = totals.metricsState === "observed";
  const tile = (label: string, value: string) => <div role="listitem"><span>{label}</span><strong>{value}</strong></div>;
  return <section className="ci-report-section" aria-labelledby="ci-own-ads">
    <div className="ci-report-section-head">
      <h3 id="ci-own-ads">How your Google Ads are doing</h3>
      <FreshnessTag freshness={ads.freshness} at={ads.period.end} label="Through" />
    </div>
    <p className="ci-muted">{ciDate(ads.period.start)} – {ciDate(ads.period.end)}. A read-only overview; nothing in your Google Ads account is changed.</p>
    {observed ? <div className="ci-report-tiles" role="list" aria-label="Google Ads totals">
      {tile("Spent", moneyText(totals.spend))}
      {tile("Clicks", totals.clicks === null ? "—" : totals.clicks.toLocaleString())}
      {tile("Leads", totals.conversions === null ? "—" : trimDecimal(totals.conversions))}
      {tile("Cost per lead", totals.costPerConversion ? moneyText(totals.costPerConversion) : "No leads yet")}
    </div> : <p className="ci-report-note">{evidenceText(totals.metricsState, totals.metricsReason)}</p>}
    <div className="ci-report-scores ci-report-scores-grid">
      <ScoreMeter label="Results concern" score={ads.scores.performance} />
      <ScoreMeter label="Lead-tracking gaps" score={ads.scores.measurementGap} />
      <ScoreMeter label="Ad wording concern" score={ads.scores.adCopy} />
      <ScoreMeter label="Ad-to-page mismatch" score={ads.scores.landingPageMismatch} />
    </div>
    {(ads.focus || ads.findings.copyDriver || ads.findings.landingPageDriver) && <div className="ci-report-focus">
      {ads.focus && <p><strong>What we're looking at next:</strong> {ads.focus}</p>}
      {ads.findings.copyDriver && <p>{ads.findings.copyDriver}</p>}
      {ads.findings.landingPageDriver && <p>{ads.findings.landingPageDriver}</p>}
    </div>}
    {ads.campaigns.length > 0 && <div className="ci-report-table"><table>
      <caption>Campaigns</caption>
      <thead><tr><th scope="col">Campaign</th><th scope="col">Spent</th><th scope="col">Clicks</th><th scope="col">Leads</th></tr></thead>
      <tbody>{ads.campaigns.map(campaign => <tr key={campaign.name}><th scope="row">{campaign.name}<small>{campaign.status}</small></th>
        <td>{moneyText(campaign.cost)}</td><td>{campaign.clicks.toLocaleString()}</td><td>{trimDecimal(campaign.conversions)}</td></tr>)}</tbody>
    </table></div>}
  </section>;
}
