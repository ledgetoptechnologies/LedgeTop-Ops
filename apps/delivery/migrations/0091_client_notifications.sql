PRAGMA foreign_keys = ON;

ALTER TABLE shares ADD COLUMN recipient_email TEXT;

CREATE TABLE IF NOT EXISTS delivery_notifications (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  share_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('share_created','share_updated','share_revoked','first_access','expiring_72h')),
  recipient_email TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_until TEXT,
  sent_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_delivery_notifications_pending
  ON delivery_notifications(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_shares_recipient_expiration
  ON shares(recipient_email, revoked_at, expires_at);
