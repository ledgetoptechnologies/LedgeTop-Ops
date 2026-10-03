PRAGMA foreign_keys = ON;

-- Default-off Operations-owned portal authority v2 control plane. These tables
-- are not consulted by authorization. Grant commands in this release must have
-- an empty scope set, so applying the migration cannot expose portal content.
CREATE TABLE portal_operations_workspace_authority_heads (
  workspace_id TEXT PRIMARY KEY,
  client_authority_id TEXT NOT NULL UNIQUE,
  ownership_epoch INTEGER NOT NULL CHECK(ownership_epoch >= 1),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  binding_operation_id TEXT NOT NULL,
  last_operation_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(client_authority_id) REFERENCES portal_client_authority_workspace_bindings(client_authority_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE RESTRICT
);

CREATE TRIGGER portal_operations_workspace_authority_head_insert_guard
BEFORE INSERT ON portal_operations_workspace_authority_heads
WHEN NEW.ownership_epoch<>1 OR NEW.state<>'active' OR NOT EXISTS (
  SELECT 1 FROM portal_client_authority_workspace_bindings binding
  JOIN portal_client_authority_workspace_binding_receipts receipt ON receipt.operation_id=binding.operation_id
  WHERE binding.client_authority_id=NEW.client_authority_id
    AND binding.workspace_id=NEW.workspace_id AND binding.state='inactive' AND binding.revision=1
    AND binding.operation_id=NEW.binding_operation_id
    AND receipt.client_authority_id=binding.client_authority_id AND receipt.workspace_id=binding.workspace_id
)
BEGIN SELECT RAISE(ABORT,'operations portal v2 workspace authority requires exact inactive binding'); END;

CREATE TRIGGER portal_operations_workspace_authority_head_update_guard
BEFORE UPDATE ON portal_operations_workspace_authority_heads
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.client_authority_id IS NOT OLD.client_authority_id
  OR NEW.binding_operation_id IS NOT OLD.binding_operation_id OR NEW.created_at IS NOT OLD.created_at
  OR NEW.ownership_epoch<>OLD.ownership_epoch+1 OR NEW.last_operation_id IS OLD.last_operation_id
  OR NOT (OLD.state='active' AND NEW.state='revoked')
BEGIN SELECT RAISE(ABORT,'operations portal v2 workspace authority transition denied'); END;

CREATE TRIGGER portal_operations_workspace_authority_head_no_delete
BEFORE DELETE ON portal_operations_workspace_authority_heads
BEGIN SELECT RAISE(ABORT,'operations portal v2 workspace authority is durable'); END;

CREATE TABLE portal_operations_principal_grant_heads (
  workspace_id TEXT NOT NULL,
  client_authority_id TEXT NOT NULL,
  issuer TEXT NOT NULL CHECK(length(trim(issuer)) BETWEEN 1 AND 512),
  subject TEXT NOT NULL CHECK(length(trim(subject)) BETWEEN 1 AND 512),
  ownership_epoch INTEGER NOT NULL CHECK(ownership_epoch >= 1),
  grant_revision INTEGER NOT NULL CHECK(grant_revision >= 1),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  last_operation_id TEXT NOT NULL UNIQUE,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(workspace_id,issuer,subject),
  FOREIGN KEY(workspace_id) REFERENCES portal_operations_workspace_authority_heads(workspace_id) ON DELETE RESTRICT,
  CHECK((state='active' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL))
);

CREATE TRIGGER portal_operations_principal_grant_insert_guard
BEFORE INSERT ON portal_operations_principal_grant_heads
WHEN NEW.grant_revision<>1 OR NEW.state<>'active' OR NOT EXISTS (
  SELECT 1 FROM portal_operations_workspace_authority_heads head
  WHERE head.workspace_id=NEW.workspace_id AND head.client_authority_id=NEW.client_authority_id
    AND head.ownership_epoch=NEW.ownership_epoch AND head.state='active'
)
BEGIN SELECT RAISE(ABORT,'operations portal v2 initial grant requires active exact workspace epoch'); END;

CREATE TRIGGER portal_operations_principal_grant_update_guard
BEFORE UPDATE ON portal_operations_principal_grant_heads
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.client_authority_id IS NOT OLD.client_authority_id
  OR NEW.issuer IS NOT OLD.issuer OR NEW.subject IS NOT OLD.subject OR NEW.created_at IS NOT OLD.created_at
  OR NEW.ownership_epoch<>OLD.ownership_epoch OR NEW.grant_revision<>OLD.grant_revision+1
  OR NEW.last_operation_id IS OLD.last_operation_id OR NOT EXISTS (
    SELECT 1 FROM portal_operations_workspace_authority_heads head
    WHERE head.workspace_id=NEW.workspace_id AND head.client_authority_id=NEW.client_authority_id
      AND head.ownership_epoch=NEW.ownership_epoch AND head.state='active'
  )
BEGIN SELECT RAISE(ABORT,'operations portal v2 grant CAS denied'); END;

CREATE TRIGGER portal_operations_principal_grant_no_delete
BEFORE DELETE ON portal_operations_principal_grant_heads
BEGIN SELECT RAISE(ABORT,'operations portal v2 grant tombstones are durable'); END;

CREATE TABLE portal_operations_authority_v2_audit (
  operation_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  workspace_id TEXT NOT NULL,
  client_authority_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('grant','revoke')),
  ownership_epoch INTEGER NOT NULL,
  grant_revision INTEGER NOT NULL,
  resulting_state TEXT NOT NULL CHECK(resulting_state IN ('active','revoked')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(workspace_id,issuer,subject) REFERENCES portal_operations_principal_grant_heads(workspace_id,issuer,subject) ON DELETE RESTRICT
);

CREATE TRIGGER portal_operations_authority_v2_audit_guard
BEFORE INSERT ON portal_operations_authority_v2_audit
WHEN NOT EXISTS (
  SELECT 1 FROM portal_operations_principal_grant_heads grant_head
  JOIN portal_operations_workspace_authority_heads workspace_head ON workspace_head.workspace_id=grant_head.workspace_id
  WHERE grant_head.workspace_id=NEW.workspace_id AND grant_head.client_authority_id=NEW.client_authority_id
    AND grant_head.issuer=NEW.issuer AND grant_head.subject=NEW.subject
    AND grant_head.ownership_epoch=NEW.ownership_epoch AND grant_head.grant_revision=NEW.grant_revision
    AND grant_head.state=NEW.resulting_state AND grant_head.last_operation_id=NEW.operation_id
    AND workspace_head.state='active' AND workspace_head.ownership_epoch=NEW.ownership_epoch
)
BEGIN SELECT RAISE(ABORT,'operations portal v2 audit requires exact post-CAS grant'); END;

CREATE TRIGGER portal_operations_authority_v2_audit_no_update BEFORE UPDATE ON portal_operations_authority_v2_audit
BEGIN SELECT RAISE(ABORT,'operations portal v2 audit is immutable'); END;
CREATE TRIGGER portal_operations_authority_v2_audit_no_delete BEFORE DELETE ON portal_operations_authority_v2_audit
BEGIN SELECT RAISE(ABORT,'operations portal v2 audit is immutable'); END;

CREATE TABLE portal_operations_authority_v2_receipts (
  operation_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  client_authority_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  ownership_epoch INTEGER NOT NULL,
  grant_revision INTEGER NOT NULL,
  resulting_state TEXT NOT NULL CHECK(resulting_state IN ('active','revoked')),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(operation_id) REFERENCES portal_operations_authority_v2_audit(operation_id) ON DELETE RESTRICT
);

CREATE TRIGGER portal_operations_authority_v2_receipt_guard
BEFORE INSERT ON portal_operations_authority_v2_receipts
WHEN NOT EXISTS (SELECT 1 FROM portal_operations_authority_v2_audit audit
  WHERE audit.operation_id=NEW.operation_id AND audit.request_fingerprint=NEW.request_fingerprint
    AND audit.workspace_id=NEW.workspace_id AND audit.client_authority_id=NEW.client_authority_id
    AND audit.issuer=NEW.issuer AND audit.subject=NEW.subject
    AND audit.ownership_epoch=NEW.ownership_epoch AND audit.grant_revision=NEW.grant_revision
    AND audit.resulting_state=NEW.resulting_state)
BEGIN SELECT RAISE(ABORT,'operations portal v2 receipt requires exact immutable audit'); END;

CREATE TRIGGER portal_operations_authority_v2_receipt_no_update BEFORE UPDATE ON portal_operations_authority_v2_receipts
BEGIN SELECT RAISE(ABORT,'operations portal v2 receipt is immutable'); END;
CREATE TRIGGER portal_operations_authority_v2_receipt_no_delete BEFORE DELETE ON portal_operations_authority_v2_receipts
BEGIN SELECT RAISE(ABORT,'operations portal v2 receipt is immutable'); END;
