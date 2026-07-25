PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO permissions(key,description) VALUES
  ('delivery.files.create','Create delivery folders and files'),
  ('delivery.files.copy','Copy delivery files and folders'),
  ('delivery.files.move','Move or rename delivery files and folders'),
  ('delivery.files.upload','Upload delivery files'),
  ('delivery.files.batch','Run bounded delivery filesystem batches'),
  ('delivery.files.restore','Restore delivery items from Trash');

INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
  SELECT role_id,key FROM (SELECT 'role-owner' AS role_id) CROSS JOIN permissions
  WHERE key LIKE 'delivery.files.%';

INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
  SELECT 'role-admin',key FROM permissions WHERE key LIKE 'delivery.files.%';

INSERT OR IGNORE INTO role_permissions(role_id,permission_key) VALUES
  ('role-delivery-coordinator','delivery.browse'),
  ('role-delivery-coordinator','delivery.share.create'),
  ('role-delivery-coordinator','delivery.share.revoke'),
  ('role-delivery-coordinator','delivery.share.audit');

CREATE TABLE IF NOT EXISTS local_staff_role_assignments (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','division')),
  division_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(staff_id,role_id,scope,division_id),
  FOREIGN KEY (staff_id) REFERENCES staff_users(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id),
  FOREIGN KEY (created_by) REFERENCES staff_users(id)
);

CREATE INDEX IF NOT EXISTS idx_local_staff_roles_staff
  ON local_staff_role_assignments(staff_id);

CREATE TABLE IF NOT EXISTS r2_operation_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('copy','move','batch')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  requested_by TEXT NOT NULL,
  source_key TEXT,
  target_key TEXT,
  conflict_policy TEXT NOT NULL DEFAULT 'fail' CHECK (conflict_policy IN ('fail','skip','replace','rename')),
  payload_json TEXT NOT NULL,
  cursor TEXT,
  total_items INTEGER NOT NULL DEFAULT 0,
  processed_items INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_r2_operation_jobs_status
  ON r2_operation_jobs(status,updated_at);

CREATE TABLE IF NOT EXISTS r2_upload_sessions (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL UNIQUE,
  object_key TEXT NOT NULL,
  expected_size INTEGER NOT NULL CHECK (expected_size >= 0),
  content_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','aborted','expired')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (created_by) REFERENCES staff_users(id)
);

CREATE INDEX IF NOT EXISTS idx_r2_upload_sessions_status
  ON r2_upload_sessions(status,expires_at);

CREATE TABLE IF NOT EXISTS r2_upload_parts (
  session_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number >= 1),
  etag TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id,part_number),
  FOREIGN KEY (session_id) REFERENCES r2_upload_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS r2_replacement_recovery (
  id TEXT PRIMARY KEY,
  original_key TEXT NOT NULL,
  recovery_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  purge_after TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_r2_replacement_recovery_purge
  ON r2_replacement_recovery(purge_after);

CREATE TABLE IF NOT EXISTS r2_event_suppressions (
  object_key TEXT PRIMARY KEY,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('create')),
  expires_at TEXT NOT NULL
);
