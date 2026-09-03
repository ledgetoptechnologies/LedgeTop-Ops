import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Card, EmptyState, StatusPill } from "@ltds/ui";
import { api, ApiError } from "./api";

export type ClientKind = "organization" | "standalone_client";
export type ClientRootNamespace = "business" | "portal" | "account";
export interface ClientSummary {
  workspace_id: string | null;
  kind: ClientKind;
  route_kind: "organizations" | "standalone";
  public_id: string;
  display_name: string;
  status: string;
  portal_status: string;
  account_count: number;
  project_count: number;
  request_count: number;
  contact_count?: number;
  contacts?: unknown[];
  detail_path?: string;
  source_id?: string;
  source_name?: string;
  root_namespace?: ClientRootNamespace;
  pa_public_id?: string | null;
  business_party_id?: string | null;
  business_party_name?: string | null;
  business_party_member_count?: number;
  meaningful_activity_at?: string | null;
}
export interface ClientHubCapabilities {
  directory: boolean;
  requests: boolean;
  delivery: boolean;
  viewer: boolean;
}
interface DirectoryResponse {
  clients: ClientSummary[];
  sources?: Array<{ source_id: string; display_name: string }>;
  nextCursor?: string | null;
  indexUpdatedAt?: string | null;
  activityAsOf?: string;
  activityCoverage?: "project_alpha_business_records";
  searchCapabilities?: { businessContacts: boolean; portalContacts: boolean; portalContactMinimumQueryLength?: number };
  capabilities: ClientHubCapabilities;
}
interface DirectoryQuery { q: string; kind: ClientKind | "all"; source: string; sort: "recent" | "name" }
const FILTERS: Array<{ kind: DirectoryQuery["kind"]; label: string }> = [
  { kind: "all", label: "All" },
  { kind: "organization", label: "Organizations" },
  { kind: "standalone_client", label: "Individual Clients" },
];

function readQuery(search = location.search): DirectoryQuery {
  const parameters = new URLSearchParams(search), kind = parameters.get("kind");
  return { q: (parameters.get("q") || "").trim(),
    kind: kind === "organization" || kind === "standalone_client" ? kind : "all", source: parameters.get("source") || "",
    sort: parameters.get("sort") === "name" ? "name" : "recent" };
}

function queryString(query: DirectoryQuery): string {
  const parameters = new URLSearchParams();
  if (query.q) parameters.set("q", query.q);
  if (query.kind !== "all") parameters.set("kind", query.kind);
  if (query.source) parameters.set("source", query.source);
  if (query.sort === "name") parameters.set("sort", query.sort);
  const value = parameters.toString();
  return value ? `?${value}` : "";
}

export function clientDirectoryReturnPath(): string {
  return `/clients${queryString(readQuery())}`;
}

function detailPath(client: ClientSummary, query: DirectoryQuery): string {
  const sourcePath = client.source_id ? `sources/${encodeURIComponent(client.source_id)}/${client.root_namespace ? `${client.root_namespace}/` : ""}` : "";
  const fallback = `/clients/${sourcePath}${client.route_kind}/${encodeURIComponent(client.public_id)}`;
  let pathname = fallback;
  if (client.detail_path) {
    try {
      const candidate = new URL(client.detail_path, location.origin);
      if (candidate.origin === location.origin && candidate.pathname.startsWith("/clients/"))
        pathname = candidate.pathname;
    } catch { /* Fall back to the existing, encoded client route. */ }
  }
  return `${pathname}${queryString(query)}`;
}

function clientKey(client: ClientSummary): string {
  if (client.business_party_id) return JSON.stringify(["party", client.business_party_id]);
  return JSON.stringify([client.source_id || "", client.root_namespace || "", client.kind, client.public_id]);
}

function number(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString() : "0";
}

function refreshedTime(value: string | null | undefined): string | null {
  if (!value) return null;
  // Database UTC timestamps may omit the ISO separator and timezone.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z` : value;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Accept explicit ISO instants or database UTC timestamps, never guessed locale dates. */
export function businessTimestamp(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const sql = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value);
  const normalized = sql ? `${value.replace(" ", "T")}Z` : value;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(normalized);
  if (!match || match[0] !== normalized || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return null;
  const calendar = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (!Number.isFinite(calendar.valueOf()) || calendar.toISOString().slice(0, 10) !== `${match[1]}-${match[2]}-${match[3]}`) return null;
  const date = new Date(normalized);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}
function ClientBusinessUpdate({ value, asOf }: { value?: string | null; asOf: string | null }) {
  const timestamp = businessTimestamp(value), observedAt = businessTimestamp(asOf);
  const verified = timestamp && (asOf === null || (observedAt && timestamp <= observedAt)) ? timestamp : null;
  return <dl className="client-directory-update"><dt>Last business update</dt><dd>{verified
    ? <time dateTime={verified}>{new Date(verified).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time>
    : value === null || value === undefined ? "No business update recorded" : "Business update unavailable"}</dd></dl>;
}

function statusTone(status: string): "neutral" | "success" | "warning" | "danger" {
  return status === "active" ? "success" : ["blocked", "revoked", "closed"].includes(status)
    ? "danger" : status === "suspended" ? "warning" : "neutral";
}

export function clientPortalStatus(client: ClientSummary): { label: string; tone: "neutral" | "success" | "warning" | "danger"; description?: string } {
  if (client.portal_status === "not_supported")
    return { label: "Portal unavailable for this source", tone: "neutral" as const };
  if (client.portal_status === "mapping_conflict")
    return { label: "Portal link needs review", tone: "warning" as const };
  if (client.portal_status === "mapping_unavailable" || (client.root_namespace === "business" && !client.pa_public_id && !client.workspace_id))
    return { label: "No portal workspace linked", tone: "neutral" as const,
      description: "This Project Alpha business record has no exact portal workspace mapping. This is not an access approval decision." };
  return { label: client.portal_status === "not_provisioned" ? "Portal not set up" : client.portal_status.replaceAll("_", " "),
    tone: statusTone(client.portal_status) };
}

function ClientPortalStatusPill({ client }: { client: ClientSummary }) {
  const portal = clientPortalStatus(client);
  return <span className="client-directory-portal-state"
    aria-label={portal.description ? `${portal.label}. ${portal.description}` : portal.label}
    title={portal.description}><StatusPill tone={portal.tone}>{portal.label}</StatusPill></span>;
}

export function ClientDirectory() {
  const [query, setQuery] = useState(readQuery);
  const [draft, setDraft] = useState(query.q);
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [sources, setSources] = useState<NonNullable<DirectoryResponse["sources"]>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [indexUpdatedAt, setIndexUpdatedAt] = useState<string | null>(null);
  const [activityAsOf, setActivityAsOf] = useState<string | null>(null);
  const [searchCapabilities, setSearchCapabilities] = useState({ businessContacts: true, portalContacts: false,
    portalContactMinimumQueryLength: 3 });
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState<"initial" | "more" | null>("initial");
  const [error, setError] = useState("");
  const [staleCursor, setStaleCursor] = useState(false);
  const failedCursor = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const requestNumber = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (selection: DirectoryQuery, cursor: string | null) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const request = ++requestNumber.current;
    setLoading(cursor ? "more" : "initial");
    setError("");
    setStaleCursor(false);
    if (!cursor) { setClients([]); setNextCursor(null); setIndexUpdatedAt(null); setActivityAsOf(null); setLoaded(false); }
    const parameters = new URLSearchParams(queryString(selection));
    parameters.set("limit", "24");
    parameters.set("sort", selection.sort);
    if (cursor) parameters.set("cursor", cursor);
    try {
      const result = await api<DirectoryResponse>(`/api/client-hub?${parameters}`, { signal: abort.signal });
      if (abort.signal.aborted || request !== requestNumber.current) return;
      if (!result.capabilities.directory) throw new ApiError("Client-directory access is no longer available for your account.", 403, {});
      setClients(previous => {
        const combined = new Map((cursor ? previous : []).map(client => [clientKey(client), client]));
        for (const client of result.clients) combined.set(clientKey(client), client);
        return [...combined.values()];
      });
      setNextCursor(result.nextCursor || null);
      setSources(result.sources || []);
      setIndexUpdatedAt(refreshedTime(result.indexUpdatedAt));
      setActivityAsOf(result.activityAsOf ?? null);
      const portalMinimum = result.searchCapabilities?.portalContactMinimumQueryLength;
      setSearchCapabilities({ businessContacts: result.searchCapabilities?.businessContacts ?? true,
        portalContacts: result.searchCapabilities?.portalContacts === true,
        portalContactMinimumQueryLength: Number.isSafeInteger(portalMinimum) && portalMinimum! >= 1 && portalMinimum! <= 200
          ? portalMinimum! : 3 });
      setLoaded(true);
      failedCursor.current = null;
    } catch (caught) {
      if (abort.signal.aborted || request !== requestNumber.current) return;
      const contextChanged = caught instanceof ApiError && caught.status === 409;
      if (caught instanceof ApiError && [401, 403, 404, 409].includes(caught.status)) {
        setClients([]); setSources([]); setNextCursor(null); setIndexUpdatedAt(null); setActivityAsOf(null); setLoaded(false);
        cursor = null;
      }
      const stale = contextChanged;
      failedCursor.current = stale ? null : cursor;
      setStaleCursor(stale);
      setError(caught instanceof Error ? caught.message : "The client directory could not be loaded.");
    } finally {
      if (!abort.signal.aborted && request === requestNumber.current) setLoading(null);
    }
  }, []);

  useEffect(() => {
    void load(query, null);
    return () => { controller.current?.abort(); requestNumber.current += 1; };
  }, [query.q, query.kind, query.source, query.sort, load]);
  useEffect(() => {
    const restore = () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      const restored = readQuery();
      setQuery(restored);
      setDraft(restored.q);
    };
    addEventListener("popstate", restore);
    return () => removeEventListener("popstate", restore);
  }, []);

  const changeQuery = useCallback((selection: DirectoryQuery, historyMode: "push" | "replace" = "push") => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const normalized = { ...selection, q: selection.q.trim() };
    const href = `/clients${queryString(normalized)}`;
    if (`${location.pathname}${location.search}` !== href)
      history[historyMode === "replace" ? "replaceState" : "pushState"](history.state, "", href);
    setDraft(normalized.q);
    setQuery(normalized);
  }, []);
  useEffect(() => {
    if (draft.trim() === query.q) return;
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null;
      changeQuery({ ...query, q: draft }, "replace");
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchTimer.current = null;
    };
  }, [draft, query, changeQuery]);
  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    changeQuery({ ...query, q: draft });
  };

  return <section className="client-directory-workspace" aria-label="Client directory">
    <div className="client-directory-toolbar">
      <form className="client-directory-search" role="search" onSubmit={search}>
        <label htmlFor="client-directory-query">Search clients</label>
        <div>
          <input id="client-directory-query" type="search" value={draft} maxLength={200}
            placeholder={searchCapabilities.businessContacts ? "Client name, business contact, or project" : "Client or project name"}
            aria-describedby="client-directory-search-help" autoComplete="off"
            onChange={event => setDraft(event.target.value)} />
          <button type="submit" className="button-orange">Search</button>
          {(draft || query.q) && <button type="button" className="button-ghost"
            onClick={() => changeQuery({ ...query, q: "" })}>Clear search</button>}
        </div>
        <small id="client-directory-search-help">
          Results update as you type. Search client names{searchCapabilities.businessContacts ? ", business contacts (name, email, phone)," : ""} and permitted project names.
          {searchCapabilities.portalContacts
            ? ` Portal contact records are searched after ${searchCapabilities.portalContactMinimumQueryLength} characters.`
            : " Portal-only contact and login search is not available."}
        </small>
      </form>
      <div className="client-directory-selectors">{(sources.length > 0 || query.source) && <label className="client-directory-source" htmlFor="client-directory-source">
        Client source
        <select id="client-directory-source" value={query.source}
          onChange={event => changeQuery({ ...query, source: event.target.value })}>
          <option value="">All available sources</option>
          {query.source && !sources.some(source => source.source_id === query.source) && <option value={query.source} disabled>Unavailable source</option>}
          {sources.map(source => <option key={source.source_id} value={source.source_id}>{source.display_name}</option>)}
        </select>
      </label>}
        <label className="client-directory-sort" htmlFor="client-directory-sort">Sort clients
          <select id="client-directory-sort" value={query.sort} onChange={event => changeQuery({ ...query, sort: event.target.value === "name" ? "name" : "recent" })}>
            <option value="recent">Recent business updates</option><option value="name">Name (A–Z)</option>
          </select>
        </label>
      </div>
    </div>
    <p className="client-directory-status">Recent order uses business record updates you can access; synchronization and page views do not count.</p>
    <div className="client-directory-filters" role="group" aria-label="Client type">
      {FILTERS.map(filter => <button key={filter.kind} type="button" className="button-ghost"
        aria-pressed={query.kind === filter.kind}
        onClick={() => changeQuery({ ...query, kind: filter.kind })}>{filter.label}</button>)}
    </div>
    <p className="client-directory-status" role="status" aria-live="polite">
      {loading === "initial" ? "Loading clients…" : loaded
        ? `${number(clients.length)} client${clients.length === 1 ? "" : "s"} shown${query.q ? ` matching “${query.q}”` : ""}${loading === "more" ? " · Loading more…" : ""}`
        : "Client directory could not be loaded."}
    </p>
    {loaded && <p className="client-directory-status client-directory-freshness">
      {indexUpdatedAt ? <>Directory refreshed <time dateTime={indexUpdatedAt}>{new Date(indexUpdatedAt).toLocaleString()}</time>.</>
        : "Directory refreshed periodically."} This reflects directory synchronization, not client activity.
    </p>}
    {error && <Card><div role="alert"><strong>{clients.length ? "More clients could not be loaded" : "Client directory unavailable"}</strong><p>{error}</p></div>
      <button type="button" className="button-orange" disabled={Boolean(loading)}
        onClick={() => void load(query, failedCursor.current)}>{staleCursor ? "Refresh clients" : "Retry clients"}</button>
    </Card>}
    <div className="client-directory-grid" aria-busy={Boolean(loading)}>
      {clients.map(client => <a className="client-directory-card" key={clientKey(client)}
        href={detailPath(client, query)} aria-label={`Open ${client.business_party_name || client.display_name} client workspace`}>
        <div className="client-directory-card-header"><small>{client.kind === "organization" ? "Organization" : "Individual client"}</small>
          {!client.business_party_id && <ClientPortalStatusPill client={client} />}</div>
        <h3>{client.business_party_name || client.display_name}</h3>
        {client.business_party_id ? <><small>Linked customer · {number(client.business_party_member_count || 0)} business records</small>
          <p className="client-directory-status">Open each source workspace for its contacts, history and access.</p></>
          : client.source_name && <small>{client.source_name}</small>}
        {!client.business_party_id && client.root_namespace === "portal" && <small>Portal workspace · business link pending</small>}
        <ClientBusinessUpdate value={client.meaningful_activity_at} asOf={activityAsOf} />
        {!client.business_party_id && <dl className="client-directory-card-counts">
          <div><dt>Shared projects</dt><dd>{number(client.project_count)}</dd></div>
          <div><dt>Contact records</dt><dd>{number(client.contact_count ?? client.contacts?.length ?? 0)}</dd></div>
          <div><dt>Requests</dt><dd>{number(client.request_count)}</dd></div>
        </dl>}
        <span className="client-directory-open">Open client workspace <span aria-hidden="true">→</span></span>
      </a>)}
    </div>
    {loaded && !loading && !error && !clients.length && <Card>
      <EmptyState title={query.q || query.kind !== "all" || query.source ? "No matching clients" : "No clients yet"}
        detail={query.q || query.kind !== "all" || query.source ? "Try another search, client type, or source." : "Clients will appear after they have synchronized."} />
      {(query.q || query.kind !== "all" || query.source) && <button type="button" className="button-ghost"
        onClick={() => changeQuery({ q: "", kind: "all", source: "", sort: query.sort })}>Reset filters</button>}
    </Card>}
    {nextCursor && !error && <div className="client-directory-more"><button type="button" className="button-ghost"
      disabled={Boolean(loading)} onClick={() => void load(query, nextCursor)}>{loading === "more" ? "Loading more…" : "Load more clients"}</button></div>}
  </section>;
}
