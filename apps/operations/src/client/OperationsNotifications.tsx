import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Card, EmptyState, StatusPill } from "@ltds/ui";
import { api, ApiError } from "./api";
import "./OperationsNotifications.css";

type BatchStatus = "pending" | "processing" | "sent" | "cancelled" | "suppressed" | "failed";
type BatchAction = "send-now" | "cancel";
type NotificationKind = "folder_changes" | "portal_delivery" | "authenticated_delivery";
interface NotificationBase {
  id: string; revision: number; status: BatchStatus; folderLabel: string; recipientEmail: string | null;
  eligibleAt: string; createdAt: string; updatedAt: string; deliveredAt: string | null;
  errorCode: string | null; canSendNow: boolean; canCancel: boolean;
}
type NotificationBatch = NotificationBase & ({ kind: "folder_changes"; accountName: string; addedCount: number; removedCount: number }
  | { kind: "portal_delivery"; sourceName: string; workspaceName: string; eventLabel: string; deliveryMode: "staged" | "direct_legacy" | "awaiting_staging" }
  | { kind: "authenticated_delivery"; workspaceName?: string; addedCount: number; removedCount: number });
interface NotificationPage { items: NotificationBatch[]; nextCursor: string | null; serverNow: string; coverage: "delivery_notifications_v2";
  availability: { folderChanges: true; nativeDeliveries: boolean; authenticatedDeliveries?: boolean } }
type NotificationRoute = { view: "pending" | "history"; q: string; batchId: string | null; kind: NotificationKind; invalid: boolean };
type Mutation = { id: string; kind: NotificationKind; label: string; action: BatchAction; revision: number; key: string; busy: boolean; error: string };
const statuses: BatchStatus[] = ["pending", "processing", "sent", "cancelled", "suppressed", "failed"];
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const boundedText = (value: unknown, max = 4000): value is string => typeof value === "string" && value.length <= max;
const textOrNull = (value: unknown) => value === null || boundedText(value);
const notificationKey = (row: { kind: NotificationKind; id: string }) => `${row.kind}:${row.id}`;
const notificationName = (row: NotificationBatch) => row.kind === "folder_changes" ? row.accountName
  : row.kind === "authenticated_delivery" ? row.workspaceName || "Authenticated delivery" : row.workspaceName;
const notificationApi = (row: { kind: NotificationKind; id: string }) => `/api/notifications/deliveries/${row.kind === "folder_changes" ? "" : `${row.kind}/`}${encodeURIComponent(row.id)}`;
const isoTime = (value: unknown): value is string => typeof value === "string" && /Z$|[+-]\d{2}:\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
const readRoute = (): NotificationRoute => {
  const params = new URLSearchParams(location.search);
  const batchId = params.get("batchId"), kind = params.get("kind");
  return { view: params.get("view") === "history" ? "history" : "pending", q: (params.get("q") || "").trim().slice(0, 200), batchId,
    kind: kind === "portal_delivery" || kind === "authenticated_delivery" ? kind : "folder_changes",
    invalid: params.getAll("batchId").length > 1 || params.getAll("kind").length > 1
      || (kind !== null && (batchId === null || !["folder_changes", "portal_delivery", "authenticated_delivery"].includes(kind)))
      || (batchId !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(batchId)) };
};
function pageValid(value: unknown, requested: NotificationRoute): value is NotificationPage {
  return record(value) && value.coverage === "delivery_notifications_v2" && isoTime(value.serverNow)
    && record(value.availability) && value.availability.folderChanges === true && typeof value.availability.nativeDeliveries === "boolean"
    && (value.nextCursor === null || typeof value.nextCursor === "string" && value.nextCursor.length > 0)
    && Array.isArray(value.items) && value.items.length <= 25 && value.items.every(item => record(item) && typeof item.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item.id)
      && Number.isSafeInteger(item.revision) && Number(item.revision) > 0 && statuses.includes(item.status as BatchStatus)
      && (requested.batchId ? item.id === requested.batchId && item.kind === requested.kind : requested.view === "pending" ? item.status === "pending" || item.status === "processing" : item.status !== "pending" && item.status !== "processing")
      && boundedText(item.folderLabel) && (item.recipientEmail === null || boundedText(item.recipientEmail, 320))
      && (item.kind === "folder_changes" ? boundedText(item.accountName) && [item.addedCount, item.removedCount].every(count => Number.isSafeInteger(count) && Number(count) >= 0)
        : item.kind === "portal_delivery" ? (value.availability as Record<string, unknown>).nativeDeliveries === true
          && [item.sourceName, item.workspaceName, item.eventLabel].every(name => boundedText(name))
          && ["staged", "direct_legacy", "awaiting_staging"].includes(String(item.deliveryMode))
          && (item.deliveryMode === "staged" || item.canSendNow === false && item.canCancel === false)
        : item.kind === "authenticated_delivery" && (value.availability as Record<string, unknown>).authenticatedDeliveries === true
          && (item.workspaceName === undefined || boundedText(item.workspaceName))
          && [item.addedCount, item.removedCount].every(count => Number.isSafeInteger(count) && Number(count) >= 0))
      && [item.eligibleAt, item.createdAt, item.updatedAt].every(isoTime) && (item.deliveredAt === null || isoTime(item.deliveredAt))
      && textOrNull(item.errorCode) && typeof item.canSendNow === "boolean" && typeof item.canCancel === "boolean");
}
function shownTime(value: string): string {
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
function eligibility(row: NotificationBatch, now: number): string {
  if (row.status === "processing") return "Dispatch in progress";
  if (row.kind === "portal_delivery" && row.deliveryMode === "awaiting_staging") return "Awaiting staging";
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
  const [availability, setAvailability] = useState<NotificationPage["availability"] | null>(null);
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
    setRows([]); setNextCursor(null); setPageCount(0); setLastUpdated(null); serverClock.current = null; setAvailability(null);
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
    const params = new URLSearchParams({ format: "combined", view: requested.view });
    if (requested.q) params.set("q", requested.q);
    if (cursor) params.set("cursor", cursor);
    try {
      const value = await api<unknown>(requested.batchId ? notificationApi({ kind: requested.kind, id: requested.batchId })
        : `/api/notifications/deliveries?${params}`, { signal: controller.signal });
      if (!valid()) return;
      const legacyExact = requested.batchId && requested.kind === "folder_changes" && record(value) && value.coverage === "legacy_folder_changes"
        && record(value.item) && (value.item.kind === undefined || value.item.kind === "folder_changes");
      const result = requested.batchId && record(value) ? { items: [legacyExact ? { ...(value.item as Record<string, unknown>), kind: "folder_changes" } : value.item],
        nextCursor: null, serverNow: value.serverNow, coverage: legacyExact ? "delivery_notifications_v2" : value.coverage,
        availability: legacyExact ? { folderChanges: true, nativeDeliveries: false } : value.availability } : value;
      if (!pageValid(result, requested)) {
        if (requested.batchId) { clearProtected("This notification could not be verified. Refresh to check its current state."); return; }
        throw new Error("Notification records could not be verified. Refresh to try again.");
      }
      // A delayed pre-action read must not resurrect a cancelled or older batch.
      const received = result.items.filter(row => {
        const key = notificationKey(row), floor = confirmed.current.get(key);
        if (!floor) return true;
        if (row.revision > floor.revision) { confirmed.current.delete(key); return true; }
        return row.revision === floor.revision && row.status === floor.status;
      });
      setRows(previous => {
        const merged = new Map((cursor ? previous : []).map(row => [notificationKey(row), row]));
        for (const row of received) {
          const key = notificationKey(row), existing = merged.get(key);
          if (!existing || row.revision >= existing.revision) merged.set(key, row);
        }
        return [...merged.values()];
      });
      setNextCursor(result.nextCursor); setPageCount(previous => cursor ? previous + 1 : 1);
      setAvailability(legacyExact ? null : {...result.availability, authenticatedDeliveries: result.availability.authenticatedDeliveries === true});
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
      if (next.view === currentRoute.current.view && next.q === currentRoute.current.q && next.batchId === currentRoute.current.batchId && next.kind === currentRoute.current.kind && next.invalid === currentRoute.current.invalid) return;
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
    setRows([]); setNextCursor(null); setPageCount(0); setLastUpdated(null); setLoadingMore(false); setAvailability(null);
    void load();
    return () => { pending.current?.abort(); pending.current = null; requestSequence.current += 1; };
  }, [route.view, route.q, route.batchId, route.kind, route.invalid, load]);
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
    if (next.view === currentRoute.current.view && next.q === currentRoute.current.q && next.batchId === currentRoute.current.batchId && next.kind === currentRoute.current.kind && next.invalid === currentRoute.current.invalid) return;
    pending.current?.abort(); pending.current = null; requestSequence.current += 1;
    const params = new URLSearchParams();
    if (next.view === "history") params.set("view", "history");
    if (next.q) params.set("q", next.q);
    if (next.batchId && next.kind !== "folder_changes") params.set("kind", next.kind);
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
      const result = await api<unknown>(`${notificationApi(active)}/${active.action}`, {
        method: "POST", signal: controller.signal, headers: { "Idempotency-Key": active.key },
        body: JSON.stringify({ expectedRevision: active.revision }),
      });
      if (!valid()) return;
      if (!record(result) || result.ok !== true || result.id !== active.id || result.action !== active.action
        || (active.kind === "folder_changes" ? result.kind !== undefined && result.kind !== "folder_changes" : result.kind !== active.kind)
        || result.revision !== active.revision + 1
        || result.status !== (active.action === "cancel" ? "cancelled" : "pending")
        || typeof result.replayed !== "boolean") throw new Error("The action outcome could not be confirmed.");
      confirmed.current.set(notificationKey(active), { revision: Number(result.revision), status: result.status as BatchStatus });
      updateMutation(null);
      setRows(previous => previous.filter(row => notificationKey(row) !== notificationKey(active)));
      setMessage(active.action === "cancel" ? `Notification cancelled. Files and access are unchanged; ${active.kind === "folder_changes" ? "later file changes can create a new notification" : active.kind === "authenticated_delivery" ? "later eligible file changes can create a new notification while the exact-person policy remains enabled" : "this does not revoke the delivery or recall earlier notices"}. Email already accepted for delivery and published inbox notices cannot be recalled.`
        : active.kind === "folder_changes" ? "Notification made eligible for dispatch. This does not confirm delivery; a new file change before dispatch can restart the waiting period."
          : "Notification made eligible for dispatch. This does not confirm delivery or change recipient access. Eligibility is checked again before dispatch.");
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
    const label = `${notificationName(row)} · ${row.folderLabel}${row.kind === "portal_delivery" ? ` · ${row.sourceName} · ${row.recipientEmail || "Recipient unavailable"}` : ""}`;
    if (action === "cancel" && !confirm(`Cancel the notification for ${label}? This stops remaining attempts. It does not remove files or change access. Email already accepted for delivery and published inbox notices cannot be recalled.${row.kind === "folder_changes" ? " Later file changes can create a new notification." : " The delivery itself is not revoked."}`)) return;
    void perform({ id: row.id, kind: row.kind, label, action, revision: row.revision, key: crypto.randomUUID(), busy: false, error: "" });
  };

  return <section className="page-stack operations-notifications" aria-label="Delivery notification center">
    <div className="page-heading"><div><h2>Notifications</h2>
      <p>{route.batchId ? "Review this exact notification and its current delivery status." : "Review pending delivery notifications and their history."}</p></div>
      <button className="button-ghost" type="button" aria-disabled={loading || loadingMore || mutation?.busy} onClick={() => {
        if (!pending.current && !mutationRef.current?.busy) void load();
      }}>Refresh notifications</button></div>
    <div className="notification-coverage"><strong>Delivery and folder-change notifications</strong>
      <p>Legacy folder subscriptions, explicit Project Alpha delivery notices, and opt-in summaries for exact authenticated recipients.</p>
      {availability?.nativeDeliveries === false && <p className="notification-availability" role="status">Native delivery notices are unavailable until the notification database upgrade is applied. Only folder-change notices are shown.</p>}
      {availability?.authenticatedDeliveries === false && <p className="notification-availability" role="status">Exact authenticated-recipient change notices are unavailable until the notification database and feature are ready.</p>}
      <details><summary>About these notifications</summary>
        <p>The countdown shows the earliest dispatch time, not a delivery guarantee. Recipient eligibility is checked again before dispatch. New file changes can restart the waiting period.</p>
        <p>Native delivery-ready notices may be staged; earlier direct-dispatch notices are read-only. Authenticated change summaries appear only for an active exact-person grant with an explicit opt-in policy. They do not change access or replace legacy subscriptions.</p>
        <p>Sent means accepted for delivery, not proof the recipient received or read the notice. Cancellation cannot recall email already accepted or inbox notices already published.</p>
      </details></div>
    <div className="notification-view-switch" role="group" aria-label="Notification views">
      {(["pending", "history"] as const).map(view => <button key={view} type="button" className={!route.batchId && !route.invalid && route.view === view ? "button-orange" : "button-ghost"}
        aria-pressed={!route.batchId && !route.invalid && route.view === view} onClick={() => navigate(route.batchId || route.invalid ? { view, q: "", batchId: null, kind: "folder_changes", invalid: false } : { ...route, view })}>{view === "pending" ? "Pending" : "History"}</button>)}
    </div>
    {route.batchId && !route.invalid && <p role="status">Showing the selected notification, including any status change since it was opened. Choose Pending or History to return to all notifications.</p>}
    {!route.batchId && !route.invalid && <form className="notification-search" role="search" aria-label="Find notifications" onSubmit={search}>
      <label>Search notifications<input maxLength={200} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Client, workspace, source, or folder" /></label>
      <button type="submit" className="button-orange">Search</button>
      {(draft || route.q) && <button type="button" className="button-ghost" onClick={() => navigate({ ...route, q: "" })}>Clear search</button>}
    </form>}
    {mutation && <div className="notification-action-status" role={mutation.error ? "alert" : "status"}>
      <strong>{mutation.action === "cancel" ? "Cancel notification" : "Send now"}: {mutation.label}</strong>
      <p>{mutation.busy ? "Checking the action with the server…" : mutation.error}</p>
      {!mutation.busy && <button type="button" className="button-ghost" onClick={() => { if (mutationRef.current) void perform(mutationRef.current); }}>Retry action</button>}
    </div>}
    {message && <p className="notification-action-status" role="status">{message}</p>}
    <Card title={route.batchId ? "Selected notification" : route.view === "pending" ? "Pending delivery notifications" : "Notification history"}>
      {lastUpdated && <p className="notification-freshness">Updated {shownTime(lastUpdated)}. {rows.length} {rows.length === 1 ? "notification" : "notifications"} shown.
        {route.view === "pending" && pageCount > 1 ? " Refresh to check for new changes." : ""}</p>}
      {error && <div className="notification-error" role="alert"><span>{error.message}</span><button type="button" className="button-ghost"
        aria-disabled={loading || loadingMore} onClick={() => { if (!pending.current) void load(error.cursor); }}>Retry notifications</button></div>}
      {loading && <p role="status">Loading notifications…</p>}
      <div className="notification-batch-list">
        {rows.map(row => <article key={notificationKey(row)} className="notification-batch" aria-label={`${notificationName(row)} · ${row.folderLabel}`} data-notification-kind={row.kind}>
          <header><div><h3>{notificationName(row)}</h3><p>{row.folderLabel}</p><small className="notification-kind">{row.kind === "folder_changes" ? "Folder changes" : row.kind === "portal_delivery" ? "Portal delivery" : "Authenticated recipient changes"}</small></div>
            <StatusPill tone={row.status === "failed" ? "danger" : row.status === "sent" ? "success" : row.status === "pending" ? "warning" : "neutral"}>{statusLabel(row.status)}</StatusPill></header>
          <dl><div><dt>Recipient</dt><dd>{row.recipientEmail || "Recipient unavailable"}</dd></div>
            {row.kind === "folder_changes" || row.kind === "authenticated_delivery" ? <div><dt>Net changes</dt><dd>{row.addedCount.toLocaleString()} added · {row.removedCount.toLocaleString()} removed</dd></div>
              : <><div><dt>Source</dt><dd>{row.sourceName}</dd></div><div><dt>Workspace</dt><dd>{row.workspaceName}</dd></div><div><dt>Event</dt><dd>{row.eventLabel}</dd></div></>}
            <div><dt>Created</dt><dd>{shownTime(row.createdAt)}</dd></div>
            <div><dt>{row.deliveredAt ? "Sent" : "Last updated"}</dt><dd>{shownTime(row.deliveredAt || row.updatedAt)}</dd></div></dl>
          {(row.status === "pending" || row.status === "processing") && <p className="notification-countdown" aria-live="off">{eligibility(row, clock)}</p>}
          {row.kind === "portal_delivery" && row.deliveryMode !== "staged" && <p>{row.deliveryMode === "awaiting_staging" ? "Awaiting staging. Actions are not available for this notice yet." : "Earlier direct-dispatch notice. This record is read-only."}</p>}
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
        detail={nextCursor ? "More records remain to be checked. Load more to continue." : route.q ? "Try another client, workspace, source, or folder name." : "Only the delivery notification sources described above are included."} />}
      {(nextCursor || pageCount > 1) && <div className="notification-pagination"><button type="button" className="button-ghost"
        aria-disabled={loadingMore || loading || !nextCursor} onClick={() => { if (nextCursor && !pending.current) void load(nextCursor); }}>
        {loadingMore ? "Loading more…" : nextCursor ? "Load more notifications" : "No more notifications"}</button></div>}
    </Card>
  </section>;
}
