PRAGMA foreign_keys = ON;

-- This is a durable intent ledger only. It has no provider credential, no
-- network side effect, and grants no portal access. A later internal consumer
-- may claim and deliver a row only after its provider contract is complete.
CREATE TABLE IF NOT EXISTS client_portal_notification_outbox (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('request_submitted','request_status_changed')),
  status_value TEXT CHECK (status_value IN ('submitted','under_review','accepted','declined','cancelled','completed')),
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('staff_triage','client_requester')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','suppressed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_expires_at TEXT,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id, event_type, status_value, recipient_kind),
  FOREIGN KEY (request_id) REFERENCES client_service_requests(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_client_portal_notification_outbox_ready
  ON client_portal_notification_outbox(status, next_attempt_at, lease_expires_at, created_at);
