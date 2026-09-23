PRAGMA foreign_keys = ON;

-- 0125 treated a synthetic NULL relationship row as the representation of a
-- standalone client. Native Directory represents that state by absence. Keep
-- every collision predicate and replace only the relationship trigger.
DROP TRIGGER project_alpha_existing_directory_binding_activation_relationship;

CREATE TRIGGER project_alpha_existing_directory_binding_activation_relationship
BEFORE INSERT ON project_alpha_existing_directory_binding_activation_receipts
WHEN EXISTS (SELECT 1 FROM project_alpha_existing_directory_binding_review_evidence review
  WHERE review.receipt_id=NEW.review_receipt_id AND (
    EXISTS (SELECT 1 FROM project_alpha_directory_mappings legacy
      WHERE legacy.source_id=review.source_id AND legacy.source_instance_id=review.source_instance_id
        AND legacy.application_id=review.application_id AND legacy.resource_type=review.resource_type
        AND (legacy.external_id=review.external_id OR legacy.project_alpha_public_id=review.project_alpha_public_id))
    OR (review.resource_type='client' AND EXISTS (
      SELECT 1 FROM operations_directory_client_organizations relationship
      WHERE relationship.client_record_id=review.record_id
        AND 1<>(
          (SELECT COUNT(*) FROM project_alpha_directory_mappings parent
            JOIN operations_directory_records parent_record
              ON parent_record.record_id=parent.external_id AND parent_record.record_kind='organization'
            WHERE parent.source_id=review.source_id AND parent.source_instance_id=review.source_instance_id
              AND parent.application_id=review.application_id AND parent.history_epoch_id=review.history_epoch_id
              AND parent.resource_type='organization' AND parent.external_id=relationship.organization_record_id)
          + (SELECT COUNT(*) FROM project_alpha_existing_directory_binding_activation_receipts parent
            JOIN operations_directory_records parent_record
              ON parent_record.record_id=parent.record_id AND parent_record.record_kind='organization'
            WHERE parent.source_id=review.source_id AND parent.source_instance_id=review.source_instance_id
              AND parent.application_id=review.application_id AND parent.history_epoch_id=review.history_epoch_id
              AND parent.resource_type='organization' AND parent.record_id=relationship.organization_record_id)
        )
    ))
  ))
BEGIN SELECT RAISE(ABORT,'existing directory binding activation conflicts with mapping or relationship'); END;
