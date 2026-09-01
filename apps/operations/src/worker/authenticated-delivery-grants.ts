import { HTTPException } from "hono/http-exception";
import { projectAccessCapacitySql } from '../../../client/src/worker/client-portal/project-access-capacity';
import { requirePermission } from "./acl";
import { normalizePrefix, resolveDivisionAssociation } from "./delivery";
import type { Env, StaffPrincipal } from "./types";
import { isAlphaPublicId,validatedUniquePublicIdExpression } from './client-hub-source';
import { projectAlphaReadVisibleSql } from './project-alpha-read-visibility';
import { prepareProjectAccessTerms,parseProjectAccessTerms,projectAccessTermsReady,projectAccessTermsSql,projectAccessTermsExpirySql,
  type ProjectAccessTermsInput } from '../../../client/src/worker/client-portal/project-access-terms';
import { projectAccessReadColumns } from '../../../client/src/worker/client-portal/project-access-read';
import { projectAccessAuthorityHistoryReady,projectAccessGrantEvent } from '../../../client/src/worker/client-portal/project-access-authority-history';
import { NATIVE_PORTAL_TARGET_SCOPES_SQL,readNativeTargetScopes } from '../../../client/src/worker/client-portal/native-portal-scopes';
import { authorizePortalWorkspaceCapability } from '../../../client/src/worker/client-portal/workspace-v2';
import {requireProjectAccessAuthorityMutations} from './project-access-mutation-gate';

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const REASON = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SEARCH_LIMIT = 20;
const RECIPIENT_LIMIT = 200;
export type AuthenticatedGrantAudienceType = "organization" | "department" | "client" | "project" | "principal";

interface BindingContext {
  id: string;
  workspaceId: string;
  sourceVersion: string;
  ownerType: Exclude<AuthenticatedGrantAudienceType, "principal">;
  ownerPublicId: string;
  prefix: string;
  generationId: string;
  divisionId: string;
  workspaceLabel:string;
  ownerName:string;
  rootType:'organization'|'standalone_client';
  rootPublicId:string;
}

interface Recipient {
  principalPublicId: string;
  identityId: string;
  sourceVersion: string;
}

export interface AuthenticatedDeliveryGrantNotificationTarget {
  grantId: string;
  logicalGrantId: string;
  grantVersion: number;
  workspaceId: string;
  folderBindingId: string;
  bindingSourceVersion: string;
  ownerScopeType: Exclude<AuthenticatedGrantAudienceType, "principal">;
  ownerPublicId: string;
  r2Prefix: string;
  principalPublicId: string;
  principalSourceVersion: string;
  identityId: string;
  divisionId: string;
  workspaceLabel: string;
  folderLabel: string;
  sourceId: "project-alpha:primary";
  active: boolean;
}

export interface AuthenticatedDeliveryGrantView {
  id: string;
  grantId: string;
  version: number;
  workspaceId: string;
  folderBindingId: string;
  audience: { type: AuthenticatedGrantAudienceType; publicId: string };
  status: "active" | "revoked" | "expired";
  expiresAt: string | null;
  recipientCount: number;
  createdAt: string;
  updatedAt: string;
  accessTerms:ProjectAccessTermsInput|null;
  effectiveAccessExpiresAt:string|null;
}

export interface AuthenticatedDeliveryGrantInput {
  folderBindingId:string;audienceType:AuthenticatedGrantAudienceType;audiencePublicId:string;reasonCode:string;
  expiresAt?:string|null;accessTerms?:ProjectAccessTermsInput;expectedContextVersion?:string;
}
export interface AuthenticatedDeliveryGrantPreview {
  operation:Omit<AuthenticatedDeliveryGrantInput,'expectedContextVersion'>;contextVersion:string;
  folderBindingId:string;workspaceId:string;workspaceLabel:string;sourceId:'project-alpha:primary';
  projectName:string|null;accessTermsSupported:boolean;projectEndSupported:boolean;
  audienceLabel:string;recipientCount:number;dynamicAudience:boolean;
  recipientPreview:{mode:'exact'|'dynamic';currentAuthorizedCount:number|null;truncated:boolean};
  accessTerms:ProjectAccessTermsInput|null;effectiveAccessExpiresAt:string|null;
}

export interface AuthenticatedDeliveryGrantAudienceSearchResult {
  type:AuthenticatedGrantAudienceType;publicId:string;displayName:string;email?:string|null;
  recipientMode:'exact'|'dynamic';currentAuthorizedRecipientCount?:number;recipientCountTruncated?:boolean;
}

export interface AuthenticatedDeliveryGrantListItem extends AuthenticatedDeliveryGrantView {
  workspaceLabel: string;
  audienceLabel: string;
  dynamicAudience: boolean;
}

function deliveryDb(env: Env): D1Database {
  const db = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return db.withSession?.("first-primary") ?? db;
}

export function authenticatedDeliveryGrantsEnabled(env: Env): boolean {
  return env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED === "true" &&
    env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED === "true";
}

function requireEnabled(env: Env): void {
  if (!authenticatedDeliveryGrantsEnabled(env)) throw new HTTPException(404, { message: "Not found" });
}

async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedExpiry(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= Date.now() + 5 * 60_000 || parsed > Date.now() + 366 * 24 * 60 * 60 * 1000)
    throw new HTTPException(400, { message: "Grant expiry must be between five minutes and one year from now" });
  return new Date(parsed).toISOString();
}

async function bindingContext(env: Env, bindingId: string): Promise<BindingContext> {
  if (!OPAQUE.test(bindingId)) throw new HTTPException(404, { message: "Folder binding not found" });
  const row = await deliveryDb(env).prepare(`SELECT binding.id,binding.workspace_id,binding.owner_scope_type,
      binding.owner_public_id,binding.r2_prefix,binding.source_version,checkpoint.active_generation_id,
      workspace.display_name workspace_label,workspace.root_type,COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) root_public_id,owner.display_name owner_name
    FROM portal_v2_folder_bindings binding
    JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id AND workspace.status='active'
      AND workspace.project_alpha_source_id='project-alpha:primary'
      AND (workspace.legacy_account_id IS NULL OR EXISTS (SELECT 1 FROM client_accounts account
        WHERE account.id=workspace.legacy_account_id AND (account.project_alpha_source_id IS NULL OR account.project_alpha_source_id='project-alpha:primary')))
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=binding.workspace_id
    JOIN portal_v2_directory_generations generation
      ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=checkpoint.workspace_id
      AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities owner
      ON owner.workspace_id=binding.workspace_id AND owner.generation_id=checkpoint.active_generation_id
      AND owner.entity_type=binding.owner_scope_type AND owner.public_id=binding.owner_public_id AND owner.active=1
    WHERE binding.id=? AND binding.status='active' AND binding.revoked_at IS NULL
      AND binding.source_version IS NOT NULL`).bind(bindingId).first<{
      id: string; workspace_id: string; owner_scope_type: BindingContext["ownerType"];
      owner_public_id: string; r2_prefix: string; source_version: string; active_generation_id: string;
      workspace_label:string;root_type:BindingContext['rootType'];root_public_id:string;owner_name:string;
    }>();
  if (!row) throw new HTTPException(404, { message: "Folder binding not found" });
  const prefix = normalizePrefix(row.r2_prefix);
  const candidates = await env.OPS_DB.withSession("first-primary").prepare(`SELECT project_folders.division_id,project_folders.r2_prefix
    FROM project_folders JOIN pa_projects ON pa_projects.id=project_folders.project_id AND pa_projects.active=1 AND pa_projects.projection_source_id='project-alpha:primary'
    WHERE substr(?,1,length(project_folders.r2_prefix))=project_folders.r2_prefix
    ORDER BY length(project_folders.r2_prefix) DESC LIMIT 51`).bind(prefix)
    .all<{ division_id: string; r2_prefix: string }>();
  if (candidates.results.length > 50) throw new HTTPException(409, { message: "Folder association is too broad" });
  const matching = candidates.results.filter(candidate => prefix.startsWith(normalizePrefix(candidate.r2_prefix)));
  if (!matching.length) throw new HTTPException(404, { message: "Folder binding not found" });
  const longest = Math.max(...matching.map(candidate => normalizePrefix(candidate.r2_prefix).length));
  const divisionId = resolveDivisionAssociation(prefix, matching.filter(candidate => normalizePrefix(candidate.r2_prefix).length === longest));
  if (!divisionId) throw new HTTPException(409, { message: "Folder binding association is ambiguous" });
  return { id: row.id, workspaceId: row.workspace_id, sourceVersion: row.source_version,
    ownerType: row.owner_scope_type, ownerPublicId: row.owner_public_id, prefix,
    generationId: row.active_generation_id, divisionId,workspaceLabel:row.workspace_label,ownerName:row.owner_name,rootType:row.root_type,rootPublicId:row.root_public_id };
}

async function bindingIdForFolderKey(env: Env, folderKey: string): Promise<string> {
  const prefix = normalizePrefix(folderKey);
  const rows = await deliveryDb(env).prepare(`SELECT binding.id,binding.r2_prefix
    FROM portal_v2_folder_bindings binding JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id
    WHERE binding.status='active' AND binding.revoked_at IS NULL AND binding.r2_prefix IN (?,?)
      AND workspace.project_alpha_source_id='project-alpha:primary'
    ORDER BY binding.updated_at DESC,binding.id LIMIT 2`).bind(prefix, prefix.slice(0, -1)).all<{ id: string; r2_prefix: string }>();
  const matches = rows.results.filter(row => normalizePrefix(row.r2_prefix) === prefix);
  if (matches.length !== 1) throw new HTTPException(404, { message: "This folder is not bound to a client workspace" });
  return matches[0]!.id;
}

/** Resolve the one immutable recipient of an exact-principal grant. This is
 * deliberately keyed only by the physical grant ID: staff policy routes must
 * never accept a browser-supplied identity or recipient address. The binding
 * lookup also proves the current primary source and exact Operations division. */
export async function resolveAuthenticatedDeliveryGrantNotificationTarget(
  env: Env,
  grantId: string,
): Promise<AuthenticatedDeliveryGrantNotificationTarget | null> {
  requireEnabled(env);
  if (!OPAQUE.test(grantId)) return null;
  const rows = await deliveryDb(env).prepare(`SELECT grant_record.id,grant_record.logical_grant_id,
      grant_record.grant_version,grant_record.workspace_id,grant_record.folder_binding_id,
      grant_record.binding_source_version,grant_record.audience_public_id,grant_record.audience_source_version,
      grant_record.status,grant_record.revoked_at,grant_record.expires_at,recipient.identity_id,
      ${projectAccessTermsSql({termsId:'grant_record.access_terms_id',workspaceId:'grant_record.workspace_id',
        projectId:'(SELECT project_public_id FROM portal_project_access_terms WHERE id=grant_record.access_terms_id)',legacyRetained:'1'})} terms_current
    FROM portal_v2_authenticated_delivery_grants grant_record
    JOIN portal_v2_workspaces workspace ON workspace.id=grant_record.workspace_id
      AND workspace.status='active' AND workspace.project_alpha_source_id='project-alpha:primary'
    JOIN portal_v2_authenticated_delivery_grant_recipients recipient ON recipient.grant_id=grant_record.id
      AND recipient.workspace_id=grant_record.workspace_id
      AND recipient.principal_public_id=grant_record.audience_public_id
      AND recipient.principal_source_version=grant_record.audience_source_version
    WHERE grant_record.id=? AND grant_record.audience_type='principal' LIMIT 2`)
    .bind(grantId).all<{id:string;logical_grant_id:string;grant_version:number;workspace_id:string;
      folder_binding_id:string;binding_source_version:string;audience_public_id:string;audience_source_version:string;
      identity_id:string;status:string;revoked_at:string|null;expires_at:string|null;terms_current:number}>();
  if (rows.results.length !== 1) return null;
  const row = rows.results[0]!;
  let context: BindingContext;
  try { context = await bindingContext(env,row.folder_binding_id); }
  catch (error) { if (error instanceof HTTPException) return null; throw error; }
  if (context.workspaceId !== row.workspace_id || context.sourceVersion !== row.binding_source_version) return null;
  if(!await primaryNotificationOwner(env,context))return null;
  const active = row.status === "active" && row.revoked_at === null && row.terms_current === 1 &&
    (row.expires_at === null || Date.parse(row.expires_at) > Date.now());
  return {grantId:row.id,logicalGrantId:row.logical_grant_id,grantVersion:row.grant_version,
    workspaceId:row.workspace_id,folderBindingId:row.folder_binding_id,bindingSourceVersion:row.binding_source_version,
    ownerScopeType:context.ownerType,ownerPublicId:context.ownerPublicId,r2Prefix:context.prefix,
    principalPublicId:row.audience_public_id,principalSourceVersion:row.audience_source_version,identityId:row.identity_id,
    divisionId:context.divisionId,workspaceLabel:context.workspaceLabel,folderLabel:context.ownerName,
    sourceId:"project-alpha:primary",active};
}

/** Current client-side eligibility for enabling delivery mail. This uses the
 * same verified identity, membership, live target, entitlement and deny
 * evaluation as a portal delivery request. */
export async function authenticatedDeliveryGrantNotificationRecipientUsable(
  env:Env,
  target:AuthenticatedDeliveryGrantNotificationTarget,
):Promise<boolean>{
  if(!target.active)return false;
  const person=await deliveryDb(env).prepare(`SELECT identity.issuer,identity.subject,identity.verified_email email
    FROM pa_portal_principals principal JOIN portal_v2_identities identity ON identity.id=principal.identity_id
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=principal.workspace_id AND membership.identity_id=identity.id
    WHERE principal.workspace_id=? AND principal.public_id=? AND principal.identity_id=? AND principal.source_version=?
      AND principal.status='active' AND identity.status='active' AND identity.revoked_at IS NULL AND identity.verified_email IS NOT NULL
      AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))`)
    .bind(target.workspaceId,target.principalPublicId,target.identityId,target.principalSourceVersion)
    .first<{issuer:string;subject:string;email:string}>();
  if(!person)return false;
  return authorizePortalWorkspaceCapability(env,person,target.workspaceId,'delivery.view',
    {scopeType:'folder',publicId:target.folderBindingId},
    target.ownerScopeType==='project'?{retainedProjectId:target.ownerPublicId}:undefined);
}

/** Exact primary public coordinates only. A longer inactive/foreign owner
 * shadows its ancestor instead of borrowing the ancestor's staff division. */
async function primaryProjectOwner(env:Env,context:BindingContext){
  if(context.ownerType!=='project'||!isAlphaPublicId(context.ownerPublicId))return null;
  const prefixes:string[]=[];let prefix='';for(const part of context.prefix.split('/').filter(Boolean)){prefix+=`${part}/`;prefixes.push(prefix,prefix.slice(0,-1));}
  if(prefix!==context.prefix||prefixes.length>128)return null;
  const rows=await env.OPS_DB.withSession('first-primary').prepare(`WITH matching AS(
    SELECT pf.*,length(rtrim(pf.r2_prefix,'/')||'/') prefix_length FROM project_folders pf WHERE pf.r2_prefix IN(SELECT value FROM json_each(?)))
    SELECT matching.project_id,matching.division_id,matching.r2_prefix,p.active,p.projection_source_id,p.name,
      division.active division_active,${validatedUniquePublicIdExpression('pa_projects','p')} public_id,
      ${projectAlphaReadVisibleSql('p.projection_source_id')} source_visible
    FROM matching LEFT JOIN pa_projects p ON p.id=matching.project_id LEFT JOIN divisions division ON division.id=matching.division_id
    WHERE prefix_length=(SELECT max(prefix_length) FROM matching) LIMIT 2`).bind(JSON.stringify(prefixes))
    .all<{project_id:string;division_id:string;r2_prefix:string;active:number;projection_source_id:string;name:string;division_active:number;public_id:string|null;source_visible:number}>();
  if(rows.results.length!==1)return null;const row=rows.results[0]!;
  return row.active===1&&row.division_active===1&&row.projection_source_id==='project-alpha:primary'&&row.source_visible===1
    &&row.public_id===context.ownerPublicId&&row.division_id===context.divisionId?row:null;
}

async function primaryNotificationOwner(env:Env,context:BindingContext):Promise<boolean>{
  if(context.ownerType==='department'||!isAlphaPublicId(context.ownerPublicId))return false;
  const prefixes:string[]=[];let prefix='';
  for(const part of context.prefix.split('/').filter(Boolean)){prefix+=`${part}/`;prefixes.push(prefix,prefix.slice(0,-1));}
  if(prefix!==context.prefix||!prefixes.length||prefixes.length>128)return false;
  const rows=await env.OPS_DB.withSession('first-primary').prepare(`WITH matching AS(
    SELECT pf.project_id,pf.division_id,pf.r2_prefix,length(rtrim(pf.r2_prefix,'/')||'/') prefix_length
    FROM project_folders pf WHERE pf.r2_prefix IN(SELECT value FROM json_each(?)))
    SELECT matching.division_id,p.active project_active,p.projection_source_id,division.active division_active,
      ${validatedUniquePublicIdExpression('pa_projects','p')} project_public_id,
      ${validatedUniquePublicIdExpression('pa_clients','client')} client_public_id,
      ${validatedUniquePublicIdExpression('pa_organizations','org')} organization_public_id
    FROM matching LEFT JOIN divisions division ON division.id=matching.division_id
    LEFT JOIN pa_projects p ON p.id=matching.project_id
    LEFT JOIN pa_clients client ON client.id=p.client_id AND client.projection_source_id=p.projection_source_id AND client.active=1
    LEFT JOIN pa_organizations org ON org.id=p.organization_id AND org.projection_source_id=p.projection_source_id AND org.active=1
    WHERE prefix_length=(SELECT max(prefix_length) FROM matching) LIMIT 2`).bind(JSON.stringify(prefixes))
    .all<{division_id:string;project_active:number;projection_source_id:string;division_active:number;
      project_public_id:string|null;client_public_id:string|null;organization_public_id:string|null}>();
  if(rows.results.length!==1)return false;const row=rows.results[0]!;
  const mapped=context.ownerType==='project'?row.project_public_id:context.ownerType==='client'?row.client_public_id:row.organization_public_id;
  return row.project_active===1&&row.division_active===1&&row.projection_source_id==='project-alpha:primary'
    &&row.division_id===context.divisionId&&mapped===context.ownerPublicId;
}
const primaryScopeExpressions=["json_extract((SELECT v FROM input),'$.targets')","json_extract((SELECT v FROM input),'$.workspaceId')",
  "json_extract((SELECT v FROM input),'$.generationId')","json_extract((SELECT v FROM input),'$.relations')",'66'];
const primaryScopeQuery=NATIVE_PORTAL_TARGET_SCOPES_SQL.replace(/\?([1-5])\b/g,(_match,n:string)=>primaryScopeExpressions[Number(n)-1]!);
const primaryGrantProofSql=`WITH input AS(SELECT json(?) v),scope_rows AS(${primaryScopeQuery}),
  selected_people AS(SELECT p.public_id,p.identity_id,p.source_version,p.status,p.email_hint,p.display_name,i.issuer,i.subject,i.verified_email,i.status identity_status,i.revoked_at,
    m.status membership_status,m.revoked_at membership_revoked,m.expires_at,m.source_type membership_source,m.source_version membership_version,
    CASE WHEN m.expires_at IS NULL OR datetime(m.expires_at)>datetime('now') THEN 1 ELSE 0 END membership_live
    FROM input JOIN pa_portal_principals p ON p.workspace_id=json_extract(v,'$.workspaceId')
    JOIN portal_v2_identities i ON i.id=p.identity_id JOIN portal_v2_workspace_memberships m ON m.workspace_id=p.workspace_id AND m.identity_id=i.id
    WHERE json_extract(v,'$.audienceType')='principal' AND p.public_id=json_extract(v,'$.audienceId'))
  SELECT json_object(
    'binding',(SELECT json_array(b.id,b.workspace_id,b.owner_scope_type,b.owner_public_id,b.r2_prefix,b.source_version,b.status,b.revoked_at,w.status,w.project_alpha_source_id,
      w.root_type,COALESCE(w.pa_organization_public_id,w.pa_client_public_id),cp.active_generation_id,cp.source_sequence,w.legacy_account_id,
      account.id,account.project_alpha_source_id,source.projection_source_id,source.source_workspace_id)
      FROM input JOIN portal_v2_folder_bindings b ON b.id=json_extract(v,'$.bindingId') JOIN portal_v2_workspaces w ON w.id=b.workspace_id
      JOIN portal_v2_directory_checkpoints cp ON cp.workspace_id=w.id LEFT JOIN client_accounts account ON account.id=w.legacy_account_id
      LEFT JOIN pa_portal_workspace_sources source ON source.workspace_id=w.id),
    'scopes',(SELECT json_group_array(json_array(target_type,target_id,entity_type,public_id,parent_public_id,source_version,depth,display_name,binding_version,retained)) FROM scope_rows),
    'people',(SELECT json_group_array(json_array(public_id,identity_id,source_version,status,email_hint,display_name,issuer,subject,verified_email,identity_status,revoked_at,membership_status,membership_revoked,expires_at,membership_live,membership_source,membership_version)) FROM selected_people),
    'audience',(SELECT json_array(e.entity_type,e.public_id,e.parent_public_id,e.display_name,e.source_version,e.active)
      FROM input JOIN portal_v2_directory_checkpoints cp ON cp.workspace_id=json_extract(v,'$.workspaceId')
      JOIN portal_v2_directory_entities e ON e.workspace_id=cp.workspace_id AND e.generation_id=cp.active_generation_id
        AND e.entity_type=json_extract(v,'$.audienceType') AND e.public_id=json_extract(v,'$.audienceId')),
    'rules',(SELECT json_group_array(json_array(id,capability,effect,scope_type,scope_public_id,entitlement_version,source_version,access_terms_id,terms_live)) FROM (
      SELECT entitlement.*,${projectAccessReadColumns('entitlement',true)} FROM input JOIN portal_v2_entitlements entitlement
      ON entitlement.workspace_id=json_extract(v,'$.workspaceId') AND entitlement.identity_id IN(SELECT identity_id FROM selected_people)
      WHERE entitlement.capability IN ('delivery.view','workspace.view') AND entitlement.status='active' AND entitlement.revoked_at IS NULL
        AND datetime(entitlement.valid_from)<=datetime('now') AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
        AND ${projectAccessCapacitySql('entitlement',true)} ORDER BY entitlement.id LIMIT 201)),
    'denials',(SELECT json_group_array(json_array(id,workspace_id,scope_type,scope_public_id)) FROM (
      SELECT d.id,d.workspace_id,d.scope_type,d.scope_public_id FROM input JOIN portal_v2_identity_denials d ON d.identity_id IN(SELECT identity_id FROM selected_people)
      WHERE json_extract(v,'$.denylist')=1 AND (d.workspace_id=json_extract(v,'$.workspaceId') OR d.scope_type='global')
        AND d.status='active' AND d.revoked_at IS NULL AND datetime(d.valid_from)<=datetime('now') AND (d.expires_at IS NULL OR datetime(d.expires_at)>datetime('now')) ORDER BY d.id LIMIT 201)),
    'blocks',(SELECT json_group_array(json_array(id,match_type,issuer,subject,normalized_email)) FROM (
      SELECT block.id,block.match_type,block.issuer,block.subject,block.normalized_email FROM portal_v2_identity_eligibility_blocks block
      WHERE block.status='active' AND datetime(block.valid_from)<=datetime('now') AND (block.expires_at IS NULL OR datetime(block.expires_at)>datetime('now'))
        AND EXISTS(SELECT 1 FROM selected_people p WHERE (block.match_type='issuer_subject' AND block.issuer=p.issuer AND block.subject=p.subject)
          OR (block.match_type='email' AND block.normalized_email=lower(p.verified_email))) ORDER BY block.id LIMIT 201)),
    'lifecycle',(SELECT json_array(l.generation_id,l.source_sequence,l.lifecycle_status,l.completed_at,l.source_version)
      FROM input JOIN portal_project_access_current_lifecycle l ON l.workspace_id=json_extract(v,'$.workspaceId') AND l.project_public_id=json_extract(v,'$.projectId'))
  ) proof`;
interface ExplicitPrimaryReview {input:string;proof:string;opsProof:string;terms:ProjectAccessTermsInput|null;
  selected:{sourceVersion:string;displayName:string};recipients:Recipient[];preview:AuthenticatedDeliveryGrantPreview}
async function readPrimaryProof(env:Env,input:string){
  const value=await deliveryDb(env).prepare(primaryGrantProofSql).bind(input).first<string>('proof');
  if(!value||value.length>100_000)throw new HTTPException(409,{message:'Grant context changed; review again'});
  const parsed=JSON.parse(value) as Record<string,unknown>;
  if(['scopes','people','rules','denials','blocks'].some(key=>!Array.isArray(parsed[key])||parsed[key].length>200))throw new HTTPException(503,{message:'Grant authorization exceeds safe capacity'});
  return value;
}
async function primaryOpsProof(env:Env,principal:StaffPrincipal,context:BindingContext){
  await requirePermission(env,principal,'delivery.share.create',{divisionId:context.divisionId},true);
  const owner=await primaryProjectOwner(env,context);
  const actor=await env.OPS_DB.withSession('first-primary').prepare(`SELECT id,status,access_subject FROM staff_users WHERE id=? AND status='active' AND access_subject IS ?`)
    .bind(principal.id,principal.accessSubject).first();
  if(!owner||!actor)throw new HTTPException(404,{message:'Exact primary project ownership is unavailable'});
  return {owner,json:JSON.stringify([owner,actor])};
}
async function legacyOpsProof(env:Env,principal:StaffPrincipal,context:BindingContext){
  await requirePermission(env,principal,'delivery.share.create',{divisionId:context.divisionId},true);
  const current=await bindingContext(env,context.id);
  const actor=await env.OPS_DB.withSession('first-primary').prepare(`SELECT id,status,access_subject FROM staff_users WHERE id=? AND status='active' AND access_subject IS ?`)
    .bind(principal.id,principal.accessSubject).first();
  if(!actor||JSON.stringify(current)!==JSON.stringify(context))throw new HTTPException(409,{message:'Grant context changed; review again'});
  return {json:JSON.stringify([current,actor])};
}
async function reviewOpsProof(env:Env,principal:StaffPrincipal,context:BindingContext,terms:ProjectAccessTermsInput|null){
  return terms?primaryOpsProof(env,principal,context):legacyOpsProof(env,principal,context);
}

function ancestrySql(): string {
  return `WITH RECURSIVE ancestry(entity_type,public_id,source_version,depth) AS (
    SELECT entity_type,public_id,source_version,0 FROM portal_v2_directory_entities
      WHERE workspace_id=? AND generation_id=? AND entity_type=? AND public_id=? AND active=1
    UNION
    SELECT parent.entity_type,parent.public_id,parent.source_version,ancestry.depth+1
      FROM ancestry JOIN portal_v2_directory_entities child
        ON child.workspace_id=? AND child.generation_id=? AND child.entity_type=ancestry.entity_type
        AND child.public_id=ancestry.public_id AND child.active=1
      JOIN portal_v2_directory_entities parent
        ON parent.workspace_id=child.workspace_id AND parent.generation_id=child.generation_id
        AND parent.public_id=child.parent_public_id AND parent.active=1
      WHERE ancestry.depth<12
    UNION
    SELECT parent.entity_type,parent.public_id,parent.source_version,ancestry.depth+1
      FROM ancestry JOIN portal_v2_directory_relations relation
        ON relation.workspace_id=? AND relation.generation_id=? AND relation.to_type=ancestry.entity_type
        AND relation.to_public_id=ancestry.public_id AND relation.active=1 AND relation.relation_type='contains'
      JOIN portal_v2_directory_entities parent
        ON parent.workspace_id=relation.workspace_id AND parent.generation_id=relation.generation_id
        AND parent.entity_type=relation.from_type AND parent.public_id=relation.from_public_id AND parent.active=1
      WHERE ancestry.depth<12
  )`;
}

function ancestryBindings(context: BindingContext): unknown[] {
  return [context.workspaceId, context.generationId, context.ownerType, context.ownerPublicId,
    context.workspaceId, context.generationId, context.workspaceId, context.generationId];
}

async function audience(env: Env, context: BindingContext, type: AuthenticatedGrantAudienceType, publicId: string): Promise<{ sourceVersion: string; displayName: string }> {
  const db = deliveryDb(env);
  if (type === "principal") {
    const row = await db.prepare(`SELECT principal.source_version,principal.display_name
      FROM pa_portal_principals principal JOIN portal_v2_identities identity
        ON identity.id=principal.identity_id AND identity.status='active' AND identity.revoked_at IS NULL
      JOIN portal_v2_workspace_memberships membership
        ON membership.workspace_id=principal.workspace_id AND membership.identity_id=identity.id
        AND membership.status='active' AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
      WHERE principal.workspace_id=? AND principal.public_id=? AND principal.status='active'`)
      .bind(context.workspaceId, publicId).first<{ source_version: string; display_name: string }>();
    if (!row) throw new HTTPException(404, { message: "Grant audience not found" });
    return { sourceVersion: row.source_version, displayName: row.display_name };
  }
  const row = await db.prepare(`${ancestrySql()} SELECT source_version,display_name FROM (
      SELECT ancestry.source_version,entity.display_name FROM ancestry JOIN portal_v2_directory_entities entity
        ON entity.workspace_id=? AND entity.generation_id=? AND entity.entity_type=ancestry.entity_type
        AND entity.public_id=ancestry.public_id
      WHERE ancestry.entity_type=? AND ancestry.public_id=? LIMIT 1
    )`).bind(...ancestryBindings(context), context.workspaceId, context.generationId, type, publicId)
    .first<{ source_version: string; display_name: string }>();
  if (!row) throw new HTTPException(404, { message: "Grant audience is outside this folder workspace" });
  return { sourceVersion: row.source_version, displayName: row.display_name };
}

async function recipients(env: Env, context: BindingContext, type: AuthenticatedGrantAudienceType, publicId: string): Promise<Recipient[]> {
  // Group grants are deliberately dynamic. Current verified membership,
  // entitlement, hierarchy, source versions and denials are intersected on
  // every portal request, so newly authorized group members do not require a
  // staff rewrite and removed members cannot survive in a stale snapshot.
  // Only an exact-principal grant snapshots a principal/identity binding.
  if (type !== "principal") return [];
  const db = deliveryDb(env);
  const principals = await db.prepare(`SELECT principal.public_id,principal.identity_id,principal.source_version
    FROM pa_portal_principals principal
    JOIN portal_v2_identities identity ON identity.id=principal.identity_id
      AND identity.status='active' AND identity.revoked_at IS NULL
    JOIN portal_v2_workspace_memberships membership
      ON membership.workspace_id=principal.workspace_id AND membership.identity_id=identity.id
      AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    WHERE principal.workspace_id=? AND principal.status='active'
      AND principal.public_id=?
    ORDER BY principal.public_id LIMIT 201`).bind(context.workspaceId, publicId)
    .all<{ public_id: string; identity_id: string; source_version: string }>();
  if (principals.results.length > RECIPIENT_LIMIT) throw new HTTPException(409, { message: "Grant audience is too large" });
  const authorized: Recipient[] = [];
  for (const principal of principals.results) {
    const effective = await db.prepare(`${ancestrySql()} SELECT 1 ok
      WHERE EXISTS (SELECT 1 FROM portal_v2_entitlements allow_record
        WHERE allow_record.workspace_id=? AND allow_record.identity_id=?
          AND allow_record.capability='delivery.view' AND allow_record.effect='allow'
          AND allow_record.status='active' AND allow_record.revoked_at IS NULL
          AND datetime(allow_record.valid_from)<=datetime('now')
          AND (allow_record.expires_at IS NULL OR datetime(allow_record.expires_at)>datetime('now'))
          AND ((allow_record.scope_type='workspace' AND allow_record.scope_public_id=?) OR
            EXISTS (SELECT 1 FROM ancestry WHERE entity_type=allow_record.scope_type AND public_id=allow_record.scope_public_id)))
      AND NOT EXISTS (SELECT 1 FROM portal_v2_entitlements deny_record
        WHERE deny_record.workspace_id=? AND deny_record.identity_id=?
          AND deny_record.capability='delivery.view' AND deny_record.effect='deny'
          AND deny_record.status='active' AND deny_record.revoked_at IS NULL
          AND datetime(deny_record.valid_from)<=datetime('now')
          AND (deny_record.expires_at IS NULL OR datetime(deny_record.expires_at)>datetime('now'))
          AND ((deny_record.scope_type='workspace' AND deny_record.scope_public_id=?) OR
            EXISTS (SELECT 1 FROM ancestry WHERE entity_type=deny_record.scope_type AND public_id=deny_record.scope_public_id)))
      AND (?<>'true' OR NOT EXISTS (SELECT 1 FROM portal_v2_identity_denials active_denial
        WHERE active_denial.identity_id=? AND active_denial.status='active' AND active_denial.revoked_at IS NULL
          AND datetime(active_denial.valid_from)<=datetime('now')
          AND (active_denial.expires_at IS NULL OR datetime(active_denial.expires_at)>datetime('now'))
          AND (active_denial.scope_type='global' OR (active_denial.workspace_id=? AND
            ((active_denial.scope_type='workspace' AND active_denial.scope_public_id=?) OR
             EXISTS (SELECT 1 FROM ancestry WHERE entity_type=active_denial.scope_type AND public_id=active_denial.scope_public_id))))))`)
      .bind(...ancestryBindings(context), context.workspaceId, principal.identity_id, context.workspaceId,
        context.workspaceId, principal.identity_id, context.workspaceId,
        env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED ?? "false", principal.identity_id,
        context.workspaceId, context.workspaceId).first("ok");
    if (effective !== null) authorized.push({ principalPublicId: principal.public_id,
      identityId: principal.identity_id, sourceVersion: principal.source_version });
  }
  if (authorized[0]?.principalPublicId !== publicId)
    throw new HTTPException(404, { message: "Grant audience is not currently authorized for this folder" });
  if (!authorized.length) throw new HTTPException(409, { message: "Grant audience has no currently authorized verified identities" });
  return authorized;
}

function grantOperation(input:AuthenticatedDeliveryGrantInput):Omit<AuthenticatedDeliveryGrantInput,'expectedContextVersion'> {
  const {expectedContextVersion:_expected,...operation}=input;
  if(operation.accessTerms){
    operation.accessTerms=parseProjectAccessTerms(operation.accessTerms);
    if(operation.expiresAt&&!Number.isFinite(Date.parse(operation.expiresAt)))throw new HTTPException(400,{message:'Grant expiry is invalid'});
    const expiry=operation.expiresAt?new Date(operation.expiresAt).toISOString():null;
    if(expiry!==operation.accessTerms.expiresAt)throw new HTTPException(400,{message:'Grant expiry conflicts with the reviewed access terms'});
    operation.expiresAt=expiry;
  }else operation.expiresAt=normalizedExpiry(operation.expiresAt);
  return operation;
}
async function explicitPrimaryReview(env:Env,principal:StaffPrincipal,context:BindingContext,
  operation:Omit<AuthenticatedDeliveryGrantInput,'expectedContextVersion'>):Promise<ExplicitPrimaryReview>{
  if(!await projectAccessTermsReady(deliveryDb(env)))throw new HTTPException(503,{message:'Project access terms are unavailable'});
  if(!operation.accessTerms)normalizedExpiry(operation.expiresAt);
  const terms=operation.accessTerms??null,ops=await reviewOpsProof(env,principal,context,terms);
  const scopes=await readNativeTargetScopes(env,{workspaceId:context.workspaceId,generationId:context.generationId,rootType:context.rootType,rootPublicId:context.rootPublicId},
    [{scopeType:'folder',publicId:context.id}],{retention:'structural'});
  if(terms&&!scopes.has(`folder:${context.id}`))throw new HTTPException(404,{message:'Project scope is unavailable'});
  if(terms&&operation.audienceType!=='principal'&&!scopes.get(`folder:${context.id}`)!.scopes.has(`${operation.audienceType}:${operation.audiencePublicId}`))
    throw new HTTPException(404,{message:'Grant audience is outside this project scope'});
  const prepared=terms?await prepareProjectAccessTerms(deliveryDb(env),{sourceId:'project-alpha:primary',workspaceId:context.workspaceId,projectPublicId:context.ownerPublicId},
    terms,{type:'staff',id:principal.id}):null;
  const input=JSON.stringify({bindingId:context.id,workspaceId:context.workspaceId,generationId:context.generationId,projectId:context.ownerPublicId,
    targets:[{scopeType:'folder',publicId:context.id}],relations:env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED==='true'?1:0,
    denylist:env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED==='true'?1:0,audienceType:operation.audienceType,audienceId:operation.audiencePublicId});
  const before=await readPrimaryProof(env,input),selected=await audience(env,context,operation.audienceType,operation.audiencePublicId),selectedRecipients=await recipients(env,context,operation.audienceType,operation.audiencePublicId);
  const dynamicAudience=operation.audienceType!=='principal';
  // A group grant is reevaluated dynamically. Until Project Alpha projects a
  // versioned group-membership set, reporting the folder-wide eligible count
  // as a department/organization count would be misleading.
  const recipientPreview={currentAuthorizedCount:dynamicAudience?null:selectedRecipients.length,truncated:false};
  for(const recipient of terms?selectedRecipients:[]){
    const person=await deliveryDb(env).prepare('SELECT issuer,subject,verified_email email FROM portal_v2_identities WHERE id=?').bind(recipient.identityId)
      .first<{issuer:string;subject:string;email:string}>();
    if(!person||!await authorizePortalWorkspaceCapability(env,person,context.workspaceId,'delivery.view',{scopeType:'folder',publicId:context.id},
      {retainedProjectId:context.ownerPublicId}))throw new HTTPException(404,{message:'Grant audience is not currently authorized for this folder'});
  }
  const proof=await readPrimaryProof(env,input);
  if(before!==proof||(await reviewOpsProof(env,principal,context,terms)).json!==ops.json)throw new HTTPException(409,{message:'Grant context changed; review again'});
  const lifecycle=await deliveryDb(env).prepare('SELECT 1 ok FROM portal_project_access_current_lifecycle WHERE workspace_id=? AND project_public_id=?')
    .bind(context.workspaceId,context.ownerPublicId).first('ok');
  const preview:AuthenticatedDeliveryGrantPreview={operation,contextVersion:await hash(JSON.stringify([operation,context,ops.json,proof])),
    folderBindingId:context.id,workspaceId:context.workspaceId,workspaceLabel:context.workspaceLabel,sourceId:'project-alpha:primary',
    projectName:context.ownerType==='project'?context.ownerName:null,accessTermsSupported:context.ownerType==='project'&&Boolean(await primaryProjectOwner(env,context)),
    projectEndSupported:context.ownerType==='project'&&lifecycle!==null,audienceLabel:selected.displayName,
    recipientCount:selectedRecipients.length,dynamicAudience,
    recipientPreview:{mode:dynamicAudience?'dynamic':'exact',...recipientPreview},
    accessTerms:terms,effectiveAccessExpiresAt:prepared?.view.effectiveExpiresAt??operation.expiresAt??null};
  return {input,proof,opsProof:ops.json,terms,selected,recipients:selectedRecipients,preview};
}
export async function previewAuthenticatedDeliveryGrant(env:Env,principal:StaffPrincipal,input:AuthenticatedDeliveryGrantInput):Promise<AuthenticatedDeliveryGrantPreview>{
  requireEnabled(env);
  if(!OPAQUE.test(input.audiencePublicId)||!REASON.test(input.reasonCode))throw new HTTPException(400,{message:'Authenticated grant request is invalid'});
  const context=await bindingContext(env,input.folderBindingId);
  return (await explicitPrimaryReview(env,principal,context,grantOperation(input))).preview;
}

export async function searchAuthenticatedDeliveryGrantAudiences(env: Env, principal: StaffPrincipal, bindingId: string, queryValue: string,
  typeFilter?:AuthenticatedGrantAudienceType) {
  requireEnabled(env);
  const context = await bindingContext(env, bindingId);
  await requirePermission(env, principal, "delivery.share.create", { divisionId: context.divisionId }, true);
  const query = queryValue.trim().toLowerCase();
  if (query.length < 2 || query.length > 100) throw new HTTPException(400, { message: "Audience search is invalid" });
  if(typeFilter&&!['organization','department','client','project','principal'].includes(typeFilter))
    throw new HTTPException(400,{message:'Audience type is invalid'});
  const like = `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`;
  const db = deliveryDb(env);
  const [entities, principals] = await Promise.all([
    db.prepare(`${ancestrySql()} SELECT ancestry.entity_type,ancestry.public_id,entity.display_name
      FROM ancestry JOIN portal_v2_directory_entities entity
        ON entity.workspace_id=? AND entity.generation_id=? AND entity.entity_type=ancestry.entity_type
        AND entity.public_id=ancestry.public_id
      WHERE ancestry.entity_type IN ('organization','department','client','project')
        AND lower(entity.display_name) LIKE ? ESCAPE '\\'
      GROUP BY ancestry.entity_type,ancestry.public_id,entity.display_name
      ORDER BY min(ancestry.depth),lower(entity.display_name),ancestry.public_id LIMIT ?`)
      .bind(...ancestryBindings(context), context.workspaceId, context.generationId, like, SEARCH_LIMIT)
      .all<{ entity_type: Exclude<AuthenticatedGrantAudienceType, "principal">; public_id: string; display_name: string }>(),
    db.prepare(`${ancestrySql()} SELECT principal.public_id,principal.display_name,identity.verified_email
      FROM pa_portal_principals principal JOIN portal_v2_identities identity
        ON identity.id=principal.identity_id AND identity.status='active' AND identity.revoked_at IS NULL
      JOIN portal_v2_workspace_memberships membership
        ON membership.workspace_id=principal.workspace_id AND membership.identity_id=identity.id
        AND membership.status='active' AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
      WHERE principal.workspace_id=? AND principal.status='active'
        AND (lower(principal.display_name) LIKE ? ESCAPE '\\' OR lower(identity.verified_email) LIKE ? ESCAPE '\\')
        AND EXISTS (SELECT 1 FROM portal_v2_entitlements allow_record
          WHERE allow_record.workspace_id=? AND allow_record.identity_id=identity.id
            AND allow_record.capability='delivery.view' AND allow_record.effect='allow'
            AND allow_record.status='active' AND allow_record.revoked_at IS NULL
            AND datetime(allow_record.valid_from)<=datetime('now')
            AND (allow_record.expires_at IS NULL OR datetime(allow_record.expires_at)>datetime('now'))
            AND ((allow_record.scope_type='workspace' AND allow_record.scope_public_id=?) OR
              EXISTS (SELECT 1 FROM ancestry WHERE entity_type=allow_record.scope_type AND public_id=allow_record.scope_public_id)))
        AND NOT EXISTS (SELECT 1 FROM portal_v2_entitlements deny_record
          WHERE deny_record.workspace_id=? AND deny_record.identity_id=identity.id
            AND deny_record.capability='delivery.view' AND deny_record.effect='deny'
            AND deny_record.status='active' AND deny_record.revoked_at IS NULL
            AND datetime(deny_record.valid_from)<=datetime('now')
            AND (deny_record.expires_at IS NULL OR datetime(deny_record.expires_at)>datetime('now'))
            AND ((deny_record.scope_type='workspace' AND deny_record.scope_public_id=?) OR
              EXISTS (SELECT 1 FROM ancestry WHERE entity_type=deny_record.scope_type AND public_id=deny_record.scope_public_id)))
        AND (?<>'true' OR NOT EXISTS (SELECT 1 FROM portal_v2_identity_denials active_denial
          WHERE active_denial.identity_id=identity.id AND active_denial.status='active'
            AND active_denial.revoked_at IS NULL AND datetime(active_denial.valid_from)<=datetime('now')
            AND (active_denial.expires_at IS NULL OR datetime(active_denial.expires_at)>datetime('now'))
            AND (active_denial.scope_type='global' OR (active_denial.workspace_id=? AND
              ((active_denial.scope_type='workspace' AND active_denial.scope_public_id=?) OR
               EXISTS (SELECT 1 FROM ancestry WHERE entity_type=active_denial.scope_type AND public_id=active_denial.scope_public_id))))))
      ORDER BY lower(principal.display_name),principal.public_id LIMIT ?`)
      .bind(...ancestryBindings(context), context.workspaceId, like, like,
        context.workspaceId, context.workspaceId, context.workspaceId, context.workspaceId,
        env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED ?? "false", context.workspaceId, context.workspaceId,
        SEARCH_LIMIT).all<{ public_id: string; display_name: string; verified_email: string | null }>(),
  ]);
  const options:AuthenticatedDeliveryGrantAudienceSearchResult[]=[
    ...entities.results.map(row=>({type:row.entity_type,publicId:row.public_id,displayName:row.display_name,
      recipientMode:'dynamic' as const})),
    ...principals.results.map(row=>({type:'principal' as const,publicId:row.public_id,displayName:row.display_name,email:row.verified_email,
      recipientMode:'exact' as const,currentAuthorizedRecipientCount:1,recipientCountTruncated:false})),
  ];
  return {folderBindingId:context.id,workspaceId:context.workspaceId,workspaceLabel:context.workspaceLabel,
    scopeTypeFilter:typeFilter??null,audiences:options.filter(option=>!typeFilter||option.type===typeFilter).slice(0,SEARCH_LIMIT)};
}

function grantTermsColumns(ready:boolean):string {
  if(!ready)return 'NULL access_terms_json,grant_record.expires_at effective_access_expiry,1 terms_current';
  return `(SELECT json_object('kind',kind,'mode',mode,'expiresAt',expires_at) FROM portal_project_access_terms WHERE id=grant_record.access_terms_id) access_terms_json,
    CASE WHEN grant_record.access_terms_id IS NULL THEN grant_record.expires_at ELSE ${projectAccessTermsExpirySql('grant_record.access_terms_id')} END effective_access_expiry,
    ${projectAccessTermsSql({termsId:'grant_record.access_terms_id',workspaceId:'grant_record.workspace_id',
      projectId:'(SELECT project_public_id FROM portal_project_access_terms WHERE id=grant_record.access_terms_id)',legacyRetained:'1'})} terms_current`;
}
interface GrantTermsRow {access_terms_json:string|null;effective_access_expiry:string|null;terms_current:number}
function grantTermsView(row:GrantTermsRow){return {accessTerms:row.access_terms_json?parseProjectAccessTerms(JSON.parse(row.access_terms_json)):null,
  effectiveAccessExpiresAt:row.effective_access_expiry};}
export async function listAuthenticatedDeliveryGrants(
  env: Env,
  principal: StaffPrincipal,
  folderKey: string,
): Promise<{ folderBindingId: string; grants: AuthenticatedDeliveryGrantListItem[];sourceId:'project-alpha:primary';projectName:string|null;accessTermsSupported:boolean;projectEndSupported:boolean }> {
  requireEnabled(env);
  const folderBindingId = await bindingIdForFolderKey(env, folderKey);
  const context = await bindingContext(env, folderBindingId);
  await requirePermission(env, principal, "delivery.share.create", { divisionId: context.divisionId }, true);
  const ready=await projectAccessTermsReady(deliveryDb(env)),owner=ready?await primaryProjectOwner(env,context):null;
  const lifecycle=owner?await deliveryDb(env).prepare('SELECT 1 ok FROM portal_project_access_current_lifecycle WHERE workspace_id=? AND project_public_id=?')
    .bind(context.workspaceId,context.ownerPublicId).first('ok'):null;
  const rows = await deliveryDb(env).prepare(`SELECT grant_record.id,grant_record.logical_grant_id,
      grant_record.grant_version,grant_record.workspace_id,grant_record.folder_binding_id,
      grant_record.audience_type,grant_record.audience_public_id,
      CASE WHEN grant_record.status='active' AND grant_record.expires_at IS NOT NULL
        AND datetime(grant_record.expires_at)<=datetime('now') THEN 'expired' ELSE grant_record.status END status,
      grant_record.expires_at,grant_record.created_at,grant_record.updated_at,
      workspace.display_name workspace_label,
      COALESCE(principal.display_name,entity.display_name,'Authorized client audience') audience_label,
      COUNT(recipient.identity_id) recipient_count,${grantTermsColumns(ready)}
    FROM portal_v2_authenticated_delivery_grants grant_record
    JOIN portal_v2_workspaces workspace ON workspace.id=grant_record.workspace_id
    LEFT JOIN pa_portal_principals principal
      ON grant_record.audience_type='principal' AND principal.workspace_id=grant_record.workspace_id
      AND principal.public_id=grant_record.audience_public_id
    LEFT JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=grant_record.workspace_id
    LEFT JOIN portal_v2_directory_entities entity
      ON grant_record.audience_type<>'principal' AND entity.workspace_id=grant_record.workspace_id
      AND entity.generation_id=checkpoint.active_generation_id
      AND entity.entity_type=grant_record.audience_type AND entity.public_id=grant_record.audience_public_id
    LEFT JOIN portal_v2_authenticated_delivery_grant_recipients recipient ON recipient.grant_id=grant_record.id
    WHERE grant_record.folder_binding_id=?
    GROUP BY grant_record.id
    ORDER BY grant_record.updated_at DESC,grant_record.id DESC LIMIT 101`)
    .bind(folderBindingId).all<GrantTermsRow & {
      id: string; logical_grant_id: string; grant_version: number; workspace_id: string;
      folder_binding_id: string; audience_type: AuthenticatedGrantAudienceType; audience_public_id: string;
      status: AuthenticatedDeliveryGrantView["status"]; expires_at: string | null; created_at: string;
      updated_at: string; workspace_label: string; audience_label: string; recipient_count: number;
    }>();
  if (rows.results.length > 100)
    throw new HTTPException(409, { message: "This folder has too many grant records to manage safely" });
  return { folderBindingId,sourceId:'project-alpha:primary',projectName:context.ownerType==='project'?context.ownerName:null,
    accessTermsSupported:Boolean(owner),projectEndSupported:lifecycle!==null,grants: rows.results.map(row => ({
    id: row.id, grantId: row.logical_grant_id, version: row.grant_version,
    workspaceId: row.workspace_id, folderBindingId: row.folder_binding_id,
    audience: { type: row.audience_type, publicId: row.audience_public_id }, status:row.status==='active'&&row.terms_current!==1?'expired':row.status,
    expiresAt: row.expires_at, recipientCount: row.recipient_count, createdAt: row.created_at,
    updatedAt: row.updated_at, workspaceLabel: row.workspace_label, audienceLabel: row.audience_label,
    dynamicAudience: row.audience_type !== "principal",
    ...grantTermsView(row),
  })) };
}

async function grantView(db: D1Database, id: string): Promise<AuthenticatedDeliveryGrantView | null> {
  const ready=await projectAccessTermsReady(db);
  const row = await db.prepare(`SELECT grant_record.id,grant_record.logical_grant_id,grant_record.grant_version,
      grant_record.workspace_id,grant_record.folder_binding_id,grant_record.audience_type,
      grant_record.audience_public_id,
      CASE WHEN grant_record.status='active' AND grant_record.expires_at IS NOT NULL
        AND datetime(grant_record.expires_at)<=datetime('now') THEN 'expired'
        ELSE grant_record.status END status,
      grant_record.expires_at,
      grant_record.created_at,grant_record.updated_at,COUNT(recipient.identity_id) recipient_count,${grantTermsColumns(ready)}
    FROM portal_v2_authenticated_delivery_grants grant_record
    LEFT JOIN portal_v2_authenticated_delivery_grant_recipients recipient ON recipient.grant_id=grant_record.id
    WHERE grant_record.id=? GROUP BY grant_record.id`).bind(id).first<GrantTermsRow & {
      id: string; logical_grant_id: string; grant_version: number; workspace_id: string;
      folder_binding_id: string; audience_type: AuthenticatedGrantAudienceType; audience_public_id: string;
      status: AuthenticatedDeliveryGrantView["status"]; expires_at: string | null;
      created_at: string; updated_at: string; recipient_count: number;
    }>();
  return row ? { id: row.id, grantId: row.logical_grant_id, version: row.grant_version,
    workspaceId: row.workspace_id, folderBindingId: row.folder_binding_id,
    audience: { type: row.audience_type, publicId: row.audience_public_id }, status:row.status==='active'&&row.terms_current!==1?'expired':row.status,
    expiresAt: row.expires_at, recipientCount: row.recipient_count, createdAt: row.created_at,
    updatedAt: row.updated_at,...grantTermsView(row) } : null;
}

async function replay(env: Env, principal: StaffPrincipal, key: string, action: string, fingerprint: string): Promise<AuthenticatedDeliveryGrantView | null> {
  const row = await deliveryDb(env).prepare(`SELECT action,request_fingerprint,grant_id
    FROM portal_v2_authenticated_delivery_grant_mutations WHERE actor_staff_id=? AND idempotency_key=?`)
    .bind(principal.id, key).first<{ action: string; request_fingerprint: string; grant_id: string }>();
  if (!row) return null;
  if (row.action !== action || row.request_fingerprint !== fingerprint)
    throw new HTTPException(409, { message: "Idempotency-Key was already used for a different grant request" });
  return grantView(deliveryDb(env), row.grant_id);
}

async function insertGrant(env: Env, principal: StaffPrincipal, context: BindingContext,
  input: { logicalGrantId: string; version: number; audienceType: AuthenticatedGrantAudienceType;
    audiencePublicId: string; reasonCode: string; expiresAt: string | null; action: "grant.create" | "grant.restore";
    auditAction: "grant.created" | "grant.restored"; idempotencyKey: string; fingerprint: string;review?:ExplicitPrimaryReview;restoreFrom?:{id:string;version:number} },
): Promise<AuthenticatedDeliveryGrantView> {
  const selected = input.review?.selected??await audience(env, context, input.audienceType, input.audiencePublicId);
  const selectedRecipients = input.review?.recipients??await recipients(env, context, input.audienceType, input.audiencePublicId);
  const id = crypto.randomUUID();
  const db = deliveryDb(env);
  const historyReady=await projectAccessAuthorityHistoryReady(db),auditId=crypto.randomUUID();
  const terms=input.review?.terms?await prepareProjectAccessTerms(db,{sourceId:'project-alpha:primary',workspaceId:context.workspaceId,projectPublicId:context.ownerPublicId},
    input.review.terms,{type:'staff',id:principal.id},`primary-grant-${id}`):null;
  if(input.review&&(await reviewOpsProof(env,principal,context,input.review.terms)).json!==input.review.opsProof)throw new HTTPException(409,{message:'Grant context changed; review again'});
  await db.batch([
    ...(input.review?[db.prepare(`WITH current_proof AS MATERIALIZED (${primaryGrantProofSql})
      INSERT INTO portal_project_access_write_fences(id,write_guard)
      SELECT ?,CASE WHEN count(*)=1 AND max(proof)=? ${input.restoreFrom?`AND EXISTS(SELECT 1 FROM portal_v2_authenticated_delivery_grants old
        WHERE old.id=? AND old.grant_version=? AND (old.status IN('revoked','expired') OR (old.status='active' AND
          ((old.expires_at IS NOT NULL AND datetime(old.expires_at)<=datetime('now')) OR NOT ${projectAccessTermsSql({termsId:'old.access_terms_id',workspaceId:'old.workspace_id',projectId:'(SELECT project_public_id FROM portal_project_access_terms WHERE id=old.access_terms_id)',legacyRetained:'1'})})))
          AND NOT EXISTS(SELECT 1 FROM portal_v2_authenticated_delivery_grants newer WHERE newer.logical_grant_id=old.logical_grant_id AND newer.grant_version>old.grant_version))`:''}
        THEN 1 ELSE 0 END FROM current_proof`)
        .bind(input.review.input,crypto.randomUUID(),input.review.proof,...(input.restoreFrom?[input.restoreFrom.id,input.restoreFrom.version]:[])),...(terms?[terms.statement]:[])]:[]),
    ...(input.restoreFrom?[db.prepare(`UPDATE portal_v2_authenticated_delivery_grants SET status='expired',updated_at=datetime('now') WHERE id=? AND status='active'`)
      .bind(input.restoreFrom.id)]:[]),
    db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants
      (id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,
       audience_type,audience_public_id,audience_source_version,reason_code,expires_at,created_by_staff_id${terms?',access_terms_id':''})
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?${terms?',?':''})`).bind(id, input.logicalGrantId, input.version, context.workspaceId,
      context.id, context.sourceVersion, input.audienceType, input.audiencePublicId, selected.sourceVersion,
      input.reasonCode, input.expiresAt, principal.id,...(terms?[terms.id]:[])),
    ...selectedRecipients.map(recipient => db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients
      (grant_id,workspace_id,principal_public_id,identity_id,principal_source_version) VALUES (?,?,?,?,?)`)
      .bind(id, context.workspaceId, recipient.principalPublicId, recipient.identityId, recipient.sourceVersion)),
    db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_mutations
      (actor_staff_id,idempotency_key,action,request_fingerprint,grant_id,logical_grant_id,grant_version)
      VALUES (?,?,?,?,?,?,?)`).bind(principal.id, input.idempotencyKey, input.action, input.fingerprint,
      id, input.logicalGrantId, input.version),
    db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_audit
      (id,logical_grant_id,grant_id,grant_version,workspace_id,action,actor_staff_id,details_json)
       VALUES (?,?,?,?,?,?,?,?)`).bind(auditId, input.logicalGrantId, id, input.version,
      context.workspaceId, input.auditAction, principal.id, JSON.stringify({ folderBindingId: context.id,
        audienceType: input.audienceType, audiencePublicId: input.audiencePublicId,
         recipientCount: selectedRecipients.length, reasonCode: input.reasonCode,...(terms?{accessTerms:input.review!.terms,accessTermsId:terms.id}:{} ) })),
    ...(historyReady?[projectAccessGrantEvent(db,{grantId:id,eventKind:input.auditAction==='grant.restored'?'grant_restored':'grant_created',
      producerEventKey:`authenticated-grant-audit:${auditId}`,actor:{type:'staff',id:principal.id},requiredGrantAuditId:auditId})]:[]),
  ]);
  if(input.review){
    try{if((await reviewOpsProof(env,principal,context,input.review.terms)).json!==input.review.opsProof||await readPrimaryProof(env,input.review.input)!==input.review.proof)
      throw new HTTPException(409,{message:'Grant context changed; review again'});}
    catch(error){
      // OPS and Delivery are separate databases. Close this exact new grant if
      // the post-write staff/owner proof cannot be established; never claim a
      // cross-database atomic transaction or reactivate a historical grant.
      const revokeAuditId=crypto.randomUUID();
      try{await db.batch([db.prepare(`UPDATE portal_v2_authenticated_delivery_grants SET status='revoked',revoked_at=datetime('now'),
        revoked_by_staff_id=?,revoke_reason_code='authority_changed',updated_at=datetime('now') WHERE id=? AND status='active'`).bind(principal.id,id),
        db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_audit(id,logical_grant_id,grant_id,grant_version,workspace_id,action,actor_staff_id,details_json)
          SELECT ?,logical_grant_id,id,grant_version,workspace_id,'grant.revoked',?,'{"reasonCode":"authority_changed"}'
          FROM portal_v2_authenticated_delivery_grants WHERE id=? AND status='revoked' AND changes()=1`)
          .bind(revokeAuditId,principal.id,id),
        ...(historyReady?[projectAccessGrantEvent(db,{grantId:id,eventKind:'grant_revoked',producerEventKey:`authenticated-grant-audit:${revokeAuditId}`,
          actor:{type:'staff',id:principal.id},requiredGrantAuditId:revokeAuditId})]:[])]);}catch(cleanupError){
        const status=await db.prepare(`SELECT status FROM portal_v2_authenticated_delivery_grants WHERE id=?`).bind(id).first<string>('status');
        if(status!=='revoked')throw cleanupError;
      }
      throw error;
    }
  }
  return (await grantView(db, id))!;
}

export async function createAuthenticatedDeliveryGrant(env: Env, principal: StaffPrincipal, input:AuthenticatedDeliveryGrantInput,
  idempotencyKey: string): Promise<{ grant: AuthenticatedDeliveryGrantView; replayed: boolean }> {
  requireProjectAccessAuthorityMutations(env);
  requireEnabled(env);
  if (!IDEMPOTENCY.test(idempotencyKey) || !OPAQUE.test(input.audiencePublicId) || !REASON.test(input.reasonCode))
    throw new HTTPException(400, { message: "Authenticated grant request is invalid" });
  const context = await bindingContext(env, input.folderBindingId);
  await requirePermission(env, principal, "delivery.share.create", { divisionId: context.divisionId }, true);
  const normalized = grantOperation(input),expiresAt=normalized.expiresAt??null;
  if(input.accessTerms)await primaryOpsProof(env,principal,context);
  const fingerprint = await hash(JSON.stringify(normalized));
  const prior = await replay(env, principal, idempotencyKey, "grant.create", fingerprint);
  if (prior) return { grant: prior, replayed: true };
  const review=input.accessTerms||input.expectedContextVersion?await explicitPrimaryReview(env,principal,context,normalized):undefined;
  if(review&&(!/^[a-f0-9]{64}$/.test(input.expectedContextVersion??'')||input.expectedContextVersion!==review.preview.contextVersion))
    throw new HTTPException(409,{message:'Grant context changed; review again'});
  const logicalGrantId = crypto.randomUUID();
  try {
    return { grant: await insertGrant(env, principal, context, { logicalGrantId, version: 1,
      audienceType: input.audienceType, audiencePublicId: input.audiencePublicId,
      reasonCode: input.reasonCode, expiresAt, action: "grant.create", auditAction: "grant.created",
      idempotencyKey, fingerprint,review }), replayed: false };
  } catch (error) {
    if(review&&error instanceof HTTPException)throw error;
    if(review&&(await explicitPrimaryReview(env,principal,context,normalized)).preview.contextVersion!==input.expectedContextVersion)
      throw new HTTPException(409,{message:'Grant context changed; review again'});
    const raced = await replay(env, principal, idempotencyKey, "grant.create", fingerprint);
    if (raced) return { grant: raced, replayed: true };
    if(error instanceof Error&&/portal_project_access_write_guard|portal project access terms/.test(error.message))throw new HTTPException(409,{message:'Grant context changed; review again'});
    throw error;
  }
}

export async function revokeAuthenticatedDeliveryGrant(env: Env, principal: StaffPrincipal,
  logicalGrantId: string, expectedVersion: number, reasonCode: string, idempotencyKey: string,
): Promise<{ grant: AuthenticatedDeliveryGrantView; replayed: boolean }> {
  requireProjectAccessAuthorityMutations(env);
  requireEnabled(env);
  if (!OPAQUE.test(logicalGrantId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
      !REASON.test(reasonCode) || !IDEMPOTENCY.test(idempotencyKey))
    throw new HTTPException(400, { message: "Grant revocation request is invalid" });
  const fingerprint = await hash(JSON.stringify({ logicalGrantId, expectedVersion, reasonCode }));
  const prior = await replay(env, principal, idempotencyKey, "grant.revoke", fingerprint);
  if (prior) {const scope=await bindingContext(env,prior.folderBindingId);
    await requirePermission(env,principal,'delivery.share.revoke',{divisionId:scope.divisionId},true);
    return { grant: prior, replayed: true };}
  const db = deliveryDb(env);
  const historyReady=await projectAccessAuthorityHistoryReady(db),auditId=crypto.randomUUID();
  const current = await db.prepare(`SELECT id,folder_binding_id FROM portal_v2_authenticated_delivery_grants
    WHERE logical_grant_id=? AND grant_version=? AND status='active' AND revoked_at IS NULL
      AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))`)
    .bind(logicalGrantId, expectedVersion).first<{ id: string; folder_binding_id: string }>();
  if (!current) throw new HTTPException(409, { message: "Grant changed; refresh and try again" });
  const context = await bindingContext(env, current.folder_binding_id);
  await requirePermission(env, principal, "delivery.share.revoke", { divisionId: context.divisionId }, true);
  let results:D1Result[];
  try{results = await db.batch([
    db.prepare(`UPDATE portal_v2_authenticated_delivery_grants SET status='revoked',revoked_at=datetime('now'),
      revoked_by_staff_id=?,revoke_reason_code=?,updated_at=datetime('now')
      WHERE id=? AND grant_version=? AND status='active' AND revoked_at IS NULL`)
      .bind(principal.id, reasonCode, current.id, expectedVersion),
    db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_mutations
      (actor_staff_id,idempotency_key,action,request_fingerprint,grant_id,logical_grant_id,grant_version)
      SELECT ?,?,'grant.revoke',?,?,?,? WHERE changes()=1`)
      .bind(principal.id, idempotencyKey, fingerprint, current.id, logicalGrantId, expectedVersion),
    db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_audit
      (id,logical_grant_id,grant_id,grant_version,workspace_id,action,actor_staff_id,details_json)
      SELECT ?,logical_grant_id,id,grant_version,workspace_id,'grant.revoked',?,?
      FROM portal_v2_authenticated_delivery_grants grant_record
      WHERE grant_record.id=? AND grant_record.status='revoked'
        AND EXISTS (SELECT 1 FROM portal_v2_authenticated_delivery_grant_mutations mutation
          WHERE mutation.actor_staff_id=? AND mutation.idempotency_key=?
            AND mutation.action='grant.revoke' AND mutation.grant_id=grant_record.id)`)
      .bind(auditId, principal.id, JSON.stringify({ reasonCode }), current.id,
         principal.id, idempotencyKey),
    ...(historyReady?[projectAccessGrantEvent(db,{grantId:current.id,eventKind:'grant_revoked',
      producerEventKey:`authenticated-grant-audit:${auditId}`,actor:{type:'staff',id:principal.id},requiredGrantAuditId:auditId})]:[]),
  ]);}catch(cause){
    const raced=await replay(env,principal,idempotencyKey,'grant.revoke',fingerprint);
    if(raced){const scope=await bindingContext(env,raced.folderBindingId);
      await requirePermission(env,principal,'delivery.share.revoke',{divisionId:scope.divisionId},true);
      return {grant:raced,replayed:true};}
    const status=await db.prepare(`SELECT status FROM portal_v2_authenticated_delivery_grants WHERE id=?`).bind(current.id).first<string>('status');
    if(status!=='active')throw new HTTPException(409,{message:'Grant changed; refresh and try again'});
    throw new HTTPException(503,{message:'Grant revocation could not be recorded',cause});
  }
  if (results[0]?.meta.changes !== 1) throw new HTTPException(409, { message: "Grant changed; refresh and try again" });
  return { grant: (await grantView(db, current.id))!, replayed: false };
}

export async function restoreAuthenticatedDeliveryGrant(env: Env, principal: StaffPrincipal,
  logicalGrantId: string, expectedVersion: number, reasonCode: string, expiresAtValue: string | null | undefined,
  idempotencyKey: string,options?:{accessTerms?:ProjectAccessTermsInput;expectedContextVersion?:string},
): Promise<{ grant: AuthenticatedDeliveryGrantView; replayed: boolean }> {
  requireProjectAccessAuthorityMutations(env);
  requireEnabled(env);
  if (!OPAQUE.test(logicalGrantId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
      !REASON.test(reasonCode) || !IDEMPOTENCY.test(idempotencyKey))
    throw new HTTPException(400, { message: "Grant restoration request is invalid" });
  const db = deliveryDb(env);
  const ready=await projectAccessTermsReady(db);
  const latest = await db.prepare(`SELECT id,folder_binding_id,audience_type,audience_public_id,status,
      ${ready?'access_terms_id':'NULL access_terms_id'},
      CASE WHEN status='active' AND expires_at IS NOT NULL AND datetime(expires_at)<=datetime('now') THEN 1 ELSE 0 END is_elapsed
    FROM portal_v2_authenticated_delivery_grants WHERE logical_grant_id=? AND grant_version=?
      ORDER BY grant_version DESC LIMIT 1`)
    .bind(logicalGrantId, expectedVersion).first<{ id: string; folder_binding_id: string;
      audience_type: AuthenticatedGrantAudienceType; audience_public_id: string;
      status: "active" | "revoked" | "expired"; is_elapsed: number;access_terms_id:string|null }>();
  if (!latest) throw new HTTPException(409, { message: "Grant changed; refresh and try again" });
  const context = await bindingContext(env, latest.folder_binding_id);
  await requirePermission(env, principal, "delivery.share.create", { divisionId: context.divisionId }, true);
  if(latest.access_terms_id&&!options?.accessTerms)throw new HTTPException(409,{message:'Review new project access terms before restoring this grant'});
  const operation=grantOperation({folderBindingId:context.id,audienceType:latest.audience_type,audiencePublicId:latest.audience_public_id,
    reasonCode,expiresAt:expiresAtValue,...(options?.accessTerms?{accessTerms:options.accessTerms}:{} )});
  const expiresAt=operation.expiresAt??null;
  if(options?.accessTerms)await primaryOpsProof(env,principal,context);
  const fingerprint = await hash(JSON.stringify({ logicalGrantId, expectedVersion, reasonCode, expiresAt,...(operation.accessTerms?{accessTerms:operation.accessTerms}:{} ) }));
  const prior = await replay(env, principal, idempotencyKey, "grant.restore", fingerprint);
  if (prior) return { grant: prior, replayed: true };
  const priorView=await grantView(db,latest.id);
  if(!priorView||priorView.status==='active')throw new HTTPException(409,{message:'Grant changed; refresh and try again'});
  const newer = await db.prepare("SELECT 1 ok FROM portal_v2_authenticated_delivery_grants WHERE logical_grant_id=? AND grant_version>?")
    .bind(logicalGrantId, expectedVersion).first("ok");
  if (newer !== null) throw new HTTPException(409, { message: "Grant changed; refresh and try again" });
  const review=operation.accessTerms||options?.expectedContextVersion?await explicitPrimaryReview(env,principal,context,operation):undefined;
  if(review&&(!/^[a-f0-9]{64}$/.test(options?.expectedContextVersion??'')||options?.expectedContextVersion!==review.preview.contextVersion))
    throw new HTTPException(409,{message:'Grant context changed; review again'});
  try {
    if (!review&&latest.status === "active" && latest.is_elapsed === 1) {
      const expired = await db.prepare(`UPDATE portal_v2_authenticated_delivery_grants
        SET status='expired',updated_at=datetime('now')
        WHERE id=? AND status='active' AND expires_at IS NOT NULL
          AND datetime(expires_at)<=datetime('now')`).bind(latest.id).run();
      if (expired.meta.changes !== 1)
        throw new HTTPException(409, { message: "Grant changed; refresh and try again" });
    }
    return { grant: await insertGrant(env, principal, context, { logicalGrantId,
      version: expectedVersion + 1, audienceType: latest.audience_type,
      audiencePublicId: latest.audience_public_id, reasonCode, expiresAt,
      action: "grant.restore", auditAction: "grant.restored", idempotencyKey, fingerprint,review,
      ...(review?{restoreFrom:{id:latest.id,version:expectedVersion}}:{}) }), replayed: false };
  } catch (error) {
    if(review&&error instanceof HTTPException)throw error;
    if(review&&(await explicitPrimaryReview(env,principal,context,operation)).preview.contextVersion!==options?.expectedContextVersion)
      throw new HTTPException(409,{message:'Grant context changed; review again'});
    const raced = await replay(env, principal, idempotencyKey, "grant.restore", fingerprint);
    if (raced) return { grant: raced, replayed: true };
    if(error instanceof Error&&/portal_project_access_write_guard|portal project access terms/.test(error.message))throw new HTTPException(409,{message:'Grant context changed; review again'});
    throw error;
  }
}
