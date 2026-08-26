import type { ClientHubKind } from "./client-hub-directory";
import type { Env } from "./types";

export interface ClientHubWorkspaceLookup {
  key: string;
  kind: ClientHubKind;
  business_id: string | null;
  pa_public_id: string | null;
  workspace_id: string | null;
}
export interface ClientHubWorkspace {
  id: string;
  root_type: ClientHubKind;
  display_name: string;
  status: string;
  legacy_account_id: string | null;
  pa_organization_public_id: string | null;
  pa_client_public_id: string | null;
}
export interface ClientHubWorkspaceResolution {
  workspace: ClientHubWorkspace | null;
  status: "mapped" | "missing" | "pending" | "conflict";
}

// A legacy workspace's pa_* columns contain INTERNAL IDs. Only its explicit
// account bridge plus selected legacy generation prove that interpretation.
// Native generations instead use source-issued public IDs. Never mix them.
const businessCandidate = `wanted.business_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM portal_v2_directory_checkpoints checkpoint
  JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
    AND generation.workspace_id=checkpoint.workspace_id AND generation.source_sequence=checkpoint.source_sequence
    AND generation.status='active' AND generation.complete=1
  JOIN portal_v2_directory_entities entity ON entity.workspace_id=generation.workspace_id
    AND entity.generation_id=generation.id AND entity.entity_type=workspace.root_type
    AND entity.parent_public_id IS NULL AND entity.active=1
  WHERE checkpoint.workspace_id=workspace.id AND (
    (wanted.pa_public_id IS NOT NULL AND generation.source_generation<>'legacy-backfill'
      AND entity.public_id=wanted.pa_public_id AND entity.source_version<>'legacy-backfill'
      AND ((wanted.kind='organization' AND workspace.pa_organization_public_id=wanted.pa_public_id
          AND workspace.pa_client_public_id IS NULL)
        OR (wanted.kind='standalone_client' AND workspace.pa_client_public_id=wanted.pa_public_id
          AND workspace.pa_organization_public_id IS NULL)))
    OR (generation.source_generation='legacy-backfill' AND generation.source_sequence=0
      AND entity.source_version='legacy-backfill' AND entity.public_id=wanted.business_id
      AND EXISTS (SELECT 1 FROM client_accounts account WHERE account.id=workspace.legacy_account_id
        AND account.status='active' AND (
          (wanted.kind='organization' AND account.project_alpha_organization_id=wanted.business_id
            AND workspace.pa_organization_public_id=wanted.business_id AND workspace.pa_client_public_id IS NULL)
          OR (wanted.kind='standalone_client' AND account.project_alpha_client_id=wanted.business_id
            AND account.project_alpha_organization_id IS NULL AND workspace.pa_client_public_id=wanted.business_id
            AND workspace.pa_organization_public_id IS NULL))))))`;

const potentialBusinessCandidate = `wanted.business_id IS NOT NULL AND (
  (wanted.pa_public_id IS NOT NULL AND (
    (wanted.kind='organization' AND workspace.pa_organization_public_id=wanted.pa_public_id)
    OR (wanted.kind='standalone_client' AND workspace.pa_client_public_id=wanted.pa_public_id)))
  OR EXISTS (SELECT 1 FROM client_accounts account WHERE account.id=workspace.legacy_account_id
    AND account.status='active' AND (
      (wanted.kind='organization' AND account.project_alpha_organization_id=wanted.business_id
        AND workspace.pa_organization_public_id=wanted.business_id AND workspace.pa_client_public_id IS NULL)
      OR (wanted.kind='standalone_client' AND account.project_alpha_client_id=wanted.business_id
        AND account.project_alpha_organization_id IS NULL AND workspace.pa_client_public_id=wanted.business_id
        AND workspace.pa_organization_public_id IS NULL))))`;

const selectedPortalGeneration = `EXISTS (SELECT 1 FROM portal_v2_directory_checkpoints checkpoint
  JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
    AND generation.workspace_id=checkpoint.workspace_id AND generation.source_sequence=checkpoint.source_sequence
    AND generation.status='active' AND generation.complete=1
  JOIN portal_v2_directory_entities entity ON entity.workspace_id=generation.workspace_id
    AND entity.generation_id=generation.id AND entity.entity_type=workspace.root_type
    AND entity.parent_public_id IS NULL AND entity.active=1
  WHERE checkpoint.workspace_id=workspace.id
    AND entity.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id))`;

/** Resolve exact portal workspaces, not access grants. At most two candidates
 * per input leave D1; any ambiguity is reported instead of selecting a winner. */
export async function resolveClientHubWorkspaces(
  env: Pick<Env, "DELIVERY_DB">,
  lookups: readonly ClientHubWorkspaceLookup[],
): Promise<Map<string, ClientHubWorkspaceResolution>> {
  const result = new Map<string, ClientHubWorkspaceResolution>();
  for (const lookup of lookups) {
    if (result.has(lookup.key)) throw new Error("Duplicate Client Hub workspace lookup key");
    result.set(lookup.key, { workspace: null, status: "missing" });
  }
  const db = env.DELIVERY_DB.withSession("first-primary");
  for (let start = 0; start < lookups.length; start += 20) {
    const page = lookups.slice(start, start + 20);
    const rows = await db.prepare(`WITH wanted(lookup_key,kind,business_id,pa_public_id,workspace_id) AS (
      VALUES ${page.map(() => "(?,?,?,?,?)").join(",")}
    ), candidates AS (
      SELECT wanted.lookup_key,workspace.id,workspace.root_type,workspace.display_name,workspace.status,
        workspace.legacy_account_id,workspace.pa_organization_public_id,workspace.pa_client_public_id,
        CASE WHEN wanted.workspace_id IS NOT NULL THEN ${selectedPortalGeneration}
          ELSE (${businessCandidate}) END verified,
        ROW_NUMBER() OVER(PARTITION BY wanted.lookup_key ORDER BY workspace.id) candidate_number
      FROM wanted JOIN portal_v2_workspaces workspace ON workspace.root_type=wanted.kind AND workspace.status<>'closed'
      WHERE (wanted.workspace_id IS NOT NULL AND workspace.id=wanted.workspace_id)
        OR (wanted.workspace_id IS NULL AND ${potentialBusinessCandidate})
    ) SELECT * FROM candidates WHERE candidate_number<=2 ORDER BY lookup_key,candidate_number`)
      .bind(...page.flatMap(row => [row.key, row.kind, row.business_id, row.pa_public_id, row.workspace_id]))
      .all<ClientHubWorkspace & { lookup_key: string; candidate_number: number; verified: number }>();
    for (const row of rows.results) {
      if (row.candidate_number > 1) result.set(row.lookup_key, { workspace: null, status: "conflict" });
      else if (!row.verified) result.set(row.lookup_key, { workspace: null, status: "pending" });
      else {
        const { lookup_key, candidate_number: _candidateNumber, verified: _verified, ...workspace } = row;
        result.set(lookup_key, { workspace, status: "mapped" });
      }
    }
  }
  return result;
}

export async function resolveClientHubWorkspace(
  env: Pick<Env, "DELIVERY_DB">,
  lookup: ClientHubWorkspaceLookup,
): Promise<ClientHubWorkspaceResolution> {
  const result = await resolveClientHubWorkspaces(env, [lookup]);
  return result.get(lookup.key)!;
}
