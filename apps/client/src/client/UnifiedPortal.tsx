import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Card, EmptyState, Skeleton, StatusPill } from "@ltds/ui";
import type { PortalServiceRequest, PortalWorkspace } from "./portal-api";
import {
  accountLabel, loadUnifiedPortal, showsClientName, unifiedAccount, unifiedAccountSupported,
  type UnifiedAccount, type UnifiedAccountResult, type UnifiedProject, type UnifiedRequest,
} from "./unified-portal";

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

export function UnifiedPortal({ page, workspaces, displayName, openInAccount, navigate, renderStatus, supplement }: {
  page: UnifiedPage;
  workspaces: PortalWorkspace[];
  displayName: string;
  openInAccount: OpenInAccount;
  navigate: (page: UnifiedPage) => void;
  renderStatus: (request: PortalServiceRequest) => ReactNode;
  supplement?: ReactNode;
}) {
  const accounts = useMemo(() => workspaces.filter(unifiedAccountSupported).map(unifiedAccount), [workspaces]);
  const accountKey = accounts.map(account => account.workspace.id).join("\u0000");
  const [results, setResults] = useState<Map<string, UnifiedAccountResult>>(() => new Map());
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState<string>("all");
  const [choosingRequest, setChoosingRequest] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const controller = new AbortController(), current = ++generation.current;
    setResults(new Map());
    void loadUnifiedPortal(accounts.map(account => account.workspace), controller.signal, result => {
      if (controller.signal.aborted || current !== generation.current) return;
      setResults(previous => new Map(previous).set(result.account.workspace.id, result));
    }).catch(() => undefined);
    return () => controller.abort();
    // accountKey captures the exact authorized account list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountKey, retry]);

  const withClient = showsClientName(accounts);
  const filters = useMemo(() => {
    const businesses = [...new Set(accounts.map(account => account.business))];
    return businesses.length > 1 ? businesses : [];
  }, [accounts]);
  const visible = (account: UnifiedAccount) => filter === "all" || account.business === filter;
  const ready = [...results.values()].filter(result => result.status === "ready");
  const failed = [...results.values()].filter((result): result is Extract<UnifiedAccountResult, { status: "error" }> => result.status === "error");
  const loading = results.size < accounts.length;
  const projects = ready.flatMap(result => result.projects).filter(item => visible(item.account)).sort(byName);
  const requests = ready.flatMap(result => result.requests).filter(item => visible(item.account)).sort(byUpdated);
  const requestAccounts = ready.filter(result => result.canRequest).map(result => result.account);

  const startRequest = () => {
    if (requestAccounts.length === 1) openInAccount(requestAccounts[0]!.workspace.id, "/portal/requests/new");
    else setChoosingRequest(true);
  };
  const label = (account: UnifiedAccount) => accountLabel(account, withClient);

  const filterBar = filters.length > 0 && <div className="ltds-segmented unified-portal-filter" role="group" aria-label="Show items from">
    <button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All</button>
    {filters.map(business => <button key={business} type="button" aria-pressed={filter === business} onClick={() => setFilter(business)}>{business}</button>)}
  </div>;
  const problems = failed.length > 0 && <div className="unified-portal-problems" role="alert">
    {failed.map(result => <p key={result.account.workspace.id}><strong>{label(result.account)}</strong> couldn’t be loaded. {result.message}</p>)}
    <button type="button" className="button-ghost" onClick={() => setRetry(value => value + 1)}>Try again</button>
  </div>;
  const loadingNote = loading && <Skeleton variant="list" rows={3} label="Loading your projects and requests…" />;

  const projectCards = (items: UnifiedProject[]) => <div className="portal-project-grid">
    {items.map(item => <button key={item.key} type="button" className="portal-project-card ltds-card"
      onClick={() => openInAccount(item.account.workspace.id, `/portal/projects/${encodeURIComponent(item.projectId)}`)}>
      <div><span className="portal-project-ref unified-portal-business">{label(item.account)}</span>
        {item.status && <StatusPill tone="success">{item.status === "active" ? "Active" : item.status}</StatusPill>}</div>
      <h2>{item.projectName}</h2>
      <span className="portal-project-link">Open project →</span>
    </button>)}
  </div>;
  const requestRows = (items: UnifiedRequest[]) => <ul className="unified-portal-requests">
    {items.map(item => <li key={item.key}>
      <div><strong>{item.request.title}</strong>
        <small>{label(item.account)}{item.projectName ? ` · ${item.projectName}` : ""} · Updated {new Date(item.request.updatedAt).toLocaleDateString()}</small></div>
      <div className="unified-portal-request-actions">{renderStatus(item.request)}
        <button type="button" className="button-ghost button-small" onClick={() => openInAccount(item.account.workspace.id, "/portal/requests")}>View</button></div>
    </li>)}
  </ul>;
  const requestChooser = choosingRequest && <Card title="Who is this request for?" className="unified-portal-chooser">
    <p>Choose the business and client this request is for. It’s sent only to that account.</p>
    <div className="unified-portal-account-list">
      {requestAccounts.map(account => <button key={account.workspace.id} type="button" className="button-ghost"
        onClick={() => openInAccount(account.workspace.id, "/portal/requests/new")}>
        <strong>{account.business}</strong><small>{account.clientName}</small></button>)}
    </div>
    <button type="button" className="portal-text-action" onClick={() => setChoosingRequest(false)}>Cancel</button>
  </Card>;
  const accountDirectory = (title: string, detail: string, path: string, action: string) => <>
    <section className="portal-page-heading"><span className="eyebrow">Client portal</span><h1>{title}</h1><p>{detail}</p></section>
    <div className="unified-portal-account-list">
      {accounts.map(account => <Card key={account.workspace.id}>
        <strong>{account.business}</strong><p>{account.clientName}</p>
        <button type="button" className="button-orange" onClick={() => openInAccount(account.workspace.id, path)}>{action}</button>
      </Card>)}
    </div>
  </>;

  if (page === "deliveries") return accountDirectory("Deliveries", "Files delivered to you, grouped by the business that delivered them.", "/portal/deliveries", "Open deliveries");
  if (page === "feedback") return accountDirectory("Feedback", "Feedback you’ve shared, grouped by business.", "/portal/feedback", "Open feedback");
  if (page === "account") return accountDirectory("Account", "Your profile, team and access for each business you work with.", "/portal/account", "Open account settings");

  if (page === "projects") return <>
    <section className="portal-page-heading"><span className="eyebrow">Projects</span><h1>Projects</h1>
      <p>Every project you can open, from each Ledge Top business you work with.</p></section>
    {filterBar}{problems}{loadingNote}
    {!loading && projects.length === 0 ? <Card><EmptyState title="No projects available" detail="No projects are shared with you yet." /></Card> : projectCards(projects)}
  </>;

  if (page === "requests") return <>
    <section className="portal-page-heading portal-page-heading-action">
      <div><span className="eyebrow">Flight & service</span><h1>Service requests</h1><p>Requests across every business you work with.</p></div>
      {requestAccounts.length > 0 && <button type="button" className="button-orange" onClick={startRequest}>New request</button>}
    </section>
    {requestChooser}{filterBar}{problems}{loadingNote}
    <Card title="Request history">{!loading && requests.length === 0 ? <EmptyState title="No requests yet" detail="Requests you submit will appear here." /> : requestRows(requests)}</Card>
  </>;

  const openRequests = requests.filter(item => !CLOSED_REQUEST.has(item.request.status));
  return <>
    <section className="portal-welcome"><span className="eyebrow">Client portal</span><h1>{displayName}</h1>
      <p>Projects, files and service requests from every Ledge Top business you work with, in one place.</p></section>
    {filterBar}{problems}
    <div className="portal-stat-grid">
      <Card><span className="portal-stat">{loading && !ready.length ? "…" : projects.length}</span><strong>Projects</strong>
        <button type="button" className="portal-text-action" onClick={() => navigate("projects")}>View projects</button></Card>
      <Card><span className="portal-stat">{loading && !ready.length ? "…" : openRequests.length}</span><strong>Open requests</strong>
        <button type="button" className="portal-text-action" onClick={() => navigate("requests")}>View requests</button></Card>
    </div>
    {requestChooser}
    <Card title="Your projects">{loadingNote}{!loading && projects.length === 0 ? <EmptyState title="No projects available" detail="No projects are shared with you yet." /> : projectCards(projects.slice(0, 6))}</Card>
    <Card title="Recent requests" action={requestAccounts.length > 0 ? <button type="button" className="button-ghost button-small" onClick={startRequest}>New request</button> : undefined}>
      {requests.length === 0 ? <p>No requests yet.</p> : requestRows(requests.slice(0, 5))}</Card>
    {supplement}
  </>;
}
