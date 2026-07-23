PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS file_aliases (
  physical_key TEXT PRIMARY KEY,
  parent_key TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'system',
  updated_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_file_aliases_display_name
  ON file_aliases(display_name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS bulk_download_jobs (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  share_version INTEGER NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','ready','failed','expired','cancelled')),
  manifest_key TEXT NOT NULL,
  archive_key TEXT NOT NULL,
  multipart_upload_id TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  processed_files INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  processed_bytes INTEGER NOT NULL DEFAULT 0,
  archive_size INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bulk_download_jobs_share_status
  ON bulk_download_jobs(share_id,status,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bulk_download_jobs_expiry
  ON bulk_download_jobs(expires_at);
