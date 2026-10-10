PRAGMA foreign_keys = ON;

-- 0081 originally narrowed canonical Directory relationship IDs to UUIDs even
-- though adopted/native records use the established bounded external-ID
-- contract. Rebuild only the mutable current-state table; immutable history,
-- fences, dependent views and all public-link tables remain untouched.
DROP TRIGGER operations_directory_client_organizations_insert_guard;
DROP TRIGGER operations_directory_client_organizations_update_guard;
DROP TRIGGER operations_directory_client_organizations_no_delete;
DROP TRIGGER operations_directory_client_organizations_insert_history;
DROP TRIGGER operations_directory_client_organizations_update_history;
DROP INDEX operations_directory_client_organizations_parent;

CREATE TABLE operations_directory_client_organizations_next (
  client_record_id TEXT NOT NULL PRIMARY KEY REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT
    CHECK(length(client_record_id) BETWEEN 1 AND 191 AND length(CAST(client_record_id AS BLOB))<=764
      AND instr(client_record_id,char(0))=0),
  organization_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT
    CHECK(organization_record_id IS NULL OR (length(organization_record_id) BETWEEN 1 AND 191
      AND length(CAST(organization_record_id AS BLOB))<=764 AND instr(organization_record_id,char(0))=0)),
  relationship_version INTEGER NOT NULL CHECK(typeof(relationship_version)='integer' AND relationship_version BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO operations_directory_client_organizations_next(
  client_record_id,organization_record_id,relationship_version,created_at,updated_at)
SELECT client_record_id,organization_record_id,relationship_version,created_at,updated_at
FROM operations_directory_client_organizations;

PRAGMA legacy_alter_table = ON;
DROP TABLE operations_directory_client_organizations;
ALTER TABLE operations_directory_client_organizations_next RENAME TO operations_directory_client_organizations;
PRAGMA legacy_alter_table = OFF;

CREATE INDEX operations_directory_client_organizations_parent ON operations_directory_client_organizations(organization_record_id);
CREATE TRIGGER operations_directory_client_organizations_insert_guard BEFORE INSERT ON operations_directory_client_organizations
WHEN EXISTS(SELECT 1 FROM operations_directory_client_organizations WHERE client_record_id=NEW.client_record_id)
  OR NOT EXISTS(SELECT 1 FROM operations_directory_live_relationship_fences fence
    WHERE fence.client_record_id=NEW.client_record_id AND fence.expected_relationship_version=0
      AND fence.previous_organization_record_id IS NULL AND fence.organization_record_id IS NEW.organization_record_id
      AND NEW.relationship_version=1)
BEGIN SELECT RAISE(ABORT,'directory relationship create requires current native authority'); END;
CREATE TRIGGER operations_directory_client_organizations_update_guard BEFORE UPDATE ON operations_directory_client_organizations
WHEN NEW.client_record_id IS NOT OLD.client_record_id OR NEW.created_at IS NOT OLD.created_at
  OR NEW.relationship_version<>OLD.relationship_version+1
  OR NOT EXISTS(SELECT 1 FROM operations_directory_live_relationship_fences fence
    WHERE fence.client_record_id=OLD.client_record_id AND fence.expected_relationship_version=OLD.relationship_version
      AND fence.previous_organization_record_id IS OLD.organization_record_id
      AND fence.organization_record_id IS NEW.organization_record_id)
BEGIN SELECT RAISE(ABORT,'directory relationship update requires current native authority'); END;
CREATE TRIGGER operations_directory_client_organizations_no_delete BEFORE DELETE ON operations_directory_client_organizations
BEGIN SELECT RAISE(ABORT,'directory relationship is durable'); END;
CREATE TRIGGER operations_directory_client_organizations_insert_history AFTER INSERT ON operations_directory_client_organizations
BEGIN
  INSERT INTO operations_directory_client_organization_history(client_record_id,relationship_version,mutation_id,
    previous_organization_record_id,organization_record_id,client_record_version,previous_organization_record_version,
    organization_record_version,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version)
  SELECT NEW.client_record_id,NEW.relationship_version,fence.mutation_id,
    fence.previous_organization_record_id,fence.organization_record_id,fence.client_record_version,
    fence.previous_organization_record_version,fence.organization_record_version,fence.actor_staff_id,
    fence.actor_access_subject,fence.actor_email,fence.actor_admission_version,fence.actor_profile_version
  FROM operations_directory_live_relationship_fences fence WHERE fence.client_record_id=NEW.client_record_id;
END;
CREATE TRIGGER operations_directory_client_organizations_update_history AFTER UPDATE ON operations_directory_client_organizations
BEGIN
  INSERT INTO operations_directory_client_organization_history(client_record_id,relationship_version,mutation_id,
    previous_organization_record_id,organization_record_id,client_record_version,previous_organization_record_version,
    organization_record_version,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,actor_profile_version)
  SELECT NEW.client_record_id,NEW.relationship_version,fence.mutation_id,
    fence.previous_organization_record_id,fence.organization_record_id,fence.client_record_version,
    fence.previous_organization_record_version,fence.organization_record_version,fence.actor_staff_id,
    fence.actor_access_subject,fence.actor_email,fence.actor_admission_version,fence.actor_profile_version
  FROM operations_directory_live_relationship_fences fence WHERE fence.client_record_id=NEW.client_record_id;
END;
