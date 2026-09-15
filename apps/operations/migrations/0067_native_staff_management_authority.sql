PRAGMA foreign_keys = ON;

CREATE TABLE native_staff_authority_capabilities (
  contract_version INTEGER NOT NULL CHECK(typeof(contract_version)='integer' AND contract_version=1),
  authority_domain TEXT NOT NULL CHECK(authority_domain IN ('directory','staff_admin')),
  capability TEXT NOT NULL CHECK(length(capability) BETWEEN 1 AND 191),
  PRIMARY KEY(contract_version,authority_domain,capability)
);

INSERT INTO native_staff_authority_capabilities(contract_version,authority_domain,capability) VALUES
  (1,'directory','directory.profile.view'),
  (1,'directory','directory.profile.edit'),
  (1,'directory','directory.identity.link'),
  (1,'directory','directory.enrollment.manage'),
  (1,'directory','directory.portal_access.manage'),
  (1,'staff_admin','staff.profile.read'),
  (1,'staff_admin','staff.profile.edit'),
  (1,'staff_admin','staff.effective_access.read'),
  (1,'staff_admin','staff.revocation_impact.read'),
  (1,'staff_admin','staff.onboarding.create'),
  (1,'staff_admin','staff.onboarding.approve'),
  (1,'staff_admin','staff.onboarding.cancel'),
  (1,'staff_admin','staff.admission.enable'),
  (1,'staff_admin','staff.admission.disable'),
  (1,'staff_admin','staff.membership.manage'),
  (1,'staff_admin','staff.directory_grant.manage'),
  (1,'staff_admin','staff.admin_delegation.manage'),
  (1,'staff_admin','staff.identity.recover');

CREATE TRIGGER native_staff_authority_capabilities_no_insert BEFORE INSERT ON native_staff_authority_capabilities
BEGIN SELECT RAISE(ABORT,'native staff authority capability catalog is frozen'); END;
CREATE TRIGGER native_staff_authority_capabilities_no_update BEFORE UPDATE ON native_staff_authority_capabilities
BEGIN SELECT RAISE(ABORT,'native staff authority capability catalog is immutable'); END;
CREATE TRIGGER native_staff_authority_capabilities_no_delete BEFORE DELETE ON native_staff_authority_capabilities
BEGIN SELECT RAISE(ABORT,'native staff authority capability catalog is durable'); END;

CREATE TABLE native_staff_management_delegations (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191 AND instr(id,char(0))=0 AND substr(id,1,1) GLOB '[A-Za-z0-9]' AND id NOT GLOB '*[^A-Za-z0-9:._-]*'),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(contract_version)='integer' AND contract_version=1),
  authority_domain TEXT NOT NULL DEFAULT 'staff_admin' CHECK(authority_domain='staff_admin'),
  capability TEXT NOT NULL,
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','business_area','division','exact_staff')),
  business_area_id TEXT REFERENCES native_business_areas(id) ON DELETE RESTRICT,
  division_id TEXT REFERENCES native_business_divisions(id) ON DELETE RESTRICT,
  target_staff_id TEXT REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(typeof(active)='integer' AND active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  granted_by TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(contract_version,authority_domain,capability)
    REFERENCES native_staff_authority_capabilities(contract_version,authority_domain,capability) ON DELETE RESTRICT,
  FOREIGN KEY(business_area_id,division_id)
    REFERENCES native_business_divisions(business_area_id,id) ON DELETE RESTRICT,
  CHECK((scope_kind='global' AND business_area_id IS NULL AND division_id IS NULL AND target_staff_id IS NULL)
    OR (scope_kind='business_area' AND business_area_id IS NOT NULL AND division_id IS NULL AND target_staff_id IS NULL)
    OR (scope_kind='division' AND business_area_id IS NOT NULL AND division_id IS NOT NULL AND target_staff_id IS NULL)
    OR (scope_kind='exact_staff' AND business_area_id IS NULL AND division_id IS NULL AND target_staff_id IS NOT NULL))
);
CREATE UNIQUE INDEX native_staff_management_delegation_identity ON native_staff_management_delegations
  (actor_staff_id,contract_version,capability,effect,scope_kind,ifnull(business_area_id,''),ifnull(division_id,''),ifnull(target_staff_id,''));
CREATE INDEX native_staff_management_delegations_actor_capability
  ON native_staff_management_delegations(actor_staff_id,capability,active);
CREATE TRIGGER native_staff_management_delegations_insert_guard BEFORE INSERT ON native_staff_management_delegations
WHEN EXISTS(SELECT 1 FROM native_staff_management_delegations row WHERE row.id=NEW.id)
  OR EXISTS(SELECT 1 FROM native_staff_management_delegations row
    WHERE row.actor_staff_id=NEW.actor_staff_id AND row.contract_version=NEW.contract_version
      AND row.capability=NEW.capability AND row.effect=NEW.effect AND row.scope_kind=NEW.scope_kind
      AND row.business_area_id IS NEW.business_area_id AND row.division_id IS NEW.division_id
      AND row.target_staff_id IS NEW.target_staff_id)
BEGIN SELECT RAISE(ABORT,'native staff management delegation identity already exists'); END;
CREATE TRIGGER native_staff_management_delegations_update_guard BEFORE UPDATE ON native_staff_management_delegations
WHEN NEW.id IS NOT OLD.id OR NEW.actor_staff_id IS NOT OLD.actor_staff_id
  OR NEW.contract_version IS NOT OLD.contract_version OR NEW.authority_domain IS NOT OLD.authority_domain
  OR NEW.capability IS NOT OLD.capability OR NEW.effect IS NOT OLD.effect OR NEW.scope_kind IS NOT OLD.scope_kind
  OR NEW.business_area_id IS NOT OLD.business_area_id OR NEW.division_id IS NOT OLD.division_id
  OR NEW.target_staff_id IS NOT OLD.target_staff_id OR NEW.granted_by IS NOT OLD.granted_by
  OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'native staff management delegation update is invalid'); END;
CREATE TRIGGER native_staff_management_delegations_no_delete BEFORE DELETE ON native_staff_management_delegations
BEGIN SELECT RAISE(ABORT,'native staff management delegation is durable'); END;

CREATE TABLE native_staff_delegation_ceilings (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191 AND instr(id,char(0))=0 AND substr(id,1,1) GLOB '[A-Za-z0-9]' AND id NOT GLOB '*[^A-Za-z0-9:._-]*'),
  parent_delegation_id TEXT NOT NULL REFERENCES native_staff_management_delegations(id) ON DELETE RESTRICT,
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(contract_version)='integer' AND contract_version=1),
  authority_domain TEXT NOT NULL CHECK(authority_domain IN ('directory','staff_admin')),
  capability TEXT NOT NULL,
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  grant_allow INTEGER NOT NULL CHECK(typeof(grant_allow)='integer' AND grant_allow IN (0,1)),
  grant_deny INTEGER NOT NULL CHECK(typeof(grant_deny)='integer' AND grant_deny IN (0,1)),
  operation_create INTEGER NOT NULL CHECK(typeof(operation_create)='integer' AND operation_create IN (0,1)),
  operation_revoke INTEGER NOT NULL CHECK(typeof(operation_revoke)='integer' AND operation_revoke IN (0,1)),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','business_area','division','assigned','resource','exact_staff')),
  business_area_id TEXT REFERENCES native_business_areas(id) ON DELETE RESTRICT,
  division_id TEXT REFERENCES native_business_divisions(id) ON DELETE RESTRICT,
  resource_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  target_staff_id TEXT REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  active INTEGER NOT NULL DEFAULT 1 CHECK(typeof(active)='integer' AND active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(contract_version,authority_domain,capability)
    REFERENCES native_staff_authority_capabilities(contract_version,authority_domain,capability) ON DELETE RESTRICT,
  FOREIGN KEY(business_area_id,division_id)
    REFERENCES native_business_divisions(business_area_id,id) ON DELETE RESTRICT,
  CHECK(grant_allow=1 OR grant_deny=1),
  CHECK(operation_create=1 OR operation_revoke=1),
  CHECK((authority_domain='directory' AND scope_kind IN ('global','business_area','division','assigned','resource') AND target_staff_id IS NULL)
    OR (authority_domain='staff_admin' AND scope_kind IN ('global','business_area','division','exact_staff') AND resource_id IS NULL)),
  CHECK((scope_kind IN ('global','assigned') AND business_area_id IS NULL AND division_id IS NULL AND resource_id IS NULL AND target_staff_id IS NULL)
    OR (scope_kind='business_area' AND business_area_id IS NOT NULL AND division_id IS NULL AND resource_id IS NULL AND target_staff_id IS NULL)
    OR (scope_kind='division' AND business_area_id IS NOT NULL AND division_id IS NOT NULL AND resource_id IS NULL AND target_staff_id IS NULL)
    OR (scope_kind='resource' AND business_area_id IS NULL AND division_id IS NULL AND resource_id IS NOT NULL AND target_staff_id IS NULL)
    OR (scope_kind='exact_staff' AND business_area_id IS NULL AND division_id IS NULL AND resource_id IS NULL AND target_staff_id IS NOT NULL))
);
CREATE UNIQUE INDEX native_staff_delegation_ceiling_identity ON native_staff_delegation_ceilings
  (parent_delegation_id,contract_version,authority_domain,capability,effect,grant_allow,grant_deny,
   operation_create,operation_revoke,scope_kind,ifnull(business_area_id,''),ifnull(division_id,''),
   ifnull(resource_id,''),ifnull(target_staff_id,''));
CREATE INDEX native_staff_delegation_ceilings_parent_active
  ON native_staff_delegation_ceilings(parent_delegation_id,active);

CREATE TRIGGER native_staff_delegation_ceilings_insert_guard BEFORE INSERT ON native_staff_delegation_ceilings
WHEN EXISTS(SELECT 1 FROM native_staff_delegation_ceilings row WHERE row.id=NEW.id)
  OR EXISTS(SELECT 1 FROM native_staff_delegation_ceilings row
    WHERE row.parent_delegation_id=NEW.parent_delegation_id AND row.contract_version=NEW.contract_version
      AND row.authority_domain=NEW.authority_domain AND row.capability=NEW.capability AND row.effect=NEW.effect
      AND row.grant_allow=NEW.grant_allow AND row.grant_deny=NEW.grant_deny
      AND row.operation_create=NEW.operation_create AND row.operation_revoke=NEW.operation_revoke
      AND row.scope_kind=NEW.scope_kind AND row.business_area_id IS NEW.business_area_id
      AND row.division_id IS NEW.division_id AND row.resource_id IS NEW.resource_id
      AND row.target_staff_id IS NEW.target_staff_id)
BEGIN SELECT RAISE(ABORT,'native staff delegation ceiling identity already exists'); END;

CREATE TRIGGER native_staff_delegation_ceilings_parent_insert BEFORE INSERT ON native_staff_delegation_ceilings
WHEN NOT EXISTS (
  SELECT 1 FROM native_staff_management_delegations parent
  WHERE parent.id=NEW.parent_delegation_id AND parent.active=1 AND parent.effect='allow'
    AND parent.contract_version=NEW.contract_version
    AND parent.capability=CASE NEW.authority_domain
      WHEN 'directory' THEN 'staff.directory_grant.manage'
      ELSE 'staff.admin_delegation.manage' END
)
BEGIN SELECT RAISE(ABORT,'native staff delegation ceiling parent is invalid'); END;

CREATE TRIGGER native_staff_delegation_ceilings_update_guard BEFORE UPDATE ON native_staff_delegation_ceilings
WHEN NEW.id IS NOT OLD.id OR NEW.parent_delegation_id IS NOT OLD.parent_delegation_id
  OR NEW.contract_version IS NOT OLD.contract_version OR NEW.authority_domain IS NOT OLD.authority_domain
  OR NEW.capability IS NOT OLD.capability OR NEW.effect IS NOT OLD.effect
  OR NEW.grant_allow IS NOT OLD.grant_allow OR NEW.grant_deny IS NOT OLD.grant_deny
  OR NEW.operation_create IS NOT OLD.operation_create OR NEW.operation_revoke IS NOT OLD.operation_revoke
  OR NEW.scope_kind IS NOT OLD.scope_kind OR NEW.business_area_id IS NOT OLD.business_area_id
  OR NEW.division_id IS NOT OLD.division_id OR NEW.resource_id IS NOT OLD.resource_id
  OR NEW.target_staff_id IS NOT OLD.target_staff_id OR NEW.created_at IS NOT OLD.created_at
  OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'native staff delegation ceiling update is invalid'); END;
CREATE TRIGGER native_staff_delegation_ceilings_reactivate_guard BEFORE UPDATE OF active ON native_staff_delegation_ceilings
WHEN OLD.active=0 AND NEW.active=1 AND NOT EXISTS (
  SELECT 1 FROM native_staff_management_delegations parent
  WHERE parent.id=NEW.parent_delegation_id AND parent.active=1 AND parent.effect='allow'
    AND parent.contract_version=NEW.contract_version
    AND parent.capability=CASE NEW.authority_domain
      WHEN 'directory' THEN 'staff.directory_grant.manage'
      ELSE 'staff.admin_delegation.manage' END
)
BEGIN SELECT RAISE(ABORT,'native staff delegation ceiling parent is inactive'); END;
CREATE TRIGGER native_staff_delegation_ceilings_no_delete BEFORE DELETE ON native_staff_delegation_ceilings
BEGIN SELECT RAISE(ABORT,'native staff delegation ceiling is durable'); END;
