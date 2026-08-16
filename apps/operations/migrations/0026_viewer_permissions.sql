PRAGMA foreign_keys = ON;

-- Viewer authority is independently assignable and denyable. Existing broad
-- project/integration grants do not imply access to model data or sharing.
INSERT OR IGNORE INTO permissions(key,description) VALUES
  ('viewer.view','View explicitly associated 3D models'),
  ('viewer.manage','Associate and revoke Viewer models for LTDS projects'),
  ('viewer.share.create','Create public 3D Viewer shares'),
  ('viewer.share.revoke','Revoke public 3D Viewer shares'),
  ('viewer.import','Import or rescan 3D Viewer models');

INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
SELECT role.id,permission.key
FROM roles role
CROSS JOIN permissions permission
WHERE role.id IN ('role-owner','role-admin')
  AND permission.key IN (
    'viewer.view','viewer.manage','viewer.share.create','viewer.share.revoke','viewer.import'
  );
