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

/** A folder heading in a shared project: only ever built from the paths of tasks the client can already open. */
export interface SharedViewerFolderGroup { id: string; name: string; folders: SharedViewerFolderGroup[]; tasks: NativeViewerWorkItem[] }
export interface SharedViewerProjectGroup { key: string; projectName: string | null; folders: SharedViewerFolderGroup[]; tasks: NativeViewerWorkItem[] }

/** SQLite NOCASE folds ASCII only; matching it keeps sibling folders in the order staff see them. */
const nocase = (value: string) => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
const binary = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
function sortFolders(folders: SharedViewerFolderGroup[]): SharedViewerFolderGroup[] {
  folders.sort((left, right) => binary(nocase(left.name), nocase(right.name)) || binary(left.id, right.id));
  for (const folder of folders) sortFolders(folder.folders);
  return folders;
}

/** True once any loaded row carries a folder path; older responses without one keep the flat list. */
export function sharedViewerHasFolders(rows: NativeViewerWorkItem[]): boolean {
  return rows.some(row => row.folderPath !== undefined);
}

/**
 * Groups already-deduplicated rows by project, then by nested folder, as the staff workspace shows them: at each
 * level, subfolders (by name, case-insensitively, then id) before tasks (in row order). Projects keep the order their
 * newest row appears in. Rebuilt from every loaded row after each page, so paging regroups as items arrive.
 */
export function sharedViewerGroups(rows: NativeViewerWorkItem[]): SharedViewerProjectGroup[] {
  const projects = new Map<string, SharedViewerProjectGroup & { index: Map<string, SharedViewerFolderGroup> }>();
  for (const row of rows) {
    // The opaque project key keeps same-named projects apart; older rows fall back to their names.
    const key = row.projectKey ? `${row.workspaceId}\u0000key\u0000${row.projectKey}` : `names\u0000${row.businessName ?? ""}\u0000${row.projectName ?? ""}`;
    let project = projects.get(key);
    if (!project) { project = { key, projectName: row.projectName, folders: [], tasks: [], index: new Map() }; projects.set(key, project); }
    let level: { folders: SharedViewerFolderGroup[]; tasks: NativeViewerWorkItem[] } = project, parentKey = "";
    for (const folder of row.folderPath ?? []) {
      // Keyed by the full id chain, so one folder id never joins two different branches.
      const folderKey = `${parentKey}/${folder.id}`;
      let group = project.index.get(folderKey);
      if (!group) { group = { id: folder.id, name: folder.name, folders: [], tasks: [] }; project.index.set(folderKey, group); level.folders.push(group); }
      level = group; parentKey = folderKey;
    }
    level.tasks.push(row);
  }
  return [...projects.values()].map(({ index: _index, ...project }) => ({ ...project, folders: sortFolders(project.folders) }));
}
