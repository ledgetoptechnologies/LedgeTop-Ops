PRAGMA foreign_keys = ON;

-- Forward-only provenance for existing native Directory grants. The backfill
-- is lossless and does not create admissions, grants, scopes, memberships, or
-- authority. Generation is an invalidation fence; history is append-only.
CREATE TABLE native_directory_grant_generations (
  staff_id TEXT NOT NULL PRIMARY KEY REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS updated_at)
);

CREATE TABLE native_directory_grant_history (
  grant_id TEXT NOT NULL REFERENCES native_directory_grants(id) ON DELETE RESTRICT,
  grant_version INTEGER NOT NULL CHECK(typeof(grant_version)='integer' AND grant_version>=1),
  staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  permission TEXT NOT NULL,
  effect TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  business_area_id TEXT,
  division_id TEXT,
  resource_id TEXT,
  active INTEGER NOT NULL CHECK(typeof(active)='integer' AND active IN (0,1)),
  grant_generation INTEGER NOT NULL CHECK(typeof(grant_generation)='integer' AND grant_generation>=1),
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(recorded_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at) IS recorded_at),
  PRIMARY KEY(grant_id,grant_version)
);

INSERT INTO native_directory_grant_generations(staff_id,generation)
SELECT staff_id,COUNT(*) FROM native_directory_grants GROUP BY staff_id;
INSERT INTO native_directory_grant_history(
  grant_id,grant_version,staff_id,permission,effect,scope_kind,business_area_id,division_id,resource_id,active,grant_generation)
SELECT grant.id,1,grant.staff_id,grant.permission,grant.effect,grant.scope_kind,grant.business_area_id,grant.division_id,grant.resource_id,grant.active,generation.generation
FROM native_directory_grants grant JOIN native_directory_grant_generations generation ON generation.staff_id=grant.staff_id;

CREATE TRIGGER native_directory_grant_generations_no_update
BEFORE UPDATE ON native_directory_grant_generations
WHEN NEW.staff_id IS NOT OLD.staff_id OR NEW.generation<>OLD.generation+1
BEGIN SELECT RAISE(ABORT,'native directory grant generation is append-only'); END;
CREATE TRIGGER native_directory_grant_generations_no_delete
BEFORE DELETE ON native_directory_grant_generations
BEGIN SELECT RAISE(ABORT,'native directory grant generation is durable'); END;
CREATE TRIGGER native_directory_grant_history_no_update
BEFORE UPDATE ON native_directory_grant_history
BEGIN SELECT RAISE(ABORT,'native directory grant history is immutable'); END;
CREATE TRIGGER native_directory_grant_history_no_delete
BEFORE DELETE ON native_directory_grant_history
BEGIN SELECT RAISE(ABORT,'native directory grant history is durable'); END;

CREATE TRIGGER native_directory_grants_generation_insert
AFTER INSERT ON native_directory_grants
BEGIN
  INSERT INTO native_directory_grant_generations(staff_id,generation) VALUES(NEW.staff_id,1)
    ON CONFLICT(staff_id) DO UPDATE SET generation=generation+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
  INSERT INTO native_directory_grant_history(grant_id,grant_version,staff_id,permission,effect,scope_kind,business_area_id,division_id,resource_id,active,grant_generation)
    SELECT NEW.id,1,NEW.staff_id,NEW.permission,NEW.effect,NEW.scope_kind,NEW.business_area_id,NEW.division_id,NEW.resource_id,NEW.active,generation
    FROM native_directory_grant_generations WHERE staff_id=NEW.staff_id;
END;
CREATE TRIGGER native_directory_grants_generation_update
AFTER UPDATE ON native_directory_grants
BEGIN
  UPDATE native_directory_grant_generations SET generation=generation+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE staff_id=NEW.staff_id;
  INSERT INTO native_directory_grant_history(grant_id,grant_version,staff_id,permission,effect,scope_kind,business_area_id,division_id,resource_id,active,grant_generation)
    SELECT NEW.id,COALESCE((SELECT MAX(grant_version) FROM native_directory_grant_history WHERE grant_id=NEW.id),0)+1,
      NEW.staff_id,NEW.permission,NEW.effect,NEW.scope_kind,NEW.business_area_id,NEW.division_id,NEW.resource_id,NEW.active,generation
    FROM native_directory_grant_generations WHERE staff_id=NEW.staff_id;
END;
CREATE TRIGGER native_directory_grants_no_delete
BEFORE DELETE ON native_directory_grants
BEGIN SELECT RAISE(ABORT,'native directory grants are durable'); END;

-- Existing lifecycle updates may still toggle active with their normal
-- admission version increment. Subject and admitting principal can no longer
-- be rewritten in place or replaced by delete/reinsert.
DROP TRIGGER native_staff_admissions_identity;
CREATE TRIGGER native_staff_admissions_identity BEFORE UPDATE ON native_staff_admissions
WHEN NEW.staff_id IS NOT OLD.staff_id OR NEW.created_at IS NOT OLD.created_at
  OR NEW.bound_access_subject IS NOT OLD.bound_access_subject OR NEW.admitted_by IS NOT OLD.admitted_by
  OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'native admission update is invalid'); END;
CREATE TRIGGER native_staff_admissions_no_delete BEFORE DELETE ON native_staff_admissions
BEGIN SELECT RAISE(ABORT,'native admissions are durable'); END;
