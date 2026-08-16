PRAGMA foreign_keys = ON;

-- Additive emergency deny policy for verified portal identities. The feature
-- remains inert until CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED=true. Denials
-- are evaluated live on every portal-v2 authorization request so an already
-- issued Cloudflare Access assertion cannot preserve revoked authority.
CREATE TABLE IF NOT EXISTS portal_v2_identity_denials (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  workspace_id TEXT,
  scope_type TEXT NOT NULL CHECK (scope_type IN (
    'global','workspace','organization','standalone_client',
    'department','client','project','folder','contact'
  )),
  scope_public_id TEXT,
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  created_by_actor_type TEXT NOT NULL CHECK (created_by_actor_type IN ('staff','system')),
  created_by_actor_id TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_actor_type TEXT CHECK (revoked_by_actor_type IN ('staff','system')),
  revoked_by_actor_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (identity_id) REFERENCES portal_v2_identities(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE CASCADE,
  CHECK (
    (scope_type='global' AND workspace_id IS NULL AND scope_public_id IS NULL) OR
    (scope_type='workspace' AND workspace_id IS NOT NULL AND scope_public_id=workspace_id) OR
    (scope_type NOT IN ('global','workspace') AND workspace_id IS NOT NULL AND scope_public_id IS NOT NULL)
  ),
  CHECK (datetime(valid_from) IS NOT NULL),
  CHECK (expires_at IS NULL OR (
    datetime(expires_at) IS NOT NULL AND datetime(expires_at)>datetime(valid_from)
  )),
  CHECK (
    (status='active' AND revoked_at IS NULL AND revoked_by_actor_type IS NULL AND revoked_by_actor_id IS NULL) OR
    (status='revoked' AND revoked_at IS NOT NULL AND revoked_by_actor_type IS NOT NULL AND revoked_by_actor_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_portal_v2_identity_denials_effective
  ON portal_v2_identity_denials(identity_id,status,workspace_id,scope_type,scope_public_id,expires_at);

CREATE TABLE IF NOT EXISTS portal_v2_identity_denial_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  denial_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  workspace_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('denial.created','denial.revoked','denial.changed')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('staff','system')),
  actor_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (denial_id) REFERENCES portal_v2_identity_denials(id) ON DELETE CASCADE,
  FOREIGN KEY (identity_id) REFERENCES portal_v2_identities(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portal_v2_identity_denial_audit_identity
  ON portal_v2_identity_denial_audit(identity_id,created_at DESC,id DESC);

CREATE TRIGGER IF NOT EXISTS portal_v2_identity_denial_audit_insert
AFTER INSERT ON portal_v2_identity_denials
BEGIN
  INSERT INTO portal_v2_identity_denial_audit
    (denial_id,identity_id,workspace_id,action,actor_type,actor_id,details_json)
  VALUES (
    NEW.id,NEW.identity_id,NEW.workspace_id,'denial.created',
    NEW.created_by_actor_type,NEW.created_by_actor_id,
    json_object('scopeType',NEW.scope_type,'scopePublicId',NEW.scope_public_id,
      'reasonCode',NEW.reason_code,'validFrom',NEW.valid_from,'expiresAt',NEW.expires_at)
  );
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_identity_denial_audit_update
AFTER UPDATE OF status,valid_from,expires_at,reason_code,revoked_at ON portal_v2_identity_denials
WHEN OLD.status<>NEW.status OR OLD.valid_from<>NEW.valid_from OR
  OLD.expires_at IS NOT NEW.expires_at OR OLD.reason_code<>NEW.reason_code OR
  OLD.revoked_at IS NOT NEW.revoked_at
BEGIN
  INSERT INTO portal_v2_identity_denial_audit
    (denial_id,identity_id,workspace_id,action,actor_type,actor_id,details_json)
  VALUES (
    NEW.id,NEW.identity_id,NEW.workspace_id,
    CASE WHEN NEW.status='revoked' THEN 'denial.revoked' ELSE 'denial.changed' END,
    CASE WHEN NEW.status='revoked' THEN NEW.revoked_by_actor_type ELSE NEW.created_by_actor_type END,
    CASE WHEN NEW.status='revoked' THEN NEW.revoked_by_actor_id ELSE NEW.created_by_actor_id END,
    json_object('scopeType',NEW.scope_type,'scopePublicId',NEW.scope_public_id,
      'reasonCode',NEW.reason_code,'validFrom',NEW.valid_from,'expiresAt',NEW.expires_at)
  );
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_identity_denial_immutable_scope
BEFORE UPDATE ON portal_v2_identity_denials
WHEN OLD.identity_id<>NEW.identity_id OR OLD.workspace_id IS NOT NEW.workspace_id OR
  OLD.scope_type<>NEW.scope_type OR OLD.scope_public_id IS NOT NEW.scope_public_id OR
  OLD.created_by_actor_type<>NEW.created_by_actor_type OR
  OLD.created_by_actor_id<>NEW.created_by_actor_id OR OLD.created_at<>NEW.created_at
BEGIN
  SELECT RAISE(ABORT,'portal identity denial scope and creator are immutable');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_identity_denial_prevent_resurrection
BEFORE UPDATE ON portal_v2_identity_denials
WHEN OLD.status='revoked'
BEGIN
  SELECT RAISE(ABORT,'revoked portal identity denial is immutable');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_identity_denial_prevent_delete
BEFORE DELETE ON portal_v2_identity_denials
BEGIN
  SELECT RAISE(ABORT,'portal identity denial history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_identity_denial_audit_prevent_update
BEFORE UPDATE ON portal_v2_identity_denial_audit
BEGIN
  SELECT RAISE(ABORT,'portal identity denial audit is immutable');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_identity_denial_audit_prevent_delete
BEFORE DELETE ON portal_v2_identity_denial_audit
BEGIN
  SELECT RAISE(ABORT,'portal identity denial audit is immutable');
END;
