import type { ViewerProjectSelection, ViewerPublicShareSummary } from "@ltds/shared";
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
  permissions: { measure: boolean; cameras: boolean; download: boolean; report?: boolean };
  expiresAt: string | null; revokedAt: string | null; createdAt: string; clientDisplayName: string | null;
  selection?: ViewerProjectSelection;
};
type GrantWorkspace = { clients: DirectShareClient[]; clientsNextCursor: string | null; grants: DirectShareGrant[];
  grantsNextCursor?: string | null; grantsIncomplete?: boolean;
  /** Operations can keep a share's model report choice. */
  modelReport?: true };
/** Quick share sends only published tasks. A null task is refused before sending. */
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

/** Search-first: nothing is listed until at least this many characters are typed. */
export const QUICK_SHARE_MIN_QUERY = 2;
/** At most this many matches are shown; staff keep typing to narrow the list. */
export const QUICK_SHARE_RESULT_LIMIT = 10;
export const searchReady = (q: string) => q.trim().length >= QUICK_SHARE_MIN_QUERY;

/** The project search request, or null while the text is too short to search. */
export function projectSearchPath(q: string): string | null {
  if (!searchReady(q)) return null;
  return `/api/viewer/direct-share-catalog?${new URLSearchParams({ limit: String(QUICK_SHARE_RESULT_LIMIT), q: q.trim() })}`;
}

/** The client search request (clients only, never the grant list), or null while the text is too short. */
export function clientSearchPath(viewerProjectId: string, q: string): string | null {
  if (!searchReady(q)) return null;
  return `/api/viewer/direct-client-grants?${new URLSearchParams({ viewerProjectId, limit: String(QUICK_SHARE_RESULT_LIMIT), include: "clients", q: q.trim() })}`;
}

/** One page of matching clients, bounded to the result limit. */
export async function searchDirectShareClients(fetchJson: (path: string) => Promise<unknown>, viewerProjectId: string, q: string)
  : Promise<{ clients: DirectShareClient[]; more: boolean } | null> {
  const path = clientSearchPath(viewerProjectId, q);
  if (!path) return null;
  const value = await fetchJson(path);
  if (!validGrantWorkspace(value)) throw new Error("invalid_response");
  return { clients: value.clients.slice(0, QUICK_SHARE_RESULT_LIMIT), more: !!value.clientsNextCursor || value.clients.length > QUICK_SHARE_RESULT_LIMIT };
}

/** Arrow, Home and End keys over a result list; null when the key does not move the selection. */
export function nextActiveOption(active: number, key: string, count: number): number | null {
  if (!count) return null;
  if (key === "ArrowDown") return active < 0 ? 0 : Math.min(count - 1, active + 1);
  if (key === "ArrowUp") return active < 0 ? count - 1 : Math.max(0, active - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export const DIRECT_SHARE_GRANT_PAGE_LIMIT = 50;
/** Loads every page of this project's grants (the server pages grants 100 at a time), and no clients:
 * clients are only listed by a typed search. If the page limit is reached the result says so. */
export async function loadDirectShareWorkspace(fetchJson: (path: string) => Promise<unknown>, viewerProjectId: string)
  : Promise<GrantWorkspace> {
  const first = await fetchJson(`/api/viewer/direct-client-grants?${new URLSearchParams({ viewerProjectId, include: "grants" })}`);
  if (!validGrantWorkspace(first)) throw new Error("invalid_response");
  const grants = [...first.grants];
  let cursor = typeof first.grantsNextCursor === "string" ? first.grantsNextCursor : null, pages = 1;
  while (cursor && pages < DIRECT_SHARE_GRANT_PAGE_LIMIT) {
    const page = await fetchJson(`/api/viewer/direct-client-grants?${new URLSearchParams({ viewerProjectId, include: "grants", grantsCursor: cursor })}`);
    if (!validGrantWorkspace(page)) throw new Error("invalid_response");
    grants.push(...page.grants); cursor = typeof page.grantsNextCursor === "string" ? page.grantsNextCursor : null; pages++;
  }
  const { modelReport: _modelReport, ...rest } = first;
  return { ...rest, ...(first.modelReport === true ? { modelReport: true as const } : {}), grants, grantsNextCursor: cursor, grantsIncomplete: !!cursor };
}

/** Confirmed coverage only. The catalog has no folder ancestry to resolve saved project selections. */
export function grantsForTarget(grants: DirectShareGrant[], target: ViewerShareTarget): DirectShareGrant[] {
  return grants.filter(grant => !grant.revokedAt && grant.viewerProjectId === target.project.viewerProjectId
    && (grant.scopeType === "project" ? grant.selection === undefined
      : target.task !== null && grant.taskId === target.task.taskId));
}

/** The exact task grant body. Whole-project sharing belongs in Viewer. Quick share has no Model report box:
 * once Operations can keep that choice, a new share leaves the report off (staff turn it on in the Viewer). */
export function directShareBody(target: ViewerShareTarget, client: DirectShareClient,
  permissions: DirectShareGrant["permissions"], expiresAt: string | null, modelReport = false) {
  if (!target.task) throw new Error("Share whole projects from the Viewer");
  return {
    sourceId: client.sourceId, workspaceId: client.workspaceId, viewerProjectId: target.project.viewerProjectId,
    taskId: target.task.taskId, scopeType: "task", includeFuturePublished: false,
    confirmedScope: true, expiresAt, permissions: modelReport ? { ...permissions, report: false } : permissions,
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

/** Today's calendar day in America/Chicago (YYYY-MM-DD): the earliest last day a share can have. */
export function chicagoToday(now = Date.now()): string {
  return new Date(now).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

/** The end of that Chicago day, only while it is still in the future; a day that has already ended gives null. */
export function futureChicagoEndOfDay(day: string, now = Date.now()): string | null {
  const end = chicagoEndOfDay(day);
  return end !== null && Date.parse(end) > now ? end : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const previousDay = (day: string) => {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! - 1)).toISOString().slice(0, 10);
};

/** Public links must end at least five minutes and at most 30 days ahead: the Central-time last days that fit. */
export function publicLinkDayRange(now = Date.now()): { min: string; max: string } {
  let min = chicagoToday(now);
  if (Date.parse(chicagoEndOfDay(min)!) < now + 5 * 60 * 1000) min = chicagoToday(now + DAY_MS);
  let max = chicagoToday(now + 30 * DAY_MS);
  while (Date.parse(chicagoEndOfDay(max)!) > now + 30 * DAY_MS) max = previousDay(max);
  return { min, max };
}

/** A new public link starts on the latest last day allowed: 30 days out. Staff can shorten it or choose no end. */
export const defaultPublicLinkDay = (now = Date.now()) => publicLinkDayRange(now).max;

/** The end of a public link's last Central-time day, only while it is within the allowed range. */
export function publicLinkExpiry(day: string, now = Date.now()): string | null {
  const { min, max } = publicLinkDayRange(now);
  return day >= min && day <= max ? chicagoEndOfDay(day) : null;
}

/** A plain sentence naming what the client can do, from the chosen options. */
export function permissionSentence(permissions: DirectShareGrant["permissions"]): string {
  const abilities = ["view the model", permissions.measure && "take measurements", permissions.cameras && "see camera photos",
    permissions.download && "download files"].filter((item): item is string => !!item);
  const list = abilities.length > 1 ? `${abilities.slice(0, -1).join(", ")}${abilities.length > 2 ? "," : ""} and ${abilities.at(-1)}` : abilities[0];
  return `They can ${list}.`;
}

/** The business line under a client: hidden when every client comes through the same business. */
export function businessLabel(businessName: string, businessCount: number): string | null {
  if (businessCount < 2) return null;
  return `via ${/^ledge top\b/i.test(businessName) ? businessName : `Ledge Top ${businessName}`}`;
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
const SHARE_UNCONFIRMED = "We couldn't confirm the share. Try again to finish it — the same share is sent, so it won't be duplicated.";
const LINK_UNCONFIRMED = "We couldn't confirm the link was created. Try again to finish it — the same link is requested, so it won't be duplicated.";
/**
 * The Viewer keeps a request's idempotency receipt for 24 hours, then forgets it. Past this shorter window an
 * unconfirmed attempt is never re-sent: a resend after the receipt is gone could create a second share or link.
 */
export const RETRY_WINDOW_MS = 12 * 60 * 60 * 1000;
const SHARE_HELD = "We still can't confirm this share, and it's too old to retry safely. Check \"Already shared with\" above to see whether it went through. To share again, reload the page.";
const LINK_HELD = "We still can't confirm this link, and it's too old to retry safely. Check the existing links above to see whether it was created. To create another, reload the page.";

type PendingDirectShare = {
  body: string; key: string; sentAt: number; clientName: string; client: DirectShareClient; permissions: DirectShareGrant["permissions"];
  neverExpires: boolean; expiryDay: string; expiresAt: string | null;
};
type PendingPublicLink = { body: string; key: string; sentAt: number; label: string; expiryDay: string; neverExpires: boolean; download: boolean; cameras: boolean; units: "imperial" | "metric" };

/** Search Viewer projects, pick a published model, then share it. */
export function ViewerQuickShare({ canCreatePublic, canRevokePublic, onOpenViewer, opening = false }: {
  canCreatePublic: boolean; canRevokePublic: boolean; onOpenViewer?: () => void; opening?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [projects, setProjects] = useState<ProjectPage | null>(null);
  const [projectError, setProjectError] = useState("");
  const [off, setOff] = useState(false);
  const [project, setProject] = useState<ViewerCatalogProject | null>(null);
  const [tasks, setTasks] = useState<TaskPage | null>(null);
  const [taskError, setTaskError] = useState("");
  const [target, setTarget] = useState<ViewerShareTarget | null>(null);
  const projectRun = useRef(0), taskRun = useRef(0);

  const loadProjects = useCallback(async (q: string) => {
    const run = ++projectRun.current;
    setProjectError("");
    const path = projectSearchPath(q);
    if (!path) { setProjects(null); return; }
    try {
      const value = await api<unknown>(path);
      if (run !== projectRun.current) return;
      if (!validViewerCatalogProjects(value)) throw new Error("invalid_response");
      setProjects({ projects: value.projects.slice(0, QUICK_SHARE_RESULT_LIMIT), nextCursor: value.nextCursor });
    } catch (caught) {
      if (run !== projectRun.current) return;
      setProjects(null);
      if (statusOf(caught) === 404) { setOff(true); return; }
      setProjectError(statusOf(caught) === 403 ? "You don't have permission to share Viewer models." : "Viewer projects couldn't be loaded. Try again.");
    }
  }, []);
  useEffect(() => {
    // Search-first: no project is listed, or requested, until two characters are typed.
    if (!searchReady(query)) return;
    const timer = window.setTimeout(() => void loadProjects(query), 250);
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
  const ready = searchReady(query);
  const openViewer = onOpenViewer && <button type="button" className="button-ghost button-small" disabled={opening} onClick={onOpenViewer}>Open in Viewer</button>;
  const choose = (selected: ViewerCatalogProject) => { setProject(selected); setTasks(null); void loadTasks(selected, null); };
  const back = () => { taskRun.current += 1; setProject(null); setTasks(null); setTaskError(""); };

  if (off) return <section className="viewer-quick-share" aria-labelledby="viewer-quick-share-heading">
    <h3 id="viewer-quick-share-heading">Quick share</h3><p className="notice" role="status">{SHARING_OFF}</p>
  </section>;
  return <section className="viewer-quick-share" aria-labelledby="viewer-quick-share-heading">
    <header><h3 id="viewer-quick-share-heading">Quick share</h3></header>
    <p className="viewer-quick-share-pointer">Share whole projects from the Viewer. {openViewer}</p>
    {!project ? <>
      <label className="viewer-quick-share-search">Search Viewer projects
        <input type="search" value={query} onChange={event => changeQuery(event.target.value)} placeholder="Type 2 or more letters" maxLength={120} /></label>
      {projectError && <div className="notice error" role="alert">{projectError} <button type="button" className="button-ghost button-small" onClick={() => void loadProjects(query)}>Retry</button></div>}
      {ready && !projects && !projectError && <p className="viewer-quick-share-loading" role="status">Searching…</p>}
      {projects && (projects.projects.length ? <ul className="viewer-quick-share-list" aria-label="Viewer projects">{projects.projects.map(item =>
        <li key={item.viewerProjectId}><button type="button" onClick={() => choose(item)}>
          <strong>{item.name}</strong>{item.publishedTaskCount != null && <small>{item.publishedTaskCount} published model{item.publishedTaskCount === 1 ? "" : "s"}</small>}
        </button></li>)}</ul>
        : <EmptyState title="No matching projects" detail="Try a different name." />)}
      {projects?.nextCursor && <p className="viewer-quick-share-empty" role="status">Showing the first {QUICK_SHARE_RESULT_LIMIT}. Keep typing to narrow the list.</p>}
    </> : <>
      <div className="viewer-quick-share-crumb"><button type="button" className="button-ghost button-small" onClick={back}>Back to search</button><strong>{project.name}</strong>{openViewer}</div>
      {taskError && <div className="notice error" role="alert">{taskError} <button type="button" className="button-ghost button-small" onClick={() => void loadTasks(project, null)}>Retry</button></div>}
      {!tasks && !taskError && <p className="viewer-quick-share-loading" role="status">Loading published models…</p>}
      {tasks && tasks.tasks.length > 0 && <ul className="viewer-quick-share-list" aria-label={`Published models in ${tasks.project.name}`}>
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
  const [busy, setBusy] = useState(false), [unconfirmed, setUnconfirmed] = useState(false);
  const onStateChange = useCallback((nextBusy: boolean, nextUnconfirmed: boolean) => { setBusy(nextBusy); setUnconfirmed(nextUnconfirmed); }, []);
  // The method and the dialog stay fixed while a share is in flight or unconfirmed. Its idempotency receipt is scoped to
  // this staff sign-in and expires, so an unconfirmed share is only retried from here, never from a later reopen.
  const locked = busy || unconfirmed;
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
  if (!target.task) return <Dialog open onClose={onClose} title="Share from Viewer">
    <p>Share whole projects from the Viewer.</p>
  </Dialog>;
  return <Dialog open onClose={onClose} dismissible={!locked} size="lg" title={`Share ${label}`}
    description={target.task ? `From ${target.project.name}` : "Shares every published model in this project, and models published to it later."}>
    <div className="share-mode-selector ltds-segmented" role="tablist" aria-label="Sharing method">
      <button ref={workspaceTab} id="viewer-share-tab-workspace" type="button" role="tab" aria-selected={mode === "workspace"}
        aria-controls="viewer-share-panel-workspace" tabIndex={mode === "workspace" ? 0 : -1} className={mode === "workspace" ? "active" : "button-ghost"}
        disabled={locked} onClick={() => setMode("workspace")} onKeyDown={onTabKey}>Client Workspace</button>
      <button ref={publicTab} id="viewer-share-tab-public" type="button" role="tab" aria-selected={mode === "public"}
        aria-controls="viewer-share-panel-public" tabIndex={mode === "public" ? 0 : -1} className={mode === "public" ? "active" : "button-ghost"}
        disabled={locked || !publicAvailable} title={!publicAvailable ? publicReason : undefined}
        onClick={() => setMode("public")} onKeyDown={onTabKey}>Public link</button>
    </div>
    {mode === "workspace"
      ? <section id="viewer-share-panel-workspace" className="share-mode-panel" role="tabpanel" aria-labelledby="viewer-share-tab-workspace">
        <header><strong>Client Workspace access</strong>
          <small>Choose a client or organization. They'll see it in their Ledge Top portal after signing in. This does not create a public link.</small></header>
        <DirectClientSharePanel target={target} onStateChange={onStateChange} />
      </section>
      : <section id="viewer-share-panel-public" className="share-mode-panel" role="tabpanel" aria-labelledby="viewer-share-tab-public">
        <p className="share-mode-description">Create a link for anyone who receives the complete URL. Add a password when the model shouldn't be open to everyone holding the link.</p>
        <ViewerPublicLinkPanel modelId={target.task!.modelId!} canCreate={canCreatePublic} canRevoke={canRevokePublic} onStateChange={onStateChange} />
      </section>}
  </Dialog>;
}

// Camera photos show where each photo was taken, so a new share leaves them off until staff choose to include them.
const DEFAULT_PERMISSIONS = { measure: true, cameras: false, download: false };
const sameClient = (grant: DirectShareGrant, client: DirectShareClient) => grant.sourceId === client.sourceId && grant.workspaceId === client.workspaceId;

function DirectClientSharePanel({ target, onStateChange }: { target: ViewerShareTarget; onStateChange: (busy: boolean, unconfirmed: boolean) => void }) {
  // A share left unconfirmed when the dialog was closed comes back exactly as it was sent.
  const [query, setQuery] = useState("");
  const [workspace, setWorkspace] = useState<GrantWorkspace | null>(null);
  const [loadError, setLoadError] = useState("");
  // Client search results: null until two characters are typed and the answer arrives.
  const [results, setResults] = useState<{ clients: DirectShareClient[]; more: boolean } | null>(null);
  const [searchError, setSearchError] = useState("");
  const [active, setActive] = useState(-1);
  const search = useRef(0);
  const [blocked, setBlocked] = useState("");
  const [client, setClient] = useState<DirectShareClient | null>(null);
  const [permissions, setPermissions] = useState(DEFAULT_PERMISSIONS);
  const [neverExpires, setNeverExpires] = useState(true);
  const [expiryDay, setExpiryDay] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // An unconfirmed share is retried with the identical body and key, and the selection stays locked until it resolves.
  const pending = useRef<PendingDirectShare | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  // Held: unconfirmed for too long to retry. The request body is dropped; only the unresolved marker stays.
  const [held, setHeld] = useState(false);
  const run = useRef(0);
  useEffect(() => { onStateChange(busy, unconfirmed); }, [busy, unconfirmed, onStateChange]);

  // Existing shares for this project; never the client list.
  const load = useCallback(async () => {
    const current = ++run.current;
    setLoadError("");
    try {
      const value = await loadDirectShareWorkspace(path => api<unknown>(path), target.project.viewerProjectId);
      if (current !== run.current) return;
      setWorkspace(value);
      // Existing-access checks need every share; say so plainly if some could not be listed.
      if (value.grantsIncomplete) setLoadError("Some existing shares for this project could not be listed.");
    } catch (caught) {
      if (current !== run.current) return;
      setWorkspace(null);
      const status = statusOf(caught);
      if (status === 404) setBlocked("Client Workspace sharing isn't turned on yet.");
      else if (status === 403) setBlocked("Administrator access is required to share with clients.");
      else setLoadError("Existing shares couldn't be loaded. Try again.");
    }
  }, [target.project.viewerProjectId]);
  useEffect(() => { void load(); }, [load]);
  const runSearch = useCallback(async (q: string) => {
    const current = ++search.current;
    setSearchError("");
    try {
      const value = await searchDirectShareClients(path => api<unknown>(path), target.project.viewerProjectId, q);
      if (current !== search.current) return;
      setResults(value); setActive(value?.clients.length ? 0 : -1);
    } catch (caught) {
      if (current !== search.current) return;
      setResults(null); setActive(-1);
      const status = statusOf(caught);
      if (status === 404) setBlocked("Client Workspace sharing isn't turned on yet.");
      else if (status === 403) setBlocked("Administrator access is required to share with clients.");
      else setSearchError("Clients couldn't be searched. Try again.");
    }
  }, [target.project.viewerProjectId]);
  useEffect(() => {
    // Search-first: no client is listed, or requested, until two characters are typed.
    if (!searchReady(query)) return;
    const timer = window.setTimeout(() => void runSearch(query), 250);
    return () => window.clearTimeout(timer);
  }, [query, runSearch]);
  useEffect(() => () => { run.current += 1; search.current += 1; }, []);
  // A new search drops the previous results at once, so Enter or a click can't pick from an old list.
  const changeQuery = (value: string) => { search.current += 1; setResults(null); setActive(-1); setSearchError(""); setQuery(value); };

  const existing = workspace ? grantsForTarget(workspace.grants, target) : [];
  const restricted = (workspace?.grants ?? []).filter(grant => !grant.revokedAt
    && grant.viewerProjectId === target.project.viewerProjectId && grant.scopeType === "project" && grant.selection !== undefined);
  const expiresAt = unconfirmed && pending.current ? pending.current.expiresAt : neverExpires ? null : futureChicagoEndOfDay(expiryDay);
  const today = chicagoToday();
  const businessCount = new Set((client ? [client] : results?.clients ?? []).map(item => item.businessName)).size;
  // The API refuses a second share of the same scope to the same client; a whole-project share and a model share sit side by side.
  const clientGrants = client ? existing.filter(grant => sameClient(grant, client)) : [];
  const sameScope = clientGrants.find(grant => target.task ? grant.scopeType === "task" && grant.taskId === target.task.taskId : grant.scopeType === "project");
  const viaProject = !sameScope && clientGrants.some(grant => grant.scopeType === "project");
  const pick = (next: DirectShareClient | null) => {
    if (busy || unconfirmed) return;
    setClient(next); setReviewing(false); setError(""); setMessage(""); pending.current = null;
    if (!next) changeQuery("");
  };
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const count = results?.clients.length ?? 0;
    const moved = nextActiveOption(active, event.key, count);
    if (moved !== null) { event.preventDefault(); setActive(moved); return; }
    if (event.key === "Enter") { event.preventDefault(); const chosen = results?.clients[active]; if (chosen) pick(chosen); return; }
    if (event.key === "Escape" && query) { event.preventDefault(); changeQuery(""); }
  };

  const send = async () => {
    const attempt = pending.current;
    if (!attempt || busy) return;
    // A retry follows a send whose outcome is unknown: that earlier send may be the share the server now reports.
    const retry = unconfirmed;
    setBusy(true); setError("");
    try {
      await api("/api/viewer/direct-client-grants", { method: "POST", headers: { "Idempotency-Key": attempt.key }, body: attempt.body });
      pending.current = null; setUnconfirmed(false); setReviewing(false); setClient(null);
      setPermissions(DEFAULT_PERMISSIONS); setNeverExpires(true); setExpiryDay("");
      setMessage(`Shared with ${attempt.clientName}. They'll see it in their Ledge Top portal.`);
      changeQuery(""); void load();
    } catch (caught) {
      if (uncertain(caught)) {
        setUnconfirmed(true);
        setError(SHARE_UNCONFIRMED);
      } else {
        pending.current = null; setUnconfirmed(false);
        const code = caught instanceof ApiError ? caught.payload.code : undefined;
        // Server text is never shown for these: each has one plain next step.
        setError(code === "relationship_missing" ? "Something changed with this client. Choose them again from the list."
          : code === "duplicate_active_grant" ? retry
            ? `${attempt.clientName} already has this share, possibly from your earlier attempt. Check "Already shared with" above.`
            : `${attempt.clientName} already has this share. To change it, stop sharing first, then share again.`
          : (caught as Error).message);
        if (code === "relationship_missing") { setClient(null); setReviewing(false); changeQuery(""); void load(); }
        if (code === "duplicate_active_grant") void load();
      }
    } finally { setBusy(false); }
  };
  const hold = () => {
    if (pending.current) pending.current = { ...pending.current, body: "" };
    setHeld(true); setError(SHARE_HELD); void load();
  };
  useEffect(() => {
    if (!unconfirmed || held || !pending.current) return;
    const timer = window.setTimeout(hold, Math.max(0, pending.current.sentAt + RETRY_WINDOW_MS - Date.now()));
    return () => window.clearTimeout(timer);
  });
  const confirm = (event: FormEvent) => {
    event.preventDefault();
    // Try again re-sends the unconfirmed share exactly as it was first sent, but only within the retry window.
    if (unconfirmed) {
      if (held) return;
      if (pending.current && Date.now() - pending.current.sentAt > RETRY_WINDOW_MS) { hold(); return; }
      void send(); return;
    }
    if (!client || !target.task || busy || sameScope || (!neverExpires && !expiresAt)) return;
    pending.current = { body: JSON.stringify(directShareBody(target, client, permissions, expiresAt, workspace?.modelReport === true)), key: crypto.randomUUID(), sentAt: Date.now(),
      clientName: client.displayName, client, permissions, neverExpires, expiryDay, expiresAt };
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
      void load();
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };

  if (blocked) return <div className="notice" role="status">{blocked}</div>;
  const errorNotice = error && <div className="notice error" role="alert">{error}</div>;
  const business = client && businessLabel(client.businessName, businessCount);
  return <div className="viewer-direct-share">
    {existing.length > 0 && <div className="viewer-direct-share-existing"><strong>Already shared with</strong><ul>{existing.map(grant => <li key={grant.grantId}>
      <div><span>{grant.clientDisplayName ?? "Client"}</span><small>{grant.scopeType === "project" ? "Whole project" : "This model"} · {chicagoDate(grant.expiresAt)}{grant.permissions.download ? " · downloads allowed" : ""}</small></div>
      <button type="button" className="button-ghost button-small viewer-stop-share" disabled={busy || unconfirmed} onClick={() => void revoke(grant)}>Stop sharing</button>
    </li>)}</ul></div>}
    {restricted.length > 0 && <div className="viewer-direct-share-existing"><strong>Restricted project shares</strong><ul>{restricted.map(grant => <li key={grant.grantId}>
      <div><span>{grant.clientDisplayName ?? "Client"}</span><small>Restricted project · Model coverage not confirmed · {chicagoDate(grant.expiresAt)}</small></div>
    </li>)}</ul><p>Manage these saved selections in the Viewer. This model's folder membership isn't available here.</p></div>}
    {loadError && <div className="notice error" role="alert">{loadError} <button type="button" className="button-ghost button-small" onClick={() => void load()}>Retry</button></div>}
    {!client ? <>
      <label htmlFor="viewer-direct-share-client-search">Client or organization</label>
      <input id="viewer-direct-share-client-search" type="search" role="combobox" aria-autocomplete="list" aria-controls="viewer-direct-share-client-list"
        aria-expanded={!!results?.clients.length} aria-activedescendant={results && active >= 0 ? `viewer-direct-share-client-${active}` : undefined}
        value={query} onChange={event => changeQuery(event.target.value)} onKeyDown={onSearchKey} placeholder="Type 2 or more letters" maxLength={120} autoComplete="off" />
      {searchError && <div className="notice error" role="alert">{searchError} <button type="button" className="button-ghost button-small" onClick={() => void runSearch(query)}>Retry</button></div>}
      <ul id="viewer-direct-share-client-list" className="viewer-direct-share-clients" role="listbox" aria-label="Matching clients" hidden={!results?.clients.length}>
        {(results?.clients ?? []).map((item, index) => {
          const via = businessLabel(item.businessName, businessCount);
          return <li key={`${item.sourceId}/${item.workspaceId}`} id={`viewer-direct-share-client-${index}`} role="option" aria-selected={index === active}
            className={index === active ? "active" : undefined} onMouseDown={event => event.preventDefault()} onClick={() => pick(item)}>
            <strong>{item.displayName}</strong>
            {via && <small>{via}</small>}
            {existing.some(grant => sameClient(grant, item)) && <small className="viewer-direct-share-has-access">Already has access</small>}
          </li>;
        })}
      </ul>
      <p className="viewer-quick-share-empty" role="status">{!searchReady(query) || searchError ? "" : !results ? "Searching…"
        : !results.clients.length ? "No clients match that name."
        : results.more ? `Showing the first ${QUICK_SHARE_RESULT_LIMIT}. Keep typing to narrow the list.` : ""}</p>
    </> : <form className="viewer-direct-share-form" onSubmit={confirm}>
      <div className="viewer-direct-share-recipient"><div><strong>{client.displayName}</strong>{business && <small>{business}</small>}</div>
        <button type="button" className="button-ghost button-small" disabled={busy || unconfirmed} onClick={() => pick(null)}>Change</button></div>
      <fieldset disabled={busy || unconfirmed}><legend>They can</legend>
        <label className="viewer-share-check"><input type="checkbox" checked disabled /> View the model</label>
        <label className="viewer-share-check"><input type="checkbox" checked={permissions.measure} onChange={event => setPermissions({ ...permissions, measure: event.target.checked })} /> Take measurements</label>
        <label className="viewer-share-check"><input type="checkbox" checked={permissions.cameras} onChange={event => setPermissions({ ...permissions, cameras: event.target.checked })} /> See camera photos</label>
        <label className="viewer-share-check"><input type="checkbox" checked={permissions.download} onChange={event => setPermissions({ ...permissions, download: event.target.checked })} /> Download files</label>
      </fieldset>
      <fieldset disabled={busy || unconfirmed}><legend>Access ends</legend>
        <label className="viewer-share-check"><input type="checkbox" checked={neverExpires} onChange={event => setNeverExpires(event.target.checked)} /> Never (until you stop sharing)</label>
        {!neverExpires && <label>Last day (Central time)<input type="date" required min={today} value={expiryDay} onChange={event => setExpiryDay(event.target.value)} /></label>}
      </fieldset>
      {!reviewing ? <button type="button" className="button-orange" disabled={!neverExpires && !expiresAt} onClick={() => setReviewing(true)}>Review share</button>
        : <section className="viewer-direct-share-review" aria-label="Review share">
          <p>Share <strong>{target.task ? target.task.title : `all of ${target.project.name}`}</strong> with <strong>{client.displayName}</strong>
            {target.task ? "" : ", including every model published to it later"}. Access {expiresAt ? `ends ${chicagoDate(expiresAt)}` : "doesn't expire"}. {permissionSentence(permissions)}</p>
          {/* While a share is unconfirmed, its own earlier attempt may be what now shows as existing access. */}
          {!unconfirmed && sameScope && <p className="viewer-direct-share-note">{client.displayName} already has this share, so it can't be shared again.
            To change their access, stop sharing above, then share again.</p>}
          {!unconfirmed && viaProject && <p className="viewer-direct-share-note">{client.displayName} already has this model through a whole-project share.
            This adds a separate share for this model with the options above; their whole-project access stays as it is.</p>}
          {!unconfirmed && restricted.some(grant => sameClient(grant, client)) && <p className="viewer-direct-share-note">We can't confirm whether their restricted project share includes this model.
            This adds a separate share for this model. Their restricted project share stays as it is.</p>}
          {errorNotice}
          <div className="actions">
            {held ? <button type="button" className="button-ghost" onClick={() => void load()}>Check again</button>
              : <button type="submit" className="button-orange" disabled={busy || (!unconfirmed && !!sameScope)}>{busy ? "Sharing…" : unconfirmed ? "Try again" : "Share"}</button>}
            {!unconfirmed && <button type="button" className="button-ghost" disabled={busy} onClick={() => setReviewing(false)}>Back</button>}
          </div>
        </section>}
    </form>}
    {!(client && reviewing) && errorNotice}
    {message && <div className="notice ok" role="status">{message}</div>}
  </div>;
}

/** Public bearer links for one Viewer model, through the existing model share routes. */
export function ViewerPublicLinkPanel({ modelId, canCreate, canRevoke, onStateChange }: {
  modelId: string; canCreate: boolean; canRevoke: boolean; onStateChange: (busy: boolean, unconfirmed: boolean) => void;
}) {
  const [shares, setShares] = useState<ViewerPublicShareSummary[] | null>(null);
  const [off, setOff] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [label, setLabel] = useState("");
  // Like client shares, a link ends at the close of its last day in Central time.
  const [expiryDay, setExpiryDay] = useState(() => defaultPublicLinkDay());
  const [neverExpires, setNeverExpires] = useState(false);
  const [password, setPassword] = useState("");
  const [download, setDownload] = useState(false);
  const [cameras, setCameras] = useState(false);
  const [units, setUnits] = useState<"imperial" | "metric">("imperial");
  const [createdUrl, setCreatedUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // An unconfirmed link is retried with the identical body and key, so it can't be created twice.
  const pending = useRef<PendingPublicLink | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  // Held: unconfirmed for too long to retry. The body, which may hold a password, is dropped; only the marker stays.
  const [held, setHeld] = useState(false);
  useEffect(() => { onStateChange(busy, unconfirmed); }, [busy, unconfirmed, onStateChange]);
  const path = `/api/viewer/models/${encodeURIComponent(modelId)}/shares`;
  const load = useCallback(async () => {
    setLoadError("");
    try { setShares((await api<{ shares: ViewerPublicShareSummary[] }>(path)).shares); }
    catch (caught) {
      if (statusOf(caught) === 404) setOff(true); else setLoadError("Existing links couldn't be loaded.");
    }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  const dayRange = publicLinkDayRange();
  const expiresAt = neverExpires ? null : publicLinkExpiry(expiryDay);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!unconfirmed) {
      if (!neverExpires && !expiresAt) return;
      if (neverExpires && !window.confirm("Create a link that never expires? It stays active until you revoke it.")) return;
      pending.current = { key: crypto.randomUUID(), sentAt: Date.now(), label, expiryDay, neverExpires, download, cameras, units, body: JSON.stringify({
        label: label.trim() || null, expiresAt, displayUnits: units,
        ...(password ? { password } : {}), permissions: { view: true, measure: true, cameras, download },
      }) };
    }
    const attempt = pending.current;
    if (!attempt || held) return;
    if (Date.now() - attempt.sentAt > RETRY_WINDOW_MS) { hold(); return; }
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
        setError(LINK_UNCONFIRMED);
      } else { pending.current = null; setUnconfirmed(false); setError((caught as Error).message); }
    } finally { setBusy(false); }
  };
  const hold = () => {
    if (pending.current) pending.current = { ...pending.current, body: "" };
    setPassword(""); setHeld(true); setError(LINK_HELD); void load();
  };
  useEffect(() => {
    if (!unconfirmed || held || !pending.current) return;
    const timer = window.setTimeout(hold, Math.max(0, pending.current.sentAt + RETRY_WINDOW_MS - Date.now()));
    return () => window.clearTimeout(timer);
  });
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
  const errorNotice = error && <div className="notice error" role="alert">{error}</div>;
  return <div className="viewer-public-link">
    {loadError && <div className="notice error" role="alert">{loadError} <button type="button" className="button-ghost button-small" onClick={() => void load()}>Retry</button></div>}
    {active.length > 0 && <div className="viewer-direct-share-existing"><strong>Active links</strong><ul>{active.map(share => <li key={share.id}>
      <div><span>{share.label || "Unlabeled link"}</span><small>{share.hasPassword ? "Password protected" : "No password"} · {share.expiresAt ? `expires ${chicagoDate(share.expiresAt)}` : "never expires"} · {share.accessCount} open{share.accessCount === 1 ? "" : "s"}</small></div>
      {canRevoke && <button type="button" className="button-ghost button-small viewer-stop-share" disabled={busy || unconfirmed} onClick={() => void revoke(share)}>Revoke</button>}
    </li>)}</ul></div>}
    {canCreate ? <form className="viewer-share-form" onSubmit={create}>
      <fieldset className="viewer-share-fields" disabled={busy || unconfirmed}>
      <label>Label (optional)<input maxLength={120} value={label} onChange={event => setLabel(event.target.value)} placeholder="Client review or demo" /></label>
      <label>Last day (Central time)<input type="date" required={!neverExpires} disabled={neverExpires} value={expiryDay} min={dayRange.min} max={dayRange.max} onChange={event => setExpiryDay(event.target.value)} /></label>
      <label className="viewer-share-check"><input type="checkbox" checked={neverExpires} onChange={event => setNeverExpires(event.target.checked)} /> Never expires</label>
      <label>Password (optional)<input type="password" minLength={8} maxLength={128} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} placeholder={unconfirmed ? "Kept from the first attempt" : "At least 8 characters"} /></label>
      <label>Measurement units<select value={units} onChange={event => setUnits(event.target.value as "imperial" | "metric")}><option value="imperial">Imperial</option><option value="metric">Metric</option></select></label>
      <label className="viewer-share-check"><input type="checkbox" checked={cameras} onChange={event => setCameras(event.target.checked)} /> Show camera photos and where they were taken</label>
      <label className="viewer-share-check"><input type="checkbox" checked={download} onChange={event => setDownload(event.target.checked)} /> Allow model download</label>
      </fieldset>
      {errorNotice && <div className="viewer-share-form-error">{errorNotice}</div>}
      {held ? <button type="button" className="button-ghost" onClick={() => void load()}>Check again</button>
        : <button type="submit" className="button-orange" disabled={busy || (!unconfirmed && !neverExpires && !expiresAt)}>{busy ? "Creating…" : unconfirmed ? "Try again" : "Create link"}</button>}
    </form> : <p className="notice" role="status">You don't have permission to create public links.</p>}
    {createdUrl && <div className="viewer-created-share" role="status">
      <label>New link<input readOnly value={createdUrl} onFocus={event => event.currentTarget.select()} /></label>
      <button type="button" className="button-orange button-small" onClick={() => void navigator.clipboard.writeText(createdUrl).then(() => setMessage("Link copied."), () => setMessage("Select and copy the link manually."))}>Copy link</button>
    </div>}
    {!canCreate && errorNotice}
    {message && <div className="notice ok" role="status">{message}</div>}
    {shares && !active.length && !createdUrl && <StatusPill>No active links</StatusPill>}
  </div>;
}
