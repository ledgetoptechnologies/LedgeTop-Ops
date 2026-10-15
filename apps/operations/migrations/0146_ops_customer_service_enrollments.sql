PRAGMA foreign_keys = ON;

-- Operations-owned service identity. This catalog is deliberately separate
-- from staff business areas, Project Alpha service assignments, and portal
-- permissions. A display name is descriptive only; provider/source identity
-- is the durable key, so identical names from LTDS and LTT remain distinct.
CREATE TABLE operations_service_definitions (
  service_id TEXT NOT NULL PRIMARY KEY CHECK(length(service_id) BETWEEN 1 AND 191 AND service_id=trim(service_id)),
  provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 128 AND provider_id=trim(provider_id)),
  source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128 AND source_id=trim(source_id)),
  source_service_id TEXT NOT NULL CHECK(length(source_service_id) BETWEEN 1 AND 191 AND source_service_id=trim(source_service_id)),
  display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(provider_id,source_id,source_service_id)
);

CREATE TRIGGER operations_service_definitions_identity_immutable
BEFORE UPDATE ON operations_service_definitions
BEGIN SELECT RAISE(ABORT,'service definition is immutable'); END;
CREATE TRIGGER operations_service_definitions_no_delete
BEFORE DELETE ON operations_service_definitions
BEGIN SELECT RAISE(ABORT,'service definitions are durable'); END;

-- The current, Operations-only enrollment state for one exact Directory
-- customer record and one provider/source-qualified service. This is not a
-- portal grant and must never be used to infer any content, file, financial,
-- Access-principal, email, or Project Alpha entitlement.
CREATE TABLE operations_customer_service_enrollments (
  customer_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  service_id TEXT NOT NULL REFERENCES operations_service_definitions(service_id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  last_mutation_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(customer_record_id,service_id)
);
CREATE INDEX operations_customer_service_enrollments_service
  ON operations_customer_service_enrollments(service_id,customer_record_id);

-- Each command is the immutable staff audit record and idempotency boundary.
-- Writers insert this row and then the exact corresponding head transition in
-- one transaction; triggers fence every state/revision transition.
CREATE TABLE operations_customer_service_enrollment_mutations (
  mutation_id TEXT NOT NULL PRIMARY KEY CHECK(length(mutation_id) BETWEEN 1 AND 191 AND mutation_id=trim(mutation_id)),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  authorized_access_subject TEXT NOT NULL CHECK(length(authorized_access_subject) BETWEEN 1 AND 191 AND authorized_access_subject=trim(authorized_access_subject)),
  authorized_admission_version INTEGER NOT NULL CHECK(typeof(authorized_admission_version)='integer' AND authorized_admission_version>=1),
  authorized_profile_version INTEGER NOT NULL CHECK(typeof(authorized_profile_version)='integer' AND authorized_profile_version>=1),
  authorized_grant_generation INTEGER NOT NULL CHECK(typeof(authorized_grant_generation)='integer' AND authorized_grant_generation>=1),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128 AND idempotency_key=trim(idempotency_key)),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  customer_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  service_id TEXT NOT NULL REFERENCES operations_service_definitions(service_id) ON DELETE RESTRICT,
  desired_state TEXT NOT NULL CHECK(desired_state IN ('active','revoked')),
  expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
  result_revision INTEGER NOT NULL CHECK(typeof(result_revision)='integer' AND result_revision BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(actor_staff_id,idempotency_key),
  UNIQUE(customer_record_id,service_id,result_revision),
  CHECK(result_revision=expected_revision+1)
);

CREATE TRIGGER operations_customer_service_enrollment_mutation_guard
BEFORE INSERT ON operations_customer_service_enrollment_mutations
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_records customer
  WHERE customer.record_id=NEW.customer_record_id AND customer.record_kind='client')
 OR NOT EXISTS(SELECT 1 FROM native_staff_admissions admission
   JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
   JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
   WHERE admission.staff_id=NEW.actor_staff_id AND admission.active=1
     AND admission.bound_access_subject=NEW.authorized_access_subject
     AND admission.version=NEW.authorized_admission_version
     AND profile.version=NEW.authorized_profile_version
     AND generation.generation=NEW.authorized_grant_generation
     AND EXISTS(SELECT 1 FROM native_directory_grants allow_row
       WHERE allow_row.staff_id=admission.staff_id AND allow_row.permission='directory.enrollment.manage'
         AND allow_row.effect='allow' AND allow_row.active=1
         AND (allow_row.scope_kind='global' OR (allow_row.scope_kind='resource' AND allow_row.resource_id=NEW.customer_record_id)
           OR (allow_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
             WHERE assignment.record_id=NEW.customer_record_id AND assignment.staff_id=admission.staff_id AND assignment.active=1))
           OR (allow_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
             JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
             WHERE scope.record_id=NEW.customer_record_id AND scope.active=1 AND scope.business_area_id=allow_row.business_area_id))
           OR (allow_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
             JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
             JOIN native_business_divisions division ON division.id=scope.division_id AND division.business_area_id=scope.business_area_id AND division.active=1
             WHERE scope.record_id=NEW.customer_record_id AND scope.active=1 AND scope.division_id=allow_row.division_id))))
     AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny_row
       WHERE deny_row.staff_id=admission.staff_id AND deny_row.permission='directory.enrollment.manage'
         AND deny_row.effect='deny' AND deny_row.active=1
         AND (deny_row.scope_kind='global' OR (deny_row.scope_kind='resource' AND deny_row.resource_id=NEW.customer_record_id)
           OR (deny_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
             WHERE assignment.record_id=NEW.customer_record_id AND assignment.staff_id=admission.staff_id AND assignment.active=1))
           OR (deny_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
             JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
             WHERE scope.record_id=NEW.customer_record_id AND scope.active=1 AND scope.business_area_id=deny_row.business_area_id))
           OR (deny_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
             JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
             JOIN native_business_divisions division ON division.id=scope.division_id AND division.business_area_id=scope.business_area_id AND division.active=1
             WHERE scope.record_id=NEW.customer_record_id AND scope.active=1 AND scope.division_id=deny_row.division_id)))))
 OR (NEW.expected_revision=0 AND (NEW.desired_state<>'active' OR EXISTS(
   SELECT 1 FROM operations_customer_service_enrollments enrollment
   WHERE enrollment.customer_record_id=NEW.customer_record_id AND enrollment.service_id=NEW.service_id)))
 OR (NEW.expected_revision>=1 AND NOT EXISTS(
   SELECT 1 FROM operations_customer_service_enrollments enrollment
   WHERE enrollment.customer_record_id=NEW.customer_record_id AND enrollment.service_id=NEW.service_id
     AND enrollment.revision=NEW.expected_revision))
BEGIN SELECT RAISE(ABORT,'customer service enrollment requires exact customer revision'); END;

CREATE TRIGGER operations_customer_service_enrollment_mutation_no_update
BEFORE UPDATE ON operations_customer_service_enrollment_mutations
BEGIN SELECT RAISE(ABORT,'customer service enrollment mutation is immutable'); END;
CREATE TRIGGER operations_customer_service_enrollment_mutation_no_delete
BEFORE DELETE ON operations_customer_service_enrollment_mutations
BEGIN SELECT RAISE(ABORT,'customer service enrollment mutation is durable'); END;

CREATE TRIGGER operations_customer_service_enrollment_insert_guard
BEFORE INSERT ON operations_customer_service_enrollments
WHEN NEW.revision<>1 OR NEW.state<>'active'
 OR NOT EXISTS(SELECT 1 FROM operations_directory_records customer
   WHERE customer.record_id=NEW.customer_record_id AND customer.record_kind='client')
 OR NOT EXISTS(SELECT 1 FROM operations_customer_service_enrollment_mutations mutation
   WHERE mutation.mutation_id=NEW.last_mutation_id AND mutation.customer_record_id=NEW.customer_record_id
     AND mutation.service_id=NEW.service_id AND mutation.expected_revision=0
     AND mutation.result_revision=NEW.revision AND mutation.desired_state=NEW.state)
BEGIN SELECT RAISE(ABORT,'customer service enrollment requires exact initial mutation'); END;

CREATE TRIGGER operations_customer_service_enrollment_update_guard
BEFORE UPDATE ON operations_customer_service_enrollments
WHEN NEW.customer_record_id IS NOT OLD.customer_record_id OR NEW.service_id IS NOT OLD.service_id
 OR NEW.created_at IS NOT OLD.created_at OR NEW.revision<>OLD.revision+1
 OR NEW.last_mutation_id IS OLD.last_mutation_id
 OR NOT EXISTS(SELECT 1 FROM operations_customer_service_enrollment_mutations mutation
   WHERE mutation.mutation_id=NEW.last_mutation_id AND mutation.customer_record_id=OLD.customer_record_id
     AND mutation.service_id=OLD.service_id AND mutation.expected_revision=OLD.revision
     AND mutation.result_revision=NEW.revision AND mutation.desired_state=NEW.state)
BEGIN SELECT RAISE(ABORT,'customer service enrollment transition requires exact mutation'); END;
CREATE TRIGGER operations_customer_service_enrollment_no_delete
BEFORE DELETE ON operations_customer_service_enrollments
BEGIN SELECT RAISE(ABORT,'customer service enrollments are durable'); END;
