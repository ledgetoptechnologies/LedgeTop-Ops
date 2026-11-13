PRAGMA foreign_keys = ON;

-- Per-person controller eligibility is separate from username ownership,
-- active staff status, and the broader flight_logs.view permission.
CREATE TABLE staff_logs_device_eligibility_commands (
  command_id TEXT NOT NULL PRIMARY KEY
    CHECK(length(command_id) BETWEEN 1 AND 191 AND instr(command_id,char(0))=0),
  request_sha256 TEXT NOT NULL
    CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  actor_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  actor_subject TEXT NOT NULL CHECK(length(actor_subject) BETWEEN 1 AND 191 AND instr(actor_subject,char(0))=0),
  actor_email TEXT NOT NULL COLLATE BINARY
    CHECK(length(actor_email) BETWEEN 3 AND 254 AND actor_email=lower(actor_email) COLLATE BINARY
      AND actor_email=trim(actor_email) AND instr(actor_email,'@')>1 AND instr(actor_email,char(0))=0),
  actor_admission_version INTEGER NOT NULL
    CHECK(typeof(actor_admission_version)='integer' AND actor_admission_version BETWEEN 1 AND 9007199254740991),
  actor_profile_version INTEGER NOT NULL
    CHECK(typeof(actor_profile_version)='integer' AND actor_profile_version BETWEEN 1 AND 9007199254740991),
  actor_verified_until_ms INTEGER NOT NULL
    CHECK(typeof(actor_verified_until_ms)='integer' AND actor_verified_until_ms BETWEEN 1 AND 253402300799000),
  actor_login_json TEXT
    CHECK(actor_login_json IS NULL OR (typeof(actor_login_json)='text' AND length(actor_login_json)<=4096 AND json_valid(actor_login_json))),
  target_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  target_admission_version INTEGER NOT NULL
    CHECK(typeof(target_admission_version)='integer' AND target_admission_version BETWEEN 1 AND 9007199254740991),
  expected_revision INTEGER NOT NULL
    CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
  result_revision INTEGER NOT NULL
    CHECK(typeof(result_revision)='integer' AND result_revision BETWEEN 1 AND 9007199254740991
      AND result_revision=expected_revision+1),
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500 AND length(trim(reason))>0 AND instr(reason,char(0))=0),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(julianday(created_at) IS NOT NULL)
);

CREATE TABLE staff_logs_device_eligibility (
  staff_id TEXT NOT NULL PRIMARY KEY REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL
    CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
  admission_version INTEGER NOT NULL
    CHECK(typeof(admission_version)='integer' AND admission_version BETWEEN 1 AND 9007199254740991),
  command_id TEXT NOT NULL UNIQUE
    REFERENCES staff_logs_device_eligibility_commands(command_id) ON DELETE RESTRICT
);
CREATE INDEX staff_logs_device_eligibility_effect ON staff_logs_device_eligibility(effect,staff_id);

CREATE TRIGGER staff_logs_device_command_authorize
BEFORE INSERT ON staff_logs_device_eligibility_commands
WHEN EXISTS(SELECT 1 FROM staff_logs_device_eligibility_commands prior WHERE prior.command_id=NEW.command_id)
  OR NEW.actor_verified_until_ms<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  OR NEW.result_revision<>NEW.expected_revision+1
  OR NEW.expected_revision<>coalesce((SELECT current.revision FROM staff_logs_device_eligibility current
      WHERE current.staff_id=NEW.target_staff_id),0)
  OR NOT EXISTS(
    SELECT 1 FROM native_staff_admissions actor
    JOIN native_staff_profiles actor_profile ON actor_profile.staff_id=actor.staff_id
    JOIN staff_users actor_user ON actor_user.id=actor.staff_id
    WHERE actor.staff_id=NEW.actor_staff_id AND actor.active=1
      AND actor.bound_access_subject=NEW.actor_subject
      AND actor.version=NEW.actor_admission_version
      AND actor_profile.version=NEW.actor_profile_version
      AND actor_profile.login_email=NEW.actor_email COLLATE BINARY
      AND actor_user.email=actor_profile.login_email COLLATE BINARY
      AND actor_user.access_subject=actor.bound_access_subject
      AND actor_user.status='active'
  )
  OR NOT (
    EXISTS(SELECT 1 FROM staff_role_assignments role
      JOIN role_permissions permission ON permission.role_id=role.role_id
      WHERE role.staff_id=NEW.actor_staff_id AND role.scope='global'
        AND permission.permission_key='roles.manage')
    OR EXISTS(SELECT 1 FROM local_staff_role_assignments role
      JOIN role_permissions permission ON permission.role_id=role.role_id
      WHERE role.staff_id=NEW.actor_staff_id AND role.scope='global'
        AND permission.permission_key='roles.manage')
    OR EXISTS(SELECT 1 FROM staff_permission_overrides permission
      WHERE permission.staff_id=NEW.actor_staff_id AND permission.permission_key='roles.manage'
        AND permission.effect='allow' AND permission.scope='global')
  )
  OR EXISTS(SELECT 1 FROM staff_permission_overrides permission
    WHERE permission.staff_id=NEW.actor_staff_id AND permission.permission_key='roles.manage'
      AND permission.effect='deny' AND permission.scope='global')
  OR NOT EXISTS(
    SELECT 1 FROM native_staff_admissions target
    JOIN native_staff_profiles target_profile ON target_profile.staff_id=target.staff_id
    JOIN staff_users target_user ON target_user.id=target.staff_id
    WHERE target.staff_id=NEW.target_staff_id
      AND target.version=NEW.target_admission_version
      AND target_profile.login_email=target_user.email COLLATE BINARY
      AND target_user.access_subject=target.bound_access_subject
      AND target_user.status=CASE target.active WHEN 1 THEN 'active' ELSE 'inactive' END
      AND (NEW.effect='deny' OR target.active=1)
  )
  OR (NEW.actor_login_json IS NOT NULL AND NOT (
    json_type(NEW.actor_login_json)='object'
    AND (SELECT count(*) FROM json_each(NEW.actor_login_json))=11
    AND (SELECT count(DISTINCT key) FROM json_each(NEW.actor_login_json))=11
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.actor_login_json) field
      WHERE field.key NOT IN ('kind','staffId','canonicalEmail','canonicalSubject','issuer','email','subject',
        'expiresAt','bindingId','bindingVersion','generation'))
    AND json_type(NEW.actor_login_json,'$.kind')='text'
    AND json_extract(NEW.actor_login_json,'$.kind')='alternate'
    AND json_type(NEW.actor_login_json,'$.staffId')='text'
    AND json_extract(NEW.actor_login_json,'$.staffId')=NEW.actor_staff_id
    AND json_type(NEW.actor_login_json,'$.canonicalEmail')='text'
    AND json_extract(NEW.actor_login_json,'$.canonicalEmail')=NEW.actor_email COLLATE BINARY
    AND json_type(NEW.actor_login_json,'$.canonicalSubject')='text'
    AND json_extract(NEW.actor_login_json,'$.canonicalSubject')=NEW.actor_subject COLLATE BINARY
    AND json_type(NEW.actor_login_json,'$.issuer')='text'
    AND json_type(NEW.actor_login_json,'$.email')='text'
    AND json_type(NEW.actor_login_json,'$.subject')='text'
    AND json_type(NEW.actor_login_json,'$.expiresAt')='integer'
    AND json_extract(NEW.actor_login_json,'$.expiresAt') BETWEEN 1 AND 253402300799
    AND json_extract(NEW.actor_login_json,'$.expiresAt')*1000=NEW.actor_verified_until_ms
    AND json_type(NEW.actor_login_json,'$.bindingId')='text'
    AND length(json_extract(NEW.actor_login_json,'$.bindingId'))=36
    AND json_extract(NEW.actor_login_json,'$.bindingId') GLOB '????????-????-4???-[89ab]???-????????????'
    AND json_extract(NEW.actor_login_json,'$.bindingId') NOT GLOB '*[^0-9a-f-]*'
    AND json_type(NEW.actor_login_json,'$.bindingVersion')='integer'
    AND json_extract(NEW.actor_login_json,'$.bindingVersion') BETWEEN 1 AND 9007199254740990
    AND json_type(NEW.actor_login_json,'$.generation')='integer'
    AND json_extract(NEW.actor_login_json,'$.generation') BETWEEN 1 AND 9007199254740990
    AND json_extract(NEW.actor_login_json,'$.expiresAt')>CAST((julianday('now')-2440587.5)*86400 AS INTEGER)
    AND EXISTS(
      SELECT 1 FROM staff_login_generations generation
      JOIN staff_login_bindings binding ON binding.staff_id=generation.staff_id
      JOIN staff_login_binding_intents intent ON intent.id=binding.intent_id
      JOIN native_staff_admissions canonical ON canonical.staff_id=binding.staff_id
      JOIN native_staff_profiles canonical_profile ON canonical_profile.staff_id=canonical.staff_id
      JOIN staff_users canonical_user ON canonical_user.id=canonical.staff_id
      WHERE generation.staff_id=NEW.actor_staff_id
        AND generation.generation=json_extract(NEW.actor_login_json,'$.generation')
        AND binding.id=json_extract(NEW.actor_login_json,'$.bindingId')
        AND binding.staff_id=NEW.actor_staff_id
        AND binding.version=json_extract(NEW.actor_login_json,'$.bindingVersion')
        AND binding.status='active'
        AND binding.issuer=json_extract(NEW.actor_login_json,'$.issuer') COLLATE BINARY
        AND binding.login_email=json_extract(NEW.actor_login_json,'$.email') COLLATE BINARY
        AND binding.access_subject=json_extract(NEW.actor_login_json,'$.subject') COLLATE BINARY
        AND binding.login_email<>NEW.actor_email COLLATE NOCASE
        AND intent.status='claimed' AND intent.binding_id=binding.id
        AND intent.staff_id=NEW.actor_staff_id AND intent.issuer=binding.issuer COLLATE BINARY
        AND intent.alternate_email=binding.login_email COLLATE BINARY
        AND intent.canonical_email=canonical_profile.login_email COLLATE BINARY
        AND intent.canonical_subject=canonical.bound_access_subject COLLATE BINARY
        AND canonical.active=1 AND canonical.version=NEW.actor_admission_version
        AND canonical.bound_access_subject=NEW.actor_subject COLLATE BINARY
        AND canonical_profile.version=NEW.actor_profile_version
        AND canonical_profile.login_email=NEW.actor_email COLLATE BINARY
        AND canonical_user.email=canonical_profile.login_email COLLATE BINARY
        AND canonical_user.access_subject=canonical.bound_access_subject COLLATE BINARY
        AND canonical_user.status='active'
    )
  ))
BEGIN SELECT RAISE(ABORT,'logs_device_eligibility_denied'); END;

CREATE TRIGGER staff_logs_device_command_apply
AFTER INSERT ON staff_logs_device_eligibility_commands
BEGIN
  INSERT INTO staff_logs_device_eligibility(staff_id,revision,effect,admission_version,command_id)
    SELECT NEW.target_staff_id,NEW.result_revision,NEW.effect,NEW.target_admission_version,NEW.command_id
    WHERE NEW.expected_revision=0;
  UPDATE staff_logs_device_eligibility
    SET revision=NEW.result_revision,effect=NEW.effect,
      admission_version=NEW.target_admission_version,command_id=NEW.command_id
    WHERE staff_id=NEW.target_staff_id AND revision=NEW.expected_revision
      AND NEW.expected_revision>0;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM staff_logs_device_eligibility current
      WHERE current.staff_id=NEW.target_staff_id AND current.revision=NEW.result_revision
        AND current.effect=NEW.effect AND current.admission_version=NEW.target_admission_version
        AND current.command_id=NEW.command_id)
    THEN RAISE(ABORT,'staff_logs_device_command_not_applied') END;
END;

CREATE TRIGGER staff_logs_device_commands_no_update
BEFORE UPDATE ON staff_logs_device_eligibility_commands
BEGIN SELECT RAISE(ABORT,'staff_logs_device_commands_immutable'); END;

CREATE TRIGGER staff_logs_device_commands_no_delete
BEFORE DELETE ON staff_logs_device_eligibility_commands
BEGIN SELECT RAISE(ABORT,'staff_logs_device_commands_durable'); END;

CREATE TRIGGER staff_logs_device_eligibility_insert
BEFORE INSERT ON staff_logs_device_eligibility
WHEN NOT EXISTS(
  SELECT 1 FROM staff_logs_device_eligibility_commands command
  WHERE command.command_id=NEW.command_id AND command.target_staff_id=NEW.staff_id
    AND command.expected_revision=0 AND command.result_revision=NEW.revision
    AND command.effect=NEW.effect AND command.target_admission_version=NEW.admission_version
    AND NEW.revision=1
    AND NOT EXISTS(SELECT 1 FROM staff_logs_device_eligibility prior WHERE prior.staff_id=NEW.staff_id)
)
BEGIN SELECT RAISE(ABORT,'staff_logs_device_eligibility_requires_command'); END;

CREATE TRIGGER staff_logs_device_eligibility_update
BEFORE UPDATE ON staff_logs_device_eligibility
WHEN NEW.staff_id IS NOT OLD.staff_id OR NEW.revision<>OLD.revision+1
  OR NOT EXISTS(
    SELECT 1 FROM staff_logs_device_eligibility_commands command
    WHERE command.command_id=NEW.command_id AND command.target_staff_id=NEW.staff_id
      AND command.expected_revision=OLD.revision AND command.result_revision=NEW.revision
      AND command.effect=NEW.effect AND command.target_admission_version=NEW.admission_version
  )
BEGIN SELECT RAISE(ABORT,'staff_logs_device_eligibility_requires_command'); END;

CREATE TRIGGER staff_logs_device_eligibility_no_delete
BEFORE DELETE ON staff_logs_device_eligibility
BEGIN SELECT RAISE(ABORT,'staff_logs_device_eligibility_durable'); END;
