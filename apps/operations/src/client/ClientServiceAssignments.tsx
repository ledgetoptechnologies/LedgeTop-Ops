import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Card, EmptyState, StatusPill } from "@ltds/ui";
import { api, ApiError } from "./api";
import "./ClientServiceAssignments.css";

export type ServiceAssignmentFilter = "current" | "effective" | "upcoming" | "expired" | "needs_review";
export interface ClientServiceAssignmentRow {
  row_key: string;
  assignment_public_id: string;
  service_public_id: string;
  service_name: string | null;
  service_label: string;
  service_source_version: string;
  assignment_source_version: string;
  subject_type: "organization" | "standalone_client";
  subject_public_id: string;
  subject_name: string;
  effective_status: Exclude<ServiceAssignmentFilter, "current">;
  effective_from: string | null;
  effective_until: string | null;
  source_id: string;
  source_name: string;
  source_generation: string;
  source_sequence: number;
  source_updated_at: string;
}
export interface ClientServiceAssignmentResult {
  items: ClientServiceAssignmentRow[];
  page: { available: boolean; reason: "permission_required" | "not_applicable" | "workspace_unavailable"
    | "subject_mapping_unavailable" | "schema_unavailable" | "receiver_not_ready" | "directory_not_ready"
    | "projection_not_ready" | null; nextCursor: string | null; hasMore: boolean; returned: number; limit: number };
  readiness: { tables: "ready" | "unavailable"; receiver: "ready" | "not_enrolled" | "suspended" | "unavailable";
    source: "observed" | "unobserved" | "unavailable"; directory: "ready" | "unavailable";
    projection: "ready" | "unavailable"; catalog: "ready" | "unavailable" };
  canonicalRoot: { sourceId: string; rootNamespace: string; kind: string; publicId: string };
  contextVersion: string;
  refreshedAt: string;
}

interface Query { q: string; status: ServiceAssignmentFilter }
const FILTERS = new Set<ServiceAssignmentFilter>(["current", "effective", "upcoming", "expired", "needs_review"]);

function readQuery(): Query {
  const parameters = new URLSearchParams(location.search), raw = parameters.get("service_status") as ServiceAssignmentFilter | null;
  return { q: (parameters.get("service_q") || "").trim().slice(0, 200), status: raw && FILTERS.has(raw) ? raw : "current" };
}
function isDefault(query: Query) { return !query.q && query.status === "current"; }
function rootKey(root: ClientServiceAssignmentResult["canonicalRoot"]) {
  return JSON.stringify([root.sourceId, root.rootNamespace, root.kind, root.publicId]);
}
function contextFailure(error: unknown) { return error instanceof ApiError && [401, 403, 404, 409].includes(error.status); }
function date(value: string | null, empty: string) {
  if (value === null) return empty;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.valueOf()) ? parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Date not verified";
}
function statusLabel(status: ClientServiceAssignmentRow["effective_status"]) {
  return status === "needs_review" ? "Needs review" : status[0]!.toUpperCase() + status.slice(1);
}
function statusTone(status: ClientServiceAssignmentRow["effective_status"]): "success" | "warning" | "neutral" {
  return status === "effective" ? "success" : status === "upcoming" || status === "needs_review" ? "warning" : "neutral";
}
function unavailableDetail(reason: ClientServiceAssignmentResult["page"]["reason"]) {
  switch (reason) {
    case "permission_required": return "Client-directory and operations-management access are both required.";
    case "not_applicable": return "Service assignments apply only to exact Project Alpha business records.";
    case "workspace_unavailable": return "A verified, source-owned portal workspace has not been linked to this client.";
    case "subject_mapping_unavailable": return "The current exported Project Alpha subject ID could not be verified.";
    case "schema_unavailable": return "The service-assignment receiver tables are not available yet.";
    case "receiver_not_ready": return "The exact source and workspace are not actively enrolled in the receiver.";
    case "directory_not_ready": return "The current source-owned directory no longer proves this exact client subject.";
    case "projection_not_ready": return "No verified current service-assignment projection is available for this source.";
    default: return "Service assignments are unavailable for this client.";
  }
}

export function ClientServiceAssignments({ initialPage, basePath, contextVersion, canonicalRoot, contextSignal, onInvalidated }: {
  initialPage: ClientServiceAssignmentResult;
  basePath: string;
  contextVersion: string;
  canonicalRoot: ClientServiceAssignmentResult["canonicalRoot"];
  contextSignal: AbortSignal;
  onInvalidated: (message: string) => void;
}) {
  const [query, setQuery] = useState(readQuery), [draft, setDraft] = useState(readQuery);
  const [state, setState] = useState<{ value: ClientServiceAssignmentResult | null; busy: boolean; error: string;
    continued: boolean; retryMore: boolean; retryReplace: boolean }>({ value: isDefault(readQuery()) ? initialPage : null,
      busy: !isDefault(readQuery()), error: "", continued: false, retryMore: false, retryReplace: false });
  const active = useRef(true), controller = useRef<AbortController | null>(null), sequence = useRef(0), initialConsumed = useRef(false);
  const invalidateRef = useRef(onInvalidated); invalidateRef.current = onInvalidated;
  const expectedRoot = rootKey(canonicalRoot), formId = useId();
  const validate = (value: ClientServiceAssignmentResult, previousCursor?: string) => {
    if (value.contextVersion !== contextVersion || !value.canonicalRoot || rootKey(value.canonicalRoot) !== expectedRoot)
      throw new ApiError("Client mapping or permissions changed. Refresh the client workspace.", 409, {});
    if (!Array.isArray(value.items) || !value.page || !value.readiness
      || (value.page.hasMore && (!value.page.nextCursor || value.page.nextCursor === previousCursor)))
      throw new ApiError("Service assignments could not be continued safely. Refresh the client workspace.", 409, {});
    return value;
  };
  const load = async (more = false, replace = false) => {
    if (contextSignal.aborted || controller.current) return;
    const previous = state.value;
    if (more && (!previous?.page.available || !previous.page.hasMore || !previous.page.nextCursor)) return;
    const abort = new AbortController(), request = ++sequence.current;
    controller.current = abort;
    setState(current => replace ? { value: null, busy: true, error: "", continued: false, retryMore: false, retryReplace: true }
      : { ...current, busy: true, error: "", retryReplace: false });
    try {
      const parameters = new URLSearchParams({ q: query.q, status: query.status, limit: more ? "25" : "5" });
      if (more) parameters.set("cursor", previous!.page.nextCursor!);
      const value = await api<ClientServiceAssignmentResult>(`${basePath}/service-assignments?${parameters}`, { signal: abort.signal });
      if (!active.current || contextSignal.aborted || abort.signal.aborted || sequence.current !== request) return;
      validate(value, more ? previous!.page.nextCursor! : undefined);
      setState(current => {
        const rows = new Map((more ? current.value?.items || [] : []).map(row => [row.row_key, row]));
        for (const row of value.items) rows.set(row.row_key, row);
        return { value: { ...value, items: [...rows.values()] }, busy: false, error: "", continued: more,
          retryMore: false, retryReplace: false };
      });
    } catch (error) {
      if (!active.current || contextSignal.aborted || abort.signal.aborted || sequence.current !== request) return;
      const message = error instanceof Error ? error.message : "Service assignments could not be loaded.";
      if (contextFailure(error)) {
        setState({ value: null, busy: false, error: message, continued: false, retryMore: false, retryReplace: false });
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
      try { setState({ value: validate(initialPage), busy: false, error: "", continued: false, retryMore: false, retryReplace: false }); }
      catch (error) { invalidateRef.current(error instanceof Error ? error.message : "Refresh the client workspace."); }
    } else { initialConsumed.current = true; void load(false, true); }
    return () => { active.current = false; abort(); removeEventListener("popstate", sync); contextSignal.removeEventListener("abort", abort); };
  }, [query.q, query.status, contextVersion, expectedRoot, contextSignal]);
  const search = (next: Query) => {
    const normalized = { q: next.q.trim().slice(0, 200), status: next.status }, url = new URL(location.href);
    if (normalized.q) url.searchParams.set("service_q", normalized.q); else url.searchParams.delete("service_q");
    if (normalized.status === "current") url.searchParams.delete("service_status"); else url.searchParams.set("service_status", normalized.status);
    if (`${url.pathname}${url.search}` !== `${location.pathname}${location.search}`)
      history.pushState({}, "", `${url.pathname}${url.search}${url.hash}`);
    setQuery(normalized); setDraft(normalized);
  };
  const submit = (event: FormEvent) => { event.preventDefault(); search(draft); };
  const value = state.value, filtered = !isDefault(query);
  const canContinue = Boolean(value?.page.available && value.page.hasMore && value.page.nextCursor);
  return <Card title="Project Alpha service assignments"><section className="client-service-assignments"
    aria-label="Project Alpha service assignments" aria-busy={state.busy}>
    <p className="client-service-assignment-warning"><strong>Informational only.</strong> Assignments do not grant portal access, enable service requests, or expose pricing.</p>
    {value?.page.available === false ? <EmptyState title="Service assignments unavailable" detail={unavailableDetail(value.page.reason)} /> : <>
      <form className="client-service-assignment-search" onSubmit={submit}>
        <label htmlFor={`${formId}-query`}>Search assigned services</label>
        <div><input id={`${formId}-query`} type="search" maxLength={200} value={draft.q}
          onChange={event => setDraft(current => ({ ...current, q: event.target.value }))} placeholder="Service name or ID" />
          <label>Effective status<select value={draft.status}
            onChange={event => setDraft(current => ({ ...current, status: event.target.value as ServiceAssignmentFilter }))}>
            <option value="current">Current projection</option><option value="effective">Effective now</option>
            <option value="upcoming">Upcoming</option><option value="expired">Window ended</option><option value="needs_review">Needs review</option>
          </select></label>
          <button type="submit" className="button-orange">Search services</button>
          {filtered && <button type="button" className="button-ghost" onClick={() => search({ q: "", status: "current" })}>Clear service filters</button>}
        </div>
      </form>
      {!value && state.busy && <p role="status">Loading service assignments…</p>}
      {value?.items.length === 0 && <EmptyState title={filtered ? "No matching service assignments" : "No service assignments"}
        detail={filtered ? "Try another service name, ID, or effective status." : "No current assignments target this exact client subject."} />}
      <div className="client-service-assignment-rows">{value?.items.map(row => <article key={row.row_key}
        aria-label={`Service assignment for ${row.service_label}`}>
        <header><div><h3>{row.service_label}</h3>{row.service_name && <p>Service ID: {row.service_public_id}</p>}</div>
          <StatusPill tone={statusTone(row.effective_status)}>{statusLabel(row.effective_status)}</StatusPill></header>
        <dl><div><dt>Assigned subject</dt><dd>{row.subject_name}</dd><dd>{row.subject_type.replaceAll("_", " ")} · {row.subject_public_id}</dd></div>
          <div><dt>Effective window</dt><dd>{date(row.effective_from, "No start date")} – {date(row.effective_until, "No end date")}</dd></div>
          <div><dt>Source</dt><dd>{row.source_name}</dd><dd>{row.source_id}</dd></div>
          <div><dt>Assignment version</dt><dd>{row.assignment_source_version}</dd></div>
          <div><dt>Service version</dt><dd>{row.service_source_version}</dd></div>
          <div><dt>Projection</dt><dd>{row.source_generation} · sequence {row.source_sequence.toLocaleString()}</dd></div></dl>
      </article>)}</div>
      <div className="client-service-assignment-actions"><p role="status">{value ? `${value.items.length.toLocaleString()} service ${value.items.length === 1 ? "assignment" : "assignments"} shown${state.busy ? " · Loading more…" : ""}` : ""}</p>
        {value?.readiness.catalog === "unavailable" && <p className="muted">Current catalog labels are unavailable; service IDs are shown instead.</p>}
        {value?.readiness.source === "unobserved" && <p className="muted">The source capability has not been observed; stored projection facts remain read-only.</p>}
        {state.error && <p role="alert" className="client-service-assignment-error">{state.error}</p>}
        {(state.error || canContinue || state.continued) && <button type="button" className="button-ghost"
          aria-disabled={state.busy || (!state.error && !canContinue)} onClick={() => { if (!state.busy)
            void load(state.error ? state.retryMore : true, state.error ? state.retryReplace : false); }}>
          {state.busy ? "Loading service assignments…" : state.error ? "Retry service assignments"
            : canContinue ? "Load more service assignments" : "All service assignments loaded"}</button>}
        <button type="button" className="button-ghost" aria-disabled={state.busy}
          onClick={() => { if (!state.busy) void load(false); }}>Refresh service assignments</button>
        {value?.refreshedAt && <small>Service assignments refreshed {date(value.refreshedAt, "recently")}.</small>}
      </div>
    </>}
  </section></Card>;
}
