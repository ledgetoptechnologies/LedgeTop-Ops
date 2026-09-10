PRAGMA foreign_keys = ON;

-- This journal is intentionally separate from the pickup lifecycle.  It is a
-- publication record for R2's ready prefix, not a receipt that a TrueNAS host
-- downloaded or retained a file.
CREATE TABLE IF NOT EXISTS file_request_upload_basic_checks (
  upload_id TEXT PRIMARY KEY REFERENCES file_request_uploads(id) ON DELETE CASCADE,
  object_etag TEXT NOT NULL,
  object_bytes INTEGER NOT NULL CHECK (object_bytes > 0),
  object_version TEXT NOT NULL,
  check_version TEXT NOT NULL CHECK (check_version = 'basic-v1'),
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file_request_upload_promotion_journal (
  upload_id TEXT PRIMARY KEY REFERENCES file_request_uploads(id) ON DELETE CASCADE,
  source_identity TEXT NOT NULL,
  source_key TEXT NOT NULL,
  destination_key TEXT NOT NULL UNIQUE,
  multipart_upload_id TEXT,
  parts_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK (state IN ('pending','copying','publishing','ready','unavailable','failed')),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
  publication_started_at TEXT,
  published_at TEXT,
  destination_etag TEXT,
  destination_bytes INTEGER CHECK (destination_bytes IS NULL OR destination_bytes > 0),
  destination_version TEXT,
  retention_checked_at TEXT,
  retention_completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((state = 'pending' AND multipart_upload_id IS NULL) OR state <> 'pending')
);

CREATE INDEX IF NOT EXISTS idx_incoming_promotion_pending
  ON file_request_upload_promotion_journal(state, updated_at);

CREATE TABLE IF NOT EXISTS file_request_upload_promotion_outbox (
  upload_id TEXT NOT NULL REFERENCES file_request_uploads(id) ON DELETE CASCADE,
  segment INTEGER NOT NULL CHECK (segment BETWEEN 0 AND 2000),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures BETWEEN 0 AND 3),
  state TEXT NOT NULL CHECK (state IN ('pending','leased','dispatched','needs_attention')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  instance_id TEXT,
  error_code TEXT,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(upload_id,segment)
);
CREATE INDEX IF NOT EXISTS idx_incoming_promotion_outbox_drain
  ON file_request_upload_promotion_outbox(state,next_attempt_at,lease_expires_at,created_at);
