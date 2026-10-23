'use strict';

// The overview describes current work. Historical attempts remain available
// in task history, but do not keep resolved or recycled work actionable.
function processingJobCounts(database) {
  return database.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN a.status IN ('pending','admitted','initializing','uploading','committed','queued_upstream') THEN 1 ELSE 0 END),0) AS queued,
      COALESCE(SUM(CASE WHEN a.status IN ('running','ingesting','derivatives','cancelling') THEN 1 ELSE 0 END),0) AS running,
      COALESCE(SUM(CASE WHEN a.status='ready_for_review' THEN 1 ELSE 0 END),0) AS reviewReady,
      COALESCE(SUM(CASE WHEN a.status='failed' THEN 1 ELSE 0 END),0) AS failed
    FROM processing_attempts a
    JOIN processing_tasks t ON t.id=a.task_id AND t.active_attempt_id=a.id
    JOIN projects p ON p.id=t.project_id
    WHERE t.status<>'archived' AND t.purged_at IS NULL
      AND p.status='active' AND p.purged_at IS NULL
  `).get();
}

module.exports = { processingJobCounts };
