import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { isMovedSourceMarker,type ClientFeedbackDetail,type ClientFeedbackEvent,type ClientFeedbackItem } from '@ltds/shared';
import type { Env } from '../types';
import type { ClientPortalFile, VerifiedClientPrincipal, ClientFilePage } from './types';
import { isHiddenKey, kindForKey, normalizeRoot, parseRange, safeFileName, validateRelativePath } from '../files';
import { nativePortalScopesAllowed, resolveNativePortalWorkspaceReadContext, nativePortalSourceSchemaAvailable,
  type NativePortalReadContext, type PortalDirectoryEntry } from './workspace-v2';
import { readNativeAuthenticatedDeliveryGrants, readNativeAuthenticatedDeliveryPage, nativeDeliveryResourcesReady } from './authenticated-delivery-grants';
import { encodeNativePortalHandle, decodeNativePortalHandle, type NativePortalHandle } from './native-portal-handles';
import { readNativeTargetScopes } from './native-portal-scopes';
import { nativeDirectoryAuthorizationAvailable, nativeWorkspaceFeatureReadiness } from './native-workspace-readiness';
import { createNativeFeedbackRecord,nativeFeedbackSchemaAvailable,readNativeFeedbackRecord,type NativeFeedbackRecord } from './native-feedback-store';
import { nativeFeedbackActionPath,nativeFeedbackTargetInputSchema,reauthorizeNativeFeedbackRecipient,resolveNativeFeedbackTarget,type ResolvedNativeFeedbackTarget } from './native-feedback-target';
import { feedbackFingerprint,FeedbackStoreError } from './feedback-store';
import { nativeRequestSchemaReady, nativeServiceRequestsEnabled } from './native-request-authority';
import { requestAttachmentsAvailable } from './request-attachments';
import { z } from 'zod';
import { clientPortalRequestOriginAllowed } from '../origin-policy';
import { appendAuthenticatedContentStart,authenticatedContentAuditRequired } from './authenticated-content-audit';
import { nativeFeedbackEnabledForContext,nativeFeedbackNotificationsSchemaAvailable } from './native-feedback-authority';

type Bindings = {Bindings:Env;Variables:{clientPrincipal:VerifiedClientPrincipal}};
type Ctx = Context<Bindings>;
type Grant = Awaited<ReturnType<typeof readNativeAuthenticatedDeliveryGrants>>[number];
type FileRow = {r2_key:string;etag:string;size:number;uploaded_at:string;content_type:string|null;media_kind:string};
const PAGE = 25;
const unavailable = ():never => {throw new HTTPException(404,{message:'Delivery is unavailable'});};
const changed = ():never => {throw new HTTPException(409,{message:'Workspace access changed. Refresh this workspace to continue.'});};
const invalid = ():never => {throw new HTTPException(400,{message:'Invalid delivery cursor'});};
const clean = (value:string,max=500) => value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,max);
const canonicalEtag=(value:string)=>value.trim().replace(/^W\//,'').replace(/^"|"$/g,'');
function envelope(context:NativePortalReadContext) {return {workspaceId:context.workspaceId,sourceId:context.sourceId,contextVersion:context.contextVersion};}
function database(env:Env){return env.DELIVERY_DB.withSession('first-primary');}
async function boundedJson(c:Ctx):Promise<unknown>{
  const reader=c.req.raw.body?.getReader();if(!reader)throw new HTTPException(400,{message:'A JSON body is required'});
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>32_768){await reader.cancel();throw new HTTPException(413,{message:'Feedback is too large'});}chunks.push(next.value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new HTTPException(400,{message:'Feedback JSON is invalid'});}
}
function sameOrigin(c:Ctx){if(!clientPortalRequestOriginAllowed(c.req.raw,c.env))
  throw new HTTPException(403,{message:'This request is not allowed'});}
async function nativeFeedbackItem(env:Env,row:NativeFeedbackRecord,resolved:ResolvedNativeFeedbackTarget):Promise<ClientFeedbackItem>{return {
  id:row.id,status:row.status,revision:row.revision,message:row.message,completionNote:row.completionNote,createdAt:row.createdAt,
  updatedAt:row.updatedAt,completedAt:row.completedAt,target:{kind:row.target.kind,projectId:row.target.projectPublicId,label:row.target.label,
    projectName:row.target.projectName,available:resolved.available,actionPath:await nativeFeedbackActionPath(env,resolved)}};}
async function nativeFeedbackDetail(env:Env,row:NativeFeedbackRecord,resolved:ResolvedNativeFeedbackTarget):Promise<ClientFeedbackDetail>{
  const events=await database(env).prepare(`SELECT revision,actor_type actor,status,note,created_at createdAt FROM portal_native_feedback_events
    WHERE feedback_id=? ORDER BY revision LIMIT 4`).bind(row.id).all<ClientFeedbackEvent>();
  if(events.results.length>3)throw new HTTPException(503,{message:'Feedback history is unavailable'});
  return {feedback:await nativeFeedbackItem(env,row,resolved),events:events.results};
}
function feedbackCursor(value:string|undefined):{at:string;id:string}|null{if(!value)return null;try{if(value.length>1024||!/^[A-Za-z0-9_-]+$/.test(value))throw new Error();
  const decoded=JSON.parse(atob(value.replace(/-/g,'+').replace(/_/g,'/')));return z.object({at:z.string().max(40),id:z.string().regex(/^native_[A-Za-z0-9-]+$/)}).strict().parse(decoded);
}catch{throw new HTTPException(409,{message:'Feedback page changed. Refresh this workspace.'});}}
function encodeFeedbackCursor(row:{created_at:string;id:string}){return btoa(JSON.stringify({at:row.created_at,id:row.id})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function notificationCursor(value:string|undefined):{at:string;id:string}|null{if(!value)return null;try{if(value.length>1024||!/^[A-Za-z0-9_-]+$/.test(value))throw new Error();
  const decoded=JSON.parse(atob(value.replace(/-/g,'+').replace(/_/g,'/')));return z.object({at:z.string().max(40),id:z.string().uuid()}).strict().parse(decoded);
}catch{throw new HTTPException(409,{message:'Notification page changed. Refresh this workspace.'});}}
function encodeNotificationCursor(row:{created_at:string;id:string}){return btoa(JSON.stringify({at:row.created_at,id:row.id})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function canonicalPrefix(prefix:string):string {
  if(prefix.length>1024||normalizeRoot(prefix)!==prefix||isHiddenKey(prefix)||/[\u0000-\u001f\u007f]/.test(prefix))return unavailable();
  return prefix;
}
function safeRelative(path:string,folder:boolean):string {
  if(path===''&&folder)return '';
  if(folder&&!path.endsWith('/'))return unavailable();
  const bare=folder?path.slice(0,-1):path;
  try{if(validateRelativePath(bare)!==bare)return unavailable();}catch{return unavailable();}
  return path;
}
function upperBound(prefix:string):string{return prefix.slice(0,-1)+String.fromCharCode(prefix.charCodeAt(prefix.length-1)+1);}
function proof(context:NativePortalReadContext,grant:Grant|undefined,kind:NativePortalHandle['kind'],path=''):NativePortalHandle {
  return {v:1,kind,sourceId:context.sourceId,workspaceId:context.workspaceId,identityId:context.identityId,contextVersion:context.contextVersion,
    bindingId:grant?.folder_binding_id??'',bindingVersion:grant?.binding_source_version??'',grantId:grant?.grant_id??'',grantVersion:grant?.grant_version??0,
    bindingProof:grant?.binding_fingerprint??'',
    path,expires:Date.now()+60*60_000};
}
async function contextFor(c:Ctx):Promise<NativePortalReadContext> {
  const context=await resolveNativePortalWorkspaceReadContext(c.env,c.get('clientPrincipal'),c.req.param('workspaceId')??'');
  if(!context)return unavailable();
  const expected=c.req.query('expectedContext');
  if(expected!==undefined&&expected!==context.contextVersion)return changed();
  return context;
}
async function recheck(c:Ctx,context:NativePortalReadContext):Promise<void> {
  const current=await resolveNativePortalWorkspaceReadContext(c.env,c.get('clientPrincipal'),context.workspaceId);
  if(!current||current.contextVersion!==context.contextVersion)return changed();
}
async function nativeFeedbackReady(c:Ctx,context:NativePortalReadContext):Promise<boolean>{
  return nativeFeedbackEnabledForContext(c.env,context)
    && await nativeFeedbackSchemaAvailable(c.env)
    && await nativeFeedbackNotificationsSchemaAvailable(c.env);
}
async function requireNativeFeedback(c:Ctx,context:NativePortalReadContext):Promise<void>{
  if(!nativeFeedbackEnabledForContext(c.env,context))throw new HTTPException(404,{message:'Feedback is not available'});
  if(!await nativeFeedbackSchemaAvailable(c.env)||!await nativeFeedbackNotificationsSchemaAvailable(c.env))
    throw new HTTPException(503,{message:'Client feedback is not available'});
}
async function decode(c:Ctx,context:NativePortalReadContext,raw:string,kind:NativePortalHandle['kind']):Promise<NativePortalHandle> {
  const handle=await decodeNativePortalHandle(c.env,raw);
  if(!handle||handle.kind!==kind||handle.sourceId!==context.sourceId||handle.workspaceId!==context.workspaceId||handle.identityId!==context.identityId)return unavailable();
  if(handle.contextVersion!==context.contextVersion)return changed();
  return handle;
}
async function grantFor(c:Ctx,context:NativePortalReadContext,handle:NativePortalHandle):Promise<Grant> {
  const grants=await readNativeAuthenticatedDeliveryGrants(c.env,c.get('clientPrincipal'),context,handle.bindingId,{grantId:handle.grantId});
  const grant=grants.find(g=>g.grant_id===handle.grantId&&g.grant_version===handle.grantVersion&&g.binding_source_version===handle.bindingVersion
    && g.binding_fingerprint===handle.bindingProof);
  if(!grant)return unavailable();
  canonicalPrefix(grant.r2_prefix);return grant;
}
function fileDto(context:NativePortalReadContext,row:FileRow,id:string):ClientPortalFile {
  const base=`/api/client/v2/workspaces/${encodeURIComponent(context.workspaceId)}/files/${encodeURIComponent(id)}`;
  const kind=kindForKey(row.r2_key);
  return {id,name:clean(row.r2_key.split('/').at(-1)??'File'),size:row.size,uploadedAt:row.uploaded_at,contentType:row.content_type,
    kind,previewPath:kind==='other'?null:`${base}/preview`,thumbnailPath:null,downloadPath:`${base}/download`};
}
const visibleSql = `instr(lower('/'||f.r2_key||'/'),'/_ltds/')=0 AND instr(lower('/'||f.r2_key||'/'),'/.previews/')=0
  AND instr(lower('/'||f.r2_key||'/'),'/dump/')=0 AND NOT EXISTS(SELECT 1 FROM delivery_tombstones t
    WHERE t.restored_at IS NULL AND (t.physical_key=f.r2_key OR (t.tombstone_kind='prefix' AND substr(f.r2_key,1,length(t.physical_key))=t.physical_key)))`;
async function readFile(c:Ctx,context:NativePortalReadContext,handle:NativePortalHandle,grant:Grant):Promise<FileRow> {
  const key=canonicalPrefix(grant.r2_prefix)+safeRelative(handle.path,false);
  const row=await database(c.env).prepare(`SELECT f.r2_key,f.etag,f.size,f.uploaded_at,f.content_type,f.media_kind
    FROM file_index f WHERE f.r2_key=? AND ${visibleSql}`).bind(key).first<FileRow>();
  if(!row||row.etag!==handle.etag)return unavailable();
  return row;
}

/** Only source-owned native resources. No legacy account/session is created or
 * consulted, and existing primary hierarchy routes fall through untouched. */
export function createNativePortalWorkspaceRouter():Hono<Bindings> {
  const router=new Hono<Bindings>();
  router.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});
  router.get('/:workspaceId/context',async c=>{
    const context=await contextFor(c);
    const directoryRead=await nativeDirectoryAuthorizationAvailable(c.env,context);
    // Capability means this read surface is ready, not a promise of files.
    // Listing every grant just to render the shell was unbounded N+1 work.
    const deliveryView=await nativeDeliveryResourcesReady(c.env);
    const feedback=await nativeFeedbackReady(c,context);
    const serviceRequests=nativeServiceRequestsEnabled(c.env)&&await nativeRequestSchemaReady(c.env);
    const requestAttachments=serviceRequests&&requestAttachmentsAvailable(c.env);
    const features=nativeWorkspaceFeatureReadiness({directoryAuthorized:directoryRead,deliveryBackendReady:deliveryView,
      feedbackBackendReady:feedback,serviceRequestsReady:serviceRequests});
    await recheck(c,context);
    return c.json({workspace:{id:context.workspaceId,sourceId:context.sourceId,displayName:clean(context.displayName),rootType:context.rootType,
      rootPublicId:context.rootPublicId,resourceMode:'native' as const},contextVersion:context.contextVersion,features,capabilities:{directoryRead,deliveryView,
      requestV2:serviceRequests,requestAttachments,feedback:feedback&&directoryRead,manageTeam:false,workspaceMembershipManagement:false,delegatedShares:false,
      viewer:false,viewerShares:false,viewBilling:false}});
  });
  router.post('/:workspaceId/feedback',async c=>{
    sameOrigin(c);const context=await contextFor(c);await requireNativeFeedback(c,context);
    const parsed=z.object({target:nativeFeedbackTargetInputSchema,message:z.string().trim().min(1).max(5000)}).strict().safeParse(await boundedJson(c));
    const key=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/).safeParse(c.req.header('Idempotency-Key'));
    if(!parsed.success||!key.success)throw new HTTPException(400,{message:'Feedback is invalid'});
    const principal=c.get('clientPrincipal'),limiter=c.env.PUBLIC_BULK_RATE_LIMITER;
    if(!limiter?.limit)throw new HTTPException(503,{message:'Feedback submission is unavailable'});
    if(!(await limiter.limit({key:`feedback:${await feedbackFingerprint([principal.issuer,principal.subject])}`})).success)
      throw new HTTPException(429,{message:'Please wait before submitting more feedback'});
    const resolved=await resolveNativeFeedbackTarget(c.env,principal,context,parsed.data.target);
    try{
      const saved=await createNativeFeedbackRecord(database(c.env),resolved,parsed.data.message,key.data);
      const current=await reauthorizeNativeFeedbackRecipient(c.env,saved.record);if(!current)throw new HTTPException(404,{message:'Feedback not found'});
      await recheck(c,context);return c.json({...await nativeFeedbackDetail(c.env,saved.record,current),replayed:saved.replayed},saved.replayed?200:201);
    }catch(error){if(error instanceof FeedbackStoreError)throw new HTTPException(error.code==='invalid'?400:409,{message:error.code==='idempotency_conflict'
      ?'This submission key was already used for different feedback':'Feedback changed. Refresh and try again.'});throw error;}
  });
  router.get('/:workspaceId/feedback',async c=>{
    const context=await contextFor(c);await requireNativeFeedback(c,context);
    const principal=c.get('clientPrincipal'),cursor=feedbackCursor(c.req.query('cursor'));
    const rows=await database(c.env).prepare(`SELECT id,created_at FROM portal_native_feedback WHERE source_id=? AND workspace_id=?
      AND creator_identity_id=? AND principal_issuer=? AND principal_subject=?
      AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT 6`)
      .bind(context.sourceId,context.workspaceId,context.identityId,principal.issuer,principal.subject,cursor?.at??null,cursor?.at??null,cursor?.at??null,cursor?.id??null)
      .all<{id:string;created_at:string}>();
    const examined=rows.results.slice(0,5),items:ClientFeedbackItem[]=[];
    for(const entry of examined){const record=await readNativeFeedbackRecord(database(c.env),entry.id);if(!record)continue;
      const resolved=await reauthorizeNativeFeedbackRecipient(c.env,record);if(resolved)items.push(await nativeFeedbackItem(c.env,record,resolved));}
    await recheck(c,context);return c.json({items,nextCursor:rows.results.length>5?encodeFeedbackCursor(examined.at(-1)!):null});
  });
  router.get('/:workspaceId/feedback/:id',async c=>{
    const context=await contextFor(c);await requireNativeFeedback(c,context);
    const id=c.req.param('id');if(!/^native_[A-Za-z0-9-]+$/.test(id))throw new HTTPException(404,{message:'Feedback not found'});
    const record=await readNativeFeedbackRecord(database(c.env),id),resolved=record?await reauthorizeNativeFeedbackRecipient(c.env,record):null;
    if(!record||!resolved||record.context.sourceId!==context.sourceId||record.context.workspaceId!==context.workspaceId||record.context.identityId!==context.identityId)
      throw new HTTPException(404,{message:'Feedback not found'});
    await recheck(c,context);return c.json(await nativeFeedbackDetail(c.env,record,resolved));
  });
  router.get('/:workspaceId/feedback-notifications',async c=>{
    const context=await contextFor(c);await requireNativeFeedback(c,context);
    const principal=c.get('clientPrincipal'),cursor=notificationCursor(c.req.query('cursor'));
    const rows=await database(c.env).prepare(`SELECT notice.id,notice.feedback_id,notice.feedback_revision,notice.read_at,notice.created_at
      FROM portal_native_feedback_notifications notice
      JOIN portal_native_feedback feedback ON feedback.id=notice.feedback_id
        AND feedback.revision=notice.feedback_revision AND feedback.status='done'
        AND feedback.source_id=notice.source_id AND feedback.workspace_id=notice.workspace_id
        AND feedback.creator_identity_id=notice.recipient_identity_id
        AND feedback.principal_issuer=notice.principal_issuer AND feedback.principal_subject=notice.principal_subject
      WHERE notice.source_id=? AND notice.workspace_id=? AND notice.recipient_identity_id=?
        AND notice.principal_issuer=? AND notice.principal_subject=? AND notice.dismissed_at IS NULL
        AND (? IS NULL OR notice.created_at<? OR (notice.created_at=? AND notice.id<?))
      ORDER BY notice.created_at DESC,notice.id DESC LIMIT 6`)
      .bind(context.sourceId,context.workspaceId,context.identityId,principal.issuer,principal.subject,
        cursor?.at??null,cursor?.at??null,cursor?.at??null,cursor?.id??null)
      .all<{id:string;feedback_id:string;feedback_revision:number;read_at:string|null;created_at:string}>();
    const examined=rows.results.slice(0,5),notifications=[];
    for(const row of examined){
      const record=await readNativeFeedbackRecord(database(c.env),row.feedback_id);
      if(!record||record.revision!==row.feedback_revision)continue;
      const resolved=await reauthorizeNativeFeedbackRecipient(c.env,record);
      if(!resolved||resolved.context.sourceId!==context.sourceId||resolved.context.workspaceId!==context.workspaceId
        ||resolved.context.identityId!==context.identityId||resolved.context.issuer!==principal.issuer||resolved.context.subject!==principal.subject)continue;
      notifications.push({id:row.id,feedbackId:record.id,title:'Feedback completed',body:record.completionNote??'Your feedback has been handled.',
        actionPath:`/portal/feedback/${encodeURIComponent(record.id)}?workspace=${encodeURIComponent(context.workspaceId)}`,
        readAt:row.read_at,createdAt:row.created_at});
    }
    await recheck(c,context);
    return c.json({notifications,nextCursor:rows.results.length>5?encodeNotificationCursor(examined.at(-1)!):null});
  });
  router.patch('/:workspaceId/feedback-notifications/:id',async c=>{
    sameOrigin(c);const context=await contextFor(c);await requireNativeFeedback(c,context);
    const id=z.string().uuid().safeParse(c.req.param('id')),
      action=z.object({action:z.enum(['read','dismiss'])}).strict().safeParse(await boundedJson(c));
    if(!id.success||!action.success)throw new HTTPException(400,{message:'Notification update is invalid'});
    const principal=c.get('clientPrincipal');
    const row=await database(c.env).prepare(`SELECT notice.feedback_id,notice.feedback_revision
      FROM portal_native_feedback_notifications notice
      JOIN portal_native_feedback feedback ON feedback.id=notice.feedback_id
        AND feedback.revision=notice.feedback_revision AND feedback.status='done'
        AND feedback.source_id=notice.source_id AND feedback.workspace_id=notice.workspace_id
        AND feedback.creator_identity_id=notice.recipient_identity_id
        AND feedback.principal_issuer=notice.principal_issuer AND feedback.principal_subject=notice.principal_subject
      WHERE notice.id=? AND notice.source_id=? AND notice.workspace_id=? AND notice.recipient_identity_id=?
        AND notice.principal_issuer=? AND notice.principal_subject=? AND notice.dismissed_at IS NULL`)
      .bind(id.data,context.sourceId,context.workspaceId,context.identityId,principal.issuer,principal.subject)
      .first<{feedback_id:string;feedback_revision:number}>();
    const record=row?await readNativeFeedbackRecord(database(c.env),row.feedback_id):null;
    const resolved=record&&record.revision===row!.feedback_revision?await reauthorizeNativeFeedbackRecipient(c.env,record):null;
    if(!record||!resolved||resolved.context.sourceId!==context.sourceId||resolved.context.workspaceId!==context.workspaceId
      ||resolved.context.identityId!==context.identityId||resolved.context.issuer!==principal.issuer||resolved.context.subject!==principal.subject)
      throw new HTTPException(404,{message:'Notification not found'});
    await recheck(c,context);
    const result=await database(c.env).prepare(`UPDATE portal_native_feedback_notifications AS notice
      SET read_at=COALESCE(read_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        dismissed_at=CASE WHEN ?='dismiss' THEN COALESCE(dismissed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE dismissed_at END
      WHERE notice.id=? AND notice.feedback_id=? AND notice.feedback_revision=?
        AND notice.source_id=? AND notice.workspace_id=? AND notice.recipient_identity_id=?
        AND notice.principal_issuer=? AND notice.principal_subject=? AND notice.dismissed_at IS NULL
        AND EXISTS(SELECT 1 FROM portal_native_feedback feedback WHERE feedback.id=notice.feedback_id
          AND feedback.revision=notice.feedback_revision AND feedback.status='done'
          AND feedback.source_id=notice.source_id AND feedback.workspace_id=notice.workspace_id
          AND feedback.creator_identity_id=notice.recipient_identity_id
          AND feedback.principal_issuer=notice.principal_issuer AND feedback.principal_subject=notice.principal_subject
          AND (${resolved.guard.sql}))`)
      .bind(action.data.action,id.data,record.id,record.revision,context.sourceId,context.workspaceId,context.identityId,
        principal.issuer,principal.subject,...resolved.guard.bindings).run();
    if(Number(result.meta.changes)!==1)throw new HTTPException(409,{message:'Notification access changed'});
    return c.json({success:true});
  });
  router.get('/:workspaceId/hierarchy',async(c,next)=>{
    // Explicit legacy wrappers retain their established response/authorization;
    // signed primary workspaces without an account use the native adapter.
    if(!await nativePortalSourceSchemaAvailable(c.env))return next();
    const workspace=await database(c.env).prepare(`SELECT workspace.project_alpha_source_id,workspace.legacy_account_id,
      EXISTS(SELECT 1 FROM portal_v2_directory_checkpoints checkpoint
        JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
          AND generation.workspace_id=checkpoint.workspace_id AND generation.status='active' AND generation.complete=1
        WHERE checkpoint.workspace_id=workspace.id) native_projection
      FROM portal_v2_workspaces workspace WHERE workspace.id=?`)
      .bind(c.req.param('workspaceId')).first<{project_alpha_source_id:string;legacy_account_id:string|null;native_projection:number}>();
    if(workspace?.project_alpha_source_id==='project-alpha:primary'&&workspace.legacy_account_id!==null)return next();
    // Historical primary hierarchy rows may have neither a legacy bridge nor
    // an activated signed directory. They belong to the mounted compatibility
    // route; only a complete native projection is claimed here.
    if(workspace?.project_alpha_source_id==='project-alpha:primary'&&!workspace.native_projection)return next();
    const context=await contextFor(c),query=(c.req.query('q')??'').trim();
    if(query.length>100)return invalid();
    const cursor=c.req.query('cursor');
    const after=cursor?await decode(c,context,cursor,'cursor'):null;
    if(after&&(after.bindingId!==''||after.path!==`hierarchy:${query}`))return invalid();
    const rows=await database(c.env).prepare(`SELECT e.entity_type,e.public_id,e.parent_public_id,substr(e.display_name,1,500) display_name,e.source_version,
      (SELECT CASE WHEN count(*)=1 THEN min(p.entity_type) ELSE NULL END FROM portal_v2_directory_entities p
        WHERE p.workspace_id=e.workspace_id AND p.generation_id=e.generation_id AND p.public_id=e.parent_public_id AND p.active=1) parent_type
      FROM portal_v2_directory_entities e WHERE e.workspace_id=? AND e.generation_id=? AND e.active=1
        AND (?='' OR instr(lower(e.display_name),lower(?))>0) AND (e.entity_type,e.public_id)>(?,?)
      ORDER BY e.entity_type,e.public_id LIMIT 51`).bind(context.workspaceId,context.generationId,query,query,after?.entryKind??'',after?.after??'')
      .all<{entity_type:PortalDirectoryEntry['type'];public_id:string;parent_public_id:string|null;parent_type:string|null;display_name:string;source_version:string}>();
    const scanned=rows.results.slice(0,50);
    const scopes=await readNativeTargetScopes(c.env,context,scanned.map(e=>({scopeType:e.entity_type,publicId:e.public_id})),{retention:'structural'});
    const expiredProjects=[...new Set([...scopes.values()].flatMap(target=>target.proofRows
      .filter(row=>row.entity_type==='project'&&row.retained===0).map(row=>row.public_id)))];
    // A live explicit delivery term changes only that project's history cutoff.
    // Directory capability and all current denies remain independently required.
    const termGrants=expiredProjects.length&&await nativeDeliveryResourcesReady(c.env)
      ?(await readNativeAuthenticatedDeliveryGrants(c.env,c.get('clientPrincipal'),context,undefined,{projectIds:expiredProjects}))
        .filter(grant=>grant.source==='staff'&&grant.access_terms_id&&grant.terms_live===1):[];
    const entries=[];
    for(const row of scanned){
      const target=scopes.get(`${row.entity_type}:${row.public_id}`);
      const retainedProject=target&&termGrants.find(grant=>target.scopes.has(`project:${grant.owner_public_id}`))?.owner_public_id;
      const allowed=target&&nativePortalScopesAllowed(context,'directory.read',target.scopes,true,target,retainedProject);
      if(allowed)entries.push({type:row.entity_type,publicId:row.public_id,parentPublicId:row.parent_public_id,parentType:row.parent_type,
        displayName:clean(row.display_name),sourceVersion:row.source_version});
    }
    const last=scanned.at(-1);
    const nextCursor=rows.results.length>50&&last?await encodeNativePortalHandle(c.env,{...proof(context,undefined,'cursor',`hierarchy:${query}`),after:last.public_id,entryKind:last.entity_type}):null;
    if(termGrants.length){
      const current=await readNativeAuthenticatedDeliveryGrants(c.env,c.get('clientPrincipal'),context,undefined,{projectIds:expiredProjects});
      if(termGrants.some(grant=>!current.some(now=>now.binding_fingerprint===grant.binding_fingerprint)))return changed();
    }
    await recheck(c,context);return c.json({...envelope(context),entries,page:{nextCursor}});
  });
  router.get('/:workspaceId/deliveries',async c=>{
    const context=await contextFor(c),raw=c.req.query('cursor');
    const cursor=raw?await decode(c,context,raw,'cursor'):null;
    if(cursor&&(cursor.path!=='deliveries'||cursor.bindingId!==''))return invalid();
    const selected=await readNativeAuthenticatedDeliveryPage(c.env,c.get('clientPrincipal'),context,cursor?.after??'');
    const page=selected.grants,items=[];
    for(const grant of page){canonicalPrefix(grant.r2_prefix);items.push({id:await encodeNativePortalHandle(c.env,proof(context,grant,'folder')),
      displayName:clean(grant.owner_name),owner:{type:grant.owner_scope_type,publicId:grant.owner_public_id}});}
    const nextCursor=selected.after?await encodeNativePortalHandle(c.env,{...proof(context,undefined,'cursor','deliveries'),after:selected.after}):null;
    if(page.length){
      const current=await readNativeAuthenticatedDeliveryGrants(c.env,c.get('clientPrincipal'),context,undefined,{bindingIds:page.map(g=>g.folder_binding_id)});
      if(page.some(g=>!current.some(now=>now.binding_fingerprint===g.binding_fingerprint)))return changed();
    }
    await recheck(c,context);return c.json({...envelope(context),items,page:{nextCursor}});
  });
  router.get('/:workspaceId/folders/:folderHandle',async c=>{
    const context=await contextFor(c),raw=c.req.param('folderHandle'),handle=await decode(c,context,raw,'folder'),grant=await grantFor(c,context,handle);
    const path=safeRelative(handle.path,true),prefix=canonicalPrefix(grant.r2_prefix)+path,rawCursor=c.req.query('cursor');
    const cursor=rawCursor?await decode(c,context,rawCursor,'cursor'):null;
    if(cursor&&(cursor.bindingId!==handle.bindingId||cursor.bindingVersion!==handle.bindingVersion||cursor.bindingProof!==handle.bindingProof
      ||cursor.path!==path||cursor.grantId!==handle.grantId||cursor.grantVersion!==handle.grantVersion))return invalid();
    const rows=await database(c.env).prepare(`WITH candidates AS (
      SELECT f.r2_key,f.etag,f.size,f.uploaded_at,f.content_type,f.media_kind,substr(f.r2_key,?) relative_key
      FROM file_index f WHERE f.r2_key>=? AND f.r2_key<? AND ${visibleSql}
    ), entries AS (
      SELECT 'folder' entry_kind,substr(relative_key,1,instr(relative_key,'/')-1) entry_name,
        NULL r2_key,NULL etag,NULL size,NULL uploaded_at,NULL content_type,NULL media_kind
      FROM candidates WHERE instr(relative_key,'/')>0 GROUP BY substr(relative_key,1,instr(relative_key,'/')-1)
      UNION ALL SELECT 'file',relative_key,r2_key,etag,size,uploaded_at,content_type,media_kind
      FROM candidates WHERE relative_key<>'' AND instr(relative_key,'/')=0)
      SELECT * FROM entries WHERE (entry_name,entry_kind)>(?,?) ORDER BY entry_name,entry_kind LIMIT ?`)
      .bind(prefix.length+1,prefix,upperBound(prefix),cursor?.after??'',cursor?.entryKind??'',PAGE+1).all<FileRow&{entry_kind:'folder'|'file';entry_name:string}>();
    const page=rows.results.slice(0,PAGE),files:ClientPortalFile[]=[],folders:Array<{id:string;name:string}>=[];
    for(const row of page){
      const relative=path+row.entry_name;
      if(row.entry_kind==='folder'){safeRelative(relative+'/',true);folders.push({id:await encodeNativePortalHandle(c.env,proof(context,grant,'folder',relative+'/')),name:clean(row.entry_name)});}
      else{safeRelative(relative,false);const id=await encodeNativePortalHandle(c.env,{...proof(context,grant,'file',relative),etag:row.etag});files.push(fileDto(context,row,id));}
    }
    const breadcrumbs:Array<{id:string|null;name:string}>=[{id:await encodeNativePortalHandle(c.env,proof(context,grant,'folder')),name:clean(grant.owner_name)}];
    let accumulated='';for(const part of path.split('/').filter(Boolean)){accumulated+=part+'/';breadcrumbs.push({id:await encodeNativePortalHandle(c.env,proof(context,grant,'folder',accumulated)),name:clean(part)});}
    const last=page.at(-1),nextCursor=rows.results.length>PAGE&&last?await encodeNativePortalHandle(c.env,{...proof(context,grant,'cursor',path),after:last.entry_name,entryKind:last.entry_kind}):null;
    await grantFor(c,context,handle);await recheck(c,context);
    const result:ClientFilePage={files,folders,breadcrumbs,folderId:raw,prefix:'',cursor:nextCursor};return c.json({...result,...envelope(context)});
  });
  router.get('/:workspaceId/files/:fileHandle',async c=>{
    const context=await contextFor(c),raw=c.req.param('fileHandle'),handle=await decode(c,context,raw,'file'),grant=await grantFor(c,context,handle);
    const row=await readFile(c,context,handle,grant);await grantFor(c,context,handle);await recheck(c,context);
    return c.json({...envelope(context),file:fileDto(context,row,raw)});
  });
  async function media(c:Ctx,disposition:'inline'|'attachment'){
    const context=await contextFor(c),handle=await decode(c,context,c.req.param('fileHandle')??'','file'),grant=await grantFor(c,context,handle);
    const row=await readFile(c,context,handle,grant),type=(row.content_type??'application/octet-stream').split(';')[0]!.trim().toLowerCase();
    if(disposition==='inline'&&!/^(application\/(pdf|json)|text\/(plain|csv)|image\/(avif|gif|jpeg|png|webp)|audio\/(aac|flac|mpeg|ogg|wav|webm)|video\/(mp4|mpeg|ogg|quicktime|webm))$/.test(type))throw new HTTPException(415,{message:'Preview unavailable'});
    // No R2 operation before fresh context, grant and exact indexed key checks.
    await grantFor(c,context,handle);await recheck(c,context);
    const head=await c.env.DATA_BUCKET.head(row.r2_key);
    if(!head||isMovedSourceMarker(head)||canonicalEtag(head.httpEtag)!==canonicalEtag(row.etag)||head.size!==row.size)return unavailable();
    let range:ReturnType<typeof parseRange>;
    try{range=parseRange(!c.req.header('If-Range')||c.req.header('If-Range')===head.httpEtag?c.req.header('Range'):undefined,head.size);
      if(range&&head.size===0)throw new Error('Empty range');}
    catch{return new Response(null,{status:416,headers:{'Accept-Ranges':'bytes','Content-Range':`bytes */${head.size}`,'Cache-Control':'private, no-store'}});}
    const headers=new Headers({'Content-Type':disposition==='inline'&&(type.startsWith('text/')||type==='application/json')?'text/plain; charset=utf-8':row.content_type??'application/octet-stream',
      'Content-Disposition':`${disposition}; filename="${safeFileName(row.r2_key)}"; filename*=UTF-8''${encodeURIComponent(row.r2_key.split('/').at(-1)??'file')}`,
      'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','ETag':head.httpEtag,'Accept-Ranges':'bytes','Content-Length':String(range?.length??head.size)});
    if(range)headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${head.size}`);
    await grantFor(c,context,handle);await readFile(c,context,handle,grant);await recheck(c,context);
    if(c.req.method==='HEAD')return new Response(null,{status:range?206:200,headers});
    if(!range&&c.req.header('If-None-Match')===head.httpEtag){headers.delete('Content-Length');return new Response(null,{status:304,headers});}
    const object=await c.env.DATA_BUCKET.get(row.r2_key,{...(range?{range}:{}),onlyIf:{etagMatches:head.etag}});
    if(!object||!('body' in object))return unavailable();
    if(isMovedSourceMarker(object)||object.etag!==head.etag){void object.body.cancel().catch(()=>{});return unavailable();}
    try{await grantFor(c,context,handle);await readFile(c,context,handle,grant);await recheck(c,context);}
    catch(error){void object.body.cancel().catch(()=>{});throw error;}
    const authorizedAt=new Date();
    let auditRequired=false;
    try{auditRequired=await authenticatedContentAuditRequired(c.env);}
    catch{void object.body.cancel().catch(()=>{});throw new HTTPException(503,{message:'File access auditing is temporarily unavailable'});}
    if(auditRequired){
      try{await appendAuthenticatedContentStart(c.env,{
        authorityMode:'native_delivery',sourceId:context.sourceId,workspaceId:context.workspaceId,
        identityId:context.identityId,projectPublicId:grant.owner_scope_type==='project'?grant.owner_public_id:null,
        folderBindingId:grant.folder_binding_id,grantId:grant.grant_id,grantVersion:grant.grant_version,
        grantSource:grant.source,bindingSourceVersion:grant.binding_source_version,
        ownerScopeType:grant.owner_scope_type,ownerPublicId:grant.owner_public_id,
        action:disposition==='inline'?'file.preview_requested':'file.download_requested',
        storageKey:row.r2_key,contentVersion:row.etag,
      },authorizedAt);}
      catch{void object.body.cancel().catch(()=>{});throw new HTTPException(503,{message:'File access auditing is temporarily unavailable'});}
      try{await grantFor(c,context,handle);await readFile(c,context,handle,grant);await recheck(c,context);}
      catch(error){void object.body.cancel().catch(()=>{});throw error;}
    }
    // Once handed off, an in-flight stream cannot be recalled. No bytes are
    // handed to the client before this final fresh authorization check.
    return new Response(object.body,{status:range?206:200,headers});
  }
  router.on(['GET','HEAD'],'/:workspaceId/files/:fileHandle/preview',c=>media(c,'inline'));
  router.on(['GET','HEAD'],'/:workspaceId/files/:fileHandle/download',c=>media(c,'attachment'));
  return router;
}
