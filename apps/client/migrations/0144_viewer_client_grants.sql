PRAGMA foreign_keys = ON;

-- Authenticated Client Portal access is distinct from tokenized public shares.
-- A project grant may follow future ready associations; a task grant pins one
-- association. Portal project membership and v2 entitlements remain mandatory.
CREATE TABLE IF NOT EXISTS viewer_client_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('project','task')),
  association_id TEXT,
  include_future_published INTEGER NOT NULL DEFAULT 1 CHECK (include_future_published IN (0,1)),
  can_measure INTEGER NOT NULL DEFAULT 1 CHECK (can_measure IN (0,1)),
  can_view_cameras INTEGER NOT NULL DEFAULT 1 CHECK (can_view_cameras IN (0,1)),
  can_download INTEGER NOT NULL DEFAULT 0 CHECK (can_download IN (0,1)),
  authorization_expires_at TEXT,
  grant_version INTEGER NOT NULL DEFAULT 1 CHECK (grant_version >= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by_staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  revoked_by_staff_id TEXT,
  revoke_reason TEXT,
  CHECK ((scope_type='project' AND association_id IS NULL) OR
         (scope_type='task' AND association_id IS NOT NULL AND include_future_published=0)),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  FOREIGN KEY (association_id) REFERENCES viewer_model_associations(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_viewer_client_grants_unique_live
  ON viewer_client_grants(account_id,project_id,scope_type,COALESCE(association_id,''))
  WHERE status='active' AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_viewer_client_grants_authorize
  ON viewer_client_grants(account_id,project_id,status,authorization_expires_at,association_id);

CREATE TABLE IF NOT EXISTS viewer_client_grant_mutation_receipts (
  actor_staff_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('grant.create','grant.revoke')),
  request_fingerprint TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (actor_staff_id,idempotency_key),
  FOREIGN KEY (grant_id) REFERENCES viewer_client_grants(id) ON DELETE RESTRICT
);
