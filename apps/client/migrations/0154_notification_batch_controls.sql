PRAGMA foreign_keys = ON;

-- Staff control receipts are not grants or recipient assignments. Keep the
-- successful compare-and-swap result for uncertain-response retries.
CREATE TABLE client_folder_notification_batch_controls (
  actor_id TEXT NOT NULL,
  mutation_key TEXT NOT NULL CHECK (length(mutation_key) BETWEEN 16 AND 128),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint)=43),
  batch_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('send-now','cancel')),
  expected_revision INTEGER NOT NULL CHECK (expected_revision>=1),
  result_revision INTEGER NOT NULL CHECK (result_revision=expected_revision+1),
  result_status TEXT NOT NULL CHECK (result_status IN ('pending','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (actor_id,mutation_key),
  FOREIGN KEY (batch_id) REFERENCES client_folder_notification_batches(id)
);
CREATE INDEX idx_client_folder_notification_batch_controls_batch
  ON client_folder_notification_batch_controls(batch_id,created_at);

CREATE TRIGGER client_folder_notification_batch_control_result
BEFORE INSERT ON client_folder_notification_batch_controls
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM client_folder_notification_batches batch
    WHERE batch.id=NEW.batch_id AND batch.revision=NEW.result_revision
      AND batch.status=NEW.result_status
      AND ((NEW.action='cancel' AND NEW.result_status='cancelled')
        OR (NEW.action='send-now' AND NEW.result_status='pending'))
  ) THEN RAISE(ABORT,'notification-control-result-mismatch') END;
END;
