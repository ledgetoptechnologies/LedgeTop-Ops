PRAGMA foreign_keys=ON;

-- D1 rejects the prior row-derived LIKE pattern at execution time once the
-- prefix crosses its pattern-complexity bound. Preserve the complete reviewed
-- grant guard and replace only its final containment predicate with a literal,
-- case-sensitive prefix comparison.
DROP TRIGGER operations_portal_native_delivery_grant_folder_guard;

CREATE TRIGGER operations_portal_native_delivery_grant_folder_guard BEFORE INSERT
ON operations_portal_native_delivery_authority_commands WHEN NEW.action='delivery.grant' AND NOT EXISTS(
 SELECT 1 FROM operations_portal_folder_reservation_heads folder
 JOIN operations_shared_projects project ON project.external_project_id=folder.external_project_id
 JOIN operations_shared_project_revisions project_revision
   ON project_revision.external_project_id=project.external_project_id AND project_revision.version=project.current_version
 JOIN project_folders physical ON physical.project_id=folder.ops_folder_project_id
 WHERE folder.reservation_id=NEW.folder_reservation_id AND folder.target_id=NEW.target_id
   AND folder.state='active' AND folder.revision=NEW.folder_reservation_revision
   AND ((project.client_record_id IS NOT NULL AND project.client_record_id=NEW.target_client_record_id)
     OR (project.client_record_id IS NULL AND NEW.root_kind='organization'
       AND project.organization_record_id=NEW.root_record_id))
   AND folder.client_folder_binding_id=NEW.client_folder_binding_id
   AND folder.external_project_id=NEW.external_project_id AND folder.project_version=NEW.project_version
   AND folder.ops_folder_project_id=NEW.ops_folder_project_id AND folder.ops_division_id=NEW.ops_division_id
   AND folder.selected_r2_prefix=NEW.selected_r2_prefix AND folder.base_r2_prefix=NEW.base_r2_prefix
   AND folder.base_match_method=NEW.base_match_method AND folder.base_confirmed_by=NEW.base_confirmed_by
   AND folder.base_confirmed_at=NEW.base_confirmed_at AND project.current_version=NEW.project_version
   AND physical.division_id=NEW.ops_division_id AND physical.r2_prefix=NEW.base_r2_prefix
   AND physical.match_method=NEW.base_match_method AND physical.confirmed_by=NEW.base_confirmed_by
   AND physical.confirmed_at=NEW.base_confirmed_at
   AND substr(NEW.selected_r2_prefix,1,length(NEW.base_r2_prefix))=NEW.base_r2_prefix COLLATE BINARY)
BEGIN SELECT RAISE(ABORT,'operations portal native delivery current folder denied'); END;
