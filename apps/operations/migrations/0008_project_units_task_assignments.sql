ALTER TABLE pa_projects ADD COLUMN business_unit_id TEXT;
CREATE INDEX idx_pa_projects_business_unit ON pa_projects(business_unit_id,active);

CREATE TABLE pa_task_assignments (
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  assigned_by_user_id TEXT,
  assigned_at TEXT,
  payload_json TEXT NOT NULL,
  last_sync_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (task_id,user_id)
);
CREATE INDEX idx_pa_task_assignments_user ON pa_task_assignments(user_id,active,task_id);

INSERT OR IGNORE INTO pa_task_assignments (task_id,user_id,assigned_at,payload_json,last_sync_id,active)
SELECT id,assignee_user_id,updated_at,json_object('legacy_assignee_user_id',assignee_user_id),last_sync_id,active
FROM pa_tasks WHERE assignee_user_id IS NOT NULL AND assignee_user_id<>'';

CREATE TABLE pa_projection_entity_versions (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  event_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity_type,entity_id)
);

-- Migration 0007 predates the task_assignments snapshot collection. Rebuild
-- the constrained fingerprint table so reconciliation can persist that
-- collection without violating the CHECK constraint.
ALTER TABLE pa_projection_fingerprints RENAME TO pa_projection_fingerprints_legacy;

CREATE TABLE pa_projection_fingerprints (
  collection TEXT PRIMARY KEY CHECK (collection IN (
    'users','business_units','worker_business_units','clients','organizations',
    'projects','project_assignments','service_locations','application_entitlements',
    'operations','operation_assignments','tasks','task_assignments','calendar_events'
  )),
  fingerprint TEXT NOT NULL,
  last_sync_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO pa_projection_fingerprints (collection,fingerprint,last_sync_id,updated_at)
SELECT collection,fingerprint,last_sync_id,updated_at
FROM pa_projection_fingerprints_legacy;

DROP TABLE pa_projection_fingerprints_legacy;
