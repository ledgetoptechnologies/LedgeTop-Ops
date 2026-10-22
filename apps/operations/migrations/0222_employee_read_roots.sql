-- Explicit employee file-read authority only. Installation grants nobody access
-- and records no host paths, backend URLs, credentials or mounted resources.
CREATE TABLE ops_employee_read_roots (
  root_id TEXT NOT NULL PRIMARY KEY CHECK(length(root_id)=36 AND root_id=lower(root_id)
    AND substr(root_id,9,1)='-' AND substr(root_id,14,1)='-' AND substr(root_id,19,1)='-' AND substr(root_id,24,1)='-'
    AND length(replace(root_id,'-',''))=32 AND replace(root_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  gateway_id TEXT NOT NULL CHECK(length(gateway_id)=36 AND gateway_id=lower(gateway_id)
    AND substr(gateway_id,9,1)='-' AND substr(gateway_id,14,1)='-' AND substr(gateway_id,19,1)='-' AND substr(gateway_id,24,1)='-'
    AND length(replace(gateway_id,'-',''))=32 AND replace(gateway_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  root_generation INTEGER NOT NULL DEFAULT 1 CHECK(typeof(root_generation)='integer' AND root_generation BETWEEN 1 AND 9007199254740991),
  root_fingerprint TEXT NOT NULL CHECK(length(root_fingerprint)=64 AND root_fingerprint NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK(status IN ('active','disabled')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER ops_employee_read_root_insert BEFORE INSERT ON ops_employee_read_roots
WHEN NEW.root_generation<>1
BEGIN SELECT RAISE(ABORT,'employee read root must start at generation one'); END;
CREATE TRIGGER ops_employee_read_root_update BEFORE UPDATE ON ops_employee_read_roots
WHEN NEW.root_id IS NOT OLD.root_id OR NEW.gateway_id IS NOT OLD.gateway_id OR NEW.created_at IS NOT OLD.created_at
  OR NEW.root_generation<>OLD.root_generation+1
BEGIN SELECT RAISE(ABORT,'employee read root identity immutable; advance generation'); END;
CREATE TRIGGER ops_employee_read_root_no_delete BEFORE DELETE ON ops_employee_read_roots
BEGIN SELECT RAISE(ABORT,'employee read root registrations are durable'); END;

CREATE TABLE ops_employee_read_grants (
  grant_id TEXT NOT NULL PRIMARY KEY CHECK(length(grant_id)=36 AND grant_id=lower(grant_id)
    AND substr(grant_id,9,1)='-' AND substr(grant_id,14,1)='-' AND substr(grant_id,19,1)='-' AND substr(grant_id,24,1)='-'
    AND length(replace(grant_id,'-',''))=32 AND replace(grant_id,'-','') NOT GLOB '*[^0-9a-f]*'),
  root_id TEXT NOT NULL REFERENCES ops_employee_read_roots(root_id) ON DELETE RESTRICT,
  root_generation INTEGER NOT NULL CHECK(typeof(root_generation)='integer' AND root_generation BETWEEN 1 AND 9007199254740991),
  root_fingerprint TEXT NOT NULL CHECK(length(root_fingerprint)=64 AND root_fingerprint NOT GLOB '*[^0-9a-f]*'),
  staff_id TEXT NOT NULL REFERENCES native_staff_profiles(staff_id) ON DELETE RESTRICT,
  access_subject TEXT NOT NULL CHECK(length(access_subject) BETWEEN 1 AND 191),
  admission_version INTEGER NOT NULL CHECK(typeof(admission_version)='integer' AND admission_version BETWEEN 1 AND 9007199254740991),
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  grant_generation INTEGER NOT NULL DEFAULT 1 CHECK(typeof(grant_generation)='integer' AND grant_generation BETWEEN 1 AND 9007199254740991),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at BETWEEN 1 AND 253402300799),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ops_employee_read_grants_exact ON ops_employee_read_grants(root_id,staff_id,access_subject,admission_version,active,effect);
CREATE INDEX ops_employee_read_grants_person ON ops_employee_read_grants(staff_id,access_subject,admission_version,active,effect,root_id);
CREATE TRIGGER ops_employee_read_grant_insert BEFORE INSERT ON ops_employee_read_grants
WHEN NEW.grant_generation<>1 OR NOT EXISTS(
  SELECT 1 FROM ops_employee_read_roots root
  JOIN native_staff_admissions admission ON admission.staff_id=NEW.staff_id AND admission.active=1
    AND admission.bound_access_subject=NEW.access_subject AND admission.version=NEW.admission_version
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
  JOIN staff_users staff ON staff.id=profile.staff_id AND staff.status='active' AND staff.access_subject=admission.bound_access_subject
  WHERE root.root_id=NEW.root_id AND root.status='active' AND root.root_generation=NEW.root_generation
    AND root.root_fingerprint=NEW.root_fingerprint)
BEGIN SELECT RAISE(ABORT,'employee read grant requires current exact root and admission'); END;
CREATE TRIGGER ops_employee_read_grant_update BEFORE UPDATE ON ops_employee_read_grants
WHEN NEW.grant_id IS NOT OLD.grant_id OR NEW.root_id IS NOT OLD.root_id OR NEW.root_generation IS NOT OLD.root_generation
  OR NEW.root_fingerprint IS NOT OLD.root_fingerprint OR NEW.staff_id IS NOT OLD.staff_id
  OR NEW.access_subject IS NOT OLD.access_subject OR NEW.admission_version IS NOT OLD.admission_version
  OR NEW.effect IS NOT OLD.effect OR NEW.created_at IS NOT OLD.created_at
  OR NEW.grant_generation<>OLD.grant_generation+1 OR OLD.active=0
BEGIN SELECT RAISE(ABORT,'employee read grant identity immutable; revocation is terminal'); END;
CREATE TRIGGER ops_employee_read_grant_no_delete BEFORE DELETE ON ops_employee_read_grants
BEGIN SELECT RAISE(ABORT,'employee read grant registrations are durable'); END;
