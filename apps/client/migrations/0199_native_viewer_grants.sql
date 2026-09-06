PRAGMA foreign_keys = ON;

-- Native portal Viewer access is independent of legacy account grants. Every
-- row is bound to one immutable Project Alpha source, native workspace and
-- projected project. The live authorization query still rechecks the current
-- directory generation, person membership, entitlements and identity denies.
CREATE TABLE viewer_native_client_grants (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL CHECK (
    substr(source_id,1,14)='project-alpha:' AND length(source_id) BETWEEN 15 AND 78
    AND substr(source_id,15,1) GLOB '[a-z0-9]'
    AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*' AND instr(source_id,char(0))=0),
  workspace_id TEXT NOT NULL,
  project_public_id TEXT NOT NULL CHECK (length(project_public_id) BETWEEN 1 AND 256),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('project','task')),
  association_id TEXT,
  include_future_published INTEGER NOT NULL DEFAULT 0 CHECK (include_future_published IN (0,1)),
  can_measure INTEGER NOT NULL DEFAULT 1 CHECK (can_measure IN (0,1)),
  can_view_cameras INTEGER NOT NULL DEFAULT 1 CHECK (can_view_cameras IN (0,1)),
  can_download INTEGER NOT NULL DEFAULT 0 CHECK (can_download IN (0,1)),
  authorization_expires_at TEXT,
  grant_version INTEGER NOT NULL DEFAULT 1 CHECK (grant_version>=1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by_staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  revoked_by_staff_id TEXT,
  revoke_reason TEXT,
  CHECK ((scope_type='project' AND association_id IS NULL AND include_future_published=1)
    OR (scope_type='task' AND association_id IS NOT NULL AND include_future_published=0)),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (association_id) REFERENCES viewer_model_associations(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_viewer_native_grants_unique_live
  ON viewer_native_client_grants(source_id,workspace_id,project_public_id,scope_type,COALESCE(association_id,''))
  WHERE status='active' AND revoked_at IS NULL;
CREATE INDEX idx_viewer_native_grants_authorize
  ON viewer_native_client_grants(source_id,workspace_id,project_public_id,status,authorization_expires_at,association_id);

CREATE TRIGGER viewer_native_grant_owner_insert BEFORE INSERT ON viewer_native_client_grants
WHEN NOT EXISTS (SELECT 1 FROM portal_v2_workspaces workspace
  WHERE workspace.id=NEW.workspace_id AND workspace.project_alpha_source_id=NEW.source_id
    AND workspace.legacy_account_id IS NULL AND workspace.status='active')
OR (NEW.association_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM viewer_model_associations association JOIN projects project ON project.id=association.project_id
  WHERE association.id=NEW.association_id AND project.project_alpha_source_id=NEW.source_id
    AND project.project_alpha_project_id=NEW.project_public_id))
BEGIN SELECT RAISE(ABORT,'native Viewer grant authority is invalid'); END;

CREATE TRIGGER viewer_native_grant_owner_update BEFORE UPDATE OF
  source_id,workspace_id,project_public_id,scope_type,association_id,status,revoked_at
  ON viewer_native_client_grants
WHEN NEW.source_id IS NOT OLD.source_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.project_public_id IS NOT OLD.project_public_id OR NEW.scope_type IS NOT OLD.scope_type
  OR NEW.association_id IS NOT OLD.association_id
  OR (OLD.status='revoked' AND NEW.status<>'revoked')
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL)
  OR (NEW.status='active' AND NEW.revoked_at IS NULL AND NOT EXISTS (
    SELECT 1 FROM portal_v2_workspaces workspace
    WHERE workspace.id=NEW.workspace_id AND workspace.project_alpha_source_id=NEW.source_id
      AND workspace.legacy_account_id IS NULL AND workspace.status='active'))
BEGIN SELECT RAISE(ABORT,'native Viewer grant authority is immutable or unavailable'); END;

CREATE TABLE viewer_native_client_grant_mutation_receipts (
  actor_staff_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('grant.create','grant.revoke')),
  request_fingerprint TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (actor_staff_id,idempotency_key),
  FOREIGN KEY (grant_id) REFERENCES viewer_native_client_grants(id) ON DELETE RESTRICT
);

CREATE TABLE viewer_native_client_grant_audit (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('grant.created','grant.revoked')),
  actor_staff_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (grant_id) REFERENCES viewer_native_client_grants(id) ON DELETE RESTRICT
);
CREATE INDEX idx_viewer_native_grant_audit ON viewer_native_client_grant_audit(grant_id,created_at,id);
