import { projectAlphaSourceName } from "@ltds/shared";
import { requestChoice, Skeleton } from "@ltds/ui";
import { useEffect, useRef, useState } from "react";
import type {
  PortalDirectoryCorrespondenceCommand, PortalDirectoryCorrespondenceDiscovery, PortalDirectoryCorrespondenceStatus,
} from "../../../../packages/shared/src/portal-directory-correspondence";
import { api, ApiError } from "./api";

const ENDPOINT = "/api/admin/integrations/project-alpha/connectors";
const PORTAL_SOURCE = "project-alpha:primary";
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

type ConnectorLabel = { sourceId: string; displayName: string; snapshotOrigin: string };
type Frozen = { directorySourceId: string; command: PortalDirectoryCorrespondenceCommand; body: string;
  expectedRevisionId: string | null; transmitted: boolean };

/* An action whose outcome is unknown must survive this card re-mounting when the
   parent reloads connection status, so it lives here for the page session. */
const frozenByDirectorySource = new Map<string, Frozen>();

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function validProof(value: unknown, directorySourceId: string): boolean {
  if (!record(value)) return false;
  return value.directorySourceId === directorySourceId && value.portalSourceId === PORTAL_SOURCE
    && ["sourceInstanceId", "applicationId", "historyEpochId", "baseUrl", "producerBindingId", "applicationKey", "currentKeyFingerprint"]
      .every(field => text(value[field], 2048))
    && count(value.connectorRevision) && count(value.connectorVersion) && count(value.primaryAuthorityVersion);
}

export function validCorrespondenceStatus(value: unknown, directorySourceId: string): value is PortalDirectoryCorrespondenceStatus {
  if (!record(value) || !["not_required", "ready", "unavailable", "suspended"].includes(String(value.status))) return false;
  if (value.reason !== undefined && !["schema", "configuration", "producer", "authority", "changed"].includes(String(value.reason))) return false;
  const current = value.current, preview = value.preview;
  if (current !== null && !(record(current) && count(current.version) && current.version > 0
    && (current.state === "active" || current.state === "revoked") && text(current.revisionId, 128)
    && typeof current.revocationProofSha256 === "string" && SHA256.test(current.revocationProofSha256)
    && text(current.approvedByStaffId, 256) && text(current.approvedAt, 64))) return false;
  if (preview !== null && !(record(preview) && typeof preview.proofSha256 === "string" && SHA256.test(preview.proofSha256)
    && validProof(preview.proof, directorySourceId))) return false;
  return true;
}

export function validCorrespondenceDiscovery(value: unknown): value is PortalDirectoryCorrespondenceDiscovery {
  if (!record(value) || !["not_required", "review", "unavailable"].includes(String(value.status)) || !Array.isArray(value.candidates)
    || value.candidates.length > 8) return false;
  const seen = new Set<string>();
  return value.candidates.every(candidate => record(candidate) && typeof candidate.directorySourceId === "string"
    && SOURCE.test(candidate.directorySourceId) && candidate.directorySourceId !== PORTAL_SOURCE && !seen.has(candidate.directorySourceId)
    && Boolean(seen.add(candidate.directorySourceId)) && validCorrespondenceStatus(candidate.review, candidate.directorySourceId));
}

/** The backend hashes exactly these fields, in this order, to confirm the echoed request. */
async function requestSha256(directorySourceId: string, command: PortalDirectoryCorrespondenceCommand): Promise<string> {
  const canonical = JSON.stringify({ directorySourceId, operationId: command.operationId, action: command.action,
    expectedVersion: command.expectedVersion, expectedProofSha256: command.expectedProofSha256 });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function host(origin: string | undefined): string | null {
  if (!origin) return null;
  try { return new URL(origin).hostname || null; } catch { return null; }
}

function directoryLabel(directorySourceId: string, connectors: readonly ConnectorLabel[]): { name: string; domain: string | null } {
  const connector = connectors.find(row => row.sourceId === directorySourceId);
  return { name: connector?.displayName || projectAlphaSourceName(directorySourceId), domain: host(connector?.snapshotOrigin) };
}

function reasonText(status: PortalDirectoryCorrespondenceStatus): string | null {
  switch (status.reason) {
    case "changed": return "The Project Alpha connection changed since this link was approved. Review it before client workspaces use it again.";
    case "schema": return "The connection link needs a database update before it can be reviewed.";
    case "configuration": return "The two Project Alpha connections are not configured for a link yet.";
    case "producer": return "Project Alpha did not confirm the connection details. Nothing was changed.";
    case "authority": return "The client portal connection is not active, so a link can't be approved right now.";
    default: return null;
  }
}

export function PortalCorrespondencePanel({ discovery, connectors, onChanged }: {
  discovery: unknown; connectors: readonly ConnectorLabel[]; onChanged: () => void;
}) {
  if (discovery === undefined) return null;
  if (!validCorrespondenceDiscovery(discovery))
    return <section className="alpha-correspondence" aria-label="Client workspace connection"><h3>Client workspace connection</h3>
      <p role="alert" className="notice">The client workspace connection status could not be verified. Refresh connection status to check it again.</p></section>;
  if (discovery.status === "not_required") return null;
  const candidates = discovery.candidates.filter(candidate => candidate.review.status !== "not_required");
  if (discovery.status === "unavailable" && candidates.length === 0)
    return <section className="alpha-correspondence" aria-label="Client workspace connection"><h3>Client workspace connection</h3>
      <p role="status" className="notice">The client workspace connection can't be reviewed right now. Existing client access is unchanged.</p></section>;
  return <>{candidates.map(candidate => <PortalCorrespondenceCard key={candidate.directorySourceId}
    directorySourceId={candidate.directorySourceId} initial={candidate.review} connectors={connectors} onChanged={onChanged} />)}</>;
}

function PortalCorrespondenceCard({ directorySourceId, initial, connectors, onChanged }: {
  directorySourceId: string; initial: PortalDirectoryCorrespondenceStatus; connectors: readonly ConnectorLabel[]; onChanged: () => void;
}) {
  const [status, setStatus] = useState<PortalDirectoryCorrespondenceStatus | null>(initial);
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const [frozen, setFrozenState] = useState<Frozen | null>(() => frozenByDirectorySource.get(directorySourceId) ?? null);
  const [error, setError] = useState(() => frozenByDirectorySource.get(directorySourceId)?.transmitted
    ? "The previous request's outcome is not confirmed. Retry the same request; no other change can be made until it is confirmed." : "");
  const [notice, setNotice] = useState("");
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (!frozenByDirectorySource.has(directorySourceId)) setStatus(initial); }, [initial, directorySourceId]);
  const setFrozen = (value: Frozen | null) => {
    if (value) frozenByDirectorySource.set(directorySourceId, value); else frozenByDirectorySource.delete(directorySourceId);
    setFrozenState(value);
  };
  const path = `${ENDPOINT}/${encodeURIComponent(directorySourceId)}/portal-correspondence`;

  const reload = async () => {
    setLoading(true);
    try {
      const value = await api<unknown>(path);
      if (!validCorrespondenceStatus(value, directorySourceId)) throw new Error("The client workspace connection status could not be verified.");
      if (live.current) setStatus(value);
    } catch (caught) {
      if (live.current) setError(caught instanceof Error ? caught.message : "The client workspace connection status could not be loaded.");
    } finally { if (live.current) setLoading(false); }
  };

  const submit = async (operation: Frozen) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    const sent: Frozen = { ...operation, transmitted: true };
    setFrozen(sent);
    let unknown = true;
    try {
      const result = await api<unknown>(path, { method: "POST", headers: { "Idempotency-Key": sent.command.operationId }, body: sent.body });
      const { command } = sent;
      const valid = record(result) && result.ok === true && result.operationId === command.operationId && result.action === command.action
        && result.directorySourceId === sent.directorySourceId && typeof result.replayed === "boolean"
        && count(result.version) && result.version === command.expectedVersion + 1 && text(result.revisionId, 128)
        && (command.action === "approve" || result.revisionId === sent.expectedRevisionId)
        && typeof result.requestSha256 === "string" && result.requestSha256 === await requestSha256(sent.directorySourceId, command);
      if (!valid) throw new Error("The client workspace connection response could not be verified.");
      unknown = false;
      setFrozen(null);
      if (live.current) setNotice(command.action === "approve"
        ? "Client workspaces are connected. No client access or files were granted."
        : "Client workspaces are disconnected. Existing records were kept.");
      onChanged();
      await reload();
    } catch (caught) {
      const payload = caught instanceof ApiError ? caught.payload : null;
      const rejected = caught instanceof ApiError && caught.status === 409 && payload?.ok === false && payload.code === "rejected"
        && payload.operationId === sent.command.operationId;
      // Request validation and authorization run before any change, so those
      // ordinary 4xx answers are definite. Everything else may have committed.
      const definite = rejected || (caught instanceof ApiError && [400, 401, 403, 404, 422].includes(caught.status));
      if (definite) {
        unknown = false;
        setFrozen(null);
        if (live.current) setError(rejected
          ? "The connection changed before this request was applied. Nothing was changed; review the current details."
          : `${caught instanceof Error ? caught.message : "The request was not accepted."} Nothing was changed.`);
        await reload();
      }
    } finally {
      if (unknown && live.current)
        setError("The outcome of this request is not confirmed. Retry the same request; no other change can be made until it is confirmed.");
      if (live.current) setBusy(false);
    }
  };

  const start = async (action: "approve" | "revoke") => {
    if (!status || busy || frozen) return;
    const current = status.current;
    if (action === "revoke") {
      if (!current || current.state !== "active") return;
      const choice = await requestChoice({ title: "Disconnect client workspaces?",
        description: "Client portals stop using this connection. Existing workspace records are kept and no files are deleted.",
        choices: [{ value: "revoke", label: "Disconnect", tone: "danger" }] });
      if (choice !== "revoke") return;
    } else if (!status.preview) return;
    const operationId = crypto.randomUUID();
    const command: PortalDirectoryCorrespondenceCommand = { operationId, action,
      expectedVersion: current?.version ?? 0,
      expectedProofSha256: action === "revoke" ? current!.revocationProofSha256 : status.preview!.proofSha256 };
    await submit({ directorySourceId, command, body: JSON.stringify(command),
      expectedRevisionId: action === "revoke" ? current!.revisionId : null, transmitted: false });
  };

  const directory = directoryLabel(directorySourceId, connectors);
  const portalName = projectAlphaSourceName(PORTAL_SOURCE);
  const portalDomain = host(status?.preview?.proof.baseUrl);
  const active = status?.current?.state === "active";
  const canApprove = !!status?.preview && (status.status === "ready" || status.status === "suspended") && !(active && status.status === "ready");
  const locked = busy || loading || Boolean(frozen);
  const reason = status ? reasonText(status) : null;

  return <section className="alpha-correspondence" aria-label="Client workspace connection" aria-busy={busy || loading}>
    <header><h3>Client workspace connection</h3>
      <span className={`alpha-correspondence-state ${active ? (status?.status === "suspended" ? "is-review" : "is-on") : "is-off"}`}>
        {!status ? "Checking" : active ? (status.status === "suspended" ? "Needs review" : "Connected") : "Not connected"}</span></header>
    <p className="alpha-correspondence-pair"><strong>{directory.name}</strong> business records{directory.domain && <small> ({directory.domain})</small>}
      {" ↔ "}<strong>{portalName}</strong> client portal{portalDomain && <small> ({portalDomain})</small>}</p>
    <p className="alpha-correspondence-scope">This only lets client workspaces find their existing records across the two connections. It does not add anyone to a workspace or grant access to files.</p>
    {loading && !busy ? <Skeleton variant="text" lines={2} label="Checking the client workspace connection…" /> : status && <>
      {reason && <p role="status" className="notice">{reason}</p>}
      {status.current && <dl className="alpha-correspondence-current">
        <div><dt>Status</dt><dd>{status.current.state === "active" ? "Connected" : "Disconnected"}</dd></div>
        <div><dt>Approved</dt><dd>{new Date(status.current.approvedAt).toLocaleString()}</dd></div>
      </dl>}
      {!status.preview && !active && !reason && <p role="status">No connection is ready for review yet.</p>}
    </>}
    {error && <p role="alert" className="notice error">{error}</p>}
    {notice && <p role="status" className="notice">{notice}</p>}
    <div className="alpha-connection-actions">
      {frozen?.transmitted
        ? <button type="button" className="button-orange" disabled={busy} onClick={() => void submit(frozen)}>
          {busy ? "Confirming…" : frozen.command.action === "approve" ? "Retry same connect request" : "Retry same disconnect request"}</button>
        : <>
          {canApprove && <button type="button" className="button-orange" disabled={locked} onClick={() => void start("approve")}>
            {busy ? "Connecting…" : status?.status === "suspended" ? "Review and reconnect" : "Connect client workspaces"}</button>}
          {active && <button type="button" className="button-danger" disabled={locked} onClick={() => void start("revoke")}>
            {busy ? "Disconnecting…" : "Disconnect"}</button>}
          <button type="button" className="button-ghost" disabled={locked} onClick={() => { setError(""); setNotice(""); void reload(); }}>Check again</button>
        </>}
    </div>
    <details className="alpha-correspondence-details"><summary>Technical details</summary><dl>
      <dt>Business records source</dt><dd><code>{directorySourceId}</code></dd>
      <dt>Client portal source</dt><dd><code>{PORTAL_SOURCE}</code></dd>
      {status?.current && <><dt>Link revision</dt><dd><code>{status.current.revisionId}</code></dd></>}
      {status?.preview && <><dt>Preview proof</dt><dd><code>{status.preview.proofSha256}</code></dd></>}
    </dl></details>
  </section>;
}
