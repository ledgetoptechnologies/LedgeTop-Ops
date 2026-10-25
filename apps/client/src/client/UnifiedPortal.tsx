import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Card, EmptyState, Skeleton, StatusPill } from "@ltds/ui";
import type { PortalServiceRequest, PortalWorkspace } from "./portal-api";
import {
  AREA_TEXT, accountArea, loadUnifiedPortal, unifiedAccount, unifiedAccountSupported,
  type UnifiedAccountResult, type UnifiedProject, type UnifiedRequest,
} from "./unified-portal";
import { UnifiedDeliveries } from "./UnifiedDeliveries";

export type UnifiedPage = "dashboard" | "projects" | "requests" | "deliveries" | "feedback" | "account";
export const UNIFIED_PAGES: ReadonlySet<string> = new Set<UnifiedPage>(["dashboard", "projects", "requests", "deliveries", "feedback", "account"]);

/** Where an item lives: opening it loads exactly that client account, never a merged context. */
export type OpenInAccount = (workspaceId: string, path: string) => void;

const CLOSED_REQUEST = new Set(["completed", "cancelled", "declined"]);

function byName(left: UnifiedProject, right: UnifiedProject) {
  return left.projectName.localeCompare(right.projectName) || left.account.business.localeCompare(right.account.business);
}
function byUpdated(left: UnifiedRequest, right: UnifiedRequest) {
  return right.request.updatedAt.localeCompare(left.request.updatedAt);
}

export function UnifiedPortal({ page, workspaces, openInAccount, navigate, renderStatus, supplement }: {
  page: UnifiedPage;
  workspaces: PortalWorkspace[];
  openInAccount: OpenInAccount;
  navigate: (page: UnifiedPage) => void;
  renderStatus: (request: PortalServiceRequest) => ReactNode;
  supplement?: ReactNode;
}) {
  const accounts = useMemo(() => workspaces.filter(unifiedAccountSupported).map(unifiedAccount), [workspaces]);
  const [results, setResults] = useState<Map<string, UnifiedAccountResult>>(() => new Map());
  const [retry, setRetry] = useState(0);
  const [choosingRequest, setChoosingRequest] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    let active = true, controller: AbortController | null = null, lastStartedAt = -Infinity;
    const clear = () => {
      generation.current++;
      controller?.abort();
      controller = null;
      setResults(new Map());
    };
    const refresh = () => {
      if (!active || document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastStartedAt < 1000) return;
      lastStartedAt = now;
      // Hide the previous private summaries before checking each account again.
      // A denied/unavailable account must never retain its last successful data.
      clear();
      const current = generation.current, requestController = new AbortController();
      controller = requestController;
      void loadUnifiedPortal(accounts.map(account => account.workspace), requestController.signal, result => {
        if (!active || requestController.signal.aborted || current !== generation.current) return;
        setResults(previous => new Map(previous).set(result.account.workspace.id, result));
      }).catch(() => undefined);
    };
    const visibilityChanged = () => {
      if (document.visibilityState === "visible") refresh();
      else { clear(); lastStartedAt = 0; }
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visibilityChanged);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      active = false;
      generation.current++;
      controller?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [accounts, retry]);

  const ready = [...results.values()].filter(result => result.status === "ready");
  const failed = [...results.values()].filter((result): result is Extract<UnifiedAccountResult, { status: "error" }> => result.status === "error");
  const loading = results.size < accounts.length;
  // One list for everything: clients never pick a business. Which account an item belongs to stays
  // attached to it (from the server) so opening it still loads exactly that account.
  const projects = ready.flatMap(result => result.projects).sort(byName);
  const requests = ready.flatMap(result => result.requests).sort(byUpdated);
  const requestAccounts = ready.filter(result => result.canRequest).map(result => result.account);
  // The chooser asks what kind of help is needed; one choice per kind of service, never one per business or account.
  const requestChoices = requestAccounts.filter((account, index) => requestAccounts.findIndex(other => accountArea(other) === accountArea(account)) === index);

  const startRequest = () => {
    if (requestChoices.length === 1) openInAccount(requestChoices[0]!.workspace.id, "/portal/requests/new");
    else setChoosingRequest(true);
  };
  // One Ledge Top portal: no business, division or account names anywhere, even across several accounts.
  const problems = failed.length > 0 && <div className="unified-portal-problems" role="alert">
    <p>Some of your work couldn’t be loaded.</p>
    {[...new Set(failed.map(result => result.message).filter(Boolean))].map(message => <p key={message}>{message}</p>)}
    <button type="button" className="button-ghost" onClick={() => setRetry(value => value + 1)}>Try again</button>
  </div>;
  const loadingNote = loading && <Skeleton variant="list" rows={3} label="Loading your projects and requests…" />;

  const projectCards = (items: UnifiedProject[]) => <div className="portal-project-grid">
    {items.map(item => <button key={item.key} type="button" className="portal-project-card ltds-card"
      onClick={() => openInAccount(item.account.workspace.id, `/portal/projects/${encodeURIComponent(item.projectId)}`)}>
      <div>{item.status && <StatusPill tone="success">{item.status === "active" ? "Active" : item.status}</StatusPill>}</div>
      <h2>{item.projectName}</h2>
      <span className="portal-project-link">Open project →</span>
    </button>)}
  </div>;
  const requestRows = (items: UnifiedRequest[]) => <ul className="unified-portal-requests">
    {items.map(item => <li key={item.key}>
      <div><strong>{item.request.title}</strong>
        <small>{[item.projectName, `Updated ${new Date(item.request.updatedAt).toLocaleDateString()}`].filter(Boolean).join(" · ")}</small></div>
      <div className="unified-portal-request-actions">{renderStatus(item.request)}
        <button type="button" className="button-ghost button-small" onClick={() => openInAccount(item.account.workspace.id, "/portal/requests")}>View</button></div>
    </li>)}
  </ul>;
  // Ask what the client needs, not which business: the choice decides where the request goes.
  const requestChooser = choosingRequest && <Card title="What do you need help with?" className="unified-portal-chooser">
    <div className="unified-portal-need-list">
      {requestChoices.map(account => <button key={account.workspace.id} type="button" className="unified-portal-need"
        onClick={() => openInAccount(account.workspace.id, "/portal/requests/new")}>
        <span><strong>{AREA_TEXT[accountArea(account)].need}</strong><small>{AREA_TEXT[accountArea(account)].needDetail}</small></span>
      </button>)}
    </div>
    <button type="button" className="portal-text-action" onClick={() => setChoosingRequest(false)}>Cancel</button>
  </Card>;
  const heading = (title: string, detail: string) => <section className="portal-page-heading"><span className="eyebrow">Client portal</span><h1>{title}</h1><p>{detail}</p></section>;
  /** One neutral card that opens the first account's page. */
  const single = (title: string, detail: string, path: string, card: string, action: string) => <>
    {heading(title, detail)}
    {accounts[0] && <Card className="unified-portal-area"><strong>{card}</strong>
      <button type="button" className="button-orange" onClick={() => openInAccount(accounts[0]!.workspace.id, path)}>{action}</button></Card>}
    {supplement}
  </>;

  if (page === "deliveries") return <>
    {heading("Deliveries", "Files and data we’ve delivered to you.")}
    <UnifiedDeliveries workspaces={accounts.map(account => account.workspace)} openInAccount={openInAccount} />
    {supplement}
  </>;
  if (page === "feedback") return single("Feedback", "Tell us what’s working and what to change.", "/portal/feedback", "Your feedback", "Give feedback");
  if (page === "account") return single("Account", "Your profile, team and sign-in.", "/portal/account", "Account settings", "Open account settings");

  if (page === "projects") return <>
    <section className="portal-page-heading"><span className="eyebrow">Projects</span><h1>Projects</h1>
      <p>Every project you can open with Ledge Top.</p></section>
    {problems}{loadingNote}
    {!loading && projects.length === 0 ? <Card><EmptyState title="No projects available" detail="No projects are shared with you yet." /></Card> : projectCards(projects)}
  </>;

  if (page === "requests") return <>
    <section className="portal-page-heading portal-page-heading-action">
      <div><span className="eyebrow">Requests</span><h1>Service requests</h1><p>Everything you’ve asked us for, and where it stands.</p></div>
      {requestAccounts.length > 0 && <button type="button" className="button-orange" onClick={startRequest}>New request</button>}
    </section>
    {requestChooser}{problems}{loadingNote}
    {requests.length > 0 && <RequestProgress requests={requests} />}
    <Card title="Request history">{!loading && requests.length === 0 ? <EmptyState title="No requests yet" detail="Requests you submit will appear here." /> : requestRows(requests)}</Card>
  </>;

  const openRequests = requests.filter(item => !CLOSED_REQUEST.has(item.request.status));
  const completed = requests.filter(item => item.request.status === "completed");
  const counting = loading && !ready.length;
  // Order on the page: what's happening, what's owed, then projects and activity; the service list and
  // shared files (from the supplement) follow last.
  return <div className="portal-home">
    <section className="portal-welcome portal-welcome-split">
      <div><span className="eyebrow">Client portal</span><h1>Welcome back</h1>
        <p>Your projects, deliveries, requests and invoices in one place.</p></div>
      {requestAccounts.length > 0 && <button type="button" className="button-orange" onClick={startRequest}>New request</button>}
    </section>
    {problems}{requestChooser}
    <div className="portal-overview-tiles">
      <OverviewTile icon="projects" value={counting ? "…" : String(projects.length)} label="Projects" action="View projects" onClick={() => navigate("projects")} />
      <OverviewTile icon="progress" value={counting ? "…" : String(openRequests.length)} label="Requests in progress" action="View requests" onClick={() => navigate("requests")} />
      <OverviewTile icon="done" value={counting ? "…" : String(completed.length)} label="Completed requests" action="See history" onClick={() => navigate("requests")} />
      <OverviewTile icon="files" value="Files" label="Deliveries" action="Open deliveries" onClick={() => navigate("deliveries")} />
    </div>
    {requests.length > 0 && <RequestProgress requests={requests} />}
    {supplement}
    <Card className="portal-home-projects" title="Your projects" action={projects.length > 6 ? <button type="button" className="button-ghost button-small" onClick={() => navigate("projects")}>All projects</button> : undefined}>
      {loadingNote}{!loading && projects.length === 0 ? <EmptyState title="No projects available" detail="No projects are shared with you yet." /> : projectCards(projects.slice(0, 6))}</Card>
    <Card className="portal-home-activity" title="Recent activity" action={requestAccounts.length > 0 ? <button type="button" className="button-ghost button-small" onClick={startRequest}>New request</button> : undefined}>
      {requests.length === 0 ? <p className="unified-portal-quiet">No requests yet. When you ask us for something, you’ll follow it here.</p> : requestRows(requests.slice(0, 5))}</Card>
  </div>;
}

type TileIcon = "projects" | "progress" | "done" | "files";
const TILE_PATHS: Record<TileIcon, string> = {
  projects: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  progress: "M12 3a9 9 0 1 0 9 9M12 7v5l3 2",
  done: "M5 12.5l4.5 4.5L19 7.5",
  files: "M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM14 3v5h5",
};
function OverviewTile({ icon, value, label, action, onClick }: { icon: TileIcon; value: string; label: string; action: string; onClick: () => void }) {
  return <button type="button" className={`portal-overview-tile portal-overview-tile-${icon}`} onClick={onClick}>
    <span className="portal-overview-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d={TILE_PATHS[icon]} /></svg></span>
    <span className="portal-overview-value">{value}</span>
    <span className="portal-overview-label">{label}</span>
    <span className="portal-overview-action">{action} →</span>
  </button>;
}


const STAGES = [
  { key: "received", label: "Received", match: ["submitted"] },
  { key: "review", label: "In review", match: ["under_review"] },
  { key: "approved", label: "Approved", match: ["accepted_pending_pa_linkage", "accepted_linked"] },
  { key: "completed", label: "Completed", match: ["completed"] },
  { key: "closed", label: "Closed", match: ["declined", "cancelled"] },
] as const;

/** Where every request stands, as one bar. Counts only; each request still opens in its own account. */
function RequestProgress({ requests }: { requests: UnifiedRequest[] }) {
  const counts = STAGES.map(stage => ({ ...stage, count: requests.filter(item => (stage.match as readonly string[]).includes(item.request.status)).length }))
    .filter(stage => stage.count > 0);
  const total = counts.reduce((sum, stage) => sum + stage.count, 0);
  if (!total) return null;
  return <Card title="Request progress" className="portal-progress-card">
    <div className="portal-progress-bar" role="img" aria-label={counts.map(stage => `${stage.count} ${stage.label.toLowerCase()}`).join(", ")}>
      {counts.map(stage => <span key={stage.key} className={`portal-progress-${stage.key}`} style={{ flexGrow: stage.count }} />)}
    </div>
    <ul className="portal-progress-legend">
      {counts.map(stage => <li key={stage.key}><span className={`portal-progress-dot portal-progress-${stage.key}`} aria-hidden="true" />
        <strong>{stage.count}</strong> {stage.label}</li>)}
    </ul>
  </Card>;
}
