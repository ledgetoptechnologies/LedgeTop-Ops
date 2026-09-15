PRAGMA foreign_keys = ON;

-- 0120 is published history. Strengthen its two dormant evidence writers
-- forward-only so a proof that expires after its original insertion is no
-- longer treated as current authority for a private PA read settlement.
DROP TRIGGER IF EXISTS project_alpha_project_v2_canonical_intents_exact;
CREATE TRIGGER project_alpha_project_v2_canonical_intents_exact
BEFORE INSERT ON project_alpha_project_v2_canonical_intents
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_request_fingerprints fingerprint
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=fingerprint.command_id
  JOIN native_project_command_reservations reservation ON reservation.command_id=outbox.command_id
  JOIN native_project_live_command_proofs proof ON proof.command_id=outbox.command_id
    AND proof.external_project_id=outbox.external_project_id
  WHERE fingerprint.command_id=NEW.command_id AND fingerprint.request_sha256=NEW.request_sha256
    AND outbox.operation=NEW.operation AND outbox.external_project_id=NEW.external_project_id
    AND outbox.source_id=NEW.source_id AND outbox.expected_source_instance_id=NEW.source_instance_id
    AND outbox.application_id=NEW.application_id AND outbox.expected_history_epoch_id=NEW.history_epoch_id
    AND proof.grant_generation=NEW.expected_grant_generation
    AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND json_type(outbox.command_json,'$.commandId')='text'
    AND json_extract(outbox.command_json,'$.commandId')=NEW.command_id
    AND json_type(outbox.command_json,'$.externalId')='text'
    AND json_extract(outbox.command_json,'$.externalId')=NEW.external_project_id
)
 OR NOT (
   (NEW.expected_local_version=0 AND NOT EXISTS (
      SELECT 1 FROM operations_shared_projects project
      WHERE project.external_project_id=NEW.external_project_id))
   OR (NEW.expected_local_version>=1 AND EXISTS (
      SELECT 1 FROM operations_shared_projects project
      WHERE project.external_project_id=NEW.external_project_id
        AND project.current_version=NEW.expected_local_version
        AND project.canonical_projection_sha256=NEW.expected_local_projection_sha256))
 )
 OR (NEW.expected_mapping_state='absent' AND EXISTS (
      SELECT 1 FROM project_alpha_project_mappings mapping
      WHERE mapping.external_project_id=NEW.external_project_id))
 OR (NEW.expected_mapping_state='exact' AND NOT EXISTS (
      SELECT 1 FROM project_alpha_project_mappings mapping
      WHERE mapping.external_project_id=NEW.external_project_id
        AND mapping.source_id=NEW.source_id AND mapping.source_instance_id=NEW.source_instance_id
        AND mapping.application_id=NEW.application_id AND mapping.history_epoch_id=NEW.history_epoch_id
        AND mapping.project_alpha_public_id=NEW.expected_project_alpha_public_id))
BEGIN SELECT RAISE(ABORT,'project v2 canonical intent is not current and exact'); END;

DROP TRIGGER IF EXISTS project_alpha_project_v2_canonical_settlement_receipts_exact;
CREATE TRIGGER project_alpha_project_v2_canonical_settlement_receipts_exact
BEFORE INSERT ON project_alpha_project_v2_canonical_settlement_receipts
WHEN NOT EXISTS (
  SELECT 1 FROM project_alpha_project_v2_canonical_intents intent
  JOIN project_alpha_project_v2_success_receipts receipt ON receipt.command_id=intent.command_id
  JOIN project_alpha_project_outbox outbox ON outbox.command_id=intent.command_id
  JOIN native_project_live_command_proofs proof ON proof.command_id=outbox.command_id
    AND proof.external_project_id=outbox.external_project_id
  WHERE intent.command_id=NEW.command_id AND receipt.receipt_id=NEW.success_receipt_id
    AND intent.operation=NEW.operation AND intent.external_project_id=NEW.external_project_id
    AND intent.source_id=NEW.source_id AND intent.source_instance_id=NEW.source_instance_id
    AND intent.application_id=NEW.application_id AND intent.history_epoch_id=NEW.history_epoch_id
    AND intent.expected_local_version=NEW.prior_local_version
    AND proof.grant_generation=intent.expected_grant_generation
    AND proof.verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND receipt.source_instance_id=NEW.source_instance_id AND receipt.application_id=NEW.application_id
    AND receipt.history_epoch_id=NEW.history_epoch_id
    AND receipt.project_alpha_public_id=NEW.project_alpha_public_id
    AND receipt.project_alpha_revision=NEW.project_alpha_revision
    AND receipt.projection_sha256=NEW.projection_sha256
    AND ((intent.expected_local_version=0 AND NOT EXISTS (
        SELECT 1 FROM operations_shared_projects project
        WHERE project.external_project_id=intent.external_project_id))
      OR (intent.expected_local_version>=1 AND EXISTS (
        SELECT 1 FROM operations_shared_projects project
        WHERE project.external_project_id=intent.external_project_id
          AND project.current_version=intent.expected_local_version
          AND project.canonical_projection_sha256=intent.expected_local_projection_sha256)))
    AND ((intent.expected_mapping_state='absent' AND NOT EXISTS (
        SELECT 1 FROM project_alpha_project_mappings mapping
        WHERE mapping.external_project_id=intent.external_project_id))
      OR (intent.expected_mapping_state='exact' AND EXISTS (
        SELECT 1 FROM project_alpha_project_mappings mapping
        WHERE mapping.external_project_id=intent.external_project_id
          AND mapping.source_id=intent.source_id
          AND mapping.source_instance_id=intent.source_instance_id
          AND mapping.application_id=intent.application_id
          AND mapping.history_epoch_id=intent.history_epoch_id
          AND mapping.project_alpha_public_id=intent.expected_project_alpha_public_id)))
)
BEGIN SELECT RAISE(ABORT,'project v2 canonical settlement receipt is not exact'); END;
