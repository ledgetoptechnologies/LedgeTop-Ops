-- Scheduling metadata never enrolls or enables a producer. Primary recovery
-- retains its existing schedule; only already-active business_data is eligible.
CREATE TABLE pa_snapshot_recovery_scheduler (
  id TEXT PRIMARY KEY CHECK(id='secondary'),
  last_scheduled_at INTEGER NOT NULL DEFAULT 0 CHECK(last_scheduled_at>=0),
  lease_token TEXT,
  lease_until INTEGER,
  CHECK((lease_token IS NULL)=(lease_until IS NULL))
);
INSERT INTO pa_snapshot_recovery_scheduler(id) VALUES('secondary');

CREATE TABLE pa_snapshot_recovery_sources (
  source_id TEXT PRIMARY KEY REFERENCES pa_connectors(source_id),
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK(next_attempt_at>=0),
  status TEXT NOT NULL DEFAULT 'never' CHECK(status IN ('never','running','success','failed','deferred')),
  error_code TEXT CHECK(error_code IS NULL OR (length(error_code) BETWEEN 1 AND 80 AND error_code NOT GLOB '*[^a-z0-9_-]*')),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 32),
  attempt_id TEXT,
  lease_token TEXT,
  lease_until INTEGER,
  CHECK(source_id<>'project-alpha:primary'),
  CHECK((status='running' AND attempt_id IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (status<>'running' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX idx_pa_snapshot_recovery_due ON pa_snapshot_recovery_sources(next_attempt_at,last_attempt_at,source_id);
CREATE TRIGGER pa_snapshot_recovery_source_insert BEFORE INSERT ON pa_snapshot_recovery_sources
WHEN NOT EXISTS(SELECT 1 FROM pa_connectors WHERE source_id=NEW.source_id AND profile='business_data')
  OR EXISTS(SELECT 1 FROM pa_snapshot_recovery_sources WHERE source_id=NEW.source_id)
BEGIN SELECT RAISE(ABORT,'snapshot recovery source is invalid'); END;
CREATE TRIGGER pa_snapshot_recovery_source_identity BEFORE UPDATE ON pa_snapshot_recovery_sources
WHEN NEW.source_id IS NOT OLD.source_id
BEGIN SELECT RAISE(ABORT,'snapshot recovery source is immutable'); END;
CREATE TRIGGER pa_snapshot_recovery_source_no_delete BEFORE DELETE ON pa_snapshot_recovery_sources
BEGIN SELECT RAISE(ABORT,'snapshot recovery accounting is persistent'); END;
INSERT INTO pa_snapshot_recovery_sources(source_id) SELECT source_id FROM pa_connectors WHERE profile='business_data';
CREATE TRIGGER pa_connector_recovery_registration AFTER INSERT ON pa_connectors WHEN NEW.profile='business_data'
BEGIN INSERT INTO pa_snapshot_recovery_sources(source_id) VALUES(NEW.source_id); END;

CREATE TABLE pa_snapshot_recovery_attempts (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES pa_snapshot_recovery_sources(source_id),
  scheduled_at INTEGER NOT NULL,
  scheduler_token TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision>0),
  source_version INTEGER NOT NULL CHECK(source_version>0),
  primary_revision INTEGER NOT NULL CHECK(primary_revision>0),
  primary_version INTEGER NOT NULL CHECK(primary_version>0),
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL CHECK(deadline_at>started_at),
  completed_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running','success','failed','deferred')),
  error_code TEXT CHECK(error_code IS NULL OR (length(error_code) BETWEEN 1 AND 80 AND error_code NOT GLOB '*[^a-z0-9_-]*')),
  CHECK((status='running')=(completed_at IS NULL)),
  UNIQUE(scheduled_at,source_id)
);
CREATE INDEX idx_pa_snapshot_recovery_attempt_source ON pa_snapshot_recovery_attempts(source_id,started_at DESC,id);
CREATE INDEX idx_pa_snapshot_recovery_expired_running ON pa_snapshot_recovery_attempts(deadline_at) WHERE status='running';
CREATE TRIGGER pa_snapshot_recovery_attempt_insert BEFORE INSERT ON pa_snapshot_recovery_attempts
WHEN NEW.status<>'running' OR EXISTS(SELECT 1 FROM pa_snapshot_recovery_attempts
    WHERE id=NEW.id OR (scheduled_at=NEW.scheduled_at AND source_id=NEW.source_id))
  OR NOT EXISTS(SELECT 1 FROM pa_snapshot_recovery_sources source WHERE source.source_id=NEW.source_id
    AND source.attempt_id=NEW.id AND source.status='running' AND source.lease_token=NEW.lease_token)
BEGIN SELECT RAISE(ABORT,'snapshot recovery attempt is invalid'); END;
CREATE TRIGGER pa_snapshot_recovery_attempt_identity BEFORE UPDATE ON pa_snapshot_recovery_attempts
WHEN OLD.id IS NOT NEW.id OR OLD.source_id IS NOT NEW.source_id OR OLD.scheduled_at IS NOT NEW.scheduled_at
  OR OLD.scheduler_token IS NOT NEW.scheduler_token OR OLD.lease_token IS NOT NEW.lease_token
  OR OLD.source_revision IS NOT NEW.source_revision OR OLD.source_version IS NOT NEW.source_version
  OR OLD.primary_revision IS NOT NEW.primary_revision OR OLD.primary_version IS NOT NEW.primary_version
  OR OLD.started_at IS NOT NEW.started_at OR OLD.deadline_at IS NOT NEW.deadline_at
  OR OLD.status<>'running' OR NEW.status='running'
BEGIN SELECT RAISE(ABORT,'snapshot recovery attempt is immutable or terminal'); END;
CREATE TRIGGER pa_snapshot_recovery_attempt_no_delete BEFORE DELETE ON pa_snapshot_recovery_attempts
BEGIN SELECT RAISE(ABORT,'snapshot recovery attempts are persistent'); END;

CREATE TABLE pa_snapshot_recovery_write_guard (
  id TEXT PRIMARY KEY CHECK(id='secondary'),
  write_guard INTEGER NOT NULL CONSTRAINT pa_snapshot_recovery_claim_guard CHECK(write_guard=1)
);
