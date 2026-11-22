'use strict';

const MAX_EXCLUSIONS = 128;
const MAX_FOLDER_DEPTH = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function canonicalProjectExclusions(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'folderIds,taskIds,version'
    || value.version !== 1 || !Array.isArray(value.folderIds) || !Array.isArray(value.taskIds)
    || value.folderIds.length + value.taskIds.length > MAX_EXCLUSIONS) return null;
  const folderIds = [...value.folderIds];
  const taskIds = [...value.taskIds];
  if (!folderIds.length && !taskIds.length) return null;
  if (![...folderIds, ...taskIds].every(id => typeof id === 'string' && UUID.test(id))) return null;
  return {
    version: 1,
    folderIds: [...new Set(folderIds)].sort(),
    taskIds: [...new Set(taskIds)].sort(),
  };
}

// Both callers bind this predicate to the authoritative processing_tasks row (t).
// A filed task must have one complete, same-project chain ending at a root.
function projectExclusionPredicate(database, value) {
  if (value === undefined) return { sql: '', args: [] };
  const exclusions = canonicalProjectExclusions(value);
  if (!exclusions || !database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_folders'",
  ).get()) return { sql: ' AND 0', args: [] };

  const { taskIds, folderIds } = exclusions;
  const taskCheck = taskIds.length ? ` AND t.id NOT IN (${taskIds.map(() => '?').join(',')})` : '';
  const folderCheck = folderIds.length
    ? ` AND NOT EXISTS (SELECT 1 FROM ancestry WHERE id IN (${folderIds.map(() => '?').join(',')}))`
    : '';
  return {
    sql: `${taskCheck} AND (t.folder_id IS NULL OR EXISTS (
      WITH RECURSIVE ancestry(id,parent_id,depth) AS (
        SELECT id,parent_id,1 FROM project_folders WHERE id=t.folder_id AND project_id=t.project_id
        UNION ALL
        SELECT f.id,f.parent_id,a.depth+1 FROM ancestry a
        JOIN project_folders f ON f.id=a.parent_id AND f.project_id=t.project_id
        WHERE a.depth<${MAX_FOLDER_DEPTH}
      )
      SELECT 1 FROM ancestry WHERE parent_id IS NULL${folderCheck}
    ))`,
    args: [...taskIds, ...folderIds],
  };
}

module.exports = { canonicalProjectExclusions, projectExclusionPredicate };
