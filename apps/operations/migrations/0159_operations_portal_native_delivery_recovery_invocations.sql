PRAGMA foreign_keys = ON;

-- One-use, current-manager authorization for manually recovering one exact
-- immutable 0158 command. It cannot create, alter, or broaden folder access.
CREATE TABLE operations_portal_native_delivery_recovery_invocations (
  invocation_id TEXT PRIMARY KEY CHECK(length(invocation_id)=36 AND lower(invocation_id)=invocation_id
    AND invocation_id NOT GLOB '*[^0-9a-f-]*' AND substr(invocation_id,9,1)='-'
    AND substr(invocation_id,14,1)='-' AND substr(invocation_id,15,1)='4'
    AND substr(invocation_id,19,1)='-' AND substr(invocation_id,20,1) GLOB '[89ab]'
    AND substr(invocation_id,24,1)='-'),
  operation_id TEXT NOT NULL REFERENCES operations_portal_native_delivery_authority_commands(operation_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action='recover'),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  command_sha256 TEXT NOT NULL CHECK(length(command_sha256)=64 AND command_sha256 NOT GLOB '*[^0-9a-f]*'),
  operation_fingerprint TEXT NOT NULL CHECK(length(operation_fingerprint)=64 AND operation_fingerprint NOT GLOB '*[^0-9a-f]*'),
  command_action TEXT NOT NULL CHECK(command_action IN ('delivery.grant','delivery.revoke')),
  authority_id TEXT NOT NULL, expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
  resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
  target_id TEXT NOT NULL, root_record_id TEXT NOT NULL, ops_division_id TEXT NOT NULL,
  invoked_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  invoked_access_subject TEXT NOT NULL, invoked_email TEXT NOT NULL,
  invoked_admission_version INTEGER NOT NULL CHECK(invoked_admission_version>=1),
  invoked_profile_version INTEGER NOT NULL CHECK(invoked_profile_version>=1),
  invoked_grant_generation INTEGER NOT NULL CHECK(invoked_grant_generation>=1),
  invoked_verified_until TEXT NOT NULL CHECK(length(invoked_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',invoked_verified_until) IS invoked_verified_until),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500 AND reason=trim(reason) AND instr(reason,char(0))=0),
  state TEXT NOT NULL DEFAULT 'authorized' CHECK(state IN ('authorized','claimed')),
  claim_token TEXT UNIQUE, claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((state='authorized' AND claim_token IS NULL AND claimed_at IS NULL)
    OR (state='claimed' AND length(claim_token)=36 AND lower(claim_token)=claim_token
      AND claim_token NOT GLOB '*[^0-9a-f-]*' AND substr(claim_token,15,1)='4'
      AND substr(claim_token,20,1) GLOB '[89ab]' AND claimed_at IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ',claimed_at) IS claimed_at))
);
CREATE TABLE operations_portal_native_delivery_recovery_invocation_audit (
  invocation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_delivery_recovery_invocations(invocation_id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL, action TEXT NOT NULL, request_fingerprint TEXT NOT NULL,
  command_sha256 TEXT NOT NULL, operation_fingerprint TEXT NOT NULL, command_action TEXT NOT NULL,
  authority_id TEXT NOT NULL, expected_revision INTEGER NOT NULL, resulting_revision INTEGER NOT NULL,
  target_id TEXT NOT NULL, root_record_id TEXT NOT NULL, ops_division_id TEXT NOT NULL,
  invoked_by_staff_id TEXT NOT NULL, invoked_access_subject TEXT NOT NULL, invoked_email TEXT NOT NULL,
  invoked_admission_version INTEGER NOT NULL, invoked_profile_version INTEGER NOT NULL,
  invoked_grant_generation INTEGER NOT NULL, invoked_verified_until TEXT NOT NULL,
  reason TEXT NOT NULL, claim_token TEXT NOT NULL UNIQUE, claimed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TRIGGER operations_portal_native_delivery_recovery_command_guard BEFORE INSERT
ON operations_portal_native_delivery_recovery_invocations
WHEN NEW.state<>'authorized' OR NEW.claim_token IS NOT NULL OR NEW.claimed_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_commands command
   JOIN operations_portal_native_delivery_authorizations original ON original.operation_id=command.operation_id
   JOIN operations_portal_native_delivery_authority_outbox outbox ON outbox.operation_id=command.operation_id
   JOIN operations_portal_native_delivery_authority_heads head ON head.authority_id=command.authority_id
   WHERE command.operation_id=NEW.operation_id AND command.command_sha256=NEW.command_sha256
     AND command.operation_fingerprint=NEW.operation_fingerprint AND command.action=NEW.command_action
     AND command.authority_id=NEW.authority_id AND command.expected_revision=NEW.expected_revision
     AND command.resulting_revision=NEW.resulting_revision AND command.target_id=NEW.target_id
     AND command.root_record_id=NEW.root_record_id AND command.ops_division_id=NEW.ops_division_id
     AND outbox.request_fingerprint=command.command_sha256
     AND outbox.canonical_wire_json=command.canonical_command_json
     AND outbox.state IN ('pending','retry','dispatching')
     AND (outbox.state<>'dispatching' OR outbox.claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     AND head.latest_operation_id=command.operation_id AND head.revision=command.resulting_revision
     AND head.state=CASE command.action WHEN 'delivery.grant' THEN 'active' ELSE 'revoked' END)
BEGIN SELECT RAISE(ABORT,'native delivery recovery command denied'); END;

CREATE TRIGGER operations_portal_native_delivery_recovery_identity_guard BEFORE INSERT
ON operations_portal_native_delivery_recovery_invocations
WHEN NEW.invoked_verified_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR NOT EXISTS(
 SELECT 1 FROM native_staff_admissions admission
 JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
 JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
 WHERE admission.staff_id=NEW.invoked_by_staff_id AND admission.active=1
   AND admission.bound_access_subject=NEW.invoked_access_subject AND admission.version=NEW.invoked_admission_version
   AND profile.login_email=NEW.invoked_email AND profile.version=NEW.invoked_profile_version
   AND generation.generation=NEW.invoked_grant_generation)
BEGIN SELECT RAISE(ABORT,'native delivery recovery identity denied'); END;

CREATE TRIGGER operations_portal_native_delivery_recovery_manager_guard BEFORE INSERT
ON operations_portal_native_delivery_recovery_invocations
WHEN NOT EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=NEW.invoked_by_staff_id
   AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
     OR (role.role_id='role-division-manager' AND role.scope='division' AND role.division_id=NEW.ops_division_id)))
 OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
   WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.effect='allow'
     AND permission.record_id=NEW.root_record_id)
 OR EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
   WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.effect='deny'
     AND permission.record_id=NEW.root_record_id)
BEGIN SELECT RAISE(ABORT,'native delivery recovery manager denied'); END;

CREATE TRIGGER operations_portal_native_delivery_recovery_permission_guard BEFORE INSERT
ON operations_portal_native_delivery_recovery_invocations
WHEN (SELECT count(DISTINCT permission.permission_key) FROM operations_portal_workspace_effective_permissions permission
  WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.effect='allow'
    AND permission.permission_key IN ('projects.view','delivery.browse',
      CASE NEW.command_action WHEN 'delivery.grant' THEN 'delivery.share.create' ELSE 'delivery.share.revoke' END)
    AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=NEW.ops_division_id)))<>3
 OR EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
  WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.effect='deny'
    AND permission.permission_key IN ('projects.view','delivery.browse',
      CASE NEW.command_action WHEN 'delivery.grant' THEN 'delivery.share.create' ELSE 'delivery.share.revoke' END)
    AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=NEW.ops_division_id)))
BEGIN SELECT RAISE(ABORT,'native delivery recovery permission denied'); END;

CREATE TRIGGER operations_portal_native_delivery_recovery_budget_guard BEFORE INSERT
ON operations_portal_native_delivery_recovery_invocations
WHEN (SELECT count(*) FROM operations_portal_native_delivery_recovery_invocations prior
  WHERE prior.operation_id=NEW.operation_id)>=8
BEGIN SELECT RAISE(ABORT,'native delivery recovery budget exhausted'); END;

CREATE TRIGGER operations_portal_native_delivery_recovery_claim_guard BEFORE UPDATE
ON operations_portal_native_delivery_recovery_invocations
WHEN OLD.state<>'authorized' OR NEW.state<>'claimed'
 OR OLD.invocation_id IS NOT NEW.invocation_id OR OLD.operation_id<>NEW.operation_id OR OLD.action<>NEW.action
 OR OLD.request_fingerprint<>NEW.request_fingerprint OR OLD.command_sha256<>NEW.command_sha256
 OR OLD.operation_fingerprint<>NEW.operation_fingerprint OR OLD.command_action<>NEW.command_action
 OR OLD.authority_id<>NEW.authority_id OR OLD.expected_revision<>NEW.expected_revision
 OR OLD.resulting_revision<>NEW.resulting_revision OR OLD.target_id<>NEW.target_id
 OR OLD.root_record_id<>NEW.root_record_id OR OLD.ops_division_id<>NEW.ops_division_id
 OR OLD.invoked_by_staff_id<>NEW.invoked_by_staff_id OR OLD.invoked_access_subject<>NEW.invoked_access_subject
 OR OLD.invoked_email<>NEW.invoked_email OR OLD.invoked_admission_version<>NEW.invoked_admission_version
 OR OLD.invoked_profile_version<>NEW.invoked_profile_version OR OLD.invoked_grant_generation<>NEW.invoked_grant_generation
 OR OLD.invoked_verified_until<>NEW.invoked_verified_until OR OLD.reason<>NEW.reason OR OLD.created_at<>NEW.created_at
 OR NEW.claim_token IS NULL OR NEW.claimed_at IS NULL
 OR NEW.invoked_verified_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_authority_outbox outbox
   WHERE outbox.operation_id=NEW.operation_id AND outbox.state='dispatching' AND outbox.claim_token=NEW.claim_token)
 OR NOT EXISTS(SELECT 1 FROM native_staff_admissions admission
   JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
   JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
   WHERE admission.staff_id=NEW.invoked_by_staff_id AND admission.active=1
     AND admission.bound_access_subject=NEW.invoked_access_subject AND admission.version=NEW.invoked_admission_version
     AND profile.login_email=NEW.invoked_email AND profile.version=NEW.invoked_profile_version
     AND generation.generation=NEW.invoked_grant_generation)
BEGIN SELECT RAISE(ABORT,'native delivery recovery claim denied'); END;

CREATE TRIGGER operations_portal_native_delivery_recovery_claim_command_guard BEFORE UPDATE
ON operations_portal_native_delivery_recovery_invocations WHEN NEW.state='claimed' AND NOT EXISTS(
 SELECT 1 FROM operations_portal_native_delivery_authority_commands command
 JOIN operations_portal_native_delivery_authority_heads head ON head.authority_id=command.authority_id
 JOIN operations_portal_native_delivery_authority_outbox outbox ON outbox.operation_id=command.operation_id
 WHERE command.operation_id=NEW.operation_id AND command.command_sha256=NEW.command_sha256
   AND command.operation_fingerprint=NEW.operation_fingerprint AND command.action=NEW.command_action
   AND command.authority_id=NEW.authority_id AND command.expected_revision=NEW.expected_revision
   AND command.resulting_revision=NEW.resulting_revision AND command.target_id=NEW.target_id
   AND command.root_record_id=NEW.root_record_id AND command.ops_division_id=NEW.ops_division_id
   AND head.latest_operation_id=command.operation_id AND head.revision=command.resulting_revision
   AND head.state=CASE command.action WHEN 'delivery.grant' THEN 'active' ELSE 'revoked' END
   AND outbox.state='dispatching' AND outbox.claim_token=NEW.claim_token
   AND outbox.request_fingerprint=command.command_sha256
   AND outbox.canonical_wire_json=command.canonical_command_json)
BEGIN SELECT RAISE(ABORT,'native delivery recovery claim command denied'); END;

CREATE TRIGGER operations_portal_native_delivery_recovery_claim_manager_guard BEFORE UPDATE
ON operations_portal_native_delivery_recovery_invocations WHEN NEW.state='claimed' AND (
 NOT EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=NEW.invoked_by_staff_id
   AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
     OR (role.role_id='role-division-manager' AND role.scope='division' AND role.division_id=NEW.ops_division_id)))
 OR NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
   WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.effect='allow'
     AND permission.record_id=NEW.root_record_id)
 OR EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
   WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.effect='deny'
     AND permission.record_id=NEW.root_record_id))
BEGIN SELECT RAISE(ABORT,'native delivery recovery claim manager denied'); END;

CREATE TRIGGER operations_portal_native_delivery_recovery_claim_permission_guard BEFORE UPDATE
ON operations_portal_native_delivery_recovery_invocations WHEN NEW.state='claimed' AND (
 (SELECT count(DISTINCT permission.permission_key) FROM operations_portal_workspace_effective_permissions permission
  WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.effect='allow'
    AND permission.permission_key IN ('projects.view','delivery.browse',
      CASE NEW.command_action WHEN 'delivery.grant' THEN 'delivery.share.create' ELSE 'delivery.share.revoke' END)
    AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=NEW.ops_division_id)))<>3
 OR EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
  WHERE permission.staff_id=NEW.invoked_by_staff_id AND permission.effect='deny'
    AND permission.permission_key IN ('projects.view','delivery.browse',
      CASE NEW.command_action WHEN 'delivery.grant' THEN 'delivery.share.create' ELSE 'delivery.share.revoke' END)
    AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=NEW.ops_division_id))))
BEGIN SELECT RAISE(ABORT,'native delivery recovery claim permission denied'); END;

CREATE TRIGGER operations_portal_native_delivery_recovery_audit_guard BEFORE INSERT
ON operations_portal_native_delivery_recovery_invocation_audit
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_recovery_invocations invocation
 WHERE invocation.invocation_id=NEW.invocation_id AND invocation.operation_id=NEW.operation_id
   AND invocation.action=NEW.action AND invocation.request_fingerprint=NEW.request_fingerprint
   AND invocation.command_sha256=NEW.command_sha256 AND invocation.operation_fingerprint=NEW.operation_fingerprint
   AND invocation.command_action=NEW.command_action AND invocation.authority_id=NEW.authority_id
   AND invocation.expected_revision=NEW.expected_revision AND invocation.resulting_revision=NEW.resulting_revision
   AND invocation.target_id=NEW.target_id AND invocation.root_record_id=NEW.root_record_id
   AND invocation.ops_division_id=NEW.ops_division_id AND invocation.invoked_by_staff_id=NEW.invoked_by_staff_id
   AND invocation.invoked_access_subject=NEW.invoked_access_subject AND invocation.invoked_email=NEW.invoked_email
   AND invocation.invoked_admission_version=NEW.invoked_admission_version
   AND invocation.invoked_profile_version=NEW.invoked_profile_version
   AND invocation.invoked_grant_generation=NEW.invoked_grant_generation
   AND invocation.invoked_verified_until=NEW.invoked_verified_until AND invocation.reason=NEW.reason
   AND invocation.state='claimed' AND invocation.claim_token=NEW.claim_token
   AND invocation.claimed_at=NEW.claimed_at)
BEGIN SELECT RAISE(ABORT,'native delivery recovery audit denied'); END;

CREATE TRIGGER operations_portal_native_delivery_recovery_append_audit AFTER UPDATE
ON operations_portal_native_delivery_recovery_invocations WHEN NEW.state='claimed'
BEGIN
  INSERT INTO operations_portal_native_delivery_recovery_invocation_audit
    (invocation_id,operation_id,action,request_fingerprint,command_sha256,operation_fingerprint,command_action,
     authority_id,expected_revision,resulting_revision,target_id,root_record_id,ops_division_id,
     invoked_by_staff_id,invoked_access_subject,invoked_email,invoked_admission_version,invoked_profile_version,
     invoked_grant_generation,invoked_verified_until,reason,claim_token,claimed_at)
  VALUES(NEW.invocation_id,NEW.operation_id,NEW.action,NEW.request_fingerprint,NEW.command_sha256,
    NEW.operation_fingerprint,NEW.command_action,NEW.authority_id,NEW.expected_revision,NEW.resulting_revision,
    NEW.target_id,NEW.root_record_id,NEW.ops_division_id,NEW.invoked_by_staff_id,NEW.invoked_access_subject,
    NEW.invoked_email,NEW.invoked_admission_version,NEW.invoked_profile_version,NEW.invoked_grant_generation,
    NEW.invoked_verified_until,NEW.reason,NEW.claim_token,NEW.claimed_at);
END;

CREATE TRIGGER operations_portal_native_delivery_recovery_invocations_no_delete BEFORE DELETE
ON operations_portal_native_delivery_recovery_invocations
BEGIN SELECT RAISE(ABORT,'native delivery recovery invocation is durable'); END;
CREATE TRIGGER operations_portal_native_delivery_recovery_audit_no_update BEFORE UPDATE
ON operations_portal_native_delivery_recovery_invocation_audit
BEGIN SELECT RAISE(ABORT,'native delivery recovery audit is immutable'); END;
CREATE TRIGGER operations_portal_native_delivery_recovery_audit_no_delete BEFORE DELETE
ON operations_portal_native_delivery_recovery_invocation_audit
BEGIN SELECT RAISE(ABORT,'native delivery recovery audit is durable'); END;
