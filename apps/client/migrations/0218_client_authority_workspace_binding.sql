PRAGMA foreign_keys = ON;

-- Inert, reviewed workspace mapping. A client authority ID identifies one
-- Ops-managed workspace authority handle, not the global customer record;
-- one customer may have separate handles in two Project Alpha instances.
-- Issuer/subject grants remain separate per-person decisions.
-- This table is not consulted by portal authorization and cannot grant access.
CREATE TABLE portal_client_authority_workspace_bindings (
  client_authority_id TEXT PRIMARY KEY CHECK (
    length(client_authority_id)=36
    AND client_authority_id=lower(client_authority_id)
    AND substr(client_authority_id,9,1)='-'
    AND substr(client_authority_id,14,1)='-'
    AND substr(client_authority_id,19,1)='-'
    AND substr(client_authority_id,24,1)='-'
    AND replace(client_authority_id,'-','') NOT GLOB '*[^0-9a-f]*'
  ),
  workspace_id TEXT NOT NULL UNIQUE,
  projection_source_id TEXT NOT NULL,
  source_workspace_id TEXT NOT NULL,
  root_type TEXT NOT NULL CHECK(root_type IN ('organization','standalone_client')),
  root_public_id TEXT NOT NULL CHECK(length(root_public_id)=32 AND root_public_id NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'inactive' CHECK(state='inactive'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision=1),
  reconciliation_source_generation TEXT NOT NULL,
  reconciliation_source_sequence INTEGER NOT NULL CHECK(reconciliation_source_sequence>=1),
  reconciliation_snapshot_generation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE CHECK(length(trim(operation_id)) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE RESTRICT
);

CREATE TRIGGER portal_client_authority_workspace_binding_insert_guard
BEFORE INSERT ON portal_client_authority_workspace_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM pa_portal_workspace_sources source
  WHERE source.workspace_id=NEW.workspace_id
    AND source.projection_source_id=NEW.projection_source_id
    AND source.source_workspace_id=NEW.source_workspace_id
) OR NOT EXISTS (
  SELECT 1 FROM portal_v2_workspaces workspace
  WHERE workspace.id=NEW.workspace_id
    AND workspace.project_alpha_source_id=NEW.projection_source_id
    AND workspace.root_type=NEW.root_type
    AND ((NEW.root_type='organization' AND workspace.pa_organization_public_id=NEW.root_public_id)
      OR (NEW.root_type='standalone_client' AND workspace.pa_client_public_id=NEW.root_public_id))
) OR NOT EXISTS (
  SELECT 1 FROM pa_portal_projection_checkpoints checkpoint
  JOIN pa_portal_projection_generations generation
    ON generation.id=checkpoint.snapshot_generation_id
    AND generation.workspace_id=checkpoint.workspace_id
  WHERE checkpoint.workspace_id=NEW.workspace_id
    AND checkpoint.source_generation=NEW.reconciliation_source_generation
    AND checkpoint.source_sequence=NEW.reconciliation_source_sequence
    AND checkpoint.snapshot_generation_id=NEW.reconciliation_snapshot_generation_id
    AND generation.source_generation=NEW.reconciliation_source_generation
    AND generation.projection_source_id=NEW.projection_source_id
    AND generation.workspace_root_type=NEW.root_type
    AND generation.workspace_root_public_id=NEW.root_public_id
)
BEGIN SELECT RAISE(ABORT,'client authority workspace binding requires current explicit source ownership'); END;

CREATE TRIGGER portal_client_authority_workspace_binding_no_update
BEFORE UPDATE ON portal_client_authority_workspace_bindings
BEGIN SELECT RAISE(ABORT,'client authority workspace binding is immutable'); END;
CREATE TRIGGER portal_client_authority_workspace_binding_no_delete
BEFORE DELETE ON portal_client_authority_workspace_bindings
BEGIN SELECT RAISE(ABORT,'client authority workspace binding is immutable'); END;

-- Evidence is written in the same transaction as the head by a future private
-- writer. No route or scheduled task writes these tables in this increment.
CREATE TABLE portal_client_authority_workspace_binding_audit (
  operation_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  projection_source_id TEXT NOT NULL,
  source_workspace_id TEXT NOT NULL,
  root_type TEXT NOT NULL,
  root_public_id TEXT NOT NULL,
  reconciliation_source_generation TEXT NOT NULL,
  reconciliation_source_sequence INTEGER NOT NULL,
  reconciliation_snapshot_generation_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(client_authority_id) REFERENCES portal_client_authority_workspace_bindings(client_authority_id) ON DELETE RESTRICT
);
CREATE TRIGGER portal_client_authority_workspace_binding_audit_guard
BEFORE INSERT ON portal_client_authority_workspace_binding_audit
WHEN NOT EXISTS (
  SELECT 1 FROM portal_client_authority_workspace_bindings binding
  WHERE binding.operation_id=NEW.operation_id
    AND binding.client_authority_id=NEW.client_authority_id
    AND binding.workspace_id=NEW.workspace_id
    AND binding.projection_source_id=NEW.projection_source_id
    AND binding.source_workspace_id=NEW.source_workspace_id
    AND binding.root_type=NEW.root_type
    AND binding.root_public_id=NEW.root_public_id
    AND binding.reconciliation_source_generation=NEW.reconciliation_source_generation
    AND binding.reconciliation_source_sequence=NEW.reconciliation_source_sequence
    AND binding.reconciliation_snapshot_generation_id=NEW.reconciliation_snapshot_generation_id
    AND binding.state='inactive' AND binding.revision=1
)
BEGIN SELECT RAISE(ABORT,'binding audit requires exact inactive head'); END;
CREATE TRIGGER portal_client_authority_workspace_binding_audit_no_update
BEFORE UPDATE ON portal_client_authority_workspace_binding_audit
BEGIN SELECT RAISE(ABORT,'client authority workspace binding audit is immutable'); END;
CREATE TRIGGER portal_client_authority_workspace_binding_audit_no_delete
BEFORE DELETE ON portal_client_authority_workspace_binding_audit
BEGIN SELECT RAISE(ABORT,'client authority workspace binding audit is immutable'); END;

CREATE TABLE portal_client_authority_workspace_binding_receipts (
  operation_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  client_authority_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(operation_id) REFERENCES portal_client_authority_workspace_binding_audit(operation_id) ON DELETE RESTRICT
);
CREATE TRIGGER portal_client_authority_workspace_binding_receipt_guard
BEFORE INSERT ON portal_client_authority_workspace_binding_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM portal_client_authority_workspace_binding_audit audit
  WHERE audit.operation_id=NEW.operation_id
    AND audit.request_fingerprint=NEW.request_fingerprint
    AND audit.client_authority_id=NEW.client_authority_id
    AND audit.workspace_id=NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT,'binding receipt requires exact immutable audit'); END;
CREATE TRIGGER portal_client_authority_workspace_binding_receipt_no_update
BEFORE UPDATE ON portal_client_authority_workspace_binding_receipts
BEGIN SELECT RAISE(ABORT,'client authority workspace binding receipt is immutable'); END;
CREATE TRIGGER portal_client_authority_workspace_binding_receipt_no_delete
BEFORE DELETE ON portal_client_authority_workspace_binding_receipts
BEGIN SELECT RAISE(ABORT,'client authority workspace binding receipt is immutable'); END;
