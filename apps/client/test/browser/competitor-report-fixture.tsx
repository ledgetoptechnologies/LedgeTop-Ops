import { createRoot } from "react-dom/client";
import "@ltds/ui/styles.css";
import "../../src/client/styles.css";
import { CompetitorReport } from "../../src/client/CompetitorReport";
import { sampleClientReport } from "../../../../packages/shared/test-fixtures/competitor-intel-sample";

type Mode = "report" | "none" | "no-metrics" | "zero-conversions" | "cost-unknown" | "count-unknown";
const mode = (window as Window & { ciMode?: Mode }).ciMode ?? "report";
const totals = (patch: Partial<NonNullable<typeof sampleClientReport.ownAds>["totals"]>) =>
  ({ ...sampleClientReport, ownAds: { ...sampleClientReport.ownAds!, totals: { ...sampleClientReport.ownAds!.totals, ...patch } } });
const report = mode === "zero-conversions" ? totals({ conversions: "0.00", costPerConversion: null })
  : mode === "cost-unknown" ? totals({ costPerConversion: null })
  : mode === "count-unknown" ? totals({ conversions: null, costPerConversion: null })
  : mode === "none" ? null : mode === "no-metrics" ? { ...sampleClientReport, changes: [],
  ownAds: { ...sampleClientReport.ownAds!, totals: { spend: null, clicks: null, impressions: null, conversions: null, costPerConversion: null,
    metricsState: "failed" as const, metricsReason: "provider_metrics_failed" as const } } } : sampleClientReport;
createRoot(document.getElementById("root")!).render(<main style={{ padding: "16px", maxWidth: "1100px", margin: "0 auto" }}><CompetitorReport report={report} /></main>);
