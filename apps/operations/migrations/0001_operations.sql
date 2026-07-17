PRAGMA foreign_keys = ON;

CREATE TABLE divisions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  project_alpha_business_unit_id TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE staff_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (email=lower(email)),
  display_name TEXT NOT NULL,
  access_subject TEXT UNIQUE,
  project_alpha_user_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);

CREATE TABLE staff_divisions (
  staff_id TEXT NOT NULL,
  division_id TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (staff_id, division_id),
  FOREIGN KEY (staff_id) REFERENCES staff_users(id),
  FOREIGN KEY (division_id) REFERENCES divisions(id)
);

CREATE TABLE permissions (
  key TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  immutable INTEGER NOT NULL DEFAULT 0 CHECK (immutable IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE role_permissions (
  role_id TEXT NOT NULL,
  permission_key TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_key),
  FOREIGN KEY (role_id) REFERENCES roles(id),
  FOREIGN KEY (permission_key) REFERENCES permissions(key)
);

CREATE TABLE staff_role_assignments (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('global','division','assigned','own')),
  division_id TEXT,
  scope_key TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((scope='division' AND division_id IS NOT NULL AND scope_key=division_id) OR (scope<>'division' AND division_id IS NULL AND scope_key=scope)),
  UNIQUE (staff_id, role_id, scope, scope_key),
  FOREIGN KEY (staff_id) REFERENCES staff_users(id),
  FOREIGN KEY (role_id) REFERENCES roles(id),
  FOREIGN KEY (division_id) REFERENCES divisions(id),
  FOREIGN KEY (created_by) REFERENCES staff_users(id)
);

CREATE TABLE staff_permission_overrides (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  permission_key TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  scope TEXT NOT NULL CHECK (scope IN ('global','division','assigned','own')),
  division_id TEXT,
  scope_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((scope='division' AND division_id IS NOT NULL AND scope_key=division_id) OR (scope<>'division' AND division_id IS NULL AND scope_key=scope)),
  UNIQUE (staff_id, permission_key, effect, scope, scope_key),
  FOREIGN KEY (staff_id) REFERENCES staff_users(id),
  FOREIGN KEY (permission_key) REFERENCES permissions(key),
  FOREIGN KEY (division_id) REFERENCES divisions(id),
  FOREIGN KEY (created_by) REFERENCES staff_users(id)
);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('staff','integration','system')),
  actor_id TEXT,
  actor_email TEXT,
  actor_display_name TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  division_id TEXT,
  details_json TEXT,
  client_address_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (division_id) REFERENCES divisions(id)
);

CREATE INDEX idx_audit_events_created ON audit_events(created_at DESC);
CREATE INDEX idx_audit_events_entity ON audit_events(entity_type,entity_id,created_at DESC);

CREATE TABLE idempotency_keys (
  actor_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  PRIMARY KEY (actor_id, endpoint, idempotency_key)
);

CREATE TABLE integration_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  service_common_name TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  expires_at TEXT,
  revoked_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  FOREIGN KEY (created_by) REFERENCES staff_users(id)
);

CREATE TABLE pa_users (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  role TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  payload_json TEXT NOT NULL,
  last_sync_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE pa_business_units (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  payload_json TEXT NOT NULL,
  last_sync_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE pa_worker_business_units (
  user_id TEXT NOT NULL,
  business_unit_id TEXT NOT NULL,
  is_lead INTEGER NOT NULL DEFAULT 0 CHECK (is_lead IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  payload_json TEXT NOT NULL,
  last_sync_id TEXT NOT NULL,
  PRIMARY KEY (user_id,business_unit_id)
);

CREATE TABLE pa_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  organization_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  payload_json TEXT NOT NULL,
  last_sync_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE pa_organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  payload_json TEXT NOT NULL,
  last_sync_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE pa_projects (
  id TEXT PRIMARY KEY,
  client_id TEXT,
  organization_id TEXT,
  name TEXT NOT NULL,
  status TEXT,
  start_date TEXT,
  end_date TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  payload_json TEXT NOT NULL,
  last_sync_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pa_projects_client ON pa_projects(client_id,active);
CREATE INDEX idx_pa_projects_org ON pa_projects(organization_id,active);

CREATE TABLE pa_project_assignments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  payload_json TEXT NOT NULL,
  last_sync_id TEXT NOT NULL
);

CREATE INDEX idx_pa_project_assignments_project ON pa_project_assignments(project_id,active);
CREATE INDEX idx_pa_project_assignments_user ON pa_project_assignments(user_id,active);

CREATE TABLE pa_service_locations (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  client_id TEXT,
  organization_id TEXT,
  name TEXT,
  latitude REAL,
  longitude REAL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  payload_json TEXT NOT NULL,
  last_sync_id TEXT NOT NULL
);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  division_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','scheduled','ready','blocked','in_progress','completed','cancelled')),
  scheduled_start TEXT,
  scheduled_end TEXT,
  latitude REAL,
  longitude REAL,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (division_id) REFERENCES divisions(id),
  FOREIGN KEY (created_by) REFERENCES staff_users(id)
);

CREATE INDEX idx_operations_division_schedule ON operations(division_id,scheduled_start,status);

CREATE TABLE operation_staff (
  operation_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  PRIMARY KEY (operation_id,staff_id),
  FOREIGN KEY (operation_id) REFERENCES operations(id),
  FOREIGN KEY (staff_id) REFERENCES staff_users(id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  operation_id TEXT,
  project_id TEXT,
  division_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('todo','in_progress','blocked','done')),
  assigned_to TEXT,
  due_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (operation_id) REFERENCES operations(id),
  FOREIGN KEY (division_id) REFERENCES divisions(id),
  FOREIGN KEY (assigned_to) REFERENCES staff_users(id),
  FOREIGN KEY (created_by) REFERENCES staff_users(id)
);

CREATE INDEX idx_tasks_division_status ON tasks(division_id,status,due_at);
CREATE INDEX idx_tasks_assigned ON tasks(assigned_to,status,due_at);

CREATE TABLE folder_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE project_folders (
  project_id TEXT PRIMARY KEY,
  division_id TEXT NOT NULL,
  r2_prefix TEXT NOT NULL UNIQUE,
  match_method TEXT NOT NULL CHECK (match_method IN ('manual','unique_rule','project_alpha')),
  confirmed_by TEXT NOT NULL,
  confirmed_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (division_id) REFERENCES divisions(id),
  FOREIGN KEY (confirmed_by) REFERENCES staff_users(id)
);

CREATE TABLE airspace_source_health (
  source TEXT PRIMARY KEY,
  last_attempt_at TEXT,
  last_success_at TEXT,
  source_modified_at TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('fresh','stale','error','unknown')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tfr_notices (
  id TEXT PRIMARY KEY,
  notam_id TEXT NOT NULL UNIQUE,
  facility TEXT,
  state TEXT,
  type TEXT,
  title TEXT,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('scheduled','active','expired','withdrawn','unknown')),
  issued_at TEXT,
  effective_at TEXT,
  expires_at TEXT,
  official_url TEXT NOT NULL,
  geometry_available INTEGER NOT NULL DEFAULT 0 CHECK (geometry_available IN (0,1)),
  missing_snapshots INTEGER NOT NULL DEFAULT 0,
  source_updated_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_tfr_status_time ON tfr_notices(status,effective_at,expires_at);

CREATE TABLE tfr_effective_intervals (
  id TEXT PRIMARY KEY,
  tfr_id TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  FOREIGN KEY (tfr_id) REFERENCES tfr_notices(id)
);

CREATE TABLE tfr_geometries (
  id TEXT PRIMARY KEY,
  tfr_id TEXT NOT NULL,
  geojson TEXT NOT NULL,
  min_lat REAL,
  min_lon REAL,
  max_lat REAL,
  max_lon REAL,
  FOREIGN KEY (tfr_id) REFERENCES tfr_notices(id)
);

CREATE TABLE sua_areas (
  id TEXT PRIMARY KEY,
  gid TEXT,
  name TEXT NOT NULL,
  airspace_type TEXT NOT NULL,
  geojson TEXT NOT NULL,
  low_altitude TEXT,
  high_altitude TEXT,
  min_lat REAL,
  min_lon REAL,
  max_lat REAL,
  max_lon REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (id,gid)
);

CREATE TABLE sua_reservations (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','upcoming','pending','not_listed','expired','unknown')),
  starts_at TEXT,
  ends_at TEXT,
  low_altitude TEXT,
  high_altitude TEXT,
  remarks TEXT,
  source_updated_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (area_id) REFERENCES sua_areas(id)
);

CREATE INDEX idx_sua_reservation_status ON sua_reservations(status,starts_at,ends_at);

CREATE TABLE operation_airspace_matches (
  operation_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('tfr','sua')),
  source_id TEXT NOT NULL,
  match_type TEXT NOT NULL CHECK (match_type IN ('intersects','nearby')),
  matched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (operation_id,source_type,source_id),
  FOREIGN KEY (operation_id) REFERENCES operations(id)
);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  integration TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','success','partial','failed')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  records_seen INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  details_json TEXT
);

CREATE INDEX idx_sync_runs_integration ON sync_runs(integration,started_at DESC);

CREATE TABLE integration_health (
  integration TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('healthy','stale','error','disabled','unknown')),
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error_code TEXT,
  details_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
