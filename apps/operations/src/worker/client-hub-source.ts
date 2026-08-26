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
