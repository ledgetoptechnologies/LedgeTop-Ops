PRAGMA foreign_keys = ON;

-- Singleton scheduler ownership and fair-rotation cursor. This control plane
-- references only the read-only 0136 reconciliation ledger.
CREATE TABLE project_alpha_directory_reconciliation_scheduler (
  scheduler_id INTEGER NOT NULL PRIMARY KEY CHECK(scheduler_id=1),
  cursor_source_id TEXT,
  lease_token TEXT,
  lease_expires_at INTEGER,
  updated_at TEXT NOT NULL,
  CHECK((lease_token IS NULL)=(lease_expires_at IS NULL))
);
INSERT INTO project_alpha_directory_reconciliation_scheduler(scheduler_id,updated_at)
VALUES(1,'1970-01-01T00:00:00.000Z');

CREATE TABLE project_alpha_directory_reconciliation_schedule_sources (
  source_id TEXT NOT NULL PRIMARY KEY CHECK(substr(source_id,1,14)='project-alpha:'),
  next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK(next_attempt_at>=0),
  consecutive_uncertain INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_uncertain>=0),
  last_status TEXT CHECK(last_status IS NULL OR last_status IN ('complete','uncertain')),
  last_run_id TEXT REFERENCES project_alpha_directory_reconciliation_runs(run_id) ON DELETE RESTRICT,
  last_attempt_at INTEGER,
  updated_at TEXT NOT NULL,
  CHECK((last_status IS NULL)=(last_run_id IS NULL AND last_attempt_at IS NULL))
);

CREATE TRIGGER project_alpha_directory_reconciliation_schedule_source_identity
BEFORE UPDATE ON project_alpha_directory_reconciliation_schedule_sources
WHEN NEW.source_id IS NOT OLD.source_id
BEGIN SELECT RAISE(ABORT,'directory reconciliation schedule source identity is immutable'); END;
CREATE TRIGGER project_alpha_directory_reconciliation_schedule_sources_no_delete
BEFORE DELETE ON project_alpha_directory_reconciliation_schedule_sources
BEGIN SELECT RAISE(ABORT,'directory reconciliation schedule history is durable'); END;
