-- Staff Files write access (contract revision 3). Additive only; 0222/0223 rows, triggers and receipts are untouched.
-- Exclusive roots are created only by `register-exclusive-root`; read-write grants only by `grant-write`. Both commands
-- live in a second append-only command table (SQLite cannot widen the 0223 action CHECK in place). Command ids are unique
-- across both tables, enforced symmetrically inside D1.

ALTER TABLE ops_employee_read_roots ADD COLUMN exclusive INTEGER NOT NULL DEFAULT 0 CHECK(exclusive IN (0,1));
ALTER TABLE ops_employee_read_grants ADD COLUMN rights TEXT NOT NULL DEFAULT 'read' CHECK(rights IN ('read','read-write'));

CREATE TABLE ops_employee_files_write_commands (
  command_id TEXT PRIMARY KEY NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  action TEXT NOT NULL CHECK(action IN ('register-exclusive-root','grant-write')),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_profiles(staff_id),
  actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL CHECK(actor_admission_version>=1),
  actor_profile_version INTEGER NOT NULL CHECK(actor_profile_version>=1),
  actor_email TEXT NOT NULL,
  verified_until TEXT NOT NULL,
  root_id TEXT NOT NULL,
  configured_gateway_id TEXT NOT NULL,
  grant_id TEXT,
  result_generation INTEGER NOT NULL CHECK(result_generation BETWEEN 1 AND 9007199254740991),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER ops_employee_files_write_command_no_update BEFORE UPDATE ON ops_employee_files_write_commands
BEGIN SELECT RAISE(ABORT,'employee command immutable'); END;
CREATE TRIGGER ops_employee_files_write_command_no_delete BEFORE DELETE ON ops_employee_files_write_commands
BEGIN SELECT RAISE(ABORT,'employee command durable'); END;

CREATE TABLE ops_employee_files_write_command_audit (
  command_id TEXT PRIMARY KEY NOT NULL REFERENCES ops_employee_files_write_commands(command_id),
  actor_staff_id TEXT NOT NULL,actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL,actor_profile_version INTEGER NOT NULL,
  action TEXT NOT NULL,root_id TEXT NOT NULL,grant_id TEXT,result_generation INTEGER NOT NULL,
  request_sha256 TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER ops_employee_files_write_audit_no_update BEFORE UPDATE ON ops_employee_files_write_command_audit
BEGIN SELECT RAISE(ABORT,'employee audit immutable'); END;
CREATE TRIGGER ops_employee_files_write_audit_no_delete BEFORE DELETE ON ops_employee_files_write_command_audit
BEGIN SELECT RAISE(ABORT,'employee audit durable'); END;
CREATE TABLE ops_employee_files_write_issuers (
  command_id TEXT PRIMARY KEY NOT NULL REFERENCES ops_employee_files_write_commands(command_id),
  root_id TEXT NOT NULL,root_generation INTEGER NOT NULL,grant_id TEXT,
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_profiles(staff_id)
);
CREATE TRIGGER ops_employee_files_write_issuer_no_update BEFORE UPDATE ON ops_employee_files_write_issuers
BEGIN SELECT RAISE(ABORT,'employee issuer immutable'); END;
CREATE TRIGGER ops_employee_files_write_issuer_no_delete BEFORE DELETE ON ops_employee_files_write_issuers
BEGIN SELECT RAISE(ABORT,'employee issuer durable'); END;

-- Command ids are unique across both tables, symmetrically and inside D1.
CREATE TRIGGER ops_employee_read_command_not_a_write_command BEFORE INSERT ON ops_employee_read_commands
WHEN EXISTS(SELECT 1 FROM ops_employee_files_write_commands w WHERE w.command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'employee command replay conflict'); END;
CREATE TRIGGER ops_employee_files_write_command_not_a_read_command BEFORE INSERT ON ops_employee_files_write_commands
WHEN EXISTS(SELECT 1 FROM ops_employee_read_commands r WHERE r.command_id=NEW.command_id)
BEGIN SELECT RAISE(ABORT,'employee command replay conflict'); END;

-- The same manager fence and replay rule as ops_employee_read_command_authorize (0223).
CREATE TRIGGER ops_employee_files_write_command_authorize BEFORE INSERT ON ops_employee_files_write_commands
BEGIN
  SELECT RAISE(ABORT,'employee administration denied') WHERE NOT EXISTS(
    SELECT 1 FROM native_staff_admissions a JOIN native_staff_profiles p ON p.staff_id=a.staff_id
    JOIN staff_users s ON s.id=a.staff_id
    WHERE a.staff_id=NEW.actor_staff_id AND a.active=1 AND a.bound_access_subject=NEW.actor_access_subject
      AND a.version=NEW.actor_admission_version AND p.version=NEW.actor_profile_version AND p.login_email=NEW.actor_email
      AND s.status='active' AND s.access_subject=a.bound_access_subject AND julianday(NEW.verified_until)>julianday('now')
      AND EXISTS(SELECT 1 FROM staff_role_assignments r WHERE r.staff_id=a.staff_id AND r.scope='global' AND r.role_id IN ('role-owner','role-admin'))
      AND (EXISTS(SELECT 1 FROM staff_role_assignments r JOIN role_permissions rp ON rp.role_id=r.role_id
        WHERE r.staff_id=a.staff_id AND r.scope='global' AND rp.permission_key='employee.files.manage')
        OR EXISTS(SELECT 1 FROM staff_permission_overrides o WHERE o.staff_id=a.staff_id AND o.permission_key='employee.files.manage' AND o.scope='global' AND o.effect='allow'))
      AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides o WHERE o.staff_id=a.staff_id AND o.permission_key='employee.files.manage' AND o.effect='deny')
  );
  SELECT RAISE(ABORT,'employee command replay conflict') WHERE EXISTS(SELECT 1 FROM ops_employee_files_write_commands old WHERE old.command_id=NEW.command_id
    AND (old.request_sha256<>NEW.request_sha256 OR old.actor_staff_id<>NEW.actor_staff_id
      OR old.actor_access_subject<>NEW.actor_access_subject OR old.actor_admission_version<>NEW.actor_admission_version
      OR old.actor_profile_version<>NEW.actor_profile_version OR old.action<>NEW.action OR old.payload_json<>NEW.payload_json));
END;

CREATE TRIGGER ops_employee_files_write_command_preconditions BEFORE INSERT ON ops_employee_files_write_commands
WHEN NOT EXISTS(SELECT 1 FROM ops_employee_files_write_commands old WHERE old.command_id=NEW.command_id)
BEGIN
  SELECT RAISE(ABORT,'employee root conflict') WHERE NEW.action='register-exclusive-root' AND (NEW.result_generation<>1
    OR NEW.root_id<>json_extract(NEW.payload_json,'$.rootId') OR NEW.configured_gateway_id<>json_extract(NEW.payload_json,'$.gatewayId')
    OR EXISTS(SELECT 1 FROM ops_employee_read_roots r WHERE r.root_id=NEW.root_id));
  SELECT RAISE(ABORT,'employee grant conflict') WHERE NEW.action='grant-write' AND (NEW.result_generation<>1 OR NEW.grant_id<>json_extract(NEW.payload_json,'$.grantId')
    OR EXISTS(SELECT 1 FROM ops_employee_read_grants g WHERE g.grant_id=NEW.grant_id)
    OR json_extract(NEW.payload_json,'$.expiresAt')>unixepoch()+2592000
    OR NOT EXISTS(SELECT 1 FROM ops_employee_read_roots r JOIN native_staff_admissions a ON a.staff_id=json_extract(NEW.payload_json,'$.targetStaffId')
      JOIN native_staff_profiles p ON p.staff_id=a.staff_id JOIN staff_users s ON s.id=a.staff_id
      WHERE r.root_id=NEW.root_id AND r.gateway_id=NEW.configured_gateway_id AND r.status='active' AND r.exclusive=1
        AND r.root_generation=json_extract(NEW.payload_json,'$.rootGeneration') AND r.root_fingerprint=json_extract(NEW.payload_json,'$.rootFingerprint')
        AND a.active=1 AND a.bound_access_subject=json_extract(NEW.payload_json,'$.targetAccessSubject')
        AND a.version=json_extract(NEW.payload_json,'$.targetAdmissionVersion') AND s.status='active' AND s.access_subject=a.bound_access_subject
        AND json_extract(NEW.payload_json,'$.expiresAt')>unixepoch()));
END;

CREATE TRIGGER ops_employee_files_write_command_apply AFTER INSERT ON ops_employee_files_write_commands
BEGIN
  INSERT INTO ops_employee_read_roots(root_id,gateway_id,root_generation,root_fingerprint,status,display_name,exclusive)
    SELECT NEW.root_id,NEW.configured_gateway_id,1,json_extract(NEW.payload_json,'$.rootFingerprint'),'active',json_extract(NEW.payload_json,'$.displayName'),1
    WHERE NEW.action='register-exclusive-root';
  INSERT INTO ops_employee_read_grants(grant_id,root_id,root_generation,root_fingerprint,staff_id,access_subject,admission_version,effect,active,grant_generation,expires_at,rights)
    SELECT NEW.grant_id,NEW.root_id,json_extract(NEW.payload_json,'$.rootGeneration'),json_extract(NEW.payload_json,'$.rootFingerprint'),
      json_extract(NEW.payload_json,'$.targetStaffId'),json_extract(NEW.payload_json,'$.targetAccessSubject'),json_extract(NEW.payload_json,'$.targetAdmissionVersion'),
      'allow',1,1,json_extract(NEW.payload_json,'$.expiresAt'),'read-write'
    WHERE NEW.action='grant-write';
  INSERT INTO ops_employee_files_write_command_audit(command_id,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,action,root_id,grant_id,result_generation,request_sha256)
    VALUES(NEW.command_id,NEW.actor_staff_id,NEW.actor_access_subject,NEW.actor_admission_version,NEW.actor_profile_version,NEW.action,NEW.root_id,NEW.grant_id,NEW.result_generation,NEW.request_sha256);
  INSERT INTO ops_employee_files_write_issuers(command_id,root_id,root_generation,grant_id,actor_staff_id)
    SELECT NEW.command_id,NEW.root_id,r.root_generation,NEW.grant_id,NEW.actor_staff_id FROM ops_employee_read_roots r WHERE r.root_id=NEW.root_id;
END;

-- Exclusivity is fixed at enrollment: only its own command creates an exclusive root, and nothing changes it later.
CREATE TRIGGER ops_employee_read_root_exclusive_by_command BEFORE INSERT ON ops_employee_read_roots
WHEN NEW.exclusive<>0 AND NOT EXISTS(SELECT 1 FROM ops_employee_files_write_commands c
  WHERE c.root_id=NEW.root_id AND c.action='register-exclusive-root' AND c.configured_gateway_id=NEW.gateway_id)
BEGIN SELECT RAISE(ABORT,'employee exclusive root requires its enrollment command'); END;
CREATE TRIGGER ops_employee_read_root_exclusive_immutable BEFORE UPDATE OF exclusive ON ops_employee_read_roots
WHEN NEW.exclusive IS NOT OLD.exclusive
BEGIN SELECT RAISE(ABORT,'employee root exclusivity immutable'); END;

-- Rights are fixed at creation; a read-write grant exists only through `grant-write`, on an active exclusive root at the
-- exact generation and fingerprint, as an allow grant expiring within 30 days. Revocation stays terminal (0222 trigger).
CREATE TRIGGER ops_employee_read_grant_rights_immutable BEFORE UPDATE OF rights ON ops_employee_read_grants
WHEN NEW.rights IS NOT OLD.rights
BEGIN SELECT RAISE(ABORT,'employee grant rights immutable'); END;
CREATE TRIGGER ops_employee_read_grant_write_rules BEFORE INSERT ON ops_employee_read_grants
WHEN NEW.rights='read-write' AND (NEW.effect<>'allow' OR NEW.expires_at>unixepoch()+2592000
  OR NOT EXISTS(SELECT 1 FROM ops_employee_files_write_commands c WHERE c.grant_id=NEW.grant_id AND c.action='grant-write' AND c.root_id=NEW.root_id)
  OR NOT EXISTS(SELECT 1 FROM ops_employee_read_roots r WHERE r.root_id=NEW.root_id AND r.status='active' AND r.exclusive=1
    AND r.root_generation=NEW.root_generation AND r.root_fingerprint=NEW.root_fingerprint))
BEGIN SELECT RAISE(ABORT,'employee write grant requires an exclusive root, allow and at most 30 days'); END;
