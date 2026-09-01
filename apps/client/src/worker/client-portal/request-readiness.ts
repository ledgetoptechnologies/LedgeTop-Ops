import { HTTPException } from "hono/http-exception";
import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import { localOrPrimaryAlphaReference } from "./project-alpha-source";
import type { Env } from "../types";
import type { ClientPortalSession, VerifiedClientPrincipal } from "./types";
import {
  portalHierarchyV2Enabled,
  readEffectiveWorkspaceRequestProof,
  type EffectivePortalWorkspaceContext,
} from "./workspace-v2";
import { readServiceAssignmentPolicy, serviceAssignmentRequestPolicyEnabled } from "./service-assignment-policy";
import {
  nativeRequestSchemaReady,
  nativeServiceRequestsEnabled,
  resolveNativeRequestAuthority,
} from "./native-request-authority";

export type RequestReadinessReason =
  | "ready"
  | "legacy_access_unavailable"
  | "request_not_permitted"
  | "project_unavailable"
  | "catalog_unavailable"
  | "no_services_assigned"
  | "service_assignments_unavailable"
  | "request_unavailable";

interface RequestReadinessDecision {
  canStartRequest: boolean;
  reason: RequestReadinessReason;
}

export interface ClientRequestReadiness extends RequestReadinessDecision {
  mode: "catalog" | "legacy";
  workspaceId: string | null;
  target: { kind: "root" | "project"; projectId: string | null };
  root: RequestReadinessDecision;
  /** Common prerequisites only; callers must also check the exact project's canRequestService. */
  projectRequestsSupported: boolean;
  refreshedAt: string;
}

interface LocalAccess {
  role: "manager" | "member";
  can_view_billing: number;
  issuer: string;
  subject: string;
  project_allowed: number;
  project_public_id: string | null;
}

function workspaceProof(workspace: EffectivePortalWorkspaceContext | null): string | null {
  return workspace && JSON.stringify([
    workspace.workspaceId, workspace.identityId, workspace.rootType, workspace.rootPublicId,
    workspace.legacyAccountId, workspace.legacyIdentityId, workspace.role, workspace.canViewBilling,
  ]);
}

/**
 * A current UI hint, never a grant or a submission token. Request writes still
 * enforce their own live legacy/project checks and selected-workspace policy.
 * This does not enumerate projects or infer permission from catalog visibility.
 */
export async function readClientRequestReadiness(
  env: Env,
  principal: VerifiedClientPrincipal,
  session: ClientPortalSession,
  workspace: EffectivePortalWorkspaceContext | null,
  projectId: string | null,
  backendConfigured = true,
): Promise<ClientRequestReadiness> {
  const mode = env.CLIENT_PORTAL_REQUEST_V2_ENABLED === "true" ? "catalog" : "legacy";
  if (session.nativeSourceId) {
    return readNativeClientRequestReadiness(env, session, projectId, backendConfigured, mode);
  }
  // Login middleware owns eligibility provisioning. Repeated readiness reads
  // only verify established identities/bridges and must not repair grants.
  const readEnv: Env = { ...env, CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "false" };
  const expectedWorkspaceProof = workspaceProof(workspace);

  async function snapshot(assignmentWindows?: {
    root?: { evaluatedAt: string; expiresAt: string };
    project?: { evaluatedAt: string; expiresAt: string };
  }) {
    const nativeProof = workspace
      ? await readEffectiveWorkspaceRequestProof(readEnv, principal, workspace.workspaceId, projectId)
      : null;
    // A missing project proof means the selected project is unavailable, not
    // necessarily that the signed-in workspace disappeared. Recheck the root
    // independently so readiness can return a stable unavailable decision;
    // request mutation still requires the exact project proof below.
    const workspaceAuthority = workspace && projectId && !nativeProof
      ? await readEffectiveWorkspaceRequestProof(readEnv, principal, workspace.workspaceId, null)
      : nativeProof;
    const currentWorkspace = workspaceAuthority?.workspace ?? null;
    const currentProof = workspaceProof(currentWorkspace);
    if (currentProof !== expectedWorkspaceProof ||
      (portalHierarchyV2Enabled(env) && !currentWorkspace) ||
      (currentWorkspace && (currentWorkspace.legacyAccountId !== session.accountId ||
        currentWorkspace.legacyIdentityId !== session.identityId))) {
      throw new HTTPException(409, { message: "Request access changed. Refresh the client workspace." });
    }

    // Match the account, identity, membership and project predicates used by
    // both the legacy request INSERT and the catalog draft write path. A v2
    // bridge alone is not proof that this legacy storage namespace is active.
    const local: LocalAccess | null = nativeProof?.local ?? await env.DELIVERY_DB.withSession("first-primary").prepare(`
      SELECT member.role,member.can_view_billing,identity.issuer,identity.subject,
        project.project_alpha_project_id project_public_id,
        CASE WHEN ? IS NULL THEN 1 ELSE EXISTS (
          SELECT 1 FROM client_project_grants grant_record
          WHERE grant_record.account_id=account.id AND grant_record.project_id=project.id
            AND project.active=1 AND ${localOrPrimaryAlphaReference("project")} AND grant_record.revoked_at IS NULL AND grant_record.can_request_service=1
            AND (member.role='manager' OR EXISTS (
              SELECT 1 FROM client_member_project_grants member_grant
              WHERE member_grant.account_id=account.id AND member_grant.identity_id=identity.id
                AND member_grant.project_id=project.id AND member_grant.revoked_at IS NULL
            ))
        ) END project_allowed
      FROM client_accounts account
      JOIN client_identity_links identity ON identity.id=? AND identity.account_id=account.id
        AND identity.revoked_at IS NULL
      JOIN client_account_members member ON member.account_id=account.id AND member.identity_id=identity.id
        AND member.revoked_at IS NULL
      LEFT JOIN projects project ON project.id=?
      WHERE account.id=? AND account.status='active' AND ${localOrPrimaryAlphaReference("account")}`)
      .bind(projectId, session.identityId, projectId, session.accountId).first<LocalAccess>();
    const localAllowed = local !== null && (currentWorkspace !== null ||
      (local.issuer === principal.issuer && local.subject === principal.subject));
    const rootAllowed = localAllowed && (!currentWorkspace || nativeProof?.rootAllowed === true);
    const projectAllowed = Boolean(projectId && localAllowed && local?.project_allowed === 1 &&
      (!currentWorkspace || nativeProof?.projectAllowed === true));
    let catalogAvailable = mode === "legacy";
    if (localAllowed && backendConfigured && mode === "catalog") {
      try {
        catalogAvailable = await env.DELIVERY_DB.withSession("first-primary").prepare(
          "SELECT 1 available FROM pa_service_catalog_items WHERE source_id=? AND active=1 LIMIT 1",
        ).bind(PRIMARY_ALPHA_SOURCE_ID).first<number>("available") === 1;
      } catch (error) {
        if (!/no such table:\s*(?:main\.)?pa_service_catalog_items\b|no such column:\s*source_id\b/i.test(
          error instanceof Error ? error.message : String(error),
        )) throw error;
      }
    }
    const assignmentPolicy = serviceAssignmentRequestPolicyEnabled(env);
    const rootAssignment = assignmentPolicy && rootAllowed && catalogAvailable && backendConfigured && mode === "catalog"
      ? await readServiceAssignmentPolicy(env, session, null, assignmentWindows?.root) : null;
    const projectAssignment = assignmentPolicy && projectAllowed && catalogAvailable && backendConfigured && mode === "catalog" && projectId
      ? await readServiceAssignmentPolicy(env, session, projectId, assignmentWindows?.project) : null;
    return { currentProof, authorityProof: nativeProof?.authorityProof ?? workspaceAuthority?.authorityProof ?? null, local, localAllowed, rootAllowed,
      projectAllowed, catalogAvailable, assignmentPolicy, rootAssignment, projectAssignment };
  }

  const before = await snapshot();
  const after = await snapshot({
    ...(before.rootAssignment?.proof ? { root: {
      evaluatedAt: before.rootAssignment.proof.evaluatedAt,
      expiresAt: before.rootAssignment.proof.expiresAt,
    } } : {}),
    ...(before.projectAssignment?.proof ? { project: {
      evaluatedAt: before.projectAssignment.proof.evaluatedAt,
      expiresAt: before.projectAssignment.proof.expiresAt,
    } } : {}),
  });
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new HTTPException(409, { message: "Request access changed. Refresh the client workspace." });
  }
  const commonReason: RequestReadinessReason | null = !after.localAllowed
    ? "legacy_access_unavailable"
    : !backendConfigured ? "request_unavailable"
      : !after.catalogAvailable ? "catalog_unavailable" : null;
  const root: RequestReadinessDecision = {
    canStartRequest: commonReason === null && after.rootAllowed
      && (!after.assignmentPolicy || after.rootAssignment?.state === "ready"),
    reason: commonReason ?? (!after.rootAllowed ? "request_not_permitted"
      : after.rootAssignment?.state === "no_services_assigned" ? "no_services_assigned"
        : after.assignmentPolicy && after.rootAssignment?.state !== "ready" ? "service_assignments_unavailable" : "ready"),
  };
  const target: RequestReadinessDecision = projectId ? {
    canStartRequest: commonReason === null && after.projectAllowed
      && (!after.assignmentPolicy || after.projectAssignment?.state === "ready"),
    reason: commonReason ?? (!after.projectAllowed ? "project_unavailable"
      : after.projectAssignment?.state === "no_services_assigned" ? "no_services_assigned"
        : after.assignmentPolicy && after.projectAssignment?.state !== "ready" ? "service_assignments_unavailable" : "ready"),
  } : root;
  return {
    mode,
    workspaceId: workspace?.workspaceId ?? null,
    target: { kind: projectId ? "project" : "root", projectId },
    ...target,
    root,
    projectRequestsSupported: commonReason === null,
    refreshedAt: new Date().toISOString(),
  };
}

async function readNativeClientRequestReadiness(
  env: Env,
  session: ClientPortalSession,
  projectId: string | null,
  backendConfigured: boolean,
  mode: "catalog" | "legacy",
): Promise<ClientRequestReadiness> {
  const schemaReady = nativeServiceRequestsEnabled(env) && await nativeRequestSchemaReady(env);
  const stableProof = (proof: Awaited<ReturnType<typeof resolveNativeRequestAuthority>>) => proof && ({
    sourceId: proof.sourceId,
    workspaceId: proof.workspaceId,
    identityId: proof.identityId,
    rootType: proof.rootType,
    rootPublicId: proof.rootPublicId,
    projectPublicId: proof.projectPublicId,
    generationId: proof.generationId,
    sourceSequence: proof.sourceSequence,
    targetScopes: proof.targetScopes,
    allowedEntitlementIds: proof.allowedEntitlementIds,
    authority: {
      sourceId: proof.authority.sourceId,
      revision: proof.authority.revision,
      version: proof.authority.version,
      connectorRevision: proof.authority.connectorRevision,
      connectorVersion: proof.authority.connectorVersion,
    },
  });
  async function snapshot(assignmentWindows?: {
    root?: { evaluatedAt: string; expiresAt: string };
    project?: { evaluatedAt: string; expiresAt: string };
  }) {
    const rootProof = schemaReady ? await resolveNativeRequestAuthority(env, session, null) : null;
    const projectProof = schemaReady && projectId ? await resolveNativeRequestAuthority(env, session, projectId) : null;
    let catalogAvailable = false;
    if (rootProof && backendConfigured && mode === "catalog") {
      try {
        catalogAvailable = await env.DELIVERY_DB.withSession("first-primary").prepare(
          "SELECT 1 available FROM pa_service_catalog_items WHERE source_id=? AND active=1 LIMIT 1",
        ).bind(rootProof.sourceId).first<number>("available") === 1;
      } catch (error) {
        if (!/no such table:\s*(?:main\.)?pa_service_catalog_items\b|no such column:\s*source_id\b/i.test(
          error instanceof Error ? error.message : String(error),
        )) throw error;
      }
    }
    const assignmentPolicy = serviceAssignmentRequestPolicyEnabled(env);
    const rootAssignment = assignmentPolicy && rootProof && catalogAvailable && backendConfigured && mode === "catalog"
      ? await readServiceAssignmentPolicy(env, session, null, assignmentWindows?.root) : null;
    const projectAssignment = assignmentPolicy && projectProof && catalogAvailable && backendConfigured && mode === "catalog" && projectId
      ? await readServiceAssignmentPolicy(env, session, projectId, assignmentWindows?.project) : null;
    return {
      schemaReady, rootProof: stableProof(rootProof), projectProof: stableProof(projectProof), catalogAvailable,
      assignmentPolicy, rootAssignment, projectAssignment,
    };
  }
  const before = await snapshot();
  const after = await snapshot({
    ...(before.rootAssignment?.proof ? { root: {
      evaluatedAt: before.rootAssignment.proof.evaluatedAt,
      expiresAt: before.rootAssignment.proof.expiresAt,
    } } : {}),
    ...(before.projectAssignment?.proof ? { project: {
      evaluatedAt: before.projectAssignment.proof.evaluatedAt,
      expiresAt: before.projectAssignment.proof.expiresAt,
    } } : {}),
  });
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new HTTPException(409, { message: "Request access changed. Refresh the client workspace." });
  }
  const commonReason: RequestReadinessReason | null = !after.schemaReady
    ? "request_unavailable"
    : !after.rootProof
    ? "request_not_permitted"
    : !backendConfigured || mode !== "catalog" ? "request_unavailable"
      : !after.catalogAvailable ? "catalog_unavailable" : null;
  const root: RequestReadinessDecision = {
    canStartRequest: commonReason === null
      && (!after.assignmentPolicy || after.rootAssignment?.state === "ready"),
    reason: commonReason ?? (after.rootAssignment?.state === "no_services_assigned" ? "no_services_assigned"
      : after.assignmentPolicy && after.rootAssignment?.state !== "ready" ? "service_assignments_unavailable" : "ready"),
  };
  const target: RequestReadinessDecision = projectId ? {
    canStartRequest: commonReason === null && after.projectProof !== null
      && (!after.assignmentPolicy || after.projectAssignment?.state === "ready"),
    reason: commonReason ?? (!after.projectProof ? "project_unavailable"
      : after.projectAssignment?.state === "no_services_assigned" ? "no_services_assigned"
        : after.assignmentPolicy && after.projectAssignment?.state !== "ready" ? "service_assignments_unavailable" : "ready"),
  } : root;
  return {
    mode,
    workspaceId: session.workspaceId ?? null,
    target: { kind: projectId ? "project" : "root", projectId },
    ...target,
    root,
    projectRequestsSupported: commonReason === null,
    refreshedAt: new Date().toISOString(),
  };
}
