PRAGMA foreign_keys = ON;

-- Operations-owned emergency/business access overlay. Project Alpha remains
-- authoritative for the projected workspace and memberships, but cannot
-- reactivate a root that Operations has explicitly revoked.
CREATE TABLE portal_v2_root_access_policies (
  projection_source_id TEXT NOT NULL,
  root_type TEXT NOT NULL CHECK (root_type IN ('organization','standalone_client')),
  root_public_id TEXT NOT NULL CHECK (length(root_public_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('active','revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  last_operation_id TEXT,
  created_by_staff_id TEXT NOT NULL,
  updated_by_staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (projection_source_id,root_type,root_public_id)
);

CREATE TABLE portal_v2_root_access_policy_mutations (
  actor_staff_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('root.revoke','root.restore')),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint)=64),
  projection_source_id TEXT NOT NULL,
  root_type TEXT NOT NULL,
  root_public_id TEXT NOT NULL,
  result_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (actor_staff_id,idempotency_key),
  FOREIGN KEY (projection_source_id,root_type,root_public_id)
    REFERENCES portal_v2_root_access_policies(projection_source_id,root_type,root_public_id) ON DELETE RESTRICT
);

CREATE TABLE portal_v2_root_access_policy_lock (
  id INTEGER PRIMARY KEY CHECK (id=1),
  version INTEGER NOT NULL DEFAULT 0,
  operation_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO portal_v2_root_access_policy_lock(id) VALUES(1);

CREATE TABLE portal_v2_root_access_policy_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  projection_source_id TEXT NOT NULL,
  root_type TEXT NOT NULL,
  root_public_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('root.revoked','root.restored')),
  version INTEGER NOT NULL,
  reason_code TEXT NOT NULL,
  actor_staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (projection_source_id,root_type,root_public_id)
    REFERENCES portal_v2_root_access_policies(projection_source_id,root_type,root_public_id) ON DELETE RESTRICT
);

CREATE INDEX idx_portal_v2_root_access_policy_audit_root
  ON portal_v2_root_access_policy_audit(projection_source_id,root_type,root_public_id,id DESC);

CREATE TRIGGER portal_v2_root_access_policy_prevent_delete
BEFORE DELETE ON portal_v2_root_access_policies
BEGIN SELECT RAISE(ABORT,'portal root access policy cannot be deleted'); END;

CREATE TRIGGER portal_v2_root_access_policy_audit_prevent_update
BEFORE UPDATE ON portal_v2_root_access_policy_audit
BEGIN SELECT RAISE(ABORT,'portal root access policy audit is immutable'); END;

CREATE TRIGGER portal_v2_root_access_policy_audit_prevent_delete
BEFORE DELETE ON portal_v2_root_access_policy_audit
BEGIN SELECT RAISE(ABORT,'portal root access policy audit is immutable'); END;
