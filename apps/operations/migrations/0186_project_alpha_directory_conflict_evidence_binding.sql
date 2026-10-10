-- Tighten the 0185 historical false-positive exemption to the exact immutable
-- conflict evidence emitted by the original 0161 revision-reuse trigger.
DROP VIEW project_alpha_api_v2_directory_observations_current;

CREATE VIEW project_alpha_api_v2_directory_observations_current AS
SELECT observation.*,
  EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
    WHERE conflict.source_id=observation.source_id
      AND conflict.source_instance_id=observation.source_instance_id
      AND conflict.application_id=observation.application_id
      AND conflict.history_epoch_id=observation.history_epoch_id
      AND conflict.inventory_kind='directory'
      AND conflict.resource_type=observation.resource_type
      AND conflict.project_alpha_public_id=observation.project_alpha_public_id
      AND NOT (conflict.conflict_kind='revision_reuse_mismatch' AND EXISTS (
        SELECT 1
        FROM project_alpha_api_v2_directory_observations conflicted
        JOIN project_alpha_api_v2_directory_observations prior
          ON prior.source_id=conflicted.source_id
         AND prior.source_instance_id=conflicted.source_instance_id
         AND prior.application_id=conflicted.application_id
         AND prior.history_epoch_id=conflicted.history_epoch_id
         AND prior.resource_type=conflicted.resource_type
         AND prior.project_alpha_public_id=conflicted.project_alpha_public_id
         AND prior.request_id=conflict.prior_reference
        JOIN project_alpha_api_v2_inventory_receipts conflicted_receipt
          ON conflicted_receipt.source_id=conflicted.source_id
         AND conflicted_receipt.source_instance_id=conflicted.source_instance_id
         AND conflicted_receipt.application_id=conflicted.application_id
         AND conflicted_receipt.history_epoch_id=conflicted.history_epoch_id
         AND conflicted_receipt.inventory_kind='directory'
         AND conflicted_receipt.request_id=conflicted.request_id
        JOIN project_alpha_api_v2_inventory_receipts prior_receipt
          ON prior_receipt.source_id=prior.source_id
         AND prior_receipt.source_instance_id=prior.source_instance_id
         AND prior_receipt.application_id=prior.application_id
         AND prior_receipt.history_epoch_id=prior.history_epoch_id
         AND prior_receipt.inventory_kind='directory'
         AND prior_receipt.request_id=prior.request_id
        WHERE conflicted.source_id=conflict.source_id
          AND conflicted.source_instance_id=conflict.source_instance_id
          AND conflicted.application_id=conflict.application_id
          AND conflicted.history_epoch_id=conflict.history_epoch_id
          AND conflicted.resource_type=conflict.resource_type
          AND conflicted.project_alpha_public_id=conflict.project_alpha_public_id
          AND conflicted.request_id=conflict.request_id
          AND conflict.observed_revision=conflicted.resource_revision
          AND conflict.external_id IS conflicted.binding_external_id
          AND conflict.details_json=json_object(
            'observedProjectionSha256',conflicted.projection_sha256,
            'priorProjectionSha256',prior.projection_sha256)
          AND conflicted.resource_revision=prior.resource_revision
          AND conflicted.present=prior.present
          AND conflicted.last_action=prior.last_action
          AND conflicted.projection_sha256=prior.projection_sha256
          AND (conflicted.binding_external_id IS NOT prior.binding_external_id
            OR conflicted.binding_status IS NOT prior.binding_status
            OR conflicted.binding_resource_revision IS NOT prior.binding_resource_revision)
          AND (length(conflicted_receipt.authorization_generation)>length(prior_receipt.authorization_generation)
            OR (length(conflicted_receipt.authorization_generation)=length(prior_receipt.authorization_generation)
              AND conflicted_receipt.authorization_generation>prior_receipt.authorization_generation))))) AS has_conflict
FROM project_alpha_api_v2_directory_observations observation
JOIN project_alpha_api_v2_inventory_receipts receipt
  ON receipt.source_id=observation.source_id AND receipt.source_instance_id=observation.source_instance_id
 AND receipt.application_id=observation.application_id AND receipt.history_epoch_id=observation.history_epoch_id
 AND receipt.inventory_kind='directory' AND receipt.request_id=observation.request_id
WHERE NOT EXISTS (SELECT 1 FROM project_alpha_api_v2_directory_observations newer
  JOIN project_alpha_api_v2_inventory_receipts newer_receipt
    ON newer_receipt.source_id=newer.source_id AND newer_receipt.source_instance_id=newer.source_instance_id
   AND newer_receipt.application_id=newer.application_id AND newer_receipt.history_epoch_id=newer.history_epoch_id
   AND newer_receipt.inventory_kind='directory' AND newer_receipt.request_id=newer.request_id
  WHERE newer.source_id=observation.source_id AND newer.source_instance_id=observation.source_instance_id
    AND newer.application_id=observation.application_id AND newer.history_epoch_id=observation.history_epoch_id
    AND newer.resource_type=observation.resource_type AND newer.project_alpha_public_id=observation.project_alpha_public_id
    AND (length(newer.resource_revision)>length(observation.resource_revision)
      OR (newer.resource_revision=observation.resource_revision
        AND (newer_receipt.observed_at>receipt.observed_at
          OR (newer_receipt.observed_at=receipt.observed_at AND newer.request_id>observation.request_id)))
      OR (length(newer.resource_revision)=length(observation.resource_revision)
        AND newer.resource_revision>observation.resource_revision)));
