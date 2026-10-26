import type { ViewerPublicShareSummary } from "@ltds/shared";
import { Dialog, EmptyState, StatusPill } from "@ltds/ui";
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, ApiError } from "./api";

/** Count and update time are optional until the Viewer catalog source provides them. */
export type ViewerCatalogProject = { viewerProjectId: string; name: string; publishedTaskCount?: number | null; updatedAt?: string | null };
export type ViewerCatalogTask = { taskId: string; title: string; publishedAt: string; modelId: string | null };
type ProjectPage = { projects: ViewerCatalogProject[]; nextCursor: string | null };
type TaskPage = { project: { viewerProjectId: string; name: string }; tasks: ViewerCatalogTask[]; nextCursor: string | null };
export type DirectShareClient = { sourceId: string; workspaceId: string; displayName: string; businessName: string };
export type DirectShareGrant = {
  grantId: string; sourceId: string; workspaceId: string; viewerProjectId: string; taskId: string | null;
  scopeType: "project" | "task"; includeFuturePublished: boolean;
  permissions: { measure: boolean; cameras: boolean; download: boolean };
  expiresAt: string | null; revokedAt: string | null; createdAt: string; clientDisplayName: string | null;
};
type GrantWorkspace = { clients: DirectShareClient[]; clientsNextCursor: string | null; grants: DirectShareGrant[] };
/** What is being shared: a whole Viewer project (and its future published models) or one published task. */
export type ViewerShareTarget = { project: { viewerProjectId: string; name: string }; task: ViewerCatalogTask | null };

const opaque = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
// Cursors are opaque to the page and always sent URL-encoded.
const cursorOf = (value: unknown) => value === null || (typeof value === "string" && value.length > 0 && value.length <= 2048);

export function validViewerCatalogProjects(value: unknown): value is ProjectPage {
  return isRecord(value) && Array.isArray(value.projects) && cursorOf(value.nextCursor) && value.projects.every(project =>
    isRecord(project) && typeof project.viewerProjectId === "string" && opaque.test(project.viewerProjectId)
    && typeof project.name === "string"
    && (project.publishedTaskCount == null || (Number.isSafeInteger(project.publishedTaskCount) && (project.publishedTaskCount as number) >= 0))
    && (project.updatedAt == null || typeof project.updatedAt === "string"));
}

export function validViewerCatalogTasks(value: unknown, viewerProjectId: string): value is TaskPage {
  return isRecord(value) && isRecord(value.project) && value.project.viewerProjectId === viewerProjectId
    && typeof value.project.name === "string" && Array.isArray(value.tasks) && cursorOf(value.nextCursor)
    && value.tasks.every(task => isRecord(task) && typeof task.taskId === "string" && opaque.test(task.taskId)
      && typeof task.title === "string" && typeof task.publishedAt === "string"
      && (task.modelId === null || (typeof task.modelId === "string" && task.modelId.length > 0)));
}

function validGrantWorkspace(value: unknown): value is GrantWorkspace {
  return isRecord(value) && Array.isArray(value.clients) && Array.isArray(value.grants)
    && value.clients.every(client => isRecord(client) && typeof client.sourceId === "string" && typeof client.workspaceId === "string"
      && typeof client.displayName === "string" && typeof client.businessName === "string")
    && value.grants.every(grant => isRecord(grant) && typeof grant.grantId === "string" && typeof grant.workspaceId === "string"
      && isRecord(grant.permissions));
}

/** Grants that already cover this exact target: the project grant, or a grant for the same task. */
export function grantsForTarget(grants: DirectShareGrant[], target: ViewerShareTarget): DirectShareGrant[] {
  return grants.filter(grant => !grant.revokedAt && grant.viewerProjectId === target.project.viewerProjectId
    && (grant.scopeType === "project" || (target.task !== null && grant.taskId === target.task.taskId)));
}

/**
 * The exact grant body. A whole-project share also covers models published later, so it
 * needs the separate, reviewed opt-in; without it there is no project share to send.
 */
export function directShareBody(target: ViewerShareTarget, client: DirectShareClient,
  permissions: DirectShareGrant["permissions"], expiresAt: string | null, includeFuturePublished: boolean) {
  if (!target.task && !includeFuturePublished) throw new Error("A whole-project share needs the future-models opt-in");
  return {
    sourceId: client.sourceId, workspaceId: client.workspaceId, viewerProjectId: target.project.viewerProjectId,
    taskId: target.task?.taskId ?? null, scopeType: target.task ? "task" : "project", includeFuturePublished: !target.task && includeFuturePublished,
    confirmedScope: true, expiresAt, permissions,
  };
}

/** The end of a calendar day (YYYY-MM-DD) in America/Chicago, as an ISO instant. */
export function chicagoEndOfDay(day: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59);
  const parts = (instant: number) => Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant).map(part => [part.type, part.value]));
  const offset = (instant: number) => {
    const p = parts(instant);
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - instant;
  };
  // Two passes settle the offset on either side of a daylight-saving change.
  let instant = wall - offset(wall);
  instant = wall - offset(instant);
  return new Date(instant).toISOString();
}

export function chicagoDate(value: string | null): string {
  if (!value) return "Never expires";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value
    : parsed.toLocaleDateString("en-US", { timeZone: "America/Chicago", dateStyle: "medium" });
}

const statusOf = (caught: unknown) => caught instanceof ApiError ? caught.status : 0;
/** No answer, or a server failure, may already have been applied. */
const uncertain = (caught: unknown) => { const status = statusOf(caught); return !status || status >= 500; };
const SHARING_OFF = "Quick share isn't available yet. You can still share from the Viewer workspace.";

/** Search Viewer projects, pick a published model (or the whole project), then share it. */
export function ViewerQuickShare({ canCreatePublic, canRevokePublic }: { canCreatePublic: boolean; canRevokePublic: boolean }) {
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<ProjectPage | null>(null);
  const [projectError, setProjectError] = useState("");
  const [off, setOff] = useState(false);
  const [project, setProject] = useState<ViewerCatalogProject | null>(null);
  const [tasks, setTasks] = useState<TaskPage | null>(null);
  const [taskError, setTaskError] = useState("");
  const [target, setTarget] = useState<ViewerShareTarget | null>(null);
  const projectRun = useRef(0), taskRun = useRef(0);

  const loadProjects = useCallback(async (q: string, cursor: string | null) => {
    const run = ++projectRun.current;
    setProjectError("");
    try {
      const params = new URLSearchParams({ limit: "25" });
      if (q.trim()) params.set("q", q.trim());
      if (cursor) params.set("cursor", cursor);
      const value = await api<unknown>(`/api/viewer/direct-share-catalog?${params}`);
      if (run !== projectRun.current) return;
      if (!validViewerCatalogProjects(value)) throw new Error("invalid_response");
      setProjects(current => cursor && current ? { projects: [...current.projects, ...value.projects], nextCursor: value.nextCursor } : value);
    } catch (caught) {
      if (run !== projectRun.current) return;
      if (!cursor) setProjects(null);
      if (statusOf(caught) === 404) { setOff(true); return; }
      setProjectError(statusOf(caught) === 403 ? "You don't have permission to share Viewer models." : "Viewer projects couldn't be loaded. Try again.");
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadProjects(query, null), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query, loadProjects]);
  useEffect(() => () => { projectRun.current += 1; taskRun.current += 1; }, []);
  // A new search drops the previous one at once, so a late answer can't replace or outlive it.
  const changeQuery = (value: string) => { projectRun.current += 1; setProjects(null); setProjectError(""); setQuery(value); };

  const loadTasks = useCallback(async (selected: ViewerCatalogProject, cursor: string | null) => {
    const run = ++taskRun.current;
    setTaskError("");
    try {
      const value = await api<unknown>(`/api/viewer/direct-share-catalog/${encodeURIComponent(selected.viewerProjectId)}/tasks${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (run !== taskRun.current) return;
      if (!validViewerCatalogTasks(value, selected.viewerProjectId)) throw new Error("invalid_response");
      setTasks(current => cursor && current ? { ...value, tasks: [...current.tasks, ...value.tasks] } : value);
    } catch (caught) {
      if (run !== taskRun.current) return;
      if (!cursor) setTasks(null);
      setTaskError(statusOf(caught) === 404 ? "This project is no longer available in the Viewer." : "Published models couldn't be loaded. Try again.");
    }
  }, []);
  const choose = (selected: ViewerCatalogProject) => { setProject(selected); setTasks(null); void loadTasks(selected, null); };
  const back = () => { taskRun.current += 1; setProject(null); setTasks(null); setTaskError(""); };

  if (off) return <section className="viewer-quick-share" aria-labelledby="viewer-quick-share-heading">
    <h3 id="viewer-quick-share-heading">Quick share</h3><p className="notice" role="status">{SHARING_OFF}</p>
  </section>;
  return <section className="viewer-quick-share" aria-labelledby="viewer-quick-share-heading">
    <header><h3 id="viewer-quick-share-heading">Quick share</h3><p>Pick a Viewer project, choose a published model, and share it with a client or by link.</p></header>
    {!project ? <>
      <label className="viewer-quick-share-search">Search Viewer projects
        <input type="search" value={query} onChange={event => changeQuery(event.target.value)} placeholder="Project name" maxLength={120} /></label>
      {projectError && <div className="notice error" role="alert">{projectError} <button type="button" className="button-ghost button-small" onClick={() => void loadProjects(query, null)}>Retry</button></div>}
      {!projects && !projectError && <p className="viewer-quick-share-loading" role="status">Loading projects…</p>}
      {projects && (projects.projects.length ? <ul className="viewer-quick-share-list" aria-label="Viewer projects">{projects.projects.map(item =>
        <li key={item.viewerProjectId}><button type="button" onClick={() => choose(item)}>
          <strong>{item.name}</strong>{item.publishedTaskCount != null && <small>{item.publishedTaskCount} published model{item.publishedTaskCount === 1 ? "" : "s"}</small>}
        </button></li>)}</ul>
        : <EmptyState title={query.trim() ? "No matching projects" : "No Viewer projects yet"} detail={query.trim() ? "Try a different name." : "Projects created in the Viewer workspace appear here."} />)}
      {projects?.nextCursor && <button type="button" className="button-ghost button-small" onClick={() => void loadProjects(query, projects.nextCursor)}>Show more projects</button>}
    </> : <>
      <div className="viewer-quick-share-crumb"><button type="button" className="button-ghost button-small" onClick={back}>All projects</button><strong>{project.name}</strong></div>
      {taskError && <div className="notice error" role="alert">{taskError} <button type="button" className="button-ghost button-small" onClick={() => void loadTasks(project, null)}>Retry</button></div>}
      {!tasks && !taskError && <p className="viewer-quick-share-loading" role="status">Loading published models…</p>}
      {tasks && <ul className="viewer-quick-share-list" aria-label={`Published models in ${tasks.project.name}`}>
        <li><button type="button" onClick={() => setTarget({ project: tasks.project, task: null })}>
          <strong>Whole project</strong><small>Every published model, plus any published later</small></button></li>
        {tasks.tasks.map(task => <li key={task.taskId}><button type="button" onClick={() => setTarget({ project: tasks.project, task })}>
          <strong>{task.title}</strong><small>Published {chicagoDate(task.publishedAt)}</small></button></li>)}
      </ul>}
      {tasks && !tasks.tasks.length && <p className="viewer-quick-share-empty">No published models yet.</p>}
      {tasks?.nextCursor && <button type="button" className="button-ghost button-small" onClick={() => void loadTasks(project, tasks.nextCursor)}>Show more models</button>}
    </>}
    {target && <ViewerShareDialog target={target} onClose={() => setTarget(null)} canCreatePublic={canCreatePublic}
      canRevokePublic={canRevokePublic} />}
  </section>;
}

type ShareMode = "workspace" | "public";

/** Share one target, with the same Public link / Client Workspace choice as the Data share dialog. */
export function ViewerShareDialog({ target, onClose, canCreatePublic, canRevokePublic }: {
  target: ViewerShareTarget; onClose: () => void; canCreatePublic: boolean; canRevokePublic: boolean;
}) {
  const publicAvailable = !!target.task?.modelId;
  const [mode, setMode] = useState<ShareMode>("workspace");
  const [locked, setLocked] = useState(false);
  const workspaceTab = useRef<HTMLButtonElement>(null), publicTab = useRef<HTMLButtonElement>(null);
  const label = target.task ? target.task.title : `${target.project.name} (whole project)`;
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !publicAvailable) return;
    event.preventDefault();
    const next: ShareMode = event.key === "Home" ? "workspace" : event.key === "End" ? "public" : mode === "workspace" ? "public" : "workspace";
    setMode(next);
    (next === "workspace" ? workspaceTab : publicTab).current?.focus();
  };
  const publicReason = !target.task ? "Public links share one model. Choose a published model to create one."
      : "This model doesn't have a public-link version yet.";
  return <Dialog open onClose={onClose} dismissible={!locked} size="lg" title={`Share ${label}`}
    description={target.task ? `From ${target.project.name}` : "Shares every published model in this project, and models published to it later."}>
    <div className="share-mode-selector ltds-segmented" role="tablist" aria-label="Sharing method">
      <button ref={publicTab} id="viewer-share-tab-public" type="button" role="tab" aria-selected={mode === "public"}
        aria-controls="viewer-share-panel-public" tabIndex={mode === "public" ? 0 : -1} className={mode === "public" ? "active" : "button-ghost"}
        disabled={locked || !publicAvailable} title={!publicAvailable ? publicReason : undefined}
        onClick={() => setMode("public")} onKeyDown={onTabKey}>Public link</button>
      <button ref={workspaceTab} id="viewer-share-tab-workspace" type="button" role="tab" aria-selected={mode === "workspace"}
        aria-controls="viewer-share-panel-workspace" tabIndex={mode === "workspace" ? 0 : -1} className={mode === "workspace" ? "active" : "button-ghost"}
        disabled={locked} onClick={() => setMode("workspace")} onKeyDown={onTabKey}>Client Workspace</button>
    </div>
    {mode === "workspace"
      ? <section id="viewer-share-panel-workspace" className="share-mode-panel" role="tabpanel" aria-labelledby="viewer-share-tab-workspace">
        <header><strong>Client Workspace access</strong>
          <small>Choose a client or organization. They'll see it in their Ledge Top portal after signing in. This does not create a public link.</small></header>
        <DirectClientSharePanel target={target} onBusyChange={setLocked} />
      </section>
      : <section id="viewer-share-panel-public" className="share-mode-panel" role="tabpanel" aria-labelledby="viewer-share-tab-public">
        <p className="share-mode-description">Create a link for anyone who receives the complete URL. Add a password when the model shouldn't be open to everyone holding the link.</p>
        <ViewerPublicLinkPanel modelId={target.task!.modelId!} canCreate={canCreatePublic} canRevoke={canRevokePublic} onBusyChange={setLocked} />
      </section>}
  </Dialog>;
}

const DEFAULT_PERMISSIONS = { measure: true, cameras: true, download: false };

function DirectClientSharePanel({ target, onBusyChange }: { target: ViewerShareTarget; onBusyChange: (busy: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [workspace, setWorkspace] = useState<GrantWorkspace | null>(null);
  const [loadError, setLoadError] = useState("");
  const [blocked, setBlocked] = useState("");
  const [client, setClient] = useState<DirectShareClient | null>(null);
  const [permissions, setPermissions] = useState(DEFAULT_PERMISSIONS);
  const [neverExpires, setNeverExpires] = useState(true);
  const [expiryDay, setExpiryDay] = useState("");
  const [includeFuture, setIncludeFuture] = useState(false);
  const needsFutureOptIn = !target.task && !includeFuture;
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // An unconfirmed share is retried with the identical body and key, and the selection stays locked until it resolves.
  const pending = useRef<{ body: string; key: string; clientName: string } | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const run = useRef(0);
  useEffect(() => { onBusyChange(busy || unconfirmed); }, [busy, unconfirmed, onBusyChange]);

  const load = useCallback(async (q: string) => {
    const current = ++run.current;
    setLoadError("");
    try {
      const params = new URLSearchParams({ viewerProjectId: target.project.viewerProjectId, limit: "25" });
      if (q.trim()) params.set("q", q.trim());
      const value = await api<unknown>(`/api/viewer/direct-client-grants?${params}`);
      if (current !== run.current) return;
      if (!validGrantWorkspace(value)) throw new Error("invalid_response");
      setWorkspace(value);
    } catch (caught) {
      if (current !== run.current) return;
      setWorkspace(null);
      const status = statusOf(caught);
      if (status === 404) setBlocked("Client Workspace sharing isn't turned on yet.");
      else if (status === 403) setBlocked("Administrator access is required to share with clients.");
      else setLoadError("Clients couldn't be loaded. Try again.");
    }
  }, [target.project.viewerProjectId]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(query), query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [query, load]);
  useEffect(() => () => { run.current += 1; }, []);
  const changeQuery = (value: string) => { run.current += 1; setWorkspace(null); setLoadError(""); setQuery(value); };

  const existing = workspace ? grantsForTarget(workspace.grants, target) : [];
  const expiresAt = neverExpires ? null : chicagoEndOfDay(expiryDay);
  const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const pick = (next: DirectShareClient | null) => {
    if (busy || unconfirmed) return;
    setClient(next); setReviewing(false); setIncludeFuture(false); setError(""); setMessage(""); pending.current = null;
  };

  const send = async () => {
    const attempt = pending.current;
    if (!attempt || busy) return;
    setBusy(true); setError("");
    try {
      await api("/api/viewer/direct-client-grants", { method: "POST", headers: { "Idempotency-Key": attempt.key }, body: attempt.body });
      pending.current = null; setUnconfirmed(false); setReviewing(false); setClient(null);
      setPermissions(DEFAULT_PERMISSIONS); setNeverExpires(true); setExpiryDay(""); setIncludeFuture(false);
      setMessage(`Shared with ${attempt.clientName}. They'll see it in their Ledge Top portal.`);
      void load(query);
    } catch (caught) {
      if (uncertain(caught)) {
        setUnconfirmed(true);
        setError("We couldn't confirm the share. Try again to finish it — the same share is sent, so it won't be duplicated.");
      } else {
        pending.current = null; setUnconfirmed(false);
        const code = caught instanceof ApiError ? caught.payload.code : undefined;
        setError(code === "relationship_missing" ? `${(caught as Error).message}. Reload the client list and choose them again.` : (caught as Error).message);
        if (code === "relationship_missing") { setClient(null); setReviewing(false); void load(query); }
      }
    } finally { setBusy(false); }
  };
  const confirm = (event: FormEvent) => {
    event.preventDefault();
    // Try again re-sends the unconfirmed share exactly as it was first sent.
    if (unconfirmed) { void send(); return; }
    if (!client || busy || needsFutureOptIn || (!neverExpires && !expiresAt)) return;
    pending.current = { body: JSON.stringify(directShareBody(target, client, permissions, expiresAt, includeFuture)), key: crypto.randomUUID(), clientName: client.displayName };
    void send();
  };
  const revoke = async (grant: DirectShareGrant) => {
    if (busy || unconfirmed) return;
    if (!window.confirm(`Stop sharing with ${grant.clientDisplayName ?? "this client"}? They'll lose access right away.`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await api(`/api/viewer/direct-client-grants/${encodeURIComponent(grant.grantId)}`, {
        method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ reason: "Revoked by staff" }),
      });
      setMessage(`Stopped sharing with ${grant.clientDisplayName ?? "the client"}.`);
      void load(query);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  if (blocked) return <div className="notice" role="status">{blocked}</div>;
  return <div className="viewer-direct-share">
    {existing.length > 0 && <div className="viewer-direct-share-existing"><strong>Already shared with</strong><ul>{existing.map(grant => <li key={grant.grantId}>
      <div><span>{grant.clientDisplayName ?? "Client"}</span><small>{grant.scopeType === "project" ? "Whole project" : "This model"} · {chicagoDate(grant.expiresAt)}{grant.permissions.download ? " · downloads allowed" : ""}</small></div>
      <button type="button" className="button-danger button-small" disabled={busy || unconfirmed} onClick={() => void revoke(grant)}>Stop sharing</button>
    </li>)}</ul></div>}
    {!client ? <>
      <label>Client or organization<input type="search" value={query} onChange={event => changeQuery(event.target.value)} placeholder="Search clients" maxLength={120} /></label>
      {loadError && <div className="notice error" role="alert">{loadError} <button type="button" className="button-ghost button-small" onClick={() => void load(query)}>Retry</button></div>}
      {!workspace ? !loadError && <p role="status">Loading clients…</p> : workspace.clients.length
        ? <ul className="viewer-direct-share-clients" role="listbox" aria-label="Clients">{workspace.clients.map(item => <li key={`${item.sourceId}/${item.workspaceId}`}>
          <button type="button" role="option" aria-selected={false} onClick={() => pick(item)}><strong>{item.displayName}</strong><small>{item.businessName}</small></button>
        </li>)}</ul>
        : <p>{query.trim() ? "No clients match that name." : "No clients are ready for portal sharing yet."}</p>}
    </> : <form className="viewer-direct-share-form" onSubmit={confirm}>
      <div className="viewer-direct-share-recipient"><div><strong>{client.displayName}</strong><small>{client.businessName}</small></div>
        <button type="button" className="button-ghost button-small" disabled={busy || unconfirmed} onClick={() => pick(null)}>Change</button></div>
      <fieldset disabled={busy || unconfirmed}><legend>They can</legend>
        <label className="viewer-share-check"><input type="checkbox" checked disabled /> View the model</label>
        <label className="viewer-share-check"><input type="checkbox" checked={permissions.measure} onChange={event => setPermissions({ ...permissions, measure: event.target.checked })} /> Take measurements</label>
        <label className="viewer-share-check"><input type="checkbox" checked={permissions.cameras} onChange={event => setPermissions({ ...permissions, cameras: event.target.checked })} /> See camera photos</label>
        <label className="viewer-share-check"><input type="checkbox" checked={permissions.download} onChange={event => setPermissions({ ...permissions, download: event.target.checked })} /> Download files</label>
      </fieldset>
      <fieldset disabled={busy || unconfirmed}><legend>Access ends</legend>
        <label className="viewer-share-check"><input type="checkbox" checked={neverExpires} onChange={event => setNeverExpires(event.target.checked)} /> Never (until you stop sharing)</label>
        {!neverExpires && <label>Last day (Central time)<input type="date" required min={tomorrow} value={expiryDay} onChange={event => setExpiryDay(event.target.value)} /></label>}
      </fieldset>
      {!target.task && <fieldset disabled={busy || unconfirmed} className="viewer-direct-share-future"><legend>Whole project</legend>
        <label className="viewer-share-check"><input type="checkbox" checked={includeFuture} onChange={event => { setIncludeFuture(event.target.checked); setReviewing(false); }} /> Also share every model published to this project later</label>
        <small>A whole-project share always includes future models. To share only what's published now, go back and choose a single model.</small>
      </fieldset>}
      {!reviewing ? <button type="button" className="button-orange" disabled={needsFutureOptIn || (!neverExpires && !expiresAt)} onClick={() => setReviewing(true)}>Review share</button>
        : <section className="viewer-direct-share-review" aria-label="Review share">
          <p>Share <strong>{target.task ? target.task.title : `all of ${target.project.name}`}</strong> with <strong>{client.displayName}</strong>
            {target.task ? "" : ", including every model published to it later"}. Access {expiresAt ? `ends ${chicagoDate(expiresAt)}` : "doesn't expire"}.</p>
          <div className="actions">
            <button type="submit" className="button-orange" disabled={busy}>{busy ? "Sharing…" : unconfirmed ? "Try again" : "Share"}</button>
            {!unconfirmed && <button type="button" className="button-ghost" disabled={busy} onClick={() => setReviewing(false)}>Back</button>}
          </div>
        </section>}
    </form>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <div className="notice success" role="status">{message}</div>}
  </div>;
}

function shareExpiryValue(days = 7): string {
  const value = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  value.setSeconds(0, 0);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** Public bearer links for one Viewer model, through the existing model share routes. */
export function ViewerPublicLinkPanel({ modelId, canCreate, canRevoke, onBusyChange }: {
  modelId: string; canCreate: boolean; canRevoke: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const [shares, setShares] = useState<ViewerPublicShareSummary[] | null>(null);
  const [off, setOff] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState(() => shareExpiryValue());
  const [neverExpires, setNeverExpires] = useState(false);
  const [password, setPassword] = useState("");
  const [download, setDownload] = useState(false);
  const [units, setUnits] = useState<"imperial" | "metric">("imperial");
  const [createdUrl, setCreatedUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // An unconfirmed link is retried with the identical body and key, so it can't be created twice.
  const pending = useRef<{ body: string; key: string } | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  useEffect(() => { onBusyChange(busy || unconfirmed); }, [busy, unconfirmed, onBusyChange]);
  const path = `/api/viewer/models/${encodeURIComponent(modelId)}/shares`;
  const load = useCallback(async () => {
    setLoadError("");
    try { setShares((await api<{ shares: ViewerPublicShareSummary[] }>(path)).shares); }
    catch (caught) {
      if (statusOf(caught) === 404) setOff(true); else setLoadError("Existing links couldn't be loaded.");
    }
  }, [path]);
  useEffect(() => { void load(); }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!unconfirmed) {
      if (!neverExpires && !expiry) return;
      if (neverExpires && !window.confirm("Create a link that never expires? It stays active until you revoke it.")) return;
      pending.current = { key: crypto.randomUUID(), body: JSON.stringify({
        label: label.trim() || null, expiresAt: neverExpires ? null : new Date(expiry).toISOString(), displayUnits: units,
        ...(password ? { password } : {}), permissions: { view: true, measure: true, cameras: true, download },
      }) };
    }
    const attempt = pending.current;
    if (!attempt) return;
    setBusy(true); setError(""); setMessage(""); setCreatedUrl("");
    try {
      const created = await api<{ share: ViewerPublicShareSummary; viewUrl: string }>(path, {
        method: "POST", headers: { "Idempotency-Key": attempt.key }, body: attempt.body,
      });
      pending.current = null; setUnconfirmed(false);
      setShares(current => [created.share, ...(current ?? []).filter(share => share.id !== created.share.id)]);
      setCreatedUrl(created.viewUrl); setPassword("");
      setMessage("Link created. Copy it now — it can't be shown again.");
    } catch (caught) {
      if (uncertain(caught)) {
        setUnconfirmed(true);
        setError("We couldn't confirm the link was created. Try again to finish it — the same link is requested, so it won't be duplicated.");
      } else { pending.current = null; setUnconfirmed(false); setError((caught as Error).message); }
    } finally { setBusy(false); }
  };
  const revoke = async (share: ViewerPublicShareSummary) => {
    if (busy || unconfirmed || !window.confirm(`Revoke ${share.label || "this link"}? Anyone using it loses access right away.`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const value = await api<{ share: ViewerPublicShareSummary }>(`/api/viewer/shares/${encodeURIComponent(share.id)}`, {
        method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ reason: "Revoked by Operations staff" }),
      });
      setShares(current => (current ?? []).map(item => item.id === value.share.id ? value.share : item));
      setMessage("Link revoked.");
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  if (off) return <p className="notice" role="status">Public Viewer links aren't turned on.</p>;
  const active = (shares ?? []).filter(share => !share.revokedAt && !(share.expiresAt && Date.parse(share.expiresAt) <= Date.now()));
  return <div className="viewer-public-link">
    {loadError && <div className="notice error" role="alert">{loadError} <button type="button" className="button-ghost button-small" onClick={() => void load()}>Retry</button></div>}
    {active.length > 0 && <div className="viewer-direct-share-existing"><strong>Active links</strong><ul>{active.map(share => <li key={share.id}>
      <div><span>{share.label || "Unlabeled link"}</span><small>{share.hasPassword ? "Password protected" : "No password"} · {share.expiresAt ? `expires ${chicagoDate(share.expiresAt)}` : "never expires"} · {share.accessCount} open{share.accessCount === 1 ? "" : "s"}</small></div>
      {canRevoke && <button type="button" className="button-danger button-small" disabled={busy || unconfirmed} onClick={() => void revoke(share)}>Revoke</button>}
    </li>)}</ul></div>}
    {canCreate ? <form className="viewer-share-form" onSubmit={create}>
      <fieldset className="viewer-share-fields" disabled={busy || unconfirmed}>
      <label>Label (optional)<input maxLength={120} value={label} onChange={event => setLabel(event.target.value)} placeholder="Client review or demo" /></label>
      <label>Expires<input type="datetime-local" required={!neverExpires} disabled={neverExpires} value={expiry} min={shareExpiryValue(5 / 1440)} max={shareExpiryValue(30)} onChange={event => setExpiry(event.target.value)} /></label>
      <label className="viewer-share-check"><input type="checkbox" checked={neverExpires} onChange={event => setNeverExpires(event.target.checked)} /> Never expires</label>
      <label>Password (optional)<input type="password" minLength={8} maxLength={128} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 8 characters" /></label>
      <label>Measurement units<select value={units} onChange={event => setUnits(event.target.value as "imperial" | "metric")}><option value="imperial">Imperial</option><option value="metric">Metric</option></select></label>
      <label className="viewer-share-check"><input type="checkbox" checked={download} onChange={event => setDownload(event.target.checked)} /> Allow model download</label>
      </fieldset>
      <button type="submit" className="button-orange" disabled={busy || (!unconfirmed && !neverExpires && !expiry)}>{busy ? "Creating…" : unconfirmed ? "Try again" : "Create link"}</button>
    </form> : <p className="notice" role="status">You don't have permission to create public links.</p>}
    {createdUrl && <div className="viewer-created-share" role="status">
      <label>New link<input readOnly value={createdUrl} onFocus={event => event.currentTarget.select()} /></label>
      <button type="button" className="button-orange button-small" onClick={() => void navigator.clipboard.writeText(createdUrl).then(() => setMessage("Link copied."), () => setMessage("Select and copy the link manually."))}>Copy link</button>
    </div>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <div className="notice" role="status">{message}</div>}
    {shares && !active.length && !createdUrl && <StatusPill>No active links</StatusPill>}
  </div>;
}
