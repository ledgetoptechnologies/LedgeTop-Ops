PRAGMA foreign_keys = ON;

-- Inactive, Operations-local governance for future workforce-grant issuance.
-- This neither creates a workforce grant nor adopts any staff-administration
-- authority.  A future executor must still revalidate these rows in its own
-- primary-D1 transaction before it writes a grant or receipt.
CREATE TABLE native_workforce_grant_manager_delegations (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191 AND instr(id,char(0))=0 AND substr(id,1,1) GLOB '[A-Za-z0-9]' AND id NOT GLOB '*[^A-Za-z0-9:._-]*'),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191 AND actor_access_subject=trim(actor_access_subject) AND instr(actor_access_subject,char(0))=0),
  target_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(contract_version)='integer' AND contract_version=1),
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(typeof(active)='integer' AND active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  granted_by TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(actor_staff_id,contract_version,effect,target_staff_id)
);
CREATE INDEX native_workforce_grant_manager_delegations_actor_target
  ON native_workforce_grant_manager_delegations(actor_staff_id,target_staff_id,active);
CREATE TRIGGER native_workforce_grant_manager_delegations_insert_guard BEFORE INSERT ON native_workforce_grant_manager_delegations
WHEN NOT EXISTS(SELECT 1 FROM native_staff_admissions admission WHERE admission.staff_id=NEW.actor_staff_id
  AND admission.active=1 AND admission.bound_access_subject=NEW.actor_access_subject)
  OR EXISTS(SELECT 1 FROM native_workforce_grant_manager_delegations row WHERE row.id=NEW.id)
  OR EXISTS(SELECT 1 FROM native_workforce_grant_manager_delegations row WHERE row.actor_staff_id=NEW.actor_staff_id
    AND row.contract_version=NEW.contract_version AND row.effect=NEW.effect AND row.target_staff_id=NEW.target_staff_id)
BEGIN SELECT RAISE(ABORT,'native workforce grant manager delegation is invalid'); END;
CREATE TRIGGER native_workforce_grant_manager_delegations_update_guard BEFORE UPDATE ON native_workforce_grant_manager_delegations
WHEN NEW.id IS NOT OLD.id OR NEW.actor_staff_id IS NOT OLD.actor_staff_id OR NEW.actor_access_subject IS NOT OLD.actor_access_subject
  OR NEW.target_staff_id IS NOT OLD.target_staff_id OR NEW.contract_version IS NOT OLD.contract_version OR NEW.effect IS NOT OLD.effect
  OR NEW.granted_by IS NOT OLD.granted_by OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'native workforce grant manager delegation update is invalid'); END;
CREATE TRIGGER native_workforce_grant_manager_delegations_reactivate_guard BEFORE UPDATE OF active ON native_workforce_grant_manager_delegations
WHEN NEW.active=1 AND NOT EXISTS(SELECT 1 FROM native_staff_admissions admission WHERE admission.staff_id=NEW.actor_staff_id
  AND admission.active=1 AND admission.bound_access_subject=NEW.actor_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce grant manager delegation actor is inactive'); END;
CREATE TRIGGER native_workforce_grant_manager_delegations_no_delete BEFORE DELETE ON native_workforce_grant_manager_delegations
BEGIN SELECT RAISE(ABORT,'native workforce grant manager delegation is durable'); END;

-- A ceiling is one exact tuple.  It therefore cannot accidentally authorize a
-- second operation, grant effect, capability, or scope kind.  Deny ceilings
-- are represented explicitly; a later evaluator gives every matching deny
-- precedence over an allow and treats a missing ceiling as deny.
CREATE TABLE native_workforce_grant_issuer_ceilings (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191 AND instr(id,char(0))=0 AND substr(id,1,1) GLOB '[A-Za-z0-9]' AND id NOT GLOB '*[^A-Za-z0-9:._-]*'),
  parent_delegation_id TEXT NOT NULL REFERENCES native_workforce_grant_manager_delegations(id) ON DELETE RESTRICT,
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(contract_version)='integer' AND contract_version=1),
  operation TEXT NOT NULL CHECK(operation IN ('create','revoke','reactivate')),
  grant_effect TEXT NOT NULL CHECK(grant_effect IN ('allow','deny')),
  capability TEXT NOT NULL,
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('internal','business_area','division','native_project')),
  business_area_id TEXT REFERENCES native_business_areas(id) ON DELETE RESTRICT,
  division_id TEXT REFERENCES native_business_divisions(id) ON DELETE RESTRICT,
  native_project_id TEXT REFERENCES operations_shared_projects(external_project_id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(typeof(active)='integer' AND active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(contract_version,capability) REFERENCES native_workforce_authority_capabilities(contract_version,capability) ON DELETE RESTRICT,
  FOREIGN KEY(business_area_id,division_id) REFERENCES native_business_divisions(business_area_id,id) ON DELETE RESTRICT,
  CHECK((scope_kind='internal' AND business_area_id IS NULL AND division_id IS NULL AND native_project_id IS NULL)
    OR (scope_kind='business_area' AND business_area_id IS NOT NULL AND division_id IS NULL AND native_project_id IS NULL)
    OR (scope_kind='division' AND business_area_id IS NOT NULL AND division_id IS NOT NULL AND native_project_id IS NULL)
    OR (scope_kind='native_project' AND business_area_id IS NULL AND division_id IS NULL AND native_project_id IS NOT NULL)),
  UNIQUE(parent_delegation_id,contract_version,operation,grant_effect,capability,effect,scope_kind,
    business_area_id,division_id,native_project_id)
);
CREATE UNIQUE INDEX native_workforce_grant_issuer_ceiling_identity ON native_workforce_grant_issuer_ceilings(
  parent_delegation_id,contract_version,operation,grant_effect,capability,effect,scope_kind,
  ifnull(business_area_id,''),ifnull(division_id,''),ifnull(native_project_id,''));
CREATE INDEX native_workforce_grant_issuer_ceilings_parent_active
  ON native_workforce_grant_issuer_ceilings(parent_delegation_id,capability,active);
CREATE TRIGGER native_workforce_grant_issuer_ceilings_insert_guard BEFORE INSERT ON native_workforce_grant_issuer_ceilings
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_grant_manager_delegations parent
  JOIN native_staff_admissions actor ON actor.staff_id=parent.actor_staff_id
  WHERE parent.id=NEW.parent_delegation_id AND parent.contract_version=NEW.contract_version
    AND parent.effect='allow' AND parent.active=1 AND actor.active=1
    AND actor.bound_access_subject=parent.actor_access_subject)
  OR EXISTS(SELECT 1 FROM native_workforce_grant_issuer_ceilings row WHERE row.id=NEW.id)
  OR EXISTS(SELECT 1 FROM native_workforce_grant_issuer_ceilings row WHERE row.parent_delegation_id=NEW.parent_delegation_id
    AND row.contract_version=NEW.contract_version AND row.operation=NEW.operation AND row.grant_effect=NEW.grant_effect
    AND row.capability=NEW.capability AND row.effect=NEW.effect AND row.scope_kind=NEW.scope_kind
    AND row.business_area_id IS NEW.business_area_id AND row.division_id IS NEW.division_id AND row.native_project_id IS NEW.native_project_id)
BEGIN SELECT RAISE(ABORT,'native workforce grant issuer ceiling is invalid'); END;
CREATE TRIGGER native_workforce_grant_issuer_ceilings_update_guard BEFORE UPDATE ON native_workforce_grant_issuer_ceilings
WHEN NEW.id IS NOT OLD.id OR NEW.parent_delegation_id IS NOT OLD.parent_delegation_id OR NEW.contract_version IS NOT OLD.contract_version
  OR NEW.operation IS NOT OLD.operation OR NEW.grant_effect IS NOT OLD.grant_effect OR NEW.capability IS NOT OLD.capability
  OR NEW.effect IS NOT OLD.effect OR NEW.scope_kind IS NOT OLD.scope_kind OR NEW.business_area_id IS NOT OLD.business_area_id
  OR NEW.division_id IS NOT OLD.division_id OR NEW.native_project_id IS NOT OLD.native_project_id
  OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'native workforce grant issuer ceiling update is invalid'); END;
CREATE TRIGGER native_workforce_grant_issuer_ceilings_reactivate_guard BEFORE UPDATE OF active ON native_workforce_grant_issuer_ceilings
WHEN NEW.active=1 AND NOT EXISTS(SELECT 1 FROM native_workforce_grant_manager_delegations parent
  JOIN native_staff_admissions actor ON actor.staff_id=parent.actor_staff_id
  WHERE parent.id=NEW.parent_delegation_id AND parent.contract_version=NEW.contract_version
    AND parent.effect='allow' AND parent.active=1 AND actor.active=1
    AND actor.bound_access_subject=parent.actor_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce grant issuer ceiling parent is inactive'); END;
CREATE TRIGGER native_workforce_grant_issuer_ceilings_no_delete BEFORE DELETE ON native_workforce_grant_issuer_ceilings
BEGIN SELECT RAISE(ABORT,'native workforce grant issuer ceiling is durable'); END;
