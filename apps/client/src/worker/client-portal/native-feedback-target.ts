import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { ClientFeedbackTargetInput } from '@ltds/shared';
import type { Env } from '../types';
import type { VerifiedClientPrincipal } from './types';
import { decodeNativePortalHandle,encodeNativePortalHandle,type NativePortalHandle } from './native-portal-handles';
import { readNativeAuthenticatedDeliveryGrants } from './authenticated-delivery-grants';
import { readNativeTargetScopes,type NativeTargetScopes } from './native-portal-scopes';
import { nativePortalScopesAllowed,resolveNativePortalWorkspaceReadContext,type NativePortalReadContext } from './workspace-v2';
import { nativeFeedbackTargetSchema,type NativeFeedbackAuthorization,type NativeFeedbackRecord,type NativeFeedbackTarget } from './native-feedback-store';
import { portalSourceAuthorityGuard } from '../project-alpha-portal-authority';

const opaque=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const nativeFeedbackTargetInputSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('project'),projectId:opaque}).strict(),
  z.object({kind:z.literal('folder'),projectId:opaque.nullable(),folderId:z.string().min(1).max(8192)}).strict(),
  z.object({kind:z.literal('file'),projectId:opaque.nullable(),fileId:z.string().min(1).max(8192)}).strict(),
]);
type Grant=Awaited<ReturnType<typeof readNativeAuthenticatedDeliveryGrants>>[number];
export interface ResolvedNativeFeedbackTarget extends NativeFeedbackAuthorization {contextVersion:string;grant:Grant|null}
const unavailable=():never=>{throw new HTTPException(404,{message:'Feedback target not found'});};
const changed=():never=>{throw new HTTPException(409,{message:'Feedback target or access changed. Refresh and try again.'});};
function relative(path:string,folder:boolean){if(path===''&&folder)return '';if(folder&&!path.endsWith('/'))return unavailable();
  const bare=folder?path.slice(0,-1):path;if(!bare||bare.startsWith('/')||bare.includes('\\')||bare.split('/').some(part=>!part||part==='.'||part==='..')||/[\u0000-\u001f\u007f]/.test(path))return unavailable();return path;}
function proof(scope:NativeTargetScopes){return scope.proofRows.map(row=>({entityType:row.entity_type,publicId:row.public_id,
  parentPublicId:row.parent_public_id,sourceVersion:row.source_version,depth:row.depth}));}
function grantSnapshot(grant:Grant){return {source:grant.source,id:grant.grant_id,version:grant.grant_version,bindingId:grant.folder_binding_id,
  bindingVersion:grant.binding_source_version,bindingProof:grant.binding_fingerprint,prefix:grant.r2_prefix,ownerType:grant.owner_scope_type,
  ownerPublicId:grant.owner_public_id,audienceType:grant.audience_type,audiencePublicId:grant.audience_public_id,
  audienceSourceVersion:grant.audience_source_version,accessTermsId:grant.access_terms_id??null};}
function sameGrant(target:NativeFeedbackTarget,grant:Grant){return JSON.stringify(target.grant)===JSON.stringify(grantSnapshot(grant));}
const visibleFile=`NOT EXISTS(SELECT 1 FROM delivery_tombstones tombstone WHERE tombstone.restored_at IS NULL
  AND (tombstone.physical_key=file.r2_key OR (tombstone.tombstone_kind='prefix' AND substr(file.r2_key,1,length(tombstone.physical_key))=tombstone.physical_key)))`;

function authorizationGuard(context:NativePortalReadContext,principal:VerifiedClientPrincipal,target:NativeFeedbackTarget,grant:Grant|null,available:boolean){
  // Workspace-scoped entitlements authorize every descendant. Keep the exact
  // target lineage as well so narrower denies still win in the same guard.
  const scopes=[...new Set([`workspace:${context.workspaceId}`,...target.scopeProof.map(row=>`${row.entityType}:${row.publicId}`)])];
  const capability=target.kind==='project'?'directory.read':'delivery.view',requiresAllow=!grant||grant.source==='staff';
  const parts:string[]=[],bindings:(string|number|null)[]=[];
  const authority=portalSourceAuthorityGuard(context.authority);
  parts.push(authority.sql);bindings.push(...authority.bindings);
  parts.push(`EXISTS(SELECT 1 FROM portal_v2_workspaces workspace
    JOIN pa_portal_workspace_sources source ON source.workspace_id=workspace.id AND source.projection_source_id=workspace.project_alpha_source_id
    JOIN pa_portal_source_authorities authority ON authority.source_id=workspace.project_alpha_source_id AND authority.state='active'
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=workspace.id AND membership.identity_id=?
      AND membership.status='active' AND membership.revoked_at IS NULL AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    JOIN portal_v2_identities identity ON identity.id=membership.identity_id AND identity.status='active' AND identity.revoked_at IS NULL
    JOIN pa_portal_principals principal_record ON principal_record.workspace_id=workspace.id AND principal_record.identity_id=identity.id
      AND principal_record.status='active' AND principal_record.source_version=membership.source_version
      AND lower(principal_record.email_hint)=lower(identity.verified_email)
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.workspace_id=workspace.id AND generation.id=checkpoint.active_generation_id
      AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities root ON root.workspace_id=workspace.id AND root.generation_id=generation.id AND root.active=1
      AND root.entity_type=workspace.root_type AND root.public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)
    WHERE workspace.id=? AND workspace.project_alpha_source_id=? AND workspace.legacy_account_id IS NULL AND workspace.status='active'
      AND workspace.root_type=? AND COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)=?
      AND identity.issuer=? AND identity.subject=? AND membership.source_type='project_alpha' AND membership.source_version=?
      AND lower(identity.verified_email)=lower(?) AND lower(principal_record.email_hint)=lower(?))`);
  bindings.push(context.identityId,context.workspaceId,context.sourceId,context.rootType,context.rootPublicId,
    principal.issuer,principal.subject,context.membershipSourceVersion,context.verifiedEmail,context.verifiedEmail);
  for(const row of target.scopeProof){parts.push(`EXISTS(SELECT 1 FROM portal_v2_directory_checkpoints checkpoint
    JOIN portal_v2_directory_entities entity ON entity.workspace_id=checkpoint.workspace_id AND entity.generation_id=checkpoint.active_generation_id
    WHERE checkpoint.workspace_id=? AND entity.entity_type=? AND entity.public_id=? AND entity.parent_public_id IS ? AND entity.source_version=? AND entity.active=1)`);
    bindings.push(context.workspaceId,row.entityType,row.publicId,row.parentPublicId,row.sourceVersion);}
  const scopeJson=JSON.stringify(scopes);
  parts.push(`NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials denial WHERE denial.identity_id=? AND denial.status='active' AND denial.revoked_at IS NULL
    AND datetime(denial.valid_from)<=datetime('now') AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
    AND (denial.scope_type='global' OR (denial.workspace_id=? AND denial.scope_type||':'||denial.scope_public_id IN (SELECT value FROM json_each(?)))))`);
  bindings.push(context.identityId,context.workspaceId,scopeJson);
  parts.push(`NOT EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement WHERE entitlement.workspace_id=? AND entitlement.identity_id=?
    AND entitlement.capability=? AND entitlement.effect='deny' AND entitlement.status='active' AND entitlement.revoked_at IS NULL
    AND datetime(entitlement.valid_from)<=datetime('now') AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
    AND entitlement.scope_type||':'||entitlement.scope_public_id IN (SELECT value FROM json_each(?)))`);
  bindings.push(context.workspaceId,context.identityId,capability,scopeJson);
  if(requiresAllow){parts.push(`EXISTS(SELECT 1 FROM portal_v2_entitlements entitlement WHERE entitlement.workspace_id=? AND entitlement.identity_id=?
    AND entitlement.capability=? AND entitlement.effect='allow' AND entitlement.status='active' AND entitlement.revoked_at IS NULL
    AND datetime(entitlement.valid_from)<=datetime('now') AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
    AND entitlement.scope_type||':'||entitlement.scope_public_id IN (SELECT value FROM json_each(?)))`);
    bindings.push(context.workspaceId,context.identityId,capability,scopeJson);}
  if(grant){const table=grant.source==='staff'?'portal_v2_authenticated_delivery_grants':'project_alpha_delivery_portal_grants';
    parts.push(`EXISTS(SELECT 1 FROM portal_v2_folder_bindings binding JOIN ${table} grant_record
      ON grant_record.workspace_id=binding.workspace_id AND grant_record.folder_binding_id=binding.id
      WHERE binding.workspace_id=? AND binding.id=? AND binding.source_version=? AND binding.r2_prefix=? AND binding.owner_scope_type=? AND binding.owner_public_id=?
        AND binding.status='active' AND binding.revoked_at IS NULL AND grant_record.id=? AND grant_record.grant_version=?
        AND grant_record.binding_source_version=binding.source_version AND grant_record.audience_type=? AND grant_record.audience_public_id=?
        AND grant_record.audience_source_version=? AND grant_record.status='active' AND grant_record.revoked_at IS NULL
        AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now')))`);
    bindings.push(context.workspaceId,grant.folder_binding_id,grant.binding_source_version,grant.r2_prefix,grant.owner_scope_type,grant.owner_public_id,
      grant.grant_id,grant.grant_version,grant.audience_type,grant.audience_public_id,grant.audience_source_version);}
  if(grant?.source==='staff'){
    parts.push(`EXISTS(SELECT 1 FROM portal_native_staff_grants publication JOIN portal_native_staff_bindings ownership
      ON ownership.binding_id=publication.binding_id AND ownership.source_id=publication.source_id
      WHERE publication.grant_id=? AND publication.binding_id=? AND publication.state='active' AND publication.source_id=?
        AND ownership.workspace_id=? AND ownership.r2_prefix=? AND ownership.project_public_id=? AND ?='project')`);
    bindings.push(grant.grant_id,grant.folder_binding_id,context.sourceId,context.workspaceId,grant.r2_prefix,grant.owner_public_id,grant.owner_scope_type);
    if(grant.audience_type==='principal'){
      parts.push(`EXISTS(SELECT 1 FROM portal_v2_authenticated_delivery_grant_recipients recipient
        JOIN pa_portal_principals principal_record ON principal_record.workspace_id=recipient.workspace_id
          AND principal_record.public_id=recipient.principal_public_id AND principal_record.identity_id=recipient.identity_id
          AND principal_record.status='active' AND principal_record.source_version=recipient.principal_source_version
        WHERE recipient.workspace_id=? AND recipient.identity_id=? AND recipient.grant_id=?
          AND recipient.principal_public_id=? AND recipient.principal_source_version=?)`);
      bindings.push(context.workspaceId,context.identityId,grant.grant_id,grant.audience_public_id,grant.audience_source_version);
    }
  }
  if(grant?.source==='project_alpha_delivery'){
    parts.push(`EXISTS(SELECT 1 FROM project_alpha_delivery_portal_grants current_grant
      JOIN project_alpha_delivery_intent_receipts receipt ON receipt.receipt_id=current_grant.receipt_id
        AND receipt.access_mode='portal' AND receipt.resource_id=current_grant.id AND receipt.status='accepted'
      WHERE current_grant.id=? AND current_grant.workspace_id=? AND current_grant.grant_version=?
        AND receipt.project_alpha_source_id=?)`);
    bindings.push(grant.grant_id,context.workspaceId,grant.grant_version,context.sourceId);
    parts.push(`EXISTS(SELECT 1 FROM portal_v2_identities current_identity
      JOIN pa_portal_principals principal_record ON principal_record.workspace_id=? AND principal_record.public_id=?
        AND principal_record.source_version=? AND principal_record.status='active'
      WHERE current_identity.id=? AND current_identity.issuer=? AND current_identity.subject=?
        AND current_identity.status='active' AND current_identity.revoked_at IS NULL
        AND (principal_record.identity_id=current_identity.id OR EXISTS(
          SELECT 1 FROM portal_v2_identity_eligibility_bindings eligibility
          WHERE eligibility.identity_id=current_identity.id AND eligibility.workspace_id=principal_record.workspace_id
            AND eligibility.principal_public_id=principal_record.public_id
            AND eligibility.principal_source_version=principal_record.source_version
            AND eligibility.verified_email=current_identity.verified_email)))`);
    bindings.push(context.workspaceId,grant.audience_public_id,grant.audience_source_version,context.identityId,principal.issuer,principal.subject);
  }
  if(target.kind==='file'&&available&&target.file){parts.push(`EXISTS(SELECT 1 FROM file_index file WHERE file.r2_key=? AND file.etag=? AND file.size=? AND file.uploaded_at=? AND ${visibleFile})`);
    bindings.push(target.storageKey,target.file.etag,target.file.size,target.file.uploadedAt);}
  return {sql:parts.map(part=>`(${part})`).join(' AND '),bindings};
}

export async function resolveNativeFeedbackTarget(env:Env,principal:VerifiedClientPrincipal,context:NativePortalReadContext,
  requested:ClientFeedbackTargetInput,stored?:NativeFeedbackTarget):Promise<ResolvedNativeFeedbackTarget>{
  const parsed=nativeFeedbackTargetInputSchema.safeParse(requested);if(!parsed.success)return unavailable();const value=parsed.data;
  let scope:NativeTargetScopes|undefined,grant:Grant|null=null,relativePath:string|null=null,storageKey:string|null=null;
  let projectPublicId:string|null=value.projectId,label='',projectName:string|null=null,file:NativeFeedbackTarget['file']=null;
  if(value.kind==='project'){
    scope=(await readNativeTargetScopes(env,context,[{scopeType:'project',publicId:value.projectId}],{retention:'structural'})).get(`project:${value.projectId}`);
    if(!scope||!nativePortalScopesAllowed(context,'directory.read',scope.scopes,true,scope))return unavailable();label=scope.name;projectName=scope.name;
  }else{
    const raw=value.kind==='folder'?value.folderId:value.fileId,handle=await decodeNativePortalHandle(env,raw);
    if(!handle||handle.kind!==value.kind||handle.sourceId!==context.sourceId||handle.workspaceId!==context.workspaceId||handle.identityId!==context.identityId)return unavailable();
    if(handle.contextVersion!==context.contextVersion)return changed();
    const grants=await readNativeAuthenticatedDeliveryGrants(env,principal,context,handle.bindingId,{grantId:handle.grantId});
    grant=grants.find(row=>row.grant_id===handle.grantId&&row.grant_version===handle.grantVersion&&row.binding_source_version===handle.bindingVersion
      &&row.binding_fingerprint===handle.bindingProof)??null;if(!grant)return unavailable();
    relativePath=relative(handle.path,value.kind==='folder');storageKey=value.kind==='file'?`${grant.r2_prefix}${relativePath}`:null;
    scope=(await readNativeTargetScopes(env,context,[{scopeType:'folder',publicId:grant.folder_binding_id}],{retention:'structural'})).get(`folder:${grant.folder_binding_id}`);
    if(!scope||scope.bindingVersion!==grant.binding_source_version)return unavailable();projectPublicId=grant.owner_scope_type==='project'?grant.owner_public_id:null;
    projectName=grant.owner_scope_type==='project'?grant.owner_name:null;label=(relativePath.split('/').filter(Boolean).at(-1)??grant.owner_name).slice(0,160);
    if(value.kind==='file'){
      const row=await env.DELIVERY_DB.withSession('first-primary').prepare(`SELECT file.etag,file.size,file.uploaded_at FROM file_index file
        WHERE file.r2_key=? AND ${visibleFile}`).bind(storageKey).first<{etag:string;size:number;uploaded_at:string}>();
      if(!row||row.etag!==handle.etag)return unavailable();file={etag:row.etag,size:row.size,uploadedAt:row.uploaded_at};
    }
  }
  const target=nativeFeedbackTargetSchema.parse({version:1,sourceId:context.sourceId,workspaceId:context.workspaceId,rootType:context.rootType,
    rootPublicId:context.rootPublicId,kind:value.kind,projectPublicId,targetType:value.kind==='project'?'project':'folder',
    targetPublicId:value.kind==='project'?value.projectId:grant!.folder_binding_id,label:label.slice(0,160),projectName:projectName?.slice(0,160)??null,
    relativePath,storageKey,file,grant:grant?grantSnapshot(grant):null,scopeProof:proof(scope!)});
  if(stored){if(stored.sourceId!==context.sourceId||stored.workspaceId!==context.workspaceId||stored.rootType!==context.rootType||stored.rootPublicId!==context.rootPublicId
      ||stored.kind!==target.kind||stored.projectPublicId!==target.projectPublicId||stored.targetType!==target.targetType||stored.targetPublicId!==target.targetPublicId
      ||stored.relativePath!==target.relativePath||stored.storageKey!==target.storageKey||JSON.stringify(stored.scopeProof)!==JSON.stringify(target.scopeProof)
      ||(grant&&!sameGrant(stored,grant)))return unavailable();}
  const canonical=stored??target,available=value.kind!=='file'||JSON.stringify(canonical.file)===JSON.stringify(target.file);
  return {context:{sourceId:context.sourceId,workspaceId:context.workspaceId,identityId:context.identityId,issuer:principal.issuer,subject:principal.subject},
    target:canonical,guard:authorizationGuard(context,principal,canonical,grant,available),available,contextVersion:context.contextVersion,grant};
}

export async function reauthorizeNativeFeedbackRecipient(env:Env,record:NativeFeedbackRecord):Promise<ResolvedNativeFeedbackTarget|null>{
  const db=env.DELIVERY_DB.withSession('first-primary'),person=await db.prepare(`SELECT issuer,subject,verified_email email FROM portal_v2_identities
    WHERE id=? AND issuer=? AND subject=? AND status='active' AND revoked_at IS NULL`).bind(record.context.identityId,record.context.issuer,record.context.subject)
    .first<{issuer:string;subject:string;email:string}>();if(!person)return null;
  const principal={issuer:person.issuer,subject:person.subject,email:person.email},context=await resolveNativePortalWorkspaceReadContext(env,principal,record.context.workspaceId);
  if(!context||context.sourceId!==record.context.sourceId||context.identityId!==record.context.identityId)return null;
  try{
    if(record.target.kind==='project')return await resolveNativeFeedbackTarget(env,principal,context,{kind:'project',projectId:record.target.projectPublicId!},record.target);
    const grant=(await readNativeAuthenticatedDeliveryGrants(env,principal,context,record.target.grant!.bindingId,{grantId:record.target.grant!.id}))[0];
    if(!grant||!sameGrant(record.target,grant))return null;
    const kind=record.target.kind,handle:NativePortalHandle={v:1,kind,sourceId:context.sourceId,workspaceId:context.workspaceId,identityId:context.identityId,
      contextVersion:context.contextVersion,bindingId:grant.folder_binding_id,bindingVersion:grant.binding_source_version,grantId:grant.grant_id,
      grantVersion:grant.grant_version,bindingProof:grant.binding_fingerprint,path:record.target.relativePath??'',expires:Date.now()+60*60_000,
      ...(kind==='file'&&record.target.file?{etag:record.target.file.etag}:{})};
    const token=await encodeNativePortalHandle(env,handle),request=kind==='folder'?{kind,projectId:record.target.projectPublicId,folderId:token} as const
      :{kind,projectId:record.target.projectPublicId,fileId:token} as const;
    return await resolveNativeFeedbackTarget(env,principal,context,request,record.target);
  }catch(error){if(error instanceof HTTPException&&[403,404,409].includes(error.status))return null;throw error;}
}
export async function nativeFeedbackActionPath(env:Env,resolved:ResolvedNativeFeedbackTarget):Promise<string|null>{
  if(!resolved.available)return null;const target=resolved.target,query=new URLSearchParams({workspace:resolved.context.workspaceId});
  if(target.kind==='project')return `/portal/projects/${encodeURIComponent(target.projectPublicId!)}?${query}`;
  if(!resolved.grant)return null;const handle=await encodeNativePortalHandle(env,{v:1,kind:target.kind,sourceId:resolved.context.sourceId,
    workspaceId:resolved.context.workspaceId,identityId:resolved.context.identityId,contextVersion:resolved.contextVersion,
    bindingId:resolved.grant.folder_binding_id,bindingVersion:resolved.grant.binding_source_version,grantId:resolved.grant.grant_id,
    grantVersion:resolved.grant.grant_version,bindingProof:resolved.grant.binding_fingerprint,path:target.relativePath??'',
    ...(target.kind==='file'&&target.file?{etag:target.file.etag}:{}),expires:Date.now()+60*60_000});
  query.set(target.kind,handle);return `/portal/deliveries?${query}`;
}
