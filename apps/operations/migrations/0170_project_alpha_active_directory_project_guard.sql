PRAGMA foreign_keys = ON;

-- Project Alpha API-v2 settlements may use a directory mapping only after the
-- existing-directory review flow has created its durable activation receipt.
-- Keep the legacy refresh branch unchanged; use the active view only for the
-- already-guarded v2 create/bind settlement branch.
DROP TRIGGER operations_shared_projects_bound_refresh_guard;
DROP VIEW project_alpha_active_directory_mappings;
CREATE VIEW project_alpha_active_directory_mappings AS
SELECT source_id,resource_type,external_id AS record_id,external_id,project_alpha_public_id,source_instance_id,
  application_id,history_epoch_id,command_id AS provenance_id,'legacy' AS mapping_kind,created_at
FROM project_alpha_directory_mappings
UNION ALL
SELECT source_id,resource_type,record_id,external_id,project_alpha_public_id,source_instance_id,
  application_id,history_epoch_id,activation_id AS provenance_id,'acquired' AS mapping_kind,activated_at AS created_at
FROM project_alpha_existing_directory_binding_activation_receipts;

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
    AND (NEW.organization_record_id IS NULL OR EXISTS (SELECT 1 FROM project_alpha_directory_mappings customer
      JOIN operations_directory_records record ON record.record_id=customer.external_id AND record.record_kind='organization'
      WHERE customer.source_id=NEW.source_id AND customer.source_instance_id=NEW.source_instance_id
        AND customer.application_id=NEW.application_id AND customer.history_epoch_id=NEW.history_epoch_id
        AND customer.resource_type='organization' AND customer.external_id=NEW.organization_record_id))
    AND (NEW.client_record_id IS NULL OR EXISTS (SELECT 1 FROM project_alpha_directory_mappings customer
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
        ON r.record_id=d.record_id AND r.record_kind='organization'
        WHERE d.source_id=settlement.source_id AND d.source_instance_id=settlement.source_instance_id
          AND d.application_id=settlement.application_id AND d.history_epoch_id=settlement.history_epoch_id
          AND d.resource_type='organization' AND d.project_alpha_public_id=json_extract(settlement.read_json,'$.data.organizationPublicId')
          AND d.record_id=NEW.organization_record_id))
    AND ((json_type(settlement.read_json,'$.data.clientPublicId')='null' AND NEW.client_record_id IS NULL)
      OR EXISTS (SELECT 1 FROM project_alpha_active_directory_mappings d JOIN operations_directory_records r
        ON r.record_id=d.record_id AND r.record_kind='client'
        WHERE d.source_id=settlement.source_id AND d.source_instance_id=settlement.source_instance_id
          AND d.application_id=settlement.application_id AND d.history_epoch_id=settlement.history_epoch_id
          AND d.resource_type='client' AND d.project_alpha_public_id=json_extract(settlement.read_json,'$.data.clientPublicId')
          AND d.record_id=NEW.client_record_id))
    AND (NEW.organization_record_id IS NULL OR NEW.client_record_id IS NULL OR EXISTS (
      SELECT 1 FROM operations_directory_client_organizations relationship
      WHERE relationship.client_record_id=NEW.client_record_id AND relationship.organization_record_id=NEW.organization_record_id))
)
BEGIN SELECT RAISE(ABORT,'bound shared project refresh is not authorized'); END;
