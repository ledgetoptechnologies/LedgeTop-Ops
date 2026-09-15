PRAGMA foreign_keys = ON;

-- A create admission is a one-shot, server-issued description of the complete
-- canonical record.  In particular, callers cannot choose destination or
-- membership authority at mutation time.
CREATE TABLE native_directory_create_admissions (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191),
  staff_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  bound_access_subject TEXT NOT NULL CHECK(length(bound_access_subject) BETWEEN 1 AND 191),
  record_id TEXT NOT NULL UNIQUE CHECK(length(record_id) BETWEEN 1 AND 191),
  record_kind TEXT NOT NULL CHECK(record_kind IN ('organization','client')),
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json) AND json_type(scopes_json)='array' AND json_array_length(scopes_json)>0),
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json) AND json_type(profile_json)='object'),
  destinations_json TEXT NOT NULL CHECK(json_valid(destinations_json) AND json_type(destinations_json)='array'),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  consumed_mutation_id TEXT UNIQUE,
  issued_by TEXT NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  consumed_at TEXT,
  CHECK((active=1 AND consumed_mutation_id IS NULL AND consumed_at IS NULL)
    OR (active=0 AND consumed_mutation_id IS NULL AND consumed_at IS NULL)
    OR (active=0 AND consumed_mutation_id IS NOT NULL AND consumed_at IS NOT NULL))
);

CREATE TRIGGER native_directory_create_admissions_shape BEFORE INSERT ON native_directory_create_admissions
WHEN EXISTS(SELECT 1 FROM json_each(NEW.scopes_json) scope
    WHERE json_type(scope.value)<>'object'
      OR coalesce(json_type(scope.value,'$.businessAreaId'),'missing')<>'text'
      OR coalesce(json_type(scope.value,'$.divisionId'),'missing') NOT IN ('text','null')
      OR (SELECT count(*) FROM json_each(scope.value))<>2)
  OR EXISTS(SELECT 1 FROM json_each(NEW.destinations_json) destination
    WHERE json_type(destination.value)<>'object'
      OR coalesce(json_type(destination.value,'$.sourceId'),'missing')<>'text'
      OR coalesce(json_type(destination.value,'$.sourceInstanceUUID'),'missing')<>'text'
      OR coalesce(json_type(destination.value,'$.applicationUUID'),'missing')<>'text'
      OR coalesce(json_type(destination.value,'$.origin'),'missing')<>'text'
      OR coalesce(json_type(destination.value,'$.externalCanonicalId'),'missing')<>'text'
      OR (SELECT count(*) FROM json_each(destination.value))<>5)
  OR EXISTS(SELECT 1 FROM json_each(NEW.scopes_json) scope
    LEFT JOIN native_business_areas area ON area.id=json_extract(scope.value,'$.businessAreaId') AND area.active=1
    LEFT JOIN native_business_divisions division ON division.id=json_extract(scope.value,'$.divisionId')
      AND division.business_area_id=json_extract(scope.value,'$.businessAreaId') AND division.active=1
    WHERE area.id IS NULL OR (json_type(scope.value,'$.divisionId')='text' AND division.id IS NULL))
  OR (SELECT count(*) FROM json_each(NEW.scopes_json))<>(SELECT count(*) FROM (
    SELECT json_extract(value,'$.businessAreaId'),json_extract(value,'$.divisionId') FROM json_each(NEW.scopes_json) GROUP BY 1,2))
  OR (SELECT count(*) FROM json_each(NEW.destinations_json))<>(SELECT count(*) FROM (
    SELECT json_extract(value,'$.sourceId'),json_extract(value,'$.sourceInstanceUUID'),json_extract(value,'$.applicationUUID')
    FROM json_each(NEW.destinations_json) GROUP BY 1,2,3))
BEGIN SELECT RAISE(ABORT,'native directory create admission is invalid'); END;

CREATE TRIGGER native_directory_create_admissions_immutable BEFORE UPDATE ON native_directory_create_admissions
WHEN NEW.id IS NOT OLD.id OR NEW.staff_id IS NOT OLD.staff_id OR NEW.bound_access_subject IS NOT OLD.bound_access_subject
  OR NEW.record_id IS NOT OLD.record_id OR NEW.record_kind IS NOT OLD.record_kind OR NEW.scopes_json IS NOT OLD.scopes_json
  OR NEW.profile_json IS NOT OLD.profile_json OR NEW.destinations_json IS NOT OLD.destinations_json
  OR NEW.issued_by IS NOT OLD.issued_by OR NEW.created_at IS NOT OLD.created_at
  OR NOT(OLD.active=1 AND OLD.consumed_mutation_id IS NULL AND OLD.consumed_at IS NULL AND NEW.active=0
    AND ((NEW.consumed_mutation_id IS NULL AND NEW.consumed_at IS NULL)
      OR (NEW.consumed_mutation_id IS NOT NULL AND NEW.consumed_at IS NOT NULL)))
BEGIN SELECT RAISE(ABORT,'native directory create admission is immutable'); END;
CREATE TRIGGER native_directory_create_admissions_no_delete BEFORE DELETE ON native_directory_create_admissions
BEGIN SELECT RAISE(ABORT,'native directory create admissions are durable'); END;

CREATE TABLE native_directory_enrollments (
  record_id TEXT NOT NULL PRIMARY KEY REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  destinations_json TEXT NOT NULL CHECK(json_valid(destinations_json) AND json_type(destinations_json)='array'),
  create_admission_id TEXT NOT NULL UNIQUE REFERENCES native_directory_create_admissions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER native_directory_enrollments_no_update BEFORE UPDATE ON native_directory_enrollments
BEGIN SELECT RAISE(ABORT,'native directory enrollment is immutable'); END;
CREATE TRIGGER native_directory_enrollments_no_delete BEFORE DELETE ON native_directory_enrollments
BEGIN SELECT RAISE(ABORT,'native directory enrollment is durable'); END;

CREATE TRIGGER native_directory_enrollments_create_guard BEFORE INSERT ON native_directory_enrollments
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_write_fences fence
  WHERE fence.operation_kind='create' AND fence.record_id=NEW.record_id
    AND fence.create_admission_id=NEW.create_admission_id AND fence.record_writes=0
    AND json(fence.destinations_json)=json(NEW.destinations_json))
BEGIN SELECT RAISE(ABORT,'native directory enrollment requires a create admission'); END;

CREATE TRIGGER native_directory_resource_scopes_create_guard BEFORE INSERT ON native_directory_resource_scopes
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_write_fences fence,json_each(fence.scopes_json) scope
  WHERE fence.operation_kind='create' AND fence.record_id=NEW.record_id AND fence.record_writes=0
    AND json_extract(scope.value,'$.businessAreaId')=NEW.business_area_id
    AND json_extract(scope.value,'$.divisionId') IS NEW.division_id)
BEGIN SELECT RAISE(ABORT,'native directory scope requires a create admission'); END;

-- One fence is inserted in the same D1 batch as its protected writes.  The
-- selected grant is evidence, not cached authority: the live view rejoins all
-- mutable admission, identity, scope, assignment, grant and deny state.
CREATE TABLE operations_directory_write_fences (
  mutation_id TEXT NOT NULL PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK(operation_kind IN ('create','update')),
  actor_id TEXT NOT NULL,
  bound_access_subject TEXT NOT NULL,
  permission TEXT NOT NULL CHECK(permission='directory.profile.edit'),
  record_id TEXT NOT NULL UNIQUE,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('organization','client')),
  expected_version INTEGER NOT NULL CHECK(expected_version>=0),
  create_admission_id TEXT REFERENCES native_directory_create_admissions(id) ON DELETE RESTRICT,
  selected_grant_id TEXT REFERENCES native_directory_grants(id) ON DELETE RESTRICT,
  scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json) AND json_type(scopes_json)='array'),
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json) AND json_type(profile_json)='object'),
  command_json TEXT NOT NULL CHECK(json_valid(command_json) AND json_type(command_json)='object'),
  destinations_json TEXT NOT NULL CHECK(json_valid(destinations_json) AND json_type(destinations_json)='array'),
  record_writes INTEGER NOT NULL DEFAULT 1 CHECK(record_writes BETWEEN 0 AND 1),
  revision_writes INTEGER NOT NULL DEFAULT 1 CHECK(revision_writes BETWEEN 0 AND 1),
  audit_writes INTEGER NOT NULL DEFAULT 1 CHECK(audit_writes BETWEEN 0 AND 1),
  intent_writes INTEGER NOT NULL CHECK(intent_writes>=0),
  write_guard INTEGER NOT NULL DEFAULT 1 CHECK(write_guard=1),
  CHECK((operation_kind='create' AND expected_version=0 AND create_admission_id IS NOT NULL AND selected_grant_id IS NOT NULL)
    OR (operation_kind='update' AND expected_version>=1 AND create_admission_id IS NULL AND selected_grant_id IS NOT NULL))
);

CREATE TRIGGER operations_directory_write_fences_insert_shape BEFORE INSERT ON operations_directory_write_fences
WHEN NEW.intent_writes<>json_array_length(NEW.destinations_json)
BEGIN SELECT RAISE(ABORT,'directory write fence intent count is invalid'); END;
CREATE TRIGGER operations_directory_write_fences_immutable BEFORE UPDATE ON operations_directory_write_fences
WHEN NEW.mutation_id IS NOT OLD.mutation_id OR NEW.operation_kind IS NOT OLD.operation_kind
  OR NEW.actor_id IS NOT OLD.actor_id OR NEW.bound_access_subject IS NOT OLD.bound_access_subject
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

CREATE VIEW operations_directory_live_write_fences AS
SELECT fence.* FROM operations_directory_write_fences fence
JOIN staff_users actor ON actor.id=fence.actor_id
JOIN native_staff_admissions staff_admission ON staff_admission.staff_id=fence.actor_id
  AND staff_admission.active=1 AND staff_admission.bound_access_subject=fence.bound_access_subject
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

CREATE TRIGGER operations_directory_records_write_guard_insert BEFORE INSERT ON operations_directory_records
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_write_fences fence WHERE fence.mutation_id IS NOT NULL
  AND fence.operation_kind='create' AND fence.record_id=NEW.record_id AND fence.record_kind=NEW.record_kind
  AND fence.expected_version=0 AND fence.record_writes=1 AND NEW.current_version=1)
BEGIN SELECT RAISE(ABORT,'directory create requires current native authority'); END;
CREATE TRIGGER operations_directory_records_write_guard_insert_consume AFTER INSERT ON operations_directory_records
BEGIN
  UPDATE operations_directory_write_fences SET record_writes=record_writes-1
    WHERE record_id=NEW.record_id AND operation_kind='create' AND record_writes=1;
  UPDATE native_directory_create_admissions SET active=0,consumed_mutation_id=(SELECT mutation_id
      FROM operations_directory_write_fences WHERE record_id=NEW.record_id AND operation_kind='create'),
    consumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=(SELECT create_admission_id
      FROM operations_directory_write_fences WHERE record_id=NEW.record_id AND operation_kind='create');
  INSERT INTO native_directory_resource_scopes(record_id,scope_kind,business_area_id,division_id,active)
    SELECT NEW.record_id,CASE WHEN json_type(scope.value,'$.divisionId')='null' THEN 'business_area' ELSE 'division' END,
      json_extract(scope.value,'$.businessAreaId'),json_extract(scope.value,'$.divisionId'),1
    FROM operations_directory_write_fences fence,json_each(fence.scopes_json) scope
    WHERE fence.record_id=NEW.record_id AND fence.operation_kind='create';
  INSERT INTO native_directory_enrollments(record_id,destinations_json,create_admission_id)
    SELECT NEW.record_id,fence.destinations_json,fence.create_admission_id FROM operations_directory_write_fences fence
    WHERE fence.record_id=NEW.record_id AND fence.operation_kind='create';
END;

CREATE TRIGGER operations_directory_records_write_guard_update BEFORE UPDATE ON operations_directory_records
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_write_fences fence WHERE fence.operation_kind='update'
  AND fence.record_id=OLD.record_id AND fence.record_kind=OLD.record_kind AND fence.expected_version=OLD.current_version
  AND fence.record_writes=1 AND NEW.current_version=OLD.current_version+1)
BEGIN SELECT RAISE(ABORT,'directory update requires current native authority'); END;
CREATE TRIGGER operations_directory_records_write_guard_update_consume AFTER UPDATE ON operations_directory_records
BEGIN UPDATE operations_directory_write_fences SET record_writes=record_writes-1
  WHERE record_id=NEW.record_id AND operation_kind='update' AND record_writes=1; END;

CREATE TRIGGER operations_directory_revisions_write_guard BEFORE INSERT ON operations_directory_revisions
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_write_fences fence WHERE fence.mutation_id=NEW.mutation_id
  AND fence.record_id=NEW.record_id AND NEW.version=fence.expected_version+1 AND fence.record_writes=0
  AND fence.revision_writes=1 AND json(NEW.profile_json)=json(fence.profile_json))
BEGIN SELECT RAISE(ABORT,'directory revision requires current native authority'); END;
CREATE TRIGGER operations_directory_revisions_write_guard_consume AFTER INSERT ON operations_directory_revisions
BEGIN UPDATE operations_directory_write_fences SET revision_writes=revision_writes-1
  WHERE mutation_id=NEW.mutation_id AND revision_writes=1; END;

CREATE TRIGGER operations_directory_audit_write_guard BEFORE INSERT ON operations_directory_audit
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_write_fences fence WHERE fence.mutation_id=NEW.mutation_id
  AND fence.record_id=NEW.record_id AND NEW.record_version=fence.expected_version+1 AND NEW.actor_type='staff'
  AND NEW.actor_id=fence.actor_id AND fence.record_writes=0 AND fence.revision_writes=0 AND fence.audit_writes=1
  AND json(NEW.command_json)=json(fence.command_json))
BEGIN SELECT RAISE(ABORT,'directory audit requires current native authority'); END;
CREATE TRIGGER operations_directory_audit_write_guard_consume AFTER INSERT ON operations_directory_audit
BEGIN UPDATE operations_directory_write_fences SET audit_writes=audit_writes-1
  WHERE mutation_id=NEW.mutation_id AND audit_writes=1; END;

CREATE TRIGGER operations_directory_intents_write_guard BEFORE INSERT ON operations_directory_intents
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_write_fences fence,json_each(fence.destinations_json) destination
  WHERE fence.mutation_id=NEW.mutation_id AND fence.record_id=NEW.record_id AND NEW.record_version=fence.expected_version+1
    AND fence.record_writes=0 AND fence.revision_writes=0 AND fence.audit_writes=0 AND fence.intent_writes>0
    AND json_extract(destination.value,'$.sourceId')=NEW.source_id
    AND json_extract(destination.value,'$.sourceInstanceUUID')=NEW.source_instance_uuid
    AND json_extract(destination.value,'$.applicationUUID')=NEW.application_uuid
    AND json_extract(destination.value,'$.origin')=NEW.destination_origin
    AND json_extract(destination.value,'$.externalCanonicalId')=NEW.external_canonical_id
    AND json(NEW.desired_payload_json)=json(fence.profile_json))
BEGIN SELECT RAISE(ABORT,'directory intent requires current native authority and enrollment'); END;
CREATE TRIGGER operations_directory_intents_write_guard_consume AFTER INSERT ON operations_directory_intents
BEGIN UPDATE operations_directory_write_fences SET intent_writes=intent_writes-1
  WHERE mutation_id=NEW.mutation_id AND intent_writes>0; END;

CREATE TRIGGER operations_directory_write_fences_exhausted BEFORE DELETE ON operations_directory_write_fences
WHEN OLD.record_writes<>0 OR OLD.revision_writes<>0 OR OLD.audit_writes<>0 OR OLD.intent_writes<>0
BEGIN SELECT RAISE(ABORT,'directory write fence is not exhausted'); END;
