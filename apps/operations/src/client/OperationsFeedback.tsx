import { useEffect, useRef, useState, type FormEvent } from "react";
import { Card, StatusPill } from "@ltds/ui";
import { CLIENT_FEEDBACK_NOTE_LIMIT, type ClientFeedbackEvent, type ClientFeedbackStatus, type StaffClientFeedbackItem } from "@ltds/shared";
import { api, ApiError } from "./api";
import "./OperationsFeedback.css";

type Detail = { feedback: StaffClientFeedbackItem; events: ClientFeedbackEvent[] };
type Page = { items: StaffClientFeedbackItem[]; nextCursor: string | null };
type Route = { id: string | null; status: ClientFeedbackStatus | "all"; q: string; accountId: string | null; invalid: boolean };
type Change = { status: "in_progress" | "done"; note: string; key: string; revision: number; id: string };
const statuses = ["new", "in_progress", "done"];
const statusLabel = (status: string) => status === "in_progress" ? "In Progress" : status === "new" ? "New" : status === "done" ? "Done" : "All";
const nullableText = (value: unknown) => value === null || typeof value === "string";
function readRoute(): Route {
  const parts = location.pathname.split("/").filter(Boolean), params = new URLSearchParams(location.search);
  let id: string | null = null, invalid = parts.length > 3;
  if (parts[2]) { try { id = decodeURIComponent(parts[2]); invalid ||= !/^[A-Za-z0-9_-]{1,128}$/.test(id); } catch { invalid = true; } }
  const value = params.get("status");
  return { id, invalid, status: statuses.includes(value || "") || value === "all" ? value as Route["status"] : "new", q: (params.get("q") || "").trim().slice(0, 200), accountId: params.get("accountId") };
}
function path(route: Route, id: string | null = null): string {
  const params = new URLSearchParams({ status: route.status });
  if (route.q) params.set("q", route.q);
  if (route.accountId) params.set("accountId", route.accountId);
  return `/clients/feedback${id ? `/${encodeURIComponent(id)}` : ""}?${params}`;
}
function itemValid(value: unknown): value is StaffClientFeedbackItem {
  if (!value || typeof value !== "object") return false;
  const row = value as StaffClientFeedbackItem;
  return typeof row.id === "string" && Boolean(row.id) && statuses.includes(row.status) && Number.isSafeInteger(row.revision) && row.revision > 0
    && typeof row.message === "string" && typeof row.accountName === "string" && typeof row.canStart === "boolean" && typeof row.canComplete === "boolean"
    && nullableText(row.completionNote) && nullableText(row.completedAt) && typeof row.createdAt === "string" && typeof row.updatedAt === "string"
    && Boolean(row.target) && ["project", "folder", "file"].includes(row.target.kind) && typeof row.target.label === "string"
    && nullableText(row.target.projectName) && nullableText(row.target.projectId) && typeof row.target.available === "boolean" && nullableText(row.target.actionPath);
}
function detailValid(value: Detail): boolean {
  return itemValid(value.feedback) && Array.isArray(value.events) && value.events.every(event => Number.isSafeInteger(event.revision) && statuses.includes(event.status)
    && ["client", "staff"].includes(event.actor) && nullableText(event.note) && typeof event.createdAt === "string");
}
function safeClientHubTargetPath(value: string | null): string | null {
  if (!value || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value, location.origin), match = url.pathname.match(/^\/clients\/sources\/([^/]+)\/business\/(organizations|standalone)\/([^/]+)\/business-projects\/([^/]+)$/);
    if (url.origin !== location.origin || url.search || url.hash || !match) return null;
    const [source, root, project] = [match[1], match[3], match[4]].map(part => decodeURIComponent(part!));
    const validProject = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(project!);
    // Primary legacy IDs are canonical Client Hub IDs but not necessarily
    // 32-character native public IDs. Neither accepted form carries a
    // Delivery storage key or prefix.
    const validRoot = source === "project-alpha:primary"
      ? /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(root!)
      : /^[a-f0-9]{32}$/.test(root!);
    return /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(source!) && validRoot && validProject ? url.pathname : null;
  } catch { return null; }
}

export function OperationsFeedback() {
  const [route, setRoute] = useState(readRoute), [draft, setDraft] = useState(route.q);
  const [items, setItems] = useState<StaffClientFeedbackItem[]>([]), [detail, setDetail] = useState<Detail | null>(null);
  const [cursor, setCursor] = useState<string | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [change, setChange] = useState<Change | null>(null), [busy, setBusy] = useState(false), [actionError, setActionError] = useState(""), [notice, setNotice] = useState("");
  const pending = useRef<AbortController | null>(null), mutation = useRef<AbortController | null>(null), sequence = useRef(0);
  const retryCursor = useRef<string | null>(null), frozenChange = useRef<Change | null>(null);
  function invalidate(message: string) {
    pending.current?.abort(); pending.current = null; mutation.current?.abort(); mutation.current = null; sequence.current++;
    setItems([]); setDetail(null); setCursor(null); setChange(null); frozenChange.current = null;
    setLoading(false); setBusy(false); setActionError(""); setNotice(""); retryCursor.current = null; setError(message);
  }
  async function load(next: string | null = null) {
    if (route.invalid) { invalidate("This feedback link is invalid."); return; }
    if (next && pending.current) return;
    pending.current?.abort(); const controller = new AbortController(), run = ++sequence.current; pending.current = controller;
    setLoading(true); setError(""); retryCursor.current = next;
    const params = new URLSearchParams({ status: route.status });
    if (route.q) params.set("q", route.q); if (route.accountId) params.set("accountId", route.accountId); if (next) params.set("cursor", next);
    try {
      const result = await api<Detail | Page>(route.id ? `/api/operations/feedback/${encodeURIComponent(route.id)}` : `/api/operations/feedback?${params}`, { signal: controller.signal });
      if (controller.signal.aborted || run !== sequence.current) return;
      if ("feedback" in result) {
        if (!detailValid(result) || result.feedback.id !== route.id) throw new Error("Feedback details could not be verified.");
        setDetail(result);
      } else {
        if (!Array.isArray(result.items) || !result.items.every(itemValid) || !(result.nextCursor === null || typeof result.nextCursor === "string" && result.nextCursor)) throw new Error("Feedback records could not be verified.");
        setItems(previous => [...new Map((next ? [...previous, ...result.items] : result.items).map(item => [item.id, item])).values()]); setCursor(result.nextCursor);
      }
    } catch (caught) {
      if (controller.signal.aborted || run !== sequence.current) return;
      if (caught instanceof ApiError && [401, 403, 404, 409, 410].includes(caught.status)) { invalidate("Feedback or your access changed. Refresh to check current access."); return; }
      setError("Feedback could not be loaded. Try again.");
    } finally { if (!controller.signal.aborted && run === sequence.current) { pending.current = null; setLoading(false); } }
  }
  useEffect(() => { const update = () => { setRoute(readRoute()); }; addEventListener("popstate", update); return () => removeEventListener("popstate", update); }, []);
  useEffect(() => {
    setDraft(route.q); setItems([]); setDetail(null); setCursor(null); setChange(null); frozenChange.current = null; setActionError(""); setNotice(""); setBusy(false);
    void load(); return () => { sequence.current++; pending.current?.abort(); pending.current = null; mutation.current?.abort(); mutation.current = null; };
  }, [route.id, route.status, route.q, route.accountId, route.invalid]);
  const navigate = (next: Route) => { history.pushState(null, "", path(next, next.id)); setRoute(next); };
  const search = (event: FormEvent) => { event.preventDefault(); navigate({ ...route, id: null, q: draft.trim() }); };
  const choose = (status: Change["status"]) => { if (!detail || mutation.current) return; frozenChange.current = null; setActionError(""); setChange({ status, note: "", key: crypto.randomUUID(), revision: detail.feedback.revision, id: detail.feedback.id }); };
  async function applyChange() {
    if (!change || mutation.current) return;
    const current = frozenChange.current || { ...change, note: change.note.trim() }; frozenChange.current = current;
    const controller = new AbortController(), run = sequence.current; mutation.current = controller; setBusy(true); setActionError("");
    pending.current?.abort(); pending.current = null; setLoading(false);
    try {
      const result = await api<Detail & { replayed: boolean; appliedRevision: number }>(`/api/operations/feedback/${encodeURIComponent(current.id)}/status`, {
        method: "POST", signal: controller.signal, headers: { "Idempotency-Key": current.key }, body: JSON.stringify({ expectedRevision: current.revision, status: current.status, note: current.note || null }),
      });
      if (controller.signal.aborted || run !== sequence.current) return;
      if (!detailValid(result) || result.feedback.id !== current.id || result.appliedRevision !== current.revision + 1 || result.feedback.revision < result.appliedRevision || (result.feedback.revision === result.appliedRevision && result.feedback.status !== current.status)) throw new Error("Unconfirmed status update");
      setDetail(result); setChange(null); frozenChange.current = null;
      setNotice(current.status === "done" ? "Feedback marked Done. The completion update is queued; this does not confirm email delivery." : "Feedback marked In Progress.");
    } catch (caught) {
      if (controller.signal.aborted || run !== sequence.current) return;
      if (caught instanceof ApiError && [401, 403, 404, 409, 410].includes(caught.status)) { invalidate("Feedback or your access changed. Refresh before making another update."); return; }
      setActionError("We could not confirm the update. Retry to check the same action.");
    } finally { if (!controller.signal.aborted && mutation.current === controller) { mutation.current = null; setBusy(false); } }
  }
  return <section className="operations-feedback" aria-label="Client feedback">
    <header><div><span className="eyebrow">Client feedback</span><h2>{route.id ? "Feedback details" : "Feedback queue"}</h2><p>Review client comments about projects, folders, and files.</p></div>
      {route.id ? <a className="button button-ghost" href={path(route)}>Back to feedback queue</a> : <button className="button-ghost" disabled={loading} onClick={() => void load()}>Refresh feedback</button>}</header>
    {!route.id && <><nav aria-label="Feedback status">{["new", "in_progress", "done", "all"].map(status => <button className="button-ghost" key={status} aria-pressed={route.status === status} onClick={() => navigate({ ...route, status: status as Route["status"] })}>{statusLabel(status)}</button>)}</nav>
      <form onSubmit={search}><label>Search feedback<input value={draft} maxLength={200} onChange={event => setDraft(event.target.value)} placeholder="Client, project, file, or comment" /></label><button className="button-orange">Search</button></form>
      {route.accountId && <p>Showing feedback for this client account. <a href={path({ ...route, accountId: null })}>Show all clients</a></p>}</>}
    {notice && <p role="status">{notice}</p>}
    {error && <div role="alert"><p>{error}</p>{!route.invalid && <button className="button-ghost" onClick={() => void load(retryCursor.current)}>Retry feedback</button>}</div>}
    {loading && <p role="status">Loading feedback…</p>}
    {!route.id && <><div className="operations-feedback-list">{items.map(item => <Card key={item.id}><a href={path(route, item.id)}><h3>{item.target.label}</h3></a><FeedbackContent item={item} /></Card>)}</div>
      {!loading && !error && !items.length && <p>{cursor ? "No matching feedback in this page. Continue to check more records." : "No feedback matches this view."}</p>}
      {cursor && <button className="button-ghost" disabled={loading} onClick={() => void load(cursor)}>Load more feedback</button>}</>}
    {detail && <Card title={detail.feedback.target.label}><FeedbackContent item={detail.feedback} />
      <div className="operations-feedback-actions">{detail.feedback.canStart && <button className="button-ghost" disabled={busy || Boolean(frozenChange.current)} onClick={() => choose("in_progress")}>Mark In Progress</button>}{detail.feedback.canComplete && <button className="button-orange" disabled={busy || Boolean(frozenChange.current)} onClick={() => choose("done")}>Mark Done</button>}</div>
      {change && <section className="operations-feedback-change" aria-label="Update feedback"><h3>{change.status === "done" ? "Complete feedback" : "Start feedback"}</h3>
        {change.status === "done" && <label>Completion note (optional)<textarea rows={4} maxLength={CLIENT_FEEDBACK_NOTE_LIMIT} value={change.note} readOnly={Boolean(frozenChange.current)} onChange={event => setChange({ ...change, note: event.target.value })} /></label>}
        <p>The client can see this note. {change.status === "done" ? "Marking Done queues a completion update and the original client location when still available." : "This records that work is in progress."}</p>
        {actionError && <p role="alert">{actionError}</p>}<div className="operations-feedback-actions"><button className="button-orange" disabled={busy} onClick={() => void applyChange()}>{busy ? "Saving…" : frozenChange.current ? "Retry update" : `Confirm ${statusLabel(change.status)}`}</button><button className="button-ghost" disabled={busy || Boolean(frozenChange.current)} onClick={() => setChange(null)}>Cancel</button></div></section>}
      <section className="operations-feedback-history" aria-label="Feedback history"><h3>History</h3>{detail.events.map(event => <article key={event.revision}><strong>{statusLabel(event.status)}</strong><small>{event.actor === "staff" ? "Team" : "Client"} · {new Date(event.createdAt).toLocaleString()}</small>{event.note && <p>{event.note}</p>}</article>)}</section>
    </Card>}
  </section>;
}
function FeedbackContent({ item }: { item: StaffClientFeedbackItem }) {
  const actionPath = item.target.available ? safeClientHubTargetPath(item.target.actionPath) : null;
  return <div className="operations-feedback-content"><div><StatusPill tone={item.status === "done" ? "success" : "neutral"}>{statusLabel(item.status)}</StatusPill></div><p><strong>{item.accountName}</strong>{item.target.projectName ? ` · ${item.target.projectName}` : ""}</p><p>{item.message}</p>
    {item.completionNote && <div><strong>Completion note</strong><p>{item.completionNote}</p></div>}<small>Submitted {new Date(item.createdAt).toLocaleString()}</small>
    {actionPath && <p><a className="button button-ghost" href={actionPath}>Open original item</a></p>}
    {!item.target.available && <p>The original item is no longer available. This record does not link to replacement files.</p>}</div>;
}
