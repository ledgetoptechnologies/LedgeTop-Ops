import { useEffect, useRef, useState, type FormEvent } from "react";
import { Card } from "@ltds/ui";
import { api, ApiError } from "./api";

const ENDPOINT = "/api/admin/integrations/project-alpha/connectors";
const READ_ACCEPTANCE_ENDPOINT = "/api/admin/integrations/project-alpha/api-v2/read-acceptance";
const API_V2_SOURCES_ENDPOINT = "/api/admin/integrations/project-alpha/api-v2/sources";
const API_V2_SYNC_ENDPOINT = "/api/admin/integrations/project-alpha/api-v2/sync-page";
const DIRECTORY_READ_ADOPTION_ENDPOINT = "/api/admin/integrations/project-alpha/api-v2/directory/read-adoptions";
const DIRECTORY_READ_ADOPTION_CANDIDATES_ENDPOINT = `${DIRECTORY_READ_ADOPTION_ENDPOINT}/candidates`;
const PROJECT_BINDING_REFRESH_ENDPOINT = "/api/admin/project-alpha/private/projects/bindings/refresh";
const PROJECT_ADOPTION_CANDIDATES_ENDPOINT = "/api/admin/project-alpha/private/projects/adoption/candidates";
const PROJECT_ADOPTION_REVIEW_ENDPOINT = "/api/admin/project-alpha/private/projects/adoption/review";
const PRIMARY = "project-alpha:primary";
const STAGING = "project-alpha:staging";
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
type ReadAcceptancePart = { status: string; reason?: string; count?: number; exactIdentityMatch?: boolean; exactContractMatch?: boolean };
type ReadAcceptance = { sourceId: string; readOnly: boolean; capabilities: ReadAcceptancePart;
  directory: ReadAcceptancePart; projects: ReadAcceptancePart; clientWrites?: {
    meaning: "advertised_prerequisites_only";
    create: ReadAcceptancePart;
    profileWrite: ReadAcceptancePart;
  } };
type BindingRefreshOutcome = { status: string; reason?: string };
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
type DirectoryCandidate = { source: { sourceId: string; sourceInstanceId: string; applicationId: string; historyEpoch: string };
  resourceType: DirectoryResourceType; projectAlphaPublicId: string; resourceRevision: string; authorizationGeneration: string;
  binding: { externalId: string; status: "active"; resourceRevision: string }; conflictState: "clear" };
type DirectoryCandidatePage = { items: DirectoryCandidate[]; nextCursor: string | null };
type FieldComparison = { status: "compared"; reviewId: string; resourceType: DirectoryResourceType; fields: Array<{
  field: DirectoryField; localValue: string | null; projectAlphaValue: string | null; equal: boolean;
}> };
type ProjectAdoptionCandidate = { publicId: string; revision: string; projectionSha256: string; name: string;
  status: string; archived: false; organizationPublicId: string | null; clientPublicId: string | null;
  organizationRecordId: string | null; clientRecordId: string | null };

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
function advertisedPrerequisiteText(value: ReadAcceptancePart): string {
  if (value.status === "advertised") return "advertised";
  const reasons: Record<string, string> = { missing_endpoint: "missing endpoint", missing_capability: "missing granted capability",
    source_mismatch: "source identity mismatch", application_mismatch: "application identity mismatch",
    history_epoch_mismatch: "history epoch mismatch", credentials_or_scope: "credentials or scope unavailable" };
  return `${value.status}${value.reason && reasons[value.reason] ? ` (${reasons[value.reason]})` : ""}`;
}
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
function safeBindingRefreshOutcome(value: unknown): BindingRefreshOutcome | null {
  if (!record(value) || typeof value.status !== "string") return null;
  const allowedStatuses = ["refreshed", "current", "not_refreshed", "blocked", "rejected", "conflict", "uncertain"];
  if (!allowedStatuses.includes(value.status)) return null;
  const allowedReasons = ["source_disabled", "not_found", "binding_stale", "transport", "authorization", "contract", "storage",
    "preflight_configuration", "preflight_transport", "preflight_timeout", "preflight_credentials_or_scope", "preflight_http_status",
    "preflight_rate_limit", "preflight_response_limit", "preflight_invalid_contract", "preflight_source_mismatch",
    "preflight_application_mismatch", "preflight_history_epoch_mismatch", "preflight_missing_capability", "preflight_missing_endpoint"];
  return { status: value.status, ...(typeof value.reason === "string" && allowedReasons.includes(value.reason) ? { reason: value.reason } : {}) };
}
function bindingRefreshMessage(outcome: BindingRefreshOutcome): string {
  if (outcome.status === "refreshed") return "Binding refresh completed.";
  if (outcome.status === "current") return "The binding is already current.";
  if (outcome.status === "not_refreshed") return `Binding was not refreshed${outcome.reason ? ` (${outcome.reason.replaceAll("_", " ")})` : "."}`;
  return `Binding refresh was not completed${outcome.reason ? ` (${outcome.reason.replaceAll("_", " ")})` : "."}`;
}
function ReadAcceptanceCheck({ connector, disabled }: { connector: Pick<Connector, "sourceId" | "state">; disabled: boolean }) {
  const [busy, setBusy] = useState(false), [result, setResult] = useState<ReadAcceptance | null>(null), [error, setError] = useState("");
  const [externalProjectId, setExternalProjectId] = useState(""), [confirmedExternalProjectId, setConfirmedExternalProjectId] = useState("");
  const [refreshBusy, setRefreshBusy] = useState(false), [refreshOutcome, setRefreshOutcome] = useState<BindingRefreshOutcome | null>(null), [refreshError, setRefreshError] = useState("");
  const verify = async () => {
    if (busy || disabled || connector.state !== "active") return;
    setBusy(true); setResult(null); setError("");
    try {
      const response = await api<ReadAcceptance>(READ_ACCEPTANCE_ENDPOINT, {
        method: "POST", body: JSON.stringify({ sourceId: connector.sourceId }),
      });
      setResult(response);
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 404
        ? "Read-only verification is disabled outside an approved maintenance window."
        : caught instanceof Error ? caught.message : "The read-only API connection could not be verified.");
    } finally { setBusy(false); }
  };
  const verified = result?.readOnly === true && result.sourceId === connector.sourceId
    && result.capabilities.status === "verified" && result.capabilities.exactIdentityMatch === true
    && result.capabilities.exactContractMatch === true && result.directory.status === "observed"
    && result.projects.status === "observed";
  const staleStagingBinding = connector.sourceId === STAGING && result?.projects.status === "binding_stale";
  const refresh = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const projectId = externalProjectId.trim(), confirmation = confirmedExternalProjectId.trim();
    if (!staleStagingBinding || refreshBusy || disabled) return;
    if (!projectId || projectId !== externalProjectId || confirmation !== confirmedExternalProjectId
      || projectId.length > 191 || /\p{C}/u.test(projectId) || projectId !== confirmation) {
      setRefreshError("Enter the exact external Project ID twice so it can be confirmed."); return;
    }
    setRefreshBusy(true); setRefreshError(""); setRefreshOutcome(null);
    try {
      const response = await api<{ outcome?: unknown }>(PROJECT_BINDING_REFRESH_ENDPOINT, {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ sourceId: STAGING, externalProjectId: projectId }),
      });
      const outcome = safeBindingRefreshOutcome(response.outcome);
      if (!outcome) throw new Error("The binding refresh response could not be verified.");
      setRefreshOutcome(outcome);
    } catch (caught) {
      setRefreshError(operatorError(caught, "The staging binding refresh could not be completed."));
    } finally { setRefreshBusy(false); }
  };
  return <div className="alpha-read-acceptance" role="group" aria-label="Read-only API verification">
    <button type="button" className="button-ghost button-small" disabled={busy || disabled || connector.state !== "active"}
      onClick={() => void verify()}>{busy ? "Verifying read connection…" : "Verify read-only API connection"}</button>
    {result && <p role={verified ? "status" : "alert"} className="notice">{verified
      ? `API v2 read connection verified · Directory ${result.directory.count ?? 0} · Projects ${result.projects.count ?? 0}`
      : `API v2 read verification did not pass · Capabilities ${result.capabilities.status} · Directory ${result.directory.status} · Projects ${result.projects.status}`}</p>}
    {result?.clientWrites && <p role={result.clientWrites.create.status === "advertised"
      && result.clientWrites.profileWrite.status === "advertised" ? "status" : "alert"} className="notice">
      <strong>Advertised client-write prerequisites (no write attempted)</strong><br />
      Create endpoint and capability: {advertisedPrerequisiteText(result.clientWrites.create)}<br />
      Profile-write endpoint and capability: {advertisedPrerequisiteText(result.clientWrites.profileWrite)}
    </p>}
    {error && <p role="alert" className="notice">{error}</p>}
    {staleStagingBinding && <form onSubmit={refresh} aria-busy={refreshBusy} className="alpha-binding-refresh">
      <p><strong>Staging project binding is stale.</strong> Confirm the exact external Project ID before requesting a guarded refresh.</p>
      <label htmlFor="staging-binding-project-id">Exact external Project ID</label>
      <input id="staging-binding-project-id" value={externalProjectId} disabled={refreshBusy || disabled}
        onChange={event => { setExternalProjectId(event.target.value); setRefreshError(""); setRefreshOutcome(null); }} maxLength={191} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      <label htmlFor="staging-binding-project-id-confirm">Confirm exact external Project ID</label>
      <input id="staging-binding-project-id-confirm" value={confirmedExternalProjectId} disabled={refreshBusy || disabled}
        onChange={event => { setConfirmedExternalProjectId(event.target.value); setRefreshError(""); setRefreshOutcome(null); }} maxLength={191} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      <button type="submit" className="button-ghost button-small" disabled={refreshBusy || disabled}>{refreshBusy ? "Refreshing binding…" : "Refresh staging binding"}</button>
      {refreshOutcome && <p role="status" className="notice">{bindingRefreshMessage(refreshOutcome)}</p>}
      {refreshError && <p role="alert" className="notice">{refreshError}</p>}
    </form>}
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

const STAGING_DIRECTORY_OWNER_VIEW_GRANT_ENDPOINT = "/api/admin/staging/directory/owner-profile-view-grant";
function ApiV2OperatorPanel({ disabled }: { disabled: boolean }) {
  const [ownerViewGrantEnabled, setOwnerViewGrantEnabled] = useState(false);
  const [ownerGrantBusy, setOwnerGrantBusy] = useState(false), [ownerGrantMessage, setOwnerGrantMessage] = useState("");
  const [available, setAvailable] = useState<boolean | null>(null), [sources, setSources] = useState<string[]>([]), [sourceError, setSourceError] = useState("");
  const [inventorySource, setInventorySource] = useState("");
  const [inventoryBusy, setInventoryBusy] = useState<"initial" | "directory" | "projects" | null>(null);
  const [directoryInventory, setDirectoryInventory] = useState<InventoryDisplaySurface | null>(null);
  const [projectInventory, setProjectInventory] = useState<InventoryDisplaySurface | null>(null);
  const [directoryContinuationToken, setDirectoryContinuationToken] = useState("");
  const [projectContinuationToken, setProjectContinuationToken] = useState("");
  const [inventoryStopped, setInventoryStopped] = useState({ directory: "", projects: "" });
  const [inventoryError, setInventoryError] = useState("");
  const [reviewSource, setReviewSource] = useState(""), [resourceType, setResourceType] = useState<DirectoryResourceType>("client");
  const [recordId, setRecordId] = useState(""), [localVersion, setLocalVersion] = useState("1");
  const [candidates, setCandidates] = useState<DirectoryCandidate[]>([]), [candidateCursor, setCandidateCursor] = useState<string | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<DirectoryCandidate | null>(null);
  const [candidateBusy, setCandidateBusy] = useState(false), [candidateError, setCandidateError] = useState("");
  const [reviewId, setReviewId] = useState(""), [comparison, setComparison] = useState<FieldComparison | null>(null);
  const reservationKey = useRef(""), finalizationKey = useRef("");
  const [sealedReceiptId, setSealedReceiptId] = useState("");
  const [decisions, setDecisions] = useState<Partial<Record<DirectoryField, DirectoryFieldDecision>>>({});
  const [reviewBusy, setReviewBusy] = useState(false), [reviewError, setReviewError] = useState(""), [reviewMessage, setReviewMessage] = useState("");
  useEffect(() => {
    let live = true;
    api<{ sources?: unknown; stagingDirectoryOwnerViewGrantEnabled?: boolean }>(API_V2_SOURCES_ENDPOINT).then(result => {
      if (!live) return;
      if (!Array.isArray(result.sources) || result.sources.some(source => typeof source !== "string"
        || !/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(source))) throw new Error("invalid source list");
      const listed = [...new Set(result.sources)].sort();
      setAvailable(true);
      setOwnerViewGrantEnabled(result.stagingDirectoryOwnerViewGrantEnabled === true);
      setSources(listed);
      setInventorySource(current => listed.includes(current) ? current : listed[0] ?? "");
      setReviewSource(current => listed.includes(current) ? current : listed[0] ?? "");
      setSourceError("");
    }).catch(caught => {
      if (live) {
        const disabledOnDeployment = caught instanceof ApiError && caught.status === 404;
        setAvailable(!disabledOnDeployment);
        setSources([]);
        setSourceError(disabledOnDeployment ? "" : operatorError(caught, "API-v2 source configuration could not be loaded."));
      }
    });
    return () => { live = false; };
  }, []);
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
  const resetReview = () => { reservationKey.current = ""; finalizationKey.current = ""; setSealedReceiptId(""); clearComparison(); };
  const loadCandidates = async (cursor?: string | null, append = false) => {
    if (disabled || candidateBusy || !reviewSource) return;
    setCandidateBusy(true); setCandidateError("");
    try {
      const query = new URLSearchParams({ sourceId: reviewSource, limit: "50", ...(cursor ? { cursor } : {}) });
      const response = await api<unknown>(`${DIRECTORY_READ_ADOPTION_CANDIDATES_ENDPOINT}?${query.toString()}`);
      if (!record(response) || !Array.isArray(response.items) || !(response.nextCursor === null || typeof response.nextCursor === "string"))
        throw new Error("invalid candidate response");
      const parsed = response.items.filter((item): item is DirectoryCandidate => record(item) && record(item.source) && record(item.binding)
        && item.source.sourceId === reviewSource && typeof item.source.sourceInstanceId === "string"
        && typeof item.source.applicationId === "string" && typeof item.source.historyEpoch === "string"
        && (item.resourceType === "client" || item.resourceType === "organization")
        && typeof item.projectAlphaPublicId === "string" && PA_PUBLIC_ID.test(item.projectAlphaPublicId)
        && typeof item.resourceRevision === "string" && typeof item.authorizationGeneration === "string"
        && item.binding.status === "active" && typeof item.binding.externalId === "string"
        && item.binding.resourceRevision === item.resourceRevision && item.conflictState === "clear");
      if (parsed.length !== response.items.length || parsed.length > 50) throw new Error("invalid candidate item");
      setCandidates(current => append ? [...current, ...parsed] : parsed);
      setCandidateCursor(response.nextCursor);
      setSelectedCandidate(null);
      setRecordId("");
      setLocalVersion("1");
      resetReview();
    } catch (caught) {
      setCandidateError(operatorError(caught, "Eligible Project Alpha candidates could not be loaded. Refresh the list before continuing."));
      if (!append) { setCandidates([]); setCandidateCursor(null); setSelectedCandidate(null); }
    } finally { setCandidateBusy(false); }
  };
  const reserve = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (disabled || reviewBusy) return;
    const selectedRecord = recordId.trim(), version = Number(localVersion), selected = selectedCandidate;
    if (!reviewSource || !selectedRecord || selectedRecord.length > 191 || /\p{C}/u.test(selectedRecord)
      || !Number.isInteger(version) || version < 1 || !selected || selected.resourceType !== resourceType || selected.source.sourceId !== reviewSource) {
      setReviewError("Select one eligible Project Alpha record and enter its exact Operations record ID and positive version."); return;
    }
    setReviewBusy(true); clearComparison();
    try {
      const response = await api<{ outcome?: unknown }>(DIRECTORY_READ_ADOPTION_ENDPOINT, { method: "POST",
        headers: { "Idempotency-Key": reservationKey.current ||= crypto.randomUUID() }, body: JSON.stringify({ sourceId: reviewSource, resourceType,
          recordId: selectedRecord, expectedLocalRecordVersion: version, sourceInstanceId: selected.source.sourceInstanceId,
          applicationId: selected.source.applicationId, historyEpoch: selected.source.historyEpoch,
          projectAlphaPublicId: selected.projectAlphaPublicId, resourceRevision: selected.resourceRevision,
          authorizationGeneration: selected.authorizationGeneration, bindingExternalId: selected.binding.externalId,
          bindingResourceRevision: selected.binding.resourceRevision }) });
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
        setSealedReceiptId(outcome.receiptId); setComparison(null); setDecisions({}); setReviewId("");
        setReviewMessage("Field review sealed. Review the finalization warning and explicitly finalize to apply the selected fields and binding.");
      } else if (record(outcome) && ["disabled", "blocked", "rejected", "conflict"].includes(String(outcome.status)))
        setReviewError("The review could not be sealed because its exact evidence is disabled, stale, invalid, or already sealed.");
      else throw new Error("invalid field-review response");
    } catch (caught) { setReviewError(operatorError(caught, "The field-review receipt could not be verified. Treat the seal outcome as uncertain and refresh before retrying.")); }
    finally { setReviewBusy(false); }
  };
  const finalize = async () => {
    if (disabled || reviewBusy || !sealedReceiptId) return;
    if (!window.confirm("Finalize this sealed review? Explicitly adopted scalar fields will update the Operations record, Project Alpha will be rebound to that exact record, and the canonical mapping will activate. This does not grant client portal, Delivery, folder, workspace, or public-link access.")) return;
    setReviewBusy(true); setReviewError(""); setReviewMessage("");
    try {
      const response = await api<{ outcome?: unknown }>(`${DIRECTORY_READ_ADOPTION_ENDPOINT}/field-reviews/${encodeURIComponent(sealedReceiptId)}/finalize`, {
        method: "POST", headers: { "Idempotency-Key": finalizationKey.current ||= crypto.randomUUID() }, body: JSON.stringify({}),
      });
      const outcome = response.outcome;
      if (record(outcome) && (outcome.status === "finalized" || outcome.status === "replayed")
        && typeof outcome.finalizationId === "string" && UUID.test(outcome.finalizationId)) {
        resetReview(); setRecordId(""); setLocalVersion("1"); setSelectedCandidate(null);
        setReviewMessage("Exact Directory mapping finalized. No client portal, Delivery, workspace, folder, or public-link access was granted.");
      } else if (record(outcome) && ["disabled", "blocked", "rejected", "conflict", "uncertain"].includes(String(outcome.status)))
        setReviewError(`Finalization stopped at ${typeof outcome.stage === "string" ? outcome.stage.replaceAll("_", " ") : "its safety gate"}. Refresh and perform a new review if evidence or authority is stale.`);
      else throw new Error("invalid finalization response");
    } catch (caught) { setReviewError(operatorError(caught, "Finalization could not be verified. Retry with the same browser session before starting a new review.")); }
    finally { setReviewBusy(false); }
  };
  const grantOwnerView = async () => {
    if (disabled || ownerGrantBusy || !ownerViewGrantEnabled) return;
    if (!window.confirm("Grant only the protected Operations owner global Directory profile-view access in staging? This does not grant edit, client activation, PA writes, portal access, or public-link authority.")) return;
    setOwnerGrantBusy(true); setOwnerGrantMessage("");
    try {
      const response = await api<{ status?: string; permission?: string; scope?: string }>(STAGING_DIRECTORY_OWNER_VIEW_GRANT_ENDPOINT, {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ confirm: true }),
      });
      if ((response.status !== "granted" && response.status !== "already_granted")
        || response.permission !== "directory.profile.view" || response.scope !== "global") throw new Error("Grant response could not be verified.");
      setOwnerGrantMessage(response.status === "granted" ? "Staging owner profile-view permission granted and audited." : "Staging owner profile-view permission was already active.");
    } catch (caught) { setOwnerGrantMessage(operatorError(caught, "The staging owner view grant could not be verified. Refresh before retrying.")); }
    finally { setOwnerGrantBusy(false); }
  };
  const allDecided = Boolean(comparison) && comparison!.fields.every(field => Boolean(decisions[field.field]));
  if (available !== true) return null;
  return <details className="alpha-connection"><summary>Staging API-v2 operator review</summary>
    <p>This default-off panel reads and stores one bounded inventory page, then supports an explicit exact-record comparison. It never auto-matches records, changes client access, publishes links, activates clients, or writes to Project Alpha. A separately enabled staging-only control can grant the protected owner profile-view access.</p>
    {sourceError && <p role="alert" className="notice">{sourceError}</p>}
    {sources.length === 0 ? <p role="status">No enabled API-v2 sources are available to review. Legacy connector records are not used to discover API-v2 connections.</p> : <>
    <ul aria-label="Enabled API-v2 sources">{sources.map(sourceId => <li key={sourceId}><strong>{sourceId}</strong>
      <ReadAcceptanceCheck connector={{ sourceId, state: "active" }} disabled={disabled} /></li>)}</ul>
    <section aria-label="Bounded API-v2 inventory"><h3>Bounded inventory evidence</h3>
      <label>Deployment source<select value={inventorySource} disabled={disabled || Boolean(inventoryBusy)} onChange={event => { setInventorySource(event.target.value); clearInventory(); }}>
        {sources.map(sourceId => <option key={sourceId} value={sourceId}>{sourceId}</option>)}</select></label>
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
      {ownerViewGrantEnabled && <div><h4>Staging owner profile review</h4><p>This one-time action grants the protected owner only global Directory profile-view access. It does not change client access or Project Alpha.</p>
        <button type="button" className="button-ghost button-small" disabled={disabled || ownerGrantBusy} onClick={() => void grantOwnerView()}>{ownerGrantBusy ? "Granting view access…" : "Grant owner profile view"}</button>
        {ownerGrantMessage && <p role="status" className="notice">{ownerGrantMessage}</p>}</div>}
      <form onSubmit={reserve} aria-busy={reviewBusy}>
        <label>Deployment source<select value={reviewSource} disabled={disabled || reviewBusy || candidateBusy || Boolean(reviewId)} onChange={event => { setReviewSource(event.target.value); setCandidates([]); setCandidateCursor(null); setSelectedCandidate(null); resetReview(); }}>
          {sources.map(sourceId => <option key={sourceId} value={sourceId}>{sourceId}</option>)}</select></label>
        <label>Record type<select value={resourceType} disabled={disabled || reviewBusy || candidateBusy || Boolean(reviewId)} onChange={event => { setResourceType(event.target.value as DirectoryResourceType); setSelectedCandidate(null); resetReview(); }}><option value="client">Client</option><option value="organization">Organization</option></select></label>
        <div role="group" aria-label="Eligible Project Alpha records">
          <button type="button" className="button-ghost button-small" disabled={disabled || candidateBusy || reviewBusy || Boolean(reviewId)} onClick={() => void loadCandidates(null)}>{candidateBusy ? "Loading eligible records…" : "Refresh eligible Project Alpha records"}</button>
          {candidateError && <p role="alert" className="notice">{candidateError}</p>}
          {candidates.filter(candidate => candidate.resourceType === resourceType).map(candidate => {
            const value = `${candidate.source.sourceInstanceId}:${candidate.source.applicationId}:${candidate.source.historyEpoch}:${candidate.resourceType}:${candidate.projectAlphaPublicId}`;
            const selectedValue = selectedCandidate && `${selectedCandidate.source.sourceInstanceId}:${selectedCandidate.source.applicationId}:${selectedCandidate.source.historyEpoch}:${selectedCandidate.resourceType}:${selectedCandidate.projectAlphaPublicId}`;
            return <label key={value}><input type="radio" name="project-alpha-directory-candidate" value={value}
              checked={selectedValue === value} disabled={disabled || candidateBusy || reviewBusy || Boolean(reviewId)}
              onChange={() => { resetReview(); setSelectedCandidate(candidate); }} />
              {candidate.resourceType} · {candidate.projectAlphaPublicId} · revision {candidate.resourceRevision} · binding {candidate.binding.externalId}</label>;
          })}
          {!candidateBusy && candidates.filter(candidate => candidate.resourceType === resourceType).length === 0 && <p role="status">No eligible unreserved {resourceType} records on this page.</p>}
          {candidateCursor && <button type="button" className="button-ghost button-small" disabled={disabled || candidateBusy || reviewBusy || Boolean(reviewId)} onClick={() => void loadCandidates(candidateCursor, true)}>{candidateBusy ? "Loading more…" : "Load more eligible records"}</button>}
        </div>
        <label>Exact local record ID<input value={recordId} maxLength={191} disabled={disabled || reviewBusy || Boolean(reviewId)} onChange={event => { setRecordId(event.target.value); resetReview(); }} /></label>
        <label>Expected local record version<input type="number" min="1" step="1" value={localVersion} disabled={disabled || reviewBusy || Boolean(reviewId)} onChange={event => { setLocalVersion(event.target.value); resetReview(); }} /></label>
        <button type="submit" className="button-ghost button-small" disabled={disabled || reviewBusy || Boolean(reviewId) || !selectedCandidate}>{reviewBusy && !reviewId ? "Reserving exact pair…" : "Reserve selected exact pair"}</button>
      </form>
      {reviewId && !comparison && <button type="button" className="button-ghost button-small" disabled={disabled || reviewBusy} onClick={() => void compare()}>{reviewBusy ? "Comparing authorized fields…" : "Compare authorized fields"}</button>}
      {comparison && <div role="group" aria-label="Compared field dispositions"><div className="project-alpha-field-review-table-scroll" tabIndex={0} aria-label="Compared fields; scroll horizontally to view each value and disposition"><table><thead><tr><th>Field</th><th>Local value</th><th>Project Alpha value</th><th>Disposition</th></tr></thead><tbody>
        {comparison.fields.map(field => <tr key={field.field}><th scope="row">{FIELD_LABELS[field.field]}</th><td>{valueCell(field.localValue)}</td><td>{valueCell(field.projectAlphaValue)}</td><td>{field.equal
          ? <span>Unchanged</span>
          : <select aria-label={`${FIELD_LABELS[field.field]} disposition`} value={decisions[field.field] ?? ""} disabled={reviewBusy} onChange={event => setDecisions(current => ({ ...current, [field.field]: event.target.value as DirectoryFieldDecision }))}>
            <option value="">Select disposition</option><option value="retain_local">Retain local</option><option value="adopt_project_alpha">Adopt Project Alpha</option><option value="requires_follow_up">Requires follow-up</option></select>}</td></tr>)}
      </tbody></table></div><button type="button" className="button-ghost button-small" disabled={disabled || reviewBusy || !allDecided} onClick={() => void seal()}>{reviewBusy ? "Sealing review…" : "Seal field review"}</button></div>}
      {sealedReceiptId && <div role="group" aria-label="Finalize sealed Directory review"><p>This applies only the sealed scalar dispositions, rebinds the exact Project Alpha identity, and activates the one-to-one canonical mapping. Unsupported relationship changes require a new review. Client portal, Delivery, workspace, folder, and public-link access remain unchanged.</p>
        <button type="button" className="button-ghost button-small" disabled={disabled || reviewBusy} onClick={() => void finalize()}>{reviewBusy ? "Finalizing exact mapping…" : "Finalize sealed review"}</button></div>}
      {reviewMessage && <p role="status" className="notice">{reviewMessage}</p>}{reviewError && <p role="alert" className="notice">{reviewError}</p>}
    </section>
    </>}
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

function ProjectAdoptionPanel({ connectors, disabled }: { connectors: readonly Connector[]; disabled: boolean }) {
  const sources = connectors.filter(row => row.state === "active");
  const [sourceId, setSourceId] = useState(STAGING), [projects, setProjects] = useState<readonly ProjectAdoptionCandidate[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState(""), [externalId, setExternalId] = useState("");
  const [reviewKey, setReviewKey] = useState(""), [reviewItemId, setReviewItemId] = useState("");
  const [reviewRequest, setReviewRequest] = useState<{
    idempotencyKey: string; sourceId: string; externalProjectId: string; projectAlphaPublicId: string;
  } | null>(null);
  const [reserveKey, setReserveKey] = useState(""), [reservationId, setReservationId] = useState("");
  const [commandId, setCommandId] = useState("");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  const frozen = Boolean(reviewRequest || reviewKey || reviewItemId || reserveKey || reservationId || commandId);
  useEffect(() => {
    if (!frozen && sources.length && !sources.some(source => source.sourceId === sourceId)) setSourceId(sources[0]!.sourceId);
  }, [frozen, sources, sourceId]);
  const discover = async (cursor?: string) => {
    if (busy || disabled || frozen) return;
    const requestedSource = sourceId;
    setBusy(true); setError(""); setMessage("");
    if (!cursor) { setProjects([]); setSelected(""); setNextCursor(null); }
    try {
      const response = await api<{ outcome?: { status?: string; projects?: ProjectAdoptionCandidate[]; nextCursor?: string | null } }>(
        `${PROJECT_ADOPTION_CANDIDATES_ENDPOINT}?sourceId=${encodeURIComponent(requestedSource)}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (response.outcome?.status !== "observed" || !Array.isArray(response.outcome.projects))
        throw new Error("Candidate discovery was not authorized or could not be verified.");
      if (sourceId !== requestedSource) return;
      setProjects(current => cursor ? [...current, ...response.outcome!.projects!] : response.outcome!.projects!);
      setNextCursor(response.outcome.nextCursor ?? null);
      setMessage(response.outcome.projects.length ? "Select one Project for deliberate review." : "No authorized unbound Projects were found.");
    } catch (caught) { setError(operatorError(caught, "Project adoption discovery is unavailable.")); }
    finally { setBusy(false); }
  };
  const review = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const exact = externalId.trim();
    if (!PA_PUBLIC_ID.test(selected) || !exact || exact !== externalId || exact.length > 191 || /\p{C}/u.test(exact)) {
      setError("Select a candidate and enter a new, unused Operations Project ID."); return;
    }
    if (!reviewKey && !window.confirm("Create short-lived review evidence for this exact PA Project and Operations destination? This does not bind, grant access, or publish a portal.")) return;
    const request = reviewRequest ?? { idempotencyKey: crypto.randomUUID(), sourceId,
      externalProjectId: exact, projectAlphaPublicId: selected };
    const idempotencyKey = request.idempotencyKey;
    if (!reviewRequest) { setReviewRequest(request); setReviewKey(idempotencyKey); }
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await api<{ outcome?: { status?: string; reviewItemId?: string } }>(PROJECT_ADOPTION_REVIEW_ENDPOINT, {
        method: "POST", headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ sourceId: request.sourceId, externalProjectId: request.externalProjectId,
          projectAlphaPublicId: request.projectAlphaPublicId }),
      });
      if (response.outcome?.status !== "reviewed" || !response.outcome.reviewItemId) {
        setError(response.outcome?.status === "uncertain"
          ? "Project adoption review outcome is uncertain. The same frozen request key is retained; retry only after operator review."
          : `Project adoption review was not completed (${response.outcome?.status ?? "invalid response"}). Reset only after reviewing server state.`);
        return;
      }
      setReviewItemId(response.outcome.reviewItemId);
      setMessage(`Review evidence created: ${response.outcome.reviewItemId}. Reservation remains a separate action.`);
    } catch (caught) { setError(`${operatorError(caught, "Project adoption review outcome is uncertain.")} The same frozen request key is retained; retry only after operator review.`); }
    finally { setBusy(false); }
  };
  const reserve = async () => {
    if (!reviewItemId || busy || reservationId) return;
    if (!reserveKey && !window.confirm("Reserve this exact reviewed adoption intent? This still does not bind, grant client access, or publish a portal.")) return;
    const idempotencyKey = reserveKey || crypto.randomUUID();
    if (!reserveKey) setReserveKey(idempotencyKey);
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await api<{ status?: string; reservationId?: string }>(
        "/api/admin/project-alpha/private/projects/adoption/reserve", {
          method: "POST", headers: { "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({ reviewItemId, idempotencyKey }),
        });
      if (response.status !== "reserved" || !response.reservationId) {
        setError(response.status === "uncertain"
          ? "Project adoption reservation outcome is uncertain. The review ID and frozen reservation key are retained; retry only after operator review."
          : `Project adoption reservation was not completed (${response.status ?? "invalid response"}). Reset only after reviewing server state.`);
        return;
      }
      setReservationId(response.reservationId);
      setMessage(`Reservation created: ${response.reservationId}. Binding remains a separate action.`);
    } catch (caught) { setError(`${operatorError(caught, "Project adoption reservation outcome is uncertain.")} The review ID and frozen reservation key are retained; retry only after operator review.`); }
    finally { setBusy(false); }
  };
  const bind = async () => {
    if (!reservationId || busy || commandId) return;
    if (!window.confirm("Create the native Operations Project and enqueue the exact PA binding command? This does not acknowledge remote completion, grant client access, or publish a portal.")) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await api<{ status?: string; commandId?: string; replayed?: boolean }>(
        "/api/admin/project-alpha/private/projects/adoption/bind", {
          method: "POST", headers: { "Idempotency-Key": reservationId }, body: JSON.stringify({ reservationId }),
        });
      if (response.status !== "planned" || !response.commandId) {
        setError(response.status === "uncertain"
          ? "Project adoption bind outcome is uncertain. The reservation ID is retained; retry only after checking local command state."
          : `Project adoption bind was not planned (${response.status ?? "invalid response"}). Reset only after reviewing server state.`);
        return;
      }
      setCommandId(response.commandId);
      setMessage(`Bind command queued locally: ${response.commandId}. Project Alpha acknowledgement is not yet confirmed.`);
    } catch (caught) { setError(`${operatorError(caught, "Project adoption bind outcome is uncertain.")} The reservation ID is retained; retry only after checking local command state.`); }
    finally { setBusy(false); }
  };
  const reset = () => {
    if (busy || !window.confirm("Clear this local operator flow? Server-side review, reservation, or queued command records are retained.")) return;
    setProjects([]); setNextCursor(null); setSelected(""); setExternalId(""); setReviewRequest(null); setReviewKey(""); setReviewItemId("");
    setReserveKey(""); setReservationId(""); setCommandId(""); setMessage(""); setError("");
  };
  return <section className="alpha-connection" aria-label="PA-created Project adoption review">
    <h3>Review an unbound Project</h3>
    <p>Discovery is read-only and authority-filtered. Review does not bind the Project, grant client access, or publish it to a portal.</p>
    <label htmlFor="project-adoption-source">Project Alpha source</label>
    <select id="project-adoption-source" value={sourceId} disabled={busy || disabled || frozen}
      onChange={event => { setSourceId(event.target.value); setProjects([]); setSelected(""); setNextCursor(null); setMessage(""); setError(""); }}>
      {sources.map(source => <option key={source.sourceId} value={source.sourceId}>{source.displayName}</option>)}
    </select>
    <button type="button" className="button-ghost button-small" disabled={busy || disabled || frozen || !sources.length}
      onClick={() => void discover()}>{busy ? "Checking…" : "Find authorized unbound Projects"}</button>
    {nextCursor && <button type="button" className="button-ghost button-small" disabled={busy || disabled || frozen}
      onClick={() => void discover(nextCursor)}>{busy ? "Loading…" : "Load next 50 Projects"}</button>}
    {projects.length > 0 && <form onSubmit={review} aria-busy={busy}>
      <fieldset><legend>Select one exact PA Project</legend>{projects.map(project => <label key={project.publicId}>
        <input type="radio" name="project-adoption-candidate" value={project.publicId} checked={selected === project.publicId}
          disabled={busy || disabled || frozen} onChange={() => { setSelected(project.publicId); setMessage(""); setError(""); }} />
        {project.name} · revision {project.revision} · {project.publicId}
      </label>)}</fieldset>
      <label htmlFor="project-adoption-external-id">New, unused Operations Project ID</label>
      <input id="project-adoption-external-id" value={externalId} maxLength={191} disabled={busy || disabled || frozen}
        autoCapitalize="none" autoCorrect="off" spellCheck={false}
        onChange={event => { setExternalId(event.target.value); setMessage(""); setError(""); }} />
      <button type="submit" disabled={busy || disabled || !selected || Boolean(reviewItemId)}>{reviewKey && !reviewItemId ? "Retry frozen review request" : "Create review evidence only"}</button>
    </form>}
    {reviewItemId && !reservationId && <button type="button" disabled={busy || disabled}
      onClick={() => void reserve()}>{reserveKey ? "Retry frozen reservation request" : "Reserve reviewed intent"}</button>}
    {reservationId && !commandId && <button type="button" disabled={busy || disabled}
      onClick={() => void bind()}>Create local bind plan and queue command</button>}
    {frozen && <button type="button" className="button-ghost button-small" disabled={busy}
      onClick={reset}>Reset local flow</button>}
    <p><small>No step in this panel grants client access or publishes the Project to a portal. A planned bind is only a locally queued command, not a Project Alpha acknowledgement.</small></p>
    {message && <p role="status" className="notice">{message}</p>}{error && <p role="alert" className="notice">{error}</p>}
  </section>;
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
    {error && <p role="alert" className="notice">{error}</p>}{message && <p role="status" className="notice">{message}</p>}{!data && !error && <p role="status">Loading connections…</p>}
    <button type="button" className="button-ghost button-small" disabled={loading || Boolean(syncing)} onClick={refresh}>Refresh connection status</button>
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
        <div className="alpha-connection-actions"><button type="button" disabled={loading || Boolean(syncing) || connector.state !== "active"} onClick={() => void sync(connector)}>{syncing === connector.sourceId ? "Synchronizing…" : "Sync now"}</button></div>
        <details><summary>Connection details</summary><dl><dt>Source</dt><dd>{connector.sourceId}</dd><dt>Producer</dt><dd>{connector.producerBindingId}</dd><dt>Destination</dt><dd>{connector.snapshotOrigin}{connector.snapshotBasePath}</dd><dt>Application</dt><dd>{connector.applicationKey}</dd><dt>Revision</dt><dd>{connector.activeRevision}</dd></dl><p>These values are read-only here. Change the reviewed deployment source manifest and deploy Operations; do not paste credentials into this page.</p></details>
      </section>;
    })}
    <ApiV2OperatorPanel disabled={loading || Boolean(syncing)} />
    {data && <ProjectAdoptionPanel connectors={data.connectors} disabled={loading || Boolean(syncing)} />}
    {data?.portal?.recovery && <div className="notice" role="status"><p>A prior portal coordination operation is unfinished. Recovery cancels that uncertain update and pauses affected client portals; it never registers a source or retries activation.</p><button type="button" disabled={loading || Boolean(syncing)} onClick={() => void recoverPortalUpdate()}>Recover unfinished portal update</button></div>}
  </div></Card>;
}
