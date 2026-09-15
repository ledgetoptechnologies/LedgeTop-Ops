PRAGMA foreign_keys = ON;

-- This Operations-local contract is intentionally unseeded and separate from
-- the frozen authority catalogs. It delegates only the exact beneficiary that
-- an admitted actor may select while recording time on another staff member's
-- behalf; it grants no time-recording capability by itself.
-- There is deliberately no issuance command or bootstrap seed for these rows:
-- direct inserts are a trusted administrative/database operation until a
-- separately reviewed issuance workflow is introduced.
CREATE TABLE native_workforce_time_beneficiary_selection_delegations (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 191 AND instr(id,char(0))=0 AND substr(id,1,1) GLOB '[A-Za-z0-9]' AND id NOT GLOB '*[^A-Za-z0-9:._-]*'),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  beneficiary_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(contract_version)='integer' AND contract_version=1),
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(typeof(active)='integer' AND active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  granted_by TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(actor_staff_id<>beneficiary_staff_id)
);
CREATE UNIQUE INDEX native_workforce_time_beneficiary_selection_identity ON native_workforce_time_beneficiary_selection_delegations(actor_staff_id,beneficiary_staff_id,contract_version,effect);
CREATE INDEX native_workforce_time_beneficiary_selection_lookup ON native_workforce_time_beneficiary_selection_delegations(actor_staff_id,beneficiary_staff_id,active,effect);
CREATE TRIGGER native_workforce_time_beneficiary_selection_insert_guard BEFORE INSERT ON native_workforce_time_beneficiary_selection_delegations
WHEN EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_delegations row WHERE row.id=NEW.id)
  OR EXISTS(SELECT 1 FROM native_workforce_time_beneficiary_selection_delegations row WHERE row.actor_staff_id=NEW.actor_staff_id AND row.beneficiary_staff_id=NEW.beneficiary_staff_id AND row.contract_version=NEW.contract_version AND row.effect=NEW.effect)
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection delegation identity already exists'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_update_guard BEFORE UPDATE ON native_workforce_time_beneficiary_selection_delegations
WHEN NEW.id IS NOT OLD.id OR NEW.actor_staff_id IS NOT OLD.actor_staff_id OR NEW.beneficiary_staff_id IS NOT OLD.beneficiary_staff_id OR NEW.contract_version IS NOT OLD.contract_version OR NEW.effect IS NOT OLD.effect OR NEW.granted_by IS NOT OLD.granted_by OR NEW.created_at IS NOT OLD.created_at OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection delegation update is invalid'); END;
CREATE TRIGGER native_workforce_time_beneficiary_selection_no_delete BEFORE DELETE ON native_workforce_time_beneficiary_selection_delegations
BEGIN SELECT RAISE(ABORT,'native workforce time beneficiary selection delegation is durable'); END;
