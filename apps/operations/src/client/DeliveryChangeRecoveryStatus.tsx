import { useEffect, useState } from "react";
import { Card, StatusPill } from "@ltds/ui";
import { api } from "./api";
import "./DeliveryChangeRecoveryStatus.css";

type State = "ready" | "attention" | "disabled" | "unavailable";
type Reason = "schema_unavailable" | "status_unavailable";
type FailureReason = "authority-suppressed" | "staging-fence" | "staging-schema" | "staging-invalid" | "staging-failed";
type Counts = { pending: number; processing: number; completed: number; failed: number };
type Failure = { reason: FailureReason; count: number };
type RecoveryStatus = {
  enabled: boolean; state: State; reason: Reason | null; counts: Counts | null; failures: Failure[];
  oldestPendingAt: string | null; lastFailureAt: string | null;
};

const states = new Set<State>(["ready", "attention", "disabled", "unavailable"]);
const reasons = new Set<Reason>(["schema_unavailable", "status_unavailable"]);
const failureReasons = new Set<FailureReason>(["authority-suppressed", "staging-fence", "staging-schema", "staging-invalid", "staging-failed"]);
const failureLabels: Record<FailureReason, string> = {
  "authority-suppressed": "Authority suppressed",
  "staging-fence": "Staging fence",
  "staging-schema": "Staging schema",
  "staging-invalid": "Staging invalid",
  "staging-failed": "Staging failed",
};

function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function utc(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}
function nullableUtc(value: unknown): value is string | null { return value === null || utc(value); }
function verifiedStatus(value: unknown): RecoveryStatus {
  if (!value || typeof value !== "object") throw new Error("invalid");
  const row = value as Partial<RecoveryStatus>;
  if (typeof row.enabled !== "boolean" || !states.has(row.state as State) || (row.reason !== null && !reasons.has(row.reason as Reason))
    || !Array.isArray(row.failures) || row.failures.length > 5 || !nullableUtc(row.oldestPendingAt) || !nullableUtc(row.lastFailureAt)) throw new Error("invalid");
  if (row.state === "unavailable") {
    if (row.counts !== null || row.failures.length !== 0 || row.oldestPendingAt !== null || row.lastFailureAt !== null || row.reason === null) throw new Error("invalid");
  } else {
    const counts = row.counts;
    if (row.reason !== null || !counts || !nonnegative(counts.pending) || !nonnegative(counts.processing) || !nonnegative(counts.completed) || !nonnegative(counts.failed)) throw new Error("invalid");
    const expectedState: State = !row.enabled ? "disabled" : counts.failed > 0 ? "attention" : "ready";
    if (row.state !== expectedState || (counts.pending + counts.processing > 0) !== (row.oldestPendingAt !== null)
      || (counts.failed > 0) !== (row.lastFailureAt !== null)) throw new Error("invalid");
  }
  const failureTotal = row.failures.reduce((total, item) => total + (item?.count ?? 0), 0);
  if (row.failures.some(item => !item || !failureReasons.has(item.reason) || !nonnegative(item.count) || item.count < 1)
    || new Set(row.failures.map(item => item.reason)).size !== row.failures.length
    || !Number.isSafeInteger(failureTotal) || row.counts != null && failureTotal !== row.counts.failed) throw new Error("invalid");
  return row as RecoveryStatus;
}

function tone(state: State): "success" | "warning" | "neutral" | "danger" {
  return state === "ready" ? "success" : state === "disabled" ? "neutral" : state === "attention" ? "warning" : "danger";
}
function stateLabel(state: State): string { return state === "ready" ? "No terminal failures recorded" : state === "disabled" ? "paused" : state; }
function formatTime(value: string | null): string { return value ? new Date(value).toLocaleString() : "Not recorded"; }

export function DeliveryChangeRecoveryStatus() {
  const [data, setData] = useState<RecoveryStatus | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(""), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(""); setLoading(true);
    api<unknown>("/api/admin/delivery-change-recovery", { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setData(verifiedStatus(value)); setLoading(false); } })
      .catch(() => { if (!controller.signal.aborted) { setData(null); setLoading(false); setError("Delivery recovery status could not be checked."); } });
    return () => controller.abort();
  }, [revision]);
  return <Card className="delivery-change-recovery-card" title="Delivery notification recovery" action={<button type="button" className="button-ghost button-small"
    disabled={loading} onClick={() => setRevision(value => value + 1)}>{loading && revision > 0 ? "Refreshing…" : "Refresh delivery recovery"}</button>}>
    <div className="delivery-change-recovery">
      <p>Read-only status for accepted delivery-change projection. Completed means a target was staged or suppressed; it does not mean email was delivered.</p>
      {error && <p className="notice" role="alert">{error}</p>}
      {loading && !error && <p role="status">{revision ? "Refreshing delivery recovery…" : "Checking delivery recovery…"}</p>}
      {data && <>
        <div className="delivery-change-recovery-summary"><StatusPill tone={tone(data.state)}>{stateLabel(data.state)}</StatusPill>
          <span>{data.enabled ? "Recovery is enabled." : data.state === "unavailable" ? "Recovery is paused." : "Recovery is paused; existing jobs remain visible."}</span></div>
        {data.reason && <p className="notice">{data.reason === "schema_unavailable" ? "Required database schema is unavailable." : "Recovery status is unavailable."}</p>}
        {data.counts && <dl className="delivery-change-recovery-counts">
          <div><dt>Pending</dt><dd>{data.counts.pending}</dd></div><div><dt>Processing</dt><dd>{data.counts.processing}</dd></div>
          <div><dt>Completed</dt><dd>{data.counts.completed}</dd></div><div><dt>Failed</dt><dd>{data.counts.failed}</dd></div>
        </dl>}
        {data.counts && <dl className="delivery-change-recovery-times"><div><dt>Oldest outstanding</dt><dd>{data.oldestPendingAt ? <time dateTime={data.oldestPendingAt}>{formatTime(data.oldestPendingAt)}</time> : "Not recorded"}</dd></div>
          <div><dt>Last failure</dt><dd>{data.lastFailureAt ? <time dateTime={data.lastFailureAt}>{formatTime(data.lastFailureAt)}</time> : "Not recorded"}</dd></div></dl>}
        {data.failures.length > 0 && <section aria-label="Recovery failure counts"><h3>Failure counts</h3><ul>{data.failures.map(item => <li key={item.reason}>{failureLabels[item.reason]}: {item.count}</li>)}</ul></section>}
      </>}
    </div>
  </Card>;
}
