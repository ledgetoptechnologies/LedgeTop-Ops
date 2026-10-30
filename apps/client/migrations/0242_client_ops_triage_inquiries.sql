PRAGMA foreign_keys=ON;

-- Generic inquiries are not catalog service requests and must not acquire a
-- local account, project, source enrollment, or PA linkage.
CREATE TABLE client_ops_triage_inquiries (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  portal_identity_id TEXT NOT NULL REFERENCES portal_v2_identities(id) ON DELETE RESTRICT,
  authorizing_workspace_id TEXT NOT NULL CHECK(length(authorizing_workspace_id) BETWEEN 1 AND 128),
  authorizing_source_id TEXT NOT NULL CHECK(length(authorizing_source_id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK(kind IN ('website','drone','other')),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 160),
  details TEXT NOT NULL CHECK(length(trim(details)) BETWEEN 1 AND 4000),
  location TEXT CHECK(location IS NULL OR length(trim(location))<=300),
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','under_review','declined','closed')),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(portal_identity_id,idempotency_key)
);
CREATE INDEX idx_client_ops_triage_inquiries_queue
  ON client_ops_triage_inquiries(status,created_at,id);
CREATE INDEX idx_client_ops_triage_inquiries_identity
  ON client_ops_triage_inquiries(portal_identity_id,created_at DESC,id DESC);

CREATE TABLE client_ops_triage_notification_outbox (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
  inquiry_id TEXT NOT NULL REFERENCES client_ops_triage_inquiries(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type='inquiry_submitted'),
  recipient_kind TEXT NOT NULL CHECK(recipient_kind='staff_triage'),
  dedupe_key TEXT NOT NULL UNIQUE CHECK(length(dedupe_key) BETWEEN 1 AND 256),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed','suppressed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_expires_at TEXT,
  delivered_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(inquiry_id,event_type,recipient_kind)
);
CREATE INDEX idx_client_ops_triage_outbox_ready
  ON client_ops_triage_notification_outbox(status,next_attempt_at,lease_expires_at,created_at);
