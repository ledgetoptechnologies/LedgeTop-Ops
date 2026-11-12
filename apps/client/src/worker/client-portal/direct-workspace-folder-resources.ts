import {Hono,type Context} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {isMovedSourceMarker} from '@ltds/shared';
import type {Env} from '../types';
import type {ClientPortalSession,VerifiedClientPrincipal,ClientPortalFile,ClientFilePage} from './types';
import {isHiddenKey,kindForKey,parseRange,safeFileName,validateRelativePath} from '../files';
import {listAuthorizedDirectWorkspaceFolderResourcesForPrincipal,type DirectWorkspaceFolderResource} from '../operations-portal-direct-folder-grants';

type Bindings={Bindings:Env;Variables:{clientSession:ClientPortalSession;clientPrincipal:VerifiedClientPrincipal}};
type Ctx=Context<Bindings>;
type Kind='folder'|'cursor'|'file';
type Claims={v:1;kind:Kind;workspaceId:string;issuer:string;subject:string;grantId:string;grantVersion:number;
  sourceId:string;targetId:string;targetRevision:number;clientAuthorityId:string;
  path:string;expires:number;after?:string;entryKind?:'folder'|'file';etag?:string};
type FileRow={r2_key:string;etag:string;size:number;uploaded_at:string;content_type:string|null;media_kind:string};
const TTL=15*60_000,PAGE=25;
const unavailable=():never=>{throw new HTTPException(404,{message:'Shared folder is unavailable'});};
const temporary=():never=>{throw new HTTPException(503,{message:'Shared folder access is temporarily unavailable'});};
const db=(c:Ctx)=>c.env.DELIVERY_DB.withSession('first-primary');
const canonicalPath=(value:string,folder:boolean)=>{
  if(value.length>2048||value!==value.normalize('NFC')||value.startsWith('/')||value.includes('\\')||/[\u0000-\u001f\u007f]/u.test(value))return false;
  if(folder){if(value!==''&&!value.endsWith('/'))return false;if(value)value=value.slice(0,-1);}
  else if(!value||value.endsWith('/'))return false;
  return value===''?folder:value.split('/').every(part=>part.length>0&&part.length<=255&&part!=='.'&&part!=='..');
};
const text=(value:unknown,max=512):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value);
function strictClaims(value:unknown):Claims|null{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const x=value as Record<string,unknown>,base=['v','kind','workspaceId','issuer','subject','grantId','grantVersion','sourceId','targetId',
    'targetRevision','clientAuthorityId','path','expires'];
  const allowed=x.kind==='cursor'?[...base,'after','entryKind']:x.kind==='file'?[...base,'etag']:base;
  if(Object.keys(x).length!==allowed.length||Object.keys(x).some(key=>!allowed.includes(key))||x.v!==1
    ||!['folder','cursor','file'].includes(String(x.kind))||!text(x.workspaceId,128)||!text(x.issuer)||!text(x.subject)
    ||!text(x.grantId,128)||!Number.isSafeInteger(x.grantVersion)||Number(x.grantVersion)<1||!text(x.sourceId,128)
    ||!text(x.targetId,128)||!Number.isSafeInteger(x.targetRevision)||Number(x.targetRevision)<1||!text(x.clientAuthorityId,128)
    ||typeof x.path!=='string'||!canonicalPath(x.path,x.kind!=='file')||!Number.isSafeInteger(x.expires)
    ||Number(x.expires)<=Date.now()||Number(x.expires)>Date.now()+TTL+60_000)return null;
  if(x.kind==='cursor'&&(!text(x.after,1024)||String(x.after).includes('/')||String(x.after).includes('\\')
    ||!['folder','file'].includes(String(x.entryKind))))return null;
  if(x.kind==='file'&&!text(x.etag,256))return null;
  return x as unknown as Claims;
}
function b64(bytes:Uint8Array){let raw='';for(const byte of bytes)raw+=String.fromCharCode(byte);return btoa(raw).replace(/\+/gu,'-').replace(/\//gu,'_').replace(/=+$/gu,'');}
async function encryptionKey(secret:string){
  if(secret.length<32)throw new Error('direct-folder-handle-key-unavailable');
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`ltds-direct-workspace-folder-v1\0${secret}`));
  return crypto.subtle.importKey('raw',bytes,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
async function encode(c:Ctx,claims:Claims){
  const parsed=strictClaims(claims);if(!parsed)throw new Error('direct-folder-handle-invalid');
  const iv=crypto.getRandomValues(new Uint8Array(12)),cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},
    await encryptionKey(c.env.DELIVERY_SESSION_SECRET),new TextEncoder().encode(JSON.stringify(parsed))));
  const bytes=new Uint8Array(iv.length+cipher.length);bytes.set(iv);bytes.set(cipher,iv.length);return `df1_${b64(bytes)}`;
}
async function decode(env:Pick<Env,'DELIVERY_SESSION_SECRET'>,raw:string):Promise<Claims|null>{
  if(raw.length>8192||!/^df1_[A-Za-z0-9_-]+$/u.test(raw))return null;
  let bytes:Uint8Array;try{const value=raw.slice(4);bytes=Uint8Array.from(atob(value.replace(/-/gu,'+').replace(/_/gu,'/')),ch=>ch.charCodeAt(0));if(b64(bytes)!==value||bytes.length<29)return null;}catch{return null;}
  try{return strictClaims(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},
    await encryptionKey(env.DELIVERY_SESSION_SECRET),bytes.slice(12)))));}catch{return null;}
}
/** Decode only the workspace coordinate needed by the outer portal router.
 * The selected workspace is still checked against the signed-in identity, and
 * the resource router independently revalidates the current grant on use. */
export async function directWorkspaceFolderCoordinate(env:Pick<Env,'DELIVERY_SESSION_SECRET'>,raw:string,expectedKind:'folder'|'file'){
  const claims=await decode(env,raw);
  if(!claims||claims.kind!==expectedKind)return null;
  return {workspaceId:claims.workspaceId};
}
function claimsFor(folder:DirectWorkspaceFolderResource,principal:VerifiedClientPrincipal,path='',kind:Kind='folder'):Claims{
  return {v:1,kind,workspaceId:folder.workspaceId,issuer:principal.issuer,subject:principal.subject,grantId:folder.grantId,
    grantVersion:folder.grantVersion,sourceId:folder.sourceId,targetId:folder.targetId,targetRevision:folder.targetRevision,
    clientAuthorityId:folder.clientAuthorityId,path,expires:Date.now()+TTL};
}
async function currentFolder(c:Ctx,claims:Claims):Promise<DirectWorkspaceFolderResource>{
  const principal=c.get('clientPrincipal'),session=c.get('clientSession');
  if(!session.workspaceId||claims.workspaceId!==session.workspaceId||claims.issuer!==principal.issuer||claims.subject!==principal.subject)return unavailable();
  let resources:DirectWorkspaceFolderResource[];
  try{resources=await listAuthorizedDirectWorkspaceFolderResourcesForPrincipal(c.env,{workspaceId:session.workspaceId,issuer:principal.issuer,subject:principal.subject});}
  catch{return temporary();}
  const folder=resources.find(item=>item.grantId===claims.grantId&&item.grantVersion===claims.grantVersion
    &&item.workspaceId===claims.workspaceId
    &&item.sourceId===claims.sourceId&&item.targetId===claims.targetId&&item.targetRevision===claims.targetRevision);
  if(!folder||isHiddenKey(folder.r2Prefix))return unavailable();
  return folder;
}
function relative(path:string,folder:boolean){
  if(path===''&&folder)return '';
  try{const bare=folder?path.slice(0,-1):path;if((folder&&!path.endsWith('/'))||validateRelativePath(bare)!==bare)return unavailable();}
  catch{return unavailable();}
  return path;
}
const visibleSql=`instr(lower('/'||f.r2_key||'/'),'/_ltds/')=0 AND instr(lower('/'||f.r2_key||'/'),'/.previews/')=0
 AND instr(lower('/'||f.r2_key||'/'),'/dump/')=0 AND NOT EXISTS(SELECT 1 FROM delivery_tombstones tombstone WHERE tombstone.restored_at IS NULL
   AND (tombstone.physical_key=f.r2_key OR (tombstone.tombstone_kind='prefix' AND substr(f.r2_key,1,length(tombstone.physical_key))=tombstone.physical_key)))`;
function fileDto(c:Ctx,row:FileRow,handle:string):ClientPortalFile{
  const query=new URLSearchParams({file:handle}),base='/api/client/direct-workspace-folders',kind=kindForKey(row.r2_key);
  return {id:handle,name:row.r2_key.split('/').at(-1)??'File',size:row.size,uploadedAt:row.uploaded_at,contentType:row.content_type,
    kind,previewPath:kind==='other'?null:`${base}/preview?${query}`,thumbnailPath:null,downloadPath:`${base}/download?${query}`};
}
function metaMatches(row:FileRow,key:string){return row.r2_key===key&&Number.isSafeInteger(row.size)&&row.size>=0;}

/** Project-free, active-workspace direct shares. Handles are encrypted and
 * each request rereads membership, grant, recipient publication and source pins. */
export function createDirectWorkspaceFolderResourceRouter(){
  const router=new Hono<Bindings>();
  router.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');c.header('Cloudflare-CDN-Cache-Control','no-store');
    if(c.env.CLIENT_PORTAL_DIRECT_FOLDER_GRANTS_ENABLED?.trim().toLowerCase()==='false')return c.json({error:'Not found'},404);await next();});
  router.get('/',async c=>{
    const session=c.get('clientSession'),principal=c.get('clientPrincipal');if(!session.workspaceId)return c.json({items:[]});
    let resources:DirectWorkspaceFolderResource[];
    try{resources=await listAuthorizedDirectWorkspaceFolderResourcesForPrincipal(c.env,{workspaceId:session.workspaceId,issuer:principal.issuer,subject:principal.subject});}
    catch{return temporary();}
    const items=[] as Array<{id:string;name:string;expiresAt:string|null}>;
    for(const item of resources){const claims=claimsFor(item,principal);items.push({id:await encode(c,claims),name:item.displayName,expiresAt:item.expiresAt});}
    return c.json({resourceMode:'direct_workspace_folders',items});
  });
  router.get('/:folderHandle/files',async c=>{
    const parent=await decode(c.env,c.req.param('folderHandle'));if(!parent||parent.kind!=='folder')return unavailable();
    const folder=await currentFolder(c,parent),parentPath=relative(parent.path,true),prefix=folder.r2Prefix+parentPath;
    const rawCursor=c.req.query('cursor'),cursor=rawCursor?await decode(c.env,rawCursor):null;
    if(rawCursor&&(!cursor||cursor.kind!=='cursor'||cursor.grantId!==parent.grantId||cursor.grantVersion!==parent.grantVersion
      ||cursor.workspaceId!==parent.workspaceId||cursor.issuer!==parent.issuer||cursor.subject!==parent.subject
      ||cursor.sourceId!==parent.sourceId||cursor.targetId!==parent.targetId
      ||cursor.targetRevision!==parent.targetRevision||cursor.clientAuthorityId!==parent.clientAuthorityId||cursor.path!==parent.path))return unavailable();
    if(cursor)await currentFolder(c,cursor);
    const upper=prefix.slice(0,-1)+'0';
    const rows=await db(c).prepare(`WITH candidates AS(SELECT f.r2_key,f.etag,f.size,f.uploaded_at,f.content_type,f.media_kind,
      substr(f.r2_key,length(?)+1) relative_key FROM file_index f WHERE f.r2_key>=? AND f.r2_key<? AND ${visibleSql}),
      entries AS(SELECT 'folder' entry_kind,substr(relative_key,1,instr(relative_key,'/')-1) entry_name,NULL r2_key,NULL etag,NULL size,
        NULL uploaded_at,NULL content_type,NULL media_kind FROM candidates WHERE instr(relative_key,'/')>0
        GROUP BY substr(relative_key,1,instr(relative_key,'/')-1)
        UNION ALL SELECT 'file',relative_key,r2_key,etag,size,uploaded_at,content_type,media_kind FROM candidates
        WHERE relative_key<>'' AND instr(relative_key,'/')=0)
      SELECT * FROM entries WHERE (entry_name,entry_kind)>(?,?) ORDER BY entry_name,entry_kind LIMIT ?`)
      .bind(prefix,prefix,upper,cursor?.after??'',cursor?.entryKind??'',PAGE+1).all<FileRow&{entry_kind:'folder'|'file';entry_name:string}>();
    if(!rows.success||rows.results.length>PAGE+1)return temporary();
    const page=rows.results.slice(0,PAGE),files:ClientPortalFile[]=[],folders:Array<{id:string;name:string}>=[];
    for(const row of page){
      if(row.entry_kind==='folder'){
        const path=parentPath+validateRelativePath(row.entry_name)+'/';
        folders.push({id:await encode(c,{...claimsFor(folder,c.get('clientPrincipal'),path),kind:'folder'}),name:row.entry_name});
      }else{
        if(!Number.isSafeInteger(row.size)||row.size<0)return unavailable();
        const path=parentPath+validateRelativePath(row.entry_name),claims={...claimsFor(folder,c.get('clientPrincipal'),path,'file'),etag:row.etag};
        const handle=await encode(c,claims);files.push(fileDto(c,row,handle));
      }
    }
    await currentFolder(c,parent);
    const breadcrumbs:Array<{id:string;name:string}>=[{id:await encode(c,{...claimsFor(folder,c.get('clientPrincipal')) ,kind:'folder'}),name:folder.displayName}];
    let built='';for(const part of parentPath.split('/').filter(Boolean)){built+=part+'/';breadcrumbs.push({id:await encode(c,{...claimsFor(folder,c.get('clientPrincipal'),built),kind:'folder'}),name:part});}
    const last=page.at(-1),next=rows.results.length>PAGE&&last?await encode(c,{...claimsFor(folder,c.get('clientPrincipal'),parentPath,'cursor'),after:last.entry_name,entryKind:last.entry_kind}):null;
    const result:ClientFilePage={files,folders,breadcrumbs,folderId:c.req.param('folderHandle'),prefix:'',cursor:next};return c.json(result);
  });
  async function fileFor(c:Ctx,raw:string):Promise<{claims:Claims;folder:DirectWorkspaceFolderResource;row:FileRow;key:string}>{
    const claims=await decode(c.env,raw);if(!claims||claims.kind!=='file')return unavailable();
    const folder=await currentFolder(c,claims),path=relative(claims.path,false),key=folder.r2Prefix+path;
    const row=await db(c).prepare(`SELECT f.r2_key,f.etag,f.size,f.uploaded_at,f.content_type,f.media_kind FROM file_index f
      WHERE f.r2_key=? AND ${visibleSql}`).bind(key).first<FileRow>();
    if(!row||!metaMatches(row,key)||row.etag!==claims.etag)return unavailable();return {claims,folder,row,key};
  }
  router.get('/files/:fileHandle',async c=>{const {row}=await fileFor(c,c.req.param('fileHandle'));return c.json({resourceMode:'direct_workspace_folders',file:fileDto(c,row,c.req.param('fileHandle'))});});
  async function media(c:Ctx,disposition:'inline'|'attachment'){
    const raw=c.req.query('file');if(!raw)return unavailable();const {claims,folder,row,key}=await fileFor(c,raw);
    const type=(row.content_type??'application/octet-stream').split(';')[0]!.trim().toLowerCase();
    if(disposition==='inline'&&!/^(application\/(pdf|json)|text\/(plain|csv)|image\/(avif|gif|jpeg|png|webp)|audio\/(aac|flac|mpeg|ogg|wav|webm)|video\/(mp4|mpeg|ogg|quicktime|webm))$/u.test(type))
      throw new HTTPException(415,{message:'Preview unavailable'});
    const head=await c.env.DATA_BUCKET.head(key);if(!head||isMovedSourceMarker(head)||head.size!==row.size||head.etag!==row.etag.replace(/^"|"$/gu,''))return unavailable();
    await currentFolder(c,claims);
    let range:ReturnType<typeof parseRange>;
    try{range=parseRange(!c.req.header('If-Range')||c.req.header('If-Range')===head.httpEtag?c.req.header('Range'):undefined,head.size);if(range&&head.size===0)throw new Error('empty-range');}
    catch{return new Response(null,{status:416,headers:{'Accept-Ranges':'bytes','Content-Range':`bytes */${head.size}`,'Cache-Control':'private, no-store'}});}
    const headers=new Headers({'Content-Type':disposition==='inline'&&(type.startsWith('text/')||type==='application/json')?'text/plain; charset=utf-8':row.content_type??'application/octet-stream',
      'Content-Disposition':`${disposition}; filename="${safeFileName(key)}"; filename*=UTF-8''${encodeURIComponent(key.split('/').at(-1)??'file')}`,
      'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",
      'ETag':head.httpEtag,'Accept-Ranges':'bytes','Content-Length':String(range?.length??head.size)});
    if(range)headers.set('Content-Range',`bytes ${range.offset}-${range.offset+range.length-1}/${head.size}`);
    await currentFolder(c,claims);if(c.req.method==='HEAD')return new Response(null,{status:range?206:200,headers});
    if(!range&&c.req.header('If-None-Match')===head.httpEtag){headers.delete('Content-Length');return new Response(null,{status:304,headers});}
    const object=await c.env.DATA_BUCKET.get(key,{...(range?{range}:{}),onlyIf:{etagMatches:head.etag}});if(!object||!('body'in object))return unavailable();
    try{if(isMovedSourceMarker(object)||object.etag!==head.etag||object.size!==head.size)return unavailable();
      await currentFolder(c,claims);return new Response(object.body,{status:range?206:200,headers});
    }catch(error){await object.body.cancel().catch(()=>undefined);throw error;}
  }
  router.on(['GET','HEAD'],'/preview',c=>media(c,'inline'));
  router.on(['GET','HEAD'],'/download',c=>media(c,'attachment'));
  router.onError((error,c)=>c.json({error:error instanceof HTTPException?error.message:'Shared folder access is temporarily unavailable'},
    error instanceof HTTPException?error.status:503));
  return router;
}
