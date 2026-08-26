PRAGMA foreign_keys = ON;

-- One immutable producer reservation owns each LOCAL workspace handle. There
-- is deliberately no FK to portal_v2_workspaces: complete snapshot pages are
-- staged before a native workspace exists. Legacy handles/root bytes are not
-- reinterpreted as native public IDs; primary adoption preserves them exactly.
CREATE TABLE pa_portal_workspace_sources (
  workspace_id TEXT PRIMARY KEY NOT NULL,
  projection_source_id TEXT NOT NULL CHECK (
    substr(projection_source_id,1,14)='project-alpha:'
    AND length(projection_source_id) BETWEEN 15 AND 78
    AND substr(projection_source_id,15,1) GLOB '[a-z0-9]'
    AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*'
    AND instr(projection_source_id,char(0))=0
  ),
  source_workspace_id TEXT NOT NULL,
  UNIQUE (projection_source_id,source_workspace_id),
  UNIQUE (workspace_id,projection_source_id)
);

-- Keep each statement below D1's compound-SELECT limit. All seven inserts run
-- in the same migration batch, before immutable reservation triggers exist;
-- overlapping historical handles deliberately retain the same primary tuple.
INSERT OR IGNORE INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
SELECT id,'project-alpha:primary',id FROM portal_v2_workspaces;
INSERT OR IGNORE INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
SELECT workspace_id,'project-alpha:primary',workspace_id FROM pa_portal_projection_generations;
INSERT OR IGNORE INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
SELECT workspace_id,'project-alpha:primary',workspace_id FROM pa_portal_projection_receipts;
INSERT OR IGNORE INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
SELECT workspace_id,'project-alpha:primary',workspace_id FROM pa_portal_projection_audit;
INSERT OR IGNORE INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
SELECT workspace_id,'project-alpha:primary',workspace_id FROM pa_portal_projection_checkpoints;
INSERT OR IGNORE INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
SELECT workspace_id,'project-alpha:primary',workspace_id FROM portal_v2_directory_generations;
INSERT OR IGNORE INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
SELECT workspace_id,'project-alpha:primary',workspace_id FROM portal_v2_directory_checkpoints;

CREATE TRIGGER pa_portal_workspace_sources_immutable_update
BEFORE UPDATE ON pa_portal_workspace_sources
WHEN NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.projection_source_id IS NOT OLD.projection_source_id
  OR NEW.source_workspace_id IS NOT OLD.source_workspace_id
BEGIN SELECT RAISE(ABORT,'portal workspace source ownership is immutable'); END;

CREATE TRIGGER pa_portal_workspace_sources_immutable_delete
BEFORE DELETE ON pa_portal_workspace_sources
BEGIN SELECT RAISE(ABORT,'portal workspace source reservations cannot be deleted'); END;

-- BEFORE INSERT also covers REPLACE (implicit DELETE triggers are not reliable
-- under SQLite's default recursive_triggers setting). Exact same-owner UPSERT
-- remains valid; this is an ownership guarantee, not a generic REPLACE ban.
CREATE TRIGGER pa_portal_workspace_sources_immutable_insert
BEFORE INSERT ON pa_portal_workspace_sources
WHEN EXISTS (SELECT 1 FROM pa_portal_workspace_sources existing
  WHERE (existing.workspace_id=NEW.workspace_id AND
    (existing.projection_source_id IS NOT NEW.projection_source_id
      OR existing.source_workspace_id IS NOT NEW.source_workspace_id))
    OR (existing.projection_source_id=NEW.projection_source_id
      AND existing.source_workspace_id=NEW.source_workspace_id
      AND existing.workspace_id<>NEW.workspace_id))
BEGIN SELECT RAISE(ABORT,'portal workspace source ownership is immutable'); END;

ALTER TABLE portal_v2_workspaces ADD COLUMN project_alpha_source_id TEXT NOT NULL
  DEFAULT 'project-alpha:primary' CHECK (
    substr(project_alpha_source_id,1,14)='project-alpha:'
    AND length(project_alpha_source_id) BETWEEN 15 AND 78
    AND substr(project_alpha_source_id,15,1) GLOB '[a-z0-9]'
    AND substr(project_alpha_source_id,15) NOT GLOB '*[^a-z0-9_-]*'
    AND instr(project_alpha_source_id,char(0))=0
  );
DROP INDEX idx_portal_v2_workspace_org_root;
DROP INDEX idx_portal_v2_workspace_client_root;
CREATE UNIQUE INDEX idx_portal_v2_workspace_org_root
  ON portal_v2_workspaces(project_alpha_source_id,pa_organization_public_id)
  WHERE pa_organization_public_id IS NOT NULL;
CREATE UNIQUE INDEX idx_portal_v2_workspace_client_root
  ON portal_v2_workspaces(project_alpha_source_id,pa_client_public_id)
  WHERE pa_client_public_id IS NOT NULL;
-- Client Hub's resumable native-root scan selects one source before keyset
-- pagination. Root-reference indexes do not serve this source + local-ID order.
CREATE INDEX idx_portal_v2_workspace_source_cursor
  ON portal_v2_workspaces(project_alpha_source_id,id COLLATE BINARY)
  WHERE status<>'closed';

CREATE TRIGGER portal_v2_workspace_owner_insert
BEFORE INSERT ON portal_v2_workspaces
WHEN EXISTS (SELECT 1 FROM portal_v2_workspaces existing WHERE
    (existing.id=NEW.id AND (existing.project_alpha_source_id IS NOT NEW.project_alpha_source_id
      OR existing.root_type IS NOT NEW.root_type
      OR existing.pa_organization_public_id IS NOT NEW.pa_organization_public_id
      OR existing.pa_client_public_id IS NOT NEW.pa_client_public_id))
    OR (existing.id<>NEW.id AND existing.project_alpha_source_id=NEW.project_alpha_source_id
      AND ((NEW.pa_organization_public_id IS NOT NULL AND existing.pa_organization_public_id=NEW.pa_organization_public_id)
        OR (NEW.pa_client_public_id IS NOT NULL AND existing.pa_client_public_id=NEW.pa_client_public_id)))
    OR (NEW.legacy_account_id IS NOT NULL AND existing.legacy_account_id=NEW.legacy_account_id AND existing.id<>NEW.id))
  OR EXISTS (SELECT 1 FROM pa_portal_workspace_sources owner WHERE owner.workspace_id=NEW.id
    AND owner.projection_source_id<>NEW.project_alpha_source_id)
  OR (NOT EXISTS (SELECT 1 FROM pa_portal_workspace_sources owner WHERE owner.workspace_id=NEW.id)
    AND (NEW.project_alpha_source_id<>'project-alpha:primary' OR EXISTS (
      SELECT 1 FROM pa_portal_workspace_sources owner
      WHERE owner.projection_source_id='project-alpha:primary' AND owner.source_workspace_id=NEW.id)))
  OR (NEW.project_alpha_source_id<>'project-alpha:primary' AND NEW.legacy_account_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'portal workspace ownership conflicts with its source reservation'); END;

-- Compatibility for existing primary-only native/legacy writers. Updated
-- production writers still provide source explicitly. No secondary reservation
-- is ever inferred and no membership or resource access is created here.
CREATE TRIGGER portal_v2_workspace_reserve_primary_insert
AFTER INSERT ON portal_v2_workspaces
WHEN NEW.project_alpha_source_id='project-alpha:primary'
BEGIN
  INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id)
  SELECT NEW.id,'project-alpha:primary',NEW.id
  WHERE NOT EXISTS (SELECT 1 FROM pa_portal_workspace_sources WHERE workspace_id=NEW.id);
END;

CREATE TRIGGER portal_v2_workspace_owner_update
BEFORE UPDATE ON portal_v2_workspaces
WHEN NEW.id IS NOT OLD.id OR NEW.project_alpha_source_id IS NOT OLD.project_alpha_source_id
  OR NEW.root_type IS NOT OLD.root_type
  OR NEW.pa_organization_public_id IS NOT OLD.pa_organization_public_id
  OR NEW.pa_client_public_id IS NOT OLD.pa_client_public_id
  OR NOT EXISTS (SELECT 1 FROM pa_portal_workspace_sources owner
    WHERE owner.workspace_id=NEW.id AND owner.projection_source_id=NEW.project_alpha_source_id)
  OR (NEW.project_alpha_source_id<>'project-alpha:primary' AND NEW.legacy_account_id IS NOT NULL)
  OR (NEW.legacy_account_id IS NOT NULL AND EXISTS (SELECT 1 FROM portal_v2_workspaces existing
    WHERE existing.id<>NEW.id AND existing.legacy_account_id=NEW.legacy_account_id))
BEGIN SELECT RAISE(ABORT,'portal workspace ownership is immutable'); END;

CREATE TRIGGER portal_v2_workspace_owner_delete
BEFORE DELETE ON portal_v2_workspaces
BEGIN SELECT RAISE(ABORT,'portal workspaces must be closed, not deleted'); END;

ALTER TABLE pa_portal_projection_generations ADD COLUMN projection_source_id TEXT NOT NULL
  DEFAULT 'project-alpha:primary' CHECK (
    substr(projection_source_id,1,14)='project-alpha:'
    AND length(projection_source_id) BETWEEN 15 AND 78
    AND substr(projection_source_id,15,1) GLOB '[a-z0-9]'
    AND substr(projection_source_id,15) NOT GLOB '*[^a-z0-9_-]*'
    AND instr(projection_source_id,char(0))=0
  );
CREATE UNIQUE INDEX idx_pa_portal_projection_generation_source
  ON pa_portal_projection_generations(id,workspace_id,projection_source_id);

CREATE TRIGGER pa_portal_projection_generation_owner_insert
BEFORE INSERT ON pa_portal_projection_generations
WHEN NOT EXISTS (SELECT 1 FROM pa_portal_workspace_sources owner
    WHERE owner.workspace_id=NEW.workspace_id AND owner.projection_source_id=NEW.projection_source_id)
  OR EXISTS (SELECT 1 FROM pa_portal_projection_generations existing WHERE
    (existing.id=NEW.id AND (existing.workspace_id IS NOT NEW.workspace_id
      OR existing.projection_source_id IS NOT NEW.projection_source_id
      OR existing.source_generation IS NOT NEW.source_generation OR existing.source_sequence IS NOT NEW.source_sequence
      OR existing.snapshot_hash IS NOT NEW.snapshot_hash OR existing.page_count IS NOT NEW.page_count
      OR existing.record_count IS NOT NEW.record_count OR existing.workspace_root_type IS NOT NEW.workspace_root_type
      OR existing.workspace_root_public_id IS NOT NEW.workspace_root_public_id
      OR existing.workspace_display_name IS NOT NEW.workspace_display_name
      OR existing.workspace_source_version IS NOT NEW.workspace_source_version OR existing.workspace_active IS NOT NEW.workspace_active))
    OR (existing.id<>NEW.id AND existing.workspace_id=NEW.workspace_id
      AND (existing.source_generation=NEW.source_generation OR existing.source_sequence=NEW.source_sequence)))
BEGIN SELECT RAISE(ABORT,'portal projection generation ownership conflicts'); END;

CREATE TRIGGER pa_portal_projection_generation_owner_update
BEFORE UPDATE ON pa_portal_projection_generations
WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.projection_source_id IS NOT OLD.projection_source_id
  OR NEW.source_generation IS NOT OLD.source_generation OR NEW.source_sequence IS NOT OLD.source_sequence
  OR NEW.snapshot_hash IS NOT OLD.snapshot_hash OR NEW.page_count IS NOT OLD.page_count
  OR NEW.record_count IS NOT OLD.record_count OR NEW.workspace_root_type IS NOT OLD.workspace_root_type
  OR NEW.workspace_root_public_id IS NOT OLD.workspace_root_public_id
  OR NEW.workspace_display_name IS NOT OLD.workspace_display_name
  OR NEW.workspace_source_version IS NOT OLD.workspace_source_version OR NEW.workspace_active IS NOT OLD.workspace_active
  OR NOT EXISTS (SELECT 1 FROM pa_portal_workspace_sources owner
    WHERE owner.workspace_id=NEW.workspace_id AND owner.projection_source_id=NEW.projection_source_id)
BEGIN SELECT RAISE(ABORT,'portal projection generation ownership is immutable'); END;

-- Directory generations inherit immutable producer ownership through the local
-- workspace. Their existing composite FKs already isolate all entity children.
CREATE TRIGGER portal_v2_directory_generation_owner_insert
BEFORE INSERT ON portal_v2_directory_generations
WHEN NOT EXISTS (SELECT 1 FROM portal_v2_workspaces workspace
    JOIN pa_portal_workspace_sources owner ON owner.workspace_id=workspace.id
      AND owner.projection_source_id=workspace.project_alpha_source_id
    WHERE workspace.id=NEW.workspace_id)
  OR EXISTS (SELECT 1 FROM portal_v2_directory_generations existing WHERE
    (existing.id=NEW.id AND (existing.workspace_id IS NOT NEW.workspace_id
      OR existing.source_generation IS NOT NEW.source_generation OR existing.source_sequence IS NOT NEW.source_sequence))
    OR (existing.id<>NEW.id AND existing.workspace_id=NEW.workspace_id
      AND (existing.source_generation=NEW.source_generation OR existing.source_sequence=NEW.source_sequence)))
BEGIN SELECT RAISE(ABORT,'portal directory generation ownership conflicts'); END;

CREATE TRIGGER portal_v2_directory_generation_owner_update
BEFORE UPDATE ON portal_v2_directory_generations
WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.source_generation IS NOT OLD.source_generation OR NEW.source_sequence IS NOT OLD.source_sequence
BEGIN SELECT RAISE(ABORT,'portal directory generation ownership is immutable'); END;

-- Receipts are a leaf table: rebuild only this table, preserving payload hashes,
-- delivery IDs, workspace handles, timestamps and status exactly. A failed
-- transaction-time write_guard rolls back the entire D1 batch before authority
-- writes. An ignored zero-row checkpoint update is not a transaction guard.
CREATE TABLE pa_portal_projection_receipts_source (
  projection_source_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('snapshot_page','snapshot_activate','event')),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash)=64),
  source_sequence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','ignored')),
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  write_guard INTEGER NOT NULL DEFAULT 1 CONSTRAINT pa_portal_projection_write_guard CHECK (write_guard=1),
  PRIMARY KEY (projection_source_id,delivery_id),
  FOREIGN KEY (workspace_id,projection_source_id)
    REFERENCES pa_portal_workspace_sources(workspace_id,projection_source_id) ON DELETE RESTRICT
);
INSERT INTO pa_portal_projection_receipts_source
  (projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status,received_at)
SELECT 'project-alpha:primary',delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status,received_at
FROM pa_portal_projection_receipts;
DROP TABLE pa_portal_projection_receipts;
ALTER TABLE pa_portal_projection_receipts_source RENAME TO pa_portal_projection_receipts;
CREATE INDEX idx_pa_portal_projection_receipts_workspace
  ON pa_portal_projection_receipts(workspace_id,projection_source_id,received_at);

CREATE TRIGGER pa_portal_projection_receipt_immutable_update
BEFORE UPDATE ON pa_portal_projection_receipts
BEGIN SELECT RAISE(ABORT,'portal projection receipt is immutable'); END;
CREATE TRIGGER pa_portal_projection_receipt_immutable_delete
BEFORE DELETE ON pa_portal_projection_receipts
BEGIN SELECT RAISE(ABORT,'portal projection receipt is immutable'); END;
CREATE TRIGGER pa_portal_projection_receipt_immutable_insert
BEFORE INSERT ON pa_portal_projection_receipts
WHEN EXISTS (SELECT 1 FROM pa_portal_projection_receipts existing
  WHERE existing.projection_source_id=NEW.projection_source_id AND existing.delivery_id=NEW.delivery_id
    AND (existing.workspace_id IS NOT NEW.workspace_id OR existing.delivery_kind IS NOT NEW.delivery_kind
      OR existing.payload_hash IS NOT NEW.payload_hash OR existing.source_sequence IS NOT NEW.source_sequence
      OR existing.status IS NOT NEW.status OR existing.received_at IS NOT NEW.received_at))
BEGIN SELECT RAISE(ABORT,'portal projection receipt conflicts'); END;

CREATE TRIGGER pa_portal_projection_checkpoint_owner_insert
BEFORE INSERT ON pa_portal_projection_checkpoints
WHEN NOT EXISTS (SELECT 1 FROM pa_portal_projection_generations generation
  JOIN pa_portal_workspace_sources owner ON owner.workspace_id=generation.workspace_id
    AND owner.projection_source_id=generation.projection_source_id
  WHERE generation.id=NEW.snapshot_generation_id AND generation.workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'portal projection checkpoint ownership conflicts'); END;
CREATE TRIGGER pa_portal_projection_checkpoint_owner_update
BEFORE UPDATE ON pa_portal_projection_checkpoints
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NOT EXISTS (
  SELECT 1 FROM pa_portal_projection_generations generation
  JOIN pa_portal_workspace_sources owner ON owner.workspace_id=generation.workspace_id
    AND owner.projection_source_id=generation.projection_source_id
  WHERE generation.id=NEW.snapshot_generation_id AND generation.workspace_id=NEW.workspace_id)
BEGIN SELECT RAISE(ABORT,'portal projection checkpoint ownership conflicts'); END;

-- Audits retain their original bytes and derive producer identity from the
-- permanent workspace reservation; no denormalized source can drift.
CREATE TRIGGER pa_portal_projection_audit_owner_insert
BEFORE INSERT ON pa_portal_projection_audit
WHEN NOT EXISTS (SELECT 1 FROM pa_portal_workspace_sources WHERE workspace_id=NEW.workspace_id)
  OR EXISTS (SELECT 1 FROM pa_portal_projection_audit existing WHERE existing.id=NEW.id
    AND (existing.workspace_id IS NOT NEW.workspace_id OR existing.delivery_id IS NOT NEW.delivery_id))
BEGIN SELECT RAISE(ABORT,'portal projection audit ownership conflicts'); END;
CREATE TRIGGER pa_portal_projection_audit_owner_update
BEFORE UPDATE ON pa_portal_projection_audit
WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.delivery_id IS NOT OLD.delivery_id
BEGIN SELECT RAISE(ABORT,'portal projection audit ownership is immutable'); END;

-- A reserved secondary source is synthetic storage, not portal activation.
-- Existing primary local-NULL legacy wrappers remain valid. No secondary
-- workspace may receive a compatibility bridge to the primary legacy portal.
CREATE TRIGGER portal_v2_legacy_bridge_workspace_source_insert
BEFORE INSERT ON portal_v2_legacy_member_bridges
WHEN EXISTS (SELECT 1 FROM portal_v2_workspaces WHERE id=NEW.workspace_id
  AND project_alpha_source_id<>'project-alpha:primary')
BEGIN SELECT RAISE(ABORT,'legacy bridge requires primary portal source'); END;
CREATE TRIGGER portal_v2_legacy_bridge_workspace_source_update
BEFORE UPDATE ON portal_v2_legacy_member_bridges
WHEN (NEW.revoked_at IS NULL OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.legacy_account_id IS NOT OLD.legacy_account_id OR NEW.identity_id IS NOT OLD.identity_id)
AND EXISTS (SELECT 1 FROM portal_v2_workspaces WHERE id=NEW.workspace_id
  AND project_alpha_source_id<>'project-alpha:primary')
BEGIN SELECT RAISE(ABORT,'legacy bridge requires primary portal source'); END;
CREATE TRIGGER portal_v2_eligibility_bridge_workspace_source_insert
BEFORE INSERT ON portal_v2_identity_eligibility_legacy_bridges
WHEN EXISTS (SELECT 1 FROM portal_v2_workspaces WHERE id=NEW.workspace_id
  AND project_alpha_source_id<>'project-alpha:primary')
BEGIN SELECT RAISE(ABORT,'eligibility bridge requires primary portal source'); END;
CREATE TRIGGER portal_v2_eligibility_bridge_workspace_source_update
BEFORE UPDATE ON portal_v2_identity_eligibility_legacy_bridges
WHEN (NEW.revoked_at IS NULL OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.legacy_account_id IS NOT OLD.legacy_account_id OR NEW.identity_id IS NOT OLD.identity_id)
AND EXISTS (SELECT 1 FROM portal_v2_workspaces WHERE id=NEW.workspace_id
  AND project_alpha_source_id<>'project-alpha:primary')
BEGIN SELECT RAISE(ABORT,'eligibility bridge requires primary portal source'); END;
