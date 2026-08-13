PRAGMA foreign_keys = ON;

-- Client-created bearer links are deliberately separate from staff-created
-- `shares`. Applying this migration cannot create or enable a public link.
-- Folder targets are provisioned by trusted Operations code and are opaque to
-- the browser; their internal relative prefixes never appear in client APIs.
CREATE TABLE IF NOT EXISTS client_share_folder_targets (
  id TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 16 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  workspace_id TEXT NOT NULL,
  folder_binding_id TEXT NOT NULL,
  binding_source_version TEXT NOT NULL,
  relative_prefix TEXT NOT NULL DEFAULT ''
    CHECK (length(relative_prefix) <= 900),
  staff_exact_root_approved INTEGER NOT NULL DEFAULT 0
    CHECK (staff_exact_root_approved IN (0,1)),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','revoked')),
  revoked_at TEXT,
  created_by_staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (id, workspace_id),
  UNIQUE (id, workspace_id, folder_binding_id),
  UNIQUE (workspace_id, folder_binding_id, relative_prefix),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (folder_binding_id) REFERENCES portal_v2_folder_bindings(id) ON DELETE CASCADE,
  CHECK (relative_prefix<>'' OR staff_exact_root_approved=1)
);

CREATE INDEX IF NOT EXISTS idx_client_share_targets_binding
  ON client_share_folder_targets(workspace_id, folder_binding_id, status);

-- A delegation authorizes one exact identity and one version of its live PA
-- entitlement. Its root is a server-side folder target, never an R2 key.
CREATE TABLE IF NOT EXISTS client_share_delegations (
  id TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 16 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  workspace_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  entitlement_id TEXT NOT NULL,
  entitlement_version INTEGER NOT NULL CHECK (entitlement_version >= 1),
  folder_binding_id TEXT NOT NULL,
  folder_binding_source_version TEXT NOT NULL,
  root_target_id TEXT NOT NULL,
  allow_exact_root INTEGER NOT NULL DEFAULT 0 CHECK (allow_exact_root IN (0,1)),
  maximum_link_lifetime_seconds INTEGER NOT NULL DEFAULT 604800
    CHECK (maximum_link_lifetime_seconds BETWEEN 300 AND 2592000),
  require_password INTEGER NOT NULL DEFAULT 0 CHECK (require_password IN (0,1)),
  policy_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(policy_json)),
  delegation_version INTEGER NOT NULL DEFAULT 1 CHECK (delegation_version >= 1),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','revoked','expired')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_staff_id TEXT,
  created_by_staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (workspace_id, identity_id)
    REFERENCES portal_v2_workspace_memberships(workspace_id, identity_id),
  FOREIGN KEY (entitlement_id, workspace_id, identity_id)
    REFERENCES portal_v2_entitlements(id, workspace_id, identity_id),
  FOREIGN KEY (folder_binding_id, workspace_id)
    REFERENCES portal_v2_folder_bindings(id, workspace_id),
  FOREIGN KEY (root_target_id, workspace_id, folder_binding_id)
    REFERENCES client_share_folder_targets(id, workspace_id, folder_binding_id)
);

CREATE INDEX IF NOT EXISTS idx_client_share_delegations_live
  ON client_share_delegations(workspace_id, identity_id, status, expires_at);

-- Each bearer link has an independent random public ID, fragment secret hash,
-- version, password policy, expiry and revocation state. There is no foreign
-- key to staff `shares`, which prevents namespace or lifecycle confusion.
CREATE TABLE IF NOT EXISTS client_delegated_shares (
  id TEXT PRIMARY KEY
    CHECK (length(id) BETWEEN 16 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
  public_id TEXT NOT NULL UNIQUE
    CHECK (length(public_id) BETWEEN 20 AND 64 AND public_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  workspace_id TEXT NOT NULL,
  delegation_id TEXT NOT NULL,
  -- Immutable provenance only. Runtime authority follows the delegation's
  -- current identity/entitlement, allowing reviewed manager replacement.
  created_by_identity_id TEXT NOT NULL,
  folder_target_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash)=43),
  share_version INTEGER NOT NULL DEFAULT 1 CHECK (share_version >= 1),
  label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 160),
  password_hash TEXT,
  password_salt TEXT,
  password_algorithm TEXT,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending_signer','active','failed','revoked','expired')),
  signer_receipt_id TEXT UNIQUE,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint)=43),
  revoked_at TEXT,
  revoked_by_identity_id TEXT,
  revoked_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (workspace_id, created_by_identity_id, idempotency_key),
  FOREIGN KEY (workspace_id, created_by_identity_id)
    REFERENCES portal_v2_workspace_memberships(workspace_id, identity_id),
  FOREIGN KEY (delegation_id, workspace_id)
    REFERENCES client_share_delegations(id, workspace_id),
  FOREIGN KEY (folder_target_id, workspace_id)
    REFERENCES client_share_folder_targets(id, workspace_id),
  FOREIGN KEY (revoked_by_identity_id) REFERENCES portal_v2_identities(id)
);

CREATE INDEX IF NOT EXISTS idx_client_delegated_shares_creator
  ON client_delegated_shares(workspace_id, created_by_identity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_delegated_shares_live
  ON client_delegated_shares(public_id, share_version, status, expires_at);

CREATE TABLE IF NOT EXISTS client_delegated_share_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  delegation_id TEXT,
  share_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('client','staff','public','system')),
  actor_id TEXT,
  event_type TEXT NOT NULL,
  request_idempotency_key TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (delegation_id) REFERENCES client_share_delegations(id),
  FOREIGN KEY (share_id) REFERENCES client_delegated_shares(id)
);

CREATE INDEX IF NOT EXISTS idx_client_delegated_share_events_scope
  ON client_delegated_share_events(workspace_id, created_at DESC);

-- Durable per-identity rate accounting supplements edge rate limiting. The
-- Worker updates one row per minute and fails closed if its bounded limit is
-- exhausted.
CREATE TABLE IF NOT EXISTS client_delegated_share_rate_windows (
  workspace_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create','list','revoke')),
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, identity_id, action, window_start),
  FOREIGN KEY (workspace_id, identity_id)
    REFERENCES portal_v2_workspace_memberships(workspace_id, identity_id)
);
