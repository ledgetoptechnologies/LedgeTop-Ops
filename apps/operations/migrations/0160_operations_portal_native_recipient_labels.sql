-- Presentation-only label captured from a signed, validated Client Access
-- assertion's email claim. Authorization remains exclusively issuer + subject; this table
-- is never consulted by an authority, permission, or identity lookup.
CREATE TABLE IF NOT EXISTS operations_portal_native_recipient_labels (
  intent_id TEXT PRIMARY KEY REFERENCES operations_portal_native_recipient_intents(intent_id) ON DELETE RESTRICT,
  redeem_operation_id TEXT NOT NULL UNIQUE REFERENCES operations_portal_native_recipient_operations(operation_id) ON DELETE RESTRICT,
  access_issuer TEXT NOT NULL,
  access_subject TEXT NOT NULL,
  display_label TEXT NOT NULL CHECK(length(display_label) BETWEEN 1 AND 160
    AND display_label=trim(display_label) AND instr(display_label,char(0))=0
    AND display_label NOT GLOB ('*['||char(1)||'-'||char(31)||char(127)||']*')),
  label_source TEXT NOT NULL CHECK(label_source='access.email'),
  captured_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 0154 intentionally admitted exactly nine redeem request members. Replace
-- only that audit trigger so every new redeem also commits the Access-asserted,
-- presentation-only label into its canonical idempotency document.
DROP TRIGGER operations_portal_native_recipient_operation_request_guard;

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
        AND (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.request'))=10
        AND json_extract(NEW.canonical_request_json,'$.request.targetId')=intent.target_id
        AND json_extract(NEW.canonical_request_json,'$.request.targetRevision')=intent.target_revision
        AND json_extract(NEW.canonical_request_json,'$.request.targetClientRecordId')=intent.target_client_record_id
        AND json_extract(NEW.canonical_request_json,'$.request.targetRelationshipVersion')=intent.target_relationship_version
        AND json_extract(NEW.canonical_request_json,'$.request.tokenSha256')=intent.token_sha256
        AND typeof(json_extract(NEW.canonical_request_json,'$.request.issuer'))='text'
        AND length(json_extract(NEW.canonical_request_json,'$.request.issuer')) BETWEEN 1 AND 512
        AND typeof(json_extract(NEW.canonical_request_json,'$.request.subject'))='text'
        AND length(json_extract(NEW.canonical_request_json,'$.request.subject')) BETWEEN 1 AND 512
        AND typeof(json_extract(NEW.canonical_request_json,'$.request.verifiedUntil'))='text'
        AND json_extract(NEW.canonical_request_json,'$.request.verifiedUntil')>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND typeof(json_extract(NEW.canonical_request_json,'$.request.recipientLabel'))='text'
        AND length(json_extract(NEW.canonical_request_json,'$.request.recipientLabel')) BETWEEN 1 AND 160
        AND json_extract(NEW.canonical_request_json,'$.request.recipientLabel')=
          trim(json_extract(NEW.canonical_request_json,'$.request.recipientLabel'))
        AND instr(json_extract(NEW.canonical_request_json,'$.request.recipientLabel'),char(0))=0
        AND json_extract(NEW.canonical_request_json,'$.request.recipientLabel') NOT GLOB
          ('*['||char(1)||'-'||char(31)||char(127)||']*'))
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

-- The transition is the point where the asserted issuer, subject, and Access
-- deadline become durable on the intent. Pin those resulting values back to
-- the same exact ten-member redeem operation rather than trusting adjacency.
DROP TRIGGER operations_portal_native_recipient_transition_guard;

CREATE TRIGGER operations_portal_native_recipient_transition_guard
BEFORE UPDATE ON operations_portal_native_recipient_intents
WHEN NEW.intent_id IS NOT OLD.intent_id OR NEW.target_id IS NOT OLD.target_id OR NEW.target_revision<>OLD.target_revision
  OR NEW.target_client_record_id IS NOT OLD.target_client_record_id
  OR NEW.target_relationship_version<>OLD.target_relationship_version OR NEW.token_sha256 IS NOT OLD.token_sha256
  OR NEW.issued_by_staff_id IS NOT OLD.issued_by_staff_id OR NEW.issued_access_subject IS NOT OLD.issued_access_subject
  OR NEW.issued_email IS NOT OLD.issued_email OR NEW.issued_admission_version<>OLD.issued_admission_version
  OR NEW.issued_profile_version<>OLD.issued_profile_version OR NEW.issued_grant_generation<>OLD.issued_grant_generation
  OR NEW.expires_at IS NOT OLD.expires_at OR NEW.created_at IS NOT OLD.created_at OR NEW.revision<>OLD.revision+1
  OR NOT ((OLD.state='issued' AND NEW.state='pending' AND NEW.access_issuer IS NOT NULL AND NEW.access_subject IS NOT NULL
      AND NEW.recipient_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NEW.recipient_binding_id IS NULL
      AND EXISTS(SELECT 1 FROM operations_portal_native_recipient_operations operation
        WHERE operation.intent_id=OLD.intent_id AND operation.action='redeem'
          AND operation.expected_revision=OLD.revision AND operation.resulting_revision=NEW.revision
          AND operation.resulting_state='pending'
          AND (SELECT count(*) FROM json_each(operation.canonical_request_json,'$.request'))=10
          AND json_extract(operation.canonical_request_json,'$.request.issuer') IS NEW.access_issuer
          AND json_extract(operation.canonical_request_json,'$.request.subject') IS NEW.access_subject
          AND json_extract(operation.canonical_request_json,'$.request.verifiedUntil') IS NEW.recipient_verified_until))
    OR (OLD.state IN ('issued','pending') AND NEW.state='cancelled' AND NEW.recipient_binding_id IS NULL
      AND EXISTS(SELECT 1 FROM operations_portal_native_recipient_operations operation WHERE operation.intent_id=OLD.intent_id
        AND operation.action='cancel' AND operation.resulting_revision=NEW.revision))
    OR (OLD.state='pending' AND NEW.state='confirming' AND NEW.access_issuer IS OLD.access_issuer
      AND NEW.access_subject IS OLD.access_subject AND NEW.recipient_verified_until IS OLD.recipient_verified_until
      AND NEW.recipient_binding_id IS NOT NULL AND NEW.grant_operation_id IS NOT NULL AND NEW.revoke_operation_id IS NULL
      AND EXISTS(SELECT 1 FROM operations_portal_native_authority_commands command
        WHERE command.operation_id=NEW.grant_operation_id AND command.enrollment_intent_id=OLD.intent_id
          AND command.action='recipient.grant'))
    OR (OLD.state='confirming' AND NEW.state='active' AND NEW.recipient_binding_id IS OLD.recipient_binding_id
      AND NEW.grant_operation_id IS OLD.grant_operation_id AND EXISTS(
        SELECT 1 FROM operations_portal_native_authority_finalizations finalization
        WHERE finalization.operation_id=OLD.grant_operation_id AND finalization.intent_id=OLD.intent_id
          AND finalization.prior_revision=OLD.revision AND finalization.resulting_revision=NEW.revision
          AND finalization.resulting_state='active'))
    OR (OLD.state='active' AND NEW.state='revoking' AND NEW.recipient_binding_id IS OLD.recipient_binding_id
      AND NEW.grant_operation_id IS OLD.grant_operation_id AND NEW.revoke_operation_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM operations_portal_native_authority_commands command
        WHERE command.operation_id=NEW.revoke_operation_id AND command.enrollment_intent_id=OLD.intent_id
          AND command.action='recipient.revoke'))
    OR (OLD.state='revoking' AND NEW.state='revoked' AND NEW.recipient_binding_id IS OLD.recipient_binding_id
      AND NEW.grant_operation_id IS OLD.grant_operation_id AND NEW.revoke_operation_id IS OLD.revoke_operation_id
      AND EXISTS(SELECT 1 FROM operations_portal_native_authority_finalizations finalization
        WHERE finalization.operation_id=OLD.revoke_operation_id AND finalization.intent_id=OLD.intent_id
          AND finalization.prior_revision=OLD.revision AND finalization.resulting_revision=NEW.revision
          AND finalization.resulting_state='revoked')))
BEGIN SELECT RAISE(ABORT,'operations portal native recipient transition denied'); END;

DROP TRIGGER IF EXISTS operations_portal_native_recipient_label_insert_guard;
CREATE TRIGGER operations_portal_native_recipient_label_insert_guard
BEFORE INSERT ON operations_portal_native_recipient_labels
WHEN NEW.label_source<>'access.email' OR NOT EXISTS(
  SELECT 1
  FROM operations_portal_native_recipient_operations operation
  JOIN operations_portal_native_recipient_operation_commits committed
    ON committed.operation_id=operation.operation_id AND committed.intent_id=operation.intent_id
  JOIN operations_portal_native_recipient_intents intent ON intent.intent_id=operation.intent_id
  WHERE operation.operation_id=NEW.redeem_operation_id AND operation.intent_id=NEW.intent_id
    AND operation.action='redeem' AND operation.expected_revision=1
    AND operation.resulting_revision=2 AND operation.resulting_state='pending'
    AND intent.state='pending' AND intent.revision=2
    AND NEW.access_issuer=intent.access_issuer AND NEW.access_subject=intent.access_subject
    AND json_extract(operation.canonical_request_json,'$.request.issuer')=NEW.access_issuer
    AND json_extract(operation.canonical_request_json,'$.request.subject')=NEW.access_subject
    AND json_extract(operation.canonical_request_json,'$.request.recipientLabel')=NEW.display_label)
BEGIN SELECT RAISE(ABORT,'operations portal native recipient label is not an exact committed redemption'); END;

DROP TRIGGER IF EXISTS operations_portal_native_recipient_labels_no_update;
CREATE TRIGGER operations_portal_native_recipient_labels_no_update
BEFORE UPDATE ON operations_portal_native_recipient_labels
BEGIN SELECT RAISE(ABORT,'operations portal native recipient labels are immutable'); END;

DROP TRIGGER IF EXISTS operations_portal_native_recipient_labels_no_delete;
CREATE TRIGGER operations_portal_native_recipient_labels_no_delete
BEFORE DELETE ON operations_portal_native_recipient_labels
BEGIN SELECT RAISE(ABORT,'operations portal native recipient labels are durable'); END;
