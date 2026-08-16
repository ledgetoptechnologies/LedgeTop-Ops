PRAGMA foreign_keys = ON;

-- Durable idempotency for staff-managed emergency identity denials. Denial
-- policy itself remains in 0136 and is never rewritten or reactivated.
CREATE TABLE IF NOT EXISTS portal_v2_identity_denial_mutations (
  actor_staff_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('denial.create','denial.revoke')),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint)=64),
  denial_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (actor_staff_id,idempotency_key),
  FOREIGN KEY (denial_id) REFERENCES portal_v2_identity_denials(id)
);

-- A single optimistic generation serializes last-effective-manager validation
-- with denial creation. Two administrators cannot both validate against the
-- same pre-denial state and concurrently remove one another as the final
-- managers of a scope.
CREATE TABLE IF NOT EXISTS portal_v2_identity_denial_invariant_lock (
  id INTEGER PRIMARY KEY CHECK (id=1),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version>=0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO portal_v2_identity_denial_invariant_lock(id,version)
VALUES (1,0);

CREATE TRIGGER IF NOT EXISTS portal_v2_identity_denial_lock_monotonic
BEFORE UPDATE ON portal_v2_identity_denial_invariant_lock
WHEN OLD.id<>NEW.id OR NEW.version<>OLD.version+1
BEGIN
  SELECT RAISE(ABORT,'portal identity denial invariant lock is monotonic');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_identity_denial_lock_prevent_delete
BEFORE DELETE ON portal_v2_identity_denial_invariant_lock
BEGIN
  SELECT RAISE(ABORT,'portal identity denial invariant lock cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS portal_v2_authenticated_delivery_grants (
  id TEXT PRIMARY KEY,
  logical_grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL CHECK (grant_version>=1),
  workspace_id TEXT NOT NULL,
  folder_binding_id TEXT NOT NULL,
  binding_source_version TEXT NOT NULL,
  audience_type TEXT NOT NULL CHECK (audience_type IN (
    'organization','department','client','project','principal'
  )),
  audience_public_id TEXT NOT NULL,
  audience_source_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
  reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 80),
  expires_at TEXT,
  created_by_staff_id TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_staff_id TEXT,
  revoke_reason_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (logical_grant_id,grant_version),
  UNIQUE (id,workspace_id),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (folder_binding_id,workspace_id)
    REFERENCES portal_v2_folder_bindings(id,workspace_id),
  CHECK (expires_at IS NULL OR datetime(expires_at) IS NOT NULL),
  CHECK (
    (status='active' AND revoked_at IS NULL AND revoked_by_staff_id IS NULL AND revoke_reason_code IS NULL) OR
    (status='revoked' AND revoked_at IS NOT NULL AND revoked_by_staff_id IS NOT NULL AND revoke_reason_code IS NOT NULL) OR
    (status='expired' AND revoked_at IS NULL AND revoked_by_staff_id IS NULL AND revoke_reason_code IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_v2_authenticated_grants_one_active
  ON portal_v2_authenticated_delivery_grants(logical_grant_id)
  WHERE status='active' AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_portal_v2_authenticated_grants_binding
  ON portal_v2_authenticated_delivery_grants(workspace_id,folder_binding_id,status,expires_at);

-- Exact-principal grants snapshot the opaque PA principal and LTDS identity
-- binding. Group grants are evaluated dynamically from current membership,
-- entitlement and hierarchy state and therefore have no recipient rows.
-- Email is display/notification metadata and is deliberately absent from the
-- authority key.
CREATE TABLE IF NOT EXISTS portal_v2_authenticated_delivery_grant_recipients (
  grant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  principal_public_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  principal_source_version TEXT NOT NULL,
  PRIMARY KEY (grant_id,identity_id),
  FOREIGN KEY (grant_id,workspace_id)
    REFERENCES portal_v2_authenticated_delivery_grants(id,workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id,principal_public_id)
    REFERENCES pa_portal_principals(workspace_id,public_id),
  FOREIGN KEY (workspace_id,identity_id)
    REFERENCES portal_v2_workspace_memberships(workspace_id,identity_id)
);

CREATE TABLE IF NOT EXISTS portal_v2_authenticated_delivery_grant_mutations (
  actor_staff_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('grant.create','grant.revoke','grant.restore')),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint)=64),
  grant_id TEXT NOT NULL,
  logical_grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (actor_staff_id,idempotency_key),
  FOREIGN KEY (grant_id) REFERENCES portal_v2_authenticated_delivery_grants(id)
);

CREATE TABLE IF NOT EXISTS portal_v2_authenticated_delivery_grant_audit (
  id TEXT PRIMARY KEY,
  logical_grant_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  grant_version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('grant.created','grant.revoked','grant.restored')),
  actor_staff_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (grant_id,workspace_id)
    REFERENCES portal_v2_authenticated_delivery_grants(id,workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_portal_v2_authenticated_grant_audit_scope
  ON portal_v2_authenticated_delivery_grant_audit(workspace_id,created_at DESC,id DESC);

CREATE TRIGGER IF NOT EXISTS portal_v2_identity_denial_mutation_immutable_update
BEFORE UPDATE ON portal_v2_identity_denial_mutations
BEGIN
  SELECT RAISE(ABORT,'portal identity denial mutation is immutable');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_identity_denial_mutation_immutable_delete
BEFORE DELETE ON portal_v2_identity_denial_mutations
BEGIN
  SELECT RAISE(ABORT,'portal identity denial mutation is immutable');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_authenticated_grant_immutable_authority
BEFORE UPDATE ON portal_v2_authenticated_delivery_grants
WHEN OLD.logical_grant_id<>NEW.logical_grant_id OR OLD.grant_version<>NEW.grant_version OR
  OLD.workspace_id<>NEW.workspace_id OR OLD.folder_binding_id<>NEW.folder_binding_id OR
  OLD.binding_source_version<>NEW.binding_source_version OR OLD.audience_type<>NEW.audience_type OR
  OLD.audience_public_id<>NEW.audience_public_id OR
  OLD.audience_source_version<>NEW.audience_source_version OR
  OLD.reason_code<>NEW.reason_code OR OLD.expires_at IS NOT NEW.expires_at OR
  OLD.created_by_staff_id<>NEW.created_by_staff_id OR OLD.created_at<>NEW.created_at
BEGIN
  SELECT RAISE(ABORT,'authenticated delivery grant authority is immutable');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_authenticated_grant_prevent_resurrection
BEFORE UPDATE ON portal_v2_authenticated_delivery_grants
WHEN OLD.status<>'active'
BEGIN
  SELECT RAISE(ABORT,'terminal authenticated delivery grant is immutable');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_authenticated_grant_prevent_delete
BEFORE DELETE ON portal_v2_authenticated_delivery_grants
BEGIN
  SELECT RAISE(ABORT,'authenticated delivery grant history cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_authenticated_grant_recipient_immutable_update
BEFORE UPDATE ON portal_v2_authenticated_delivery_grant_recipients
BEGIN
  SELECT RAISE(ABORT,'authenticated delivery grant recipient is immutable');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_authenticated_grant_recipient_immutable_delete
BEFORE DELETE ON portal_v2_authenticated_delivery_grant_recipients
BEGIN
  SELECT RAISE(ABORT,'authenticated delivery grant recipient is immutable');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_authenticated_grant_audit_immutable_update
BEFORE UPDATE ON portal_v2_authenticated_delivery_grant_audit
BEGIN
  SELECT RAISE(ABORT,'authenticated delivery grant audit is immutable');
END;

CREATE TRIGGER IF NOT EXISTS portal_v2_authenticated_grant_audit_immutable_delete
BEFORE DELETE ON portal_v2_authenticated_delivery_grant_audit
BEGIN
  SELECT RAISE(ABORT,'authenticated delivery grant audit is immutable');
END;
