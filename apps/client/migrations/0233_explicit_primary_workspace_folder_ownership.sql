PRAGMA foreign_keys=ON;

ALTER TABLE portal_primary_staff_bindings ADD COLUMN ownership_kind TEXT NOT NULL DEFAULT 'project_mapping'
  CHECK(ownership_kind IN ('project_mapping','explicit_workspace'));
ALTER TABLE portal_primary_staff_bindings ADD COLUMN ops_division_id TEXT;

CREATE TRIGGER portal_primary_explicit_binding_shape BEFORE INSERT ON portal_primary_staff_bindings
WHEN (NEW.ownership_kind='explicit_workspace' AND (
  NEW.ops_division_id IS NULL OR length(NEW.ops_division_id)=0 OR NEW.owner_scope_type NOT IN ('client','organization')
  OR NEW.ops_project_id IS NOT NULL OR NEW.project_public_id IS NOT NULL OR NEW.project_source_version IS NOT NULL))
 OR (NEW.ownership_kind='project_mapping' AND NEW.ops_division_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'primary-explicit-binding-shape'); END;

CREATE TRIGGER portal_primary_explicit_binding_immutable BEFORE UPDATE ON portal_primary_staff_bindings
WHEN NEW.ownership_kind IS NOT OLD.ownership_kind OR NEW.ops_division_id IS NOT OLD.ops_division_id
BEGIN SELECT RAISE(ABORT,'primary-explicit-binding-immutable'); END;

CREATE TABLE portal_primary_folder_authority_mutations (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('project_folder','division_deactivation')),
  actor_id TEXT NOT NULL,
  witness_json TEXT NOT NULL CHECK(json_valid(witness_json)),
  phase TEXT NOT NULL CHECK(phase IN ('reserved','attempted','completed')),
  created_at TEXT NOT NULL DEFAULT(datetime('now')),
  updated_at TEXT NOT NULL DEFAULT(datetime('now'))
);
-- An unresolved cross-database writer blocks new binding publication. There
-- is deliberately no lease expiry: a timed-out OPS write may still complete.
CREATE UNIQUE INDEX portal_primary_folder_single_pending_writer
  ON portal_primary_folder_authority_mutations((1)) WHERE phase<>'completed';
CREATE TRIGGER portal_primary_folder_mutation_immutable BEFORE UPDATE ON portal_primary_folder_authority_mutations
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.kind IS NOT OLD.kind OR NEW.actor_id IS NOT OLD.actor_id
 OR NEW.witness_json IS NOT OLD.witness_json OR NEW.created_at IS NOT OLD.created_at
 OR OLD.phase='completed' OR (OLD.phase='attempted' AND NEW.phase NOT IN ('attempted','completed'))
 OR (OLD.phase='reserved' AND NEW.phase NOT IN ('attempted','completed'))
BEGIN SELECT RAISE(ABORT,'primary-folder-mutation-immutable'); END;
CREATE TRIGGER portal_primary_folder_mutation_no_delete BEFORE DELETE ON portal_primary_folder_authority_mutations
BEGIN SELECT RAISE(ABORT,'primary-folder-mutation-immutable'); END;

CREATE TRIGGER portal_primary_folder_binding_publication_guard BEFORE INSERT ON portal_primary_staff_bindings
WHEN EXISTS(SELECT 1 FROM portal_primary_folder_authority_mutations WHERE phase<>'completed')
 OR EXISTS(SELECT 1 FROM portal_v2_folder_bindings other
   LEFT JOIN portal_primary_staff_bindings receipt ON receipt.binding_id=other.id
   WHERE other.id<>NEW.binding_id AND other.status='active' AND other.revoked_at IS NULL
     AND (NEW.ownership_kind='explicit_workspace' OR receipt.ownership_kind='explicit_workspace')
     AND (substr(rtrim(other.r2_prefix,'/')||'/',1,length(NEW.r2_prefix))=NEW.r2_prefix
       OR substr(NEW.r2_prefix,1,length(rtrim(other.r2_prefix,'/')||'/'))=rtrim(other.r2_prefix,'/')||'/'))
BEGIN SELECT RAISE(ABORT,'primary-folder-authority-publication-conflict'); END;

-- Preserve every0189 authority condition; normalize only the exact standalone root owner.
DROP TRIGGER portal_primary_staff_binding_insert_guard;
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
     AND root_entity.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) AND root_entity.active=1 AND root_entity.parent_public_id IS NULL
   JOIN portal_v2_directory_entities owner_entity
     ON owner_entity.workspace_id=workspace.id AND owner_entity.generation_id=directory_generation.id
     AND owner_entity.entity_type=CASE WHEN binding.owner_scope_type='client' AND workspace.root_type='standalone_client' AND binding.owner_public_id=workspace.pa_client_public_id THEN 'standalone_client' ELSE binding.owner_scope_type END AND owner_entity.public_id=binding.owner_public_id AND owner_entity.active=1
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

