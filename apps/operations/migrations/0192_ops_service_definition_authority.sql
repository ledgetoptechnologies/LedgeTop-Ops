PRAGMA foreign_keys = ON;

CREATE TABLE operations_service_definition_mutations (
  mutation_id TEXT PRIMARY KEY CHECK(length(mutation_id) BETWEEN 1 AND 191 AND mutation_id=trim(mutation_id)),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  authorized_access_subject TEXT NOT NULL,
  authorized_admission_version INTEGER NOT NULL CHECK(authorized_admission_version>=1),
  authorized_profile_version INTEGER NOT NULL CHECK(authorized_profile_version>=1),
  authorized_grant_generation INTEGER NOT NULL CHECK(authorized_grant_generation>=1),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128 AND idempotency_key=trim(idempotency_key)),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  service_id TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_service_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(actor_staff_id,idempotency_key)
);

CREATE TRIGGER operations_service_definition_mutation_guard BEFORE INSERT ON operations_service_definition_mutations
WHEN NOT EXISTS(SELECT 1 FROM native_staff_admissions admission
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.version=NEW.authorized_profile_version
  JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
    AND generation.generation=NEW.authorized_grant_generation
  WHERE admission.staff_id=NEW.actor_staff_id AND admission.active=1
    AND admission.bound_access_subject=NEW.authorized_access_subject AND admission.version=NEW.authorized_admission_version
    AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
      AND role.role_id IN ('role-owner','role-admin') AND role.scope='global')
    AND EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=admission.staff_id
      AND grant_row.permission='directory.enrollment.manage' AND grant_row.effect='allow'
      AND grant_row.scope_kind='global' AND grant_row.active=1)
    AND NOT EXISTS(SELECT 1 FROM native_directory_grants grant_row WHERE grant_row.staff_id=admission.staff_id
      AND grant_row.permission='directory.enrollment.manage' AND grant_row.effect='deny'
      AND grant_row.scope_kind='global' AND grant_row.active=1))
 OR EXISTS(SELECT 1 FROM operations_service_definitions definition
      WHERE definition.service_id=NEW.service_id OR (definition.provider_id=NEW.provider_id
        AND definition.source_id=NEW.source_id AND definition.source_service_id=NEW.source_service_id))
BEGIN SELECT RAISE(ABORT,'service definition mutation denied'); END;

CREATE TRIGGER operations_service_definition_mutation_no_update BEFORE UPDATE ON operations_service_definition_mutations
BEGIN SELECT RAISE(ABORT,'service definition mutations are immutable'); END;
CREATE TRIGGER operations_service_definition_mutation_no_delete BEFORE DELETE ON operations_service_definition_mutations
BEGIN SELECT RAISE(ABORT,'service definition mutations are durable'); END;

CREATE TRIGGER operations_service_definition_insert_authority BEFORE INSERT ON operations_service_definitions
WHEN NOT EXISTS(SELECT 1 FROM operations_service_definition_mutations mutation
  WHERE mutation.service_id=NEW.service_id AND mutation.provider_id=NEW.provider_id
    AND mutation.source_id=NEW.source_id AND mutation.source_service_id=NEW.source_service_id
    AND mutation.display_name=NEW.display_name)
BEGIN SELECT RAISE(ABORT,'service definition requires audited authority'); END;
