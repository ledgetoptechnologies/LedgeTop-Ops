PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=ON;

CREATE TABLE operations_portal_native_workspace_cleanup_commands (
  operation_id TEXT PRIMARY KEY,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_fingerprint TEXT NOT NULL UNIQUE CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  canonical_wire_json TEXT NOT NULL CHECK(json_valid(canonical_wire_json) AND json_type(canonical_wire_json)='object'
    AND length(CAST(canonical_wire_json AS BLOB))<=32768),
  target_id TEXT NOT NULL UNIQUE,
  target_revision INTEGER NOT NULL CHECK(target_revision>=1),
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  creation_operation_id TEXT NOT NULL REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  expected_ownership_epoch INTEGER NOT NULL CHECK(expected_ownership_epoch>=1),
  resulting_ownership_epoch INTEGER NOT NULL CHECK(resulting_ownership_epoch=expected_ownership_epoch+1),
  authorized_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  authorized_access_subject TEXT NOT NULL,
  authorized_admission_version INTEGER NOT NULL CHECK(authorized_admission_version>=1),
  authorized_profile_version INTEGER NOT NULL CHECK(authorized_profile_version>=1),
  authorized_grant_generation INTEGER NOT NULL CHECK(authorized_grant_generation>=1),
  authorized_verified_until TEXT NOT NULL CHECK(length(authorized_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',authorized_verified_until) IS authorized_verified_until),
  reason TEXT NOT NULL CHECK(length(reason)<=500 AND length(trim(reason)) BETWEEN 1 AND 500 AND instr(reason,char(0))=0),
  observed_at TEXT NOT NULL CHECK(length(observed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) IS observed_at),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_native_workspace_cleanup_outbox (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_workspace_cleanup_commands(operation_id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL,
  canonical_wire_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','acknowledged')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  available_at INTEGER NOT NULL DEFAULT(unixepoch()*1000),
  lease_token TEXT,
  lease_expires_at INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((lease_token IS NULL AND lease_expires_at IS NULL)
    OR (state='claimed' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

-- A fresh, currently authorized owner may explicitly retry the exact frozen
-- cleanup wire. The invocation is one-use and cannot alter that command.
CREATE TABLE operations_portal_native_workspace_cleanup_invocations (
  invocation_id TEXT PRIMARY KEY CHECK(length(invocation_id)=36 AND lower(invocation_id)=invocation_id
    AND invocation_id NOT GLOB '*[^0-9a-f-]*' AND substr(invocation_id,15,1)='4'
    AND substr(invocation_id,20,1) GLOB '[89ab]'),
  operation_id TEXT NOT NULL REFERENCES operations_portal_native_workspace_cleanup_commands(operation_id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL,
  target_id TEXT NOT NULL,
  root_record_id TEXT NOT NULL,
  invoked_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  invoked_access_subject TEXT NOT NULL,
  invoked_email TEXT NOT NULL,
  invoked_admission_version INTEGER NOT NULL CHECK(invoked_admission_version>=1),
  invoked_profile_version INTEGER NOT NULL CHECK(invoked_profile_version>=1),
  invoked_grant_generation INTEGER NOT NULL CHECK(invoked_grant_generation>=1),
  invoked_verified_until TEXT NOT NULL CHECK(length(invoked_verified_until)=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',invoked_verified_until) IS invoked_verified_until),
  state TEXT NOT NULL DEFAULT 'authorized' CHECK(state IN ('authorized','claimed')),
  claim_token TEXT UNIQUE,
  claimed_at TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((state='authorized' AND claim_token IS NULL AND claimed_at IS NULL)
    OR (state='claimed' AND claim_token IS NOT NULL AND claimed_at IS NOT NULL))
);

CREATE TABLE operations_portal_native_workspace_cleanup_invocation_audit (
  invocation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_workspace_cleanup_invocations(invocation_id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  target_id TEXT NOT NULL,
  root_record_id TEXT NOT NULL,
  invoked_by_staff_id TEXT NOT NULL,
  invoked_access_subject TEXT NOT NULL,
  invoked_email TEXT NOT NULL,
  invoked_admission_version INTEGER NOT NULL,
  invoked_profile_version INTEGER NOT NULL,
  invoked_grant_generation INTEGER NOT NULL,
  invoked_verified_until TEXT NOT NULL,
  claim_token TEXT NOT NULL UNIQUE,
  claimed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_native_workspace_cleanup_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_workspace_cleanup_outbox(operation_id) ON DELETE RESTRICT,
  request_fingerprint TEXT NOT NULL,
  target_id TEXT NOT NULL,
  ownership_epoch INTEGER NOT NULL CHECK(ownership_epoch>=2),
  resulting_state TEXT NOT NULL CHECK(resulting_state='revoked'),
  recorded_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE operations_portal_native_workspace_cleanup_finalizations (
  operation_id TEXT PRIMARY KEY REFERENCES operations_portal_native_workspace_cleanup_receipts(operation_id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL,
  prior_state TEXT NOT NULL CHECK(prior_state='revoking'),
  resulting_state TEXT NOT NULL CHECK(resulting_state='revoked'),
  ownership_epoch INTEGER NOT NULL CHECK(ownership_epoch>=2),
  finalized_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The original head reserved revoked_operation_id for the unified command
-- table, but workspace.revoke has no recipient operation to satisfy that FK.
-- Rebuild the workspace head and its recipient-head child together so the
-- exact workspace revocation operation references the forward cleanup ledger
-- without changing any existing row values or breaking populated FK closure.
DROP TRIGGER operations_portal_native_authority_command_guard;
DROP TRIGGER operations_portal_native_recipient_operation_request_guard;
DROP TRIGGER operations_portal_native_workspace_head_insert_guard;
DROP TRIGGER operations_portal_native_recipient_head_insert_guard;
DROP TRIGGER operations_portal_native_recipient_head_update_guard;
DROP TRIGGER operations_portal_native_recipient_heads_no_delete;
DROP TRIGGER operations_portal_native_binding_revoke_guard;
DROP TRIGGER operations_portal_native_workspace_finalize_guard;
DROP TRIGGER operations_portal_workspace_revoke_native_authority_guard;
DROP TRIGGER operations_portal_native_workspace_heads_no_delete;
CREATE TABLE operations_portal_native_workspace_authority_heads_v2 (
  target_id TEXT PRIMARY KEY REFERENCES operations_portal_workspace_reservation_heads(target_id) ON DELETE RESTRICT,
  target_revision INTEGER NOT NULL,
  client_authority_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL UNIQUE,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('organization','standalone_client')),
  root_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  ownership_epoch INTEGER NOT NULL CHECK(ownership_epoch>=1),
  state TEXT NOT NULL CHECK(state IN ('provisioning','active','revoking','revoked')),
  creation_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  latest_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  created_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_access_subject TEXT NOT NULL,
  created_admission_version INTEGER NOT NULL,
  created_profile_version INTEGER NOT NULL,
  created_grant_generation INTEGER NOT NULL,
  revoked_by_staff_id TEXT REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  revoked_operation_id TEXT UNIQUE REFERENCES operations_portal_native_workspace_cleanup_commands(operation_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((state IN ('provisioning','active') AND revoked_by_staff_id IS NULL AND revoked_operation_id IS NULL)
    OR (state IN ('revoking','revoked') AND revoked_by_staff_id IS NOT NULL AND revoked_operation_id IS NOT NULL))
);
INSERT INTO operations_portal_native_workspace_authority_heads_v2 SELECT * FROM operations_portal_native_workspace_authority_heads;
CREATE TABLE operations_portal_native_recipient_authority_heads_v2 (
  recipient_binding_id TEXT PRIMARY KEY REFERENCES client_onboarding_recipient_identity_bindings(binding_id) ON DELETE RESTRICT,
  enrollment_intent_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_recipient_intents(intent_id) ON DELETE RESTRICT,
  target_id TEXT NOT NULL REFERENCES operations_portal_native_workspace_authority_heads_v2(target_id) ON DELETE RESTRICT,
  target_client_record_id TEXT NOT NULL REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  ownership_epoch INTEGER NOT NULL CHECK(ownership_epoch>=1),
  grant_revision INTEGER NOT NULL CHECK(grant_revision>=1),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  permission_schema_version INTEGER NOT NULL CHECK(permission_schema_version=3),
  permissions_json TEXT NOT NULL CHECK((state='active' AND permissions_json='["operations.service_home.read"]')
    OR (state='revoked' AND permissions_json='[]')),
  expires_at TEXT CHECK(expires_at IS NULL OR (length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at)),
  creation_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  latest_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  created_by_staff_id TEXT NOT NULL REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  created_access_subject TEXT NOT NULL,
  created_admission_version INTEGER NOT NULL,
  created_profile_version INTEGER NOT NULL,
  created_grant_generation INTEGER NOT NULL,
  revoked_by_staff_id TEXT REFERENCES native_staff_admissions(staff_id) ON DELETE RESTRICT,
  revoked_operation_id TEXT UNIQUE REFERENCES operations_portal_native_authority_commands(operation_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((state='active' AND revoked_by_staff_id IS NULL AND revoked_operation_id IS NULL)
    OR (state='revoked' AND revoked_by_staff_id IS NOT NULL AND revoked_operation_id IS NOT NULL))
);
INSERT INTO operations_portal_native_recipient_authority_heads_v2
SELECT * FROM operations_portal_native_recipient_authority_heads;
DROP TABLE operations_portal_native_recipient_authority_heads;
DROP TABLE operations_portal_native_workspace_authority_heads;
ALTER TABLE operations_portal_native_workspace_authority_heads_v2 RENAME TO operations_portal_native_workspace_authority_heads;
ALTER TABLE operations_portal_native_recipient_authority_heads_v2 RENAME TO operations_portal_native_recipient_authority_heads;
CREATE UNIQUE INDEX operations_portal_native_recipient_one_current_principal
  ON operations_portal_native_recipient_authority_heads(target_id,issuer,subject) WHERE state='active';

-- New grants, confirmation, and cancellation still require the current target
-- topology. Revocation alone may use the immutable active authority lineage so
-- an ownership/relationship drift cannot strand an already granted recipient.
CREATE TRIGGER operations_portal_native_recipient_operation_request_guard
BEFORE INSERT ON operations_portal_native_recipient_operations
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_recipient_intents intent
  WHERE intent.intent_id=NEW.intent_id
    AND json_extract(NEW.canonical_request_json,'$.request.expectedRevision') IS NEW.expected_revision
    AND ((NEW.action='issue' AND intent.state='issued' AND intent.revision=1 AND NEW.expected_revision=0
        AND (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.request'))=6
        AND json_extract(NEW.canonical_request_json,'$.request.targetId')=intent.target_id
        AND json_extract(NEW.canonical_request_json,'$.request.targetRevision')=intent.target_revision
        AND json_extract(NEW.canonical_request_json,'$.request.targetClientRecordId')=intent.target_client_record_id
        AND json_extract(NEW.canonical_request_json,'$.request.targetRelationshipVersion')=intent.target_relationship_version
        AND json_extract(NEW.canonical_request_json,'$.request.expiresAt')=intent.expires_at)
      OR (NEW.action='redeem' AND intent.state='issued' AND intent.revision=1
        AND (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.request'))=9
        AND json_extract(NEW.canonical_request_json,'$.request.targetId')=intent.target_id
        AND json_extract(NEW.canonical_request_json,'$.request.targetClientRecordId')=intent.target_client_record_id
        AND json_extract(NEW.canonical_request_json,'$.request.targetRelationshipVersion')=intent.target_relationship_version
        AND json_extract(NEW.canonical_request_json,'$.request.tokenSha256')=intent.token_sha256)
      OR (NEW.action IN ('cancel','confirm','revoke') AND intent.revision=NEW.expected_revision
        AND (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.request'))=1))
    AND (NEW.action='redeem' OR (NEW.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS(
      SELECT 1 FROM native_staff_admissions admission
      JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
        AND profile.login_email=NEW.actor_email AND profile.version=NEW.actor_profile_version
      JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
        AND generation.generation=NEW.actor_grant_generation
      WHERE admission.staff_id=NEW.actor_staff_id AND admission.active=1
        AND admission.bound_access_subject=NEW.actor_access_subject AND admission.version=NEW.actor_admission_version
        AND ((NEW.action='revoke' AND EXISTS(
          SELECT 1 FROM operations_portal_native_workspace_authority_heads workspace
          WHERE workspace.target_id=intent.target_id AND workspace.state='active'
            AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
              AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
                OR (role.role_id='role-division-manager' AND role.scope='division'
                  AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                    WHERE scope.record_id=workspace.root_record_id AND scope.active=1
                      AND scope.division_id=role.division_id))))
            AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
              WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
                AND permission.record_id=workspace.root_record_id)
            AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
              WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
                AND permission.record_id=workspace.root_record_id)))
          OR (NEW.action<>'revoke' AND EXISTS(
            SELECT 1 FROM operations_portal_workspace_reservation_heads target
            WHERE target.target_id=intent.target_id AND target.state='active'
              AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
                AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
                  OR (role.role_id='role-division-manager' AND role.scope='division'
                    AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
                      WHERE scope.record_id=target.root_record_id AND scope.active=1
                        AND scope.division_id=role.division_id))))
              AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
                WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
                  AND permission.record_id=target.root_record_id)
              AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
                WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
                  AND permission.record_id=target.root_record_id))))))))
BEGIN SELECT RAISE(ABORT,'operations portal native recipient operation denied'); END;

CREATE TRIGGER operations_portal_native_authority_command_guard
BEFORE INSERT ON operations_portal_native_authority_commands
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_recipient_operations operation
  JOIN operations_portal_native_recipient_intents intent ON intent.intent_id=operation.intent_id
  JOIN client_onboarding_recipient_identity_bindings binding ON binding.binding_id=NEW.recipient_binding_id
    AND binding.target_client_record_id=intent.target_client_record_id AND binding.access_issuer=intent.access_issuer
    AND binding.access_subject=intent.access_subject AND binding.status='active'
  WHERE operation.operation_id=NEW.operation_id AND operation.intent_id=intent.intent_id
    AND NEW.enrollment_intent_id=intent.intent_id AND NEW.target_id=intent.target_id
    AND NEW.target_client_record_id=intent.target_client_record_id AND NEW.issuer=intent.access_issuer AND NEW.subject=intent.access_subject
    AND NEW.authorized_by_staff_id=operation.actor_staff_id AND NEW.authorized_access_subject=operation.actor_access_subject
    AND NEW.authorized_admission_version=operation.actor_admission_version
    AND NEW.authorized_profile_version=operation.actor_profile_version
    AND NEW.authorized_grant_generation=operation.actor_grant_generation
    AND NEW.authorized_verified_until=operation.actor_verified_until
    AND ((NEW.action='recipient.grant' AND operation.action='confirm' AND intent.state='pending'
        AND EXISTS(SELECT 1 FROM operations_portal_workspace_reservation_heads target
          JOIN operations_directory_client_organizations relation ON relation.client_record_id=intent.target_client_record_id
            AND relation.relationship_version=intent.target_relationship_version
          WHERE target.target_id=intent.target_id AND target.state='active' AND NEW.target_revision=target.revision
            AND NEW.client_authority_id=target.client_authority_id AND NEW.workspace_id=target.workspace_id
            AND NEW.root_kind=target.root_kind AND NEW.root_record_id=target.root_record_id
            AND ((target.root_kind='organization' AND relation.organization_record_id=target.root_record_id)
              OR (target.root_kind='standalone_client' AND intent.target_client_record_id=target.root_record_id
                AND relation.organization_record_id IS NULL)))
        AND NEW.expected_grant_revision=0 AND NEW.resulting_grant_revision=1
        AND ((NEW.expected_ownership_epoch=0 AND NEW.resulting_ownership_epoch=1
            AND NOT EXISTS(SELECT 1 FROM operations_portal_native_workspace_authority_heads workspace WHERE workspace.target_id=intent.target_id))
          OR (NEW.expected_ownership_epoch>=1 AND NEW.resulting_ownership_epoch=NEW.expected_ownership_epoch
            AND EXISTS(SELECT 1 FROM operations_portal_native_workspace_authority_heads workspace
              WHERE workspace.target_id=intent.target_id AND workspace.state='active'
                AND workspace.ownership_epoch=NEW.expected_ownership_epoch)))
        AND NOT EXISTS(SELECT 1 FROM operations_portal_native_recipient_authority_heads existing
          WHERE existing.target_id=intent.target_id AND existing.issuer=intent.access_issuer
            AND existing.subject=intent.access_subject AND existing.state='active'))
      OR (NEW.action='recipient.revoke' AND operation.action='revoke' AND intent.state='active'
        AND EXISTS(SELECT 1 FROM operations_portal_native_workspace_authority_heads workspace
          JOIN operations_portal_native_recipient_authority_heads head ON head.target_id=workspace.target_id
          WHERE workspace.target_id=intent.target_id AND workspace.state='active'
            AND NEW.target_revision=workspace.target_revision AND NEW.client_authority_id=workspace.client_authority_id
            AND NEW.workspace_id=workspace.workspace_id AND NEW.root_kind=workspace.root_kind
            AND NEW.root_record_id=workspace.root_record_id
            AND workspace.ownership_epoch=NEW.expected_ownership_epoch
            AND head.recipient_binding_id=NEW.recipient_binding_id AND head.state='active'
            AND head.ownership_epoch=NEW.expected_ownership_epoch AND head.grant_revision=NEW.expected_grant_revision))))
BEGIN SELECT RAISE(ABORT,'operations portal native authority command denied'); END;

CREATE TRIGGER operations_portal_native_workspace_head_insert_guard
BEFORE INSERT ON operations_portal_native_workspace_authority_heads
WHEN NEW.state<>'provisioning' OR NEW.ownership_epoch<>1 OR NOT EXISTS(
  SELECT 1 FROM operations_portal_native_authority_commands command
  WHERE command.operation_id=NEW.creation_operation_id AND command.operation_id=NEW.latest_operation_id
    AND command.action='recipient.grant' AND command.target_id=NEW.target_id AND command.target_revision=NEW.target_revision
    AND command.client_authority_id=NEW.client_authority_id AND command.workspace_id=NEW.workspace_id
    AND command.root_kind=NEW.root_kind AND command.root_record_id=NEW.root_record_id
    AND command.expected_ownership_epoch=0 AND command.resulting_ownership_epoch=NEW.ownership_epoch
    AND command.authorized_by_staff_id=NEW.created_by_staff_id
    AND command.authorized_access_subject=NEW.created_access_subject
    AND command.authorized_admission_version=NEW.created_admission_version
    AND command.authorized_profile_version=NEW.created_profile_version
    AND command.authorized_grant_generation=NEW.created_grant_generation)
BEGIN SELECT RAISE(ABORT,'operations portal native workspace head insert denied'); END;

CREATE TRIGGER operations_portal_native_recipient_head_insert_guard
BEFORE INSERT ON operations_portal_native_recipient_authority_heads
WHEN NEW.state<>'active' OR NEW.grant_revision<>1 OR NOT EXISTS(
  SELECT 1 FROM operations_portal_native_authority_commands command
  JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=command.target_id
  WHERE command.operation_id=NEW.creation_operation_id AND command.operation_id=NEW.latest_operation_id
    AND command.action='recipient.grant' AND command.recipient_binding_id=NEW.recipient_binding_id
    AND command.enrollment_intent_id=NEW.enrollment_intent_id AND command.target_id=NEW.target_id
    AND command.target_client_record_id=NEW.target_client_record_id AND command.issuer=NEW.issuer AND command.subject=NEW.subject
    AND command.resulting_ownership_epoch=NEW.ownership_epoch AND command.resulting_grant_revision=NEW.grant_revision
    AND command.permission_schema_version=NEW.permission_schema_version AND command.permissions_json=NEW.permissions_json
    AND command.expires_at IS NEW.expires_at AND workspace.ownership_epoch=NEW.ownership_epoch
    AND workspace.state IN ('provisioning','active') AND command.authorized_by_staff_id=NEW.created_by_staff_id
    AND command.authorized_access_subject=NEW.created_access_subject
    AND command.authorized_admission_version=NEW.created_admission_version
    AND command.authorized_profile_version=NEW.created_profile_version
    AND command.authorized_grant_generation=NEW.created_grant_generation)
BEGIN SELECT RAISE(ABORT,'operations portal native recipient head insert denied'); END;

CREATE TRIGGER operations_portal_native_recipient_head_update_guard
BEFORE UPDATE ON operations_portal_native_recipient_authority_heads
WHEN NEW.recipient_binding_id IS NOT OLD.recipient_binding_id OR NEW.enrollment_intent_id IS NOT OLD.enrollment_intent_id
  OR NEW.target_id IS NOT OLD.target_id OR NEW.target_client_record_id IS NOT OLD.target_client_record_id
  OR NEW.issuer IS NOT OLD.issuer OR NEW.subject IS NOT OLD.subject OR NEW.ownership_epoch<>OLD.ownership_epoch
  OR OLD.state<>'active' OR NEW.state<>'revoked' OR NEW.grant_revision<>OLD.grant_revision+1
  OR NEW.permission_schema_version<>3 OR NEW.permissions_json<>'[]' OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.creation_operation_id IS NOT OLD.creation_operation_id OR NEW.created_by_staff_id IS NOT OLD.created_by_staff_id
  OR NEW.created_access_subject IS NOT OLD.created_access_subject
  OR NEW.created_admission_version<>OLD.created_admission_version OR NEW.created_profile_version<>OLD.created_profile_version
  OR NEW.created_grant_generation<>OLD.created_grant_generation OR NEW.revoked_by_staff_id IS NULL
  OR NEW.revoked_operation_id IS NULL OR NEW.latest_operation_id IS NOT NEW.revoked_operation_id
  OR NOT EXISTS(SELECT 1 FROM operations_portal_native_authority_commands command
    WHERE command.operation_id=NEW.revoked_operation_id AND command.action='recipient.revoke'
      AND command.recipient_binding_id=OLD.recipient_binding_id AND command.enrollment_intent_id=OLD.enrollment_intent_id
      AND command.expected_ownership_epoch=OLD.ownership_epoch AND command.resulting_ownership_epoch=NEW.ownership_epoch
      AND command.expected_grant_revision=OLD.grant_revision AND command.resulting_grant_revision=NEW.grant_revision
      AND command.authorized_by_staff_id=NEW.revoked_by_staff_id)
BEGIN SELECT RAISE(ABORT,'operations portal native recipient head update denied'); END;

CREATE TRIGGER operations_portal_native_recipient_heads_no_delete BEFORE DELETE
ON operations_portal_native_recipient_authority_heads
BEGIN SELECT RAISE(ABORT,'operations portal native recipient heads are durable'); END;

CREATE TRIGGER operations_portal_native_binding_revoke_guard
BEFORE UPDATE OF status ON client_onboarding_recipient_identity_bindings
WHEN EXISTS(SELECT 1 FROM operations_portal_native_recipient_authority_heads head
    WHERE head.recipient_binding_id=OLD.binding_id)
  AND (OLD.status<>'active' OR NEW.status<>'revoked' OR NOT EXISTS(
    SELECT 1 FROM operations_portal_native_recipient_authority_heads head
    JOIN operations_portal_native_authority_finalizations finalization ON finalization.intent_id=head.enrollment_intent_id
    WHERE head.recipient_binding_id=OLD.binding_id AND head.state='revoked' AND finalization.resulting_state='revoked'))
BEGIN SELECT RAISE(ABORT,'operations portal native recipient binding revoke denied'); END;

CREATE TRIGGER operations_portal_native_workspace_finalize_guard
BEFORE UPDATE ON operations_portal_native_workspace_authority_heads
WHEN NEW.target_id IS NOT OLD.target_id OR NEW.target_revision<>OLD.target_revision
  OR NEW.client_authority_id IS NOT OLD.client_authority_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.root_kind IS NOT OLD.root_kind OR NEW.root_record_id IS NOT OLD.root_record_id
  OR NEW.creation_operation_id IS NOT OLD.creation_operation_id OR NEW.latest_operation_id IS NOT OLD.latest_operation_id
  OR NEW.created_by_staff_id IS NOT OLD.created_by_staff_id OR NEW.created_access_subject IS NOT OLD.created_access_subject
  OR NEW.created_admission_version<>OLD.created_admission_version OR NEW.created_profile_version<>OLD.created_profile_version
  OR NEW.created_grant_generation<>OLD.created_grant_generation OR NOT (
    (OLD.state='provisioning' AND NEW.state='active' AND NEW.ownership_epoch=OLD.ownership_epoch
      AND NEW.revoked_by_staff_id IS OLD.revoked_by_staff_id AND NEW.revoked_operation_id IS OLD.revoked_operation_id
      AND EXISTS(SELECT 1 FROM operations_portal_native_authority_finalizations finalization
        WHERE finalization.operation_id=OLD.creation_operation_id AND finalization.resulting_state='active'))
    OR (OLD.state='active' AND NEW.state='revoking' AND NEW.ownership_epoch=OLD.ownership_epoch+1
      AND NEW.revoked_by_staff_id IS NOT NULL AND NEW.revoked_operation_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM operations_portal_native_workspace_cleanup_commands command
        WHERE command.operation_id=NEW.revoked_operation_id AND command.target_id=OLD.target_id
          AND command.expected_ownership_epoch=OLD.ownership_epoch
          AND command.resulting_ownership_epoch=NEW.ownership_epoch
          AND command.authorized_by_staff_id=NEW.revoked_by_staff_id))
    OR (OLD.state='revoking' AND NEW.state='revoked' AND NEW.ownership_epoch=OLD.ownership_epoch
      AND NEW.revoked_by_staff_id IS OLD.revoked_by_staff_id AND NEW.revoked_operation_id IS OLD.revoked_operation_id
      AND EXISTS(SELECT 1 FROM operations_portal_native_workspace_cleanup_finalizations finalization
        WHERE finalization.operation_id=OLD.revoked_operation_id AND finalization.target_id=OLD.target_id
          AND finalization.ownership_epoch=OLD.ownership_epoch AND finalization.resulting_state='revoked')))
BEGIN SELECT RAISE(ABORT,'operations portal native workspace transition denied'); END;

CREATE TRIGGER operations_portal_native_workspace_heads_no_delete BEFORE DELETE
ON operations_portal_native_workspace_authority_heads
BEGIN SELECT RAISE(ABORT,'operations portal native workspace heads are durable'); END;

CREATE TRIGGER operations_portal_workspace_revoke_native_authority_guard
BEFORE UPDATE OF state ON operations_portal_workspace_reservation_heads
WHEN NEW.state='revoked' AND EXISTS(SELECT 1 FROM operations_portal_native_workspace_authority_heads authority
  WHERE authority.target_id=OLD.target_id AND authority.state<>'revoked')
BEGIN SELECT RAISE(ABORT,'active native portal authority blocks workspace revoke'); END;

CREATE TRIGGER operations_portal_native_workspace_cleanup_command_guard
BEFORE INSERT ON operations_portal_native_workspace_cleanup_commands
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_workspace_authority_heads workspace
  JOIN operations_portal_native_authority_commands creation ON creation.operation_id=workspace.creation_operation_id
    AND creation.action='recipient.grant' AND creation.target_id=workspace.target_id
  JOIN operations_portal_native_authority_receipts creation_receipt ON creation_receipt.operation_id=creation.operation_id
    AND creation_receipt.resulting_state='active'
  JOIN operations_portal_native_authority_finalizations creation_finalization
    ON creation_finalization.operation_id=creation.operation_id AND creation_finalization.resulting_state='active'
  JOIN native_staff_admissions admission ON admission.staff_id=NEW.authorized_by_staff_id AND admission.active=1
    AND admission.bound_access_subject=NEW.authorized_access_subject
    AND admission.version=NEW.authorized_admission_version
  JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    AND profile.version=NEW.authorized_profile_version
  JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
    AND generation.generation=NEW.authorized_grant_generation
  WHERE workspace.target_id=NEW.target_id AND workspace.target_revision=NEW.target_revision
    AND workspace.client_authority_id=NEW.client_authority_id AND workspace.workspace_id=NEW.workspace_id
    AND workspace.root_kind=NEW.root_kind AND workspace.root_record_id=NEW.root_record_id
    AND workspace.creation_operation_id=NEW.creation_operation_id AND workspace.state='active'
    AND workspace.ownership_epoch=NEW.expected_ownership_epoch
    AND NEW.resulting_ownership_epoch=workspace.ownership_epoch+1
    AND NEW.authorized_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
      AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
        OR (role.role_id='role-division-manager' AND role.scope='division'
          AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=workspace.root_record_id AND scope.active=1 AND scope.division_id=role.division_id))))
    AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
      WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
        AND permission.record_id=workspace.root_record_id)
    AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
      WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
        AND permission.record_id=workspace.root_record_id)
    AND EXISTS(SELECT 1 FROM operations_portal_native_recipient_authority_heads recipient
      WHERE recipient.target_id=workspace.target_id)
    AND NOT EXISTS(SELECT 1 FROM operations_portal_native_recipient_authority_heads recipient
      LEFT JOIN operations_portal_native_recipient_intents intent
        ON intent.intent_id=recipient.enrollment_intent_id AND intent.recipient_binding_id=recipient.recipient_binding_id
      LEFT JOIN operations_portal_native_authority_receipts receipt ON receipt.operation_id=recipient.revoked_operation_id
        AND receipt.recipient_binding_id=recipient.recipient_binding_id AND receipt.resulting_state='revoked'
      LEFT JOIN operations_portal_native_authority_finalizations finalization
        ON finalization.operation_id=recipient.revoked_operation_id AND finalization.intent_id=intent.intent_id
        AND finalization.resulting_state='revoked'
      WHERE recipient.target_id=workspace.target_id AND (recipient.state<>'revoked' OR intent.state<>'revoked'
        OR recipient.revoked_operation_id IS NULL OR receipt.operation_id IS NULL OR finalization.operation_id IS NULL)))
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup denied'); END;

CREATE TRIGGER operations_portal_native_workspace_cleanup_command_json_guard
BEFORE INSERT ON operations_portal_native_workspace_cleanup_commands
WHEN (SELECT count(*) FROM json_each(NEW.canonical_wire_json))<>14
  OR json_extract(NEW.canonical_wire_json,'$.protocol') IS NOT 'operations-portal-native-authority'
  OR json_extract(NEW.canonical_wire_json,'$.protocolVersion') IS NOT 1
  OR json_extract(NEW.canonical_wire_json,'$.permissionSchemaVersion') IS NOT 3
  OR json_extract(NEW.canonical_wire_json,'$.action') IS NOT 'workspace.revoke'
  OR json_extract(NEW.canonical_wire_json,'$.operationId') IS NOT NEW.operation_id
  OR json_extract(NEW.canonical_wire_json,'$.target.targetId') IS NOT NEW.target_id
  OR json_extract(NEW.canonical_wire_json,'$.target.targetRevision') IS NOT CAST(NEW.target_revision AS TEXT)
  OR json_extract(NEW.canonical_wire_json,'$.target.clientAuthorityId') IS NOT NEW.client_authority_id
  OR json_extract(NEW.canonical_wire_json,'$.target.workspaceId') IS NOT NEW.workspace_id
  OR json_extract(NEW.canonical_wire_json,'$.target.rootKind') IS NOT NEW.root_kind
  OR json_extract(NEW.canonical_wire_json,'$.target.rootRecordId') IS NOT NEW.root_record_id
  OR json_type(NEW.canonical_wire_json,'$.recipient') IS NOT 'null'
  OR json_extract(NEW.canonical_wire_json,'$.expected.ownershipEpoch') IS NOT CAST(NEW.expected_ownership_epoch AS TEXT)
  OR json_type(NEW.canonical_wire_json,'$.expected.grantRevision') IS NOT 'null'
  OR json_extract(NEW.canonical_wire_json,'$.resulting.ownershipEpoch') IS NOT CAST(NEW.resulting_ownership_epoch AS TEXT)
  OR json_type(NEW.canonical_wire_json,'$.resulting.grantRevision') IS NOT 'null'
  OR json_array_length(json_extract(NEW.canonical_wire_json,'$.permissions'))<>0
  OR json_type(NEW.canonical_wire_json,'$.expiresAt') IS NOT 'null'
  OR json_type(NEW.canonical_wire_json,'$.publication') IS NOT 'null'
  OR json_extract(NEW.canonical_wire_json,'$.actorProof.staffId') IS NOT NEW.authorized_by_staff_id
  OR json_extract(NEW.canonical_wire_json,'$.actorProof.verifiedAccessSubject') IS NOT NEW.authorized_access_subject
  OR json_extract(NEW.canonical_wire_json,'$.actorProof.admissionVersion') IS NOT CAST(NEW.authorized_admission_version AS TEXT)
  OR json_extract(NEW.canonical_wire_json,'$.actorProof.profileVersion') IS NOT CAST(NEW.authorized_profile_version AS TEXT)
  OR json_extract(NEW.canonical_wire_json,'$.actorProof.grantGeneration') IS NOT CAST(NEW.authorized_grant_generation AS TEXT)
  OR json_extract(NEW.canonical_wire_json,'$.actorProof.verifiedUntil') IS NOT NEW.authorized_verified_until
  OR json_extract(NEW.canonical_wire_json,'$.observedAt') IS NOT NEW.observed_at
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup wire is invalid'); END;

CREATE VIEW operations_portal_native_workspace_cleanup_live_commands AS
SELECT command.operation_id
FROM operations_portal_native_workspace_cleanup_commands command
JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=command.target_id
  AND workspace.state='revoking' AND workspace.revoked_operation_id=command.operation_id
JOIN native_staff_admissions admission ON admission.staff_id=command.authorized_by_staff_id AND admission.active=1
  AND admission.bound_access_subject=command.authorized_access_subject
  AND admission.version=command.authorized_admission_version
JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.version=command.authorized_profile_version
JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
  AND generation.generation=command.authorized_grant_generation
WHERE command.authorized_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
    AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
      OR (role.role_id='role-division-manager' AND role.scope='division'
        AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
          WHERE scope.record_id=workspace.root_record_id AND scope.active=1 AND scope.division_id=role.division_id))))
  AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
    WHERE permission.staff_id=admission.staff_id AND permission.effect='allow' AND permission.record_id=workspace.root_record_id)
  AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
    WHERE permission.staff_id=admission.staff_id AND permission.effect='deny' AND permission.record_id=workspace.root_record_id);

CREATE TRIGGER operations_portal_native_workspace_cleanup_outbox_guard
BEFORE INSERT ON operations_portal_native_workspace_cleanup_outbox
WHEN NEW.state<>'pending' OR NEW.attempts<>0 OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM operations_portal_native_workspace_cleanup_commands command
    WHERE command.operation_id=NEW.operation_id AND command.request_fingerprint=NEW.request_fingerprint
      AND command.canonical_wire_json=NEW.canonical_wire_json)
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup outbox denied'); END;

CREATE TRIGGER operations_portal_native_workspace_cleanup_invocation_insert_guard
BEFORE INSERT ON operations_portal_native_workspace_cleanup_invocations
WHEN NEW.state<>'authorized' OR NEW.claim_token IS NOT NULL OR NEW.claimed_at IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM operations_portal_native_workspace_cleanup_commands command
    JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=command.target_id
      AND workspace.state='revoking' AND workspace.revoked_operation_id=command.operation_id
    JOIN operations_portal_native_workspace_cleanup_outbox outbox ON outbox.operation_id=command.operation_id
      AND outbox.state<>'acknowledged'
    JOIN native_staff_admissions admission ON admission.staff_id=NEW.invoked_by_staff_id AND admission.active=1
      AND admission.bound_access_subject=NEW.invoked_access_subject AND admission.version=NEW.invoked_admission_version
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.login_email=NEW.invoked_email
      AND profile.version=NEW.invoked_profile_version
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
      AND generation.generation=NEW.invoked_grant_generation
    WHERE command.operation_id=NEW.operation_id AND command.request_fingerprint=NEW.request_fingerprint
      AND command.target_id=NEW.target_id AND command.root_record_id=NEW.root_record_id
      AND NEW.invoked_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
        AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
          OR (role.role_id='role-division-manager' AND role.scope='division'
            AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=workspace.root_record_id AND scope.active=1 AND scope.division_id=role.division_id))))
      AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
          AND permission.record_id=workspace.root_record_id)
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
          AND permission.record_id=workspace.root_record_id))
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup invocation denied'); END;

CREATE TRIGGER operations_portal_native_workspace_cleanup_invocation_claim_guard
BEFORE UPDATE ON operations_portal_native_workspace_cleanup_invocations
WHEN OLD.state<>'authorized' OR NEW.state<>'claimed' OR NEW.operation_id<>OLD.operation_id
  OR NEW.request_fingerprint<>OLD.request_fingerprint OR NEW.target_id<>OLD.target_id
  OR NEW.root_record_id<>OLD.root_record_id OR NEW.invoked_by_staff_id<>OLD.invoked_by_staff_id
  OR NEW.invoked_access_subject<>OLD.invoked_access_subject OR NEW.invoked_email<>OLD.invoked_email
  OR NEW.invoked_admission_version<>OLD.invoked_admission_version
  OR NEW.invoked_profile_version<>OLD.invoked_profile_version
  OR NEW.invoked_grant_generation<>OLD.invoked_grant_generation
  OR NEW.invoked_verified_until<>OLD.invoked_verified_until OR NEW.created_at<>OLD.created_at
  OR NOT EXISTS(SELECT 1 FROM operations_portal_native_workspace_cleanup_outbox outbox
    WHERE outbox.operation_id=NEW.operation_id AND outbox.state='claimed' AND outbox.lease_token=NEW.claim_token)
  OR NOT EXISTS(SELECT 1 FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.login_email=NEW.invoked_email
      AND profile.version=NEW.invoked_profile_version
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
      AND generation.generation=NEW.invoked_grant_generation
    JOIN operations_portal_native_workspace_cleanup_commands command ON command.operation_id=NEW.operation_id
    WHERE admission.staff_id=NEW.invoked_by_staff_id AND admission.active=1
      AND admission.bound_access_subject=NEW.invoked_access_subject AND admission.version=NEW.invoked_admission_version
      AND NEW.invoked_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
        AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
          OR (role.role_id='role-division-manager' AND role.scope='division'
            AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=command.root_record_id AND scope.active=1 AND scope.division_id=role.division_id))))
      AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='allow' AND permission.record_id=command.root_record_id)
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='deny' AND permission.record_id=command.root_record_id))
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup invocation claim denied'); END;

CREATE TRIGGER operations_portal_native_workspace_cleanup_invocation_audit_guard
BEFORE INSERT ON operations_portal_native_workspace_cleanup_invocation_audit
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_workspace_cleanup_invocations invocation
  JOIN operations_portal_native_workspace_cleanup_outbox outbox ON outbox.operation_id=invocation.operation_id
  WHERE invocation.invocation_id=NEW.invocation_id AND invocation.state='claimed'
    AND invocation.operation_id=NEW.operation_id AND invocation.request_fingerprint=NEW.request_fingerprint
    AND invocation.target_id=NEW.target_id AND invocation.root_record_id=NEW.root_record_id
    AND invocation.invoked_by_staff_id=NEW.invoked_by_staff_id
    AND invocation.invoked_access_subject=NEW.invoked_access_subject AND invocation.invoked_email=NEW.invoked_email
    AND invocation.invoked_admission_version=NEW.invoked_admission_version
    AND invocation.invoked_profile_version=NEW.invoked_profile_version
    AND invocation.invoked_grant_generation=NEW.invoked_grant_generation
    AND invocation.invoked_verified_until=NEW.invoked_verified_until
    AND invocation.claim_token=NEW.claim_token AND invocation.claimed_at=NEW.claimed_at
    AND outbox.state='claimed' AND outbox.lease_token=invocation.claim_token)
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup invocation audit denied'); END;

CREATE TRIGGER operations_portal_native_workspace_cleanup_invocations_no_delete BEFORE DELETE
ON operations_portal_native_workspace_cleanup_invocations
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup invocations are durable'); END;
CREATE TRIGGER operations_portal_native_workspace_cleanup_invocation_audit_no_update BEFORE UPDATE
ON operations_portal_native_workspace_cleanup_invocation_audit
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup invocation audit is immutable'); END;
CREATE TRIGGER operations_portal_native_workspace_cleanup_invocation_audit_no_delete BEFORE DELETE
ON operations_portal_native_workspace_cleanup_invocation_audit
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup invocation audit is durable'); END;

CREATE TRIGGER operations_portal_native_workspace_cleanup_outbox_wire_immutable
BEFORE UPDATE ON operations_portal_native_workspace_cleanup_outbox
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.canonical_wire_json IS NOT OLD.canonical_wire_json
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup wire is immutable'); END;

CREATE TRIGGER operations_portal_native_workspace_cleanup_receipt_guard
BEFORE INSERT ON operations_portal_native_workspace_cleanup_receipts
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_workspace_cleanup_outbox outbox
  JOIN operations_portal_native_workspace_cleanup_commands command ON command.operation_id=outbox.operation_id
  WHERE outbox.operation_id=NEW.operation_id AND outbox.state='acknowledged'
    AND outbox.request_fingerprint=NEW.request_fingerprint AND command.target_id=NEW.target_id
    AND command.resulting_ownership_epoch=NEW.ownership_epoch AND NEW.resulting_state='revoked')
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup receipt is inconsistent'); END;

CREATE TRIGGER operations_portal_native_workspace_cleanup_finalization_guard
BEFORE INSERT ON operations_portal_native_workspace_cleanup_finalizations
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_workspace_cleanup_receipts receipt
  JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=receipt.target_id
  WHERE receipt.operation_id=NEW.operation_id AND receipt.target_id=NEW.target_id
    AND receipt.ownership_epoch=NEW.ownership_epoch AND receipt.resulting_state='revoked'
    AND workspace.state=NEW.prior_state AND workspace.state='revoking'
    AND workspace.revoked_operation_id=NEW.operation_id AND workspace.ownership_epoch=NEW.ownership_epoch)
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup finalization denied'); END;

CREATE TRIGGER operations_portal_native_workspace_cleanup_commands_no_update BEFORE UPDATE
ON operations_portal_native_workspace_cleanup_commands
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup commands are immutable'); END;
CREATE TRIGGER operations_portal_native_workspace_cleanup_commands_no_delete BEFORE DELETE
ON operations_portal_native_workspace_cleanup_commands
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup commands are durable'); END;
CREATE TRIGGER operations_portal_native_workspace_cleanup_outbox_no_delete BEFORE DELETE
ON operations_portal_native_workspace_cleanup_outbox
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup outbox is durable'); END;
CREATE TRIGGER operations_portal_native_workspace_cleanup_receipts_no_update BEFORE UPDATE
ON operations_portal_native_workspace_cleanup_receipts
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup receipts are immutable'); END;
CREATE TRIGGER operations_portal_native_workspace_cleanup_receipts_no_delete BEFORE DELETE
ON operations_portal_native_workspace_cleanup_receipts
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup receipts are durable'); END;
CREATE TRIGGER operations_portal_native_workspace_cleanup_finalizations_no_update BEFORE UPDATE
ON operations_portal_native_workspace_cleanup_finalizations
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup finalizations are immutable'); END;
CREATE TRIGGER operations_portal_native_workspace_cleanup_finalizations_no_delete BEFORE DELETE
ON operations_portal_native_workspace_cleanup_finalizations
BEGIN SELECT RAISE(ABORT,'operations portal native workspace cleanup finalizations are durable'); END;
