PRAGMA foreign_keys = ON;
PRAGMA defer_foreign_keys = ON;

-- Preserve global receipt handles and every existing child FK. Do not rename
-- the old parent: SQLite would rewrite child references to its temporary name.
-- Receipt children use NO ACTION (not CASCADE), so deferring validation permits
-- copy/drop/rename without deleting grants, audits or notification history.
CREATE TABLE project_alpha_delivery_intent_receipts_source (
  receipt_id TEXT PRIMARY KEY NOT NULL,
  delivery_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint)=64),
  access_mode TEXT NOT NULL CHECK (access_mode IN ('portal','guest')),
  resource_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status='accepted'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  project_alpha_source_id TEXT NOT NULL CHECK (
    substr(project_alpha_source_id,1,14)='project-alpha:'
    AND length(project_alpha_source_id) BETWEEN 15 AND 78
    AND substr(project_alpha_source_id,15,1) GLOB '[a-z0-9]'
    AND substr(project_alpha_source_id,15) NOT GLOB '*[^a-z0-9_-]*'
    AND instr(project_alpha_source_id,char(0))=0
  ),
  write_guard INTEGER NOT NULL DEFAULT 1
    CONSTRAINT project_alpha_delivery_intent_write_guard CHECK (write_guard=1),
  UNIQUE (project_alpha_source_id,delivery_id),
  UNIQUE (receipt_id,project_alpha_source_id)
);
INSERT INTO project_alpha_delivery_intent_receipts_source
  (receipt_id,delivery_id,request_fingerprint,access_mode,resource_id,status,created_at,project_alpha_source_id)
SELECT receipt_id,delivery_id,request_fingerprint,access_mode,resource_id,status,created_at,'project-alpha:primary'
FROM project_alpha_delivery_intent_receipts;

CREATE TABLE project_alpha_delivery_intent_revocation_receipts_source (
  receipt_id TEXT PRIMARY KEY NOT NULL,
  delivery_id TEXT NOT NULL,
  original_receipt_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint)=64),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  project_alpha_source_id TEXT NOT NULL CHECK (
    substr(project_alpha_source_id,1,14)='project-alpha:'
    AND length(project_alpha_source_id) BETWEEN 15 AND 78
    AND substr(project_alpha_source_id,15,1) GLOB '[a-z0-9]'
    AND substr(project_alpha_source_id,15) NOT GLOB '*[^a-z0-9_-]*'
    AND instr(project_alpha_source_id,char(0))=0
  ),
  write_guard INTEGER NOT NULL DEFAULT 1
    CONSTRAINT project_alpha_delivery_revocation_write_guard CHECK (write_guard=1),
  UNIQUE (project_alpha_source_id,delivery_id),
  FOREIGN KEY (original_receipt_id,project_alpha_source_id)
    REFERENCES project_alpha_delivery_intent_receipts_source(receipt_id,project_alpha_source_id)
);
INSERT INTO project_alpha_delivery_intent_revocation_receipts_source
  (receipt_id,delivery_id,original_receipt_id,request_fingerprint,created_at,project_alpha_source_id)
SELECT receipt_id,delivery_id,original_receipt_id,request_fingerprint,created_at,'project-alpha:primary'
FROM project_alpha_delivery_intent_revocation_receipts;

DROP TABLE project_alpha_delivery_intent_revocation_receipts;
DROP TABLE project_alpha_delivery_intent_receipts;
ALTER TABLE project_alpha_delivery_intent_receipts_source RENAME TO project_alpha_delivery_intent_receipts;
ALTER TABLE project_alpha_delivery_intent_revocation_receipts_source RENAME TO project_alpha_delivery_intent_revocation_receipts;

CREATE INDEX idx_project_alpha_delivery_intent_resource_source
  ON project_alpha_delivery_intent_receipts(access_mode,resource_id,project_alpha_source_id);
CREATE INDEX idx_project_alpha_delivery_revocation_original_source
  ON project_alpha_delivery_intent_revocation_receipts(original_receipt_id,project_alpha_source_id);

-- Receipts are immutable replay records, including their original timestamps.
-- INSERT guards also reject REPLACE stealing a global handle or source key.
CREATE TRIGGER project_alpha_delivery_intent_receipt_immutable_update
BEFORE UPDATE ON project_alpha_delivery_intent_receipts
BEGIN SELECT RAISE(ABORT,'delivery intent receipt is immutable'); END;
CREATE TRIGGER project_alpha_delivery_intent_receipt_immutable_delete
BEFORE DELETE ON project_alpha_delivery_intent_receipts
BEGIN SELECT RAISE(ABORT,'delivery intent receipt cannot be deleted'); END;
CREATE TRIGGER project_alpha_delivery_intent_receipt_immutable_insert
BEFORE INSERT ON project_alpha_delivery_intent_receipts
WHEN EXISTS (SELECT 1 FROM project_alpha_delivery_intent_receipts existing WHERE
  (existing.receipt_id=NEW.receipt_id AND (existing.delivery_id IS NOT NEW.delivery_id
    OR existing.project_alpha_source_id IS NOT NEW.project_alpha_source_id
    OR existing.request_fingerprint IS NOT NEW.request_fingerprint OR existing.access_mode IS NOT NEW.access_mode
    OR existing.resource_id IS NOT NEW.resource_id OR existing.status IS NOT NEW.status
    OR existing.created_at IS NOT NEW.created_at))
  OR (existing.project_alpha_source_id=NEW.project_alpha_source_id AND existing.delivery_id=NEW.delivery_id
    AND existing.receipt_id<>NEW.receipt_id))
BEGIN SELECT RAISE(ABORT,'delivery intent receipt ownership conflicts'); END;

CREATE TRIGGER project_alpha_delivery_revocation_receipt_immutable_update
BEFORE UPDATE ON project_alpha_delivery_intent_revocation_receipts
BEGIN SELECT RAISE(ABORT,'delivery revocation receipt is immutable'); END;
CREATE TRIGGER project_alpha_delivery_revocation_receipt_immutable_delete
BEFORE DELETE ON project_alpha_delivery_intent_revocation_receipts
BEGIN SELECT RAISE(ABORT,'delivery revocation receipt cannot be deleted'); END;
CREATE TRIGGER project_alpha_delivery_revocation_receipt_immutable_insert
BEFORE INSERT ON project_alpha_delivery_intent_revocation_receipts
WHEN EXISTS (SELECT 1 FROM project_alpha_delivery_intent_revocation_receipts existing WHERE
  (existing.receipt_id=NEW.receipt_id AND (existing.delivery_id IS NOT NEW.delivery_id
    OR existing.project_alpha_source_id IS NOT NEW.project_alpha_source_id
    OR existing.original_receipt_id IS NOT NEW.original_receipt_id
    OR existing.request_fingerprint IS NOT NEW.request_fingerprint OR existing.created_at IS NOT NEW.created_at))
  OR (existing.project_alpha_source_id=NEW.project_alpha_source_id AND existing.delivery_id=NEW.delivery_id
    AND existing.receipt_id<>NEW.receipt_id))
BEGIN SELECT RAISE(ABORT,'delivery revocation receipt ownership conflicts'); END;

-- The resource may be created AFTER its receipt in the same batch. If it or
-- another receipt already exists, its source must agree. Resource insert guards
-- below validate the opposite creation order. Runtime write_guard still proves
-- current authorization; provenance alone never grants resource access.
CREATE TRIGGER project_alpha_delivery_intent_resource_source_insert
BEFORE INSERT ON project_alpha_delivery_intent_receipts
WHEN EXISTS (SELECT 1 FROM project_alpha_delivery_intent_receipts existing
  WHERE existing.access_mode=NEW.access_mode AND existing.resource_id=NEW.resource_id
    AND existing.project_alpha_source_id<>NEW.project_alpha_source_id)
  OR (NEW.access_mode='portal' AND EXISTS (
    SELECT 1 FROM project_alpha_delivery_portal_grants grant_row
    JOIN portal_v2_workspaces workspace ON workspace.id=grant_row.workspace_id
    WHERE grant_row.id=NEW.resource_id AND workspace.project_alpha_source_id<>NEW.project_alpha_source_id))
  OR (NEW.access_mode='guest' AND EXISTS (
    SELECT 1 FROM project_alpha_delivery_guest_authority authority
    JOIN portal_v2_workspaces workspace ON workspace.id=authority.workspace_id
    WHERE authority.share_id=NEW.resource_id AND workspace.project_alpha_source_id<>NEW.project_alpha_source_id))
BEGIN SELECT RAISE(ABORT,'delivery intent resource source conflicts'); END;

CREATE TRIGGER project_alpha_delivery_portal_grant_source_insert
BEFORE INSERT ON project_alpha_delivery_portal_grants
WHEN NOT EXISTS (SELECT 1 FROM project_alpha_delivery_intent_receipts receipt
  JOIN portal_v2_workspaces workspace ON workspace.project_alpha_source_id=receipt.project_alpha_source_id
  WHERE receipt.receipt_id=NEW.receipt_id AND receipt.access_mode='portal'
    AND receipt.resource_id=NEW.id AND workspace.id=NEW.workspace_id)
  OR EXISTS (SELECT 1 FROM project_alpha_delivery_intent_receipts receipt
    WHERE receipt.access_mode='portal' AND receipt.resource_id=NEW.id
      AND receipt.project_alpha_source_id<>(SELECT project_alpha_source_id FROM portal_v2_workspaces WHERE id=NEW.workspace_id))
  OR EXISTS (SELECT 1 FROM project_alpha_delivery_portal_grants existing WHERE
    (existing.id=NEW.id AND (existing.receipt_id IS NOT NEW.receipt_id OR existing.workspace_id IS NOT NEW.workspace_id
      OR existing.folder_binding_id IS NOT NEW.folder_binding_id
      OR existing.binding_source_version IS NOT NEW.binding_source_version
      OR existing.audience_type IS NOT NEW.audience_type OR existing.audience_public_id IS NOT NEW.audience_public_id
      OR existing.audience_source_version IS NOT NEW.audience_source_version
      OR existing.grant_version IS NOT NEW.grant_version OR existing.status IS NOT NEW.status
      OR existing.expires_at IS NOT NEW.expires_at OR existing.label IS NOT NEW.label
      OR existing.actor_kind IS NOT NEW.actor_kind OR existing.actor_id IS NOT NEW.actor_id
      OR existing.revoked_at IS NOT NEW.revoked_at OR existing.revoke_reason_code IS NOT NEW.revoke_reason_code
      OR existing.created_at IS NOT NEW.created_at))
    OR (existing.receipt_id=NEW.receipt_id AND existing.id<>NEW.id)
    OR (existing.status='active' AND NEW.status='active' AND existing.id<>NEW.id
      AND existing.folder_binding_id=NEW.folder_binding_id AND existing.binding_source_version=NEW.binding_source_version
      AND existing.audience_public_id=NEW.audience_public_id AND existing.audience_source_version=NEW.audience_source_version))
BEGIN SELECT RAISE(ABORT,'delivery portal grant source conflicts'); END;

-- Guest authority inherits source from its immutable native workspace. There
-- is no second source column to drift from that existing ownership contract.
CREATE TRIGGER project_alpha_delivery_guest_source_insert
BEFORE INSERT ON project_alpha_delivery_guest_authority
WHEN NOT EXISTS (SELECT 1 FROM project_alpha_delivery_intent_receipts receipt
  JOIN portal_v2_workspaces workspace ON workspace.project_alpha_source_id=receipt.project_alpha_source_id
  WHERE receipt.access_mode='guest' AND receipt.resource_id=NEW.share_id AND workspace.id=NEW.workspace_id)
  OR EXISTS (SELECT 1 FROM project_alpha_delivery_intent_receipts receipt
    WHERE receipt.access_mode='guest' AND receipt.resource_id=NEW.share_id
      AND receipt.project_alpha_source_id<>(SELECT project_alpha_source_id FROM portal_v2_workspaces WHERE id=NEW.workspace_id))
  OR EXISTS (SELECT 1 FROM project_alpha_delivery_guest_authority existing WHERE existing.share_id=NEW.share_id
    AND (existing.workspace_id IS NOT NEW.workspace_id OR existing.folder_binding_id IS NOT NEW.folder_binding_id
      OR existing.binding_source_version IS NOT NEW.binding_source_version
      OR existing.directory_generation_id IS NOT NEW.directory_generation_id
      OR existing.principal_public_id IS NOT NEW.principal_public_id
      OR existing.principal_source_version IS NOT NEW.principal_source_version
      OR existing.label IS NOT NEW.label OR existing.created_at IS NOT NEW.created_at
      OR existing.status IS NOT NEW.status OR existing.revoked_at IS NOT NEW.revoked_at))
BEGIN SELECT RAISE(ABORT,'delivery guest authority source conflicts'); END;
CREATE TRIGGER project_alpha_delivery_guest_source_update
BEFORE UPDATE ON project_alpha_delivery_guest_authority
WHEN NEW.share_id IS NOT OLD.share_id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.folder_binding_id IS NOT OLD.folder_binding_id OR NEW.binding_source_version IS NOT OLD.binding_source_version
  OR NEW.directory_generation_id IS NOT OLD.directory_generation_id
  OR NEW.principal_public_id IS NOT OLD.principal_public_id OR NEW.principal_source_version IS NOT OLD.principal_source_version
  OR NEW.label IS NOT OLD.label OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'delivery guest authority ownership is immutable'); END;
CREATE TRIGGER project_alpha_delivery_guest_source_delete
BEFORE DELETE ON project_alpha_delivery_guest_authority
BEGIN SELECT RAISE(ABORT,'delivery guest authority cannot be deleted'); END;

PRAGMA defer_foreign_keys = OFF;
