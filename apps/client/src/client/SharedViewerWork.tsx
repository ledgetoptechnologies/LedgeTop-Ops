import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, EmptyState, Skeleton } from "@ltds/ui";
import type { RequestError } from "./bulk-download";
import { loadNativeViewerWork, type NativeViewerWorkItem } from "./native-portal-api";
import type { PortalWorkspace } from "./portal-api";
import { directViewerTaskPath, sharedViewerRows, showsBusinessName, viewerWorkAccounts } from "./shared-viewer-work";
import { AREA_TEXT, accountArea, unifiedAccount } from "./unified-portal";

const ACCOUNT_CONCURRENCY = 4;
type AccountWork =
  | { status: "loading" }
  | { status: "none" }
  | { status: "ready"; items: NativeViewerWorkItem[]; cursor: string | null; loadingMore: boolean; moreError: boolean }
  | { status: "error" };

/** 403/404 means this account has no direct sharing; it is skipped without a message. */
const noSharing = (caught: unknown) => [403, 404].includes((caught as RequestError).status ?? 0);
const shortDate = (value: string) => new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/**
 * Every Viewer task shared directly with the signed-in person, as one flat list. Account
 * (workspace) names are never shown: some are internal labels. Each row opens with its
 * own account and grant, so nothing is merged or switched.
 */
export function SharedViewerWork({ workspaces }: { workspaces: PortalWorkspace[] }) {
  const accounts = useMemo(() => viewerWorkAccounts(workspaces), [workspaces]);
  const [work, setWork] = useState<Map<string, AccountWork>>(() => new Map());
  const controllers = useRef(new Map<string, AbortController>());
  const generation = useRef(0);

  const loadFirst = useCallback(async (workspaceId: string, current: number) => {
    controllers.current.get(workspaceId)?.abort();
    const controller = new AbortController(); controllers.current.set(workspaceId, controller);
    const settle = (value: AccountWork) => { if (!controller.signal.aborted && current === generation.current) setWork(previous => new Map(previous).set(workspaceId, value)); };
    settle({ status: "loading" });
    try {
      const page = await loadNativeViewerWork(workspaceId, null, controller.signal);
      settle({ status: "ready", items: page.items, cursor: page.nextCursor, loadingMore: false, moreError: false });
    } catch (caught) { settle(noSharing(caught) ? { status: "none" } : { status: "error" }); }
  }, []);

  useEffect(() => {
    const current = ++generation.current, queue = accounts.map(account => account.id);
    setWork(new Map(queue.map(id => [id, { status: "loading" }])));
    const worker = async () => { for (let next = queue.shift(); next && current === generation.current; next = queue.shift()) await loadFirst(next, current); };
    void Promise.all(Array.from({ length: Math.min(ACCOUNT_CONCURRENCY, queue.length) }, worker));
    const owned = controllers.current;
    return () => { generation.current++; owned.forEach(controller => controller.abort()); owned.clear(); };
  }, [accounts, loadFirst]);

  const loadMore = async (workspaceId: string) => {
    const state = work.get(workspaceId);
    if (state?.status !== "ready" || !state.cursor || state.loadingMore) return;
    const current = generation.current, controller = new AbortController(); controllers.current.set(workspaceId, controller);
    const update = (change: (value: Extract<AccountWork, { status: "ready" }>) => AccountWork) => {
      if (controller.signal.aborted || current !== generation.current) return;
      setWork(previous => { const value = previous.get(workspaceId); return value?.status === "ready" ? new Map(previous).set(workspaceId, change(value)) : previous; });
    };
    update(value => ({ ...value, loadingMore: true, moreError: false }));
    try {
      // The cursor is only ever sent back to the account that issued it.
      const page = await loadNativeViewerWork(workspaceId, state.cursor, controller.signal);
      update(value => ({ ...value, items: [...value.items, ...page.items], cursor: page.nextCursor, loadingMore: false }));
    } catch { update(value => ({ ...value, loadingMore: false, moreError: true })); }
  };

  const states = accounts.map(account => ({ account, state: work.get(account.id) ?? { status: "loading" as const } }));
  const rows = sharedViewerRows(states.flatMap(({ state }) => state.status === "ready" ? state.items : []));
  const withBusiness = showsBusinessName(rows);
  const loading = states.some(({ state }) => state.status === "loading");
  const failed = states.filter(({ state }) => state.status === "error");
  const more = states.filter(({ state }) => state.status === "ready" && (state.cursor || state.moreError));
  // Accounts are told apart by the kind of work only when several fail, never by their stored names.
  const areaName = (workspace: PortalWorkspace) => failed.length > 1 ? AREA_TEXT[accountArea(unifiedAccount(workspace))].name : "";
  if (!accounts.length) return null;

  return <Card title="Shared 3D work" className="shared-viewer-work">
    {failed.map(({ account }) => <div key={account.id} className="shared-viewer-work-problem" role="alert">
      <p>Some shared 3D work{areaName(account) ? ` (${areaName(account)})` : ""} couldn’t be loaded.</p>
      <button type="button" className="button-ghost button-small" onClick={() => void loadFirst(account.id, generation.current)}>Try again</button>
    </div>)}
    {rows.length > 0 && <ul className="shared-viewer-work-list">{rows.map(row => <li key={`${row.workspaceId}:${row.taskId}`}>
      <div><strong>{row.title}</strong>
        {(row.projectName || (withBusiness && row.businessName)) && <span>{[row.projectName, withBusiness ? row.businessName : null].filter(Boolean).join(" · ")}</span>}
        <small>Shared {shortDate(row.sharedAt)}{row.expiresAt ? ` · Available until ${shortDate(row.expiresAt)}` : ""}</small></div>
      <a className="button button-orange" href={directViewerTaskPath(row)}>Open 3D model<span className="visually-hidden">: {row.title}</span></a>
    </li>)}</ul>}
    {loading && <Skeleton variant="list" rows={2} label="Loading shared 3D work…" />}
    {!loading && rows.length === 0 && failed.length === 0 && <EmptyState title="No 3D work has been shared with you yet." detail="3D models shared with you will appear here." />}
    {more.map(({ account, state }) => state.status === "ready" && <div key={account.id} className="shared-viewer-work-more">
      {state.moreError && <p role="alert">More shared 3D work couldn’t be loaded.</p>}
      <button type="button" className="button-ghost" disabled={state.loadingMore} onClick={() => void loadMore(account.id)}>
        {state.moreError ? "Try again" : "Load more 3D work"}</button>
    </div>)}
  </Card>;
}
