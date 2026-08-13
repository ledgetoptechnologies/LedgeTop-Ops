import type { Env } from "../types";
import type { VerifiedClientPrincipal } from "./types";

export const PORTAL_HIERARCHY_V2_FLAG = "CLIENT_PORTAL_HIERARCHY_V2_ENABLED";

export type PortalWorkspaceCapability =
  | "workspace.view"
  | "directory.read"
  | "delivery.view"
  | "request.create"
  | "member.manage"
  | "delegated_share.create";

export type PortalWorkspaceScopeType =
  | "workspace"
  | "organization"
  | "department"
  | "client"
  | "project"
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
}
interface EntitlementRow {
  effect: "allow" | "deny";
  scope_type: PortalWorkspaceScopeType;
  scope_public_id: string;
}
interface ScopeRow { entity_type: PortalWorkspaceScopeType; public_id: string }

function portalDb(env: Env): D1Database {
  return env.DELIVERY_DB;
}

export function portalHierarchyV2Enabled(env: Env): boolean {
  return env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED === "true";
}

function validPrincipalPart(value: string): boolean {
  return value.length >= 1 && value.length <= 512;
}

async function resolveGlobalIdentity(
  env: Env,
  principal: VerifiedClientPrincipal,
): Promise<IdentityRow | null> {
  if (!validPrincipalPart(principal.issuer) || !validPrincipalPart(principal.subject)) return null;
  return portalDb(env)
    .prepare(`SELECT id FROM portal_v2_identities
      WHERE issuer=? AND subject=? AND status='active' AND revoked_at IS NULL`)
    .bind(principal.issuer, principal.subject)
    .first<IdentityRow>();
}

async function activeWorkspace(
  env: Env,
  identityId: string,
  workspaceId: string,
): Promise<WorkspaceRow | null> {
  return portalDb(env).prepare(`
    SELECT w.id,w.root_type,w.pa_organization_public_id,w.pa_client_public_id,w.display_name
    FROM portal_v2_workspaces w
    JOIN portal_v2_workspace_memberships m
      ON m.workspace_id=w.id AND m.identity_id=? AND m.status='active' AND m.revoked_at IS NULL
      AND (m.expires_at IS NULL OR datetime(m.expires_at)>datetime('now'))
    WHERE w.id=? AND w.status='active'`)
    .bind(identityId, workspaceId)
    .first<WorkspaceRow>();
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
    if (!(await authorizePortalWorkspaceCapability(
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
  if (!(await authorizePortalWorkspaceCapability(
    env,
    principal,
    workspaceId,
    "directory.read",
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
    LIMIT 101`)
    .bind(workspaceId, normalized, normalized)
    .all<{
      entity_type: PortalDirectoryEntry["type"];
      public_id: string;
      parent_public_id: string | null;
      display_name: string;
      source_version: string;
    }>();
  if (result.results.length > 100) return null;
  return result.results.map(row => ({
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
  const matchingInvite = await portalDb(env).prepare(`SELECT id FROM portal_v2_invitations
    WHERE token_hash=? AND lower(invited_email)=?`).bind(tokenHash, normalizedEmail).first("id");
  if (matchingInvite === null) return "denied";
  let identity = await portalDb(env).prepare(`SELECT id FROM portal_v2_identities
    WHERE issuer=? AND subject=? AND status='active' AND revoked_at IS NULL AND lower(verified_email)=?`)
    .bind(principal.issuer, principal.subject, normalizedEmail).first<IdentityRow>();
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
  const before = await portalDb(env).prepare(`SELECT status,accepted_by_identity_id
    FROM portal_v2_invitations WHERE token_hash=? AND lower(invited_email)=lower(?)`)
    .bind(tokenHash, normalizedEmail)
    .first<{ status: string; accepted_by_identity_id: string | null }>();
  if (before?.status === "accepted") return before.accepted_by_identity_id === identity.id ? "replayed" : "denied";
  if (!before || before.status !== "pending") return "denied";

  const invitation = await portalDb(env).prepare(`SELECT id,workspace_id FROM portal_v2_invitations
    WHERE token_hash=? AND lower(invited_email)=lower(?) AND status='pending'
      AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')`)
    .bind(tokenHash, normalizedEmail)
    .first<{ id: string; workspace_id: string }>();
  if (!invitation) return "denied";
  await portalDb(env).batch([
    portalDb(env).prepare(`UPDATE portal_v2_invitations
      SET status='accepted',accepted_at=datetime('now'),accepted_by_identity_id=?
      WHERE id=? AND status='pending' AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')`)
      .bind(identity.id, invitation.id),
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
    portalDb(env).prepare(`INSERT INTO portal_v2_membership_audit
      (id,workspace_id,actor_identity_id,action,subject_identity_id,invitation_id)
      SELECT ?,workspace_id,?,'invitation.accepted',?,id FROM portal_v2_invitations
      WHERE id=? AND status='accepted' AND accepted_by_identity_id=?
        AND NOT EXISTS (SELECT 1 FROM portal_v2_membership_audit audit WHERE audit.invitation_id=? AND audit.action='invitation.accepted')`)
      .bind(crypto.randomUUID(), identity.id, identity.id, invitation.id, identity.id, invitation.id),
  ]);
  const acceptedBy = await portalDb(env).prepare("SELECT accepted_by_identity_id FROM portal_v2_invitations WHERE id=?")
    .bind(invitation.id).first("accepted_by_identity_id");
  return acceptedBy === identity.id ? "accepted" : "denied";
}
