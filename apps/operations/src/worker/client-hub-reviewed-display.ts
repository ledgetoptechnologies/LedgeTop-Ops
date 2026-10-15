import { clientHubActiveDirectoryIdentitySql, type ClientHubActiveDirectoryIdentity } from "./client-hub-source";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import type { Env } from "./types";

/** Resolve only the bounded set of sources that can contribute review rows.
 * The durable row supplies a source key, never configuration authority. */
export async function clientHubReviewedDisplayIdentities(
  env: Pick<Env, "OPS_DB" | "PROJECT_ALPHA_API_V2_CONNECTIONS">,
): Promise<readonly ClientHubActiveDirectoryIdentity[]> {
  const sources = await env.OPS_DB.withSession("first-primary").prepare(`SELECT DISTINCT source_id
    FROM project_alpha_reviewed_standalone_client_displays ORDER BY source_id LIMIT 101`)
    .all<{ source_id: string }>();
  if (sources.results.length > 100) throw new Error("client-hub-reviewed-display-source-limit");
  return sources.results.flatMap(({ source_id }) => {
    try {
      const configured = resolveProjectAlphaApiV2Connection(env, source_id);
      const sourceInstanceId = configured.connection.expectedSourceInstanceId;
      const applicationId = configured.connection.expectedApplicationId;
      const historyEpochId = configured.connection.expectedHistoryEpoch;
      if (!configured.enabled || typeof sourceInstanceId !== "string" || typeof applicationId !== "string"
        || typeof historyEpochId !== "string") return [];
      return [{ sourceId: configured.sourceId, sourceInstanceId, applicationId, historyEpochId }];
    } catch { return []; }
  });
}

/** A reviewed display is durable evidence, not durable read authority. */
export function clientHubReviewedDisplayLiveSql(
  alias: string,
  identities: readonly ClientHubActiveDirectoryIdentity[],
): string {
  if (!/^[a-z_]+$/.test(alias)) throw new Error("client-hub-invalid-reviewed-display-alias");
  return `(${alias}.state='display_only' AND ${clientHubActiveDirectoryIdentitySql(alias, identities)}
    AND EXISTS(SELECT 1 FROM project_alpha_api_v2_directory_observations_current observation
      JOIN project_alpha_api_v2_inventory_receipts inventory
        ON inventory.source_id=observation.source_id AND inventory.source_instance_id=observation.source_instance_id
       AND inventory.application_id=observation.application_id AND inventory.history_epoch_id=observation.history_epoch_id
       AND inventory.inventory_kind='directory' AND inventory.request_id=observation.request_id
      WHERE observation.source_id=${alias}.source_id AND observation.source_instance_id=${alias}.source_instance_id
        AND observation.application_id=${alias}.application_id AND observation.history_epoch_id=${alias}.history_epoch_id
        AND observation.resource_type='client' AND observation.project_alpha_public_id=${alias}.project_alpha_public_id
        AND observation.present=1 AND observation.last_action='upsert' AND observation.has_conflict=0
        AND observation.resource_revision=${alias}.project_alpha_revision
        AND observation.binding_external_id=${alias}.external_id AND observation.binding_status='active'
        AND observation.binding_resource_revision=observation.resource_revision
        AND observation.request_id=${alias}.inventory_request_id
        AND inventory.authorization_generation=${alias}.authorization_generation
        AND inventory.page_sha256=${alias}.inventory_page_sha256)
    AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_conflicts conflict
      WHERE conflict.source_id=${alias}.source_id
        AND conflict.source_instance_id=${alias}.source_instance_id
        AND conflict.application_id=${alias}.application_id
        AND conflict.history_epoch_id=${alias}.history_epoch_id
        AND conflict.inventory_kind='directory'
        AND (conflict.resource_type='source' OR (conflict.resource_type='client'
          AND (conflict.project_alpha_public_id=${alias}.project_alpha_public_id OR conflict.external_id=${alias}.external_id))))
    AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_mappings mapping
      WHERE mapping.source_id=${alias}.source_id AND mapping.source_instance_id=${alias}.source_instance_id
        AND mapping.application_id=${alias}.application_id AND mapping.resource_type='client'
        AND (mapping.external_id=${alias}.external_id OR mapping.project_alpha_public_id=${alias}.project_alpha_public_id))
    AND NOT EXISTS(SELECT 1 FROM project_alpha_acquired_canonical_mappings mapping
      WHERE mapping.source_id=${alias}.source_id AND mapping.source_instance_id=${alias}.source_instance_id
        AND mapping.application_id=${alias}.application_id AND mapping.resource_type='client'
        AND (mapping.record_id=${alias}.record_id OR mapping.external_id=${alias}.external_id
          OR mapping.project_alpha_public_id=${alias}.project_alpha_public_id)))`;
}
