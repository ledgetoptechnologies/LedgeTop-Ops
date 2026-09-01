PRAGMA foreign_keys = ON;

-- Bearer-bearing notification jobs must remain bound to the exact share
-- generation and recipient authority that existed when they were queued.
-- Never infer this provenance for legacy unsent rows from the current share:
-- the share may have rotated since the row was created.
ALTER TABLE delivery_notifications ADD COLUMN share_version INTEGER;
ALTER TABLE delivery_notifications ADD COLUMN recipient_authority_kind TEXT
  CHECK (recipient_authority_kind IN ('direct_email','directory_principal'));
ALTER TABLE delivery_notifications ADD COLUMN recipient_principal_public_id TEXT;

UPDATE delivery_notifications
SET status='failed',
    lease_until=NULL,
    next_attempt_at=datetime('now'),
    last_error='notification-provenance-unavailable',
    updated_at=datetime('now')
WHERE kind IN ('share_created','share_updated')
  AND status IN ('queued','sending','failed');

CREATE INDEX IF NOT EXISTS idx_delivery_notifications_share_authority
  ON delivery_notifications(share_id,share_version,status,created_at);

CREATE TRIGGER delivery_notifications_bearer_authority_insert
BEFORE INSERT ON delivery_notifications
WHEN NEW.kind IN ('share_created','share_updated') AND (
  NEW.share_version IS NULL OR NEW.share_version < 1 OR
  NEW.recipient_authority_kind IS NULL OR
  (NEW.recipient_authority_kind='directory_principal' AND NEW.recipient_principal_public_id IS NULL) OR
  (NEW.recipient_authority_kind='direct_email' AND NEW.recipient_principal_public_id IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'bearer notification authority provenance is required');
END;

CREATE TRIGGER delivery_notifications_bearer_authority_update
BEFORE UPDATE OF kind,share_version,recipient_authority_kind,recipient_principal_public_id ON delivery_notifications
WHEN NEW.kind IN ('share_created','share_updated') AND (
  NEW.share_version IS NULL OR NEW.share_version < 1 OR
  NEW.recipient_authority_kind IS NULL OR
  (NEW.recipient_authority_kind='directory_principal' AND NEW.recipient_principal_public_id IS NULL) OR
  (NEW.recipient_authority_kind='direct_email' AND NEW.recipient_principal_public_id IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'bearer notification authority provenance is required');
END;

CREATE TRIGGER delivery_notifications_authority_immutable
BEFORE UPDATE OF share_id,recipient_email,share_version,recipient_authority_kind,recipient_principal_public_id
ON delivery_notifications
WHEN OLD.share_id IS NOT NEW.share_id
  OR OLD.recipient_email IS NOT NEW.recipient_email
  OR OLD.share_version IS NOT NEW.share_version
  OR OLD.recipient_authority_kind IS NOT NEW.recipient_authority_kind
  OR OLD.recipient_principal_public_id IS NOT NEW.recipient_principal_public_id
BEGIN
  SELECT RAISE(ABORT, 'delivery notification authority provenance is immutable');
END;

-- A provider may accept a message while a concurrent share rotation wins the
-- local lifecycle race. Keep that outcome terminal and distinguish it from a
-- successfully current delivery. Rotation statements explicitly skip it.
CREATE TRIGGER delivery_notifications_provider_accepted_terminal
BEFORE UPDATE ON delivery_notifications
WHEN OLD.status='failed' AND OLD.last_error='provider-accepted-after-suppression'
  AND (NEW.status IS NOT OLD.status OR NEW.last_error IS NOT OLD.last_error
    OR NEW.lease_until IS NOT OLD.lease_until OR NEW.sent_at IS NOT OLD.sent_at)
BEGIN
  SELECT RAISE(ABORT, 'provider accepted after notification suppression is terminal');
END;
