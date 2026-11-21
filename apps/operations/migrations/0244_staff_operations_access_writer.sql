PRAGMA foreign_keys = ON;

-- Native staff Operations-access writer (part B). An owner/admin with
-- roles.manage grants or revokes ONE global allow override for an
-- Ops-onboarded hire per immutable command. Grants are ordinary
-- staff_permission_overrides rows with the canonical id
-- native-ops-access:<staff>:<permission>, so every existing reader works
-- unchanged. There is no deny writer, no division-scoped writer and no runtime
-- switch: applying this migration is the activation step.

-- ===================== REVIEW DEFAULTS (policy) =====================
-- Keep in step with src/worker/staff-operations-access-policy.ts; a mounted
-- test compares both. Grantable set: STAFF_ACCESS_CONTROLS minus the
-- owner-only viewer.storage.purge. requires_explicit_actor_allow=1 marks keys
-- read through hasLocalGlobalAllow: the actor's ceiling for them is its own
-- explicit global override allow, never a role-derived allow.
-- The grant/revoke ceilings themselves are in staff_operations_access_command_authorize
-- (marked "REVIEW DEFAULT" below).
CREATE TABLE staff_operations_access_catalog (
  permission TEXT NOT NULL PRIMARY KEY REFERENCES permissions(key) ON DELETE RESTRICT,
  requires_explicit_actor_allow INTEGER NOT NULL CHECK(requires_explicit_actor_allow IN (0,1))
);
INSERT INTO staff_operations_access_catalog(permission,requires_explicit_actor_allow) VALUES
  ('operations.view_all',1),
  ('sops.assign',0),
  ('delivery.browse',0),
  ('delivery.share.create',0),
  ('delivery.share.revoke',0),
  ('delivery.share.audit',0),
  ('team.view',0),
  ('administration.view',0),
  ('viewer.view',0),
  ('viewer.datasets.manage',0),
  ('viewer.processing.manage',0),
  ('viewer.publish',0),
  ('viewer.share.create',0),
  ('viewer.share.revoke',0),
  ('viewer.manage',0);
-- =================== END REVIEW DEFAULTS (catalog) ===================

CREATE TRIGGER staff_operations_access_catalog_no_insert
BEFORE INSERT ON staff_operations_access_catalog
BEGIN SELECT RAISE(ABORT,'staff_operations_access_catalog_frozen'); END;

CREATE TRIGGER staff_operations_access_catalog_no_update
BEFORE UPDATE ON staff_operations_access_catalog
BEGIN SELECT RAISE(ABORT,'staff_operations_access_catalog_frozen'); END;

CREATE TRIGGER staff_operations_access_catalog_no_delete
BEFORE DELETE ON staff_operations_access_catalog
BEGIN SELECT RAISE(ABORT,'staff_operations_access_catalog_frozen'); END;

-- Immutable provenance only: an approved onboarding whose approval receipt is
-- the matching staff.onboarding.approve command. The override guard protects
-- every such staff id whatever its mutable staff_users flags say.
CREATE VIEW staff_operations_access_native_hires AS
SELECT onboarding.proposed_staff_id staff_id, receipt.actor_staff_id approved_by
FROM native_staff_pending_onboarding onboarding
JOIN native_staff_management_commands receipt ON receipt.command_id=onboarding.approval_command_id
WHERE onboarding.state='approved'
  AND receipt.capability='staff.onboarding.approve'
  AND receipt.target_kind='onboarding'
  AND receipt.target_onboarding_id=onboarding.onboarding_id
  AND receipt.target_proposed_staff_id=onboarding.proposed_staff_id;

-- Writable targets: provenance bound to the materialized row (local,
-- sync-protected, no Project Alpha link, admitted by the approver). The
-- CURRENT identity is checked for internal consistency only; it is not
-- compared with the historical onboarding email or claimed subject.
CREATE VIEW staff_operations_access_targets AS
SELECT hire.staff_id staff_id,
  admission.version admission_version,
  admission.active admission_active,
  CASE WHEN staff.status=CASE admission.active WHEN 1 THEN 'active' ELSE 'inactive' END
    AND staff.email=profile.login_email COLLATE BINARY
    AND staff.access_subject=admission.bound_access_subject
  THEN 1 ELSE 0 END identity_current,
  CASE WHEN staff.id='staff-beau-koltz'
    OR EXISTS(SELECT 1 FROM staff_role_assignments owner_role WHERE owner_role.staff_id=staff.id
      AND owner_role.role_id='role-owner' AND owner_role.scope='global')
    OR EXISTS(SELECT 1 FROM local_staff_role_assignments owner_role WHERE owner_role.staff_id=staff.id
      AND owner_role.role_id='role-owner' AND owner_role.scope='global')
  THEN 1 ELSE 0 END protected_owner
FROM staff_operations_access_native_hires hire
JOIN staff_users staff ON staff.id=hire.staff_id
JOIN native_staff_admissions admission ON admission.staff_id=hire.staff_id
JOIN native_staff_profiles profile ON profile.staff_id=hire.staff_id
WHERE staff.provisioning_source='local' AND staff.sync_protected=1
  AND staff.project_alpha_user_id IS NULL
  AND admission.admitted_by=hire.approved_by;

CREATE TABLE staff_operations_access_commands (
  command_id TEXT NOT NULL PRIMARY KEY
    CHECK(length(command_id)=36 AND command_id GLOB '????????-????-4???-[89ab]???-????????????'
      AND command_id NOT GLOB '*[^0-9a-f-]*'),
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
  permission TEXT NOT NULL REFERENCES staff_operations_access_catalog(permission) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK(operation IN ('grant','revoke')),
  override_id TEXT NOT NULL
    CHECK(override_id='native-ops-access:'||target_staff_id||':'||permission),
  expected_revision INTEGER NOT NULL
    CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
  result_revision INTEGER NOT NULL
    CHECK(typeof(result_revision)='integer' AND result_revision BETWEEN 1 AND 9007199254740991
      AND result_revision=expected_revision+1),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500 AND length(trim(reason))>0 AND instr(reason,char(0))=0),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(julianday(created_at) IS NOT NULL),
  UNIQUE(target_staff_id,result_revision)
);
CREATE INDEX staff_operations_access_commands_override
  ON staff_operations_access_commands(override_id,result_revision);

CREATE TABLE staff_operations_access_state (
  staff_id TEXT NOT NULL PRIMARY KEY REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL
    CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
  command_id TEXT NOT NULL UNIQUE
    REFERENCES staff_operations_access_commands(command_id) ON DELETE RESTRICT
);

-- Every condition is evaluated on live rows inside the write transaction; the
-- route's pre-read only chooses an error code.
CREATE TRIGGER staff_operations_access_command_authorize
BEFORE INSERT ON staff_operations_access_commands
WHEN EXISTS(SELECT 1 FROM staff_operations_access_commands prior WHERE prior.command_id=NEW.command_id)
  OR NEW.actor_verified_until_ms<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
  OR NEW.result_revision<>NEW.expected_revision+1
  OR NEW.override_id<>'native-ops-access:'||NEW.target_staff_id||':'||NEW.permission
  OR NEW.expected_revision<>coalesce((SELECT current.revision FROM staff_operations_access_state current
      WHERE current.staff_id=NEW.target_staff_id),0)
  -- (a) The 0243 actor fence.
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
  -- (b) REVIEW DEFAULT: the global owner/admin gate (prepareAclAdministratorRead).
  OR NOT EXISTS(SELECT 1 FROM staff_role_assignments gate
    WHERE gate.staff_id=NEW.actor_staff_id AND gate.role_id IN ('role-owner','role-admin') AND gate.scope='global')
  -- (c) Global allow for roles.manage, and no roles.manage deny at any scope.
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
      AND permission.effect='deny')
  -- (d) REVIEW DEFAULT: the ceiling applies to grant AND revoke. The actor holds
  -- a global allow for the permission, and no deny for it at any scope.
  -- (e) For explicit-local keys only the actor's own override allow counts.
  OR NOT EXISTS(SELECT 1 FROM staff_operations_access_catalog catalog
    WHERE catalog.permission=NEW.permission AND (
      EXISTS(SELECT 1 FROM staff_permission_overrides own WHERE own.staff_id=NEW.actor_staff_id
        AND own.permission_key=NEW.permission AND own.effect='allow' AND own.scope='global')
      OR (catalog.requires_explicit_actor_allow=0 AND (
        EXISTS(SELECT 1 FROM staff_role_assignments role
          JOIN role_permissions permission ON permission.role_id=role.role_id
          WHERE role.staff_id=NEW.actor_staff_id AND role.scope='global'
            AND permission.permission_key=NEW.permission)
        OR EXISTS(SELECT 1 FROM local_staff_role_assignments role
          JOIN role_permissions permission ON permission.role_id=role.role_id
          WHERE role.staff_id=NEW.actor_staff_id AND role.scope='global'
            AND permission.permission_key=NEW.permission)))))
  OR EXISTS(SELECT 1 FROM staff_permission_overrides deny WHERE deny.staff_id=NEW.actor_staff_id
    AND deny.permission_key=NEW.permission AND deny.effect='deny')
  -- Target: a current, receipt-backed native hire; never self or an owner.
  OR NEW.target_staff_id=NEW.actor_staff_id
  OR NOT EXISTS(SELECT 1 FROM staff_operations_access_targets target
    WHERE target.staff_id=NEW.target_staff_id AND target.identity_current=1 AND target.protected_owner=0
      AND target.admission_version=NEW.target_admission_version
      AND (NEW.operation='revoke' OR target.admission_active=1))
  -- Prestate. A deny wins over any allow, so the writer never works around it.
  OR EXISTS(SELECT 1 FROM staff_permission_overrides deny WHERE deny.staff_id=NEW.target_staff_id
    AND deny.permission_key=NEW.permission AND deny.effect='deny')
  OR (NEW.operation='grant' AND (
    EXISTS(SELECT 1 FROM staff_permission_overrides allowed WHERE allowed.staff_id=NEW.target_staff_id
      AND allowed.permission_key=NEW.permission AND allowed.effect='allow' AND allowed.scope='global')
    OR EXISTS(SELECT 1 FROM staff_role_assignments role
      JOIN role_permissions permission ON permission.role_id=role.role_id
      WHERE role.staff_id=NEW.target_staff_id AND role.scope='global' AND permission.permission_key=NEW.permission)
    OR EXISTS(SELECT 1 FROM local_staff_role_assignments role
      JOIN role_permissions permission ON permission.role_id=role.role_id
      WHERE role.staff_id=NEW.target_staff_id AND role.scope='global' AND permission.permission_key=NEW.permission)))
  -- A revoke removes only the exact command-managed row: canonical id, allow,
  -- global, created by the actor of the latest command for that row (a grant).
  OR (NEW.operation='revoke' AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides managed
    WHERE managed.id=NEW.override_id AND managed.staff_id=NEW.target_staff_id
      AND managed.permission_key=NEW.permission AND managed.effect='allow' AND managed.scope='global'
      AND (SELECT latest.operation||':'||latest.actor_staff_id FROM staff_operations_access_commands latest
        WHERE latest.override_id=managed.id
        ORDER BY latest.result_revision DESC LIMIT 1)='grant:'||managed.created_by))
  -- The 0243 alternate-login block, verbatim.
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
BEGIN SELECT RAISE(ABORT,'staff_operations_access_denied'); END;

CREATE TRIGGER staff_operations_access_command_apply
AFTER INSERT ON staff_operations_access_commands
BEGIN
  INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
    SELECT NEW.override_id,NEW.target_staff_id,NEW.permission,'allow','global',NULL,'global',NEW.actor_staff_id
    WHERE NEW.operation='grant';
  DELETE FROM staff_permission_overrides
    WHERE NEW.operation='revoke' AND id=NEW.override_id AND staff_id=NEW.target_staff_id
      AND permission_key=NEW.permission AND effect='allow' AND scope='global';
  INSERT INTO staff_operations_access_state(staff_id,revision,command_id)
    SELECT NEW.target_staff_id,NEW.result_revision,NEW.command_id WHERE NEW.expected_revision=0;
  UPDATE staff_operations_access_state SET revision=NEW.result_revision,command_id=NEW.command_id
    WHERE staff_id=NEW.target_staff_id AND revision=NEW.expected_revision AND NEW.expected_revision>0;
  SELECT RAISE(ABORT,'staff_operations_access_not_applied')
    WHERE NOT EXISTS(SELECT 1 FROM staff_operations_access_state current
        WHERE current.staff_id=NEW.target_staff_id AND current.revision=NEW.result_revision
          AND current.command_id=NEW.command_id)
      OR (NEW.operation='grant' AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides granted
        WHERE granted.id=NEW.override_id AND granted.staff_id=NEW.target_staff_id
          AND granted.permission_key=NEW.permission AND granted.effect='allow' AND granted.scope='global'
          AND granted.created_by=NEW.actor_staff_id))
      OR (NEW.operation='revoke' AND EXISTS(SELECT 1 FROM staff_permission_overrides remaining
        WHERE remaining.id=NEW.override_id));
END;

CREATE TRIGGER staff_operations_access_commands_no_update
BEFORE UPDATE ON staff_operations_access_commands
BEGIN SELECT RAISE(ABORT,'staff_operations_access_commands_immutable'); END;

CREATE TRIGGER staff_operations_access_commands_no_delete
BEFORE DELETE ON staff_operations_access_commands
BEGIN SELECT RAISE(ABORT,'staff_operations_access_commands_durable'); END;

CREATE TRIGGER staff_operations_access_state_insert
BEFORE INSERT ON staff_operations_access_state
WHEN NEW.revision<>1
  OR EXISTS(SELECT 1 FROM staff_operations_access_state prior WHERE prior.staff_id=NEW.staff_id)
  OR NOT EXISTS(SELECT 1 FROM staff_operations_access_commands command
    WHERE command.command_id=NEW.command_id AND command.target_staff_id=NEW.staff_id
      AND command.expected_revision=0 AND command.result_revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'staff_operations_access_state_requires_command'); END;

CREATE TRIGGER staff_operations_access_state_update
BEFORE UPDATE ON staff_operations_access_state
WHEN NEW.staff_id IS NOT OLD.staff_id OR NEW.revision<>OLD.revision+1
  OR NOT EXISTS(SELECT 1 FROM staff_operations_access_commands command
    WHERE command.command_id=NEW.command_id AND command.target_staff_id=NEW.staff_id
      AND command.expected_revision=OLD.revision AND command.result_revision=NEW.revision)
BEGIN SELECT RAISE(ABORT,'staff_operations_access_state_requires_command'); END;

CREATE TRIGGER staff_operations_access_state_no_delete
BEFORE DELETE ON staff_operations_access_state
BEGIN SELECT RAISE(ABORT,'staff_operations_access_state_durable'); END;

-- Guard on native-hire override rows. Rows of every other staff member are
-- untouched, so legacy writers, readers and a code rollback keep working.
-- An INSERT or DELETE must be the in-flight effect of an unconsumed command
-- (result_revision = state revision + 1); an UPDATE always aborts.
CREATE TRIGGER staff_operations_access_override_insert_guard
BEFORE INSERT ON staff_permission_overrides
WHEN EXISTS(SELECT 1 FROM staff_operations_access_native_hires hire WHERE hire.staff_id=NEW.staff_id)
  AND NOT EXISTS(SELECT 1 FROM staff_operations_access_commands command
    WHERE command.target_staff_id=NEW.staff_id AND command.override_id=NEW.id
      AND command.permission=NEW.permission_key AND command.operation='grant'
      AND command.actor_staff_id=NEW.created_by
      AND NEW.effect='allow' AND NEW.scope='global' AND NEW.division_id IS NULL AND NEW.scope_key='global'
      AND command.expected_revision=coalesce((SELECT current.revision FROM staff_operations_access_state current
        WHERE current.staff_id=NEW.staff_id),0)
      AND command.result_revision=command.expected_revision+1)
BEGIN SELECT RAISE(ABORT,'staff_operations_access_override_requires_command'); END;

CREATE TRIGGER staff_operations_access_override_delete_guard
BEFORE DELETE ON staff_permission_overrides
WHEN EXISTS(SELECT 1 FROM staff_operations_access_native_hires hire WHERE hire.staff_id=OLD.staff_id)
  AND NOT EXISTS(SELECT 1 FROM staff_operations_access_commands command
    WHERE command.target_staff_id=OLD.staff_id AND command.override_id=OLD.id
      AND command.permission=OLD.permission_key AND command.operation='revoke'
      AND OLD.effect='allow' AND OLD.scope='global'
      AND command.expected_revision=coalesce((SELECT current.revision FROM staff_operations_access_state current
        WHERE current.staff_id=OLD.staff_id),0)
      AND command.result_revision=command.expected_revision+1
      AND (SELECT latest.operation||':'||latest.actor_staff_id FROM staff_operations_access_commands latest
        WHERE latest.override_id=OLD.id AND latest.result_revision<=command.expected_revision
        ORDER BY latest.result_revision DESC LIMIT 1)='grant:'||OLD.created_by)
BEGIN SELECT RAISE(ABORT,'staff_operations_access_override_requires_command'); END;

CREATE TRIGGER staff_operations_access_override_update_guard
BEFORE UPDATE ON staff_permission_overrides
WHEN EXISTS(SELECT 1 FROM staff_operations_access_native_hires hire WHERE hire.staff_id IN (OLD.staff_id,NEW.staff_id))
BEGIN SELECT RAISE(ABORT,'staff_operations_access_override_immutable'); END;
