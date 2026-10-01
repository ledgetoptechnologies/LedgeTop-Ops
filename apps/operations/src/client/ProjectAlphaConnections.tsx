import { useEffect, useRef, useState, type FormEvent } from "react";
import { Card } from "@ltds/ui";
import { api, ApiError } from "./api";

const ENDPOINT = "/api/admin/integrations/project-alpha/connectors";
const READ_ACCEPTANCE_ENDPOINT = "/api/admin/api-v2/project-alpha/read-acceptance";
const READ_ACCEPTANCE_CONNECTIONS_ENDPOINT = `${READ_ACCEPTANCE_ENDPOINT}/connections`;
const API_V2_SYNC_ENDPOINT = "/api/admin/integrations/project-alpha/api-v2/sync-page";
const DIRECTORY_READ_ADOPTION_ENDPOINT = "/api/admin/integrations/project-alpha/api-v2/directory/read-adoptions";
const PRIMARY = "project-alpha:primary";
type Connector = {
  sourceId: string; displayName: string; producerBindingId: string; snapshotOrigin: string; snapshotBasePath: string;
  applicationKey: string; profile: "primary_legacy" | "business_data"; state: "pending" | "active" | "suspended" | "retired";
  readVisible: boolean; activeRevision: number; version: number;
};
type Health = { sourceId: string; status: string; lastAttemptAt: string | null; lastSuccessAt: string | null; lastErrorCode: string | null };
type Recovery = { sourceId: string; lastAttemptAt: string | null; lastSuccessAt: string | null; nextAttemptAt: string | null;
  status: "never" | "running" | "success" | "failed" | "deferred"; errorCode: string | null; failureCount: number };
type PortalAuthority = { sourceId: string; state: Connector["state"]; version: number; connectorRevision: number };
type PortalStatus = { available: boolean; authorities: PortalAuthority[];
  recovery: { version: number; sourceId: string; action: string; startedAt: string } | null };
type ProjectManagementRoute = { sourceId: string; version: number; revision: number; enabled: boolean; reviewedUrlTemplate: string | null };
type Directory = { connectors: Connector[]; health: Health[]; legacyPrimary: boolean; recovery?: Recovery[] | null;
  portal?: PortalStatus; projectManagement?: ProjectManagementRoute[] };
type ApiV2ReadAcceptanceConfig = { status: "configured" | "unconfigured" | "misconfigured";
  readAcceptanceEnabled: boolean; connections: Array<{ sourceId: string; enabled: boolean }> };
type ReadAcceptancePart = { status: string; count?: number; exactIdentityMatch?: boolean; exactContractMatch?: boolean };
type ReadAcceptance = { sourceId: string; readOnly: boolean; capabilities: ReadAcceptancePart;
  directory: ReadAcceptancePart; projects: ReadAcceptancePart };
type InventoryPageSurface = { status: "persisted" | "conflicted"; itemCount: number; conflictCount: number; hasMore: boolean; continuationToken?: string };
type InventoryRequestedSurface = InventoryPageSurface
  | { status: "blocked"; reason: "transport" | "contract" | "authorization" | "binding_stale" | "storage" | "cursor_stale" };
type InventoryDisplaySurface = Omit<InventoryPageSurface, "continuationToken"> | Exclude<InventoryRequestedSurface, InventoryPageSurface>;
type InventorySurface = InventoryRequestedSurface | { status: "not_requested" };
type InventoryResult = { status: "completed" | "partial"; directory: InventorySurface; projects: InventorySurface }
  | { status: "disabled" }
  | { status: "blocked"; reason: "connection" | "capabilities" | "storage" }
  | { status: "rejected"; reason: "invalid_input" };
type DirectoryResourceType = "client" | "organization";
type DirectoryField = "name" | "email" | "phone" | "address_line1" | "address_line2" | "city" | "state"
  | "postal_code" | "country" | "client_type" | "organization_public_id";
type DirectoryFieldDecision = "unchanged" | "retain_local" | "adopt_project_alpha" | "requires_follow_up";
type FieldComparison = { status: "compared"; reviewId: string; resourceType: DirectoryResourceType; fields: Array<{
  field: DirectoryField; localValue: string | null; projectAlphaValue: string | null; equal: boolean;
}> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PA_PUBLIC_ID = /^[0-9a-f]{32}$/;
const ORGANIZATION_FIELDS: readonly DirectoryField[] = ["name", "email", "phone", "address_line1", "address_line2", "city", "state", "postal_code", "country"];
const CLIENT_FIELDS: readonly DirectoryField[] = [...ORGANIZATION_FIELDS, "client_type", "organization_public_id"];
const FIELD_LABELS: Record<DirectoryField, string> = {
  name: "Name", email: "Email", phone: "Phone", address_line1: "Address line 1", address_line2: "Address line 2",
  city: "City", state: "State", postal_code: "Postal code", country: "Country", client_type: "Client type",
  organization_public_id: "Organization public ID",
};

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
function ReadAcceptanceCheck({ sourceId, connectionEnabled, acceptanceEnabled, disabled }: {
  sourceId: string; connectionEnabled: boolean; acceptanceEnabled: boolean; disabled: boolean;
}) {
  const [busy, setBusy] = useState(false), [result, setResult] = useState<ReadAcceptance | null>(null), [error, setError] = useState("");
  const verify = async () => {
    if (busy || disabled || !connectionEnabled || !acceptanceEnabled) return;
    setBusy(true); setResult(null); setError("");
    try {
      const response = await api<ReadAcceptance>(READ_ACCEPTANCE_ENDPOINT, {
        method: "POST", body: JSON.stringify({ sourceId }),
      });
      setResult(response);
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 404
        ? "Read-only verification is disabled outside an approved maintenance window."
        : caught instanceof Error ? caught.message : "The read-only API connection could not be verified.");
    } finally { setBusy(false); }
  };
  const verified = result?.readOnly === true && result.sourceId === sourceId
    && result.capabilities.status === "verified" && result.capabilities.exactIdentityMatch === true
    && result.capabilities.exactContractMatch === true && result.directory.status === "observed"
    && result.projects.status === "observed";
  return <div className="alpha-read-acceptance" role="group" aria-label="Read-only API verification">
    <button type="button" className="button-ghost button-small" disabled={busy || disabled || !connectionEnabled || !acceptanceEnabled}
      onClick={() => void verify()}>{busy ? "Verifying read connection…" : "Verify read-only API connection"}</button>
    {!connectionEnabled && <p>Connection is disabled by deployment configuration.</p>}
    {!acceptanceEnabled && <p>Read-only acceptance is disabled by deployment configuration.</p>}
    {result && <p role={verified ? "status" : "alert"} className="notice">{verified
      ? `API v2 read connection verified · Directory ${result.directory.count ?? 0} · Projects ${result.projects.count ?? 0}`
      : `API v2 read verification did not pass · Capabilities ${result.capabilities.status} · Directory ${result.directory.status} · Projects ${result.projects.status}`}</p>}
    {error && <p role="alert" className="notice">{error}</p>}
  </div>;
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function inventorySurface(value: unknown): value is InventorySurface {
  if (!record(value)) return false;
  if (value.status === "not_requested") return Object.keys(value).length === 1;
  if (value.status === "blocked") return ["transport", "contract", "authorization", "binding_stale", "storage", "cursor_stale"].includes(String(value.reason));
  if ((value.status !== "persisted" && value.status !== "conflicted") || !Number.isInteger(value.itemCount)
    || Number(value.itemCount) < 0 || !Number.isInteger(value.conflictCount) || Number(value.conflictCount) < 0
    || typeof value.hasMore !== "boolean") return false;
  return value.hasMore
    ? typeof value.continuationToken === "string" && value.continuationToken.length >= 1 && value.continuationToken.length <= 2048
    : value.continuationToken === undefined;
}
function inventoryResult(value: unknown): value is InventoryResult {
  if (!record(value) || !["completed", "partial", "disabled", "blocked", "rejected"].includes(String(value.status))) return false;
  if (value.status === "completed" || value.status === "partial") return inventorySurface(value.directory) && inventorySurface(value.projects);
  if (value.status === "disabled") return Object.keys(value).length === 1;
  return value.status === "blocked"
    ? ["connection", "capabilities", "storage"].includes(String(value.reason))
    : value.status === "rejected" && value.reason === "invalid_input";
}
function inventoryPageResult(value: InventoryResult, continuation?: "directory" | "projects"):
  value is Extract<InventoryResult, { status: "completed" | "partial" }> {
  if (value.status !== "completed" && value.status !== "partial") return false;
  if (!continuation) return value.directory.status !== "not_requested" && value.projects.status !== "not_requested";
  const requested = continuation === "directory" ? value.directory : value.projects;
  const other = continuation === "directory" ? value.projects : value.directory;
  return requested.status !== "not_requested" && other.status === "not_requested";
}
function fieldComparison(value: unknown, reviewId: string): value is FieldComparison {
  if (!record(value) || value.status !== "compared" || value.reviewId !== reviewId
    || (value.resourceType !== "client" && value.resourceType !== "organization") || !Array.isArray(value.fields)) return false;
  const expected = value.resourceType === "client" ? CLIENT_FIELDS : ORGANIZATION_FIELDS;
  if (value.fields.length !== expected.length) return false;
  const seen = new Set<string>();
  return value.fields.every(item => {
    if (!record(item) || !expected.includes(item.field as DirectoryField) || seen.has(String(item.field))
      || !(item.localValue === null || typeof item.localValue === "string")
      || !(item.projectAlphaValue === null || typeof item.projectAlphaValue === "string") || typeof item.equal !== "boolean"
      || item.equal !== Object.is(item.localValue, item.projectAlphaValue)) return false;
    seen.add(String(item.field)); return true;
  });
}
function operatorError(caught: unknown, fallback: string): string {
  return caught instanceof ApiError && caught.status === 404
    ? "This staging-only operation is disabled. No action was taken."
    : caught instanceof ApiError && caught.status === 403
      ? "Current administrator, permission, and native staff authority is required. No values were disclosed."
      : fallback;
}
function inventorySurfaceText(label: string, surface: InventoryRequestedSurface): string {
  if (surface.status === "blocked") return surface.reason === "binding_stale"
    ? `${label}: stopped because the exact binding is stale. Review the binding before another inventory request.`
    : `${label}: blocked (${surface.reason.replaceAll("_", " ")}).`;
  return `${label}: ${surface.itemCount} observed · ${surface.conflictCount} conflicts${surface.hasMore ? " · more pages remain" : " · page complete"}.`;
}
function valueCell(value: string | null) { return value === null ? <em>Not set</em> : value === "" ? <em>Empty string</em> : <code>{value}</code>; }

function ApiV2OperatorPanel({ connectors, disabled }: { connectors: Connector[]; disabled: boolean }) {
  const active = connectors.filter(connector => connector.state === "active");
  const [inventorySource, setInventorySource] = useState(active[0]?.sourceId ?? "");
  const [inventoryBusy, setInventoryBusy] = useState<"initial" | "directory" | "projects" | null>(null);
  const [directoryInventory, setDirectoryInventory] = useState<InventoryDisplaySurface | null>(null);
  const [projectInventory, setProjectInventory] = useState<InventoryDisplaySurface | null>(null);
  const [directoryContinuationToken, setDirectoryContinuationToken] = useState("");
  const [projectContinuationToken, setProjectContinuationToken] = useState("");
  const [inventoryStopped, setInventoryStopped] = useState({ directory: "", projects: "" });
  const [inventoryError, setInventoryError] = useState("");
  const [reviewSource, setReviewSource] = useState(active[0]?.sourceId ?? ""), [resourceType, setResourceType] = useState<DirectoryResourceType>("client");
  const [recordId, setRecordId] = useState(""), [localVersion, setLocalVersion] = useState("1"), [projectAlphaPublicId, setProjectAlphaPublicId] = useState("");
  const [reviewId, setReviewId] = useState(""), [comparison, setComparison] = useState<FieldComparison | null>(null);
  const reservationKey = useRef("");
  const [decisions, setDecisions] = useState<Partial<Record<DirectoryField, DirectoryFieldDecision>>>({});
  const [reviewBusy, setReviewBusy] = useState(false), [reviewError, setReviewError] = useState(""), [reviewMessage, setReviewMessage] = useState("");
  useEffect(() => {
    if (!active.some(connector => connector.sourceId === inventorySource)) setInventorySource(active[0]?.sourceId ?? "");
    if (!active.some(connector => connector.sourceId === reviewSource)) setReviewSource(active[0]?.sourceId ?? "");
  }, [active, inventorySource, reviewSource]);
  const clearInventory = () => {
    setDirectoryInventory(null); setProjectInventory(null); setDirectoryContinuationToken(""); setProjectContinuationToken("");
    setInventoryStopped({ directory: "", projects: "" }); setInventoryError("");
  };
  const applyInventorySurface = (surface: "directory" | "projects", value: InventoryRequestedSurface) => {
    const setValue = surface === "directory" ? setDirectoryInventory : setProjectInventory;
    const setToken = surface === "directory" ? setDirectoryContinuationToken : setProjectContinuationToken;
    if (value.status === "blocked") {
      setValue(value);
      setToken("");
      setInventoryStopped(current => ({ ...current, [surface]: `${surface === "directory" ? "Directory" : "Projects"} continuation stopped. Restart the bounded inventory before requesting this surface again.` }));
    } else {
      const { continuationToken, ...display } = value;
      setValue(display);
      setToken(continuationToken ?? "");
      setInventoryStopped(current => ({ ...current, [surface]: "" }));
    }
  };
  const runInventory = async (continuation?: "directory" | "projects") => {
    const token = continuation === "directory" ? directoryContinuationToken
      : continuation === "projects" ? projectContinuationToken : "";
    if (disabled || inventoryBusy || !inventorySource || continuation && !token) return;
    setInventoryBusy(continuation ?? "initial");
    if (!continuation) clearInventory();
    else setInventoryStopped(current => ({ ...current, [continuation]: "" }));
    setInventoryError("");
    try {
      const body = { sourceId: inventorySource, limit: 100, ...(continuation === "directory" ? { directoryContinuationToken: token }
        : continuation === "projects" ? { projectContinuationToken: token } : {}) };
      const result = await api<unknown>(API_V2_SYNC_ENDPOINT, { method: "POST", body: JSON.stringify(body) });
      if (!inventoryResult(result) || !inventoryPageResult(result, continuation)) throw new Error("invalid inventory response");
      if (!continuation) {
        applyInventorySurface("directory", result.directory as InventoryRequestedSurface);
        applyInventorySurface("projects", result.projects as InventoryRequestedSurface);
      } else applyInventorySurface(continuation,
        (continuation === "directory" ? result.directory : result.projects) as InventoryRequestedSurface);
    } catch (caught) {
      if (!continuation) setInventoryError(operatorError(caught, "The bounded inventory response could not be verified. No further page was requested."));
      else {
        if (continuation === "directory") setDirectoryContinuationToken(""); else setProjectContinuationToken("");
        const stale = caught instanceof ApiError && caught.status === 409;
        setInventoryStopped(current => ({ ...current, [continuation]: `${continuation === "directory" ? "Directory" : "Projects"} continuation stopped${stale ? " because its inventory or token is stale" : " after an error"}. Restart the bounded inventory before requesting this surface again.` }));
      }
    } finally { setInventoryBusy(null); }
  };
  const clearComparison = () => { setReviewId(""); setComparison(null); setDecisions({}); setReviewError(""); setReviewMessage(""); };
  const resetReview = () => { reservationKey.current = ""; clearComparison(); };
  const reserve = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (disabled || reviewBusy) return;
    const selectedRecord = recordId.trim(), selectedPublicId = projectAlphaPublicId.trim(), version = Number(localVersion);
    if (!reviewSource || !selectedRecord || selectedRecord.length > 191 || /\p{C}/u.test(selectedRecord)
      || !Number.isInteger(version) || version < 1 || !PA_PUBLIC_ID.test(selectedPublicId)) {
      setReviewError("Enter one active source, an exact local record ID and positive version, and a 32-character lowercase Project Alpha public ID."); return;
    }
    setReviewBusy(true); clearComparison();
    try {
      const response = await api<{ outcome?: unknown }>(DIRECTORY_READ_ADOPTION_ENDPOINT, { method: "POST",
        headers: { "Idempotency-Key": reservationKey.current ||= crypto.randomUUID() }, body: JSON.stringify({ sourceId: reviewSource, resourceType,
          recordId: selectedRecord, expectedLocalRecordVersion: version, projectAlphaPublicId: selectedPublicId }) });
      const outcome = response.outcome;
      if (record(outcome) && (outcome.status === "reserved" || outcome.status === "replayed") && outcome.state === "inactive"
        && typeof outcome.reviewId === "string" && UUID.test(outcome.reviewId)) {
        setReviewId(outcome.reviewId); setReviewMessage("Exact pair reserved as inactive. Field values remain hidden until you explicitly compare them.");
      } else if (record(outcome) && outcome.status === "disabled") setReviewError("This staging-only operation is disabled. No action was taken.");
      else if (record(outcome) && ["blocked", "rejected", "conflict"].includes(String(outcome.status)))
        setReviewError(`The exact pair was not reserved (${String(outcome.status).replaceAll("_", " ")}). No comparison was performed.`);
      else throw new Error("invalid reservation response");
    } catch (caught) { setReviewError(operatorError(caught, "The exact-pair reservation response could not be verified.")); }
    finally { setReviewBusy(false); }
  };
  const compare = async () => {
    if (disabled || reviewBusy || !reviewId) return;
    setReviewBusy(true); setComparison(null); setDecisions({}); setReviewError(""); setReviewMessage("");
    try {
      const response = await api<{ outcome?: unknown }>(`${DIRECTORY_READ_ADOPTION_ENDPOINT}/${encodeURIComponent(reviewId)}/field-comparison`,
        { method: "POST", body: JSON.stringify({}) });
      const outcome = response.outcome;
      if (fieldComparison(outcome, reviewId)) {
        setComparison(outcome); setDecisions(Object.fromEntries(outcome.fields.filter(field => field.equal).map(field => [field.field, "unchanged"])));
        setReviewMessage("Authorized comparison loaded. Review every differing field before sealing.");
      } else if (record(outcome) && outcome.status === "disabled") setReviewError("This staging-only operation is disabled. No values were disclosed.");
      else if (record(outcome) && ["blocked", "rejected"].includes(String(outcome.status)))
        setReviewError("The comparison is no longer current or authorized. No values were disclosed.");
      else throw new Error("invalid comparison response");
    } catch (caught) { setReviewError(operatorError(caught, "The field-comparison response could not be verified. No values were disclosed.")); }
    finally { setReviewBusy(false); }
  };
  const seal = async () => {
    if (disabled || reviewBusy || !comparison || comparison.fields.some(field => !decisions[field.field])) return;
    if (!window.confirm("Seal these enum-only field dispositions? This does not update local records or Project Alpha.")) return;
    setReviewBusy(true); setReviewError(""); setReviewMessage("");
    try {
      const response = await api<{ outcome?: unknown }>(`${DIRECTORY_READ_ADOPTION_ENDPOINT}/${encodeURIComponent(comparison.reviewId)}/field-review`,
        { method: "POST", body: JSON.stringify({ decisions }) });
      const outcome = response.outcome;
      if (record(outcome) && (outcome.status === "sealed" || outcome.status === "replayed")
        && typeof outcome.receiptId === "string" && UUID.test(outcome.receiptId)) {
        reservationKey.current = ""; setComparison(null); setDecisions({}); setReviewId(""); setRecordId(""); setProjectAlphaPublicId(""); setLocalVersion("1");
        setReviewMessage("Field review sealed. No local profile or Project Alpha values were changed.");
      } else if (record(outcome) && ["disabled", "blocked", "rejected", "conflict"].includes(String(outcome.status)))
        setReviewError("The review could not be sealed because its exact evidence is disabled, stale, invalid, or already sealed.");
      else throw new Error("invalid field-review response");
    } catch (caught) { setReviewError(operatorError(caught, "The field-review receipt could not be verified. Treat the seal outcome as uncertain and refresh before retrying.")); }
    finally { setReviewBusy(false); }
  };
  if (connectors.length === 0) return null;
  const allDecided = Boolean(comparison) && comparison!.fields.every(field => Boolean(decisions[field.field]));
  return <details className="alpha-connection"><summary>Staging API-v2 operator review</summary>
    <p>This default-off panel reads and stores one bounded inventory page, then supports an explicit exact-record comparison. It never auto-matches records, changes access, publishes links, activates anything, or writes to Project Alpha.</p>
    <section aria-label="Bounded API-v2 inventory"><h3>Bounded inventory evidence</h3>
      <label>Deployment source<select value={inventorySource} disabled={disabled || Boolean(inventoryBusy)} onChange={event => { setInventorySource(event.target.value); clearInventory(); }}>
        {active.map(connector => <option key={connector.sourceId} value={connector.sourceId}>{connector.displayName}</option>)}</select></label>
      <button type="button" className="button-ghost button-small" disabled={disabled || Boolean(inventoryBusy) || !inventorySource} onClick={() => void runInventory()}>{inventoryBusy === "initial" ? "Reading one bounded page…" : directoryInventory || projectInventory || inventoryStopped.directory || inventoryStopped.projects || inventoryError ? "Restart bounded inventory" : "Read one bounded inventory page"}</button>
      <p>Continuation tokens stay in this browser session and are never displayed. Each button click requests at most one page; continuation is never automatic.</p>
      {directoryInventory && <div className="notice" role={directoryInventory.status === "blocked" ? "alert" : "status"}><p>{inventorySurfaceText("Directory", directoryInventory)}</p>
        {directoryContinuationToken && <button type="button" className="button-ghost button-small" disabled={disabled || Boolean(inventoryBusy)} onClick={() => void runInventory("directory")}>{inventoryBusy === "directory" ? "Continuing Directory…" : "Continue Directory"}</button>}
      </div>}
      {inventoryStopped.directory && <p role="alert" className="notice">{inventoryStopped.directory}</p>}
      {projectInventory && <div className="notice" role={projectInventory.status === "blocked" ? "alert" : "status"}><p>{inventorySurfaceText("Projects", projectInventory)}</p>
        {projectContinuationToken && <button type="button" className="button-ghost button-small" disabled={disabled || Boolean(inventoryBusy)} onClick={() => void runInventory("projects")}>{inventoryBusy === "projects" ? "Continuing Projects…" : "Continue Projects"}</button>}
      </div>}
      {inventoryStopped.projects && <p role="alert" className="notice">{inventoryStopped.projects}</p>}
      {inventoryError && <p role="alert" className="notice">{inventoryError}</p>}
    </section>
    <section aria-label="Exact-record field review"><h3>Exact-record field review</h3>
      <form onSubmit={reserve} aria-busy={reviewBusy}>
        <label>Deployment source<select value={reviewSource} disabled={disabled || reviewBusy || Boolean(reviewId)} onChange={event => { setReviewSource(event.target.value); resetReview(); }}>
          {active.map(connector => <option key={connector.sourceId} value={connector.sourceId}>{connector.displayName}</option>)}</select></label>
        <label>Record type<select value={resourceType} disabled={disabled || reviewBusy || Boolean(reviewId)} onChange={event => { setResourceType(event.target.value as DirectoryResourceType); resetReview(); }}><option value="client">Client</option><option value="organization">Organization</option></select></label>
        <label>Exact local record ID<input value={recordId} maxLength={191} disabled={disabled || reviewBusy || Boolean(reviewId)} onChange={event => { setRecordId(event.target.value); resetReview(); }} /></label>
        <label>Expected local record version<input type="number" min="1" step="1" value={localVersion} disabled={disabled || reviewBusy || Boolean(reviewId)} onChange={event => { setLocalVersion(event.target.value); resetReview(); }} /></label>
        <label>Exact Project Alpha public ID<input value={projectAlphaPublicId} maxLength={32} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={disabled || reviewBusy || Boolean(reviewId)} onChange={event => { setProjectAlphaPublicId(event.target.value); resetReview(); }} /></label>
        <button type="submit" className="button-ghost button-small" disabled={disabled || reviewBusy || Boolean(reviewId)}>{reviewBusy && !reviewId ? "Reserving exact pair…" : "Reserve exact pair"}</button>
      </form>
      {reviewId && !comparison && <button type="button" className="button-ghost button-small" disabled={disabled || reviewBusy} onClick={() => void compare()}>{reviewBusy ? "Comparing authorized fields…" : "Compare authorized fields"}</button>}
      {comparison && <div role="group" aria-label="Compared field dispositions"><table><thead><tr><th>Field</th><th>Local value</th><th>Project Alpha value</th><th>Disposition</th></tr></thead><tbody>
        {comparison.fields.map(field => <tr key={field.field}><th scope="row">{FIELD_LABELS[field.field]}</th><td>{valueCell(field.localValue)}</td><td>{valueCell(field.projectAlphaValue)}</td><td>{field.equal
          ? <span>Unchanged</span>
          : <select aria-label={`${FIELD_LABELS[field.field]} disposition`} value={decisions[field.field] ?? ""} disabled={reviewBusy} onChange={event => setDecisions(current => ({ ...current, [field.field]: event.target.value as DirectoryFieldDecision }))}>
            <option value="">Select disposition</option><option value="retain_local">Retain local</option><option value="adopt_project_alpha">Adopt Project Alpha</option><option value="requires_follow_up">Requires follow-up</option></select>}</td></tr>)}
      </tbody></table><button type="button" className="button-ghost button-small" disabled={disabled || reviewBusy || !allDecided} onClick={() => void seal()}>{reviewBusy ? "Sealing review…" : "Seal field review"}</button></div>}
      {reviewMessage && <p role="status" className="notice">{reviewMessage}</p>}{reviewError && <p role="alert" className="notice">{reviewError}</p>}
    </section>
  </details>;
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
function PortalPurpose({ connector, status, primaryActive, disabled, onAction }: {
  connector: Connector; status?: PortalStatus; primaryActive: boolean; disabled: boolean;
  onAction: (action: "configure" | "activate" | "suspend") => void;
}) {
  const authority = status?.authorities.find(row => row.sourceId === connector.sourceId);
  const current = authority?.connectorRevision === connector.activeRevision;
  const canActivate = connector.state === "active" && primaryActive && current;
  if (connector.profile !== "business_data") return null;
  return <div className="alpha-portal-purpose" role="group" aria-label="Client portal connection">
    <p><strong>Client portal</strong> · {!status?.available ? "Requires coordinated database upgrade" : authority?.state ?? "Not configured"}</p>
    {status?.available && <>
      <p>Uses this connection's deployed event-key commitment. It does not register a source or grant client access by itself.</p>
      {authority && !current && <p className="notice">Refresh portal configuration after the deployed connection revision changes.</p>}
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

/** The connector registry is deployment-owned. This is a status/sync surface,
 * never a browser form for source authority or credentials. */
export function ProjectAlphaConnections() {
  const [data, setData] = useState<Directory | null>(null), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [apiV2Config, setApiV2Config] = useState<ApiV2ReadAcceptanceConfig | null>(null), [apiV2ConfigError, setApiV2ConfigError] = useState("");
  const [legacyVisible, setLegacyVisible] = useState(false);
  const [loading, setLoading] = useState(false), [syncing, setSyncing] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    if (!legacyVisible) { setLoading(false); return; }
    const controller = new AbortController(); setLoading(true);
    api<Directory>(ENDPOINT, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setData(result); setError(""); } })
      .catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Connection status could not be loaded."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [legacyVisible, revision]);
  useEffect(() => {
    const controller = new AbortController();
    api<ApiV2ReadAcceptanceConfig>(READ_ACCEPTANCE_CONNECTIONS_ENDPOINT, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setApiV2Config(result); setApiV2ConfigError(""); } })
      .catch(caught => { if (!controller.signal.aborted) setApiV2ConfigError(caught instanceof Error
        ? caught.message : "API-v2 connection status could not be loaded."); });
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
  const portalAction = async (connector: Connector, action: "configure" | "activate" | "suspend") => {
    if (syncing) return;
    const authority = data?.portal?.authorities.find(row => row.sourceId === connector.sourceId);
    const warning = action === "configure"
      ? "Stage this connection's deployed event-key commitment? This does not register the source or grant client access."
      : action === "activate"
        ? "Activate this connection's client portal for independently authorized workspaces?"
        : "Pause this connection's client portal? Existing records and grants are retained.";
    if (!window.confirm(warning)) return;
    setSyncing(connector.sourceId); setError(""); setMessage("");
    try {
      await api(`${ENDPOINT}/${encodeURIComponent(connector.sourceId)}/portal`, { method: "POST", body: JSON.stringify({
        expectedVersion: connector.version, expectedPortalVersion: authority?.version ?? null, action,
      }) });
      if (live.current) { setMessage(action === "configure" ? "Client portal configuration staged." : action === "activate" ? "Client portal activated." : "Client portal paused."); setRevision(value => value + 1); }
    } catch (caught) { if (live.current) setError(caught instanceof Error ? caught.message : "Client portal could not be updated."); }
    finally { if (live.current) setSyncing(null); }
  };
  const recoverPortalUpdate = async () => {
    const recovery = data?.portal?.recovery;
    if (syncing || !recovery) return;
    if (!window.confirm("Cancel the unfinished portal configuration update and leave affected client portals paused? You can review and activate each connection afterward.")) return;
    setSyncing("portal-recovery"); setError(""); setMessage("");
    try {
      await api(`${ENDPOINT}/recover-portal-update`, { method: "POST", body: JSON.stringify({ expectedVersion: recovery.version }) });
      if (live.current) { setMessage("Unfinished portal update recovered. Review each portal before activating it."); setRevision(value => value + 1); }
    } catch (caught) { if (live.current) setError(caught instanceof Error ? caught.message : "Portal recovery could not be completed."); }
    finally { if (live.current) setSyncing(null); }
  };
  const legacy: Connector = { sourceId: PRIMARY, displayName: "Primary connection", producerBindingId: "legacy", snapshotOrigin: "", snapshotBasePath: "", applicationKey: "", profile: "primary_legacy", state: "active", readVisible: true, activeRevision: 0, version: 0 };
  return <Card title="Project Alpha connections"><div className="alpha-connections">
    <p>Connection identities, destinations, and credentials are managed as deployment configuration. Operations can show status and request a sync, but cannot register, alter, or retire a source from the browser.</p>
    {error && <p role="alert" className="notice">{error}</p>}{message && <p role="status" className="notice">{message}</p>}{legacyVisible && !data && !error && <p role="status">Loading legacy connection tools…</p>}
      <button type="button" className="button-ghost button-small" disabled={loading || Boolean(syncing)} onClick={refresh}>Refresh connection status</button>
    <section className="alpha-connection" aria-label="Project Alpha API v2 read-only connections">
      <h3>Project Alpha API v2 · read-only acceptance</h3>
      <p>Checks the deployment-configured API-v2 connection directly. This does not use legacy snapshot sync or change either system.</p>
      {apiV2ConfigError && <p role="alert" className="notice">{apiV2ConfigError}</p>}
      {!apiV2Config && !apiV2ConfigError && <p role="status">Loading API-v2 connection status…</p>}
      {apiV2Config?.status === "unconfigured" && <p>No API-v2 connections are configured for this deployment.</p>}
      {apiV2Config?.status === "misconfigured" && <p role="alert">The API-v2 connection configuration is invalid or unavailable. Secret details are not shown here.</p>}
      {apiV2Config?.status === "configured" && apiV2Config.connections.map(connection => <div key={connection.sourceId} className="alpha-connection-actions">
        <span><strong>{connection.sourceId}</strong> · {connection.enabled ? "Enabled" : "Disabled"}</span>
        <ReadAcceptanceCheck key={`${connection.sourceId}:${connection.enabled}:${apiV2Config.readAcceptanceEnabled}:${revision}`}
          sourceId={connection.sourceId} connectionEnabled={connection.enabled}
          acceptanceEnabled={apiV2Config.readAcceptanceEnabled} disabled={loading || Boolean(syncing)} />
      </div>)}
    </section>
    {!legacyVisible && <button type="button" className="button-ghost button-small" disabled={loading || Boolean(syncing)} onClick={() => setLegacyVisible(true)}>Show legacy connection tools</button>}
    {legacyVisible && <p className="notice">Legacy snapshot sync, portal controls, and project links are separate from API v2. These tools do not verify or change the API-v2 connection.</p>}
    {data?.legacyPrimary && <section className="alpha-connection" aria-label="Primary connection"><h3>Primary connection</h3><p><strong>Business record sync</strong> · Using the original deployment configuration. Add it to the deployment source manifest to migrate it to the same exact-source registry as additional Project Alpha instances.</p><SyncHealth health={data.health.find(row => row.sourceId === PRIMARY)} /><button type="button" disabled={loading || Boolean(syncing)} onClick={() => void sync(legacy)}>{syncing === PRIMARY ? "Synchronizing…" : "Sync primary now"}</button></section>}
    {data?.connectors.map(connector => {
      const management = data.projectManagement?.find(row => row.sourceId === connector.sourceId);
      return <section key={connector.sourceId} className="alpha-connection" aria-label={`${connector.displayName} connection`}><h3>{connector.displayName}</h3>
        <p><strong>{connector.state}</strong> · {connector.profile === "primary_legacy" ? "Primary staff authority" : "Business data only"} · {connector.readVisible ? "Business records visible" : "Business records hidden"}</p>
        <SyncHealth health={data.health.find(row => row.sourceId === connector.sourceId)} /><RecoveryStatus connector={connector} recovery={data.recovery?.find(row => row.sourceId === connector.sourceId)} />
        <PortalPurpose connector={connector} status={data.portal}
          primaryActive={data.legacyPrimary || data.connectors.some(row => row.sourceId === PRIMARY && row.state === "active")}
          disabled={loading || Boolean(syncing)} onAction={action => void portalAction(connector, action)} />
        <ProjectManagement connector={connector} route={management} disabled={loading || Boolean(syncing)} onRefresh={() => setRevision(value => value + 1)} />
        <div className="alpha-connection-actions"><button type="button" disabled={loading || Boolean(syncing) || connector.state !== "active"} onClick={() => void sync(connector)}>{syncing === connector.sourceId ? "Synchronizing…" : "Sync now"}</button>
        </div>
        <details><summary>Connection details</summary><dl><dt>Source</dt><dd>{connector.sourceId}</dd><dt>Producer</dt><dd>{connector.producerBindingId}</dd><dt>Destination</dt><dd>{connector.snapshotOrigin}{connector.snapshotBasePath}</dd><dt>Application</dt><dd>{connector.applicationKey}</dd><dt>Revision</dt><dd>{connector.activeRevision}</dd></dl><p>These values are read-only here. Change the reviewed deployment source manifest and deploy Operations; do not paste credentials into this page.</p></details>
      </section>;
    })}
    {data && <ApiV2OperatorPanel connectors={data.connectors} disabled={loading || Boolean(syncing)} />}
    {data?.portal?.recovery && <div className="notice" role="status"><p>A prior portal coordination operation is unfinished. Recovery cancels that uncertain update and pauses affected client portals; it never registers a source or retries activation.</p><button type="button" disabled={loading || Boolean(syncing)} onClick={() => void recoverPortalUpdate()}>Recover unfinished portal update</button></div>}
  </div></Card>;
}
