import type { Env } from "./types";
import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import { projectAlphaReadVisibleSql } from "./project-alpha-read-visibility";
import { HTTPException } from "hono/http-exception";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";

export function isBusinessProjectionSource(value: string): value is `project-alpha:${string}` {
  return /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

export type ClientHubSourceKind = "organization" | "standalone_client";
export type ClientHubMappingStatus = "mapped" | "missing" | "invalid" | "ambiguous" | "not_applicable";
export function clientHubAlphaInternalId(root: { source_id: string; root_namespace: string; pa_internal_id?: string | null }, provenId?: string | null): string {
  const id = provenId ?? root.pa_internal_id;
  if (root.root_namespace !== "business" || !root.source_id.startsWith("project-alpha:")
    || typeof id !== "string" || !id)
    throw new HTTPException(409, { message: "This client's Project Alpha identity is unresolved; refresh before continuing" });
  return id;
}
type SourceTable = "pa_organizations" | "pa_clients" | "pa_projects";
const ACTIVE_MAPPING_COLUMNS = ["source_id", "resource_type", "record_id", "external_id", "project_alpha_public_id",
  "source_instance_id", "application_id", "history_epoch_id"] as const;

/** 0125 introduced this relation as a view and 0170 added record_id. Some test
 * and recovery databases materialize the same contract as a table, so inspect
 * sqlite_master rather than assuming either storage type. An existing but
 * incomplete relation is unsafe and must not silently fall back to payloads. */
export async function hasClientHubActiveDirectoryMappings(database: Pick<D1Database, "prepare">): Promise<boolean> {
  const relation = await database.prepare(`SELECT type FROM sqlite_master
    WHERE name='project_alpha_active_directory_mappings' AND type IN ('table','view') LIMIT 1`)
    .first<{ type: "table" | "view" }>();
  if (!relation) return false;
  const columns = await database.prepare("PRAGMA table_info('project_alpha_active_directory_mappings')")
    .all<{ name: string }>();
  const present = new Set(columns.results.map(column => column.name));
  if (!ACTIVE_MAPPING_COLUMNS.every(column => present.has(column)))
    throw new Error("client-hub-active-directory-mapping-schema-invalid");
  return true;
}

export type ClientHubActiveDirectoryIdentity = Readonly<{
  sourceId: string; sourceInstanceId: string; applicationId: string; historyEpochId: string;
}>;

/** Resolve sources represented by the active mapping relation through the
 * deployment-owned API-v2 parser. Once that relation exists, missing, malformed,
 * removed, or disabled configuration is not a reason to trust a historical
 * mapping. One retired source must not make unrelated Client Hub namespaces
 * unavailable, so an unresolvable source contributes no trusted identity. */
export async function clientHubActiveDirectoryIdentities(
  env: Pick<Env, "OPS_DB" | "PROJECT_ALPHA_API_V2_CONNECTIONS">,
): Promise<readonly ClientHubActiveDirectoryIdentity[] | null> {
  if (!(await hasClientHubActiveDirectoryMappings(env.OPS_DB))) return null;
  const sources = await env.OPS_DB.prepare("SELECT DISTINCT source_id FROM project_alpha_active_directory_mappings ORDER BY source_id")
    .all<{ source_id: string }>();
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

/** Values are safe SQL literals because the existing connection parser admits
 * only canonical source IDs and UUIDs. Keeping this as one predicate avoids
 * subtly different tuple checks in the directory and index queries. */
export function clientHubActiveDirectoryIdentitySql(
  alias: string, identities: readonly ClientHubActiveDirectoryIdentity[],
): string {
  if (!/^[a-z_]+$/.test(alias)) throw new Error("client-hub-invalid-mapping-alias");
  if (!identities.length) return "0=1";
  return `(${identities.map(identity => `(${alias}.source_id='${identity.sourceId}'
    AND ${alias}.source_instance_id='${identity.sourceInstanceId}'
    AND ${alias}.application_id='${identity.applicationId}'
    AND ${alias}.history_epoch_id='${identity.historyEpochId}')`).join(" OR ")})`;
}

// Alpha migration 0062 creates immutable, lowercase 32-hex public identifiers.
// Do not coerce an internal ID, trim malformed values, or invent a new identity.
export function isAlphaPublicId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

export function readClientHubSourcePublicId(payload: string): {
  pa_public_id: string | null; mapping_status: ClientHubMappingStatus;
} {
  let record: unknown;
  try { record = JSON.parse(payload); } catch { return { pa_public_id: null, mapping_status: "invalid" }; }
  if (!record || typeof record !== "object" || Array.isArray(record))
    return { pa_public_id: null, mapping_status: "invalid" };
  const candidate = (record as Record<string, unknown>).public_id;
  if (candidate === undefined || candidate === null) return { pa_public_id: null, mapping_status: "missing" };
  return isAlphaPublicId(candidate) ? { pa_public_id: candidate, mapping_status: "mapped" }
    : { pa_public_id: null, mapping_status: "invalid" };
}

// Callers supply fixed SQL aliases/table names, never request input.
export function sourcePublicIdExpression(alias: string): string {
  if (!/^[a-z_]+$/.test(alias)) throw new Error("client-hub-invalid-source-alias");
  return `(CASE WHEN json_valid(${alias}.payload_json) THEN
    CASE WHEN json_type(${alias}.payload_json,'$.public_id')='text'
    THEN json_extract(${alias}.payload_json,'$.public_id') END END)`;
}

export function validatedUniquePublicIdExpression(table: SourceTable, alias: string): string {
  const value = sourcePublicIdExpression(alias);
  const other = sourcePublicIdExpression("mapping_candidate");
  return `(CASE WHEN length(${value})=32 AND ${value} NOT GLOB '*[^0-9a-f]*'
    AND (SELECT count(*) FROM ${table} mapping_candidate WHERE ${other}=${value}
      AND mapping_candidate.projection_source_id=${alias}.projection_source_id)=1 THEN ${value} END)`;
}

export interface ClientHubSourceRoot {
  /** Canonical Operations directory identity used for Client Hub routes. */
  id: string;
  display_name: string; organization_id: string | null; active: number;
  /** Project Alpha's internal row ID; never use this as the Operations route ID. */
  pa_internal_id: string;
  pa_public_id: string | null; mapping_status: ClientHubMappingStatus;
}

export async function resolveClientHubSourceRoot(
  env: Pick<Env, "OPS_DB" | "PROJECT_ALPHA_API_V2_CONNECTIONS">, kind: ClientHubSourceKind, internalId: string, sourceId: string = PRIMARY_ALPHA_SOURCE_ID,
): Promise<ClientHubSourceRoot | null> {
  const table = kind === "organization" ? "pa_organizations" : "pa_clients";
  const activeMappings = await hasClientHubActiveDirectoryMappings(env.OPS_DB);
  if (activeMappings) {
    const identities = await clientHubActiveDirectoryIdentities(env);
    const currentMapping = clientHubActiveDirectoryIdentitySql("mapping", identities ?? []);
    const resourceType = kind === "organization" ? "organization" : "client";
    return env.OPS_DB.withSession("first-primary").prepare(`SELECT mapping.record_id id,mapping.external_id pa_internal_id,
      json_extract(revision.profile_json,'$.name') display_name,NULL organization_id,1 active,
      mapping.project_alpha_public_id pa_public_id,'mapped' mapping_status
      FROM project_alpha_active_directory_mappings mapping
      JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind=mapping.resource_type
      JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
      ${kind === "organization" ? "" : `JOIN operations_directory_client_organizations relationship
        ON relationship.client_record_id=record.record_id AND relationship.organization_record_id IS NULL`}
      WHERE mapping.record_id=? AND mapping.source_id=? AND mapping.resource_type='${resourceType}'
        AND ${currentMapping} AND ${projectAlphaReadVisibleSql("mapping.source_id")}
        AND json_valid(revision.profile_json) AND json_type(revision.profile_json,'$.name')='text'
        AND length(trim(json_extract(revision.profile_json,'$.name'))) BETWEEN 1 AND 150
        AND length(mapping.project_alpha_public_id)=32 AND mapping.project_alpha_public_id NOT GLOB '*[^0-9a-f]*'
        AND (SELECT count(*) FROM project_alpha_active_directory_mappings candidate
          WHERE candidate.source_id=mapping.source_id AND candidate.source_instance_id=mapping.source_instance_id
            AND candidate.application_id=mapping.application_id AND candidate.history_epoch_id=mapping.history_epoch_id
            AND candidate.resource_type=mapping.resource_type
            AND (candidate.record_id=mapping.record_id OR candidate.external_id=mapping.external_id
              OR candidate.project_alpha_public_id=mapping.project_alpha_public_id))=1
      LIMIT 1`).bind(internalId, sourceId).first<ClientHubSourceRoot>();
  }
  const row = await env.OPS_DB.withSession("first-primary").prepare(`SELECT source.id,source.id pa_internal_id,source.name display_name,
    ${kind === "organization" ? "NULL" : "source.organization_id"} organization_id,source.active,source.payload_json,
    ${validatedUniquePublicIdExpression(table, "source")} pa_public_id
    FROM ${table} source WHERE source.id=? AND source.projection_source_id=?
      AND ${projectAlphaReadVisibleSql("source.projection_source_id")}`).bind(internalId, sourceId)
    .first<Omit<ClientHubSourceRoot, "mapping_status"> & { payload_json: string }>();
  if (!row) return null;
  const parsed = readClientHubSourcePublicId(row.payload_json);
  return { id: row.id, pa_internal_id: row.pa_internal_id, display_name: row.display_name, organization_id: row.organization_id, active: row.active,
    pa_public_id: row.pa_public_id,
    mapping_status: parsed.pa_public_id && !row.pa_public_id ? "ambiguous" : parsed.mapping_status };
}

/** Resolve a Project Alpha-local identity without confusing it with the
 * Operations record ID used by Client Hub routes. Active mappings are the only
 * accepted bridge; when the mapping view is not installed, preserve the
 * existing legacy source-ID behavior. */
export async function resolveClientHubSourceRootByAlphaIdentity(
  env: Pick<Env, "OPS_DB" | "PROJECT_ALPHA_API_V2_CONNECTIONS">, kind: ClientHubSourceKind, paInternalId: string,
  sourceId: string = PRIMARY_ALPHA_SOURCE_ID, paPublicId?: string | null,
): Promise<ClientHubSourceRoot | null> {
  if (!(await hasClientHubActiveDirectoryMappings(env.OPS_DB)))
    return resolveClientHubSourceRoot(env, kind, paInternalId, sourceId);
  const identities = await clientHubActiveDirectoryIdentities(env);
  const currentMapping = clientHubActiveDirectoryIdentitySql("mapping", identities ?? []);
  const resourceType = kind === "organization" ? "organization" : "client";
  const clauses = ["mapping.external_id=?"];
  const values: string[] = [sourceId, resourceType, paInternalId];
  if (paPublicId) { clauses.push("mapping.project_alpha_public_id=?"); values.push(paPublicId); }
  const mappings = await env.OPS_DB.withSession("first-primary").prepare(`SELECT mapping.record_id
    FROM project_alpha_active_directory_mappings mapping
    JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind=mapping.resource_type
    WHERE mapping.source_id=? AND mapping.resource_type=? AND ${currentMapping} AND (${clauses.join(" OR ")})
      AND (SELECT count(*) FROM project_alpha_active_directory_mappings candidate
        WHERE candidate.source_id=mapping.source_id AND candidate.source_instance_id=mapping.source_instance_id
          AND candidate.application_id=mapping.application_id AND candidate.history_epoch_id=mapping.history_epoch_id
          AND candidate.resource_type=mapping.resource_type
          AND (candidate.record_id=mapping.record_id OR candidate.external_id=mapping.external_id
            OR candidate.project_alpha_public_id=mapping.project_alpha_public_id))=1
    ORDER BY mapping.record_id LIMIT 2`).bind(...values).all<{ record_id: string }>();
  if (mappings.results.length !== 1) return null;
  const root = await resolveClientHubSourceRoot(env, kind, mappings.results[0]!.record_id, sourceId);
  return root?.pa_internal_id === paInternalId && (!paPublicId || root.pa_public_id === paPublicId) ? root : null;
}

/** Resolve a current Project Alpha public identity to its Operations root.
 * Native API-v2 enrollments may have no legacy `pa_organizations`/`pa_clients`
 * mirror, so the active mapping relation is authoritative whenever installed.
 * Ambiguous, stale, disabled, malformed, or wrong-type mappings fail closed. */
export async function resolveClientHubSourceRootByAlphaPublicId(
  env: Pick<Env, "OPS_DB" | "PROJECT_ALPHA_API_V2_CONNECTIONS">, kind: ClientHubSourceKind,
  sourceId: string, paPublicId: string,
): Promise<ClientHubSourceRoot | null> {
  if (!isAlphaPublicId(paPublicId) || !isBusinessProjectionSource(sourceId)) return null;
  if (!(await hasClientHubActiveDirectoryMappings(env.OPS_DB))) {
    const table = kind === "organization" ? "pa_organizations" : "pa_clients";
    const rows = await env.OPS_DB.withSession("first-primary").prepare(`SELECT source.id
      FROM ${table} source WHERE source.active=1 AND source.projection_source_id=?
        ${kind === "standalone_client" ? "AND source.organization_id IS NULL" : ""}
        AND ${validatedUniquePublicIdExpression(table, "source")}=? LIMIT 2`).bind(sourceId, paPublicId).all<{ id: string }>();
    if (rows.results.length !== 1) return null;
    return resolveClientHubSourceRootByAlphaIdentity(env, kind, rows.results[0]!.id, sourceId, paPublicId);
  }

  const identities = await clientHubActiveDirectoryIdentities(env);
  const currentMapping = clientHubActiveDirectoryIdentitySql("mapping", identities ?? []);
  const resourceType = kind === "organization" ? "organization" : "client";
  const rows = await env.OPS_DB.withSession("first-primary").prepare(`SELECT mapping.external_id
    FROM project_alpha_active_directory_mappings mapping
    JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind=mapping.resource_type
    JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
    ${kind === "standalone_client" ? `JOIN operations_directory_client_organizations relationship
      ON relationship.client_record_id=record.record_id AND relationship.organization_record_id IS NULL` : ""}
    WHERE mapping.source_id=? AND mapping.resource_type=? AND ${currentMapping}
      AND mapping.project_alpha_public_id=? AND length(mapping.external_id)>0
      AND length(mapping.project_alpha_public_id)=32 AND mapping.project_alpha_public_id NOT GLOB '*[^0-9a-f]*'
      AND json_valid(revision.profile_json) AND json_type(revision.profile_json,'$.name')='text'
      AND length(trim(json_extract(revision.profile_json,'$.name'))) BETWEEN 1 AND 150
      AND ${projectAlphaReadVisibleSql("mapping.source_id")}
      AND (SELECT count(*) FROM project_alpha_active_directory_mappings candidate
        WHERE candidate.source_id=mapping.source_id AND candidate.source_instance_id=mapping.source_instance_id
          AND candidate.application_id=mapping.application_id AND candidate.history_epoch_id=mapping.history_epoch_id
          AND candidate.resource_type=mapping.resource_type
          AND (candidate.record_id=mapping.record_id OR candidate.external_id=mapping.external_id
            OR candidate.project_alpha_public_id=mapping.project_alpha_public_id))=1
    LIMIT 2`).bind(sourceId, resourceType, paPublicId).all<{ external_id: string }>();
  if (rows.results.length !== 1) return null;
  return resolveClientHubSourceRootByAlphaIdentity(env, kind, rows.results[0]!.external_id, sourceId, paPublicId);
}
