// Exact provenance predicate used by the financial resolver (1666b635).
// Kept separate here so the refresh workflow does not alter financial gates.
export function historicalCrossSurfaceGenerationConflict(surface: "directory" | "project"): string {
  return `conflict.conflict_kind='authorization_generation_regressed'
    AND conflict.resource_type='source' AND conflict.inventory_kind='${surface}'
    AND conflict.project_alpha_public_id IS NULL AND conflict.external_id IS NULL
    AND EXISTS (SELECT 1 FROM project_alpha_api_v2_inventory_receipts observed
      JOIN project_alpha_api_v2_inventory_receipts prior
        ON prior.source_id=observed.source_id AND prior.source_instance_id=observed.source_instance_id
        AND prior.application_id=observed.application_id AND prior.history_epoch_id=observed.history_epoch_id
        AND prior.inventory_kind<>observed.inventory_kind AND prior.request_id=conflict.prior_reference
      WHERE observed.source_id=conflict.source_id AND observed.source_instance_id=conflict.source_instance_id
        AND observed.application_id=conflict.application_id AND observed.history_epoch_id=conflict.history_epoch_id
        AND observed.inventory_kind=conflict.inventory_kind AND observed.request_id=conflict.request_id
        AND observed.authorization_generation=conflict.observed_revision
        AND conflict.details_json=json_object('observedAuthorizationGeneration',observed.authorization_generation,
          'priorAuthorizationGeneration',prior.authorization_generation)
        AND prior.rowid<observed.rowid AND prior.observed_at<=observed.observed_at
        AND conflict.created_at>=observed.observed_at
        AND (length(prior.authorization_generation)>length(observed.authorization_generation)
          OR length(prior.authorization_generation)=length(observed.authorization_generation)
            AND prior.authorization_generation>observed.authorization_generation)
        AND (SELECT count(*) FROM project_alpha_api_v2_inventory_receipts reference
          WHERE reference.source_id=observed.source_id AND reference.source_instance_id=observed.source_instance_id
            AND reference.application_id=observed.application_id AND reference.history_epoch_id=observed.history_epoch_id
            AND reference.request_id=conflict.prior_reference)=1
        AND (SELECT count(*) FROM project_alpha_api_v2_inventory_receipts reference
          WHERE reference.source_id=observed.source_id AND reference.source_instance_id=observed.source_instance_id
            AND reference.application_id=observed.application_id AND reference.history_epoch_id=observed.history_epoch_id
            AND reference.request_id=conflict.request_id)=1
        AND NOT EXISTS (SELECT 1 FROM project_alpha_api_v2_inventory_receipts same_surface
          WHERE same_surface.source_id=observed.source_id AND same_surface.source_instance_id=observed.source_instance_id
            AND same_surface.application_id=observed.application_id AND same_surface.history_epoch_id=observed.history_epoch_id
            AND same_surface.inventory_kind=observed.inventory_kind
            AND (same_surface.rowid<observed.rowid OR same_surface.observed_at<=observed.observed_at)
            AND (length(same_surface.authorization_generation)>length(observed.authorization_generation)
              OR length(same_surface.authorization_generation)=length(observed.authorization_generation)
                AND same_surface.authorization_generation>observed.authorization_generation)))`;
}
