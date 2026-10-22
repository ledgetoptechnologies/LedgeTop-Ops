'use strict';

const INVALID_CODE = 'invalid_providerless_retry';

function json(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function previousAttemptId(database, attemptId) {
  const rows = database.prepare(`
    SELECT details_json FROM audit_events
    WHERE action='processing_attempt.retried'
      AND entity_type='processing_attempt'
      AND entity_id=?
    ORDER BY created_at DESC,id DESC
  `).all(attemptId);
  const ids = [...new Set(rows.map((row) => json(row.details_json).previousAttemptId).filter(Boolean))];
  return ids.length === 1 ? ids[0] : null;
}

function retryRoot(database, attempt) {
  const seen = new Set([attempt.id]);
  let current = attempt;
  for (let depth = 0; depth < 100; depth += 1) {
    const previousId = previousAttemptId(database, current.id);
    if (!previousId) return current;
    if (seen.has(previousId)) return null;
    const previous = database.prepare('SELECT * FROM processing_attempts WHERE id=?').get(previousId);
    if (!previous || previous.task_id !== attempt.task_id) return null;
    seen.add(previousId);
    current = previous;
  }
  return null;
}

function owningFailedOperation(database, attemptId) {
  const rows = database.prepare(`
    SELECT * FROM dataset_operations
    WHERE processing_attempt_id=? AND status='failed'
    ORDER BY created_at,id
  `).all(attemptId);
  return rows.length === 1 ? rows[0] : null;
}

function reconcileProviderlessRetries(processing, { limit = 100 } = {}) {
  const database = processing.database;
  const candidates = database.prepare(`
    SELECT a.* FROM processing_attempts a
    WHERE a.provider_id IS NULL
      AND a.status='pending'
      AND COALESCE(a.submission_phase,'new')='new'
      AND COALESCE(a.uploaded_file_count,0)=0
      AND a.result_model_id IS NULL
      AND a.result_model_version_id IS NULL
      AND EXISTS (
        SELECT 1 FROM processing_jobs j
        WHERE j.attempt_id=a.id AND j.job_type='submit' AND j.status IN ('pending','leased')
      )
    ORDER BY a.created_at,a.id
    LIMIT ?
  `).all(Math.max(1, Math.min(Number(limit) || 100, 1000)));
  let invalidated = 0;
  let restored = 0;
  for (const candidate of candidates) {
    processing.transaction(() => {
      const attempt = database.prepare(`
        SELECT * FROM processing_attempts
        WHERE id=? AND provider_id IS NULL AND status='pending'
          AND COALESCE(submission_phase,'new')='new'
          AND COALESCE(uploaded_file_count,0)=0
          AND result_model_id IS NULL AND result_model_version_id IS NULL
      `).get(candidate.id);
      if (!attempt) return;
      const t = new Date().toISOString();
      database.prepare(`
        UPDATE processing_jobs
        SET status='failed',lease_owner=NULL,lease_expires_at=NULL,
            error_code=?,error_message=?,updated_at=?
        WHERE attempt_id=? AND job_type='submit' AND status IN ('pending','leased')
      `).run(INVALID_CODE, 'Imported work cannot be retried as a provider submission.', t, attempt.id);
      if (database.prepare(`
        UPDATE processing_attempts
        SET status='failed',error_code=?,error_message=?,completed_at=COALESCE(completed_at,?),updated_at=?
        WHERE id=? AND provider_id IS NULL AND status='pending'
      `).run(INVALID_CODE, 'Retry the owning import or required derivative operation.', t, t, attempt.id).changes !== 1) return;
      invalidated += 1;

      const root = retryRoot(database, attempt);
      const operation = root && root.id !== attempt.id && root.status === 'failed'
        ? owningFailedOperation(database, root.id)
        : null;
      if (operation) {
        restored += database.prepare(`
          UPDATE processing_tasks
          SET active_attempt_id=?,status='failed',updated_at=?
          WHERE id=? AND active_attempt_id=?
        `).run(root.id, t, attempt.task_id, attempt.id).changes;
      } else {
        database.prepare(`
          UPDATE processing_tasks SET status='failed',updated_at=?
          WHERE id=? AND active_attempt_id=?
        `).run(t, attempt.task_id, attempt.id);
      }
      processing.recordProcessingEvent({
        attemptId: attempt.id,
        operationId: operation?.id || null,
        eventType: 'processing_attempt.invalid_providerless_retry',
        phase: 'failed',
        severity: 'error',
        errorCode: INVALID_CODE,
        message: 'Imported work must be retried through its owning operation.',
        details: { previousAttemptId: previousAttemptId(database, attempt.id), restoredAttemptId: operation ? root.id : null },
        createdAt: t,
      });
      processing.insertAudit({
        actorId: null,
        action: 'processing_attempt.invalid_providerless_retry',
        entityType: 'processing_attempt',
        entityId: attempt.id,
        details: { restoredAttemptId: operation ? root.id : null, operationId: operation?.id || null },
      });
    });
  }
  return { scanned: candidates.length, invalidated, restored };
}

module.exports = { INVALID_CODE, reconcileProviderlessRetries };
