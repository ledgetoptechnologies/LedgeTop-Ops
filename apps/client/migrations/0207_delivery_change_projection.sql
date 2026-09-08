PRAGMA foreign_keys=ON;

-- Receipt targets are immutable acceptance facts. Projection state is kept in
-- this separate, mutable table so a staging retry cannot alter the saved
-- recipient set or rediscover a recipient after acceptance.
CREATE TABLE portal_authenticated_delivery_change_projection_jobs (
  receipt_key TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL CHECK(grant_version>=1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
  next_attempt_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(julianday(next_attempt_at) IS NOT NULL),
  lease_token TEXT CHECK(lease_token IS NULL OR length(lease_token) BETWEEN 16 AND 128),
  lease_expires_at TEXT CHECK(lease_expires_at IS NULL OR julianday(lease_expires_at) IS NOT NULL),
  last_reason_code TEXT CHECK(last_reason_code IS NULL OR last_reason_code IN (
    'authority-suppressed','staging-fence','staging-schema','staging-invalid','staging-failed'
  )),
  completed_at TEXT CHECK(completed_at IS NULL OR julianday(completed_at) IS NOT NULL),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(receipt_key,grant_id,identity_id),
  FOREIGN KEY(receipt_key,grant_id,identity_id)
    REFERENCES portal_authenticated_delivery_change_receipt_targets(receipt_key,grant_id,identity_id)
);
CREATE INDEX idx_authenticated_delivery_projection_claim
  ON portal_authenticated_delivery_change_projection_jobs(status,next_attempt_at,receipt_key);
CREATE INDEX idx_authenticated_delivery_projection_target
  ON portal_authenticated_delivery_change_projection_jobs(grant_id,grant_version,identity_id,status,receipt_key);

-- A seal is inserted only after the exact target set is complete. Creating
-- jobs in this trigger makes receipt acceptance and pending projection work one
-- D1 transaction, including an intentionally empty recipient set.
CREATE TRIGGER authenticated_delivery_projection_create_sealed_targets
AFTER INSERT ON portal_authenticated_delivery_change_receipt_seals
BEGIN
  INSERT INTO portal_authenticated_delivery_change_projection_jobs
    (receipt_key,grant_id,identity_id,grant_version)
  SELECT target.receipt_key,target.grant_id,target.identity_id,target.grant_version
  FROM portal_authenticated_delivery_change_receipt_targets target
  WHERE target.receipt_key=NEW.receipt_key;
END;

-- Initialize only already-sealed acceptance facts at migration time. This is
-- deliberately not a file-index backfill and never reruns candidate selection.
INSERT OR IGNORE INTO portal_authenticated_delivery_change_projection_jobs
  (receipt_key,grant_id,identity_id,grant_version)
SELECT target.receipt_key,target.grant_id,target.identity_id,target.grant_version
FROM portal_authenticated_delivery_change_receipt_seals seal
JOIN portal_authenticated_delivery_change_receipt_targets target ON target.receipt_key=seal.receipt_key;
