import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import type {PortalNotificationHistoryItem,PortalNotificationHistoryPage} from '@ltds/shared';
import type {Env} from '../types';
import type {ClientPortalSession,VerifiedClientPrincipal} from './types';
import type {EffectivePortalWorkspaceContext,NativePortalReadContext} from './workspace-v2';
import {authorizeEffectiveWorkspaceNotification,resolveNativePortalWorkspaceReadContext,eligiblePortalShellQuery} from './workspace-v2';
import {nativeRequestSchemaReady,nativeServiceRequestsEnabled,resolveNativeRequestAuthority} from './native-request-authority';
import {readFeedbackRecord} from './feedback-store';
import {reauthorizeFeedbackRecipient} from './feedback-target';
import {readNativeFeedbackRecord} from './native-feedback-store';
import {nativeFeedbackSchemaAvailable} from './native-feedback-store';
import {reauthorizeNativeFeedbackRecipient} from './native-feedback-target';
import {nativeFeedbackEnabledForContext,nativeFeedbackNotificationsSchemaAvailable} from './native-feedback-authority';
import {decodeNotificationHistoryCursor,encodeNotificationHistoryCursor,notificationHistoryScope} from './notification-history-cursor';
import {d1TablesPresent} from '../schema-readiness';
import {authorizeNativePortalReadTarget} from './workspace-v2';
import {readNativeTargetScopes,NATIVE_PORTAL_TARGET_SCOPES_SQL} from './native-portal-scopes';
import {projectAccessTermsSql} from './project-access-terms';
import {portalProjectionSourceGuard} from '../project-alpha-portal-authority';
import {portalRootAccessAllowedSql} from './workspace-access-policy';
import {authenticatedDeliveryChangeAuthoritySql} from '@ltds/shared/authenticated-delivery-authority';
import {readPortalProjectionSourceProof} from '../project-alpha-portal-authority';
import {readEffectiveWorkspaceIdentityMutationGuard} from './effective-workspace-identity-mutation-guard';
import {readEffectiveWorkspaceVisibilityMutationGuard} from './effective-workspace-visibility-mutation-guard';
import {authorizeAuthenticatedDeliveryGrant,readNativeAuthenticatedDeliveryGrants} from './authenticated-delivery-grants';
import {encodeNativePortalHandle} from './native-portal-handles';
import {encodeAuthenticatedDeliveryHandle} from './authenticated-delivery-handles';

type Variables={clientSession:ClientPortalSession;clientPrincipal:VerifiedClientPrincipal;clientWorkspace:EffectivePortalWorkspaceContext|null};
const PAGE=25,TTL=15*60_000;
type Raw={rowid:number;id:string;kind:'request'|'feedback'|'delivery'|'native_delivery'|'authenticated_delivery';title:string;body:string;actionPath:string|null;readAt:string|null;createdAt:string};
type LedgerCoverage='included'|'omitted_feature_disabled'|'omitted_schema_unavailable';
type Dependencies={notificationSchemaAvailable:(env:Env)=>Promise<boolean>;feedbackSchemaAvailable:(env:Env)=>Promise<boolean>};
export function notificationHistoryCoverage(input:{native:boolean;notifications:boolean;primaryFeedback:boolean;nativeRequestsEnabled:boolean;nativeRequestSchema:boolean;nativeFeedbackEnabled:boolean;nativeFeedbackSchema:boolean}):{requests:LedgerCoverage;feedback:LedgerCoverage}{
  if(!input.native)return {requests:input.notifications?'included':'omitted_schema_unavailable',feedback:input.primaryFeedback?'included':'omitted_schema_unavailable'};
  return {requests:!input.nativeRequestsEnabled?'omitted_feature_disabled':!input.notifications||!input.nativeRequestSchema?'omitted_schema_unavailable':'included',
    feedback:!input.nativeFeedbackEnabled?'omitted_feature_disabled':!input.nativeFeedbackSchema?'omitted_schema_unavailable':'included'};
}
async function nativeDeliverySchemaAvailable(env:Env){return d1TablesPresent(env.DELIVERY_DB,['native_delivery_recipient_events','native_delivery_recipient_event_state']);}
async function authenticatedDeliverySchemaAvailable(env:Env){return d1TablesPresent(env.DELIVERY_DB,[
  'authenticated_delivery_recipient_events','authenticated_delivery_recipient_event_state',
  'portal_authenticated_delivery_change_batches','portal_authenticated_delivery_change_batch_items',
  'portal_authenticated_delivery_notification_policies','portal_primary_staff_bindings','portal_v2_identity_eligibility_blocks',
  'portal_native_staff_bindings','portal_native_staff_grants',
]);}
const db=(env:Env)=>env.DELIVERY_DB.withSession('first-primary');
const key=(row:Raw)=>`${row.kind}:${row.id}`;
// Timestamps and opaque notification keys are ASCII. Use SQLite BINARY order,
// not locale collation, so the merge and continuation predicate agree.
const binaryDescending=(a:string,b:string)=>a===b?0:a>b?-1:1;
const before=(after:[string,string]|undefined)=>after??[null,null];
const cleanPath=(value:string|null)=>value?.startsWith('/portal/')&&!/[\\\u0000-\u001f\u007f]/.test(value)?value:null;

async function scopeFor(env:Env,principal:VerifiedClientPrincipal,session:ClientPortalSession,workspace:EffectivePortalWorkspaceContext|null){
  if(session.nativeSourceId&&session.workspaceId&&session.nativePortalIdentityId){
    const context=await resolveNativePortalWorkspaceReadContext(env,principal,session.workspaceId);if(!context||context.sourceId!==session.nativeSourceId||context.identityId!==session.nativePortalIdentityId)return null;
    return {scope:{sourceId:context.sourceId,workspaceId:context.workspaceId,rootType:context.rootType,rootPublicId:context.rootPublicId},context};
  }
  if(workspace){const row=await db(env).prepare(`SELECT project_alpha_source_id sourceId,root_type rootType,
    CASE WHEN root_type='organization' THEN pa_organization_public_id ELSE pa_client_public_id END rootPublicId,status FROM portal_v2_workspaces WHERE id=?`)
    .bind(workspace.workspaceId).first<{sourceId:string;rootType:string;rootPublicId:string;status:string}>();
    if(!row||row.status!=='active'||row.rootType!==workspace.rootType||row.rootPublicId!==workspace.rootPublicId)return null;
    return {scope:{sourceId:row.sourceId,workspaceId:workspace.workspaceId,rootType:row.rootType,rootPublicId:row.rootPublicId},context:null};}
  const row=await db(env).prepare(`SELECT COALESCE(project_alpha_source_id,'project-alpha:primary') sourceId,
    CASE WHEN project_alpha_organization_id IS NOT NULL THEN 'organization' ELSE 'standalone_client' END rootType,
    COALESCE(project_alpha_organization_id,project_alpha_client_id) rootPublicId,status FROM client_accounts WHERE id=?`).bind(session.accountId)
    .first<{sourceId:string;rootType:string;rootPublicId:string|null;status:string}>();
  return row?.status==='active'?{scope:{sourceId:row.sourceId,workspaceId:null,
    rootType:row.rootPublicId?row.rootType:'legacy_account',rootPublicId:row.rootPublicId??session.accountId},context:null}:null;
}
async function requestRows(env:Env,session:ClientPortalSession,water:number,asOf:string,afterKey:[string,string]|undefined){
  const [at,id]=before(afterKey);
  if(session.nativeSourceId)return db(env).prepare(`SELECT n.rowid,n.id,'request' kind,n.title,n.body,n.action_path actionPath,n.read_at readAt,n.created_at createdAt
    FROM client_portal_notifications n JOIN client_service_requests r ON n.source_type='service_request' AND r.id=n.source_id
    WHERE n.rowid<=? AND n.created_at<=? AND n.dismissed_at IS NULL AND r.portal_workspace_id=? AND r.portal_identity_id=? AND r.catalog_source_id=?
      AND n.account_id=r.account_id AND n.recipient_identity_id=r.created_by_identity_id
      AND (? IS NULL OR n.created_at<? OR (n.created_at=? AND 'request:'||n.id<?)) ORDER BY n.created_at DESC,n.id DESC LIMIT ?`)
    .bind(water,asOf,session.workspaceId,session.nativePortalIdentityId,session.nativeSourceId,at,at,at,id,PAGE+1).all<Raw>();
  return db(env).prepare(`SELECT n.rowid,n.id,CASE n.source_type WHEN 'folder_grant' THEN 'delivery' ELSE 'request' END kind,n.title,n.body,n.action_path actionPath,n.read_at readAt,n.created_at createdAt
    FROM client_portal_notifications n
    WHERE n.rowid<=? AND n.created_at<=? AND n.dismissed_at IS NULL AND n.account_id=? AND n.recipient_identity_id=?
      AND (n.source_type<>'service_request' OR EXISTS(SELECT 1 FROM client_service_requests r
        WHERE r.id=n.source_id AND r.account_id=n.account_id AND r.created_by_identity_id=n.recipient_identity_id))
      AND (? IS NULL OR n.created_at<? OR (n.created_at=? AND (CASE n.source_type WHEN 'folder_grant' THEN 'delivery:' ELSE 'request:' END)||n.id<?))
    ORDER BY n.created_at DESC,(CASE n.source_type WHEN 'folder_grant' THEN 'delivery:' ELSE 'request:' END)||n.id DESC LIMIT ?`)
    .bind(water,asOf,session.accountId,session.identityId,at,at,at,id,PAGE+1).all<Raw>();
}
async function feedbackRows(env:Env,principal:VerifiedClientPrincipal,session:ClientPortalSession,workspaceIdentityId:string|null,water:number,asOf:string,afterKey:[string,string]|undefined){
  const [at,id]=before(afterKey);
  if(session.nativeSourceId)return db(env).prepare(`SELECT n.rowid,n.id,'feedback' kind,'Feedback completed' title,
    COALESCE(f.completion_note,'Your feedback has been handled.') body,NULL actionPath,n.read_at readAt,n.created_at createdAt
    FROM portal_native_feedback_notifications n JOIN portal_native_feedback f ON f.id=n.feedback_id AND f.revision=n.feedback_revision
    WHERE n.rowid<=? AND n.created_at<=? AND n.dismissed_at IS NULL AND n.source_id=? AND n.workspace_id=? AND n.recipient_identity_id=?
      AND n.principal_issuer=? AND n.principal_subject=? AND (? IS NULL OR n.created_at<? OR (n.created_at=? AND 'feedback:'||n.id<?))
    ORDER BY n.created_at DESC,n.id DESC LIMIT ?`).bind(water,asOf,session.nativeSourceId,session.workspaceId,session.nativePortalIdentityId,
      principal.issuer,principal.subject,at,at,at,id,PAGE+1).all<Raw>();
  return db(env).prepare(`SELECT n.rowid,n.id,'feedback' kind,'Feedback completed' title,
    COALESCE(f.completion_note,'Your feedback has been handled.') body,NULL actionPath,n.read_at readAt,n.created_at createdAt
    FROM client_feedback_notifications n JOIN client_feedback f ON f.id=n.feedback_id AND f.revision=n.feedback_revision
    WHERE n.rowid<=? AND n.created_at<=? AND n.dismissed_at IS NULL AND n.account_id=? AND n.recipient_identity_id=?
      AND n.workspace_id IS ? AND n.workspace_identity_id IS ? AND f.principal_issuer=? AND f.principal_subject=?
      AND (? IS NULL OR n.created_at<? OR (n.created_at=? AND 'feedback:'||n.id<?)) ORDER BY n.created_at DESC,n.id DESC LIMIT ?`)
    .bind(water,asOf,session.accountId,session.identityId,session.workspaceId??null,workspaceIdentityId,
      principal.issuer,principal.subject,at,at,at,id,PAGE+1).all<Raw>();
}
async function nativeDeliveryRows(env:Env,session:ClientPortalSession,water:number,asOf:string,afterKey:[string,string]|undefined){
  const [at,id]=before(afterKey);
  return db(env).prepare(`SELECT event.rowid,event.id,'native_delivery' kind,'Delivery access granted' title,
    'You have been granted access to a Project Alpha delivery.' body,NULL actionPath,state.read_at readAt,event.created_at createdAt
    FROM native_delivery_recipient_events event
    LEFT JOIN native_delivery_recipient_event_state state ON state.event_id=event.id AND state.recipient_identity_id=?
    WHERE event.rowid<=? AND event.created_at<=? AND event.source_id=? AND event.workspace_id=?
      AND EXISTS(SELECT 1 FROM pa_portal_principals principal JOIN portal_v2_identities identity ON identity.id=?
        WHERE principal.workspace_id=event.workspace_id AND principal.public_id=event.principal_public_id AND principal.status='active'
          AND principal.source_version=event.principal_source_version AND identity.status='active' AND identity.revoked_at IS NULL
          AND (principal.identity_id=identity.id OR (principal.identity_id IS NULL AND EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_bindings eligibility
            WHERE eligibility.identity_id=identity.id AND eligibility.workspace_id=event.workspace_id AND eligibility.principal_public_id=event.principal_public_id
              AND eligibility.principal_source_version=event.principal_source_version AND eligibility.verified_email=identity.verified_email))))
      AND state.dismissed_at IS NULL
      AND (? IS NULL OR event.created_at<? OR (event.created_at=? AND 'native_delivery:'||event.id<?))
    ORDER BY event.created_at DESC,event.id DESC LIMIT ?`).bind(session.nativePortalIdentityId,water,asOf,session.nativeSourceId,session.workspaceId,
      session.nativePortalIdentityId,at,at,at,id,PAGE+1).all<Raw>();
}
async function authorizeNativeDelivery(env:Env,principal:VerifiedClientPrincipal,session:ClientPortalSession,row:Raw,asOf:string){
  if(!session.nativeSourceId||!session.workspaceId||!session.nativePortalIdentityId)return null;
  const event=await db(env).prepare(`SELECT event.id,event.grant_id grantId,event.folder_binding_id bindingId,event.created_at createdAt,
      event.owner_scope_type ownerScopeType,event.owner_public_id ownerPublicId,event.r2_prefix prefix
    FROM native_delivery_recipient_events event
    JOIN project_alpha_delivery_portal_grants grant_record ON grant_record.id=event.grant_id AND grant_record.workspace_id=event.workspace_id
      AND grant_record.grant_version=event.grant_version AND grant_record.folder_binding_id=event.folder_binding_id
      AND grant_record.binding_source_version=event.binding_source_version
      AND grant_record.audience_type='principal' AND grant_record.audience_public_id=event.principal_public_id
      AND grant_record.audience_source_version=event.principal_source_version
      AND grant_record.status='active' AND grant_record.revoked_at IS NULL
      AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))
    JOIN project_alpha_delivery_intent_receipts receipt ON receipt.receipt_id=event.receipt_id AND receipt.project_alpha_source_id=event.source_id
      AND receipt.resource_id=event.grant_id AND receipt.access_mode='portal' AND receipt.status='accepted'
    JOIN portal_v2_folder_bindings binding ON binding.id=event.folder_binding_id AND binding.workspace_id=event.workspace_id
      AND binding.source_version=event.binding_source_version AND binding.owner_scope_type=event.owner_scope_type
      AND binding.owner_public_id=event.owner_public_id AND binding.r2_prefix=event.r2_prefix AND binding.status='active' AND binding.revoked_at IS NULL
    JOIN pa_portal_principals principal_record ON principal_record.workspace_id=event.workspace_id AND principal_record.public_id=event.principal_public_id
      AND principal_record.source_version=event.principal_source_version AND principal_record.status='active'
    JOIN portal_v2_identities current_identity ON current_identity.id=? AND current_identity.status='active' AND current_identity.revoked_at IS NULL
    LEFT JOIN portal_v2_identity_eligibility_bindings eligibility ON eligibility.identity_id=current_identity.id AND eligibility.workspace_id=event.workspace_id
      AND eligibility.principal_public_id=event.principal_public_id AND eligibility.principal_source_version=event.principal_source_version AND eligibility.verified_email=current_identity.verified_email
    WHERE (principal_record.identity_id=current_identity.id
      OR (principal_record.identity_id IS NULL AND eligibility.identity_id IS NOT NULL))
      AND lower(principal_record.email_hint)=lower(current_identity.verified_email)
      AND event.id=? AND event.source_id=? AND event.workspace_id=? AND event.event_type='grant_accepted' AND event.created_at<=?`)
    .bind(session.nativePortalIdentityId,row.id,session.nativeSourceId,session.workspaceId,asOf).first<{id:string;grantId:string;bindingId:string;createdAt:string;ownerScopeType:string;ownerPublicId:string;prefix:string}>();
  if(!event||event.createdAt!==row.createdAt)return null;
  const context=await resolveNativePortalWorkspaceReadContext(env,principal,session.workspaceId);
  if(!context||context.sourceId!==session.nativeSourceId||context.identityId!==session.nativePortalIdentityId
    ||!await authorizeNativePortalReadTarget(env,context,'delivery.view',{scopeType:'folder',publicId:event.bindingId}))return null;
  return event;
}
async function nativeDeliveryMutationGuard(env:Env,principal:VerifiedClientPrincipal,session:ClientPortalSession,eventId:string,
  eventTable:'native_delivery_recipient_events'|'authenticated_delivery_recipient_events'='native_delivery_recipient_events'){
  if(!session.workspaceId||!session.nativePortalIdentityId)return null;
  const context=await resolveNativePortalWorkspaceReadContext(env,principal,session.workspaceId);if(!context||context.identityId!==session.nativePortalIdentityId||context.sourceId!==session.nativeSourceId)return null;
  const membership=await db(env).prepare('SELECT id,source_type FROM portal_v2_workspace_memberships WHERE workspace_id=? AND identity_id=? AND source_version=? AND status=\'active\' AND revoked_at IS NULL')
    .bind(context.workspaceId,context.identityId,context.membershipSourceVersion).first<{id:string;source_type:string}>();if(!membership)return null;
  const event=await db(env).prepare(`SELECT folder_binding_id bindingId FROM ${eventTable} WHERE id=? AND workspace_id=? AND source_id=?`).bind(eventId,session.workspaceId,session.nativeSourceId).first<{bindingId:string}>();
  const target=event?(await readNativeTargetScopes(env,context,[{scopeType:'folder',publicId:event.bindingId}],{retention:'structural'})).get(`folder:${event.bindingId}`):null;if(!target)return null;
  const authority=portalProjectionSourceGuard(context.authority),parts=[authority.sql],bindings:(string|number|null)[]=[...authority.bindings];
  const scopes=JSON.stringify([...target.scopes]);
  const termsProject='(SELECT project_public_id FROM portal_project_access_terms WHERE id=allow_record.access_terms_id)';
  const expired=JSON.stringify(target.proofRows.filter(row=>row.entity_type==='project'&&row.retained===0).map(row=>row.public_id));
  const liveAllowTerms=projectAccessTermsSql({termsId:'allow_record.access_terms_id',workspaceId:'allow_record.workspace_id',projectId:termsProject,legacyRetained:'1'});
  // Re-evaluate the complete canonical lineage in the write, including relation
  // edges, retention, generation and binding version. Merely checking the old
  // list of ancestors misses a newly inserted narrower deny scope.
  const scopeQuery=NATIVE_PORTAL_TARGET_SCOPES_SQL.replace(/\?([1-5])/g,(_match,index:string)=>
    `(SELECT ${['targets','workspace','generation','relations','maximum'][Number(index)-1]} FROM native_inputs)`);
  const scopeProof=JSON.stringify(target.proofRows.map(row=>[row.target_type,row.target_id,row.entity_type,row.public_id,
    row.parent_public_id,row.source_version,row.depth,row.display_name,row.binding_version,row.retained]));
  // Keep the recursive scope proof and its aggregate in separate top-level
  // materialized CTEs.  Nesting the recursive query inside the boolean guard
  // makes the final readback/state statement exceed D1's expression-depth
  // limit, even though each logical authorization check is independently
  // bounded. `native_inputs` remains in this same statement, so the
  // proof is still tied to the exact snapshot selected above.
  parts.push(`native_inputs AS MATERIALIZED(SELECT ? targets,? workspace,? generation,? relations,? maximum),
    native_scope_rows AS MATERIALIZED(${scopeQuery}),
    native_scope_proof AS MATERIALIZED(SELECT json_group_array(json_array(target_type,target_id,entity_type,public_id,
      parent_public_id,source_version,depth,display_name,binding_version,retained)) proof FROM native_scope_rows),
    native_scope_guard AS MATERIALIZED(SELECT 1 ok FROM native_scope_proof WHERE native_scope_proof.proof=?)`);
  bindings.push(JSON.stringify([{scopeType:'folder',publicId:event!.bindingId}]),context.workspaceId,context.generationId,
    env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED==='true'?1:0,66,scopeProof);
  parts.push(`EXISTS(SELECT 1 FROM portal_v2_workspaces workspace
    JOIN pa_portal_workspace_sources source ON source.workspace_id=workspace.id AND source.projection_source_id=workspace.project_alpha_source_id
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=workspace.id AND membership.identity_id=?
      AND membership.status='active' AND membership.revoked_at IS NULL AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    JOIN portal_v2_identities identity ON identity.id=membership.identity_id AND identity.status='active' AND identity.revoked_at IS NULL
    WHERE workspace.id=? AND workspace.project_alpha_source_id=? AND workspace.status='active' AND workspace.legacy_account_id IS NULL
      AND workspace.root_type=? AND COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)=?
      AND ${portalRootAccessAllowedSql(env.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED==='true','workspace')}
      AND identity.issuer=? AND identity.subject=? AND identity.verified_email=? AND membership.source_version=? AND membership.id=? AND membership.source_type=?
      AND (membership.source_type<>'project_alpha' OR EXISTS(SELECT 1 FROM pa_portal_principals member_principal
        WHERE member_principal.workspace_id=workspace.id AND member_principal.status='active'
          AND member_principal.source_version=membership.source_version AND lower(member_principal.email_hint)=lower(identity.verified_email)
          AND (member_principal.identity_id=identity.id OR (member_principal.identity_id IS NULL AND EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_bindings eligibility
            WHERE eligibility.workspace_id=workspace.id AND eligibility.identity_id=identity.id
              AND eligibility.principal_public_id=member_principal.public_id AND eligibility.principal_source_version=member_principal.source_version
              AND eligibility.verified_email=identity.verified_email)))))
      AND (EXISTS(${eligiblePortalShellQuery(false,'workspace.id','identity.id')}) OR EXISTS(SELECT 1 FROM portal_v2_entitlements allow_record
        WHERE allow_record.workspace_id=workspace.id AND allow_record.identity_id=identity.id AND allow_record.capability='workspace.view'
          AND allow_record.effect='allow' AND allow_record.scope_type='workspace' AND allow_record.scope_public_id=workspace.id
          AND allow_record.status='active' AND allow_record.revoked_at IS NULL AND datetime(allow_record.valid_from)<=datetime('now')
          AND (allow_record.expires_at IS NULL OR datetime(allow_record.expires_at)>datetime('now')) AND ${liveAllowTerms})))`);
  bindings.push(context.identityId,context.workspaceId,context.sourceId,context.rootType,context.rootPublicId,
    principal.issuer,principal.subject,context.verifiedEmail,context.membershipSourceVersion,membership.id,membership.source_type);
  parts.push(`NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials denial WHERE denial.identity_id=? AND denial.status='active' AND denial.revoked_at IS NULL
    AND datetime(denial.valid_from)<=datetime('now') AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
    AND (denial.scope_type='global' OR (denial.workspace_id=? AND denial.scope_type||':'||denial.scope_public_id IN (SELECT value FROM json_each(?)))))`);
  bindings.push(context.identityId,context.workspaceId,scopes);
  parts.push(`NOT EXISTS(SELECT 1 FROM portal_v2_entitlements denial WHERE denial.workspace_id=? AND denial.identity_id=?
    AND denial.effect='deny' AND denial.status='active' AND denial.revoked_at IS NULL AND datetime(denial.valid_from)<=datetime('now')
    AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
    AND ((denial.capability='delivery.view' AND denial.scope_type||':'||denial.scope_public_id IN (SELECT value FROM json_each(?)))
      OR (denial.capability='workspace.view' AND denial.scope_type='workspace' AND denial.scope_public_id=denial.workspace_id)))`);
  bindings.push(context.workspaceId,context.identityId,scopes);
  parts.push(`EXISTS(SELECT 1 FROM portal_v2_entitlements allow_record WHERE allow_record.workspace_id=? AND allow_record.identity_id=?
    AND allow_record.capability='delivery.view' AND allow_record.effect='allow' AND allow_record.status='active' AND allow_record.revoked_at IS NULL
    AND datetime(allow_record.valid_from)<=datetime('now') AND (allow_record.expires_at IS NULL OR datetime(allow_record.expires_at)>datetime('now'))
    AND allow_record.scope_type||':'||allow_record.scope_public_id IN (SELECT value FROM json_each(?)) AND ${liveAllowTerms}
    AND ((allow_record.access_terms_id IS NULL AND (json_array_length(?)=0 OR (allow_record.scope_type='project' AND allow_record.source_type IN ('project_alpha','legacy'))))
      OR (allow_record.access_terms_id IS NOT NULL AND 'project:'||${termsProject} IN (SELECT value FROM json_each(?))
        AND NOT EXISTS(SELECT 1 FROM json_each(?) expired WHERE expired.value<>${termsProject}))))`);
  bindings.push(context.workspaceId,context.identityId,scopes,expired,scopes,expired);
  // Materialized guard CTEs remain in the same atomic statement, but keep each
  // independently bounded expression below D1's expression-depth limit.
  // Make each guard relation empty on failure. This keeps the final mutation
  // and readback predicates flat: the CTE cross joins enforce every check,
  // without rebuilding a large AND expression at the statement root.
  return {ctes:parts.map((part,index)=>index===1?part:`native_guard_${index} AS MATERIALIZED(SELECT 1 ok WHERE (${part}))`).join(','),
    from:parts.map((_part,index)=>`CROSS JOIN ${index===1?'native_scope_guard':`native_guard_${index}`}`).join(' '),
    sql:'1=1',bindings};
}
async function authorizeRequest(env:Env,principal:VerifiedClientPrincipal,session:ClientPortalSession,workspace:EffectivePortalWorkspaceContext|null,sourceId:string,row:Raw,asOf:string){
  const record=await db(env).prepare(`SELECT r.id,r.project_id projectId,r.portal_project_public_id portalProjectId,r.catalog_source_id sourceId,
    r.updated_at updatedAt,n.title,n.body,n.action_path actionPath,n.read_at readAt,n.created_at createdAt FROM client_portal_notifications n
    JOIN client_service_requests r ON n.source_type='service_request' AND r.id=n.source_id WHERE n.id=? AND n.dismissed_at IS NULL`)
    .bind(row.id).first<{id:string;projectId:string|null;portalProjectId:string|null;sourceId:string;updatedAt:string;title:string;body:string;actionPath:string|null;readAt:string|null;createdAt:string}>();
  if(!record||record.sourceId!==sourceId||record.title!==row.title||record.body!==row.body||record.createdAt!==row.createdAt||record.updatedAt>asOf)return null;
  if(session.nativeSourceId){const proof=await resolveNativeRequestAuthority(env,session,record.portalProjectId);if(!proof||proof.sourceId!==session.nativeSourceId)return null;}
  else if(workspace){if(!await authorizeEffectiveWorkspaceNotification(env,principal,workspace,row.id))return null;}
  else {const allowed=await db(env).prepare(`SELECT 1 ok FROM client_accounts a JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL
    JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
    JOIN client_service_requests r ON r.id=? AND r.account_id=a.id AND r.created_by_identity_id=i.id
    WHERE a.id=? AND a.status='active' AND (r.project_id IS NULL OR EXISTS(SELECT 1 FROM client_project_grants g
      WHERE g.account_id=a.id AND g.project_id=r.project_id AND g.revoked_at IS NULL AND (m.role='manager' OR EXISTS(
        SELECT 1 FROM client_member_project_grants mg WHERE mg.account_id=a.id AND mg.identity_id=i.id AND mg.project_id=r.project_id AND mg.revoked_at IS NULL))))`)
    .bind(session.identityId,record.id,session.accountId).first('ok');if(!allowed)return null;}
  const final=await db(env).prepare(`SELECT r.updated_at updatedAt,n.title,n.body,n.action_path actionPath,n.read_at readAt,n.created_at createdAt
    FROM client_portal_notifications n JOIN client_service_requests r ON n.source_type='service_request' AND r.id=n.source_id
    WHERE n.id=? AND n.dismissed_at IS NULL`).bind(row.id)
    .first<{updatedAt:string;title:string;body:string;actionPath:string|null;readAt:string|null;createdAt:string}>();
  return final&&final.updatedAt<=asOf&&final.updatedAt===record.updatedAt&&final.title===record.title&&final.body===record.body&&final.actionPath===record.actionPath&&final.readAt===record.readAt&&final.createdAt===record.createdAt?record:null;
}
async function authorizeDelivery(env:Env,principal:VerifiedClientPrincipal,session:ClientPortalSession,workspace:EffectivePortalWorkspaceContext|null,sourceId:string,row:Raw,asOf:string){
  const notice=await db(env).prepare(`SELECT n.source_id sourceId,n.title,n.body,n.action_path actionPath,n.read_at readAt,n.created_at createdAt
    FROM client_portal_notifications n WHERE n.id=? AND n.source_type='folder_grant' AND n.dismissed_at IS NULL
      AND n.account_id=? AND n.recipient_identity_id=?`).bind(row.id,session.accountId,session.identityId)
    .first<{sourceId:string;title:string;body:string;actionPath:string|null;readAt:string|null;createdAt:string}>();
  if(!notice||notice.title!==row.title||notice.body!==row.body||notice.createdAt!==row.createdAt||notice.createdAt>asOf)return null;
  const allowed=async()=>{
    if(workspace)return authorizeEffectiveWorkspaceNotification(env,principal,workspace,row.id);
    return (await db(env).prepare(`SELECT 1 ok FROM client_folder_associations association
    JOIN client_accounts account ON account.id=? AND account.status='active'
    JOIN client_identity_links identity ON identity.id=? AND identity.account_id=account.id AND identity.revoked_at IS NULL
    JOIN client_account_members member ON member.account_id=account.id AND member.identity_id=identity.id AND member.revoked_at IS NULL
    WHERE association.logical_grant_id=? AND association.account_id=account.id AND association.revoked_at IS NULL
      AND COALESCE(account.project_alpha_source_id,'project-alpha:primary')=?
      AND ((association.scope_type='client' AND association.project_id IS NULL) OR (association.scope_type='project' AND association.project_id IS NOT NULL
        AND EXISTS(SELECT 1 FROM projects project JOIN client_project_grants project_grant
          ON project_grant.project_id=project.id AND project_grant.account_id=account.id AND project_grant.revoked_at IS NULL
          WHERE project.id=association.project_id AND project.active=1 AND (member.role='manager' OR EXISTS(
            SELECT 1 FROM client_member_project_grants member_grant WHERE member_grant.account_id=account.id
              AND member_grant.identity_id=identity.id AND member_grant.project_id=project.id AND member_grant.revoked_at IS NULL)))))`)
    .bind(session.accountId,session.identityId,notice.sourceId,sourceId).first('ok'))!==null;
  };
  if(!await allowed())return null;
  const final=await db(env).prepare(`SELECT title,body,action_path actionPath,read_at readAt,created_at createdAt FROM client_portal_notifications
    WHERE id=? AND source_type='folder_grant' AND dismissed_at IS NULL AND account_id=? AND recipient_identity_id=?`).bind(row.id,session.accountId,session.identityId)
    .first<{title:string;body:string;actionPath:string|null;readAt:string|null;createdAt:string}>();
  return final&&final.title===notice.title&&final.body===notice.body&&final.actionPath===notice.actionPath&&final.readAt===notice.readAt&&final.createdAt===notice.createdAt&&await allowed()?final:null;
}
async function authorizeFeedback(env:Env,principal:VerifiedClientPrincipal,session:ClientPortalSession,row:Raw,native:NativePortalReadContext|null,asOf:string){
  if(native){const notice=await db(env).prepare('SELECT feedback_id FROM portal_native_feedback_notifications WHERE id=? AND dismissed_at IS NULL').bind(row.id).first<{feedback_id:string}>();
    const feedback=notice?await readNativeFeedbackRecord(db(env),notice.feedback_id):null,resolved=feedback?await reauthorizeNativeFeedbackRecipient(env,feedback):null;
    if(!feedback||feedback.updatedAt>asOf||!resolved||feedback.context.sourceId!==native.sourceId||feedback.context.workspaceId!==native.workspaceId||feedback.context.identityId!==native.identityId||feedback.context.issuer!==principal.issuer||feedback.context.subject!==principal.subject)return null;
    const final=await readNativeFeedbackRecord(db(env),feedback.id),finalResolved=final?await reauthorizeNativeFeedbackRecipient(env,final):null;
    return final&&finalResolved&&final.updatedAt<=asOf&&final.updatedAt===feedback.updatedAt&&final.revision===feedback.revision&&final.status===feedback.status?final:null;}
  const notice=await db(env).prepare('SELECT feedback_id FROM client_feedback_notifications WHERE id=? AND dismissed_at IS NULL AND account_id=? AND recipient_identity_id=? AND workspace_id IS ?')
    .bind(row.id,session.accountId,session.identityId,session.workspaceId??null).first<{feedback_id:string}>();
  const feedback=notice?await readFeedbackRecord(db(env),notice.feedback_id):null,resolved=feedback?await reauthorizeFeedbackRecipient(env,feedback):null;
  if(!feedback||feedback.updatedAt>asOf||!resolved||feedback.context.issuer!==principal.issuer||feedback.context.subject!==principal.subject)return null;
  const final=await readFeedbackRecord(db(env),feedback.id),finalResolved=final?await reauthorizeFeedbackRecipient(env,final):null;
  return final&&finalResolved&&final.updatedAt<=asOf&&final.updatedAt===feedback.updatedAt&&final.revision===feedback.revision&&final.status===feedback.status?final:null;
}

type AuthenticatedEvent={id:string;batch_id:string;source_id:string;workspace_id:string;identity_id:string;
  folder_binding_id:string;grant_id:string;grant_version:number;binding_source_version:string;
  r2_prefix:string;owner_scope_type:'organization'|'department'|'client'|'project';owner_public_id:string;
  added_count:number;removed_count:number;created_at:string};
type NotificationGuard={ctes:string;from:string;sql:string;bindings:(string|number|null)[]};
const portalIdentity=(session:ClientPortalSession,workspace:EffectivePortalWorkspaceContext|null)=>session.nativePortalIdentityId??workspace?.identityId??session.identityId;

async function authenticatedDeliveryRows(env:Env,session:ClientPortalSession,workspace:EffectivePortalWorkspaceContext|null,
  sourceId:string,water:number,asOf:string,afterKey:[string,string]|undefined){
  const [at,id]=before(afterKey);
  return db(env).prepare(`SELECT event.rowid,event.id,'authenticated_delivery' kind,'Files changed in your delivery' title,
      '' body,NULL actionPath,state.read_at readAt,event.created_at createdAt
    FROM authenticated_delivery_recipient_events event
    LEFT JOIN authenticated_delivery_recipient_event_state state ON state.event_id=event.id AND state.recipient_identity_id=event.identity_id
    WHERE event.rowid<=? AND event.created_at<=? AND event.source_id=? AND event.workspace_id=? AND event.identity_id=?
      AND state.dismissed_at IS NULL
      AND (? IS NULL OR event.created_at<? OR (event.created_at=? AND 'authenticated_delivery:'||event.id<?))
    ORDER BY event.created_at DESC,event.id DESC LIMIT ?`)
    .bind(water,asOf,sourceId,session.workspaceId,portalIdentity(session,workspace),at,at,at,id,PAGE+1).all<Raw>();
}

/** Build the same current-authority boundary for read and state mutation. The
 * immutable batch/event supplies recipients; never infer them from email. */
async function authenticatedDeliveryGuard(env:Env,principal:VerifiedClientPrincipal,session:ClientPortalSession,
  workspace:EffectivePortalWorkspaceContext|null,eventId:string):Promise<{event:AuthenticatedEvent;guard:NotificationGuard;native:NativePortalReadContext|null}|null>{
  if(!session.workspaceId||env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED!=='true')return null;
  const resolved=await scopeFor(env,principal,session,workspace);if(!resolved)return null;
  const identity=portalIdentity(session,workspace);
  const event=await db(env).prepare(`SELECT id,batch_id,source_id,workspace_id,identity_id,folder_binding_id,
      grant_id,grant_version,binding_source_version,r2_prefix,owner_scope_type,owner_public_id,added_count,removed_count,created_at
    FROM authenticated_delivery_recipient_events WHERE id=? AND source_id=? AND workspace_id=? AND identity_id=?`)
    .bind(eventId,resolved.scope.sourceId,session.workspaceId,identity).first<AuthenticatedEvent>();
  if(!event||!Number.isSafeInteger(event.added_count)||!Number.isSafeInteger(event.removed_count)
    ||event.added_count<0||event.removed_count<0||event.added_count+event.removed_count<1||event.added_count+event.removed_count>50)return null;
  let base:NotificationGuard;
  if(resolved.context){
    const native=await nativeDeliveryMutationGuard(env,principal,session,eventId,'authenticated_delivery_recipient_events');
    if(!native)return null;base=native;
  }else{
    if(!workspace||!await authorizeAuthenticatedDeliveryGrant(env,principal,workspace.workspaceId,event.folder_binding_id))return null;
    const source=await readPortalProjectionSourceProof(env,db(env),resolved.scope.sourceId);if(!source)return null;
    const sourceGuard=portalProjectionSourceGuard(source);
    const identityGuard=await readEffectiveWorkspaceIdentityMutationGuard(env,principal,workspace);
    const visibility=await readEffectiveWorkspaceVisibilityMutationGuard(env,workspace);
    const parts=[sourceGuard,identityGuard,visibility,{
      sql:`EXISTS(SELECT 1 FROM portal_v2_workspaces workspace JOIN portal_v2_identities identity ON identity.id=?
        WHERE workspace.id=? AND workspace.project_alpha_source_id=? AND workspace.status='active'
          AND identity.issuer=? AND identity.subject=? AND lower(identity.verified_email)=?
          AND ${portalRootAccessAllowedSql(env.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED==='true','workspace')}
          AND NOT EXISTS(SELECT 1 FROM portal_v2_entitlements denial WHERE denial.workspace_id=workspace.id
            AND denial.identity_id=identity.id AND denial.capability='workspace.view' AND denial.effect='deny'
            AND denial.scope_type='workspace' AND denial.scope_public_id=workspace.id AND denial.status='active'
            AND denial.revoked_at IS NULL AND datetime(denial.valid_from)<=datetime('now')
            AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))))`,
      bindings:[identity,workspace.workspaceId,resolved.scope.sourceId,principal.issuer,principal.subject,principal.email.trim().toLowerCase()],
    }];
    base={ctes:parts.map((part,index)=>`authenticated_guard_${index} AS MATERIALIZED(SELECT (${part.sql}) ok)`).join(','),
      from:parts.map((_part,index)=>`CROSS JOIN authenticated_guard_${index}`).join(' '),
      sql:parts.map((_part,index)=>`authenticated_guard_${index}.ok=1`).join(' AND '),bindings:parts.flatMap(part=>part.bindings)};
  }
  // The reusable authority query re-evaluates grant/policy/principal versions,
  // membership, lineage, access terms and denies in the statement itself.
  const primaryStaffReceiptsReady=await d1TablesPresent(env.DELIVERY_DB,['portal_primary_staff_bindings']);
  if(!primaryStaffReceiptsReady)return null;
  return {event,native:resolved.context,guard:{
    ctes:`${base.ctes},authenticated_batch_authority AS MATERIALIZED(${authenticatedDeliveryChangeAuthoritySql(env.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED==='true',env.CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED==='true',primaryStaffReceiptsReady)}),
      authenticated_current_recipient AS MATERIALIZED(SELECT 1 FROM authenticated_delivery_recipient_events event
        JOIN portal_v2_folder_bindings binding ON binding.id=event.folder_binding_id AND binding.workspace_id=event.workspace_id
        JOIN portal_v2_identities identity ON identity.id=event.identity_id
        WHERE event.id=? AND (event.source_id<>'project-alpha:primary' OR binding.source_type<>'operations' OR EXISTS(
          SELECT 1 FROM portal_primary_staff_bindings receipt WHERE receipt.binding_id=binding.id
            AND receipt.workspace_id=binding.workspace_id AND receipt.r2_prefix=binding.r2_prefix AND receipt.state='active'))
          AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_blocks block WHERE block.status='active'
            AND datetime(block.valid_from)<=datetime('now') AND (block.expires_at IS NULL OR datetime(block.expires_at)>datetime('now'))
            AND (block.match_type='issuer_subject' AND block.issuer=identity.issuer AND block.subject=identity.subject
              OR block.match_type='email' AND block.normalized_email=lower(identity.verified_email))))`,
    from:base.from,sql:`(${base.sql}) AND EXISTS(SELECT 1 FROM authenticated_batch_authority) AND EXISTS(SELECT 1 FROM authenticated_current_recipient)`,
    bindings:[...base.bindings,event.batch_id,event.id],
  }};
}

/** Exact, current authority for a notification's folder resource. A dismissal
 * hides the notice, not its independently authorized resource. Never infer a
 * broader legacy association or replace a revoked grant with another one. */
export async function readAuthenticatedDeliveryResource(env:Env,principal:VerifiedClientPrincipal,session:ClientPortalSession,
  workspace:EffectivePortalWorkspaceContext|null,eventId:string):Promise<AuthenticatedEvent|null>{
  if(!await authenticatedDeliverySchemaAvailable(env))return null;
  const proof=await authenticatedDeliveryGuard(env,principal,session,workspace,eventId);if(!proof)return null;
  const {event,guard}=proof;
  const current=await db(env).prepare(`WITH ${guard.ctes} SELECT event.id
    FROM authenticated_delivery_recipient_events event ${guard.from}
    WHERE event.id=? AND event.identity_id=? AND ${guard.sql}`)
    .bind(...guard.bindings,event.id,event.identity_id).first<{id:string}>();
  return current?event:null;
}

async function authorizeAuthenticatedDelivery(env:Env,principal:VerifiedClientPrincipal,session:ClientPortalSession,
  workspace:EffectivePortalWorkspaceContext|null,row:Raw,asOf:string){
  const proof=await authenticatedDeliveryGuard(env,principal,session,workspace,row.id);if(!proof||proof.event.created_at!==row.createdAt||proof.event.created_at>asOf)return null;
  const {event,guard,native}=proof;
  let actionPath:string|null=null;
  if(native){
    const grants=await readNativeAuthenticatedDeliveryGrants(env,principal,native,event.folder_binding_id,{grantId:event.grant_id});
    const grant=grants.find(value=>value.source==='staff'&&value.grant_id===event.grant_id&&value.grant_version===event.grant_version&&value.binding_source_version===event.binding_source_version);
    if(!grant)return null;
    const folder=await encodeNativePortalHandle(env,{v:1,kind:'folder',sourceId:native.sourceId,workspaceId:native.workspaceId,
      identityId:native.identityId,contextVersion:native.contextVersion,bindingId:grant.folder_binding_id,bindingVersion:grant.binding_source_version,
      grantId:grant.grant_id,grantVersion:grant.grant_version,bindingProof:grant.binding_fingerprint,path:'',expires:Date.now()+60*60_000});
    actionPath=`/portal/deliveries?${new URLSearchParams({workspace:native.workspaceId,folder})}`;
  }else{
    const folder=await encodeAuthenticatedDeliveryHandle(env,{v:1,kind:'folder',sourceId:event.source_id,
      workspaceId:event.workspace_id,identityId:event.identity_id,eventId:event.id,grantId:event.grant_id,
      grantVersion:event.grant_version,bindingId:event.folder_binding_id,bindingSourceVersion:event.binding_source_version,
      path:'',expires:Date.now()+60*60_000});
    actionPath=`/portal/deliveries?${new URLSearchParams({workspace:event.workspace_id,folder})}`;
  }
  const current=await db(env).prepare(`WITH ${guard.ctes} SELECT event.id,state.read_at readAt
    FROM authenticated_delivery_recipient_events event LEFT JOIN authenticated_delivery_recipient_event_state state
      ON state.event_id=event.id AND state.recipient_identity_id=event.identity_id ${guard.from}
    WHERE event.id=? AND event.identity_id=? AND state.dismissed_at IS NULL AND ${guard.sql}`)
    .bind(...guard.bindings,event.id,event.identity_id).first<{id:string;readAt:string|null}>();
  if(!current)return null;
  const parts=[event.added_count?`${event.added_count} added`:'',event.removed_count?`${event.removed_count} removed`:''].filter(Boolean);
  return {body:`${parts.join(' and ')} in your shared delivery.`,actionPath,readAt:current.readAt};
}

export async function mutateAuthenticatedDeliveryNotification(env:Env,principal:VerifiedClientPrincipal,session:ClientPortalSession,
  workspace:EffectivePortalWorkspaceContext|null,eventId:string,action:'read'|'dismiss',beforeWrite?:()=>Promise<void>){
  if(!await authenticatedDeliverySchemaAvailable(env))return false;
  const proof=await authenticatedDeliveryGuard(env,principal,session,workspace,eventId);if(!proof)return false;
  const {event,guard}=proof;
  await beforeWrite?.();
  const stamp=action==='read'?"read_at=COALESCE(read_at,datetime('now'))":"dismissed_at=COALESCE(dismissed_at,datetime('now'))";
  const result=await db(env).prepare(`WITH ${guard.ctes}
    INSERT INTO authenticated_delivery_recipient_event_state(event_id,recipient_identity_id,read_at,dismissed_at)
    SELECT event.id,event.identity_id,CASE WHEN ?='read' THEN datetime('now') END,CASE WHEN ?='dismiss' THEN datetime('now') END
    FROM authenticated_delivery_recipient_events event ${guard.from}
    WHERE event.id=? AND event.identity_id=? AND ${guard.sql}
    ON CONFLICT(event_id,recipient_identity_id) DO UPDATE SET ${stamp},updated_at=datetime('now')`)
    .bind(...guard.bindings,action,action,event.id,event.identity_id).run();
  return Boolean(result.meta.changes);
}

async function currentCoverage(env:Env,session:ClientPortalSession,native:NativePortalReadContext|null,deps:Dependencies):Promise<{requests:LedgerCoverage;feedback:LedgerCoverage;nativeDelivery:LedgerCoverage;authenticatedDelivery:LedgerCoverage}>{
  const notifications=await deps.notificationSchemaAvailable(env);
  const authenticatedDelivery:LedgerCoverage=!session.workspaceId||env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED!=='true'?'omitted_feature_disabled':await authenticatedDeliverySchemaAvailable(env)?'included':'omitted_schema_unavailable';
  if(!session.nativeSourceId)return {...notificationHistoryCoverage({native:false,notifications,primaryFeedback:await deps.feedbackSchemaAvailable(env),nativeRequestsEnabled:false,nativeRequestSchema:false,nativeFeedbackEnabled:false,nativeFeedbackSchema:false}),nativeDelivery:'omitted_feature_disabled',authenticatedDelivery};
  const nativeRequestsEnabled=nativeServiceRequestsEnabled(env),nativeFeedbackEnabled=!!native&&nativeFeedbackEnabledForContext(env,native);
  return {...notificationHistoryCoverage({native:true,notifications,primaryFeedback:false,nativeRequestsEnabled,nativeRequestSchema:nativeRequestsEnabled&&await nativeRequestSchemaReady(env),nativeFeedbackEnabled,
    nativeFeedbackSchema:nativeFeedbackEnabled&&await nativeFeedbackSchemaAvailable(env)&&await nativeFeedbackNotificationsSchemaAvailable(env)}),nativeDelivery:await nativeDeliverySchemaAvailable(env)?'included':'omitted_schema_unavailable',authenticatedDelivery};
}
export function createClientNotificationHistoryRouter(deps:Dependencies){const router=new Hono<{Bindings:Env;Variables:Variables}>();
  router.get('/notification-history',async c=>{const query=c.req.queries();if(Object.keys(query).some(k=>k!=='cursor')||Object.values(query).some(v=>v.length!==1))throw new HTTPException(400,{message:'Notification query is invalid'});
    const principal=c.get('clientPrincipal'),session=c.get('clientSession'),workspace=c.get('clientWorkspace'),resolved=await scopeFor(c.env,principal,session,workspace);if(!resolved)throw new HTTPException(404,{message:'Notifications not found'});
    const scopeHash=await notificationHistoryScope({...resolved.scope,identityId:portalIdentity(session,workspace)}),encoded=c.req.query('cursor'),cursor=encoded?await decodeNotificationHistoryCursor(c.env,principal,encoded):null;
    if(encoded&&(!cursor||cursor.scope!==scopeHash||cursor.expires<Date.now()))throw new HTTPException(409,{message:'Notification page changed. Refresh this workspace.'});
    const readiness=await currentCoverage(c.env,session,resolved.context,deps),coverage=cursor?.coverage??readiness;
    if(cursor&&coverage.requests==='included'&&readiness.requests!=='included')throw new HTTPException(readiness.requests==='omitted_schema_unavailable'?503:409,{message:'Notification history availability changed. Refresh this workspace.'});
    if(cursor&&coverage.feedback==='included'&&readiness.feedback!=='included')throw new HTTPException(readiness.feedback==='omitted_schema_unavailable'?503:409,{message:'Notification history availability changed. Refresh this workspace.'});
    if(cursor&&coverage.nativeDelivery==='included'&&readiness.nativeDelivery!=='included')throw new HTTPException(503,{message:'Notification history availability changed. Refresh this workspace.'});
    if(cursor&&coverage.authenticatedDelivery==='included'&&readiness.authenticatedDelivery!=='included')throw new HTTPException(readiness.authenticatedDelivery==='omitted_schema_unavailable'?503:409,{message:'Notification history availability changed. Refresh this workspace.'});
    const asOf=cursor?.asOf??new Date().toISOString(),requestWater=coverage.requests!=='included'?0:cursor?.water.requests??Number(await db(c.env).prepare('SELECT COALESCE(MAX(rowid),0) water FROM client_portal_notifications').first('water')??0),
      feedbackWater=coverage.feedback!=='included'?0:cursor?.water.feedback??Number(await db(c.env).prepare(session.nativeSourceId?'SELECT COALESCE(MAX(rowid),0) water FROM portal_native_feedback_notifications':'SELECT COALESCE(MAX(rowid),0) water FROM client_feedback_notifications').first('water')??0),
      nativeDeliveryWater=coverage.nativeDelivery!=='included'?0:cursor?.water.nativeDelivery??Number(await db(c.env).prepare('SELECT COALESCE(MAX(rowid),0) water FROM native_delivery_recipient_events').first('water')??0),
      authenticatedDeliveryWater=coverage.authenticatedDelivery!=='included'?0:cursor?.water.authenticatedDelivery??Number(await db(c.env).prepare('SELECT COALESCE(MAX(rowid),0) water FROM authenticated_delivery_recipient_events').first('water')??0);
    const [requests,feedback,nativeDelivery,authenticatedDelivery]=await Promise.all([coverage.requests==='included'?requestRows(c.env,session,requestWater,asOf,cursor?.after):Promise.resolve({results:[]} as {results:Raw[]}),coverage.feedback==='included'?feedbackRows(c.env,principal,session,workspace?.identityId??null,feedbackWater,asOf,cursor?.after):Promise.resolve({results:[]} as {results:Raw[]}),coverage.nativeDelivery==='included'?nativeDeliveryRows(c.env,session,nativeDeliveryWater,asOf,cursor?.after):Promise.resolve({results:[]} as {results:Raw[]}),coverage.authenticatedDelivery==='included'?authenticatedDeliveryRows(c.env,session,workspace,resolved.scope.sourceId,authenticatedDeliveryWater,asOf,cursor?.after):Promise.resolve({results:[]} as {results:Raw[]})]);
    const raw=[...requests.results,...feedback.results,...nativeDelivery.results,...authenticatedDelivery.results].sort((a,b)=>binaryDescending(a.createdAt,b.createdAt)||binaryDescending(key(a),key(b))),examined=raw.slice(0,PAGE),items:PortalNotificationHistoryItem[]=[];
    for(const row of examined){if(row.kind==='request'){const current=await authorizeRequest(c.env,principal,session,workspace,resolved.scope.sourceId,row,asOf);if(!current)continue;
        items.push({id:row.id,kind:'request',title:row.title,body:row.body,actionPath:cleanPath(row.actionPath),readAt:row.readAt,createdAt:row.createdAt,mutationPath:`/api/client/notifications/${encodeURIComponent(row.id)}`});}
      else if(row.kind==='delivery'){const current=await authorizeDelivery(c.env,principal,session,workspace,resolved.scope.sourceId,row,asOf);if(!current)continue;
        items.push({id:row.id,kind:'delivery',title:current.title,body:current.body,actionPath:cleanPath(current.actionPath),readAt:current.readAt,createdAt:current.createdAt,mutationPath:`/api/client/notifications/${encodeURIComponent(row.id)}`});}
      else if(row.kind==='native_delivery'){const current=await authorizeNativeDelivery(c.env,principal,session,row,asOf);if(!current)continue;
        items.push({id:row.id,kind:'delivery',title:row.title,body:row.body,actionPath:null,readAt:row.readAt,createdAt:row.createdAt,mutationPath:`/api/client/v2/workspaces/${encodeURIComponent(session.workspaceId!)}/native-delivery-notifications/${encodeURIComponent(row.id)}`});}
      else if(row.kind==='authenticated_delivery'){const current=await authorizeAuthenticatedDelivery(c.env,principal,session,workspace,row,asOf);if(!current)continue;
        items.push({id:row.id,kind:'authenticated_delivery',title:row.title,body:current.body,actionPath:current.actionPath,readAt:current.readAt,createdAt:row.createdAt,mutationPath:`/api/client/notification-history/authenticated-delivery/${encodeURIComponent(row.id)}`});}
      else {const current=await authorizeFeedback(c.env,principal,session,row,resolved.context,asOf);if(!current)continue;
        if(row.body!==(current.completionNote??'Your feedback has been handled.'))continue;
        const suffix=session.nativeSourceId?`/api/client/v2/workspaces/${encodeURIComponent(session.workspaceId!)}/feedback-notifications`:'/api/client/feedback-notifications';
        items.push({id:row.id,kind:'feedback',title:row.title,body:row.body,actionPath:`/portal/feedback/${encodeURIComponent(current.id)}${session.workspaceId?`?workspace=${encodeURIComponent(session.workspaceId)}`:''}`,readAt:row.readAt,createdAt:row.createdAt,mutationPath:`${suffix}/${encodeURIComponent(row.id)}`});}}
    const final=await scopeFor(c.env,principal,session,workspace);if(!final||await notificationHistoryScope({...final.scope,identityId:portalIdentity(session,workspace)})!==scopeHash)throw new HTTPException(409,{message:'Notification access changed. Refresh this workspace.'});
    const last=examined.at(-1),nextCursor=raw.length>PAGE&&last?await encodeNotificationHistoryCursor(c.env,principal,{v:4,scope:scopeHash,asOf,coverage,water:{requests:requestWater,feedback:feedbackWater,nativeDelivery:nativeDeliveryWater,authenticatedDelivery:authenticatedDeliveryWater},after:[last.createdAt,key(last)],expires:Date.now()+TTL}):null;
    const response:PortalNotificationHistoryPage={scope:resolved.scope,asOf,coverage:{...coverage,delivery:session.nativeSourceId?(coverage.nativeDelivery==='included'?'included_project_alpha_grant_notices':'omitted_schema_unavailable'):coverage.requests==='included'?'included_legacy_portal_notices':'omitted_no_explicit_grant_authority'},items,nextCursor};return c.json(response);
  });return router;}

/** Native delivery state is deliberately separate from the immutable producer
 * event. This adapter never updates mail, batch, receipt, grant, or event rows. */
export async function mutateNativeDeliveryNotification(env:Env,principal:VerifiedClientPrincipal,session:ClientPortalSession,eventId:string,action:'read'|'dismiss',beforeWrite?:()=>Promise<void>){
  if(!session.nativeSourceId||!session.workspaceId||!session.nativePortalIdentityId||!await nativeDeliverySchemaAvailable(env))return false;
  const row=await db(env).prepare(`SELECT event.rowid,event.id,'native_delivery' kind,'Delivery access granted' title,
    'You have been granted access to a Project Alpha delivery.' body,NULL actionPath,state.read_at readAt,event.created_at createdAt
    FROM native_delivery_recipient_events event LEFT JOIN native_delivery_recipient_event_state state
      ON state.event_id=event.id AND state.recipient_identity_id=? WHERE event.id=? AND event.source_id=? AND event.workspace_id=?`)
    .bind(session.nativePortalIdentityId,eventId,session.nativeSourceId,session.workspaceId).first<Raw>();
  if(!row||!await authorizeNativeDelivery(env,principal,session,row,new Date().toISOString()))return false;
  const guard=await nativeDeliveryMutationGuard(env,principal,session,eventId);if(!guard)return false;
  // Test-only caller hook establishes that the statement's own guard, rather
  // than the preceding read, is the authorization boundary.
  await beforeWrite?.();
  // The event/grant/binding/principal fence is repeated in the statement that
  // creates the first identity state row. It prevents a rebinding from
  // inheriting a prior identity's read state. The materialized guard joins also
  // re-evaluate entitlement, access terms and lineage in this same statement.
  const stamp=action==='read'?'read_at=COALESCE(read_at,datetime(\'now\'))':'dismissed_at=COALESCE(dismissed_at,datetime(\'now\'))';
  const result=await db(env).prepare(`WITH ${guard.ctes},native_event_authority AS MATERIALIZED(SELECT event.id
    FROM native_delivery_recipient_events event
    JOIN project_alpha_delivery_portal_grants grant_record ON grant_record.id=event.grant_id AND grant_record.workspace_id=event.workspace_id
      AND grant_record.grant_version=event.grant_version AND grant_record.folder_binding_id=event.folder_binding_id
      AND grant_record.binding_source_version=event.binding_source_version
      AND grant_record.audience_type='principal' AND grant_record.audience_public_id=event.principal_public_id
      AND grant_record.audience_source_version=event.principal_source_version AND grant_record.status='active' AND grant_record.revoked_at IS NULL
      AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))
    JOIN project_alpha_delivery_intent_receipts receipt ON receipt.receipt_id=event.receipt_id AND receipt.project_alpha_source_id=event.source_id
      AND receipt.resource_id=event.grant_id AND receipt.access_mode='portal' AND receipt.status='accepted'
    JOIN portal_v2_folder_bindings binding ON binding.id=event.folder_binding_id AND binding.workspace_id=event.workspace_id
      AND binding.source_version=event.binding_source_version AND binding.owner_scope_type=event.owner_scope_type AND binding.owner_public_id=event.owner_public_id
      AND binding.r2_prefix=event.r2_prefix AND binding.status='active' AND binding.revoked_at IS NULL
    JOIN pa_portal_principals principal_record ON principal_record.workspace_id=event.workspace_id AND principal_record.public_id=event.principal_public_id
      AND principal_record.source_version=event.principal_source_version AND principal_record.status='active'
    JOIN portal_v2_identities current_identity ON current_identity.id=? AND current_identity.issuer=? AND current_identity.subject=? AND current_identity.status='active' AND current_identity.revoked_at IS NULL
    WHERE event.id=? AND event.source_id=? AND event.workspace_id=? AND event.event_type='grant_accepted'
      AND lower(principal_record.email_hint)=lower(current_identity.verified_email)
      AND (principal_record.identity_id=current_identity.id OR (principal_record.identity_id IS NULL AND EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_bindings eligibility WHERE eligibility.identity_id=current_identity.id AND eligibility.workspace_id=event.workspace_id AND eligibility.principal_public_id=event.principal_public_id AND eligibility.principal_source_version=event.principal_source_version AND eligibility.verified_email=current_identity.verified_email)))
    ) INSERT INTO native_delivery_recipient_event_state(event_id,recipient_identity_id,read_at,dismissed_at)
    SELECT id,?,CASE WHEN ?='read' THEN datetime('now') END,CASE WHEN ?='dismiss' THEN datetime('now') END
    FROM native_event_authority ${guard.from} WHERE ${guard.sql}
    ON CONFLICT(event_id,recipient_identity_id) DO UPDATE SET ${stamp},updated_at=datetime('now')`)
    .bind(...guard.bindings,session.nativePortalIdentityId,principal.issuer,principal.subject,eventId,session.nativeSourceId,session.workspaceId,
      session.nativePortalIdentityId,action,action).run();
  return Boolean(result.meta.changes);
}
