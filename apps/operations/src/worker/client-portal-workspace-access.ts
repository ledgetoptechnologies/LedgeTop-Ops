import { HTTPException } from "hono/http-exception";
import { createPortalIdentityDenial, revokePortalIdentityDenial } from "./client-portal-deny-policies";
import { requirePortalIdentityMutationTarget } from "./client-portal-identity-read";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import type { Env, StaffPrincipal } from "./types";

export interface WorkspaceAccessMutationInput {
  expectedContextVersion: string;
  expectedPrincipalContext: string;
  reasonCode: string;
}

export interface WorkspaceAccessReactivationInput extends WorkspaceAccessMutationInput {
  denialId: string;
  expectedUpdatedAt: string;
}

/** Pause access only in the exact Client Hub workspace. Project Alpha remains
 * the membership source of record; this overlays the existing live denial
 * authority instead of mutating or deleting the projected membership. */
export async function suspendClientPortalWorkspaceAccess(env: Env, actor: StaffPrincipal,
  context: ClientHubCollectionContext, principalPublicId: string, input: WorkspaceAccessMutationInput,
  idempotencyKey: string) {
  const target = await requirePortalIdentityMutationTarget(env, actor, context, principalPublicId,
    input.expectedContextVersion, input.expectedPrincipalContext);
  if (!target.actions.canSuspendWorkspaceAccess)
    throw new HTTPException(409, { message: target.workspaceAccessSuspended
      ? "Portal access is already paused for this client workspace"
      : "This portal login does not have current workspace access to pause" });
  const result = await createPortalIdentityDenial(env, actor, {
    identityId: target.identity_id!, workspaceId: target.workspace_id,
    scopeType: "workspace", scopePublicId: target.workspace_id,
    reasonCode: input.reasonCode, expiresAt: null,
  }, idempotencyKey);
  return { ...result, outcome: "workspace_access_suspended" as const };
}

/** Restore the one exact active workspace denial exposed by the reviewed
 * principal summary. A denial from another identity or workspace can never be
 * selected through this route. */
export async function reactivateClientPortalWorkspaceAccess(env: Env, actor: StaffPrincipal,
  context: ClientHubCollectionContext, principalPublicId: string, input: WorkspaceAccessReactivationInput,
  idempotencyKey: string) {
  const target = await requirePortalIdentityMutationTarget(env, actor, context, principalPublicId,
    input.expectedContextVersion, input.expectedPrincipalContext);
  if (!target.actions.canReactivateWorkspaceAccess || !target.removableWorkspaceDenialId
    || !target.removableWorkspaceDenialUpdatedAt)
    throw new HTTPException(409, { message: target.workspaceDenialCount > 1
      ? "Multiple workspace restrictions apply. Review the access audit before restoring access"
      : "Portal access is not paused for this client workspace" });
  if (input.denialId !== target.removableWorkspaceDenialId
    || input.expectedUpdatedAt !== target.removableWorkspaceDenialUpdatedAt)
    throw new HTTPException(409, { message: "Portal access changed. Refresh the client workspace and try again" });
  const result = await revokePortalIdentityDenial(env, actor, input.denialId, input.expectedUpdatedAt,
    input.reasonCode, idempotencyKey);
  return { ...result, outcome: "workspace_access_reactivated" as const };
}
