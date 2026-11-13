-- Pin the owner's selected recipient scope from issue through confirmation.
-- Historical intents receive the v3 service-home-only default and are never
-- upgraded by this migration.
ALTER TABLE operations_portal_native_recipient_intents
  ADD COLUMN permission_schema_version INTEGER NOT NULL DEFAULT 3
    CHECK(permission_schema_version IN (3,4));
ALTER TABLE operations_portal_native_recipient_intents
  ADD COLUMN requested_permissions_json TEXT NOT NULL DEFAULT '["operations.service_home.read"]'
    CHECK(json_valid(requested_permissions_json) AND json_type(requested_permissions_json)='array');

CREATE TRIGGER operations_portal_native_recipient_intent_permission_insert_guard
BEFORE INSERT ON operations_portal_native_recipient_intents
WHEN NOT ((NEW.permission_schema_version=3
    AND NEW.requested_permissions_json='["operations.service_home.read"]')
  OR (NEW.permission_schema_version=4
    AND NEW.requested_permissions_json='["operations.request.create","operations.service_home.read"]'))
BEGIN SELECT RAISE(ABORT,'native recipient intent capability set is invalid'); END;

CREATE TRIGGER operations_portal_native_recipient_intent_permission_immutable
BEFORE UPDATE ON operations_portal_native_recipient_intents
WHEN NEW.permission_schema_version IS NOT OLD.permission_schema_version
  OR NEW.requested_permissions_json IS NOT OLD.requested_permissions_json
BEGIN SELECT RAISE(ABORT,'native recipient intent capabilities are immutable'); END;

-- The issue command is the immutable owner-authorized record of the selected
-- permission set. Accept the historical six-field request only for migrated
-- home-only intents; new explicit selections must match the pinned intent.
DROP TRIGGER operations_portal_native_recipient_operation_request_guard;
CREATE TRIGGER operations_portal_native_recipient_operation_request_guard
BEFORE INSERT ON operations_portal_native_recipient_operations
WHEN NOT EXISTS(SELECT 1 FROM operations_portal_native_recipient_intents intent
  WHERE intent.intent_id=NEW.intent_id
    AND json_extract(NEW.canonical_request_json,'$.request.expectedRevision') IS NEW.expected_revision
    AND ((NEW.action='issue' AND intent.state='issued' AND intent.revision=1 AND NEW.expected_revision=0
        AND ((SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.request'))=6
          AND intent.permission_schema_version=3
          AND intent.requested_permissions_json='["operations.service_home.read"]'
          OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.request'))=8
          AND json_extract(NEW.canonical_request_json,'$.request.permissionSchemaVersion') IS intent.permission_schema_version
          AND json_extract(NEW.canonical_request_json,'$.request.permissions') IS intent.requested_permissions_json)
        AND json_extract(NEW.canonical_request_json,'$.request.targetId')=intent.target_id
        AND json_extract(NEW.canonical_request_json,'$.request.targetRevision')=intent.target_revision
        AND json_extract(NEW.canonical_request_json,'$.request.targetClientRecordId')=intent.target_client_record_id
        AND json_extract(NEW.canonical_request_json,'$.request.targetRelationshipVersion')=intent.target_relationship_version
        AND json_extract(NEW.canonical_request_json,'$.request.expiresAt')=intent.expires_at)
      OR (NEW.action='redeem' AND intent.state='issued' AND intent.revision=1
        AND (((SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.request'))=10
            AND intent.permission_schema_version=3
            AND intent.requested_permissions_json='["operations.service_home.read"]')
          OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.request'))=12
            AND json_extract(NEW.canonical_request_json,'$.request.permissionSchemaVersion') IS intent.permission_schema_version
            AND json_extract(NEW.canonical_request_json,'$.request.permissions') IS intent.requested_permissions_json)
        AND json_extract(NEW.canonical_request_json,'$.request.targetId')=intent.target_id
        AND json_extract(NEW.canonical_request_json,'$.request.targetClientRecordId')=intent.target_client_record_id
        AND json_extract(NEW.canonical_request_json,'$.request.targetRelationshipVersion')=intent.target_relationship_version
        AND json_extract(NEW.canonical_request_json,'$.request.tokenSha256')=intent.token_sha256)
      OR (NEW.action IN ('cancel','confirm','revoke') AND intent.revision=NEW.expected_revision
        AND (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.request'))=1))
  AND (NEW.action='redeem' OR EXISTS(
    SELECT 1 FROM operations_portal_workspace_reservation_heads target
    JOIN native_staff_admissions admission ON admission.staff_id=NEW.actor_staff_id
      AND admission.active=1 AND admission.bound_access_subject=NEW.actor_access_subject
      AND admission.version=NEW.actor_admission_version
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
      AND profile.login_email=NEW.actor_email AND profile.version=NEW.actor_profile_version
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
      AND generation.generation=NEW.actor_grant_generation
    WHERE target.target_id=intent.target_id AND target.state='active'
      AND NEW.actor_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
        AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
          OR (role.role_id='role-division-manager' AND role.scope='division'
            AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=target.root_record_id AND scope.active=1 AND scope.division_id=role.division_id))))
      AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
          AND permission.record_id=target.root_record_id)
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
          AND permission.record_id=target.root_record_id))))
BEGIN SELECT RAISE(ABORT,'operations portal native recipient operation denied'); END;

-- The recipient transition must commit the same permission acknowledgement
-- that the immutable redemption operation records.
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
          AND ((OLD.permission_schema_version=3
              AND OLD.requested_permissions_json='["operations.service_home.read"]'
              AND (SELECT count(*) FROM json_each(operation.canonical_request_json,'$.request'))=10)
            OR (OLD.permission_schema_version=4
              AND (SELECT count(*) FROM json_each(operation.canonical_request_json,'$.request'))=12
              AND json_extract(operation.canonical_request_json,'$.request.permissionSchemaVersion') IS OLD.permission_schema_version
              AND json_extract(operation.canonical_request_json,'$.request.permissions') IS OLD.requested_permissions_json))
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
