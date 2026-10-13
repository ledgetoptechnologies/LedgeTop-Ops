PRAGMA foreign_keys=ON;

-- Forward-only closure of an existing native workspace authority. This never
-- creates a workspace or recipient grant and is valid only after every
-- recipient head under the umbrella is already revoked.
DROP TRIGGER operations_portal_native_workspace_authority_update_guard;
CREATE TRIGGER operations_portal_native_workspace_authority_update_guard
BEFORE UPDATE ON operations_portal_native_workspace_authority_heads
WHEN NEW.target_id IS NOT OLD.target_id OR NEW.target_revision<>OLD.target_revision
  OR NEW.client_authority_id IS NOT OLD.client_authority_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.root_kind IS NOT OLD.root_kind OR NEW.root_record_id IS NOT OLD.root_record_id
  OR OLD.state<>'active' OR NEW.state<>'revoked' OR NEW.ownership_epoch<>OLD.ownership_epoch+1
  OR NOT EXISTS(SELECT 1 FROM operations_portal_native_authority_commands command
    WHERE command.operation_id=NEW.latest_operation_id AND command.action='workspace.revoke'
      AND command.target_id=OLD.target_id AND command.target_revision=OLD.target_revision
      AND command.client_authority_id=OLD.client_authority_id AND command.workspace_id=OLD.workspace_id
      AND command.root_kind=OLD.root_kind AND command.root_record_id=OLD.root_record_id
      AND command.recipient_binding_id IS NULL AND command.enrollment_intent_id IS NULL
      AND command.target_client_record_id IS NULL AND command.issuer IS NULL AND command.subject IS NULL
      AND command.expected_ownership_epoch=OLD.ownership_epoch
      AND command.resulting_ownership_epoch=NEW.ownership_epoch
      AND command.expected_grant_revision IS NULL AND command.resulting_grant_revision IS NULL
      AND command.permissions_json='[]' AND command.publication_operation_id IS NULL)
  OR EXISTS(SELECT 1 FROM operations_portal_native_recipient_authority_heads recipient
    WHERE recipient.target_id=OLD.target_id AND recipient.state<>'revoked')
BEGIN SELECT RAISE(ABORT,'native workspace authority cleanup is not exact'); END;

DROP TRIGGER operations_portal_native_authority_history_guard;
CREATE TRIGGER operations_portal_native_authority_history_guard
BEFORE INSERT ON operations_portal_native_authority_history WHEN NOT EXISTS(
  SELECT 1 FROM operations_portal_native_authority_commands command
  JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=command.target_id
  LEFT JOIN operations_portal_native_recipient_authority_heads recipient
    ON recipient.recipient_binding_id=command.recipient_binding_id
  WHERE command.operation_id=NEW.operation_id AND command.action=NEW.action
    AND command.request_fingerprint=NEW.request_fingerprint AND command.target_id=NEW.target_id
    AND command.recipient_binding_id IS NEW.recipient_binding_id
    AND command.resulting_ownership_epoch=NEW.ownership_epoch
    AND command.resulting_grant_revision IS NEW.grant_revision
    AND ((command.action='workspace.revoke' AND NEW.recipient_binding_id IS NULL AND NEW.grant_revision IS NULL
        AND NEW.state='revoked' AND workspace.state='revoked'
        AND workspace.ownership_epoch=NEW.ownership_epoch AND workspace.latest_operation_id=NEW.operation_id)
      OR (command.action IN ('recipient.grant','recipient.revoke')
        AND recipient.target_id=NEW.target_id AND recipient.ownership_epoch=NEW.ownership_epoch
        AND recipient.grant_revision=NEW.grant_revision AND recipient.state=NEW.state
        AND recipient.latest_operation_id=NEW.operation_id))
) BEGIN SELECT RAISE(ABORT,'native authority history does not close its exact head'); END;
