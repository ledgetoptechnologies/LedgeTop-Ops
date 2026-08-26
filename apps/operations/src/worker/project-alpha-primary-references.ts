import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import { isAlphaPublicId, sourcePublicIdExpression } from "./client-hub-source";
import type { Env } from "./types";

export interface PrimaryBusinessReferences {
  /** Trusted Delivery row provenance; never inferred from a matching scalar. */
  accountSourceId: string | null;
  projectSourceId?: string | null;
  clientId: string;
  organizationId?: string | null;
  projectId?: string | null;
  accountId?: string;
}
export type PrimaryReferenceProof = { available: true } | {
  available: false; reason: "unsupported_source" | "mapping_unavailable";
};

/** The sole outbound connector must never receive another producer's local
 * IDs. Exact current primary projection or the existing verified primary portal
 * generation supplies provenance; an email/name/raw scalar alone never does. */
export async function provePrimaryBusinessReferences(
  env: Pick<Env, "OPS_DB" | "DELIVERY_DB">, input: PrimaryBusinessReferences,
): Promise<PrimaryReferenceProof> {
  if (input.accountSourceId !== PRIMARY_ALPHA_SOURCE_ID ||
    (input.projectId != null && input.projectSourceId !== PRIMARY_ALPHA_SOURCE_ID))
    return { available: false, reason: "unsupported_source" };
  const references = [
    { table: "pa_clients", kind: "client", id: input.clientId },
    ...(input.organizationId ? [{ table: "pa_organizations", kind: "organization", id: input.organizationId }] : []),
    ...(input.projectId ? [{ table: "pa_projects", kind: "project", id: input.projectId }] : []),
  ];
  let allPrimary = true;
  for (const reference of references) {
    const rows = (await env.OPS_DB.withSession("first-primary").prepare(`SELECT source.id,source.projection_source_id,source.active
      FROM ${reference.table} source WHERE source.id=? OR
        (source.projection_source_id=? AND ?=1 AND ${sourcePublicIdExpression("source")}=?) LIMIT 2`)
      .bind(reference.id, PRIMARY_ALPHA_SOURCE_ID, isAlphaPublicId(reference.id) ? 1 : 0, reference.id)
      .all<{ id: string; projection_source_id: string; active: number }>()).results;
    if (rows.some(row => row.id === reference.id && row.projection_source_id !== PRIMARY_ALPHA_SOURCE_ID))
      return { available: false, reason: "unsupported_source" };
    if (rows.length > 1 || rows.some(row => row.active !== 1)) return { available: false, reason: "mapping_unavailable" };
    if (!rows.length) allPrimary = false;
  }
  if (allPrimary) return { available: true };
  if (!input.accountId) return { available: false, reason: "mapping_unavailable" };

  // Native portal public IDs need not yet be exported by the v1 business
  // snapshot. This compatibility proof uses the selected complete generation
  // and an explicit account bridge, never a same-name/same-email association.
  // Portal ingestion remains server-bound to primary in this release.
  const predicates = references.map(reference => `EXISTS (SELECT 1 FROM portal_v2_directory_entities entity
    WHERE entity.workspace_id=workspace.id AND entity.generation_id=generation.id
      AND entity.entity_type ${reference.kind === "client" ? "IN ('client','standalone_client')" : `='${reference.kind}'`}
      AND entity.public_id=? AND entity.active=1 AND entity.source_version<>'legacy-backfill')`);
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT workspace.id
    FROM portal_v2_workspaces workspace
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=workspace.id AND generation.source_sequence=checkpoint.source_sequence
      AND generation.status='active' AND generation.complete=1 AND generation.source_generation<>'legacy-backfill'
    JOIN client_accounts account ON account.id=? AND account.status='active'
      AND account.project_alpha_source_id='project-alpha:primary'
      AND account.project_alpha_client_id=? AND account.project_alpha_organization_id IS ?
    WHERE workspace.status='active' AND (workspace.legacy_account_id=account.id
      OR EXISTS (SELECT 1 FROM portal_v2_identity_eligibility_legacy_bridges bridge
        WHERE bridge.workspace_id=workspace.id AND bridge.legacy_account_id=account.id AND bridge.status='active' AND bridge.revoked_at IS NULL)
      OR EXISTS (SELECT 1 FROM portal_v2_legacy_member_bridges bridge
        WHERE bridge.workspace_id=workspace.id AND bridge.legacy_account_id=account.id AND bridge.status='active' AND bridge.revoked_at IS NULL))
      AND EXISTS (SELECT 1 FROM portal_v2_directory_entities root
        WHERE root.workspace_id=workspace.id AND root.generation_id=generation.id AND root.entity_type=workspace.root_type
          AND root.parent_public_id IS NULL AND root.active=1
          AND root.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id))
      AND ${predicates.join(" AND ")} LIMIT 2`)
    .bind(input.accountId, input.clientId, input.organizationId ?? null, ...references.map(reference => reference.id))
    .all<{ id: string }>();
  return rows.results.length === 1 ? { available: true } : { available: false, reason: "mapping_unavailable" };
}
