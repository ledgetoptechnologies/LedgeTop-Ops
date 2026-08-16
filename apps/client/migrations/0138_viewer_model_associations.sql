PRAGMA foreign_keys = ON;

-- LTDS owns authorization and project association only. Canonical model IDs,
-- versions, rendering metadata, assets and Viewer sessions remain Viewer-owned.
CREATE TABLE IF NOT EXISTS viewer_model_associations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  project_alpha_project_id TEXT NOT NULL,
  project_source_version TEXT NOT NULL,
  viewer_model_id TEXT NOT NULL,
  viewer_model_version_id TEXT NOT NULL,
  viewer_resource_version TEXT NOT NULL,
  model_title TEXT NOT NULL CHECK (length(trim(model_title)) BETWEEN 1 AND 240),
  model_provider TEXT NOT NULL CHECK (length(trim(model_provider)) BETWEEN 1 AND 80),
  model_status TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked','source_stale')),
  association_version INTEGER NOT NULL DEFAULT 1 CHECK (association_version >= 1),
  created_by_staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  revoked_by_staff_id TEXT,
  revoke_reason TEXT,
  UNIQUE (project_id, viewer_model_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_viewer_associations_project_live
  ON viewer_model_associations(project_id,state,viewer_model_id);
CREATE INDEX IF NOT EXISTS idx_viewer_associations_model_live
  ON viewer_model_associations(viewer_model_id,state,project_id);

-- Staff association mutations are replay-safe. The mutation and this receipt
-- are committed in one D1 batch, so a concurrent same-key retry cannot bump an
-- association version a second time.
CREATE TABLE IF NOT EXISTS viewer_association_mutation_receipts (
  actor_staff_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('association.create','association.revoke')),
  request_fingerprint TEXT NOT NULL,
  association_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (actor_staff_id,idempotency_key),
  FOREIGN KEY (association_id) REFERENCES viewer_model_associations(id) ON DELETE RESTRICT
);

-- A session request is a mutation at the Viewer. Cache its one-time grant for
-- safe same-key retries and reject same-key/different-request conflicts.
CREATE TABLE IF NOT EXISTS viewer_session_issuance_receipts (
  actor_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('ops','client')),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  response_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (actor_id,audience,idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_viewer_session_receipts_expiry
  ON viewer_session_issuance_receipts(expires_at);
