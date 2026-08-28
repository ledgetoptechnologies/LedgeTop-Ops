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
type PortalAuthority = { sourceId: string; state: Connector["state"]; version: number; activeRevision: number; connectorRevision: number };
type PortalStatus = { available: boolean; authorities: PortalAuthority[];
  recovery: { version: number; sourceId: string; action: string; startedAt: string } | null };
type ProjectManagementRoute = { sourceId: string; version: number; revision: number; enabled: boolean; reviewedUrlTemplate: string | null };
type Directory = { connectors: Connector[]; health: Health[]; legacyPrimary: boolean; recovery?: Recovery[] | null; portal?: PortalStatus;
  projectManagement?: ProjectManagementRoute[] };
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

function projectManagementTemplateError(value: string): string | null {
  const template = value.trim();
  if (!template) return "Enter the reviewed Project Alpha project URL template.";
  let parsed: URL;
  try { parsed = new URL(template); } catch { return "Enter a complete HTTPS URL."; }
  if (parsed.protocol !== "https:") return "The project URL template must use HTTPS.";
  if (parsed.username || parsed.password) return "The project URL template cannot contain credentials.";
  if (parsed.search || parsed.hash) return "The project URL template cannot contain a query or fragment.";
  const placeholders = template.match(/\{recordId\}/g) ?? [];
  if (placeholders.length > 1) return "Use {recordId} at most once.";
  if (/[{}]/.test(template.replace("{recordId}", ""))) return "Only the {recordId} placeholder is supported.";
  if (placeholders.length) {
    const index = template.indexOf("{recordId}"), before = template[index - 1], after = template[index + "{recordId}".length];
    if (before !== "/" || (after !== undefined && after !== "/")) return "{recordId} must be one complete path segment.";
  }
  return null;
}

function ProjectManagementConfiguration({ connector, route, registryAvailable, disabled, onRefresh }: {
  connector: Connector; route?: ProjectManagementRoute; registryAvailable: boolean; disabled: boolean; onRefresh: () => void;
}) {
  const [enabled, setEnabled] = useState(Boolean(route?.enabled));
  const [template, setTemplate] = useState(route?.reviewedUrlTemplate ?? "");
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  useEffect(() => {
    if (dirty) return;
    setEnabled(Boolean(route?.enabled)); setTemplate(route?.reviewedUrlTemplate ?? "");
  }, [route?.enabled, route?.reviewedUrlTemplate, route?.version, dirty]);
  if (!registryAvailable) return <div className="alpha-project-management" role="group" aria-label="Project management">
    <p><strong>Project creation</strong> · Requires coordinated database upgrade</p>
    <p>Operations will not create a local project or guess an external Project Alpha route.</p>
  </div>;
  const editable = connector.state === "active" && connector.readVisible;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || disabled || !editable || !dirty) return;
    const nextTemplate = template.trim(), validation = enabled ? projectManagementTemplateError(nextTemplate) : null;
    if (validation) { setError(validation); return; }
    const action = enabled ? "enable" : "disable";
    if (!window.confirm(`${connector.displayName}: ${action === "enable" ? "Enable" : "Disable"} the external Project Alpha project-creation link for this exact source? This does not grant Project Alpha access or create a project in Operations.`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<{ projectManagement: ProjectManagementRoute }>(
        `${ENDPOINT}/${encodeURIComponent(connector.sourceId)}/project-management`, {
          method: "PUT", body: JSON.stringify({ expectedConnectorVersion: connector.version, expectedVersion: route?.version ?? null,
            idempotencyKey: crypto.randomUUID(), reviewedUrlTemplate: enabled ? nextTemplate : null }),
        });
      if (!result.projectManagement || result.projectManagement.sourceId !== connector.sourceId
        || result.projectManagement.enabled !== enabled || result.projectManagement.reviewedUrlTemplate !== (enabled ? nextTemplate : null))
        throw new Error("The project-management response could not be verified. Refresh the connection before retrying.");
      setDirty(false); setMessage(enabled ? "Project creation link enabled." : "Project creation link disabled."); onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Project management could not be updated.");
      onRefresh();
    } finally { setBusy(false); }
  };
  return <div className="alpha-project-management" role="group" aria-label="Project management">
    <p><strong>Project creation</strong> · {route?.enabled ? "Enabled" : "Not configured"}</p>
    {!editable ? <p>{connector.state === "retired" ? "This retired connection cannot expose project creation."
      : "Activate this connection and show its business records before configuring project creation."}</p> : <form onSubmit={submit} aria-busy={busy}>
      <label className="alpha-project-management-toggle"><input type="checkbox" checked={enabled} disabled={busy || disabled}
        onChange={event => { setEnabled(event.target.checked); setDirty(true); setError(""); setMessage(""); }} /> Enable external project creation</label>
      <label htmlFor={`project-management-${connector.sourceId}`}>Reviewed Project Alpha URL template</label>
      <input id={`project-management-${connector.sourceId}`} type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        maxLength={2048} value={template} disabled={!enabled || busy || disabled} aria-describedby={`project-management-help-${connector.sourceId}`}
        onChange={event => { setTemplate(event.target.value); setDirty(true); setError(""); setMessage(""); }} />
      <small id={`project-management-help-${connector.sourceId}`}>HTTPS only. No credentials, query, or fragment. Optionally use one whole <code>{"{recordId}"}</code> path segment. Project Alpha still authorizes creation.</small>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <button type="submit" className="button-ghost button-small" disabled={busy || disabled || !dirty}>{busy ? "Saving project route…" : "Save project route"}</button>
    </form>}
  </div>;
}

export function ProjectAlphaConnections() {
  const [data, setData] = useState<Directory | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [mutating, setMutating] = useState(false);
  const [loading, setLoading] = useState(true);
  const busy = mutating || loading;
  const controlsBusy = busy || Boolean(data?.portal?.recovery);
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
    if (busy || mutation.current || (data?.portal?.recovery && path !== "/recover-portal-update")) return;
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
    const pausesPortal = Boolean(data?.portal?.authorities.some(authority =>
      authority.state === "active" && (primary || authority.sourceId === connector.sourceId)));
    const warning = state === "retired" ? (primary
      ? "Retiring the primary permanently stops synchronization for all connections. It cannot be reactivated or replaced here. Existing business records and client grants are retained."
      : "Retirement is permanent; this producer identity cannot be reused.")
      : state === "suspended" ? (primary
        ? "This pauses synchronization for the primary and all secondary connections until primary is activated again. Existing business records and client grants are retained."
        : "This stops new synchronization. Existing business records and client grants are retained.")
      : state === "active" ? (primary ? "This enables synchronization from the existing primary staff-authority source." : "This enables business-data synchronization only; it grants no staff or client access.")
      : "This changes staff business-record visibility only, not client grants or shared links.";
    const portalWarning = pausesPortal && (state === "suspended" || state === "retired")
      ? " Registered secondary client-portal access will also be paused. Reactivating synchronization does not automatically restore portal access." : "";
    if (!window.confirm(`${connector.displayName}: ${warning}${portalWarning}\nContinue?`)) return;
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
      {data?.portal?.recovery && <div role="status" className="notice">
        <p>A connection update is unfinished. Recovery cancels the uncertain update and pauses all registered secondary client portals. It does not delete records or change the primary portal.</p>
        <button type="button" disabled={busy} onClick={() => {
          if (window.confirm("Cancel the unfinished connection update and pause all registered secondary client portals? You can review and reactivate each portal afterward."))
            void submit("/recover-portal-update", "POST", { expectedVersion: data.portal!.recovery!.version }, "Connection update recovered. Secondary client portals remain paused; review each before activation.");
        }}>Recover unfinished connection update</button>
      </div>}
      {data?.legacyPrimary && <section className="alpha-connection">
        <h3>Primary connection</h3>
        <p>Using the existing deployment configuration. Signed events and daily reconciliation remain enabled when configured.</p>
        <SyncHealth health={data.health.find(row => row.sourceId === PRIMARY)} />
        <button type="button" disabled={controlsBusy} onClick={() => void submit(`/${encodeURIComponent(PRIMARY)}/sync`, "POST", {}, "Primary synchronization finished.")}>Sync primary now</button>
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
          <button type="button" disabled={controlsBusy || connector.state !== "active"} onClick={() => void submit(`/${encodeURIComponent(connector.sourceId)}/sync`, "POST", {}, `${connector.displayName} synchronization finished.`)}>Sync now</button>
          {connector.state !== "retired" && <button type="button" disabled={controlsBusy} onClick={() => change(connector, connector.state === "active" ? "suspended" : "active")}>{connector.state === "active" ? "Suspend sync" : "Activate connection"}</button>}
          {connector.sourceId !== PRIMARY && <button type="button" disabled={controlsBusy} onClick={() => {
            if (window.confirm(`${connector.readVisible ? "Hide" : "Show"} this source's staff business records? This does not change client access or shared links.`))
              void submit(`/${encodeURIComponent(connector.sourceId)}`, "PATCH", { expectedVersion: connector.version, state: connector.state, readVisible: !connector.readVisible }, "Business visibility updated.");
          }}>{connector.readVisible ? "Hide business records" : "Show business records"}</button>}
        </div>
        {connector.profile === "business_data" && <PortalPurpose connector={connector} status={data.portal}
          primaryActive={data.connectors.some(row => row.sourceId === PRIMARY && row.state === "active")}
          disabled={controlsBusy} onAction={action => {
            const authority = data.portal?.authorities.find(row => row.sourceId === connector.sourceId);
            const warning = action === "configure" ? "Use this connection's current deployed signing credentials and Access authentication for its client portal? This stages the configuration and pauses any currently enabled portal access until you explicitly activate it."
              : action === "activate" ? "Enable this connection's client portal? Only independently authorized workspaces and delivery resources become available; this does not merge customer permissions or enable finance, requests or model access."
                : "Pause this connection's client portal? Its records and grants are retained, but clients cannot read its resources until you explicitly reactivate it.";
            if (window.confirm(warning)) void submit(`/${encodeURIComponent(connector.sourceId)}/portal`, "POST",
              { expectedVersion: connector.version, expectedPortalVersion: authority?.version ?? null, action },
              action === "configure" ? "Client portal configuration staged. Review and activate when ready." : action === "activate" ? "Client portal enabled for independently authorized workspaces." : "Client portal paused.");
          }} />}
        <ProjectManagementConfiguration connector={connector}
          route={data.projectManagement?.find(row => row.sourceId === connector.sourceId)}
          registryAvailable={Array.isArray(data.projectManagement)} disabled={controlsBusy}
          onRefresh={() => { setLoading(true); setRevisionToken(value => value + 1); }} />
        <details><summary>Connection details</summary>
          <dl><dt>Source</dt><dd>{connector.sourceId}</dd><dt>Producer</dt><dd>{connector.producerBindingId}</dd>
            <dt>Destination</dt><dd>{connector.snapshotOrigin}{connector.snapshotBasePath}</dd><dt>Application</dt><dd>{connector.applicationKey}</dd>
            <dt>Revision</dt><dd>{connector.activeRevision}</dd></dl>
          <p>Source, producer, destination, and authority profile cannot be reassigned.</p>
          {connector.state !== "retired" && <>
            <form className="alpha-connection-form" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget);
              void submit(`/${encodeURIComponent(connector.sourceId)}`, "PATCH", { expectedVersion: connector.version, state: connector.state, displayName: field(form, "displayName") }, "Connection label updated."); }}>
              <label>Connection label<input name="displayName" required maxLength={160} defaultValue={connector.displayName} key={connector.version} /></label>
              <button disabled={controlsBusy} type="submit">Save label</button>
            </form>
            <details><summary>Rotate credentials and producer authentication</summary>
              <p>Deploy the new credential set to Operations and the event receiver first, and to Client when this source has a client portal. This creates an audited revision without changing the source destination. Registered secondary portals are paused; configure and activate them again after rotation.</p>
              <form className="alpha-connection-form" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget);
                if (window.confirm("Apply a new connection revision? In-flight old-revision syncs will stop before further writes."))
                  void submit(`/${encodeURIComponent(connector.sourceId)}/revisions`, "POST", { expectedVersion: connector.version, revision: revision(form, connector.snapshotBasePath) }, "Connection revision updated."); }}>
                <CredentialFields /><button disabled={controlsBusy} type="submit">Apply new revision</button>
              </form>
            </details>
            <button type="button" className="button-danger button-small" disabled={controlsBusy} onClick={() => change(connector, "retired")}>Retire connection</button>
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
          <CredentialFields /><button type="submit" disabled={controlsBusy}>Register pending connection</button>
        </form>
      </details>}
    </div>
  </Card>;
}
function PortalPurpose({ connector, status, primaryActive, disabled, onAction }: {
  connector: Connector; status: PortalStatus | undefined; primaryActive: boolean; disabled: boolean;
  onAction: (action: "configure" | "activate" | "suspend") => void;
}) {
  const authority = status?.authorities.find(row => row.sourceId === connector.sourceId);
  const current = authority?.connectorRevision === connector.activeRevision;
  const canActivate = connector.state === "active" && primaryActive && current;
  return <div role="group" aria-label="Client portal connection">
    <p><strong>Client portal</strong> · {!status?.available ? "Requires coordinated database upgrade" : authority?.state ?? "Not configured"}</p>
    {status?.available && <>
      <p>Uses this connection's authentication. Workspaces and delivery access stay independently authorized; business grouping never merges permissions.</p>
      {authority && !current && <p className="notice">Configure the portal using the current connection revision before activating it.</p>}
      {(!primaryActive || connector.state !== "active") && <p>Both this connection and the primary must be active before portal activation.</p>}
      <div className="alpha-connection-actions">
        <button type="button" disabled={disabled || connector.state === "retired" || authority?.state === "retired"}
          onClick={() => onAction("configure")}>{authority ? "Refresh portal configuration" : "Configure client portal"}</button>
        {authority && authority.state !== "retired" && <button type="button"
          disabled={disabled || (authority.state !== "active" && !canActivate)}
          onClick={() => onAction(authority.state === "active" ? "suspend" : "activate")}>{authority.state === "active" ? "Pause client portal" : "Activate client portal"}</button>}
      </div>
    </>}
  </div>;
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
