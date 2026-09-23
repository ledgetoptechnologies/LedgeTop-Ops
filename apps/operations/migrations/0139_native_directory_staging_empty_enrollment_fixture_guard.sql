PRAGMA foreign_keys = ON;

-- The staging-only, source-less organization fixture is the lone create that
-- may consume an empty enrollment. Its HTTP route checks enrollment.manage,
-- but this guard repeats that decision inside the same D1 batch as the record
-- insert so a grant revoked after request admission cannot be raced.
CREATE TRIGGER operations_directory_staging_empty_enrollment_fixture_enrollment_guard
BEFORE INSERT ON operations_directory_records
WHEN NEW.record_id='staging-native-empty-enrollment-organization-v1'
  AND NOT EXISTS(
    SELECT 1 FROM operations_directory_write_fences f
    WHERE f.mutation_id='6d0da70c-f4f5-4b10-8988-6639b8e01531'
      AND f.operation_kind='create' AND f.record_id=NEW.record_id AND f.record_kind='organization'
      AND f.expected_version=0 AND f.create_admission_id='6d0da70c-f4f5-4b10-8988-6639b8e01531:admission'
      AND json(f.destinations_json)=json('[]') AND json_array_length(f.scopes_json)=1
      AND json_extract(f.scopes_json,'$[0].divisionId') IS NULL
      AND EXISTS(SELECT 1 FROM native_directory_grants grant
        WHERE grant.staff_id=f.actor_id AND grant.permission='directory.enrollment.manage'
          AND grant.effect='allow' AND grant.active=1
          AND (grant.scope_kind='global' OR (grant.scope_kind='business_area'
            AND grant.business_area_id=json_extract(f.scopes_json,'$[0].businessAreaId')))
          AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny
            WHERE deny.staff_id=grant.staff_id AND deny.permission=grant.permission
              AND deny.effect='deny' AND deny.active=1
              AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=f.record_id)
                OR (deny.scope_kind='business_area' AND deny.business_area_id=json_extract(f.scopes_json,'$[0].businessAreaId'))
                OR (deny.scope_kind='division' AND deny.division_id IS NULL)))
      )
  )
BEGIN SELECT RAISE(ABORT,'staging empty-enrollment fixture requires current enrollment authority'); END;
