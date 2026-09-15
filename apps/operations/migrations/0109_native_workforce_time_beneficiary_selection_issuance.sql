PRAGMA foreign_keys = ON;

-- Unseeded, Operations-only issuer contract for the exact actor -> beneficiary
-- selection introduced by 0108.  This is deliberately distinct from 0101:
-- that contract issues a general workforce capability to its target, while this
-- contract can create only an internal time.record.on_behalf selection binding.
-- It is unmounted and unseeded until a separately reviewed revoke/reactivate
-- workflow exists. Revoking this issuer contract does not cascade to an already
-- issued 0108 selection: activation must remain blocked until a separate,
-- explicit selection revoke/deny lifecycle can immediately disable that row.
CREATE TABLE native_workforce_time_beneficiary_selection_issuer_delegations (
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
CREATE TRIGGER native_workforce_time_beneficiary_selection_issuer_delegations_insert_guard BEFORE INSERT ON native_workforce_time_beneficiary_selection_issuer_delegations
WHEN NOT EXISTS(SELECT 1 FROM native_staff_admissions admission WHERE admission.staff_id=NEW.actor_staff_id AND admission.active=1 AND admission.bound_access_subject=NEW.actor_access_subject)
  OR EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_issuer_delegations row WHERE row.id=NEW.id)
  OR EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_issuer_delegations row WHERE row.actor_staff_id=NEW.actor_staff_id AND row.beneficiary_staff_id=NEW.beneficiary_staff_id AND row.contract_version=NEW.contract_version AND row.effect=NEW.effect)
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection issuer delegation is invalid'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_issuer_delegations_update_guard BEFORE UPDATE ON native_workforce_time_beneficiary_selection_issuer_delegations
WHEN NEW.id IS NOT OLD.id OR NEW.actor_staff_id IS NOT OLD.actor_staff_id OR NEW.actor_access_subject IS NOT OLD.actor_access_subject OR NEW.beneficiary_staff_id IS NOT OLD.beneficiary_staff_id OR NEW.contract_version IS NOT OLD.contract_version OR NEW.effect IS NOT OLD.effect OR NEW.granted_by IS NOT OLD.granted_by OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection issuer delegation update is invalid'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_issuer_delegations_reactivate_guard BEFORE UPDATE OF active ON native_workforce_time_beneficiary_selection_issuer_delegations
WHEN NEW.active=1 AND NOT EXISTS(SELECT 1 FROM native_staff_admissions admission WHERE admission.staff_id=NEW.actor_staff_id AND admission.active=1 AND admission.bound_access_subject=NEW.actor_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection issuer delegation actor is inactive'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_issuer_delegations_no_delete BEFORE DELETE ON native_workforce_time_beneficiary_selection_issuer_delegations
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection issuer delegation is durable'); END;

CREATE TABLE native_workforce_time_beneficiary_selection_issuer_ceilings (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191 AND instr(id,char(0))=0 AND substr(id,1,1) GLOB '[A-Za-z0-9]' AND id NOT GLOB '*[^A-Za-z0-9:._-]*'),
  parent_delegation_id TEXT NOT NULL REFERENCES native_workforce_time_beneficiary_selection_issuer_delegations(id) ON DELETE RESTRICT,
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(contract_version)='integer' AND contract_version=1),
  operation TEXT NOT NULL CHECK(operation='create'),
  selection_effect TEXT NOT NULL CHECK(selection_effect IN ('allow','deny')),
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(typeof(active)='integer' AND active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(parent_delegation_id,contract_version,operation,selection_effect,effect)
);
CREATE TRIGGER native_workforce_time_beneficiary_selection_issuer_ceilings_insert_guard BEFORE INSERT ON native_workforce_time_beneficiary_selection_issuer_ceilings
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_issuer_delegations parent JOIN native_staff_admissions actor ON actor.staff_id=parent.actor_staff_id WHERE parent.id=NEW.parent_delegation_id AND parent.contract_version=NEW.contract_version AND parent.effect='allow' AND parent.active=1 AND actor.active=1 AND actor.bound_access_subject=parent.actor_access_subject)
  OR EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_issuer_ceilings row WHERE row.id=NEW.id)
  OR EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_issuer_ceilings row WHERE row.parent_delegation_id=NEW.parent_delegation_id AND row.contract_version=NEW.contract_version AND row.operation=NEW.operation AND row.selection_effect=NEW.selection_effect AND row.effect=NEW.effect)
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection issuer ceiling is invalid'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_issuer_ceilings_update_guard BEFORE UPDATE ON native_workforce_time_beneficiary_selection_issuer_ceilings
WHEN NEW.id IS NOT OLD.id OR NEW.parent_delegation_id IS NOT OLD.parent_delegation_id OR NEW.contract_version IS NOT OLD.contract_version OR NEW.operation IS NOT OLD.operation OR NEW.selection_effect IS NOT OLD.selection_effect OR NEW.effect IS NOT OLD.effect OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection issuer ceiling update is invalid'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_issuer_ceilings_reactivate_guard BEFORE UPDATE OF active ON native_workforce_time_beneficiary_selection_issuer_ceilings
WHEN NEW.active=1 AND NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_issuer_delegations parent JOIN native_staff_admissions actor ON actor.staff_id=parent.actor_staff_id WHERE parent.id=NEW.parent_delegation_id AND parent.contract_version=NEW.contract_version AND parent.effect='allow' AND parent.active=1 AND actor.active=1 AND actor.bound_access_subject=parent.actor_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection issuer ceiling parent is inactive'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_issuer_ceilings_no_delete BEFORE DELETE ON native_workforce_time_beneficiary_selection_issuer_ceilings
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection issuer ceiling is durable'); END;

CREATE TABLE native_workforce_time_beneficiary_selection_issuances (
  command_id TEXT NOT NULL PRIMARY KEY,
  selection_delegation_id TEXT NOT NULL UNIQUE REFERENCES native_workforce_time_beneficiary_selection_delegations(id) ON DELETE RESTRICT,
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL CHECK(actor_admission_version>=1),
  beneficiary_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  beneficiary_admission_version INTEGER NOT NULL CHECK(beneficiary_admission_version>=1),
  issuer_delegation_id TEXT NOT NULL REFERENCES native_workforce_time_beneficiary_selection_issuer_delegations(id) ON DELETE RESTRICT,
  issuer_delegation_version INTEGER NOT NULL CHECK(issuer_delegation_version>=1),
  issuer_ceiling_id TEXT NOT NULL REFERENCES native_workforce_time_beneficiary_selection_issuer_ceilings(id) ON DELETE RESTRICT,
  issuer_ceiling_version INTEGER NOT NULL CHECK(issuer_ceiling_version>=1),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- The audit insertion is the authority fence: it rechecks every current
-- admission, allow, deny, and selected version in the same D1 batch as 0108's
-- delegation row. Any failure atomically rolls back the new selection.
CREATE TRIGGER native_workforce_time_beneficiary_selection_issuances_insert_guard BEFORE INSERT ON native_workforce_time_beneficiary_selection_issuances
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_delegations selection
  JOIN native_staff_admissions actor ON actor.staff_id=NEW.actor_staff_id
  JOIN native_staff_admissions beneficiary ON beneficiary.staff_id=NEW.beneficiary_staff_id
  JOIN native_workforce_time_beneficiary_selection_issuer_delegations issuer ON issuer.id=NEW.issuer_delegation_id
  JOIN native_workforce_time_beneficiary_selection_issuer_ceilings ceiling ON ceiling.id=NEW.issuer_ceiling_id
  WHERE selection.id=NEW.selection_delegation_id AND selection.actor_staff_id=NEW.actor_staff_id AND selection.beneficiary_staff_id=NEW.beneficiary_staff_id AND selection.granted_by=NEW.actor_staff_id AND selection.contract_version=1 AND selection.active=1 AND selection.version=1
    AND actor.active=1 AND actor.bound_access_subject=NEW.actor_access_subject AND actor.version=NEW.actor_admission_version
    AND beneficiary.active=1 AND beneficiary.version=NEW.beneficiary_admission_version
    AND issuer.actor_staff_id=NEW.actor_staff_id AND issuer.actor_access_subject=NEW.actor_access_subject AND issuer.beneficiary_staff_id=NEW.beneficiary_staff_id AND issuer.contract_version=1 AND issuer.effect='allow' AND issuer.active=1 AND issuer.version=NEW.issuer_delegation_version
    AND NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_issuer_delegations denial WHERE denial.actor_staff_id=NEW.actor_staff_id AND denial.actor_access_subject=NEW.actor_access_subject AND denial.beneficiary_staff_id=NEW.beneficiary_staff_id AND denial.contract_version=1 AND denial.effect='deny' AND denial.active=1)
    AND ceiling.parent_delegation_id=issuer.id AND ceiling.contract_version=1 AND ceiling.operation='create' AND ceiling.selection_effect=selection.effect AND ceiling.effect='allow' AND ceiling.active=1 AND ceiling.version=NEW.issuer_ceiling_version
    AND NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_issuer_ceilings denial JOIN native_workforce_time_beneficiary_selection_issuer_delegations parent ON parent.id=denial.parent_delegation_id WHERE parent.actor_staff_id=NEW.actor_staff_id AND parent.actor_access_subject=NEW.actor_access_subject AND parent.beneficiary_staff_id=NEW.beneficiary_staff_id AND parent.contract_version=1 AND parent.effect='allow' AND parent.active=1 AND denial.contract_version=1 AND denial.operation='create' AND denial.selection_effect=selection.effect AND denial.effect='deny' AND denial.active=1)
)
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection issuance is invalid'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_issuances_no_update BEFORE UPDATE ON native_workforce_time_beneficiary_selection_issuances
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection issuance is immutable'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_issuances_no_delete BEFORE DELETE ON native_workforce_time_beneficiary_selection_issuances
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection issuance is durable'); END;

CREATE TABLE native_workforce_time_beneficiary_selection_issuance_receipts (
  command_id TEXT NOT NULL PRIMARY KEY REFERENCES native_workforce_time_beneficiary_selection_issuances(command_id) ON DELETE RESTRICT,
  selection_delegation_id TEXT NOT NULL UNIQUE REFERENCES native_workforce_time_beneficiary_selection_delegations(id) ON DELETE RESTRICT,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_access_subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER native_workforce_time_beneficiary_selection_issuance_receipts_insert_guard BEFORE INSERT ON native_workforce_time_beneficiary_selection_issuance_receipts
WHEN NOT EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_issuances issuance JOIN native_staff_admissions actor ON actor.staff_id=NEW.actor_staff_id WHERE issuance.command_id=NEW.command_id AND issuance.selection_delegation_id=NEW.selection_delegation_id AND issuance.actor_staff_id=NEW.actor_staff_id AND issuance.actor_access_subject=NEW.actor_access_subject AND actor.active=1 AND actor.bound_access_subject=NEW.actor_access_subject)
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection issuance receipt is invalid'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_issuance_receipts_no_update BEFORE UPDATE ON native_workforce_time_beneficiary_selection_issuance_receipts
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection issuance receipt is immutable'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_issuance_receipts_no_delete BEFORE DELETE ON native_workforce_time_beneficiary_selection_issuance_receipts
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection issuance receipt is durable'); END;
