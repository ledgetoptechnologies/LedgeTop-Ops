import {HTTPException} from 'hono/http-exception';
import {NATIVE_PORTAL_TARGET_SCOPES_SQL,readNativeTargetScopes} from './native-portal-scopes';
import {projectAccessReadColumns,projectAccessRowAllows,type ProjectAccessReadRow} from './project-access-read';
import {projectAccessTermsExpirySql,type ProjectAccessTermsView} from './project-access-terms';
import {projectAccessCapacitySql} from './project-access-capacity';
import type {PortalAuthorizationEnv,PortalWorkspaceCapability,PortalWorkspaceTarget} from './workspace-v2';

const replacements=["json_extract((SELECT v FROM delegation_input),'$.targets')","json_extract((SELECT v FROM delegation_input),'$.workspaceId')",
  "(SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=json_extract((SELECT v FROM delegation_input),'$.workspaceId'))",
  "json_extract((SELECT v FROM delegation_input),'$.relations')",'66'];
const scopesSql=NATIVE_PORTAL_TARGET_SCOPES_SQL.replace(/\?([1-5])\b/g,(_,index:string)=>replacements[Number(index)-1]!);
const query=`WITH delegation_input AS(SELECT json(?) v)
 SELECT json_object(
 'identity',(SELECT json_object('id',id,'issuer',issuer,'subject',subject,'email',verified_email,'status',status,'revoked',revoked_at)
   FROM portal_v2_identities WHERE id=json_extract(v,'$.identityId')),
 'membership',(SELECT json_object('id',id,'status',status,'revoked',revoked_at,'expiresAt',expires_at,'source',source_type,'version',source_version,
   'live',CASE WHEN expires_at IS NULL OR datetime(expires_at)>datetime('now') THEN 1 ELSE 0 END)
   FROM portal_v2_workspace_memberships WHERE workspace_id=json_extract(v,'$.workspaceId') AND identity_id=json_extract(v,'$.identityId')),
 'workspace',(SELECT json_object('id',w.id,'source',w.project_alpha_source_id,'status',w.status,'rootType',w.root_type,
   'rootPublicId',COALESCE(w.pa_organization_public_id,w.pa_client_public_id),'generationId',cp.active_generation_id,'sequence',cp.source_sequence,
   'legacyAccount',w.legacy_account_id) FROM portal_v2_workspaces w JOIN portal_v2_directory_checkpoints cp ON cp.workspace_id=w.id
   WHERE w.id=json_extract(v,'$.workspaceId')),
 'scopeRows',(SELECT json_group_array(json_object('target_type',target_type,'target_id',target_id,'entity_type',entity_type,'public_id',public_id,
   'parent_public_id',parent_public_id,'source_version',source_version,'depth',depth,'display_name',display_name,'binding_version',binding_version,'retained',retained)) FROM (${scopesSql})),
 'entitlements',(SELECT json_group_array(json_object('id',id,'capability',capability,'effect',effect,'scope_type',scope_type,'scope_public_id',scope_public_id,
   'status',status,'revoked_at',revoked_at,'valid_from',valid_from,'expires_at',expires_at,'entitlement_version',entitlement_version,
   'access_terms_id',access_terms_id,'terms_project_id',terms_project_id,'terms_kind',terms_kind,'terms_mode',terms_mode,'terms_live',terms_live,'terms_expiry',terms_expiry,
   'live',CASE WHEN datetime(valid_from)<=datetime('now') AND (expires_at IS NULL OR datetime(expires_at)>datetime('now')) THEN 1 ELSE 0 END))
   FROM (SELECT e.id,e.capability,e.effect,e.scope_type,e.scope_public_id,e.status,e.revoked_at,e.valid_from,e.expires_at,e.entitlement_version,
     ${projectAccessReadColumns('e',true)},${projectAccessTermsExpirySql('e.access_terms_id')} terms_expiry,
     (SELECT mode FROM portal_project_access_terms WHERE id=e.access_terms_id) terms_mode
     FROM portal_v2_entitlements e WHERE e.workspace_id=json_extract(v,'$.workspaceId') AND e.identity_id=json_extract(v,'$.identityId')
       AND e.status='active' AND e.revoked_at IS NULL AND (e.expires_at IS NULL OR datetime(e.expires_at)>datetime('now'))
       AND ${projectAccessCapacitySql('e',true)}
       AND e.capability IN ('workspace.view','member.manage','delivery.view','request.create') ORDER BY e.id LIMIT 801)),
 'denials',(SELECT json_group_array(json_object('id',id,'scope',scope_type,'target',scope_public_id,'workspace',workspace_id,
   'status',status,'revoked',revoked_at,'validFrom',valid_from,'expiresAt',expires_at,
   'live',CASE WHEN status='active' AND revoked_at IS NULL AND datetime(valid_from)<=datetime('now')
     AND (expires_at IS NULL OR datetime(expires_at)>datetime('now')) THEN 1 ELSE 0 END)) FROM (SELECT * FROM portal_v2_identity_denials
   WHERE identity_id=json_extract(v,'$.identityId') AND status='active' AND revoked_at IS NULL
     AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
     AND (scope_type='global' OR workspace_id=json_extract(v,'$.workspaceId')) ORDER BY id LIMIT 201)),
 'blocks',(SELECT json_group_array(json_object('id',id,'status',status,'validFrom',valid_from,'expiresAt',expires_at,
   'live',CASE WHEN status='active' AND datetime(valid_from)<=datetime('now') AND (expires_at IS NULL OR datetime(expires_at)>datetime('now')) THEN 1 ELSE 0 END))
   FROM (SELECT * FROM portal_v2_identity_eligibility_blocks WHERE status='active'
     AND (expires_at IS NULL OR datetime(expires_at)>datetime('now'))
     AND ((match_type='issuer_subject' AND issuer=json_extract(v,'$.issuer') AND subject=json_extract(v,'$.subject'))
       OR (match_type='email' AND normalized_email=json_extract(v,'$.email'))) ORDER BY id LIMIT 201)),
 'policy',(SELECT json_object('policy',policy,'version',version) FROM portal_workspace_invitation_policies WHERE workspace_id=json_extract(v,'$.workspaceId'))
 ) proof FROM delegation_input`;
interface Entitlement extends ProjectAccessReadRow {id:string;capability:PortalWorkspaceCapability;effect:string;scope_type:string;scope_public_id:string;
 status:string;revoked_at:string|null;valid_from:string;expires_at:string|null;terms_expiry:string|null;terms_mode:string|null;live:number}
function timestamp(value:string):number{
  const parsed=Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)?`${value.replace(' ','T')}Z`:value);
  return Number.isFinite(parsed)?parsed:-Infinity;
}
function exceeds():never {throw new HTTPException(403,{message:'Requested access exceeds your delegation authority'});}
export async function captureProjectInvitationDelegation(env:PortalAuthorizationEnv,input:{workspaceId:string;projectId:string;identityId:string;issuer:string;subject:string;email:string},
  capabilities:PortalWorkspaceCapability[],terms:ProjectAccessTermsView){
  return captureWorkspaceInvitationDelegation(env,{...input,target:{scopeType:'project',publicId:input.projectId}},capabilities,terms);
}
/** Broad invitations have no access terms, so every delegated capability must
 * have an independent unlimited path. A finite project manager cannot issue a
 * permanent organization/client invitation. Canonical deny checks remain the
 * caller's responsibility after this capture and before its atomic fence. */
export async function captureWorkspaceInvitationDelegation(env:PortalAuthorizationEnv,input:{workspaceId:string;target:PortalWorkspaceTarget;identityId:string;issuer:string;subject:string;email:string},
  capabilities:PortalWorkspaceCapability[],terms:ProjectAccessTermsView|null){
  const root=await env.DELIVERY_DB.withSession('first-primary').prepare(`SELECT root_type,COALESCE(pa_organization_public_id,pa_client_public_id) root_id
    FROM portal_v2_workspaces WHERE id=? AND status='active'`).bind(input.workspaceId).first<{root_type:'organization'|'standalone_client';root_id:string}>();
  if(!root)exceeds();
  const targetInput=input.target.scopeType==='workspace'?{scopeType:root.root_type,publicId:root.root_id}:input.target;
  const encoded=JSON.stringify({...input,targets:[targetInput],relations:env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED==='true'?1:0});
  const proof=await env.DELIVERY_DB.withSession('first-primary').prepare(query).bind(encoded).first<string>('proof');
  if(!proof||new TextEncoder().encode(proof).byteLength>192*1024)exceeds();
  const state=JSON.parse(proof) as {membership:{expiresAt:string|null}|null;workspace:{id:string;rootType:'organization'|'standalone_client';rootPublicId:string;generationId:string}|null;
    entitlements:Entitlement[];denials:unknown[];blocks:unknown[];scopeRows:unknown[]};
  if(!state.workspace||!state.membership||state.entitlements.length>800||state.denials.length>200||state.blocks.length>200)exceeds();
  const target=await readNativeTargetScopes(env,{workspaceId:state.workspace.id,generationId:state.workspace.generationId,rootType:state.workspace.rootType,rootPublicId:state.workspace.rootPublicId},
    [targetInput],{retention:'structural'});
  const scope=target.get(`${targetInput.scopeType}:${targetInput.publicId}`);if(!scope||JSON.stringify(scope.proofRows)!==JSON.stringify(state.scopeRows))exceeds();
  const expired=scope.proofRows.filter(row=>row.entity_type==='project'&&row.retained<=0).map(row=>row.public_id);
  const desired=terms?.effectiveExpiresAt?timestamp(terms.effectiveExpiresAt):Infinity;
  const membershipCeiling=state.membership.expiresAt?timestamp(state.membership.expiresAt):Infinity;
  if(!Number.isFinite(membershipCeiling)&&membershipCeiling!==Infinity)exceeds();
  if(desired>membershipCeiling)exceeds();
  for(const capability of new Set<PortalWorkspaceCapability>(['member.manage','workspace.view',...capabilities])){
    const shell=capability==='workspace.view',scopes=shell||input.target.scopeType==='workspace'?new Set([`workspace:${input.workspaceId}`]):scope.scopes;
    const allows=state.entitlements.filter(row=>row.capability===capability&&row.effect==='allow'&&row.status==='active'&&!row.revoked_at
      &&row.live===1&&scopes.has(`${row.scope_type}:${row.scope_public_id}`)
      &&projectAccessRowAllows(row,scopes,shell?[]:expired,shell));
    const ceiling=Math.max(-Infinity,...allows.map(row=>Math.min(row.expires_at?timestamp(row.expires_at):Infinity,
      row.terms_expiry?timestamp(row.terms_expiry):row.terms_mode==='project_end'
        ?terms?.mode==='project_end'&&row.terms_project_id===input.target.publicId?Infinity:-Infinity:Infinity)));
    if(desired>ceiling)exceeds();
  }
  // The caller performs the canonical deny-aware per-capability checks AFTER
  // this capture. Its first write then compares the very same bounded facts.
  return {proof,fence:(id:string)=>env.DELIVERY_DB.prepare(`INSERT INTO portal_project_invitation_fences(id,write_guard)
    VALUES(?,CASE WHEN (${query})=? THEN 1 ELSE 0 END)`).bind(id,encoded,proof)};
}
