PRAGMA foreign_keys = ON;

-- Native delivery dispatch enumerates the bounded registered-source set and
-- probes each source independently. These partial indexes keep a noisy source
-- from turning another tenant's ready probe into a global backlog scan.
CREATE INDEX idx_portal_delivery_notification_source_pending
  ON portal_delivery_notification_batches(source_id,eligible_at,created_at,id)
  WHERE status='pending' AND attempt_count<3;

CREATE INDEX idx_portal_delivery_notification_source_processing
  ON portal_delivery_notification_batches(source_id,lease_expires_at,created_at,id)
  WHERE status='processing' AND attempt_count<3;

CREATE INDEX idx_portal_delivery_notification_pending_exhausted
  ON portal_delivery_notification_batches(eligible_at,created_at,id)
  WHERE status='pending' AND attempt_count>=3;

CREATE INDEX idx_portal_delivery_notification_processing_exhausted
  ON portal_delivery_notification_batches(lease_expires_at,created_at,id)
  WHERE status='processing' AND attempt_count>=3;

CREATE TABLE portal_delivery_notification_scheduler (
  id TEXT PRIMARY KEY CHECK(id='source-round-robin'),
  staged_last_source_id TEXT,
  direct_last_source_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);

INSERT INTO portal_delivery_notification_scheduler(id)
VALUES('source-round-robin');
