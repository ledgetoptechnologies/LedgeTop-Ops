import { useEffect, useRef, useState, type FormEvent } from "react";
import { Card } from "@ltds/ui";
import { api } from "./api";

const ENDPOINT = "/api/admin/integrations/project-alpha/connectors";
type Connector = {
  sourceId: string; displayName: string; producerBindingId: string; snapshotOrigin: string; snapshotBasePath: string;
  applicationKey: string; profile: "primary_legacy" | "business_data"; state: "pending" | "active" | "suspended" | "retired";
  readVisible: boolean; activeRevision: number; version: number;
};
type Health = { sourceId: string; status: string; lastAttemptAt: string | null; lastSuccessAt: string | null; lastErrorCode: string | null };
type Recovery = { sourceId: string; lastAttemptAt: string | null; lastSuccessAt: string | null; nextAttemptAt: string | null;
  status: "never" | "running" | "success" | "failed" | "deferred"; errorCode: string | null; failureCount: number };
type Directory = { connectors: Connector[]; health: Health[]; legacyPrimary: boolean; recovery?: Recovery[] | null };
const PRIMARY = "project-alpha:primary";
const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
function revision(form: FormData, path: string) {
  return { credentialRef: field(form, "credentialRef"), snapshotBasePath: path, accessIssuer: field(form, "accessIssuer"),
    accessAudience: field(form, "accessAudience"), accessSubject: field(form, "accessSubject") };
}
function CredentialFields() {
  return <>
    <label>Credential reference<input name="credentialRef" required maxLength={64} autoComplete="off" placeholder="Deployed secret reference, not the secret" /></label>
    <label>Access issuer<input name="accessIssuer" type="url" required maxLength={2048} placeholder="https://team.cloudflareaccess.com" /></label>
    <label>Access audience<input name="accessAudience" required maxLength={512} /></label>
    <label>Producer Access subject<input name="accessSubject" required maxLength={512} /></label>
  </>;
}
function date(value: string | null) { return value ? new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).toLocaleString() : "Not yet"; }

export function ProjectAlphaConnections() {
  const [data, setData] = useState<Directory | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [mutating, setMutating] = useState(false);
  const [loading, setLoading] = useState(true);
  const busy = mutating || loading;
  const live = useRef(true);
  const mutation = useRef<AbortController | null>(null);
  const [revisionToken, setRevisionToken] = useState(0);
  useEffect(() => { live.current = true; return () => { live.current = false; mutation.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api<Directory>(ENDPOINT, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setData(result);
    }).catch(error => {
      if (!controller.signal.aborted) { setData(null); setError((error as Error).message); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revisionToken]);

  async function submit(path: string, method: string, body: object, success: string) {
    if (busy || mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setMutating(true); setError(""); setMessage("");
    try {
      await api(ENDPOINT + path, { method, body: JSON.stringify(body), signal: controller.signal });
      if (!live.current || controller.signal.aborted) return;
      setLoading(true);
      setMessage(success); setRevisionToken(value => value + 1);
    } catch (error) {
      if (!live.current || controller.signal.aborted) return;
      setError((error as Error).message);
      // Reload after conflicts so a retry never silently reuses a stale version.
      setLoading(true);
      setRevisionToken(value => value + 1);
    } finally { if (mutation.current === controller) mutation.current = null; if (live.current) setMutating(false); }
  }
  function change(connector: Connector, state: Connector["state"], readVisible = connector.readVisible) {
    if (busy) return;
    const primary = connector.sourceId === PRIMARY;
    const warning = state === "retired" ? (primary
      ? "Retiring the primary permanently stops synchronization for all connections. It cannot be reactivated or replaced here. Existing business records and client grants are retained."
      : "Retirement is permanent; this producer identity cannot be reused.")
      : state === "suspended" ? (primary
        ? "This pauses synchronization for the primary and all secondary connections until primary is activated again. Existing business records and client grants are retained."
        : "This stops new synchronization. Existing business records and client grants are retained.")
      : state === "active" ? (primary ? "This enables synchronization from the existing primary staff-authority source." : "This enables business-data synchronization only; it grants no staff or client access.")
      : "This changes staff business-record visibility only, not client grants or shared links.";
    if (!window.confirm(`${connector.displayName}: ${warning}\nContinue?`)) return;
    void submit(`/${encodeURIComponent(connector.sourceId)}`, "PATCH", { expectedVersion: connector.version, state, readVisible }, "Connection updated.");
  }
  function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget), sourceId = field(form, "sourceId");
    if (!window.confirm(sourceId === PRIMARY
      ? "Enroll the existing primary connection? It must match the deployed producer and signing keys. Enrollment pauses legacy synchronization until you activate this connection."
      : "Register this business-data source? It starts pending and hidden, without staff or client access.")) return;
    void submit("", "POST", { sourceId, producerBindingId: field(form, "producerBindingId"), displayName: field(form, "displayName"),
      snapshotOrigin: field(form, "snapshotOrigin"), applicationKey: field(form, "applicationKey"), profile: sourceId === PRIMARY ? "primary_legacy" : "business_data",
      revision: revision(form, field(form, "snapshotBasePath")) }, "Connection registered. Review its identity before activation.");
  }
  return <Card title="Project Alpha connections">
    <div className="alpha-connections">
      <p>Each source owns its business records. Only the existing primary source manages staff authority. Credentials remain in deployment secrets.</p>
      {error && <p role="alert" className="notice">{error}</p>}
      {message && <p role="status" className="notice">{message}</p>}
      {!data && !error && <p role="status">Loading connections…</p>}
      <button type="button" className="button-ghost button-small" disabled={busy} onClick={() => { setError(""); setLoading(true); setRevisionToken(value => value + 1); }}>Refresh connection status</button>
      {data?.legacyPrimary && <section className="alpha-connection">
        <h3>Primary connection</h3>
        <p>Using the existing deployment configuration. Signed events and daily reconciliation remain enabled when configured.</p>
        <SyncHealth health={data.health.find(row => row.sourceId === PRIMARY)} />
        <button type="button" disabled={busy} onClick={() => void submit(`/${encodeURIComponent(PRIMARY)}/sync`, "POST", {}, "Primary synchronization finished.")}>Sync primary now</button>
      </section>}
      {data?.connectors.map(connector => <section key={connector.sourceId} className="alpha-connection" aria-label={`${connector.displayName} connection`}>
        <h3>{connector.displayName}</h3>
        <p><strong>{connector.state}</strong> · {connector.profile === "primary_legacy" ? "Primary staff authority" : "Business data only"} · {connector.readVisible ? "Business records visible" : "Business records hidden"}</p>
        {connector.sourceId === PRIMARY && connector.state === "pending" && <p className="notice">Primary synchronization is paused until this connection is activated. Existing business records and client grants are retained.</p>}
        <SyncHealth health={data.health.find(row => row.sourceId === connector.sourceId)} />
        {connector.sourceId !== PRIMARY && connector.profile === "business_data" && <ScheduledRecovery
          connector={connector} primaryActive={data.connectors.some(row => row.sourceId === PRIMARY && row.state === "active")}
          recovery={data.recovery?.find(row => row.sourceId === connector.sourceId)} />}
        <div className="alpha-connection-actions">
          <button type="button" disabled={busy || connector.state !== "active"} onClick={() => void submit(`/${encodeURIComponent(connector.sourceId)}/sync`, "POST", {}, `${connector.displayName} synchronization finished.`)}>Sync now</button>
          {connector.state !== "retired" && <button type="button" disabled={busy} onClick={() => change(connector, connector.state === "active" ? "suspended" : "active")}>{connector.state === "active" ? "Suspend sync" : "Activate connection"}</button>}
          {connector.sourceId !== PRIMARY && <button type="button" disabled={busy} onClick={() => {
            if (window.confirm(`${connector.readVisible ? "Hide" : "Show"} this source's staff business records? This does not change client access or shared links.`))
              void submit(`/${encodeURIComponent(connector.sourceId)}`, "PATCH", { expectedVersion: connector.version, state: connector.state, readVisible: !connector.readVisible }, "Business visibility updated.");
          }}>{connector.readVisible ? "Hide business records" : "Show business records"}</button>}
        </div>
        <details><summary>Connection details</summary>
          <dl><dt>Source</dt><dd>{connector.sourceId}</dd><dt>Producer</dt><dd>{connector.producerBindingId}</dd>
            <dt>Destination</dt><dd>{connector.snapshotOrigin}{connector.snapshotBasePath}</dd><dt>Application</dt><dd>{connector.applicationKey}</dd>
            <dt>Revision</dt><dd>{connector.activeRevision}</dd></dl>
          <p>Source, producer, destination, and authority profile cannot be reassigned.</p>
          {connector.state !== "retired" && <>
            <form className="alpha-connection-form" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget);
              void submit(`/${encodeURIComponent(connector.sourceId)}`, "PATCH", { expectedVersion: connector.version, state: connector.state, displayName: field(form, "displayName") }, "Connection label updated."); }}>
              <label>Connection label<input name="displayName" required maxLength={160} defaultValue={connector.displayName} key={connector.version} /></label>
              <button disabled={busy} type="submit">Save label</button>
            </form>
            <details><summary>Rotate credentials and producer authentication</summary>
              <p>Deploy the new credential set to Operations and the event receiver first. This creates an audited revision, without changing the source destination.</p>
              <form className="alpha-connection-form" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget);
                if (window.confirm("Apply a new connection revision? In-flight old-revision syncs will stop before further writes."))
                  void submit(`/${encodeURIComponent(connector.sourceId)}/revisions`, "POST", { expectedVersion: connector.version, revision: revision(form, connector.snapshotBasePath) }, "Connection revision updated."); }}>
                <CredentialFields /><button disabled={busy} type="submit">Apply new revision</button>
              </form>
            </details>
            <button type="button" className="button-danger button-small" disabled={busy} onClick={() => change(connector, "retired")}>Retire connection</button>
          </>}
        </details>
      </section>)}
      {data && <details><summary>Register a source</summary>
        <p>Enroll and activate the existing primary before activating additional sources. Registration alone never enables synchronization or client access.</p>
        <form className="alpha-connection-form" onSubmit={register}>
          <label>Source ID<input name="sourceId" required pattern="project-alpha:[a-z0-9][a-z0-9_-]*" maxLength={78} placeholder="project-alpha:service-name" /></label>
          <label>Connection label<input name="displayName" required maxLength={160} /></label>
          <label>Immutable producer ID<input name="producerBindingId" required pattern="[A-Za-z0-9_-]+" maxLength={128} /></label>
          <label>Snapshot origin<input name="snapshotOrigin" type="url" required maxLength={2048} placeholder="https://alpha.example.com" /></label>
          <label>Base path<input name="snapshotBasePath" required defaultValue="/" maxLength={1024} /></label>
          <label>Application key<input name="applicationKey" required maxLength={64} /></label>
          <CredentialFields /><button type="submit" disabled={busy}>Register pending connection</button>
        </form>
      </details>}
    </div>
  </Card>;
}
function SyncHealth({ health }: { health?: Health }) {
  return <p>Sync: {health?.status ?? "Not yet run"}<br />Last attempt: {date(health?.lastAttemptAt ?? null)} · Last success: {date(health?.lastSuccessAt ?? null)}
    {health?.lastErrorCode && <><br />Last error: {health.lastErrorCode}</>}</p>;
}

function RecoveryTime({ value }: { value: string | null }) {
  if (!value) return <>Not recorded</>;
  const iso = value.replace(" ", "T"), normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(iso) ? iso : `${iso}Z`, parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? <time dateTime={normalized}>{parsed.toLocaleString()}</time> : <>Unavailable</>;
}
function ScheduledRecovery({ connector, primaryActive, recovery }: { connector: Connector; primaryActive: boolean; recovery?: Recovery }) {
  const eligible = primaryActive && connector.state === "active";
  const eligibility = eligible ? "Eligible by connection state" : !primaryActive && connector.state !== "active"
    ? "Paused: primary and this connection are not active" : !primaryActive
    ? "Paused: primary connection is not active" : `Paused: this connection is ${connector.state}`;
  const labels: Record<Recovery["status"], string> = { never: "Not attempted", running: "Running", success: "Succeeded", failed: "Failed", deferred: "Deferred" };
  return <div className="alpha-recovery" role="group" aria-label="Scheduled recovery">
    <p><strong>Scheduled recovery</strong> · {eligibility}<br />
      {recovery ? <>Last attempt: {labels[recovery.status]}{recovery.lastAttemptAt && <> · <RecoveryTime value={recovery.lastAttemptAt} /></>}<br />
        Last success: <RecoveryTime value={recovery.lastSuccessAt} />{eligible && recovery.nextAttemptAt && <><br />Next attempt not before: <RecoveryTime value={recovery.nextAttemptAt} /></>}
        {recovery.errorCode && <><br />Last recovery error: {recovery.errorCode}</>}
        {recovery.failureCount > 0 && <> · Failure count: {recovery.failureCount}</>}
      </> : <>Recovery status unavailable. Refresh connection status to check again.</>}
    </p>
    <details><summary>Recovery schedule</summary><p>Checked hourly, with at most two connections processed one at a time. After success, at least 24 hours pass before another scheduled attempt. Earliest times are not guaranteed start times. Pending, suspended, and retired connections are skipped.</p></details>
  </div>;
}
