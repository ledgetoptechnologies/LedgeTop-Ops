PRAGMA foreign_keys = ON;

-- Preserve the immutable 0058 enrollment identity for every legacy and
-- parent-intent relationship. A separately reviewed/activated acquired
-- mapping may use a different PA external ID; in that case the enrollment
-- must still pin the original Ops record ID, and the acquired evidence branch
-- below must prove the exact active activation receipt.
DROP TRIGGER operations_directory_intent_relationship_dependencies_insert_guard;
CREATE TRIGGER operations_directory_intent_relationship_dependencies_insert_guard
BEFORE INSERT ON operations_directory_intent_relationship_dependencies
WHEN EXISTS(SELECT 1 FROM operations_directory_intent_relationship_dependencies WHERE intent_id=NEW.intent_id)
  OR NOT EXISTS(SELECT 1 FROM operations_directory_intents intent
    JOIN operations_directory_records client ON client.record_id=intent.record_id AND client.record_kind='client'
    JOIN operations_directory_client_organization_history history
      ON history.client_record_id=intent.record_id AND history.relationship_version=NEW.relationship_version
    JOIN operations_directory_client_organizations current_relation
      ON current_relation.client_record_id=intent.record_id AND current_relation.relationship_version=NEW.relationship_version
    JOIN operations_directory_live_write_fences fence
      ON fence.mutation_id=intent.mutation_id AND fence.record_id=intent.record_id
      AND fence.record_writes=0 AND fence.revision_writes=0 AND fence.audit_writes=0 AND fence.intent_writes=0
    WHERE intent.intent_id=NEW.intent_id AND intent.record_id=NEW.client_record_id
      AND intent.record_version=NEW.client_record_version
      AND history.mutation_id=NEW.relationship_mutation_id
      AND history.client_record_version<=NEW.client_record_version
      AND history.organization_record_id IS NEW.organization_record_id
      AND current_relation.organization_record_id IS NEW.organization_record_id
      AND intent.source_id=NEW.source_id AND intent.source_instance_uuid=NEW.source_instance_uuid
      AND intent.application_uuid=NEW.application_uuid AND intent.expected_history_epoch_id=NEW.history_epoch_id
      AND intent.destination_origin=NEW.destination_origin
      AND ((NEW.evidence_kind='unlinked' AND NEW.organization_record_id IS NULL)
        OR (NEW.organization_record_id IS NOT NULL AND EXISTS(
          SELECT 1 FROM operations_directory_records parent
          JOIN operations_directory_revisions parent_revision
            ON parent_revision.record_id=parent.record_id AND parent_revision.version=NEW.organization_record_version
          JOIN native_directory_enrollments enrollment ON enrollment.record_id=parent.record_id
          WHERE parent.record_id=NEW.organization_record_id AND parent.record_kind='organization'
            AND parent.current_version=NEW.organization_record_version
            AND EXISTS(SELECT 1 FROM json_each(enrollment.destinations_json) destination
              WHERE json_extract(destination.value,'$.sourceId')=NEW.source_id
                AND json_extract(destination.value,'$.sourceInstanceUUID')=NEW.source_instance_uuid
                AND json_extract(destination.value,'$.applicationUUID')=NEW.application_uuid
                AND json_extract(destination.value,'$.historyEpoch')=NEW.history_epoch_id
                AND json_extract(destination.value,'$.origin')=NEW.destination_origin
                AND ((NEW.evidence_kind='acquired_mapping'
                    AND json_extract(destination.value,'$.externalCanonicalId')=NEW.organization_record_id)
                  OR (NEW.evidence_kind<>'acquired_mapping'
                    AND json_extract(destination.value,'$.externalCanonicalId')=NEW.parent_external_canonical_id)))
        ))))
  OR (NEW.evidence_kind='parent_intent' AND NOT EXISTS(
    SELECT 1 FROM operations_directory_intents parent
    JOIN operations_directory_records record ON record.record_id=parent.record_id AND record.record_kind='organization'
    WHERE parent.intent_id=NEW.parent_intent_id AND parent.record_id=NEW.organization_record_id
      AND parent.record_version=NEW.organization_record_version
      AND parent.source_id=NEW.source_id AND parent.source_instance_uuid=NEW.source_instance_uuid
      AND parent.application_uuid=NEW.application_uuid AND parent.expected_history_epoch_id=NEW.history_epoch_id
      AND parent.destination_origin=NEW.destination_origin
      AND parent.external_canonical_id=NEW.parent_external_canonical_id))
  OR (NEW.evidence_kind='existing_mapping' AND NOT EXISTS(
    SELECT 1 FROM project_alpha_directory_mappings mapping
    JOIN project_alpha_directory_outbox outbox ON outbox.command_id=mapping.command_id
    WHERE mapping.command_id=NEW.parent_mapping_command_id
      AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_uuid
      AND mapping.application_id=NEW.application_uuid AND mapping.history_epoch_id=NEW.history_epoch_id
      AND mapping.resource_type='organization' AND mapping.external_id=NEW.parent_external_canonical_id
      AND mapping.project_alpha_public_id=NEW.parent_public_id
      AND outbox.state='acknowledged' AND outbox.command_json IS NEW.parent_ack_command_json
      AND outbox.outcome_json IS NEW.parent_ack_outcome_json
      AND outbox.source_id=NEW.source_id AND outbox.expected_source_instance_id=NEW.source_instance_uuid
      AND outbox.application_id=NEW.application_uuid AND outbox.expected_history_epoch_id=NEW.history_epoch_id
      AND outbox.destination_base_url=NEW.destination_origin
      AND outbox.resource_type='organization' AND outbox.external_id=NEW.parent_external_canonical_id
      AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
      AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=NEW.history_epoch_id
      AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=NEW.source_instance_uuid
      AND json_extract(outbox.outcome_json,'$.response.applicationId')=NEW.application_uuid
      AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
      AND json_extract(outbox.outcome_json,'$.response.result.resource.id')=NEW.parent_external_canonical_id
      AND json_extract(outbox.outcome_json,'$.response.result.resource.revision')=NEW.parent_ack_revision
      AND json_extract(outbox.outcome_json,'$.response.result.data.publicId')=NEW.parent_public_id))
  OR (NEW.evidence_kind='acquired_mapping' AND NOT EXISTS(
    SELECT 1
    FROM project_alpha_existing_directory_binding_activation_receipts activation
    JOIN project_alpha_active_directory_mappings mapping
      ON mapping.mapping_kind='acquired' AND mapping.provenance_id=activation.activation_id
      AND mapping.record_id=activation.record_id
      AND mapping.source_id=activation.source_id AND mapping.source_instance_id=activation.source_instance_id
      AND mapping.application_id=activation.application_id AND mapping.history_epoch_id=activation.history_epoch_id
      AND mapping.resource_type='organization' AND mapping.external_id=activation.external_id
      AND mapping.project_alpha_public_id=activation.project_alpha_public_id
    WHERE activation.activation_id=NEW.parent_activation_id
      AND activation.record_id=NEW.organization_record_id
      AND activation.source_id=NEW.source_id AND activation.source_instance_id=NEW.source_instance_uuid
      AND activation.application_id=NEW.application_uuid AND activation.history_epoch_id=NEW.history_epoch_id
      AND activation.resource_type='organization' AND activation.external_id=NEW.parent_external_canonical_id
      AND activation.project_alpha_public_id=NEW.parent_public_id
      AND activation.project_alpha_revision=NEW.parent_ack_revision
      AND (activation.local_record_version=NEW.organization_record_version OR EXISTS(
        SELECT 1 FROM operations_directory_intents updated
        JOIN operations_directory_materializations materialization ON materialization.intent_id=updated.intent_id
          AND materialization.history_epoch_id=updated.expected_history_epoch_id
        JOIN operations_directory_audit audit ON audit.mutation_id=updated.mutation_id
          AND audit.record_id=updated.record_id AND audit.record_version=updated.record_version
          AND audit.actor_type='staff' AND json_extract(audit.command_json,'$.operation')='update'
        JOIN project_alpha_directory_outbox outbox ON outbox.command_id=materialization.command_id
          AND outbox.state='acknowledged' AND outbox.command_json=materialization.command_json
          AND outbox.source_id=updated.source_id
          AND outbox.expected_source_instance_id=updated.source_instance_uuid AND outbox.application_id=updated.application_uuid
          AND outbox.expected_history_epoch_id=updated.expected_history_epoch_id
          AND outbox.destination_base_url=updated.destination_origin AND outbox.resource_type='organization'
          AND outbox.external_id=updated.external_canonical_id
        WHERE updated.record_id=NEW.organization_record_id AND updated.record_version=NEW.organization_record_version
          AND updated.state='acknowledged' AND updated.source_id=NEW.source_id
          AND updated.source_instance_uuid=NEW.source_instance_uuid AND updated.application_uuid=NEW.application_uuid
          AND updated.expected_history_epoch_id=NEW.history_epoch_id AND updated.destination_origin=NEW.destination_origin
          AND updated.external_canonical_id=NEW.parent_external_canonical_id
          AND json_extract(outbox.command_json,'$.operation')='update'
          AND json_extract(outbox.command_json,'$.resourceType')='organization'
          AND json_extract(outbox.command_json,'$.externalId')=NEW.parent_external_canonical_id
          AND json_extract(outbox.command_json,'$.expectedProjectAlphaPublicId')=NEW.parent_public_id
          AND json_extract(outbox.outcome_json,'$.status')='acknowledged'
          AND json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=NEW.source_instance_uuid
          AND json_extract(outbox.outcome_json,'$.response.applicationId')=NEW.application_uuid
          AND json_extract(outbox.outcome_json,'$.response.historyEpoch')=NEW.history_epoch_id
          AND json_extract(outbox.outcome_json,'$.response.result.resource.type')='organization'
          AND json_extract(outbox.outcome_json,'$.response.result.resource.publicId')=NEW.parent_public_id
          AND json_type(outbox.outcome_json,'$.response.result.resource.revision')='text'
          AND length(json_extract(outbox.outcome_json,'$.response.result.resource.revision')) BETWEEN 1 AND 19
          AND json_extract(outbox.outcome_json,'$.response.result.resource.revision') NOT GLOB '*[^0-9]*'
          AND substr(json_extract(outbox.outcome_json,'$.response.result.resource.revision'),1,1)<>'0'
      ))))
BEGIN SELECT RAISE(ABORT,'directory intent relationship dependency requires live canonical evidence'); END;
