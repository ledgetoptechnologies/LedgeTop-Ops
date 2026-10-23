ALTER TABLE ops_employee_read_roots ADD COLUMN display_name TEXT NOT NULL DEFAULT 'Server files'
  CHECK(length(display_name) BETWEEN 1 AND 160);
INSERT INTO permissions(key,description) VALUES('employee.files.manage','Manage exact employee file-read root registrations and grants');
INSERT INTO role_permissions(role_id,permission_key) SELECT id,'employee.files.manage' FROM roles WHERE id IN ('role-owner','role-admin');

CREATE TABLE ops_employee_read_commands (
  command_id TEXT PRIMARY KEY NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  action TEXT NOT NULL CHECK(action IN ('register-root','advance-root','grant-read','deny-read','revoke-grant')),
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
CREATE TRIGGER ops_employee_read_command_no_update BEFORE UPDATE ON ops_employee_read_commands
BEGIN SELECT RAISE(ABORT,'employee command immutable'); END;
CREATE TRIGGER ops_employee_read_command_no_delete BEFORE DELETE ON ops_employee_read_commands
BEGIN SELECT RAISE(ABORT,'employee command durable'); END;

CREATE TABLE ops_employee_read_mutation_audit (
  command_id TEXT PRIMARY KEY NOT NULL REFERENCES ops_employee_read_commands(command_id),
  actor_staff_id TEXT NOT NULL,actor_access_subject TEXT NOT NULL,
  actor_admission_version INTEGER NOT NULL,actor_profile_version INTEGER NOT NULL,
  action TEXT NOT NULL,root_id TEXT NOT NULL,grant_id TEXT,result_generation INTEGER NOT NULL,
  request_sha256 TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER ops_employee_read_audit_no_update BEFORE UPDATE ON ops_employee_read_mutation_audit
BEGIN SELECT RAISE(ABORT,'employee audit immutable'); END;
CREATE TRIGGER ops_employee_read_audit_no_delete BEFORE DELETE ON ops_employee_read_mutation_audit
BEGIN SELECT RAISE(ABORT,'employee audit durable'); END;
CREATE TABLE ops_employee_read_issuers (
  command_id TEXT PRIMARY KEY NOT NULL REFERENCES ops_employee_read_commands(command_id),
  root_id TEXT NOT NULL,root_generation INTEGER NOT NULL,grant_id TEXT,
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_profiles(staff_id)
);
CREATE TRIGGER ops_employee_read_issuer_no_update BEFORE UPDATE ON ops_employee_read_issuers
BEGIN SELECT RAISE(ABORT,'employee issuer immutable'); END;
CREATE TRIGGER ops_employee_read_issuer_no_delete BEFORE DELETE ON ops_employee_read_issuers
BEGIN SELECT RAISE(ABORT,'employee issuer durable'); END;

CREATE TRIGGER ops_employee_read_command_authorize BEFORE INSERT ON ops_employee_read_commands
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
  SELECT RAISE(ABORT,'employee command replay conflict') WHERE EXISTS(SELECT 1 FROM ops_employee_read_commands old WHERE old.command_id=NEW.command_id
    AND (old.request_sha256<>NEW.request_sha256 OR old.actor_staff_id<>NEW.actor_staff_id
      OR old.actor_access_subject<>NEW.actor_access_subject OR old.actor_admission_version<>NEW.actor_admission_version
      OR old.actor_profile_version<>NEW.actor_profile_version OR old.action<>NEW.action OR old.payload_json<>NEW.payload_json));
END;

CREATE TRIGGER ops_employee_read_command_preconditions BEFORE INSERT ON ops_employee_read_commands
WHEN NOT EXISTS(SELECT 1 FROM ops_employee_read_commands old WHERE old.command_id=NEW.command_id)
BEGIN
  SELECT RAISE(ABORT,'employee root conflict') WHERE NEW.action='register-root' AND (NEW.result_generation<>1 OR NEW.root_id<>json_extract(NEW.payload_json,'$.rootId')
    OR NEW.configured_gateway_id<>json_extract(NEW.payload_json,'$.gatewayId')
    OR EXISTS(SELECT 1 FROM ops_employee_read_roots r WHERE r.root_id=NEW.root_id));
  SELECT RAISE(ABORT,'employee root conflict') WHERE NEW.action='advance-root' AND NOT EXISTS(SELECT 1 FROM ops_employee_read_roots r WHERE r.root_id=NEW.root_id
    AND r.gateway_id=NEW.configured_gateway_id AND r.root_generation=json_extract(NEW.payload_json,'$.expectedGeneration')
    AND NEW.result_generation=r.root_generation+1);
  SELECT RAISE(ABORT,'employee grant conflict') WHERE NEW.action IN ('grant-read','deny-read') AND (NEW.result_generation<>1 OR NEW.grant_id<>json_extract(NEW.payload_json,'$.grantId')
    OR EXISTS(SELECT 1 FROM ops_employee_read_grants g WHERE g.grant_id=NEW.grant_id)
    OR NOT EXISTS(SELECT 1 FROM ops_employee_read_roots r JOIN native_staff_admissions a ON a.staff_id=json_extract(NEW.payload_json,'$.targetStaffId')
      JOIN native_staff_profiles p ON p.staff_id=a.staff_id JOIN staff_users s ON s.id=a.staff_id
      WHERE r.root_id=NEW.root_id AND r.gateway_id=NEW.configured_gateway_id AND r.status='active'
        AND r.root_generation=json_extract(NEW.payload_json,'$.rootGeneration') AND r.root_fingerprint=json_extract(NEW.payload_json,'$.rootFingerprint')
        AND a.active=1 AND a.bound_access_subject=json_extract(NEW.payload_json,'$.targetAccessSubject')
        AND a.version=json_extract(NEW.payload_json,'$.targetAdmissionVersion') AND s.status='active' AND s.access_subject=a.bound_access_subject
        AND json_extract(NEW.payload_json,'$.expiresAt')>unixepoch()));
  SELECT RAISE(ABORT,'employee grant conflict') WHERE NEW.action='revoke-grant' AND NOT EXISTS(SELECT 1 FROM ops_employee_read_grants g JOIN ops_employee_read_roots r ON r.root_id=g.root_id
    WHERE g.grant_id=NEW.grant_id AND g.root_id=NEW.root_id AND r.gateway_id=NEW.configured_gateway_id AND g.active=1
      AND g.grant_generation=json_extract(NEW.payload_json,'$.expectedGeneration') AND NEW.result_generation=g.grant_generation+1);
END;

CREATE TRIGGER ops_employee_read_command_apply AFTER INSERT ON ops_employee_read_commands
BEGIN
  INSERT INTO ops_employee_read_roots(root_id,gateway_id,root_generation,root_fingerprint,status,display_name)
    SELECT NEW.root_id,NEW.configured_gateway_id,1,json_extract(NEW.payload_json,'$.rootFingerprint'),'active',json_extract(NEW.payload_json,'$.displayName')
    WHERE NEW.action='register-root';
  UPDATE ops_employee_read_roots SET root_generation=NEW.result_generation,root_fingerprint=json_extract(NEW.payload_json,'$.rootFingerprint'),
    status=json_extract(NEW.payload_json,'$.status'),display_name=json_extract(NEW.payload_json,'$.displayName')
    WHERE NEW.action='advance-root' AND root_id=NEW.root_id;
  INSERT INTO ops_employee_read_grants(grant_id,root_id,root_generation,root_fingerprint,staff_id,access_subject,admission_version,effect,active,grant_generation,expires_at)
    SELECT NEW.grant_id,NEW.root_id,json_extract(NEW.payload_json,'$.rootGeneration'),json_extract(NEW.payload_json,'$.rootFingerprint'),
      json_extract(NEW.payload_json,'$.targetStaffId'),json_extract(NEW.payload_json,'$.targetAccessSubject'),json_extract(NEW.payload_json,'$.targetAdmissionVersion'),
      CASE NEW.action WHEN 'grant-read' THEN 'allow' ELSE 'deny' END,1,1,json_extract(NEW.payload_json,'$.expiresAt')
    WHERE NEW.action IN ('grant-read','deny-read');
  UPDATE ops_employee_read_grants SET active=0,grant_generation=NEW.result_generation WHERE NEW.action='revoke-grant' AND grant_id=NEW.grant_id;
  INSERT INTO ops_employee_read_mutation_audit(command_id,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,action,root_id,grant_id,result_generation,request_sha256)
    VALUES(NEW.command_id,NEW.actor_staff_id,NEW.actor_access_subject,NEW.actor_admission_version,NEW.actor_profile_version,NEW.action,NEW.root_id,NEW.grant_id,NEW.result_generation,NEW.request_sha256);
  INSERT INTO ops_employee_read_issuers(command_id,root_id,root_generation,grant_id,actor_staff_id)
    SELECT NEW.command_id,NEW.root_id,r.root_generation,NEW.grant_id,NEW.actor_staff_id FROM ops_employee_read_roots r WHERE r.root_id=NEW.root_id;
END;

CREATE TABLE ops_employee_read_content_starts (
  event_id TEXT PRIMARY KEY NOT NULL,gateway_id TEXT NOT NULL,root_id TEXT NOT NULL,root_generation INTEGER NOT NULL,root_fingerprint TEXT NOT NULL,
  staff_id TEXT NOT NULL,access_subject TEXT NOT NULL,admission_version INTEGER NOT NULL,profile_version INTEGER NOT NULL,
  grant_id TEXT NOT NULL,grant_generation INTEGER NOT NULL,snapshot_id TEXT NOT NULL,sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  path_sha256 TEXT NOT NULL CHECK(length(path_sha256)=64 AND path_sha256 NOT GLOB '*[^0-9a-f]*'),
  range_start INTEGER,range_end INTEGER,verified_until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((range_start IS NULL AND range_end IS NULL) OR (typeof(range_start)='integer' AND typeof(range_end)='integer' AND range_start>=0 AND range_end>=range_start))
);
CREATE TRIGGER ops_employee_content_start_current BEFORE INSERT ON ops_employee_read_content_starts
WHEN NOT EXISTS(SELECT 1 FROM ops_employee_read_roots r JOIN ops_employee_read_grants g ON g.root_id=r.root_id
  JOIN native_staff_admissions a ON a.staff_id=g.staff_id JOIN native_staff_profiles p ON p.staff_id=a.staff_id JOIN staff_users s ON s.id=a.staff_id
  WHERE r.root_id=NEW.root_id AND r.gateway_id=NEW.gateway_id AND r.status='active' AND r.root_generation=NEW.root_generation AND r.root_fingerprint=NEW.root_fingerprint
    AND g.grant_id=NEW.grant_id AND g.grant_generation=NEW.grant_generation AND g.root_generation=r.root_generation AND g.root_fingerprint=r.root_fingerprint
    AND g.staff_id=NEW.staff_id AND g.access_subject=NEW.access_subject AND g.admission_version=NEW.admission_version AND g.active=1 AND g.effect='allow' AND g.expires_at>unixepoch()
    AND a.active=1 AND a.bound_access_subject=NEW.access_subject AND a.version=NEW.admission_version AND p.version=NEW.profile_version
    AND s.status='active' AND s.access_subject=a.bound_access_subject AND julianday(NEW.verified_until)>julianday('now')
    AND NOT EXISTS(SELECT 1 FROM ops_employee_read_grants d WHERE d.root_id=r.root_id AND d.root_generation=r.root_generation AND d.root_fingerprint=r.root_fingerprint
      AND d.staff_id=NEW.staff_id AND d.access_subject=NEW.access_subject AND d.admission_version=NEW.admission_version AND d.effect='deny' AND d.active=1 AND d.expires_at>unixepoch()))
BEGIN SELECT RAISE(ABORT,'employee content authorization changed'); END;
CREATE TRIGGER ops_employee_content_no_update BEFORE UPDATE ON ops_employee_read_content_starts
BEGIN SELECT RAISE(ABORT,'employee content audit immutable'); END;
CREATE TRIGGER ops_employee_content_no_delete BEFORE DELETE ON ops_employee_read_content_starts
BEGIN SELECT RAISE(ABORT,'employee content audit durable'); END;
