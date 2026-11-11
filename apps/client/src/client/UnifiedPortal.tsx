import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Card, EmptyState, Skeleton, StatusPill } from "@ltds/ui";
import type { PortalServiceRequest, PortalWorkspace } from "./portal-api";
import {
  loadUnifiedPortal, unifiedAccount, unifiedAccountSupported,
  type UnifiedAccountResult, type UnifiedProject, type UnifiedRequest,
} from "./unified-portal";
import { UnifiedDeliveries } from "./UnifiedDeliveries";
import { QuickRequest } from "./QuickRequest";
import { INQUIRY_KIND_LABEL, loadInquiries, loadRequestServices, type ClientInquiry, type RequestServices } from "./request-services-api";
import type { RequestError } from "./bulk-download";

export type UnifiedPage = "dashboard" | "projects" | "requests" | "deliveries" | "feedback" | "account";
export const UNIFIED_PAGES: ReadonlySet<string> = new Set<UnifiedPage>(["dashboard", "projects", "requests", "deliveries", "feedback", "account"]);

/** Where an item lives: opening it loads exactly that client account, never a merged context. */
export type OpenInAccount = (workspaceId: string, path: string) => void;

const CLOSED_REQUEST = new Set(["completed", "cancelled", "declined"]);
const CLOSED_INQUIRY = new Set(["declined", "closed"]);
const CHECKING_REQUESTS = "Checking your requests…";
const INQUIRY_STATUS: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" }> = {
  received: { label: "Received", tone: "neutral" }, under_review: { label: "Under review", tone: "warning" },
  declined: { label: "Declined", tone: "danger" }, closed: { label: "Closed", tone: "success" },
};
const inquiryStatus = (status: string) => INQUIRY_STATUS[status] ?? { label: status.replace(/_/g, " ").replace(/^./, letter => letter.toUpperCase()), tone: "neutral" as const };

function byName(left: UnifiedProject, right: UnifiedProject) {
  return left.projectName.localeCompare(right.projectName) || left.account.business.localeCompare(right.account.business);
}
function byUpdated(left: UnifiedRequest, right: UnifiedRequest) {
  return right.request.updatedAt.localeCompare(left.request.updatedAt);
}

export function UnifiedPortal({ page, workspaces, openInAccount, navigate, renderStatus, supplement, mapboxPublicToken = null }: {
  page: UnifiedPage;
  workspaces: PortalWorkspace[];
  openInAccount: OpenInAccount;
  navigate: (page: UnifiedPage) => void;
  renderStatus: (request: PortalServiceRequest) => ReactNode;
  supplement?: ReactNode;
  mapboxPublicToken?: string | null;
}) {
  const accounts = useMemo(() => workspaces.filter(unifiedAccountSupported).map(unifiedAccount), [workspaces]);
  // Stable across renders so the delivery lists load once per account, not on every refresh of this page.
  const accountWorkspaces = useMemo(() => accounts.map(account => account.workspace), [accounts]);
  const [results, setResults] = useState<Map<string, UnifiedAccountResult>>(() => new Map());
  const [retry, setRetry] = useState(0);
  const [choosingRequest, setChoosingRequest] = useState(false);
  // The one-step form is the only way to start a request across accounts. Without it, a single account
  // opens its own form; several accounts get a retry, never a choice of business or account.
  const [quickRequest, setQuickRequest] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  // General requests aren't tied to an account, so they're read once for the client, not per account.
  // "loading": not answered yet; null: not offered here; "error": offered but couldn't be read. Only a list or
  // null is a real answer, so neither of the others may be shown as "no requests".
  const [inquiries, setInquiries] = useState<ClientInquiry[] | null | "loading" | "error">("loading");
  // What the one-step form offers this client, read once like general requests: a client can have services or
  // general choices even when none of their accounts takes requests online. null: not offered here (an older
  // portal, or no access); "error": couldn't be checked.
  const [offered, setOffered] = useState<RequestServices | null | "loading" | "error">("loading");
  const generation = useRef(0);
  // Home starts requests and counts them too, so it reads the same two lists as the requests page.
  const requestPage = page === "requests" || page === "dashboard";

  useEffect(() => {
    if (!requestPage) return;
    const controller = new AbortController();
    setInquiries("loading");
    loadInquiries(controller.signal).then(value => { if (!controller.signal.aborted) setInquiries(value); },
      () => { if (!controller.signal.aborted) setInquiries("error"); });
    return () => controller.abort();
  }, [requestPage, retry]);

  useEffect(() => {
    if (!requestPage) return;
    const controller = new AbortController();
    setOffered("loading");
    loadRequestServices(controller.signal).then(value => { if (!controller.signal.aborted) setOffered(value); },
      (caught: RequestError) => { if (!controller.signal.aborted) setOffered(caught.status === 403 ? null : "error"); });
    return () => controller.abort();
  }, [requestPage, retry]);

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
  // Going straight to one account's form needs every account answered: one still loading or failed may also take requests.
  const allAccountsReady = accounts.length > 0 && accounts.every(account => results.get(account.workspace.id)?.status === "ready");
  const onlyRequestAccount = allAccountsReady && requestAccounts.length === 1 ? requestAccounts[0]! : null;
  // An account that can't take requests online doesn't load its request history either, so an empty list
  // there means "not shown", never "no requests". The page says which, instead of dropping the button.
  const historyHidden = ready.some(result => !result.historyLoaded);
  // "No requests yet" only when every account answered and every account's history was actually read.
  const historyComplete = !loading && failed.length === 0 && !historyHidden;
  const offers = typeof offered === "object" && offered !== null;
  const offersRequests = offers && (offered.services.length > 0 || offered.inquiryKinds.length > 0);
  // Nothing offered but some accounts couldn't list their services: that's "couldn't check", not "not available".
  const offerUnchecked = offered === "error" || (offers && !offersRequests && offered.unavailable.length > 0);
  const requestAvailability: "available" | "checking" | "unchecked" | "unavailable" = requestAccounts.length > 0 || offersRequests ? "available"
    : loading || offered === "loading" ? "checking" : failed.length > 0 || offerUnchecked ? "unchecked" : "unavailable";

  const startRequest = () => {
    setNotice(null);
    if (!quickRequest && onlyRequestAccount) { openInAccount(onlyRequestAccount.workspace.id, "/portal/requests/new"); return; }
    setQuickRequest(true);
    setChoosingRequest(true);
  };
  const requestSent = () => {
    setChoosingRequest(false);
    setNotice("Request sent. Ledge Top will review it shortly.");
    setRetry(value => value + 1);
    navigate("requests");
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
  const requestRow = (item: UnifiedRequest) => <li key={item.key}>
    <div><strong>{item.request.title}</strong>
      <small>{[item.request.serviceCategory, item.projectName, `Updated ${new Date(item.request.updatedAt).toLocaleDateString()}`].filter(Boolean).join(" · ")}</small></div>
    <div className="unified-portal-request-actions">{renderStatus(item.request)}
      <button type="button" className="button-ghost button-small" onClick={() => openInAccount(item.account.workspace.id, "/portal/requests")}>View</button></div>
  </li>;
  // General requests have no page of their own yet, so they show where they stand and nothing to open.
  const historyProblem = !loading && !historyComplete && <p className="unified-portal-request-note">{failed.length > 0
    ? "Some request history couldn’t be loaded, so this list may be incomplete." : "Requests for some of your work aren’t listed here yet."}</p>;
  const inquiryProblem = inquiries === "error" && <>
    <p className="unified-portal-request-note" role="status">General requests you’ve sent couldn’t be loaded right now.</p>
    <button type="button" className="button-ghost button-small" aria-label="Try loading general requests again" onClick={() => setRetry(value => value + 1)}>Try again</button>
  </>;
  const inquiryRow = (item: ClientInquiry) => <li key={`inquiry:${item.id}`}>
    <div><strong>{item.title}</strong><small>{`${INQUIRY_KIND_LABEL[item.kind]} · Sent ${new Date(item.createdAt).toLocaleDateString()}`}</small></div>
    <div className="unified-portal-request-actions"><StatusPill tone={inquiryStatus(item.status).tone}>{inquiryStatus(item.status).label}</StatusPill></div>
  </li>;
  const requestRows = (items: UnifiedRequest[]) => <ul className="unified-portal-requests">{items.map(requestRow)}</ul>;
  // The server works out where a request goes from the service picked; the client never chooses.
  const requestChooser = choosingRequest && quickRequest ? <QuickRequest mapboxPublicToken={mapboxPublicToken}
    onSubmitted={requestSent} onCancel={() => setChoosingRequest(false)} onUnavailable={() => {
      setQuickRequest(false);
      if (onlyRequestAccount) { setChoosingRequest(false); openInAccount(onlyRequestAccount.workspace.id, "/portal/requests/new"); }
    }} /> : choosingRequest && <Card title="New requests are unavailable" className="unified-portal-chooser">
    <div role="alert"><p>A new request can’t be started right now. Try again in a moment.</p></div>
    <div className="unified-portal-chooser-actions">
      <button type="button" className="button-orange" onClick={() => setQuickRequest(true)}>Try again</button>
      <button type="button" className="portal-text-action" onClick={() => setChoosingRequest(false)}>Cancel</button>
    </div>
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
    <UnifiedDeliveries workspaces={accountWorkspaces} openInAccount={openInAccount} />
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
      {requestAvailability === "available" ? <button type="button" className="button-orange" onClick={startRequest}>New request</button>
        : requestAvailability === "checking" && <button type="button" className="button-orange" disabled>Checking…</button>}
    </section>
    {notice && <p className="portal-success-notice" role="status">{notice}</p>}
    {requestAvailability === "unavailable" && <Card className="unified-portal-request-unavailable" title="New requests aren’t available online yet">
      <p>New requests can’t be started online for your account right now. To ask for new work, ask your Ledge Top contact or admin.</p>
      <button type="button" className="portal-text-action" onClick={() => navigate("account")}>Go to your account</button>
    </Card>}
    {requestAvailability === "unchecked" && <Card className="unified-portal-request-unavailable" title="We couldn’t check new requests">
      <p>We couldn’t confirm whether new requests are available right now. Try again in a moment.</p>
      {failed.length === 0 && <button type="button" className="button-ghost" onClick={() => setRetry(value => value + 1)}>Try again</button>}
    </Card>}
    {requestChooser}{problems}{loadingNote}
    {requests.length > 0 && <RequestProgress requests={requests} />}
    <Card title="Request history">{!loading && requests.length === 0
      ? historyComplete ? inquiries === "loading" ? <p className="unified-portal-quiet" role="status">{CHECKING_REQUESTS}</p>
        : inquiries === "error" || Array.isArray(inquiries) && inquiries.length > 0
        ? <EmptyState title="No service requests yet" detail="Service requests you submit will appear here." />
        : <EmptyState title="No requests yet" detail="Requests you submit will appear here." />
        : failed.length > 0 ? <EmptyState title="Request history couldn’t be loaded" detail="Some of your work didn’t load, so requests may be missing. Try again above." />
        : <EmptyState title="Request history isn’t shown here yet" detail="Past requests for your account aren’t listed here yet." />
      : <>{requestRows(requests)}{historyProblem}</>}</Card>
    {Array.isArray(inquiries) && inquiries.length > 0 && <Card title="General requests">
      <ul className="unified-portal-requests">{inquiries.map(inquiryRow)}</ul>
    </Card>}
    {inquiryProblem}
  </>;

  const general = Array.isArray(inquiries) ? inquiries : [];
  const openRequests = requests.filter(item => !CLOSED_REQUEST.has(item.request.status)).length
    + general.filter(item => !CLOSED_INQUIRY.has(item.status)).length;
  const completed = requests.filter(item => item.request.status === "completed");
  const counting = loading && !ready.length;
  const countingRequests = counting || inquiries === "loading";
  // Service and general requests in one list, newest first: a client never sorts their work by kind either.
  const activity = [
    ...requests.map(item => ({ at: item.request.updatedAt, row: requestRow(item) })),
    ...general.map(item => ({ at: item.createdAt, row: inquiryRow(item) })),
  ].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 5);
  const canStart = requestAvailability === "available";
  // Order on the page: what's happening, what's owed, then projects and activity; the service list and
  // shared files (from the supplement) follow last.
  return <div className="portal-home">
    <section className="portal-welcome portal-welcome-split">
      <div><span className="eyebrow">Client portal</span><h1>Welcome back</h1>
        <p>Your projects, deliveries, requests and invoices in one place.</p></div>
      {canStart && <button type="button" className="button-orange" onClick={startRequest}>New request</button>}
    </section>
    {problems}{requestChooser}
    <div className="portal-overview-tiles">
      <OverviewTile icon="projects" value={counting ? "…" : String(projects.length)} label="Projects" action="View projects" onClick={() => navigate("projects")} />
      <OverviewTile icon="progress" value={countingRequests ? "…" : String(openRequests)} label="Requests in progress" action="View requests" onClick={() => navigate("requests")} />
      <OverviewTile icon="done" value={counting ? "…" : String(completed.length)} label="Completed requests" action="See history" onClick={() => navigate("requests")} />
      <OverviewTile icon="files" value="Files" label="Deliveries" action="Open deliveries" onClick={() => navigate("deliveries")} />
    </div>
    {requests.length > 0 && <RequestProgress requests={requests} />}
    {supplement}
    <Card className="portal-home-projects" title="Your projects" action={projects.length > 6 ? <button type="button" className="button-ghost button-small" onClick={() => navigate("projects")}>All projects</button> : undefined}>
      {loadingNote}{!loading && projects.length === 0 ? <EmptyState title="No projects available" detail="No projects are shared with you yet." /> : projectCards(projects.slice(0, 6))}</Card>
    <Card className="portal-home-activity" title="Recent activity" action={canStart ? <button type="button" className="button-ghost button-small" onClick={startRequest}>New request</button> : undefined}>
      {activity.length > 0 ? <ul className="unified-portal-requests">{activity.map(item => item.row)}</ul>
        : loading || inquiries === "loading" ? <p className="unified-portal-quiet" role="status">{CHECKING_REQUESTS}</p>
        : historyComplete && inquiries !== "error" && <p className="unified-portal-quiet">No requests yet. When you ask us for something, you’ll follow it here.</p>}
      {historyProblem}{inquiryProblem}</Card>
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
