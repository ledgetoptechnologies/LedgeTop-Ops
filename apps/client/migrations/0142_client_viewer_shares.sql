PRAGMA foreign_keys = ON;

-- Operations owns the Viewer service credential and durable source authorization.
-- The client Worker reaches it only through the private ViewerSessionIssuer binding.
CREATE TABLE IF NOT EXISTS client_viewer_source_authorizations (
  id TEXT PRIMARY KEY,
  authorization_version INTEGER NOT NULL DEFAULT 1 CHECK (authorization_version >= 1),
  workspace_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  legacy_account_id TEXT NOT NULL,
  legacy_identity_id TEXT NOT NULL,
  principal_issuer TEXT NOT NULL,
  principal_subject TEXT NOT NULL,
  project_id TEXT NOT NULL,
  association_id TEXT NOT NULL,
  association_version INTEGER NOT NULL CHECK (association_version >= 1),
  viewer_model_id TEXT NOT NULL,
  viewer_model_version_id TEXT NOT NULL,
  authorization_expires_at TEXT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked')),
  share_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  last_denial_reason TEXT,
  last_denial_at TEXT,
  UNIQUE (identity_id,idempotency_key),
  UNIQUE (share_id)
);

CREATE INDEX IF NOT EXISTS idx_client_viewer_source_auth_live
  ON client_viewer_source_authorizations(id,authorization_version,status,share_id);
CREATE INDEX IF NOT EXISTS idx_client_viewer_source_auth_owner
  ON client_viewer_source_authorizations(identity_id,association_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS client_viewer_share_revocation_receipts (
  identity_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  share_id TEXT NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (identity_id,idempotency_key)
);
