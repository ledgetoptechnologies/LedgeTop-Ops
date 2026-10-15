import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { advanceImportRecord, importCandidateKey, loadImportCandidates, parseImportJob, readImportStatus,
  reviewImportRecord, renewImportRecord, sortImportCandidates, type ExistingImportRequest, type ImportCandidate, type ImportJob,
  type ImportReference, type ImportReview, type ImportState, type ImportStatus } from "./native-directory-existing-import-client";

const STORAGE_KEY = "ltds-existing-pa-import-v1";
type Row = { candidate: ImportCandidate; review?: ImportReview; status: ImportState | "available" | "checking"; message?: string; renewable?: boolean };
const FIELD_LABELS: Record<string, string> = { name: "Name", generalEmail: "Email", generalPhone: "Phone", email: "Email",
  phone: "Phone", clientType: "Client type", addressLine1: "Address line 1", addressLine2: "Address line 2",
  city: "City", state: "State", postalCode: "Postal code", country: "Country" };
const STATUS_LABELS: Record<Row["status"], string> = { available: "Awaiting review", checking: "Checking…", reviewed: "Ready to import",
  activated: "Editable in Ops", pending: "Pending · resume required", blocked: "Review required", conflict: "Record changed" };
function statusMessage(value: ImportStatus): string | undefined {
  if (value.renewable) return "This review expired. Renew it before continuing.";
  if (value.status === "blocked" || value.status === "conflict") return "This record needs review before the import can continue.";
  if (value.status === "pending") return "PA confirmation is unfinished. Resume checks the saved command first.";
  return undefined;
}
function failure(caught: unknown): string {
  return caught instanceof ApiError && caught.status === 403 ? "Your current sign-in or permissions no longer allow this import."
    : caught instanceof ApiError && caught.status === 409 ? "A record changed. Refresh its source and review before continuing."
    : caught instanceof Error && !(caught instanceof ApiError) ? caught.message
    : "The request did not finish. Resume checks the saved import before sending the same command again.";
}

export function NativeDirectoryExistingImportPanel({ disabled = false, sources = [], request = api }: {
  disabled?: boolean; sources?: readonly { sourceId: string; displayName: string }[]; request?: ExistingImportRequest;
}) {
  const [rows, setRows] = useState<Row[]>([]), [visible, setVisible] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const live = useRef(true), stop = useRef(false), active = useRef(false), currentRows = useRef<Row[]>([]);
  const job = useRef<ImportJob | null>(null);
  const publish = (next: Row[]) => { currentRows.current = next; if (live.current) setRows(next); };
  const update = (key: string, patch: Partial<Row>) => publish(currentRows.current.map(row =>
    importCandidateKey(row.candidate) === key ? { ...row, ...patch } : row));
  const save = (next: ImportJob) => {
    // Persist command references before any request that could commit remotely.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); job.current = next;
  };
  const load = async () => {
    if (active.current || disabled) return;
    active.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const candidates = await loadImportCandidates(request);
      if (!live.current) return;
      setVisible(true);
      const stored = parseImportJob(window.localStorage.getItem(STORAGE_KEY)); job.current = stored;
      let next: Row[] = candidates.map(candidate => ({ candidate, status: "available" }));
      publish(next);
      if (stored) for (const ref of sortImportCandidates(stored.records)) {
        if (!live.current) break;
        if (!ref.importId) continue;
        const result = await readImportStatus(request, stored.batchId, ref);
        const restored: Row = { candidate: result.review, review: result.review, status: result.status,
          renewable: result.renewable, message: statusMessage(result) };
        const key = importCandidateKey(ref);
        next = currentRows.current.filter(row => importCandidateKey(row.candidate) !== key);
        next.push(restored); publish(sortImportCandidates(next.map(row => ({ ...row.candidate, row }))).map(value => value.row));
      }
      if (stored && live.current) setMessage("A saved review was restored. No import was started automatically.");
    } catch (caught) {
      if (live.current) {
        if (caught instanceof ApiError && (caught.status === 404 || caught.status === 403)) { setVisible(false); publish([]); }
        else { setVisible(true); setError(failure(caught)); }
      }
    } finally { active.current = false; if (live.current) setBusy(false); }
  };
  useEffect(() => { live.current = true; void load(); return () => { live.current = false; stop.current = true; }; }, [disabled, request]);

  const reviewAll = async () => {
    if (active.current || disabled || !currentRows.current.length) return;
    active.current = true; stop.current = false; setBusy(true); setError(""); setMessage("");
    try {
      const existing = job.current;
      const refs = new Map(existing?.records.map(ref => [importCandidateKey(ref), ref]));
      const next: ImportJob = { version: 1, batchId: existing?.batchId ?? crypto.randomUUID(), records:
        sortImportCandidates(currentRows.current.map(row => row.candidate)).map(candidate => refs.get(importCandidateKey(candidate))
          ?? { sourceId: candidate.sourceId, kind: candidate.kind, recordId: candidate.recordId,
            businessAreaId: candidate.businessAreaId, idempotencyKey: crypto.randomUUID() }) };
      save(next);
      for (const ref of next.records) {
        if (stop.current || !live.current) break;
        const key = importCandidateKey(ref), row = currentRows.current.find(value => importCandidateKey(value.candidate) === key);
        if (!row || row.status === "activated" || row.review) continue;
        update(key, { status: "checking", message: undefined });
        try {
          const reviewed = await reviewImportRecord(request, next.batchId, row.candidate, ref);
          const saved = job.current!;
          save({ ...saved, records: saved.records.map(value => importCandidateKey(value) === key ? { ...value, importId: reviewed.importId } : value) });
          update(key, { review: reviewed, candidate: { ...row.candidate, name: reviewed.name }, status: "reviewed" });
        } catch (caught) { update(key, { status: "blocked", message: failure(caught) }); throw caught; }
      }
      if (live.current) setMessage(stop.current ? "Review paused. You can continue with the saved references."
        : "Review complete. Check the records below before importing them.");
    } catch (caught) { if (live.current) setError(failure(caught)); }
    finally { active.current = false; if (live.current) setBusy(false); }
  };
  const executeAll = async () => {
    if (active.current || disabled || !job.current) return;
    active.current = true; stop.current = false; setBusy(true); setError(""); setMessage("");
    try {
      for (const ref of sortImportCandidates(job.current.records)) {
        if (stop.current || !live.current) break;
        const key = importCandidateKey(ref);
        const row = currentRows.current.find(value => importCandidateKey(value.candidate) === key);
        if (!row?.review || !ref.importId) throw new Error("Every record must be reviewed before importing.");
        if (row.status === "activated") continue;
        update(key, { status: "checking", message: undefined });
        try {
          // Reconcile each stored command before sending, including on resume.
          const result = await advanceImportRecord(request, job.current.batchId, ref, () => !stop.current && live.current);
          update(key, { status: result.status, review: result.review, renewable: result.renewable,
            message: statusMessage(result) });
          if (result.status === "activated") continue;
          if (result.status === "blocked" || result.status === "conflict")
            throw new Error("This import needs a fresh server review before continuing.");
          stop.current = true;
          if (live.current) setMessage("Import paused on an unfinished record. Resume checks its saved command first.");
          break;
        } catch (caught) {
          const latest = currentRows.current.find(value => importCandidateKey(value.candidate) === key);
          if (latest?.status === "checking") update(key, { status: "pending", message: failure(caught) });
          throw caught;
        }
      }
      if (live.current && currentRows.current.every(row => row.status === "activated"))
        setMessage("All reviewed records are now editable in Ops.");
      else if (live.current && stop.current) setMessage("Import paused. Resume checks existing results before continuing.");
    } catch (caught) { if (live.current) setError(failure(caught)); }
    finally { active.current = false; if (live.current) setBusy(false); }
  };
  const renewExpired = async () => {
    if (active.current || disabled || !job.current) return;
    active.current = true; stop.current = false; setBusy(true); setError(""); setMessage("");
    try {
      for (const ref of sortImportCandidates(job.current.records)) {
        if (stop.current || !live.current) break;
        const key = importCandidateKey(ref);
        if (!currentRows.current.find(row => importCandidateKey(row.candidate) === key)?.renewable) continue;
        const current = await readImportStatus(request, job.current.batchId, ref);
        update(key, { status: current.status, review: current.review, renewable: current.renewable,
          message: statusMessage(current) });
        if (stop.current || !live.current) break;
        if (!current.renewable || current.status === "activated" || current.status === "conflict") continue;
        const renewed = await renewImportRecord(request, current.review, ref);
        update(key, { status: "reviewed", review: renewed, renewable: false, message: undefined });
      }
      if (live.current) setMessage("Review renewal finished. Resume the saved import when you are ready.");
    } catch (caught) { if (live.current) setError(failure(caught)); }
    finally { active.current = false; if (live.current) setBusy(false); }
  };
  if (!visible) return null;
  const complete = rows.filter(row => row.status === "activated").length;
  const allReviewed = rows.length > 0 && rows.every(row => Boolean(row.review));
  const resumable = rows.some(row => row.status === "pending");
  return <section className="alpha-connection" aria-label="Import existing PA records">
    <h3>Import existing PA records</h3>
    <p>Connect existing clients and organizations so you can edit them in Ops. Organizations are imported before their contacts.</p>
    <p>This preserves the PA records and existing links. It sends no invitations and grants no client access.</p>
    {error && <p role="alert" className="notice">{error}</p>}
    {message && <p role="status" className="notice">{message}</p>}
    <p role="status">{rows.length} records · {complete} editable in Ops</p>
    <div className="alpha-connection-actions">
      <button type="button" disabled={disabled || busy} onClick={() => void load()}>Refresh import list</button>
      <button type="button" disabled={disabled || busy || !rows.length || allReviewed} onClick={() => void reviewAll()}>Review existing records</button>
      {rows.some(row => row.renewable) && <button type="button" disabled={disabled || busy} onClick={() => void renewExpired()}>Renew expired reviews</button>}
      <button type="button" disabled={disabled || busy || !allReviewed || complete === rows.length} onClick={() => void executeAll()}>
        {resumable ? "Resume reviewed import" : "Import reviewed records"}</button>
      {busy && <button type="button" onClick={() => { stop.current = true; setMessage("Pausing after the current request finishes…"); }}>Pause</button>}
    </div>
    {!rows.length && <p>No existing records are available to import.</p>}
    {rows.length > 0 && <div className="project-alpha-field-review-table-scroll"><table><caption>Existing records to connect to Ops</caption>
      <thead><tr><th scope="col">Record</th><th scope="col">Type</th><th scope="col">PA connection</th><th scope="col">Organization</th><th scope="col">Status</th></tr></thead>
      <tbody>{rows.map(row => <tr key={importCandidateKey(row.candidate)} data-source-id={row.candidate.sourceId}
        data-record-kind={row.candidate.kind} data-classic-record-id={row.candidate.recordId}
        data-import-id={row.review?.importId} data-import-state={row.status}>
        <th scope="row">{row.candidate.name}{row.review && <details><summary>Reviewed profile</summary><dl>
          {Object.entries(row.review.profile).filter(([field]) => FIELD_LABELS[field]).map(([field, value]) =>
            <div key={field}><dt>{FIELD_LABELS[field]}</dt><dd>{value || "Not set"}</dd></div>)}
        </dl></details>}</th>
        <td>{row.candidate.kind === "organization" ? "Organization" : "Client"}</td>
        <td>{sources.find(source => source.sourceId === row.candidate.sourceId)?.displayName ?? "PA connection"}</td>
        <td>{row.candidate.parentRecordId ? rows.find(parent => parent.candidate.sourceId === row.candidate.sourceId
          && parent.candidate.kind === "organization" && parent.candidate.recordId === row.candidate.parentRecordId)?.candidate.name ?? "Existing organization" : "—"}</td>
        <td>{STATUS_LABELS[row.status]}{row.message && <p>{row.message}</p>}</td>
      </tr>)}</tbody></table></div>}
  </section>;
}
