PRAGMA foreign_keys = ON;

-- Client portal records are additive to the existing delivery model. No rows are
-- seeded, so applying this migration grants no access by itself.
CREATE TABLE IF NOT EXISTS client_accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('disabled','active','suspended','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_client_accounts_status
  ON client_accounts(status, display_name COLLATE NOCASE);

-- issuer + subject is the sole external identity key. Email is metadata only;
-- it is never used to infer account, project, or delivery authorization.
CREATE TABLE IF NOT EXISTS client_identity_links (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  issuer TEXT NOT NULL CHECK (length(trim(issuer)) BETWEEN 1 AND 512),
  subject TEXT NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 512),
  email TEXT COLLATE NOCASE,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  UNIQUE (issuer, subject),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_client_identity_account
  ON client_identity_links(account_id, revoked_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_client_identity_account_key
  ON client_identity_links(id, account_id);

CREATE TABLE IF NOT EXISTS client_project_grants (
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  can_request_service INTEGER NOT NULL DEFAULT 0 CHECK (can_request_service IN (0, 1)),
  granted_by TEXT,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  PRIMARY KEY (account_id, project_id),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by) REFERENCES staff_users(id)
);

CREATE INDEX IF NOT EXISTS idx_client_project_grants_project
  ON client_project_grants(project_id, revoked_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shares_portal_grant_key
  ON shares(id, project_id, share_version);

-- A delivery grant remains bound to the public share version that staff
-- approved. Rotating a share invalidates stale portal grants without changing
-- the existing public-share contract.
CREATE TABLE IF NOT EXISTS client_delivery_grants (
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  share_id TEXT NOT NULL,
  share_version INTEGER NOT NULL CHECK (share_version >= 1),
  granted_by TEXT,
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (account_id, share_id),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, project_id) REFERENCES client_project_grants(account_id, project_id),
  FOREIGN KEY (share_id, project_id, share_version) REFERENCES shares(id, project_id, share_version),
  FOREIGN KEY (granted_by) REFERENCES staff_users(id)
);

CREATE INDEX IF NOT EXISTS idx_client_delivery_grants_project
  ON client_delivery_grants(account_id, project_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_client_delivery_grants_share
  ON client_delivery_grants(share_id, share_version, revoked_at);

CREATE TABLE IF NOT EXISTS client_service_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_by_identity_id TEXT NOT NULL,
  request_type TEXT NOT NULL CHECK (request_type IN ('flight','service')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  details TEXT NOT NULL CHECK (length(trim(details)) BETWEEN 1 AND 5000),
  location_text TEXT CHECK (location_text IS NULL OR length(trim(location_text)) BETWEEN 1 AND 240),
  preferred_start_at TEXT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 43),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','under_review','accepted','declined','cancelled','completed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, idempotency_key),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id),
  FOREIGN KEY (account_id, project_id) REFERENCES client_project_grants(account_id, project_id),
  FOREIGN KEY (created_by_identity_id, account_id) REFERENCES client_identity_links(id, account_id),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_client_service_requests_account
  ON client_service_requests(account_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_client_service_requests_project
  ON client_service_requests(project_id, status, created_at DESC);
