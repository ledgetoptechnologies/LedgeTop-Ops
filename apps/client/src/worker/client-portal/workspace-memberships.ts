import type { PortalAuthorizationEnv as Env } from './workspace-v2';
import type {Env as ClientEnv} from '../types';
import { invitationRecipientEmailHash } from "./access-enrollment-receipts";
import type { VerifiedClientPrincipal } from "./types";
import {
  authorizePortalWorkspaceCapability,
  portalHierarchyV2Enabled,
  portalIdentityDenylistEnabled,
  type PortalWorkspaceCapability,
  type PortalWorkspaceTarget,
  authorizePrimaryPortalTargetBatch,
  readLegacyInvitationCapabilityOptions,
} from "./workspace-v2";
import { portalHierarchyRelationsEnabled,resolvePortalRelationAuthorizedTargets } from "./hierarchy-relations";
import { parseProjectAccessTerms,prepareProjectAccessTerms,projectAccessTermsReady,readProjectAccessTerms,readWorkspaceInvitationPolicy,
  type ProjectAccessTermsInput,type ProjectAccessTermsView } from './project-access-terms';
import {captureProjectInvitationDelegation,captureWorkspaceInvitationDelegation} from './project-invitation-delegation';
import {invitationRequestsReady,submitWorkspaceInvitationRequest,replaySubmittedWorkspaceInvitationRequest,type WorkspaceInvitationRequestView} from './workspace-invitation-requests';
import {PRIMARY_ALPHA_SOURCE_ID} from '@ltds/shared';
import {HTTPException} from 'hono/http-exception';
import {canManageWorkspaceAddressBook,workspaceAddressBookAvailableFor} from './workspace-address-book';
import {prepareAddressBookContactSelection,type AddressBookContactSelection} from './workspace-address-book';
import {primaryWorkspaceAccount} from './project-alpha-source';
import {projectAccessCapacitySql} from './project-access-capacity';
import {readPortalSourceAuthorityProof,type PortalSourceAuthorityProof} from '../project-alpha-portal-authority';

type AddressBookAccessEnv=Env&Partial<Pick<ClientEnv,'CLIENT_PORTAL_ADDRESS_BOOK_ENABLED'|'CLIENT_PORTAL_ADDRESS_BOOK_FINGERPRINT_SECRET'|'DELIVERY_SESSION_SECRET'|'DELIVERY_PREVIOUS_SESSION_SECRET'|'CLIENT_PORTAL_PEER_ADMIN_ENABLED'>>;

const INVITABLE_CAPABILITIES = new Set<PortalWorkspaceCapability>([
  "workspace.view", "delivery.view", "request.create",
]);
const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export interface WorkspaceInvitationInput {
  email: string;
  addressContact?:AddressBookContactSelection;
  projectPublicId?: string;
  targetScope?: { type: "organization" | "department" | "client" | "project"; publicId: string };
  organizationWide?: boolean;
  confirmOrganizationWide?: boolean;
  capabilities: PortalWorkspaceCapability[];
  accessTerms?: ProjectAccessTermsInput;
  expectedInvitationPolicyVersion?:number;
}

export interface WorkspaceInvitationView {
  id: string;
  email: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  scope: { type: "organization" | "department" | "client" | "project" | "workspace"; publicId: string | null };
  capabilities: PortalWorkspaceCapability[];
  expiresAt: string;
  accessTerms: ProjectAccessTermsView|null;
}

export interface WorkspaceMemberView {
  identityId: string;
  email: string | null;
  status: "active" | "suspended" | "revoked";
  manager: boolean;
  source: string;
  managerVersion: number;
  canChangeManager: boolean;
}

type Identity = { id: string };

function db(env: Env): D1Database { return env.DELIVERY_DB; }

export function workspaceMembershipManagementEnabled(env: Env): boolean {
  return portalHierarchyV2Enabled(env) && env.CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED === "true";
}

export function workspacePeerAdminEnabled(env: AddressBookAccessEnv): boolean {
  return workspaceMembershipManagementEnabled(env) && env.CLIENT_PORTAL_PEER_ADMIN_ENABLED === "true";
}

function normalizeEmail(email: string): string | null {
  const normalized = email.trim().toLocaleLowerCase("en-US");
  if (normalized.length < 3 || normalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
  return normalized;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hexDigest(value:string):Promise<string>{
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))]
    .map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

interface SecondaryManagerContext{
  identityId:string;sourceId:string;workspaceName:string;rootType:'organization'|'standalone_client';rootPublicId:string;
  generationId:string;sourceSequence:number;sourceVersion:string;authority:PortalSourceAuthorityProof;
}

async function secondaryManagerContext(env:Env,principal:VerifiedClientPrincipal,workspaceId:string):Promise<SecondaryManagerContext|null>{
  const email=normalizeEmail(principal.email);
  if(!email)return null;
  const database=db(env).withSession('first-primary');
  // Preserve the pre-secondary primary path during a rolling migration. A
  // primary workspace must never prepare a statement against projection or
  // secondary-authority tables merely to discover that it is primary.
  const sourceId=await database.prepare(`SELECT project_alpha_source_id FROM portal_v2_workspaces
    WHERE id=? AND status='active'`).bind(workspaceId).first<string>('project_alpha_source_id');
  if(!sourceId||sourceId===PRIMARY_ALPHA_SOURCE_ID)return null;
  const row=await database.prepare(`SELECT identity.id identity_id,workspace.project_alpha_source_id source_id,
      workspace.display_name workspace_name,workspace.root_type,
      COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) root_public_id,
      checkpoint.active_generation_id generation_id,checkpoint.source_sequence,membership.source_version
    FROM portal_v2_identities identity
    JOIN portal_v2_workspace_memberships membership ON membership.identity_id=identity.id AND membership.workspace_id=?
      AND membership.source_type='project_alpha' AND membership.status='active' AND membership.revoked_at IS NULL
      AND membership.expires_at IS NULL
    JOIN portal_v2_workspaces workspace ON workspace.id=membership.workspace_id AND workspace.status='active'
      AND workspace.legacy_account_id IS NULL AND workspace.project_alpha_source_id<>'project-alpha:primary'
    JOIN pa_portal_workspace_sources owner ON owner.workspace_id=workspace.id AND owner.projection_source_id=workspace.project_alpha_source_id
    JOIN pa_portal_principals projected ON projected.workspace_id=workspace.id AND projected.identity_id=identity.id
      AND projected.status='active' AND projected.source_version=membership.source_version
      AND lower(projected.email_hint)=lower(identity.verified_email)
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
      AND generation.source_sequence=checkpoint.source_sequence
    JOIN portal_v2_directory_entities root ON root.workspace_id=workspace.id AND root.generation_id=generation.id
      AND root.entity_type=workspace.root_type AND root.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)
      AND root.active=1
    WHERE identity.issuer=? AND identity.subject=? AND lower(identity.verified_email)=?
      AND identity.status='active' AND identity.revoked_at IS NULL`)
    .bind(workspaceId,principal.issuer,principal.subject,email)
    .first<{identity_id:string;source_id:string;workspace_name:string;root_type:'organization'|'standalone_client';root_public_id:string;
      generation_id:string;source_sequence:number;source_version:string}>();
  if(!row)return null;
  const authority=await readPortalSourceAuthorityProof(database,row.source_id);
  if(!authority)return null;
  const managerCapabilities=await database.prepare(`SELECT COUNT(DISTINCT allow.capability) count FROM portal_v2_entitlements allow
    WHERE allow.workspace_id=? AND allow.identity_id=? AND allow.capability IN ('workspace.view','member.manage')
      AND allow.effect='allow' AND allow.scope_type='workspace' AND allow.scope_public_id=?
      AND allow.source_type='project_alpha' AND allow.source_version=? AND allow.status='active' AND allow.revoked_at IS NULL
      AND datetime(allow.valid_from)<=datetime('now') AND allow.expires_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements deny WHERE deny.workspace_id=allow.workspace_id
        AND deny.identity_id=allow.identity_id AND deny.capability=allow.capability AND deny.effect='deny'
        AND deny.scope_type='workspace' AND deny.scope_public_id=allow.workspace_id AND deny.status='active'
        AND deny.revoked_at IS NULL AND datetime(deny.valid_from)<=datetime('now')
        AND (deny.expires_at IS NULL OR datetime(deny.expires_at)>datetime('now')))`)
    .bind(workspaceId,row.identity_id,workspaceId,row.source_version).first<number>('count');
  if(managerCapabilities!==2)return null;
  if(portalIdentityDenylistEnabled(env)){
    const denied=await database.prepare(`SELECT 1 ok FROM portal_v2_identity_denials WHERE identity_id=?
      AND status='active' AND revoked_at IS NULL AND datetime(valid_from)<=datetime('now')
      AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
      AND (scope_type='global' OR (workspace_id=? AND scope_type='workspace' AND scope_public_id=?)) LIMIT 1`)
      .bind(row.identity_id,workspaceId,workspaceId).first('ok');
    if(denied!==null)return null;
  }
  return {identityId:row.identity_id,sourceId:row.source_id,workspaceName:row.workspace_name,rootType:row.root_type,
    rootPublicId:row.root_public_id,generationId:row.generation_id,sourceSequence:row.source_sequence,
    sourceVersion:row.source_version,authority};
}

async function secondaryTargetAllowed(env:Env,context:SecondaryManagerContext,workspaceId:string,target:PortalWorkspaceTarget,
  capabilities:readonly PortalWorkspaceCapability[]=['member.manage']):Promise<boolean>{
  const workspace={id:workspaceId,rootType:context.rootType,rootPublicId:context.rootPublicId};
  for(const capability of capabilities){
    if(target.scopeType==='workspace'){
      const allowed=await db(env).prepare(`SELECT 1 ok FROM portal_v2_entitlements allow
        WHERE allow.workspace_id=? AND allow.identity_id=? AND allow.capability=? AND allow.effect='allow'
          AND allow.scope_type='workspace' AND allow.scope_public_id=? AND allow.source_type='project_alpha'
          AND allow.source_version=? AND allow.status='active' AND allow.revoked_at IS NULL
          AND datetime(allow.valid_from)<=datetime('now') AND allow.expires_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements deny WHERE deny.workspace_id=allow.workspace_id
            AND deny.identity_id=allow.identity_id AND deny.capability=allow.capability AND deny.effect='deny'
            AND deny.scope_type='workspace' AND deny.scope_public_id=allow.workspace_id AND deny.status='active'
            AND deny.revoked_at IS NULL AND datetime(deny.valid_from)<=datetime('now')
            AND (deny.expires_at IS NULL OR datetime(deny.expires_at)>datetime('now'))) LIMIT 1`)
        .bind(workspaceId,context.identityId,capability,workspaceId,context.sourceVersion).first('ok');
      if(allowed===null)return false;
      continue;
    }
    const allowed=await resolvePortalRelationAuthorizedTargets(env,workspace,context.identityId,capability,[target]);
    if(!allowed?.has(`${target.scopeType}:${target.publicId}`))return false;
  }
  return true;
}

function secondaryFreshFence(database:D1Database,context:SecondaryManagerContext,principal:VerifiedClientPrincipal,
  workspaceId:string,id:string):D1PreparedStatement{
  return database.prepare(`INSERT INTO portal_secondary_workspace_membership_fences(id,write_guard)
    VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM portal_v2_workspaces workspace
      JOIN pa_portal_workspace_sources owner ON owner.workspace_id=workspace.id AND owner.projection_source_id=workspace.project_alpha_source_id
      JOIN pa_portal_source_authorities authority ON authority.source_id=owner.projection_source_id AND authority.state='active'
        AND authority.active_revision=? AND authority.version=? AND authority.connector_revision=? AND authority.connector_version=?
      JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id AND revision.revision=authority.active_revision
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
        AND checkpoint.active_generation_id=? AND checkpoint.source_sequence=?
      JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
        AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
        AND generation.source_sequence=checkpoint.source_sequence
      JOIN portal_v2_directory_entities root ON root.workspace_id=workspace.id AND root.generation_id=generation.id
        AND root.entity_type=? AND root.public_id=? AND root.active=1
      JOIN portal_v2_identities identity ON identity.id=? AND identity.issuer=? AND identity.subject=?
        AND lower(identity.verified_email)=? AND identity.status='active' AND identity.revoked_at IS NULL
      JOIN pa_portal_principals projected ON projected.workspace_id=workspace.id AND projected.identity_id=identity.id
        AND projected.status='active' AND projected.source_version=? AND lower(projected.email_hint)=lower(identity.verified_email)
      JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=workspace.id AND membership.identity_id=identity.id
        AND membership.source_type='project_alpha' AND membership.source_version=? AND membership.status='active'
        AND membership.revoked_at IS NULL AND membership.expires_at IS NULL
      WHERE workspace.id=? AND workspace.project_alpha_source_id=? AND workspace.legacy_account_id IS NULL AND workspace.status='active'
        AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials denial WHERE denial.identity_id=identity.id
          AND denial.status='active' AND denial.revoked_at IS NULL AND datetime(denial.valid_from)<=datetime('now')
          AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
          AND (denial.scope_type='global' OR denial.workspace_id=workspace.id))
        AND EXISTS(SELECT 1 FROM portal_v2_entitlements view_allow WHERE view_allow.workspace_id=workspace.id
          AND view_allow.identity_id=identity.id AND view_allow.capability='workspace.view' AND view_allow.effect='allow'
          AND view_allow.scope_type='workspace' AND view_allow.scope_public_id=workspace.id AND view_allow.source_type='project_alpha'
          AND view_allow.source_version=membership.source_version AND view_allow.status='active' AND view_allow.revoked_at IS NULL
          AND datetime(view_allow.valid_from)<=datetime('now') AND view_allow.expires_at IS NULL)
        AND EXISTS(SELECT 1 FROM portal_v2_entitlements manage_allow WHERE manage_allow.workspace_id=workspace.id
          AND manage_allow.identity_id=identity.id AND manage_allow.capability='member.manage' AND manage_allow.effect='allow'
          AND manage_allow.scope_type='workspace' AND manage_allow.scope_public_id=workspace.id AND manage_allow.source_type='project_alpha'
          AND manage_allow.source_version=membership.source_version AND manage_allow.status='active' AND manage_allow.revoked_at IS NULL
          AND datetime(manage_allow.valid_from)<=datetime('now') AND manage_allow.expires_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements deny WHERE deny.workspace_id=workspace.id
          AND deny.identity_id=identity.id AND deny.capability IN ('workspace.view','member.manage') AND deny.effect='deny'
          AND deny.scope_type='workspace' AND deny.scope_public_id=workspace.id AND deny.status='active'
          AND deny.revoked_at IS NULL AND datetime(deny.valid_from)<=datetime('now')
          AND (deny.expires_at IS NULL OR datetime(deny.expires_at)>datetime('now'))))
      THEN 1 ELSE 0 END)`)
    .bind(id,context.authority.revision,context.authority.version,context.authority.connectorRevision,context.authority.connectorVersion,
      context.generationId,context.sourceSequence,context.rootType,context.rootPublicId,context.identityId,
      principal.issuer,principal.subject,principal.email.trim().toLowerCase(),context.sourceVersion,context.sourceVersion,workspaceId,context.sourceId);
}

function unlimitedWorkspaceCapabilitySql(capability: "workspace.view" | "member.manage", termsReady: boolean,
  principalsReady=false,identityDenialsEnabled=false,workspaceReference="?",identityReference="?"): string {
  return `EXISTS(SELECT 1 FROM portal_v2_workspace_memberships effective_membership
    JOIN portal_v2_identities effective_identity ON effective_identity.id=effective_membership.identity_id
      AND effective_identity.status='active' AND effective_identity.revoked_at IS NULL
    JOIN portal_v2_workspaces effective_workspace ON effective_workspace.id=effective_membership.workspace_id
      AND effective_workspace.status='active' AND effective_workspace.root_type='organization'
      AND ${primaryWorkspaceAccount('effective_workspace')}
    JOIN portal_v2_directory_checkpoints effective_checkpoint ON effective_checkpoint.workspace_id=effective_workspace.id
    JOIN portal_v2_directory_generations effective_generation ON effective_generation.id=effective_checkpoint.active_generation_id
      AND effective_generation.workspace_id=effective_checkpoint.workspace_id
      AND effective_generation.status='active' AND effective_generation.complete=1
    JOIN portal_v2_directory_entities effective_root ON effective_root.workspace_id=effective_workspace.id
      AND effective_root.generation_id=effective_checkpoint.active_generation_id
      AND effective_root.entity_type='organization' AND effective_root.public_id=effective_workspace.pa_organization_public_id
      AND effective_root.active=1
    JOIN portal_v2_entitlements effective_allow ON effective_allow.workspace_id=effective_membership.workspace_id
      AND effective_allow.identity_id=effective_membership.identity_id
    WHERE effective_membership.workspace_id=${workspaceReference} AND effective_membership.identity_id=${identityReference}
      AND effective_membership.status='active' AND effective_membership.revoked_at IS NULL
      AND effective_membership.expires_at IS NULL
      ${principalsReady?`AND (effective_membership.source_type<>'project_alpha' OR EXISTS(SELECT 1 FROM pa_portal_principals current_principal
        WHERE current_principal.workspace_id=effective_membership.workspace_id AND current_principal.identity_id=effective_membership.identity_id
          AND current_principal.status='active' AND current_principal.source_version=effective_membership.source_version))`:''}
      AND effective_allow.capability='${capability}' AND effective_allow.effect='allow'
      AND effective_allow.scope_type='workspace' AND effective_allow.scope_public_id=effective_membership.workspace_id
      AND effective_allow.status='active' AND effective_allow.revoked_at IS NULL
      AND datetime(effective_allow.valid_from)<=datetime('now') AND effective_allow.expires_at IS NULL
      ${termsReady ? "AND effective_allow.access_terms_id IS NULL" : ""}
      AND (effective_allow.source_type<>'project_alpha' OR (effective_membership.source_type='project_alpha'
        AND effective_allow.source_version=effective_membership.source_version))
      ${identityDenialsEnabled?`AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials effective_identity_deny
        WHERE effective_identity_deny.identity_id=effective_membership.identity_id
          AND effective_identity_deny.status='active' AND effective_identity_deny.revoked_at IS NULL
          AND datetime(effective_identity_deny.valid_from)<=datetime('now')
          AND (effective_identity_deny.expires_at IS NULL OR datetime(effective_identity_deny.expires_at)>datetime('now'))
          AND (effective_identity_deny.scope_type='global' OR (effective_identity_deny.workspace_id=effective_membership.workspace_id
            AND effective_identity_deny.scope_type='workspace'
            AND effective_identity_deny.scope_public_id=effective_membership.workspace_id)))
        AND NOT EXISTS(SELECT 1 FROM (SELECT capacity_deny.id FROM portal_v2_identity_denials capacity_deny
          WHERE capacity_deny.identity_id=effective_membership.identity_id
            AND capacity_deny.status='active' AND capacity_deny.revoked_at IS NULL
            AND datetime(capacity_deny.valid_from)<=datetime('now')
            AND (capacity_deny.expires_at IS NULL OR datetime(capacity_deny.expires_at)>datetime('now'))
            AND (capacity_deny.scope_type='global' OR capacity_deny.workspace_id=effective_membership.workspace_id)
          ORDER BY capacity_deny.id LIMIT 1 OFFSET 200))`:''}
      AND NOT EXISTS(SELECT 1 FROM (SELECT capacity_entitlement.id FROM portal_v2_entitlements capacity_entitlement
        WHERE capacity_entitlement.workspace_id=effective_membership.workspace_id
          AND capacity_entitlement.identity_id=effective_membership.identity_id
          AND capacity_entitlement.capability='${capability}'
          AND capacity_entitlement.status='active' AND capacity_entitlement.revoked_at IS NULL
          AND datetime(capacity_entitlement.valid_from)<=datetime('now')
          AND (capacity_entitlement.expires_at IS NULL OR datetime(capacity_entitlement.expires_at)>datetime('now'))
          AND ${projectAccessCapacitySql('capacity_entitlement',termsReady)}
        ORDER BY capacity_entitlement.entitlement_version DESC,capacity_entitlement.id LIMIT 1 OFFSET 200))
      AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements effective_deny
        WHERE effective_deny.workspace_id=effective_allow.workspace_id
          AND effective_deny.identity_id=effective_allow.identity_id
          AND effective_deny.capability=effective_allow.capability AND effective_deny.effect='deny'
          AND effective_deny.scope_type='workspace' AND effective_deny.scope_public_id=effective_allow.scope_public_id
          AND effective_deny.status='active' AND effective_deny.revoked_at IS NULL
          AND datetime(effective_deny.valid_from)<=datetime('now')
          AND (effective_deny.expires_at IS NULL OR datetime(effective_deny.expires_at)>datetime('now'))))`;
}

async function hasUnlimitedWorkspaceAuthority(database: D1Database, workspaceId: string, identityId: string, termsReady: boolean,
  principalsReady:boolean,identityDenialsEnabled:boolean): Promise<boolean> {
  const row=await database.prepare(`SELECT (${unlimitedWorkspaceCapabilitySql("workspace.view",termsReady,principalsReady,identityDenialsEnabled)}
    AND ${unlimitedWorkspaceCapabilitySql("member.manage",termsReady,principalsReady,identityDenialsEnabled)}) authorized`)
    .bind(workspaceId,identityId,workspaceId,identityId).first<number>('authorized');
  return row===1;
}

async function actorIdentity(env: Env, principal: VerifiedClientPrincipal): Promise<Identity | null> {
  return db(env).prepare(`SELECT id FROM portal_v2_identities
    WHERE issuer=? AND subject=? AND status='active' AND revoked_at IS NULL`)
    .bind(principal.issuer, principal.subject).first<Identity>();
}

async function activeScopeExists(env: Env, workspaceId: string, target: PortalWorkspaceTarget): Promise<boolean> {
  if (target.scopeType === "workspace") return target.publicId === workspaceId;
  return (await db(env).prepare(`SELECT 1 ok FROM portal_v2_directory_checkpoints c
    JOIN portal_v2_directory_generations g ON g.id=c.active_generation_id AND g.workspace_id=c.workspace_id AND g.status='active' AND g.complete=1
    JOIN portal_v2_directory_entities e ON e.workspace_id=c.workspace_id AND e.generation_id=c.active_generation_id
      AND e.entity_type=? AND e.public_id=? AND e.active=1
    WHERE c.workspace_id=?`).bind(target.scopeType, target.publicId, workspaceId).first("ok")) !== null;
}

async function replayedInvitation(env: Env, workspaceId: string, actorId: string, key: string, requestHash: string): Promise<WorkspaceInvitationView | null | "conflict"> {
  const command = await db(env).prepare(`SELECT request_hash,invitation_id FROM portal_v2_invitation_commands
    WHERE workspace_id=? AND actor_identity_id=? AND idempotency_key=?`)
    .bind(workspaceId, actorId, key).first<{ request_hash: string; invitation_id: string }>();
  if (!command) return null;
  if (command.request_hash !== requestHash) return "conflict";
  return getInvitation(env, workspaceId, command.invitation_id);
}

async function getInvitation(env: Env, workspaceId: string, invitationId: string): Promise<WorkspaceInvitationView | null> {
  const row = await db(env).prepare(`SELECT id,invited_email,
    CASE WHEN status='pending' AND datetime(expires_at)<=datetime('now') THEN 'expired' ELSE status END status,expires_at
    FROM portal_v2_invitations WHERE id=? AND workspace_id=?`)
    .bind(invitationId, workspaceId).first<{ id: string; invited_email: string; status: WorkspaceInvitationView["status"]; expires_at: string }>();
  if (!row) return null;
  const grants = await db(env).prepare(`SELECT capability,scope_type,scope_public_id FROM portal_v2_invitation_entitlements
    WHERE invitation_id=? ORDER BY capability`).bind(invitationId).all<{ capability: PortalWorkspaceCapability; scope_type: WorkspaceInvitationView["scope"]["type"]; scope_public_id: string }>();
  const scoped = grants.results.find(grant => grant.scope_type !== "workspace") ?? grants.results[0];
  let accessTerms:ProjectAccessTermsView|null=null;
  if(await projectAccessTermsReady(db(env))){
    const termsId=await db(env).prepare('SELECT access_terms_id FROM portal_v2_invitation_entitlements WHERE invitation_id=? AND access_terms_id IS NOT NULL LIMIT 1')
      .bind(invitationId).first<string>('access_terms_id');
    if(termsId)accessTerms=await readProjectAccessTerms(db(env),termsId);
  }
  return {
    id: row.id, email: row.invited_email, status: row.status, expiresAt: row.expires_at,
    scope: { type: scoped?.scope_type ?? "workspace", publicId: !scoped || scoped.scope_type === "workspace" ? null : scoped.scope_public_id },
    capabilities: [...new Set(grants.results.map(grant => grant.capability))],accessTerms,
  };
}

export type CreateWorkspaceInvitationResult =
  | { outcome: "created" | "replayed"; invitation: WorkspaceInvitationView; deliveryQueued: true }
  | { outcome:'approval_requested'|'approval_replayed';request:WorkspaceInvitationRequestView;deliveryQueued:false }
  | { outcome: "denied" | "invalid" | "conflict" | "rate_limited" | "approval_required" | "policy_disabled" | 'mail_unavailable' | 'secondary_approval_unsupported' };

export async function createWorkspaceInvitation(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
  input: WorkspaceInvitationInput,
  idempotencyKey: string,
  options?:{emailDeliveryAvailable:boolean},
): Promise<CreateWorkspaceInvitationResult> {
  if (!workspaceMembershipManagementEnabled(env) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(idempotencyKey)) return { outcome: "invalid" };
  const actor = await actorIdentity(env, principal);
  if (!actor) return { outcome: "denied" };
  const workspaceSource=await db(env).prepare(`SELECT project_alpha_source_id source_id FROM portal_v2_workspaces
    WHERE id=? AND status='active'`).bind(workspaceId).first<{source_id:string}>();
  if(!workspaceSource)return {outcome:'denied'};
  const secondary=workspaceSource.source_id===PRIMARY_ALPHA_SOURCE_ID?null:await secondaryManagerContext(env,principal,workspaceId);
  if(workspaceSource.source_id!==PRIMARY_ALPHA_SOURCE_ID&&!secondary)return {outcome:'denied'};
  if(secondary&&input.addressContact)return {outcome:'invalid'};
  const email = normalizeEmail(input.email);
  const capabilities = [...new Set(input.capabilities)].sort();
  if (!email || capabilities.length === 0 || capabilities.some(capability => !INVITABLE_CAPABILITIES.has(capability))) return { outcome: "invalid" };

  const organizationWide = input.organizationWide === true;
  if (input.targetScope && !portalHierarchyRelationsEnabled(env)) return { outcome: "invalid" };
  if (input.targetScope && (organizationWide || input.projectPublicId)) return { outcome: "invalid" };
  if (organizationWide && input.confirmOrganizationWide !== true) return { outcome: "invalid" };
  const selectedTarget: PortalWorkspaceTarget = organizationWide
    ? { scopeType: "workspace", publicId: workspaceId }
    : input.targetScope
      ? { scopeType: input.targetScope.type, publicId: input.targetScope.publicId }
      : { scopeType: "project", publicId: input.projectPublicId ?? "" };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(selectedTarget.publicId)) return { outcome: "invalid" };
  if (!(await activeScopeExists(env, workspaceId, selectedTarget))) return { outcome: "denied" };
  // Managers can create only LTDS-local guest grants within their own exact
  // authority. member.manage itself is never invit-able or client-created.
  if (secondary
    ? !(await secondaryTargetAllowed(env,secondary,workspaceId,selectedTarget,['member.manage',...capabilities]))
    : !(await authorizePortalWorkspaceCapability(env, principal, workspaceId, "member.manage", selectedTarget))) return { outcome: "denied" };

  const termsReady=await projectAccessTermsReady(db(env));
  const policy=termsReady?await readWorkspaceInvitationPolicy(db(env),workspaceId):{mode:'allowed',version:0};
  if(input.expectedInvitationPolicyVersion!==undefined&&input.expectedInvitationPolicyVersion!==policy.version)
    throw new HTTPException(409,{message:'invitation_policy_changed'});
  if(policy.mode==='disabled')return {outcome:'policy_disabled'};
  const accessTerms=input.accessTerms===undefined?undefined:parseProjectAccessTerms(input.accessTerms);
  if(accessTerms&&(accessTerms.kind!=='collaborator'||selectedTarget.scopeType!=='project'))return {outcome:'invalid'};
  const canonical = JSON.stringify({ email, capabilities, scopeType: selectedTarget.scopeType, scopePublicId: selectedTarget.publicId,
    ...(input.addressContact?{addressContact:input.addressContact}:{}),
    ...(accessTerms?{accessTerms}:{}),...(input.expectedInvitationPolicyVersion!==undefined?{policyVersion:input.expectedInvitationPolicyVersion}:{}) });
  const requestHash = await digest(canonical);
  const requestsReady=await invitationRequestsReady(db(env));
  if(requestsReady){
    const requested=await replaySubmittedWorkspaceInvitationRequest(db(env),{workspaceId,actorId:actor.id,idempotencyKey,requestHash});
    if(requested)return {outcome:'approval_replayed',request:requested,deliveryQueued:false};
  }
  const replay = await replayedInvitation(env, workspaceId, actor.id, idempotencyKey, requestHash);
  if (replay === "conflict") return { outcome: "conflict" };
  if (replay) return { outcome: "replayed", invitation: replay, deliveryQueued: true };
  const selectedContact=input.addressContact?await prepareAddressBookContactSelection(env,workspaceId,input.addressContact,email):null;
  if(policy.mode==='require_approval'){
    if(secondary)return {outcome:'secondary_approval_unsupported'};
    if(!requestsReady)return {outcome:'approval_required'};
    try{const result=await submitWorkspaceInvitationRequest(env,principal,{workspaceId,requesterIdentityId:actor.id,email,target:selectedTarget,
        capabilities,accessTerms,addressContact:input.addressContact,requestHash,idempotencyKey});
      return {outcome:result.replayed?'approval_replayed':'approval_requested',request:result.request,deliveryQueued:false};
    }catch(error){const winner=await replayedInvitation(env,workspaceId,actor.id,idempotencyKey,requestHash);
      if(winner&&winner!=='conflict')return {outcome:'replayed',invitation:winner,deliveryQueued:true};throw error;}
  }
  if(options?.emailDeliveryAvailable===false)return {outcome:'mail_unavailable'};

  const rate = await db(env).prepare(`SELECT request_count count,
    CASE WHEN datetime(window_started_at,'+1 hour')>datetime('now') THEN 1 ELSE 0 END current_window
    FROM portal_v2_invitation_rate_limits WHERE workspace_id=? AND actor_identity_id=?`)
    .bind(workspaceId, actor.id).first<{ count: number; current_window: number }>();
  if (rate?.current_window === 1 && rate.count >= 10) return { outcome: "rate_limited" };

  const invitationId = crypto.randomUUID();
  const sourceId=accessTerms?workspaceSource.source_id:null;
  const preparedTerms=accessTerms?await prepareProjectAccessTerms(db(env),{workspaceId,sourceId:sourceId??'',projectPublicId:selectedTarget.publicId},accessTerms,
    {type:'identity',id:actor.id},`invitation-${invitationId}`):null;
  const delegation=secondary
    ?await captureWorkspaceInvitationDelegation(env,{workspaceId,target:selectedTarget,identityId:actor.id,
      issuer:principal.issuer,subject:principal.subject,email:principal.email.trim().toLowerCase()},capabilities,preparedTerms?.view??null)
    :preparedTerms?await captureProjectInvitationDelegation(env,{workspaceId,projectId:selectedTarget.publicId,identityId:actor.id,
      issuer:principal.issuer,subject:principal.subject,email:principal.email.trim().toLowerCase()},capabilities,preparedTerms.view):null;
  if(delegation){
    for(const capability of new Set<PortalWorkspaceCapability>(['member.manage','workspace.view',...capabilities])){
      const target=capability==='workspace.view'?{scopeType:'workspace' as const,publicId:workspaceId}:selectedTarget;
      if(secondary
        ?!await secondaryTargetAllowed(env,secondary,workspaceId,target,[capability])
        :!await authorizePortalWorkspaceCapability(env,principal,workspaceId,capability,target))return {outcome:'denied'};
    }
  }
  const token = randomToken();
  const tokenHash = await digest(token);
  const recipientEmailHash = await invitationRecipientEmailHash(email);
  if (!recipientEmailHash) return { outcome: "invalid" };
  const expiresAt = new Date(Date.now() + INVITE_LIFETIME_MS).toISOString();
  const scopeType = selectedTarget.scopeType;
  const scopePublicId = selectedTarget.publicId;
  const grants = [...new Set<PortalWorkspaceCapability>(["workspace.view", ...capabilities])];
  const database = db(env);
  const secondaryContextHash=secondary?await hexDigest(JSON.stringify({workspaceId,sourceId:secondary.sourceId,identityId:secondary.identityId,
    issuer:principal.issuer,subject:principal.subject,email,authority:secondary.authority,generationId:secondary.generationId,
    sourceSequence:secondary.sourceSequence,sourceVersion:secondary.sourceVersion,scopeType,scopePublicId,grants})):null;
  try {
    await database.batch([
      ...(secondary?[secondaryFreshFence(database,secondary,principal,workspaceId,`secondary-invitation-${invitationId}`),
        database.prepare(`INSERT INTO portal_secondary_workspace_invitation_authority
          (invitation_id,workspace_id,source_id,inviter_identity_id,inviter_issuer,inviter_subject,inviter_email,
           authority_revision,authority_version,connector_revision,connector_version,generation_id,source_sequence,context_hash)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(invitationId,workspaceId,secondary.sourceId,secondary.identityId,
            principal.issuer,principal.subject,principal.email.trim().toLowerCase(),secondary.authority.revision,secondary.authority.version,
            secondary.authority.connectorRevision,secondary.authority.connectorVersion,secondary.generationId,
            secondary.sourceSequence,secondaryContextHash)]:[]),
      ...(termsReady&&input.expectedInvitationPolicyVersion!==undefined?[database.prepare(`INSERT INTO portal_project_invitation_fences(id,write_guard)
        VALUES(?,CASE WHEN COALESCE((SELECT version FROM portal_workspace_invitation_policies WHERE workspace_id=?),0)=?
          AND COALESCE((SELECT policy FROM portal_workspace_invitation_policies WHERE workspace_id=?),'allowed')='allowed' THEN 1 ELSE 0 END)`)
        .bind(`issue-policy-${invitationId}`,workspaceId,policy.version,workspaceId)]:[]),
      ...(delegation?[delegation.fence(invitationId)]:[]),
      ...(selectedContact?[selectedContact.fence(`invitation-contact-${invitationId}`)]:[]),
      ...(preparedTerms?[preparedTerms.statement]:[]),
      database.prepare(`INSERT INTO portal_v2_invitations
        (id,workspace_id,token_hash,invited_email,invited_by_identity_id,expires_at)
        VALUES (?,?,?,?,?,?)`).bind(invitationId, workspaceId, tokenHash, email, actor.id, expiresAt),
      ...grants.map(capability => database.prepare(`INSERT INTO portal_v2_invitation_entitlements
        (invitation_id,capability,scope_type,scope_public_id${termsReady?',access_terms_id':''}) VALUES (?,?,?,?${termsReady?',?':''})`)
        .bind(invitationId, capability, capability === "workspace.view" ? "workspace" : scopeType, capability === "workspace.view" ? workspaceId : scopePublicId,
          ...(termsReady?[preparedTerms?.id??null]:[]))),
      database.prepare(`INSERT INTO portal_v2_invitation_commands
        (workspace_id,actor_identity_id,idempotency_key,request_hash,invitation_id) VALUES (?,?,?,?,?)`)
        .bind(workspaceId, actor.id, idempotencyKey, requestHash, invitationId),
      database.prepare(`INSERT INTO portal_v2_invitation_rate_limits(workspace_id,actor_identity_id,window_started_at,request_count)
        VALUES (?,?,datetime('now'),1) ON CONFLICT(workspace_id,actor_identity_id) DO UPDATE SET
        window_started_at=CASE WHEN datetime(window_started_at,'+1 hour')<=datetime('now') THEN datetime('now') ELSE window_started_at END,
        request_count=CASE WHEN datetime(window_started_at,'+1 hour')<=datetime('now') THEN 1 ELSE request_count+1 END`)
        .bind(workspaceId, actor.id),
      database.prepare(`INSERT INTO portal_v2_invitation_email_outbox(id,invitation_id,recipient_email,payload_json,recipient_email_hash)
        VALUES (?,?,?,?,?)`).bind(crypto.randomUUID(), invitationId, email, JSON.stringify({ invitationId, token, expiresAt }), recipientEmailHash),
      database.prepare(`INSERT INTO portal_v2_membership_audit
        (id,workspace_id,actor_identity_id,action,invitation_id,details_json) VALUES (?,?,?,'invitation.created',?,?)`)
        .bind(crypto.randomUUID(), workspaceId, actor.id, invitationId, JSON.stringify({ scopeType, scopePublicId, capabilities: grants,
          ...(preparedTerms?{accessTerms:preparedTerms.view}:{}),invitationPolicyVersion:policy.version })),
    ]);
  } catch (error) {
    if(requestsReady){const requested=await replaySubmittedWorkspaceInvitationRequest(database,{workspaceId,actorId:actor.id,idempotencyKey,requestHash});
      if(requested)return {outcome:'approval_replayed',request:requested,deliveryQueued:false};}
    const raced = await replayedInvitation(env, workspaceId, actor.id, idempotencyKey, requestHash);
    if (raced && raced !== "conflict") return { outcome: "replayed", invitation: raced, deliveryQueued: true };
    if (raced === "conflict") return { outcome: "conflict" };
    if(termsReady){const current=await readWorkspaceInvitationPolicy(database,workspaceId);
      if(current.mode!=='allowed')return {outcome:current.mode==='disabled'?'policy_disabled':'approval_required'};}
    if(input.addressContact)await prepareAddressBookContactSelection(env,workspaceId,input.addressContact,email);
    return { outcome: "invalid" };
  }
  return { outcome: "created", invitation: (await getInvitation(env, workspaceId, invitationId))!, deliveryQueued: true };
}

export interface WorkspaceInviteScope {type:'organization'|'department'|'client'|'project';publicId:string;displayName:string;
 capabilities:Array<'delivery.view'|'request.create'>;projectEndSupported:boolean}
export async function listWorkspaceAccess(env: AddressBookAccessEnv, principal: VerifiedClientPrincipal, workspaceId: string): Promise<{ members: WorkspaceMemberView[]; invitations: WorkspaceInvitationView[];
  sourceId:string;sourceName:string;workspaceName:string;canManageMembers:boolean;invitationRequestsSupported:boolean;inviteScopes:WorkspaceInviteScope[];
  addressBookAvailable:boolean;canManageAddressBook:boolean;
  peerAdminManagement:boolean;
  projectAccessTermsSupported:boolean;invitationPolicy:{mode:'allowed'|'disabled'|'require_approval';version:number};projectAccessOptions:Array<{projectPublicId:string;projectEndSupported:boolean}> } | null> {
  const secondary=await secondaryManagerContext(env,principal,workspaceId);
  const primaryAllowed=secondary?false:await authorizePortalWorkspaceCapability(env,principal,workspaceId,'workspace.view',{scopeType:'workspace',publicId:workspaceId});
  if(!secondary&&!primaryAllowed)return null;
  const canManageMembers=Boolean(secondary)||await authorizePortalWorkspaceCapability(env, principal, workspaceId, "member.manage", { scopeType: "workspace", publicId: workspaceId });
  const termsReady=await projectAccessTermsReady(db(env)),requestsReady=await invitationRequestsReady(db(env));
  const principalsReady=await portalPrincipalsReady(db(env)),identityDenialsEnabled=portalIdentityDenylistEnabled(env);
  const addressBookAvailable=await workspaceAddressBookAvailableFor(env,workspaceId);
  const workspace=await db(env).prepare('SELECT display_name,project_alpha_source_id,root_type FROM portal_v2_workspaces WHERE id=? AND status=\'active\'').bind(workspaceId)
    .first<{display_name:string;project_alpha_source_id:string;root_type:string}>();
  if(!workspace||(secondary?workspace.project_alpha_source_id!==secondary.sourceId:workspace.project_alpha_source_id!==PRIMARY_ALPHA_SOURCE_ID))return null;
  const scopeRows=(await db(env).prepare(`SELECT e.entity_type type,e.public_id,e.display_name,${termsReady?`EXISTS(SELECT 1 FROM portal_project_access_current_lifecycle l WHERE l.workspace_id=e.workspace_id AND l.project_public_id=e.public_id)`:'0'} supported
    FROM portal_v2_directory_checkpoints cp JOIN portal_v2_directory_generations g ON g.id=cp.active_generation_id AND g.workspace_id=cp.workspace_id AND g.status='active' AND g.complete=1
    JOIN portal_v2_directory_entities e ON e.workspace_id=cp.workspace_id AND e.generation_id=cp.active_generation_id AND e.active=1
    WHERE cp.workspace_id=? AND e.entity_type IN ('organization','department','client','project') ORDER BY e.entity_type,e.public_id LIMIT 201`)
    .bind(workspaceId).all<{type:WorkspaceInviteScope['type'];public_id:string;display_name:string;supported:number}>()).results;
  if(scopeRows.length>200)return null;
  const inviteScopes:WorkspaceInviteScope[]=[];
  const scoped=scopeRows.filter(scope=>portalHierarchyRelationsEnabled(env)||scope.type==='project');
  const legacyOptions=secondary?null:await readLegacyInvitationCapabilityOptions(env,principal,workspaceId,
    scoped.map(scope=>({scopeType:scope.type,publicId:scope.public_id})));
  const allowed=legacyOptions??new Map<PortalWorkspaceCapability,Set<string>>();
  if(secondary){
    for(const capability of ['member.manage','delivery.view','request.create'] as const){
      const keys=new Set<string>();
      for(const scope of scoped){const target={scopeType:scope.type,publicId:scope.public_id};
        if(await secondaryTargetAllowed(env,secondary,workspaceId,target,[capability]))keys.add(`${scope.type}:${scope.public_id}`);}
      allowed.set(capability,keys);
    }
  }else if(!legacyOptions)for(const capability of ['member.manage','delivery.view','request.create'] as const){
    const keys=new Set<string>();
    for(let offset=0;offset<scoped.length;offset+=100){
      const batch=await authorizePrimaryPortalTargetBatch(env,principal,workspaceId,scoped.slice(offset,offset+100).map(scope=>({target:{scopeType:scope.type,publicId:scope.public_id}})),capability);
      for(const id of batch.keys())keys.add(id);
    }
    allowed.set(capability,keys);
  }
  for(const scope of scoped){
    if(!portalHierarchyRelationsEnabled(env)&&scope.type!=='project')continue;
    const targetKey=`${scope.type}:${scope.public_id}`;
    if(!allowed.get('member.manage')?.has(targetKey))continue;
    const capabilities:Array<'delivery.view'|'request.create'>=[];
    for(const cap of ['delivery.view','request.create'] as const)if(allowed.get(cap)?.has(targetKey))capabilities.push(cap);
    if(capabilities.length)inviteScopes.push({type:scope.type,publicId:scope.public_id,displayName:scope.display_name.slice(0,500),capabilities,projectEndSupported:scope.supported===1});
  }
  if(!canManageMembers&&!inviteScopes.length)return null;
  const actor=canManageMembers?await actorIdentity(env,principal):null;
  const members = canManageMembers?await db(env).prepare(secondary?`SELECT m.identity_id,i.verified_email,m.status,m.source_type,
    EXISTS(SELECT 1 FROM portal_v2_entitlements manager WHERE manager.workspace_id=m.workspace_id
      AND manager.identity_id=m.identity_id AND manager.capability='member.manage' AND manager.effect='allow'
      AND manager.scope_type='workspace' AND manager.scope_public_id=m.workspace_id AND manager.status='active'
      AND manager.revoked_at IS NULL AND datetime(manager.valid_from)<=datetime('now') AND manager.expires_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements deny WHERE deny.workspace_id=manager.workspace_id
        AND deny.identity_id=manager.identity_id AND deny.capability='member.manage' AND deny.effect='deny'
        AND deny.scope_type='workspace' AND deny.scope_public_id=m.workspace_id AND deny.status='active'
        AND deny.revoked_at IS NULL AND datetime(deny.valid_from)<=datetime('now')
        AND (deny.expires_at IS NULL OR datetime(deny.expires_at)>datetime('now')))) manager,
    COALESCE((SELECT MAX(versioned.entitlement_version) FROM portal_v2_entitlements versioned
      WHERE versioned.workspace_id=m.workspace_id AND versioned.identity_id=m.identity_id
        AND versioned.capability='member.manage' AND versioned.effect='allow'
        AND versioned.scope_type='workspace' AND versioned.scope_public_id=m.workspace_id),0) manager_version,
    0 local_manager,0 peer_eligible
    FROM portal_v2_workspace_memberships m JOIN portal_v2_identities i ON i.id=m.identity_id
    WHERE m.workspace_id=? AND m.status<>'revoked' ORDER BY lower(i.verified_email),m.identity_id LIMIT 201`:`SELECT m.identity_id,i.verified_email,m.status,m.source_type,
    ${unlimitedWorkspaceCapabilitySql('member.manage',termsReady,principalsReady,identityDenialsEnabled,'m.workspace_id','m.identity_id')} manager,
    COALESCE((SELECT MAX(versioned.entitlement_version) FROM portal_v2_entitlements versioned
      WHERE versioned.workspace_id=m.workspace_id AND versioned.identity_id=m.identity_id
        AND versioned.capability='member.manage' AND versioned.effect='allow'
        AND versioned.scope_type='workspace' AND versioned.scope_public_id=m.workspace_id),0) manager_version,
    EXISTS(SELECT 1 FROM portal_v2_entitlements local_manager WHERE local_manager.workspace_id=m.workspace_id
      AND local_manager.identity_id=m.identity_id AND local_manager.capability='member.manage'
      AND local_manager.effect='allow' AND local_manager.scope_type='workspace'
      AND local_manager.scope_public_id=m.workspace_id AND local_manager.source_type='operations'
      AND local_manager.status='active' AND local_manager.revoked_at IS NULL
      AND datetime(local_manager.valid_from)<=datetime('now') AND local_manager.expires_at IS NULL
      ${termsReady?'AND local_manager.access_terms_id IS NULL':''}) local_manager,
    (m.source_type<>'project_alpha' AND
      ${unlimitedWorkspaceCapabilitySql('workspace.view',termsReady,principalsReady,identityDenialsEnabled,'m.workspace_id','m.identity_id')}) peer_eligible
    FROM portal_v2_workspace_memberships m JOIN portal_v2_identities i ON i.id=m.identity_id
    WHERE m.workspace_id=? AND m.status<>'revoked' ORDER BY lower(i.verified_email),m.identity_id LIMIT 201`)
    .bind(workspaceId).all<{ identity_id: string; verified_email: string | null; status: WorkspaceMemberView["status"]; source_type: string; manager: number;manager_version:number;local_manager:number;peer_eligible:number }>():{results:[]};
  if (members.results.length > 200) return null;
  const invitationRows = canManageMembers?await db(env).prepare(`SELECT id FROM portal_v2_invitations WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT 101`).bind(workspaceId).all<{ id: string }>():{results:[]};
  if (invitationRows.results.length > 100) return null;
  const invitationPolicy=termsReady?await readWorkspaceInvitationPolicy(db(env),workspaceId):{mode:'allowed' as const,version:0};
  const freshSecondary=secondary?await secondaryManagerContext(env,principal,workspaceId):null;
  if(secondary&&!freshSecondary)return null;
  if(!secondary&&!await authorizePortalWorkspaceCapability(env,principal,workspaceId,'workspace.view',{scopeType:'workspace',publicId:workspaceId}))return null;
  if(!secondary&&canManageMembers&&!await authorizePortalWorkspaceCapability(env,principal,workspaceId,'member.manage',{scopeType:'workspace',publicId:workspaceId}))return null;
  const canManageAddressBook=!secondary&&addressBookAvailable&&await canManageWorkspaceAddressBook(env,principal,workspaceId);
  const peerAdminManagement=workspacePeerAdminEnabled(env)&&canManageMembers&&Boolean(actor)&&workspace.root_type==='organization'
    &&workspace.project_alpha_source_id===PRIMARY_ALPHA_SOURCE_ID&&await peerAdminSchemaReady(db(env))
    &&await hasUnlimitedWorkspaceAuthority(db(env),workspaceId,actor!.id,termsReady,principalsReady,identityDenialsEnabled);
  const managerCount=members.results.filter(row=>row.manager===1).length;
  return {sourceId:workspace.project_alpha_source_id,sourceName:'Project Alpha',workspaceName:workspace.display_name,
    canManageMembers,invitationRequestsSupported:secondary?false:requestsReady,inviteScopes,
    addressBookAvailable,canManageAddressBook,
    peerAdminManagement,
    projectAccessTermsSupported:termsReady,invitationPolicy,projectAccessOptions:inviteScopes.filter(scope=>scope.type==='project')
    .map(scope=>({projectPublicId:scope.publicId,projectEndSupported:scope.projectEndSupported})),
    members: members.results.map(row => ({ identityId: row.identity_id, email: row.verified_email, status: row.status,
      manager: row.manager === 1, source: row.source_type,managerVersion:row.manager_version,
      canChangeManager:peerAdminManagement&&row.peer_eligible===1&&(row.manager===0
        ?row.identity_id!==actor?.id:row.local_manager===1&&managerCount>1) })),
    invitations: (await Promise.all(invitationRows.results.map(row => getInvitation(env, workspaceId, row.id)))).filter((value): value is WorkspaceInvitationView => value !== null),
  };
}

async function peerAdminSchemaReady(database:D1Database):Promise<boolean>{
  return await database.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='portal_workspace_peer_admin_commands'")
    .first<number>('ok')===1;
}
async function portalPrincipalsReady(database:D1Database):Promise<boolean>{
  return await database.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='pa_portal_principals'").first<number>('ok')===1;
}

type PeerAdminTargetState={status:string;source:string;expiresAt:string|null;manager:boolean;localManager:boolean;managerVersion:number;eligible:boolean};
async function peerAdminTargetState(database:D1Database,workspaceId:string,identityId:string,termsReady:boolean,
  principalsReady:boolean,identityDenialsEnabled:boolean):Promise<PeerAdminTargetState|null>{
  const row=await database.prepare(`SELECT membership.status,membership.source_type,membership.expires_at,
    COALESCE((SELECT MAX(versioned.entitlement_version) FROM portal_v2_entitlements versioned
      WHERE versioned.workspace_id=membership.workspace_id AND versioned.identity_id=membership.identity_id
        AND versioned.capability='member.manage' AND versioned.effect='allow'
        AND versioned.scope_type='workspace' AND versioned.scope_public_id=membership.workspace_id),0) manager_version,
    ${unlimitedWorkspaceCapabilitySql('member.manage',termsReady,principalsReady,identityDenialsEnabled)} manager,
    EXISTS(SELECT 1 FROM portal_v2_entitlements local_manager WHERE local_manager.workspace_id=membership.workspace_id
      AND local_manager.identity_id=membership.identity_id AND local_manager.capability='member.manage'
      AND local_manager.effect='allow' AND local_manager.scope_type='workspace'
      AND local_manager.scope_public_id=membership.workspace_id AND local_manager.source_type='operations'
      AND local_manager.status='active' AND local_manager.revoked_at IS NULL
      AND datetime(local_manager.valid_from)<=datetime('now') AND local_manager.expires_at IS NULL
      ${termsReady?'AND local_manager.access_terms_id IS NULL':''}) local_manager,
    ${unlimitedWorkspaceCapabilitySql('workspace.view',termsReady,principalsReady,identityDenialsEnabled)} eligible
    FROM portal_v2_workspaces workspace
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=workspace.id
    JOIN portal_v2_identities identity ON identity.id=membership.identity_id
    WHERE workspace.id=? AND workspace.status='active' AND workspace.root_type='organization'
      AND workspace.project_alpha_source_id=? AND membership.identity_id=?
      AND identity.status='active' AND identity.revoked_at IS NULL`)
    .bind(workspaceId,identityId,workspaceId,identityId,workspaceId,PRIMARY_ALPHA_SOURCE_ID,identityId)
    .first<{status:string;source_type:string;expires_at:string|null;manager_version:number;manager:number;local_manager:number;eligible:number}>();
  return row?{status:row.status,source:row.source_type,expiresAt:row.expires_at,manager:row.manager===1,
    localManager:row.local_manager===1,managerVersion:row.manager_version,eligible:row.eligible===1}:null;
}

export type PeerAdminChangeResult=
  |{outcome:'created'|'replayed';manager:boolean;version:number}
  |{outcome:'disabled'|'denied'|'not_found'|'managed_source'|'ineligible'|'last_manager'|'changed'|'conflict'|'invalid'};

async function replayPeerAdminCommand(database:D1Database,workspaceId:string,actorId:string,key:string,hash:string):Promise<PeerAdminChangeResult|null>{
  const row=await database.prepare(`SELECT request_hash,desired_manager,result_version FROM portal_workspace_peer_admin_commands
    WHERE workspace_id=? AND actor_identity_id=? AND idempotency_key=?`).bind(workspaceId,actorId,key)
    .first<{request_hash:string;desired_manager:number;result_version:number}>();
  if(!row)return null;
  return row.request_hash===hash?{outcome:'replayed',manager:row.desired_manager===1,version:row.result_version}:{outcome:'conflict'};
}

export async function changeWorkspacePeerAdministrator(env:AddressBookAccessEnv,principal:VerifiedClientPrincipal,workspaceId:string,
  identityId:string,input:{manager:boolean;expectedVersion:number},idempotencyKey:string):Promise<PeerAdminChangeResult>{
  if(!workspacePeerAdminEnabled(env))return {outcome:'disabled'};
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId)||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(identityId)
    ||!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(idempotencyKey)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)
    return {outcome:'invalid'};
  const database=db(env),actor=await actorIdentity(env,principal);
  if(!actor)return {outcome:'denied'};
  const hash=await digest(JSON.stringify({workspaceId,identityId,manager:input.manager,expectedVersion:input.expectedVersion}));
  if(!await peerAdminSchemaReady(database))return {outcome:'disabled'};
  const replay=await replayPeerAdminCommand(database,workspaceId,actor.id,idempotencyKey,hash);if(replay)return replay;
  const termsReady=await projectAccessTermsReady(database),principalsReady=await portalPrincipalsReady(database);
  const identityDenialsEnabled=portalIdentityDenylistEnabled(env);
  const target=await peerAdminTargetState(database,workspaceId,identityId,termsReady,principalsReady,identityDenialsEnabled);
  if(!target)return {outcome:'not_found'};
  if(target.source==='project_alpha')return {outcome:'managed_source'};
  if(target.status!=='active'||target.expiresAt!==null||!target.eligible)return {outcome:'ineligible'};
  if(target.managerVersion!==input.expectedVersion)return {outcome:'changed'};
  if(input.manager===target.manager)return {outcome:'changed'};
  if(!input.manager&&!target.localManager)return {outcome:'managed_source'};
  if(!await authorizePortalWorkspaceCapability(env,principal,workspaceId,'workspace.view',{scopeType:'workspace',publicId:workspaceId})
    ||!await authorizePortalWorkspaceCapability(env,principal,workspaceId,'member.manage',{scopeType:'workspace',publicId:workspaceId})
    ||!await hasUnlimitedWorkspaceAuthority(database,workspaceId,actor.id,termsReady,principalsReady,identityDenialsEnabled))return {outcome:'denied'};

  const guard:Array<{sql:string;values:unknown[]}>=[];
  guard.push({sql:unlimitedWorkspaceCapabilitySql('workspace.view',termsReady,principalsReady,identityDenialsEnabled),values:[workspaceId,actor.id]});
  guard.push({sql:unlimitedWorkspaceCapabilitySql('member.manage',termsReady,principalsReady,identityDenialsEnabled),values:[workspaceId,actor.id]});
  guard.push({sql:`EXISTS(SELECT 1 FROM portal_v2_workspaces guarded_workspace
    JOIN portal_v2_workspace_memberships guarded_member ON guarded_member.workspace_id=guarded_workspace.id
    JOIN portal_v2_identities guarded_identity ON guarded_identity.id=guarded_member.identity_id
    WHERE guarded_workspace.id=? AND guarded_workspace.status='active' AND guarded_workspace.root_type='organization'
      AND guarded_workspace.project_alpha_source_id=? AND guarded_member.identity_id=?
      AND guarded_member.source_type<>'project_alpha' AND guarded_member.status='active'
      AND guarded_member.revoked_at IS NULL AND guarded_member.expires_at IS NULL
      AND guarded_identity.status='active' AND guarded_identity.revoked_at IS NULL
      AND ${unlimitedWorkspaceCapabilitySql('workspace.view',termsReady,principalsReady,identityDenialsEnabled)})`,values:[workspaceId,PRIMARY_ALPHA_SOURCE_ID,identityId,workspaceId,identityId]});
  guard.push({sql:`COALESCE((SELECT MAX(versioned.entitlement_version) FROM portal_v2_entitlements versioned
    WHERE versioned.workspace_id=? AND versioned.identity_id=? AND versioned.capability='member.manage'
      AND versioned.effect='allow' AND versioned.scope_type='workspace' AND versioned.scope_public_id=?),0)=?`,
    values:[workspaceId,identityId,workspaceId,input.expectedVersion]});
  if(input.manager){
    guard.push({sql:`NOT EXISTS(SELECT 1 FROM portal_v2_entitlements existing_manager
      WHERE existing_manager.workspace_id=? AND existing_manager.identity_id=?
        AND existing_manager.capability='member.manage' AND existing_manager.effect='allow'
        AND existing_manager.scope_type='workspace' AND existing_manager.scope_public_id=?
        AND existing_manager.status='active' AND existing_manager.revoked_at IS NULL
        AND datetime(existing_manager.valid_from)<=datetime('now') AND existing_manager.expires_at IS NULL
        ${termsReady?'AND existing_manager.access_terms_id IS NULL':''})`,values:[workspaceId,identityId,workspaceId]});
    guard.push({sql:`NOT EXISTS(SELECT 1 FROM portal_v2_entitlements manager_deny WHERE manager_deny.workspace_id=?
      AND manager_deny.identity_id=? AND manager_deny.capability='member.manage' AND manager_deny.effect='deny'
      AND manager_deny.scope_type='workspace' AND manager_deny.scope_public_id=? AND manager_deny.status='active'
      AND manager_deny.revoked_at IS NULL AND datetime(manager_deny.valid_from)<=datetime('now')
      AND (manager_deny.expires_at IS NULL OR datetime(manager_deny.expires_at)>datetime('now')))`,values:[workspaceId,identityId,workspaceId]});
  }else{
    guard.push({sql:unlimitedWorkspaceCapabilitySql('member.manage',termsReady,principalsReady,identityDenialsEnabled),values:[workspaceId,identityId]});
    guard.push({sql:`EXISTS(SELECT 1 FROM portal_v2_entitlements local_manager WHERE local_manager.workspace_id=?
      AND local_manager.identity_id=? AND local_manager.capability='member.manage' AND local_manager.effect='allow'
      AND local_manager.scope_type='workspace' AND local_manager.scope_public_id=? AND local_manager.source_type='operations'
      AND local_manager.status='active' AND local_manager.revoked_at IS NULL AND local_manager.expires_at IS NULL
      ${termsReady?'AND local_manager.access_terms_id IS NULL':''})`,values:[workspaceId,identityId,workspaceId]});
    guard.push({sql:`EXISTS(SELECT 1 FROM portal_v2_workspace_memberships other_member
      WHERE other_member.workspace_id=? AND other_member.identity_id<>?
        AND ${unlimitedWorkspaceCapabilitySql('workspace.view',termsReady,principalsReady,identityDenialsEnabled,'other_member.workspace_id','other_member.identity_id')}
        AND ${unlimitedWorkspaceCapabilitySql('member.manage',termsReady,principalsReady,identityDenialsEnabled,'other_member.workspace_id','other_member.identity_id')})`,values:[workspaceId,identityId]});
  }
  const nextVersion=input.expectedVersion+1,entitlementId=crypto.randomUUID(),fenceId=crypto.randomUUID(),auditId=crypto.randomUUID();
  const statements:D1PreparedStatement[]=[database.prepare(`INSERT INTO portal_workspace_peer_admin_fences(id,write_guard)
    VALUES(?,CASE WHEN ${guard.map(part=>`(${part.sql})`).join(' AND ')} THEN 1 ELSE 0 END)`).bind(fenceId,...guard.flatMap(part=>part.values))];
  if(!input.manager)statements.push(database.prepare(`UPDATE portal_v2_entitlements SET status='revoked',revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE workspace_id=? AND identity_id=? AND capability='member.manage' AND effect='allow' AND scope_type='workspace'
      AND scope_public_id=? AND source_type='operations' AND status='active' AND revoked_at IS NULL`)
    .bind(workspaceId,identityId,workspaceId));
  statements.push(database.prepare(`INSERT INTO portal_v2_entitlements
    (id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,status,revoked_at)
    VALUES(?,?,?,'member.manage','allow','workspace',?,?,'operations',?,?)`)
    .bind(entitlementId,workspaceId,identityId,workspaceId,nextVersion,input.manager?'active':'revoked',input.manager?null:new Date().toISOString()));
  statements.push(database.prepare(`INSERT INTO portal_workspace_peer_admin_commands
    (workspace_id,actor_identity_id,idempotency_key,request_hash,target_identity_id,desired_manager,result_version)
    VALUES(?,?,?,?,?,?,?)`).bind(workspaceId,actor.id,idempotencyKey,hash,identityId,input.manager?1:0,nextVersion));
  statements.push(database.prepare(`INSERT INTO portal_workspace_peer_admin_audit
    (id,workspace_id,actor_identity_id,target_identity_id,action,target_version,details_json)
    VALUES(?,?,?,?,?,?,?)`).bind(auditId,workspaceId,actor.id,identityId,input.manager?'manager.promoted':'manager.demoted',nextVersion,
      JSON.stringify({authority:'client_peer_admin',membershipPreserved:true})));
  try{await database.batch(statements);}catch{
    const raced=await replayPeerAdminCommand(database,workspaceId,actor.id,idempotencyKey,hash);if(raced)return raced;
    const current=await peerAdminTargetState(database,workspaceId,identityId,termsReady,principalsReady,identityDenialsEnabled);
    if(!current)return {outcome:'not_found'};if(current.source==='project_alpha')return {outcome:'managed_source'};
    if(current.managerVersion!==input.expectedVersion)return {outcome:'changed'};
    if(!await hasUnlimitedWorkspaceAuthority(database,workspaceId,actor.id,termsReady,principalsReady,identityDenialsEnabled))return {outcome:'denied'};
    if(current.status!=='active'||current.expiresAt!==null||!current.eligible)return {outcome:'ineligible'};
    if(!input.manager&&current.manager&&current.localManager)return {outcome:'last_manager'};
    return {outcome:'ineligible'};
  }
  const saved=await replayPeerAdminCommand(database,workspaceId,actor.id,idempotencyKey,hash);
  return saved&&saved.outcome==='replayed'?{...saved,outcome:'created'}:{outcome:'changed'};
}

export async function revokeWorkspaceInvitation(env: Env, principal: VerifiedClientPrincipal, workspaceId: string, invitationId: string): Promise<boolean> {
  const actor = await actorIdentity(env, principal);
  if (!actor) return false;
  const secondary=await secondaryManagerContext(env,principal,workspaceId);
  const inviteScope = await db(env).prepare(`SELECT grant_record.scope_type,grant_record.scope_public_id
    FROM portal_v2_invitations invitation
    JOIN portal_v2_invitation_entitlements grant_record ON grant_record.invitation_id=invitation.id
    WHERE invitation.id=? AND invitation.workspace_id=?
    ORDER BY CASE WHEN grant_record.scope_type='workspace' THEN 1 ELSE 0 END
    LIMIT 1`).bind(invitationId, workspaceId)
    .first<{ scope_type: PortalWorkspaceTarget["scopeType"]; scope_public_id: string }>();
  if (!inviteScope || (secondary
    ?!(await secondaryTargetAllowed(env,secondary,workspaceId,{scopeType:inviteScope.scope_type,publicId:inviteScope.scope_public_id}))
    :!(await authorizePortalWorkspaceCapability(env, principal, workspaceId, "member.manage", {
      scopeType: inviteScope.scope_type,publicId: inviteScope.scope_public_id,
  })))) return false;
  const database = db(env);
  let secondaryDelegation:Awaited<ReturnType<typeof captureWorkspaceInvitationDelegation>>|null=null;
  if(secondary){try{secondaryDelegation=await captureWorkspaceInvitationDelegation(env,{workspaceId,
    target:{scopeType:inviteScope.scope_type,publicId:inviteScope.scope_public_id},identityId:actor.id,
    issuer:principal.issuer,subject:principal.subject,email:principal.email.trim().toLowerCase()},[],null);}catch{return false;}}
  const revoke=database.prepare(`UPDATE portal_v2_invitations SET status='revoked',revoked_at=datetime('now')
    WHERE id=? AND workspace_id=? AND status='pending' AND revoked_at IS NULL`).bind(invitationId, workspaceId);
  const changed = secondary
    ?(await database.batch([secondaryFreshFence(database,secondary,principal,workspaceId,`secondary-revoke-${crypto.randomUUID()}`),
      secondaryDelegation!.fence(`secondary-revoke-delegation-${crypto.randomUUID()}`),revoke]))[2]
    :await revoke.run();
  // D1 includes the terminal-secret scrub trigger's outbox update in changes.
  // Zero is the only failure signal for the guarded invitation transition.
  if (!changed || changed.meta.changes < 1) return false;
  await database.batch([
    database.prepare(`UPDATE portal_v2_invitation_email_outbox SET
      status=CASE WHEN status='sent' THEN 'sent' ELSE 'cancelled' END,payload_json='{"redacted":true}',
      lease_expires_at=NULL,last_error_code=NULL,updated_at=datetime('now') WHERE invitation_id=?`).bind(invitationId),
    database.prepare(`INSERT INTO portal_v2_membership_audit(id,workspace_id,actor_identity_id,action,invitation_id)
      VALUES (?,?,?,'invitation.revoked',?)`).bind(crypto.randomUUID(), workspaceId, actor.id, invitationId),
  ]);
  return true;
}

export type SuspendMemberResult = "suspended" | "denied" | "last_manager" | "managed_source" | "not_found";
export async function suspendWorkspaceMember(env: Env, principal: VerifiedClientPrincipal, workspaceId: string, identityId: string): Promise<SuspendMemberResult> {
  const actor = await actorIdentity(env, principal);
  if(!actor)return 'denied';
  const secondary=await secondaryManagerContext(env,principal,workspaceId);
  if(!secondary&&!(await authorizePortalWorkspaceCapability(env, principal, workspaceId, "member.manage", { scopeType: "workspace", publicId: workspaceId }))) return "denied";
  const target = await db(env).prepare(`SELECT status,source_type,EXISTS(SELECT 1 FROM portal_v2_entitlements e WHERE e.workspace_id=m.workspace_id AND e.identity_id=m.identity_id
    AND e.capability='member.manage' AND e.effect='allow' AND e.status='active' AND e.revoked_at IS NULL
    AND e.scope_type='workspace' AND e.scope_public_id=m.workspace_id
    AND datetime(e.valid_from)<=datetime('now') AND (e.expires_at IS NULL OR datetime(e.expires_at)>datetime('now'))
    AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements denied WHERE denied.workspace_id=e.workspace_id
      AND denied.identity_id=e.identity_id AND denied.capability='member.manage' AND denied.effect='deny'
      AND denied.status='active' AND denied.revoked_at IS NULL AND denied.scope_type='workspace'
      AND denied.scope_public_id=e.workspace_id AND datetime(denied.valid_from)<=datetime('now')
      AND (denied.expires_at IS NULL OR datetime(denied.expires_at)>datetime('now')))) manager
    FROM portal_v2_workspace_memberships m WHERE m.workspace_id=? AND m.identity_id=?`).bind(workspaceId, identityId)
    .first<{ status: string; source_type: string; manager: number }>();
  if (!target || target.status !== "active") return "not_found";
  if (target.source_type === "project_alpha") return "managed_source";
  const database = db(env);
  let secondaryDelegation:Awaited<ReturnType<typeof captureWorkspaceInvitationDelegation>>|null=null;
  if(secondary){try{secondaryDelegation=await captureWorkspaceInvitationDelegation(env,{workspaceId,
    target:{scopeType:'workspace',publicId:workspaceId},identityId:actor.id,issuer:principal.issuer,
    subject:principal.subject,email:principal.email.trim().toLowerCase()},[],null);}catch{return 'denied';}}
  await database.batch([
    ...(secondary?[secondaryFreshFence(database,secondary,principal,workspaceId,`secondary-suspend-${crypto.randomUUID()}`),
      secondaryDelegation!.fence(`secondary-suspend-delegation-${crypto.randomUUID()}`)]:[]),
    database.prepare(`UPDATE portal_v2_workspace_memberships AS target SET status='suspended',updated_at=datetime('now')
      WHERE target.workspace_id=? AND target.identity_id=? AND target.status='active'
        AND (NOT EXISTS(SELECT 1 FROM portal_v2_entitlements target_allow WHERE target_allow.workspace_id=target.workspace_id
          AND target_allow.identity_id=target.identity_id AND target_allow.capability='member.manage'
          AND target_allow.effect='allow' AND target_allow.status='active' AND target_allow.revoked_at IS NULL
          AND target_allow.scope_type='workspace' AND target_allow.scope_public_id=target.workspace_id
          AND datetime(target_allow.valid_from)<=datetime('now') AND (target_allow.expires_at IS NULL OR datetime(target_allow.expires_at)>datetime('now'))
          AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements target_deny WHERE target_deny.workspace_id=target_allow.workspace_id
            AND target_deny.identity_id=target_allow.identity_id AND target_deny.capability='member.manage'
            AND target_deny.effect='deny' AND target_deny.status='active' AND target_deny.revoked_at IS NULL
            AND target_deny.scope_type='workspace' AND target_deny.scope_public_id=target_allow.workspace_id
            AND datetime(target_deny.valid_from)<=datetime('now') AND (target_deny.expires_at IS NULL OR datetime(target_deny.expires_at)>datetime('now'))))
        OR EXISTS(SELECT 1 FROM portal_v2_workspace_memberships other
          JOIN portal_v2_identities other_identity ON other_identity.id=other.identity_id AND other_identity.status='active' AND other_identity.revoked_at IS NULL
          JOIN portal_v2_entitlements other_allow ON other_allow.workspace_id=other.workspace_id AND other_allow.identity_id=other.identity_id
          WHERE other.workspace_id=target.workspace_id AND other.identity_id<>target.identity_id AND other.status='active' AND other.revoked_at IS NULL
            AND (other.expires_at IS NULL OR datetime(other.expires_at)>datetime('now'))
            AND other_allow.capability='member.manage' AND other_allow.effect='allow' AND other_allow.status='active' AND other_allow.revoked_at IS NULL
            AND other_allow.scope_type='workspace' AND other_allow.scope_public_id=target.workspace_id
            AND datetime(other_allow.valid_from)<=datetime('now') AND (other_allow.expires_at IS NULL OR datetime(other_allow.expires_at)>datetime('now'))
            AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements other_deny WHERE other_deny.workspace_id=other_allow.workspace_id
              AND other_deny.identity_id=other_allow.identity_id AND other_deny.capability='member.manage'
              AND other_deny.effect='deny' AND other_deny.status='active' AND other_deny.revoked_at IS NULL
              AND other_deny.scope_type='workspace' AND other_deny.scope_public_id=other_allow.workspace_id
              AND datetime(other_deny.valid_from)<=datetime('now') AND (other_deny.expires_at IS NULL OR datetime(other_deny.expires_at)>datetime('now')))))`).bind(workspaceId, identityId),
    database.prepare(`UPDATE portal_v2_entitlements SET status='suspended' WHERE workspace_id=? AND identity_id=? AND status='active' AND changes()=1`).bind(workspaceId, identityId),
    database.prepare(`INSERT INTO portal_v2_membership_audit(id,workspace_id,actor_identity_id,action,subject_identity_id)
      SELECT ?,?,?, 'membership.suspended',? WHERE changes()=1`).bind(crypto.randomUUID(), workspaceId, actor.id, identityId),
  ]);
  // D1 may include rows changed by migration-owned lifecycle triggers in the
  // first statement's metadata. Read the guarded state instead of treating a
  // trigger-expanded change count as a failed membership transition.
  const status = await database.prepare(`SELECT status FROM portal_v2_workspace_memberships
    WHERE workspace_id=? AND identity_id=?`).bind(workspaceId, identityId).first("status");
  if (status === "suspended") return "suspended";
  return target.manager === 1 ? "last_manager" : "not_found";
}
