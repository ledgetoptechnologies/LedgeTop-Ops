import type { Env as ClientEnv } from "../types";
import { primaryWorkspaceAccount } from "./project-alpha-source";
import type { PortalAuthorizationEnv } from "./workspace-v2";
type Env = PortalAuthorizationEnv & Pick<ClientEnv, "AUTHENTICATED_DELIVERY_GRANTS_ENABLED">;
import type { VerifiedClientPrincipal } from "./types";
import { authorizePortalWorkspaceCapability,authorizePrimaryPortalTargetBatch, portalHierarchyV2Enabled, nativePortalScopesAllowed, type NativePortalReadContext } from "./workspace-v2";
import { readNativeTargetScopes } from './native-portal-scopes';
import { d1ColumnPresent, d1TablesPresent } from '../schema-readiness';
import { HTTPException } from 'hono/http-exception';
import { projectAccessTermsReady, projectAccessTermsSql } from './project-access-terms';
import { projectAccessReadColumns, projectAccessRowAllows, type ProjectAccessReadRow } from './project-access-read';
import { portalRootAccessAllowedSql } from './workspace-access-policy';

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const AUTHORIZED_BINDING_LIMIT = 100;

interface GrantCandidate extends ProjectAccessReadRow {
  grant_id: string;
  grant_version: number;
  binding_source_version: string;
  source: "staff" | "project_alpha_delivery";
  folder_binding_id: string;
  r2_prefix: string;
  owner_scope_type: "organization" | "department" | "client" | "project";
  owner_public_id: string;
  audience_type: "organization" | "department" | "client" | "project" | "principal";
  audience_public_id: string;
  audience_source_version: string;
}

function primaryOperationsReceiptSql(receiptsReady:boolean,sourceTypeReady:boolean,workspaceAlias="workspace"):string {
  if(!sourceTypeReady)return "1=1";
  const nonPrimary=`${workspaceAlias}.project_alpha_source_id<>'project-alpha:primary'`;
  return receiptsReady?`(${nonPrimary} OR binding.source_type<>'operations' OR EXISTS(
    SELECT 1 FROM portal_primary_staff_bindings receipt WHERE receipt.binding_id=binding.id
      AND receipt.workspace_id=binding.workspace_id AND receipt.r2_prefix=binding.r2_prefix AND receipt.state='active'))`
    :`(${nonPrimary} OR binding.source_type<>'operations')`;
}

function portalDb(env: Env): D1Database {
  const db = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return db.withSession?.("first-primary") ?? db;
}

export function authenticatedDeliveryGrantsEnabled(env: Env): boolean {
  return portalHierarchyV2Enabled(env) && env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED === "true";
}

async function candidates(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
  folderBindingId?: string,
  native?: NativePortalReadContext,
  selection?: {bindingIds?:string[];grantId?:string;projectIds?:string[]},
): Promise<GrantCandidate[] | null> {
  const workspaceSource = native ? `workspace.project_alpha_source_id=? AND workspace.legacy_account_id IS NULL
    AND EXISTS(SELECT 1 FROM pa_portal_workspace_sources map WHERE map.workspace_id=workspace.id
      AND map.projection_source_id=workspace.project_alpha_source_id)` : primaryWorkspaceAccount('workspace');
  const sourceBindings = native ? [native.sourceId] : [];
  const termsReady=native?.projectAccessTermsAvailable??await projectAccessTermsReady(env.DELIVERY_DB);
  const [primaryReceiptReady,bindingSourceTypeReady]=await Promise.all([
    d1TablesPresent(env.DELIVERY_DB,["portal_primary_staff_bindings"]),
    d1ColumnPresent(env.DELIVERY_DB,"portal_v2_folder_bindings","source_type"),
  ]);
  // Operations-owned bindings are authority-bearing only while their immutable
  // primary staff receipt remains active. If migration 0189 is absent, fail
  // those bindings closed instead of treating old routing metadata as access.
  const primaryReceiptSql=primaryOperationsReceiptSql(primaryReceiptReady,bindingSourceTypeReady);
  const rootAccessSql=portalRootAccessAllowedSql(env.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED === "true", "workspace");
  const rows = await portalDb(env).prepare(`SELECT DISTINCT 'staff' source,binding.id folder_binding_id,binding.r2_prefix,
      grant_record.id grant_id,grant_record.grant_version,binding.source_version binding_source_version,
      binding.owner_scope_type,binding.owner_public_id,grant_record.audience_type,
      grant_record.audience_public_id,grant_record.audience_source_version,${projectAccessReadColumns('grant_record',termsReady)}
    FROM portal_v2_identities identity
    JOIN portal_v2_workspace_memberships membership
      ON membership.identity_id=identity.id AND membership.workspace_id=?
      AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    LEFT JOIN portal_v2_authenticated_delivery_grant_recipients recipient
      ON recipient.workspace_id=membership.workspace_id AND recipient.identity_id=identity.id
    JOIN portal_v2_authenticated_delivery_grants grant_record
      ON grant_record.workspace_id=membership.workspace_id
      AND (grant_record.audience_type<>'principal' OR grant_record.id=recipient.grant_id)
      AND grant_record.status='active' AND grant_record.revoked_at IS NULL
      AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))
    JOIN portal_v2_folder_bindings binding
      ON binding.id=grant_record.folder_binding_id AND binding.workspace_id=grant_record.workspace_id
      AND binding.status='active' AND binding.revoked_at IS NULL
      AND binding.source_version=grant_record.binding_source_version
    LEFT JOIN pa_portal_principals principal_record
      ON principal_record.workspace_id=recipient.workspace_id
      AND principal_record.public_id=recipient.principal_public_id
      AND principal_record.identity_id=recipient.identity_id AND principal_record.status='active'
      AND principal_record.source_version=recipient.principal_source_version
    WHERE identity.issuer=? AND identity.subject=? AND identity.status='active' AND identity.revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM portal_v2_workspaces workspace WHERE workspace.id=membership.workspace_id
        AND workspace.status='active' AND ${rootAccessSql} AND ${workspaceSource} AND ${primaryReceiptSql})
      AND (grant_record.audience_type<>'principal' OR principal_record.public_id IS NOT NULL)
      ${termsReady?`AND ${projectAccessTermsSql({termsId:'grant_record.access_terms_id',workspaceId:'grant_record.workspace_id',projectId:'binding.owner_public_id',legacyRetained:'1'})}`:''}
      ${native ? `AND (grant_record.audience_type<>'principal' OR (recipient.principal_public_id=grant_record.audience_public_id
        AND recipient.principal_source_version=grant_record.audience_source_version))
        AND EXISTS(SELECT 1 FROM portal_native_staff_grants publication JOIN portal_native_staff_bindings ownership
          ON ownership.binding_id=publication.binding_id AND ownership.source_id=publication.source_id
          WHERE publication.grant_id=grant_record.id AND publication.binding_id=binding.id AND publication.state='active'
            AND publication.source_id=? AND ownership.workspace_id=grant_record.workspace_id
            AND ownership.r2_prefix=binding.r2_prefix AND ownership.project_public_id=binding.owner_public_id AND binding.owner_scope_type='project')
        AND (? IS NULL OR binding.id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR grant_record.id=?)
        AND (? IS NULL OR (binding.owner_scope_type='project' AND binding.owner_public_id IN (SELECT value FROM json_each(?))))` : ''}
      ${!native&&selection?.projectIds?`AND binding.owner_scope_type='project' AND binding.owner_public_id IN(SELECT value FROM json_each(?))`:''}
      AND (? IS NULL OR binding.id=?)
    ORDER BY binding.id LIMIT ?`)
    .bind(workspaceId, principal.issuer, principal.subject,
      ...sourceBindings,
      ...(native?[native.sourceId,selection?.bindingIds?JSON.stringify(selection.bindingIds):null,selection?.bindingIds?JSON.stringify(selection.bindingIds):null,selection?.grantId??null,selection?.grantId??null,
        selection?.projectIds?JSON.stringify(selection.projectIds):null,selection?.projectIds?JSON.stringify(selection.projectIds):null]:[]),
      ...(!native&&selection?.projectIds?[JSON.stringify(selection.projectIds)]:[]),folderBindingId ?? null, folderBindingId ?? null, native?201:AUTHORIZED_BINDING_LIMIT + 1)
    .all<GrantCandidate>();
  const integration = await portalDb(env).prepare(`SELECT DISTINCT 'project_alpha_delivery' source,binding.id folder_binding_id,binding.r2_prefix,
      grant_record.id grant_id,grant_record.grant_version,binding.source_version binding_source_version,
      binding.owner_scope_type,binding.owner_public_id,grant_record.audience_type,
      grant_record.audience_public_id,grant_record.audience_source_version,NULL access_terms_id,NULL terms_project_id,NULL terms_kind,1 terms_live
    FROM portal_v2_identities identity
    JOIN portal_v2_workspace_memberships membership ON membership.identity_id=identity.id AND membership.workspace_id=?
      AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    JOIN project_alpha_delivery_portal_grants grant_record ON grant_record.workspace_id=membership.workspace_id
      AND grant_record.audience_type='principal' AND grant_record.status='active'
      AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))
    JOIN portal_v2_folder_bindings binding ON binding.id=grant_record.folder_binding_id
      AND binding.workspace_id=grant_record.workspace_id AND binding.status='active' AND binding.revoked_at IS NULL
      AND binding.source_version=grant_record.binding_source_version
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=binding.workspace_id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=checkpoint.workspace_id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities owner ON owner.workspace_id=binding.workspace_id
      AND owner.generation_id=checkpoint.active_generation_id AND owner.entity_type=binding.owner_scope_type
      AND owner.public_id=binding.owner_public_id AND owner.source_version=binding.source_version AND owner.active=1
    LEFT JOIN pa_portal_principals principal_record ON principal_record.workspace_id=membership.workspace_id
      AND principal_record.public_id=grant_record.audience_public_id
      AND principal_record.status='active' AND principal_record.source_version=grant_record.audience_source_version
    LEFT JOIN portal_v2_identity_eligibility_bindings eligibility ON eligibility.identity_id=identity.id
      AND eligibility.workspace_id=membership.workspace_id AND eligibility.principal_public_id=principal_record.public_id
      AND eligibility.principal_source_version=principal_record.source_version
      AND eligibility.verified_email=identity.verified_email
    WHERE identity.issuer=? AND identity.subject=? AND identity.status='active' AND identity.revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM portal_v2_workspaces workspace WHERE workspace.id=membership.workspace_id
        AND workspace.status='active' AND ${rootAccessSql} AND ${workspaceSource} AND ${primaryReceiptSql}
        ${native ? `AND EXISTS(SELECT 1 FROM project_alpha_delivery_intent_receipts receipt
          WHERE receipt.receipt_id=grant_record.receipt_id AND receipt.project_alpha_source_id=workspace.project_alpha_source_id
            AND receipt.access_mode='portal' AND receipt.resource_id=grant_record.id AND receipt.status='accepted')` : ''})
      AND principal_record.public_id IS NOT NULL
      AND (principal_record.identity_id=identity.id OR eligibility.identity_id=identity.id)
      ${native?`AND (? IS NULL OR binding.id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR grant_record.id=?)
        AND (? IS NULL OR (binding.owner_scope_type='project' AND binding.owner_public_id IN (SELECT value FROM json_each(?))))`:''}
      ${!native&&selection?.projectIds?`AND binding.owner_scope_type='project' AND binding.owner_public_id IN(SELECT value FROM json_each(?))`:''}
      AND (? IS NULL OR binding.id=?) ORDER BY binding.id LIMIT ?`)
    .bind(workspaceId,principal.issuer,principal.subject,...sourceBindings,
      ...(native?[selection?.bindingIds?JSON.stringify(selection.bindingIds):null,selection?.bindingIds?JSON.stringify(selection.bindingIds):null,selection?.grantId??null,selection?.grantId??null,
        selection?.projectIds?JSON.stringify(selection.projectIds):null,selection?.projectIds?JSON.stringify(selection.projectIds):null]:[]),
      ...(!native&&selection?.projectIds?[JSON.stringify(selection.projectIds)]:[]),folderBindingId??null,folderBindingId??null,native?201:AUTHORIZED_BINDING_LIMIT+1).all<GrantCandidate>();
  const combined=[...rows.results,...integration.results];
  return combined.length > (native?200:AUTHORIZED_BINDING_LIMIT) ? null : combined;
}

async function authorizedPrimaryStaffGrants(env:Env,principal:VerifiedClientPrincipal,workspaceId:string,rows:GrantCandidate[]){
  const staff=rows.filter(row=>row.source==='staff');
  const scopes=await authorizePrimaryPortalTargetBatch(env,principal,workspaceId,staff.map(row=>({
    target:{scopeType:'folder' as const,publicId:row.folder_binding_id},
    ...(row.access_terms_id&&row.terms_project_id?{retainedProjectId:row.terms_project_id}:{})})));
  return staff.flatMap(row=>{const scope=scopes.get(`folder:${row.folder_binding_id}`);
    if(!scope||scope.bindingVersion!==row.binding_source_version||row.audience_type!=='principal'
      &&scope.versions.get(`${row.audience_type}:${row.audience_public_id}`)!==row.audience_source_version)return [];
    const expired=scope.proofRows.filter(item=>item.entity_type==='project'&&item.retained===0).map(item=>item.public_id);
    if(!projectAccessRowAllows(row,scope.scopes,expired))return [];
    return [{row,scope}];
  });
}

/** Current primary explicit grants supply retention only, not directory access.
 * Selection and authorization are bounded/batched, with the same allow/deny
 * rules used by the primary file authorizer. Never expose these proof bytes. */
export async function readPrimaryTermRetentionGrants(env:Env,principal:VerifiedClientPrincipal,workspaceId:string,projectIds:string[]){
  if(!authenticatedDeliveryGrantsEnabled(env)||!projectIds.length||!await projectAccessTermsReady(env.DELIVERY_DB))return [];
  if(projectIds.length>200)throw new HTTPException(503,{message:'Project history exceeds safe capacity. Contact support.'});
  const rows=await candidates(env,principal,workspaceId,undefined,undefined,{projectIds});
  if(!rows)throw new HTTPException(503,{message:'Project delivery access exceeds safe capacity. Contact support.'});
  const explicit=rows.filter(row=>row.source==='staff'&&row.access_terms_id&&row.owner_scope_type==='project'
    &&projectAccessRowAllows(row,new Set([`project:${row.owner_public_id}`])));
  return (await authorizedPrimaryStaffGrants(env,principal,workspaceId,explicit))
    .map(({row,scope})=>({projectId:row.owner_public_id,proof:JSON.stringify([row,scope.proofRows])}))
    .sort((a,b)=>a.projectId.localeCompare(b.projectId)||a.proof.localeCompare(b.proof));
}

export async function nativeDeliveryResourcesReady(env:Env):Promise<boolean>{
  return authenticatedDeliveryGrantsEnabled(env)&&await d1TablesPresent(env.DELIVERY_DB,
    ['portal_native_staff_bindings','portal_native_staff_grants','portal_native_staff_grant_events','portal_native_staff_write_fences']);
}

/** Native-only adapter. The same audience, deny and versioned grant policy is
 * reused; callers must fence the supplied context again before returning data. */
export async function readNativeAuthenticatedDeliveryGrants(
  env: Env, principal: VerifiedClientPrincipal, context: NativePortalReadContext, bindingId?: string,
  selection?:{bindingIds?:string[];grantId?:string;projectIds?:string[]},
): Promise<Array<GrantCandidate & {owner_name:string;binding_fingerprint:string}>> {
  if (!await nativeDeliveryResourcesReady(env))throw new HTTPException(503,{message:'Native deliveries are not ready. Contact support.'});
  const rows = await candidates(env,principal,context.workspaceId,bindingId,context,selection);
  if (!rows) throw new HTTPException(503,{message:'This delivery selection has too many active grants. Contact support.'});
  const scopes=await readNativeTargetScopes(env,context,[...new Set(rows.map(r=>r.folder_binding_id))].map(publicId=>({scopeType:'folder',publicId})),{retention:'structural'});
  const result:Array<GrantCandidate & {owner_name:string;binding_fingerprint:string}> = [];
  for (const row of rows) {
    const owner=scopes.get(`folder:${row.folder_binding_id}`);
    if(!owner||owner.bindingVersion!==row.binding_source_version)continue;
    const expired=owner.proofRows.filter(p=>p.entity_type==='project'&&p.retained===0).map(p=>p.public_id);
    if(!projectAccessRowAllows(row,owner.scopes,expired)
      ||!nativePortalScopesAllowed(context,'delivery.view',owner.scopes,row.source==='staff',owner,row.access_terms_id?row.terms_project_id??undefined:undefined))continue;
    if(row.audience_type!=='principal'&&owner.versions.get(`${row.audience_type}:${row.audience_public_id}`)!==row.audience_source_version)continue;
    {
      const fingerprint = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([
        context.sourceId,context.workspaceId,row.folder_binding_id,row.binding_source_version,row.r2_prefix,
        row.owner_scope_type,row.owner_public_id,row.source,row.grant_id,row.grant_version,
        row.audience_type,row.audience_public_id,row.audience_source_version,
        row.access_terms_id??null,
      ]))));
      result.push({...row,owner_name:owner.name,binding_fingerprint:[...fingerprint].map(n=>n.toString(16).padStart(2,'0')).join('')});
    }
  }
  return result;
}

/** Seek raw bindings before authorization. Empty intermediate pages retain a
 * continuation, so denied or ungranted bindings cannot hide later deliveries. */
export async function readNativeAuthenticatedDeliveryPage(env:Env,principal:VerifiedClientPrincipal,context:NativePortalReadContext,after=''){
  if(!await nativeDeliveryResourcesReady(env))throw new HTTPException(503,{message:'Native deliveries are not ready. Contact support.'});
  const bindings=await portalDb(env).prepare(`SELECT id FROM portal_v2_folder_bindings
    WHERE workspace_id=? AND id>? AND status='active' AND revoked_at IS NULL ORDER BY id LIMIT 26`)
    .bind(context.workspaceId,after).all<{id:string}>();
  const scanned=bindings.results.slice(0,25);
  const grants=scanned.length?await readNativeAuthenticatedDeliveryGrants(env,principal,context,undefined,{bindingIds:scanned.map(b=>b.id)}):[];
  const unique=[...new Map(grants.sort((a,b)=>a.grant_id.localeCompare(b.grant_id)).map(g=>[g.folder_binding_id,g])).values()]
    .sort((a,b)=>a.folder_binding_id<b.folder_binding_id?-1:a.folder_binding_id>b.folder_binding_id?1:0);
  return {grants:unique,after:bindings.results.length>25?scanned.at(-1)!.id:null};
}

async function integrationDenied(env:Env,principal:VerifiedClientPrincipal,workspaceId:string,row:GrantCandidate):Promise<boolean>{
  if(env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED!=="true")return false;
  const denied=await portalDb(env).prepare(`WITH RECURSIVE lineage(entity_type,public_id,parent_public_id,depth) AS (
    SELECT entity.entity_type,entity.public_id,entity.parent_public_id,0
    FROM portal_v2_directory_checkpoints checkpoint JOIN portal_v2_directory_entities entity
      ON entity.workspace_id=checkpoint.workspace_id AND entity.generation_id=checkpoint.active_generation_id
      AND entity.entity_type=? AND entity.public_id=? AND entity.active=1 WHERE checkpoint.workspace_id=?
    UNION SELECT parent.entity_type,parent.public_id,parent.parent_public_id,lineage.depth+1 FROM lineage
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=?
      JOIN portal_v2_directory_entities parent ON parent.workspace_id=checkpoint.workspace_id
        AND parent.generation_id=checkpoint.active_generation_id AND parent.public_id=lineage.parent_public_id AND parent.active=1
      WHERE lineage.parent_public_id IS NOT NULL AND lineage.depth<12
  ) SELECT 1 ok FROM portal_v2_identities identity JOIN portal_v2_identity_denials denial ON denial.identity_id=identity.id
    WHERE identity.issuer=? AND identity.subject=? AND identity.status='active' AND identity.revoked_at IS NULL
      AND denial.status='active' AND denial.revoked_at IS NULL AND datetime(denial.valid_from)<=datetime('now')
      AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
      AND (denial.scope_type='global' OR (denial.workspace_id=? AND
        ((denial.scope_type='workspace' AND denial.scope_public_id=?) OR
         (denial.scope_type='folder' AND denial.scope_public_id=?) OR
         EXISTS(SELECT 1 FROM lineage WHERE entity_type=denial.scope_type AND public_id=denial.scope_public_id)))) LIMIT 1`)
    .bind(row.owner_scope_type,row.owner_public_id,workspaceId,workspaceId,principal.issuer,principal.subject,
      workspaceId,workspaceId,row.folder_binding_id).first("ok");
  return denied!==null;
}

async function audienceLiveAndContained(env: Env, workspaceId: string, row: GrantCandidate): Promise<boolean> {
  if (row.audience_type === "principal") {
    const active = await portalDb(env).prepare(`SELECT 1 ok FROM pa_portal_principals
      WHERE workspace_id=? AND public_id=? AND source_version=? AND status='active'`)
      .bind(workspaceId, row.audience_public_id, row.audience_source_version).first("ok");
    return active !== null;
  }
  const active = await portalDb(env).prepare(`WITH RECURSIVE ancestry(entity_type,public_id,parent_public_id,source_version,depth) AS (
      SELECT owner.entity_type,owner.public_id,owner.parent_public_id,owner.source_version,0
      FROM portal_v2_directory_checkpoints checkpoint
      JOIN portal_v2_directory_generations generation
        ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=checkpoint.workspace_id
        AND generation.status='active' AND generation.complete=1
      JOIN portal_v2_directory_entities owner
        ON owner.workspace_id=checkpoint.workspace_id AND owner.generation_id=checkpoint.active_generation_id
        AND owner.entity_type=? AND owner.public_id=? AND owner.active=1
      WHERE checkpoint.workspace_id=?
      UNION
      SELECT parent.entity_type,parent.public_id,parent.parent_public_id,parent.source_version,ancestry.depth+1
      FROM ancestry
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=?
      JOIN portal_v2_directory_entities parent
        ON parent.workspace_id=checkpoint.workspace_id AND parent.generation_id=checkpoint.active_generation_id
        AND parent.public_id=ancestry.parent_public_id AND parent.active=1
      WHERE ancestry.parent_public_id IS NOT NULL AND ancestry.depth<12
      UNION
      SELECT parent.entity_type,parent.public_id,parent.parent_public_id,parent.source_version,ancestry.depth+1
      FROM ancestry
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=?
      JOIN portal_v2_directory_relations relation
        ON relation.workspace_id=checkpoint.workspace_id AND relation.generation_id=checkpoint.active_generation_id
        AND relation.to_type=ancestry.entity_type AND relation.to_public_id=ancestry.public_id
        AND relation.relation_type='contains' AND relation.active=1
      JOIN portal_v2_directory_entities parent
        ON parent.workspace_id=relation.workspace_id AND parent.generation_id=relation.generation_id
        AND parent.entity_type=relation.from_type AND parent.public_id=relation.from_public_id AND parent.active=1
      WHERE ancestry.depth<12
    ) SELECT 1 ok FROM ancestry WHERE entity_type=? AND public_id=? AND source_version=? LIMIT 1`)
    .bind(row.owner_scope_type, row.owner_public_id, workspaceId, workspaceId, workspaceId,
      row.audience_type, row.audience_public_id, row.audience_source_version).first("ok");
  return active !== null;
}

/**
 * Intersects an exact verified portal identity and its live portal-v2
 * entitlement with one versioned staff-approved folder grant. The grant never
 * replaces PA identity/membership authority; both sides must still be live.
 */
export async function authorizeAuthenticatedDeliveryGrant(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
  folderBindingId: string,
): Promise<boolean> {
  if (!authenticatedDeliveryGrantsEnabled(env) || !OPAQUE.test(workspaceId) || !OPAQUE.test(folderBindingId)) return false;
  const rows = await candidates(env, principal, workspaceId, folderBindingId);
  if (!rows) return false;
  const termsReady=await projectAccessTermsReady(env.DELIVERY_DB);
  if(termsReady&&(await authorizedPrimaryStaffGrants(env,principal,workspaceId,rows)).length)return true;
  for (const row of rows) {
    if(termsReady&&row.source==='staff')continue;
    if(row.access_terms_id&&!projectAccessRowAllows(row,new Set([`project:${row.owner_public_id}`])))continue;
    if(row.access_terms_id){
      const scope=(await authorizePrimaryPortalTargetBatch(env,principal,workspaceId,[{target:{scopeType:'folder',publicId:folderBindingId},retainedProjectId:row.owner_public_id}]))
        .get(`folder:${folderBindingId}`);
      if(scope?.bindingVersion===row.binding_source_version&&(row.audience_type==='principal'||scope.versions.get(`${row.audience_type}:${row.audience_public_id}`)===row.audience_source_version))return true;
      continue;
    }
    if(!await audienceLiveAndContained(env,workspaceId,row))continue;
    if(row.source==="project_alpha_delivery"){
      if(!await integrationDenied(env,principal,workspaceId,row))return true;
      continue;
    }
    if(await authorizePortalWorkspaceCapability(env,principal,workspaceId,"delivery.view",{scopeType:"folder",publicId:folderBindingId},
      row.access_terms_id&&row.terms_project_id?{retainedProjectId:row.terms_project_id}:undefined))return true;
  }
  return false;
}

/** Server-only prefix set for repository SQL filtering. Raw prefixes must never
 * be serialized in browser responses. */
export async function listAuthorizedAuthenticatedDeliveryPrefixes(
  env: Env,
  principal: VerifiedClientPrincipal,
  workspaceId: string,
): Promise<Set<string>> {
  if (!authenticatedDeliveryGrantsEnabled(env) || !OPAQUE.test(workspaceId)) return new Set();
  const termsReady=await projectAccessTermsReady(env.DELIVERY_DB);
  if(termsReady){
    const rows=await candidates(env,principal,workspaceId);
    if(!rows)throw new HTTPException(503,{message:'Project delivery access exceeds safe capacity. Contact support.'});
    const prefixes=new Set((await authorizedPrimaryStaffGrants(env,principal,workspaceId,rows)).map(({row})=>row.r2_prefix));
    // Integration-owned legacy grants retain their separate existing policy.
    for(const row of rows.filter(item=>item.source==='project_alpha_delivery'))
      if(await audienceLiveAndContained(env,workspaceId,row)&&!await integrationDenied(env,principal,workspaceId,row))prefixes.add(row.r2_prefix);
    return prefixes;
  }
  const [primaryReceiptReady,bindingSourceTypeReady]=await Promise.all([
    d1TablesPresent(env.DELIVERY_DB,["portal_primary_staff_bindings"]),
    d1ColumnPresent(env.DELIVERY_DB,"portal_v2_folder_bindings","source_type"),
  ]);
  const primaryReceiptSql=primaryOperationsReceiptSql(primaryReceiptReady,bindingSourceTypeReady);
  // Resolve every folder binding in one bounded authorization query. Calling
  // the single-binding resolver in a loop repeated identity, membership,
  // hierarchy, entitlement and denial reads up to 100 times on each listing.
  const rows = await portalDb(env).prepare(`WITH RECURSIVE base AS (
      SELECT DISTINCT identity.id identity_id,workspace.id workspace_id,workspace.root_type,
        COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) root_public_id,
        grant_record.id grant_id,${termsReady?'grant_record.access_terms_id':'NULL'} access_terms_id,grant_record.audience_type,grant_record.audience_public_id,
        grant_record.audience_source_version,binding.id folder_binding_id,binding.r2_prefix,
        owner.entity_type,owner.public_id,owner.parent_public_id,owner.source_version
      FROM portal_v2_identities identity
      JOIN portal_v2_workspace_memberships membership
        ON membership.identity_id=identity.id AND membership.workspace_id=?
        AND membership.status='active' AND membership.revoked_at IS NULL
        AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
      JOIN portal_v2_workspaces workspace
        ON workspace.id=membership.workspace_id AND workspace.status='active'
        AND ${portalRootAccessAllowedSql(env.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED === "true", "workspace")}
        AND ${primaryWorkspaceAccount("workspace")}
      JOIN portal_v2_authenticated_delivery_grants grant_record
        ON grant_record.workspace_id=workspace.id AND grant_record.status='active'
        AND grant_record.revoked_at IS NULL
        AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))
      JOIN portal_v2_folder_bindings binding
        ON binding.id=grant_record.folder_binding_id AND binding.workspace_id=grant_record.workspace_id
        AND binding.status='active' AND binding.revoked_at IS NULL
        AND binding.source_version=grant_record.binding_source_version
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
      JOIN portal_v2_directory_generations generation
        ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=checkpoint.workspace_id
        AND generation.status='active' AND generation.complete=1
      JOIN portal_v2_directory_entities owner
        ON owner.workspace_id=workspace.id AND owner.generation_id=checkpoint.active_generation_id
        AND owner.entity_type=binding.owner_scope_type AND owner.public_id=binding.owner_public_id
        AND owner.active=1
      LEFT JOIN portal_v2_authenticated_delivery_grant_recipients recipient
        ON grant_record.audience_type='principal' AND recipient.grant_id=grant_record.id
        AND recipient.workspace_id=workspace.id AND recipient.identity_id=identity.id
        AND recipient.principal_public_id=grant_record.audience_public_id
      LEFT JOIN pa_portal_principals principal_record
        ON principal_record.workspace_id=recipient.workspace_id
        AND principal_record.public_id=recipient.principal_public_id
        AND principal_record.identity_id=recipient.identity_id AND principal_record.status='active'
        AND principal_record.source_version=recipient.principal_source_version
      WHERE identity.issuer=? AND identity.subject=? AND identity.status='active' AND identity.revoked_at IS NULL
        AND ${primaryReceiptSql}
        AND (grant_record.audience_type<>'principal' OR principal_record.public_id IS NOT NULL)
    ), lineage(grant_id,entity_type,public_id,parent_public_id,source_version,depth) AS (
      SELECT grant_id,entity_type,public_id,parent_public_id,source_version,0 FROM base
      UNION
      SELECT lineage.grant_id,parent.entity_type,parent.public_id,parent.parent_public_id,parent.source_version,lineage.depth+1
      FROM lineage
      JOIN base ON base.grant_id=lineage.grant_id
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=base.workspace_id
      JOIN portal_v2_directory_entities parent
        ON parent.workspace_id=base.workspace_id AND parent.generation_id=checkpoint.active_generation_id
        AND parent.public_id=lineage.parent_public_id AND parent.active=1
      WHERE lineage.parent_public_id IS NOT NULL AND lineage.depth<12
      UNION
      SELECT lineage.grant_id,parent.entity_type,parent.public_id,parent.parent_public_id,parent.source_version,lineage.depth+1
      FROM lineage
      JOIN base ON base.grant_id=lineage.grant_id
      JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=base.workspace_id
      JOIN portal_v2_directory_relations relation
        ON relation.workspace_id=base.workspace_id AND relation.generation_id=checkpoint.active_generation_id
        AND relation.to_type=lineage.entity_type AND relation.to_public_id=lineage.public_id
        AND relation.relation_type='contains' AND relation.active=1
      JOIN portal_v2_directory_entities parent
        ON parent.workspace_id=relation.workspace_id AND parent.generation_id=relation.generation_id
        AND parent.entity_type=relation.from_type AND parent.public_id=relation.from_public_id AND parent.active=1
      WHERE ?='true' AND lineage.depth<12
    )
    SELECT DISTINCT base.r2_prefix
    FROM base
    WHERE ${termsReady?projectAccessTermsSql({termsId:'base.access_terms_id',workspaceId:'base.workspace_id',projectId:'base.public_id',legacyRetained:'1'}):'1'}
      AND EXISTS (SELECT 1 FROM lineage root
        WHERE root.grant_id=base.grant_id AND root.entity_type=base.root_type
          AND root.public_id=base.root_public_id)
      AND (base.audience_type='principal' OR EXISTS (SELECT 1 FROM lineage audience
        WHERE audience.grant_id=base.grant_id AND audience.entity_type=base.audience_type
          AND audience.public_id=base.audience_public_id
          AND audience.source_version=base.audience_source_version))
      AND EXISTS (SELECT 1 FROM portal_v2_entitlements allow_record
        WHERE allow_record.workspace_id=base.workspace_id AND allow_record.identity_id=base.identity_id
          AND allow_record.capability='delivery.view' AND allow_record.effect='allow'
          AND allow_record.status='active' AND allow_record.revoked_at IS NULL
          AND datetime(allow_record.valid_from)<=datetime('now')
          AND (allow_record.expires_at IS NULL OR datetime(allow_record.expires_at)>datetime('now'))
          ${termsReady?`AND (allow_record.access_terms_id IS NULL OR EXISTS(SELECT 1 FROM lineage term_project
            WHERE term_project.grant_id=base.grant_id AND term_project.entity_type='project'
              AND ${projectAccessTermsSql({termsId:'allow_record.access_terms_id',workspaceId:'base.workspace_id',projectId:'term_project.public_id',legacyRetained:'1'})}))`:''}
          AND ((allow_record.scope_type='workspace' AND allow_record.scope_public_id=?)
            OR (allow_record.scope_type='folder' AND allow_record.scope_public_id=base.folder_binding_id)
            OR EXISTS (SELECT 1 FROM lineage allowed_scope WHERE allowed_scope.grant_id=base.grant_id
              AND allowed_scope.entity_type=allow_record.scope_type
              AND allowed_scope.public_id=allow_record.scope_public_id)))
      AND NOT EXISTS (SELECT 1 FROM portal_v2_entitlements deny_record
        WHERE deny_record.workspace_id=base.workspace_id AND deny_record.identity_id=base.identity_id
          AND deny_record.capability='delivery.view' AND deny_record.effect='deny'
          AND deny_record.status='active' AND deny_record.revoked_at IS NULL
          AND datetime(deny_record.valid_from)<=datetime('now')
          AND (deny_record.expires_at IS NULL OR datetime(deny_record.expires_at)>datetime('now'))
          AND ((deny_record.scope_type='workspace' AND deny_record.scope_public_id=?)
            OR (deny_record.scope_type='folder' AND deny_record.scope_public_id=base.folder_binding_id)
            OR EXISTS (SELECT 1 FROM lineage denied_scope WHERE denied_scope.grant_id=base.grant_id
              AND denied_scope.entity_type=deny_record.scope_type
              AND denied_scope.public_id=deny_record.scope_public_id)))
      AND (?<>'true' OR NOT EXISTS (SELECT 1 FROM portal_v2_identity_denials active_denial
        WHERE active_denial.identity_id=base.identity_id AND active_denial.status='active'
          AND active_denial.revoked_at IS NULL AND datetime(active_denial.valid_from)<=datetime('now')
          AND (active_denial.expires_at IS NULL OR datetime(active_denial.expires_at)>datetime('now'))
          AND (active_denial.scope_type='global' OR (active_denial.workspace_id=base.workspace_id AND
            ((active_denial.scope_type='workspace' AND active_denial.scope_public_id=?)
              OR (active_denial.scope_type='folder' AND active_denial.scope_public_id=base.folder_binding_id)
              OR EXISTS (SELECT 1 FROM lineage denied_identity_scope
                WHERE denied_identity_scope.grant_id=base.grant_id
                  AND denied_identity_scope.entity_type=active_denial.scope_type
                  AND denied_identity_scope.public_id=active_denial.scope_public_id))))))
    ORDER BY base.r2_prefix LIMIT ?`)
    .bind(workspaceId, principal.issuer, principal.subject,
      env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED ?? "false",
      workspaceId, workspaceId, env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED ?? "false", workspaceId,
      AUTHORIZED_BINDING_LIMIT + 1)
    .all<{ r2_prefix: string }>();
  if (rows.results.length > AUTHORIZED_BINDING_LIMIT) return new Set();
  const prefixes=new Set(rows.results.map(row => row.r2_prefix));
  const integration=await candidates(env,principal,workspaceId);
  if(!integration)return new Set();
  for(const row of integration){
    if(!row.r2_prefix || prefixes.has(row.r2_prefix))continue;
    if(row.access_terms_id&&!projectAccessRowAllows(row,new Set([`project:${row.owner_public_id}`])))continue;
    if(!await audienceLiveAndContained(env,workspaceId,row))continue;
    if(row.source==="project_alpha_delivery"){
      if(!await integrationDenied(env,principal,workspaceId,row))prefixes.add(row.r2_prefix);
    }else if(await authorizePortalWorkspaceCapability(env,principal,workspaceId,"delivery.view",{scopeType:"folder",publicId:row.folder_binding_id},
      row.access_terms_id&&row.terms_project_id?{retainedProjectId:row.terms_project_id}:undefined))prefixes.add(row.r2_prefix);
  }
  return prefixes;
}
