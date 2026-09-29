PRAGMA foreign_keys = ON;

-- 0148 is already durable in staging. Add narrowly scoped database-time
-- fences without rewriting the applied migration.
CREATE TRIGGER client_portal_recipient_enrollment_redeem_expiry_guard
BEFORE UPDATE ON client_portal_recipient_enrollment_intents
WHEN OLD.state='issued' AND NEW.state='pending'
  AND OLD.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
BEGIN
  SELECT RAISE(ABORT,'recipient enrollment intent expired before redemption commit');
END;

CREATE TRIGGER client_portal_recipient_enrollment_finalize_owner_guard
BEFORE INSERT ON client_portal_recipient_enrollment_operations
WHEN NEW.action='finalize_revoke' AND NOT EXISTS(
  SELECT 1 FROM client_portal_recipient_enrollment_intents i
  JOIN client_portal_workspace_binding_selections s ON s.selection_id=i.selection_id
  JOIN native_staff_admissions a ON a.staff_id=NEW.actor_staff_id AND a.active=1
    AND a.bound_access_subject=NEW.actor_access_subject AND a.version=NEW.actor_admission_version
  JOIN native_staff_profiles p ON p.staff_id=a.staff_id AND p.version=NEW.actor_profile_version
  JOIN native_directory_grant_generations generation ON generation.staff_id=a.staff_id
    AND generation.generation=NEW.actor_grant_generation
  WHERE i.intent_id=NEW.intent_id AND NEW.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=a.staff_id
      AND role.role_id='role-owner' AND role.scope='global')
    AND EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=a.staff_id
      AND grant_row.permission='directory.portal_access.manage' AND grant_row.effect='allow' AND grant_row.active=1
      AND (grant_row.scope_kind='global' OR (grant_row.scope_kind='resource' AND grant_row.resource_id=s.record_id)))
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=a.staff_id
      AND deny.permission='directory.portal_access.manage' AND deny.effect='deny' AND deny.active=1
      AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=s.record_id)
        OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=s.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))
        OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=s.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))
)
BEGIN
  SELECT RAISE(ABORT,'recipient enrollment finalization requires current owner');
END;
