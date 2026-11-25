'use strict';

const MAX_SELECTION = 128;
const MAX_FOLDER_DEPTH = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CAPABILITIES = Object.freeze(['task_generation_v1', 'selection_v1']);

const sortedUnique = ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && UUID.test(id))
  && ids.every((id, index) => index === 0 || ids[index - 1] < id);

// What a share with a selection covers: everything except these folders and tasks, or only these.
// One canonical form (sorted, unique ids); anything else is refused, never repaired.
function canonicalProjectSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'folderIds,mode,taskIds,version'
    || value.version !== 1 || !['except', 'only'].includes(value.mode)
    || !sortedUnique(value.folderIds) || !sortedUnique(value.taskIds)) return null;
  const total = value.folderIds.length + value.taskIds.length;
  return total >= 1 && total <= MAX_SELECTION
    ? { version: 1, mode: value.mode, folderIds: [...value.folderIds], taskIds: [...value.taskIds] }
    : null;
}

// Bound to the authoritative processing_tasks row (t), on top of the published/active checks.
// A filed task must have one complete, same-project chain ending at a root. Unfiled has an empty, valid chain.
function projectSelectionPredicate(database, value) {
  if (value === undefined) return { sql: '', args: [] };
  const selection = canonicalProjectSelection(value);
  if (!selection) return { sql: ' AND 0', args: [] };
  const { mode, folderIds, taskIds } = selection, marks = ids => ids.map(() => '?').join(',');
  const folders = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_folders'").get());
  // A chosen task follows the task, so it needs no folder schema; everything else does.
  if (!folders) return mode === 'only' && !folderIds.length
    ? { sql: ` AND t.id IN (${marks(taskIds)})`, args: taskIds } : { sql: ' AND 0', args: [] };
  const chain = check => `EXISTS (
      WITH RECURSIVE ancestry(id,parent_id,depth) AS (
        SELECT id,parent_id,1 FROM project_folders WHERE id=t.folder_id AND project_id=t.project_id
        UNION ALL
        SELECT f.id,f.parent_id,a.depth+1 FROM ancestry a
        JOIN project_folders f ON f.id=a.parent_id AND f.project_id=t.project_id
        WHERE a.depth<${MAX_FOLDER_DEPTH}
      )
      SELECT 1 FROM ancestry WHERE parent_id IS NULL${check}
    )`;
  const inFolders = `EXISTS (SELECT 1 FROM ancestry WHERE id IN (${marks(folderIds)}))`;
  if (mode === 'except') return {
    sql: `${taskIds.length ? ` AND t.id NOT IN (${marks(taskIds)})` : ''} AND (t.folder_id IS NULL OR ${chain(folderIds.length ? ` AND NOT ${inFolders}` : '')})`,
    args: [...taskIds, ...folderIds],
  };
  const parts = [], args = [];
  if (taskIds.length) { parts.push(`t.id IN (${marks(taskIds)})`); args.push(...taskIds); }
  if (folderIds.length) { parts.push(`(t.folder_id IS NOT NULL AND ${chain(` AND ${inFolders}`)})`); args.push(...folderIds); }
  return { sql: ` AND (${parts.join(' OR ')})`, args };
}

module.exports = { CAPABILITIES, canonicalProjectSelection, projectSelectionPredicate };
