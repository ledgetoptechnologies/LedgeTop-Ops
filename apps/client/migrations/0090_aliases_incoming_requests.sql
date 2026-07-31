PRAGMA foreign_keys = ON;

-- Virtual names live with delivery metadata so both the Operations and public
-- Delivery Workers can project the same names without giving Delivery OPS_DB.
CREATE TABLE IF NOT EXISTS file_aliases (
  physical_key TEXT PRIMARY KEY,
  parent_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_aliases_sibling_name
  ON file_aliases(parent_key, display_name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS preview_artifacts (
  artifact_prefix TEXT PRIMARY KEY,
  source_key TEXT NOT NULL,
  source_etag TEXT,
  manifest_etag TEXT NOT NULL,
  missing_since TEXT,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_preview_artifacts_source
  ON preview_artifacts(source_key);

CREATE INDEX IF NOT EXISTS idx_preview_artifacts_missing
  ON preview_artifacts(missing_since);

CREATE TABLE IF NOT EXISTS file_requests (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT,
  access_code_hash TEXT,
  max_files INTEGER NOT NULL DEFAULT 500 CHECK (max_files BETWEEN 1 AND 500),
  max_bytes INTEGER NOT NULL DEFAULT 2199023255552 CHECK (max_bytes > 0),
  reserved_files INTEGER NOT NULL DEFAULT 0 CHECK (reserved_files >= 0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_file_requests_expiry
  ON file_requests(expires_at, revoked_at);

CREATE TABLE IF NOT EXISTS file_request_contributors (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT,
  client_address_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (request_id) REFERENCES file_requests(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS file_request_uploads (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  contributor_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  upload_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  declared_size INTEGER NOT NULL CHECK (declared_size > 0),
  actual_size INTEGER,
  content_type TEXT NOT NULL,
  declared_sha256 TEXT,
  etag TEXT,
  status TEXT NOT NULL CHECK (status IN ('uploading','quarantined','accepted','rejected','expired')),
  rejection_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (request_id) REFERENCES file_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (contributor_id) REFERENCES file_request_contributors(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_file_request_uploads_status
  ON file_request_uploads(status, created_at);

CREATE TABLE IF NOT EXISTS public_rate_limits (
  rate_key TEXT NOT NULL,
  window_bucket INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (rate_key, window_bucket)
);

CREATE INDEX IF NOT EXISTS idx_public_rate_limits_expiry
  ON public_rate_limits(expires_at);
