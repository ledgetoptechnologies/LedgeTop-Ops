PRAGMA foreign_keys = ON;

-- Native Project Alpha workspaces intentionally do not have a legacy account
-- bridge. Request rows keep using the mature request/inbox tables, but their
-- storage owner is explicitly bound to the source-owned workspace and never
-- becomes an authentication or request-authority bridge.
CREATE TABLE portal_native_request_storage_bindings (
  workspace_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL CHECK (
    length(source_id) BETWEEN 15 AND 78
    AND substr(source_id,1,14)='project-alpha:'
    AND substr(source_id,15,1) GLOB '[a-z0-9]'
    AND substr(source_id,15) NOT GLOB '*[^a-z0-9_-]*'),
  account_id TEXT NOT NULL UNIQUE,
  storage_identity_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','suspended')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id),
  FOREIGN KEY (account_id) REFERENCES client_accounts(id),
  FOREIGN KEY (storage_identity_id,account_id)
    REFERENCES client_identity_links(id,account_id)
);
CREATE UNIQUE INDEX portal_native_request_storage_source
  ON portal_native_request_storage_bindings(source_id,workspace_id);

-- This is an ownership ledger, not an editable account bridge.  Operational
-- suspension may change, but the source/workspace/storage tuple must remain
-- stable for every draft and request that already points at it.  Rejecting
-- conflicting INSERT before conflict resolution also closes INSERT OR
-- REPLACE's ownership-theft path while the normal writer can safely re-read a
-- concurrent winner.
CREATE TRIGGER portal_native_request_storage_binding_conflicting_insert
BEFORE INSERT ON portal_native_request_storage_bindings
WHEN EXISTS (
  SELECT 1 FROM portal_native_request_storage_bindings binding
  WHERE binding.workspace_id=NEW.workspace_id
    OR binding.account_id=NEW.account_id
    OR binding.storage_identity_id=NEW.storage_identity_id
)
BEGIN SELECT RAISE(ABORT,'native request storage ownership already exists'); END;

CREATE TRIGGER portal_native_request_storage_binding_owner_update
BEFORE UPDATE OF workspace_id,source_id,account_id,storage_identity_id,created_at
ON portal_native_request_storage_bindings
WHEN NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.source_id IS NOT OLD.source_id
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.storage_identity_id IS NOT OLD.storage_identity_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'native request storage ownership is immutable'); END;

CREATE TRIGGER portal_native_request_storage_binding_delete
BEFORE DELETE ON portal_native_request_storage_bindings
BEGIN SELECT RAISE(ABORT,'native request storage ownership cannot be deleted'); END;

ALTER TABLE client_service_request_drafts ADD COLUMN portal_workspace_id TEXT;
ALTER TABLE client_service_request_drafts ADD COLUMN portal_identity_id TEXT;
ALTER TABLE client_service_request_drafts ADD COLUMN portal_project_public_id TEXT;
ALTER TABLE client_service_requests ADD COLUMN portal_workspace_id TEXT;
ALTER TABLE client_service_requests ADD COLUMN portal_identity_id TEXT;
ALTER TABLE client_service_requests ADD COLUMN portal_project_public_id TEXT;

CREATE INDEX client_request_drafts_native_owner
  ON client_service_request_drafts(portal_workspace_id,portal_identity_id,state,updated_at DESC,id DESC)
  WHERE portal_workspace_id IS NOT NULL;
CREATE INDEX client_requests_native_owner
  ON client_service_requests(portal_workspace_id,portal_identity_id,created_at DESC,id DESC)
  WHERE portal_workspace_id IS NOT NULL;

-- Direct-R2 part URLs are bearer capabilities.  A native actor must first
-- obtain a short-lived, one-time lease under the same live authority guard as
-- the request mutation.  The nonce is consumed by the part checkpoint; an
-- unconsumed lease can be replayed only until its bounded expiry so a lost HTTP
-- response does not force the browser to create a second capability.
CREATE TABLE portal_native_request_attachment_part_tickets (
  attachment_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 4),
  nonce TEXT NOT NULL UNIQUE CHECK (length(nonce) BETWEEN 32 AND 128),
  workspace_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  last_issued_at TEXT NOT NULL,
  PRIMARY KEY (attachment_id,part_number),
  FOREIGN KEY (attachment_id) REFERENCES client_service_request_attachments(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id) REFERENCES portal_v2_workspaces(id),
  FOREIGN KEY (identity_id) REFERENCES portal_v2_identities(id)
);
CREATE INDEX portal_native_request_attachment_ticket_expiry
  ON portal_native_request_attachment_part_tickets(expires_at)
  WHERE consumed_at IS NULL;

CREATE TRIGGER portal_native_request_attachment_ticket_owner_update
BEFORE UPDATE OF attachment_id,part_number,workspace_id,identity_id,source_id
ON portal_native_request_attachment_part_tickets
WHEN NEW.attachment_id IS NOT OLD.attachment_id OR NEW.part_number IS NOT OLD.part_number
  OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.identity_id IS NOT OLD.identity_id
  OR NEW.source_id IS NOT OLD.source_id
BEGIN SELECT RAISE(ABORT,'native request attachment ticket ownership is immutable'); END;

-- A native row is accepted only with the complete immutable ownership tuple.
-- The actor remains the portal identity; created_by_identity_id is only the
-- source-qualified storage identity required by the established FK graph.
CREATE TRIGGER client_request_drafts_native_owner_insert
BEFORE INSERT ON client_service_request_drafts
WHEN NEW.portal_workspace_id IS NOT NULL OR NEW.portal_identity_id IS NOT NULL
  OR NEW.portal_project_public_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'native request draft ownership is not current')
  WHERE NEW.portal_workspace_id IS NULL OR NEW.portal_identity_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM portal_native_request_storage_bindings binding
      JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id
        AND workspace.status='active' AND workspace.legacy_account_id IS NULL
        AND workspace.project_alpha_source_id=binding.source_id
      JOIN portal_v2_identities identity ON identity.id=NEW.portal_identity_id
        AND identity.status='active' AND identity.revoked_at IS NULL
      JOIN portal_v2_workspace_memberships membership
        ON membership.workspace_id=workspace.id AND membership.identity_id=identity.id
        AND membership.status='active' AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
      JOIN client_accounts account ON account.id=binding.account_id
        AND account.status='active' AND account.project_alpha_source_id=binding.source_id
      JOIN client_identity_links storage_identity
        ON storage_identity.id=binding.storage_identity_id
        AND storage_identity.account_id=binding.account_id AND storage_identity.revoked_at IS NULL
      WHERE binding.workspace_id=NEW.portal_workspace_id AND binding.state='active'
        AND binding.account_id=NEW.account_id
        AND binding.storage_identity_id=NEW.created_by_identity_id
        AND NEW.catalog_source_id=binding.source_id
        AND NEW.project_id IS NULL
        AND (NEW.portal_project_public_id IS NULL OR EXISTS (
          SELECT 1 FROM portal_v2_directory_checkpoints checkpoint
          JOIN portal_v2_directory_generations generation
            ON generation.id=checkpoint.active_generation_id
            AND generation.workspace_id=checkpoint.workspace_id
            AND generation.status='active' AND generation.complete=1
          JOIN portal_v2_directory_entities project
            ON project.workspace_id=workspace.id
            AND project.generation_id=checkpoint.active_generation_id
            AND project.entity_type='project'
            AND project.public_id=NEW.portal_project_public_id AND project.active=1
          WHERE checkpoint.workspace_id=workspace.id))
    );
END;

CREATE TRIGGER client_requests_native_owner_insert
BEFORE INSERT ON client_service_requests
WHEN NEW.portal_workspace_id IS NOT NULL OR NEW.portal_identity_id IS NOT NULL
  OR NEW.portal_project_public_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'native request ownership is not current')
  WHERE NEW.portal_workspace_id IS NULL OR NEW.portal_identity_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM portal_native_request_storage_bindings binding
      JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id
        AND workspace.status='active' AND workspace.legacy_account_id IS NULL
        AND workspace.project_alpha_source_id=binding.source_id
      JOIN portal_v2_identities identity ON identity.id=NEW.portal_identity_id
        AND identity.status='active' AND identity.revoked_at IS NULL
      JOIN portal_v2_workspace_memberships membership
        ON membership.workspace_id=workspace.id AND membership.identity_id=identity.id
        AND membership.status='active' AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
      JOIN client_accounts account ON account.id=binding.account_id
        AND account.status='active' AND account.project_alpha_source_id=binding.source_id
      JOIN client_identity_links storage_identity
        ON storage_identity.id=binding.storage_identity_id
        AND storage_identity.account_id=binding.account_id AND storage_identity.revoked_at IS NULL
      WHERE binding.workspace_id=NEW.portal_workspace_id AND binding.state='active'
        AND binding.account_id=NEW.account_id
        AND binding.storage_identity_id=NEW.created_by_identity_id
        AND NEW.catalog_source_id=binding.source_id
        AND NEW.project_id IS NULL
        AND (NEW.portal_project_public_id IS NULL OR EXISTS (
          SELECT 1 FROM portal_v2_directory_checkpoints checkpoint
          JOIN portal_v2_directory_generations generation
            ON generation.id=checkpoint.active_generation_id
            AND generation.workspace_id=checkpoint.workspace_id
            AND generation.status='active' AND generation.complete=1
          JOIN portal_v2_directory_entities project
            ON project.workspace_id=workspace.id
            AND project.generation_id=checkpoint.active_generation_id
            AND project.entity_type='project'
            AND project.public_id=NEW.portal_project_public_id AND project.active=1
          WHERE checkpoint.workspace_id=workspace.id))
    );
END;

CREATE TRIGGER client_request_drafts_native_owner_update
BEFORE UPDATE OF account_id,project_id,created_by_identity_id,catalog_source_id,
  portal_workspace_id,portal_identity_id
ON client_service_request_drafts
WHEN NEW.account_id IS NOT OLD.account_id OR NEW.project_id IS NOT OLD.project_id
  OR NEW.created_by_identity_id IS NOT OLD.created_by_identity_id
  OR NEW.catalog_source_id IS NOT OLD.catalog_source_id
  OR NEW.portal_workspace_id IS NOT OLD.portal_workspace_id
  OR NEW.portal_identity_id IS NOT OLD.portal_identity_id
BEGIN SELECT RAISE(ABORT,'request draft ownership is immutable'); END;

CREATE TRIGGER client_request_drafts_native_project_update
BEFORE UPDATE OF portal_project_public_id ON client_service_request_drafts
WHEN NEW.portal_workspace_id IS NOT NULL AND NEW.portal_project_public_id IS NOT OLD.portal_project_public_id
  AND NEW.portal_project_public_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM portal_native_request_storage_bindings binding
    JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id
      AND workspace.status='active' AND workspace.legacy_account_id IS NULL
      AND workspace.project_alpha_source_id=binding.source_id
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=checkpoint.workspace_id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities project ON project.workspace_id=workspace.id
      AND project.generation_id=checkpoint.active_generation_id AND project.entity_type='project'
      AND project.public_id=NEW.portal_project_public_id AND project.active=1
    WHERE binding.workspace_id=NEW.portal_workspace_id AND binding.source_id=NEW.catalog_source_id
      AND binding.account_id=NEW.account_id AND binding.storage_identity_id=NEW.created_by_identity_id
      AND binding.state='active')
BEGIN SELECT RAISE(ABORT,'native request draft project is not current'); END;

CREATE TRIGGER client_requests_native_owner_update
BEFORE UPDATE OF account_id,project_id,created_by_identity_id,catalog_source_id,
  portal_workspace_id,portal_identity_id,portal_project_public_id
ON client_service_requests
WHEN NEW.account_id IS NOT OLD.account_id OR NEW.project_id IS NOT OLD.project_id
  OR NEW.created_by_identity_id IS NOT OLD.created_by_identity_id
  OR NEW.catalog_source_id IS NOT OLD.catalog_source_id
  OR NEW.portal_workspace_id IS NOT OLD.portal_workspace_id
  OR NEW.portal_identity_id IS NOT OLD.portal_identity_id
  OR NEW.portal_project_public_id IS NOT OLD.portal_project_public_id
BEGIN SELECT RAISE(ABORT,'request ownership is immutable'); END;

-- A legacy row cannot be reinterpreted as native later. Native rows are only
-- created by the guarded native request writer above.
CREATE TRIGGER client_request_drafts_native_shape_update
BEFORE UPDATE ON client_service_request_drafts
WHEN (OLD.portal_workspace_id IS NULL)<>(NEW.portal_workspace_id IS NULL)
  OR (OLD.portal_identity_id IS NULL)<>(NEW.portal_identity_id IS NULL)
BEGIN SELECT RAISE(ABORT,'request draft ownership shape is immutable'); END;

CREATE TRIGGER client_requests_native_shape_update
BEFORE UPDATE ON client_service_requests
WHEN (OLD.portal_workspace_id IS NULL)<>(NEW.portal_workspace_id IS NULL)
  OR (OLD.portal_identity_id IS NULL)<>(NEW.portal_identity_id IS NULL)
BEGIN SELECT RAISE(ABORT,'request ownership shape is immutable'); END;
