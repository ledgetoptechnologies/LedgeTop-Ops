PRAGMA foreign_keys = ON;

-- Project canonical identity checks originally recognized only legacy Directory
-- mappings. 0125 introduced the reviewed active-mapping view, so replace only
-- the three 0122 guards that validate customer identities. Project mappings,
-- settlement evidence, live authority, relationship checks, and all history
-- predicates remain unchanged.
DROP TRIGGER operations_shared_projects_bound_refresh_guard;
CREATE TRIGGER operations_shared_projects_bound_refresh_guard BEFORE INSERT ON operations_shared_projects
WHEN NEW.pa_revision IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM project_alpha_project_refresh refresh
  JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=refresh.external_project_id
    AND mapping.establishment_command_id=refresh.establishment_command_id
  JOIN project_alpha_project_outbox command ON command.command_id=refresh.establishment_command_id
    AND command.operation='bind' AND command.state='acknowledged'
  JOIN native_project_live_command_proofs proof ON proof.command_id=command.command_id
    AND proof.external_project_id=refresh.external_project_id
  WHERE refresh.external_project_id=NEW.external_project_id
    AND refresh.history_epoch_id=NEW.history_epoch_id AND mapping.history_epoch_id=NEW.history_epoch_id
    AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
    AND mapping.application_id=NEW.application_id AND mapping.project_alpha_public_id=NEW.project_alpha_public_id
    AND json(proof.scopes_json)=json(NEW.scopes_json)
    AND (length(NEW.pa_revision)>length(refresh.minimum_revision)
      OR (length(NEW.pa_revision)=length(refresh.minimum_revision) AND NEW.pa_revision>=refresh.minimum_revision))
    AND (NEW.organization_record_id IS NULL OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings customer
      JOIN operations_directory_records record ON record.record_id=customer.external_id AND record.record_kind='organization'
      WHERE customer.source_id=NEW.source_id AND customer.source_instance_id=NEW.source_instance_id
        AND customer.application_id=NEW.application_id AND customer.history_epoch_id=NEW.history_epoch_id
        AND customer.resource_type='organization' AND customer.external_id=NEW.organization_record_id))
    AND (NEW.client_record_id IS NULL OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings customer
      JOIN operations_directory_records record ON record.record_id=customer.external_id AND record.record_kind='client'
      WHERE customer.source_id=NEW.source_id AND customer.source_instance_id=NEW.source_instance_id
        AND customer.application_id=NEW.application_id AND customer.history_epoch_id=NEW.history_epoch_id
        AND customer.resource_type='client' AND customer.external_id=NEW.client_record_id))
    AND (NEW.organization_record_id IS NULL OR NEW.client_record_id IS NULL OR EXISTS (
      SELECT 1 FROM operations_directory_client_organizations relationship
      WHERE relationship.client_record_id=NEW.client_record_id AND relationship.organization_record_id=NEW.organization_record_id))
) AND NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement
  JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=settlement.command_id
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=intent.command_id AND outbox.state='leased'
  JOIN native_project_live_command_proofs proof ON proof.command_id=intent.command_id
    AND proof.external_project_id=intent.external_project_id AND proof.grant_generation=intent.expected_grant_generation
  WHERE settlement.external_project_id=NEW.external_project_id AND settlement.prior_local_version=0
    AND intent.operation IN ('create','bind') AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND NEW.source_id=settlement.source_id AND NEW.source_instance_id=settlement.source_instance_id
    AND NEW.application_id=settlement.application_id AND NEW.history_epoch_id=settlement.history_epoch_id
    AND NEW.project_alpha_public_id=settlement.project_alpha_public_id AND NEW.pa_revision=settlement.project_alpha_revision
    AND NEW.current_version=1 AND NEW.canonical_projection_sha256=settlement.projection_sha256
    AND NEW.name=json_extract(settlement.read_json,'$.data.name')
    AND NEW.description IS json_extract(settlement.read_json,'$.data.description')
    AND NEW.lifecycle=json_extract(settlement.read_json,'$.data.status')
    AND NEW.archived=(json_extract(settlement.read_json,'$.data.archived') IS 1)
    AND NEW.overdue_warning=(json_extract(settlement.read_json,'$.data.overdueWarning') IS 1)
    AND NEW.completed_at IS json_extract(settlement.read_json,'$.data.completedAt')
    AND NEW.archived_at IS json_extract(settlement.read_json,'$.data.archivedAt')
    AND NEW.planned_start IS json_extract(settlement.read_json,'$.data.estimatedStart')
    AND NEW.planned_end IS json_extract(settlement.read_json,'$.data.estimatedEnd')
    AND json(NEW.scopes_json)=json(proof.scopes_json)
    AND ((json_type(settlement.read_json,'$.data.organizationPublicId')='null' AND NEW.organization_record_id IS NULL)
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings d JOIN operations_directory_records r
        ON r.record_id=d.external_id AND r.record_kind='organization'
        WHERE d.source_id=settlement.source_id AND d.source_instance_id=settlement.source_instance_id
          AND d.application_id=settlement.application_id AND d.history_epoch_id=settlement.history_epoch_id
          AND d.resource_type='organization' AND d.project_alpha_public_id=json_extract(settlement.read_json,'$.data.organizationPublicId')
          AND d.external_id=NEW.organization_record_id))
    AND ((json_type(settlement.read_json,'$.data.clientPublicId')='null' AND NEW.client_record_id IS NULL)
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings d JOIN operations_directory_records r
        ON r.record_id=d.external_id AND r.record_kind='client'
        WHERE d.source_id=settlement.source_id AND d.source_instance_id=settlement.source_instance_id
          AND d.application_id=settlement.application_id AND d.history_epoch_id=settlement.history_epoch_id
          AND d.resource_type='client' AND d.project_alpha_public_id=json_extract(settlement.read_json,'$.data.clientPublicId')
          AND d.external_id=NEW.client_record_id))
    AND (NEW.organization_record_id IS NULL OR NEW.client_record_id IS NULL OR EXISTS (
      SELECT 1 FROM operations_directory_client_organizations relationship
      WHERE relationship.client_record_id=NEW.client_record_id AND relationship.organization_record_id=NEW.organization_record_id))
)
BEGIN SELECT RAISE(ABORT,'bound shared project refresh is not authorized'); END;

DROP TRIGGER operations_shared_projects_no_update;
CREATE TRIGGER operations_shared_projects_no_update BEFORE UPDATE ON operations_shared_projects
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement
  JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=settlement.command_id
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=intent.command_id AND outbox.state='leased'
  JOIN native_project_live_command_proofs proof ON proof.command_id=intent.command_id
    AND proof.external_project_id=intent.external_project_id AND proof.grant_generation=intent.expected_grant_generation
  JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=intent.external_project_id
  WHERE OLD.external_project_id=intent.external_project_id AND OLD.current_version=intent.expected_local_version
    AND OLD.canonical_projection_sha256=intent.expected_local_projection_sha256
    AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND mapping.source_id=intent.source_id AND mapping.source_instance_id=intent.source_instance_id
    AND mapping.application_id=intent.application_id AND mapping.history_epoch_id=intent.history_epoch_id
    AND ((intent.operation='update' AND mapping.project_alpha_public_id=intent.expected_project_alpha_public_id)
      OR intent.operation IN ('create','bind'))
    AND NEW.external_project_id IS OLD.external_project_id AND NEW.created_at IS OLD.created_at
    AND NEW.source_id=settlement.source_id AND NEW.source_instance_id=settlement.source_instance_id
    AND NEW.application_id=settlement.application_id AND NEW.history_epoch_id=settlement.history_epoch_id
    AND NEW.project_alpha_public_id=settlement.project_alpha_public_id AND NEW.pa_revision=settlement.project_alpha_revision
    AND NEW.current_version=OLD.current_version+1
    AND NEW.canonical_projection_sha256=settlement.projection_sha256
    AND NEW.name=json_extract(settlement.read_json,'$.data.name')
    AND NEW.description IS json_extract(settlement.read_json,'$.data.description')
    AND NEW.lifecycle=json_extract(settlement.read_json,'$.data.status')
    AND NEW.archived=(json_extract(settlement.read_json,'$.data.archived') IS 1)
    AND NEW.overdue_warning=(json_extract(settlement.read_json,'$.data.overdueWarning') IS 1)
    AND NEW.completed_at IS json_extract(settlement.read_json,'$.data.completedAt')
    AND NEW.archived_at IS json_extract(settlement.read_json,'$.data.archivedAt')
    AND NEW.planned_start IS json_extract(settlement.read_json,'$.data.estimatedStart')
    AND NEW.planned_end IS json_extract(settlement.read_json,'$.data.estimatedEnd')
    AND json(NEW.scopes_json)=json(proof.scopes_json)
    AND ((json_type(settlement.read_json,'$.data.organizationPublicId')='null' AND NEW.organization_record_id IS NULL)
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings d JOIN operations_directory_records r
        ON r.record_id=d.external_id AND r.record_kind='organization'
        WHERE d.source_id=settlement.source_id AND d.source_instance_id=settlement.source_instance_id
          AND d.application_id=settlement.application_id AND d.history_epoch_id=settlement.history_epoch_id
          AND d.resource_type='organization' AND d.project_alpha_public_id=json_extract(settlement.read_json,'$.data.organizationPublicId')
          AND d.external_id=NEW.organization_record_id))
    AND ((json_type(settlement.read_json,'$.data.clientPublicId')='null' AND NEW.client_record_id IS NULL)
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings d JOIN operations_directory_records r
        ON r.record_id=d.external_id AND r.record_kind='client'
        WHERE d.source_id=settlement.source_id AND d.source_instance_id=settlement.source_instance_id
          AND d.application_id=settlement.application_id AND d.history_epoch_id=settlement.history_epoch_id
          AND d.resource_type='client' AND d.project_alpha_public_id=json_extract(settlement.read_json,'$.data.clientPublicId')
          AND d.external_id=NEW.client_record_id))
    AND (NEW.organization_record_id IS NULL OR NEW.client_record_id IS NULL OR EXISTS (
      SELECT 1 FROM operations_directory_client_organizations relationship
      WHERE relationship.client_record_id=NEW.client_record_id AND relationship.organization_record_id=NEW.organization_record_id))
)
BEGIN SELECT RAISE(ABORT,'shared project update requires a versioned writer'); END;

DROP TRIGGER operations_shared_project_revisions_bound_guard;
CREATE TRIGGER operations_shared_project_revisions_bound_guard BEFORE INSERT ON operations_shared_project_revisions
WHEN NEW.refresh_command_id IS NOT NULL AND NEW.v2_settlement_id IS NULL AND NOT EXISTS (
  SELECT 1 FROM operations_shared_projects project
  JOIN project_alpha_project_refresh refresh ON refresh.external_project_id=project.external_project_id
    AND refresh.establishment_command_id=NEW.refresh_command_id
  JOIN native_project_live_command_proofs proof ON proof.command_id=NEW.refresh_command_id
    AND proof.external_project_id=project.external_project_id
  WHERE project.external_project_id=NEW.external_project_id AND NEW.version=1
    AND project.current_version=1 AND project.pa_revision=NEW.pa_revision
    AND json_type(NEW.read_json,'$.resource.revision')='text'
    AND json_extract(NEW.read_json,'$.resource.revision')=NEW.pa_revision
    AND json_extract(NEW.read_json,'$.resource.id')=project.project_alpha_public_id
    AND json_extract(NEW.read_json,'$.data.publicId')=project.project_alpha_public_id
    AND json_extract(NEW.read_json,'$.sourceInstanceId')=project.source_instance_id
    AND json_extract(NEW.read_json,'$.applicationId')=project.application_id
    AND json_extract(NEW.read_json,'$.historyEpoch')=project.history_epoch_id
    AND json_extract(NEW.read_json,'$.data.name')=project.name
    AND json_extract(NEW.read_json,'$.data.lifecycle')=project.lifecycle
    AND json_extract(NEW.read_json,'$.data.plannedStart') IS project.planned_start
    AND json_extract(NEW.read_json,'$.data.plannedEnd') IS project.planned_end
    AND (project.organization_record_id IS NULL
      AND json_extract(NEW.read_json,'$.data.customer.organizationPublicId') IS NULL
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings customer
        WHERE customer.source_id=project.source_id AND customer.source_instance_id=project.source_instance_id
          AND customer.application_id=project.application_id AND customer.history_epoch_id=project.history_epoch_id
          AND customer.resource_type='organization' AND customer.external_id=project.organization_record_id
          AND customer.project_alpha_public_id=json_extract(NEW.read_json,'$.data.customer.organizationPublicId')))
    AND (project.client_record_id IS NULL
      AND json_extract(NEW.read_json,'$.data.customer.primaryClientPublicId') IS NULL
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings customer
        WHERE customer.source_id=project.source_id AND customer.source_instance_id=project.source_instance_id
          AND customer.application_id=project.application_id AND customer.history_epoch_id=project.history_epoch_id
          AND customer.resource_type='client' AND customer.external_id=project.client_record_id
          AND customer.project_alpha_public_id=json_extract(NEW.read_json,'$.data.customer.primaryClientPublicId')))
)
BEGIN SELECT RAISE(ABORT,'bound shared project revision is not authorized'); END;
