PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS browser_upload_intents (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  root_prefix TEXT NOT NULL,
  collision_policy TEXT NOT NULL CHECK (collision_policy IN ('fail','rename','replace')),
  file_count INTEGER NOT NULL CHECK (file_count BETWEEN 1 AND 100),
  total_bytes INTEGER NOT NULL CHECK (total_bytes > 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','aborted','expired')),
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(created_by,idempotency_key),
  FOREIGN KEY (created_by) REFERENCES staff_users(id)
);

CREATE INDEX IF NOT EXISTS idx_browser_upload_intents_due
  ON browser_upload_intents(status,expires_at);

CREATE TABLE IF NOT EXISTS browser_upload_intent_files (
  intent_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 100),
  relative_path TEXT NOT NULL,
  object_key TEXT NOT NULL,
  expected_size INTEGER NOT NULL CHECK (expected_size > 0),
  content_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','uploading','completed','failed','aborted')),
  session_id TEXT,
  result_key TEXT,
  result_etag TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(intent_id,ordinal),
  UNIQUE(intent_id,relative_path),
  FOREIGN KEY (intent_id) REFERENCES browser_upload_intents(id) ON DELETE CASCADE
);

ALTER TABLE r2_upload_sessions ADD COLUMN intent_id TEXT;
ALTER TABLE r2_upload_sessions ADD COLUMN intent_ordinal INTEGER;
ALTER TABLE r2_upload_sessions ADD COLUMN staging_key TEXT;
ALTER TABLE r2_upload_sessions ADD COLUMN part_size INTEGER;
ALTER TABLE r2_upload_sessions ADD COLUMN conflict_policy TEXT NOT NULL DEFAULT 'fail';
ALTER TABLE r2_upload_sessions ADD COLUMN result_key TEXT;
ALTER TABLE r2_upload_sessions ADD COLUMN result_etag TEXT;
ALTER TABLE r2_upload_sessions ADD COLUMN completion_claimed_at TEXT;
-- New browser-upload sessions persist the destination version observed before
-- staging begins. Values are `absent` or `etag:<R2 HTTP ETag>`; `unknown` is a
-- fail-closed migration default for any session that predates this feature.
ALTER TABLE r2_upload_sessions ADD COLUMN destination_baseline TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE r2_replacement_recovery ADD COLUMN replacement_result_etag TEXT;

-- SQLite cannot widen the status CHECK in place. Rebuild both sides of the
-- existing upload-parts foreign key so completion can durably own a session
-- before touching multipart/R2 publication state.
ALTER TABLE r2_upload_parts RENAME TO r2_upload_parts_legacy_0018;
ALTER TABLE r2_upload_sessions RENAME TO r2_upload_sessions_legacy_0018;
DROP INDEX IF EXISTS idx_r2_upload_sessions_status;

CREATE TABLE r2_upload_sessions (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL,
  expected_size INTEGER NOT NULL CHECK (expected_size >= 0),
  content_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completing','completed','aborted','expired')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  intent_id TEXT,
  intent_ordinal INTEGER,
  staging_key TEXT,
  part_size INTEGER,
  conflict_policy TEXT NOT NULL DEFAULT 'fail',
  result_key TEXT,
  result_etag TEXT,
  completion_claimed_at TEXT,
  destination_baseline TEXT NOT NULL DEFAULT 'unknown',
  replacement_recovery_id TEXT,
  cleanup_status TEXT NOT NULL DEFAULT 'not_due'
    CHECK (cleanup_status IN ('not_due','pending','complete','failed')),
  cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
  cleanup_next_attempt_at TEXT,
  cleanup_claimed_at TEXT,
  cleanup_error TEXT,
  FOREIGN KEY (created_by) REFERENCES staff_users(id)
);

INSERT INTO r2_upload_sessions(
  id,upload_id,object_key,expected_size,content_type,status,created_by,created_at,expires_at,completed_at,
  intent_id,intent_ordinal,staging_key,part_size,conflict_policy,result_key,result_etag,completion_claimed_at,destination_baseline,
  cleanup_status,cleanup_next_attempt_at)
SELECT id,upload_id,object_key,expected_size,content_type,status,created_by,created_at,expires_at,completed_at,
  intent_id,intent_ordinal,staging_key,part_size,conflict_policy,result_key,result_etag,completion_claimed_at,destination_baseline,
  CASE WHEN staging_key IS NULL THEN 'complete' WHEN status IN ('completed','aborted','expired') THEN 'pending' ELSE 'not_due' END,
  CASE WHEN staging_key IS NOT NULL AND status IN ('completed','aborted','expired') THEN datetime('now') ELSE NULL END
FROM r2_upload_sessions_legacy_0018;

CREATE INDEX idx_r2_upload_sessions_status
  ON r2_upload_sessions(status,expires_at);

CREATE INDEX idx_r2_upload_sessions_cleanup
  ON r2_upload_sessions(cleanup_status,cleanup_next_attempt_at,cleanup_claimed_at);

CREATE TABLE r2_upload_parts (
  session_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number >= 1),
  etag TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id,part_number),
  FOREIGN KEY (session_id) REFERENCES r2_upload_sessions(id) ON DELETE CASCADE
);

INSERT INTO r2_upload_parts(session_id,part_number,etag,size,uploaded_at)
SELECT session_id,part_number,etag,size,uploaded_at FROM r2_upload_parts_legacy_0018;

DROP TABLE r2_upload_parts_legacy_0018;
DROP TABLE r2_upload_sessions_legacy_0018;

CREATE UNIQUE INDEX IF NOT EXISTS idx_r2_upload_sessions_intent_file
  ON r2_upload_sessions(intent_id,intent_ordinal)
  WHERE intent_id IS NOT NULL;
