PRAGMA foreign_keys = ON;

-- Direct/revocation notification jobs predate multi-source delivery. Persist
-- their immutable receipt source so each bounded source queue can be probed
-- independently instead of globally scanning another tenant's backlog.
ALTER TABLE project_alpha_delivery_portal_notification_outbox
  ADD COLUMN project_alpha_source_id TEXT;

UPDATE project_alpha_delivery_portal_notification_outbox
SET project_alpha_source_id=(
  SELECT receipt.project_alpha_source_id
  FROM project_alpha_delivery_intent_receipts receipt
  WHERE receipt.receipt_id=project_alpha_delivery_portal_notification_outbox.receipt_id
)
WHERE project_alpha_source_id IS NULL;

CREATE TRIGGER project_alpha_delivery_notification_source_insert_guard
BEFORE INSERT ON project_alpha_delivery_portal_notification_outbox
WHEN NEW.project_alpha_source_id IS NOT NULL AND NEW.project_alpha_source_id IS NOT (
  SELECT receipt.project_alpha_source_id FROM project_alpha_delivery_intent_receipts receipt
  WHERE receipt.receipt_id=NEW.receipt_id
)
BEGIN SELECT RAISE(ABORT,'delivery-notification-source-conflict'); END;

CREATE TRIGGER project_alpha_delivery_notification_source_fill
AFTER INSERT ON project_alpha_delivery_portal_notification_outbox
WHEN NEW.project_alpha_source_id IS NULL
BEGIN
  UPDATE project_alpha_delivery_portal_notification_outbox
  SET project_alpha_source_id=(SELECT receipt.project_alpha_source_id
    FROM project_alpha_delivery_intent_receipts receipt WHERE receipt.receipt_id=NEW.receipt_id)
  WHERE id=NEW.id;
  SELECT CASE WHEN (SELECT project_alpha_source_id FROM project_alpha_delivery_portal_notification_outbox WHERE id=NEW.id) IS NULL
    THEN RAISE(ABORT,'delivery-notification-source-unavailable') END;
END;

CREATE TRIGGER project_alpha_delivery_notification_source_immutable
BEFORE UPDATE OF project_alpha_source_id,receipt_id ON project_alpha_delivery_portal_notification_outbox
WHEN NEW.receipt_id IS NOT OLD.receipt_id OR
  (OLD.project_alpha_source_id IS NOT NULL AND NEW.project_alpha_source_id IS NOT OLD.project_alpha_source_id)
BEGIN SELECT RAISE(ABORT,'delivery-notification-source-immutable'); END;

CREATE INDEX idx_project_alpha_delivery_notification_source_direct_pending
  ON project_alpha_delivery_portal_notification_outbox(project_alpha_source_id,next_attempt_at,created_at,id)
  WHERE status='pending' AND attempt_count<3
    AND NOT(event_type='granted' AND attempt_count=0 AND lease_expires_at IS NULL);

CREATE INDEX idx_project_alpha_delivery_notification_source_processing
  ON project_alpha_delivery_portal_notification_outbox(project_alpha_source_id,lease_expires_at,created_at,id)
  WHERE status='processing' AND attempt_count<3;

-- Bounded global probes only inspect a fixed candidate window before JS
-- classifies legacy rows whose source is no longer registered.
CREATE INDEX idx_project_alpha_delivery_notification_ready_pending
  ON project_alpha_delivery_portal_notification_outbox(next_attempt_at,created_at,id,project_alpha_source_id)
  WHERE status='pending' AND attempt_count<3;

CREATE INDEX idx_project_alpha_delivery_notification_ready_processing
  ON project_alpha_delivery_portal_notification_outbox(lease_expires_at,created_at,id,project_alpha_source_id)
  WHERE status='processing' AND attempt_count<3;

CREATE INDEX idx_project_alpha_delivery_notification_pending_exhausted
  ON project_alpha_delivery_portal_notification_outbox(next_attempt_at,created_at,id)
  WHERE status='pending' AND attempt_count>=3;

CREATE INDEX idx_project_alpha_delivery_notification_processing_exhausted
  ON project_alpha_delivery_portal_notification_outbox(lease_expires_at,created_at,id)
  WHERE status='processing' AND attempt_count>=3;
