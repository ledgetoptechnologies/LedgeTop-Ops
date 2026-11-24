'use strict';

// Whether a model is in the Recycle Bin, and what that takes away. Both
// repositories use it on the one database they share.

// True while the model's task or project is in the Recycle Bin, or once it is
// purged, however far that delete got. The model version's own output decides;
// a version with no output of its own follows the model's other outputs. A
// model that was never processed here has no outputs and is never deleted.
function modelDeleted(database, modelId, modelVersionId = null) {
  const rows = database.prepare(`SELECT o.id,
      t.purged_at IS NOT NULL OR p.purged_at IS NOT NULL OR EXISTS(SELECT 1 FROM storage_trash s
        WHERE s.permanently_deleted_at IS NULL
          AND ((s.entity_type='task' AND s.entity_id=t.id) OR (s.entity_type='project' AND s.entity_id=p.id))) AS deleted
    FROM model_outputs o JOIN processing_tasks t ON t.id=o.task_id JOIN projects p ON p.id=o.project_id
    WHERE o.model_id=?`).all(modelId);
  if (!rows.length) return false;
  const versionId = modelVersionId || database.prepare('SELECT active_version_id FROM models WHERE id=?').get(modelId)?.active_version_id;
  const own = rows.filter((row) => row.id === versionId);
  return (own.length ? own : rows).some((row) => row.deleted === 1);
}

// The version a grant opens, as redeeming it reads it: older grants name it only
// in their permissions.
function grantVersionId(row) {
  if (row.model_version_id) return row.model_version_id;
  try { return JSON.parse(row.permissions_json)?.__versionId || null; } catch { return null; }
}

// Run in the transaction that takes a task or project out of the Recycle Bin,
// before it does: every link, session and unredeemed grant that is refused now
// only because its model is deleted is revoked for good, so that restoring
// cannot revive it. That includes any an earlier version issued after a delete
// that stopped partway. Capabilities of other versions are left alone.
function revokeDeletedCapabilities(database, modelIds, { timestamp, actorId = null, reason }) {
  const revoked = { shares: 0, sessions: 0, grants: 0 };
  for (const modelId of modelIds) {
    for (const share of database.prepare('SELECT id,model_version_id FROM public_shares WHERE model_id=? AND revoked_at IS NULL').all(modelId))
      if (modelDeleted(database, modelId, share.model_version_id))
        revoked.shares += database.prepare('UPDATE public_shares SET revoked_at=?,revoked_by=?,revoke_reason=?,updated_at=? WHERE id=? AND revoked_at IS NULL').run(timestamp, actorId, reason, timestamp, share.id).changes;
    for (const session of database.prepare('SELECT id,model_version_id FROM viewer_sessions WHERE model_id=? AND revoked_at IS NULL').all(modelId))
      if (modelDeleted(database, modelId, session.model_version_id))
        revoked.sessions += database.prepare('UPDATE viewer_sessions SET revoked_at=?,updated_at=? WHERE id=? AND revoked_at IS NULL').run(timestamp, timestamp, session.id).changes;
    for (const grant of database.prepare('SELECT id,model_version_id,permissions_json FROM session_grants WHERE model_id=? AND redeemed_at IS NULL').all(modelId))
      if (modelDeleted(database, modelId, grantVersionId(grant)))
        revoked.grants += database.prepare('DELETE FROM session_grants WHERE id=? AND redeemed_at IS NULL').run(grant.id).changes;
  }
  return revoked;
}

module.exports = { modelDeleted, grantVersionId, revokeDeletedCapabilities };
