PRAGMA foreign_keys = ON;

-- Separate, unseeded authority for changing an issued 0108 selection.  This
-- does not reuse general workforce grants, owner/staff-admin roles, or PA
-- projections: only an exact admitted actor -> beneficiary delegation and an
-- exact lifecycle ceiling can authorize a mutation.
CREATE TABLE native_workforce_time_beneficiary_selection_lifecycle_delegations (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191 AND instr(id,char(0))=0 AND substr(id,1,1) GLOB '[A-Za-z0-9]' AND id NOT GLOB '*[^A-Za-z0-9:._-]*'),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL CHECK(length(actor_access_subject) BETWEEN 1 AND 191 AND actor_access_subject=trim(actor_access_subject) AND instr(actor_access_subject,char(0))=0),
  beneficiary_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(contract_version)='integer' AND contract_version=1),
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(typeof(active)='integer' AND active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  granted_by TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(actor_staff_id<>beneficiary_staff_id),
  UNIQUE(actor_staff_id,beneficiary_staff_id,contract_version,effect)
);
CREATE TRIGGER native_workforce_time_beneficiary_selection_lifecycle_delegations_insert_guard BEFORE INSERT ON native_workforce_time_beneficiary_selection_lifecycle_delegations
WHEN NOT EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.actor_staff_id AND active=1 AND bound_access_subject=NEW.actor_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection lifecycle delegation is invalid'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_lifecycle_delegations_update_guard BEFORE UPDATE ON native_workforce_time_beneficiary_selection_lifecycle_delegations
WHEN NEW.id IS NOT OLD.id OR NEW.actor_staff_id IS NOT OLD.actor_staff_id OR NEW.actor_access_subject IS NOT OLD.actor_access_subject OR NEW.beneficiary_staff_id IS NOT OLD.beneficiary_staff_id OR NEW.contract_version IS NOT OLD.contract_version OR NEW.effect IS NOT OLD.effect OR NEW.granted_by IS NOT OLD.granted_by OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection lifecycle delegation update is invalid'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_lifecycle_delegations_reactivate_guard BEFORE UPDATE OF active ON native_workforce_time_beneficiary_selection_lifecycle_delegations
WHEN NEW.active=1 AND NOT EXISTS(SELECT 1 FROM native_staff_admissions WHERE staff_id=NEW.actor_staff_id AND active=1 AND bound_access_subject=NEW.actor_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection lifecycle delegation actor is inactive'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_lifecycle_delegations_no_delete BEFORE DELETE ON native_workforce_time_beneficiary_selection_lifecycle_delegations
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection lifecycle delegation is durable'); END;

CREATE TABLE native_workforce_time_beneficiary_selection_lifecycle_ceilings (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191 AND instr(id,char(0))=0 AND substr(id,1,1) GLOB '[A-Za-z0-9]' AND id NOT GLOB '*[^A-Za-z0-9:._-]*'),
  parent_delegation_id TEXT NOT NULL REFERENCES native_workforce_time_beneficiary_selection_lifecycle_delegations(id) ON DELETE RESTRICT,
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(contract_version)='integer' AND contract_version=1),
  operation TEXT NOT NULL CHECK(operation IN ('revoke','reactivate')),
  selection_effect TEXT NOT NULL CHECK(selection_effect IN ('allow','deny')),
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(typeof(active)='integer' AND active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(parent_delegation_id,contract_version,operation,selection_effect,effect)
);
CREATE TRIGGER native_workforce_time_beneficiary_selection_lifecycle_ceilings_insert_guard BEFORE INSERT ON native_workforce_time_beneficiary_selection_lifecycle_ceilings
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_lifecycle_delegations parent JOIN native_staff_admissions actor ON actor.staff_id=parent.actor_staff_id WHERE parent.id=NEW.parent_delegation_id AND parent.contract_version=NEW.contract_version AND parent.effect='allow' AND parent.active=1 AND actor.active=1 AND actor.bound_access_subject=parent.actor_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection lifecycle ceiling is invalid'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_lifecycle_ceilings_update_guard BEFORE UPDATE ON native_workforce_time_beneficiary_selection_lifecycle_ceilings
WHEN NEW.id IS NOT OLD.id OR NEW.parent_delegation_id IS NOT OLD.parent_delegation_id OR NEW.contract_version IS NOT OLD.contract_version OR NEW.operation IS NOT OLD.operation OR NEW.selection_effect IS NOT OLD.selection_effect OR NEW.effect IS NOT OLD.effect OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection lifecycle ceiling update is invalid'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_lifecycle_ceilings_reactivate_guard BEFORE UPDATE OF active ON native_workforce_time_beneficiary_selection_lifecycle_ceilings
WHEN NEW.active=1 AND NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_lifecycle_delegations parent JOIN native_staff_admissions actor ON actor.staff_id=parent.actor_staff_id WHERE parent.id=NEW.parent_delegation_id AND parent.contract_version=NEW.contract_version AND parent.effect='allow' AND parent.active=1 AND actor.active=1 AND actor.bound_access_subject=parent.actor_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection lifecycle ceiling parent is inactive'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_lifecycle_ceilings_no_delete BEFORE DELETE ON native_workforce_time_beneficiary_selection_lifecycle_ceilings
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection lifecycle ceiling is durable'); END;

CREATE TABLE native_workforce_time_beneficiary_selection_lifecycle_audits (
  command_id TEXT NOT NULL PRIMARY KEY,
  selection_delegation_id TEXT NOT NULL REFERENCES native_workforce_time_beneficiary_selection_delegations(id) ON DELETE RESTRICT,
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL CHECK(actor_admission_version>=1),
  beneficiary_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  beneficiary_admission_version INTEGER NOT NULL CHECK(beneficiary_admission_version>=1),
  lifecycle_delegation_id TEXT NOT NULL REFERENCES native_workforce_time_beneficiary_selection_lifecycle_delegations(id) ON DELETE RESTRICT,
  lifecycle_delegation_version INTEGER NOT NULL CHECK(lifecycle_delegation_version>=1),
  lifecycle_ceiling_id TEXT NOT NULL REFERENCES native_workforce_time_beneficiary_selection_lifecycle_ceilings(id) ON DELETE RESTRICT,
  lifecycle_ceiling_version INTEGER NOT NULL CHECK(lifecycle_ceiling_version>=1),
  operation TEXT NOT NULL CHECK(operation IN ('revoke','reactivate')),
  selection_effect TEXT NOT NULL CHECK(selection_effect IN ('allow','deny')),
  selection_previous_version INTEGER NOT NULL CHECK(selection_previous_version>=1),
  selection_version INTEGER NOT NULL CHECK(selection_version=selection_previous_version+1),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(selection_delegation_id,selection_version)
);
CREATE TRIGGER native_workforce_time_beneficiary_selection_lifecycle_audits_insert_guard BEFORE INSERT ON native_workforce_time_beneficiary_selection_lifecycle_audits
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_delegations selection
  JOIN native_staff_admissions actor ON actor.staff_id=NEW.actor_staff_id
  JOIN native_staff_admissions beneficiary ON beneficiary.staff_id=NEW.beneficiary_staff_id
  JOIN native_workforce_time_beneficiary_selection_lifecycle_delegations delegation ON delegation.id=NEW.lifecycle_delegation_id
  JOIN native_workforce_time_beneficiary_selection_lifecycle_ceilings ceiling ON ceiling.id=NEW.lifecycle_ceiling_id
  WHERE selection.id=NEW.selection_delegation_id AND selection.actor_staff_id=NEW.actor_staff_id AND selection.beneficiary_staff_id=NEW.beneficiary_staff_id AND selection.granted_by=NEW.actor_staff_id AND selection.contract_version=1 AND selection.effect=NEW.selection_effect AND selection.version=NEW.selection_version
    AND selection.active=CASE NEW.operation WHEN 'revoke' THEN 0 ELSE 1 END
    AND actor.active=1 AND actor.bound_access_subject=NEW.actor_access_subject AND actor.version=NEW.actor_admission_version
    AND beneficiary.active=1 AND beneficiary.version=NEW.beneficiary_admission_version
    AND delegation.actor_staff_id=NEW.actor_staff_id AND delegation.actor_access_subject=NEW.actor_access_subject AND delegation.beneficiary_staff_id=NEW.beneficiary_staff_id AND delegation.contract_version=1 AND delegation.effect='allow' AND delegation.active=1 AND delegation.version=NEW.lifecycle_delegation_version
    AND NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_lifecycle_delegations denial WHERE denial.actor_staff_id=NEW.actor_staff_id AND denial.actor_access_subject=NEW.actor_access_subject AND denial.beneficiary_staff_id=NEW.beneficiary_staff_id AND denial.contract_version=1 AND denial.effect='deny' AND denial.active=1)
    AND ceiling.parent_delegation_id=delegation.id AND ceiling.contract_version=1 AND ceiling.operation=NEW.operation AND ceiling.selection_effect=NEW.selection_effect AND ceiling.effect='allow' AND ceiling.active=1 AND ceiling.version=NEW.lifecycle_ceiling_version
    AND NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_lifecycle_ceilings denial JOIN native_workforce_time_beneficiary_selection_lifecycle_delegations parent ON parent.id=denial.parent_delegation_id WHERE parent.actor_staff_id=NEW.actor_staff_id AND parent.actor_access_subject=NEW.actor_access_subject AND parent.beneficiary_staff_id=NEW.beneficiary_staff_id AND parent.contract_version=1 AND parent.effect='allow' AND parent.active=1 AND denial.contract_version=1 AND denial.operation=NEW.operation AND denial.selection_effect=NEW.selection_effect AND denial.effect='deny' AND denial.active=1)
)
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection lifecycle is invalid'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_lifecycle_audits_no_update BEFORE UPDATE ON native_workforce_time_beneficiary_selection_lifecycle_audits
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection lifecycle audit is immutable'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_lifecycle_audits_no_delete BEFORE DELETE ON native_workforce_time_beneficiary_selection_lifecycle_audits
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection lifecycle audit is durable'); END;

CREATE TABLE native_workforce_time_beneficiary_selection_lifecycle_receipts (
  command_id TEXT NOT NULL PRIMARY KEY REFERENCES native_workforce_time_beneficiary_selection_lifecycle_audits(command_id) ON DELETE RESTRICT,
  selection_delegation_id TEXT NOT NULL REFERENCES native_workforce_time_beneficiary_selection_delegations(id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER native_workforce_time_beneficiary_selection_lifecycle_receipts_insert_guard BEFORE INSERT ON native_workforce_time_beneficiary_selection_lifecycle_receipts
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_lifecycle_audits audit JOIN native_staff_admissions actor ON actor.staff_id=NEW.actor_staff_id WHERE audit.command_id=NEW.command_id AND audit.selection_delegation_id=NEW.selection_delegation_id AND audit.actor_staff_id=NEW.actor_staff_id AND audit.actor_access_subject=NEW.actor_access_subject AND actor.active=1 AND actor.bound_access_subject=NEW.actor_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection lifecycle receipt is invalid'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_lifecycle_receipts_no_update BEFORE UPDATE ON native_workforce_time_beneficiary_selection_lifecycle_receipts
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection lifecycle receipt is immutable'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_lifecycle_receipts_no_delete BEFORE DELETE ON native_workforce_time_beneficiary_selection_lifecycle_receipts
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection lifecycle receipt is durable'); END;
