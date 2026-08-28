import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Card, EmptyState, StatusPill } from "@ltds/ui";
import { api, ApiError } from "./api";
import "./ClientExternalAccessRoster.css";

export type ExternalAccessFilter = "current" | "all" | "active" | "unassigned" | "pending" | "suspended" | "blocked" | "expired" | "revoked";
export interface ExternalAccessRow {
  row_key: string;
  kind: "membership" | "invitation";
  display_name: string;
  email_hint: string;
  access_status: "active" | "unassigned" | "pending" | "suspended" | "blocked" | "expired" | "revoked" | "needs_review";
  source_type: "project_alpha" | "operations" | "client_invitation" | "legacy";
  expires_at: string | null;
  revoked_at: string | null;
  assigned_access_count: number;
  created_at: string;
}
export interface ExternalAccessPage {
  available: boolean;
  reason: "workspace_unavailable" | null;
  nextCursor: string | null;
  hasMore: boolean;
  returned: number;
  limit: number;
}
export interface ExternalAccessResult {
  items: ExternalAccessRow[];
  page: ExternalAccessPage;
  canonicalRoot: { sourceId: string; rootNamespace: string; kind: string; publicId: string };
  contextVersion: string;
  refreshedAt: string;
}

interface Query { q: string; status: ExternalAccessFilter }
const filters = new Set<ExternalAccessFilter>(["current", "all", "active", "unassigned", "pending", "suspended", "blocked", "expired", "revoked"]);

function readQuery(): Query {
  const parameters = new URLSearchParams(location.search), raw = parameters.get("access_status") as ExternalAccessFilter | null;
  return { q: (parameters.get("access_q") || "").trim().slice(0, 200), status: raw && filters.has(raw) ? raw : "current" };
}
function isDefault(query: Query) { return !query.q && query.status === "current"; }
function contextFailure(error: unknown) { return error instanceof ApiError && [401, 403, 404, 409].includes(error.status); }
function rootKey(root: ExternalAccessResult["canonicalRoot"]) { return JSON.stringify([root.sourceId, root.rootNamespace, root.kind, root.publicId]); }
function sourceLabel(source: ExternalAccessRow["source_type"]) {
  return source === "project_alpha" ? "Project Alpha" : source === "operations" ? "Operations"
    : source === "client_invitation" ? "Client invitation" : "Legacy access";
}
function statusLabel(status: ExternalAccessRow["access_status"]) {
  return status === "active" ? "Active membership" : status === "unassigned" ? "No assigned access"
    : status === "pending" ? "Pending invitation" : status === "blocked" ? "Sign-in blocked"
      : status === "needs_review" ? "Needs review" : status[0]!.toUpperCase() + status.slice(1);
}
function statusTone(status: ExternalAccessRow["access_status"]): "success" | "warning" | "danger" | "neutral" {
  return status === "active" ? "success" : status === "revoked" || status === "blocked" ? "danger"
    : status === "pending" || status === "suspended" || status === "expired" || status === "needs_review" ? "warning" : "neutral";
}
function date(value: string | null) {
  if (value === null) return "No expiration";
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.valueOf()) ? parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Expiry not verified";
}

export function ClientExternalAccessRoster({ initialPage, basePath, contextVersion, canonicalRoot, contextSignal, onInvalidated }: {
  initialPage: ExternalAccessResult;
  basePath: string;
  contextVersion: string;
  canonicalRoot: ExternalAccessResult["canonicalRoot"];
  contextSignal: AbortSignal;
  onInvalidated: (message: string) => void;
}) {
  const [query, setQuery] = useState(readQuery), [draft, setDraft] = useState(readQuery);
  const [state, setState] = useState<{ value: ExternalAccessResult | null; busy: boolean; error: string; continued: boolean; retryMore: boolean | null; retryReplace: boolean }>(
    { value: isDefault(readQuery()) ? initialPage : null, busy: !isDefault(readQuery()), error: "", continued: false, retryMore: null, retryReplace: false });
  const active = useRef(true), controller = useRef<AbortController | null>(null), sequence = useRef(0), initialConsumed = useRef(false);
  const invalidateRef = useRef(onInvalidated); invalidateRef.current = onInvalidated;
  const formId = useId();
  const expectedRoot = rootKey(canonicalRoot);
  const validate = (value: ExternalAccessResult, previousCursor?: string) => {
    if (value.contextVersion !== contextVersion || !value.canonicalRoot || rootKey(value.canonicalRoot) !== expectedRoot)
      throw new ApiError("Client mapping or permissions changed. Refresh the client workspace.", 409, {});
    if (!Array.isArray(value.items) || !value.page || (value.page.hasMore && (!value.page.nextCursor || value.page.nextCursor === previousCursor)))
      throw new ApiError("External access could not be continued safely. Refresh the client workspace.", 409, {});
    return value;
  };
  const load = async (more = false, replace = false) => {
    if (contextSignal.aborted || controller.current) return;
    const previous = state.value;
    if (more && (!previous?.page.available || !previous.page.hasMore || !previous.page.nextCursor)) return;
    const abort = new AbortController(), request = ++sequence.current;
    controller.current = abort;
    setState(current => replace
      ? { value: null, busy: true, error: "", continued: false, retryMore: null, retryReplace: true }
      : { ...current, busy: true, error: "", retryReplace: false });
    try {
      const parameters = new URLSearchParams({ q: query.q, status: query.status, limit: more ? "25" : "5" });
      if (more) parameters.set("cursor", previous!.page.nextCursor!);
      const value = await api<ExternalAccessResult>(`${basePath}/external-access?${parameters}`, { signal: abort.signal });
      if (!active.current || contextSignal.aborted || abort.signal.aborted || sequence.current !== request) return;
      validate(value, more ? previous!.page.nextCursor! : undefined);
      setState(current => {
        const rows = new Map((more ? current.value?.items || [] : []).map(row => [row.row_key, row]));
        for (const row of value.items) rows.set(row.row_key, row);
        return { value: { ...value, items: [...rows.values()] }, busy: false, error: "", continued: more, retryMore: null, retryReplace: false };
      });
    } catch (error) {
      if (!active.current || contextSignal.aborted || abort.signal.aborted || sequence.current !== request) return;
      const message = error instanceof Error ? error.message : "External access could not be loaded.";
      if (contextFailure(error)) {
        setState({ value: null, busy: false, error: message, continued: false, retryMore: null, retryReplace: false });
        invalidateRef.current(message);
      } else setState(current => ({ ...current, busy: false, error: message, retryMore: more, retryReplace: replace }));
    } finally {
      if (active.current && sequence.current === request) controller.current = null;
    }
  };
  useEffect(() => {
    active.current = true;
    const abort = () => { sequence.current += 1; controller.current?.abort(); controller.current = null; };
    const sync = () => { const next = readQuery(); setQuery(next); setDraft(next); };
    addEventListener("popstate", sync); contextSignal.addEventListener("abort", abort);
    if (!initialConsumed.current && isDefault(query)) {
      initialConsumed.current = true;
      try { setState({ value: validate(initialPage), busy: false, error: "", continued: false, retryMore: null, retryReplace: false }); }
      catch (error) { invalidateRef.current(error instanceof Error ? error.message : "Refresh the client workspace."); }
    } else { initialConsumed.current = true; void load(false, true); }
    return () => { active.current = false; abort(); removeEventListener("popstate", sync); contextSignal.removeEventListener("abort", abort); };
  }, [query.q, query.status, contextVersion, expectedRoot, contextSignal]);
  const search = (next: Query) => {
    const normalized = { q: next.q.trim().slice(0, 200), status: next.status }, url = new URL(location.href);
    if (normalized.q) url.searchParams.set("access_q", normalized.q); else url.searchParams.delete("access_q");
    if (normalized.status === "current") url.searchParams.delete("access_status"); else url.searchParams.set("access_status", normalized.status);
    if (`${url.pathname}${url.search}` !== `${location.pathname}${location.search}`) history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
    setQuery(normalized); setDraft(normalized);
  };
  const submit = (event: FormEvent) => { event.preventDefault(); search(draft); };
  const value = state.value;
  const canContinue = Boolean(value?.page.available && value.page.hasMore && value.page.nextCursor);
  const filtered = !isDefault(query);
  return <Card title="External access"><section className="external-access-roster" aria-label="External access" aria-busy={state.busy}>
    <p>Portal membership and invitation records for this client workspace. Business contacts are listed separately. Assigned rules do not by themselves guarantee effective resource access.</p>
    {value?.page.available === false ? <EmptyState title="External access unavailable" detail="A verified portal workspace is required before external access can be shown." /> : <>
      <form className="external-access-search" onSubmit={submit}>
        <label htmlFor={`${formId}-query`}>Search external access</label>
        <div><input id={`${formId}-query`} type="search" maxLength={200} value={draft.q} onChange={event => setDraft(current => ({ ...current, q: event.target.value }))} placeholder="Name or email" />
          <label>Access status<select value={draft.status} onChange={event => setDraft(current => ({ ...current, status: event.target.value as ExternalAccessFilter }))}>
            <option value="current">Current records</option><option value="all">All records</option><option value="active">Active membership</option><option value="unassigned">No assigned access</option>
            <option value="pending">Pending invitations</option><option value="suspended">Suspended</option><option value="blocked">Sign-in blocked</option>
            <option value="expired">Expired</option><option value="revoked">Revoked</option>
          </select></label>
          <button type="submit" className="button-orange">Search access</button>
          {filtered && <button type="button" className="button-ghost" onClick={() => search({ q: "", status: "current" })}>Clear access filters</button>}
        </div>
      </form>
      {!value && state.busy && <p role="status">Loading external access…</p>}
      {value?.items.length === 0 && <EmptyState title={filtered ? "No matching external access" : "No external access"}
        detail={filtered ? "Try another name or access status." : "No current membership or pending invitation records are available for this client workspace."} />}
      <div className="external-access-rows">{value?.items.map(row => <article key={row.row_key} aria-label={`External access for ${row.display_name}`}>
        <header><div><h3>{row.display_name}</h3>{row.email_hint && row.email_hint !== row.display_name.toLocaleLowerCase("en-US") && <p>{row.email_hint}</p>}</div>
          <StatusPill tone={statusTone(row.access_status)}>{statusLabel(row.access_status)}</StatusPill></header>
        <dl><div><dt>Access source</dt><dd>{sourceLabel(row.source_type)}</dd></div><div><dt>Access ends</dt><dd>{date(row.expires_at)}</dd></div>
          <div><dt>Assigned access</dt><dd>{row.assigned_access_count.toLocaleString()} {row.assigned_access_count === 1 ? "rule" : "rules"}</dd></div></dl>
      </article>)}</div>
      <div className="external-access-actions"><p role="status">{value ? `${value.items.length.toLocaleString()} external access ${value.items.length === 1 ? "record" : "records"} shown${state.busy ? " · Loading more…" : ""}` : ""}</p>
        {state.error && <p role="alert" className="external-access-error">{state.error}</p>}
        {(state.error || canContinue || state.continued) && <button type="button" className="button-ghost" aria-disabled={state.busy || (!state.error && !canContinue)} onClick={() => { if (!state.busy) void load(state.error ? Boolean(state.retryMore) : true, state.error ? state.retryReplace : false); }}>
          {state.busy ? "Loading external access…" : state.error ? "Retry external access" : canContinue ? "Load more external access" : "All external access loaded"}</button>}
        <button type="button" className="button-ghost" aria-disabled={state.busy} onClick={() => { if (!state.busy) void load(false); }}>Refresh external access</button>
        {value?.refreshedAt && <small>External access refreshed {date(value.refreshedAt)}. Later changes appear after refresh.</small>}
      </div>
    </>}
  </section></Card>;
}
