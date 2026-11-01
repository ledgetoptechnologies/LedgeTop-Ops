'use strict';

// The overview describes current work. Historical attempts remain available
// in task history, but do not keep resolved or recycled work actionable.
function processingJobCounts(database) {
  return database.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN a.status IN ('pending','admitted','initializing','uploading','committed','queued_upstream') THEN 1 ELSE 0 END),0) AS queued,
      COALESCE(SUM(CASE WHEN a.status IN ('running','ingesting','derivatives','cancelling') THEN 1 ELSE 0 END),0) AS running,
      COALESCE(SUM(CASE WHEN a.status='ready_for_review' THEN 1 ELSE 0 END),0) AS reviewReady,
      COALESCE(SUM(CASE WHEN a.status='failed' THEN 1 ELSE 0 END),0) AS failed,
      COALESCE(SUM(CASE WHEN a.status IN ('pending','admitted','initializing','uploading','committed','queued_upstream','running','ingesting') AND EXISTS (
        SELECT 1 FROM processing_jobs j WHERE j.attempt_id=a.id AND j.status IN ('pending','leased') AND (
          (j.job_type='reconcile' AND j.error_code IN (
            'provider_observation_unavailable','provider_status_unknown','provider_status_not_found',
            'provider_status_auth_failed','provider_adapter_unavailable','provider_observation_persistence_unavailable','provider_result_identity_mismatch','provider_attempt_unavailable'
          )) OR (j.job_type='ingest' AND j.error_code='provider_download_unavailable')
          OR (j.job_type='submit' AND j.error_code IN ('provider_submission_ambiguous','provider_image_limit_exceeded','provider_input_limit_exceeded','provider_upload_request_limit_exceeded','provider_capacity_invalid','provider_filename_unsupported','provider_input_type_unsupported','provider_input_empty','duplicate_source_basename'))
        )
      ) THEN 1 ELSE 0 END),0) AS observationWarnings
    FROM processing_attempts a
    JOIN processing_tasks t ON t.id=a.task_id AND t.active_attempt_id=a.id
    JOIN projects p ON p.id=t.project_id
    WHERE t.status<>'archived' AND t.purged_at IS NULL
      AND p.status='active' AND p.purged_at IS NULL
  `).get();
}

module.exports = { processingJobCounts };
