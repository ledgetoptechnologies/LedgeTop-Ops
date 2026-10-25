import { useCallback, useEffect, useRef, useState } from "react";
import { Card, EmptyState, Skeleton } from "@ltds/ui";
import { loadNativeDeliveries, loadNativePortalContext, type NativeDeliveryTarget, type NativePortalContext } from "./native-portal-api";
import type { PortalWorkspace } from "./portal-api";
import type { OpenInAccount } from "./UnifiedPortal";

const ACCOUNT_CONCURRENCY = 4;
type AccountFolders =
  | { status: "loading" }
  | { status: "none" }
  | { status: "legacy" }
  | { status: "ready"; context: NativePortalContext; items: NativeDeliveryTarget[]; cursor: string | null; loadingMore: boolean; moreError: boolean }
  | { status: "error" };

/**
 * Delivery folders from every client account, as one list with no business or account names. Each folder opens in
 * its own account, and a cursor only ever goes back to the account that issued it. Older accounts without folder
 * listings are reached through one neutral link each.
 */
export function UnifiedDeliveries({ workspaces, openInAccount }: { workspaces: PortalWorkspace[]; openInAccount: OpenInAccount }) {
  const [folders, setFolders] = useState<Map<string, AccountFolders>>(() => new Map());
  const controllers = useRef(new Map<string, AbortController>());
  const generation = useRef(0);

  const loadFirst = useCallback(async (workspace: PortalWorkspace, current: number) => {
    controllers.current.get(workspace.id)?.abort();
    const controller = new AbortController(); controllers.current.set(workspace.id, controller);
    const settle = (value: AccountFolders) => { if (!controller.signal.aborted && current === generation.current) setFolders(previous => new Map(previous).set(workspace.id, value)); };
    if (workspace.resourceMode !== "native") return settle({ status: "legacy" });
    settle({ status: "loading" });
    try {
      const context = await loadNativePortalContext(workspace, undefined, controller.signal);
      if (!context.capabilities.deliveryView) return settle({ status: "none" });
      const page = await loadNativeDeliveries(context, null, controller.signal);
      settle({ status: "ready", context, items: page.items, cursor: page.page.nextCursor, loadingMore: false, moreError: false });
    } catch { settle({ status: "error" }); }
  }, []);

  useEffect(() => {
    const current = ++generation.current, queue = [...workspaces];
    setFolders(new Map(queue.map(workspace => [workspace.id, { status: "loading" }])));
    const worker = async () => { for (let next = queue.shift(); next && current === generation.current; next = queue.shift()) await loadFirst(next, current); };
    void Promise.all(Array.from({ length: Math.min(ACCOUNT_CONCURRENCY, queue.length) }, worker));
    const owned = controllers.current;
    return () => { generation.current++; owned.forEach(controller => controller.abort()); owned.clear(); };
  }, [workspaces, loadFirst]);

  const loadMore = async (workspace: PortalWorkspace) => {
    const state = folders.get(workspace.id);
    if (state?.status !== "ready" || !state.cursor || state.loadingMore) return;
    const current = generation.current, controller = new AbortController(); controllers.current.set(workspace.id, controller);
    const update = (change: (value: Extract<AccountFolders, { status: "ready" }>) => AccountFolders) => {
      if (controller.signal.aborted || current !== generation.current) return;
      setFolders(previous => { const value = previous.get(workspace.id); return value?.status === "ready" ? new Map(previous).set(workspace.id, change(value)) : previous; });
    };
    update(value => ({ ...value, loadingMore: true, moreError: false }));
    try {
      const page = await loadNativeDeliveries(state.context, state.cursor, controller.signal);
      update(value => {
        const ids = new Set(value.items.map(item => item.id));
        return { ...value, items: [...value.items, ...page.items.filter(item => !ids.has(item.id))], cursor: page.page.nextCursor, loadingMore: false };
      });
    } catch { update(value => ({ ...value, loadingMore: false, moreError: true })); }
  };

  const states = workspaces.map(workspace => ({ workspace, state: folders.get(workspace.id) ?? { status: "loading" as const } }));
  const rows = states.flatMap(({ workspace, state }) => state.status === "ready" ? state.items.map(item => ({ workspace, item })) : [])
    .sort((left, right) => left.item.displayName.localeCompare(right.item.displayName) || left.workspace.id.localeCompare(right.workspace.id));
  const legacy = states.filter(({ state }) => state.status === "legacy");
  const failed = states.filter(({ state }) => state.status === "error");
  const more = states.filter(({ state }) => state.status === "ready" && (state.cursor || state.moreError));
  const loading = states.some(({ state }) => state.status === "loading");

  return <Card title="Delivery folders" className="unified-deliveries">
    {failed.length > 0 && <div className="unified-portal-problems" role="alert">
      <p>Some of your delivery folders couldn’t be loaded.</p>
      <button type="button" className="button-ghost" onClick={() => failed.forEach(({ workspace }) => void loadFirst(workspace, generation.current))}>Try again</button>
    </div>}
    {rows.length > 0 && <ul className="native-workspace-list">{rows.map(({ workspace, item }) => <li key={`${workspace.id}:${item.id}`}>
      <div><strong>{item.displayName}</strong></div>
      <div><button type="button" className="button-orange" onClick={() => openInAccount(workspace.id, `/portal/deliveries?${new URLSearchParams({ folder: item.id })}`)}>
        Open folder<span className="visually-hidden">: {item.displayName}</span></button></div>
    </li>)}</ul>}
    {legacy.map(({ workspace }, index) => <p key={workspace.id} className="unified-deliveries-legacy">
      <button type="button" className="button-ghost" onClick={() => openInAccount(workspace.id, "/portal/deliveries")}>
        {legacy.length > 1 ? `Open more delivered files (${index + 1})` : rows.length ? "Open more delivered files" : "Open your delivered files"}</button>
    </p>)}
    {loading && <Skeleton variant="list" rows={2} label="Loading delivery folders…" />}
    {!loading && rows.length === 0 && legacy.length === 0 && failed.length === 0 && <EmptyState title="No delivery folders yet" detail="Folders we share with you will appear here." />}
    {more.map(({ workspace, state }) => state.status === "ready" && <div key={workspace.id} className="shared-viewer-work-more">
      {state.moreError && <p role="alert">More delivery folders couldn’t be loaded.</p>}
      <button type="button" className="button-ghost" disabled={state.loadingMore} onClick={() => void loadMore(workspace)}>
        {state.moreError ? "Try again" : "Load more delivery folders"}</button>
    </div>)}
  </Card>;
}
