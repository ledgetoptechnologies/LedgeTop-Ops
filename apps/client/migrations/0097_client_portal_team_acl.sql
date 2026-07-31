PRAGMA foreign_keys = ON;

-- Explicit portal roles are deliberately separate from an identity link. An
-- identity is not an account member merely because it has authenticated.
CREATE TABLE IF NOT EXISTS client_account_members (
  account_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manager','member')),
  can_view_billing INTEGER NOT NULL DEFAULT 0 CHECK (can_view_billing IN (0,1)),
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, identity_id),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (identity_id, account_id) REFERENCES client_identity_links(id, account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_client_account_members_active
  ON client_account_members(account_id, revoked_at, role);

-- A manager may create a pending non-manager invitation, but it never grants
-- access until a provider-verified identity is bound by a future acceptance
-- flow. This keeps the Cloudflare/IdP provisioning seam asynchronous.
CREATE TABLE IF NOT EXISTS client_account_invitations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(email)) BETWEEN 3 AND 320),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role='member'),
  project_ids_json TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  accepted_at TEXT,
  invited_by_identity_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by_identity_id, account_id) REFERENCES client_identity_links(id, account_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_client_account_invitation_active_email
  ON client_account_invitations(account_id, email)
  WHERE revoked_at IS NULL AND accepted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_client_account_invitations_active
  ON client_account_invitations(account_id, revoked_at, accepted_at, expires_at);

-- Project grants for a member can only narrow the account's active project
-- grants. The repository rechecks the account grant on every read/write.
CREATE TABLE IF NOT EXISTS client_member_project_grants (
  account_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  granted_by_identity_id TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, identity_id, project_id),
  FOREIGN KEY (account_id, identity_id) REFERENCES client_account_members(account_id, identity_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, project_id) REFERENCES client_project_grants(account_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (granted_by_identity_id, account_id) REFERENCES client_identity_links(id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_client_member_project_grants_active
  ON client_member_project_grants(account_id, identity_id, revoked_at, project_id);

-- The delivery-side worker records desired Access-group changes but deliberately
-- never calls Cloudflare's management API from a client-facing request.
CREATE TABLE IF NOT EXISTS client_access_sync_outbox (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  action TEXT NOT NULL CHECK (action IN ('provision','revoke')),
  source_type TEXT NOT NULL CHECK (source_type IN ('invite','membership')),
  source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (action, source_type, source_id, status)
);

CREATE INDEX IF NOT EXISTS idx_client_access_sync_outbox_pending
  ON client_access_sync_outbox(status, next_attempt_at, created_at);
