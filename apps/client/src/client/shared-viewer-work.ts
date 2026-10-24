import type { NativeViewerWorkItem } from "./native-portal-api";
import type { PortalWorkspace } from "./portal-api";

/**
 * 3D work shared directly with a client, flattened across every native client
 * account the person can open. Each row keeps its own account and grant: a
 * task never borrows another grant's permissions or another account's cursor.
 */

/** Only native accounts can hold direct Viewer grants. */
export function viewerWorkAccounts(workspaces: PortalWorkspace[]): PortalWorkspace[] {
  const seen = new Set<string>();
  return workspaces.filter(workspace => workspace.resourceMode === "native" && !seen.has(workspace.id) && !!seen.add(workspace.id));
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

/** Business names only help when the list spans more than one business. */
export function showsBusinessName(rows: NativeViewerWorkItem[]): boolean {
  return new Set(rows.map(row => row.businessName).filter(Boolean)).size > 1;
}

export function directViewerTaskPath(item: Pick<NativeViewerWorkItem, "workspaceId" | "grantId" | "taskId">): string {
  return `/portal/viewer/${encodeURIComponent(item.grantId)}/tasks/${encodeURIComponent(item.taskId)}?${new URLSearchParams({ workspace: item.workspaceId })}`;
}
