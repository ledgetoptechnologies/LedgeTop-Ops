PRAGMA foreign_keys = ON;

-- Default-off ownership control plane. No runtime route reads or writes these
-- tables yet, and this migration creates no identity, membership, entitlement,
-- public-link, or workspace rows.
--
-- Keep all three identities explicit: the Operations client authority UUID,
-- the existing local portal workspace, and its producer-owned source workspace.
CREATE TABLE portal_client_authority_workspace_claims (
  client_authority_id TEXT PRIMARY KEY CHECK (
    length(client_authority_id)=36
    AND client_authority_id=lower(client_authority_id)
    AND substr(client_authority_id,9,1)='-'
    AND substr(client_authority_id,14,1)='-'
    AND substr(client_authority_id,19,1)='-'
    AND substr(client_authority_id,24,1)='-'
    AND replace(client_authority_id,'-','') NOT GLOB '*[^0-9a-f]*'
  ),
  workspace_id TEXT NOT NULL,
  projection_source_id TEXT NOT NULL,
  source_workspace_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','released')),
  ownership_epoch INTEGER NOT NULL CHECK(ownership_epoch >= 1),
  reconciliation_source_generation TEXT NOT NULL CHECK(length(trim(reconciliation_source_generation)) BETWEEN 1 AND 200),
  reconciliation_source_sequence INTEGER NOT NULL CHECK(reconciliation_source_sequence >= 1),
  reconciliation_snapshot_generation_id TEXT NOT NULL CHECK(length(trim(reconciliation_snapshot_generation_id)) BETWEEN 1 AND 200),
  last_operation_id TEXT NOT NULL UNIQUE CHECK(length(trim(last_operation_id)) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(workspace_id),
  FOREIGN KEY(workspace_id) REFERENCES portal_v2_workspaces(id) ON DELETE RESTRICT
);

CREATE TRIGGER portal_client_authority_workspace_claim_insert_guard
BEFORE INSERT ON portal_client_authority_workspace_claims
WHEN NEW.state<>'active'
  OR NOT EXISTS (
    SELECT 1 FROM pa_portal_workspace_sources source
    WHERE source.workspace_id=NEW.workspace_id
      AND source.projection_source_id=NEW.projection_source_id
      AND source.source_workspace_id=NEW.source_workspace_id
  )
  OR NOT EXISTS (
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
  )
BEGIN SELECT RAISE(ABORT,'client authority workspace claim requires current explicit source ownership'); END;

-- The head is CAS-ready: writers must advance exactly one epoch. A release is
-- deny-closed until evidence names a checkpoint newer than the active claim.
CREATE TRIGGER portal_client_authority_workspace_claim_update_guard
BEFORE UPDATE ON portal_client_authority_workspace_claims
WHEN NEW.client_authority_id IS NOT OLD.client_authority_id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.projection_source_id IS NOT OLD.projection_source_id
  OR NEW.source_workspace_id IS NOT OLD.source_workspace_id
  OR OLD.state<>'active'
  OR NEW.state<>'released'
  OR NEW.ownership_epoch<>OLD.ownership_epoch+1
  OR NEW.last_operation_id IS OLD.last_operation_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NOT EXISTS (
    SELECT 1 FROM pa_portal_workspace_sources source
    WHERE source.workspace_id=NEW.workspace_id
      AND source.projection_source_id=NEW.projection_source_id
      AND source.source_workspace_id=NEW.source_workspace_id
  )
  OR NOT EXISTS (
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
  )
  OR NEW.reconciliation_source_sequence<=OLD.reconciliation_source_sequence
BEGIN SELECT RAISE(ABORT,'client authority workspace claim CAS or reconciliation guard failed'); END;

-- Released heads are permanent tombstones in v1. Reactivation and rollback
-- require a future versioned migration with explicitly reviewed semantics.

CREATE TRIGGER portal_client_authority_workspace_claim_no_delete
BEFORE DELETE ON portal_client_authority_workspace_claims
BEGIN SELECT RAISE(ABORT,'client authority workspace claim heads cannot be deleted'); END;
