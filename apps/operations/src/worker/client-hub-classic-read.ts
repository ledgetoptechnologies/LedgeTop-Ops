import type { Env } from "./types";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";

export type ClientHubClassicReadIdentity = Readonly<{
  sourceId: string; sourceInstanceId: string; applicationId: string; historyEpochId: string; origin: string;
}>;

/** Classic projections are display data, never a native binding. A durable
 * current inventory observation supplies the instance/epoch proof absent from
 * their old payloads. No clock TTL turns an otherwise current client invisible. */
export async function clientHubClassicReadIdentities(env: Pick<Env, "OPS_DB" | "PROJECT_ALPHA_API_V2_CONNECTIONS">): Promise<readonly ClientHubClassicReadIdentity[]> {
  const relations = await env.OPS_DB.prepare(`SELECT name FROM sqlite_master WHERE name IN (
    'project_alpha_api_v2_directory_observations_current','project_alpha_acquired_canonical_mappings',
    'project_alpha_existing_directory_binding_acquired_mapping_receipts','operations_directory_records',
    'project_alpha_directory_mappings')`).all<{ name: string }>();
  if (relations.results.length !== 5) return [];
  const sources = await env.OPS_DB.prepare(`SELECT DISTINCT source_id FROM project_alpha_api_v2_directory_observations_current ORDER BY source_id`).all<{ source_id: string }>();
  return sources.results.flatMap(({ source_id }) => {
    try {
      const configured = resolveProjectAlphaApiV2Connection(env, source_id);
      const connection = configured.connection;
      if (!configured.enabled || !connection.expectedSourceInstanceId || !connection.expectedApplicationId || !connection.expectedHistoryEpoch) return [];
      return [{ sourceId: source_id, sourceInstanceId: connection.expectedSourceInstanceId,
        applicationId: connection.expectedApplicationId, historyEpochId: connection.expectedHistoryEpoch, origin: connection.baseUrl }];
    } catch { return []; }
  });
}

export function clientHubClassicReadEligibleSql(table: "pa_clients" | "pa_organizations", alias: string,
  identities: readonly ClientHubClassicReadIdentity[]): string {
  if (!/^[a-z_]+$/.test(alias)) throw new Error("client-hub-invalid-classic-alias");
  if (!identities.length) return "0=1";
  // Every interpolated value has already passed the deployment connection
  // parser. Quote origins as SQL literals as host names may contain apostrophes.
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const publicId = (row: string) => `(CASE WHEN json_valid(${row}.payload_json) THEN CASE
    WHEN json_type(${row}.payload_json,'$.public_id')='text' THEN json_extract(${row}.payload_json,'$.public_id') END END)`;
  const value = publicId(alias);
  const resource = table === "pa_clients" ? "client" : "organization";
  const tuple = identities.map(identity => `(observation.source_id=${quote(identity.sourceId)}
    AND observation.source_instance_id=${quote(identity.sourceInstanceId)} AND observation.application_id=${quote(identity.applicationId)}
    AND observation.history_epoch_id=${quote(identity.historyEpochId)} AND connector.snapshot_origin=${quote(identity.origin)})`).join(" OR ");
  const claims = ["project_alpha_active_directory_mappings", "project_alpha_directory_mappings", "project_alpha_acquired_canonical_mappings",
    "project_alpha_existing_directory_binding_acquired_mapping_receipts"].map(claim => `NOT EXISTS (
      SELECT 1 FROM ${claim} classic_claim WHERE classic_claim.source_id=${alias}.projection_source_id
        AND classic_claim.resource_type='${resource}' AND (classic_claim.project_alpha_public_id=${value}
          OR classic_claim.external_id=${alias}.id ${claim === "project_alpha_active_directory_mappings" || claim === "project_alpha_acquired_canonical_mappings" ? `OR classic_claim.record_id=${alias}.id` : ""}))`).join(" AND ");
  return `(${alias}.active=1 AND length(trim(${alias}.name)) BETWEEN 1 AND 150
    AND length(${value})=32 AND ${value} NOT GLOB '*[^0-9a-f]*'
    AND (SELECT count(*) FROM ${table} classic_duplicate WHERE classic_duplicate.projection_source_id=${alias}.projection_source_id
      AND ${publicId("classic_duplicate")}=${value})=1
    AND EXISTS (SELECT 1 FROM project_alpha_api_v2_directory_observations_current observation
      JOIN pa_connectors connector ON connector.source_id=observation.source_id
      WHERE observation.source_id=${alias}.projection_source_id AND observation.resource_type='${resource}'
        AND observation.project_alpha_public_id=${value} AND observation.present=1 AND observation.last_action='upsert'
        AND observation.binding_external_id IS NULL AND observation.binding_status IS NULL AND observation.has_conflict=0
        AND connector.read_visible=1 AND connector.state<>'retired' AND (${tuple}))
    AND NOT EXISTS (SELECT 1 FROM operations_directory_records classic_record WHERE classic_record.record_id=${alias}.id)
    AND ${claims})`;
}

/** Materialize eligibility once in composite directory/search queries. Apart
 * from avoiding repeated work this stays below D1's expression-depth limit. */
export function clientHubClassicReadCtes(identities: readonly ClientHubClassicReadIdentity[]): string {
  return `classic_read_clients AS MATERIALIZED (SELECT classic_client.* FROM pa_clients classic_client
      WHERE ${clientHubClassicReadEligibleSql("pa_clients", "classic_client", identities)}),
    classic_read_organizations AS MATERIALIZED (SELECT classic_organization.* FROM pa_organizations classic_organization
      WHERE ${clientHubClassicReadEligibleSql("pa_organizations", "classic_organization", identities)})`;
}
