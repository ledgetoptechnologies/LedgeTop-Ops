PRAGMA foreign_keys = ON;

-- Activate only the already-reviewed 0119--0121 create/update/bind evidence.
-- This migration does not mount a caller and does not add refresh support.
ALTER TABLE operations_shared_projects ADD COLUMN overdue_warning INTEGER NOT NULL DEFAULT 0
  CHECK(typeof(overdue_warning)='integer' AND overdue_warning IN (0,1));

CREATE TABLE project_alpha_project_v2_canonical_activation_receipts (
  activation_id TEXT NOT NULL PRIMARY KEY CHECK(length(activation_id)=36 AND activation_id=lower(activation_id)
    AND activation_id NOT GLOB '*[^0-9a-f-]*' AND substr(activation_id,9,1)='-'
    AND substr(activation_id,14,1)='-' AND substr(activation_id,15,1)='4'
    AND substr(activation_id,19,1)='-' AND substr(activation_id,20,1) IN ('8','9','a','b')
    AND substr(activation_id,24,1)='-' AND length(replace(activation_id,'-',''))=32),
  settlement_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_project_v2_canonical_settlement_receipts(settlement_id) ON DELETE RESTRICT,
  command_id TEXT NOT NULL UNIQUE REFERENCES project_alpha_project_v2_canonical_intents(command_id) ON DELETE RESTRICT,
  external_project_id TEXT NOT NULL REFERENCES operations_shared_projects(external_project_id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK(operation IN ('create','update','bind')),
  prior_local_version INTEGER NOT NULL CHECK(typeof(prior_local_version)='integer' AND prior_local_version>=0),
  resulting_local_version INTEGER NOT NULL CHECK(typeof(resulting_local_version)='integer'
    AND resulting_local_version IN (prior_local_version,prior_local_version+1)
    AND resulting_local_version>=1),
  organization_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  client_record_id TEXT REFERENCES operations_directory_records(record_id) ON DELETE RESTRICT,
  activated_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    CHECK(length(activated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',activated_at) IS activated_at)
);

CREATE TRIGGER project_alpha_project_v2_canonical_activation_receipts_no_update
BEFORE UPDATE ON project_alpha_project_v2_canonical_activation_receipts
BEGIN SELECT RAISE(ABORT,'project v2 canonical activation receipts are immutable'); END;
CREATE TRIGGER project_alpha_project_v2_canonical_activation_receipts_no_delete
BEFORE DELETE ON project_alpha_project_v2_canonical_activation_receipts
BEGIN SELECT RAISE(ABORT,'project v2 canonical activation receipts are durable'); END;

-- Keep the final assertion shallow enough for D1's expression-depth limit.
-- The mapping/head/history writers below independently validate the detailed
-- canonical and directory fields before this compact all-rows-present check.
CREATE TRIGGER project_alpha_project_v2_canonical_activation_receipts_exact
BEFORE INSERT ON project_alpha_project_v2_canonical_activation_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement
  JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=settlement.command_id
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=intent.command_id
  JOIN native_project_live_command_proofs proof ON proof.command_id=intent.command_id
    AND proof.external_project_id=intent.external_project_id AND proof.grant_generation=intent.expected_grant_generation
  JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=intent.external_project_id
  JOIN operations_shared_projects project ON project.external_project_id=intent.external_project_id
  JOIN operations_shared_project_revisions revision ON revision.external_project_id=intent.external_project_id
    AND revision.version=NEW.resulting_local_version
  WHERE settlement.settlement_id=NEW.settlement_id AND settlement.command_id=NEW.command_id
    AND settlement.external_project_id=NEW.external_project_id AND settlement.operation=NEW.operation
    AND settlement.prior_local_version=NEW.prior_local_version
    AND NEW.resulting_local_version=CASE WHEN NEW.prior_local_version=0 THEN 1 ELSE NEW.prior_local_version+1 END
    AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND outbox.state='acknowledged'
    AND json_extract(outbox.outcome_json,'$.projectV2ActivationId')=NEW.activation_id
    AND json_extract(outbox.outcome_json,'$.settlementId')=NEW.settlement_id
    AND mapping.source_id=settlement.source_id AND mapping.source_instance_id=settlement.source_instance_id
    AND mapping.application_id=settlement.application_id AND mapping.history_epoch_id=settlement.history_epoch_id
    AND mapping.project_alpha_public_id=settlement.project_alpha_public_id
    AND project.current_version=NEW.resulting_local_version
    AND project.project_alpha_public_id=settlement.project_alpha_public_id
    AND project.pa_revision=settlement.project_alpha_revision
    AND project.canonical_projection_sha256=settlement.projection_sha256
    AND project.organization_record_id IS NEW.organization_record_id
    AND project.client_record_id IS NEW.client_record_id
    AND revision.pa_revision IS NULL AND revision.refresh_command_id IS NULL
    AND revision.v2_settlement_id=NEW.settlement_id
    AND json(revision.read_json)=json(settlement.read_json)
)
BEGIN SELECT RAISE(ABORT,'project v2 canonical activation receipt is not exact'); END;

-- The 0086 guards remain authoritative for legacy refreshes.  Their v2 branch
-- additionally requires the exact dormant settlement, an unexpired live proof,
-- the pre-POST intent, and the temporary leased outbox state used by the one
-- atomic activation batch.
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
      OR EXISTS (SELECT 1 FROM project_alpha_directory_mappings d JOIN operations_directory_records r
        ON r.record_id=d.external_id AND r.record_kind='organization'
        WHERE d.source_id=settlement.source_id AND d.source_instance_id=settlement.source_instance_id
          AND d.application_id=settlement.application_id AND d.history_epoch_id=settlement.history_epoch_id
          AND d.resource_type='organization' AND d.project_alpha_public_id=json_extract(settlement.read_json,'$.data.organizationPublicId')
          AND d.external_id=NEW.organization_record_id))
    AND ((json_type(settlement.read_json,'$.data.clientPublicId')='null' AND NEW.client_record_id IS NULL)
      OR EXISTS (SELECT 1 FROM project_alpha_directory_mappings d JOIN operations_directory_records r
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
      OR EXISTS (SELECT 1 FROM project_alpha_directory_mappings d JOIN operations_directory_records r
        ON r.record_id=d.external_id AND r.record_kind='organization'
        WHERE d.source_id=settlement.source_id AND d.source_instance_id=settlement.source_instance_id
          AND d.application_id=settlement.application_id AND d.history_epoch_id=settlement.history_epoch_id
          AND d.resource_type='organization' AND d.project_alpha_public_id=json_extract(settlement.read_json,'$.data.organizationPublicId')
          AND d.external_id=NEW.organization_record_id))
    AND ((json_type(settlement.read_json,'$.data.clientPublicId')='null' AND NEW.client_record_id IS NULL)
      OR EXISTS (SELECT 1 FROM project_alpha_directory_mappings d JOIN operations_directory_records r
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

DROP TRIGGER operations_shared_project_revisions_v2_settlement_deferred;
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
      OR EXISTS (SELECT 1 FROM project_alpha_directory_mappings customer
        WHERE customer.source_id=project.source_id AND customer.source_instance_id=project.source_instance_id
          AND customer.application_id=project.application_id AND customer.history_epoch_id=project.history_epoch_id
          AND customer.resource_type='organization' AND customer.external_id=project.organization_record_id
          AND customer.project_alpha_public_id=json_extract(NEW.read_json,'$.data.customer.organizationPublicId')))
    AND (project.client_record_id IS NULL
      AND json_extract(NEW.read_json,'$.data.customer.primaryClientPublicId') IS NULL
      OR EXISTS (SELECT 1 FROM project_alpha_directory_mappings customer
        WHERE customer.source_id=project.source_id AND customer.source_instance_id=project.source_instance_id
          AND customer.application_id=project.application_id AND customer.history_epoch_id=project.history_epoch_id
          AND customer.resource_type='client' AND customer.external_id=project.client_record_id
          AND customer.project_alpha_public_id=json_extract(NEW.read_json,'$.data.customer.primaryClientPublicId')))
)
BEGIN SELECT RAISE(ABORT,'bound shared project revision is not authorized'); END;

CREATE TRIGGER operations_shared_project_revisions_v2_settlement_guard
BEFORE INSERT ON operations_shared_project_revisions
WHEN NEW.v2_settlement_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement
  JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=settlement.command_id
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=intent.command_id AND outbox.state='leased'
  JOIN native_project_live_command_proofs proof ON proof.command_id=intent.command_id
    AND proof.external_project_id=intent.external_project_id AND proof.grant_generation=intent.expected_grant_generation
  JOIN operations_shared_projects project ON project.external_project_id=intent.external_project_id
  JOIN project_alpha_project_mappings mapping ON mapping.external_project_id=intent.external_project_id
  WHERE settlement.settlement_id=NEW.v2_settlement_id AND NEW.external_project_id=intent.external_project_id
    AND NEW.version=project.current_version AND NEW.version=intent.expected_local_version+1
    AND NEW.pa_revision IS NULL AND NEW.refresh_command_id IS NULL
    AND json(NEW.read_json)=json(settlement.read_json)
    AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND mapping.source_id=settlement.source_id AND mapping.source_instance_id=settlement.source_instance_id
    AND mapping.application_id=settlement.application_id AND mapping.history_epoch_id=settlement.history_epoch_id
    AND mapping.project_alpha_public_id=settlement.project_alpha_public_id
    AND project.source_id=settlement.source_id AND project.source_instance_id=settlement.source_instance_id
    AND project.application_id=settlement.application_id AND project.history_epoch_id=settlement.history_epoch_id
    AND project.project_alpha_public_id=settlement.project_alpha_public_id
    AND project.canonical_projection_sha256=settlement.projection_sha256
)
BEGIN SELECT RAISE(ABORT,'project v2 canonical history settlement is not authorized'); END;

-- A v2 mapping must be the exact mapping named by its settlement.  The 0063
-- leased-command trigger continues to govern both legacy and v2 inserts.
CREATE TRIGGER project_alpha_project_mappings_v2_settlement_guard
BEFORE INSERT ON project_alpha_project_mappings
WHEN EXISTS (SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement
  WHERE settlement.command_id=NEW.establishment_command_id)
 AND NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement
  JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=settlement.command_id
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=intent.command_id AND outbox.state='leased'
  JOIN native_project_live_command_proofs proof ON proof.command_id=intent.command_id
    AND proof.external_project_id=intent.external_project_id AND proof.grant_generation=intent.expected_grant_generation
  WHERE settlement.command_id=NEW.establishment_command_id AND intent.operation IN ('create','bind')
    AND intent.expected_mapping_state='absent' AND intent.external_project_id=NEW.external_project_id
    AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND NEW.source_id=settlement.source_id AND NEW.source_instance_id=settlement.source_instance_id
    AND NEW.application_id=settlement.application_id AND NEW.history_epoch_id=settlement.history_epoch_id
    AND NEW.project_alpha_public_id=settlement.project_alpha_public_id
    AND NEW.establishment_kind=intent.operation
    AND ((intent.operation='create' AND NEW.create_command_id=intent.command_id)
      OR (intent.operation='bind' AND NEW.create_command_id IS NULL))
)
BEGIN SELECT RAISE(ABORT,'project v2 mapping settlement is not authorized'); END;
