import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Card, EmptyState, StatusPill } from "@ltds/ui";
import { api, ApiError } from "./api";
import "./OperationsNotifications.css";

type BatchStatus = "pending" | "processing" | "sent" | "cancelled" | "suppressed" | "failed";
type BatchAction = "send-now" | "cancel";
interface NotificationBatch {
  id: string; revision: number; status: BatchStatus; accountName: string; folderLabel: string; recipientEmail: string | null;
  addedCount: number; removedCount: number; eligibleAt: string; createdAt: string; updatedAt: string; deliveredAt: string | null;
  errorCode: string | null; canSendNow: boolean; canCancel: boolean;
}
interface NotificationPage { items: NotificationBatch[]; nextCursor: string | null; serverNow: string; coverage: "legacy_folder_changes" }
type NotificationRoute = { view: "pending" | "history"; q: string; batchId: string | null; invalid: boolean };
type Mutation = { id: string; label: string; action: BatchAction; revision: number; key: string; busy: boolean; error: string };
const statuses: BatchStatus[] = ["pending", "processing", "sent", "cancelled", "suppressed", "failed"];
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const textOrNull = (value: unknown) => value === null || typeof value === "string";
const isoTime = (value: unknown): value is string => typeof value === "string" && /Z$|[+-]\d{2}:\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
const readRoute = (): NotificationRoute => {
  const params = new URLSearchParams(location.search);
  const batchId = params.get("batchId");
  return { view: params.get("view") === "history" ? "history" : "pending", q: (params.get("q") || "").trim().slice(0, 200), batchId,
    invalid: params.getAll("batchId").length > 1 || (batchId !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(batchId)) };
};
function pageValid(value: unknown, view: NotificationRoute["view"], exactId?: string | null): value is NotificationPage {
  return record(value) && value.coverage === "legacy_folder_changes" && isoTime(value.serverNow)
    && (value.nextCursor === null || typeof value.nextCursor === "string" && value.nextCursor.length > 0)
    && Array.isArray(value.items) && value.items.every(item => record(item) && typeof item.id === "string" && item.id.length > 0
      && Number.isSafeInteger(item.revision) && Number(item.revision) > 0 && statuses.includes(item.status as BatchStatus)
      && (exactId ? item.id === exactId : view === "pending" ? item.status === "pending" || item.status === "processing" : item.status !== "pending" && item.status !== "processing")
      && typeof item.accountName === "string" && typeof item.folderLabel === "string" && textOrNull(item.recipientEmail)
      && [item.addedCount, item.removedCount].every(count => Number.isSafeInteger(count) && Number(count) >= 0)
      && [item.eligibleAt, item.createdAt, item.updatedAt].every(isoTime) && (item.deliveredAt === null || isoTime(item.deliveredAt))
      && textOrNull(item.errorCode) && typeof item.canSendNow === "boolean" && typeof item.canCancel === "boolean");
}
function shownTime(value: string): string {
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
function eligibility(row: NotificationBatch, now: number): string {
  if (row.status === "processing") return "Dispatch in progress";
  const seconds = Math.max(0, Math.ceil((Date.parse(row.eligibleAt) - now) / 1000));
  return seconds ? `Eligible in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "Ready for dispatch";
}
function statusLabel(status: BatchStatus): string {
  return status === "suppressed" ? "Not sent" : status[0]!.toUpperCase() + status.slice(1);
}

export function OperationsNotifications() {
  const [route, setRoute] = useState(readRoute), [draft, setDraft] = useState(route.q);
  const [rows, setRows] = useState<NotificationBatch[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<{ message: string; cursor?: string } | null>(null);
  const [mutation, setMutation] = useState<Mutation | null>(null), [message, setMessage] = useState("");
  const [lastUpdated, setLastUpdated] = useState<string | null>(null), [clock, setClock] = useState(Date.now());
  const [pageCount, setPageCount] = useState(0);
  const pending = useRef<AbortController | null>(null), requestSequence = useRef(0), mounted = useRef(true);
  const mutationController = useRef<AbortController | null>(null), mutationRef = useRef<Mutation | null>(null);
  const confirmed = useRef(new Map<string, { revision: number; status: BatchStatus }>());
  const serverClock = useRef<{ at: number; received: number } | null>(null), currentRoute = useRef(route);
  currentRoute.current = route;
  const updateMutation = (value: Mutation | null) => { mutationRef.current = value; setMutation(value); };

  const clearProtected = useCallback((message: string) => {
    pending.current?.abort(); pending.current = null; requestSequence.current += 1;
    mutationController.current?.abort(); mutationController.current = null;
    mutationRef.current = null; setMutation(null); setMessage(""); confirmed.current.clear();
    setRows([]); setNextCursor(null); setPageCount(0); setLastUpdated(null); serverClock.current = null;
    setLoading(false); setLoadingMore(false); setError({ message });
  }, []);

  const load = useCallback(async (cursor?: string, quiet = false) => {
    if (quiet && (pending.current || mutationRef.current || document.hidden)) return;
    if (currentRoute.current.invalid) { clearProtected("This notification link is invalid. Choose Pending or History to browse notifications."); return; }
    pending.current?.abort();
    const controller = new AbortController(), sequence = ++requestSequence.current;
    pending.current = controller;
    const requested = currentRoute.current;
    const valid = () => mounted.current && !controller.signal.aborted && sequence === requestSequence.current;
    if (cursor) setLoadingMore(true); else if (!quiet) setLoading(true);
    setError(null);
    const params = new URLSearchParams({ view: requested.view });
    if (requested.q) params.set("q", requested.q);
    if (cursor) params.set("cursor", cursor);
    try {
      const value = await api<unknown>(requested.batchId ? `/api/notifications/deliveries/${encodeURIComponent(requested.batchId)}`
        : `/api/notifications/deliveries?${params}`, { signal: controller.signal });
      if (!valid()) return;
      const result = requested.batchId && record(value) ? { items: [value.item], nextCursor: null, serverNow: value.serverNow, coverage: value.coverage } : value;
      if (!pageValid(result, requested.view, requested.batchId)) {
        if (requested.batchId) { clearProtected("This notification could not be verified. Refresh to check its current state."); return; }
        throw new Error("Notification records could not be verified. Refresh to try again.");
      }
      // A delayed pre-action read must not resurrect a cancelled or older batch.
      const received = result.items.filter(row => {
        const floor = confirmed.current.get(row.id);
        if (!floor) return true;
        if (row.revision > floor.revision) { confirmed.current.delete(row.id); return true; }
        return row.revision === floor.revision && row.status === floor.status;
      });
      setRows(previous => {
        const merged = new Map((cursor ? previous : []).map(row => [row.id, row]));
        for (const row of received) {
          const existing = merged.get(row.id);
          if (!existing || row.revision >= existing.revision) merged.set(row.id, row);
        }
        return [...merged.values()];
      });
      setNextCursor(result.nextCursor); setPageCount(previous => cursor ? previous + 1 : 1);
      setLastUpdated(result.serverNow); serverClock.current = { at: Date.parse(result.serverNow), received: performance.now() };
      setClock(Date.parse(result.serverNow));
    } catch (caught) {
      if (!valid()) return;
      if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) {
        clearProtected(caught.status === 401 ? "Sign in again to view notifications." : "Notification access is no longer available.");
      } else if (caught instanceof ApiError && caught.status === 409) {
        clearProtected("Notifications changed while this page was loading. Refresh the list.");
      } else if (requested.batchId && caught instanceof ApiError && [404, 410].includes(caught.status)) {
        clearProtected("This notification is unavailable or your access changed. Choose Pending or History to browse current notifications.");
      } else setError({ message: caught instanceof Error ? caught.message : "Notifications could not be loaded.", cursor });
    } finally {
      if (valid()) { pending.current = null; setLoading(false); setLoadingMore(false); }
    }
  }, [clearProtected]);

  useEffect(() => {
    mounted.current = true;
    const syncRoute = () => {
      if (location.pathname !== "/operations/notifications") return;
      const next = readRoute();
      setDraft(next.q);
      if (next.view === currentRoute.current.view && next.q === currentRoute.current.q && next.batchId === currentRoute.current.batchId && next.invalid === currentRoute.current.invalid) return;
      pending.current?.abort(); pending.current = null; requestSequence.current += 1;
      currentRoute.current = next; setRoute(next);
    };
    addEventListener("popstate", syncRoute);
    return () => {
      mounted.current = false; pending.current?.abort(); requestSequence.current += 1;
      mutationController.current?.abort(); removeEventListener("popstate", syncRoute);
    };
  }, []);
  useEffect(() => {
    setRows([]); setNextCursor(null); setPageCount(0); setLastUpdated(null); setLoadingMore(false);
    void load();
    return () => { pending.current?.abort(); pending.current = null; requestSequence.current += 1; };
  }, [route.view, route.q, route.batchId, route.invalid, load]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const synced = serverClock.current;
      if (synced) setClock(synced.at + performance.now() - synced.received);
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    // Do not throw away additional pages the operator explicitly loaded.
    if ((!route.batchId && route.view !== "pending") || route.invalid || pageCount !== 1) return;
    const refresh = () => { void load(undefined, true); };
    const timer = window.setInterval(refresh, 20_000);
    addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); removeEventListener("focus", refresh); };
  }, [route.view, route.batchId, route.invalid, pageCount, load]);

  const navigate = (next: NotificationRoute) => {
    setDraft(next.q);
    if (next.view === currentRoute.current.view && next.q === currentRoute.current.q && next.batchId === currentRoute.current.batchId && next.invalid === currentRoute.current.invalid) return;
    pending.current?.abort(); pending.current = null; requestSequence.current += 1;
    const params = new URLSearchParams();
    if (next.view === "history") params.set("view", "history");
    if (next.q) params.set("q", next.q);
    if (next.batchId) params.set("batchId", next.batchId);
    history.pushState(null, "", `/operations/notifications${params.size ? `?${params}` : ""}`);
    currentRoute.current = next; setRoute(next);
  };
  const search = (event: FormEvent) => { event.preventDefault(); navigate({ ...route, q: draft.trim().slice(0, 200) }); };
  const perform = async (operation: Mutation) => {
    if (mutationRef.current?.busy) return;
    const active = { ...operation, busy: true, error: "" };
    updateMutation(active); setMessage("");
    const controller = new AbortController(); mutationController.current = controller;
    const valid = () => mounted.current && !controller.signal.aborted && mutationRef.current?.key === active.key;
    try {
      const result = await api<unknown>(`/api/notifications/deliveries/${encodeURIComponent(active.id)}/${active.action}`, {
        method: "POST", signal: controller.signal, headers: { "Idempotency-Key": active.key },
        body: JSON.stringify({ expectedRevision: active.revision }),
      });
      if (!valid()) return;
      if (!record(result) || result.ok !== true || result.id !== active.id || result.action !== active.action
        || result.revision !== active.revision + 1
        || result.status !== (active.action === "cancel" ? "cancelled" : "pending")
        || typeof result.replayed !== "boolean") throw new Error("The action outcome could not be confirmed.");
      confirmed.current.set(active.id, { revision: Number(result.revision), status: result.status as BatchStatus });
      updateMutation(null);
      setRows(previous => previous.filter(row => row.id !== active.id));
      setMessage(active.action === "cancel" ? "Notification cancelled. Files and access are unchanged; later file changes can create a new notification. Email already accepted for delivery and published inbox notices cannot be recalled."
        : "Notification made eligible for dispatch. This does not confirm delivery; a new file change before dispatch can restart the waiting period.");
      void load();
    } catch (caught) {
      if (!valid()) return;
      if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) {
        clearProtected(caught.status === 401 ? "Sign in again before managing notifications." : "You no longer have permission for this notification action.");
      } else if (caught instanceof ApiError && [400, 404, 409].includes(caught.status)) {
        updateMutation(null);
        setRows([]); setNextCursor(null); setPageCount(0); setLastUpdated(null);
        setMessage(caught.status === 409 ? "This notification changed before the action could be applied. Review its refreshed state before trying again." : caught.message);
        void load();
      } else updateMutation({ ...active, busy: false, error: "The action outcome could not be confirmed. Retry checks the same operation without creating a second request." });
    } finally { if (mutationController.current === controller) mutationController.current = null; }
  };
  const begin = (row: NotificationBatch, action: BatchAction) => {
    if (mutationRef.current || row.status !== "pending" || !(action === "send-now" ? row.canSendNow : row.canCancel)) return;
    if (action === "cancel" && !confirm(`Cancel the notification for ${row.accountName} · ${row.folderLabel}? This stops remaining attempts. It does not remove files or change access. Email already accepted for delivery and published inbox notices cannot be recalled. Later file changes can create a new notification.`)) return;
    void perform({ id: row.id, label: `${row.accountName} · ${row.folderLabel}`, action, revision: row.revision, key: crypto.randomUUID(), busy: false, error: "" });
  };

  return <section className="page-stack operations-notifications" aria-label="Delivery notification center">
    <div className="page-heading"><div><h2>Notifications</h2>
      <p>{route.batchId ? "Review this exact client-folder notification and its current delivery status." : "Review pending client-folder notifications and their delivery history."}</p></div>
      <button className="button-ghost" type="button" aria-disabled={loading || loadingMore || mutation?.busy} onClick={() => {
        if (!pending.current && !mutationRef.current?.busy) void load();
      }}>Refresh notifications</button></div>
    <div className="notification-coverage"><strong>Client-folder change notices only</strong>
      <p>Legacy client-workspace folder subscriptions; other notification sources are not shown.</p>
      <details><summary>About these notifications</summary>
        <p>The countdown shows the earliest dispatch time, not a delivery guarantee. Recipient eligibility is checked again before dispatch. New file changes can restart the waiting period.</p>
        <p>Sent means accepted for delivery, not proof the recipient received or read the notice. Cancellation cannot recall email already accepted or inbox notices already published.</p>
      </details></div>
    <div className="notification-view-switch" role="group" aria-label="Notification views">
      {(["pending", "history"] as const).map(view => <button key={view} type="button" className={!route.batchId && !route.invalid && route.view === view ? "button-orange" : "button-ghost"}
        aria-pressed={!route.batchId && !route.invalid && route.view === view} onClick={() => navigate(route.batchId || route.invalid ? { view, q: "", batchId: null, invalid: false } : { ...route, view })}>{view === "pending" ? "Pending" : "History"}</button>)}
    </div>
    {route.batchId && !route.invalid && <p role="status">Showing the selected notification, including any status change since it was opened. Choose Pending or History to return to all notifications.</p>}
    {!route.batchId && !route.invalid && <form className="notification-search" role="search" aria-label="Find notifications" onSubmit={search}>
      <label>Search notifications<input maxLength={200} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Client or folder" /></label>
      <button type="submit" className="button-orange">Search</button>
      {(draft || route.q) && <button type="button" className="button-ghost" onClick={() => navigate({ ...route, q: "" })}>Clear search</button>}
    </form>}
    {mutation && <div className="notification-action-status" role={mutation.error ? "alert" : "status"}>
      <strong>{mutation.action === "cancel" ? "Cancel notification" : "Send now"}: {mutation.label}</strong>
      <p>{mutation.busy ? "Checking the action with the server…" : mutation.error}</p>
      {!mutation.busy && <button type="button" className="button-ghost" onClick={() => { if (mutationRef.current) void perform(mutationRef.current); }}>Retry action</button>}
    </div>}
    {message && <p className="notification-action-status" role="status">{message}</p>}
    <Card title={route.batchId ? "Selected notification" : route.view === "pending" ? "Pending delivery batches" : "Notification history"}>
      {lastUpdated && <p className="notification-freshness">Updated {shownTime(lastUpdated)}. {rows.length} {rows.length === 1 ? "batch" : "batches"} shown.
        {route.view === "pending" && pageCount > 1 ? " Refresh to check for new changes." : ""}</p>}
      {error && <div className="notification-error" role="alert"><span>{error.message}</span><button type="button" className="button-ghost"
        aria-disabled={loading || loadingMore} onClick={() => { if (!pending.current) void load(error.cursor); }}>Retry notifications</button></div>}
      {loading && <p role="status">Loading notifications…</p>}
      <div className="notification-batch-list">
        {rows.map(row => <article key={row.id} className="notification-batch" aria-label={`${row.accountName} · ${row.folderLabel}`}>
          <header><div><h3>{row.accountName}</h3><p>{row.folderLabel}</p></div>
            <StatusPill tone={row.status === "failed" ? "danger" : row.status === "sent" ? "success" : row.status === "pending" ? "warning" : "neutral"}>{statusLabel(row.status)}</StatusPill></header>
          <dl><div><dt>Recipient</dt><dd>{row.recipientEmail || "Recipient no longer available"}</dd></div>
            <div><dt>Net changes</dt><dd>{row.addedCount.toLocaleString()} added · {row.removedCount.toLocaleString()} removed</dd></div>
            <div><dt>Created</dt><dd>{shownTime(row.createdAt)}</dd></div>
            <div><dt>{row.deliveredAt ? "Sent" : "Last updated"}</dt><dd>{shownTime(row.deliveredAt || row.updatedAt)}</dd></div></dl>
          {(row.status === "pending" || row.status === "processing") && <p className="notification-countdown" aria-live="off">{eligibility(row, clock)}</p>}
          {row.status === "processing" && <p>Dispatch has started and can no longer be cancelled here.</p>}
          {row.status === "pending" && row.errorCode === "delivery-attempt-failed" && <p>A delivery attempt failed. This batch is waiting for another attempt. An earlier email may already have been accepted, or an inbox notice published; cancellation cannot recall either.</p>}
          {row.status === "suppressed" && <p>Not sent after eligibility checks.</p>}
          {row.status === "failed" && <p>This notification could not be delivered.</p>}
          {row.status === "pending" && (row.canSendNow || row.canCancel) && <div className="notification-batch-actions">
            {row.canSendNow && <button type="button" className="button-orange" disabled={Boolean(mutation)} onClick={() => begin(row, "send-now")}>Send now</button>}
            {row.canCancel && <button type="button" className="button-danger" disabled={Boolean(mutation)} onClick={() => begin(row, "cancel")}>Cancel notification</button>}
          </div>}
        </article>)}
      </div>
      {!loading && !error && !rows.length && <EmptyState title={nextCursor ? "No matching notifications in this page" : route.view === "pending" ? "No pending notifications found" : "No notification history found"}
        detail={nextCursor ? "More records remain to be checked. Load more to continue." : route.q ? "Try another client or folder name." : "Only the client-folder subscriptions described above are included."} />}
      {(nextCursor || pageCount > 1) && <div className="notification-pagination"><button type="button" className="button-ghost"
        aria-disabled={loadingMore || loading || !nextCursor} onClick={() => { if (nextCursor && !pending.current) void load(nextCursor); }}>
        {loadingMore ? "Loading more…" : nextCursor ? "Load more notifications" : "No more notifications"}</button></div>}
    </Card>
  </section>;
}
