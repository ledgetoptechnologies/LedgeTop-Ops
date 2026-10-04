PRAGMA foreign_keys = ON;

-- A field-review receipt is evidence only, but it must not be sealed after the
-- reviewer's directory identity-link authority has been revoked or denied.
-- This successor guard closes the time-of-check/time-of-use window left by the
-- exact-claim guard in 0163. It intentionally does not activate a claim or
-- change any mapping, Delivery, or public-link state.
CREATE TRIGGER project_alpha_directory_read_adoption_field_review_receipts_current_identity_link
BEFORE INSERT ON project_alpha_directory_read_adoption_field_review_receipts
WHEN NOT EXISTS(
  SELECT 1
  FROM operations_directory_records record
  WHERE record.record_id=NEW.record_id
    AND record.record_kind=NEW.resource_type
    AND EXISTS(
      SELECT 1
      FROM native_directory_grants allow_row
      WHERE allow_row.staff_id=NEW.reviewer_staff_id
        AND allow_row.permission='directory.identity.link'
        AND allow_row.effect='allow'
        AND allow_row.active=1
        AND (
          allow_row.scope_kind='global'
          OR (allow_row.scope_kind='resource' AND allow_row.resource_id=record.record_id)
          OR (allow_row.scope_kind='assigned' AND EXISTS(
            SELECT 1 FROM native_directory_assignments assignment
            WHERE assignment.record_id=record.record_id
              AND assignment.staff_id=NEW.reviewer_staff_id
              AND assignment.active=1))
          OR (allow_row.scope_kind='business_area' AND EXISTS(
            SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=record.record_id
              AND scope.active=1
              AND scope.business_area_id=allow_row.business_area_id))
          OR (allow_row.scope_kind='division' AND EXISTS(
            SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=record.record_id
              AND scope.active=1
              AND scope.division_id=allow_row.division_id))
        )
    )
    AND NOT EXISTS(
      SELECT 1
      FROM native_directory_grants deny_row
      WHERE deny_row.staff_id=NEW.reviewer_staff_id
        AND deny_row.permission='directory.identity.link'
        AND deny_row.effect='deny'
        AND deny_row.active=1
        AND (
          deny_row.scope_kind='global'
          OR (deny_row.scope_kind='resource' AND deny_row.resource_id=record.record_id)
          OR (deny_row.scope_kind='assigned' AND EXISTS(
            SELECT 1 FROM native_directory_assignments assignment
            WHERE assignment.record_id=record.record_id
              AND assignment.staff_id=NEW.reviewer_staff_id
              AND assignment.active=1))
          OR (deny_row.scope_kind='business_area' AND EXISTS(
            SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=record.record_id
              AND scope.active=1
              AND scope.business_area_id=deny_row.business_area_id))
          OR (deny_row.scope_kind='division' AND EXISTS(
            SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=record.record_id
              AND scope.active=1
              AND scope.division_id=deny_row.division_id))
        )
    )
)
BEGIN
  SELECT RAISE(ABORT,'directory adoption field review requires current identity-link authority');
END;
