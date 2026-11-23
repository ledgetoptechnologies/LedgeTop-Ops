// Pure helpers for the workspace folder tree: per-user expanded state, the flat
// row order of one project's tree, folder task counts and keyboard targets.
// The DOM, requests and authorization stay in workspace-projects.js.

export const TREE_STORAGE_PREFIX = 'ltds-viewer-tree:v1:';
const MAX_SAVED_IDS = 500;

export function treeStorageKey(subject) {
  return `${TREE_STORAGE_PREFIX}${subject || 'anonymous'}`;
}

// Expanded projects and folders for one user. Storage can be missing, full or
// blocked; the tree then works for this visit only.
export function readTreeState(storage, subject) {
  const ids = list => new Set(Array.isArray(list)
    ? list.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200).slice(0, MAX_SAVED_IDS)
    : []);
  try {
    const value = JSON.parse(storage?.getItem(treeStorageKey(subject)) || 'null');
    if (!value || typeof value !== 'object') return { projects: new Set(), folders: new Set() };
    return { projects: ids(value.projects), folders: ids(value.folders) };
  } catch {
    return { projects: new Set(), folders: new Set() };
  }
}

export function writeTreeState(storage, subject, tree) {
  try {
    storage?.setItem(treeStorageKey(subject), JSON.stringify({
      projects: [...tree.projects].slice(-MAX_SAVED_IDS),
      folders: [...tree.folders].slice(-MAX_SAVED_IDS),
    }));
    return true;
  } catch {
    return false;
  }
}

const collator = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.displayName || '', b.displayName || '') || String(a.id).localeCompare(String(b.id));

export function childFolders(folders, parentId) {
  return folders.filter(folder => (folder.parentId || null) === parentId).sort(byName);
}

// Folder ids from the top level down to folderId; stops at unknown ids and cycles.
export function folderAncestry(folders, folderId) {
  const result = [], seen = new Set();
  for (let current = folderId; current && !seen.has(current);) {
    seen.add(current);
    const folder = folders.find(item => item.id === current);
    if (!folder) break;
    result.unshift(folder.id);
    current = folder.parentId || null;
  }
  return result;
}

// Tasks under each folder, subfolders included.
export function folderTaskCounts(folders, tasks) {
  const parent = new Map(folders.map(folder => [folder.id, folder.parentId || null]));
  const counts = new Map(folders.map(folder => [folder.id, 0]));
  for (const task of tasks) {
    const seen = new Set();
    for (let id = task.folderId || null; id && counts.has(id) && !seen.has(id); id = parent.get(id)) {
      seen.add(id);
      counts.set(id, counts.get(id) + 1);
    }
  }
  return counts;
}

export function folderIsEmpty(folders, tasks, folderId) {
  return !folders.some(folder => folder.parentId === folderId) && !tasks.some(task => task.folderId === folderId);
}

// One project's rows in display order: folders by name, then tasks in the
// given order, children right after their open folder. Tasks whose folder is
// unknown (not loaded yet, or deleted elsewhere) stay visible at the top level.
// pending: { parentId } for an inline "New folder" row.
export function projectTreeRows({ projectId, folders = [], tasks = [], expanded = new Set(), pending = null }) {
  const known = new Set(folders.map(folder => folder.id));
  const parentOf = task => (task.folderId && known.has(task.folderId) ? task.folderId : null);
  const rows = [];
  const walk = (parentId, level, parentKey, seen) => {
    const folderRows = childFolders(folders, parentId).filter(folder => !seen.has(folder.id));
    const taskRows = tasks.filter(task => parentOf(task) === parentId);
    const setsize = folderRows.length + taskRows.length;
    let position = 0;
    if (pending && (pending.parentId || null) === parentId) rows.push({ kind: 'new', key: `n:${parentId || projectId}`, parentId, level, parentKey });
    for (const folder of folderRows) {
      const open = expanded.has(folder.id), key = `f:${folder.id}`;
      rows.push({ kind: 'folder', key, id: folder.id, folder, level, posinset: ++position, setsize, parentKey, expanded: open });
      if (!open) continue;
      const before = rows.length;
      walk(folder.id, level + 1, key, new Set([...seen, folder.id]));
      if (rows.length === before) rows.push({ kind: 'empty', key: `e:${folder.id}`, folderId: folder.id, level: level + 1, parentKey: key });
    }
    for (const task of taskRows) rows.push({ kind: 'task', key: `t:${task.id}`, id: task.id, task, level, posinset: ++position, setsize, parentKey });
  };
  walk(null, 2, `p:${projectId}`, new Set());
  return rows;
}

// Keyboard movement in a treegrid with one tab stop. rows: [{ level, expandable, expanded }].
// Returns { focus: index }, { toggle: true }, { controls: true } or null.
export function treeKeyAction(rows, index, key) {
  const row = rows[index];
  if (!row) return null;
  switch (key) {
    case 'ArrowDown': return index + 1 < rows.length ? { focus: index + 1 } : null;
    case 'ArrowUp': return index > 0 ? { focus: index - 1 } : null;
    case 'Home': return rows.length ? { focus: 0 } : null;
    case 'End': return rows.length ? { focus: rows.length - 1 } : null;
    case 'ArrowRight':
      if (row.expandable && !row.expanded) return { toggle: true };
      if (row.expandable && rows[index + 1]?.level === row.level + 1) return { focus: index + 1 };
      return { controls: true };
    case 'ArrowLeft': {
      if (row.expandable && row.expanded) return { toggle: true };
      for (let at = index - 1; at >= 0; at--) if (rows[at].level === row.level - 1) return { focus: at };
      return null;
    }
    default: return null;
  }
}
