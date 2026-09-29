PRAGMA foreign_keys = ON;

-- Approved default-off evolution of the existing 0219 principal CAS stream.
-- Existing rows remain protocol 2 and permissionless. This migration creates
-- no parallel authority stream, public route, public link, or production grant.
ALTER TABLE portal_operations_principal_grant_heads ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 2
  CHECK(protocol_version IN (2,3));
ALTER TABLE portal_operations_principal_grant_heads ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]'
  CHECK(permissions_json IN ('[]','["operations.service_home.read"]'));
ALTER TABLE portal_operations_authority_v2_audit ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 2
  CHECK(protocol_version IN (2,3));
ALTER TABLE portal_operations_authority_v2_audit ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]'
  CHECK(permissions_json IN ('[]','["operations.service_home.read"]'));
ALTER TABLE portal_operations_authority_v2_receipts ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 2
  CHECK(protocol_version IN (2,3));
ALTER TABLE portal_operations_authority_v2_receipts ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]'
  CHECK(permissions_json IN ('[]','["operations.service_home.read"]'));

DROP TRIGGER portal_operations_principal_grant_insert_guard;
DROP TRIGGER portal_operations_principal_grant_update_guard;
DROP TRIGGER portal_operations_authority_v2_audit_guard;
DROP TRIGGER portal_operations_authority_v2_receipt_guard;

CREATE TRIGGER portal_operations_principal_grant_insert_guard BEFORE INSERT ON portal_operations_principal_grant_heads
WHEN NEW.grant_revision<>1 OR NEW.state<>'active'
 OR (NEW.protocol_version=2 AND NEW.permissions_json<>'[]') OR (NEW.state='revoked' AND NEW.permissions_json<>'[]')
 OR NOT EXISTS(SELECT 1 FROM portal_operations_workspace_authority_heads head
   WHERE head.workspace_id=NEW.workspace_id AND head.client_authority_id=NEW.client_authority_id
     AND head.ownership_epoch=NEW.ownership_epoch AND head.state='active')
BEGIN SELECT RAISE(ABORT,'operations portal authority initial grant requires exact active workspace and protocol'); END;

CREATE TRIGGER portal_operations_principal_grant_update_guard BEFORE UPDATE ON portal_operations_principal_grant_heads
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.client_authority_id IS NOT OLD.client_authority_id
 OR NEW.issuer IS NOT OLD.issuer OR NEW.subject IS NOT OLD.subject OR NEW.created_at IS NOT OLD.created_at
 OR NEW.ownership_epoch<>OLD.ownership_epoch OR NEW.grant_revision<>OLD.grant_revision+1
 OR NEW.last_operation_id IS OLD.last_operation_id
 OR (NEW.protocol_version=2 AND NEW.permissions_json<>'[]') OR (NEW.state='revoked' AND NEW.permissions_json<>'[]')
 OR NOT EXISTS(SELECT 1 FROM portal_operations_workspace_authority_heads head
   WHERE head.workspace_id=NEW.workspace_id AND head.client_authority_id=NEW.client_authority_id
     AND head.ownership_epoch=NEW.ownership_epoch AND head.state='active')
BEGIN SELECT RAISE(ABORT,'operations portal authority grant CAS denied'); END;

CREATE TRIGGER portal_operations_authority_v2_audit_guard BEFORE INSERT ON portal_operations_authority_v2_audit
WHEN (NEW.protocol_version=2 AND NEW.permissions_json<>'[]') OR (NEW.resulting_state='revoked' AND NEW.permissions_json<>'[]')
 OR NOT EXISTS(SELECT 1 FROM portal_operations_principal_grant_heads grant_head
   JOIN portal_operations_workspace_authority_heads workspace_head ON workspace_head.workspace_id=grant_head.workspace_id
   WHERE grant_head.workspace_id=NEW.workspace_id AND grant_head.client_authority_id=NEW.client_authority_id
     AND grant_head.issuer=NEW.issuer AND grant_head.subject=NEW.subject
     AND grant_head.ownership_epoch=NEW.ownership_epoch AND grant_head.grant_revision=NEW.grant_revision
     AND grant_head.state=NEW.resulting_state AND grant_head.last_operation_id=NEW.operation_id
     AND grant_head.protocol_version=NEW.protocol_version AND grant_head.permissions_json=NEW.permissions_json
     AND workspace_head.state='active' AND workspace_head.ownership_epoch=NEW.ownership_epoch)
BEGIN SELECT RAISE(ABORT,'operations portal authority audit requires exact post-CAS protocol and permissions'); END;

CREATE TRIGGER portal_operations_authority_v2_receipt_guard BEFORE INSERT ON portal_operations_authority_v2_receipts
WHEN (NEW.protocol_version=2 AND NEW.permissions_json<>'[]') OR (NEW.resulting_state='revoked' AND NEW.permissions_json<>'[]')
 OR NOT EXISTS(SELECT 1 FROM portal_operations_authority_v2_audit audit
   WHERE audit.operation_id=NEW.operation_id AND audit.request_fingerprint=NEW.request_fingerprint
     AND audit.workspace_id=NEW.workspace_id AND audit.client_authority_id=NEW.client_authority_id
     AND audit.issuer=NEW.issuer AND audit.subject=NEW.subject
     AND audit.ownership_epoch=NEW.ownership_epoch AND audit.grant_revision=NEW.grant_revision
     AND audit.resulting_state=NEW.resulting_state AND audit.protocol_version=NEW.protocol_version
     AND audit.permissions_json=NEW.permissions_json)
BEGIN SELECT RAISE(ABORT,'operations portal authority receipt requires exact immutable protocol audit'); END;
