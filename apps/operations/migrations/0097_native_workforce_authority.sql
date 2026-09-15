PRAGMA foreign_keys = ON;

-- This is an Operations-local, default-deny authority contract for the inactive
-- workforce ledger.  It creates neither a route nor a seed grant.  In
-- particular, it has no PA references and intentionally contains no job scope:
-- native jobs and their authority mappings do not exist yet.
CREATE TABLE native_workforce_authority_capabilities (
  contract_version INTEGER NOT NULL CHECK(typeof(contract_version)='integer' AND contract_version=1),
  capability TEXT NOT NULL CHECK(capability IN (
    'time.record.self','time.record.on_behalf','time.submit','time.review',
    'bonus.record.self','bonus.record.on_behalf','bonus.submit','bonus.review')),
  PRIMARY KEY(contract_version,capability)
);

INSERT INTO native_workforce_authority_capabilities(contract_version,capability) VALUES
  (1,'time.record.self'),(1,'time.record.on_behalf'),(1,'time.submit'),(1,'time.review'),
  (1,'bonus.record.self'),(1,'bonus.record.on_behalf'),(1,'bonus.submit'),(1,'bonus.review');

CREATE TRIGGER native_workforce_authority_capabilities_no_insert BEFORE INSERT ON native_workforce_authority_capabilities
BEGIN SELECT RAISE(ABORT,'native workforce authority capability catalog is frozen'); END;
CREATE TRIGGER native_workforce_authority_capabilities_no_update BEFORE UPDATE ON native_workforce_authority_capabilities
BEGIN SELECT RAISE(ABORT,'native workforce authority capability catalog is immutable'); END;
CREATE TRIGGER native_workforce_authority_capabilities_no_delete BEFORE DELETE ON native_workforce_authority_capabilities
BEGIN SELECT RAISE(ABORT,'native workforce authority capability catalog is durable'); END;

-- Exact-project authority refers to the existing canonical Operations project.
-- Its current lifecycle and JSON scopes are revalidated by the read evaluator.

CREATE TABLE native_workforce_authority_grants (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191 AND instr(id,char(0))=0 AND substr(id,1,1) GLOB '[A-Za-z0-9]' AND id NOT GLOB '*[^A-Za-z0-9:._-]*'),
  staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(contract_version)='integer' AND contract_version=1),
  capability TEXT NOT NULL,
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('internal','business_area','division','native_project')),
  business_area_id TEXT REFERENCES native_business_areas(id) ON DELETE RESTRICT,
  division_id TEXT REFERENCES native_business_divisions(id) ON DELETE RESTRICT,
  native_project_id TEXT REFERENCES operations_shared_projects(external_project_id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(typeof(active)='integer' AND active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  granted_by TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(contract_version,capability) REFERENCES native_workforce_authority_capabilities(contract_version,capability) ON DELETE RESTRICT,
  FOREIGN KEY(business_area_id,division_id) REFERENCES native_business_divisions(business_area_id,id) ON DELETE RESTRICT,
  CHECK((scope_kind='internal' AND business_area_id IS NULL AND division_id IS NULL AND native_project_id IS NULL)
    OR (scope_kind='business_area' AND business_area_id IS NOT NULL AND division_id IS NULL AND native_project_id IS NULL)
    OR (scope_kind='division' AND business_area_id IS NOT NULL AND division_id IS NOT NULL AND native_project_id IS NULL)
    OR (scope_kind='native_project' AND business_area_id IS NULL AND division_id IS NULL AND native_project_id IS NOT NULL))
);
CREATE UNIQUE INDEX native_workforce_authority_grant_identity ON native_workforce_authority_grants(
  staff_id,contract_version,capability,effect,scope_kind,ifnull(business_area_id,''),ifnull(division_id,''),ifnull(native_project_id,''));
CREATE INDEX native_workforce_authority_grants_lookup ON native_workforce_authority_grants(staff_id,capability,active);
CREATE TRIGGER native_workforce_authority_grants_insert_guard BEFORE INSERT ON native_workforce_authority_grants
WHEN EXISTS(SELECT 1 FROM native_workforce_authority_grants row WHERE row.id=NEW.id)
  OR EXISTS(SELECT 1 FROM native_workforce_authority_grants row WHERE row.staff_id=NEW.staff_id
    AND row.contract_version=NEW.contract_version AND row.capability=NEW.capability AND row.effect=NEW.effect
    AND row.scope_kind=NEW.scope_kind AND row.business_area_id IS NEW.business_area_id
    AND row.division_id IS NEW.division_id AND row.native_project_id IS NEW.native_project_id)
BEGIN SELECT RAISE(ABORT,'native workforce authority grant identity already exists'); END;
CREATE TRIGGER native_workforce_authority_grants_update_guard BEFORE UPDATE ON native_workforce_authority_grants
WHEN NEW.id IS NOT OLD.id OR NEW.staff_id IS NOT OLD.staff_id OR NEW.contract_version IS NOT OLD.contract_version
  OR NEW.capability IS NOT OLD.capability OR NEW.effect IS NOT OLD.effect OR NEW.scope_kind IS NOT OLD.scope_kind
  OR NEW.business_area_id IS NOT OLD.business_area_id OR NEW.division_id IS NOT OLD.division_id
  OR NEW.native_project_id IS NOT OLD.native_project_id OR NEW.granted_by IS NOT OLD.granted_by
  OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'native workforce authority grant update is invalid'); END;
CREATE TRIGGER native_workforce_authority_grants_no_delete BEFORE DELETE ON native_workforce_authority_grants
BEGIN SELECT RAISE(ABORT,'native workforce authority grant is durable'); END;
