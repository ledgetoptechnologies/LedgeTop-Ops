PRAGMA foreign_keys = ON;

-- Client-appointed administrators are local overlays on an existing active
-- workspace member. They never create identities or memberships and never
-- replace Project Alpha-owned authority.
CREATE TABLE portal_workspace_peer_admin_commands (
  workspace_id TEXT NOT NULL,
  actor_identity_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=43),
  target_identity_id TEXT NOT NULL,
  desired_manager INTEGER NOT NULL CHECK(desired_manager IN (0,1)),
  result_version INTEGER NOT NULL CHECK(result_version>=1),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(workspace_id,actor_identity_id,idempotency_key),
  FOREIGN KEY(workspace_id,target_identity_id)
    REFERENCES portal_v2_workspace_memberships(workspace_id,identity_id),
  FOREIGN KEY(actor_identity_id) REFERENCES portal_v2_identities(id)
);

CREATE TABLE portal_workspace_peer_admin_audit (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_identity_id TEXT NOT NULL,
  target_identity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('manager.promoted','manager.demoted')),
  target_version INTEGER NOT NULL CHECK(target_version>=1),
  details_json TEXT NOT NULL DEFAULT('{}') CHECK(json_valid(details_json) AND length(details_json)<=512),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(workspace_id,target_identity_id)
    REFERENCES portal_v2_workspace_memberships(workspace_id,identity_id),
  FOREIGN KEY(actor_identity_id) REFERENCES portal_v2_identities(id)
);
CREATE INDEX idx_portal_peer_admin_audit_workspace
  ON portal_workspace_peer_admin_audit(workspace_id,created_at DESC,id DESC);

-- A failed transaction-time authority or compare-and-swap predicate inserts
-- zero into this guarded table and aborts the whole D1 batch.
CREATE TABLE portal_workspace_peer_admin_fences (
  id TEXT PRIMARY KEY NOT NULL,
  write_guard INTEGER NOT NULL CONSTRAINT portal_peer_admin_write_guard CHECK(write_guard=1),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER portal_peer_admin_command_update BEFORE UPDATE ON portal_workspace_peer_admin_commands
BEGIN SELECT RAISE(ABORT,'peer administrator commands are immutable'); END;
CREATE TRIGGER portal_peer_admin_command_delete BEFORE DELETE ON portal_workspace_peer_admin_commands
BEGIN SELECT RAISE(ABORT,'peer administrator commands are immutable'); END;
CREATE TRIGGER portal_peer_admin_audit_update BEFORE UPDATE ON portal_workspace_peer_admin_audit
BEGIN SELECT RAISE(ABORT,'peer administrator audit is immutable'); END;
CREATE TRIGGER portal_peer_admin_audit_delete BEFORE DELETE ON portal_workspace_peer_admin_audit
BEGIN SELECT RAISE(ABORT,'peer administrator audit is immutable'); END;
CREATE TRIGGER portal_peer_admin_fence_update BEFORE UPDATE ON portal_workspace_peer_admin_fences
BEGIN SELECT RAISE(ABORT,'peer administrator fences are immutable'); END;
CREATE TRIGGER portal_peer_admin_fence_delete BEFORE DELETE ON portal_workspace_peer_admin_fences
BEGIN SELECT RAISE(ABORT,'peer administrator fences are immutable'); END;
