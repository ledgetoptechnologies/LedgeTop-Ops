import { PRIMARY_ALPHA_SOURCE_ID } from '@ltds/shared';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { authorizeItem, normalizePrefix } from './delivery';
import { authenticatedDeliveryGrantsEnabled } from './authenticated-delivery-grants';
import { validatedUniquePublicIdExpression } from './client-hub-source';
import { projectAlphaReadVisibleSql } from './project-alpha-read-visibility';
import { portalSourceAuthoritiesReady } from '../../../client/src/worker/project-alpha-portal-authority';
import { NATIVE_PORTAL_TARGET_SCOPES_SQL,readNativeTargetScopes } from '../../../client/src/worker/client-portal/native-portal-scopes';
import { eligiblePortalShellQuery } from '../../../client/src/worker/client-portal/workspace-v2';
import { projectAccessCapacitySql } from '../../../client/src/worker/client-portal/project-access-capacity';
import { prepareProjectAccessTerms, projectAccessTermsSql, projectAccessTermsExpirySql, projectAccessTermsReady,
  type ProjectAccessTermsView } from '../../../client/src/worker/client-portal/project-access-terms';
import { projectAccessAuthorityHistoryReady,projectAccessGrantEvent } from '../../../client/src/worker/client-portal/project-access-authority-history';
import type { Env, StaffPrincipal } from './types';
import {requireProjectAccessAuthorityMutations} from './project-access-mutation-gate';
import { portalRootAccessAllowedSql } from './client-portal-root-access';
import { requireAuthenticatedDeliveryCreation } from './authenticated-delivery-creation-gate';

type Database = Pick<D1Database,'prepare'|'batch'>;
const opaque = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const source = z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/).refine(value=>value!==PRIMARY_ALPHA_SOURCE_ID);
const accessTermsSchema = z.object({
  kind:z.enum(['customer','collaborator']),mode:z.enum(['specific_date','project_end','until_revoked']),
  expiresAt:z.string().datetime({offset:true}).nullable(),
}).strict().superRefine((terms,context)=>{
  if((terms.kind==='customer'&&terms.mode!=='until_revoked')
    ||(terms.mode==='specific_date')!==(terms.expiresAt!==null))
    context.addIssue({code:'custom',message:'Invalid project access terms'});
});
type AccessTerms = z.infer<typeof accessTermsSchema>;
const selectionSchema = z.object({folderRef:z.string().regex(/^[A-Za-z0-9_-]{2,1400}$/),sourceId:source,
  workspaceId:opaque,projectId:z.string().min(1).max(512),principalPublicId:opaque,
  reasonCode:z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_. -]+$/),expiresAt:z.string().datetime({offset:true}).nullable(),
  accessTerms:accessTermsSchema.optional()}).strict();
export type NativeDeliveryGrantInput = z.infer<typeof selectionSchema>;
export interface NativeDeliveryGrantView {
  id:string;grantId:string;version:number;sourceId:string;sourceName:string;workspaceId:string;workspaceName:string;
  projectId:string;projectName:string;principalPublicId:string;recipientName:string;recipientEmail:string|null;
  status:'active'|'revoked'|'expired';expiresAt:string|null;createdAt:string;canRevoke:boolean;
  publicationState:'pending'|'active'|'suspended'|'revoked';
  accessTerms:AccessTerms|null;effectiveAccessExpiresAt:string|null;
}
export interface NativeDeliveryGrantPreview {
  operation:NativeDeliveryGrantInput;contextVersion:string;sourceName:string;workspaceName:string;projectName:string;
  recipientName:string;recipientEmail:string|null;folderName:string;expiresAt:string|null;
  accessTerms:AccessTerms|null;effectiveAccessExpiresAt:string|null;projectEndSupported:boolean;
}
interface OpsProof { sourceId:string;sourceName:string;projectId:string;projectName:string;projectPublicId:string;
  rootType:'organization'|'standalone_client';rootPublicId:string;divisionId:string;connectorRevision:number;
  connectorVersion:number;producerBindingId:string;[key:string]:unknown }
interface DeliveryProof { workspaceName:string;generationId:string;ownerVersion:string;principalVersion:string;
  identityId:string;recipientName:string;recipientEmail:string|null;[key:string]:unknown }
interface Prepared { operation:NativeDeliveryGrantInput;prefix:string;bindingId:string;opsInput:string;opsJson:string;ops:OpsProof;
  deliveryInput:string;deliveryJson:string;deliverySql:string;delivery:DeliveryProof;contextVersion:string;
  accessTermsView?:ProjectAccessTermsView|null;projectEndSupported?:boolean }
interface Authorization { id:string;actor_id:string;idempotency_key:string;action:'create'|'revoke';fingerprint:string;
  source_id:string;workspace_id:string;project_id:string;grant_id:string;binding_id:string;operation_json:string;
  ops_proof_json:string;delivery_proof_json:string;publication_deadline:string }
interface StoredGrant { id:string;logical_grant_id:string;grant_version:number;workspace_id:string;folder_binding_id:string;
  audience_public_id:string;status:'active'|'revoked'|'expired';expires_at:string|null;created_at:string;
  source_id:string;project_id:string;project_public_id:string;r2_prefix:string;division_id:string;state:string;
  authorization_id:string;fingerprint:string;access_terms_id:string|null;access_kind:AccessTerms['kind']|null;
  access_mode:AccessTerms['mode']|null;access_expires_at:string|null;effective_access_expires_at:string|null }

const error=(status:400|403|404|409|503,code:string):never=>{throw new HTTPException(status,{message:code});};
const changed=():never=>error(409,'native_delivery_context_changed');
const unavailable=():never=>error(503,'native_delivery_unavailable');
const primary=(db:D1Database):Database=>db.withSession('first-primary');
const digest=async(value:unknown)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))]
  .map(n=>n.toString(16).padStart(2,'0')).join('');
const display=(value:string)=>value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,500);
const utc=(value:string)=>new Date(value.includes('T')?value:value.replace(' ','T')+'Z').toISOString();
function parse(value:unknown):NativeDeliveryGrantInput {
  const parsed=selectionSchema.safeParse(value);if(!parsed.success)return error(400,'native_delivery_invalid');
  const input=parsed.data;
  if(input.accessTerms){
    if(input.accessTerms.expiresAt)input.accessTerms.expiresAt=new Date(input.accessTerms.expiresAt).toISOString();
    // One explicit reviewed lifetime; never silently select a longer one when
    // an older client also submits the legacy expiration field.
    const legacy=input.expiresAt?new Date(input.expiresAt).toISOString():null;
    if(legacy!==input.accessTerms.expiresAt)return error(400,'native_delivery_expiry_conflict');
  }
  if(input.expiresAt){input.expiresAt=new Date(input.expiresAt).toISOString();
    if(Date.parse(input.expiresAt)<=Date.now()||Date.parse(input.expiresAt)>Date.now()+366*86400_000)return error(400,'native_delivery_expiry_invalid');}
  return input;
}
function idempotency(value:string):string { if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(value))return error(400,'native_delivery_idempotency_invalid');return value; }
async function tables(db:Database,names:string[]):Promise<boolean>{return await db.prepare(`SELECT count(*) n FROM sqlite_master
  WHERE type='table' AND name IN(SELECT value FROM json_each(?))`).bind(JSON.stringify(names)).first<number>('n')===names.length;}
export async function nativeDeliveryBindingsReady(env:Env):Promise<boolean>{
  return authenticatedDeliveryGrantsEnabled(env)&&await portalSourceAuthoritiesReady(env.DELIVERY_DB)
    &&await tables(primary(env.OPS_DB),['native_delivery_authorizations','pa_connector_portal_coordination','pa_connector_portal_sources'])
    &&await tables(primary(env.DELIVERY_DB),['portal_native_staff_bindings','portal_native_staff_grants','portal_native_staff_grant_events','portal_native_staff_write_fences',
      'portal_project_access_terms','portal_project_access_deadlines'])&&await projectAccessTermsReady(primary(env.DELIVERY_DB));
}
async function ready(env:Env){if(!await nativeDeliveryBindingsReady(env))return unavailable();}
async function activeStaff(env:Env,principal:StaffPrincipal){
  if(!await primary(env.OPS_DB).prepare(`SELECT 1 ok FROM staff_users WHERE id=? AND email=? AND access_subject IS ?
    AND project_alpha_user_id IS ? AND status='active'`).bind(principal.id,principal.email,principal.accessSubject,principal.projectAlphaUserId).first())
    return error(403,'native_delivery_staff_unavailable');
}

// SQL is the authority check, not a JS snapshot of role rows. The same query is
// evaluated inside the OPS receipt INSERT, including new explicit denies.
function permission(key:string):string{return `EXISTS(SELECT 1 FROM permissions_now permission WHERE permission.permission_key='${key}'
    AND permission.effect='allow' AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=folder.division_id)))
  AND NOT EXISTS(SELECT 1 FROM permissions_now permission WHERE permission.permission_key='${key}' AND permission.effect='deny'
    AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=folder.division_id)))`;}
const projectPublic=validatedUniquePublicIdExpression('pa_projects','p');
const organizationPublic=validatedUniquePublicIdExpression('pa_organizations','organization');
const clientPublic=validatedUniquePublicIdExpression('pa_clients','client');
const OPS_PROOF_SQL=`WITH input AS(SELECT json(?) v), permissions_now AS(
  SELECT rp.permission_key,'allow' effect,a.scope,a.division_id FROM staff_role_assignments a
    JOIN role_permissions rp ON rp.role_id=a.role_id,input WHERE a.staff_id=json_extract(v,'$.actor.id')
  UNION ALL SELECT rp.permission_key,'allow',a.scope,a.division_id FROM local_staff_role_assignments a
    JOIN role_permissions rp ON rp.role_id=a.role_id,input WHERE a.staff_id=json_extract(v,'$.actor.id')
  UNION ALL SELECT permission_key,effect,scope,division_id FROM staff_permission_overrides,input WHERE staff_id=json_extract(v,'$.actor.id')
), folders AS(SELECT pf.* FROM project_folders pf,input WHERE rtrim(pf.r2_prefix,'/')||'/' IN(SELECT value FROM json_each(v,'$.ancestors'))),
folder AS(SELECT * FROM folders WHERE length(rtrim(r2_prefix,'/')||'/')=(SELECT max(length(rtrim(r2_prefix,'/')||'/')) FROM folders))
SELECT json_object('actorId',actor.id,'email',actor.email,'subject',actor.access_subject,'alphaUser',actor.project_alpha_user_id,
  'sourceId',p.projection_source_id,'sourceName',connector.display_name,'projectId',p.id,'projectName',p.name,
  'projectPublicId',${projectPublic},'clientId',p.client_id,'organizationId',p.organization_id,
  'rootType',CASE WHEN organization.id IS NOT NULL THEN 'organization' ELSE 'standalone_client' END,
  'rootPublicId',CASE WHEN organization.id IS NOT NULL THEN ${organizationPublic} ELSE ${clientPublic} END,
  'folderProjectId',folder.project_id,'folderPrefix',folder.r2_prefix,'divisionId',folder.division_id,
  'folderConfirmedBy',folder.confirmed_by,'folderConfirmedAt',folder.confirmed_at,
  'connectorRevision',connector.active_revision,'connectorVersion',connector.version,'producerBindingId',connector.producer_binding_id,
  'connectorState',connector.state,'primaryState',primary_connector.state,
  'primaryRevision',primary_connector.active_revision,'primaryVersion',primary_connector.version,'barrierVersion',barrier.version) proof
FROM input JOIN staff_users actor ON actor.id=json_extract(v,'$.actor.id') AND actor.status='active'
 AND actor.email=json_extract(v,'$.actor.email') AND actor.access_subject IS json_extract(v,'$.actor.accessSubject')
 AND actor.project_alpha_user_id IS json_extract(v,'$.actor.projectAlphaUserId')
JOIN pa_projects p ON p.id=json_extract(v,'$.projectId') AND p.projection_source_id=json_extract(v,'$.sourceId') AND p.active=1
JOIN pa_projection_record_ids map ON map.local_id=p.id AND map.record_kind='project' AND map.projection_source_id=p.projection_source_id
JOIN pa_connectors connector ON connector.source_id=p.projection_source_id AND connector.profile='business_data'
 AND (json_extract(v,'$.action')<>'create' OR connector.state='active')
JOIN pa_connectors primary_connector ON primary_connector.source_id='project-alpha:primary'
 AND (json_extract(v,'$.action')<>'create' OR primary_connector.state='active')
JOIN pa_connector_portal_sources enrolled ON enrolled.source_id=connector.source_id
JOIN pa_connector_portal_coordination barrier ON barrier.id='portal' AND (json_extract(v,'$.action')<>'create' OR barrier.token IS NULL)
JOIN folder JOIN divisions division ON division.id=folder.division_id AND division.active=1
LEFT JOIN pa_clients client ON client.id=p.client_id AND client.projection_source_id=p.projection_source_id AND client.active=1
LEFT JOIN pa_organizations organization ON organization.id=COALESCE(p.organization_id,client.organization_id)
 AND organization.projection_source_id=p.projection_source_id AND organization.active=1
WHERE p.projection_source_id<>'project-alpha:primary' AND ${projectAlphaReadVisibleSql('p.projection_source_id')}
 AND (SELECT count(*) FROM folder)=1 AND ${projectPublic} IS NOT NULL
 AND ((COALESCE(p.organization_id,client.organization_id) IS NOT NULL AND ${organizationPublic} IS NOT NULL)
   OR (p.organization_id IS NULL AND client.organization_id IS NULL AND ${clientPublic} IS NOT NULL))
 AND (${permission('delivery.browse')}) AND (${permission('projects.view')})
 AND ((json_extract(v,'$.action')='create' AND (${permission('delivery.share.create')}))
   OR (json_extract(v,'$.action')='revoke' AND (${permission('delivery.share.revoke')}))
   OR (json_extract(v,'$.action')='audit' AND (${permission('delivery.share.audit')})))
 AND (EXISTS(SELECT 1 FROM staff_role_assignments a WHERE a.staff_id=actor.id AND a.role_id IN('role-admin','role-owner') AND a.scope='global')
   OR (EXISTS(SELECT 1 FROM staff_permission_overrides o WHERE o.staff_id=actor.id AND o.permission_key='operations.view_all'
       AND o.effect='allow' AND o.scope='global')
     AND EXISTS(SELECT 1 FROM permissions_now permission WHERE permission.permission_key='projects.view' AND permission.effect='allow' AND permission.scope='global')))
 AND NOT EXISTS(SELECT 1 FROM permissions_now permission WHERE permission.permission_key='operations.view_all' AND permission.effect='deny' AND permission.scope='global')`;

// The exact Client scope query is reused inside the publication transaction.
// Only fixed internal expressions replace its five bound parameter positions;
// no browser input can become SQL. Validation and captured rows come from the
// same Client helper read, including ambiguity/cycle/retention/feature gates.
const scopeExpressions=["json_extract((SELECT v FROM input),'$.scopeTargets')","json_extract((SELECT v FROM input),'$.workspaceId')",
  "json_extract((SELECT v FROM input),'$.generationId')","json_extract((SELECT v FROM input),'$.relations')",'66'];
const scopeQuery=NATIVE_PORTAL_TARGET_SCOPES_SQL.replace(/\?([1-5])\b/g,(_,n:string)=>scopeExpressions[Number(n)-1]!);
const scopeProofSql=`SELECT json_group_array(json_array(target_type,target_id,entity_type,public_id,parent_public_id,source_version,
  depth,display_name,binding_version,retained)) FROM (${scopeQuery})`;
// Native principals are exact verified identity bindings. No business contact,
// matching email, audience group or folder prefix creates a recipient.
const deliveryProofSql=(env:Pick<Env,'CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED'>)=>`WITH input AS(SELECT json(?) v), current_entitlements AS(
 SELECT entitlement.* FROM input JOIN portal_v2_entitlements entitlement
 ON entitlement.workspace_id=json_extract(v,'$.workspaceId') AND entitlement.capability IN ('workspace.view','directory.read','delivery.view')
 AND entitlement.status='active' AND entitlement.revoked_at IS NULL AND datetime(entitlement.valid_from)<=datetime('now')
 AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
 AND ${projectAccessCapacitySql('entitlement',true)}
), lineage(entity_type,public_id) AS(
 SELECT json_extract(value,'$.entity_type'),json_extract(value,'$.public_id') FROM input,json_each(v,'$.scopeRows')
), applicable AS(SELECT entitlement.* FROM input JOIN portal_v2_entitlements entitlement
 ON entitlement.workspace_id=json_extract(v,'$.workspaceId') AND entitlement.capability='delivery.view' AND entitlement.status='active'
 AND entitlement.revoked_at IS NULL AND datetime(entitlement.valid_from)<=datetime('now')
 AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))
 AND (entitlement.effect='deny' OR ${projectAccessTermsSql({termsId:'entitlement.access_terms_id',workspaceId:'entitlement.workspace_id',projectId:"json_extract(v,'$.projectPublicId')",legacyRetained:'1'})})
 WHERE (entitlement.scope_type='workspace' AND entitlement.scope_public_id=json_extract(v,'$.workspaceId'))
 OR EXISTS(SELECT 1 FROM lineage WHERE entity_type=entitlement.scope_type AND public_id=entitlement.scope_public_id)
 OR (entitlement.scope_type='folder' AND entitlement.scope_public_id=json_extract(v,'$.bindingId')))
SELECT json_object('workspaceName',w.display_name,'workspaceRoot',COALESCE(w.pa_organization_public_id,w.pa_client_public_id),
 'sourceId',w.project_alpha_source_id,'sourceWorkspaceId',mapping.source_workspace_id,'generationId',generation.id,
 'sequence',cp.source_sequence,'ownerVersion',owner.source_version,'ownerName',owner.display_name,'scopeDigest',json_extract(v,'$.scopeDigest'),
 'principalVersion',recipient.source_version,'identityId',identity.id,'issuer',identity.issuer,'subject',identity.subject,
 'recipientName',recipient.display_name,'recipientEmail',identity.verified_email,'membershipId',membership.id,
 'membershipVersion',membership.source_version,'membershipExpiry',membership.expires_at,
 'authorityRevision',authority.active_revision,'authorityVersion',authority.version,
 'connectorRevision',authority.connector_revision,'connectorVersion',authority.connector_version,
 'accessLifecycle',(SELECT json_object('status',lifecycle.lifecycle_status,'completedAt',lifecycle.completed_at,
   'sourceVersion',lifecycle.source_version,'generation',lifecycle.generation_id,'sequence',lifecycle.source_sequence)
   FROM portal_project_access_current_lifecycle lifecycle WHERE lifecycle.workspace_id=w.id
     AND lifecycle.project_public_id=owner.public_id AND lifecycle.source_id=w.project_alpha_source_id)) proof
FROM input JOIN portal_v2_workspaces w ON w.id=json_extract(v,'$.workspaceId') AND w.status='active' AND w.legacy_account_id IS NULL
 AND w.project_alpha_source_id=json_extract(v,'$.sourceId') AND w.root_type=json_extract(v,'$.rootType')
 AND COALESCE(w.pa_organization_public_id,w.pa_client_public_id)=json_extract(v,'$.rootPublicId')
JOIN pa_portal_workspace_sources mapping ON mapping.workspace_id=w.id AND mapping.projection_source_id=w.project_alpha_source_id
JOIN pa_portal_source_authorities authority ON authority.source_id=w.project_alpha_source_id AND authority.state='active'
 AND authority.connector_revision=json_extract(v,'$.connectorRevision') AND authority.producer_binding_id=json_extract(v,'$.producerBindingId')
JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id AND revision.revision=authority.active_revision
JOIN portal_v2_directory_checkpoints cp ON cp.workspace_id=w.id
JOIN portal_v2_directory_generations generation ON generation.id=cp.active_generation_id AND generation.workspace_id=w.id AND generation.status='active' AND generation.complete=1
JOIN portal_v2_directory_entities owner ON owner.workspace_id=w.id AND owner.generation_id=generation.id AND owner.entity_type='project'
 AND owner.public_id=json_extract(v,'$.projectPublicId') AND owner.active=1
JOIN pa_portal_principals recipient ON recipient.workspace_id=w.id AND recipient.public_id=json_extract(v,'$.principalPublicId') AND recipient.status='active'
JOIN portal_v2_identities identity ON identity.id=recipient.identity_id AND identity.status='active' AND identity.revoked_at IS NULL
JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=w.id AND membership.identity_id=identity.id
 AND membership.status='active' AND membership.revoked_at IS NULL AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
 AND (membership.source_type<>'project_alpha' OR (membership.source_version=recipient.source_version
   AND lower(recipient.email_hint)=lower(identity.verified_email)))
WHERE (generation.id=json_extract(v,'$.generationId') AND (${scopeProofSql})=json_extract(v,'$.scopeProof')
 AND ${portalRootAccessAllowedSql(env, 'w')}
 AND (SELECT count(*) FROM lineage)<=64
 AND EXISTS(SELECT 1 FROM lineage WHERE entity_type=w.root_type AND public_id=COALESCE(w.pa_organization_public_id,w.pa_client_public_id)))
 AND (EXISTS(SELECT 1 FROM applicable WHERE identity_id=identity.id AND effect='allow')
 AND NOT EXISTS(SELECT 1 FROM applicable WHERE identity_id=identity.id AND effect='deny')
 AND (SELECT count(*) FROM current_entitlements WHERE identity_id=identity.id)<=200)
 AND (NOT EXISTS(SELECT 1 FROM current_entitlements WHERE identity_id=identity.id AND capability='workspace.view'
   AND effect='deny' AND scope_type='workspace' AND scope_public_id=w.id)
 AND (EXISTS(SELECT 1 FROM current_entitlements WHERE identity_id=identity.id AND capability='workspace.view'
   AND effect='allow' AND scope_type='workspace' AND scope_public_id=w.id
   AND ${projectAccessTermsSql({termsId:'current_entitlements.access_terms_id',workspaceId:'current_entitlements.workspace_id',
     projectId:'(SELECT project_public_id FROM portal_project_access_terms shell_terms WHERE shell_terms.id=current_entitlements.access_terms_id)',legacyRetained:'1'})})
   OR EXISTS(${eligiblePortalShellQuery(false,'w.id','membership.identity_id')})))
 AND ((SELECT count(*) FROM pa_portal_principals p LEFT JOIN portal_v2_identity_eligibility_bindings eligibility
   ON eligibility.workspace_id=p.workspace_id AND eligibility.principal_public_id=p.public_id AND eligibility.identity_id=identity.id
   WHERE p.workspace_id=w.id AND p.status='active' AND (p.identity_id=identity.id OR eligibility.identity_id=identity.id))<=200
 AND (json_extract(v,'$.denylist')<>1 OR (SELECT count(*) FROM portal_v2_identity_denials denial
   WHERE denial.identity_id=identity.id AND denial.status='active' AND denial.revoked_at IS NULL
     AND datetime(denial.valid_from)<=datetime('now') AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
     AND (denial.scope_type='global' OR denial.workspace_id=w.id))<=200))
 AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_blocks block WHERE block.status='active'
   AND datetime(block.valid_from)<=datetime('now') AND (block.expires_at IS NULL OR datetime(block.expires_at)>datetime('now'))
   AND ((block.match_type='issuer_subject' AND block.issuer=identity.issuer AND block.subject=identity.subject)
     OR (block.match_type='email' AND block.normalized_email=lower(identity.verified_email))))
 AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials denial WHERE json_extract(v,'$.denylist')=1
   AND denial.identity_id=identity.id AND denial.status='active' AND denial.revoked_at IS NULL AND datetime(denial.valid_from)<=datetime('now')
   AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now')) AND (denial.scope_type='global' OR (denial.workspace_id=w.id AND
     ((denial.scope_type='workspace' AND denial.scope_public_id=w.id) OR (denial.scope_type='folder' AND denial.scope_public_id=json_extract(v,'$.bindingId'))
       OR EXISTS(SELECT 1 FROM lineage WHERE entity_type=denial.scope_type AND public_id=denial.scope_public_id)))))
 AND NOT EXISTS(SELECT 1 FROM delivery_tombstones tombstone WHERE tombstone.restored_at IS NULL
   AND (rtrim(tombstone.physical_key,'/')||'/'=json_extract(v,'$.prefix') OR (tombstone.tombstone_kind='prefix'
     AND substr(json_extract(v,'$.prefix'),1,length(tombstone.physical_key))=tombstone.physical_key)))`;

function ancestors(prefix:string):string[]{const parts=prefix.slice(0,-1).split('/');return parts.map((_,index)=>parts.slice(0,index+1).join('/')+'/');}
async function opsProof(env:Env,principal:StaffPrincipal,prefix:string,sourceId:string,projectId:string,action:'create'|'revoke'|'audit'){
  const input=JSON.stringify({actor:principal,ancestors:ancestors(prefix),sourceId,projectId,action});
  const json=await primary(env.OPS_DB).prepare(OPS_PROOF_SQL).bind(input).first<string>('proof');
  if(!json)return error(404,'native_delivery_target_unavailable');return {input,json,value:JSON.parse(json) as OpsProof};
}
async function deliveryInput(env:Env,operation:NativeDeliveryGrantInput,prefix:string,ops:OpsProof,bindingId:string,candidateOnly=false){
  const generationId=await primary(env.DELIVERY_DB).prepare(`SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=?`)
    .bind(operation.workspaceId).first<string>('active_generation_id');if(!generationId)return error(404,'native_delivery_target_unavailable');
  const targets=[{scopeType:'project' as const,publicId:ops.projectPublicId}];
  const scopes=await readNativeTargetScopes(env,{workspaceId:operation.workspaceId,generationId,rootType:ops.rootType,rootPublicId:ops.rootPublicId},targets,
    operation.accessTerms||candidateOnly?{retention:'structural'}:undefined);
  const selected=scopes.get(`project:${ops.projectPublicId}`);if(!selected)return error(404,'native_delivery_target_unavailable');
  const rows=selected.proofRows,scopeProof=JSON.stringify(rows.map(row=>[row.target_type,row.target_id,row.entity_type,row.public_id,row.parent_public_id,
    row.source_version,row.depth,row.display_name,row.binding_version,row.retained]));
  return JSON.stringify({...ops,workspaceId:operation.workspaceId,principalPublicId:operation.principalPublicId,prefix,bindingId,generationId,
    scopeTargets:targets,scopeRows:rows,scopeProof,scopeDigest:await digest(scopeProof),relations:env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED==='true'?1:0,
    denylist:env.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED==='true'?1:0});
}
async function assertOps(env:Env,prepared:Pick<Prepared,'opsInput'|'opsJson'>){
  if(await primary(env.OPS_DB).prepare(OPS_PROOF_SQL).bind(prepared.opsInput).first<string>('proof')!==prepared.opsJson)return changed();
}
async function assertDelivery(env:Env,prepared:Pick<Prepared,'deliveryInput'|'deliveryJson'|'deliverySql'>){
  if(await primary(env.DELIVERY_DB).prepare(prepared.deliverySql).bind(prepared.deliveryInput).first<string>('proof')!==prepared.deliveryJson)return changed();
}
async function binding(env:Env,workspaceId:string,prefix:string){return primary(env.DELIVERY_DB).prepare(`SELECT b.id,b.owner_public_id,b.source_version,b.status,
  b.revoked_at,n.project_id,n.source_id,n.division_id FROM portal_v2_folder_bindings b LEFT JOIN portal_native_staff_bindings n ON n.binding_id=b.id
  WHERE b.workspace_id=? AND b.r2_prefix=?`).bind(workspaceId,prefix).first<{id:string;owner_public_id:string;source_version:string|null;
    status:string;revoked_at:string|null;project_id:string|null;source_id:string|null;division_id:string|null}>();}
async function prepare(env:Env,principal:StaffPrincipal,operation:NativeDeliveryGrantInput,action:'create'|'revoke'|'audit'='create',candidateOnly=false):Promise<Prepared>{
  await ready(env);const prefix=normalizePrefix(await authorizeItem(env,principal,operation.folderRef));
  if(prefix.length>1000||ancestors(prefix).length>64)return error(400,'native_delivery_folder_invalid');
  const ops=await opsProof(env,principal,prefix,operation.sourceId,operation.projectId,action);
  const existing=await binding(env,operation.workspaceId,prefix);
  if(existing&&(existing.project_id!==operation.projectId||existing.source_id!==operation.sourceId
    ||existing.owner_public_id!==ops.value.projectPublicId||existing.division_id!==ops.value.divisionId
    ||existing.status!=='active'||existing.revoked_at!==null))return error(409,'native_delivery_binding_conflict');
  const bindingId=existing?.id??`native-binding-${await digest([operation.workspaceId,prefix])}`;
  const input=await deliveryInput(env,operation,prefix,ops.value,bindingId,candidateOnly);
  const proofSql=deliveryProofSql(env);
  const json=await primary(env.DELIVERY_DB).prepare(proofSql).bind(input).first<string>('proof');
  if(!json)return error(404,'native_delivery_recipient_unavailable');const current=JSON.parse(json) as DeliveryProof;
  const accessTermsView=operation.accessTerms?(await prepareProjectAccessTerms(primary(env.DELIVERY_DB),
    {sourceId:operation.sourceId,workspaceId:operation.workspaceId,projectPublicId:ops.value.projectPublicId},operation.accessTerms,
    {type:'staff',id:principal.id})).view:null;
  if(existing&&existing.source_version!==current.ownerVersion)return error(409,'native_delivery_binding_changed');
  const result={operation,prefix,bindingId,opsInput:ops.input,opsJson:ops.json,ops:ops.value,deliveryInput:input,deliveryJson:json,deliverySql:proofSql,delivery:current,
    accessTermsView,projectEndSupported:current.accessLifecycle!==null,contextVersion:await digest([operation,ops.json,json])};
  await assertOps(env,result);await assertDelivery(env,result);return result;
}
export async function previewNativeDeliveryGrant(env:Env,principal:StaffPrincipal,value:unknown):Promise<NativeDeliveryGrantPreview>{
  const p=await prepare(env,principal,parse(value));return {operation:p.operation,contextVersion:p.contextVersion,sourceName:display(p.ops.sourceName),
    workspaceName:display(p.delivery.workspaceName),projectName:display(p.ops.projectName),recipientName:display(p.delivery.recipientName),
    recipientEmail:p.delivery.recipientEmail,folderName:display(p.prefix.slice(0,-1).split('/').pop()!),expiresAt:p.operation.expiresAt,
    accessTerms:p.operation.accessTerms??null,effectiveAccessExpiresAt:p.accessTermsView?.effectiveExpiresAt??p.operation.expiresAt,
    projectEndSupported:p.projectEndSupported===true};
}

async function authorization(env:Env,principal:StaffPrincipal,key:string){return primary(env.OPS_DB).prepare(
  'SELECT * FROM native_delivery_authorizations WHERE actor_id=? AND idempotency_key=?').bind(principal.id,key).first<Authorization>();}
function deliveryFence(db:Database,id:string,p:Prepared,extra='1',values:(string|number|null)[]=[]){
  // Keep the full proof in this write transaction, but outside the scalar CASE
  // expression. Inlining its hierarchy and lifetime checks inside VALUES can
  // exceed D1's expression depth even though the standalone proof is valid.
  // The aggregate emits a failing guard for a missing proof, never zero writes.
  return db.prepare(`WITH current_proof AS MATERIALIZED (${p.deliverySql})
    INSERT INTO portal_native_staff_write_fences(id,write_guard)
    SELECT ?,CASE WHEN count(*)=1 AND max(proof)=? AND (${extra}) THEN 1 ELSE 0 END FROM current_proof WHERE 1
    ON CONFLICT(id) DO UPDATE SET write_guard=excluded.write_guard`).bind(p.deliveryInput,id,p.deliveryJson,...values);
}
async function reserve(env:Env,principal:StaffPrincipal,p:Prepared,key:string,action:'create'|'revoke',fingerprint:string,grantId:string,bindingId:string):Promise<Authorization>{
  const db=primary(env.OPS_DB),id=crypto.randomUUID(),deadline=new Date(Date.now()+120_000).toISOString();
  try {await db.batch([db.prepare(`INSERT INTO native_delivery_authorizations(id,actor_id,idempotency_key,action,fingerprint,source_id,workspace_id,
    project_id,grant_id,binding_id,operation_json,ops_proof_json,delivery_proof_json,publication_deadline,write_guard)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN (${OPS_PROOF_SQL})=? THEN 1 ELSE 0 END)`).bind(id,principal.id,key,action,fingerprint,p.operation.sourceId,
      p.operation.workspaceId,p.operation.projectId,grantId,bindingId,JSON.stringify(p.operation),p.opsJson,p.deliveryJson,deadline,p.opsInput,p.opsJson)]);
  } catch(cause){const winner=await authorization(env,principal,key);if(winner){if(winner.fingerprint!==fingerprint)return error(409,'native_delivery_idempotency_conflict');return winner;}
    if(cause instanceof Error&&/native_delivery_authorization_guard/.test(cause.message))return changed();throw cause;}
  return (await authorization(env,principal,key))!;
}
async function stored(env:Env,id:string){return primary(env.DELIVERY_DB).prepare(`SELECT g.*,n.source_id,n.project_id,n.project_public_id,n.r2_prefix,n.division_id,
  terms.kind access_kind,terms.mode access_mode,terms.expires_at access_expires_at,
  ${projectAccessTermsExpirySql('g.access_terms_id')} effective_access_expires_at,
  publication.state,publication.authorization_id,publication.fingerprint FROM portal_v2_authenticated_delivery_grants g
  JOIN portal_native_staff_grants publication ON publication.grant_id=g.id
  JOIN portal_native_staff_bindings n ON n.binding_id=publication.binding_id AND n.source_id=publication.source_id
  LEFT JOIN portal_project_access_terms terms ON terms.id=g.access_terms_id
  WHERE g.id=?`).bind(id).first<StoredGrant>();}
const HISTORY_PROOF_SQL=`WITH input AS(SELECT json(?) v)
 SELECT json_object('grant',g.id,'version',g.grant_version,'workspace',g.workspace_id,'binding',b.id,'prefix',b.r2_prefix,
   'source',n.source_id,'project',n.project_id,'publicId',n.project_public_id,'division',n.division_id,
   'audience',g.audience_public_id,'audienceVersion',g.audience_source_version,'bindingVersion',g.binding_source_version,
   'authorization',publication.authorization_id,'recipientIdentity',recipient.identity_id,'accessTermsId',g.access_terms_id) proof
 FROM input JOIN portal_native_staff_grants publication ON publication.grant_id=json_extract(v,'$.id')
 JOIN portal_v2_authenticated_delivery_grants g ON g.id=publication.grant_id
 JOIN portal_native_staff_bindings n ON n.binding_id=publication.binding_id AND n.source_id=publication.source_id
 JOIN portal_v2_folder_bindings b ON b.id=n.binding_id AND b.workspace_id=n.workspace_id
 JOIN portal_v2_workspaces w ON w.id=n.workspace_id AND w.project_alpha_source_id=n.source_id AND w.legacy_account_id IS NULL
 JOIN pa_portal_workspace_sources map ON map.workspace_id=w.id AND map.projection_source_id=n.source_id
 JOIN portal_v2_authenticated_delivery_grant_recipients recipient ON recipient.grant_id=g.id AND recipient.workspace_id=w.id
   AND recipient.principal_public_id=g.audience_public_id AND recipient.principal_source_version=g.audience_source_version
 WHERE n.source_id=json_extract(v,'$.sourceId') AND n.project_id=json_extract(v,'$.projectId')
   AND n.project_public_id=json_extract(v,'$.projectPublicId') AND n.division_id=json_extract(v,'$.divisionId')
   AND n.r2_prefix=json_extract(v,'$.prefix') AND b.r2_prefix=n.r2_prefix AND b.owner_scope_type='project'
   AND b.owner_public_id=n.project_public_id AND g.folder_binding_id=b.id AND g.workspace_id=w.id AND g.audience_type='principal'`;
async function historyPrepared(env:Env,principal:StaffPrincipal,row:StoredGrant,folderRef:string,action:'audit'|'revoke',knownPrefix?:string,verify=true):Promise<Prepared>{
  const prefix=knownPrefix??normalizePrefix(await authorizeItem(env,principal,folderRef));if(prefix!==row.r2_prefix)return error(404,'native_delivery_not_found');
  const original=await primary(env.OPS_DB).prepare('SELECT * FROM native_delivery_authorizations WHERE id=? AND action=\'create\'')
    .bind(row.authorization_id).first<Authorization>();if(!original)return unavailable();
  const operation={...JSON.parse(original.operation_json) as NativeDeliveryGrantInput,folderRef};
  const ops=await opsProof(env,principal,prefix,row.source_id,row.project_id,action);
  const input=JSON.stringify({id:row.id,sourceId:row.source_id,projectId:row.project_id,projectPublicId:ops.value.projectPublicId,divisionId:ops.value.divisionId,prefix});
  const json=await primary(env.DELIVERY_DB).prepare(HISTORY_PROOF_SQL).bind(input).first<string>('proof');if(!json)return error(404,'native_delivery_not_found');
  const p={operation,prefix,bindingId:row.folder_binding_id,opsInput:ops.input,opsJson:ops.json,ops:ops.value,
    deliveryInput:input,deliveryJson:json,deliverySql:HISTORY_PROOF_SQL,delivery:JSON.parse(original.delivery_proof_json) as DeliveryProof,
    contextVersion:await digest([ops.json,json])};
  if(verify){await assertOps(env,p);await assertDelivery(env,p);}return p;
}
function event(db:Database,id:string,receipt:string,action:string,actor:string){return db.prepare(`INSERT INTO portal_native_staff_grant_events(id,grant_id,authorization_id,action,actor_id)
  SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM portal_native_staff_grant_events WHERE authorization_id=? AND action=?)`)
  .bind(crypto.randomUUID(),id,receipt,action,actor,receipt,action);}
async function suspend(env:Env,auth:Authorization){const db=primary(env.DELIVERY_DB),historyReady=await projectAccessAuthorityHistoryReady(db),
  published=Boolean(await db.prepare(`SELECT 1 ok FROM portal_native_staff_grant_events WHERE grant_id=? AND authorization_id=? AND action='published'`)
    .bind(auth.grant_id,auth.id).first('ok'));try{await db.batch([
  db.prepare(`UPDATE portal_native_staff_grants SET state='suspended',updated_at=datetime('now') WHERE grant_id=? AND authorization_id=? AND state IN('pending','active')`).bind(auth.grant_id,auth.id),
  db.prepare(`UPDATE portal_v2_authenticated_delivery_grants SET status='revoked',revoked_at=datetime('now'),revoked_by_staff_id=?,
    revoke_reason_code='publication_uncertain',updated_at=datetime('now') WHERE id=? AND status='active'
    AND EXISTS(SELECT 1 FROM portal_native_staff_grants WHERE grant_id=? AND authorization_id=? AND state='suspended')`)
    .bind(auth.actor_id,auth.grant_id,auth.grant_id,auth.id),
  db.prepare(`INSERT INTO portal_native_staff_grant_events(id,grant_id,authorization_id,action,actor_id)
    SELECT ?,grant_id,authorization_id,'suspended',? FROM portal_native_staff_grants WHERE grant_id=? AND authorization_id=? AND state='suspended'
      AND NOT EXISTS(SELECT 1 FROM portal_native_staff_grant_events WHERE authorization_id=? AND action='suspended')`)
    .bind(crypto.randomUUID(),auth.actor_id,auth.grant_id,auth.id,auth.id),
  ...(historyReady&&published?[projectAccessGrantEvent(db,{grantId:auth.grant_id,eventKind:'grant_revoked',
    producerEventKey:`native-grant-event:${auth.id}:suspended`,actor:{type:'staff',id:auth.actor_id},
    requiredNativeEvent:{authorizationId:auth.id,action:'suspended',requirePublished:true}})]:[])]);}catch(cause){
  const terminal=await db.prepare(`SELECT publication.state,grant_record.status FROM portal_native_staff_grants publication
    JOIN portal_v2_authenticated_delivery_grants grant_record ON grant_record.id=publication.grant_id
    WHERE publication.grant_id=? AND publication.authorization_id=?`).bind(auth.grant_id,auth.id)
    .first<{state:string;status:string}>();
  if(terminal&&(terminal.state==='revoked'||terminal.state==='suspended')&&terminal.status==='revoked')return;
  throw cause;
}}
function view(row:StoredGrant,p:Prepared,canRevoke:boolean):NativeDeliveryGrantView{return {id:row.id,grantId:row.logical_grant_id,version:row.grant_version,
  sourceId:row.source_id,sourceName:display(p.ops.sourceName),workspaceId:row.workspace_id,workspaceName:display(p.delivery.workspaceName),projectId:row.project_id,
  projectName:display(p.ops.projectName),principalPublicId:row.audience_public_id,recipientName:display(p.delivery.recipientName),recipientEmail:p.delivery.recipientEmail,
  status:row.state==='suspended'||row.state==='revoked'?'revoked':row.status==='active'&&[row.expires_at,row.effective_access_expires_at]
    .some(expiry=>expiry!==null&&Date.parse(utc(expiry))<=Date.now())?'expired':row.status,
  expiresAt:row.expires_at,createdAt:utc(row.created_at),publicationState:row.state as NativeDeliveryGrantView['publicationState'],
  accessTerms:row.access_kind&&row.access_mode?{kind:row.access_kind,mode:row.access_mode,expiresAt:row.access_expires_at}:null,
  effectiveAccessExpiresAt:row.effective_access_expires_at?utc(row.effective_access_expires_at):row.expires_at,
  canRevoke:canRevoke&&(row.state==='active'||row.state==='pending')&&row.status==='active'};}
async function mayRevoke(env:Env,principal:StaffPrincipal,p:Prepared):Promise<boolean>{try{await opsProof(env,principal,p.prefix,p.operation.sourceId,p.operation.projectId,'revoke');return true;}
  catch(cause){if(cause instanceof HTTPException&&cause.status===404)return false;throw cause;}}

export async function createNativeDeliveryGrant(env:Env,principal:StaffPrincipal,value:unknown,keyValue:string):Promise<{grant:NativeDeliveryGrantView;replayed:boolean}>{
  requireProjectAccessAuthorityMutations(env);
  requireAuthenticatedDeliveryCreation(env);
  const schema=selectionSchema.extend({expectedContextVersion:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),parsed=schema.safeParse(value);
  if(!parsed.success)return error(400,'native_delivery_invalid');const {expectedContextVersion,...raw}=parsed.data;
  const operation=parse(raw),key=idempotency(keyValue),fingerprint=await digest(['create',operation,expectedContextVersion]);
  await ready(env);const previous=await authorization(env,principal,key);
  if(previous&&previous.fingerprint!==fingerprint)return error(409,'native_delivery_idempotency_conflict');
  const p=await prepare(env,principal,operation);if(p.contextVersion!==expectedContextVersion)return changed();
  const existing=await binding(env,operation.workspaceId,p.prefix);
  const auth=previous??await reserve(env,principal,p,key,'create',fingerprint,crypto.randomUUID(),p.bindingId);
  if(auth.ops_proof_json!==p.opsJson||auth.delivery_proof_json!==p.deliveryJson)return changed();
  let row=await stored(env,auth.grant_id);
  if(row?.state==='active') {await assertOps(env,p);await assertDelivery(env,p);
    if(view(row,p,false).status!=='active')return changed();
    return {grant:view(row,p,await mayRevoke(env,principal,p)),replayed:true};}
  if(row&&row.state!=='pending')return error(409,'native_delivery_reconciliation_required');
  if(Date.parse(auth.publication_deadline)<=Date.now())return error(409,'native_delivery_reconciliation_required');
  const db=primary(env.DELIVERY_DB);
  try {
    if(!row) {
      const statements=[deliveryFence(db,auth.id,p,"datetime(?)>datetime('now')",[auth.publication_deadline])];
      if(!existing){statements.push(db.prepare(`INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version,status)
        VALUES(?,?,'project',?,?,'operations',?,'active')`).bind(auth.binding_id,operation.workspaceId,p.ops.projectPublicId,p.prefix,p.delivery.ownerVersion),
        db.prepare(`INSERT INTO portal_native_staff_bindings(binding_id,source_id,workspace_id,project_id,project_public_id,r2_prefix,division_id)
          VALUES(?,?,?,?,?,?,?)`).bind(auth.binding_id,operation.sourceId,operation.workspaceId,operation.projectId,p.ops.projectPublicId,p.prefix,p.ops.divisionId));}
      else if(existing.id!==auth.binding_id)return changed();
      const accessTerms=operation.accessTerms?await prepareProjectAccessTerms(db,
        {sourceId:operation.sourceId,workspaceId:operation.workspaceId,projectPublicId:p.ops.projectPublicId},operation.accessTerms,
        {type:'staff',id:principal.id},`project-access-${auth.grant_id}`):null;
      if(accessTerms)statements.push(accessTerms.statement);
      statements.push(db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants(id,logical_grant_id,grant_version,workspace_id,folder_binding_id,binding_source_version,
        audience_type,audience_public_id,audience_source_version,reason_code,expires_at,created_by_staff_id,access_terms_id) VALUES(?,?,1,?,?,?,'principal',?,?,?,?,?,?)`)
        .bind(auth.grant_id,auth.grant_id,operation.workspaceId,auth.binding_id,p.delivery.ownerVersion,operation.principalPublicId,p.delivery.principalVersion,
          operation.reasonCode,operation.expiresAt,principal.id,accessTerms?.id??null),
        db.prepare(`INSERT INTO portal_v2_authenticated_delivery_grant_recipients(grant_id,workspace_id,principal_public_id,identity_id,principal_source_version) VALUES(?,?,?,?,?)`)
          .bind(auth.grant_id,operation.workspaceId,operation.principalPublicId,p.delivery.identityId,p.delivery.principalVersion),
        db.prepare(`INSERT INTO portal_native_staff_grants(grant_id,binding_id,source_id,authorization_id,actor_id,idempotency_key,fingerprint,state,publication_deadline)
          VALUES(?,?,?,?,?,?,?,'pending',?)`).bind(auth.grant_id,auth.binding_id,operation.sourceId,auth.id,principal.id,key,fingerprint,auth.publication_deadline),
        event(db,auth.grant_id,auth.id,'staged',principal.id));
      try{await db.batch(statements);}catch(cause){const winner=await stored(env,auth.grant_id);if(!winner||winner.authorization_id!==auth.id)throw cause;}
    }
    await assertOps(env,p);
    const historyReady=await projectAccessAuthorityHistoryReady(db);
    await db.batch([deliveryFence(db,auth.id,p,`EXISTS(SELECT 1 FROM portal_native_staff_grants publication
      JOIN portal_v2_authenticated_delivery_grants grant_record ON grant_record.id=publication.grant_id
      JOIN portal_v2_folder_bindings binding ON binding.id=publication.binding_id
      WHERE publication.grant_id=? AND publication.authorization_id=? AND publication.state='pending'
        AND datetime(publication.publication_deadline)>datetime('now') AND grant_record.status='active'
        AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))
        AND ${projectAccessTermsSql({termsId:'grant_record.access_terms_id',workspaceId:'grant_record.workspace_id',projectId:'binding.owner_public_id',legacyRetained:'1'})}
        AND binding.status='active' AND binding.revoked_at IS NULL AND binding.source_version=?)`,[auth.grant_id,auth.id,p.delivery.ownerVersion]),
      db.prepare(`UPDATE portal_native_staff_grants SET state='active',updated_at=datetime('now') WHERE grant_id=? AND authorization_id=? AND state='pending'`).bind(auth.grant_id,auth.id),
      event(db,auth.grant_id,auth.id,'published',principal.id),
      ...(historyReady?[projectAccessGrantEvent(db,{grantId:auth.grant_id,eventKind:'grant_created',
        producerEventKey:`native-grant-event:${auth.id}:published`,actor:{type:'staff',id:principal.id},
        requiredNativeEvent:{authorizationId:auth.id,action:'published'}})]:[])]);
    await assertOps(env,p);await assertDelivery(env,p);
  } catch(cause) {
    const winner=await stored(env,auth.grant_id);
    if(winner?.state==='active'&&winner.authorization_id===auth.id){
      try {await assertOps(env,p);await assertDelivery(env,p);
        if(view(winner,p,false).status==='active')
          return {grant:view(winner,p,await mayRevoke(env,principal,p)),replayed:true};
      }catch{/* Failed current proof closes this authorization's gate below. */}
    }
    // The OPS receipt is the delegation linearization point. We do not claim
    // cross-D1 atomicity: uncertain publication closes the local read gate.
    await suspend(env,auth);
    if(cause instanceof HTTPException)throw cause;
    if(cause instanceof Error&&/portal_native_staff_write_guard|UNIQUE constraint|native-staff/.test(cause.message))return changed();throw cause;
  }
  row=await stored(env,auth.grant_id);if(!row||row.state!=='active')return changed();
  return {grant:view(row,p,await mayRevoke(env,principal,p)),replayed:Boolean(previous)};
}

export async function revokeNativeDeliveryGrant(env:Env,principal:StaffPrincipal,id:string,value:unknown,keyValue:string):Promise<{grant:NativeDeliveryGrantView;replayed:boolean}>{
  requireProjectAccessAuthorityMutations(env);
  const parsed=z.object({folderRef:selectionSchema.shape.folderRef,expectedVersion:z.number().int().positive(),reasonCode:selectionSchema.shape.reasonCode}).strict().safeParse(value);
  if(!parsed.success||!opaque.safeParse(id).success)return error(400,'native_delivery_invalid');
  await ready(env);const key=idempotency(keyValue),row=await stored(env,id);if(!row)return error(404,'native_delivery_not_found');
  if(row.grant_version!==parsed.data.expectedVersion)return changed();
  const p=await historyPrepared(env,principal,row,parsed.data.folderRef,'revoke');p.operation={...p.operation,reasonCode:parsed.data.reasonCode};
  const fingerprint=await digest(['revoke',id,parsed.data]);let auth=await authorization(env,principal,key);
  if(auth&&auth.fingerprint!==fingerprint)return error(409,'native_delivery_idempotency_conflict');
  if(auth&&row.status==='revoked'){await assertOps(env,p);await assertDelivery(env,p);return {grant:view(row,p,false),replayed:true};}
  if(row.status!=='active'||!['active','pending'].includes(row.state))return changed();
  auth??=await reserve(env,principal,p,key,'revoke',fingerprint,id,row.folder_binding_id);
  if(auth.ops_proof_json!==p.opsJson||auth.delivery_proof_json!==p.deliveryJson||Date.parse(auth.publication_deadline)<=Date.now())return changed();
  const db=primary(env.DELIVERY_DB),historyReady=await projectAccessAuthorityHistoryReady(primary(env.DELIVERY_DB));
  try {await assertOps(env,p);await db.batch([deliveryFence(db,auth.id,p,`EXISTS(SELECT 1 FROM portal_v2_authenticated_delivery_grants
      WHERE id=? AND grant_version=? AND status='active') AND datetime(?)>datetime('now')
      AND EXISTS(SELECT 1 FROM portal_native_staff_grants publication
        WHERE publication.grant_id=? AND publication.state=?
          AND ((?='pending' AND NOT EXISTS(SELECT 1 FROM portal_native_staff_grant_events published
              WHERE published.grant_id=publication.grant_id AND published.authorization_id=publication.authorization_id AND published.action='published'))
            OR (?='active' AND EXISTS(SELECT 1 FROM portal_native_staff_grant_events published
              WHERE published.grant_id=publication.grant_id AND published.authorization_id=publication.authorization_id AND published.action='published'))))`,
      [id,parsed.data.expectedVersion,auth.publication_deadline,id,row.state,row.state,row.state]),
    db.prepare(`UPDATE portal_v2_authenticated_delivery_grants SET status='revoked',revoked_at=datetime('now'),revoked_by_staff_id=?,
      revoke_reason_code=?,updated_at=datetime('now') WHERE id=? AND status='active'`).bind(principal.id,parsed.data.reasonCode,id),
    db.prepare(`UPDATE portal_native_staff_grants SET state='revoked',updated_at=datetime('now') WHERE grant_id=? AND state=?`).bind(id,row.state),
    event(db,id,auth.id,'revoked',principal.id),
    ...(historyReady&&row.state==='active'?[projectAccessGrantEvent(db,{grantId:id,eventKind:'grant_revoked',
      producerEventKey:`native-grant-event:${auth.id}:revoked`,actor:{type:'staff',id:principal.id},
      requiredNativeEvent:{authorizationId:auth.id,action:'revoked',requirePublished:true}})]:[])]);
    await assertOps(env,p);await assertDelivery(env,p);
  } catch(cause){const winner=await stored(env,id);if(winner?.status==='revoked'){
      await assertOps(env,p);await assertDelivery(env,p);return {grant:view(winner,p,false),replayed:true};}
    if(cause instanceof Error&&/portal_native_staff_write_guard/.test(cause.message))return changed();throw cause;}
  return {grant:view((await stored(env,id))!,p,false),replayed:false};
}

export async function listNativeDeliveryGrants(env:Env,principal:StaffPrincipal,folderRef:string):Promise<{grants:NativeDeliveryGrantView[]}>{
  await ready(env);await activeStaff(env,principal);const prefix=normalizePrefix(await authorizeItem(env,principal,folderRef));
  const rows=await primary(env.DELIVERY_DB).prepare(`SELECT publication.grant_id FROM portal_native_staff_bindings b
    JOIN portal_native_staff_grants publication ON publication.binding_id=b.binding_id WHERE b.r2_prefix=?
    ORDER BY publication.created_at DESC,publication.grant_id DESC LIMIT 101`).bind(prefix).all<{grant_id:string}>();
  if(rows.results.length>100)return error(409,'native_delivery_list_too_large');const grants:NativeDeliveryGrantView[]=[],proofs:Prepared[]=[];
  for(const candidate of rows.results){const row=(await stored(env,candidate.grant_id))!;
    try{const p=await historyPrepared(env,principal,row,folderRef,'audit',prefix,false);
      grants.push(view(row,p,await mayRevoke(env,principal,p)));proofs.push(p);}
    catch(cause){if(cause instanceof HTTPException&&[403,404,409].includes(cause.status))continue;throw cause;}}
  for(let i=0;i<proofs.length;i++){const p=proofs[i]!,old=grants[i]!;await assertOps(env,p);await assertDelivery(env,p);
    const current=await stored(env,old.id);if(!current||current.state!==old.publicationState)return changed();
    const updated=view(current,p,await mayRevoke(env,principal,p));if(updated.status!==old.status)return changed();grants[i]=updated;}
  await activeStaff(env,principal);
  return {grants};
}

export async function searchNativeDeliveryTargets(env:Env,principal:StaffPrincipal,folderRef:string,q:string){
  await ready(env);await activeStaff(env,principal);const prefix=normalizePrefix(await authorizeItem(env,principal,folderRef)),query=q.normalize('NFC').trim();
  if(query.length<2||query.length>100)return error(400,'native_delivery_query_invalid');
  const pattern='%'+query.replace(/[\\%_]/g,'\\$&')+'%';
  const candidates=await primary(env.OPS_DB).prepare(`SELECT p.id,p.projection_source_id FROM pa_projects p JOIN pa_connectors c ON c.source_id=p.projection_source_id
    WHERE p.active=1 AND c.profile='business_data' AND c.state='active' AND ${projectAlphaReadVisibleSql('p.projection_source_id')}
      AND (p.name LIKE ? ESCAPE '\\' OR c.display_name LIKE ? ESCAPE '\\') ORDER BY p.name COLLATE NOCASE,p.id LIMIT 101`)
    .bind(pattern,pattern).all<{id:string;projection_source_id:string}>();
  const targets:Array<{sourceId:string;sourceName:string;workspaceId:string;workspaceName:string;projectId:string;projectName:string;projectEndSupported:boolean}>=[],proofs:Array<{opsInput:string;opsJson:string}>=[];
  for(const candidate of candidates.results.slice(0,100)){let ops;try{ops=await opsProof(env,principal,prefix,candidate.projection_source_id,candidate.id,'create');}
    catch(cause){if(cause instanceof HTTPException&&cause.status===404)continue;throw cause;}
    const workspaces=await primary(env.DELIVERY_DB).prepare(`SELECT w.id,w.display_name,
      EXISTS(SELECT 1 FROM portal_project_access_current_lifecycle lifecycle WHERE lifecycle.workspace_id=w.id
        AND lifecycle.source_id=w.project_alpha_source_id AND lifecycle.project_public_id=e.public_id) project_end_supported
      FROM portal_v2_workspaces w
      JOIN pa_portal_source_authorities a ON a.source_id=w.project_alpha_source_id AND a.state='active' AND a.connector_revision=?
      JOIN pa_portal_workspace_sources m ON m.workspace_id=w.id AND m.projection_source_id=w.project_alpha_source_id
      JOIN portal_v2_directory_checkpoints cp ON cp.workspace_id=w.id
      JOIN portal_v2_directory_generations g ON g.id=cp.active_generation_id AND g.workspace_id=w.id AND g.status='active' AND g.complete=1
      JOIN portal_v2_directory_entities e ON e.workspace_id=w.id AND e.generation_id=g.id AND e.entity_type='project' AND e.public_id=? AND e.active=1
      WHERE w.project_alpha_source_id=? AND w.root_type=? AND COALESCE(w.pa_organization_public_id,w.pa_client_public_id)=?
        AND w.status='active' AND w.legacy_account_id IS NULL AND ${portalRootAccessAllowedSql(env, 'w')}
        ORDER BY w.id LIMIT 2`)
      .bind(ops.value.connectorRevision,ops.value.projectPublicId,candidate.projection_source_id,ops.value.rootType,ops.value.rootPublicId).all<{id:string;display_name:string;project_end_supported:number}>();
    if(workspaces.results.length!==1)continue;const w=workspaces.results[0]!;await assertOps(env,{opsInput:ops.input,opsJson:ops.json});
    targets.push({sourceId:candidate.projection_source_id,sourceName:display(ops.value.sourceName),workspaceId:w.id,workspaceName:display(w.display_name),projectId:candidate.id,projectName:display(ops.value.projectName),projectEndSupported:w.project_end_supported===1});
    proofs.push({opsInput:ops.input,opsJson:ops.json});
    if(targets.length===20)break;}
  for(const proof of proofs)await assertOps(env,proof);await activeStaff(env,principal);
  return {targets,truncated:targets.length===20||candidates.results.length>100};
}
export async function searchNativeDeliveryRecipients(env:Env,principal:StaffPrincipal,value:{folderRef:string;sourceId:string;workspaceId:string;projectId:string;q:string}){
  await ready(env);await activeStaff(env,principal);const query=value.q.normalize('NFC').trim();if(query.length<2||query.length>100)return error(400,'native_delivery_query_invalid');
  const prefix=normalizePrefix(await authorizeItem(env,principal,value.folderRef));
  await opsProof(env,principal,prefix,value.sourceId,value.projectId,'create');
  const pattern='%'+query.replace(/[\\%_]/g,'\\$&')+'%';const rows=await primary(env.DELIVERY_DB).prepare(`SELECT public_id FROM pa_portal_principals
    WHERE workspace_id=? AND status='active' AND identity_id IS NOT NULL AND (display_name LIKE ? ESCAPE '\\' OR email_hint LIKE ? ESCAPE '\\')
    ORDER BY display_name COLLATE NOCASE,public_id LIMIT 51`).bind(value.workspaceId,pattern,pattern).all<{public_id:string}>();
  const recipients:Array<{principalPublicId:string;displayName:string;email:string|null}>=[],proofs:Prepared[]=[];
  // Candidate discovery does not grant access or classify anyone. Retained
  // customer history must still be selectable for an explicit reviewed grant.
  for(const row of rows.results.slice(0,50)){try{const p=await prepare(env,principal,parse({folderRef:value.folderRef,sourceId:value.sourceId,workspaceId:value.workspaceId,
    projectId:value.projectId,principalPublicId:row.public_id,reasonCode:'staff_delivery',expiresAt:null}),'create',true);
    recipients.push({principalPublicId:row.public_id,displayName:display(p.delivery.recipientName),email:p.delivery.recipientEmail});proofs.push(p);if(recipients.length===20)break;
  }catch(cause){if(cause instanceof HTTPException&&[403,404,409].includes(cause.status))continue;throw cause;}}
  for(const proof of proofs){await assertOps(env,proof);await assertDelivery(env,proof);}await activeStaff(env,principal);
  return {recipients,truncated:recipients.length===20||rows.results.length>50};
}
