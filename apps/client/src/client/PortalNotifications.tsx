import { useEffect, useRef, useState } from "react";
import { requestJson, type RequestError } from "./bulk-download";
import { safeFeedbackTargetPath } from "./feedback-api";
import type { PortalNotification, PortalNotificationPage } from "./portal-api";

type FeedbackNotification = Omit<PortalNotification, "eventType"> & {feedbackId: string};
type Notice = PortalNotification | FeedbackNotification;
type Group = {items: Notice[]; cursor: string | null; error: string; loading: boolean; unread?: number};
const empty = (): Group => ({items: [], cursor: null, error: "", loading: true});
function exactActionPath(value: string | null, workspaceId: string | null): string | null {
  const safe = safeFeedbackTargetPath(value);
  if (!safe || !workspaceId) return safe;
  const url = new URL(safe, location.origin);
  url.searchParams.set("workspace", workspaceId);
  return `${url.pathname}${url.search}${url.hash}`;
}
export function PortalNotifications({feedbackEnabled, requestsEnabled = true, nativeWorkspaceId = null}: {
  feedbackEnabled: boolean; requestsEnabled?: boolean; nativeWorkspaceId?: string | null;
}) {
  const [open, setOpen] = useState(false), [requests, setRequests] = useState<Group>(() => requestsEnabled ? empty() : {...empty(), loading: false});
  const [feedback, setFeedback] = useState<Group>(() => feedbackEnabled ? empty() : {...empty(), loading: false});
  const root = useRef<HTMLDivElement>(null), generation = useRef(0), controllers = useRef(new Map<string, AbortController>());
  const [busy, setBusy] = useState<string[]>([]);
  const retryCursors = useRef<Record<string, string | null>>({});
  const confirmed = useRef(new Map<string, "read" | "dismiss">());
  function clearAccess() {
    generation.current++; for (const controller of controllers.current.values()) controller.abort(); controllers.current.clear(); confirmed.current.clear(); setBusy([]);
    const blocked = {items: [], cursor: null, loading: false, error: "Notifications or your access changed. Refresh to check again."}; setRequests(blocked); setFeedback(blocked);
  }
  async function load(kind: "requests" | "feedback", cursor: string | null = null) {
    const key = `load:${kind}`; if (controllers.current.has(key)) return;
    const controller = new AbortController(), run = generation.current; controllers.current.set(key, controller); retryCursors.current[kind] = cursor;
    const setter = kind === "requests" ? setRequests : setFeedback; setter(value => ({...value, loading: true, error: ""}));
    try {
      const base = kind === "requests" ? "/api/client/notifications" : nativeWorkspaceId
        ? `/api/client/v2/workspaces/${encodeURIComponent(nativeWorkspaceId)}/feedback-notifications`
        : "/api/client/feedback-notifications";
      const page = await requestJson<PortalNotificationPage & {nextCursor: string | null}>(`${base}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, {signal: controller.signal});
      if (controller.signal.aborted || run !== generation.current) return;
      const next = kind === "requests" ? page.cursor : page.nextCursor;
      if (!Array.isArray(page.notifications) || !page.notifications.every(row => row && typeof row.id === "string" && typeof row.title === "string" && typeof row.body === "string" && typeof row.createdAt === "string" && (row.readAt === null || typeof row.readAt === "string") && (row.actionPath === null || safeFeedbackTargetPath(row.actionPath))) || !(next === null || typeof next === "string" && next)) throw new Error("Invalid notifications");
      const rows = page.notifications.filter(row => confirmed.current.get(`${kind}:${row.id}`) !== "dismiss").map(row => confirmed.current.has(`${kind}:${row.id}`) ? {...row, readAt: row.readAt || new Date().toISOString()} : row);
      setter(value => ({items: [...new Map((cursor ? [...value.items, ...rows] : rows).map(row => [row.id, row])).values()], cursor: next, error: "", loading: false, unread: kind === "requests" ? Math.max(0, page.unreadCount - page.notifications.filter(row => !row.readAt && confirmed.current.has(`${kind}:${row.id}`)).length) : undefined}));
    } catch (caught) {
      if (controller.signal.aborted || run !== generation.current) return;
      if ([401, 403, 404, 409, 410].includes((caught as RequestError).status ?? 0)) { clearAccess(); return; }
      setter(value => ({...value, error: "Notifications could not be loaded.", loading: false}));
    } finally { if (controllers.current.get(key) === controller) controllers.current.delete(key); }
  }
  useEffect(() => {
    if (requestsEnabled) void load("requests"); else setRequests({...empty(), loading: false});
    if (feedbackEnabled) void load("feedback"); else setFeedback({...empty(), loading: false});
    return () => { generation.current++; for (const controller of controllers.current.values()) controller.abort(); controllers.current.clear(); };
  }, [feedbackEnabled, requestsEnabled, nativeWorkspaceId]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key === "Escape") { setOpen(false); root.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
      else if (event instanceof MouseEvent && root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", close);
    return () => {document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close);};
  }, [open]);
  async function mutate(kind: "requests" | "feedback", item: Notice, action: "read" | "dismiss") {
    const key = `${kind}:${item.id}`; if (controllers.current.has(key)) return;
    const controller = new AbortController(), run = generation.current; controllers.current.set(key, controller); setBusy(value => [...value, key]);
    const setter = kind === "requests" ? setRequests : setFeedback;
    try {
      const base = kind === "requests" ? "/api/client/notifications" : nativeWorkspaceId
        ? `/api/client/v2/workspaces/${encodeURIComponent(nativeWorkspaceId)}/feedback-notifications`
        : "/api/client/feedback-notifications";
      await requestJson(`${base}/${encodeURIComponent(item.id)}`, {method: "PATCH", signal: controller.signal, headers: {"Content-Type": "application/json"}, body: JSON.stringify({action})});
      if (controller.signal.aborted || run !== generation.current) return;
      confirmed.current.set(key, action);
      setter(value => ({...value, error: "", items: action === "dismiss" ? value.items.filter(row => row.id !== item.id) : value.items.map(row => row.id === item.id ? {...row, readAt: new Date().toISOString()} : row), unread: value.unread === undefined ? undefined : Math.max(0, value.unread - (item.readAt ? 0 : 1))}));
    } catch (caught) {
      if (controller.signal.aborted || run !== generation.current) return;
      if ([401, 403, 404, 409, 410].includes((caught as RequestError).status ?? 0)) { clearAccess(); return; }
      setter(value => ({...value, error: "The notification update could not be confirmed. Try the action again."}));
    } finally { if (!controller.signal.aborted && controllers.current.get(key) === controller) {controllers.current.delete(key); setBusy(value => value.filter(id => id !== key));} }
  }
  const feedbackUnread = feedbackEnabled && feedback.items.some(row => !row.readAt), unread = requestsEnabled ? requests.unread || 0 : 0;
  const requestLabel = nativeWorkspaceId ? "Request updates" : "Request and delivery updates";
  const group = (kind: "requests" | "feedback", state: Group) => <section aria-label={kind === "requests" ? requestLabel : "Feedback updates"}>
    {(feedbackEnabled && requestsEnabled) && <h3>{kind === "requests" ? (nativeWorkspaceId ? "Requests" : "Requests and deliveries") : "Feedback updates"}</h3>}
    {state.loading && <p role="status">Loading notifications…</p>}{state.error && <div role="alert"><p>{state.error}</p><button className="button-ghost button-small" onClick={() => void load(kind, retryCursors.current[kind] ?? null)}>Retry notifications</button></div>}
    {!state.loading && !state.error && !state.items.length && <p className="portal-notification-empty">{state.cursor ? "Continue to check more updates." : "You’re all caught up."}</p>}
    <div className="portal-notification-list">{state.items.map(item => { const actionPath = exactActionPath(item.actionPath, nativeWorkspaceId); return <article key={item.id} className={item.readAt ? "" : "is-unread"}>
      {actionPath ? <a href={actionPath} onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); const run = generation.current;
        void mutate(kind, item, "read").then(() => { if (generation.current === run) window.location.assign(actionPath); });
      }}><strong>{item.title}</strong></a> : <strong>{item.title}</strong>}<p>{item.body}</p><small>{new Date(item.createdAt).toLocaleString()}</small>
      <div>{!item.readAt && <button className="button-ghost button-small" disabled={busy.includes(`${kind}:${item.id}`)} onClick={() => void mutate(kind, item, "read")}>Mark read</button>}<button className="button-ghost button-small" disabled={busy.includes(`${kind}:${item.id}`)} onClick={() => void mutate(kind, item, "dismiss")}>Dismiss</button></div>
    </article>; })}</div>{state.cursor && <button className="button-ghost button-small" disabled={state.loading} onClick={() => void load(kind, state.cursor)}>Load more {kind === "feedback" ? "feedback updates" : "updates"}</button>}
  </section>;
  const unreadLabel = nativeWorkspaceId ? `${unread} unread request update${unread === 1 ? "" : "s"}` : `${unread} unread request and delivery updates`;
  return <div className="portal-notification-center" ref={root}><button className="portal-notification-bell" aria-label={`Notifications${unread ? `, ${unreadLabel}` : ""}${feedbackUnread ? ", unread feedback updates" : ""}`} aria-expanded={open} aria-controls="portal-notification-panel" onClick={() => setOpen(value => !value)}><span aria-hidden="true">🔔</span>{unread > 0 && <span className="portal-notification-count">{unread > 99 ? "99+" : unread}</span>}{feedbackUnread && <span className="portal-feedback-unread" aria-hidden="true">•</span>}</button>
    {open && <section id="portal-notification-panel" className="portal-notification-panel" aria-label="Notifications"><header><strong>Notifications</strong><button className="button-ghost button-small" onClick={() => setOpen(false)} aria-label="Close notifications">Close</button></header>{requestsEnabled && group("requests", requests)}{feedbackEnabled && group("feedback", feedback)}</section>}
  </div>;
}
