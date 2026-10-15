PRAGMA foreign_keys = ON;

-- An acquired PA identity may differ from the immutable Ops enrollment ID
-- only when the exact active acquired mapping proves the complete tuple.
-- Keep the original live-write-fence, revision, destination, and payload checks.
DROP TRIGGER operations_directory_intents_write_guard;
CREATE TRIGGER operations_directory_intents_write_guard BEFORE INSERT ON operations_directory_intents
WHEN NOT EXISTS(
  SELECT 1
  FROM operations_directory_live_write_fences fence,json_each(fence.destinations_json) destination
  WHERE fence.mutation_id=NEW.mutation_id AND fence.record_id=NEW.record_id
    AND NEW.record_version=fence.expected_version+1
    AND fence.record_writes=0 AND fence.revision_writes=0 AND fence.audit_writes=0 AND fence.intent_writes>0
    AND json_extract(destination.value,'$.sourceId')=NEW.source_id
    AND json_extract(destination.value,'$.sourceInstanceUUID')=NEW.source_instance_uuid
    AND json_extract(destination.value,'$.applicationUUID')=NEW.application_uuid
    AND json_extract(destination.value,'$.historyEpoch')=NEW.expected_history_epoch_id
    AND json_extract(destination.value,'$.origin')=NEW.destination_origin
    AND (
      json_extract(destination.value,'$.externalCanonicalId')=NEW.external_canonical_id
      OR (
        json_extract(destination.value,'$.externalCanonicalId')=NEW.record_id
        AND EXISTS(
          SELECT 1
          FROM project_alpha_active_directory_mappings mapping
          JOIN operations_directory_records record
            ON record.record_id=mapping.record_id AND record.record_kind=mapping.resource_type
          WHERE mapping.mapping_kind='acquired'
            AND mapping.record_id=NEW.record_id
            AND mapping.resource_type=fence.record_kind
            AND mapping.source_id=NEW.source_id
            AND mapping.source_instance_id=NEW.source_instance_uuid
            AND mapping.application_id=NEW.application_uuid
            AND mapping.history_epoch_id=NEW.expected_history_epoch_id
            AND mapping.external_id=NEW.external_canonical_id
            AND length(mapping.project_alpha_public_id)=32
            AND mapping.project_alpha_public_id=lower(mapping.project_alpha_public_id)
            AND mapping.project_alpha_public_id NOT GLOB '*[^0-9a-f]*'
        )
      )
    )
    AND json(NEW.desired_payload_json)=json(fence.profile_json)
)
BEGIN SELECT RAISE(ABORT,'directory intent requires current native authority and enrollment'); END;
