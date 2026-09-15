PRAGMA foreign_keys = ON;

-- Canonical identity linkage only. This never enrolls a PA destination or grants
-- portal, billing, or service access. Absence means never decided; a versioned
-- NULL organization means an explicit unlinked decision.
CREATE TABLE operations_directory_client_organizations (
  client_record_id TEXT NOT NULL PRIMARY KEY REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT
    CHECK(length(client_record_id)=36 AND length(replace(client_record_id,'-',''))=32
      AND substr(client_record_id,9,1)='-' AND substr(client_record_id,14,1)='-' AND substr(client_record_id,19,1)='-'
      AND substr(client_record_id,24,1)='-' AND substr(client_record_id,15,1)='4'
      AND substr(client_record_id,20,1) GLOB '[89ab]' AND client_record_id NOT GLOB '*[^0-9a-f-]*'),
  organization_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT
    CHECK(organization_record_id IS NULL OR (length(organization_record_id)=36
      AND length(replace(organization_record_id,'-',''))=32
      AND substr(organization_record_id,9,1)='-' AND substr(organization_record_id,14,1)='-'
      AND substr(organization_record_id,19,1)='-' AND substr(organization_record_id,24,1)='-'
      AND substr(organization_record_id,15,1)='4' AND substr(organization_record_id,20,1) GLOB '[89ab]'
      AND organization_record_id NOT GLOB '*[^0-9a-f-]*')),
  relationship_version INTEGER NOT NULL CHECK(typeof(relationship_version)='integer' AND relationship_version BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX operations_directory_client_organizations_parent ON operations_directory_client_organizations(organization_record_id);

CREATE TABLE operations_directory_relationship_write_fences (
  mutation_id TEXT NOT NULL PRIMARY KEY CHECK(length(mutation_id)=36 AND length(replace(mutation_id,'-',''))=32
    AND substr(mutation_id,9,1)='-' AND substr(mutation_id,14,1)='-' AND substr(mutation_id,19,1)='-'
    AND substr(mutation_id,24,1)='-' AND substr(mutation_id,15,1)='4'
    AND substr(mutation_id,20,1) GLOB '[89ab]' AND mutation_id NOT GLOB '*[^0-9a-f-]*'),
  client_record_id TEXT NOT NULL UNIQUE REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  expected_relationship_version INTEGER NOT NULL CHECK(typeof(expected_relationship_version)='integer'
    AND expected_relationship_version BETWEEN 0 AND 9007199254740990),
  previous_organization_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  organization_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  client_record_version INTEGER NOT NULL CHECK(typeof(client_record_version)='integer' AND client_record_version>=1),
  previous_organization_record_version INTEGER CHECK(previous_organization_record_version>=1),
  organization_record_version INTEGER CHECK(organization_record_version>=1),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191),
  actor_email TEXT NOT NULL CHECK(length(actor_email) BETWEEN 3 AND 254),
  actor_admission_version INTEGER NOT NULL CHECK(typeof(actor_admission_version)='integer' AND actor_admission_version>=1),
  actor_profile_version INTEGER NOT NULL CHECK(typeof(actor_profile_version)='integer' AND actor_profile_version>=1),
  verified_until TEXT NOT NULL CHECK(length(verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',verified_until) IS verified_until),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((previous_organization_record_id IS NULL)=(previous_organization_record_version IS NULL)),
  CHECK((organization_record_id IS NULL)=(organization_record_version IS NULL)),
  CHECK(expected_relationship_version<>0 OR previous_organization_record_id IS NULL),
  CHECK(expected_relationship_version=0 OR previous_organization_record_id IS NOT organization_record_id)
);

CREATE VIEW operations_directory_relationship_fence_resources AS
SELECT mutation_id,client_record_id AS record_id,'client' AS record_kind,client_record_version AS record_version
  FROM operations_directory_relationship_write_fences
UNION ALL
SELECT mutation_id,previous_organization_record_id,'organization',previous_organization_record_version
  FROM operations_directory_relationship_write_fences WHERE previous_organization_record_id IS NOT NULL
UNION ALL
SELECT mutation_id,organization_record_id,'organization',organization_record_version
  FROM operations_directory_relationship_write_fences WHERE organization_record_id IS NOT NULL;

-- The selected authority is never cached. Every guarded write and final fence
-- deletion re-evaluates current native identity, all referenced record versions,
-- active scope parents, both permissions, and every matching deny.
CREATE VIEW operations_directory_live_relationship_fences AS
SELECT fence.* FROM operations_directory_relationship_write_fences fence
JOIN native_staff_admissions admission ON admission.staff_id=fence.actor_staff_id
  AND admission.active=1 AND admission.bound_access_subject=fence.actor_access_subject
  AND admission.version=fence.actor_admission_version
JOIN native_staff_profiles profile ON profile.staff_id=fence.actor_staff_id
  AND profile.version=fence.actor_profile_version AND profile.login_email=fence.actor_email
WHERE fence.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND NOT EXISTS (
    SELECT 1 FROM operations_directory_relationship_fence_resources resource
    LEFT JOIN operations_directory_records record ON record.record_id=resource.record_id
    WHERE resource.mutation_id=fence.mutation_id AND (
      record.record_id IS NULL OR record.record_kind<>resource.record_kind
      OR record.current_version<>resource.record_version
      OR NOT EXISTS(SELECT 1 FROM operations_directory_revisions revision
        WHERE revision.record_id=resource.record_id AND revision.version=resource.record_version)
      OR NOT EXISTS(SELECT 1 FROM native_directory_enrollments enrollment
        WHERE enrollment.record_id=resource.record_id)
      OR EXISTS (SELECT 1 FROM native_directory_resource_scopes scope
        LEFT JOIN native_business_areas area ON area.id=scope.business_area_id
        LEFT JOIN native_business_divisions division ON division.id=scope.division_id
          AND division.business_area_id=scope.business_area_id
        WHERE scope.record_id=resource.record_id AND scope.active=1
          AND (coalesce(area.active,0)<>1 OR (scope.division_id IS NOT NULL AND coalesce(division.active,0)<>1)))
      OR EXISTS (SELECT 1 FROM (
        SELECT 'directory.identity.link' AS permission UNION ALL SELECT 'directory.profile.edit'
      ) needed WHERE
        NOT EXISTS (SELECT 1 FROM native_directory_grants allow_row
          WHERE allow_row.staff_id=fence.actor_staff_id AND allow_row.permission=needed.permission
            AND allow_row.effect='allow' AND allow_row.active=1
            AND (allow_row.scope_kind='global'
              OR (allow_row.scope_kind='resource' AND allow_row.resource_id=resource.record_id)
              OR (allow_row.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
                WHERE assignment.record_id=resource.record_id AND assignment.staff_id=fence.actor_staff_id AND assignment.active=1))
              OR (allow_row.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=resource.record_id AND scope.active=1 AND scope.business_area_id=allow_row.business_area_id))
              OR (allow_row.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=resource.record_id AND scope.active=1 AND scope.division_id=allow_row.division_id))))
        OR EXISTS (SELECT 1 FROM native_directory_grants deny
          WHERE deny.staff_id=fence.actor_staff_id AND deny.permission=needed.permission
            AND deny.effect='deny' AND deny.active=1
            AND (deny.scope_kind='global'
              OR (deny.scope_kind='resource' AND deny.resource_id=resource.record_id)
              OR (deny.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments assignment
                WHERE assignment.record_id=resource.record_id AND assignment.staff_id=fence.actor_staff_id AND assignment.active=1))
              OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=resource.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))
              OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                WHERE scope.record_id=resource.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))
      )
    )
  );

CREATE TABLE operations_directory_client_organization_history (
  client_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  relationship_version INTEGER NOT NULL CHECK(typeof(relationship_version)='integer' AND relationship_version>=1),
  mutation_id TEXT NOT NULL UNIQUE,
  previous_organization_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  organization_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  client_record_version INTEGER NOT NULL,
  previous_organization_record_version INTEGER,
  organization_record_version INTEGER,
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL,
  actor_profile_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(client_record_id,relationship_version),
  CHECK((previous_organization_record_id IS NULL)=(previous_organization_record_version IS NULL)),
  CHECK((organization_record_id IS NULL)=(organization_record_version IS NULL))
);

CREATE TRIGGER operations_directory_relationship_fences_insert_guard BEFORE INSERT ON operations_directory_relationship_write_fences
WHEN EXISTS(SELECT 1 FROM operations_directory_relationship_write_fences WHERE mutation_id=NEW.mutation_id OR client_record_id=NEW.client_record_id)
BEGIN SELECT RAISE(ABORT,'directory relationship fence identity already exists'); END;
CREATE TRIGGER operations_directory_relationship_fences_no_update BEFORE UPDATE ON operations_directory_relationship_write_fences
BEGIN SELECT RAISE(ABORT,'directory relationship fence is immutable'); END;
CREATE TRIGGER operations_directory_relationship_fences_complete BEFORE DELETE ON operations_directory_relationship_write_fences
WHEN NOT EXISTS(SELECT 1 FROM operations_directory_live_relationship_fences live WHERE live.mutation_id=OLD.mutation_id)
  OR NOT EXISTS(SELECT 1 FROM operations_directory_client_organizations relation
    WHERE relation.client_record_id=OLD.client_record_id AND relation.relationship_version=OLD.expected_relationship_version+1
      AND relation.organization_record_id IS OLD.organization_record_id)
  OR NOT EXISTS(SELECT 1 FROM operations_directory_client_organization_history history
    WHERE history.mutation_id=OLD.mutation_id AND history.client_record_id=OLD.client_record_id
      AND history.relationship_version=OLD.expected_relationship_version+1
      AND history.previous_organization_record_id IS OLD.previous_organization_record_id
      AND history.organization_record_id IS OLD.organization_record_id)
BEGIN SELECT RAISE(ABORT,'directory relationship fence is not complete'); END;

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
CREATE TRIGGER operations_directory_client_organization_history_insert_guard BEFORE INSERT ON operations_directory_client_organization_history
WHEN EXISTS(SELECT 1 FROM operations_directory_client_organization_history
    WHERE mutation_id=NEW.mutation_id OR (client_record_id=NEW.client_record_id AND relationship_version=NEW.relationship_version))
  OR NOT EXISTS(SELECT 1 FROM operations_directory_live_relationship_fences fence
    JOIN operations_directory_client_organizations relation ON relation.client_record_id=fence.client_record_id
    WHERE fence.mutation_id=NEW.mutation_id AND fence.client_record_id=NEW.client_record_id
      AND relation.relationship_version=NEW.relationship_version AND relation.organization_record_id IS NEW.organization_record_id
      AND NEW.relationship_version=fence.expected_relationship_version+1
      AND NEW.previous_organization_record_id IS fence.previous_organization_record_id
      AND NEW.organization_record_id IS fence.organization_record_id
      AND NEW.client_record_version=fence.client_record_version
      AND NEW.previous_organization_record_version IS fence.previous_organization_record_version
      AND NEW.organization_record_version IS fence.organization_record_version
      AND NEW.actor_staff_id=fence.actor_staff_id AND NEW.actor_access_subject=fence.actor_access_subject
      AND NEW.actor_email=fence.actor_email AND NEW.actor_admission_version=fence.actor_admission_version
      AND NEW.actor_profile_version=fence.actor_profile_version)
BEGIN SELECT RAISE(ABORT,'directory relationship history requires current native authority'); END;
CREATE TRIGGER operations_directory_client_organization_history_no_update BEFORE UPDATE ON operations_directory_client_organization_history
BEGIN SELECT RAISE(ABORT,'directory relationship history is immutable'); END;
CREATE TRIGGER operations_directory_client_organization_history_no_delete BEFORE DELETE ON operations_directory_client_organization_history
BEGIN SELECT RAISE(ABORT,'directory relationship history is durable'); END;
