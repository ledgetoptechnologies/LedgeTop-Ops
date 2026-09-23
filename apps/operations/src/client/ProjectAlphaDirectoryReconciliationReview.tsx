import { useEffect, useRef, useState } from "react";
import { Card } from "@ltds/ui";
import { api, ApiError } from "./api";

const ROOT = "/api/admin/project-alpha/private/directory/reconciliation";
const PRODUCTION_SOURCES = ["project-alpha:primary", "project-alpha:secondary"] as const;
const STAGING_SOURCES = ["project-alpha:staging"] as const;
function reviewSources(): readonly string[] {
  return window.location.hostname === "ops-staging.ledgetopdroneservices.com"
    ? STAGING_SOURCES : PRODUCTION_SOURCES;
}
const ADOPTABLE = new Set(["extra_remote", "public_id_mismatch", "external_id_mismatch", "binding_mismatch"]);

type ResourceType = "client" | "organization";
type Finding = {
  findingId: string; sourceId: string; classification: string; resourceType: ResourceType;
  reviewState: "open" | "acknowledged" | "dismissed" | "resolved"; localRecordId: string | null;
  localPublicId: string | null; remotePublicId: string | null; remoteRevision: string | null;
  present: boolean | null; lastAction: "upsert" | "delete" | null; bindingRecordId: string | null;
  bindingStatus: "active" | "tombstoned" | null; bindingRevision: string | null; createdAt: string;
};
type FindingPage = { items: Finding[]; nextCursor: string | null };
type NativeRecord = { recordId: string; resourceType: ResourceType; currentVersion: number;
  displayName: string; contactEmail: string | null };
type NativeRecordPage = { items: NativeRecord[]; nextCursor: string | null };
type FindingContext = { findingId: string; resourceType: ResourceType; displayName: string;
  contactEmail: string | null; organizationPublicId: string | null };
type AcquisitionOutcome =
  | { status: "acquired"; actionId: string; findingId: string; acquiredReceiptId: string; replayed: boolean }
  | { status: "uncertain"; reason: "remote" | "database" | "acquisition" }
  | { status: "blocked"; reason: "stale_snapshot" | "remote" | "acquisition" }
  | { status: "conflict"; reason: "reservation" | "acquisition" }
  | { status: "rejected"; reason: "invalid_input" };

const classificationLabels: Record<string, string> = {
  missing_remote: "Missing from Project Alpha",
  extra_remote: "Extra Project Alpha record",
  public_id_mismatch: "Public ID mismatch",
  external_id_mismatch: "External ID mismatch",
  revision_mismatch: "Revision mismatch",
  projection_mismatch: "Projection mismatch",
  presence_mismatch: "Presence mismatch",
  binding_mismatch: "Binding mismatch",
  relationship_mismatch: "Relationship mismatch",
};

function sourceLabel(sourceId: string): string {
  if (sourceId === PRODUCTION_SOURCES[0]) return "Ledge Top Drone Services Project Alpha";
  if (sourceId === PRODUCTION_SOURCES[1]) return "Ledge Top Technologies Project Alpha";
  if (sourceId === STAGING_SOURCES[0]) return "Project Alpha staging";
  return "Unknown Project Alpha source";
}
function date(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
}
function presence(value: boolean | null): string {
  return value === null ? "Not reported" : value ? "Present" : "Absent";
}
function errorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError && caught.status === 404) return "The private reconciliation review transport is unavailable.";
  return caught instanceof Error ? caught.message : fallback;
}

function RecordSelection({ finding, onAcquired }: { finding: Finding; onAcquired: (findingId: string) => void }) {
  const [open, setOpen] = useState(false), [records, setRecords] = useState<NativeRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null), [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false), [submitting, setSubmitting] = useState(false);
  const [contextLoading, setContextLoading] = useState(false), [context, setContext] = useState<FindingContext | null>(null);
  const [message, setMessage] = useState(""), [error, setError] = useState("");
  const idempotencyKey = useRef<string | null>(null);

  const load = async (cursor?: string) => {
    if (loading) return;
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ resourceType: finding.resourceType, limit: "25" });
      if (cursor) query.set("cursor", cursor);
      const page = await api<NativeRecordPage>(`${ROOT}/records?${query}`);
      setRecords(current => cursor
        ? [...current, ...page.items.filter(item => !current.some(existing => existing.recordId === item.recordId))]
        : page.items);
      setNextCursor(page.nextCursor);
    } catch (caught) { setError(errorMessage(caught, "Existing Operations records could not be loaded.")); }
    finally { setLoading(false); }
  };
  const loadContext = async () => {
    setContextLoading(true); setError("");
    try {
      const value = await api<FindingContext>(`${ROOT}/findings/${encodeURIComponent(finding.findingId)}/context`);
      if (value.findingId !== finding.findingId || value.resourceType !== finding.resourceType)
        throw new Error("The current Project Alpha record context did not match this finding.");
      setContext(value);
    } catch (caught) { setError(errorMessage(caught, "Current Project Alpha record context could not be loaded.")); }
    finally { setContextLoading(false); }
  };
  const begin = () => { setOpen(true); void load(); void loadContext(); };
  const acquire = async () => {
    const record = records.find(item => item.recordId === selected);
    if (!record || submitting) return;
    if (!window.confirm(`Acquire this Project Alpha record for existing ${record.resourceType} record ${record.recordId} at version ${record.currentVersion}? The mapping will remain inactive pending separate review.`)) return;
    const key = idempotencyKey.current ?? crypto.randomUUID();
    idempotencyKey.current = key;
    setSubmitting(true); setError(""); setMessage("");
    try {
      const outcome = await api<AcquisitionOutcome>(`${ROOT}/acquire`, {
        method: "POST", headers: { "Idempotency-Key": key }, body: JSON.stringify({
          findingId: finding.findingId, recordId: record.recordId,
          expectedRecordVersion: record.currentVersion, idempotencyKey: key,
        }),
      });
      if (outcome.status === "acquired") {
        setMessage(`Acquired${outcome.replayed ? " (confirmed replay)" : ""}. The mapping is inactive and pending separate activation review.`);
        onAcquired(finding.findingId);
      } else if (outcome.status === "uncertain") {
        setError(`Acquisition outcome is uncertain (${outcome.reason}). Retry this exact selection to check the same action safely.`);
      } else if (outcome.status === "blocked") {
        setError(outcome.reason === "stale_snapshot"
          ? "The reconciliation snapshot or record version changed. Refresh findings and choose again."
          : `Acquisition is blocked because ${outcome.reason} verification did not complete.`);
      } else if (outcome.status === "conflict") {
        setError("This finding or native record conflicts with an existing reservation. Refresh before making another selection.");
      } else setError("The selected record was rejected. Refresh and verify the exact current version.");
    } catch (caught) {
      setError(`${errorMessage(caught, "The acquisition request failed.")} The outcome may be uncertain; retry keeps the same action identifier.`);
    } finally { setSubmitting(false); }
  };

  if (!open) return <button type="button" className="button-ghost button-small" onClick={begin}>Choose existing {finding.resourceType} record</button>;
  return <div className="reconciliation-selection" aria-label={`Select existing ${finding.resourceType} record`}>
    <div className="reconciliation-remote-context">
      <strong>Current Project Alpha record</strong>
      {context ? <p>{context.displayName}{context.contactEmail ? <> · <a href={`mailto:${context.contactEmail}`}>{context.contactEmail}</a></> : " · No contact email"}<br />
        <code>{finding.remotePublicId}</code>{context.organizationPublicId ? <> · Organization <code>{context.organizationPublicId}</code></> : null}</p>
        : <p role="status">{contextLoading ? "Loading current Project Alpha context…" : "Current Project Alpha context is unavailable."}</p>}
    </div>
    <label htmlFor={`reconciliation-record-${finding.findingId}`}>Exact existing Operations {finding.resourceType} record</label>
    <select id={`reconciliation-record-${finding.findingId}`} value={selected} disabled={loading || submitting}
      onChange={event => { setSelected(event.target.value); setError(""); setMessage(""); idempotencyKey.current = null; }}>
      <option value="">Select a record ID and current version</option>
      {records.map(record => <option key={record.recordId} value={record.recordId}>{record.displayName}{record.contactEmail ? ` · ${record.contactEmail}` : ""} · {record.recordId} · version {record.currentVersion}</option>)}
    </select>
    <small>Records remain ordered by exact native ID. Names and contact email are display context only; no matching, ranking, suggestion, or preselection is performed.</small>
    <div className="reconciliation-actions">
      {nextCursor && <button type="button" className="button-ghost button-small" disabled={loading || submitting}
        onClick={() => void load(nextCursor)}>{loading ? "Loading records…" : "Load more records"}</button>}
      <button type="button" disabled={!selected || !context || loading || contextLoading || submitting} onClick={() => void acquire()}>
        {submitting ? "Checking and acquiring…" : "Acquire as inactive mapping"}
      </button>
    </div>
    {loading && records.length === 0 && <p role="status">Loading matching record IDs…</p>}
    {!loading && records.length === 0 && !error && <p>No authorized records with valid display context are available on this page.{nextCursor ? " Load the next exact-ID page to continue." : ""}</p>}
    {error && <p className="notice" role="alert">{error}</p>}
    {message && <p className="notice" role="status">{message}</p>}
  </div>;
}

export function ProjectAlphaDirectoryReconciliationReview() {
  const [items, setItems] = useState<Finding[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [revision, setRevision] = useState(0);

  const load = async (signal: AbortSignal, cursor?: string) => {
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ limit: "25" });
      for (const sourceId of reviewSources()) query.append("sourceId", sourceId);
      if (cursor) query.set("cursor", cursor);
      const page = await api<FindingPage>(`${ROOT}/findings?${query}`, { signal });
      if (signal.aborted) return;
      setItems(current => cursor
        ? [...current, ...page.items.filter(item => !current.some(existing => existing.findingId === item.findingId))]
        : page.items);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (!signal.aborted) setError(errorMessage(caught, "Reconciliation findings could not be loaded."));
    } finally { if (!signal.aborted) setLoading(false); }
  };
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [revision]);
  const refresh = () => { if (!loading) { setItems([]); setNextCursor(null); setRevision(value => value + 1); } };
  const markAcquired = (findingId: string) => setItems(current => current.map(item =>
    item.findingId === findingId ? { ...item, reviewState: "resolved" } : item));

  return <Card title="Project Alpha reconciliation review" action={<button type="button" className="button-ghost button-small"
    disabled={loading} onClick={refresh}>Refresh findings</button>}>
    <div className="reconciliation-review">
      <p>Review stable findings from the latest complete configured source snapshots. Acquiring an exact existing Operations record creates only an inactive mapping; activation remains a separate workflow.</p>
      {error && <p className="notice" role="alert">{error}</p>}
      {loading && items.length === 0 && <p role="status">Loading reconciliation findings…</p>}
      {!loading && !error && items.length === 0 && <p>No findings are present in the current complete snapshots.</p>}
      <div className="reconciliation-findings">
        {items.map(finding => {
          const adoptable = finding.reviewState === "open" && ADOPTABLE.has(finding.classification);
          return <article key={finding.findingId} className="reconciliation-finding"
            aria-label={`${sourceLabel(finding.sourceId)} ${classificationLabels[finding.classification] ?? finding.classification}`}>
            <header><div><h3>{classificationLabels[finding.classification] ?? finding.classification}</h3>
              <p>{sourceLabel(finding.sourceId)} · {finding.resourceType}</p></div>
              <span className={`reconciliation-state reconciliation-state-${finding.reviewState}`}>{finding.reviewState}</span></header>
            <dl>
              <dt>Finding ID</dt><dd><code>{finding.findingId}</code></dd>
              <dt>Remote ID</dt><dd><code>{finding.remotePublicId ?? "Not reported"}</code></dd>
              <dt>Remote revision</dt><dd>{finding.remoteRevision ?? "Not reported"}</dd>
              <dt>Presence</dt><dd>{presence(finding.present)}{finding.lastAction ? ` · Last action ${finding.lastAction}` : ""}</dd>
              <dt>Binding</dt><dd>{finding.bindingStatus ?? "Not reported"}{finding.bindingRecordId ? <> · <code>{finding.bindingRecordId}</code></> : null}{finding.bindingRevision ? ` · revision ${finding.bindingRevision}` : ""}</dd>
              <dt>Observed</dt><dd>{date(finding.createdAt)}</dd>
            </dl>
            {adoptable && <RecordSelection finding={finding} onAcquired={markAcquired} />}
            {finding.reviewState === "resolved" && <p className="notice" role="status">Acquired or resolved. Any acquired mapping is inactive and pending separate activation review.</p>}
          </article>;
        })}
      </div>
      {nextCursor && <button type="button" className="button-ghost button-small" disabled={loading}
        onClick={() => { const controller = new AbortController(); void load(controller.signal, nextCursor); }}>
        {loading ? "Loading more findings…" : "Load more findings"}</button>}
    </div>
  </Card>;
}
