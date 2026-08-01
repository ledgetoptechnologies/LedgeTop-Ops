PRAGMA foreign_keys = ON;

-- Viewing assigned work and viewing every active Operations record are
-- separate capabilities. A global deny on view_all must not remove the
-- ordinary assigned-work access supplied by Project Alpha roles.
INSERT OR IGNORE INTO permissions(key,description) VALUES
  ('operations.view_all','View all active operations, projects, tasks, and calendar records');

INSERT OR IGNORE INTO role_permissions(role_id,permission_key)
SELECT id,'operations.view_all' FROM roles WHERE id IN ('role-owner','role-admin');

-- The removed delivery-access endpoint represented all four delivery
-- capabilities as one local role assignment. Preserve that intended access as
-- explicit controls before eliminating the overlapping grant mechanism.
INSERT OR IGNORE INTO staff_permission_overrides
  (id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
SELECT
  'staff-control-' || assignment.staff_id || '-' || permission.key,
  assignment.staff_id,
  permission.key,
  'allow',
  'global',
  NULL,
  'global',
  COALESCE(assignment.created_by,assignment.staff_id)
FROM local_staff_role_assignments assignment
JOIN (
  SELECT 'delivery.browse' key
  UNION ALL SELECT 'delivery.share.create'
  UNION ALL SELECT 'delivery.share.revoke'
  UNION ALL SELECT 'delivery.share.audit'
) permission
WHERE assignment.role_id='role-delivery-coordinator' AND assignment.scope='global';

DELETE FROM local_staff_role_assignments
WHERE role_id='role-delivery-coordinator' AND scope='global';
