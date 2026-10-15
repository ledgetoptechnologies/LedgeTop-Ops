-- Repeated inventory snapshots may legitimately preserve an unchanged owner
-- tuple. Require the current maximal observation to match the preparation
-- instead of rejecting an older matching observation merely because another
-- identical observation was recorded later.
DROP TRIGGER client_hub_native_project_preparations_insert_create_observation_latest;

CREATE TRIGGER client_hub_native_project_preparations_insert_create_observation_latest
AFTER INSERT ON client_hub_native_project_preparations
WHEN json_extract(NEW.request_json,'$.operation')='create' AND NOT EXISTS (
 SELECT 1 FROM project_alpha_api_v2_directory_observations selected
 JOIN project_alpha_api_v2_inventory_receipts selected_receipt
  ON selected_receipt.source_id=selected.source_id AND selected_receipt.source_instance_id=selected.source_instance_id
  AND selected_receipt.application_id=selected.application_id AND selected_receipt.history_epoch_id=selected.history_epoch_id
  AND selected_receipt.inventory_kind='directory' AND selected_receipt.request_id=selected.request_id
 WHERE selected.source_id=NEW.context_source_id AND selected.source_instance_id=NEW.source_instance_id
  AND selected.application_id=NEW.application_id AND selected.history_epoch_id=NEW.history_epoch_id
  AND selected.resource_type=CASE NEW.context_root_kind WHEN 'organization' THEN 'organization' ELSE 'client' END
  AND selected.project_alpha_public_id=json_extract(NEW.request_json,CASE NEW.context_root_kind
    WHEN 'organization' THEN '$.command.organization.expectedPublicId' ELSE '$.command.client.expectedPublicId' END)
  AND selected.resource_revision=json_extract(NEW.request_json,CASE NEW.context_root_kind
    WHEN 'organization' THEN '$.command.organization.expectedRevision' ELSE '$.command.client.expectedRevision' END)
  AND selected.projection_sha256=json_extract(NEW.request_json,CASE NEW.context_root_kind
    WHEN 'organization' THEN '$.command.organization.expectedProjectionSha256' ELSE '$.command.client.expectedProjectionSha256' END)
  AND selected.present=1 AND selected.binding_status='active'
  AND selected.binding_external_id=json_extract(NEW.request_json,CASE NEW.context_root_kind
    WHEN 'organization' THEN '$.command.organization.externalId' ELSE '$.command.client.externalId' END)
  AND selected.binding_resource_revision=selected.resource_revision
  AND NOT EXISTS (
   SELECT 1 FROM project_alpha_api_v2_directory_observations newer
   JOIN project_alpha_api_v2_inventory_receipts newer_receipt
    ON newer_receipt.source_id=newer.source_id AND newer_receipt.source_instance_id=newer.source_instance_id
    AND newer_receipt.application_id=newer.application_id AND newer_receipt.history_epoch_id=newer.history_epoch_id
    AND newer_receipt.inventory_kind='directory' AND newer_receipt.request_id=newer.request_id
   WHERE newer.source_id=selected.source_id AND newer.source_instance_id=selected.source_instance_id
    AND newer.application_id=selected.application_id AND newer.history_epoch_id=selected.history_epoch_id
    AND newer.resource_type=selected.resource_type AND newer.project_alpha_public_id=selected.project_alpha_public_id
    AND (length(newer.resource_revision)>length(selected.resource_revision)
      OR length(newer.resource_revision)=length(selected.resource_revision) AND newer.resource_revision>selected.resource_revision
      OR newer.resource_revision=selected.resource_revision AND (newer_receipt.observed_at>selected_receipt.observed_at
        OR newer_receipt.observed_at=selected_receipt.observed_at AND newer.request_id>selected.request_id))))
BEGIN SELECT RAISE(ABORT,'client hub native project preparation authority is not current and exact'); END;
