PRAGMA foreign_keys = ON;

-- 0125 incorrectly equated the pre-command review observation with the
-- post-acknowledgement binding-status observation. Preserve both immutable
-- hashes in their distinct roles and replace only the exact-chain trigger.
DROP TRIGGER project_alpha_existing_directory_binding_activation_exact;

CREATE TRIGGER project_alpha_existing_directory_binding_activation_exact
BEFORE INSERT ON project_alpha_existing_directory_binding_activation_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM project_alpha_existing_directory_binding_review_evidence review
  JOIN project_alpha_existing_directory_binding_acquisition_commands command
    ON command.review_receipt_id=review.receipt_id
  JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response
    ON response.command_id=command.command_id
  JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired
    ON acquired.command_id=command.command_id
  JOIN project_alpha_acquired_canonical_mappings mapping ON mapping.receipt_id=acquired.receipt_id
  JOIN project_alpha_acquired_native_owner_claims claim ON claim.receipt_id=mapping.receipt_id
  JOIN project_alpha_acquired_mapping_activation dormant ON dormant.receipt_id=mapping.receipt_id AND dormant.state='inactive'
  JOIN operations_directory_records record ON record.record_id=review.record_id
  WHERE (review.receipt_id,acquired.receipt_id,claim.claim_id)=
      (NEW.review_receipt_id,NEW.acquired_receipt_id,NEW.native_owner_claim_id)
    AND (NEW.record_id,NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,
      NEW.resource_type,NEW.external_id,NEW.project_alpha_public_id,NEW.project_alpha_revision,
      NEW.local_record_version,NEW.request_sha256)=
      (review.record_id,review.source_id,review.source_instance_id,review.application_id,review.history_epoch_id,
      review.resource_type,review.external_id,review.project_alpha_public_id,review.project_alpha_revision,
      review.reviewed_local_record_version,review.request_sha256)
    AND (NEW.acquisition_evidence_sha256,NEW.profile_evidence_sha256,NEW.binding_status_evidence_sha256)=
      (acquired.acquisition_evidence_sha256,acquired.profile_evidence_sha256,acquired.binding_status_evidence_sha256)
    AND response.response_sha256=acquired.acquisition_evidence_sha256
    AND review.reviewed_binding_evidence_sha256<>acquired.acquisition_evidence_sha256
    AND review.reviewed_binding_evidence_sha256<>acquired.profile_evidence_sha256
    AND review.reviewed_binding_evidence_sha256<>acquired.binding_status_evidence_sha256
    AND acquired.acquisition_evidence_sha256<>acquired.profile_evidence_sha256
    AND acquired.acquisition_evidence_sha256<>acquired.binding_status_evidence_sha256
    AND acquired.profile_evidence_sha256<>acquired.binding_status_evidence_sha256
    AND review.reviewed_at<=response.received_at AND response.received_at<=acquired.acquired_at
    AND NOT EXISTS (
      SELECT 1 FROM project_alpha_existing_directory_binding_review_evidence other_review
      WHERE other_review.receipt_id<>review.receipt_id
        AND other_review.reviewed_binding_evidence_sha256 IN (
          review.reviewed_binding_evidence_sha256,acquired.acquisition_evidence_sha256,
          acquired.profile_evidence_sha256,acquired.binding_status_evidence_sha256)
      UNION ALL
      SELECT 1 FROM project_alpha_existing_directory_binding_acquired_mapping_receipts other_acquired
      WHERE other_acquired.receipt_id<>acquired.receipt_id
        AND (other_acquired.acquisition_evidence_sha256 IN (
              review.reviewed_binding_evidence_sha256,acquired.acquisition_evidence_sha256,
              acquired.profile_evidence_sha256,acquired.binding_status_evidence_sha256)
          OR other_acquired.profile_evidence_sha256 IN (
              review.reviewed_binding_evidence_sha256,acquired.acquisition_evidence_sha256,
              acquired.profile_evidence_sha256,acquired.binding_status_evidence_sha256)
          OR other_acquired.binding_status_evidence_sha256 IN (
              review.reviewed_binding_evidence_sha256,acquired.acquisition_evidence_sha256,
              acquired.profile_evidence_sha256,acquired.binding_status_evidence_sha256))
    )
    AND (command.request_sha256,acquired.request_sha256,claim.request_sha256)=
      (review.request_sha256,review.request_sha256,review.request_sha256)
    AND claim.actor_id=review.reviewer_staff_id
    AND (response.source_instance_id,response.application_id,response.history_epoch_id,response.resource_type,
      response.external_id,response.project_alpha_public_id,response.project_alpha_revision)=
      (review.source_instance_id,review.application_id,review.history_epoch_id,review.resource_type,
      review.external_id,review.project_alpha_public_id,review.project_alpha_revision)
    AND (mapping.record_id,mapping.source_id,mapping.source_instance_id,mapping.application_id,
      mapping.history_epoch_id,mapping.resource_type,mapping.external_id,mapping.project_alpha_public_id)=
      (review.record_id,review.source_id,review.source_instance_id,review.application_id,
      review.history_epoch_id,review.resource_type,review.external_id,review.project_alpha_public_id)
    AND mapping.activation_state='inactive' AND mapping.native_owner_epoch_id IS NULL
    AND (claim.record_id,claim.source_id,claim.source_instance_id,claim.application_id,claim.history_epoch_id,
      claim.resource_type,claim.external_id,claim.project_alpha_public_id)=
      (review.record_id,review.source_id,review.source_instance_id,review.application_id,review.history_epoch_id,
      review.resource_type,review.external_id,review.project_alpha_public_id)
    AND claim.expected_local_record_version=review.reviewed_local_record_version
    AND record.record_kind=review.resource_type AND record.current_version=review.reviewed_local_record_version
    AND review.reviewed_local_record_version IS NOT NULL
    AND review.reviewed_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND review.reviewed_at>strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 hours')
    AND NEW.activated_by_staff_id=review.reviewer_staff_id
    AND EXISTS (SELECT 1 FROM project_alpha_existing_directory_binding_acquisition_events event
      WHERE event.command_id=command.command_id AND event.state='acknowledged'
        AND event.request_sha256=review.request_sha256
        AND event.occurred_at>=review.reviewed_at AND event.occurred_at<=acquired.acquired_at)
)
BEGIN SELECT RAISE(ABORT,'existing directory binding activation requires current exact authority and evidence'); END;
