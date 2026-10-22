import { createRoot } from "react-dom/client";
import "@ltds/ui/styles.css";
import "../../src/client/styles.css";
import { CompetitorReport } from "../../src/client/CompetitorReport";
import { sampleClientReport } from "../../../../packages/shared/test-fixtures/competitor-intel-sample";

const mode = (window as Window & { ciMode?: "report" | "none" | "no-metrics" }).ciMode ?? "report";
const report = mode === "none" ? null : mode === "no-metrics" ? { ...sampleClientReport, changes: [],
  ownAds: { ...sampleClientReport.ownAds!, totals: { spend: null, clicks: null, impressions: null, conversions: null, costPerConversion: null,
    metricsState: "failed" as const, metricsReason: "provider_metrics_failed" as const } } } : sampleClientReport;
createRoot(document.getElementById("root")!).render(<main style={{ padding: "16px", maxWidth: "1100px", margin: "0 auto" }}><CompetitorReport report={report} /></main>);
