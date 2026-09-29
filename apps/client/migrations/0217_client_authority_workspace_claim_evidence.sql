PRAGMA foreign_keys = ON;

-- Immutable evidence for the default-off, route-less Client ownership writer.
-- These records do not grant membership, entitlement, or portal access.
CREATE TABLE portal_client_authority_workspace_claim_audit (
  operation_id TEXT PRIMARY KEY CHECK(length(trim(operation_id)) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  action TEXT NOT NULL CHECK(action IN ('claim','release')),
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  projection_source_id TEXT NOT NULL,
  source_workspace_id TEXT NOT NULL,
  ownership_epoch INTEGER NOT NULL CHECK(ownership_epoch >= 1),
  resulting_state TEXT NOT NULL CHECK(resulting_state IN ('active','released')),
  reconciliation_source_generation TEXT NOT NULL,
  reconciliation_source_sequence INTEGER NOT NULL CHECK(reconciliation_source_sequence >= 1),
  reconciliation_snapshot_generation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(client_authority_id) REFERENCES portal_client_authority_workspace_claims(client_authority_id) ON DELETE RESTRICT
);

CREATE TRIGGER portal_client_authority_workspace_claim_audit_guard
BEFORE INSERT ON portal_client_authority_workspace_claim_audit
WHEN NOT EXISTS (
  SELECT 1 FROM portal_client_authority_workspace_claims head
  WHERE head.client_authority_id=NEW.client_authority_id
    AND head.workspace_id=NEW.workspace_id
    AND head.projection_source_id=NEW.projection_source_id
    AND head.source_workspace_id=NEW.source_workspace_id
    AND head.ownership_epoch=NEW.ownership_epoch
    AND head.state=NEW.resulting_state
    AND head.reconciliation_source_generation=NEW.reconciliation_source_generation
    AND head.reconciliation_source_sequence=NEW.reconciliation_source_sequence
    AND head.reconciliation_snapshot_generation_id=NEW.reconciliation_snapshot_generation_id
    AND head.last_operation_id=NEW.operation_id
)
BEGIN SELECT RAISE(ABORT,'claim audit requires exact post-CAS head'); END;

CREATE TRIGGER portal_client_authority_workspace_claim_audit_immutable
BEFORE UPDATE ON portal_client_authority_workspace_claim_audit
BEGIN SELECT RAISE(ABORT,'claim audit is immutable'); END;
CREATE TRIGGER portal_client_authority_workspace_claim_audit_no_delete
BEFORE DELETE ON portal_client_authority_workspace_claim_audit
BEGIN SELECT RAISE(ABORT,'claim audit is immutable'); END;

CREATE TABLE portal_client_authority_workspace_claim_receipts (
  operation_id TEXT PRIMARY KEY CHECK(length(trim(operation_id)) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  projection_source_id TEXT NOT NULL,
  source_workspace_id TEXT NOT NULL,
  ownership_epoch INTEGER NOT NULL CHECK(ownership_epoch >= 1),
  resulting_state TEXT NOT NULL CHECK(resulting_state IN ('active','released')),
  reconciliation_source_generation TEXT NOT NULL,
  reconciliation_source_sequence INTEGER NOT NULL CHECK(reconciliation_source_sequence >= 1),
  reconciliation_snapshot_generation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(operation_id) REFERENCES portal_client_authority_workspace_claim_audit(operation_id) ON DELETE RESTRICT
);

CREATE TRIGGER portal_client_authority_workspace_claim_receipt_guard
BEFORE INSERT ON portal_client_authority_workspace_claim_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM portal_client_authority_workspace_claim_audit audit
  WHERE audit.operation_id=NEW.operation_id
    AND audit.request_fingerprint=NEW.request_fingerprint
    AND audit.client_authority_id=NEW.client_authority_id
    AND audit.workspace_id=NEW.workspace_id
    AND audit.projection_source_id=NEW.projection_source_id
    AND audit.source_workspace_id=NEW.source_workspace_id
    AND audit.ownership_epoch=NEW.ownership_epoch
    AND audit.resulting_state=NEW.resulting_state
    AND audit.reconciliation_source_generation=NEW.reconciliation_source_generation
    AND audit.reconciliation_source_sequence=NEW.reconciliation_source_sequence
    AND audit.reconciliation_snapshot_generation_id=NEW.reconciliation_snapshot_generation_id
)
BEGIN SELECT RAISE(ABORT,'claim receipt requires exact immutable audit'); END;

CREATE TRIGGER portal_client_authority_workspace_claim_receipt_immutable
BEFORE UPDATE ON portal_client_authority_workspace_claim_receipts
BEGIN SELECT RAISE(ABORT,'claim receipt is immutable'); END;
CREATE TRIGGER portal_client_authority_workspace_claim_receipt_no_delete
BEFORE DELETE ON portal_client_authority_workspace_claim_receipts
BEGIN SELECT RAISE(ABORT,'claim receipt is immutable'); END;
