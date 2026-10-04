-- Directory and Project authorization generations advance independently in
-- Project Alpha. Compare only receipts for the same inventory surface; keep
-- any conflict evidence written by the earlier cross-surface check immutable.
CREATE TRIGGER project_alpha_api_v2_inventory_receipts_generation_conflict_surface_scoped
AFTER INSERT ON project_alpha_api_v2_inventory_receipts
WHEN EXISTS (SELECT 1 FROM project_alpha_api_v2_inventory_receipts prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.inventory_kind=NEW.inventory_kind
    AND (length(prior.authorization_generation)>length(NEW.authorization_generation)
      OR (length(prior.authorization_generation)=length(NEW.authorization_generation)
        AND prior.authorization_generation>NEW.authorization_generation)))
BEGIN
  INSERT OR IGNORE INTO project_alpha_api_v2_inventory_conflicts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
    request_id,prior_reference,conflict_kind,observed_revision,details_json)
  SELECT NEW.source_id,NEW.source_instance_id,NEW.application_id,NEW.history_epoch_id,
    NEW.inventory_kind,'source',NEW.request_id,prior.request_id,
    'authorization_generation_regressed',NEW.authorization_generation,
    json_object('observedAuthorizationGeneration',NEW.authorization_generation,
      'priorAuthorizationGeneration',prior.authorization_generation)
  FROM project_alpha_api_v2_inventory_receipts prior
  WHERE prior.source_id=NEW.source_id AND prior.source_instance_id=NEW.source_instance_id
    AND prior.application_id=NEW.application_id AND prior.history_epoch_id=NEW.history_epoch_id
    AND prior.inventory_kind=NEW.inventory_kind
    AND (length(prior.authorization_generation)>length(NEW.authorization_generation)
      OR (length(prior.authorization_generation)=length(NEW.authorization_generation)
        AND prior.authorization_generation>NEW.authorization_generation))
  ORDER BY length(prior.authorization_generation) DESC,prior.authorization_generation DESC,
    prior.observed_at DESC LIMIT 1;
END;

-- Install the corrected guard before removing the old one. If a staging
-- console applies statements separately, there is no interval without a guard.
DROP TRIGGER project_alpha_api_v2_inventory_receipts_generation_conflict;
