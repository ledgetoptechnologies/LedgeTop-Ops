import type { Env } from "../types";
import type { VerifiedClientPrincipal } from "./types";

export interface OperationsPortalEnrollmentStatus {
  authorityId: string;
  ownershipEpoch: number;
  grantRevision: number;
  state: "active";
}

const principalPart = (value: string) => value.length >= 1 && value.length <= 512 && value.trim() === value;

/**
 * Reads only the Operations-owned, empty-scope enrollment ledger. This is not
 * a portal authorization decision: it never creates an identity or membership,
 * reads PA entitlements, or returns workspace/resource metadata.
 */
export async function readOperationsPortalEnrollmentStatus(
  env: Pick<Env, "DELIVERY_DB" | "CLIENT_PORTAL_AUTHORITY_V2_ENROLLMENT_STATUS_ENABLED">,
  principal: Pick<VerifiedClientPrincipal, "issuer" | "subject">,
): Promise<readonly OperationsPortalEnrollmentStatus[]> {
  if (env.CLIENT_PORTAL_AUTHORITY_V2_ENROLLMENT_STATUS_ENABLED !== "true"
    || !principalPart(principal.issuer) || !principalPart(principal.subject)) return [];
  const database = env.DELIVERY_DB.withSession?.("first-primary") ?? env.DELIVERY_DB;
  try {
    return await database.prepare(`SELECT binding.client_authority_id authority_id,
        workspace_head.ownership_epoch ownership_epoch,grant_head.grant_revision grant_revision
      FROM portal_operations_principal_grant_heads grant_head
      JOIN portal_operations_workspace_authority_heads workspace_head
        ON workspace_head.workspace_id=grant_head.workspace_id
          AND workspace_head.client_authority_id=grant_head.client_authority_id
          AND workspace_head.ownership_epoch=grant_head.ownership_epoch
          AND workspace_head.state='active'
      JOIN portal_client_authority_workspace_bindings binding
        ON binding.client_authority_id=workspace_head.client_authority_id
          AND binding.workspace_id=workspace_head.workspace_id
          AND binding.operation_id=workspace_head.binding_operation_id
          AND binding.state='inactive' AND binding.revision=1
      JOIN portal_v2_workspaces workspace ON workspace.id=workspace_head.workspace_id
        AND workspace.status='active'
      WHERE grant_head.issuer=? AND grant_head.subject=? AND grant_head.state='active'
      ORDER BY binding.client_authority_id LIMIT 101`)
      .bind(principal.issuer, principal.subject)
      .all<{ authority_id: string; ownership_epoch: number; grant_revision: number }>()
      .then(result => result.results.length > 100
        || new Set(result.results.map(row => row.authority_id)).size !== result.results.length ? [] : result.results.map(row => ({
        authorityId: row.authority_id, ownershipEpoch: row.ownership_epoch,
        grantRevision: row.grant_revision, state: "active" as const,
      })));
  } catch (error) {
    if (/no such table:\s*(?:main\.)?(?:portal_operations_(?:principal_grant_heads|workspace_authority_heads)|portal_client_authority_workspace_bindings|portal_v2_workspaces)\b/i
      .test(error instanceof Error ? error.message : String(error))) return [];
    throw error;
  }
}
