PRAGMA foreign_keys = ON;

-- The original create intent pins the native Operations record ID. A later
-- profile update may use a distinct PA canonical ID only after the exact
-- acquired mapping is active. Origin changes and every legacy/unmapped ID
-- change remain explicit-reconciliation work.
DROP TRIGGER operations_directory_intents_destination_pinned;
CREATE TRIGGER operations_directory_intents_destination_pinned
BEFORE INSERT ON operations_directory_intents
WHEN EXISTS (
  SELECT 1 FROM operations_directory_intents previous
  WHERE previous.record_id=NEW.record_id AND previous.source_id=NEW.source_id
    AND previous.source_instance_uuid=NEW.source_instance_uuid
    AND previous.application_uuid=NEW.application_uuid
    AND (
      previous.destination_origin IS NOT NEW.destination_origin
      OR (previous.external_canonical_id IS NOT NEW.external_canonical_id AND (
        previous.external_canonical_id IS NOT NEW.record_id
        OR NOT EXISTS (
          SELECT 1 FROM project_alpha_active_directory_mappings mapping
          JOIN operations_directory_records record
            ON record.record_id=mapping.record_id AND record.record_kind=mapping.resource_type
          WHERE mapping.mapping_kind='acquired'
            AND mapping.source_id=NEW.source_id
            AND mapping.source_instance_id=NEW.source_instance_uuid
            AND mapping.application_id=NEW.application_uuid
            AND mapping.history_epoch_id=NEW.expected_history_epoch_id
            AND mapping.resource_type=record.record_kind
            AND mapping.record_id=NEW.record_id
            AND mapping.external_id=NEW.external_canonical_id
            AND length(mapping.project_alpha_public_id)=32
            AND mapping.project_alpha_public_id=lower(mapping.project_alpha_public_id)
            AND mapping.project_alpha_public_id NOT GLOB '*[^0-9a-f]*'
        )
      ))
    )
)
BEGIN SELECT RAISE(ABORT,'directory destination requires explicit reconciliation'); END;
