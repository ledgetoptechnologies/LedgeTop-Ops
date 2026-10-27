import type { NativeViewerWorkItem } from "./native-portal-api";
import type { PortalOperationsHomeResponse, PortalWorkspace } from "./portal-api";

/**
 * 3D work shared directly with a client, flattened across every native client
 * account and Operations service home the person can open. Each row keeps its
 * own account and grant: a task never borrows another grant's permissions or
 * another account's cursor.
 */

/**
 * The account IDs to ask for direct Viewer grants: native accounts, then the
 * currently verified Operations homes, once each. Operations homes are only
 * Viewer candidates here; they never become selectable portal accounts.
 */
export function viewerWorkAccounts(workspaces: PortalWorkspace[], operationsHomeWorkspaceIds: readonly string[] = []): string[] {
  const native = workspaces.filter(workspace => workspace.resourceMode === "native").map(workspace => workspace.id);
  return [...new Set([...native, ...operationsHomeWorkspaceIds])];
}

/** The account ID form a direct Viewer link can carry; other IDs could never open, so they are not listed. */
const viewerAccountId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Only a currently verified home response contributes; a hidden or revalidating one contributes nothing. */
export function operationsHomeViewerWorkspaceIds(response: PortalOperationsHomeResponse | undefined): string[] {
  return response ? response.homes.map(home => home.workspaceId).filter(id => viewerAccountId.test(id)) : [];
}

const rowKey = (item: NativeViewerWorkItem) => `${item.workspaceId}\u0000${item.taskId}`;
/** An exact task grant is more specific than a project grant that also covers the task. */
function preferred(current: NativeViewerWorkItem, next: NativeViewerWorkItem): NativeViewerWorkItem {
  if (current.scopeType !== next.scopeType) return next.scopeType === "task" ? next : current;
  const updated = next.updatedAt.localeCompare(current.updatedAt);
  return updated > 0 || (updated === 0 && next.grantId < current.grantId) ? next : current;
}

/** One row per account + task, preferring its exact task grant; newest first. Rows are never merged. */
export function sharedViewerRows(items: NativeViewerWorkItem[]): NativeViewerWorkItem[] {
  const rows = new Map<string, NativeViewerWorkItem>();
  for (const item of items) {
    const current = rows.get(rowKey(item));
    rows.set(rowKey(item), current ? preferred(current, item) : item);
  }
  return [...rows.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    || left.title.localeCompare(right.title) || rowKey(left).localeCompare(rowKey(right)));
}

export function directViewerTaskPath(item: Pick<NativeViewerWorkItem, "workspaceId" | "grantId" | "taskId">): string {
  return `/portal/viewer/${encodeURIComponent(item.grantId)}/tasks/${encodeURIComponent(item.taskId)}?${new URLSearchParams({ workspace: item.workspaceId })}`;
}
