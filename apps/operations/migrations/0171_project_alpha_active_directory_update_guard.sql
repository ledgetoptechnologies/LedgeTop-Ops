PRAGMA foreign_keys = ON;

-- API-v2 project updates and binds may name directory records only through
-- the explicit active mapping view. All proof, lease, revision, scope, identity,
-- and relationship predicates from 0122 remain byte-for-byte equivalent.
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
BEGIN SELECT RAISE(ABORT,'shared project update requires a versioned writer'); END;
