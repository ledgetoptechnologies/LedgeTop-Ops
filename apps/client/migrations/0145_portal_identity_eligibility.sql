PRAGMA foreign_keys = ON;

-- Eligibility is intentionally not authorization. These records allow an
-- active PA portal principal to establish its issuer/subject identity on first
-- login. Runtime provisioning adds only the minimum workspace membership and
-- legacy identity bridge required to render an empty portal shell; it creates
-- no entitlement, project grant, delivery grant, or Viewer grant.
CREATE TABLE IF NOT EXISTS portal_v2_identity_eligibility_bindings (
  identity_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  principal_public_id TEXT NOT NULL,
  principal_source_version TEXT NOT NULL,
  verified_email TEXT NOT NULL COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_verified_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (identity_id,workspace_id,principal_public_id),
  FOREIGN KEY (identity_id) REFERENCES portal_v2_identities(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,principal_public_id)
    REFERENCES pa_portal_principals(workspace_id,public_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portal_identity_eligibility_principal
  ON portal_v2_identity_eligibility_bindings(workspace_id,principal_public_id,identity_id);

-- Minimal shell bridge. It permits selecting the correct empty workspace but
-- grants no capability and is never consulted by project/delivery/Viewer SQL.
CREATE TABLE IF NOT EXISTS portal_v2_identity_eligibility_legacy_bridges (
  workspace_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  legacy_account_id TEXT NOT NULL,
  legacy_identity_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  PRIMARY KEY (workspace_id,identity_id),
  UNIQUE (legacy_identity_id),
  FOREIGN KEY (workspace_id,identity_id) REFERENCES portal_v2_workspace_memberships(workspace_id,identity_id) ON DELETE CASCADE,
  FOREIGN KEY (legacy_identity_id,legacy_account_id) REFERENCES client_identity_links(id,account_id) ON DELETE CASCADE
);

-- Pre-provisioning blocks cover identities that do not yet have an identity ID.
-- Either an exact issuer/subject or an exact normalized verified email can be
-- blocked. This is separate from scoped post-provisioning identity denials.
CREATE TABLE IF NOT EXISTS portal_v2_identity_eligibility_blocks (
  id TEXT PRIMARY KEY,
  match_type TEXT NOT NULL CHECK (match_type IN ('issuer_subject','email')),
  issuer TEXT,
  subject TEXT,
  normalized_email TEXT COLLATE NOCASE,
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  created_by_actor_type TEXT NOT NULL CHECK (created_by_actor_type IN ('staff','system')),
  created_by_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  CHECK ((match_type='issuer_subject' AND issuer IS NOT NULL AND subject IS NOT NULL AND normalized_email IS NULL)
    OR (match_type='email' AND issuer IS NULL AND subject IS NULL AND normalized_email IS NOT NULL)),
  CHECK (expires_at IS NULL OR datetime(expires_at)>datetime(valid_from))
);

CREATE INDEX IF NOT EXISTS idx_portal_identity_eligibility_blocks_subject
  ON portal_v2_identity_eligibility_blocks(match_type,issuer,subject,status,expires_at);
CREATE INDEX IF NOT EXISTS idx_portal_identity_eligibility_blocks_email
  ON portal_v2_identity_eligibility_blocks(match_type,normalized_email,status,expires_at);

CREATE TABLE IF NOT EXISTS portal_v2_identity_eligibility_block_mutations (
  actor_staff_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('block.create','block.revoke')),
  request_fingerprint TEXT NOT NULL,
  block_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (actor_staff_id,idempotency_key),
  FOREIGN KEY (block_id) REFERENCES portal_v2_identity_eligibility_blocks(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS portal_v2_identity_eligibility_block_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('block.created','block.revoked')),
  actor_staff_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (block_id) REFERENCES portal_v2_identity_eligibility_blocks(id) ON DELETE RESTRICT
);
