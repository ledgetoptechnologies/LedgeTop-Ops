import { useEffect, useRef, useState, type FormEvent } from "react";
import { Card, EmptyState, Loading, StatusPill } from "@ltds/ui";
import { api } from "./api";
import "./AdminAuditHistory.css";

type AuditResult = "all" | "succeeded" | "failed" | "denied";
type EventResult = Exclude<AuditResult, "all">;
interface FilterDraft { actor: string; action: string; category: string; entity: string; division: string; result: AuditResult; from: string; to: string }
interface AppliedFilters extends FilterDraft { from: string; to: string; toExclusive: boolean; limit: number }
interface AuditEvent {
  id: string;
  actor: { type: "staff" | "integration" | "system"; id: string | null; email: string | null; displayName: string | null };
  action: string; category: string; resource: { type: string | null; id: string | null }; divisionId: string | null;
  result: EventResult; occurredAt: string;
}
interface AuditResponse { events: AuditEvent[]; nextCursor: string | null; highWaterId: string; filters: AppliedFilters }

const defaults: FilterDraft = { actor: "", action: "", category: "", entity: "", division: "", result: "all", from: "", to: "" };
const keys = { actor: "adminAudit.actor", action: "adminAudit.action", category: "adminAudit.category", entity: "adminAudit.entity",
  division: "adminAudit.division", result: "adminAudit.result", from: "adminAudit.from", to: "adminAudit.to" } as const;
const results = ["all", "succeeded", "failed", "denied"] as const;
const control = /[\u0000-\u001f\u007f]/;
const filterKeys: Array<keyof AppliedFilters> = ["actor", "action", "category", "entity", "division", "result", "from", "to", "toExclusive", "limit"];

function clean(value: string) { return value.normalize("NFC").trim(); }
function validText(value: unknown, maximum: number, nullable = false): value is string | null {
  return (nullable && value === null) || typeof value === "string" && value.length <= maximum && !control.test(value);
}
function isoDay(value: string, end = false): { value: string; exclusive: boolean } | null {
  if (!value) return { value: "", exclusive: false };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  if (end) parsed.setUTCDate(parsed.getUTCDate() + 1);
  return { value: parsed.toISOString(), exclusive: end };
}
function canonical(draft: FilterDraft): AppliedFilters | null {
  const from = isoDay(draft.from), to = isoDay(draft.to, true);
  if (!from || !to || from.value && to.value && from.value >= to.value) return null;
  const value = { actor: clean(draft.actor).toLocaleLowerCase("en-US"), action: clean(draft.action), category: clean(draft.category).toLocaleLowerCase("en-US"),
    entity: clean(draft.entity).toLocaleLowerCase("en-US"), division: clean(draft.division), result: draft.result, from: from.value, to: to.value,
    toExclusive: to.exclusive, limit: 25 };
  if (value.actor.length > 200 || value.action.length > 128 || value.category.length > 128 || value.entity.length > 200
    || value.division.length > 128 || ![value.actor, value.action, value.category, value.entity, value.division].every(item => !control.test(item))) return null;
  return value;
}
function fromUrl(): FilterDraft | null {
  const params = new URLSearchParams(location.search), result = params.get(keys.result) ?? "all";
  if (!results.includes(result as AuditResult)) return null;
  const draft = { actor: params.get(keys.actor) ?? "", action: params.get(keys.action) ?? "", category: params.get(keys.category) ?? "",
    entity: params.get(keys.entity) ?? "", division: params.get(keys.division) ?? "", result: result as AuditResult,
    from: params.get(keys.from) ?? "", to: params.get(keys.to) ?? "" };
  return canonical(draft) ? draft : null;
}
function syncUrl(draft: FilterDraft, mode: "pushState" | "replaceState") {
  const url = new URL(location.href);
  for (const key of Object.values(keys)) url.searchParams.delete(key);
  for (const key of ["actor", "action", "category", "entity", "division", "from", "to"] as const)
    if (draft[key]) url.searchParams.set(keys[key], clean(draft[key]));
  if (draft.result !== "all") url.searchParams.set(keys.result, draft.result);
  history[mode](history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
function sameFilters(left: AppliedFilters, right: AppliedFilters) {
  return Boolean(left && typeof left === "object" && !Array.isArray(left)
    && Object.keys(left).length === filterKeys.length && filterKeys.every(key => left[key] === right[key]));
}
function validEvent(value: unknown): value is AuditEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as AuditEvent;
  if (!/^\d+$/.test(item.id) || !validText(item.action, 128) || !item.action || !validText(item.category, 128) || !item.category
    || !results.slice(1).includes(item.result) || !validText(item.occurredAt, 64) || !Number.isFinite(Date.parse(item.occurredAt.replace(" ", "T")))) return false;
  if (!item.actor || typeof item.actor !== "object" || !["staff", "integration", "system"].includes(item.actor.type)
    || !validText(item.actor.id, 256, true) || !validText(item.actor.email, 320, true) || !validText(item.actor.displayName, 256, true)) return false;
  return Boolean(item.resource && typeof item.resource === "object" && validText(item.resource.type, 128, true)
    && validText(item.resource.id, 512, true) && validText(item.divisionId, 128, true));
}
function validResponse(value: unknown, expected: AppliedFilters, priorCursor: string | null, expectedHighWater: string | null): value is AuditResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as AuditResponse;
  return Array.isArray(response.events) && response.events.length <= expected.limit && response.events.every(validEvent)
    && new Set(response.events.map(item => item.id)).size === response.events.length
    && (response.nextCursor === null || validText(response.nextCursor, 2048)) && (priorCursor === null || response.nextCursor !== priorCursor)
    && typeof response.highWaterId === "string" && /^\d+$/.test(response.highWaterId)
    && (expectedHighWater === null || response.highWaterId === expectedHighWater)
    && Boolean(response.filters && sameFilters(response.filters, expected));
}
function displayDate(value: string) {
  const parsed = new Date(value.replace(" ", "T"));
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Unavailable";
}
function actorLabel(event: AuditEvent) { return event.actor.displayName || event.actor.email || event.actor.id || event.actor.type; }
function tone(value: EventResult): "success" | "danger" { return value === "succeeded" ? "success" : "danger"; }

/** Global Operations ledger. Scoped Client/project timelines remain authoritative for their own federated histories. */
export function AdminAuditHistory() {
  const [draft, setDraft] = useState<FilterDraft>(defaults), [applied, setApplied] = useState<AppliedFilters | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState(""), [filterError, setFilterError] = useState("");
  const pending = useRef<AbortController | null>(null), requestNumber = useRef(0), failedCursor = useRef<string | null>(null);
  const highWater = useRef<string | null>(null), eventIndex = useRef(new Map<string, string>());

  async function load(filters: AppliedFilters, cursor: string | null) {
    pending.current?.abort();
    const controller = new AbortController(), current = ++requestNumber.current; pending.current = controller;
    setBusy(true); setError(""); setFilterError(""); failedCursor.current = cursor;
    if (!cursor) { setEvents([]); setNextCursor(null); setLoaded(false); highWater.current = null; eventIndex.current.clear(); }
    const params = new URLSearchParams({ limit: String(filters.limit), result: filters.result });
    for (const key of ["actor", "action", "category", "entity", "division"] as const) if (filters[key]) params.set(key, filters[key]);
    if (filters.from) params.set("from", filters.from.slice(0, 10));
    if (filters.to) { const end = new Date(filters.to); if (filters.toExclusive) end.setUTCDate(end.getUTCDate() - 1);
      params.set("to", filters.toExclusive ? end.toISOString().slice(0, 10) : filters.to); }
    if (cursor) params.set("cursor", cursor);
    try {
      const response = await api<unknown>(`/api/admin/audit?${params}`, { signal: controller.signal });
      if (controller.signal.aborted || requestNumber.current !== current) return;
      if (!validResponse(response, filters, cursor, cursor ? highWater.current : null)) throw new Error("The audit response could not be verified. Retry this section.");
      for (const item of response.events) {
        const prior = eventIndex.current.get(item.id), serialized = JSON.stringify(item);
        if (prior && prior !== serialized) throw new Error("The audit response could not be verified. Retry this section.");
      }
      highWater.current = response.highWaterId;
      for (const item of response.events) eventIndex.current.set(item.id, JSON.stringify(item));
      setEvents(previous => [...new Map([...(cursor ? previous : []), ...response.events].map(item => [item.id, item])).values()]);
      setNextCursor(response.nextCursor); setLoaded(true); failedCursor.current = null;
    } catch (caught) {
      if (controller.signal.aborted || requestNumber.current !== current) return;
      setError(caught instanceof Error ? caught.message : "Audit history could not be loaded.");
    } finally {
      if (!controller.signal.aborted && requestNumber.current === current) { pending.current = null; setBusy(false); }
    }
  }

  useEffect(() => {
    const restore = () => {
      const value = fromUrl();
      if (!value) { pending.current?.abort(); pending.current = null; requestNumber.current += 1; failedCursor.current = null;
        setDraft(defaults); setApplied(null); setEvents([]); setNextCursor(null); setLoaded(false); setBusy(false); highWater.current = null; eventIndex.current.clear();
        setError(""); setFilterError("The audit filters in this URL are invalid. Reset the filters to continue."); return; }
      const filters = canonical(value)!; setDraft(value); setApplied(filters); void load(filters, null);
    };
    window.addEventListener("popstate", restore); restore();
    return () => { window.removeEventListener("popstate", restore); pending.current?.abort(); requestNumber.current += 1; };
  }, []);

  const apply = (event: FormEvent) => {
    event.preventDefault(); const filters = canonical(draft);
    if (!filters) { setFilterError("Use valid filters and choose From on or before To."); return; }
    const normalizedDraft = { ...draft, actor: filters.actor, action: filters.action, category: filters.category,
      entity: filters.entity, division: filters.division };
    setDraft(normalizedDraft); setApplied(filters); syncUrl(normalizedDraft, "pushState"); void load(filters, null);
  };
  const reset = () => { const filters = canonical(defaults)!; setDraft(defaults); setApplied(filters); syncUrl(defaults, "pushState"); void load(filters, null); };
  const retry = () => { if (applied) void load(applied, failedCursor.current); };

  return <Card title="Audit history"><section className="admin-audit" aria-label="Global audit history">
    <p className="admin-audit-intro">Review the bounded Operations ledger. Client and project workspaces contain their exact scoped histories.</p>
    <form className="admin-audit-filters" onSubmit={apply} aria-label="Audit filters">
      <label>Actor<input value={draft.actor} maxLength={200} onChange={event => setDraft(value => ({ ...value, actor: event.target.value }))} placeholder="Name, email, ID, or type" /></label>
      <label>Action<input value={draft.action} maxLength={128} onChange={event => setDraft(value => ({ ...value, action: event.target.value }))} placeholder="Exact action" /></label>
      <label>Category<input value={draft.category} maxLength={128} onChange={event => setDraft(value => ({ ...value, category: event.target.value }))} placeholder="For example, delivery" /></label>
      <label>Resource<input value={draft.entity} maxLength={200} onChange={event => setDraft(value => ({ ...value, entity: event.target.value }))} placeholder="Type or exact resource ID" /></label>
      <label>Division<input value={draft.division} maxLength={128} onChange={event => setDraft(value => ({ ...value, division: event.target.value }))} placeholder="Division ID or none" /></label>
      <label>Result<select value={draft.result} onChange={event => setDraft(value => ({ ...value, result: event.target.value as AuditResult }))}>
        <option value="all">All results</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="denied">Denied</option>
      </select></label>
      <label>From<input type="date" value={draft.from} onChange={event => setDraft(value => ({ ...value, from: event.target.value }))} /></label>
      <label>To<input type="date" value={draft.to} onChange={event => setDraft(value => ({ ...value, to: event.target.value }))} /></label>
      <div className="admin-audit-filter-actions"><button type="submit" disabled={busy}>Apply filters</button>
        <button type="button" className="button-ghost" disabled={busy} onClick={reset}>Reset</button>
        <button type="button" className="button-ghost" disabled={busy || !applied} onClick={() => applied && void load(applied, null)}>Refresh</button></div>
    </form>
    {filterError && <div className="notice error" role="alert">{filterError}</div>}
    {error && <div className="notice error" role="alert"><span>{error}</span><button type="button" className="button-ghost button-small" disabled={busy} onClick={retry}>Retry audit history</button></div>}
    {busy && !loaded && <Loading />}
    {loaded && events.length === 0 && !error && <EmptyState title="No matching audit events" detail="Adjust the filters or refresh after new activity occurs." />}
    {events.length > 0 && <ul className="admin-audit-events">{events.map(item => <li key={item.id}>
      <div className="admin-audit-event-heading"><div><strong>{item.action}</strong><small>{displayDate(item.occurredAt)}</small></div>
        <StatusPill tone={tone(item.result)}>{item.result}</StatusPill></div>
      <dl><div><dt>Actor</dt><dd>{actorLabel(item)} <small>({item.actor.type})</small></dd></div>
        <div><dt>Category</dt><dd>{item.category}</dd></div>
        <div><dt>Resource</dt><dd>{item.resource.type && item.resource.id ? `${item.resource.type} · ${item.resource.id}` : item.resource.type || item.resource.id || "Not recorded"}</dd></div>
        <div><dt>Division</dt><dd>{item.divisionId || "None"}</dd></div></dl>
    </li>)}</ul>}
    {(nextCursor || busy && loaded) && <div className="admin-audit-actions"><button type="button" disabled={busy || !nextCursor}
      onClick={() => applied && nextCursor && void load(applied, nextCursor)}>{busy ? "Loading…" : "Load more audit events"}</button>
      <span aria-live="polite">{events.length} event{events.length === 1 ? "" : "s"} loaded</span></div>}
    {loaded && !nextCursor && events.length > 0 && <p className="admin-audit-complete">All matching audit events loaded.</p>}
  </section></Card>;
}
