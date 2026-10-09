import { HTTPException } from "hono/http-exception";
import type { Env } from "./types";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";

/** Fixed SQL identifiers only. A source's ingestion state never decides whether
 * its already-projected business records are visible to authorized staff. */
export function projectAlphaReadVisibleSql(sourceColumn: string): string {
  if (!/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/.test(sourceColumn))
    throw new Error("invalid-project-alpha-source-column");
  return `(((${sourceColumn}='project-alpha:primary') AND NOT EXISTS (
    SELECT 1 FROM pa_connectors primary_connector WHERE primary_connector.source_id='project-alpha:primary'))
    OR EXISTS (SELECT 1 FROM pa_connectors visible_connector
      WHERE visible_connector.source_id=${sourceColumn} AND visible_connector.read_visible=1))`;
}

type NativeIdentity = Readonly<{ sourceId: string; sourceInstanceId: string; applicationId: string; historyEpochId: string }>;

/** A deployment-enabled API-v2 source may expose only its exact native mapping
 * when no legacy connector registration exists. Any connector row remains the
 * authoritative visibility decision, including an explicit hidden state. */
export function projectAlphaNativeMappingReadVisibleSql(sourceColumn: string, mappingAlias: string,
  identities: readonly NativeIdentity[]): string {
  if (!/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/.test(sourceColumn)
    || !/^[a-z_][a-z0-9_]*$/.test(mappingAlias)) throw new Error("invalid-project-alpha-source-column");
  if (!identities.every(identity => /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(identity.sourceId)
    && [identity.sourceInstanceId, identity.applicationId, identity.historyEpochId]
      .every(value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))))
    throw new Error("invalid-project-alpha-native-identity");
  const enabled = identities.length ? `(${identities.map(identity => `(${mappingAlias}.source_id='${identity.sourceId}'
    AND ${mappingAlias}.source_instance_id='${identity.sourceInstanceId}'
    AND ${mappingAlias}.application_id='${identity.applicationId}'
    AND ${mappingAlias}.history_epoch_id='${identity.historyEpochId}')`).join(" OR ")})` : "0=1";
  return `(EXISTS (SELECT 1 FROM pa_connectors native_visible_connector
    WHERE native_visible_connector.source_id=${sourceColumn} AND native_visible_connector.read_visible=1) OR (NOT EXISTS (
    SELECT 1 FROM pa_connectors native_visibility_connector WHERE native_visibility_connector.source_id=${sourceColumn})
    AND ${enabled}))`;
}

export async function readProjectAlphaVisibility(env: Pick<Env, "OPS_DB" | "PROJECT_ALPHA_API_V2_CONNECTIONS">, sourceId: string) {
  const result = await env.OPS_DB.withSession("first-primary").prepare(`
    SELECT state.read_revision,connector.source_id connector_source_id,
      CASE WHEN ?='delivery:local' THEN 1 WHEN connector.source_id IS NULL AND ?='project-alpha:primary' THEN 1
        ELSE COALESCE(connector.read_visible,0) END visible,
      CASE WHEN ?='delivery:local' THEN 'Local delivery' WHEN connector.source_id IS NULL AND ?='project-alpha:primary'
        THEN 'Project Alpha' ELSE connector.display_name END display_name
    FROM pa_connector_directory_state state LEFT JOIN pa_connectors connector ON connector.source_id=?
    WHERE state.id='directory'`).bind(sourceId, sourceId, sourceId, sourceId, sourceId)
    .first<{ read_revision: number; visible: number; display_name: string | null; connector_source_id: string | null }>();
  if (!result || !Number.isSafeInteger(result.read_revision) || result.read_revision < 1)
    throw new HTTPException(503, { message: "Client source visibility is not ready. Retry shortly." });
  return result;
}

export async function requireProjectAlphaReadVisibility(env: Pick<Env, "OPS_DB" | "PROJECT_ALPHA_API_V2_CONNECTIONS">, sourceId: string) {
  const result = await readProjectAlphaVisibility(env, sourceId);
  if (result.visible !== 1) throw new HTTPException(404, { message: "Client source is unavailable" });
  return result;
}

export async function requireProjectAlphaReadOrNativeMappingVisibility(
  env: Pick<Env, "OPS_DB" | "PROJECT_ALPHA_API_V2_CONNECTIONS">,
  sourceId: string, recordId: string, kind: "organization" | "standalone_client",
) {
  const relation = await env.OPS_DB.withSession("first-primary").prepare(`SELECT type FROM sqlite_master
    WHERE name='project_alpha_active_directory_mappings' AND type IN ('table','view') LIMIT 1`).first<{ type: string }>();
  // Compatibility for databases predating the native mapping relation. Once
  // the relation exists, it is authoritative and must never fall back to the
  // historical absent-primary-connector visibility shortcut.
  if (!relation) return requireProjectAlphaReadVisibility(env, sourceId);
  const columns = await env.OPS_DB.withSession("first-primary")
    .prepare("PRAGMA table_info('project_alpha_active_directory_mappings')").all<{ name: string }>();
  const present = new Set(columns.results.map(column => column.name));
  const required = ["source_id", "source_instance_id", "application_id", "history_epoch_id", "resource_type",
    "record_id", "external_id", "project_alpha_public_id", "mapping_kind", "provenance_id"];
  if (!required.every(column => present.has(column)))
    throw new HTTPException(503, { message: "Client source visibility is not ready. Retry shortly." });
  const visibility = await readProjectAlphaVisibility(env, sourceId);
  if (visibility.visible === 1 && visibility.connector_source_id !== null) return visibility;
  // A present connector is an explicit source-wide decision and always vetoes
  // the native fallback, even when the API-v2 connection is enabled.
  if (visibility.connector_source_id !== null) throw new HTTPException(404, { message: "Client source is unavailable" });
  let configured;
  try { configured = resolveProjectAlphaApiV2Connection(env, sourceId); }
  catch { throw new HTTPException(404, { message: "Client source is unavailable" }); }
  if (!configured.enabled || !configured.connection.expectedHistoryEpoch)
    throw new HTTPException(404, { message: "Client source is unavailable" });
  const resourceType = kind === "organization" ? "organization" : "client";
  const rows = await env.OPS_DB.withSession("first-primary").prepare(`SELECT mapping.record_id,mapping.external_id,
      mapping.project_alpha_public_id,mapping.mapping_kind,mapping.provenance_id,record.current_version
    FROM project_alpha_active_directory_mappings mapping
    JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind=mapping.resource_type
    ${kind === "standalone_client" ? `JOIN operations_directory_client_organizations relationship
      ON relationship.client_record_id=record.record_id AND relationship.organization_record_id IS NULL` : ""}
    WHERE mapping.source_id=? AND mapping.record_id=? AND mapping.resource_type=?
      AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
      AND length(mapping.project_alpha_public_id)=32 AND mapping.project_alpha_public_id NOT GLOB '*[^0-9a-f]*'
      AND (SELECT count(*) FROM project_alpha_active_directory_mappings candidate
        WHERE candidate.source_id=mapping.source_id AND candidate.source_instance_id=mapping.source_instance_id
          AND candidate.application_id=mapping.application_id AND candidate.history_epoch_id=mapping.history_epoch_id
          AND candidate.resource_type=mapping.resource_type
          AND (candidate.record_id=mapping.record_id OR candidate.external_id=mapping.external_id
            OR candidate.project_alpha_public_id=mapping.project_alpha_public_id))=1 LIMIT 2`)
    .bind(sourceId, recordId, resourceType, configured.connection.expectedSourceInstanceId,
      configured.connection.expectedApplicationId, configured.connection.expectedHistoryEpoch).all<{
        record_id: string; external_id: string; project_alpha_public_id: string; mapping_kind: string;
        provenance_id: string; current_version: number;
      }>();
  if (rows.results.length !== 1) throw new HTTPException(404, { message: "Client source is unavailable" });
  return { ...visibility, visible: 1, display_name: visibility.display_name ?? sourceId, nativeProof: {
    sourceId, sourceInstanceId: configured.connection.expectedSourceInstanceId,
    applicationId: configured.connection.expectedApplicationId, historyEpochId: configured.connection.expectedHistoryEpoch,
    origin: configured.connection.baseUrl, resourceType,
    mappingKind: rows.results[0]!.mapping_kind, provenanceId: rows.results[0]!.provenance_id,
    recordId: rows.results[0]!.record_id, externalId: rows.results[0]!.external_id,
    publicId: rows.results[0]!.project_alpha_public_id, recordVersion: rows.results[0]!.current_version,
  } };
}
