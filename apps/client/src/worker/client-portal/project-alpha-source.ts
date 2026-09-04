import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";

/** Internal SQL aliases only. Source provenance is not an authorization grant. */
export function primaryAlphaReference(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("invalid-source-alias");
  return `${alias}.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}'`;
}

/** Local-only requests remain supported; no secondary record reaches the sole primary connector. */
export function localOrPrimaryAlphaReference(alias: string): string {
  return `(${alias}.project_alpha_source_id IS NULL OR ${primaryAlphaReference(alias)})`;
}

/** Existing local-only workspace wrappers remain usable, but are never Alpha proof. */
export function primaryWorkspaceAccount(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("invalid-source-alias");
  return `(${primaryAlphaReference(alias)} AND (${alias}.legacy_account_id IS NULL OR EXISTS(SELECT 1 FROM client_accounts source_account
    WHERE source_account.id=${alias}.legacy_account_id AND ${localOrPrimaryAlphaReference("source_account")}
    AND (NOT ${legacyBootstrapWorkspace(alias)} OR (source_account.status='active' AND (
      (${alias}.root_type='organization' AND source_account.project_alpha_organization_id=${alias}.pa_organization_public_id)
      OR (${alias}.root_type='standalone_client' AND source_account.project_alpha_organization_id IS NULL
        AND source_account.project_alpha_client_id=${alias}.pa_client_public_id)
    ))))))`;
}

/** Only the migration bootstrap derives authority from mutable legacy accounts. */
function legacyBootstrapWorkspace(alias: string): string {
  return `EXISTS(SELECT 1 FROM portal_v2_directory_checkpoints legacy_checkpoint
    JOIN portal_v2_directory_generations legacy_generation ON legacy_generation.id=legacy_checkpoint.active_generation_id
      AND legacy_generation.workspace_id=legacy_checkpoint.workspace_id
    WHERE legacy_checkpoint.workspace_id=${alias}.id AND legacy_checkpoint.source_sequence=0
      AND legacy_generation.id='legacy-generation-' || ${alias}.legacy_account_id
      AND legacy_generation.source_generation='legacy-backfill' AND legacy_generation.source_sequence=0
      AND legacy_generation.status='active' AND legacy_generation.complete=1)`;
}

/** Read defense for already-populated databases, including deployments before 0195. */
export function primaryLegacyWorkspaceMembership(workspaceAlias: string, membershipAlias: string): string {
  for (const alias of [workspaceAlias, membershipAlias]) {
    if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("invalid-source-alias");
  }
  return `(${membershipAlias}.source_type<>'legacy' OR NOT ${legacyBootstrapWorkspace(workspaceAlias)} OR EXISTS(
    SELECT 1 FROM client_account_members legacy_member
    JOIN client_identity_links legacy_identity ON legacy_identity.id=legacy_member.identity_id
      AND legacy_identity.account_id=legacy_member.account_id AND legacy_identity.revoked_at IS NULL
    WHERE legacy_member.account_id=${workspaceAlias}.legacy_account_id
      AND legacy_member.identity_id=${membershipAlias}.identity_id AND legacy_member.revoked_at IS NULL))`;
}
