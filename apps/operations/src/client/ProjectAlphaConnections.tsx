import { useEffect, useRef, useState, type FormEvent } from "react";
import { Card } from "@ltds/ui";
import { api } from "./api";

const ENDPOINT = "/api/admin/integrations/project-alpha/connectors";
const PRIMARY = "project-alpha:primary";
type Connector = {
  sourceId: string; displayName: string; producerBindingId: string; snapshotOrigin: string; snapshotBasePath: string;
  applicationKey: string; profile: "primary_legacy" | "business_data"; state: "pending" | "active" | "suspended" | "retired";
  readVisible: boolean; activeRevision: number; version: number;
};
type Health = { sourceId: string; status: string; lastAttemptAt: string | null; lastSuccessAt: string | null; lastErrorCode: string | null };
type Recovery = { sourceId: string; lastAttemptAt: string | null; lastSuccessAt: string | null; nextAttemptAt: string | null;
  status: "never" | "running" | "success" | "failed" | "deferred"; errorCode: string | null; failureCount: number };
type PortalStatus = { available: boolean; authorities: Array<{ sourceId: string; state: Connector["state"]; connectorRevision: number }>;
  recovery: { sourceId: string; action: string; startedAt: string } | null };
type ProjectManagementRoute = { sourceId: string; version: number; revision: number; enabled: boolean; reviewedUrlTemplate: string | null };
type Directory = { connectors: Connector[]; health: Health[]; legacyPrimary: boolean; recovery?: Recovery[] | null;
  portal?: PortalStatus; projectManagement?: ProjectManagementRoute[] };

function date(value: string | null) { return value ? new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).toLocaleString() : "Not yet"; }
function SyncHealth({ health }: { health?: Health }) {
  const labels: Record<string, string> = {
    "project-alpha-network-timeout": "Project Alpha did not respond before the request timed out.",
    "project-alpha-network-dns": "Project Alpha's hostname could not be resolved.",
    "project-alpha-network-tls": "The secure connection to Project Alpha could not be verified.",
    "project-alpha-network-refused": "Project Alpha refused the connection.",
    "project-alpha-network-reset": "The connection closed before the snapshot finished.",
    "project-alpha-network-redirect": "Project Alpha redirected the server-to-server snapshot request.",
    "project-alpha-network-error": "The server-to-server request failed before Project Alpha returned an HTTP response.",
  };
  const failure = health?.lastErrorCode ? labels[health.lastErrorCode] ?? health.lastErrorCode : null;
  return <p>Sync: {health?.status ?? "Not yet run"}<br />Last attempt: {date(health?.lastAttemptAt ?? null)} · Last success: {date(health?.lastSuccessAt ?? null)}{failure && <><br />Last error: {failure}</>}</p>;
}
function RecoveryStatus({ connector, recovery }: { connector: Connector; recovery?: Recovery }) {
  if (connector.profile !== "business_data") return null;
  const labels: Record<Recovery["status"], string> = { never: "Not attempted", running: "Running", success: "Succeeded", failed: "Failed", deferred: "Deferred" };
  return <p><strong>Scheduled recovery</strong> · {connector.state === "active" ? "Eligible by deployment configuration" : `Paused by deployment configuration (${connector.state})`}<br />
    {recovery ? <>Last attempt: {labels[recovery.status]} · Last success: {date(recovery.lastSuccessAt)}{recovery.nextAttemptAt && <><br />Next attempt not before: {date(recovery.nextAttemptAt)}</>}{recovery.errorCode && <><br />Last recovery error: {recovery.errorCode}</>}{recovery.failureCount > 0 && <> · Failure count: {recovery.failureCount}</>}</> : "Recovery status unavailable."}</p>;
}
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
function ProjectManagement({ connector, route, disabled, onRefresh }: { connector: Connector; route?: ProjectManagementRoute; disabled: boolean; onRefresh: () => void }) {
  const [enabled, setEnabled] = useState(Boolean(route?.enabled));
  const [template, setTemplate] = useState(route?.reviewedUrlTemplate ?? "");
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  useEffect(() => { if (!dirty) { setEnabled(Boolean(route?.enabled)); setTemplate(route?.reviewedUrlTemplate ?? ""); } }, [route?.enabled, route?.reviewedUrlTemplate, route?.version, dirty]);
  const editable = connector.state === "active" && connector.readVisible;
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (busy || disabled || !editable || !dirty) return;
    const value = template.trim();
    const validation = enabled ? projectManagementTemplateError(value) : null;
    if (validation) { setError(validation); return; }
    if (!window.confirm(`${enabled ? "Enable" : "Disable"} the reviewed Project Alpha project-creation link for ${connector.displayName}? This does not register or alter the source connection.`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api<{ projectManagement: ProjectManagementRoute }>(
        `${ENDPOINT}/${encodeURIComponent(connector.sourceId)}/project-management`, { method: "PUT", body: JSON.stringify({
          expectedConnectorVersion: connector.version, expectedVersion: route?.version ?? null, idempotencyKey: crypto.randomUUID(), reviewedUrlTemplate: enabled ? value : null,
        }) });
      if (!result.projectManagement || result.projectManagement.sourceId !== connector.sourceId
        || result.projectManagement.enabled !== enabled || result.projectManagement.reviewedUrlTemplate !== (enabled ? value : null))
        throw new Error("The project-management response could not be verified. Refresh the connection before retrying.");
      setDirty(false); setMessage(enabled ? "Project creation link enabled." : "Project creation link disabled."); onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Project management could not be updated.");
      onRefresh();
    }
    finally { setBusy(false); }
  };
  return <div className="alpha-project-management" role="group" aria-label="Project management"><p><strong>Project creation</strong> · {route?.enabled ? "Enabled" : "Not configured"}</p>
    {!editable ? <p>Activate this deployment-configured source and make its records visible before configuring project creation.</p> : <form onSubmit={save} aria-busy={busy}>
      <label><input type="checkbox" checked={enabled} disabled={busy || disabled} onChange={event => { setEnabled(event.target.checked); setDirty(true); setError(""); setMessage(""); }} /> Enable external project creation</label>
      <label htmlFor={`project-management-${connector.sourceId}`}>Reviewed Project Alpha URL template</label>
      <input id={`project-management-${connector.sourceId}`} type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        value={template} disabled={!enabled || busy || disabled} aria-describedby={`project-management-help-${connector.sourceId}`}
        onChange={event => { setTemplate(event.target.value); setDirty(true); setError(""); setMessage(""); }} maxLength={2048} />
      <small id={`project-management-help-${connector.sourceId}`}>HTTPS only. No credentials, query, or fragment. Optionally use one whole <code>{"{recordId}"}</code> path segment. Project Alpha still authorizes creation.</small>{error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
      <button type="submit" className="button-ghost button-small" disabled={busy || disabled || !dirty}>{busy ? "Saving project route…" : "Save project route"}</button>
    </form>}
  </div>;
}

/** The connector registry is deployment-owned. This is a status/sync surface,
 * never a browser form for source authority or credentials. */
export function ProjectAlphaConnections() {
  const [data, setData] = useState<Directory | null>(null), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true), [syncing, setSyncing] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true);
    api<Directory>(ENDPOINT, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setData(result); setError(""); } })
      .catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Connection status could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const refresh = () => { if (!loading && !syncing) { setMessage(""); setRevision(value => value + 1); } };
  const sync = async (connector: Connector) => {
    if (syncing || connector.state !== "active") return;
    setSyncing(connector.sourceId); setError(""); setMessage("");
    try {
      await api(`${ENDPOINT}/${encodeURIComponent(connector.sourceId)}/sync`, { method: "POST", body: JSON.stringify({}) });
      if (live.current) { setMessage(`${connector.displayName} synchronization finished.`); setRevision(value => value + 1); }
    } catch (caught) { if (live.current) setError(caught instanceof Error ? caught.message : "Synchronization could not be completed."); }
    finally { if (live.current) setSyncing(null); }
  };
  const legacy: Connector = { sourceId: PRIMARY, displayName: "Primary connection", producerBindingId: "legacy", snapshotOrigin: "", snapshotBasePath: "", applicationKey: "", profile: "primary_legacy", state: "active", readVisible: true, activeRevision: 0, version: 0 };
  return <Card title="Project Alpha connections"><div className="alpha-connections">
    <p>Connection identities, destinations, and credentials are managed as deployment configuration. Operations can show status and request a sync, but cannot register, alter, or retire a source from the browser.</p>
    {error && <p role="alert" className="notice">{error}</p>}{message && <p role="status" className="notice">{message}</p>}{!data && !error && <p role="status">Loading connections…</p>}
    <button type="button" className="button-ghost button-small" disabled={loading || Boolean(syncing)} onClick={refresh}>Refresh connection status</button>
    {data?.legacyPrimary && <section className="alpha-connection" aria-label="Primary connection"><h3>Primary connection</h3><p><strong>Business record sync</strong> · Using the original deployment configuration. Add it to the deployment source manifest to migrate it to the same exact-source registry as additional Project Alpha instances.</p><SyncHealth health={data.health.find(row => row.sourceId === PRIMARY)} /><button type="button" disabled={loading || Boolean(syncing)} onClick={() => void sync(legacy)}>{syncing === PRIMARY ? "Synchronizing…" : "Sync primary now"}</button></section>}
    {data?.connectors.map(connector => {
      const authority = data.portal?.authorities.find(row => row.sourceId === connector.sourceId), management = data.projectManagement?.find(row => row.sourceId === connector.sourceId);
      return <section key={connector.sourceId} className="alpha-connection" aria-label={`${connector.displayName} connection`}><h3>{connector.displayName}</h3>
        <p><strong>{connector.state}</strong> · {connector.profile === "primary_legacy" ? "Primary staff authority" : "Business data only"} · {connector.readVisible ? "Business records visible" : "Business records hidden"}</p>
        <SyncHealth health={data.health.find(row => row.sourceId === connector.sourceId)} /><RecoveryStatus connector={connector} recovery={data.recovery?.find(row => row.sourceId === connector.sourceId)} />
        <p><strong>Client portal</strong> · {!data.portal?.available ? "Requires coordinated database upgrade" : authority?.state ?? "Not configured"}{authority && authority.connectorRevision !== connector.activeRevision && <> · deployment configuration revision needs coordinated portal review</>}</p>
        <ProjectManagement connector={connector} route={management} disabled={loading || Boolean(syncing)} onRefresh={() => setRevision(value => value + 1)} />
        <button type="button" disabled={loading || Boolean(syncing) || connector.state !== "active"} onClick={() => void sync(connector)}>{syncing === connector.sourceId ? "Synchronizing…" : "Sync now"}</button>
        <details><summary>Connection details</summary><dl><dt>Source</dt><dd>{connector.sourceId}</dd><dt>Producer</dt><dd>{connector.producerBindingId}</dd><dt>Destination</dt><dd>{connector.snapshotOrigin}{connector.snapshotBasePath}</dd><dt>Application</dt><dd>{connector.applicationKey}</dd><dt>Revision</dt><dd>{connector.activeRevision}</dd></dl><p>These values are read-only here. Change the reviewed deployment source manifest and deploy Operations; do not paste credentials into this page.</p></details>
      </section>;
    })}
    {data?.portal?.recovery && <p className="notice" role="status">A prior portal coordination operation is unfinished. It remains read-only here; recover it through the reviewed deployment runbook before changing any portal-enabled source.</p>}
  </div></Card>;
}
