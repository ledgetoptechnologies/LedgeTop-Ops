PRAGMA foreign_keys = ON;

-- Staff recovery may retry an existing invitation delivery. It cannot create
-- Project Alpha authority, identity bindings, memberships, or content grants.
CREATE TABLE IF NOT EXISTS portal_v2_operations_management_mutations (
  actor_staff_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action='invitation.retry'),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint)=64),
  workspace_id TEXT NOT NULL,
  principal_public_id TEXT NOT NULL,
  invitation_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('queued','already_queued','not_repairable')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (actor_staff_id,idempotency_key),
  FOREIGN KEY (workspace_id,principal_public_id) REFERENCES pa_portal_principals(workspace_id,public_id),
  FOREIGN KEY (invitation_id,workspace_id) REFERENCES portal_v2_invitations(id,workspace_id)
);
CREATE TABLE IF NOT EXISTS portal_v2_operations_management_audit (
  id TEXT PRIMARY KEY,
  actor_staff_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('invitation.retry.queued','invitation.retry.rejected')),
  workspace_id TEXT NOT NULL,
  principal_public_id TEXT NOT NULL,
  invitation_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workspace_id,principal_public_id) REFERENCES pa_portal_principals(workspace_id,public_id),
  FOREIGN KEY (invitation_id,workspace_id) REFERENCES portal_v2_invitations(id,workspace_id)
);
CREATE TRIGGER IF NOT EXISTS portal_v2_operations_management_mutations_immutable_update
BEFORE UPDATE ON portal_v2_operations_management_mutations BEGIN SELECT RAISE(ABORT,'portal operations mutation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS portal_v2_operations_management_mutations_immutable_delete
BEFORE DELETE ON portal_v2_operations_management_mutations BEGIN SELECT RAISE(ABORT,'portal operations mutation is immutable'); END;
CREATE TRIGGER IF NOT EXISTS portal_v2_operations_management_audit_immutable_update
BEFORE UPDATE ON portal_v2_operations_management_audit BEGIN SELECT RAISE(ABORT,'portal operations audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS portal_v2_operations_management_audit_immutable_delete
BEFORE DELETE ON portal_v2_operations_management_audit BEGIN SELECT RAISE(ABORT,'portal operations audit is immutable'); END;
