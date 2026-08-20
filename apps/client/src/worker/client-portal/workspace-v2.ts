import type { Env } from "../types";
import type { VerifiedClientPrincipal } from "./types";
import {
  portalHierarchyRelationsEnabled,
  resolvePortalRelationAuthorizedTargets,
  resolvePortalRelationTargetScopes,
} from "./hierarchy-relations";

export const PORTAL_HIERARCHY_V2_FLAG = "CLIENT_PORTAL_HIERARCHY_V2_ENABLED";
export const PORTAL_IDENTITY_DENYLIST_FLAG = "CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED";
export const PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_FLAG = "CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED";

export type PortalWorkspaceCapability =
  | "workspace.view"
  | "directory.read"
  | "delivery.view"
  | "request.create"
  | "member.manage"
  | "delegated_share.create"
  | "viewer.share.create";

export type PortalWorkspaceScopeType =
  | "workspace"
  | "organization"
  | "standalone_client"
  | "department"
  | "client"
  | "project"
  | "contact"
  | "folder";

export interface PortalWorkspaceTarget {
  scopeType: PortalWorkspaceScopeType;
  /** Workspace ID for workspace scope; PA public ID otherwise; opaque binding ID for folder. */
  publicId: string;
}

export interface PortalWorkspaceSummary {
  id: string;
  rootType: "organization" | "standalone_client";
  rootPublicId: string;
  displayName: string;
}

export interface PortalDirectoryEntry {
  type: "organization" | "standalone_client" | "department" | "client" | "project" | "contact";
  publicId: string;
  parentPublicId: string | null;
  displayName: string;
  sourceVersion: string;
}

interface IdentityRow { id: string }
interface WorkspaceRow {
  id: string;
  root_type: "organization" | "standalone_client";
  pa_organization_public_id: string | null;
  pa_client_public_id: string | null;
  display_name: string;
  legacy_account_id?: string | null;
}
interface EntitlementRow {
  effect: "allow" | "deny";
  scope_type: PortalWorkspaceScopeType;
  scope_public_id: string;
}
interface ScopeRow { entity_type: PortalWorkspaceScopeType; public_id: string }
interface IdentityDenialRow {
  workspace_id: string | null;
  scope_type: "global" | PortalWorkspaceScopeType;
  scope_public_id: string | null;
}

function isPreRelationContractDatabase(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:\s*(?:main\.)?portal_v2_directory_generation_contracts\b/i.test(message);
}

function portalDb(env: Env): D1Database {
  return env.DELIVERY_DB;
}

export function portalHierarchyV2Enabled(env: Env): boolean {
  return env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED === "true";
}

export function portalIdentityDenylistEnabled(env: Env): boolean {
  return portalHierarchyV2Enabled(env) && env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED === "true";
}

/**
 * Evaluates emergency identity denials from durable state on every request.
 * Cloudflare Access assertions are intentionally not treated as a cached
 * authorization session; enabling a denial therefore takes effect without
 * waiting for the assertion to expire. An unexpectedly large policy set fails
 * closed instead of silently ignoring later rows.
 */
async function identityDeniedForScopes(
  env: Env,
  identityId: string,
  workspaceId: string,
  scopes: ReadonlySet<string>,
): Promise<boolean> {
  if (!portalIdentityDenylistEnabled(env)) return false;
  const result = await portalDb(env).prepare(`SELECT workspace_id,scope_type,scope_public_id
    FROM portal_v2_identity_denials
    WHERE identity_id=? AND status='active' AND revoked_at IS NULL
      AND datetime(valid_from)<=datetime('now')
      AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
      AND (scope_type='global' OR workspace_id=?)
    ORDER BY id LIMIT 201`).bind(identityId, workspaceId).all<IdentityDenialRow>();
  if (result.results.length > 200) return true;
  return result.results.some(denial => denial.scope_type === "global" || (
    denial.workspace_id === workspaceId && denial.scope_public_id !== null &&
    scopes.has(`${denial.scope_type}:${denial.scope_public_id}`)
  ));
}

async function invitationAcceptanceScopes(
  env: Env,
  workspaceId: string,
  invitationId: string,
): Promise<Set<string> | null> {
  const workspace = await portalDb(env).prepare(`SELECT id,root_type,pa_organization_public_id,
      pa_client_public_id,display_name
    FROM portal_v2_workspaces WHERE id=? AND status='active'`)
    .bind(workspaceId).first<WorkspaceRow>();
  if (!workspace || !(await activeRootExists(env, workspace))) return null;
  const grants = await portalDb(env).prepare(`SELECT DISTINCT scope_type,scope_public_id
    FROM portal_v2_invitation_entitlements WHERE invitation_id=?
    ORDER BY scope_type,scope_public_id LIMIT 51`).bind(invitationId)
    .all<{ scope_type: PortalWorkspaceScopeType; scope_public_id: string }>();
  if (grants.results.length === 0 || grants.results.length > 50) return null;
  const scopes = new Set<string>();
  for (const grant of grants.results) {
    const resolved = await targetScopes(env, workspace, {
      scopeType: grant.scope_type,
      publicId: grant.scope_public_id,
    });
    if (!resolved) return null;
    for (const scope of resolved) scopes.add(scope);
  }
  return scopes;
}

export const PORTAL_WORKSPACE_HEADER = "X-LTDS-Workspace-Id";

export interface EffectivePortalWorkspaceContext {
  workspaceId: string;
  identityId: string;
  rootType: WorkspaceRow["root_type"];
  rootPublicId: string;
  legacyAccountId: string;
  legacyIdentityId: string;
  displayName: string;
  role: "manager" | "member";
  canViewBilling: boolean;
}

function validPrincipalPart(value: string): boolean {
  return value.length >= 1 && value.length <= 512;
}

function canonicalPrincipalEmail(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (normalized.length < 3 || normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

function isPreLegacyBridgeDatabase(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:\s*(?:main\.)?portal_v2_legacy_member_bridges\b/i.test(message);
}

async function resolveGlobalIdentity(
  env: Env,
  principal: VerifiedClientPrincipal,
): Promise<IdentityRow | null> {
  if (!validPrincipalPart(principal.issuer) || !validPrincipalPart(principal.subject)) return null;
  let identity = await portalDb(env)
    .prepare(`SELECT id FROM portal_v2_identities
      WHERE issuer=? AND subject=? AND status='active' AND revoked_at IS NULL`)
    .bind(principal.issuer, principal.subject)
    .first<IdentityRow>();
  const email = canonicalPrincipalEmail(principal.email);
  if (identity) {
    try {
      const blocked = await portalDb(env).prepare(`SELECT 1 ok FROM portal_v2_identity_eligibility_blocks
        WHERE status='active' AND datetime(valid_from)<=datetime('now')
          AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
          AND ((match_type='issuer_subject' AND issuer=? AND subject=?)
            OR (match_type='email' AND normalized_email=?)) LIMIT 1`)
        .bind(principal.issuer, principal.subject, email ?? "").first("ok");
      if (blocked !== null) return null;
    } catch (error) {
      if (!/no such table:\s*(?:main\.)?portal_v2_identity_eligibility_blocks\b/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
  if (email && env.CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED === "true") {
    try {
      const blocked = await portalDb(env).prepare(`SELECT 1 ok FROM portal_v2_identity_eligibility_blocks
        WHERE status='active' AND datetime(valid_from)<=datetime('now')
          AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
          AND ((match_type='issuer_subject' AND issuer=? AND subject=?)
            OR (match_type='email' AND normalized_email=?)) LIMIT 1`)
        .bind(principal.issuer, principal.subject, email).first("ok");
      if (blocked !== null) return null;
      const authorityTablesReady = (await portalDb(env).prepare(`SELECT COUNT(*) count FROM sqlite_master
        WHERE type='table' AND name IN ('pa_portal_entitlement_intents','portal_v2_directory_checkpoints','portal_v2_directory_generations')`)
        .first<number>("count")) === 3;
      const identityIdForRepair = identity?.id ?? "";
      const authorityRepair = authorityTablesReady ? ` OR EXISTS(SELECT 1 FROM pa_portal_entitlement_intents intent
        WHERE intent.workspace_id=principal.workspace_id AND intent.principal_public_id=principal.public_id
          AND intent.status='active' AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement
            WHERE entitlement.id='pa-entitlement:' || intent.workspace_id || ':' || intent.public_id
              AND entitlement.workspace_id=intent.workspace_id AND entitlement.identity_id=?
              AND entitlement.source_type='project_alpha' AND entitlement.source_version=intent.source_version
              AND entitlement.status='active' AND entitlement.revoked_at IS NULL))` : "";
      const eligible = await portalDb(env).prepare(`SELECT principal.workspace_id,principal.public_id,principal.source_version,
          workspace.legacy_account_id
        FROM pa_portal_principals principal
        JOIN portal_v2_workspaces workspace ON workspace.id=principal.workspace_id AND workspace.status='active'
          AND workspace.legacy_account_id IS NOT NULL
        JOIN client_accounts account ON account.id=workspace.legacy_account_id AND account.status='active'
        WHERE principal.status='active' AND (principal.identity_id IS NULL OR principal.identity_id=?) AND lower(principal.email_hint)=?
          AND (principal.identity_id IS NULL
            OR NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_bindings eligibility
              WHERE eligibility.identity_id=? AND eligibility.workspace_id=principal.workspace_id
                AND eligibility.principal_public_id=principal.public_id
                AND eligibility.principal_source_version=principal.source_version
                AND lower(eligibility.verified_email)=lower(principal.email_hint))
            OR NOT EXISTS(SELECT 1 FROM portal_v2_workspace_memberships membership
              WHERE membership.workspace_id=principal.workspace_id AND membership.identity_id=?
                AND membership.source_type='project_alpha' AND membership.source_version=principal.source_version
                AND membership.status='active' AND membership.revoked_at IS NULL
                AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now')))
            OR NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_legacy_bridges bridge
              WHERE bridge.workspace_id=principal.workspace_id AND bridge.identity_id=?
                AND bridge.status='active' AND bridge.revoked_at IS NULL)
            ${authorityRepair})
        ORDER BY principal.workspace_id,principal.public_id LIMIT 101`)
        .bind(identityIdForRepair,email,identityIdForRepair,identityIdForRepair,identityIdForRepair,
          ...(authorityTablesReady ? [identityIdForRepair] : []))
        .all<{ workspace_id: string; public_id: string; source_version: string; legacy_account_id: string }>();
      if (eligible.results.length === 0) return identity;
      if (eligible.results.length > 100) return null;
      const identityId = crypto.randomUUID();
      const shells = eligible.results;
      await portalDb(env).batch([
        portalDb(env).prepare(`INSERT OR IGNORE INTO portal_v2_identities
          (id,issuer,subject,verified_email,status) VALUES(?,?,?,?,'active')`)
          .bind(identityId, principal.issuer, principal.subject, email),
        ...shells.map(row => portalDb(env).prepare(`INSERT OR IGNORE INTO portal_v2_identity_eligibility_bindings
          (identity_id,workspace_id,principal_public_id,principal_source_version,verified_email)
          SELECT id,?,?,?,? FROM portal_v2_identities WHERE issuer=? AND subject=?
            AND status='active' AND revoked_at IS NULL AND lower(verified_email)=?`)
          .bind(row.workspace_id, row.public_id, row.source_version, email,
            principal.issuer, principal.subject, email)),
        ...shells.map(row => portalDb(env).prepare(`UPDATE pa_portal_principals SET identity_id=(SELECT id FROM portal_v2_identities
            WHERE issuer=? AND subject=? AND status='active' AND revoked_at IS NULL AND lower(verified_email)=?)
          WHERE workspace_id=? AND public_id=? AND source_version=? AND status='active'
            AND (identity_id IS NULL OR identity_id=(SELECT id FROM portal_v2_identities WHERE issuer=? AND subject=?))`)
          .bind(principal.issuer,principal.subject,email,row.workspace_id,row.public_id,row.source_version,principal.issuer,principal.subject)),
        ...shells.map(row => portalDb(env).prepare(`UPDATE portal_v2_workspace_memberships SET source_type='project_alpha',
            source_version=?,status='active',revoked_at=NULL,updated_at=datetime('now')
          WHERE workspace_id=? AND identity_id=(SELECT id FROM portal_v2_identities WHERE issuer=? AND subject=?)
            AND source_type='operations' AND id LIKE 'eligibility-membership:%'`)
          .bind(row.source_version,row.workspace_id,principal.issuer,principal.subject)),
        ...shells.map(row => portalDb(env).prepare(`INSERT INTO portal_v2_workspace_memberships
          (id,workspace_id,identity_id,source_type,status,source_version)
          SELECT 'pa-membership:' || projected.workspace_id || ':' || projected.public_id,projected.workspace_id,identity.id,
            'project_alpha','active',projected.source_version
          FROM pa_portal_principals projected JOIN portal_v2_identities identity ON identity.id=projected.identity_id
          WHERE projected.workspace_id=? AND projected.public_id=? AND projected.source_version=? AND projected.status='active'
            AND identity.issuer=? AND identity.subject=? AND identity.status='active' AND identity.revoked_at IS NULL
          ON CONFLICT(workspace_id,identity_id) DO UPDATE SET status='active',source_version=excluded.source_version,
            revoked_at=NULL,updated_at=datetime('now') WHERE portal_v2_workspace_memberships.source_type='project_alpha'`)
          .bind(row.workspace_id,row.public_id,row.source_version,principal.issuer,principal.subject)),
        ...shells.map(row => portalDb(env).prepare(`INSERT OR IGNORE INTO client_identity_links
          (id,account_id,issuer,subject,email)
          SELECT ?,?, ?, identity.id,? FROM portal_v2_identities identity
          WHERE identity.issuer=? AND identity.subject=? AND identity.status='active' AND identity.revoked_at IS NULL`)
          .bind(`eligibility-legacy:${row.workspace_id}:${row.public_id}`,row.legacy_account_id,
            `ltds-eligibility:${row.workspace_id}`.slice(0,512),email,principal.issuer,principal.subject)),
        ...shells.map(row => portalDb(env).prepare(`INSERT OR IGNORE INTO client_account_members
          (account_id,identity_id,role,can_view_billing) VALUES (?,?,'member',0)`)
          .bind(row.legacy_account_id,`eligibility-legacy:${row.workspace_id}:${row.public_id}`)),
        ...shells.map(row => portalDb(env).prepare(`INSERT OR IGNORE INTO portal_v2_identity_eligibility_legacy_bridges
          (workspace_id,identity_id,legacy_account_id,legacy_identity_id)
          SELECT ?,id,?,? FROM portal_v2_identities WHERE issuer=? AND subject=? AND status='active' AND revoked_at IS NULL`)
          .bind(row.workspace_id,row.legacy_account_id,`eligibility-legacy:${row.workspace_id}:${row.public_id}`,principal.issuer,principal.subject)),
        ...(authorityTablesReady ? shells.map(row => portalDb(env).prepare(`INSERT INTO portal_v2_entitlements
          (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,
           source_type,source_version,status,valid_from,expires_at)
          SELECT 'pa-entitlement:' || intent.workspace_id || ':' || intent.public_id,intent.workspace_id,projected.identity_id,
            intent.capability,intent.effect,intent.scope_type,intent.scope_public_id,
            generation.source_sequence,'project_alpha',intent.source_version,'active',intent.valid_from,intent.expires_at
          FROM pa_portal_entitlement_intents intent
          JOIN pa_portal_principals projected ON projected.workspace_id=intent.workspace_id
            AND projected.public_id=intent.principal_public_id AND projected.status='active' AND projected.identity_id IS NOT NULL
          JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=intent.workspace_id
          JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
            AND generation.workspace_id=checkpoint.workspace_id AND generation.status='active' AND generation.complete=1
          JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=intent.workspace_id
            AND membership.identity_id=projected.identity_id AND membership.status='active' AND membership.source_type='project_alpha'
          WHERE intent.workspace_id=? AND intent.principal_public_id=? AND intent.status='active'
          ON CONFLICT(id) DO UPDATE SET identity_id=excluded.identity_id,capability=excluded.capability,effect=excluded.effect,
            scope_type=excluded.scope_type,scope_public_id=excluded.scope_public_id,entitlement_version=excluded.entitlement_version,
            source_version=excluded.source_version,status='active',valid_from=excluded.valid_from,expires_at=excluded.expires_at,revoked_at=NULL`)
          .bind(row.workspace_id,row.public_id)) : []),
      ]);
      identity = await portalDb(env).prepare(`SELECT id FROM portal_v2_identities
        WHERE issuer=? AND subject=? AND status='active' AND revoked_at IS NULL AND lower(verified_email)=?`)
        .bind(principal.issuer, principal.subject, email).first<IdentityRow>();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/no such table:\s*(?:main\.)?(?:pa_portal_principals|portal_v2_identity_eligibility_(?:bindings|blocks))\b/i.test(message)) throw error;
      return null;
    }
  }
  if (!identity) return null;
  if (portalIdentityDenylistEnabled(env)) {
    const denied = await portalDb(env).prepare(`SELECT 1 ok FROM portal_v2_identity_denials
      WHERE identity_id=? AND scope_type='global' AND status='active' AND revoked_at IS NULL
        AND datetime(valid_from)<=datetime('now') AND (expires_at IS NULL OR datetime(expires_at)>datetime('now')) LIMIT 1`)
      .bind(identity.id).first("ok");
    if (denied !== null) return null;
  }
  return identity;
}

export async function portalIdentityAccepted(env: Env, principal: VerifiedClientPrincipal): Promise<boolean> {
  return Boolean(await resolveGlobalIdentity(env, principal));
}

async function activeWorkspace(
  env: Env,
  identityId: string,
  workspaceId: string,
): Promise<WorkspaceRow | null> {
  return portalDb(env).prepare(`
    SELECT w.id,w.root_type,w.pa_organization_public_id,w.pa_client_public_id,w.display_name,w.legacy_account_id
    FROM portal_v2_workspaces w
    JOIN portal_v2_workspace_memberships m
      ON m.workspace_id=w.id AND m.identity_id=? AND m.status='active' AND m.revoked_at IS NULL
      AND (m.expires_at IS NULL OR datetime(m.expires_at)>datetime('now'))
    WHERE w.id=? AND w.status='active'`)
    .bind(identityId, workspaceId)
    .first<WorkspaceRow>();
}

async function eligiblePortalShell(env: Env, identityId: string, workspaceId: string, requireBridge = false): Promise<boolean> {
  try {
    const bridge = requireBridge ? `JOIN portal_v2_identity_eligibility_legacy_bridges bridge
      ON bridge.workspace_id=eligibility.workspace_id AND bridge.identity_id=eligibility.identity_id
      AND bridge.status='active' AND bridge.revoked_at IS NULL` : "";
    return await portalDb(env).prepare(`SELECT 1 ok FROM portal_v2_identity_eligibility_bindings eligibility
      JOIN pa_portal_principals principal ON principal.workspace_id=eligibility.workspace_id
        AND principal.public_id=eligibility.principal_public_id AND principal.status='active'
        AND principal.source_version=eligibility.principal_source_version
        AND lower(principal.email_hint)=lower(eligibility.verified_email)
      JOIN portal_v2_identities identity ON identity.id=eligibility.identity_id AND identity.status='active'
        AND identity.revoked_at IS NULL AND lower(identity.verified_email)=lower(eligibility.verified_email)
      ${bridge} WHERE eligibility.workspace_id=? AND eligibility.identity_id=? LIMIT 1`)
      .bind(workspaceId, identityId).first("ok") !== null;
  } catch (error) {
    if (/no such table:\s*(?:main\.)?portal_v2_identity_eligibility_(?:bindings|legacy_bridges)\b/i.test(error instanceof Error ? error.message : String(error))) return false;
    throw error;
  }
}

/**
 * Resolves the one workspace selected by the browser into the existing LTDS
 * account/resource namespace. Selection is never ambient server state: callers
 * must send the opaque workspace ID on every request and this adapter rechecks
 * identity, membership, root generation, workspace.view, and the exact local
 * account/identity bridge every time. Workspaces without an explicit local
 * bridge fail closed until their resources have been projected.
 */
export async function resolveEffectivePortalWorkspaceContext(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
): Promise<EffectivePortalWorkspaceContext | null> {
  if (!portalHierarchyV2Enabled(env) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId)) return null;
  const identity = await resolveGlobalIdentity(env, principal);
  if (!identity) return null;
  const workspace = await activeWorkspace(env, identity.id, workspaceId);
  if (!workspace?.legacy_account_id || !(await activeRootExists(env, workspace))) return null;
  const shellEligible = await eligiblePortalShell(env, identity.id, workspaceId, true);
  if (!shellEligible && !(await authorizePortalWorkspaceCapability(
    env,
    principal,
    workspaceId,
    "workspace.view",
    { scopeType: "workspace", publicId: workspaceId },
  ))) return null;
  let legacy: { identity_id: string; role: "manager" | "member"; can_view_billing: number } | null = null;
  try {
    legacy = await portalDb(env).prepare(`
    SELECT bridge.legacy_identity_id identity_id,m.role,m.can_view_billing
    FROM portal_v2_legacy_member_bridges bridge
    JOIN client_accounts account
      ON account.id=bridge.legacy_account_id AND account.id=? AND account.status='active'
    JOIN client_identity_links i
      ON i.id=bridge.legacy_identity_id AND i.account_id=account.id AND i.revoked_at IS NULL
    JOIN client_account_members m
      ON m.account_id=account.id AND m.identity_id=i.id AND m.revoked_at IS NULL
    WHERE bridge.workspace_id=? AND bridge.identity_id=? AND bridge.status='active' AND bridge.revoked_at IS NULL`)
      .bind(workspace.legacy_account_id, workspaceId, identity.id)
      .first<{ identity_id: string; role: "manager" | "member"; can_view_billing: number }>();
  } catch (error) {
    if (!isPreLegacyBridgeDatabase(error)) throw error;
  }
  if (!legacy) try {
    legacy = await portalDb(env).prepare(`SELECT bridge.legacy_identity_id identity_id,member.role,member.can_view_billing
      FROM portal_v2_identity_eligibility_legacy_bridges bridge
      JOIN client_account_members member ON member.account_id=bridge.legacy_account_id
        AND member.identity_id=bridge.legacy_identity_id AND member.revoked_at IS NULL
      WHERE bridge.workspace_id=? AND bridge.identity_id=? AND bridge.status='active' AND bridge.revoked_at IS NULL`)
      .bind(workspaceId, identity.id).first<{ identity_id: string; role: "manager" | "member"; can_view_billing: number }>();
  } catch (error) {
    if (!/no such table:\s*(?:main\.)?portal_v2_identity_eligibility_legacy_bridges\b/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
  legacy ??= await portalDb(env).prepare(`
    SELECT i.id identity_id,m.role,m.can_view_billing
    FROM client_accounts account
    JOIN client_identity_links i
      ON i.account_id=account.id AND i.issuer=? AND i.subject=? AND i.revoked_at IS NULL
    JOIN client_account_members m
      ON m.account_id=account.id AND m.identity_id=i.id AND m.revoked_at IS NULL
    WHERE account.id=? AND account.status='active'`)
    .bind(principal.issuer, principal.subject, workspace.legacy_account_id)
    .first<{ identity_id: string; role: "manager" | "member"; can_view_billing: number }>();
  if (!legacy) return null;
  return {
    workspaceId,
    identityId: identity.id,
    rootType: workspace.root_type,
    rootPublicId: workspace.pa_organization_public_id ?? workspace.pa_client_public_id!,
    legacyAccountId: workspace.legacy_account_id,
    legacyIdentityId: legacy.identity_id,
    displayName: workspace.display_name,
    role: legacy.role,
    canViewBilling: legacy.can_view_billing === 1,
  };
}

export async function authorizeEffectiveWorkspaceRoot(
  env: Env,
  principal: VerifiedClientPrincipal,
  context: EffectivePortalWorkspaceContext,
  capability: PortalWorkspaceCapability,
): Promise<boolean> {
  return authorizePortalWorkspaceCapability(env, principal, context.workspaceId, capability, {
    scopeType: "workspace",
    publicId: context.workspaceId,
  });
}

/** Intersects a v2 entitlement with the existing active local project grant. */
export async function authorizeEffectiveWorkspaceProject(
  env: Env,
  principal: VerifiedClientPrincipal,
  context: EffectivePortalWorkspaceContext,
  capability: "delivery.view" | "request.create" | "viewer.share.create",
  localProjectId: string,
): Promise<boolean> {
  const project = await portalDb(env).prepare(`
    SELECT project.project_alpha_project_id public_id
    FROM client_project_grants grant_record
    JOIN projects project ON project.id=grant_record.project_id AND project.active=1
    WHERE grant_record.account_id=? AND grant_record.project_id=?
      AND grant_record.revoked_at IS NULL
      AND project.project_alpha_project_id IS NOT NULL`)
    .bind(context.legacyAccountId, localProjectId)
    .first<{ public_id: string }>();
  if (!project) return false;
  return authorizePortalWorkspaceCapability(env, principal, context.workspaceId, capability, {
    scopeType: "project",
    publicId: project.public_id,
  });
}

export async function authorizeEffectiveWorkspaceRequest(
  env: Env,
  principal: VerifiedClientPrincipal,
  context: EffectivePortalWorkspaceContext,
  requestId: string,
): Promise<boolean> {
  const request = await portalDb(env).prepare(`SELECT project_id FROM client_service_requests
    WHERE id=? AND account_id=?`).bind(requestId, context.legacyAccountId).first<{ project_id: string | null }>();
  if (!request) return false;
  return request.project_id
    ? authorizeEffectiveWorkspaceProject(env, principal, context, "request.create", request.project_id)
    : authorizeEffectiveWorkspaceRoot(env, principal, context, "request.create");
}

export async function authorizeEffectiveWorkspaceDraft(
  env: Env,
  principal: VerifiedClientPrincipal,
  context: EffectivePortalWorkspaceContext,
  draftId: string,
): Promise<boolean> {
  const draft = await portalDb(env).prepare(`SELECT project_id FROM client_service_request_drafts
    WHERE id=? AND account_id=?`).bind(draftId, context.legacyAccountId).first<{ project_id: string | null }>();
  if (!draft) return false;
  return draft.project_id
    ? authorizeEffectiveWorkspaceProject(env, principal, context, "request.create", draft.project_id)
    : authorizeEffectiveWorkspaceRoot(env, principal, context, "request.create");
}

export async function authorizeEffectiveWorkspaceNotification(
  env: Env,
  principal: VerifiedClientPrincipal,
  context: EffectivePortalWorkspaceContext,
  notificationId: string,
): Promise<boolean> {
  const row = await portalDb(env).prepare(`
    SELECT notification.source_type,request.project_id,
      association.scope_type folder_scope_type,association.project_id folder_project_id,
      binding.id folder_binding_id
    FROM client_portal_notifications notification
    LEFT JOIN client_service_requests request
      ON notification.source_type='service_request' AND request.id=notification.source_id
        AND request.account_id=notification.account_id
    LEFT JOIN client_folder_associations association
      ON notification.source_type='folder_grant' AND association.logical_grant_id=notification.source_id
        AND association.account_id=notification.account_id AND association.revoked_at IS NULL
    LEFT JOIN portal_v2_folder_bindings binding
      ON binding.workspace_id=? AND binding.r2_prefix=association.r2_prefix
        AND binding.status='active' AND binding.revoked_at IS NULL
    WHERE notification.id=? AND notification.account_id=?
      AND notification.recipient_identity_id=? AND notification.dismissed_at IS NULL
    ORDER BY association.grant_version DESC LIMIT 1`)
    .bind(context.workspaceId, notificationId, context.legacyAccountId, context.legacyIdentityId)
    .first<{
      source_type: "service_request" | "folder_grant";
      project_id: string | null;
      folder_scope_type: "project" | "client" | null;
      folder_project_id: string | null;
      folder_binding_id: string | null;
    }>();
  if (!row) return false;
  if (row.source_type === "service_request") {
    return row.project_id
      ? authorizeEffectiveWorkspaceProject(env, principal, context, "request.create", row.project_id)
      : authorizeEffectiveWorkspaceRoot(env, principal, context, "request.create");
  }
  if (!row.folder_binding_id) return false;
  return authorizePortalWorkspaceCapability(env, principal, context.workspaceId, "delivery.view", {
    scopeType: "folder",
    publicId: row.folder_binding_id,
  });
}

async function activeRootExists(env: Env, workspace: WorkspaceRow): Promise<boolean> {
  const rootPublicId = workspace.pa_organization_public_id ?? workspace.pa_client_public_id;
  const row = await portalDb(env).prepare(`
    SELECT 1 ok
    FROM portal_v2_directory_checkpoints checkpoint
    JOIN portal_v2_directory_generations generation
      ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=checkpoint.workspace_id
      AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities entity
      ON entity.workspace_id=checkpoint.workspace_id AND entity.generation_id=checkpoint.active_generation_id
      AND entity.entity_type=? AND entity.public_id=? AND entity.active=1
    WHERE checkpoint.workspace_id=?`)
    .bind(workspace.root_type, rootPublicId, workspace.id)
    .first("ok");
  return row !== null;
}

async function targetScopes(
  env: Env,
  workspace: WorkspaceRow,
  target: PortalWorkspaceTarget,
): Promise<Set<string> | null> {
  if (portalHierarchyRelationsEnabled(env)) {
    return resolvePortalRelationTargetScopes(env, {
      id: workspace.id,
      rootType: workspace.root_type,
      rootPublicId: workspace.pa_organization_public_id ?? workspace.pa_client_public_id!,
    }, target);
  }
  // A schema-v3 generation must never be reinterpreted as the legacy
  // single-parent tree during a flag rollback. Older installations do not
  // have the additive contract table; only those pre-v3 databases may safely
  // fall through to legacy behavior.
  try {
    const contract = await portalDb(env).prepare(`SELECT contract.schema_version
      FROM portal_v2_directory_checkpoints checkpoint
      JOIN portal_v2_directory_generation_contracts contract
        ON contract.generation_id=checkpoint.active_generation_id AND contract.workspace_id=checkpoint.workspace_id
      WHERE checkpoint.workspace_id=?`).bind(workspace.id).first<number>("schema_version");
    if (contract === 3) return null;
  } catch (error) {
    // Only the explicit pre-0129 missing-table state is compatible. Permission,
    // availability, corruption, and all other lookup errors fail closed.
    if (!isPreRelationContractDatabase(error)) return null;
  }
  const scopes = new Set<string>([["workspace", workspace.id].join(":")]);
  const rootId = workspace.pa_organization_public_id ?? workspace.pa_client_public_id;
  if (target.scopeType === "workspace") return target.publicId === workspace.id ? scopes : null;

  let targetType = target.scopeType;
  let targetPublicId = target.publicId;
  if (target.scopeType === "folder") {
    const binding = await portalDb(env).prepare(`
      SELECT owner_scope_type,owner_public_id
      FROM portal_v2_folder_bindings
      WHERE id=? AND workspace_id=? AND status='active' AND revoked_at IS NULL`)
      .bind(target.publicId, workspace.id)
      .first<{ owner_scope_type: Exclude<PortalWorkspaceScopeType, "workspace" | "folder">; owner_public_id: string }>();
    if (!binding) return null;
    scopes.add(`folder:${target.publicId}`);
    targetType = binding.owner_scope_type;
    targetPublicId = binding.owner_public_id;
  }

  const rows = await portalDb(env).prepare(`
    WITH RECURSIVE lineage(entity_type,public_id,parent_public_id,depth) AS (
      SELECT entity.entity_type,entity.public_id,entity.parent_public_id,0
      FROM portal_v2_directory_checkpoints checkpoint
      JOIN portal_v2_directory_generations generation
        ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=checkpoint.workspace_id
        AND generation.status='active' AND generation.complete=1
      JOIN portal_v2_directory_entities entity
        ON entity.workspace_id=checkpoint.workspace_id AND entity.generation_id=checkpoint.active_generation_id
      WHERE checkpoint.workspace_id=? AND entity.entity_type=? AND entity.public_id=? AND entity.active=1
      UNION ALL
      SELECT parent.entity_type,parent.public_id,parent.parent_public_id,lineage.depth+1
      FROM lineage
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=?
      JOIN portal_v2_directory_entities parent
        ON parent.workspace_id=checkpoint.workspace_id AND parent.generation_id=checkpoint.active_generation_id
        AND parent.public_id=lineage.parent_public_id AND parent.active=1
      WHERE lineage.parent_public_id IS NOT NULL AND lineage.depth<8
    )
    SELECT entity_type,public_id FROM lineage LIMIT 10`)
    .bind(workspace.id, targetType, targetPublicId, workspace.id)
    .all<ScopeRow>();
  if (rows.results.length === 0) return null;
  for (const row of rows.results) scopes.add(`${row.entity_type}:${row.public_id}`);
  // A live target whose active ancestor chain does not reach the workspace's
  // exact PA root is orphaned/reparented and cannot be authorized.
  if (!scopes.has(`${workspace.root_type}:${rootId}`)) return null;
  return scopes;
}

/**
 * Fail-closed effective authorization. A verified identity, active membership,
 * active complete PA directory generation, live target, and matching explicit
 * allow must all exist. Any matching explicit deny wins.
 */
export async function authorizePortalWorkspaceCapability(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
  capability: PortalWorkspaceCapability,
  target: PortalWorkspaceTarget,
): Promise<boolean> {
  if (!portalHierarchyV2Enabled(env)) return false;
  const identity = await resolveGlobalIdentity(env, principal);
  if (!identity) return false;
  const workspace = await activeWorkspace(env, identity.id, workspaceId);
  if (!workspace || !(await activeRootExists(env, workspace))) return false;
  const scopes = await targetScopes(env, workspace, target);
  if (!scopes) return false;
  if (await identityDeniedForScopes(env, identity.id, workspaceId, scopes)) return false;

  const result = await portalDb(env).prepare(`
    SELECT effect,scope_type,scope_public_id
    FROM portal_v2_entitlements
    WHERE workspace_id=? AND identity_id=? AND capability=?
      AND status='active' AND revoked_at IS NULL
      AND datetime(valid_from)<=datetime('now')
      AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
    ORDER BY entitlement_version DESC,id
    LIMIT 201`)
    .bind(workspaceId, identity.id, capability)
    .all<EntitlementRow>();
  // An unexpectedly unbounded grant set is a configuration error, not a reason
  // to guess which row should win.
  if (result.results.length > 200) return false;
  let allowed = false;
  for (const entitlement of result.results) {
    if (!scopes.has(`${entitlement.scope_type}:${entitlement.scope_public_id}`)) continue;
    if (entitlement.effect === "deny") return false;
    allowed = true;
  }
  return allowed;
}

export async function listPortalWorkspaces(
  env: Env,
  principal: VerifiedClientPrincipal,
): Promise<PortalWorkspaceSummary[]> {
  if (!portalHierarchyV2Enabled(env)) return [];
  const identity = await resolveGlobalIdentity(env, principal);
  if (!identity) return [];
  const candidates = await portalDb(env).prepare(`
    SELECT w.id,w.root_type,w.pa_organization_public_id,w.pa_client_public_id,w.display_name
    FROM portal_v2_workspace_memberships m
    JOIN portal_v2_workspaces w ON w.id=m.workspace_id AND w.status='active'
    WHERE m.identity_id=? AND m.status='active' AND m.revoked_at IS NULL
      AND (m.expires_at IS NULL OR datetime(m.expires_at)>datetime('now'))
    ORDER BY w.display_name COLLATE NOCASE,w.id LIMIT 101`)
    .bind(identity.id)
    .all<WorkspaceRow>();
  if (candidates.results.length > 100) return [];
  const authorized: PortalWorkspaceSummary[] = [];
  for (const workspace of candidates.results) {
    const shellEligible = await eligiblePortalShell(env, identity.id, workspace.id);
    if (!shellEligible && !(await authorizePortalWorkspaceCapability(
      env,
      principal,
      workspace.id,
      "workspace.view",
      { scopeType: "workspace", publicId: workspace.id },
    ))) continue;
    authorized.push({
      id: workspace.id,
      rootType: workspace.root_type,
      rootPublicId: workspace.pa_organization_public_id ?? workspace.pa_client_public_id!,
      displayName: workspace.display_name,
    });
  }
  return authorized;
}

export async function listPortalWorkspaceHierarchy(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
  search: string | null,
): Promise<PortalDirectoryEntry[] | null> {
  const relationScoped = portalHierarchyRelationsEnabled(env);
  let relationAuthorization: { identityId: string; workspace: WorkspaceRow } | null = null;
  if (relationScoped) {
    const identity = await resolveGlobalIdentity(env, principal);
    if (!identity) return null;
    const workspace = await activeWorkspace(env, identity.id, workspaceId);
    if (!workspace || !(await activeRootExists(env, workspace))) return null;
    relationAuthorization = { identityId: identity.id, workspace };
  } else if (!(await authorizePortalWorkspaceCapability(
    env, principal, workspaceId, "directory.read",
    { scopeType: "workspace", publicId: workspaceId },
  ))) return null;
  const normalized = search?.trim().toLocaleLowerCase("en-US") ?? "";
  if (normalized.length > 100) return null;
  const result = await portalDb(env).prepare(`
    SELECT entity.entity_type,entity.public_id,entity.parent_public_id,entity.display_name,entity.source_version
    FROM portal_v2_directory_checkpoints checkpoint
    JOIN portal_v2_directory_generations generation
      ON generation.id=checkpoint.active_generation_id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities entity
      ON entity.workspace_id=checkpoint.workspace_id AND entity.generation_id=checkpoint.active_generation_id
      AND entity.active=1
    WHERE checkpoint.workspace_id=?
      AND (?='' OR instr(lower(entity.display_name),?)>0)
    ORDER BY entity.entity_type,entity.display_name COLLATE NOCASE,entity.public_id
    LIMIT 201`)
    .bind(workspaceId, normalized, normalized)
    .all<{
      entity_type: PortalDirectoryEntry["type"];
      public_id: string;
      parent_public_id: string | null;
      display_name: string;
      source_version: string;
    }>();
  if (result.results.length > 200) return null;
  let visible = result.results;
  if (relationScoped) {
    const workspace = relationAuthorization!.workspace;
    const authorized = await resolvePortalRelationAuthorizedTargets(
      env,
      {
        id: workspace.id,
        rootType: workspace.root_type,
        rootPublicId: workspace.pa_organization_public_id ?? workspace.pa_client_public_id!,
      },
      relationAuthorization!.identityId,
      "directory.read",
      result.results.map(row => ({ scopeType: row.entity_type, publicId: row.public_id })),
    );
    if (!authorized) return null;
    visible = result.results.filter(row => authorized.has(`${row.entity_type}:${row.public_id}`));
  }
  if (visible.length > 100) return null;
  return visible.map(row => ({
    type: row.entity_type,
    publicId: row.public_id,
    parentPublicId: row.parent_public_id,
    displayName: row.display_name,
    sourceVersion: row.source_version,
  }));
}

export async function hashPortalInvitationToken(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export type InvitationAcceptance = "accepted" | "replayed" | "denied";

/** Accepts only for the authenticated verified email. Replays by the same
 * identity are idempotent; a different identity cannot take over the token. */
export async function acceptPortalWorkspaceInvitation(
  env: Env,
  principal: VerifiedClientPrincipal,
  token: string,
): Promise<InvitationAcceptance> {
  if (!portalHierarchyV2Enabled(env) || env.CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED !== "true") return "denied";
  const tokenHash = await hashPortalInvitationToken(token);
  const normalizedEmail = principal.email?.trim().toLocaleLowerCase("en-US");
  if (!tokenHash || !normalizedEmail || !validPrincipalPart(principal.issuer) || !validPrincipalPart(principal.subject)) return "denied";
  // Email narrows this one invitation only. The durable authorization subject
  // is always the provider-verified issuer + subject pair.
  const invitation = await portalDb(env).prepare(`SELECT id,workspace_id,status,accepted_by_identity_id
    FROM portal_v2_invitations WHERE token_hash=? AND lower(invited_email)=?`)
    .bind(tokenHash, normalizedEmail)
    .first<{ id: string; workspace_id: string; status: string; accepted_by_identity_id: string | null }>();
  if (!invitation) return "denied";
  let identity = await portalDb(env).prepare(`SELECT id FROM portal_v2_identities
    WHERE issuer=? AND subject=? AND status='active' AND revoked_at IS NULL AND lower(verified_email)=?`)
    .bind(principal.issuer, principal.subject, normalizedEmail).first<IdentityRow>();
  if (invitation.status === "accepted")
    return identity && invitation.accepted_by_identity_id === identity.id ? "replayed" : "denied";
  if (invitation.status !== "pending") return "denied";

  const requireEnrollmentReceipt = env.CLIENT_PORTAL_ACCESS_ENROLLMENT_READY === "true";
  if (requireEnrollmentReceipt) {
    const activeReceipt = await portalDb(env).prepare(`SELECT 1 AS ok
      FROM portal_v2_invitation_access_enrollment_receipts receipt
      JOIN portal_v2_invitation_email_outbox outbox
        ON outbox.invitation_id=receipt.invitation_id
       AND outbox.recipient_email_hash=receipt.invited_email_hash
      JOIN portal_v2_invitations current
        ON current.id=receipt.invitation_id AND current.workspace_id=receipt.workspace_id
       AND current.token_hash=receipt.invitation_token_hash
      WHERE receipt.invitation_id=? AND receipt.workspace_id=?
        AND current.status='pending' AND current.revoked_at IS NULL
        AND datetime(current.expires_at)>datetime('now')
        AND receipt.revoked_at IS NULL
        AND datetime(receipt.enrolled_at)<=datetime('now')
        AND datetime(receipt.expires_at)>datetime('now')`)
      .bind(invitation.id, invitation.workspace_id)
      .first("ok");
    if (activeReceipt === null) return "denied";
  }
  if (identity) {
    const managedMembership = await portalDb(env).prepare(`SELECT 1 AS ok
      FROM portal_v2_workspace_memberships
      WHERE workspace_id=? AND identity_id=? AND source_type<>'client_invitation'`)
      .bind(invitation.workspace_id, identity.id)
      .first("ok");
    if (managedMembership !== null) return "denied";
  }
  if (!identity) {
    const identityId = crypto.randomUUID();
    await portalDb(env).prepare(`INSERT OR IGNORE INTO portal_v2_identities
      (id,issuer,subject,verified_email,status) VALUES (?,?,?,?,'active')`)
      .bind(identityId, principal.issuer, principal.subject, normalizedEmail).run();
    identity = await portalDb(env).prepare(`SELECT id FROM portal_v2_identities
      WHERE issuer=? AND subject=? AND status='active' AND revoked_at IS NULL AND lower(verified_email)=?`)
      .bind(principal.issuer, principal.subject, normalizedEmail).first<IdentityRow>();
  }
  if (!identity) return "denied";
  // Invitations are durable, but their authority is not a snapshot. Recheck
  // the current hierarchy and any live identity denial immediately before the
  // acceptance transaction; stale/moved scopes never create a latent grant
  // that could unexpectedly revive later.
  const acceptanceScopes = await invitationAcceptanceScopes(
    env, invitation.workspace_id, invitation.id,
  );
  if (!acceptanceScopes || await identityDeniedForScopes(
    env, identity.id, invitation.workspace_id, acceptanceScopes,
  )) return "denied";
  await portalDb(env).batch([
    portalDb(env).prepare(`UPDATE portal_v2_invitations AS invitation
      SET status='accepted',accepted_at=datetime('now'),accepted_by_identity_id=?
      WHERE id=? AND status='pending' AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')
        AND NOT EXISTS (
          SELECT 1 FROM portal_v2_workspace_memberships membership
          WHERE membership.workspace_id=invitation.workspace_id AND membership.identity_id=?
            AND membership.source_type<>'client_invitation'
        )
        ${requireEnrollmentReceipt ? `AND EXISTS (
          SELECT 1
          FROM portal_v2_invitation_access_enrollment_receipts receipt
          JOIN portal_v2_invitation_email_outbox outbox
            ON outbox.invitation_id=invitation.id
           AND outbox.recipient_email_hash=receipt.invited_email_hash
          WHERE receipt.invitation_id=invitation.id
            AND receipt.workspace_id=invitation.workspace_id
            AND receipt.invitation_token_hash=invitation.token_hash
            AND receipt.revoked_at IS NULL
            AND datetime(receipt.enrolled_at)<=datetime('now')
            AND datetime(receipt.expires_at)>datetime('now')
        )` : ""}`)
      .bind(identity.id, invitation.id, identity.id),
    portalDb(env).prepare(`INSERT INTO portal_v2_workspace_memberships
      (id,workspace_id,identity_id,source_type,status)
      SELECT 'invitation-membership-' || id,workspace_id,?,'client_invitation','active'
      FROM portal_v2_invitations WHERE id=? AND status='accepted' AND accepted_by_identity_id=?
      ON CONFLICT(workspace_id,identity_id) DO NOTHING`)
      .bind(identity.id, invitation.id, identity.id),
    portalDb(env).prepare(`INSERT OR IGNORE INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status)
      SELECT 'invitation-entitlement-' || invitation.id || '-' || grants.capability || '-' || grants.scope_type || '-' || grants.scope_public_id,
        invitation.workspace_id,?,grants.capability,'allow',grants.scope_type,grants.scope_public_id,'client_invitation','active'
      FROM portal_v2_invitations invitation
      JOIN portal_v2_invitation_entitlements grants ON grants.invitation_id=invitation.id
      JOIN portal_v2_workspace_memberships membership
        ON membership.workspace_id=invitation.workspace_id AND membership.identity_id=? AND membership.status='active'
      WHERE invitation.id=? AND invitation.status='accepted' AND invitation.accepted_by_identity_id=?`)
      .bind(identity.id, identity.id, invitation.id, identity.id),
    portalDb(env).prepare(`INSERT OR IGNORE INTO client_identity_links
      (id,account_id,issuer,subject,email,last_seen_at)
      SELECT 'portal-v2-bridge:' || invitation.workspace_id || ':' || invitation.accepted_by_identity_id,
        workspace.legacy_account_id,'urn:ltds:portal-v2-bridge:' || invitation.workspace_id,
        invitation.accepted_by_identity_id,identity.verified_email,datetime('now')
      FROM portal_v2_invitations invitation
      JOIN portal_v2_workspaces workspace ON workspace.id=invitation.workspace_id
        AND workspace.status='active' AND workspace.legacy_account_id IS NOT NULL
      JOIN portal_v2_identities identity ON identity.id=invitation.accepted_by_identity_id
        AND identity.status='active' AND identity.revoked_at IS NULL
      WHERE invitation.id=? AND invitation.status='accepted' AND invitation.accepted_by_identity_id=?`)
      .bind(invitation.id, identity.id),
    portalDb(env).prepare(`INSERT OR IGNORE INTO client_account_members
      (account_id,identity_id,role,can_view_billing)
      SELECT workspace.legacy_account_id,link.id,'member',0
      FROM portal_v2_invitations invitation
      JOIN portal_v2_workspaces workspace ON workspace.id=invitation.workspace_id
        AND workspace.status='active' AND workspace.legacy_account_id IS NOT NULL
      JOIN client_identity_links link ON link.account_id=workspace.legacy_account_id
        AND link.issuer='urn:ltds:portal-v2-bridge:' || invitation.workspace_id
        AND link.subject=invitation.accepted_by_identity_id
      WHERE invitation.id=? AND invitation.status='accepted' AND invitation.accepted_by_identity_id=?`)
      .bind(invitation.id, identity.id),
    portalDb(env).prepare(`INSERT OR IGNORE INTO portal_v2_legacy_member_bridges
      (workspace_id,identity_id,legacy_account_id,legacy_identity_id,invitation_id)
      SELECT invitation.workspace_id,invitation.accepted_by_identity_id,
        workspace.legacy_account_id,link.id,invitation.id
      FROM portal_v2_invitations invitation
      JOIN portal_v2_workspaces workspace ON workspace.id=invitation.workspace_id
        AND workspace.status='active' AND workspace.legacy_account_id IS NOT NULL
      JOIN client_identity_links link ON link.account_id=workspace.legacy_account_id
        AND link.issuer='urn:ltds:portal-v2-bridge:' || invitation.workspace_id
        AND link.subject=invitation.accepted_by_identity_id
      WHERE invitation.id=? AND invitation.status='accepted' AND invitation.accepted_by_identity_id=?`)
      .bind(invitation.id, identity.id),
    portalDb(env).prepare(`INSERT OR IGNORE INTO client_member_project_grants
      (account_id,identity_id,project_id,granted_by_identity_id)
      SELECT bridge.legacy_account_id,bridge.legacy_identity_id,grant_record.project_id,
        bridge.legacy_identity_id
      FROM portal_v2_legacy_member_bridges bridge
      JOIN client_project_grants grant_record ON grant_record.account_id=bridge.legacy_account_id
        AND grant_record.revoked_at IS NULL
      WHERE bridge.workspace_id=? AND bridge.identity_id=? AND bridge.status='active'`)
      .bind(invitation.workspace_id, identity.id),
    portalDb(env).prepare(`INSERT INTO portal_v2_membership_audit
      (id,workspace_id,actor_identity_id,action,subject_identity_id,invitation_id)
      SELECT ?,workspace_id,?,'invitation.accepted',?,id FROM portal_v2_invitations
      WHERE id=? AND status='accepted' AND accepted_by_identity_id=?
        AND NOT EXISTS (SELECT 1 FROM portal_v2_membership_audit audit WHERE audit.invitation_id=? AND audit.action='invitation.accepted')`)
      .bind(crypto.randomUUID(), identity.id, identity.id, invitation.id, identity.id, invitation.id),
  ]);
  const acceptedBy = await portalDb(env).prepare("SELECT accepted_by_identity_id FROM portal_v2_invitations WHERE id=?")
    .bind(invitation.id).first("accepted_by_identity_id");
  // Migration 0127 performs this atomically with the invitation update. Keep
  // the idempotent write here as defense in depth during rolling upgrades.
  if (acceptedBy === identity.id) {
    await portalDb(env).prepare(`UPDATE portal_v2_invitation_email_outbox SET
      payload_json='{"redacted":true}',status=CASE WHEN status='sent' THEN 'sent' ELSE 'cancelled' END,
      lease_expires_at=NULL,last_error_code=NULL,updated_at=datetime('now') WHERE invitation_id=?`)
      .bind(invitation.id).run();
  }
  return acceptedBy === identity.id ? "accepted" : "denied";
}
