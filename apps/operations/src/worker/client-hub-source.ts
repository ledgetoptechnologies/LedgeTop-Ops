import type { Env } from "./types";
import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import { projectAlphaReadVisibleSql } from "./project-alpha-read-visibility";

export function isBusinessProjectionSource(value: string): value is `project-alpha:${string}` {
  return /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

export type ClientHubSourceKind = "organization" | "standalone_client";
export type ClientHubMappingStatus = "mapped" | "missing" | "invalid" | "ambiguous" | "not_applicable";
type SourceTable = "pa_organizations" | "pa_clients" | "pa_projects";

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
  id: string; display_name: string; organization_id: string | null; active: number;
  pa_public_id: string | null; mapping_status: ClientHubMappingStatus;
}
export type CanonicalClientHubSourceResolution =
  | { state: "absent" | "invalid"; root: null }
  | { state: "current"; root: ClientHubSourceRoot };

export async function resolveClientHubSourceRoot(
  env: Pick<Env, "OPS_DB">, kind: ClientHubSourceKind, internalId: string, sourceId: string = PRIMARY_ALPHA_SOURCE_ID,
): Promise<ClientHubSourceRoot | null> {
  const table = kind === "organization" ? "pa_organizations" : "pa_clients";
  const row = await env.OPS_DB.withSession("first-primary").prepare(`SELECT source.id,source.name display_name,
    ${kind === "organization" ? "NULL" : "source.organization_id"} organization_id,source.active,source.payload_json,
    ${validatedUniquePublicIdExpression(table, "source")} pa_public_id
    FROM ${table} source WHERE source.id=? AND source.projection_source_id=?
      AND ${projectAlphaReadVisibleSql("source.projection_source_id")}`).bind(internalId, sourceId)
    .first<Omit<ClientHubSourceRoot, "mapping_status"> & { payload_json: string }>();
  if (!row) return null;
  const parsed = readClientHubSourcePublicId(row.payload_json);
  return { id: row.id, display_name: row.display_name, organization_id: row.organization_id, active: row.active,
    pa_public_id: row.pa_public_id,
    mapping_status: parsed.pa_public_id && !row.pa_public_id ? "ambiguous" : parsed.mapping_status };
}

/** Resolve an explicitly activated API-v2 Directory mapping by its Operations
 * record ID. Inventory evidence alone is never sufficient, and any competing
 * current mapping for either side of the identity fails closed. */
export async function resolveCanonicalClientHubSourceRoot(
  env: Pick<Env, "OPS_DB">, kind: ClientHubSourceKind, recordId: string, sourceId: string,
): Promise<CanonicalClientHubSourceResolution> {
  const resourceType = kind === "organization" ? "organization" : "client";
  const current = (mapping: string, observation: string) => `
    ${observation}.source_id=${mapping}.source_id
    AND ${observation}.source_instance_id=${mapping}.source_instance_id
    AND ${observation}.application_id=${mapping}.application_id
    AND ${observation}.history_epoch_id=${mapping}.history_epoch_id
    AND ${observation}.resource_type=${mapping}.resource_type
    AND ${observation}.project_alpha_public_id=${mapping}.project_alpha_public_id
    AND ${observation}.present=1 AND ${observation}.last_action='upsert' AND ${observation}.has_conflict=0
    AND ${observation}.binding_external_id=${mapping}.external_id
    AND ${observation}.binding_status='active'
    AND ${observation}.binding_resource_revision=${observation}.resource_revision`;
  const db = env.OPS_DB.withSession("first-primary");
  const exists = await db.prepare(`SELECT count(*) count FROM project_alpha_active_directory_mappings
    WHERE source_id=? AND resource_type=? AND external_id=?`).bind(sourceId, resourceType, recordId).first<number>("count");
  if (!exists) return { state: "absent", root: null };
  const rows = await db.prepare(`SELECT mapping.external_id id,
    mapping.project_alpha_public_id pa_public_id,revision.profile_json,relationship.organization_record_id
    FROM project_alpha_active_directory_mappings mapping
    JOIN operations_directory_records record ON record.record_id=mapping.external_id AND record.record_kind=mapping.resource_type
    JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
    JOIN project_alpha_api_v2_directory_observations_current observation ON ${current("mapping", "observation")}
    JOIN pa_connectors connector ON connector.source_id=mapping.source_id AND connector.state='active' AND connector.read_visible=1
    LEFT JOIN operations_directory_client_organizations relationship
      ON relationship.client_record_id=mapping.external_id AND mapping.resource_type='client'
    WHERE mapping.source_id=? AND mapping.resource_type=? AND mapping.external_id=?
      AND (?='organization' OR relationship.organization_record_id IS NULL)
      AND 1=(SELECT count(*) FROM project_alpha_active_directory_mappings candidate
        JOIN project_alpha_api_v2_directory_observations_current candidate_observation
          ON ${current("candidate", "candidate_observation")}
        WHERE candidate.source_id=mapping.source_id AND candidate.resource_type=mapping.resource_type
          AND (candidate.external_id=mapping.external_id
            OR candidate.project_alpha_public_id=mapping.project_alpha_public_id))
    LIMIT 2`).bind(sourceId, resourceType, recordId, resourceType)
    .all<{ id: string; pa_public_id: string; profile_json: string; organization_record_id: string | null }>();
  if (rows.results.length !== 1) return { state: "invalid", root: null };
  const row = rows.results[0]!;
  let profile: unknown;
  try { profile = JSON.parse(row.profile_json); } catch { return { state: "invalid", root: null }; }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return { state: "invalid", root: null };
  const name = (profile as Record<string, unknown>).name;
  if (typeof name !== "string" || !name.trim() || Array.from(name).length > 150)
    return { state: "invalid", root: null };
  return { state: "current", root: { id: row.id, display_name: name,
    organization_id: kind === "organization" ? null : row.organization_record_id,
    active: 1, pa_public_id: row.pa_public_id, mapping_status: "mapped" } };
}
