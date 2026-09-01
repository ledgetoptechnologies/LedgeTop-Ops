import type { Env as ClientEnv } from "../types";
import {invitationPublicationAllowed,invitationRequestsReady} from './invitation-approval-policy';
import { HTTPException } from 'hono/http-exception';
import { readPortalSourceAuthorityProof, portalSourceAuthoritiesReady, type PortalSourceAuthorityProof } from "../project-alpha-portal-authority";
import { readNativeTargetScopes, type NativeTargetScopes } from "./native-portal-scopes";
import { projectAccessReadColumns, projectAccessRowAllows, readExpiredScopeProjects, type ProjectAccessReadRow } from './project-access-read';
import { projectAccessTermsReady,projectAccessTermsSql,readProjectAccessTerms,readWorkspaceInvitationPolicy } from './project-access-terms';
import {projectAccessAuthorityHistoryReady,projectAccessInvitationEvent} from './project-access-authority-history';
import {requireProjectAccessAuthorityMutations} from './project-access-mutation-gate';
import { projectAccessCapacitySql } from './project-access-capacity';
import { d1TablesPresent } from "../schema-readiness";
import { bindNativePortalEligibility } from "./native-portal-eligibility";
import { readPrimaryTermRetentionGrants } from './authenticated-delivery-grants';
import { localOrPrimaryAlphaReference, primaryAlphaReference, primaryWorkspaceAccount } from "./project-alpha-source";
import {captureWorkspaceInvitationDelegation} from './project-invitation-delegation';
export type PortalAuthorizationEnv = Pick<ClientEnv, "DELIVERY_DB" | "CLIENT_PORTAL_HIERARCHY_V2_ENABLED" |
  "CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED" | "CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED" |
  "CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED" | "CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED" |
  "CLIENT_PORTAL_ACCESS_ENROLLMENT_READY" | "AUTHENTICATED_DELIVERY_GRANTS_ENABLED" |
  "PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED">;
type Env = PortalAuthorizationEnv;
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
  resourceMode?: "native";
  sourceId?: string;
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
  project_alpha_source_id?: string;
}
interface EntitlementRow extends ProjectAccessReadRow {
  id?: string;
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

function deniedByIdentityRows(rows: IdentityDenialRow[], workspaceId: string, scopes: ReadonlySet<string>): boolean {
  return rows.length > 200 || rows.some(denial => denial.scope_type === "global" || (
    denial.workspace_id === workspaceId && denial.scope_public_id !== null &&
    scopes.has(`${denial.scope_type}:${denial.scope_public_id}`)
  ));
}

function allowedByEntitlementRows(rows: EntitlementRow[], scopes: ReadonlySet<string>, expiredProjects:readonly string[]=[], shell=false,
  preserveOrdinaryHistory=false): boolean {
  if (rows.length > 200) return false;
  let allowed = false;
  for (const entitlement of rows) {
    if (!scopes.has(`${entitlement.scope_type}:${entitlement.scope_public_id}`)) continue;
    if (entitlement.effect === "deny") return false;
    if(projectAccessRowAllows(entitlement,scopes,expiredProjects,shell,{preserveOrdinaryHistory}))allowed = true;
  }
  return allowed;
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
  return deniedByIdentityRows(result.results, workspaceId, scopes);
}

async function invitationAcceptanceScopes(
  env: Env,
  workspaceId: string,
  invitationId: string,
): Promise<Set<string> | null> {
  const database=portalDb(env);
  let workspace=await database.prepare(`SELECT id,root_type,pa_organization_public_id,
      pa_client_public_id,display_name,project_alpha_source_id,legacy_account_id
    FROM portal_v2_workspaces WHERE id=? AND status='active'
      AND ${primaryWorkspaceAccount("portal_v2_workspaces")}`)
    .bind(workspaceId).first<WorkspaceRow>();
  if(!workspace){
    try{
      workspace=await database.prepare(`SELECT workspace.id,workspace.root_type,workspace.pa_organization_public_id,
          workspace.pa_client_public_id,workspace.display_name,workspace.project_alpha_source_id,workspace.legacy_account_id
        FROM portal_v2_workspaces workspace
        JOIN portal_secondary_workspace_invitation_authority binding ON binding.workspace_id=workspace.id
          AND binding.invitation_id=? AND binding.source_id=workspace.project_alpha_source_id
        JOIN pa_portal_source_authorities authority ON authority.source_id=binding.source_id AND authority.state='active'
          AND authority.active_revision=binding.authority_revision AND authority.version=binding.authority_version
          AND authority.connector_revision=binding.connector_revision AND authority.connector_version=binding.connector_version
        JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id AND revision.revision=authority.active_revision
        JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=binding.workspace_id
          AND checkpoint.active_generation_id=binding.generation_id AND checkpoint.source_sequence=binding.source_sequence
        JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
          AND generation.workspace_id=binding.workspace_id AND generation.status='active' AND generation.complete=1
          AND generation.source_sequence=checkpoint.source_sequence
        WHERE workspace.id=? AND workspace.status='active' AND workspace.legacy_account_id IS NULL`)
        .bind(invitationId,workspaceId).first<WorkspaceRow>();
    }catch(error){
      if(isMissingSecondaryMembershipSchema(error))return null;
      throw error;
    }
  }
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

function isMissingSecondaryMembershipSchema(error:unknown):boolean{
  const message=error instanceof Error?error.message:String(error);
  return /no such table:\s*(?:main\.)?(?:portal_secondary_workspace_invitation_authority|portal_secondary_workspace_membership_fences|pa_portal_source_authorities|pa_portal_source_authority_revisions)\b|no such column:\s*(?:binding\.)?grant_manifest_json\b/i.test(message);
}

// A pending invitation proves what the issuing manager was allowed to do when
// it was created. Acceptance is a new access mutation, so it must also prove
// that the same manager still owns the local authority at consumption time.
// The aliases here intentionally match each secondary-acceptance fence below.
const secondaryInvitationInviterIsCurrent = `EXISTS(SELECT 1
  FROM portal_v2_identities inviter
  JOIN portal_v2_workspace_memberships inviter_membership
    ON inviter_membership.workspace_id=workspace.id AND inviter_membership.identity_id=inviter.id
    AND inviter_membership.source_type='project_alpha' AND inviter_membership.status='active'
    AND inviter_membership.revoked_at IS NULL AND inviter_membership.expires_at IS NULL
  JOIN pa_portal_principals inviter_principal
    ON inviter_principal.workspace_id=workspace.id AND inviter_principal.identity_id=inviter.id
    AND inviter_principal.status='active' AND inviter_principal.source_version=inviter_membership.source_version
    AND lower(inviter_principal.email_hint)=lower(inviter.verified_email)
  JOIN portal_v2_directory_entities inviter_root
    ON inviter_root.workspace_id=workspace.id AND inviter_root.generation_id=generation.id
    AND inviter_root.entity_type=workspace.root_type
    AND inviter_root.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)
    AND inviter_root.active=1
  WHERE inviter.id=binding.inviter_identity_id AND inviter.issuer=binding.inviter_issuer
    AND inviter.subject=binding.inviter_subject AND lower(inviter.verified_email)=lower(binding.inviter_email)
    AND inviter.status='active' AND inviter.revoked_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials denial
      WHERE denial.identity_id=inviter.id AND denial.status='active' AND denial.revoked_at IS NULL
        AND datetime(denial.valid_from)<=datetime('now')
        AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
        AND (denial.scope_type='global' OR denial.workspace_id=workspace.id))
    AND EXISTS(SELECT 1 FROM portal_v2_entitlements view_allow
      WHERE view_allow.workspace_id=workspace.id AND view_allow.identity_id=inviter.id
        AND view_allow.capability='workspace.view' AND view_allow.effect='allow'
        AND view_allow.scope_type='workspace' AND view_allow.scope_public_id=workspace.id
        AND view_allow.source_type='project_alpha' AND view_allow.source_version=inviter_membership.source_version
        AND view_allow.status='active' AND view_allow.revoked_at IS NULL
        AND datetime(view_allow.valid_from)<=datetime('now') AND view_allow.expires_at IS NULL)
    AND EXISTS(SELECT 1 FROM portal_v2_entitlements manage_allow
      WHERE manage_allow.workspace_id=workspace.id AND manage_allow.identity_id=inviter.id
        AND manage_allow.capability='member.manage' AND manage_allow.effect='allow'
        AND manage_allow.scope_type='workspace' AND manage_allow.scope_public_id=workspace.id
        AND manage_allow.source_type='project_alpha' AND manage_allow.source_version=inviter_membership.source_version
        AND manage_allow.status='active' AND manage_allow.revoked_at IS NULL
        AND datetime(manage_allow.valid_from)<=datetime('now') AND manage_allow.expires_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements deny
      WHERE deny.workspace_id=workspace.id AND deny.identity_id=inviter.id
        AND deny.capability IN ('workspace.view','member.manage') AND deny.effect='deny'
        AND deny.scope_type='workspace' AND deny.scope_public_id=workspace.id
        AND deny.status='active' AND deny.revoked_at IS NULL
        AND datetime(deny.valid_from)<=datetime('now')
        AND (deny.expires_at IS NULL OR datetime(deny.expires_at)>datetime('now'))))`;

async function resolveGlobalIdentity(
  env: Env,
  principal: VerifiedClientPrincipal,
  allowEligibilityRepair = true,
): Promise<IdentityRow | null> {
  if (!validPrincipalPart(principal.issuer) || !validPrincipalPart(principal.subject)) return null;
  const identityDatabase = allowEligibilityRepair ? portalDb(env) : env.DELIVERY_DB.withSession('first-primary');
  let identity = await identityDatabase
    .prepare(`SELECT id FROM portal_v2_identities
      WHERE issuer=? AND subject=? AND status='active' AND revoked_at IS NULL`)
    .bind(principal.issuer, principal.subject)
    .first<IdentityRow>();
  const email = canonicalPrincipalEmail(principal.email);
  if (identity) {
    try {
      const blocked = await identityDatabase.prepare(`SELECT 1 ok FROM portal_v2_identity_eligibility_blocks
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
  if (allowEligibilityRepair && email && env.CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED === "true") {
    try {
      const blocked = await portalDb(env).prepare(`SELECT 1 ok FROM portal_v2_identity_eligibility_blocks
        WHERE status='active' AND datetime(valid_from)<=datetime('now')
          AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
          AND ((match_type='issuer_subject' AND issuer=? AND subject=?)
            OR (match_type='email' AND normalized_email=?)) LIMIT 1`)
        .bind(principal.issuer, principal.subject, email).first("ok");
      if (blocked !== null) return null;
      await bindNativePortalEligibility(env, principal, email);
      identity = await portalDb(env).prepare(`SELECT id FROM portal_v2_identities
        WHERE issuer=? AND subject=? AND status='active' AND revoked_at IS NULL AND lower(verified_email)=?`)
        .bind(principal.issuer, principal.subject, email).first<IdentityRow>();
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
          AND ${primaryAlphaReference("workspace")}
          AND workspace.legacy_account_id IS NOT NULL
        JOIN client_accounts account ON account.id=workspace.legacy_account_id AND account.status='active'
          AND ${primaryAlphaReference("account")}
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
    const denied = await (allowEligibilityRepair ? portalDb(env) : identityDatabase).prepare(`SELECT 1 ok FROM portal_v2_identity_denials
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
    WHERE w.id=? AND w.status='active' AND ${primaryWorkspaceAccount("w")}`)
    .bind(identityId, workspaceId)
    .first<WorkspaceRow>();
}

export function eligiblePortalShellQuery(requireBridge: boolean, workspaceReference = "?", identityReference = "?"): string {
  const bridge = requireBridge ? `JOIN portal_v2_identity_eligibility_legacy_bridges bridge
      ON bridge.workspace_id=eligibility.workspace_id AND bridge.identity_id=eligibility.identity_id
      AND bridge.status='active' AND bridge.revoked_at IS NULL` : "";
  return `SELECT 1 ok FROM portal_v2_identity_eligibility_bindings eligibility
      JOIN pa_portal_principals principal ON principal.workspace_id=eligibility.workspace_id
        AND principal.public_id=eligibility.principal_public_id AND principal.status='active'
        AND principal.source_version=eligibility.principal_source_version
        AND lower(principal.email_hint)=lower(eligibility.verified_email)
      JOIN portal_v2_identities identity ON identity.id=eligibility.identity_id AND identity.status='active'
        AND identity.revoked_at IS NULL AND lower(identity.verified_email)=lower(eligibility.verified_email)
      ${bridge} WHERE eligibility.workspace_id=${workspaceReference} AND eligibility.identity_id=${identityReference} LIMIT 1`;
}

async function eligiblePortalShell(env: Env, identityId: string, workspaceId: string, requireBridge = false): Promise<boolean> {
  try {
    return await portalDb(env).prepare(eligiblePortalShellQuery(requireBridge))
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
      ON account.id=bridge.legacy_account_id AND account.id=? AND account.status='active' AND ${localOrPrimaryAlphaReference("account")}
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
      JOIN client_accounts account ON account.id=bridge.legacy_account_id AND account.id=?
        AND account.status='active' AND ${localOrPrimaryAlphaReference("account")}
      JOIN client_identity_links link ON link.id=bridge.legacy_identity_id AND link.account_id=account.id AND link.revoked_at IS NULL
      JOIN client_account_members member ON member.account_id=bridge.legacy_account_id
        AND member.identity_id=bridge.legacy_identity_id AND member.revoked_at IS NULL
      WHERE bridge.workspace_id=? AND bridge.identity_id=? AND bridge.status='active' AND bridge.revoked_at IS NULL`)
      .bind(workspace.legacy_account_id, workspaceId, identity.id).first<{ identity_id: string; role: "manager" | "member"; can_view_billing: number }>();
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
    WHERE account.id=? AND account.status='active' AND ${localOrPrimaryAlphaReference("account")}`)
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
    JOIN projects project ON project.id=grant_record.project_id AND project.active=1 AND ${primaryAlphaReference("project")}
    JOIN client_accounts account ON account.id=grant_record.account_id AND account.status='active' AND ${localOrPrimaryAlphaReference("account")}
    WHERE grant_record.account_id=? AND grant_record.project_id=?
      AND grant_record.revoked_at IS NULL
      AND project.project_alpha_project_id IS NOT NULL`)
    .bind(context.legacyAccountId, localProjectId)
    .first<{ public_id: string }>();
  if (!project) return false;
  const target={scopeType:'project' as const,publicId:project.public_id};
  if(await authorizePortalWorkspaceCapability(env, principal, context.workspaceId, capability,target))return true;
  if(capability==='delivery.view'&&(await readPrimaryTermRetentionGrants(env,principal,context.workspaceId,[project.public_id])).length)
    return authorizePortalWorkspaceCapability(env,principal,context.workspaceId,capability,target,{retainedProjectId:project.public_id});
  return false;
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

async function legacyTargetContractAvailable(database: Pick<D1Database, "prepare">, workspaceId: string): Promise<boolean> {
  // A schema-v3 generation must never be reinterpreted as the legacy
  // single-parent tree during a flag rollback. Older installations do not
  // have the additive contract table; only those pre-v3 databases may safely
  // fall through to legacy behavior.
  try {
    const contract = await database.prepare(`SELECT contract.schema_version
      FROM portal_v2_directory_checkpoints checkpoint
      JOIN portal_v2_directory_generation_contracts contract
        ON contract.generation_id=checkpoint.active_generation_id AND contract.workspace_id=checkpoint.workspace_id
      WHERE checkpoint.workspace_id=?`).bind(workspaceId).first<number>("schema_version");
    if (contract === 3) return false;
  } catch (error) {
    // Only the explicit pre-0129 missing-table state is compatible. Permission,
    // availability, corruption, and all other lookup errors fail closed.
    if (!isPreRelationContractDatabase(error)) return false;
  }
  return true;
}

async function targetScopes(
  env: Env,
  workspace: WorkspaceRow,
  target: PortalWorkspaceTarget,
  database: Pick<D1Database, "prepare"> = portalDb(env),
  legacyContractVerified = false,
  options?:{retention:'structural'},
): Promise<Set<string> | null> {
  if (portalHierarchyRelationsEnabled(env)) {
    return resolvePortalRelationTargetScopes({ DELIVERY_DB: database }, {
      id: workspace.id,
      rootType: workspace.root_type,
      rootPublicId: workspace.pa_organization_public_id ?? workspace.pa_client_public_id!,
    }, target, options);
  }
  if (!legacyContractVerified && !(await legacyTargetContractAvailable(database, workspace.id))) return null;
  const scopes = new Set<string>([["workspace", workspace.id].join(":")]);
  const rootId = workspace.pa_organization_public_id ?? workspace.pa_client_public_id;
  if (target.scopeType === "workspace") return target.publicId === workspace.id ? scopes : null;

  let targetType = target.scopeType;
  let targetPublicId = target.publicId;
  if (target.scopeType === "folder") {
    const binding = await database.prepare(`
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

  const rows = await database.prepare(`
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
  options?:{retainedProjectId:string},
): Promise<boolean> {
  if (!portalHierarchyV2Enabled(env)) return false;
  const identity = await resolveGlobalIdentity(env, principal);
  if (!identity) return false;
  const workspace = await activeWorkspace(env, identity.id, workspaceId);
  if (!workspace || !(await activeRootExists(env, workspace))) return false;
  const termsReady=await projectAccessTermsReady(portalDb(env));
  const scopes = await targetScopes(env, workspace, target,portalDb(env),false,termsReady?{retention:'structural'}:undefined);
  if (!scopes) return false;
  if (await identityDeniedForScopes(env, identity.id, workspaceId, scopes)) return false;

  const result = await portalDb(env).prepare(`
    SELECT effect,scope_type,scope_public_id,${termsReady?'source_type':'NULL source_type'},${projectAccessReadColumns('entitlement',termsReady)}
    FROM portal_v2_entitlements entitlement
    WHERE workspace_id=? AND identity_id=? AND capability=?
      AND status='active' AND revoked_at IS NULL
      AND datetime(valid_from)<=datetime('now')
      AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
      AND ${projectAccessCapacitySql('entitlement',termsReady)}
    ORDER BY entitlement_version DESC,id
    LIMIT 201`)
    .bind(workspaceId, identity.id, capability)
    .all<EntitlementRow>();
  // An unexpectedly unbounded grant set is a configuration error, not a reason
  // to guess which row should win.
  const expired=termsReady?await readExpiredScopeProjects(portalDb(env),workspaceId,scopes,portalHierarchyRelationsEnabled(env)):[];
  return allowedByEntitlementRows(result.results, scopes,expired.filter(id=>id!==options?.retainedProjectId),
    capability==='workspace.view'&&target.scopeType==='workspace',
    capability==='delivery.view'||(capability==='directory.read'&&target.scopeType==='project'));
}

/** Internal batching of the same primary capability policy, for independently
 * selected versioned grants. A retention override is not an entitlement. */
export async function authorizePrimaryPortalTargetBatch(env:Env,principal:VerifiedClientPrincipal,workspaceId:string,
  targets:Array<{target:PortalWorkspaceTarget;retainedProjectId?:string}>,capability:PortalWorkspaceCapability='delivery.view'):Promise<Map<string,NativeTargetScopes>>{
  const result=new Map<string,NativeTargetScopes>();
  if(!portalHierarchyV2Enabled(env)||!targets.length)return result;
  if(targets.length>100)throw new HTTPException(503,{message:'Project delivery access exceeds safe capacity. Contact support.'});
  const identity=await resolveGlobalIdentity(env,principal);if(!identity)return result;
  const workspace=await activeWorkspace(env,identity.id,workspaceId);if(!workspace||!await activeRootExists(env,workspace))return result;
  const db=portalDb(env),generation=await db.prepare('SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=?')
    .bind(workspaceId).first<string>('active_generation_id');if(!generation)return result;
  const scopes=await readNativeTargetScopes(env,{workspaceId,generationId:generation,rootType:workspace.root_type,
    rootPublicId:workspace.pa_organization_public_id??workspace.pa_client_public_id!},targets.map(t=>t.target),{retention:'structural'});
  const ready=await projectAccessTermsReady(db);
  const rules=(await db.prepare(`SELECT effect,scope_type,scope_public_id,${ready?'source_type':'NULL source_type'},${projectAccessReadColumns('entitlement',ready)}
    FROM portal_v2_entitlements entitlement WHERE workspace_id=? AND identity_id=? AND capability=?
      AND status='active' AND revoked_at IS NULL AND datetime(valid_from)<=datetime('now')
      AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
      AND ${projectAccessCapacitySql('entitlement',ready)} ORDER BY entitlement_version DESC,id LIMIT 201`)
    .bind(workspaceId,identity.id,capability).all<EntitlementRow>()).results;
  const denials=portalIdentityDenylistEnabled(env)?(await db.prepare(`SELECT workspace_id,scope_type,scope_public_id FROM portal_v2_identity_denials
    WHERE identity_id=? AND status='active' AND revoked_at IS NULL AND datetime(valid_from)<=datetime('now')
      AND (expires_at IS NULL OR datetime(expires_at)>datetime('now')) AND (scope_type='global' OR workspace_id=?) ORDER BY id LIMIT 201`)
    .bind(identity.id,workspaceId).all<IdentityDenialRow>()).results:[];
  for(const item of targets){const key=`${item.target.scopeType}:${item.target.publicId}`,scope=scopes.get(key);if(!scope)continue;
    const expired=scope.proofRows.filter(r=>r.entity_type==='project'&&r.retained===0&&r.public_id!==item.retainedProjectId).map(r=>r.public_id);
    if(!deniedByIdentityRows(denials,workspaceId,scope.scopes)
      &&allowedByEntitlementRows(rules,scope.scopes,expired,false,capability==='delivery.view'
        ||(capability==='directory.read'&&item.target.scopeType==='project')))result.set(key,scope);
  }
  return result;
}

/** Invitation options on an explicitly pre-0129 installation use the same
 * legacy lineage and allow/deny evaluators as single-target authorization.
 * Current or partial relation/terms schemas must never downgrade to this path. */
export async function readLegacyInvitationCapabilityOptions(env:Env,principal:VerifiedClientPrincipal,workspaceId:string,
  targets:PortalWorkspaceTarget[]):Promise<Map<PortalWorkspaceCapability,Set<string>>|null>{
  if(portalHierarchyRelationsEnabled(env))return null;
  if(targets.length>200)throw new HTTPException(503,{message:'Invitation access exceeds safe capacity. Contact support.'});
  const database=portalDb(env);
  const tables=(await database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (
    'portal_v2_directory_generation_contracts','portal_v2_directory_relations','portal_v2_project_lifecycle',
    'pa_portal_projection_generation_contracts','pa_portal_projection_relations','pa_portal_projection_project_lifecycle')`)
    .all<{name:string}>()).results;
  if(tables.some(table=>table.name==='portal_v2_directory_generation_contracts'))return null;
  if(tables.length||await projectAccessTermsReady(database))throw new HTTPException(503,{message:'Invitation scope metadata is unavailable.'});
  const result=new Map<PortalWorkspaceCapability,Set<string>>();
  if(!portalHierarchyV2Enabled(env)||!targets.length)return result;
  const identity=await resolveGlobalIdentity(env,principal);if(!identity)return result;
  const workspace=await activeWorkspace(env,identity.id,workspaceId);
  if(!workspace||!await activeRootExists(env,workspace))return result;
  const capabilities=['member.manage','delivery.view','request.create'] as const;
  const rules=new Map<PortalWorkspaceCapability,EntitlementRow[]>();
  for(const capability of capabilities){
    rules.set(capability,(await database.prepare(`SELECT effect,scope_type,scope_public_id,${projectAccessReadColumns('entitlement',false)}
      FROM portal_v2_entitlements entitlement WHERE workspace_id=? AND identity_id=? AND capability=?
        AND status='active' AND revoked_at IS NULL AND datetime(valid_from)<=datetime('now')
        AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
      ORDER BY entitlement_version DESC,id LIMIT 201`).bind(workspaceId,identity.id,capability).all<EntitlementRow>()).results);
    result.set(capability,new Set());
  }
  const denials=portalIdentityDenylistEnabled(env)?(await database.prepare(`SELECT workspace_id,scope_type,scope_public_id FROM portal_v2_identity_denials
    WHERE identity_id=? AND status='active' AND revoked_at IS NULL AND datetime(valid_from)<=datetime('now')
      AND (expires_at IS NULL OR datetime(expires_at)>datetime('now')) AND (scope_type='global' OR workspace_id=?) ORDER BY id LIMIT 201`)
    .bind(identity.id,workspaceId).all<IdentityDenialRow>()).results:[];
  for(const target of targets){
    // The readiness query above proves the exact pre-contract state accepted
    // by legacyTargetContractAvailable, without issuing a missing-table query.
    const scopes=await targetScopes(env,workspace,target,database,true);
    if(!scopes||deniedByIdentityRows(denials,workspaceId,scopes))continue;
    for(const capability of capabilities)if(allowedByEntitlementRows(rules.get(capability)!,scopes))
      result.get(capability)!.add(`${target.scopeType}:${target.publicId}`);
  }
  return result;
}

export type NativePortalReadCapability = "workspace.view" | "directory.read" | "delivery.view";
export interface NativePortalReadContext {
  workspaceId: string;
  sourceId: string;
  identityId: string;
  displayName: string;
  rootType: WorkspaceRow["root_type"];
  rootPublicId: string;
  generationId: string;
  membershipSourceVersion: string;
  verifiedEmail: string;
  contextVersion: string;
  authority: PortalSourceAuthorityProof;
  /** Internal, current authorization facts. Never serialize this structure. */
  workspace: WorkspaceRow;
  grants: Array<EntitlementRow & { capability: NativePortalReadCapability }>;
  denials: IdentityDenialRow[];
  projectAccessTermsAvailable?:boolean;
}

export async function nativePortalSourceSchemaAvailable(env: Env): Promise<boolean> {
  return await portalSourceAuthoritiesReady(env.DELIVERY_DB)
    && await d1TablesPresent(env.DELIVERY_DB, ["pa_portal_workspace_sources"]);
}

/** A separate read adapter. It cannot manufacture a legacy account or authorize
 * request, billing, invitation, delegation or Viewer capabilities. */
export async function resolveNativePortalWorkspaceReadContext(
  env: Env, principal: VerifiedClientPrincipal, workspaceId: string,
): Promise<NativePortalReadContext | null> {
  if (!portalHierarchyV2Enabled(env) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId)
    || !await nativePortalSourceSchemaAvailable(env)) return null;
  const identity = await resolveGlobalIdentity(env, principal, false);
  if (!identity) return null;
  const database = env.DELIVERY_DB.withSession("first-primary");
  const workspace = await database.prepare(`SELECT workspace.*,membership.id membership_id,
      membership.status membership_status,membership.source_type membership_source_type,
      membership.source_version membership_source_version,membership.expires_at membership_expires_at,
      checkpoint.active_generation_id generation_id,checkpoint.source_sequence,
      root.source_version root_version,root.display_name root_name,
      person.issuer person_issuer,person.subject person_subject,person.verified_email person_email
    FROM portal_v2_workspaces workspace
    JOIN pa_portal_workspace_sources source ON source.workspace_id=workspace.id AND source.projection_source_id=workspace.project_alpha_source_id
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=workspace.id AND membership.identity_id=?
      AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    JOIN portal_v2_identities person ON person.id=membership.identity_id AND person.status='active' AND person.revoked_at IS NULL
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities root ON root.workspace_id=workspace.id AND root.generation_id=generation.id
      AND root.entity_type=workspace.root_type AND root.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) AND root.active=1
    WHERE workspace.id=? AND workspace.status='active' AND workspace.legacy_account_id IS NULL
      AND workspace.project_alpha_source_id<>'project-alpha:primary' AND lower(person.verified_email)=?
      AND (membership.source_type<>'project_alpha' OR EXISTS(SELECT 1 FROM pa_portal_principals current_principal
        WHERE current_principal.workspace_id=workspace.id AND current_principal.identity_id=person.id
          AND current_principal.status='active' AND current_principal.source_version=membership.source_version
          AND lower(current_principal.email_hint)=lower(person.verified_email)))`)
    .bind(identity.id, workspaceId,canonicalPrincipalEmail(principal.email)??'').first<WorkspaceRow & { project_alpha_source_id: string; generation_id: string;
      membership_source_version:string;person_email:string }>();
  if (!workspace) return null;
  const authority = await readPortalSourceAuthorityProof(database, workspace.project_alpha_source_id);
  if (!authority) return null;
  const termsReady=await projectAccessTermsReady(env.DELIVERY_DB);
  const grants = await database.prepare(`SELECT id,capability,effect,scope_type,scope_public_id,entitlement_version,
      source_type,source_version,valid_from,expires_at,${projectAccessReadColumns('entitlement',termsReady)} FROM portal_v2_entitlements entitlement
    WHERE workspace_id=? AND identity_id=? AND capability IN ('workspace.view','directory.read','delivery.view')
      AND status='active' AND revoked_at IS NULL AND datetime(valid_from)<=datetime('now')
      AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
      AND ${projectAccessCapacitySql('entitlement',termsReady)} ORDER BY id LIMIT 201`)
    .bind(workspaceId, identity.id).all<NativePortalReadContext["grants"][number]>();
  const denials = portalIdentityDenylistEnabled(env) ? (await database.prepare(`SELECT id,workspace_id,scope_type,scope_public_id,valid_from,expires_at
    FROM portal_v2_identity_denials WHERE identity_id=? AND status='active' AND revoked_at IS NULL
      AND datetime(valid_from)<=datetime('now') AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
      AND (scope_type='global' OR workspace_id=?) ORDER BY id LIMIT 201`).bind(identity.id, workspaceId).all<IdentityDenialRow>()).results : [];
  if (grants.results.length > 200 || denials.length > 200 || deniedByIdentityRows(denials, workspaceId, new Set([`workspace:${workspaceId}`]))) return null;
  const principals = (await database.prepare(`SELECT p.public_id,p.source_version,p.identity_id,p.email_hint,
      eligibility.identity_id eligible_identity,eligibility.principal_source_version eligible_version,eligibility.verified_email eligible_email
    FROM pa_portal_principals p LEFT JOIN portal_v2_identity_eligibility_bindings eligibility
      ON eligibility.workspace_id=p.workspace_id AND eligibility.principal_public_id=p.public_id AND eligibility.identity_id=?
    WHERE p.workspace_id=? AND p.status='active' AND (p.identity_id=? OR eligibility.identity_id=?) ORDER BY p.public_id LIMIT 201`)
    .bind(identity.id, workspaceId, identity.id, identity.id).all()).results;
  if (principals.length > 200) return null;
  const shellAllowed = allowedByEntitlementRows(grants.results.filter(g => g.capability === "workspace.view"), new Set([`workspace:${workspaceId}`]),[],true);
  if (!shellAllowed && !await eligiblePortalShell(env, identity.id, workspaceId)) return null;
  // Eligibility cannot override an explicit workspace.view deny.
  if (grants.results.some(g => g.capability === "workspace.view" && g.effect === "deny" && g.scope_type === "workspace" && g.scope_public_id === workspaceId)) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
    authority, identity.id, workspace, grants.results, denials, principals,
    env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED, env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED,
  ]))));
  return { workspaceId, sourceId: authority.sourceId, identityId: identity.id,
    displayName: workspace.display_name, rootType: workspace.root_type,
    rootPublicId: workspace.pa_organization_public_id ?? workspace.pa_client_public_id!,
    generationId: workspace.generation_id,membershipSourceVersion:workspace.membership_source_version,verifiedEmail:workspace.person_email,
    authority, workspace, grants: grants.results, denials,projectAccessTermsAvailable:termsReady,
    contextVersion: Array.from(digest, value => value.toString(16).padStart(2, "0")).join("") };
}

/** Evaluate only read capabilities against a freshly resolved native context. */
export async function authorizeNativePortalReadTarget(
  env: Env, context: NativePortalReadContext, capability: NativePortalReadCapability, target: PortalWorkspaceTarget,
): Promise<boolean> {
  if (!["workspace.view", "directory.read", "delivery.view"].includes(capability)) return false;
  const proof = (await readNativeTargetScopes(env,context,[target],{retention:'structural'})).get(`${target.scopeType}:${target.publicId}`);
  return Boolean(proof && nativePortalScopesAllowed(context,capability,proof.scopes,true,proof));
}

/** Same deny precedence as the primary adapter, evaluated once per bounded
 * native target batch. The context and target generation are rechecked by the caller. */
export function nativePortalScopesAllowed(context:NativePortalReadContext,capability:NativePortalReadCapability,scopes:ReadonlySet<string>,requireAllow=true,
  target?:NativeTargetScopes,retainedProjectId?:string):boolean {
  if(deniedByIdentityRows(context.denials,context.workspaceId,scopes))return false;
  const rules=context.grants.filter(g=>g.capability===capability);
  const expired=target?.proofRows.filter(row=>row.entity_type==='project'&&row.retained===0&&row.public_id!==retainedProjectId).map(row=>row.public_id)??[];
  const targetType=target?.proofRows[0]?.target_type;
  return requireAllow?allowedByEntitlementRows(rules,scopes,expired,capability==='workspace.view',
    capability==='delivery.view'||(capability==='directory.read'&&targetType==='project'))
    :!rules.some(g=>g.effect==='deny'&&scopes.has(`${g.scope_type}:${g.scope_public_id}`));
}

export async function nativePortalTargetPassesDenials(
  env: Env, context: NativePortalReadContext, capability: NativePortalReadCapability, target: PortalWorkspaceTarget,
): Promise<boolean> {
  const scopes=(await readNativeTargetScopes(env,context,[target])).get(`${target.scopeType}:${target.publicId}`)?.scopes;
  return Boolean(scopes&&nativePortalScopesAllowed(context,capability,scopes,false));
}

export interface EffectiveWorkspaceRequestProof {
  workspace: EffectivePortalWorkspaceContext;
  local: {
    role: "manager" | "member";
    can_view_billing: number;
    issuer: string;
    subject: string;
    project_allowed: number;
    project_public_id: string | null;
    bridge_priority: number;
  };
  rootAllowed: boolean;
  projectAllowed: boolean;
  /** Server-only selected-generation proof, not an authorization token. */
  authorityProof: string;
  /** Short-lived server-only facts used to repeat the effective request.create
   * decision inside the first D1 write. Browser input never supplies these. */
  mutationProof: EffectiveWorkspaceRequestMutationProof;
}

export interface EffectiveWorkspaceRequestMutationProof {
  workspaceId: string;
  identityId: string;
  issuer: string;
  subject: string;
  legacyAccountId: string;
  legacyIdentityId: string;
  localProjectId: string | null;
  projectPublicId: string | null;
  rootType: "organization" | "standalone_client";
  rootPublicId: string;
  activeGenerationId: string;
  sourceSequence: number;
  rootSourceVersion: string;
  membershipSourceVersion: string | null;
  targetScopes: string[];
  relationsEnabled: boolean;
  denylistEnabled: boolean;
  projectAccessTermsReady: boolean;
  allowedRequestEntitlementIds: string[];
  evaluatedAt: string;
  expiresAt: string;
}

export interface EffectiveWorkspaceRequestMutationGuard {
  sql: string;
  bindings: unknown[];
}

/**
 * Read-only, exact-workspace request proof. Unlike the login resolver, this
 * never provisions or repairs eligibility. It shares the existing target,
 * deny and entitlement evaluators, but loads common authority facts once.
 * Callers must obtain a second fresh proof before returning readiness.
 */
export async function readEffectiveWorkspaceRequestProof(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
  localProjectId: string | null,
): Promise<EffectiveWorkspaceRequestProof | null> {
  const evaluatedAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(evaluatedAt) + 30_000).toISOString();
  if (!portalHierarchyV2Enabled(env) || !validPrincipalPart(principal.issuer) ||
    !validPrincipalPart(principal.subject) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId)) return null;
  const database = env.DELIVERY_DB.withSession("first-primary");
  let compatibilityTables: Set<string> | null = null;
  const hasTable = (name: string) => compatibilityTables === null || compatibilityTables.has(name);
  async function inspectOptionalTables() {
    if (compatibilityTables !== null) return;
    const tables = await database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (
      'portal_v2_identity_eligibility_bindings','portal_v2_identity_eligibility_blocks',
      'portal_v2_identity_eligibility_legacy_bridges','portal_v2_legacy_member_bridges'
    )`).all<{ name: string }>();
    compatibilityTables = new Set(tables.results.map(table => table.name));
  }
  // These are the same identity/block, membership and selected complete-root
  // predicates used by resolveGlobalIdentity/activeWorkspace/activeRootExists.
  // Combining them avoids repeatedly resolving the same actor for each target.
  const readState = () => database.prepare(`SELECT workspace.id,workspace.root_type,
      workspace.pa_organization_public_id,workspace.pa_client_public_id,
      workspace.display_name,workspace.legacy_account_id,portal_identity.id identity_id,
      checkpoint.active_generation_id,generation.source_sequence,root.source_version root_source_version,
      membership.source_version membership_source_version,
      ${hasTable("portal_v2_identity_eligibility_bindings") && hasTable("portal_v2_identity_eligibility_legacy_bridges")
        ? `EXISTS(${eligiblePortalShellQuery(true, "workspace.id", "portal_identity.id")})` : "0"} shell_eligible
    FROM portal_v2_identities portal_identity
    JOIN portal_v2_workspace_memberships membership ON membership.identity_id=portal_identity.id
      AND membership.workspace_id=? AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    JOIN portal_v2_workspaces workspace ON workspace.id=membership.workspace_id AND workspace.status='active'
      AND workspace.legacy_account_id IS NOT NULL AND ${primaryWorkspaceAccount("workspace")}
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities root ON root.workspace_id=workspace.id
      AND root.generation_id=checkpoint.active_generation_id AND root.entity_type=workspace.root_type
      AND root.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) AND root.active=1
    WHERE portal_identity.issuer=? AND portal_identity.subject=? AND portal_identity.status='active' AND portal_identity.revoked_at IS NULL
      ${hasTable("portal_v2_identity_eligibility_blocks") ? `AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_blocks block
        WHERE block.status='active' AND datetime(block.valid_from)<=datetime('now')
          AND (block.expires_at IS NULL OR datetime(block.expires_at)>datetime('now'))
          AND ((block.match_type='issuer_subject' AND block.issuer=? AND block.subject=?)
            OR (block.match_type='email' AND block.normalized_email=?)))` : ""}`)
    .bind(workspaceId, principal.issuer, principal.subject,
      ...(hasTable("portal_v2_identity_eligibility_blocks")
        ? [principal.issuer, principal.subject, canonicalPrincipalEmail(principal.email) ?? ""] : []))
    .first<WorkspaceRow & {
      legacy_account_id: string; identity_id: string; active_generation_id: string;
      source_sequence: number; root_source_version: string; membership_source_version: string | null;
      shell_eligible: number;
    }>();
  let state: Awaited<ReturnType<typeof readState>>;
  try {
    state = await readState();
  } catch (error) {
    if (!/no such table:\s*(?:main\.)?portal_v2_identity_eligibility_(?:bindings|blocks|legacy_bridges)\b/i.test(
      error instanceof Error ? error.message : String(error),
    )) throw error;
    await inspectOptionalTables();
    state = await readState();
  }
  if (!state) return null;
  const verifiedState = state;

  // Preserve bridge priority, then independently intersect the active local
  // account/link/member conditions required by the actual request INSERTs.
  const readLocal = () => database.prepare(`WITH candidates(identity_id,priority) AS (
      ${hasTable("portal_v2_legacy_member_bridges") ? `SELECT legacy_identity_id,0 FROM portal_v2_legacy_member_bridges
        WHERE workspace_id=?1 AND identity_id=?2 AND legacy_account_id=?3 AND status='active' AND revoked_at IS NULL UNION ALL` : ""}
      ${hasTable("portal_v2_identity_eligibility_legacy_bridges") ? `SELECT legacy_identity_id,1 FROM portal_v2_identity_eligibility_legacy_bridges
        WHERE workspace_id=?1 AND identity_id=?2 AND legacy_account_id=?3 AND status='active' AND revoked_at IS NULL UNION ALL` : ""}
      SELECT id,2 FROM client_identity_links
        WHERE account_id=?3 AND issuer=?4 AND subject=?5 AND revoked_at IS NULL
    ) SELECT identity.id legacy_identity_id,candidates.priority bridge_priority,
      member.role,member.can_view_billing,identity.issuer,identity.subject,
      project.project_alpha_project_id project_public_id,
      CASE WHEN ?6 IS NULL THEN 1 ELSE EXISTS (
        SELECT 1 FROM client_project_grants grant_record
        WHERE grant_record.account_id=account.id AND grant_record.project_id=project.id
          AND project.active=1 AND ${primaryAlphaReference("project")} AND grant_record.revoked_at IS NULL AND grant_record.can_request_service=1
          AND (member.role='manager' OR EXISTS(SELECT 1 FROM client_member_project_grants member_grant
            WHERE member_grant.account_id=account.id AND member_grant.identity_id=identity.id
              AND member_grant.project_id=project.id AND member_grant.revoked_at IS NULL))
      ) END project_allowed
    FROM candidates
    JOIN client_accounts account ON account.id=?3 AND account.status='active' AND ${localOrPrimaryAlphaReference("account")}
    JOIN client_identity_links identity ON identity.id=candidates.identity_id
      AND identity.account_id=account.id AND identity.revoked_at IS NULL
    JOIN client_account_members member ON member.account_id=account.id AND member.identity_id=identity.id
      AND member.revoked_at IS NULL
    LEFT JOIN projects project ON project.id=?6
    ORDER BY candidates.priority,identity.id LIMIT 1`)
    .bind(workspaceId, verifiedState.identity_id, verifiedState.legacy_account_id, principal.issuer, principal.subject, localProjectId)
    .first<EffectiveWorkspaceRequestProof["local"] & { legacy_identity_id: string }>();
  let local: Awaited<ReturnType<typeof readLocal>>;
  try {
    local = await readLocal();
  } catch (error) {
    if (!/no such table:\s*(?:main\.)?(?:portal_v2_legacy_member_bridges|portal_v2_identity_eligibility_legacy_bridges)\b/i.test(
      error instanceof Error ? error.message : String(error),
    )) throw error;
    await inspectOptionalTables();
    local = await readLocal();
  }
  if (!local) return null;

  const requestTermsReady=await projectAccessTermsReady(database);
  const rules = await database.prepare(`SELECT * FROM (
      SELECT id,capability,effect,scope_type,scope_public_id,${projectAccessReadColumns('entitlement',requestTermsReady)} FROM portal_v2_entitlements entitlement
      WHERE workspace_id=?1 AND identity_id=?2 AND capability='workspace.view'
        AND status='active' AND revoked_at IS NULL AND datetime(valid_from)<=datetime('now')
        AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
        AND ${projectAccessCapacitySql('entitlement',requestTermsReady)}
      ORDER BY entitlement_version DESC,id LIMIT 201
    ) UNION ALL SELECT * FROM (
      SELECT id,capability,effect,scope_type,scope_public_id,${projectAccessReadColumns('entitlement',requestTermsReady)} FROM portal_v2_entitlements entitlement
      WHERE workspace_id=?1 AND identity_id=?2 AND capability='request.create'
        AND status='active' AND revoked_at IS NULL AND datetime(valid_from)<=datetime('now')
        AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
        AND ${projectAccessCapacitySql('entitlement',requestTermsReady)}
      ORDER BY entitlement_version DESC,id LIMIT 201
    )`).bind(workspaceId, state.identity_id)
    .all<EntitlementRow & { capability: "workspace.view" | "request.create" }>();
  const denials = portalIdentityDenylistEnabled(env) ? (await database.prepare(`
    SELECT workspace_id,scope_type,scope_public_id FROM portal_v2_identity_denials
    WHERE identity_id=? AND status='active' AND revoked_at IS NULL
      AND datetime(valid_from)<=datetime('now') AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
      AND (scope_type='global' OR workspace_id=?) ORDER BY id LIMIT 201`)
    .bind(state.identity_id, workspaceId).all<IdentityDenialRow>()).results : [];
  // Global denial always prevents resolving the identity, including when an
  // eligibility shell would otherwise bypass workspace.view permission.
  if (denials.length > 200 || denials.some(denial => denial.scope_type === "global")) return null;
  const contractAvailable = portalHierarchyRelationsEnabled(env) || await legacyTargetContractAvailable(database, workspaceId);
  const rootScopes = contractAvailable ? await targetScopes(
    env, state, { scopeType: "workspace", publicId: workspaceId }, database, true,
  ) : null;
  let expiredRequestProjects:string[]=[];
  const allows = (capability: "workspace.view" | "request.create", scopes: Set<string> | null): boolean =>
    scopes !== null && !deniedByIdentityRows(denials, workspaceId, scopes) &&
      allowedByEntitlementRows(rules.results.filter(rule => rule.capability === capability), scopes,
        [...scopes].some(scope=>scope.startsWith('project:'))?expiredRequestProjects:[],capability==='workspace.view');
  if (state.shell_eligible !== 1 && !allows("workspace.view", rootScopes)) return null;
  const projectScopes = contractAvailable && localProjectId && local.project_allowed === 1 && local.project_public_id
    ? await targetScopes(env, state, { scopeType: "project", publicId: local.project_public_id }, database, true,requestTermsReady?{retention:'structural'}:undefined)
    : null;
  if(projectScopes&&requestTermsReady)expiredRequestProjects=await readExpiredScopeProjects(database,workspaceId,projectScopes,portalHierarchyRelationsEnabled(env));
  const targetScopesForMutation = localProjectId ? projectScopes : rootScopes;
  if (!targetScopesForMutation) return null;
  return {
    workspace: {
      workspaceId, identityId: state.identity_id, rootType: state.root_type,
      rootPublicId: state.pa_organization_public_id ?? state.pa_client_public_id!,
      legacyAccountId: state.legacy_account_id, legacyIdentityId: local.legacy_identity_id,
      displayName: state.display_name, role: local.role, canViewBilling: local.can_view_billing === 1,
    },
    local,
    rootAllowed: allows("request.create", rootScopes),
    projectAllowed: allows("request.create", projectScopes),
    authorityProof: JSON.stringify([
      state.active_generation_id, state.source_sequence, state.root_source_version, state.membership_source_version,
      rules.results, denials, rootScopes && [...rootScopes].sort(), projectScopes && [...projectScopes].sort(),
    ]),
    mutationProof: {
      workspaceId,
      identityId: state.identity_id,
      issuer: principal.issuer,
      subject: principal.subject,
      legacyAccountId: state.legacy_account_id,
      legacyIdentityId: local.legacy_identity_id,
      localProjectId,
      projectPublicId: localProjectId ? local.project_public_id : null,
      rootType: state.root_type,
      rootPublicId: state.pa_organization_public_id ?? state.pa_client_public_id!,
      activeGenerationId: state.active_generation_id,
      sourceSequence: state.source_sequence,
      rootSourceVersion: state.root_source_version,
      membershipSourceVersion: state.membership_source_version,
      targetScopes: [...targetScopesForMutation].sort(),
      relationsEnabled: portalHierarchyRelationsEnabled(env),
      denylistEnabled: portalIdentityDenylistEnabled(env),
      projectAccessTermsReady: requestTermsReady,
      allowedRequestEntitlementIds: rules.results.filter(rule => rule.id && rule.capability === "request.create"
        && rule.effect === "allow" && targetScopesForMutation.has(`${rule.scope_type}:${rule.scope_public_id}`)
        && projectAccessRowAllows(rule, targetScopesForMutation, localProjectId ? expiredRequestProjects : []))
        .map(rule => rule.id!),
      evaluatedAt,
      expiresAt,
    },
  };
}

/**
 * Repeats the bounded hierarchy-v2 request.create decision in the first D1
 * mutation. This is deliberately an additional predicate on the legacy write
 * guards: it cannot provision membership, infer a project, or turn an
 * eligibility shell into request authority.
 */
export function effectiveWorkspaceRequestMutationGuardSql(
  proof: EffectiveWorkspaceRequestMutationProof,
): EffectiveWorkspaceRequestMutationGuard {
  const scopesJson = JSON.stringify(proof.targetScopes);
  const allowedEntitlementIdsJson = JSON.stringify(proof.allowedRequestEntitlementIds);
  const lineageBindings: unknown[] = [];
  let lineageSql = "1=1";
  if (proof.localProjectId !== null && proof.projectPublicId !== null) {
    if (proof.relationsEnabled) {
      lineageSql = `EXISTS (
        WITH RECURSIVE lineage(entity_type,public_id,depth) AS (
          SELECT entity.entity_type,entity.public_id,0
          FROM portal_v2_directory_entities entity
          WHERE entity.workspace_id=? AND entity.generation_id=?
            AND entity.entity_type='project' AND entity.public_id=? AND entity.active=1
          UNION
          SELECT relation.from_type,relation.from_public_id,lineage.depth+1
          FROM lineage
          JOIN portal_v2_directory_relations relation ON relation.workspace_id=?
            AND relation.generation_id=? AND relation.active=1
            AND relation.to_type=lineage.entity_type AND relation.to_public_id=lineage.public_id
          JOIN portal_v2_directory_entities parent ON parent.workspace_id=relation.workspace_id
            AND parent.generation_id=relation.generation_id AND parent.entity_type=relation.from_type
            AND parent.public_id=relation.from_public_id AND parent.active=1
          WHERE lineage.depth<12
        ) SELECT 1 WHERE (SELECT COUNT(*) FROM lineage) BETWEEN 1 AND 64
          AND (SELECT MAX(depth) FROM lineage)<12
          AND EXISTS(SELECT 1 FROM lineage WHERE entity_type=? AND public_id=?)
          AND NOT EXISTS(SELECT 1 FROM lineage WHERE (entity_type || ':' || public_id)
            NOT IN (SELECT value FROM json_each(?)))
          AND NOT EXISTS(SELECT 1 FROM json_each(?) expected
            WHERE expected.value<>? AND NOT EXISTS(SELECT 1 FROM lineage
              WHERE (entity_type || ':' || public_id)=expected.value))
      )`;
      lineageBindings.push(
        proof.workspaceId, proof.activeGenerationId, proof.projectPublicId,
        proof.workspaceId, proof.activeGenerationId, proof.rootType, proof.rootPublicId,
        scopesJson, scopesJson, `workspace:${proof.workspaceId}`,
      );
    } else {
      lineageSql = `EXISTS (
        WITH RECURSIVE lineage(entity_type,public_id,parent_public_id,depth) AS (
          SELECT entity.entity_type,entity.public_id,entity.parent_public_id,0
          FROM portal_v2_directory_entities entity
          WHERE entity.workspace_id=? AND entity.generation_id=?
            AND entity.entity_type='project' AND entity.public_id=? AND entity.active=1
          UNION ALL
          SELECT parent.entity_type,parent.public_id,parent.parent_public_id,lineage.depth+1
          FROM lineage JOIN portal_v2_directory_entities parent
            ON parent.workspace_id=? AND parent.generation_id=?
            AND parent.public_id=lineage.parent_public_id AND parent.active=1
          WHERE lineage.parent_public_id IS NOT NULL AND lineage.depth<8
        ) SELECT 1 WHERE (SELECT COUNT(*) FROM lineage) BETWEEN 1 AND 9
          AND (SELECT MAX(depth) FROM lineage)<8
          AND EXISTS(SELECT 1 FROM lineage WHERE entity_type=? AND public_id=?)
          AND NOT EXISTS(SELECT 1 FROM lineage WHERE (entity_type || ':' || public_id)
            NOT IN (SELECT value FROM json_each(?)))
          AND NOT EXISTS(SELECT 1 FROM json_each(?) expected
            WHERE expected.value<>? AND NOT EXISTS(SELECT 1 FROM lineage
              WHERE (entity_type || ':' || public_id)=expected.value))
      )`;
      lineageBindings.push(
        proof.workspaceId, proof.activeGenerationId, proof.projectPublicId,
        proof.workspaceId, proof.activeGenerationId, proof.rootType, proof.rootPublicId,
        scopesJson, scopesJson, `workspace:${proof.workspaceId}`,
      );
    }
  }

  const denialSql = proof.denylistEnabled ? `AND NOT EXISTS (
      SELECT 1 FROM portal_v2_identity_denials denial
      WHERE denial.identity_id=identity.id AND denial.status='active' AND denial.revoked_at IS NULL
        AND datetime(denial.valid_from)<=datetime('now')
        AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
        AND (denial.scope_type='global' OR (denial.workspace_id=workspace.id
          AND denial.scope_public_id IS NOT NULL
          AND (denial.scope_type || ':' || denial.scope_public_id) IN (SELECT value FROM json_each(?))))
    )` : "";
  const denialBindings = proof.denylistEnabled ? [scopesJson] : [];
  const termsSql = proof.projectAccessTermsReady ? `AND ${projectAccessTermsSql({
    termsId: "entitlement.access_terms_id",
    workspaceId: "entitlement.workspace_id",
    projectId: "(SELECT project_public_id FROM portal_project_access_terms WHERE id=entitlement.access_terms_id)",
    legacyRetained: "1",
  })} AND (entitlement.access_terms_id IS NULL OR EXISTS(
    SELECT 1 FROM portal_project_access_terms access_target
    WHERE access_target.id=entitlement.access_terms_id
      AND ('project:' || access_target.project_public_id) IN (SELECT value FROM json_each(?))
  ))` : "";
  const termsBindings = proof.projectAccessTermsReady ? [scopesJson] : [];
  const entitlementBase = `entitlement.workspace_id=workspace.id AND entitlement.identity_id=identity.id
    AND entitlement.capability='request.create' AND entitlement.status='active' AND entitlement.revoked_at IS NULL
    AND datetime(entitlement.valid_from)<=datetime('now')
    AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
    AND (entitlement.scope_type || ':' || entitlement.scope_public_id) IN (SELECT value FROM json_each(?))`;

  return {
    sql: `EXISTS (
      SELECT 1 FROM portal_v2_identities identity
      JOIN portal_v2_workspace_memberships membership ON membership.identity_id=identity.id
        AND membership.workspace_id=? AND membership.status='active' AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
      JOIN portal_v2_workspaces workspace ON workspace.id=membership.workspace_id
        AND workspace.status='active' AND workspace.legacy_account_id=? AND ${primaryWorkspaceAccount("workspace")}
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
        AND checkpoint.active_generation_id=? AND checkpoint.source_sequence=?
      JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
        AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
        AND generation.source_sequence=?
      JOIN portal_v2_directory_entities root ON root.workspace_id=workspace.id
        AND root.generation_id=checkpoint.active_generation_id AND root.entity_type=?
        AND root.public_id=? AND root.source_version=? AND root.active=1
      WHERE identity.id=? AND identity.issuer=? AND identity.subject=?
        AND identity.status='active' AND identity.revoked_at IS NULL
        AND membership.source_version IS ?
        AND datetime(?)<=datetime('now') AND datetime(?)>datetime('now')
        AND ${lineageSql}
        AND (? IS NULL OR EXISTS(
          SELECT 1 FROM projects local_project
          JOIN client_project_grants local_grant ON local_grant.project_id=local_project.id
            AND local_grant.account_id=workspace.legacy_account_id AND local_grant.revoked_at IS NULL
            AND local_grant.can_request_service=1
          WHERE local_project.id=? AND local_project.active=1
            AND ${primaryAlphaReference("local_project")}
            AND local_project.project_alpha_project_id=?
        ))
        ${denialSql}
        AND (SELECT COUNT(*) FROM portal_v2_entitlements counted
          WHERE counted.workspace_id=workspace.id AND counted.identity_id=identity.id
            AND counted.capability='request.create' AND counted.status='active' AND counted.revoked_at IS NULL
            AND datetime(counted.valid_from)<=datetime('now')
            AND (counted.expires_at IS NULL OR datetime(counted.expires_at)>datetime('now')))<=200
        AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement
          WHERE ${entitlementBase} AND entitlement.effect='deny')
        AND EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement
          WHERE ${entitlementBase} AND entitlement.effect='allow'
            AND entitlement.id IN (SELECT value FROM json_each(?)) ${termsSql})
    )`,
    bindings: [
      proof.workspaceId, proof.legacyAccountId, proof.activeGenerationId, proof.sourceSequence,
      proof.sourceSequence, proof.rootType, proof.rootPublicId, proof.rootSourceVersion,
      proof.identityId, proof.issuer, proof.subject, proof.membershipSourceVersion,
      proof.evaluatedAt, proof.expiresAt,
      ...lineageBindings,
      proof.localProjectId, proof.localProjectId, proof.projectPublicId,
      ...denialBindings,
      scopesJson,
      scopesJson, allowedEntitlementIdsJson, ...termsBindings,
    ],
  };
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
    JOIN portal_v2_workspaces w ON w.id=m.workspace_id AND w.status='active' AND ${primaryWorkspaceAccount("w")}
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
  if (await nativePortalSourceSchemaAvailable(env)) {
    const native = await env.DELIVERY_DB.withSession('first-primary').prepare(`SELECT w.id
      FROM portal_v2_workspace_memberships m JOIN portal_v2_workspaces w ON w.id=m.workspace_id
      JOIN pa_portal_source_authorities a ON a.source_id=w.project_alpha_source_id AND a.state='active'
      WHERE m.identity_id=? AND m.status='active' AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR datetime(m.expires_at)>datetime('now'))
        AND w.status='active' AND w.legacy_account_id IS NULL ORDER BY w.id LIMIT 33`)
      .bind(identity.id).all<{id:string}>();
    if (native.results.length > 32) return [];
    for (const row of native.results) {
      const context = await resolveNativePortalWorkspaceReadContext(env, principal, row.id);
      if (context) authorized.push({id:context.workspaceId,rootType:context.rootType,rootPublicId:context.rootPublicId,
        displayName:context.displayName,resourceMode:'native',sourceId:context.sourceId});
    }
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
    const projectIds=result.results.filter(row=>row.entity_type==='project').map(row=>row.public_id);
    const termGrants=await readPrimaryTermRetentionGrants(env,principal,workspaceId,projectIds);
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
      new Set(termGrants.map(row=>row.projectId)),
    );
    if (!authorized) return null;
    visible = result.results.filter(row => authorized.has(`${row.entity_type}:${row.public_id}`));
    if(termGrants.length&&JSON.stringify(await readPrimaryTermRetentionGrants(env,principal,workspaceId,projectIds))!==JSON.stringify(termGrants))return null;
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

type SecondaryAcceptanceDelegation=Awaited<ReturnType<typeof captureWorkspaceInvitationDelegation>>;
async function captureSecondaryInvitationAcceptanceDelegation(
  env:Env,invitationId:string,
):Promise<SecondaryAcceptanceDelegation|null>{
  const context=await portalDb(env).prepare(`SELECT binding.inviter_identity_id,binding.inviter_issuer,
      binding.inviter_subject,binding.inviter_email,binding.grant_manifest_json,workspace.id workspace_id,
      workspace.root_type,COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) root_public_id,
      membership.source_version
    FROM portal_secondary_workspace_invitation_authority binding
    JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id
      AND workspace.project_alpha_source_id=binding.source_id AND workspace.status='active'
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=workspace.id
      AND membership.identity_id=binding.inviter_identity_id AND membership.source_type='project_alpha'
    WHERE binding.invitation_id=?`).bind(invitationId).first<{inviter_identity_id:string;inviter_issuer:string;
      inviter_subject:string;inviter_email:string;grant_manifest_json:string|null;workspace_id:string;
      root_type:'organization'|'standalone_client';root_public_id:string;source_version:string}>();
  if(!context)return null;
  const grants=(await portalDb(env).prepare(`SELECT capability,scope_type,scope_public_id,access_terms_id
    FROM portal_v2_invitation_entitlements WHERE invitation_id=?
    ORDER BY capability,scope_type,scope_public_id LIMIT 6`).bind(invitationId)
    .all<{capability:PortalWorkspaceCapability;scope_type:PortalWorkspaceScopeType;scope_public_id:string;access_terms_id:string|null}>()).results;
  if(grants.length<1||grants.length>4)return null;
  if(context.grant_manifest_json!==JSON.stringify(grants))return null;
  const shell=grants.filter(grant=>grant.capability==='workspace.view'&&grant.scope_type==='workspace'
    &&grant.scope_public_id===context.workspace_id);
  if(shell.length!==1)return null;
  const delegated=grants.filter(grant=>grant!==shell[0]);
  const targets=new Set(delegated.map(grant=>`${grant.scope_type}:${grant.scope_public_id}`));
  if(targets.size>1)return null;
  const target=delegated[0]
    ?{scopeType:delegated[0].scope_type,publicId:delegated[0].scope_public_id}
    :{scopeType:'workspace' as const,publicId:context.workspace_id};
  const termIds=[...new Set(grants.map(grant=>grant.access_terms_id).filter((id):id is string=>Boolean(id)))];
  if(termIds.length>1)return null;
  const terms=termIds[0]?await readProjectAccessTerms(portalDb(env),termIds[0]):null;
  if(termIds[0]&&!terms)return null;
  const required=[{capability:'member.manage' as PortalWorkspaceCapability,
      target:{scopeType:'workspace' as const,publicId:context.workspace_id}},
    ...grants.map(grant=>({capability:grant.capability,
    target:{scopeType:grant.scope_type,publicId:grant.scope_public_id}})),
    ...[...new Map(grants.filter(grant=>grant.scope_type!=='workspace')
      .map(grant=>[`${grant.scope_type}:${grant.scope_public_id}`,{scopeType:grant.scope_type,publicId:grant.scope_public_id}])).values()]
      .map(target=>({capability:'member.manage' as PortalWorkspaceCapability,target}))];
  for(const requirement of required){
    if(requirement.target.scopeType==='workspace'){
      if(requirement.target.publicId!==context.workspace_id)return null;
      const allowed=await portalDb(env).prepare(`SELECT 1 ok FROM portal_v2_entitlements allow_record
        WHERE allow_record.workspace_id=? AND allow_record.identity_id=? AND allow_record.capability=?
          AND allow_record.effect='allow' AND allow_record.scope_type='workspace' AND allow_record.scope_public_id=?
          AND allow_record.source_type='project_alpha' AND allow_record.source_version=?
          AND allow_record.status='active' AND allow_record.revoked_at IS NULL
          AND datetime(allow_record.valid_from)<=datetime('now') AND allow_record.expires_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements deny_record
            WHERE deny_record.workspace_id=allow_record.workspace_id AND deny_record.identity_id=allow_record.identity_id
              AND deny_record.capability=allow_record.capability AND deny_record.effect='deny'
              AND deny_record.scope_type='workspace' AND deny_record.scope_public_id=allow_record.workspace_id
              AND deny_record.status='active' AND deny_record.revoked_at IS NULL
              AND datetime(deny_record.valid_from)<=datetime('now')
              AND (deny_record.expires_at IS NULL OR datetime(deny_record.expires_at)>datetime('now'))) LIMIT 1`)
        .bind(context.workspace_id,context.inviter_identity_id,requirement.capability,context.workspace_id,context.source_version).first('ok');
      if(allowed===null)return null;
    }else{
      const authorized=await resolvePortalRelationAuthorizedTargets(env,{id:context.workspace_id,rootType:context.root_type,
        rootPublicId:context.root_public_id},context.inviter_identity_id,requirement.capability,[requirement.target]);
      if(!authorized?.has(`${requirement.target.scopeType}:${requirement.target.publicId}`))return null;
    }
  }
  try{return await captureWorkspaceInvitationDelegation(env,{workspaceId:context.workspace_id,target,
      identityId:context.inviter_identity_id,issuer:context.inviter_issuer,subject:context.inviter_subject,
      email:context.inviter_email},delegated.map(grant=>grant.capability),terms);}
  catch(error){if(error instanceof HTTPException&&error.status===403)return null;throw error;}
}

/** Accepts only for the authenticated verified email. Replays by the same
 * identity are idempotent; a different identity cannot take over the token. */
export async function acceptPortalWorkspaceInvitation(
  env: Env,
  principal: VerifiedClientPrincipal,
  token: string,
): Promise<InvitationAcceptance> {
  requireProjectAccessAuthorityMutations(env);
  if (!portalHierarchyV2Enabled(env) || env.CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED !== "true") return "denied";
  const tokenHash = await hashPortalInvitationToken(token);
  const normalizedEmail = principal.email?.trim().toLocaleLowerCase("en-US");
  if (!tokenHash || !normalizedEmail || !validPrincipalPart(principal.issuer) || !validPrincipalPart(principal.subject)) return "denied";
  // Email narrows this one invitation only. The durable authorization subject
  // is always the provider-verified issuer + subject pair.
  type AcceptanceInvitation={id:string;workspace_id:string;status:string;accepted_by_identity_id:string|null;source_id:string;secondary_context_hash:string|null};
  const database=portalDb(env);
  let invitation=await database.prepare(`SELECT invitation.id,invitation.workspace_id,invitation.status,invitation.accepted_by_identity_id,
      workspace.project_alpha_source_id source_id,NULL secondary_context_hash
    FROM portal_v2_invitations invitation
    JOIN portal_v2_workspaces workspace ON workspace.id=invitation.workspace_id AND workspace.status='active'
    WHERE invitation.token_hash=? AND lower(invitation.invited_email)=?
      AND ${primaryWorkspaceAccount("workspace")}`)
    .bind(tokenHash, normalizedEmail)
    .first<AcceptanceInvitation>();
  if(!invitation){
    try{
      invitation=await database.prepare(`SELECT invitation.id,invitation.workspace_id,invitation.status,invitation.accepted_by_identity_id,
          workspace.project_alpha_source_id source_id,binding.context_hash secondary_context_hash
        FROM portal_v2_invitations invitation
        JOIN portal_v2_workspaces workspace ON workspace.id=invitation.workspace_id AND workspace.status='active'
          AND workspace.legacy_account_id IS NULL
        JOIN portal_secondary_workspace_invitation_authority binding ON binding.invitation_id=invitation.id
          AND binding.workspace_id=invitation.workspace_id AND binding.source_id=workspace.project_alpha_source_id
        JOIN pa_portal_source_authorities authority ON authority.source_id=binding.source_id AND authority.state='active'
          AND authority.active_revision=binding.authority_revision AND authority.version=binding.authority_version
          AND authority.connector_revision=binding.connector_revision AND authority.connector_version=binding.connector_version
        JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id AND revision.revision=authority.active_revision
        JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
          AND checkpoint.active_generation_id=binding.generation_id AND checkpoint.source_sequence=binding.source_sequence
        JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=workspace.id
          AND generation.status='active' AND generation.complete=1 AND generation.source_sequence=checkpoint.source_sequence
        WHERE invitation.token_hash=? AND lower(invitation.invited_email)=?
          AND ${secondaryInvitationInviterIsCurrent}`)
        .bind(tokenHash,normalizedEmail).first<AcceptanceInvitation>();
    }catch(error){
      if(isMissingSecondaryMembershipSchema(error))return 'denied';
      throw error;
    }
  }
  if (!invitation) return "denied";
  const accessTermsReady=await projectAccessTermsReady(portalDb(env));
  const accessHistoryReady=await projectAccessAuthorityHistoryReady(portalDb(env));
  const approvalReady=await invitationRequestsReady(portalDb(env));
  if(approvalReady){if(!await invitationPublicationAllowed(portalDb(env),invitation.id))return 'denied';}
  else if(accessTermsReady&&(await readWorkspaceInvitationPolicy(portalDb(env),invitation.workspace_id)).mode!=='allowed')return 'denied';
  let identity = await portalDb(env).prepare(`SELECT id FROM portal_v2_identities
    WHERE issuer=? AND subject=? AND status='active' AND revoked_at IS NULL AND lower(verified_email)=?`)
    .bind(principal.issuer, principal.subject, normalizedEmail).first<IdentityRow>();
  try{
    const enrollmentBlocked=await portalDb(env).prepare(`SELECT 1 ok FROM portal_v2_identity_eligibility_blocks
      WHERE status='active' AND datetime(valid_from)<=datetime('now')
        AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
        AND ((match_type='issuer_subject' AND issuer=? AND subject=?) OR (match_type='email' AND normalized_email=?)) LIMIT 1`)
      .bind(principal.issuer,principal.subject,normalizedEmail).first('ok');
    if(enrollmentBlocked!==null)return 'denied';
  }catch(error){
    if(!/no such table:\s*(?:main\.)?portal_v2_identity_eligibility_blocks\b/i.test(error instanceof Error?error.message:String(error)))throw error;
  }
  if (invitation.status === "accepted")
    return identity && invitation.accepted_by_identity_id === identity.id ? "replayed" : "denied";
  if (invitation.status !== "pending") return "denied";
  let secondaryDelegation:SecondaryAcceptanceDelegation|null=null;
  try{secondaryDelegation=invitation.secondary_context_hash
    ?await captureSecondaryInvitationAcceptanceDelegation(env,invitation.id):null;}
  catch(error){if(isMissingSecondaryMembershipSchema(error))return 'denied';throw error;}
  if(invitation.secondary_context_hash&&!secondaryDelegation)return 'denied';

  const trackedApproval=approvalReady&&(await portalDb(env).prepare('SELECT 1 ok FROM portal_workspace_invitation_approvals WHERE invitation_id=?').bind(invitation.id).first('ok'))!==null;
  const requireEnrollmentReceipt = trackedApproval || env.CLIENT_PORTAL_ACCESS_ENROLLMENT_READY === "true";
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
  const membershipAuditId=crypto.randomUUID();
  const secondaryDelegationFenceId=secondaryDelegation?`secondary-accept-delegation-${invitation.id}`:null;
  const enrollmentAcceptanceGuard=requireEnrollmentReceipt?`AND EXISTS (
    SELECT 1 FROM portal_v2_invitation_access_enrollment_receipts receipt
    JOIN portal_v2_invitation_email_outbox outbox ON outbox.invitation_id=invitation.id
      AND outbox.recipient_email_hash=receipt.invited_email_hash
    WHERE receipt.invitation_id=invitation.id AND receipt.workspace_id=invitation.workspace_id
      AND receipt.invitation_token_hash=invitation.token_hash AND receipt.revoked_at IS NULL
      AND datetime(receipt.enrolled_at)<=datetime('now') AND datetime(receipt.expires_at)>datetime('now'))`:'';
  const acceptanceUpdate=invitation.secondary_context_hash
    ?database.prepare(`UPDATE portal_v2_invitations AS invitation
      SET status='accepted',accepted_at=datetime('now'),accepted_by_identity_id=?
      WHERE id=? AND status='pending' AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')
        AND EXISTS(SELECT 1 FROM portal_v2_workspaces workspace
          JOIN portal_secondary_workspace_invitation_authority binding ON binding.invitation_id=invitation.id
            AND binding.workspace_id=workspace.id AND binding.source_id=workspace.project_alpha_source_id
          JOIN pa_portal_source_authorities authority ON authority.source_id=binding.source_id AND authority.state='active'
            AND authority.active_revision=binding.authority_revision AND authority.version=binding.authority_version
            AND authority.connector_revision=binding.connector_revision AND authority.connector_version=binding.connector_version
          JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id AND revision.revision=authority.active_revision
          JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
            AND checkpoint.active_generation_id=binding.generation_id AND checkpoint.source_sequence=binding.source_sequence
          JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
            AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
            AND generation.source_sequence=checkpoint.source_sequence
          WHERE workspace.id=invitation.workspace_id AND workspace.status='active' AND workspace.legacy_account_id IS NULL
            AND ${secondaryInvitationInviterIsCurrent})
        AND EXISTS(SELECT 1 FROM portal_project_invitation_fences delegation_fence WHERE delegation_fence.id=?)
        AND NOT EXISTS(SELECT 1 FROM portal_v2_workspace_memberships membership
          WHERE membership.workspace_id=invitation.workspace_id AND membership.identity_id=?)
        ${enrollmentAcceptanceGuard}`).bind(identity.id,invitation.id,secondaryDelegationFenceId,identity.id)
    :database.prepare(`UPDATE portal_v2_invitations AS invitation
      SET status='accepted',accepted_at=datetime('now'),accepted_by_identity_id=?
      WHERE id=? AND status='pending' AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')
        AND EXISTS(SELECT 1 FROM portal_v2_workspaces workspace WHERE workspace.id=invitation.workspace_id
          AND workspace.status='active' AND ${primaryWorkspaceAccount('workspace')})
        AND NOT EXISTS(SELECT 1 FROM portal_v2_workspace_memberships membership
          WHERE membership.workspace_id=invitation.workspace_id AND membership.identity_id=?
            AND (membership.source_type<>'client_invitation' OR membership.status<>'active'
              OR membership.revoked_at IS NOT NULL
              OR (membership.expires_at IS NOT NULL AND datetime(membership.expires_at)<=datetime('now'))))
        ${enrollmentAcceptanceGuard}`).bind(identity.id,invitation.id,identity.id);
  const membershipInsert=invitation.secondary_context_hash
    ?database.prepare(`INSERT INTO portal_v2_workspace_memberships
      (id,workspace_id,identity_id,source_type,status,source_version)
      SELECT 'invitation-membership-' || invitation.id,invitation.workspace_id,?,'client_invitation','active',binding.context_hash
      FROM portal_v2_invitations invitation
      JOIN portal_secondary_workspace_invitation_authority binding ON binding.invitation_id=invitation.id
      WHERE invitation.id=? AND invitation.status='accepted' AND invitation.accepted_by_identity_id=?
      ON CONFLICT(workspace_id,identity_id) DO NOTHING`).bind(identity.id,invitation.id,identity.id)
    :database.prepare(`INSERT INTO portal_v2_workspace_memberships
      (id,workspace_id,identity_id,source_type,status,source_version)
      SELECT 'invitation-membership-' || invitation.id,invitation.workspace_id,?,'client_invitation','active',NULL
      FROM portal_v2_invitations invitation
      WHERE invitation.id=? AND invitation.status='accepted' AND invitation.accepted_by_identity_id=?
      ON CONFLICT(workspace_id,identity_id) DO NOTHING`).bind(identity.id,invitation.id,identity.id);
  try{await database.batch([
    ...(secondaryDelegation?[secondaryDelegation.fence(secondaryDelegationFenceId!)]:[]),
    ...(invitation.secondary_context_hash?[database.prepare(`INSERT INTO portal_secondary_workspace_membership_fences(id,write_guard)
      VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM portal_secondary_workspace_invitation_authority binding
        JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id AND workspace.status='active'
          AND workspace.legacy_account_id IS NULL AND workspace.project_alpha_source_id=binding.source_id
        JOIN pa_portal_source_authorities authority ON authority.source_id=binding.source_id AND authority.state='active'
          AND authority.active_revision=binding.authority_revision AND authority.version=binding.authority_version
          AND authority.connector_revision=binding.connector_revision AND authority.connector_version=binding.connector_version
        JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id AND revision.revision=authority.active_revision
        JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
          AND checkpoint.active_generation_id=binding.generation_id AND checkpoint.source_sequence=binding.source_sequence
        JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
          AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
          AND generation.source_sequence=checkpoint.source_sequence
        WHERE binding.invitation_id=? AND binding.context_hash=?
          AND ${secondaryInvitationInviterIsCurrent}) THEN 1 ELSE 0 END)`)
      .bind(`secondary-accept-${crypto.randomUUID()}`,invitation.id,invitation.secondary_context_hash)]:[]),
    acceptanceUpdate,
    membershipInsert,
    portalDb(env).prepare(`INSERT OR IGNORE INTO portal_v2_entitlements
      (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,status,entitlement_version${accessTermsReady?',access_terms_id':''})
      SELECT 'invitation-entitlement-' || invitation.id || '-' || grants.capability || '-' || grants.scope_type || '-' || grants.scope_public_id,
        invitation.workspace_id,?,grants.capability,'allow',grants.scope_type,grants.scope_public_id,'client_invitation','active',
        ${accessTermsReady?`CASE WHEN ${trackedApproval?'0':'grants.access_terms_id IS NULL'} THEN 1 ELSE (SELECT COALESCE(MAX(prior.entitlement_version),0)+1
          FROM portal_v2_entitlements prior WHERE prior.workspace_id=invitation.workspace_id AND prior.identity_id=membership.identity_id
            AND prior.capability=grants.capability AND prior.effect='allow' AND prior.scope_type=grants.scope_type
            AND prior.scope_public_id=grants.scope_public_id) END,grants.access_terms_id`:'1'}
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
        AND workspace.status='active' AND workspace.project_alpha_source_id='project-alpha:primary'
        AND workspace.legacy_account_id IS NOT NULL
      JOIN portal_v2_identities identity ON identity.id=invitation.accepted_by_identity_id
        AND identity.status='active' AND identity.revoked_at IS NULL
      WHERE invitation.id=? AND invitation.status='accepted' AND invitation.accepted_by_identity_id=?`)
      .bind(invitation.id, identity.id),
    portalDb(env).prepare(`INSERT OR IGNORE INTO client_account_members
      (account_id,identity_id,role,can_view_billing)
      SELECT workspace.legacy_account_id,link.id,'member',0
      FROM portal_v2_invitations invitation
      JOIN portal_v2_workspaces workspace ON workspace.id=invitation.workspace_id
        AND workspace.status='active' AND workspace.project_alpha_source_id='project-alpha:primary'
        AND workspace.legacy_account_id IS NOT NULL
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
        AND workspace.status='active' AND workspace.project_alpha_source_id='project-alpha:primary'
        AND workspace.legacy_account_id IS NOT NULL
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
      JOIN portal_v2_workspaces primary_workspace ON primary_workspace.id=bridge.workspace_id
        AND primary_workspace.project_alpha_source_id='project-alpha:primary'
        AND primary_workspace.legacy_account_id=bridge.legacy_account_id
      JOIN client_project_grants grant_record ON grant_record.account_id=bridge.legacy_account_id
        AND grant_record.revoked_at IS NULL
      JOIN projects project ON project.id=grant_record.project_id AND ${primaryAlphaReference("project")}
      WHERE bridge.workspace_id=? AND bridge.identity_id=? AND bridge.status='active'`)
      .bind(invitation.workspace_id, identity.id),
    portalDb(env).prepare(`INSERT INTO portal_v2_membership_audit
      (id,workspace_id,actor_identity_id,action,subject_identity_id,invitation_id)
      SELECT ?,workspace_id,?,'invitation.accepted',?,id FROM portal_v2_invitations
      WHERE id=? AND status='accepted' AND accepted_by_identity_id=?
        AND NOT EXISTS (SELECT 1 FROM portal_v2_membership_audit audit WHERE audit.invitation_id=? AND audit.action='invitation.accepted')`)
       .bind(membershipAuditId, identity.id, identity.id, invitation.id, identity.id, invitation.id),
    ...(accessHistoryReady?[projectAccessInvitationEvent(portalDb(env),{invitationId:invitation.id,eventKind:'invitation_accepted',
      producerEventKey:`membership:${membershipAuditId}`,actor:{type:'identity',id:identity.id},subjectIdentityId:identity.id,
      requiredMembershipAuditId:membershipAuditId})]:[]),
  ]);}catch(error){
    if(error instanceof Error&&/portal invitation policy|portal access terms|portal project access terms/.test(error.message))return 'denied';
    const current=await portalDb(env).prepare(`SELECT status,accepted_by_identity_id,expires_at FROM portal_v2_invitations WHERE id=?`)
      .bind(invitation.id).first<{status:string;accepted_by_identity_id:string|null;expires_at:string}>();
    if(current?.status==='accepted')return current.accepted_by_identity_id===identity.id?'accepted':'denied';
    if(!current||current.status!=='pending'||Date.parse(current.expires_at)<=Date.now())return 'denied';
    throw new HTTPException(503,{message:'Invitation acceptance could not be recorded',cause:error});
  }
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
