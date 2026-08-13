PRAGMA foreign_keys = ON;

-- Client-managed workspace invitations remain unreachable while the shared
-- CLIENT_PORTAL_HIERARCHY_V2_ENABLED flag is false. Invitation secrets are
-- retained only in the delivery outbox until a mail adapter acknowledges them;
-- the authorization table stores only their SHA-256 hash.
CREATE TABLE IF NOT EXISTS portal_v2_invitation_commands (
  workspace_id TEXT NOT NULL,
  actor_identity_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash)=43),
  invitation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id,actor_identity_id,idempotency_key),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_identity_id) REFERENCES portal_v2_identities(id),
  FOREIGN KEY (invitation_id,workspace_id)
    REFERENCES portal_v2_invitations(id,workspace_id)
);

CREATE TABLE IF NOT EXISTS portal_v2_invitation_rate_limits (
  workspace_id TEXT NOT NULL,
  actor_identity_id TEXT NOT NULL,
  window_started_at TEXT NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count BETWEEN 0 AND 10),
  PRIMARY KEY (workspace_id,actor_identity_id),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_identity_id) REFERENCES portal_v2_identities(id)
);

CREATE TABLE IF NOT EXISTS portal_v2_invitation_email_outbox (
  id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL UNIQUE,
  recipient_email TEXT NOT NULL COLLATE NOCASE,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  lease_expires_at TEXT,
  sent_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (invitation_id) REFERENCES portal_v2_invitations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portal_v2_invitation_email_ready
  ON portal_v2_invitation_email_outbox(status,next_attempt_at,lease_expires_at,created_at);

CREATE TABLE IF NOT EXISTS portal_v2_membership_audit (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_identity_id TEXT,
  action TEXT NOT NULL CHECK (action IN (
    'invitation.created','invitation.revoked','invitation.accepted',
    'membership.suspended','membership.reactivated','manager.transferred'
  )),
  subject_identity_id TEXT,
  invitation_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_identity_id) REFERENCES portal_v2_identities(id),
  FOREIGN KEY (subject_identity_id) REFERENCES portal_v2_identities(id),
  FOREIGN KEY (invitation_id,workspace_id)
    REFERENCES portal_v2_invitations(id,workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_portal_v2_membership_audit_workspace
  ON portal_v2_membership_audit(workspace_id,created_at DESC,id DESC);
