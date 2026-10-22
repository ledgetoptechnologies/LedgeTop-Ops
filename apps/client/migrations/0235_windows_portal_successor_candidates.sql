-- Supplemental current local evidence, never content authorization.
-- Original-publication views and content-start audit guards remain unchanged.
-- Every consumer must additionally obtain fresh Ops successor proof and compare
-- exact original/current pins; the view alone cannot prove historical retention.
-- Group AND clauses to remain below the D1 expression-depth limit when callers
-- add exact identity or audit fences.
CREATE VIEW operations_portal_native_delivery_successor_candidates AS
SELECT head.authority_id,head.revision authority_revision,head.latest_operation_id delivery_operation_id,
    head.recipient_binding_id,head.target_id,head.folder_reservation_id,recipient.issuer,recipient.subject,
    command.canonical_command_json,command.request_fingerprint,
    publication.latest_operation_id publication_operation_id,publication_receipt.publication_id,
    publication.revision publication_revision,publication.source_sequence publication_source_sequence,
    publication.snapshot_id,publication.snapshot_sha256
  FROM operations_portal_native_delivery_heads head
  JOIN operations_portal_native_delivery_commands command ON command.operation_id=head.latest_operation_id
  JOIN operations_portal_native_delivery_receipts receipt ON receipt.operation_id=command.operation_id
  JOIN operations_portal_native_delivery_history history ON history.operation_id=command.operation_id
  JOIN operations_portal_native_recipient_authority_heads recipient
    ON recipient.recipient_binding_id=command.recipient_binding_id AND recipient.target_id=command.target_id
  JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=recipient.target_id
  JOIN operations_portal_native_authority_receipts home_receipt ON home_receipt.operation_id=recipient.latest_operation_id
  JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=command.target_id
  JOIN operations_portal_workspace_publication_receipts publication_receipt ON publication_receipt.operation_id=publication.latest_operation_id
  JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.operation_id=publication.latest_operation_id
  JOIN operations_portal_workspace_publication_commands published_command ON published_command.operation_id=publication.latest_operation_id
  JOIN operations_portal_workspace_publication_history published_history ON published_history.operation_id=publication.latest_operation_id
  WHERE (head.state='active' AND command.action='delivery.grant' AND head.authority_id=command.authority_id
    AND head.recipient_binding_id=command.recipient_binding_id AND head.folder_reservation_id=command.folder_reservation_id
    AND head.target_id=command.target_id AND head.revision=command.resulting_revision
    AND receipt.authority_id=head.authority_id AND receipt.recipient_binding_id=head.recipient_binding_id
    AND receipt.folder_reservation_id=head.folder_reservation_id AND receipt.action='delivery.grant'
    AND receipt.resulting_revision=head.revision AND receipt.resulting_state='active'
    AND receipt.request_fingerprint=command.request_fingerprint AND history.authority_id=head.authority_id
    AND history.revision=head.revision AND history.state='active' AND history.request_fingerprint=command.request_fingerprint)
    AND (recipient.state='active' AND workspace.state='active' AND recipient.permissions_json='["operations.service_home.read"]'
    AND recipient.ownership_epoch=workspace.ownership_epoch
    AND home_receipt.state='active' AND home_receipt.action='recipient.grant'
    AND home_receipt.target_id=recipient.target_id AND home_receipt.recipient_binding_id=recipient.recipient_binding_id
    AND home_receipt.ownership_epoch=recipient.ownership_epoch AND home_receipt.grant_revision=recipient.grant_revision
    AND recipient.enrollment_intent_id=json_extract(command.canonical_command_json,'$.recipient.enrollmentIntentId')
    AND recipient.target_client_record_id=json_extract(command.canonical_command_json,'$.recipient.targetClientRecordId')
    AND recipient.issuer=json_extract(command.canonical_command_json,'$.recipient.issuer')
    AND recipient.subject=json_extract(command.canonical_command_json,'$.recipient.subject')
    AND CAST(recipient.ownership_epoch AS TEXT)=json_extract(command.canonical_command_json,'$.recipient.homeOwnershipEpoch')
    AND CAST(recipient.grant_revision AS TEXT)=json_extract(command.canonical_command_json,'$.recipient.homeGrantRevision')
    AND recipient.latest_operation_id=json_extract(command.canonical_command_json,'$.recipient.homeGrantOperationId')
    AND home_receipt.request_fingerprint=json_extract(command.canonical_command_json,'$.recipient.homeRequestFingerprint')
    AND workspace.client_authority_id=json_extract(command.canonical_command_json,'$.target.clientAuthorityId')
    AND workspace.workspace_id=json_extract(command.canonical_command_json,'$.target.workspaceId')
    AND workspace.root_kind=json_extract(command.canonical_command_json,'$.target.rootKind')
    AND workspace.root_record_id=json_extract(command.canonical_command_json,'$.target.rootRecordId')
    AND CAST(workspace.target_revision AS TEXT)=json_extract(command.canonical_command_json,'$.target.targetRevision'))
    AND (publication.target_revision=workspace.target_revision AND publication.client_authority_id=workspace.client_authority_id
    AND publication.workspace_id=workspace.workspace_id AND publication.root_kind=workspace.root_kind AND publication.root_record_id=workspace.root_record_id
    AND publication_receipt.target_id=publication.target_id AND publication_receipt.resulting_revision=publication.revision
    AND publication_receipt.source_sequence=publication.source_sequence AND publication_receipt.snapshot_id=publication.snapshot_id
    AND publication_receipt.snapshot_sha256=publication.snapshot_sha256
    AND snapshot.target_id=publication.target_id AND snapshot.revision=publication.revision
    AND snapshot.source_sequence=publication.source_sequence AND snapshot.checkpoint_id=publication.checkpoint_id
    AND snapshot.snapshot_id=publication.snapshot_id AND snapshot.snapshot_sha256=publication.snapshot_sha256
    AND published_command.request_fingerprint=publication_receipt.request_fingerprint
    AND published_command.publication_id=publication_receipt.publication_id AND published_command.target_id=publication.target_id
    AND published_command.resulting_revision=publication.revision AND published_command.source_sequence=publication.source_sequence
    AND published_command.snapshot_id=publication.snapshot_id AND published_command.snapshot_sha256=publication.snapshot_sha256
    AND published_command.checkpoint_id=publication.checkpoint_id
    AND published_history.target_id=publication.target_id AND published_history.revision=publication.revision
    AND published_history.source_sequence=publication.source_sequence AND published_history.snapshot_id=publication.snapshot_id
    AND published_history.snapshot_sha256=publication.snapshot_sha256)
    AND julianday(json_extract(command.canonical_command_json,'$.expiresAt'))>julianday('now')
    AND (recipient.expires_at IS NULL OR json_extract(command.canonical_command_json,'$.expiresAt')<=recipient.expires_at)
    AND EXISTS(SELECT 1 FROM json_each(snapshot.snapshot_json,'$.folderReservations') folder
      WHERE json_extract(folder.value,'$.reservationId')=command.folder_reservation_id
        AND json_extract(folder.value,'$.state')='active'
        AND json_extract(folder.value,'$.bindingVersion')=json_extract(command.canonical_command_json,'$.resource.folderReservationRevision')
        AND json_extract(folder.value,'$.clientFolderBindingId')=json_extract(command.canonical_command_json,'$.resource.clientFolderBindingId')
        AND json_extract(folder.value,'$.externalProjectId')=json_extract(command.canonical_command_json,'$.resource.externalProjectId')
        AND json_extract(folder.value,'$.opsFolderProjectId')=json_extract(command.canonical_command_json,'$.resource.opsFolderProjectId')
        AND json_extract(folder.value,'$.divisionId')=json_extract(command.canonical_command_json,'$.resource.opsDivisionId')
        AND json_extract(folder.value,'$.r2Prefix')=json_extract(command.canonical_command_json,'$.resource.selectedR2Prefix'))
    AND EXISTS(SELECT 1 FROM json_each(snapshot.snapshot_json,'$.projects') project
      WHERE json_extract(project.value,'$.externalProjectId')=json_extract(command.canonical_command_json,'$.resource.externalProjectId')
        AND json_extract(project.value,'$.version')=json_extract(command.canonical_command_json,'$.resource.projectVersion')
        AND json_extract(project.value,'$.published')=1
        AND ((json_extract(project.value,'$.clientRecordId') IS NOT NULL
            AND json_extract(project.value,'$.clientRecordId')=recipient.target_client_record_id)
          OR (json_extract(project.value,'$.clientRecordId') IS NULL AND workspace.root_kind='organization'
            AND json_extract(project.value,'$.organizationRecordId')=workspace.root_record_id)));
