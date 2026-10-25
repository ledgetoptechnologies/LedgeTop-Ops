import type { Env } from "../types";
import type { VerifiedClientPrincipal } from "./types";
import { readPortalProjectionSourceProof } from "../project-alpha-portal-authority";
import { sha256Hex } from "../security";
import { portalRootAccessAllowedSql } from "./workspace-access-policy";
import { activeClientAuthorityWorkspaceClaim } from "./client-authority-claim-read";
import { readNativeOperationsPortalHomes } from "./operations-native-recipient-read";
import { resolveNativePortalWorkspaceReadContext, type NativePortalReadContext } from "./workspace-v2";

type Principal = Pick<VerifiedClientPrincipal, "issuer" | "subject" | "email">;

export type DirectViewerWorkspaceContext = Readonly<{
  mode: "native" | "operations_native";
  sourceId: string;
  workspaceId: string;
  identityId: string;
  contextVersion: string;
  displayName: string;
  rootType: "organization" | "standalone_client";
  rootPublicId: string;
  sourceWorkspaceId: string;
  sourceAuthorityDigest: string;
  authorityId?: string;
  ownershipEpoch?: number;
  authorityOwnershipEpoch?: number;
  membershipExpiresAt?: string | null;
  nativeContext?: NativePortalReadContext;
}>;

type ClaimedWorkspaceRow = {
  id: string;
  project_alpha_source_id: string;
  legacy_account_id: string | null;
  display_name: string;
  root_type: "organization" | "standalone_client";
  root_public_id: string;
  active_generation_id: string;
  source_sequence: number;
  root_version: string;
  client_authority_id: string;
  projection_source_id: string;
  source_workspace_id: string;
  ownership_epoch: number;
  reconciliation_source_generation: string;
  reconciliation_source_sequence: number;
  reconciliation_snapshot_generation_id: string;
};

const bounded = (value: string, max: number) => value.length > 0 && value.length <= max
  && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);

function db(env: Pick<Env, "DELIVERY_DB">) { return env.DELIVERY_DB.withSession("first-primary"); }

async function claimedWorkspaceContext(env: Env, principal: Principal, workspaceId: string): Promise<DirectViewerWorkspaceContext | null> {
  if (env.CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED !== "true") return null;
  const database = db(env);
  const row = await database.prepare(`SELECT workspace.id,workspace.project_alpha_source_id,workspace.legacy_account_id,
      workspace.display_name,workspace.root_type,COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) root_public_id,
      checkpoint.active_generation_id,checkpoint.source_sequence,root.source_version root_version,
    claim.client_authority_id,claim.projection_source_id,claim.source_workspace_id,claim.ownership_epoch,
      claim.reconciliation_source_generation,claim.reconciliation_source_sequence,claim.reconciliation_snapshot_generation_id
    FROM portal_client_authority_workspace_claims claim
    JOIN portal_v2_workspaces workspace ON workspace.id=claim.workspace_id AND workspace.status='active'
    JOIN pa_portal_workspace_sources mapping ON mapping.workspace_id=workspace.id
      AND mapping.projection_source_id=claim.projection_source_id AND mapping.source_workspace_id=claim.source_workspace_id
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities root ON root.workspace_id=workspace.id AND root.generation_id=generation.id
      AND root.entity_type=workspace.root_type
      AND root.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) AND root.active=1
    WHERE claim.workspace_id=? AND claim.state='active'
      AND workspace.project_alpha_source_id=claim.projection_source_id
      AND workspace.legacy_account_id IS NULL AND ${portalRootAccessAllowedSql(env.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED === "true", "workspace")}`)
    .bind(workspaceId).first<ClaimedWorkspaceRow>();
  if (!row || !bounded(row.project_alpha_source_id, 78) || !bounded(row.root_public_id, 191)
    || !Number.isSafeInteger(row.ownership_epoch) || row.ownership_epoch < 1) return null;

  const [sourceProof, homes] = await Promise.all([
    readPortalProjectionSourceProof(env, database, row.project_alpha_source_id),
    readNativeOperationsPortalHomes(env.DELIVERY_DB, { issuer: principal.issuer, subject: principal.subject }, true),
  ]);
  if (!sourceProof || !homes) return null;
  const home = homes.find(candidate => candidate.workspaceId === workspaceId);
  if (!home || home.authorityId !== row.client_authority_id) return null;

  const identityId = `op_${await sha256Hex(JSON.stringify(["operations-native-direct-viewer-identity:v1", principal.issuer, principal.subject]))}`;
  const sourceAuthorityDigest = await sha256Hex(JSON.stringify(sourceProof));
  const contextVersion = await sha256Hex(JSON.stringify([
    "operations-native-direct-viewer-context:v1", principal.issuer, principal.subject, principal.email,
    row, home, sourceAuthorityDigest,
  ]));
  return Object.freeze({ mode: "operations_native", sourceId: row.project_alpha_source_id, workspaceId: row.id,
    identityId, contextVersion, displayName: row.display_name, rootType: row.root_type, rootPublicId: row.root_public_id,
    sourceWorkspaceId: row.source_workspace_id, sourceAuthorityDigest, authorityId: row.client_authority_id,
    ownershipEpoch: row.ownership_epoch, authorityOwnershipEpoch: home.ownershipEpoch,
    membershipExpiresAt: home.expiresAt });
}

/** Direct Viewer only: unclaimed workspaces retain their native PA context; a
 * claimed workspace can use only the current Operations recipient-home proof.
 * Legacy account mappings never enter this route. */
export async function resolveDirectViewerWorkspaceContext(env: Env, principal: Principal,
  workspaceId: string): Promise<DirectViewerWorkspaceContext | null> {
  if (await activeClientAuthorityWorkspaceClaim(env.DELIVERY_DB, workspaceId))
    return claimedWorkspaceContext(env, principal, workspaceId);
  const context = await resolveNativePortalWorkspaceReadContext(env, principal, workspaceId);
  if (!context) return null;
  const mapping = await db(env).prepare(`SELECT source_workspace_id FROM pa_portal_workspace_sources
    WHERE workspace_id=? AND projection_source_id=?`).bind(context.workspaceId, context.sourceId)
    .first<{ source_workspace_id: string }>();
  if (!mapping || !bounded(mapping.source_workspace_id, 200)) return null;
  const sourceAuthorityDigest = await sha256Hex(JSON.stringify(context.authority));
  return Object.freeze({ mode: "native", sourceId: context.sourceId, workspaceId: context.workspaceId,
    identityId: context.identityId, contextVersion: context.contextVersion, displayName: context.displayName,
    rootType: context.rootType, rootPublicId: context.rootPublicId, sourceWorkspaceId: mapping.source_workspace_id,
    sourceAuthorityDigest, nativeContext: context });
}
