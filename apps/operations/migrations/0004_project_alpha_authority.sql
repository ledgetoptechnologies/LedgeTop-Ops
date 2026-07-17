PRAGMA foreign_keys = ON;

ALTER TABLE staff_users ADD COLUMN provisioning_source TEXT NOT NULL DEFAULT 'local' CHECK (provisioning_source IN ('local','project-alpha'));
ALTER TABLE staff_users ADD COLUMN sync_protected INTEGER NOT NULL DEFAULT 0 CHECK (sync_protected IN (0,1));

UPDATE staff_users
SET sync_protected=1
WHERE id IN (
  SELECT staff_id FROM staff_role_assignments
  WHERE role_id='role-owner' AND scope='global'
);

CREATE TABLE pa_application_entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  application_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  role_key TEXT NOT NULL CHECK (role_key IN ('role-operator','role-delivery-coordinator','role-division-manager')),
  business_unit_ids_json TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL,
  last_event_at TEXT,
  last_sync_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pa_entitlements_enabled ON pa_application_entitlements(enabled,active,user_id);

CREATE TABLE pa_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  business_unit_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','scheduled','in_progress','completed','cancelled')),
  scheduled_start_at TEXT,
  scheduled_end_at TEXT,
  location TEXT,
  notes TEXT,
  created_by_user_id TEXT,
  payload_json TEXT NOT NULL,
  last_sync_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pa_operations_scope ON pa_operations(business_unit_id,active,status,scheduled_start_at);
CREATE INDEX idx_pa_operations_project ON pa_operations(project_id,active);

CREATE TABLE pa_operation_assignments (
  operation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  assignment_role TEXT,
  assigned_by_user_id TEXT,
  assigned_at TEXT,
  payload_json TEXT NOT NULL,
  last_sync_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY (operation_id,user_id)
);

CREATE INDEX idx_pa_operation_assignments_user ON pa_operation_assignments(user_id,active,operation_id);

CREATE TABLE pa_operation_airspace_matches (
  operation_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('tfr','sua')),
  source_id TEXT NOT NULL,
  match_type TEXT NOT NULL CHECK (match_type IN ('intersects','nearby')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (operation_id,source_type,source_id),
  FOREIGN KEY (operation_id) REFERENCES pa_operations(id) ON DELETE CASCADE
);

CREATE TABLE pa_tasks (
  id TEXT PRIMARY KEY,
  operation_id TEXT,
  project_id TEXT NOT NULL,
  business_unit_id TEXT,
  assignee_user_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('todo','in_progress','blocked','completed','cancelled')),
  due_at TEXT,
  notes TEXT,
  created_by_user_id TEXT,
  payload_json TEXT NOT NULL,
  last_sync_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pa_tasks_scope ON pa_tasks(business_unit_id,active,status,due_at);
CREATE INDEX idx_pa_tasks_assignee ON pa_tasks(assignee_user_id,active,status,due_at);

CREATE TABLE pa_calendar_events (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('operation','task','contract','invoice')),
  source_id TEXT NOT NULL,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT,
  all_day INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0,1)),
  project_id TEXT,
  business_unit_id TEXT,
  payload_json TEXT NOT NULL,
  last_sync_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pa_calendar_scope ON pa_calendar_events(business_unit_id,active,start_at);

CREATE TABLE integration_event_receipts (
  event_id TEXT PRIMARY KEY,
  integration TEXT NOT NULL,
  event_type TEXT NOT NULL,
  user_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed','ignored')),
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  last_error TEXT
);

CREATE INDEX idx_integration_event_user_time ON integration_event_receipts(integration,user_id,occurred_at DESC);

CREATE TABLE integration_reconciliation (
  integration TEXT PRIMARY KEY,
  last_event_at TEXT,
  last_access_attempt_at TEXT,
  last_access_success_at TEXT,
  last_access_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO integration_reconciliation (integration) VALUES ('project-alpha')
ON CONFLICT(integration) DO NOTHING;
