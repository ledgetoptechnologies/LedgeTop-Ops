PRAGMA foreign_keys = ON;

ALTER TABLE file_request_uploads ADD COLUMN client_upload_id TEXT;
ALTER TABLE file_request_uploads ADD COLUMN completion_claimed_at TEXT;
ALTER TABLE file_request_uploads ADD COLUMN quota_released_at TEXT;
ALTER TABLE file_request_uploads ADD COLUMN verified_sha256 TEXT;
ALTER TABLE file_requests ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_request_uploads_client_id
  ON file_request_uploads(request_id,contributor_id,client_upload_id)
  WHERE client_upload_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS file_request_upload_parts (
  upload_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  etag TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(upload_id,part_number),
  FOREIGN KEY(upload_id) REFERENCES file_request_uploads(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS incoming_link_state (
  slot TEXT PRIMARY KEY CHECK (slot='default'),
  active_request_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(active_request_id) REFERENCES file_requests(id)
);

INSERT OR IGNORE INTO incoming_link_state(slot) VALUES ('default');
