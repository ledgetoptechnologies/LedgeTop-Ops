import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import type {PortalNotificationHistoryItem,PortalNotificationHistoryPage} from '@ltds/shared';
import type {Env} from '../types';
import type {ClientPortalSession,VerifiedClientPrincipal} from './types';
import type {EffectivePortalWorkspaceContext,NativePortalReadContext} from './workspace-v2';
import {authorizeEffectiveWorkspaceNotification,resolveNativePortalWorkspaceReadContext} from './workspace-v2';
import {nativeRequestSchemaReady,nativeServiceRequestsEnabled,resolveNativeRequestAuthority} from './native-request-authority';
import {readFeedbackRecord} from './feedback-store';
import {reauthorizeFeedbackRecipient} from './feedback-target';
import {readNativeFeedbackRecord} from './native-feedback-store';
import {nativeFeedbackSchemaAvailable} from './native-feedback-store';
import {reauthorizeNativeFeedbackRecipient} from './native-feedback-target';
import {nativeFeedbackEnabledForContext,nativeFeedbackNotificationsSchemaAvailable} from './native-feedback-authority';
import {decodeNotificationHistoryCursor,encodeNotificationHistoryCursor,notificationHistoryScope} from './notification-history-cursor';

type Variables={clientSession:ClientPortalSession;clientPrincipal:VerifiedClientPrincipal;clientWorkspace:EffectivePortalWorkspaceContext|null};
const PAGE=25,TTL=15*60_000;
type Raw={rowid:number;id:string;kind:'request'|'feedback'|'delivery';title:string;body:string;actionPath:string|null;readAt:string|null;createdAt:string};
type LedgerCoverage='included'|'omitted_feature_disabled'|'omitted_schema_unavailable';
type Dependencies={notificationSchemaAvailable:(env:Env)=>Promise<boolean>;feedbackSchemaAvailable:(env:Env)=>Promise<boolean>};
export function notificationHistoryCoverage(input:{native:boolean;notifications:boolean;primaryFeedback:boolean;nativeRequestsEnabled:boolean;nativeRequestSchema:boolean;nativeFeedbackEnabled:boolean;nativeFeedbackSchema:boolean}):{requests:LedgerCoverage;feedback:LedgerCoverage}{
  if(!input.native)return {requests:input.notifications?'included':'omitted_schema_unavailable',feedback:input.primaryFeedback?'included':'omitted_schema_unavailable'};
  return {requests:!input.nativeRequestsEnabled?'omitted_feature_disabled':!input.notifications||!input.nativeRequestSchema?'omitted_schema_unavailable':'included',
    feedback:!input.nativeFeedbackEnabled?'omitted_feature_disabled':!input.nativeFeedbackSchema?'omitted_schema_unavailable':'included'};
}
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

async function currentCoverage(env:Env,session:ClientPortalSession,native:NativePortalReadContext|null,deps:Dependencies):Promise<{requests:LedgerCoverage;feedback:LedgerCoverage}>{
  const notifications=await deps.notificationSchemaAvailable(env);
  if(!session.nativeSourceId)return notificationHistoryCoverage({native:false,notifications,primaryFeedback:await deps.feedbackSchemaAvailable(env),nativeRequestsEnabled:false,nativeRequestSchema:false,nativeFeedbackEnabled:false,nativeFeedbackSchema:false});
  const nativeRequestsEnabled=nativeServiceRequestsEnabled(env),nativeFeedbackEnabled=!!native&&nativeFeedbackEnabledForContext(env,native);
  return notificationHistoryCoverage({native:true,notifications,primaryFeedback:false,nativeRequestsEnabled,nativeRequestSchema:nativeRequestsEnabled&&await nativeRequestSchemaReady(env),nativeFeedbackEnabled,
    nativeFeedbackSchema:nativeFeedbackEnabled&&await nativeFeedbackSchemaAvailable(env)&&await nativeFeedbackNotificationsSchemaAvailable(env)});
}
export function createClientNotificationHistoryRouter(deps:Dependencies){const router=new Hono<{Bindings:Env;Variables:Variables}>();
  router.get('/notification-history',async c=>{const query=c.req.queries();if(Object.keys(query).some(k=>k!=='cursor')||Object.values(query).some(v=>v.length!==1))throw new HTTPException(400,{message:'Notification query is invalid'});
    const principal=c.get('clientPrincipal'),session=c.get('clientSession'),workspace=c.get('clientWorkspace'),resolved=await scopeFor(c.env,principal,session,workspace);if(!resolved)throw new HTTPException(404,{message:'Notifications not found'});
    const scopeHash=await notificationHistoryScope({...resolved.scope,identityId:session.nativePortalIdentityId??session.identityId}),encoded=c.req.query('cursor'),cursor=encoded?await decodeNotificationHistoryCursor(c.env,principal,encoded):null;
    if(encoded&&(!cursor||cursor.scope!==scopeHash||cursor.expires<Date.now()))throw new HTTPException(409,{message:'Notification page changed. Refresh this workspace.'});
    const readiness=await currentCoverage(c.env,session,resolved.context,deps),coverage=cursor?.coverage??readiness;
    if(cursor&&coverage.requests==='included'&&readiness.requests!=='included')throw new HTTPException(readiness.requests==='omitted_schema_unavailable'?503:409,{message:'Notification history availability changed. Refresh this workspace.'});
    if(cursor&&coverage.feedback==='included'&&readiness.feedback!=='included')throw new HTTPException(readiness.feedback==='omitted_schema_unavailable'?503:409,{message:'Notification history availability changed. Refresh this workspace.'});
    const asOf=cursor?.asOf??new Date().toISOString(),requestWater=coverage.requests!=='included'?0:cursor?.water.requests??Number(await db(c.env).prepare('SELECT COALESCE(MAX(rowid),0) water FROM client_portal_notifications').first('water')??0),
      feedbackWater=coverage.feedback!=='included'?0:cursor?.water.feedback??Number(await db(c.env).prepare(session.nativeSourceId?'SELECT COALESCE(MAX(rowid),0) water FROM portal_native_feedback_notifications':'SELECT COALESCE(MAX(rowid),0) water FROM client_feedback_notifications').first('water')??0);
    const [requests,feedback]=await Promise.all([coverage.requests==='included'?requestRows(c.env,session,requestWater,asOf,cursor?.after):Promise.resolve({results:[]} as {results:Raw[]}),coverage.feedback==='included'?feedbackRows(c.env,principal,session,workspace?.identityId??null,feedbackWater,asOf,cursor?.after):Promise.resolve({results:[]} as {results:Raw[]})]);
    const raw=[...requests.results,...feedback.results].sort((a,b)=>binaryDescending(a.createdAt,b.createdAt)||binaryDescending(key(a),key(b))),examined=raw.slice(0,PAGE),items:PortalNotificationHistoryItem[]=[];
    for(const row of examined){if(row.kind==='request'){const current=await authorizeRequest(c.env,principal,session,workspace,resolved.scope.sourceId,row,asOf);if(!current)continue;
        items.push({id:row.id,kind:'request',title:row.title,body:row.body,actionPath:cleanPath(row.actionPath),readAt:row.readAt,createdAt:row.createdAt,mutationPath:`/api/client/notifications/${encodeURIComponent(row.id)}`});}
      else if(row.kind==='delivery'){const current=await authorizeDelivery(c.env,principal,session,workspace,resolved.scope.sourceId,row,asOf);if(!current)continue;
        items.push({id:row.id,kind:'delivery',title:current.title,body:current.body,actionPath:cleanPath(current.actionPath),readAt:current.readAt,createdAt:current.createdAt,mutationPath:`/api/client/notifications/${encodeURIComponent(row.id)}`});}
      else {const current=await authorizeFeedback(c.env,principal,session,row,resolved.context,asOf);if(!current)continue;
        if(row.body!==(current.completionNote??'Your feedback has been handled.'))continue;
        const suffix=session.nativeSourceId?`/api/client/v2/workspaces/${encodeURIComponent(session.workspaceId!)}/feedback-notifications`:'/api/client/feedback-notifications';
        items.push({id:row.id,kind:'feedback',title:row.title,body:row.body,actionPath:`/portal/feedback/${encodeURIComponent(current.id)}${session.workspaceId?`?workspace=${encodeURIComponent(session.workspaceId)}`:''}`,readAt:row.readAt,createdAt:row.createdAt,mutationPath:`${suffix}/${encodeURIComponent(row.id)}`});}}
    const final=await scopeFor(c.env,principal,session,workspace);if(!final||await notificationHistoryScope({...final.scope,identityId:session.nativePortalIdentityId??session.identityId})!==scopeHash)throw new HTTPException(409,{message:'Notification access changed. Refresh this workspace.'});
    const last=examined.at(-1),nextCursor=raw.length>PAGE&&last?await encodeNotificationHistoryCursor(c.env,principal,{v:2,scope:scopeHash,asOf,coverage,water:{requests:requestWater,feedback:feedbackWater},after:[last.createdAt,key(last)],expires:Date.now()+TTL}):null;
    const response:PortalNotificationHistoryPage={scope:resolved.scope,asOf,coverage:{...coverage,delivery:!session.nativeSourceId&&coverage.requests==='included'?'included_legacy_portal_notices':'omitted_no_explicit_grant_authority'},items,nextCursor};return c.json(response);
  });return router;}
