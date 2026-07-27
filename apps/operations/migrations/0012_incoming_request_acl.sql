PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO permissions(key,description) VALUES
  ('file_requests.view','View incoming upload request status'),
  ('file_requests.create','Create and copy the reusable incoming upload link'),
  ('file_requests.manage','Rotate, protect, and revoke the reusable incoming upload link');

INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
  SELECT 'role-owner',key FROM permissions WHERE key LIKE 'file_requests.%';

INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
  SELECT 'role-admin',key FROM permissions WHERE key LIKE 'file_requests.%';
