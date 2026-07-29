-- Dropbox import jobs: staff import files from Dropbox into R2.
-- Mirrors the delivery-side cloud_transfer pattern but reversed:
-- source = Dropbox, destination = R2 (client-data bucket).

CREATE TABLE IF NOT EXISTS dropbox_import_authorizations (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'dropbox',
  credential_ciphertext TEXT NOT NULL,
  credential_iv TEXT NOT NULL,
  key_id TEXT NOT NULL DEFAULT 'v1',
  scopes TEXT NOT NULL DEFAULT '',
  token_expires_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  FOREIGN KEY (staff_id) REFERENCES staff_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dropbox_import_auth_staff
  ON dropbox_import_authorizations(staff_id,revoked_at,expires_at);

CREATE INDEX IF NOT EXISTS idx_dropbox_import_auth_expiry
  ON dropbox_import_authorizations(expires_at,revoked_at);

CREATE TABLE IF NOT EXISTS dropbox_import_oauth_states (
  state_hash TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  pkce_ciphertext TEXT NOT NULL,
  pkce_iv TEXT NOT NULL,
  key_id TEXT NOT NULL DEFAULT 'v1',
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (staff_id) REFERENCES staff_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dropbox_import_oauth_expiry
  ON dropbox_import_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS dropbox_import_jobs (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '',
  destination_prefix TEXT NOT NULL,
  conflict_mode TEXT NOT NULL DEFAULT 'autorename' CHECK (conflict_mode IN ('autorename','skip','replace','fail')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','cancelling','completed','partial','failed','cancelled','expired')),
  file_count INTEGER NOT NULL DEFAULT 0,
  processed_files INTEGER NOT NULL DEFAULT 0,
  succeeded_files INTEGER NOT NULL DEFAULT 0,
  failed_files INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  processed_bytes INTEGER NOT NULL DEFAULT 0,
  cancel_requested_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (staff_id) REFERENCES staff_users(id) ON DELETE CASCADE,
  FOREIGN KEY (authorization_id) REFERENCES dropbox_import_authorizations(id)
);

CREATE INDEX IF NOT EXISTS idx_dropbox_import_jobs_staff
  ON dropbox_import_jobs(staff_id,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dropbox_import_jobs_status
  ON dropbox_import_jobs(status,expires_at);

CREATE TABLE IF NOT EXISTS dropbox_import_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  dropbox_path TEXT NOT NULL,
  dropbox_id TEXT,
  destination_key TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('queued','running','retrying','completed','failed','cancelled','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  uploaded_bytes INTEGER NOT NULL DEFAULT 0,
  r2_etag TEXT,
  error_code TEXT,
  error_message TEXT,
  retry_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE(job_id,ordinal),
  UNIQUE(job_id,dropbox_path),
  FOREIGN KEY (job_id) REFERENCES dropbox_import_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dropbox_import_items_job_status
  ON dropbox_import_items(job_id,status,ordinal);