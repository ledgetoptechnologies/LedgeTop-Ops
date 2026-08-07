PRAGMA foreign_keys = ON;

ALTER TABLE r2_operation_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE r2_operation_jobs ADD COLUMN next_attempt_at TEXT;
ALTER TABLE r2_operation_jobs ADD COLUMN claim_token TEXT;

CREATE INDEX IF NOT EXISTS idx_r2_operation_jobs_retry
  ON r2_operation_jobs(status,next_attempt_at,lease_until,created_at);
