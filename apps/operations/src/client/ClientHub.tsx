import { useEffect, useRef, useState, type ReactNode } from "react";
import { Card, EmptyState, Loading, StatusPill } from "@ltds/ui";
import type { Permission } from "@ltds/shared";
import { api, ApiError } from "./api";
import { ClientRequestWorkflow } from "./ClientRequestWorkflow";
import { ClientPortalAccessPanel, type PortalIdentityPage } from "./ClientPortalAccessPanel";
import { ClientExternalAccessRoster, type ExternalAccessResult } from "./ClientExternalAccessRoster";
import { ClientServiceAssignments, type ClientServiceAssignmentResult } from "./ClientServiceAssignments";
import { businessProjectHref } from "./business-project-route";
import { ClientDirectory, clientDirectoryReturnPath, clientPortalStatus, type ClientSummary, type ClientHubCapabilities, type ClientRootNamespace } from "./ClientDirectory";
import { ClientBusinessParty, SourceBusinessParty, type BusinessPartyReference } from "./ClientBusinessParty";
import { ClientBusinessActivity } from "./ClientBusinessActivity";
import { ClientAuditTimeline } from "./ClientAuditTimeline";
import { ClientInvitationPolicy } from "./ClientInvitationPolicy";
import type { InvitationAdministrationAccess } from "./invitation-administration-api";

interface CollectionItem { row_key?: string }
interface ClientContact extends CollectionItem {
  contact_key?: string;
  record_type: "business_contact";
  public_id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
}
interface ClientDetailResponse {
  client: ClientSummary;
  contacts: ClientContact[];
  accounts: Array<CollectionItem & { id: string; display_name: string; status: string }>;
  projects: Array<CollectionItem & { id: string; account_id?: string; project_name: string; client_name: string; active: number; can_request_service: number }>;
  requests: Array<CollectionItem & { id: string; title: string; status: string; project_name: string | null; created_at: string }>;
  deliveryGrants: Array<CollectionItem & { share_id: string; account_id?: string; label: string | null; r2_prefix: string; project_name: string; revoked_at: string | null; expires_at: string | null }>;
  authenticatedDeliveryGrants: Array<CollectionItem & { id: string; status: string; r2_prefix: string; audience_type: string; expires_at: string | null }>;
  viewerGrants: Array<CollectionItem & { id: string; status: string; scope_type: string; project_name: string; model_title: string | null; authorization_expires_at: string | null }>;
  capabilities: ClientHubCapabilities;
  contextVersion?: string;
  pages?: Partial<Record<ClientCollectionName, ClientCollectionPage>>;
  portalIdentities?: PortalIdentityPage;
  externalAccess?: ExternalAccessResult;
  serviceAssignments?: ClientServiceAssignmentResult;
  businessProjects?: BusinessProject[];
  businessParty?: BusinessPartyReference | null;
  canManageBusinessParties?: boolean;
}
interface BusinessProject extends CollectionItem { id: string; name: string; status: string | null; start_date: string | null; end_date: string | null; manager_name: string | null; created_at: string | null }
type ClientCollectionName = "businessContacts" | "businessProjects" | "accounts" | "projects" | "requests" | "deliveryGrants" | "authenticatedDeliveryGrants" | "viewerGrants";
interface ClientCollectionPage {
  available: boolean;
  reason: null | "permission_required" | "workspace_unavailable" | "not_applicable";
  nextCursor: string | null;
  hasMore: boolean;
  returned: number;
  limit: number;
}
interface CanonicalClientRoot { sourceId: string; rootNamespace: ClientRootNamespace; kind: ClientSummary["kind"]; publicId: string }

function utcDate(value: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value);
}
function date(value?: string | null): string {
  if (value === null || value === undefined) return "No expiry";
  const parsed = utcDate(value);
  return Number.isNaN(parsed.valueOf()) ? value || "Unknown date" : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function tone(status: string): "neutral" | "success" | "warning" | "danger" {
  return status === "active" || status === "accepted_linked" || status === "completed"
    ? "success"
    : status === "revoked" || status === "blocked" || status === "declined" || status === "cancelled"
      ? "danger"
      : status === "submitted" || status === "under_review" || status === "expired"
        ? "warning"
        : "neutral";
}

function GrantStatus({ status, expiresAt }: { status: string; expiresAt: string | null }) {
  const timestamp = expiresAt === null ? null : utcDate(expiresAt).valueOf();
  const current = status !== "active" || timestamp === null ? status
    : !Number.isFinite(timestamp) ? "expiry_unverified" : timestamp <= Date.now() ? "expired" : status;
  return <StatusPill tone={current === "expiry_unverified" ? "warning" : tone(current)}>{current === "expiry_unverified" ? "Expiry not verified" : current}</StatusPill>;
}

function useClientHub<T>(path: string | null) {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: string }>({ path: null, data: null, error: "" });
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState({ path, data: null, error: "" });
    if (!path) return () => { active = false; };
    void api<T>(path, { signal: controller.signal }).then(value => { if (active) setState({ path, data: value, error: "" }); })
      .catch(caught => { if (active) setState({ path, data: null, error: caught instanceof Error ? caught.message : "Client Hub could not be loaded" }); });
    return () => { active = false; controller.abort(); };
  }, [path]);
  return state.path === path ? state : { data: null, error: "" };
}

interface ClientRoute { kind: "organizations" | "standalone"; publicId: string; sourceId?: string; rootNamespace?: ClientRootNamespace }
function clientRoute(): ClientRoute | { invalid: true } | null {
  const parts = location.pathname.split("/").filter(Boolean);
  if (parts[0] !== "clients") return null;
  const sourced = parts[1] === "sources", namespaced = sourced && parts.length === 6;
  const kindIndex = sourced ? namespaced ? 4 : 3 : 1, kind = parts[kindIndex];
  if (!sourced && !["organizations", "standalone"].includes(kind || "")) return null;
  if (parts.length !== (sourced ? namespaced ? 6 : 5 : 3) || !["organizations", "standalone"].includes(kind || "")
    || (namespaced && !["business", "portal", "account"].includes(parts[3] || ""))) return { invalid: true };
  try {
    return { kind: kind as ClientRoute["kind"], publicId: decodeURIComponent(parts[kindIndex + 1]!),
      ...(namespaced ? { rootNamespace: parts[3] as ClientRootNamespace } : {}),
      ...(sourced ? { sourceId: decodeURIComponent(parts[2]!) } : {}) };
  } catch { return { invalid: true }; }
}

function collectionKey(collection: ClientCollectionName, item: CollectionItem): string {
  if (item.row_key) return item.row_key;
  const row = item as Record<string, unknown>;
  return JSON.stringify([collection, row.account_id || "", row.workspace_id || "", row.contact_key || row.id || row.share_id || row.public_id]);
}

function rootIdentity(root: CanonicalClientRoot): string {
  return JSON.stringify([root.sourceId, root.rootNamespace, root.kind, root.publicId]);
}

function ClientCollection<T extends CollectionItem>({ collection, label, initial, page: initialPage, client, contextVersion,
  contextSignal, onInvalidated, emptyTitle, emptyDetail, children, requestParams }: {
  collection: ClientCollectionName; label: string; initial: T[]; page?: ClientCollectionPage; client: ClientSummary;
  contextVersion?: string; contextSignal: AbortSignal; onInvalidated: (message: string) => void; emptyTitle: string; emptyDetail: string;
  children: (items: T[]) => ReactNode;
  requestParams?: Record<string, string>;
}) {
  const [items, setItems] = useState(initial);
  const [page, setPage] = useState(initialPage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [continued, setContinued] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const abort = () => { sequence.current += 1; controller.current?.abort(); };
    contextSignal.addEventListener("abort", abort);
    return () => { active.current = false; abort(); contextSignal.removeEventListener("abort", abort); };
  }, [contextSignal]);
  const load = async () => {
    if (contextSignal.aborted || controller.current || !page?.available || !page.nextCursor || !client.source_id || !client.root_namespace || !contextVersion) return;
    const expectedRoot: CanonicalClientRoot = { sourceId: client.source_id, rootNamespace: client.root_namespace, kind: client.kind, publicId: client.public_id };
    const abort = new AbortController(), request = ++sequence.current;
    controller.current = abort;
    setBusy(true); setError("");
    try {
      const parameters = new URLSearchParams({ ...requestParams, limit: "25", cursor: page.nextCursor });
      const path = `/api/client-hub/sources/${encodeURIComponent(client.source_id)}/${client.root_namespace}/${client.route_kind}/${encodeURIComponent(client.public_id)}/collections/${collection}?${parameters}`;
      const result = await api<{ items: T[]; page: ClientCollectionPage; canonicalRoot: CanonicalClientRoot; contextVersion: string }>(path, { signal: abort.signal });
      if (!active.current || contextSignal.aborted || abort.signal.aborted || sequence.current !== request) return;
      if (!result.canonicalRoot || rootIdentity(result.canonicalRoot) !== rootIdentity(expectedRoot) || result.contextVersion !== contextVersion)
        throw new ApiError("The client context changed. Refresh this workspace before continuing.", 409, {});
      if (!result.page?.available) throw new ApiError("Access to this section changed. Refresh this workspace.", 403, {});
      if (!Array.isArray(result.items) || (result.page.hasMore && (!result.page.nextCursor || result.page.nextCursor === page.nextCursor)))
        throw new ApiError("This page could not be continued safely. Refresh the client workspace.", 409, {});
      setItems(previous => {
        const combined = new Map(previous.map(item => [collectionKey(collection, item), item]));
        for (const item of result.items) combined.set(collectionKey(collection, item), item);
        return [...combined.values()];
      });
      setPage(result.page);
      setContinued(true);
    } catch (caught) {
      if (!active.current || contextSignal.aborted || abort.signal.aborted || sequence.current !== request) return;
      const message = caught instanceof Error ? caught.message : "These records could not be loaded.";
      if (caught instanceof ApiError && [401, 403, 404, 409].includes(caught.status)) {
        setItems([]); setPage(undefined);
        onInvalidated(message);
      } else setError(message);
    } finally {
      if (active.current && !contextSignal.aborted && !abort.signal.aborted && sequence.current === request) {
        controller.current = null; setBusy(false);
      }
    }
  };
  if (page?.available === false) return <section className="client-hub-collection" aria-label={label}>
    <p className="muted">{page.reason === "permission_required" ? "Permission is required to view these records."
      : page.reason === "workspace_unavailable" ? "A verified portal workspace is required for these records."
        : "This collection does not apply to this client record."}</p>
  </section>;
  const canContinue = Boolean(page?.hasMore && page.nextCursor && client.source_id && client.root_namespace && contextVersion);
  return <section className="client-hub-collection" aria-label={label} aria-busy={busy}>
    {items.length ? children(items) : <EmptyState title={emptyTitle} detail={emptyDetail} />}
    <p className="client-hub-collection-status" role="status">{items.length.toLocaleString()} shown{busy ? " · Loading more…" : ""}</p>
    {error && <div className="client-hub-collection-error" role="alert"><p>{error}</p></div>}
    {(error || canContinue || continued) && <button type="button" className="button-ghost" aria-disabled={busy || !canContinue} onClick={() => { if (!busy && canContinue) void load(); }}>
      {busy ? `Loading ${label.toLowerCase()}…` : error ? `Retry ${label.toLowerCase()}` : canContinue ? `Load more ${label.toLowerCase()}` : `All ${label.toLowerCase()} loaded`}</button>}
    {page?.hasMore && !canContinue && <p className="muted">More records are available. Refresh the client workspace to continue.</p>}
  </section>;
}

function ContactList({ contacts }: { contacts: ClientContact[] }) {
  if (!contacts.length) return <EmptyState title="No business contacts" detail="Business contact records will appear here after synchronization." />;
  return <div className="client-hub-contact-list">{contacts.map(contact => {
    return <article key={collectionKey("businessContacts", contact)}>
      <div>
        <strong>{contact.display_name}</strong>
        {contact.email && <small>Email: {contact.email}</small>}
        {contact.phone && <small>Phone: {contact.phone}</small>}
        {!contact.email && !contact.phone && <small>No contact details provided by Project Alpha</small>}
      </div>
      <StatusPill tone="neutral">contact</StatusPill>
      <small>Contact records do not grant portal access</small>
    </article>;
  })}</div>;
}

function BusinessProjects({ initial, page, client, contextVersion, contextSignal, onInvalidated }: {
  initial: BusinessProject[]; page?: ClientCollectionPage; client: ClientSummary; contextVersion?: string;
  contextSignal: AbortSignal; onInvalidated: (message: string) => void;
}) {
  const readFilter = () => {
    const value = new URLSearchParams(location.search).get("business_status");
    return value === "current" || value === "completed" || value === "cancelled" ? value : "all";
  };
  const [filter, setFilter] = useState(readFilter);
  const [state, setState] = useState({ filter: "all", items: initial, page, busy: false, error: "", revision: 0 });
  const pending = useRef<AbortController | null>(null), active = useRef(true), sequence = useRef(0);
  const initialConsumed = useRef(false);
  useEffect(() => {
    active.current = true;
    const abort = () => { sequence.current += 1; pending.current?.abort(); };
    const sync = () => setFilter(readFilter());
    addEventListener("popstate", sync);
    contextSignal.addEventListener("abort", abort);
    return () => { active.current = false; abort(); removeEventListener("popstate", sync); contextSignal.removeEventListener("abort", abort); };
  }, [contextSignal]);
  const load = async (next: string) => {
    if (contextSignal.aborted || !client.source_id || !client.root_namespace || !contextVersion) return;
    pending.current?.abort();
    const abort = new AbortController(), request = ++sequence.current;
    pending.current = abort;
    setState(value => ({ ...value, filter: next, items: [], page: undefined, busy: true, error: "" }));
    try {
      const parameters = new URLSearchParams({ filter: next, limit: "5" });
      const result = await api<{ items: BusinessProject[]; page: ClientCollectionPage; canonicalRoot: CanonicalClientRoot; contextVersion: string }>(
        `/api/client-hub/sources/${encodeURIComponent(client.source_id)}/${client.root_namespace}/${client.route_kind}/${encodeURIComponent(client.public_id)}/collections/businessProjects?${parameters}`, { signal: abort.signal });
      if (!active.current || contextSignal.aborted || abort.signal.aborted || sequence.current !== request) return;
      if (result.contextVersion !== contextVersion || !result.canonicalRoot || rootIdentity(result.canonicalRoot) !== rootIdentity({ sourceId: client.source_id, rootNamespace: client.root_namespace, kind: client.kind, publicId: client.public_id }))
        throw new ApiError("This client's business project context changed. Refresh the workspace.", 409, {});
      if (!result.page?.available) throw new ApiError("Access to business projects changed. Refresh this workspace.", 403, {});
      if (!Array.isArray(result.items) || (result.page.hasMore && !result.page.nextCursor))
        throw new ApiError("Business projects could not be loaded safely. Refresh this workspace.", 409, {});
      setState(value => ({ filter: next, items: result.items, page: result.page, busy: false, error: "", revision: value.revision + 1 }));
    } catch (error) {
      if (!active.current || contextSignal.aborted || abort.signal.aborted || sequence.current !== request) return;
      const message = error instanceof Error ? error.message : "Business projects could not be loaded.";
      if (error instanceof ApiError && [401, 403, 404, 409].includes(error.status)) onInvalidated(message);
      else setState(value => ({ ...value, busy: false, error: message }));
    }
  };
  useEffect(() => {
    if (page?.available === false) return;
    if (!initialConsumed.current && filter === "all") { initialConsumed.current = true; return; }
    initialConsumed.current = true;
    void load(filter);
  }, [filter]);
  const selectFilter = (next: string) => {
    const url = new URL(location.href);
    if (next === "all") url.searchParams.delete("business_status"); else url.searchParams.set("business_status", next);
    history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
    setFilter(next);
  };
  const calendarDate = (value: string | null) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : value ? date(value) : "Not set";
  return <Card title="Business projects">
    <p>Projects recorded for this client in Project Alpha. This list does not grant portal or delivery access.</p>
    {page?.available !== false && <label className="client-hub-business-filter">Project status<select value={filter} onChange={event => selectFilter(event.target.value)}>
      <option value="all">All projects</option><option value="current">Current projects</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option>
    </select></label>}
    {state.busy || (page?.available !== false && state.filter !== filter) ? <p role="status">Loading business projects…</p> : state.error ? <div role="alert"><p>{state.error}</p><button className="button-ghost" type="button" onClick={() => void load(filter)}>Retry business projects</button></div>
      : <ClientCollection key={`${state.filter}:${state.revision}`} collection="businessProjects" label="Business projects" initial={state.items} page={state.page}
        client={client} contextVersion={contextVersion} contextSignal={contextSignal} onInvalidated={onInvalidated} requestParams={{ filter }}
        emptyTitle="No matching business projects" emptyDetail="Try another status. Shared work and portal access are listed separately.">
        {items => <div className="simple-rows">{items.map(project => {
          const href = businessProjectHref(client, project.id);
          return <div key={collectionKey("businessProjects", project)}><div>
          {href ? <a className="client-hub-project-link" href={href}><strong>{project.name}</strong></a> : <strong>{project.name}</strong>}
          <small>{project.manager_name ? `Manager: ${project.manager_name}` : "Manager not recorded"}</small>
          <small>Start: {calendarDate(project.start_date)} · End: {calendarDate(project.end_date)}</small>
          {project.created_at && <small>Project created: {date(project.created_at)}</small>}</div>
          <StatusPill tone={project.status === "overdue" ? "warning" : tone(project.status || "")}>{project.status?.replaceAll("_", " ") || "Status not recorded"}</StatusPill></div>;
        })}</div>}
      </ClientCollection>}
  </Card>;
}

function ClientWorkspace({ route, canReviewFeedback, invitationAccess }: { route: ClientRoute; canReviewFeedback: boolean; invitationAccess?: InvitationAdministrationAccess }) {
  const [revision, setRevision] = useState(0);
  const [invalidated, setInvalidated] = useState("");
  const [portalFeedback, setPortalFeedback] = useState("");
  const contextController = useRef<AbortController | null>(null);
  if (!contextController.current) contextController.current = new AbortController();
  const refresh = () => {
    contextController.current?.abort();
    contextController.current = new AbortController();
    setInvalidated("");
    setRevision(value => value + 1);
  };
  const invalidate = (message: string) => {
    // Invalidate every in-flight section immediately, before React removes the old workspace.
    contextController.current?.abort();
    setPortalFeedback("");
    setInvalidated(message);
  };
  const sourcePath = route.sourceId ? `sources/${encodeURIComponent(route.sourceId)}/${route.rootNamespace ? `${route.rootNamespace}/` : ""}` : "";
  const state = useClientHub<ClientDetailResponse>(invalidated ? null : `/api/client-hub/${sourcePath}${route.kind}/${encodeURIComponent(route.publicId)}?revision=${revision}`);
  if (invalidated) return <Card><div role="alert"><EmptyState title="Client workspace needs refreshing" detail={invalidated} /></div>
    <button type="button" className="button-orange" onClick={refresh}>Refresh client workspace</button>
    <a className="button-ghost" href={clientDirectoryReturnPath()}>Back to Client Hub</a>
  </Card>;
  if (!state.data && !state.error) return <Loading />;
  if (!state.data) return <Card><EmptyState title="Client workspace unavailable" detail={state.error} />
    <button type="button" className="button-orange" onClick={refresh}>Retry client workspace</button>
    <a className="button-ghost" href={clientDirectoryReturnPath()}>Back to Client Hub</a>
  </Card>;
  const data = state.data;
  const collectionProps = { client: data.client, contextVersion: data.contextVersion, contextSignal: contextController.current.signal, onInvalidated: invalidate };
  const portalBasePath = data.client.source_id && data.client.root_namespace
    ? `/api/client-hub/sources/${encodeURIComponent(data.client.source_id)}/${data.client.root_namespace}/${data.client.route_kind}/${encodeURIComponent(data.client.public_id)}` : null;
  return <>
    <a className="button-ghost button-small client-hub-back" href={clientDirectoryReturnPath()}>← Client Hub</a>
    <div className="client-hub-title">
      <div><small>{data.client.kind === "organization" ? "Organization" : "Standalone client"}</small><h2>{data.client.display_name}</h2>
        {data.client.source_name && <p>{data.client.source_name}</p>}
        {data.client.root_namespace === "portal" && <p>Portal workspace · business link pending</p>}</div>
      <StatusPill tone={clientPortalStatus(data.client).tone}>{clientPortalStatus(data.client).label}</StatusPill>
    </div>
    <SourceBusinessParty key={revision} client={data.client} party={data.businessParty} canManage={data.canManageBusinessParties}
      contextSignal={collectionProps.contextSignal} onInvalidated={invalidate} onRefresh={refresh} />
    <p className="client-hub-inventory-note">{data.businessProjects ? "Business projects are separate from the work shared with this client and their portal access." : "These sections show work shared with this client. Full business project history is separate."}</p>
    <div className="dashboard-grid client-hub-detail-grid" key={revision}>
      <Card title="Business contacts">
        <ClientCollection {...collectionProps} collection="businessContacts" label="Business contacts" initial={data.contacts.filter(contact => contact.record_type === "business_contact")} page={data.pages?.businessContacts}
          emptyTitle="No business contacts" emptyDetail="Synchronized business contact records will appear here. They do not grant login access.">
          {items => <ContactList contacts={items} />}
        </ClientCollection>
      </Card>
      {data.externalAccess && portalBasePath && data.client.source_id && data.client.root_namespace && <div className="client-hub-audit-panel">
        <ClientExternalAccessRoster initialPage={data.externalAccess} basePath={portalBasePath}
          contextVersion={data.contextVersion || data.externalAccess.contextVersion}
          canonicalRoot={{ sourceId: data.client.source_id, rootNamespace: data.client.root_namespace, kind: data.client.kind, publicId: data.client.public_id }}
          contextSignal={collectionProps.contextSignal} onInvalidated={invalidate} />
      </div>}
      {data.serviceAssignments && portalBasePath && data.client.source_id && data.client.root_namespace && <div className="client-hub-audit-panel">
        <ClientServiceAssignments initialPage={data.serviceAssignments} basePath={portalBasePath}
          contextVersion={data.contextVersion || data.serviceAssignments.contextVersion}
          canonicalRoot={{ sourceId: data.client.source_id, rootNamespace: data.client.root_namespace, kind: data.client.kind,
            publicId: data.client.public_id }} contextSignal={collectionProps.contextSignal} onInvalidated={invalidate} />
      </div>}
      {data.client.workspace_id && data.client.source_id === "project-alpha:primary" && (invitationAccess?.enabled && invitationAccess.canManagePolicy ? <ClientInvitationPolicy key={`${data.client.source_id}:${data.client.workspace_id}:${revision}`} workspaceId={data.client.workspace_id} sourceId={data.client.source_id} contextSignal={collectionProps.contextSignal} onInvalidated={invalidate} /> : invitationAccess?.error ? <Card title="Invitation policy"><p role="alert">{invitationAccess.error}</p></Card> : null)}
      {data.portalIdentities ? portalBasePath ? <ClientPortalAccessPanel initialPage={data.portalIdentities} basePath={portalBasePath}
        contextVersion={data.contextVersion || data.portalIdentities.contextVersion} contextSignal={collectionProps.contextSignal} onInvalidated={invalidate}
        feedback={portalFeedback} onChanged={message => { if (!collectionProps.contextSignal.aborted) { setPortalFeedback(message); refresh(); } }} />
        : <Card title="Portal logins"><p>Refresh this client workspace before viewing portal logins.</p></Card>
        : <Card title="Portal logins"><p>Portal login information is unavailable. Refresh this client workspace to try again.</p></Card>}
      <Card title="Accounts"><ClientCollection {...collectionProps} collection="accounts" label="Accounts" initial={data.accounts} page={data.pages?.accounts}
        emptyTitle="No accounts" emptyDetail="No linked portal account is active.">
        {items => <div className="simple-rows">{items.map(account => <div key={collectionKey("accounts", account)}><div><strong>{account.display_name}</strong><small>Explicit account record</small>{canReviewFeedback && <a href={`/operations/feedback?accountId=${encodeURIComponent(account.id)}`}>View client feedback</a>}</div><StatusPill tone={tone(account.status)}>{account.status}</StatusPill></div>)}</div>}
      </ClientCollection></Card>
      {data.businessProjects && <BusinessProjects {...collectionProps} initial={data.businessProjects} page={data.pages?.businessProjects} />}
      {data.client.root_namespace === "business" && data.client.source_id && data.contextVersion && <ClientBusinessActivity
        root={{ sourceId: data.client.source_id, rootNamespace: "business", kind: data.client.kind, publicId: data.client.public_id }}
        contextVersion={data.contextVersion} contextSignal={collectionProps.contextSignal} onInvalidated={invalidate} />}
      {data.client.source_id && data.client.root_namespace && data.contextVersion && <div className="client-hub-audit-panel"><ClientAuditTimeline
        root={{ sourceId: data.client.source_id, rootNamespace: data.client.root_namespace, kind: data.client.kind, publicId: data.client.public_id }}
        contextVersion={data.contextVersion} contextSignal={collectionProps.contextSignal} onInvalidated={invalidate} /></div>}
      <Card title="Shared projects"><ClientCollection {...collectionProps} collection="projects" label="Shared projects" initial={data.projects} page={data.pages?.projects}
        emptyTitle="No project access" emptyDetail="Projects remain unavailable until explicitly granted.">
        {items => <div className="simple-rows">{items.map(project => <div key={collectionKey("projects", project)}><div><strong>{project.project_name}</strong><small>{project.client_name} · {project.can_request_service ? "Requests allowed" : "View access only"}</small></div><StatusPill tone={project.active ? "success" : "neutral"}>{project.active ? "active" : "inactive"}</StatusPill></div>)}</div>}
      </ClientCollection></Card>
      {data.capabilities.delivery && <Card title="Delivery access">
        <h3 className="client-hub-subheading">Delivery links</h3>
        <ClientCollection {...collectionProps} collection="deliveryGrants" label="Delivery links" initial={data.deliveryGrants} page={data.pages?.deliveryGrants}
          emptyTitle="No delivery links" emptyDetail="Folders and files remain unavailable until explicitly shared.">
          {items => <div className="simple-rows">{items.map(grant => <div key={collectionKey("deliveryGrants", grant)}><div><strong>{grant.label || grant.project_name}</strong><small>{grant.r2_prefix} · {date(grant.expires_at)}</small></div><GrantStatus status={grant.revoked_at ? "revoked" : "active"} expiresAt={grant.expires_at} /></div>)}</div>}
        </ClientCollection>
        <h3 className="client-hub-subheading">Client portal deliveries</h3>
        <ClientCollection {...collectionProps} collection="authenticatedDeliveryGrants" label="Client portal deliveries" initial={data.authenticatedDeliveryGrants} page={data.pages?.authenticatedDeliveryGrants}
          emptyTitle="No client portal deliveries" emptyDetail="No delivery content has been shared through this client's portal.">
          {items => <div className="simple-rows">{items.map(grant => <div key={collectionKey("authenticatedDeliveryGrants", grant)}><div><strong>{grant.r2_prefix}</strong><small>{grant.audience_type} audience · {date(grant.expires_at)}</small></div><GrantStatus status={grant.status} expiresAt={grant.expires_at} /></div>)}</div>}
        </ClientCollection>
      </Card>}
      {data.capabilities.viewer && <Card title="Shared models"><ClientCollection {...collectionProps} collection="viewerGrants" label="Shared models" initial={data.viewerGrants} page={data.pages?.viewerGrants}
        emptyTitle="No Viewer access" emptyDetail="Models remain unavailable until explicitly granted.">
        {items => <div className="simple-rows">{items.map(grant => <div key={collectionKey("viewerGrants", grant)}><div><strong>{grant.model_title || grant.project_name}</strong><small>{grant.scope_type} access · {date(grant.authorization_expires_at)}</small></div><GrantStatus status={grant.status} expiresAt={grant.authorization_expires_at} /></div>)}</div>}
      </ClientCollection></Card>}
      {data.capabilities.requests && <Card title="Request history"><ClientCollection {...collectionProps} collection="requests" label="Requests" initial={data.requests} page={data.pages?.requests}
        emptyTitle="No requests" emptyDetail="This client has not submitted a service request.">
        {items => <div className="simple-rows">{items.map(request => <a key={collectionKey("requests", request)} href={`/clients/requests/${encodeURIComponent(request.id)}`}><div><strong>{request.title}</strong><small>{request.project_name || "Account request"} · {date(request.created_at)}</small></div><StatusPill tone={tone(request.status)}>{request.status.replaceAll("_", " ")}</StatusPill></a>)}</div>}
      </ClientCollection></Card>}
    </div>
  </>;
}

export function ClientHub({ mapToken, permissions, feedbackEnabled=false, invitationAccess }: { mapToken: string | null; permissions: Permission[]; feedbackEnabled?: boolean; invitationAccess?: InvitationAdministrationAccess }) {
  const [, setLocationRevision] = useState(0);
  useEffect(() => {
    const sync = () => setLocationRevision(value => value + 1);
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  const selectedRequest = location.pathname.startsWith("/clients/requests/") || location.pathname.startsWith("/operations/client-requests/");
  const route = clientRoute();
  const canReview = permissions.includes("operations.manage");
  const canViewDirectory = permissions.includes("team.view");
  if (location.pathname.startsWith("/clients/parties/")) {
    let partyId = "";
    try { const parts = location.pathname.split("/").filter(Boolean); if (parts.length === 3) partyId = decodeURIComponent(parts[2]!); } catch { /* Invalid encoded routes fail closed. */ }
    return canViewDirectory && partyId ? <ClientBusinessParty key={partyId} partyId={partyId} />
      : <Card><EmptyState title="Linked customer unavailable" detail={canViewDirectory ? "This customer link is invalid." : "Client-directory access is required."} /><a href={clientDirectoryReturnPath()}>Back to Client Hub</a></Card>;
  }
  if (selectedRequest)
    return canReview ? <ClientRequestWorkflow mapToken={mapToken} basePath="/clients/requests" /> : <Card><EmptyState title="Request unavailable" detail="Request-review access is required." /></Card>;
  if (route && "invalid" in route) return <Card><EmptyState title="Client workspace unavailable" detail="This client link is invalid." /><a href={clientDirectoryReturnPath()}>Back to Client Hub</a></Card>;
  if (route) return canViewDirectory ? <ClientWorkspace key={JSON.stringify([route.sourceId || "", route.rootNamespace || "", route.kind, route.publicId])} route={route} canReviewFeedback={feedbackEnabled} invitationAccess={invitationAccess} /> : <Card><EmptyState title="Client unavailable" detail="Client-directory access is required." /></Card>;
  return <>
    {canReview && <section className="client-hub-queue"><ClientRequestWorkflow mapToken={mapToken} basePath="/clients/requests" pendingOnly /></section>}
    {canViewDirectory && <section>
      <div className="client-hub-section-heading"><div><h2>Clients</h2><p>Organizations and standalone clients with their contacts, access, and shared work.</p></div></div>
      <ClientDirectory />
    </section>}
  </>;
}
