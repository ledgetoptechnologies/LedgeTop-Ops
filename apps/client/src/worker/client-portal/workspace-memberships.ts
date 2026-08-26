import type { PortalAuthorizationEnv as Env } from './workspace-v2';
import type {Env as ClientEnv} from '../types';
import { invitationRecipientEmailHash } from "./access-enrollment-receipts";
import type { VerifiedClientPrincipal } from "./types";
import {
  authorizePortalWorkspaceCapability,
  portalHierarchyV2Enabled,
  type PortalWorkspaceCapability,
  type PortalWorkspaceTarget,
  authorizePrimaryPortalTargetBatch,
  readLegacyInvitationCapabilityOptions,
} from "./workspace-v2";
import { portalHierarchyRelationsEnabled,resolvePortalRelationAuthorizedTargets } from "./hierarchy-relations";
import { parseProjectAccessTerms,prepareProjectAccessTerms,projectAccessTermsReady,readProjectAccessTerms,readWorkspaceInvitationPolicy,
  type ProjectAccessTermsInput,type ProjectAccessTermsView } from './project-access-terms';
import { captureProjectInvitationDelegation } from './project-invitation-delegation';
import {invitationRequestsReady,submitWorkspaceInvitationRequest,replaySubmittedWorkspaceInvitationRequest,type WorkspaceInvitationRequestView} from './workspace-invitation-requests';
import {PRIMARY_ALPHA_SOURCE_ID} from '@ltds/shared';
import {HTTPException} from 'hono/http-exception';
import {canManageWorkspaceAddressBook,workspaceAddressBookAvailableFor} from './workspace-address-book';
import {prepareAddressBookContactSelection,type AddressBookContactSelection} from './workspace-address-book';

type AddressBookAccessEnv=Env&Partial<Pick<ClientEnv,'CLIENT_PORTAL_ADDRESS_BOOK_ENABLED'|'CLIENT_PORTAL_ADDRESS_BOOK_FINGERPRINT_SECRET'|'DELIVERY_SESSION_SECRET'|'DELIVERY_PREVIOUS_SESSION_SECRET'>>;

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
}

type Identity = { id: string };

function db(env: Env): D1Database { return env.DELIVERY_DB; }

export function workspaceMembershipManagementEnabled(env: Env): boolean {
  return portalHierarchyV2Enabled(env) && env.CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED === "true";
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
  | { outcome: "denied" | "invalid" | "conflict" | "rate_limited" | "approval_required" | "policy_disabled" | 'mail_unavailable' };

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
  if (!(await authorizePortalWorkspaceCapability(env, principal, workspaceId, "member.manage", selectedTarget))) return { outcome: "denied" };

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
  const sourceId=accessTerms?await db(env).prepare('SELECT project_alpha_source_id FROM portal_v2_workspaces WHERE id=?').bind(workspaceId).first<string>('project_alpha_source_id'):null;
  const preparedTerms=accessTerms?await prepareProjectAccessTerms(db(env),{workspaceId,sourceId:sourceId??'',projectPublicId:selectedTarget.publicId},accessTerms,
    {type:'identity',id:actor.id},`invitation-${invitationId}`):null;
  const delegation=preparedTerms?await captureProjectInvitationDelegation(env,{workspaceId,projectId:selectedTarget.publicId,identityId:actor.id,
    issuer:principal.issuer,subject:principal.subject,email:principal.email.trim().toLowerCase()},capabilities,preparedTerms.view):null;
  if(delegation){
    for(const capability of new Set<PortalWorkspaceCapability>(['member.manage','workspace.view',...capabilities])){
      const target=capability==='workspace.view'?{scopeType:'workspace' as const,publicId:workspaceId}:selectedTarget;
      if(!await authorizePortalWorkspaceCapability(env,principal,workspaceId,capability,target))return {outcome:'denied'};
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
  try {
    await database.batch([
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
  } catch {
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
  projectAccessTermsSupported:boolean;invitationPolicy:{mode:'allowed'|'disabled'|'require_approval';version:number};projectAccessOptions:Array<{projectPublicId:string;projectEndSupported:boolean}> } | null> {
  if(!await authorizePortalWorkspaceCapability(env,principal,workspaceId,'workspace.view',{scopeType:'workspace',publicId:workspaceId}))return null;
  const canManageMembers=await authorizePortalWorkspaceCapability(env, principal, workspaceId, "member.manage", { scopeType: "workspace", publicId: workspaceId });
  const termsReady=await projectAccessTermsReady(db(env)),requestsReady=await invitationRequestsReady(db(env));
  const addressBookAvailable=await workspaceAddressBookAvailableFor(env,workspaceId);
  const workspace=await db(env).prepare('SELECT display_name,project_alpha_source_id FROM portal_v2_workspaces WHERE id=? AND status=\'active\'').bind(workspaceId)
    .first<{display_name:string;project_alpha_source_id:string}>();
  if(!workspace||workspace.project_alpha_source_id!==PRIMARY_ALPHA_SOURCE_ID)return null;
  const scopeRows=(await db(env).prepare(`SELECT e.entity_type type,e.public_id,e.display_name,${termsReady?`EXISTS(SELECT 1 FROM portal_project_access_current_lifecycle l WHERE l.workspace_id=e.workspace_id AND l.project_public_id=e.public_id)`:'0'} supported
    FROM portal_v2_directory_checkpoints cp JOIN portal_v2_directory_generations g ON g.id=cp.active_generation_id AND g.workspace_id=cp.workspace_id AND g.status='active' AND g.complete=1
    JOIN portal_v2_directory_entities e ON e.workspace_id=cp.workspace_id AND e.generation_id=cp.active_generation_id AND e.active=1
    WHERE cp.workspace_id=? AND e.entity_type IN ('organization','department','client','project') ORDER BY e.entity_type,e.public_id LIMIT 201`)
    .bind(workspaceId).all<{type:WorkspaceInviteScope['type'];public_id:string;display_name:string;supported:number}>()).results;
  if(scopeRows.length>200)return null;
  const inviteScopes:WorkspaceInviteScope[]=[];
  const scoped=scopeRows.filter(scope=>portalHierarchyRelationsEnabled(env)||scope.type==='project');
  const legacyOptions=await readLegacyInvitationCapabilityOptions(env,principal,workspaceId,
    scoped.map(scope=>({scopeType:scope.type,publicId:scope.public_id})));
  const allowed=legacyOptions??new Map<PortalWorkspaceCapability,Set<string>>();
  if(!legacyOptions)for(const capability of ['member.manage','delivery.view','request.create'] as const){
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
  const members = canManageMembers?await db(env).prepare(`SELECT m.identity_id,i.verified_email,m.status,m.source_type,
    EXISTS(SELECT 1 FROM portal_v2_entitlements e WHERE e.workspace_id=m.workspace_id AND e.identity_id=m.identity_id
      AND e.capability='member.manage' AND e.effect='allow' AND e.status='active' AND e.revoked_at IS NULL
      AND e.scope_type='workspace' AND e.scope_public_id=m.workspace_id
      AND datetime(e.valid_from)<=datetime('now') AND (e.expires_at IS NULL OR datetime(e.expires_at)>datetime('now'))
      AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements denied WHERE denied.workspace_id=e.workspace_id
        AND denied.identity_id=e.identity_id AND denied.capability='member.manage' AND denied.effect='deny'
        AND denied.status='active' AND denied.revoked_at IS NULL AND denied.scope_type='workspace'
        AND denied.scope_public_id=e.workspace_id AND datetime(denied.valid_from)<=datetime('now')
        AND (denied.expires_at IS NULL OR datetime(denied.expires_at)>datetime('now')))) manager
    FROM portal_v2_workspace_memberships m JOIN portal_v2_identities i ON i.id=m.identity_id
    WHERE m.workspace_id=? AND m.status<>'revoked' ORDER BY lower(i.verified_email),m.identity_id LIMIT 201`)
    .bind(workspaceId).all<{ identity_id: string; verified_email: string | null; status: WorkspaceMemberView["status"]; source_type: string; manager: number }>():{results:[]};
  if (members.results.length > 200) return null;
  const invitationRows = canManageMembers?await db(env).prepare(`SELECT id FROM portal_v2_invitations WHERE workspace_id=? ORDER BY created_at DESC,id DESC LIMIT 101`).bind(workspaceId).all<{ id: string }>():{results:[]};
  if (invitationRows.results.length > 100) return null;
  const invitationPolicy=termsReady?await readWorkspaceInvitationPolicy(db(env),workspaceId):{mode:'allowed' as const,version:0};
  if(!await authorizePortalWorkspaceCapability(env,principal,workspaceId,'workspace.view',{scopeType:'workspace',publicId:workspaceId}))return null;
  if(canManageMembers&&!await authorizePortalWorkspaceCapability(env,principal,workspaceId,'member.manage',{scopeType:'workspace',publicId:workspaceId}))return null;
  const canManageAddressBook=addressBookAvailable&&await canManageWorkspaceAddressBook(env,principal,workspaceId);
  return {sourceId:workspace.project_alpha_source_id,sourceName:'Project Alpha',workspaceName:workspace.display_name,
    canManageMembers,invitationRequestsSupported:requestsReady,inviteScopes,
    addressBookAvailable,canManageAddressBook,
    projectAccessTermsSupported:termsReady,invitationPolicy,projectAccessOptions:inviteScopes.filter(scope=>scope.type==='project')
    .map(scope=>({projectPublicId:scope.publicId,projectEndSupported:scope.projectEndSupported})),
    members: members.results.map(row => ({ identityId: row.identity_id, email: row.verified_email, status: row.status, manager: row.manager === 1, source: row.source_type })),
    invitations: (await Promise.all(invitationRows.results.map(row => getInvitation(env, workspaceId, row.id)))).filter((value): value is WorkspaceInvitationView => value !== null),
  };
}

export async function revokeWorkspaceInvitation(env: Env, principal: VerifiedClientPrincipal, workspaceId: string, invitationId: string): Promise<boolean> {
  const actor = await actorIdentity(env, principal);
  if (!actor) return false;
  const inviteScope = await db(env).prepare(`SELECT grant_record.scope_type,grant_record.scope_public_id
    FROM portal_v2_invitations invitation
    JOIN portal_v2_invitation_entitlements grant_record ON grant_record.invitation_id=invitation.id
    WHERE invitation.id=? AND invitation.workspace_id=?
    ORDER BY CASE WHEN grant_record.scope_type='workspace' THEN 1 ELSE 0 END
    LIMIT 1`).bind(invitationId, workspaceId)
    .first<{ scope_type: PortalWorkspaceTarget["scopeType"]; scope_public_id: string }>();
  if (!inviteScope || !(await authorizePortalWorkspaceCapability(env, principal, workspaceId, "member.manage", {
    scopeType: inviteScope.scope_type,
    publicId: inviteScope.scope_public_id,
  }))) return false;
  const database = db(env);
  const changed = await database.prepare(`UPDATE portal_v2_invitations SET status='revoked',revoked_at=datetime('now')
    WHERE id=? AND workspace_id=? AND status='pending' AND revoked_at IS NULL`).bind(invitationId, workspaceId).run();
  // D1 includes the terminal-secret scrub trigger's outbox update in changes.
  // Zero is the only failure signal for the guarded invitation transition.
  if (changed.meta.changes < 1) return false;
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
  if (!actor || !(await authorizePortalWorkspaceCapability(env, principal, workspaceId, "member.manage", { scopeType: "workspace", publicId: workspaceId }))) return "denied";
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
  await database.batch([
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
