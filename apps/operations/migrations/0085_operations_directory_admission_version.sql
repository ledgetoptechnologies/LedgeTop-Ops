PRAGMA foreign_keys = ON;

-- No transaction may carry an open write fence across an upgrade. Fail rather
-- than assigning a guessed admission version to an in-flight command.
CREATE TABLE operations_directory_admission_upgrade_guard (
  open_fences INTEGER NOT NULL CHECK(open_fences=0)
);
INSERT INTO operations_directory_admission_upgrade_guard(open_fences)
  SELECT count(*) FROM operations_directory_write_fences;
DROP TABLE operations_directory_admission_upgrade_guard;

ALTER TABLE operations_directory_write_fences ADD COLUMN actor_admission_version INTEGER
  CHECK(typeof(actor_admission_version)='integer' AND actor_admission_version BETWEEN 1 AND 9007199254740991);

DROP TRIGGER operations_directory_write_fences_insert_shape;
CREATE TRIGGER operations_directory_write_fences_insert_shape BEFORE INSERT ON operations_directory_write_fences
WHEN NEW.intent_writes<>json_array_length(NEW.destinations_json)
  OR NEW.actor_admission_version IS NULL
  OR typeof(NEW.actor_admission_version)<>'integer'
  OR NEW.actor_admission_version<1
BEGIN SELECT RAISE(ABORT,'directory write fence context is invalid'); END;

DROP TRIGGER operations_directory_write_fences_immutable;
CREATE TRIGGER operations_directory_write_fences_immutable BEFORE UPDATE ON operations_directory_write_fences
WHEN NEW.mutation_id IS NOT OLD.mutation_id OR NEW.operation_kind IS NOT OLD.operation_kind
  OR NEW.actor_id IS NOT OLD.actor_id OR NEW.bound_access_subject IS NOT OLD.bound_access_subject
  OR NEW.actor_admission_version IS NOT OLD.actor_admission_version
  OR NEW.permission IS NOT OLD.permission OR NEW.record_id IS NOT OLD.record_id OR NEW.record_kind IS NOT OLD.record_kind
  OR NEW.expected_version IS NOT OLD.expected_version OR NEW.create_admission_id IS NOT OLD.create_admission_id
  OR NEW.selected_grant_id IS NOT OLD.selected_grant_id OR NEW.scopes_json IS NOT OLD.scopes_json
  OR NEW.profile_json IS NOT OLD.profile_json OR NEW.command_json IS NOT OLD.command_json
  OR NEW.destinations_json IS NOT OLD.destinations_json OR NEW.write_guard IS NOT OLD.write_guard
  OR NEW.record_writes>OLD.record_writes OR NEW.revision_writes>OLD.revision_writes
  OR NEW.audit_writes>OLD.audit_writes OR NEW.intent_writes>OLD.intent_writes
  OR (OLD.record_writes-NEW.record_writes)+(OLD.revision_writes-NEW.revision_writes)
    +(OLD.audit_writes-NEW.audit_writes)+(OLD.intent_writes-NEW.intent_writes)<>1
BEGIN SELECT RAISE(ABORT,'directory write fence context is immutable'); END;

DROP VIEW operations_directory_live_write_fences;
CREATE VIEW operations_directory_live_write_fences AS
SELECT fence.* FROM operations_directory_write_fences fence
JOIN staff_users actor ON actor.id=fence.actor_id
JOIN native_staff_admissions staff_admission ON staff_admission.staff_id=fence.actor_id
  AND staff_admission.active=1 AND staff_admission.bound_access_subject=fence.bound_access_subject
  AND staff_admission.version=fence.actor_admission_version
LEFT JOIN operations_directory_records record ON record.record_id=fence.record_id
LEFT JOIN native_directory_create_admissions create_admission ON create_admission.id=fence.create_admission_id
LEFT JOIN native_directory_enrollments enrollment ON enrollment.record_id=fence.record_id
LEFT JOIN native_directory_grants selected_grant ON selected_grant.id=fence.selected_grant_id
  AND selected_grant.staff_id=fence.actor_id AND selected_grant.permission=fence.permission
  AND selected_grant.effect='allow' AND selected_grant.active=1
WHERE fence.write_guard=1
  AND ((fence.operation_kind='create'
      AND create_admission.staff_id=fence.actor_id AND create_admission.bound_access_subject=fence.bound_access_subject
      AND create_admission.record_id=fence.record_id AND create_admission.record_kind=fence.record_kind
      AND json(create_admission.scopes_json)=json(fence.scopes_json)
      AND json(create_admission.profile_json)=json(fence.profile_json)
      AND json(create_admission.destinations_json)=json(fence.destinations_json)
      AND fence.intent_writes BETWEEN 0 AND json_array_length(fence.destinations_json)
      AND NOT EXISTS(SELECT 1 FROM json_each(fence.scopes_json) proposed
        LEFT JOIN native_business_areas area ON area.id=json_extract(proposed.value,'$.businessAreaId') AND area.active=1
        LEFT JOIN native_business_divisions division ON division.id=json_extract(proposed.value,'$.divisionId')
          AND division.business_area_id=json_extract(proposed.value,'$.businessAreaId') AND division.active=1
        WHERE area.id IS NULL OR (json_type(proposed.value,'$.divisionId')='text' AND division.id IS NULL))
      AND ((fence.record_writes=1 AND record.record_id IS NULL AND create_admission.active=1
          AND create_admission.consumed_mutation_id IS NULL)
        OR (fence.record_writes=0 AND record.record_id=fence.record_id AND record.record_kind=fence.record_kind
          AND record.current_version=1 AND create_admission.active=0
          AND create_admission.consumed_mutation_id=fence.mutation_id))
      AND (selected_grant.scope_kind='global'
        OR (selected_grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM json_each(fence.scopes_json) scope
          WHERE json_extract(scope.value,'$.businessAreaId')=selected_grant.business_area_id))
        OR (selected_grant.scope_kind='division' AND EXISTS(SELECT 1 FROM json_each(fence.scopes_json) scope
          WHERE json_extract(scope.value,'$.divisionId')=selected_grant.division_id))))
    OR (fence.operation_kind='update' AND record.record_id IS NOT NULL AND record.record_kind=fence.record_kind
      AND ((fence.record_writes=1 AND record.current_version=fence.expected_version)
        OR (fence.record_writes=0 AND record.current_version=fence.expected_version+1))
      AND enrollment.record_id IS NOT NULL AND json(enrollment.destinations_json)=json(fence.destinations_json)
      AND fence.intent_writes BETWEEN 0 AND json_array_length(fence.destinations_json)
      AND NOT EXISTS(SELECT 1 FROM native_directory_resource_scopes current_scope
        JOIN native_business_areas area ON area.id=current_scope.business_area_id
        LEFT JOIN native_business_divisions division ON division.id=current_scope.division_id
        WHERE current_scope.record_id=fence.record_id AND current_scope.active=1
          AND (area.active<>1 OR (current_scope.division_id IS NOT NULL AND coalesce(division.active,0)<>1)))
      AND (selected_grant.scope_kind='global'
        OR (selected_grant.scope_kind='resource' AND selected_grant.resource_id=fence.record_id)
        OR (selected_grant.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
          WHERE assignment.record_id=fence.record_id AND assignment.staff_id=fence.actor_id AND assignment.active=1))
        OR (selected_grant.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.business_area_id=selected_grant.business_area_id))
        OR (selected_grant.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.division_id=selected_grant.division_id)))))
  AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny
    WHERE deny.staff_id=fence.actor_id AND deny.permission=fence.permission AND deny.effect='deny' AND deny.active=1
      AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=fence.record_id)
        OR (deny.scope_kind='assigned' AND fence.operation_kind='update' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
          WHERE assignment.record_id=fence.record_id AND assignment.staff_id=fence.actor_id AND assignment.active=1))
        OR (deny.scope_kind='business_area' AND ((fence.operation_kind='create' AND EXISTS(SELECT 1 FROM json_each(fence.scopes_json) scope
            WHERE json_extract(scope.value,'$.businessAreaId')=deny.business_area_id))
          OR (fence.operation_kind='update' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))))
        OR (deny.scope_kind='division' AND ((fence.operation_kind='create' AND EXISTS(SELECT 1 FROM json_each(fence.scopes_json) scope
            WHERE json_extract(scope.value,'$.divisionId')=deny.division_id))
          OR (fence.operation_kind='update' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=fence.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))));
