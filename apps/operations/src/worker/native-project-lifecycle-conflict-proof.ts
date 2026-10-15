/** A stale binding is historical evidence, not a permanent deny after the exact
 * current lifecycle head has an acknowledged repair and a later clean inventory.
 * This is intentionally unavailable to ordinary/unactivated heads. No conflict
 * evidence is deleted, and every other conflict kind remains unresolved. */
export function nativeProjectLifecycleResolvedBindingStaleSql(
  head: "s" | "project", conflict: "conflict",
): string {
  const tuple = (alias: string) => `${alias}.source_id=${head}.source_id
    AND ${alias}.source_instance_id=${head}.source_instance_id
    AND ${alias}.application_id=${head}.application_id AND ${alias}.history_epoch_id=${head}.history_epoch_id`;
  // D1 limits expression depth to 100; balance the conjunction rather than
  // letting a long left-associated AND tree consume that budget.
  const conjunction = (clauses: string[]): string => clauses.length === 1 ? clauses[0]!
    : `(${conjunction(clauses.slice(0, Math.floor(clauses.length / 2)))} AND ${conjunction(clauses.slice(Math.floor(clauses.length / 2)))})`;
  const conditions = [
    `${conflict}.conflict_kind='binding_stale' AND ${conflict}.inventory_kind='project' AND ${conflict}.resource_type='project'`,
    `${tuple(conflict)} AND ${conflict}.external_id=${head}.external_project_id`,
    `${conflict}.project_alpha_public_id IS NULL AND ${conflict}.observed_revision IS NULL`,
    `${conflict}.prior_reference='pa-binding:'||${head}.external_project_id`,
    `json_type(${conflict}.details_json)='object' AND (SELECT count(*) FROM json_each(${conflict}.details_json))=1`,
    `json_type(${conflict}.details_json,'$.externalId')='text' AND json_extract(${conflict}.details_json,'$.externalId')=${head}.external_project_id`,
    `repaired_history.external_project_id=${head}.external_project_id AND repaired_history.version=${head}.current_version`,
    `${tuple("repaired_command")} AND repaired_command.external_project_id=${head}.external_project_id`,
    `repaired_command.project_alpha_public_id=${head}.project_alpha_public_id AND repaired_command.state='activated'`,
    `repaired_command.expected_local_version=${head}.current_version-1`,
    `repaired_child.state='acknowledged' AND repaired_activation.resulting_local_version=${head}.current_version`,
    `repaired_history.read_json=repaired_settlement.read_json`,
    `repaired_receipt.project_alpha_revision=${head}.pa_revision`,
    `repaired_child.expected_revision=${head}.pa_revision`,
    `repaired_child.expected_projection_sha256=${head}.canonical_projection_sha256`,
    `repaired_refresh.created_at>${conflict}.created_at`,
    `repaired_settlement.created_at>=repaired_refresh.created_at`,
    `repaired_activation.created_at>=repaired_settlement.created_at`,
    `repaired_inventory.observed_at>repaired_activation.created_at`,
    `repaired_observation.has_conflict=0 AND repaired_observation.resource_revision=${head}.pa_revision`,
    `repaired_observation.projection_sha256=${head}.canonical_projection_sha256`,
    `repaired_observation.lifecycle_status=${head}.lifecycle AND repaired_observation.archived=(${head}.archived=1)`,
    `json_extract(repaired_receipt.response_json,'$.accepted')=1`,
    `json_extract(repaired_refresh.response_json,'$.apiVersion')='2'`,
    `json_type(repaired_refresh.response_json,'$.replayed') IN ('true','false')`,
    `json_extract(repaired_child.body,'$.commandId')=repaired_child.command_id`,
    `json_extract(repaired_refresh.response_json,'$.sourceInstanceId')=${head}.source_instance_id`,
    `json_extract(repaired_refresh.response_json,'$.applicationId')=${head}.application_id`,
    `json_extract(repaired_refresh.response_json,'$.historyEpoch')=${head}.history_epoch_id`,
    `json_extract(repaired_refresh.response_json,'$.result.resource.id')=${head}.external_project_id`,
    `json_extract(repaired_refresh.response_json,'$.result.resource.publicId')=${head}.project_alpha_public_id`,
    `json_extract(repaired_refresh.response_json,'$.result.resource.revision')=${head}.pa_revision`,
    `json_extract(repaired_refresh.response_json,'$.result.resource.projectionSha256')=${head}.canonical_projection_sha256`,
    `json_extract(repaired_settlement.binding_json,'$.apiVersion')='2'`,
    `json_extract(repaired_settlement.binding_json,'$.sourceInstanceId')=${head}.source_instance_id`,
    `json_extract(repaired_settlement.binding_json,'$.applicationId')=${head}.application_id`,
    `json_extract(repaired_settlement.binding_json,'$.historyEpoch')=${head}.history_epoch_id`,
    `json_type(repaired_settlement.binding_json,'$.error') IS NULL`,
    `json_type(repaired_settlement.binding_json,'$.binding.createdAt')='text'`,
    `json_type(repaired_settlement.binding_json,'$.binding.updatedAt')='text'`,
    `json_type(repaired_settlement.binding_json,'$.binding.revision') IS NULL`,
    `json_extract(repaired_settlement.binding_json,'$.binding.externalId')=${head}.external_project_id`,
    `json_extract(repaired_settlement.binding_json,'$.binding.publicId')=${head}.project_alpha_public_id`,
    `json_extract(repaired_settlement.binding_json,'$.resource.revision')=${head}.pa_revision`,
    `json_extract(repaired_settlement.binding_json,'$.resource.projectionSha256')=${head}.canonical_projection_sha256`,
    `json_extract(repaired_settlement.binding_json,'$.resource.status')=${head}.lifecycle`,
    `json_extract(repaired_settlement.binding_json,'$.resource.archived')=(${head}.archived=1)`,
  ];
  return `(EXISTS (
    SELECT 1 FROM operations_shared_project_revisions repaired_history
    JOIN native_project_lifecycle_settlements repaired_settlement
      ON repaired_settlement.settlement_id=repaired_history.lifecycle_settlement_id
    JOIN native_project_lifecycle_commands repaired_command ON repaired_command.command_id=repaired_settlement.command_id
    JOIN native_project_lifecycle_receipts repaired_receipt ON repaired_receipt.command_id=repaired_command.command_id
    JOIN native_project_lifecycle_refreshes repaired_child ON repaired_child.command_id=repaired_settlement.refresh_command_id
      AND repaired_child.parent_command_id=repaired_command.command_id
    JOIN native_project_lifecycle_refresh_receipts repaired_refresh ON repaired_refresh.command_id=repaired_child.command_id
    JOIN native_project_lifecycle_activations repaired_activation ON repaired_activation.command_id=repaired_command.command_id
      AND repaired_activation.settlement_id=repaired_settlement.settlement_id
    JOIN project_alpha_api_v2_project_observations_current repaired_observation
      ON ${tuple("repaired_observation")}
      AND repaired_observation.external_project_id=${head}.external_project_id
      AND repaired_observation.project_alpha_public_id=${head}.project_alpha_public_id
    JOIN project_alpha_api_v2_inventory_receipts repaired_inventory
      ON ${tuple("repaired_inventory")} AND repaired_inventory.inventory_kind='project'
      AND repaired_inventory.request_id=repaired_observation.request_id
    WHERE ${conjunction(conditions)}
  ))`;
}
