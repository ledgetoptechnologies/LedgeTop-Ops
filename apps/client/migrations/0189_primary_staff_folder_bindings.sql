PRAGMA foreign_keys = ON;

-- Staff may associate an Operations folder with an already signed, active
-- primary Project Alpha workspace.  This receipt is deliberately separate
-- from portal_native_staff_bindings: that table proves a secondary connector
-- delegation and its source-authority contract excludes the primary source.
-- A folder binding is only routing metadata; it creates no membership,
-- identity, entitlement, grant, or bearer link.
CREATE TABLE portal_primary_staff_bindings (
  binding_id TEXT PRIMARY KEY REFERENCES portal_v2_folder_bindings(id),
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL CHECK(source_id='project-alpha:primary'),
  root_type TEXT NOT NULL CHECK(root_type IN ('organization','standalone_client')),
  root_public_id TEXT NOT NULL,
  owner_scope_type TEXT NOT NULL CHECK(owner_scope_type IN ('organization','client','project')),
  owner_public_id TEXT NOT NULL,
  project_public_id TEXT,
  directory_generation_id TEXT NOT NULL,
  snapshot_generation_id TEXT NOT NULL,
  source_sequence INTEGER NOT NULL CHECK(source_sequence>=1),
  root_source_version TEXT NOT NULL,
  project_source_version TEXT,
  r2_prefix TEXT NOT NULL,
  ops_project_id TEXT,
  ops_context_version TEXT NOT NULL CHECK(length(ops_context_version)=64 AND ops_context_version NOT GLOB '*[^a-f0-9]*'),
  created_by_staff_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','suspended','revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(workspace_id,r2_prefix),
  FOREIGN KEY(workspace_id,source_id) REFERENCES pa_portal_workspace_sources(workspace_id,projection_source_id)
);

CREATE TABLE portal_primary_staff_binding_mutations (
  actor_staff_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('binding.create','binding.revoke')),
  request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^a-f0-9]*'),
  binding_id TEXT NOT NULL REFERENCES portal_primary_staff_bindings(binding_id),
  binding_version INTEGER NOT NULL CHECK(binding_version>0),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  PRIMARY KEY(actor_staff_id,idempotency_key)
);

CREATE TABLE portal_primary_staff_binding_audit (
  id TEXT PRIMARY KEY,
  binding_id TEXT NOT NULL REFERENCES portal_primary_staff_bindings(binding_id),
  binding_version INTEGER NOT NULL CHECK(binding_version>0),
  action TEXT NOT NULL CHECK(action IN ('binding.created','binding.suspended','binding.revoked')),
  actor_staff_id TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  UNIQUE(binding_id,binding_version)
);

CREATE TABLE portal_primary_staff_binding_write_fences (
  id TEXT PRIMARY KEY,
  write_guard INTEGER NOT NULL CONSTRAINT portal_primary_staff_binding_write_guard CHECK(write_guard=1)
);

CREATE INDEX idx_portal_primary_staff_binding_state
  ON portal_primary_staff_bindings(state,workspace_id,updated_at DESC);

-- Upgrade coherent pre-0189 primary Operations bindings in place. They remain
-- usable, but runtime revalidation treats this explicit compatibility reason
-- as a structural receipt and rechecks the current Operations owner/root on
-- every privileged read or write. Bindings that cannot be proven from one
-- active signed projection are intentionally left unreceipted and fail closed
-- until staff relinks them through the reviewed workflow.
INSERT INTO portal_primary_staff_bindings(
  binding_id,workspace_id,source_id,root_type,root_public_id,owner_scope_type,owner_public_id,project_public_id,
  directory_generation_id,snapshot_generation_id,source_sequence,root_source_version,project_source_version,
  r2_prefix,ops_project_id,ops_context_version,created_by_staff_id,reason_code,state
)
SELECT binding.id,workspace.id,'project-alpha:primary',workspace.root_type,
  COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id),binding.owner_scope_type,binding.owner_public_id,
  CASE WHEN binding.owner_scope_type='project' THEN binding.owner_public_id END,
  directory_generation.id,projection_generation.id,projection_checkpoint.source_sequence,root_entity.source_version,
  CASE WHEN binding.owner_scope_type='project' THEN owner_entity.source_version END,binding.r2_prefix,
  CASE WHEN binding.owner_scope_type='project' THEN 'legacy:'||binding.owner_public_id END,
  '0000000000000000000000000000000000000000000000000000000000000000',
  'migration:0189','migration_0189_legacy_compat','active'
FROM portal_v2_folder_bindings binding
JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id
JOIN pa_portal_workspace_sources source ON source.workspace_id=workspace.id
  AND source.projection_source_id=workspace.project_alpha_source_id
JOIN portal_v2_directory_checkpoints directory_checkpoint ON directory_checkpoint.workspace_id=workspace.id
JOIN portal_v2_directory_generations directory_generation ON directory_generation.id=directory_checkpoint.active_generation_id
  AND directory_generation.workspace_id=workspace.id AND directory_generation.status='active' AND directory_generation.complete=1
JOIN pa_portal_projection_checkpoints projection_checkpoint ON projection_checkpoint.workspace_id=workspace.id
  AND projection_checkpoint.source_sequence=directory_checkpoint.source_sequence
JOIN pa_portal_projection_generations projection_generation ON projection_generation.id=projection_checkpoint.snapshot_generation_id
  AND projection_generation.workspace_id=workspace.id AND projection_generation.projection_source_id=workspace.project_alpha_source_id
  AND projection_generation.status='active' AND projection_generation.complete=1
JOIN portal_v2_directory_entities root_entity ON root_entity.workspace_id=workspace.id
  AND root_entity.generation_id=directory_generation.id AND root_entity.entity_type=workspace.root_type
  AND root_entity.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) AND root_entity.active=1
JOIN portal_v2_directory_entities owner_entity ON owner_entity.workspace_id=workspace.id
  AND owner_entity.generation_id=directory_generation.id AND owner_entity.entity_type=binding.owner_scope_type
  AND owner_entity.public_id=binding.owner_public_id AND owner_entity.active=1
WHERE binding.source_type='operations' AND binding.source_version IS NOT NULL
  AND binding.status='active' AND binding.revoked_at IS NULL
  AND workspace.project_alpha_source_id='project-alpha:primary' AND workspace.status='active';

-- The transaction must still point at the exact signed projection generation,
-- root, project and source versions selected during review.  This trigger is
-- the Delivery-D1 transaction fence; the Operations proof is rechecked after
-- publication and suspends the binding if the separate database changed.
CREATE TRIGGER portal_primary_staff_binding_insert_guard
BEFORE INSERT ON portal_primary_staff_bindings
WHEN NEW.state<>'active'
 OR EXISTS(SELECT 1 FROM portal_primary_staff_bindings WHERE binding_id=NEW.binding_id OR (workspace_id=NEW.workspace_id AND r2_prefix=NEW.r2_prefix))
 OR NOT EXISTS(
   SELECT 1
   FROM portal_v2_folder_bindings binding
   JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id
   JOIN pa_portal_workspace_sources source ON source.workspace_id=workspace.id
     AND source.projection_source_id=workspace.project_alpha_source_id
   JOIN portal_v2_directory_checkpoints directory_checkpoint ON directory_checkpoint.workspace_id=workspace.id
   JOIN portal_v2_directory_generations directory_generation
     ON directory_generation.id=directory_checkpoint.active_generation_id
     AND directory_generation.workspace_id=workspace.id AND directory_generation.status='active' AND directory_generation.complete=1
   JOIN pa_portal_projection_checkpoints projection_checkpoint ON projection_checkpoint.workspace_id=workspace.id
   JOIN pa_portal_projection_generations projection_generation
     ON projection_generation.id=projection_checkpoint.snapshot_generation_id
     AND projection_generation.workspace_id=workspace.id AND projection_generation.projection_source_id=workspace.project_alpha_source_id
     AND projection_generation.status='active' AND projection_generation.complete=1
   JOIN portal_v2_directory_entities root_entity
     ON root_entity.workspace_id=workspace.id AND root_entity.generation_id=directory_generation.id
     AND root_entity.entity_type=workspace.root_type
     AND root_entity.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) AND root_entity.active=1
   JOIN portal_v2_directory_entities owner_entity
     ON owner_entity.workspace_id=workspace.id AND owner_entity.generation_id=directory_generation.id
     AND owner_entity.entity_type=binding.owner_scope_type AND owner_entity.public_id=binding.owner_public_id AND owner_entity.active=1
   LEFT JOIN portal_v2_directory_entities project_entity
     ON project_entity.workspace_id=workspace.id AND project_entity.generation_id=directory_generation.id
     AND project_entity.entity_type='project' AND project_entity.public_id=NEW.project_public_id AND project_entity.active=1
   WHERE binding.id=NEW.binding_id AND binding.workspace_id=NEW.workspace_id
     AND binding.owner_scope_type=NEW.owner_scope_type AND binding.owner_public_id=NEW.owner_public_id
     AND binding.r2_prefix=NEW.r2_prefix AND binding.source_type='operations'
     AND binding.source_version IS NOT NULL AND binding.status='active' AND binding.revoked_at IS NULL
     AND workspace.project_alpha_source_id=NEW.source_id
     AND (workspace.legacy_account_id IS NULL OR NEW.reason_code='migration_0189_legacy_compat') AND workspace.status='active'
     AND workspace.root_type=NEW.root_type
     AND COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)=NEW.root_public_id
     AND directory_generation.id=NEW.directory_generation_id
     AND projection_generation.id=NEW.snapshot_generation_id
     AND projection_checkpoint.source_sequence=NEW.source_sequence
     AND directory_checkpoint.source_sequence=NEW.source_sequence
     AND root_entity.source_version=NEW.root_source_version
     AND ((NEW.owner_scope_type='project' AND NEW.project_public_id=NEW.owner_public_id
       AND project_entity.source_version=NEW.project_source_version AND NEW.ops_project_id IS NOT NULL)
      OR (NEW.owner_scope_type<>'project' AND NEW.project_public_id IS NULL
       AND NEW.project_source_version IS NULL AND NEW.ops_project_id IS NULL))
 )
BEGIN SELECT RAISE(ABORT,'primary-staff-binding-context'); END;

CREATE TRIGGER portal_primary_staff_binding_update_guard
BEFORE UPDATE ON portal_primary_staff_bindings
WHEN NEW.binding_id IS NOT OLD.binding_id OR NEW.workspace_id IS NOT OLD.workspace_id
 OR NEW.source_id IS NOT OLD.source_id OR NEW.root_type IS NOT OLD.root_type
 OR NEW.root_public_id IS NOT OLD.root_public_id OR NEW.owner_scope_type IS NOT OLD.owner_scope_type
 OR NEW.owner_public_id IS NOT OLD.owner_public_id OR NEW.project_public_id IS NOT OLD.project_public_id
 OR NEW.directory_generation_id IS NOT OLD.directory_generation_id
 OR NEW.snapshot_generation_id IS NOT OLD.snapshot_generation_id OR NEW.source_sequence IS NOT OLD.source_sequence
 OR NEW.root_source_version IS NOT OLD.root_source_version OR NEW.project_source_version IS NOT OLD.project_source_version
 OR NEW.r2_prefix IS NOT OLD.r2_prefix OR NEW.ops_project_id IS NOT OLD.ops_project_id
 OR NEW.ops_context_version IS NOT OLD.ops_context_version OR NEW.created_by_staff_id IS NOT OLD.created_by_staff_id
 OR NEW.reason_code IS NOT OLD.reason_code OR NEW.created_at IS NOT OLD.created_at
 OR NEW.version<>OLD.version+1 OR OLD.state='revoked'
 OR (OLD.state='active' AND NEW.state NOT IN ('suspended','revoked'))
 OR (OLD.state='suspended' AND NEW.state<>'revoked')
BEGIN SELECT RAISE(ABORT,'primary-staff-binding-immutable'); END;

CREATE TRIGGER portal_primary_staff_binding_no_delete BEFORE DELETE ON portal_primary_staff_bindings
BEGIN SELECT RAISE(ABORT,'primary-staff-binding-immutable'); END;

CREATE TRIGGER portal_primary_staff_folder_identity_guard
BEFORE UPDATE ON portal_v2_folder_bindings
WHEN EXISTS(SELECT 1 FROM portal_primary_staff_bindings receipt WHERE receipt.binding_id=OLD.id)
 AND (NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id
   OR NEW.owner_scope_type IS NOT OLD.owner_scope_type OR NEW.owner_public_id IS NOT OLD.owner_public_id
   OR NEW.r2_prefix IS NOT OLD.r2_prefix OR NEW.source_type IS NOT OLD.source_type
   OR NEW.source_version IS NOT OLD.source_version)
BEGIN SELECT RAISE(ABORT,'primary-staff-folder-immutable'); END;

CREATE TRIGGER portal_primary_staff_folder_replace_guard
BEFORE INSERT ON portal_v2_folder_bindings
WHEN EXISTS(SELECT 1 FROM portal_primary_staff_bindings receipt
  WHERE receipt.binding_id=NEW.id OR (receipt.workspace_id=NEW.workspace_id AND receipt.r2_prefix=NEW.r2_prefix))
BEGIN SELECT RAISE(ABORT,'primary-staff-folder-immutable'); END;

-- Grant creation and binding revocation are serialized by Delivery D1. A
-- grant cannot be inserted after a receipt stops being active, and a binding
-- cannot be revoked after an active grant wins the race.
CREATE TRIGGER portal_primary_staff_grant_insert_guard
BEFORE INSERT ON portal_v2_authenticated_delivery_grants
WHEN EXISTS(
  SELECT 1 FROM portal_v2_folder_bindings binding JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id
  WHERE binding.id=NEW.folder_binding_id AND binding.source_type='operations'
    AND workspace.project_alpha_source_id='project-alpha:primary'
) AND NOT EXISTS(
  SELECT 1 FROM portal_primary_staff_bindings receipt
  JOIN portal_v2_folder_bindings binding ON binding.id=receipt.binding_id
  WHERE receipt.binding_id=NEW.folder_binding_id AND receipt.workspace_id=NEW.workspace_id
    AND receipt.state='active' AND binding.status='active' AND binding.revoked_at IS NULL
    AND binding.source_version=NEW.binding_source_version
)
BEGIN SELECT RAISE(ABORT,'primary-staff-binding-required'); END;

CREATE TRIGGER portal_primary_staff_folder_revoke_grant_guard
BEFORE UPDATE OF status,revoked_at ON portal_v2_folder_bindings
WHEN EXISTS(SELECT 1 FROM portal_primary_staff_bindings receipt WHERE receipt.binding_id=OLD.id)
 AND OLD.status='active' AND NEW.status='revoked'
 AND EXISTS(SELECT 1 FROM portal_v2_authenticated_delivery_grants grant_record
   WHERE grant_record.folder_binding_id=OLD.id AND grant_record.status='active' AND grant_record.revoked_at IS NULL
     AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now')))
BEGIN SELECT RAISE(ABORT,'primary-staff-binding-active-grants'); END;

CREATE TRIGGER portal_primary_staff_binding_mutation_insert_guard
BEFORE INSERT ON portal_primary_staff_binding_mutations
WHEN EXISTS(SELECT 1 FROM portal_primary_staff_binding_mutations
  WHERE actor_staff_id=NEW.actor_staff_id AND idempotency_key=NEW.idempotency_key)
 OR NOT EXISTS(SELECT 1 FROM portal_primary_staff_bindings receipt
   WHERE receipt.binding_id=NEW.binding_id AND receipt.version=NEW.binding_version)
BEGIN SELECT RAISE(ABORT,'primary-staff-binding-mutation'); END;
CREATE TRIGGER portal_primary_staff_binding_mutation_no_update BEFORE UPDATE ON portal_primary_staff_binding_mutations
BEGIN SELECT RAISE(ABORT,'primary-staff-binding-mutation-immutable'); END;
CREATE TRIGGER portal_primary_staff_binding_mutation_no_delete BEFORE DELETE ON portal_primary_staff_binding_mutations
BEGIN SELECT RAISE(ABORT,'primary-staff-binding-mutation-immutable'); END;

CREATE TRIGGER portal_primary_staff_binding_audit_insert_guard
BEFORE INSERT ON portal_primary_staff_binding_audit
WHEN EXISTS(SELECT 1 FROM portal_primary_staff_binding_audit
  WHERE id=NEW.id OR (binding_id=NEW.binding_id AND binding_version=NEW.binding_version))
 OR NOT EXISTS(SELECT 1 FROM portal_primary_staff_bindings receipt
   WHERE receipt.binding_id=NEW.binding_id AND receipt.version=NEW.binding_version)
BEGIN SELECT RAISE(ABORT,'primary-staff-binding-audit'); END;
CREATE TRIGGER portal_primary_staff_binding_audit_no_update BEFORE UPDATE ON portal_primary_staff_binding_audit
BEGIN SELECT RAISE(ABORT,'primary-staff-binding-audit-immutable'); END;
CREATE TRIGGER portal_primary_staff_binding_audit_no_delete BEFORE DELETE ON portal_primary_staff_binding_audit
BEGIN SELECT RAISE(ABORT,'primary-staff-binding-audit-immutable'); END;
