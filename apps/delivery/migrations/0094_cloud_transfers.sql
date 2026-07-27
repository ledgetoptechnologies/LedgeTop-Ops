PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cloud_oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('dropbox','google')),
  share_id TEXT NOT NULL,
  share_version INTEGER NOT NULL,
  selection_json TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  conflict_mode TEXT NOT NULL DEFAULT 'autorename' CHECK (conflict_mode IN ('autorename','skip')),
  pkce_ciphertext TEXT NOT NULL,
  pkce_iv TEXT NOT NULL,
  key_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_oauth_states_expiry
  ON cloud_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS cloud_transfer_authorizations (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  share_version INTEGER NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('dropbox','google')),
  credential_ciphertext TEXT NOT NULL,
  credential_iv TEXT NOT NULL,
  key_id TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '',
  token_expires_at TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_transfer_authorizations_expiry
  ON cloud_transfer_authorizations(expires_at,revoked_at);

CREATE TABLE IF NOT EXISTS cloud_transfer_jobs (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  share_version INTEGER NOT NULL,
  authorization_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('dropbox','google')),
  selection_json TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  conflict_mode TEXT NOT NULL DEFAULT 'autorename' CHECK (conflict_mode IN ('autorename','skip')),
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
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE,
  FOREIGN KEY (authorization_id) REFERENCES cloud_transfer_authorizations(id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_transfer_jobs_share
  ON cloud_transfer_jobs(share_id,share_version,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cloud_transfer_jobs_expiry
  ON cloud_transfer_jobs(expires_at,status);

CREATE TABLE IF NOT EXISTS cloud_transfer_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  source_key TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  source_etag TEXT NOT NULL,
  source_size INTEGER NOT NULL,
  destination_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','retrying','completed','failed','cancelled','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  uploaded_bytes INTEGER NOT NULL DEFAULT 0,
  provider_file_id TEXT,
  provider_job_id TEXT,
  upload_state_ciphertext TEXT,
  upload_state_iv TEXT,
  source_grant_hash TEXT,
  source_grant_ciphertext TEXT,
  source_grant_iv TEXT,
  source_grant_expires_at TEXT,
  error_code TEXT,
  error_message TEXT,
  retry_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE(job_id,ordinal),
  UNIQUE(job_id,source_key),
  FOREIGN KEY (job_id) REFERENCES cloud_transfer_jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cloud_transfer_items_job_status
  ON cloud_transfer_items(job_id,status,ordinal);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_transfer_items_grant
  ON cloud_transfer_items(source_grant_hash)
  WHERE source_grant_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS cloud_transfer_quota (
  share_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  created_count INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (share_id,window_start),
  FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE
);
