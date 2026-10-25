import { NATIVE_PORTAL_TARGET_SCOPES_SQL } from "./native-portal-scopes";
import { projectAccessReadColumns } from "./project-access-read";
import { projectAccessCapacitySql } from "./project-access-capacity";
import type { Env } from "../types";
import type { NativePortalReadContext } from "./workspace-v2";

/** Internal observations, never a request capability or browser input. The
 * existing directory reader decides access; these exact bounded observations
 * only detect policy/identity/lineage changes at the later write boundary. */
export interface NativeRequestProjectReadWitness {
  termsAvailable: boolean;
  relationsEnabled: boolean;
  policyJSON: string;
  lineageJSON: string;
}

const MAX_WITNESS_BYTES = 256 * 1024;
const input = "(SELECT payload FROM native_request_read_input)";
const workspace = `json_extract(${input},'$.workspaceId')`;
const identity = `json_extract(${input},'$.identityId')`;

function policySQL(termsAvailable: boolean): string {
  return `WITH native_request_read_input(payload) AS (VALUES (?))
    SELECT json_object(
      'grants',json((SELECT json_group_array(json_array(id,capability,effect,scope_type,scope_public_id,
        entitlement_version,source_type,source_version,valid_from,expires_at,
        access_terms_id,terms_project_id,terms_kind,terms_live)) FROM (
          SELECT id,capability,effect,scope_type,scope_public_id,entitlement_version,
            source_type,source_version,valid_from,expires_at,${projectAccessReadColumns("entitlement", termsAvailable)}
          FROM portal_v2_entitlements entitlement
          WHERE workspace_id=${workspace} AND identity_id=${identity}
            AND capability IN ('workspace.view','directory.read','delivery.view')
            AND status='active' AND revoked_at IS NULL AND datetime(valid_from)<=datetime('now')
            AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
            AND ${projectAccessCapacitySql("entitlement", termsAvailable)} ORDER BY id LIMIT 201))),
      'identity',json((SELECT json_group_array(json_array(id,issuer,subject,verified_email,status,revoked_at))
        FROM (SELECT id,issuer,subject,verified_email,status,revoked_at FROM portal_v2_identities
          WHERE id=${identity} ORDER BY id LIMIT 2))),
      'blocks',json((SELECT json_group_array(json_array(id,match_type,issuer,subject,normalized_email,valid_from,expires_at))
        FROM (SELECT block.id,block.match_type,block.issuer,block.subject,block.normalized_email,block.valid_from,block.expires_at
          FROM portal_v2_identity_eligibility_blocks block JOIN portal_v2_identities person ON person.id=${identity}
          WHERE block.status='active' AND datetime(block.valid_from)<=datetime('now')
            AND (block.expires_at IS NULL OR datetime(block.expires_at)>datetime('now'))
            AND ((block.match_type='issuer_subject' AND block.issuer=person.issuer AND block.subject=person.subject)
              OR (block.match_type='email' AND lower(trim(block.normalized_email))=lower(trim(person.verified_email))))
          ORDER BY block.id LIMIT 201)))) snapshot`;
}

/** Preserve the shared reader's exact recursive query. One bound JSON tuple
 * replaces its numbered parameters so embedding it in another guard cannot
 * accidentally reuse the caller's ?1.. ?5 bindings. */
function lineageSQL(): string {
  const query = NATIVE_PORTAL_TARGET_SCOPES_SQL.replace(/\?([1-5])\b/g, (_match, index: string) =>
    `(SELECT json_extract(payload,'$[${Number(index) - 1}]') FROM native_request_scope_input)`);
  return `WITH native_request_scope_input(payload) AS (VALUES (?))
    SELECT json_group_array(json_array(target_type,target_id,entity_type,public_id,parent_public_id,
      source_version,depth,display_name,binding_version,retained)) snapshot FROM (${query})`;
}

function lineageInput(workspaceId: string, generationId: string, projectPublicId: string, relations: boolean): string {
  return JSON.stringify([JSON.stringify([{ scopeType: "project", publicId: projectPublicId }]),
    workspaceId, generationId, relations ? 1 : 0, 66]);
}

export async function readNativeRequestProjectReadWitness(
  env: Env, context: NativePortalReadContext, projectPublicId: string,
): Promise<NativeRequestProjectReadWitness | null> {
  const termsAvailable = context.projectAccessTermsAvailable === true;
  const relationsEnabled = env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED === "true";
  const db = env.DELIVERY_DB.withSession("first-primary");
  const policyJSON = await db.prepare(policySQL(termsAvailable))
    .bind(JSON.stringify({ workspaceId: context.workspaceId, identityId: context.identityId })).first<string>("snapshot");
  const lineageJSON = await db.prepare(lineageSQL())
    .bind(lineageInput(context.workspaceId, context.generationId, projectPublicId, relationsEnabled)).first<string>("snapshot");
  if (typeof policyJSON !== "string" || typeof lineageJSON !== "string"
    || policyJSON.length > MAX_WITNESS_BYTES || lineageJSON.length > MAX_WITNESS_BYTES) return null;
  const policy = JSON.parse(policyJSON) as { grants: unknown[]; identity: unknown[]; blocks: unknown[] };
  const lineage = JSON.parse(lineageJSON) as unknown[];
  if (!Array.isArray(policy.grants) || policy.grants.length > 200
    || !Array.isArray(policy.identity) || policy.identity.length !== 1
    || !Array.isArray(policy.blocks) || policy.blocks.length > 200
    || !Array.isArray(lineage) || !lineage.length || lineage.length > 65) return null;
  return Object.freeze({ termsAvailable, relationsEnabled, policyJSON, lineageJSON });
}

export function nativeRequestProjectReadGuardSql(proof: {
  workspaceId: string; identityId: string; generationId: string; projectPublicId: string | null;
  projectRead?: NativeRequestProjectReadWitness;
}): { sql: string; bindings: unknown[] } {
  if (proof.projectPublicId === null) return { sql: "1=1", bindings: [] };
  const witness = proof.projectRead;
  if (!witness) return { sql: "0=1", bindings: [] };
  return {
    sql: `((${policySQL(witness.termsAvailable)})=? AND (${lineageSQL()})=?)`,
    bindings: [JSON.stringify({ workspaceId: proof.workspaceId, identityId: proof.identityId }), witness.policyJSON,
      lineageInput(proof.workspaceId, proof.generationId, proof.projectPublicId, witness.relationsEnabled), witness.lineageJSON],
  };
}
