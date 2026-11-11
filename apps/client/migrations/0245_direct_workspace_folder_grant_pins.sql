PRAGMA foreign_keys=ON;

-- Keep the membership pin monotonic and assert it in the same D1 transaction
-- that inserts a direct Ops folder grant. A read-then-check in application
-- code is insufficient because membership can change before the grant batch.
CREATE TABLE operations_portal_direct_folder_membership_versions (
  workspace_id TEXT PRIMARY KEY REFERENCES portal_v2_workspaces(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0)
);
INSERT INTO operations_portal_direct_folder_membership_versions(workspace_id,revision)
  SELECT id,0 FROM portal_v2_workspaces;

ALTER TABLE operations_portal_direct_folder_grants
  ADD COLUMN membership_revision INTEGER NOT NULL DEFAULT 0 CHECK(membership_revision>=0);
ALTER TABLE operations_portal_direct_folder_grants
  ADD COLUMN member_count INTEGER NOT NULL DEFAULT 0 CHECK(member_count BETWEEN 0 AND 1000);

DROP TRIGGER operations_portal_direct_folder_grant_authority_immutable;
CREATE TRIGGER operations_portal_direct_folder_grant_authority_immutable
BEFORE UPDATE ON operations_portal_direct_folder_grants
WHEN OLD.grant_id IS NOT NEW.grant_id OR OLD.workspace_id IS NOT NEW.workspace_id
  OR OLD.target_id IS NOT NEW.target_id OR OLD.client_authority_id IS NOT NEW.client_authority_id
  OR OLD.target_revision IS NOT NEW.target_revision OR OLD.publication_revision IS NOT NEW.publication_revision
  OR OLD.publication_snapshot_id IS NOT NEW.publication_snapshot_id
  OR OLD.publication_snapshot_sha256 IS NOT NEW.publication_snapshot_sha256
  OR OLD.source_id IS NOT NEW.source_id OR OLD.folder_ref IS NOT NEW.folder_ref
  OR OLD.owner_scope_type IS NOT NEW.owner_scope_type OR OLD.owner_record_id IS NOT NEW.owner_record_id
  OR OLD.recipient_record_id IS NOT NEW.recipient_record_id OR OLD.audience IS NOT NEW.audience
  OR OLD.expires_at IS NOT NEW.expires_at OR OLD.created_by_operation_id IS NOT NEW.created_by_operation_id
  OR OLD.created_at IS NOT NEW.created_at OR OLD.membership_revision IS NOT NEW.membership_revision
  OR OLD.member_count IS NOT NEW.member_count OR NEW.grant_version<>OLD.grant_version+1
  OR OLD.status<>'active' OR NEW.status<>'revoked' OR NEW.revoked_at IS NULL OR NEW.revoked_by_operation_id IS NULL
BEGIN SELECT RAISE(ABORT,'direct folder grant authority is immutable'); END;

CREATE TRIGGER operations_portal_direct_folder_workspace_revision_insert
AFTER INSERT ON portal_v2_workspaces
BEGIN
  INSERT INTO operations_portal_direct_folder_membership_versions(workspace_id,revision) VALUES(NEW.id,0)
  ON CONFLICT(workspace_id) DO NOTHING;
END;

CREATE TRIGGER operations_portal_direct_folder_workspace_revision_update
AFTER UPDATE OF status,root_type,pa_organization_public_id,pa_client_public_id,project_alpha_source_id
ON portal_v2_workspaces
BEGIN
  UPDATE operations_portal_direct_folder_membership_versions SET revision=revision+1 WHERE workspace_id=NEW.id;
END;

CREATE TRIGGER operations_portal_direct_folder_membership_revision_insert
AFTER INSERT ON portal_v2_workspace_memberships
BEGIN
  INSERT INTO operations_portal_direct_folder_membership_versions(workspace_id,revision) VALUES(NEW.workspace_id,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER operations_portal_direct_folder_membership_revision_update
AFTER UPDATE OF workspace_id,identity_id,source_type,status,source_version,expires_at,revoked_at
ON portal_v2_workspace_memberships
BEGIN
  UPDATE operations_portal_direct_folder_membership_versions SET revision=revision+1 WHERE workspace_id=OLD.workspace_id;
  INSERT INTO operations_portal_direct_folder_membership_versions(workspace_id,revision)
    SELECT NEW.workspace_id,1 WHERE NEW.workspace_id<>OLD.workspace_id
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

CREATE TRIGGER operations_portal_direct_folder_membership_revision_delete
AFTER DELETE ON portal_v2_workspace_memberships
BEGIN
  UPDATE operations_portal_direct_folder_membership_versions SET revision=revision+1 WHERE workspace_id=OLD.workspace_id;
END;

CREATE TRIGGER operations_portal_direct_folder_identity_revision_update
AFTER UPDATE OF issuer,subject,status,revoked_at ON portal_v2_identities
BEGIN
  UPDATE operations_portal_direct_folder_membership_versions SET revision=revision+1
  WHERE workspace_id IN (SELECT workspace_id FROM portal_v2_workspace_memberships WHERE identity_id=NEW.id);
END;

CREATE TRIGGER operations_portal_direct_folder_identity_revision_insert
AFTER INSERT ON portal_v2_identities
BEGIN
  UPDATE operations_portal_direct_folder_membership_versions SET revision=revision+1
  WHERE workspace_id IN (SELECT workspace_id FROM portal_v2_workspace_memberships WHERE identity_id=NEW.id);
END;

-- The membership and publication pins are revalidated inside the INSERT's
-- transaction. If any pin has moved, aborting the batch also rolls back the
-- grant, mutation receipt and audit row.
CREATE TRIGGER operations_portal_direct_folder_grant_current_pins
BEFORE INSERT ON operations_portal_direct_folder_grants
WHEN NOT EXISTS(
  SELECT 1
  FROM operations_portal_native_workspace_authority_heads authority
  JOIN operations_portal_workspace_publication_heads publication
    ON publication.target_id=authority.target_id
    AND publication.target_revision=authority.target_revision
    AND publication.client_authority_id=authority.client_authority_id
    AND publication.workspace_id=authority.workspace_id
  JOIN operations_portal_workspace_publication_receipts receipt
    ON receipt.operation_id=publication.latest_operation_id
    AND receipt.target_id=publication.target_id
    AND receipt.resulting_revision=publication.revision
    AND receipt.snapshot_id=publication.snapshot_id
    AND receipt.snapshot_sha256=publication.snapshot_sha256
  JOIN operations_portal_workspace_publication_snapshots snapshot
    ON snapshot.snapshot_id=publication.snapshot_id
    AND snapshot.target_id=publication.target_id
    AND snapshot.revision=publication.revision
    AND snapshot.source_sequence=publication.source_sequence
    AND snapshot.snapshot_sha256=publication.snapshot_sha256
  JOIN portal_v2_workspaces workspace
    ON workspace.id=authority.workspace_id
    AND workspace.status='active'
    AND workspace.root_type=authority.root_kind
    AND COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)=NEW.owner_record_id
    AND workspace.project_alpha_source_id=NEW.source_id
  JOIN pa_portal_workspace_sources source
    ON source.workspace_id=workspace.id AND source.projection_source_id=NEW.source_id
  JOIN operations_portal_direct_folder_membership_versions membership_version
    ON membership_version.workspace_id=workspace.id
  WHERE authority.target_id=NEW.target_id
    AND authority.workspace_id=NEW.workspace_id
    AND authority.client_authority_id=NEW.client_authority_id
    AND authority.target_revision=NEW.target_revision
    AND authority.state='active'
    AND NEW.owner_scope_type=CASE WHEN authority.root_kind='organization' THEN 'organization' ELSE 'client' END
    AND publication.revision=NEW.publication_revision
    AND publication.snapshot_id=NEW.publication_snapshot_id
    AND publication.snapshot_sha256=NEW.publication_snapshot_sha256
    AND membership_version.revision=NEW.membership_revision
    AND NEW.member_count>0
    AND NEW.member_count=(
      SELECT COUNT(*)
      FROM portal_v2_workspace_memberships membership
      JOIN portal_v2_identities identity ON identity.id=membership.identity_id
      WHERE membership.workspace_id=workspace.id
        AND membership.status='active' AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
        AND identity.status='active' AND identity.revoked_at IS NULL
    )
)
BEGIN SELECT RAISE(ABORT,'direct folder grant pins changed'); END;
