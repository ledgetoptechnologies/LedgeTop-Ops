import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, EmptyState, Skeleton } from "@ltds/ui";
import type { RequestError } from "./bulk-download";
import { loadNativeViewerWork, openNativeViewerTaskSession, type NativeViewerWorkItem } from "./native-portal-api";
import type { PortalWorkspace } from "./portal-api";
import { directViewerTaskPath, sharedViewerRows, viewerWorkAccounts } from "./shared-viewer-work";
import { createViewerSessionIssuer, openClientViewerWindowWithIssuer, viewerLaunchFailureMessage } from "./viewer-window-launch";
import type { ModelViewerSession } from "./viewer-window-launch";
import { readClientViewerUnits } from "./viewer-units-preference";

const ACCOUNT_CONCURRENCY = 4;
type AccountWork =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; items: NativeViewerWorkItem[]; cursor: string | null; loadingMore: boolean; moreError: boolean }
  | { status: "error" };

/**
 * 403/404 means direct sharing couldn't be checked for this account (an older portal, or no access to it). That is
 * never read as "nothing shared": only a verified empty list says so.
 */
const unavailable = (caught: unknown) => [403, 404].includes((caught as RequestError).status ?? 0);
const shortDate = (value: string) => new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/**
 * Every Viewer task shared directly with the signed-in person, as one flat list. Account
 * (workspace) names are never shown: some are internal labels. Each row opens with its
 * own account and grant, so nothing is merged or switched.
 */
export function SharedViewerWork({ workspaces, operationsHomeWorkspaceIds = [] }: {
  workspaces: PortalWorkspace[];
  /** Workspaces of the currently verified Operations homes; empty while they are hidden or revalidating. */
  operationsHomeWorkspaceIds?: readonly string[];
}) {
  // Keyed by content so a re-render with the same accounts doesn't reload them.
  const accountKey = viewerWorkAccounts(workspaces, operationsHomeWorkspaceIds).join("\n");
  const accounts = useMemo(() => accountKey ? accountKey.split("\n") : [], [accountKey]);
  const [work, setWork] = useState<Map<string, AccountWork>>(() => new Map());
  const [openingTask, setOpeningTask] = useState<string | null>(null);
  const [launchMessages, setLaunchMessages] = useState<Map<string, string>>(() => new Map());
  const sessionIssuers = useRef(new Map<string, () => Promise<ModelViewerSession>>());
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
    } catch (caught) { settle(unavailable(caught) ? { status: "unavailable" } : { status: "error" }); }
  }, []);

  useEffect(() => {
    const current = ++generation.current, queue = [...accounts];
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
    } catch (caught) {
      const status = (caught as RequestError).status ?? 0;
      // A cursor goes stale when sharing changes: reload this account from the start instead of retrying it.
      if ([400, 403, 404, 409].includes(status)) { if (!controller.signal.aborted && current === generation.current) void loadFirst(workspaceId, current); }
      else update(value => ({ ...value, loadingMore: false, moreError: true }));
    }
  };

  const states = accounts.map(account => ({ account, state: work.get(account) ?? { status: "loading" as const } }));
  const rows = sharedViewerRows(states.flatMap(({ state }) => state.status === "ready" ? state.items : []));
  const loading = states.some(({ state }) => state.status === "loading");
  const failed = states.filter(({ state }) => state.status === "error");
  const unchecked = states.filter(({ state }) => state.status === "unavailable");
  const more = states.filter(({ state }) => state.status === "ready" && (state.cursor || state.moreError));
  if (!accounts.length) return null;

  const openTask = (item: NativeViewerWorkItem, event: React.MouseEvent<HTMLAnchorElement>) => {
    // Preserve normal browser link gestures; a primary click gets a synchronous
    // blank-window reservation before the first task-session request.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const key = `${item.workspaceId}:${item.taskId}`;
    if (openingTask) return;
    setOpeningTask(key);
    setLaunchMessages(previous => new Map(previous).set(key, "Opening secure 3D Viewer…"));
    const issuerKey = `${item.workspaceId}:${item.taskId}:${item.grantId}`;
    let issuer = sessionIssuers.current.get(issuerKey);
    if (!issuer) {
      issuer = createViewerSessionIssuer(idempotencyKey => openNativeViewerTaskSession(item.workspaceId, item.grantId, item.taskId,
        readClientViewerUnits(), idempotencyKey));
      sessionIssuers.current.set(issuerKey, issuer);
    }
    const pending = openClientViewerWindowWithIssuer({
      title: item.title,
      issueSession: issuer,
      onStatus: (_status, message) => setLaunchMessages(previous => new Map(previous).set(key, message)),
    });
    void pending.then(opened => {
      setLaunchMessages(previous => new Map(previous).set(key, opened.openedIn === "new-tab"
        ? "Viewer opened in a new tab." : "The popup was blocked; Viewer opened in this tab without automatic renewal."));
    }).catch(caught => {
      setLaunchMessages(previous => new Map(previous).set(key, viewerLaunchFailureMessage(caught)));
    }).finally(() => setOpeningTask(current => current === key ? null : current));
  };

  return <Card title="Shared 3D work" className="shared-viewer-work">
    {failed.length > 0 && <div className="shared-viewer-work-problem" role="alert">
      <p>Some shared 3D work couldn’t be loaded.</p>
      <button type="button" className="button-ghost button-small" onClick={() => failed.forEach(({ account }) => void loadFirst(account, generation.current))}>Try again</button>
    </div>}
    {rows.length > 0 && <ul className="shared-viewer-work-list">{rows.map(row => {
      const key = `${row.workspaceId}:${row.taskId}`;
      return <li key={key}>
      <div><strong>{row.title}</strong>
        {row.projectName && <span>{row.projectName}</span>}
        <small>Shared {shortDate(row.sharedAt)}{row.expiresAt ? ` · Available until ${shortDate(row.expiresAt)}` : ""}</small></div>
      <a className="button button-orange" href={directViewerTaskPath(row)} aria-disabled={openingTask !== null || undefined}
        onClick={event => openTask(row, event)}>Open 3D model<span className="visually-hidden">: {row.title}</span></a>
      {launchMessages.has(key) && <p className="shared-viewer-work-launch" role="status" aria-live="polite">{launchMessages.get(key)}</p>}
    </li>})}</ul>}
    {loading && <Skeleton variant="list" rows={2} label="Loading shared 3D work…" />}
    {unchecked.length > 0 && <p className="shared-viewer-work-problem" role="status">{unchecked.length === states.length
      ? "Shared 3D work isn’t available here yet." : "Some shared 3D work isn’t available here yet."}</p>}
    {!loading && rows.length === 0 && failed.length === 0 && unchecked.length === 0 && <EmptyState title="No 3D work has been shared with you yet." detail="3D models shared with you will appear here." />}
    {more.map(({ account, state }) => state.status === "ready" && <div key={account} className="shared-viewer-work-more">
      {state.moreError && <p role="alert">More shared 3D work couldn’t be loaded.</p>}
      <button type="button" className="button-ghost" disabled={state.loadingMore} onClick={() => void loadMore(account)}>
        {state.moreError ? "Try again" : "Load more 3D work"}</button>
    </div>)}
  </Card>;
}
