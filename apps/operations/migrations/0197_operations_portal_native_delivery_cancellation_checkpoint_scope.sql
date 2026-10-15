-- The publication checkpoint remains strict for publication and every grant
-- path. Terminal cleanup has a separate checkpoint predicate so unrelated
-- projects created after the frozen publication do not strand an expired
-- never-recorded delivery tombstone.

CREATE VIEW operations_portal_workspace_delivery_cancellation_checkpoints AS
SELECT checkpoint.checkpoint_id
FROM operations_portal_workspace_publication_checkpoints checkpoint
JOIN operations_portal_workspace_reservation_heads workspace
  ON workspace.target_id=checkpoint.target_id AND workspace.revision=checkpoint.target_revision AND workspace.state='active'
WHERE checkpoint.directory_record_count=(SELECT count(*) FROM operations_portal_workspace_publication_directory_sources source
    WHERE source.checkpoint_id=checkpoint.checkpoint_id)
  AND checkpoint.project_count=(SELECT count(*) FROM operations_portal_workspace_publication_project_sources source
    WHERE source.checkpoint_id=checkpoint.checkpoint_id)
  AND checkpoint.folder_reservation_count=(SELECT count(*) FROM operations_portal_workspace_publication_folder_sources source
    WHERE source.checkpoint_id=checkpoint.checkpoint_id)
  AND checkpoint.folder_reservation_count=(SELECT count(*) FROM operations_portal_folder_reservation_heads folder
    WHERE folder.target_id=workspace.target_id AND folder.state='active')
  AND ((workspace.root_kind='organization' AND checkpoint.directory_record_count=1+(SELECT count(*)
        FROM operations_directory_client_organizations relation WHERE relation.organization_record_id=workspace.root_record_id))
    OR (workspace.root_kind='standalone_client' AND checkpoint.directory_record_count=1))
  AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_directory_sources source
    LEFT JOIN operations_directory_records record ON record.record_id=source.record_id
    LEFT JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
    WHERE source.checkpoint_id=checkpoint.checkpoint_id AND (record.record_id IS NULL OR revision.record_id IS NULL
      OR source.record_kind<>record.record_kind OR source.record_version<>record.current_version
      OR source.display_name<>json_extract(revision.profile_json,'$.name')
      OR (source.record_kind='organization' AND (workspace.root_kind<>'organization' OR source.record_id<>workspace.root_record_id
        OR source.parent_record_id IS NOT NULL OR source.relationship_version IS NOT NULL))
      OR (source.record_kind='client' AND NOT EXISTS(SELECT 1 FROM operations_directory_client_organizations relation
        JOIN operations_directory_client_organization_history history ON history.client_record_id=relation.client_record_id
          AND history.relationship_version=relation.relationship_version
        WHERE relation.client_record_id=source.record_id AND relation.organization_record_id IS source.parent_record_id
          AND relation.relationship_version=source.relationship_version
          AND ((workspace.root_kind='organization' AND source.parent_record_id=workspace.root_record_id)
            OR (workspace.root_kind='standalone_client' AND source.record_id=workspace.root_record_id
              AND source.parent_record_id IS NULL))))))
  AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_folder_sources source
    LEFT JOIN operations_portal_folder_reservation_heads folder ON folder.reservation_id=source.reservation_id
    LEFT JOIN project_folders physical ON physical.project_id=source.ops_folder_project_id
    WHERE source.checkpoint_id=checkpoint.checkpoint_id AND (folder.reservation_id IS NULL OR folder.target_id<>workspace.target_id
      OR folder.state<>'active' OR folder.revision<>source.binding_version
      OR folder.external_project_id<>source.external_project_id OR folder.ops_folder_project_id<>source.ops_folder_project_id
      OR folder.ops_division_id<>source.division_id OR folder.client_folder_binding_id<>source.client_folder_binding_id
      OR folder.selected_r2_prefix<>source.r2_prefix OR folder.base_r2_prefix<>source.base_r2_prefix
      OR folder.base_match_method<>source.base_match_method OR folder.base_confirmed_by<>source.base_confirmed_by
      OR folder.base_confirmed_at<>source.base_confirmed_at OR physical.project_id IS NULL
      OR physical.division_id<>source.division_id OR physical.r2_prefix<>source.base_r2_prefix
      OR physical.match_method<>source.base_match_method OR physical.confirmed_by<>source.base_confirmed_by
      OR physical.confirmed_at<>source.base_confirmed_at))
  AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_publication_project_sources source
    LEFT JOIN operations_shared_projects project ON project.external_project_id=source.external_project_id
    LEFT JOIN operations_shared_project_revisions revision ON revision.external_project_id=project.external_project_id
      AND revision.version=project.current_version
    WHERE source.checkpoint_id=checkpoint.checkpoint_id AND (project.external_project_id IS NULL OR revision.external_project_id IS NULL
      OR project.current_version<>source.project_version OR project.name<>source.name OR project.lifecycle<>source.lifecycle
      OR project.planned_start IS NOT source.planned_start OR project.planned_end IS NOT source.planned_end
      OR project.completed_at IS NOT source.completed_at OR project.archived<>source.archived
      OR project.archived_at IS NOT source.archived_at OR project.overdue_warning<>source.overdue_warning
      OR project.organization_record_id IS NOT source.organization_record_id OR project.client_record_id IS NOT source.client_record_id
      OR (workspace.root_kind='organization' AND (project.organization_record_id IS NULL
            AND project.client_record_id IS NULL
          OR project.organization_record_id IS NOT NULL AND project.organization_record_id<>workspace.root_record_id
          OR project.client_record_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM operations_directory_client_organizations relation
            WHERE relation.client_record_id=project.client_record_id AND relation.organization_record_id=workspace.root_record_id)))
      OR (workspace.root_kind='standalone_client' AND (project.organization_record_id IS NOT NULL
        OR project.client_record_id IS NOT workspace.root_record_id))))
  AND NOT EXISTS(SELECT 1 FROM operations_portal_folder_reservation_heads folder
    WHERE folder.target_id=workspace.target_id AND folder.state='active' AND NOT EXISTS(
      SELECT 1 FROM operations_portal_workspace_publication_folder_sources source
      WHERE source.checkpoint_id=checkpoint.checkpoint_id AND source.reservation_id=folder.reservation_id));

DROP VIEW operations_portal_native_delivery_cancellation_current_publication;
CREATE VIEW operations_portal_native_delivery_cancellation_current_publication AS
SELECT command.operation_id FROM operations_portal_native_delivery_authority_commands command
JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=command.target_id
JOIN operations_portal_workspace_publication_receipts publication_receipt ON publication_receipt.operation_id=publication.latest_operation_id
JOIN operations_portal_workspace_publication_commands publication_command ON publication_command.operation_id=publication_receipt.operation_id
JOIN operations_portal_workspace_delivery_cancellation_checkpoints checkpoint ON checkpoint.checkpoint_id=publication.checkpoint_id
JOIN operations_portal_workspace_publication_directory_sources published_client ON published_client.checkpoint_id=publication.checkpoint_id
  AND published_client.record_id=command.target_client_record_id AND published_client.record_kind='client'
WHERE publication.target_id=command.target_id
 AND publication.target_revision=command.target_revision AND publication.client_authority_id=command.client_authority_id
 AND publication.workspace_id=command.workspace_id AND publication.root_kind=command.root_kind AND publication.root_record_id=command.root_record_id
 AND publication.latest_operation_id=command.publication_operation_id AND publication.publication_revision=command.publication_revision
 AND publication.source_sequence=command.publication_source_sequence AND publication.snapshot_id=command.publication_snapshot_id
 AND publication.snapshot_sha256=command.publication_snapshot_sha256
 AND publication_receipt.publication_id=command.publication_id AND publication_receipt.target_id=command.target_id
 AND publication_receipt.resulting_revision=command.publication_revision AND publication_receipt.source_sequence=command.publication_source_sequence
 AND publication_receipt.snapshot_id=command.publication_snapshot_id AND publication_receipt.snapshot_sha256=command.publication_snapshot_sha256
 AND publication_command.publication_id=command.publication_id AND publication_command.target_id=command.target_id
 AND publication_command.target_revision=command.target_revision AND publication_command.client_authority_id=command.client_authority_id
 AND publication_command.workspace_id=command.workspace_id AND publication_command.root_kind=command.root_kind
 AND publication_command.root_record_id=command.root_record_id AND publication_command.checkpoint_id=publication.checkpoint_id
 AND publication_command.source_sequence=command.publication_source_sequence AND publication_command.snapshot_id=command.publication_snapshot_id
 AND publication_command.snapshot_sha256=command.publication_snapshot_sha256;
