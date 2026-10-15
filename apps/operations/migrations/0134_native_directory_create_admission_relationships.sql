PRAGMA foreign_keys = ON;

-- A client create admission binds the complete local relationship assertion.
-- Project Alpha identity, revision, authorization generation and origin remain
-- server-owned evidence in the existing admission destinations and mappings.
CREATE TABLE native_directory_create_admission_relationships (
  create_admission_id TEXT NOT NULL PRIMARY KEY
    REFERENCES native_directory_create_admissions(id) ON DELETE RESTRICT,
  client_record_id TEXT NOT NULL UNIQUE CHECK(length(client_record_id) BETWEEN 1 AND 191),
  organization_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  organization_record_version INTEGER CHECK(organization_record_version IS NULL OR
    (typeof(organization_record_version)='integer' AND organization_record_version>=1)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((organization_record_id IS NULL)=(organization_record_version IS NULL))
);

-- The route is default-off and had no issued client admissions at rollout, but
-- preserve upgrade safety by making any pre-existing unconsumed client intent
-- an explicit standalone assertion instead of leaving it ambiguous.
INSERT INTO native_directory_create_admission_relationships(create_admission_id,client_record_id)
SELECT id,record_id FROM native_directory_create_admissions
WHERE record_kind='client' AND active=1 AND consumed_mutation_id IS NULL AND consumed_at IS NULL;

CREATE TRIGGER native_directory_create_admission_relationships_insert_guard
AFTER INSERT ON native_directory_create_admission_relationships
WHEN NOT EXISTS(
    SELECT 1 FROM native_directory_create_admissions admission
    WHERE admission.id=NEW.create_admission_id AND admission.record_kind='client'
      AND admission.record_id=NEW.client_record_id AND admission.active=1
      AND admission.consumed_mutation_id IS NULL AND admission.consumed_at IS NULL)
  OR (NEW.organization_record_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM operations_directory_records organization
    JOIN operations_directory_revisions revision ON revision.record_id=organization.record_id
      AND revision.version=organization.current_version
    JOIN native_directory_enrollments enrollment ON enrollment.record_id=organization.record_id
    WHERE organization.record_id=NEW.organization_record_id AND organization.record_kind='organization'
      AND organization.current_version=NEW.organization_record_version))
BEGIN SELECT RAISE(ABORT,'native directory create relationship assertion is invalid'); END;

CREATE TRIGGER native_directory_create_admission_relationships_immutable
BEFORE UPDATE ON native_directory_create_admission_relationships
BEGIN SELECT RAISE(ABORT,'native directory create relationship assertion is immutable'); END;

CREATE TRIGGER native_directory_create_admission_relationships_no_delete
BEFORE DELETE ON native_directory_create_admission_relationships
BEGIN SELECT RAISE(ABORT,'native directory create relationship assertions are durable'); END;
