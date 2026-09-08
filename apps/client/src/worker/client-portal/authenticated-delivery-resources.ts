import {Hono,type Context} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {isMovedSourceMarker} from '@ltds/shared';
import type {Env} from '../types';
import type {ClientPortalSession,VerifiedClientPrincipal,ClientPortalFile,ClientFilePage} from './types';
import type {EffectivePortalWorkspaceContext} from './workspace-v2';
import {decodeAuthenticatedDeliveryHandle,encodeAuthenticatedDeliveryHandle,type AuthenticatedDeliveryHandle} from './authenticated-delivery-handles';
import {readAuthenticatedDeliveryResource} from './notification-history';
import {isHiddenKey,kindForKey,normalizeRoot,parseRange,safeFileName,validateRelativePath} from '../files';
import {appendAuthenticatedContentStart,authenticatedContentAuditRequired} from './authenticated-content-audit';

type Bindings={Bindings:Env;Variables:{clientSession:ClientPortalSession;clientPrincipal:VerifiedClientPrincipal;clientWorkspace:EffectivePortalWorkspaceContext|null}};
type Ctx=Context<Bindings>;
type Event=NonNullable<Awaited<ReturnType<typeof readAuthenticatedDeliveryResource>>>;
type FileRow={r2_key:string;etag:string;size:number;uploaded_at:string;content_type:string|null};
const PAGE=25;
const unavailable=():never=>{throw new HTTPException(404,{message:'Shared delivery is unavailable. Your access or the file may have changed.'});};
const database=(env:Env)=>env.DELIVERY_DB.withSession('first-primary');
const canonicalEtag=(value:string)=>value.trim().replace(/^W\//,'').replace(/^"|"$/g,'');
const visibleSql=`instr(lower('/'||f.r2_key||'/'),'/_ltds/')=0 AND instr(lower('/'||f.r2_key||'/'),'/.previews/')=0
  AND instr(lower('/'||f.r2_key||'/'),'/dump/')=0 AND NOT EXISTS(SELECT 1 FROM delivery_tombstones t
    WHERE t.restored_at IS NULL AND (t.physical_key=f.r2_key OR (t.tombstone_kind='prefix' AND substr(f.r2_key,1,length(t.physical_key))=t.physical_key)))`;
function prefixFor(event:Event):string{
  try{if(event.r2_prefix.length>1024||normalizeRoot(event.r2_prefix)!==event.r2_prefix||isHiddenKey(event.r2_prefix))return unavailable();}
  catch{return unavailable();}
  return event.r2_prefix;
}
function relative(path:string,folder:boolean):string{
  if(path===''&&folder)return path;
  try{const bare=folder?path.slice(0,-1):path;if((folder&&!path.endsWith('/'))||validateRelativePath(bare)!==bare)return unavailable();}
  catch{return unavailable();}
  return path;
}
function exactQuery(c:Ctx,allowed:string[]):void{
  const query=c.req.queries();
  if(Object.keys(query).some(key=>!allowed.includes(key))||Object.values(query).some(values=>values.length!==1))
    throw new HTTPException(400,{message:'Shared delivery query is invalid'});
}
async function decode(c:Ctx,raw:string|undefined,kind:AuthenticatedDeliveryHandle['kind']):Promise<AuthenticatedDeliveryHandle>{
  const handle=raw?await decodeAuthenticatedDeliveryHandle(c.env,raw):null;
  if(!handle||handle.kind!==kind)return unavailable();return handle;
}
/** Always look up the immutable event using the currently verified actor.
 * Handle decryption, a matching email, or a different overlapping grant is
 * never sufficient authority. */
async function authorize(c:Ctx,handle:AuthenticatedDeliveryHandle):Promise<Event>{
  if(handle.expires<=Date.now())return unavailable();
  const event=await readAuthenticatedDeliveryResource(c.env,c.get('clientPrincipal'),c.get('clientSession'),c.get('clientWorkspace'),handle.eventId);
  if(!event||event.source_id!==handle.sourceId||event.workspace_id!==handle.workspaceId||event.identity_id!==handle.identityId
    ||event.grant_id!==handle.grantId||event.grant_version!==handle.grantVersion||event.folder_binding_id!==handle.bindingId
    ||event.binding_source_version!==handle.bindingSourceVersion)return unavailable();
  prefixFor(event);relative(handle.path,handle.kind!=='file');return event;
}
function sameScope(a:AuthenticatedDeliveryHandle,b:AuthenticatedDeliveryHandle):boolean{
  return a.sourceId===b.sourceId&&a.workspaceId===b.workspaceId&&a.identityId===b.identityId&&a.eventId===b.eventId
    &&a.grantId===b.grantId&&a.grantVersion===b.grantVersion&&a.bindingId===b.bindingId
    &&a.bindingSourceVersion===b.bindingSourceVersion&&a.path===b.path;
}
function coordinates(handle:AuthenticatedDeliveryHandle){
  return {v:1 as const,sourceId:handle.sourceId,workspaceId:handle.workspaceId,identityId:handle.identityId,eventId:handle.eventId,
    grantId:handle.grantId,grantVersion:handle.grantVersion,bindingId:handle.bindingId,bindingSourceVersion:handle.bindingSourceVersion,expires:handle.expires};
}
function fileDto(row:FileRow,id:string):ClientPortalFile{
  const kind=kindForKey(row.r2_key),query=new URLSearchParams({file:id});
  return {id,name:row.r2_key.split('/').at(-1)??'File',size:row.size,uploadedAt:row.uploaded_at,contentType:row.content_type,kind,
    previewPath:kind==='other'?null:`/api/client/authenticated-deliveries/preview?${query}`,thumbnailPath:null,
    downloadPath:`/api/client/authenticated-deliveries/download?${query}`};
}
async function readFile(c:Ctx,handle:AuthenticatedDeliveryHandle,event:Event):Promise<FileRow>{
  if(handle.kind!=='file')return unavailable();
  const row=await database(c.env).prepare(`SELECT f.r2_key,f.etag,f.size,f.uploaded_at,f.content_type
    FROM file_index f WHERE f.r2_key=? AND ${visibleSql}`).bind(prefixFor(event)+relative(handle.path,false)).first<FileRow>();
  if(!row||row.etag!==handle.etag||!Number.isSafeInteger(row.size)||row.size<0)return unavailable();return row;
}

/** Exact grant-bound resources for notification links from an effective
 * workspace. This router never invokes the legacy archive/project loaders. */
export function createAuthenticatedDeliveryResourceRouter():Hono<Bindings>{
  const router=new Hono<Bindings>();
  router.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});
  router.get('/files',async c=>{
    exactQuery(c,['folder','cursor']);
    const raw=c.req.query('folder'),handle=await decode(c,raw,'folder'),event=await authorize(c,handle);
    const cursor=c.req.query('cursor')?await decode(c,c.req.query('cursor'),'cursor'):null;
    if(cursor&&(!sameScope(cursor,handle)||cursor.kind!=='cursor'))return unavailable();
    const prefix=prefixFor(event)+relative(handle.path,true);
    // A canonical folder always ends with '/', whose successor is '0'. This
    // bounds the indexed scan to only this folder's subtree, not its siblings.
    const upper=prefix.slice(0,-1)+'0';
    const rows=await database(c.env).prepare(`WITH candidates AS (
      SELECT f.r2_key,f.etag,f.size,f.uploaded_at,f.content_type,substr(f.r2_key,length(?)+1) relative_key
      FROM file_index f WHERE f.r2_key>=? AND f.r2_key<? AND ${visibleSql}
    ), entries AS (
      SELECT 'folder' entry_kind,substr(relative_key,1,instr(relative_key,'/')-1) entry_name,
        NULL r2_key,NULL etag,NULL size,NULL uploaded_at,NULL content_type
      FROM candidates WHERE instr(relative_key,'/')>0 GROUP BY substr(relative_key,1,instr(relative_key,'/')-1)
      UNION ALL SELECT 'file',relative_key,r2_key,etag,size,uploaded_at,content_type FROM candidates
      WHERE relative_key<>'' AND instr(relative_key,'/')=0)
      SELECT * FROM entries WHERE (entry_name,entry_kind)>(?,?) ORDER BY entry_name,entry_kind LIMIT ?`)
      .bind(prefix,prefix,upper,cursor?.kind==='cursor'?cursor.after:'',cursor?.kind==='cursor'?cursor.entryKind:'',PAGE+1)
      .all<FileRow&{entry_kind:'folder'|'file';entry_name:string}>();
    const page=rows.results.slice(0,PAGE),files:ClientPortalFile[]=[],folders:Array<{id:string;name:string}>=[],base=coordinates(handle);
    for(const row of page){
      if(row.entry_kind==='folder')folders.push({id:await encodeAuthenticatedDeliveryHandle(c.env,{...base,kind:'folder',path:relative(handle.path+row.entry_name+'/',true)}),name:row.entry_name});
      else{
        const id=await encodeAuthenticatedDeliveryHandle(c.env,{...base,kind:'file',path:relative(handle.path+row.entry_name,false),etag:row.etag});
        files.push(fileDto(row,id));
      }
    }
    const breadcrumbs:Array<{id:string;name:string}>=[{id:await encodeAuthenticatedDeliveryHandle(c.env,{...base,kind:'folder',path:''}),name:'Shared delivery'}];
    let path='';for(const name of handle.path.split('/').filter(Boolean)){path+=name+'/';breadcrumbs.push({id:await encodeAuthenticatedDeliveryHandle(c.env,{...base,kind:'folder',path}),name});}
    const last=page.at(-1),next=rows.results.length>PAGE&&last?await encodeAuthenticatedDeliveryHandle(c.env,{...base,kind:'cursor',path:handle.path,after:last.entry_name,entryKind:last.entry_kind}):null;
    await authorize(c,handle);
    const result:ClientFilePage={files,folders,breadcrumbs,folderId:raw!,prefix:'',cursor:next};return c.json(result);
  });
  async function media(c:Ctx,disposition:'inline'|'attachment'){
    exactQuery(c,['file']);
    const handle=await decode(c,c.req.query('file'),'file'),event=await authorize(c,handle),row=await readFile(c,handle,event);
    const type=(row.content_type??'application/octet-stream').split(';')[0]!.trim().toLowerCase();
    if(disposition==='inline'&&!/^(application\/(pdf|json)|text\/(plain|csv)|image\/(avif|gif|jpeg|png|webp)|audio\/(aac|flac|mpeg|ogg|wav|webm)|video\/(mp4|mpeg|ogg|quicktime|webm))$/.test(type))
      throw new HTTPException(415,{message:'Preview unavailable'});
    await authorize(c,handle);
    const head=await c.env.DATA_BUCKET.head(row.r2_key);
    if(!head||isMovedSourceMarker(head)||canonicalEtag(head.httpEtag)!==canonicalEtag(row.etag)||head.size!==row.size)return unavailable();
    await authorize(c,handle);await readFile(c,handle,event);
    let range:ReturnType<typeof parseRange>;
    try{range=parseRange(!c.req.header('If-Range')||c.req.header('If-Range')===head.httpEtag?c.req.header('Range'):undefined,head.size);
      if(range&&head.size===0)throw new Error('Empty range');}
    catch{return new Response(null,{status:416,headers:{'Accept-Ranges':'bytes','Content-Range':`bytes */${head.size}`,'Cache-Control':'private, no-store'}});}
    const headers=new Headers({'Content-Type':disposition==='inline'&&(type.startsWith('text/')||type==='application/json')?'text/plain; charset=utf-8':row.content_type??'application/octet-stream',
      'Content-Disposition':`${disposition}; filename="${safeFileName(row.r2_key)}"; filename*=UTF-8''${encodeURIComponent(row.r2_key.split('/').at(-1)??'file')}`,
      'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",
      'ETag':head.httpEtag,'Accept-Ranges':'bytes','Content-Length':String(range?.length??head.size)});
    if(range)headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${head.size}`);
    await authorize(c,handle);await readFile(c,handle,event);
    if(c.req.method==='HEAD')return new Response(null,{status:range?206:200,headers});
    if(!range&&c.req.header('If-None-Match')===head.httpEtag){headers.delete('Content-Length');return new Response(null,{status:304,headers});}
    const object=await c.env.DATA_BUCKET.get(row.r2_key,{...(range?{range}:{}),onlyIf:{etagMatches:head.etag}});
    if(!object||!('body' in object))return unavailable();
    if(isMovedSourceMarker(object)||object.etag!==head.etag){await object.body.cancel();return unavailable();}
    try{
      await authorize(c,handle);await readFile(c,handle,event);
      if(await authenticatedContentAuditRequired(c.env)){
        await appendAuthenticatedContentStart(c.env,{
          authorityMode:'native_delivery',grantSource:'authenticated_delivery',recipientEventId:event.id,batchId:event.batch_id,
          sourceId:event.source_id,workspaceId:event.workspace_id,identityId:event.identity_id,
          projectPublicId:event.owner_scope_type==='project'?event.owner_public_id:null,
          folderBindingId:event.folder_binding_id,grantId:event.grant_id,grantVersion:event.grant_version,
          bindingSourceVersion:event.binding_source_version,ownerScopeType:event.owner_scope_type,ownerPublicId:event.owner_public_id,
          action:disposition==='inline'?'file.preview_requested':'file.download_requested',storageKey:row.r2_key,contentVersion:row.etag,
        });
        await authorize(c,handle);await readFile(c,handle,event);
      }
    }catch(error){await object.body.cancel().catch(()=>{});if(error instanceof HTTPException)throw error;
      throw new HTTPException(503,{message:'File access verification is temporarily unavailable'});}
    return new Response(object.body,{status:range?206:200,headers});
  }
  router.on(['GET','HEAD'],'/preview',c=>media(c,'inline'));
  router.on(['GET','HEAD'],'/download',c=>media(c,'attachment'));
  return router;
}
