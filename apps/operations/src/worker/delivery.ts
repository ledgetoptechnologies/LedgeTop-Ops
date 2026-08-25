import { HTTPException } from "hono/http-exception";
import { isMovedSourceMarker, thumbnailFallbackKindForFile, type DeliveryItem } from "@ltds/shared";
import { accessCodeMatches, decryptDeliveryToken, encryptDeliveryToken, hashAccessCode, randomToken, sha256 } from "./crypto";
import { requirePermission, sqlScope } from "./acl";
import { auditStatement } from "./request-security";
import type { Env, StaffPrincipal } from "./types";
import { aliasMap } from "./aliases";
import { activeTombstones, assertNotTrashed, tombstoneMatches } from "./trash";
import { normalizeRecipientEmail, notificationDedupeKey, notificationStatement } from "./notifications";
import { thumbnailSourceEligible, thumbnailStateForObject, type ThumbnailJobRow } from "./image-thumbnails";
import {
  latestShareAudienceSnapshot,
  resolveShareAudience,
  resolveProjectAlphaDeliveryPrincipal,
  shareAudienceSnapshotStatements,
  shareDirectoryRecipientsEnabled,
  type AudienceType,
  type ShareAudienceSnapshot,
} from "./share-recipients";

const encoder = new TextEncoder(); const decoder = new TextDecoder("utf-8", { fatal: true });
const MIME: Record<string,string> = { avif:"image/avif",bmp:"image/bmp",gif:"image/gif",heic:"image/heic",heif:"image/heif",jpeg:"image/jpeg",jpg:"image/jpeg",png:"image/png",tif:"image/tiff",tiff:"image/tiff",webp:"image/webp",dng:"image/x-adobe-dng",arw:"image/x-sony-arw",cr2:"image/x-canon-cr2",cr3:"image/x-canon-cr3",crw:"image/x-canon-crw",nef:"image/x-nikon-nef",raf:"image/x-fuji-raf",rw2:"image/x-panasonic-rw2",orf:"image/x-olympus-orf",pef:"image/x-pentax-pef",srw:"image/x-samsung-srw","3fr":"image/x-hasselblad-3fr",rwl:"image/x-leica-rwl",srf:"image/x-sony-srf",sr2:"image/x-sony-sr2",x3f:"image/x-sigma-x3f",mp4:"video/mp4",m4v:"video/x-m4v",webm:"video/webm",mov:"video/quicktime",mp3:"audio/mpeg",m4a:"audio/mp4",wav:"audio/wav",ogg:"audio/ogg",pdf:"application/pdf",kml:"application/vnd.google-earth.kml+xml",kmz:"application/vnd.google-earth.kmz",txt:"text/plain; charset=utf-8",csv:"text/csv; charset=utf-8",json:"application/json; charset=utf-8" };

function b64(bytes: Uint8Array): string { let value=""; for(const byte of bytes)value+=String.fromCharCode(byte); return btoa(value).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
export function encodeRef(value:string):string{return b64(encoder.encode(value));}
export function decodeRef(value:string):string{if(!/^[A-Za-z0-9_-]+$/.test(value))throw new HTTPException(400,{message:"Invalid item reference"});try{const raw=atob(value.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(value.length/4)*4,"="));return validateRelative(decoder.decode(Uint8Array.from(raw,c=>c.charCodeAt(0))));}catch(error){if(error instanceof HTTPException)throw error;throw new HTTPException(400,{message:"Invalid item reference"});}}
function reserved(part:string):boolean{const value=part.toLowerCase();return value==="dump"||value==="_ltds"||value===".previews";}
function validateRelative(value:string):string{if(!value||value.startsWith("/")||value.includes("\\")||/[\0-\x1f\x7f]/.test(value))throw new HTTPException(400,{message:"Invalid item path"});const parts=value.split("/");if(parts.some(part=>!part||part==="."||part===".."||reserved(part)))throw new HTTPException(404,{message:"Item not found"});return parts.join("/");}
export function normalizePrefix(value:string):string{const prefix=value.trim().replace(/\\/g,"/").replace(/^\/+/,"").replace(/\/{2,}/g,"/").replace(/\/$/,"");if(!prefix||prefix.split("/").some(part=>!part||part==="."||part===".."||reserved(part)))throw new HTTPException(400,{message:"Folder prefix is invalid"});return `${prefix}/`;}
function hidden(key:string):boolean{const parts=key.replace(/\\/g,"/").split("/").filter(Boolean);return parts.some(reserved);}
function ext(key:string):string{const name=key.split("/").pop()||"";return name.includes(".")?(name.split(".").pop()||"").toLowerCase():"";}
const RAW_EXTENSIONS = new Set(["dng","arw","cr2","cr3","crw","nef","raf","rw2","orf","pef","srw","3fr","rwl","srf","sr2","x3f"]);
function isBrowserPreviewableImage(key:string):boolean{const e=ext(key);return ["avif","gif","heic","heif","jpeg","jpg","png","tif","tiff","webp","bmp"].includes(e);}
export function mime(key:string):string{return MIME[ext(key)]||"application/octet-stream";}
export type MediaKind = Exclude<DeliveryItem["kind"], "folder">;
export function mediaKind(key:string):MediaKind{const value=mime(key);if(value.startsWith("image/"))return"image";if(value.startsWith("video/"))return"video";if(value.startsWith("audio/"))return"audio";if(value==="application/pdf")return"pdf";if(value.startsWith("text/")||value.startsWith("application/json"))return"text";return"other";}
export function deliverySourceUrl(kind:DeliveryItem["kind"],id:string):string|undefined{return["image","video","audio","pdf","text"].includes(kind)?`/api/delivery/items/${id}/${kind==="pdf"?"pdf":"source"}`:undefined;}
function thumbnailEligible(object: Pick<R2Object, "key" | "size" | "httpMetadata">): boolean { return thumbnailSourceEligible(object.key,object.size,object.httpMetadata?.contentType); }

const FOLDER_VISIBILITY_CANDIDATE_BATCH = 40;
export const DELIVERY_FOLDER_PAGE_SIZE = 150;
const DELIVERY_MEDIA_LOOKUP_BATCH = 75;

interface DeliveryMediaCandidate {
  id:string;
  key:string;
  kind:MediaKind;
  etag:string;
}

interface DeliveryMediaState {
  thumbnail?:ThumbnailJobRow;
  video?:{stream_uid?:string;stream_status?:string};
}

interface DeliveryMediaPatch {
  id:string;
  thumbnailState:DeliveryItem["thumbnailState"];
  thumbnailErrorCode?:string;
  thumbnailUrl?:string;
  previewStatus?:"ready"|"processing"|"unavailable";
}

async function deliveryMediaState(
  database:D1Database,
  candidates:readonly DeliveryMediaCandidate[],
):Promise<Map<string,DeliveryMediaState>>{
  const byKey=new Map(candidates.map(candidate=>[candidate.key,candidate]));
  const state=new Map(candidates.map(candidate=>[candidate.id,{} as DeliveryMediaState]));
  for(let offset=0;offset<candidates.length;offset+=DELIVERY_MEDIA_LOOKUP_BATCH){
    const batch=candidates.slice(offset,offset+DELIVERY_MEDIA_LOOKUP_BATCH);
    if(!batch.length)continue;
    const placeholders=batch.map(()=>"?").join(",");
    const keys=batch.map(candidate=>candidate.key);
    const videos=batch.filter(candidate=>candidate.kind==="video");
    const [thumbnailRows,videoRows]=await Promise.all([
      database.prepare(`SELECT source_key,source_etag,thumbnail_key,status,error_code
        FROM image_thumbnail_jobs WHERE source_key IN (${placeholders})`).bind(...keys).all<ThumbnailJobRow>(),
      videos.length?database.prepare(`SELECT r2_key,stream_uid,stream_status
        FROM file_index WHERE r2_key IN (${videos.map(()=>"?").join(",")})`).bind(...videos.map(candidate=>candidate.key))
        .all<{r2_key:string;stream_uid?:string;stream_status?:string}>():Promise.resolve({results:[]} as {results:Array<{r2_key:string;stream_uid?:string;stream_status?:string}>}),
    ]);
    for(const row of thumbnailRows.results){
      const candidate=row.source_key?byKey.get(row.source_key):undefined;
      if(candidate)state.get(candidate.id)!.thumbnail=row;
    }
    for(const row of videoRows.results){
      const candidate=byKey.get(row.r2_key);
      if(candidate)state.get(candidate.id)!.video=row;
    }
  }
  return state;
}

function deliveryMediaPatch(candidate:DeliveryMediaCandidate,state:DeliveryMediaState):DeliveryMediaPatch{
  const thumbnail=thumbnailStateForObject(candidate.etag,state.thumbnail);
  return{
    id:candidate.id,
    thumbnailState:thumbnail.state,
    thumbnailErrorCode:thumbnail.errorCode,
    ...(thumbnail.state==="ready"?{thumbnailUrl:`/api/delivery/items/${candidate.id}/thumbnail`}:{}),
    ...(candidate.kind==="video"?{previewStatus:state.video?.stream_status==="ready"&&state.video.stream_uid?"ready":state.video?.stream_status==="error"?"unavailable":"processing"}:{}),
  };
}

function prefixUpperBound(prefix:string):string{
  // Normalized folder prefixes always end in "/". Replacing that final byte
  // with the next ASCII byte creates a strict upper bound for every descendant
  // while preserving SQLite's primary-key range lookup on file_index.r2_key.
  return `${prefix.slice(0,-1)}0`;
}

async function indexedDeliveryFolderVisibility(env:Env,candidates:readonly string[]):Promise<{indexed:Set<string>;visible:Set<string>}>{
  const indexed=new Set<string>(),visible=new Set<string>();
  for(let offset=0;offset<candidates.length;offset+=FOLDER_VISIBILITY_CANDIDATE_BATCH){
    const batch=candidates.slice(offset,offset+FOLDER_VISIBILITY_CANDIDATE_BATCH);
    const valuesSql=batch.map(()=>"(?,?)").join(",");
    const bindings=batch.flatMap(prefix=>[prefix,prefixUpperBound(prefix)]);
    const result=await env.DELIVERY_DB.prepare(`WITH candidates(prefix,upper_bound) AS (VALUES ${valuesSql})
      SELECT c.prefix,
        EXISTS (
          SELECT 1 FROM file_index indexed_file
          WHERE indexed_file.r2_key>=c.prefix AND indexed_file.r2_key<c.upper_bound
            AND indexed_file.r2_key<>c.prefix AND substr(indexed_file.r2_key,-1,1)<>'/'
            AND instr(lower('/'||indexed_file.r2_key||'/'),'/_ltds/')=0
            AND instr(lower('/'||indexed_file.r2_key||'/'),'/.previews/')=0
            AND instr(lower('/'||indexed_file.r2_key||'/'),'/dump/')=0
          LIMIT 1
        ) OR EXISTS (
          SELECT 1 FROM image_thumbnail_jobs indexed_thumbnail
          WHERE indexed_thumbnail.source_key>=c.prefix AND indexed_thumbnail.source_key<c.upper_bound
            AND indexed_thumbnail.source_key<>c.prefix AND substr(indexed_thumbnail.source_key,-1,1)<>'/'
            AND instr(lower('/'||indexed_thumbnail.source_key||'/'),'/_ltds/')=0
            AND instr(lower('/'||indexed_thumbnail.source_key||'/'),'/.previews/')=0
            AND instr(lower('/'||indexed_thumbnail.source_key||'/'),'/dump/')=0
          LIMIT 1
        ) has_index,
        EXISTS (
        SELECT 1 FROM file_index fi
        WHERE fi.r2_key>=c.prefix AND fi.r2_key<c.upper_bound
          AND fi.r2_key<>c.prefix AND substr(fi.r2_key,-1,1)<>'/'
          AND instr(lower('/'||fi.r2_key||'/'),'/_ltds/')=0
          AND instr(lower('/'||fi.r2_key||'/'),'/.previews/')=0
          AND instr(lower('/'||fi.r2_key||'/'),'/dump/')=0
          AND NOT EXISTS (
            SELECT 1 FROM delivery_tombstones t WHERE t.restored_at IS NULL AND (
              (t.tombstone_kind='exact' AND t.physical_key=fi.r2_key) OR
              (t.tombstone_kind='prefix' AND substr(fi.r2_key,1,length(t.physical_key))=t.physical_key)
            )
          )
        LIMIT 1
      ) OR EXISTS (
        SELECT 1 FROM image_thumbnail_jobs thumbnail
        WHERE thumbnail.source_key>=c.prefix AND thumbnail.source_key<c.upper_bound
          AND thumbnail.source_key<>c.prefix AND substr(thumbnail.source_key,-1,1)<>'/'
          AND instr(lower('/'||thumbnail.source_key||'/'),'/_ltds/')=0
          AND instr(lower('/'||thumbnail.source_key||'/'),'/.previews/')=0
          AND instr(lower('/'||thumbnail.source_key||'/'),'/dump/')=0
          AND NOT EXISTS (
            SELECT 1 FROM delivery_tombstones t WHERE t.restored_at IS NULL AND (
              (t.tombstone_kind='exact' AND t.physical_key=thumbnail.source_key) OR
              (t.tombstone_kind='prefix' AND substr(thumbnail.source_key,1,length(t.physical_key))=t.physical_key)
            )
          )
        LIMIT 1
      ) is_visible
      FROM candidates c`).bind(...bindings).all<{prefix:string;has_index:number;is_visible:number}>();
    for(const row of result.results)if(batch.includes(row.prefix)){
      if(row.has_index)indexed.add(row.prefix);
      if(row.is_visible)visible.add(row.prefix);
    }
  }
  return{indexed,visible};
}

async function visibleDeliveryFolders(env:Env,candidates:readonly string[]):Promise<{visible:Set<string>;reconciliationNeeded:boolean}>{
  const allowed=new Set(candidates),visibility=await indexedDeliveryFolderVisibility(env,candidates).catch(error=>{
    console.warn(JSON.stringify({event:"delivery.folder-index-reconciliation-needed",candidateCount:candidates.length,reason:"lookup_failed",errorName:error instanceof Error?error.name:"unknown"}));
    return{indexed:new Set<string>(),visible:new Set<string>()};
  });
  const {indexed,visible}=visibility;
  const unindexed=candidates.filter(value=>!indexed.has(value));
  if(unindexed.length)console.warn(JSON.stringify({event:"delivery.folder-index-reconciliation-needed",candidateCount:candidates.length,unindexedCount:unindexed.length,reason:"index_lag"}));
  // Unknown prefixes fail closed. R2 event ingestion/reconciliation will make
  // them visible without a request-time recursive subtree scan.
  return{visible:new Set([...visible].filter(value=>allowed.has(value))),reconciliationNeeded:unindexed.length>0};
}

interface FolderAssociation { division_id: string; r2_prefix: string }

async function browseRoots(env:Env,principal:StaffPrincipal):Promise<{global:boolean;roots:Array<{prefix:string;name:string;divisionId:string}>}>{const scope=await sqlScope(env,principal,"delivery.browse");if(scope.deniedGlobal)return{global:false,roots:[]};if(scope.global&&!scope.deniedDivisions.length)return{global:true,roots:[]};const denied=new Set(scope.deniedDivisions),divisions=scope.divisions.filter(divisionId=>!denied.has(divisionId));if(!divisions.length)return{global:false,roots:[]};const result=await env.OPS_DB.prepare(`SELECT pf.r2_prefix,p.name,pf.division_id FROM project_folders pf LEFT JOIN pa_projects p ON p.id=pf.project_id WHERE pf.division_id IN (${divisions.map(()=>"?").join(",")}) ORDER BY p.name,pf.r2_prefix`).bind(...divisions).all<{r2_prefix:string;name:string|null;division_id:string}>();return{global:false,roots:result.results.map(row=>({prefix:normalizePrefix(row.r2_prefix),name:row.name||row.r2_prefix,divisionId:row.division_id}))};}

export async function deliveryBrowseRevision(env:Env,principal:StaffPrincipal):Promise<string>{
  await requirePermission(env,principal,"delivery.browse");
  const access=await browseRoots(env,principal);
  const material=JSON.stringify({
    principalId:principal.id,
    global:access.global,
    roots:access.roots.map(root=>({prefix:root.prefix,divisionId:root.divisionId})).sort((a,b)=>
      a.prefix.localeCompare(b.prefix)||a.divisionId.localeCompare(b.divisionId)),
  });
  const digest=new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(material)));
  return `dbr_${b64(digest)}`;
}

/**
 * Aggregate-only renderer backlog for Operations administrators.  This must
 * never return source keys, object names, errors, or worker lease details:
 * the toolbar only needs a compact indication of outstanding work.
 */
export async function thumbnailQueueSummary(env:Env,principal:StaffPrincipal):Promise<{pending:number;processing:number;total:number}>{
  await requirePermission(env,principal,"delivery.browse");
  const row=await env.DELIVERY_DB.prepare(`SELECT
    SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
    SUM(CASE WHEN status='processing' THEN 1 ELSE 0 END) processing
    FROM image_thumbnail_jobs`).first<{pending:number|null;processing:number|null}>();
  const pending=Number(row?.pending||0),processing=Number(row?.processing||0);
  return{pending,processing,total:pending+processing};
}

export function resolveDivisionAssociation(prefix:string,associations:FolderAssociation[]):string|null{const matches=associations.map(row=>({divisionId:row.division_id,prefix:normalizePrefix(row.r2_prefix)})).filter(row=>prefix.startsWith(row.prefix));if(!matches.length)return null;const longest=Math.max(...matches.map(row=>row.prefix.length));const divisions=[...new Set(matches.filter(row=>row.prefix.length===longest).map(row=>row.divisionId))];if(divisions.length!==1)throw new HTTPException(409,{message:"Folder is associated with multiple divisions and requires review"});return divisions[0]!;}

async function inferDivisionId(env:Env,prefix:string):Promise<string|null>{const associations=await env.OPS_DB.prepare("SELECT division_id,r2_prefix FROM project_folders ORDER BY length(r2_prefix) DESC").all<FolderAssociation>();return resolveDivisionAssociation(prefix,associations.results);}

export async function authorizeDeliveryFolderPrefix(env:Env,principal:StaffPrincipal,prefixValue:string):Promise<string>{
  await requirePermission(env,principal,"delivery.browse");
  if(!prefixValue.trim())return"";
  const prefix=normalizePrefix(prefixValue),access=await browseRoots(env,principal);
  if(!access.global&&!access.roots.some(root=>prefix.startsWith(root.prefix)))throw new HTTPException(404,{message:"Folder not found"});
  await assertNotTrashed(env,prefix);
  return prefix;
}

export function resolveShareExpiration(value:string|null|undefined,maxDays:number,now=Date.now()):string|null{if(value===null||value===undefined||value==="")return null;const requested=new Date(value);if(Number.isNaN(requested.getTime())||requested.getTime()<=now||requested.getTime()>now+maxDays*86400000)throw new HTTPException(400,{message:`Expiration must be within ${maxDays} days`});return requested.toISOString();}

export async function listDeliveryFolder(env:Env,principal:StaffPrincipal,prefixValue:string,cursor?:string){
  await requirePermission(env,principal,"delivery.browse");
  const access=await browseRoots(env,principal);
  const prefix=prefixValue?normalizePrefix(prefixValue):"";
  if(prefix&&!access.global&&!access.roots.some(root=>prefix.startsWith(root.prefix)))throw new HTTPException(404,{message:"Folder not found"});
  const tombstones=await activeTombstones(env); const trashed=(key:string)=>tombstones.some(tombstone=>tombstoneMatches(tombstone,key));
  if(!access.global&&!prefixValue){const activeShares=await env.DELIVERY_DB.prepare(`SELECT COALESCE(s.r2_prefix,p.r2_prefix) r2_prefix,s.r2_object_key FROM shares s JOIN projects p ON p.id=s.project_id WHERE s.revoked_at IS NULL AND p.active=1 AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))`).all<{r2_prefix:string;r2_object_key:string|null}>();const shared=(key:string)=>activeShares.results.some(share=>{try{return share.r2_object_key?key===share.r2_object_key:key.startsWith(normalizePrefix(share.r2_prefix));}catch{return false;}});const roots=access.roots.filter(root=>!trashed(root.prefix));const aliases=await aliasMap(env,roots.map(root=>root.prefix));return{prefix:"",folders:roots.map(root=>({id:encodeRef(root.prefix.slice(0,-1)),prefix:root.prefix,name:aliases.get(root.prefix)||root.name,isShared:shared(root.prefix)})),files:[],nextCursor:null,mediaHydrated:true,reconciliationNeeded:false};}
  if(prefix)await assertNotTrashed(env,prefix);
  const listed=await env.DATA_BUCKET.list({prefix,delimiter:"/",limit:DELIVERY_FOLDER_PAGE_SIZE,cursor,include:["httpMetadata","customMetadata"]});
  const activeShares=await env.DELIVERY_DB.prepare(`SELECT COALESCE(s.r2_prefix,p.r2_prefix) r2_prefix,s.r2_object_key FROM shares s JOIN projects p ON p.id=s.project_id WHERE s.revoked_at IS NULL AND p.active=1 AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))`).all<{r2_prefix:string;r2_object_key:string|null}>();
  const shared=(key:string)=>activeShares.results.some(share=>{try{return share.r2_object_key?key===share.r2_object_key:key.startsWith(normalizePrefix(share.r2_prefix));}catch{return false;}});
  const folderCandidates=listed.delimitedPrefixes.filter(value=>!hidden(value)&&!trashed(value));
  const folderVisibility=await visibleDeliveryFolders(env,folderCandidates);
  const folders=folderCandidates.filter(value=>folderVisibility.visible.has(value));
  const files=listed.objects.filter(object=>object.key!==prefix&&!object.key.endsWith("/")&&!hidden(object.key)&&!trashed(object.key)&&!isMovedSourceMarker(object));
  const aliases=await aliasMap(env,[...folders,...files.map(object=>object.key)]);
  // Keep advisory thumbnail and Stream state off the authoritative listing's
  // critical path. The UI can render names/folders immediately, then patch
  // media state from listDeliveryFolderMedia without delaying folder open.
  const items=files.map(object=>{const id=encodeRef(object.key);const kind=mediaKind(object.key);const name=aliases.get(object.key)||object.key.slice(prefix.length);const sourceUrl=deliverySourceUrl(kind,id);return{id,name,displayName:name,physicalKey:object.key,kind,size:object.size,uploadedAt:object.uploaded.toISOString(),isShared:shared(object.key),previewUrl:kind==="image"?(isBrowserPreviewableImage(object.key)?sourceUrl:undefined):["audio","text"].includes(kind)?`/api/delivery/items/${id}/preview`:undefined,sourceUrl,thumbnailUrl:undefined as string|undefined,thumbnailState:(thumbnailEligible(object)?"pending":"not_applicable") as DeliveryItem["thumbnailState"],thumbnailErrorCode:undefined as string|undefined,thumbnailFallbackKind:thumbnailFallbackKindForFile(object.key,kind),downloadUrl:`/api/delivery/items/${id}/download`,previewStatus:kind==="video"?"processing":undefined,actions:{rename:`/api/delivery/items/${id}/display-name`,delete:`/api/delivery/items/${id}/source`}};});
  return{prefix,folders:folders.map(value=>{const id=encodeRef(value.slice(0,-1));const name=aliases.get(value)||value.slice(prefix.length).replace(/\/$/,"");return{id,prefix:value,physicalKey:value,name,displayName:name,isShared:shared(value),actions:{rename:`/api/delivery/items/${id}/display-name`,delete:`/api/delivery/items/${id}/source`}};}),files:items,nextCursor:listed.truncated?listed.cursor:null,mediaHydrated:false,reconciliationNeeded:folderVisibility.reconciliationNeeded};
}

/**
 * Advisory thumbnail/video state for exactly one already-authorized folder
 * page. It never adds names or paths to the listing; clients may only patch
 * matching ids from the authoritative page they already rendered.
 */
export async function listDeliveryFolderMedia(env:Env,principal:StaffPrincipal,prefixValue:string,cursor?:string){
  await requirePermission(env,principal,"delivery.browse");
  const access=await browseRoots(env,principal);
  const prefix=prefixValue?normalizePrefix(prefixValue):"";
  if(prefix&&!access.global&&!access.roots.some(root=>prefix.startsWith(root.prefix)))throw new HTTPException(404,{message:"Folder not found"});
  if(!access.global&&!prefixValue)return{items:[]};
  if(prefix)await assertNotTrashed(env,prefix);
  const tombstones=await activeTombstones(env),trashed=(key:string)=>tombstones.some(tombstone=>tombstoneMatches(tombstone,key));
  const listed=await env.DATA_BUCKET.list({prefix,delimiter:"/",limit:DELIVERY_FOLDER_PAGE_SIZE,cursor,include:["httpMetadata","customMetadata"]});
  const files=listed.objects.filter(object=>object.key!==prefix&&!object.key.endsWith("/")&&!hidden(object.key)&&!trashed(object.key)&&!isMovedSourceMarker(object));
  const candidates=files.flatMap(object=>{
    const kind=mediaKind(object.key);
    if(!thumbnailEligible(object)&&kind!=="video")return[];
    return[{id:encodeRef(object.key),key:object.key,kind,etag:object.httpEtag}];
  });
  const state=await deliveryMediaState(env.DELIVERY_DB,candidates);
  return{items:candidates.map(candidate=>deliveryMediaPatch(candidate,state.get(candidate.id)||{}))};
}

/**
 * Search the indexed delivery tree without turning a staff search box into a
 * bucket-wide data leak.  The index is populated by the R2 event consumer and
 * reconciliation job; results are still constrained to the caller's browse
 * roots before they are returned.
 */
export async function searchDeliveryItems(env:Env,principal:StaffPrincipal,queryValue:string,cursorValue?:string){
  await requirePermission(env,principal,"delivery.browse");
  const submittedQuery=queryValue.normalize("NFC").trim();
  const pathMode=/^path\s*:/i.test(submittedQuery);
  const query=(pathMode?submittedQuery.replace(/^path\s*:/i,""):submittedQuery).trim();
  if(!query||query.length>160||/[\0-\x1f\x7f]/.test(query))throw new HTTPException(400,{message:"Search text is invalid"});
  const access=await browseRoots(env,principal);
  if(!access.global&&!access.roots.length)return{query,items:[],nextCursor:null};
  const offset=cursorValue&&/^\d+$/.test(cursorValue)?Number(cursorValue):0;
  if(!Number.isSafeInteger(offset)||offset<0||offset>10_000)throw new HTTPException(400,{message:"Search cursor is invalid"});
  // Jobs is the Operations delivery surface.  A global delivery permission is
  // intentionally not permission to enumerate internal bucket namespaces.
  const roots=access.global?["Jobs/"]:access.roots.map(root=>root.prefix);
  const scopeSql=roots.map(()=>"r2_key LIKE ?").join(" OR ");
  const escaped=query.toLowerCase().replace(/[\\%_]/g,"\\$&");
  const prefilterSql=pathMode?"lower(r2_key) LIKE ? ESCAPE '\\'":`(
    lower(r2_key) LIKE ? ESCAPE '\\' OR EXISTS (
      SELECT 1 FROM file_aliases prefilter_alias
      WHERE (prefilter_alias.physical_key=file_index.r2_key OR
        (substr(prefilter_alias.physical_key,-1,1)='/' AND substr(file_index.r2_key,1,length(prefilter_alias.physical_key))=prefilter_alias.physical_key))
        AND lower(prefilter_alias.display_name) LIKE ? ESCAPE '\\'
    )
  )`;
  const matchSql=pathMode
    ?"part.is_leaf=1 AND lower(part.item_path) LIKE ? ESCAPE '\\'"
    :"(lower(part.item_name) LIKE ? ESCAPE '\\' OR lower(COALESCE(alias.display_name,'')) LIKE ? ESCAPE '\\')";
  // Split each scoped key into addressable path components before pagination.
  // This lets a folder name produce exactly one folder candidate and prevents
  // its descendants from consuming the page ahead of genuine leaf matches.
  const rows=await env.DELIVERY_DB.prepare(`WITH RECURSIVE
    scoped_files(r2_key,etag,size,uploaded_at,content_type,media_kind) AS (
      SELECT r2_key,etag,size,uploaded_at,content_type,media_kind FROM file_index
      WHERE (${scopeSql})
        AND (${prefilterSql})
        AND instr(lower('/'||r2_key||'/'),'/_ltds/')=0
        AND instr(lower('/'||r2_key||'/'),'/.previews/')=0
        AND instr(lower('/'||r2_key||'/'),'/dump/')=0
        AND NOT EXISTS (SELECT 1 FROM delivery_tombstones t WHERE t.restored_at IS NULL AND (
          (t.tombstone_kind='exact' AND t.physical_key=file_index.r2_key) OR
          (t.tombstone_kind='prefix' AND substr(file_index.r2_key,1,length(t.physical_key))=t.physical_key)
        ))
    ),
    path_parts(r2_key,etag,size,uploaded_at,content_type,media_kind,remaining,item_path,item_name,is_leaf) AS (
      SELECT r2_key,etag,size,uploaded_at,content_type,media_kind,r2_key,'','',0 FROM scoped_files
      UNION ALL
      SELECT r2_key,etag,size,uploaded_at,content_type,media_kind,
        CASE WHEN instr(remaining,'/')>0 THEN substr(remaining,instr(remaining,'/')+1) ELSE '' END,
        item_path||CASE WHEN instr(remaining,'/')>0 THEN substr(remaining,1,instr(remaining,'/')) ELSE remaining END,
        CASE WHEN instr(remaining,'/')>0 THEN substr(remaining,1,instr(remaining,'/')-1) ELSE remaining END,
        CASE WHEN instr(remaining,'/')=0 THEN 1 ELSE 0 END
      FROM path_parts WHERE remaining<>''
    )
    SELECT part.item_path AS r2_key,part.item_name,part.is_leaf,
      MAX(part.etag) etag,MAX(part.size) size,MAX(part.uploaded_at) uploaded_at,
      MAX(part.content_type) content_type,MAX(part.media_kind) media_kind,
      MAX(alias.display_name) display_name
    FROM path_parts part
    LEFT JOIN file_aliases alias ON alias.physical_key=part.item_path
    WHERE part.item_name<>'' AND part.item_path<>'Jobs/' AND (${matchSql})
    GROUP BY part.item_path,part.item_name,part.is_leaf
    ORDER BY part.item_path COLLATE NOCASE
    LIMIT 101 OFFSET ?`).bind(
      ...roots.map(root=>`${root}%`),`%${escaped}%`,...(pathMode?[]:[`%${escaped}%`]),
      `%${escaped}%`,...(pathMode?[]:[`%${escaped}%`]),offset,
    ).all<{r2_key:string;item_name:string;is_leaf:number;etag:string;size:number;uploaded_at:string;content_type:string|null;media_kind:string|null;display_name:string|null}>();
  const page=rows.results.slice(0,100),hasMore=rows.results.length>100;
  const folders=new Map<string,any>(),files:any[]=[];
  for(const row of page){
    const key=row.r2_key;
    if(hidden(key))continue;
    const name=row.display_name||row.item_name||key;
    if(!row.is_leaf){
      folders.set(key,{id:encodeRef(key.slice(0,-1)),prefix:key,physicalKey:key,name:row.item_name||"Folder",displayName:name,kind:"folder",searchPath:key});
      continue;
    }
    const kind=mediaKind(key),id=encodeRef(key),sourceUrl=deliverySourceUrl(kind,id);
    files.push({id,physicalKey:key,name,displayName:name,kind,size:row.size,uploadedAt:row.uploaded_at,searchPath:key,previewUrl:kind==="image"?(isBrowserPreviewableImage(key)?sourceUrl:undefined):["audio","text"].includes(kind)?`/api/delivery/items/${id}/preview`:undefined,sourceUrl,downloadUrl:`/api/delivery/items/${id}/download`,thumbnailState:"not_applicable",thumbnailFallbackKind:thumbnailFallbackKindForFile(key,kind),previewStatus:kind==="video"?"processing":undefined});
  }
  return{query,searchMode:pathMode?"path":"name",items:[...folders.values(),...files],nextCursor:hasMore?String(offset+page.length):null};
}

export async function authorizeItem(env:Env,principal:StaffPrincipal,itemRef:string):Promise<string>{await requirePermission(env,principal,"delivery.browse");const key=decodeRef(itemRef);if(hidden(key))throw new HTTPException(404,{message:"Item not found"});const access=await browseRoots(env,principal);if(!access.global&&!access.roots.some(root=>key.startsWith(root.prefix)))throw new HTTPException(404,{message:"Item not found"});await assertNotTrashed(env,key);return key;}

export interface ShareInput{clientName?:string;projectName?:string;r2Prefix?:string;itemRef?:string;projectId?:string;externalRef?:string;label?:string;accessCode?:string;generateAccessCode?:boolean;removeAccessCode?:boolean;expiresAt?:string|null;recipientEmail?:string|null;recipientAudience?:{type:AudienceType;publicId:string}|null;imageLocationMapEnabled?:boolean;}
export function deriveShareMetadata(prefix:string,input:Pick<ShareInput,"clientName"|"projectName">={}):{clientName:string;projectName:string}{const folderName=normalizePrefix(prefix).slice(0,-1).split("/").pop()||"Shared folder";return{clientName:input.clientName?.trim()||folderName,projectName:input.projectName?.trim()||folderName};}

interface ProjectRow { id:string;division_id:string|null;r2_prefix:string }
interface ActiveShareRow {
  id:string;project_id:string;public_id:string|null;label:string|null;password_hash:string|null;password_salt:string|null;password_iterations:number|null;password_algorithm:string|null;
  expires_at:string|null;idempotency_key:string|null;share_version:number;secret_ciphertext:string|null;secret_iv:string|null;division_id:string|null;recipient_email:string|null;image_location_map_enabled:number;created_by_type:string;created_by_id:string|null;r2_object_key:string|null;
}

export interface ShareLifecycleResult {
  id:string;shareUrl:string;accessCode:string|null;passwordProtected:boolean;expiresAt:string|null;
  lifecycle:"created"|"reused"|"updated"|"rotated";idempotentReplay:boolean;
}

export function resolveAccessCodeChange(input:Pick<ShareInput,"accessCode"|"generateAccessCode"|"removeAccessCode">):{kind:"preserve"|"set"|"remove";accessCode:string|null}{
  const supplied=input.accessCode?.trim()||null;
  const selected=[Boolean(input.generateAccessCode),Boolean(input.removeAccessCode),Boolean(supplied)].filter(Boolean).length;
  if(selected>1)throw new HTTPException(400,{message:"Choose only one access-code action"});
  if(input.removeAccessCode)return{kind:"remove",accessCode:null};
  const accessCode=input.generateAccessCode?randomToken(12):supplied;
  if(accessCode&&accessCode.length<8)throw new HTTPException(400,{message:"Access code must be at least eight characters"});
  return accessCode?{kind:"set",accessCode}:{kind:"preserve",accessCode:null};
}

export async function authorizeSharePrefix(env:Env,principal:StaffPrincipal,prefix:string,projectId?:string):Promise<{project:ProjectRow|null;divisionId:string|null}>{
  const access=await browseRoots(env,principal);
  if(!access.global&&!access.roots.some(root=>prefix.startsWith(root.prefix)))throw new HTTPException(404,{message:"Folder not found"});
  const project=projectId
    ?await env.DELIVERY_DB.prepare("SELECT id,division_id,r2_prefix FROM projects WHERE id=?").bind(projectId).first<ProjectRow>()
    :await env.DELIVERY_DB.prepare("SELECT id,division_id,r2_prefix FROM projects WHERE r2_prefix=? AND active=1 ORDER BY created_at DESC LIMIT 1").bind(prefix).first<ProjectRow>();
  if(projectId&&!project)throw new HTTPException(404,{message:"Project not found"});
  if(project&&normalizePrefix(project.r2_prefix)!==prefix)throw new HTTPException(409,{message:"Project folder does not match"});
  const associatedDivision=await inferDivisionId(env,prefix);
  if(project?.division_id&&associatedDivision&&project.division_id!==associatedDivision)throw new HTTPException(409,{message:"Project division does not match the folder association"});
  const divisionId=project?.division_id||associatedDivision;
  if(!access.global&&!divisionId)throw new HTTPException(404,{message:"Folder not found"});
  await requirePermission(env,principal,"delivery.share.create",{divisionId},true);
  return{project,divisionId};
}

export async function activeShareForPrefix(env:Env,prefix:string,objectKey:string|null=null):Promise<ActiveShareRow|null>{
  const current=await env.DELIVERY_DB.prepare(`SELECT s.id,s.project_id,s.public_id,s.label,s.password_hash,s.password_salt,s.password_iterations,s.password_algorithm,s.expires_at,s.idempotency_key,s.share_version,s.secret_ciphertext,s.secret_iv,s.recipient_email,s.image_location_map_enabled,s.created_by_type,s.created_by_id,s.r2_object_key,COALESCE(s.division_id,p.division_id) AS division_id
    FROM shares s JOIN projects p ON p.id=s.project_id
    WHERE s.r2_prefix=? AND ((? IS NULL AND s.r2_object_key IS NULL) OR s.r2_object_key=?) AND s.revoked_at IS NULL AND p.active=1
      AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))
    ORDER BY s.created_at DESC LIMIT 1`).bind(prefix,objectKey,objectKey).first<ActiveShareRow>();
  if(current)return current;
  // Shares created before r2_prefix was backfilled may still rely on their project.
  // Keep that compatibility lookup explicit and bounded instead of applying
  // COALESCE to every active share row in the normal path.
  if(objectKey)return null;
  return env.DELIVERY_DB.prepare(`SELECT s.id,s.project_id,s.public_id,s.label,s.password_hash,s.password_salt,s.password_iterations,s.password_algorithm,s.expires_at,s.idempotency_key,s.share_version,s.secret_ciphertext,s.secret_iv,s.recipient_email,s.image_location_map_enabled,s.created_by_type,s.created_by_id,NULL AS r2_object_key,COALESCE(s.division_id,p.division_id) AS division_id
    FROM shares s JOIN projects p ON p.id=s.project_id
    WHERE s.r2_prefix IS NULL AND p.r2_prefix=? AND s.revoked_at IS NULL AND p.active=1
      AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))
    ORDER BY s.created_at DESC LIMIT 1`).bind(prefix).first<ActiveShareRow>();
}

async function recoverShareSecret(env:Env,share:ActiveShareRow):Promise<string|null>{
  if(!share.secret_ciphertext||!share.secret_iv)return null;
  try{return await decryptDeliveryToken(share.secret_ciphertext,share.secret_iv,env.DELIVERY_TOKEN_SECRET,share.id);}catch{
    if(!env.DELIVERY_PREVIOUS_TOKEN_SECRET)return null;
    try{
      const secret=await decryptDeliveryToken(share.secret_ciphertext,share.secret_iv,env.DELIVERY_PREVIOUS_TOKEN_SECRET,share.id);
      const encrypted=await encryptDeliveryToken(secret,env.DELIVERY_TOKEN_SECRET,share.id);
      await env.DELIVERY_DB.prepare("UPDATE shares SET secret_ciphertext=?,secret_iv=? WHERE id=? AND secret_ciphertext=?").bind(encrypted.ciphertext,encrypted.iv,share.id,share.secret_ciphertext).run();
      return secret;
    }catch{return null;}
  }
}

function shareUrl(env:Env,publicId:string,secret:string):string{return`${env.DELIVERY_BASE_URL.replace(/\/$/,"")}/s/${publicId}#${secret}`;}

export function resolveShareUpdateSecurity(input:{accessCodeChanged:boolean;recipientChanged:boolean;hasRecoverableSecret:boolean;publicIdChanged:boolean}):{mustRotateCredential:boolean;versionIncrement:0|1}{
  // share_version is a credential/policy generation, not a general metadata
  // revision. Expiration and map policy remain live D1 checks on every public
  // request, so changing either one does not needlessly invalidate an otherwise
  // valid browser session. A recipient change rotates the bearer credential so
  // the previously notified audience cannot keep using the old fragment.
  const mustRotateCredential=input.accessCodeChanged||input.recipientChanged||!input.hasRecoverableSecret;
  return{mustRotateCredential,versionIncrement:mustRotateCredential||input.publicIdChanged?1:0};
}

export async function getActiveDeliveryShare(env:Env,principal:StaffPrincipal,prefixValue:string,itemRef?:string){
  const prefix=normalizePrefix(prefixValue),objectKey=itemRef?await authorizeItem(env,principal,itemRef):null;
  if(objectKey&&!objectKey.startsWith(prefix))throw new HTTPException(404,{message:"File not found"});
  await authorizeSharePrefix(env,principal,prefix);const share=await activeShareForPrefix(env,prefix,objectKey);
  if(!share)return null;await requirePermission(env,principal,"delivery.share.create",{divisionId:share.division_id},true);const secret=await recoverShareSecret(env,share);
  const [aliases,audience]=await Promise.all([aliasMap(env,[prefix,...(objectKey?[objectKey]:[])]),shareDirectoryRecipientsEnabled(env)?latestShareAudienceSnapshot(env,share.id):Promise.resolve(null)]);return{id:share.id,shareUrl:secret&&share.public_id?shareUrl(env,share.public_id,secret):null,passwordProtected:Boolean(share.password_hash),expiresAt:share.expires_at,recoverable:Boolean(secret&&share.public_id),recipientEmail:share.recipient_email,audience:audience?{audienceType:audience.audienceType,publicId:audience.audiencePublicId,displayName:audience.audienceDisplayName,recipientCount:audience.recipients.length,email:audience.audienceType==="principal"?audience.recipients[0]?.email:null}:null,imageLocationMapEnabled:share.image_location_map_enabled===1,targetType:objectKey?"file":"folder",displayName:aliases.get(objectKey||prefix)||(objectKey||prefix.slice(0,-1)).split("/").pop()};
}

export async function createDeliveryShare(env:Env,request:Request,principal:StaffPrincipal,input:ShareInput,idempotencyKey:string):Promise<ShareLifecycleResult>{
  if(!idempotencyKey||idempotencyKey.length>120)throw new HTTPException(400,{message:"Idempotency-Key is required"});
  if(!input.r2Prefix)throw new HTTPException(400,{message:"r2Prefix is required"});
  const prefix=normalizePrefix(input.r2Prefix),objectKey=input.itemRef?await authorizeItem(env,principal,input.itemRef):null,{clientName,projectName}=deriveShareMetadata(prefix,input);
  if(objectKey){
    if(!objectKey.startsWith(prefix))throw new HTTPException(404,{message:"File not found"});
    const object=await env.DATA_BUCKET.head(objectKey);
    if(!object||objectKey.endsWith("/")||isMovedSourceMarker(object))throw new HTTPException(404,{message:"File not found"});
  }
  const{project,divisionId}=await authorizeSharePrefix(env,principal,prefix,input.projectId);
  const owner=Boolean(await env.OPS_DB.prepare("SELECT 1 ok FROM staff_role_assignments WHERE staff_id=? AND role_id='role-owner' AND scope='global'").bind(principal.id).first());
  const requestedExpiration=input.expiresAt===undefined?undefined:resolveShareExpiration(input.expiresAt,owner?365:90);
  const directoryRecipients=shareDirectoryRecipientsEnabled(env);
  if(directoryRecipients&&input.recipientEmail!==undefined)throw new HTTPException(400,{message:"Choose a recipient from the client directory"});
  if(!directoryRecipients&&input.recipientAudience!==undefined)throw new HTTPException(404,{message:"Client directory recipients are unavailable"});
  let recipientEmail: string | null= null;
  if(!directoryRecipients){try { recipientEmail = normalizeRecipientEmail(input.recipientEmail); } catch (error) { throw new HTTPException(400, { message: error instanceof Error ? error.message : "Recipient email is invalid" }); }}
  const requestedRecipient:ShareAudienceSnapshot|null|undefined=directoryRecipients&&input.recipientAudience!==undefined
    ?(input.recipientAudience===null?null:await resolveShareAudience(env,prefix,input.recipientAudience.type,input.recipientAudience.publicId))
    :undefined;
  const codeChange=resolveAccessCodeChange(input);

  await env.DELIVERY_DB.prepare(`UPDATE shares SET revoked_at=datetime('now'),revoked_reason='expired' WHERE revoked_at IS NULL AND expires_at IS NOT NULL
    AND datetime(expires_at)<=datetime('now') AND COALESCE(r2_prefix,(SELECT r2_prefix FROM projects WHERE id=shares.project_id))=?
    AND ((? IS NULL AND r2_object_key IS NULL) OR r2_object_key=?)`).bind(prefix,objectKey,objectKey).run();
  await env.DELIVERY_DB.prepare(`UPDATE shares SET revoked_at=datetime('now'),revoked_reason='project_inactive' WHERE revoked_at IS NULL
    AND COALESCE(r2_prefix,(SELECT r2_prefix FROM projects WHERE id=shares.project_id))=?
    AND ((? IS NULL AND r2_object_key IS NULL) OR r2_object_key=?)
    AND EXISTS (SELECT 1 FROM projects WHERE projects.id=shares.project_id AND projects.active=0)`).bind(prefix,objectKey,objectKey).run();
  let active=await activeShareForPrefix(env,prefix,objectKey);
  if(active){
    for(let attempt=0;attempt<2;attempt+=1){
      await requirePermission(env,principal,"delivery.share.create",{divisionId:active.division_id},true);
      const currentRecipient=directoryRecipients?await latestShareAudienceSnapshot(env,active.id):null;
      const refreshedCurrentRecipient=currentRecipient
        ?await resolveShareAudience(env,prefix,currentRecipient.audienceType,currentRecipient.audiencePublicId)
        :null;
      const previousSecret=await recoverShareSecret(env,active),replay=active.idempotency_key===idempotencyKey;
      if(attempt===0&&replay&&previousSecret&&active.public_id)return{id:active.id,shareUrl:shareUrl(env,active.public_id,previousSecret),accessCode:null,passwordProtected:Boolean(active.password_hash),expiresAt:active.expires_at,lifecycle:"reused",idempotentReplay:true};

      const sameCode=codeChange.kind==="set"&&Boolean(active.password_hash&&active.password_salt)&&(
        await accessCodeMatches(codeChange.accessCode!,active.password_hash!,active.password_salt!,active.password_algorithm,env.DELIVERY_ACCESS_CODE_PEPPER) ||
        Boolean(env.DELIVERY_PREVIOUS_ACCESS_CODE_PEPPER && await accessCodeMatches(codeChange.accessCode!,active.password_hash!,active.password_salt!,active.password_algorithm,env.DELIVERY_PREVIOUS_ACCESS_CODE_PEPPER))
      );
      const securityEquivalent=codeChange.kind==="preserve"||(codeChange.kind==="remove"&&!active.password_hash)||(codeChange.kind==="set"&&sameCode);
      if(attempt>0&&!securityEquivalent)throw new HTTPException(409,{message:"This share changed while you were editing it. Reopen the share and try again."});

      const effectiveCodeChange=securityEquivalent?{kind:"preserve" as const,accessCode:null}:codeChange;
      const securityChanged=effectiveCodeChange.kind!=="preserve",expiresAt=requestedExpiration===undefined?active.expires_at:requestedExpiration;
      const effectiveDirectoryRecipient=requestedRecipient===undefined?refreshedCurrentRecipient:requestedRecipient;
      const effectiveRecipient = directoryRecipients
        ?(requestedRecipient===undefined?active.recipient_email:effectiveDirectoryRecipient?.recipients[0]?.email||null)
        :(input.recipientEmail===undefined ? active.recipient_email : recipientEmail);
      const recipientChanged=directoryRecipients
        ?input.recipientAudience!==undefined&&`${effectiveDirectoryRecipient?.audienceType||""}:${effectiveDirectoryRecipient?.audiencePublicId||""}`!==`${currentRecipient?.audienceType||""}:${currentRecipient?.audiencePublicId||""}`
        :input.recipientEmail!==undefined&&recipientEmail!==active.recipient_email;
      const expirationChanged=expiresAt!==active.expires_at,mapChanged=input.imageLocationMapEnabled!==undefined&&Number(input.imageLocationMapEnabled)!==active.image_location_map_enabled,publicIdChanged=!active.public_id;
      const updateSecurity=resolveShareUpdateSecurity({accessCodeChanged:securityChanged,recipientChanged,hasRecoverableSecret:Boolean(previousSecret),publicIdChanged});
      const mustRotate=updateSecurity.mustRotateCredential,nextShareVersion=active.share_version+updateSecurity.versionIncrement;
      if(!mustRotate&&!expirationChanged&&!publicIdChanged&&!recipientChanged&&!mapChanged)return{id:active.id,shareUrl:shareUrl(env,active.public_id!,previousSecret!),accessCode:sameCode?codeChange.accessCode:null,passwordProtected:Boolean(active.password_hash),expiresAt:active.expires_at,lifecycle:"reused",idempotentReplay:replay};

      const nextPublicId=active.public_id||randomToken(16),nextSecret=mustRotate?randomToken(32):previousSecret!;
      const encrypted=mustRotate?await encryptDeliveryToken(nextSecret,env.DELIVERY_TOKEN_SECRET,active.id):{ciphertext:active.secret_ciphertext!,iv:active.secret_iv!};
      const password=effectiveCodeChange.kind==="set"?await hashAccessCode(effectiveCodeChange.accessCode!,env.DELIVERY_ACCESS_CODE_PEPPER):null;
      const passwordHash=effectiveCodeChange.kind==="preserve"?active.password_hash:password?.hash||null;
      const passwordSalt=effectiveCodeChange.kind==="preserve"?active.password_salt:password?.salt||null;
      const passwordIterations=effectiveCodeChange.kind==="preserve"?active.password_iterations:password?.iterations||null;
      const passwordAlgorithm=effectiveCodeChange.kind==="preserve"?active.password_algorithm:password?.algorithm||null;
      const lifecycle:ShareLifecycleResult["lifecycle"]=mustRotate?"rotated":"updated",tokenHash=mustRotate?await sha256(nextSecret):null;
      const effectiveMapEnabled=input.imageLocationMapEnabled===undefined?active.image_location_map_enabled:Number(input.imageLocationMapEnabled);
      const updateStatement=env.DELIVERY_DB.prepare(`UPDATE shares SET token_hash=COALESCE(?,token_hash),public_id=COALESCE(public_id,?),secret_ciphertext=?,secret_iv=?,password_hash=?,password_salt=?,password_iterations=?,password_algorithm=?,expires_at=?,recipient_email=?,image_location_map_enabled=?,idempotency_key=?,r2_prefix=?,r2_object_key=?,division_id=COALESCE(division_id,?),share_version=share_version+? WHERE id=? AND share_version=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM projects WHERE projects.id=shares.project_id AND projects.active=1)`).bind(tokenHash,nextPublicId,encrypted.ciphertext,encrypted.iv,passwordHash,passwordSalt,passwordIterations,passwordAlgorithm,expiresAt,effectiveRecipient,effectiveMapEnabled,idempotencyKey,prefix,objectKey,divisionId,updateSecurity.versionIncrement,active.id,active.share_version);
      const updated=await env.DELIVERY_DB.batch([updateStatement,...(directoryRecipients&&effectiveDirectoryRecipient&&updateSecurity.versionIncrement?shareAudienceSnapshotStatements(env,active.id,nextShareVersion,effectiveDirectoryRecipient,principal.id,true):[])]);
      if(!updated[0]?.meta.changes){const latest=await activeShareForPrefix(env,prefix,objectKey);if(!latest)throw new HTTPException(409,{message:"This share changed while you were editing it. Reopen the share and try again."});active=latest;continue;}

      const notificationShareId=active.id,notificationShareVersion=nextShareVersion,notificationRevision=`${notificationShareVersion}:${idempotencyKey}`;
      const notifications = effectiveDirectoryRecipient ? effectiveDirectoryRecipient.recipients.map(member=>notificationStatement(env,{shareId:notificationShareId,kind:"share_updated",recipientEmail:member.email,dedupeKey:notificationDedupeKey("share_updated",notificationShareId,`${notificationRevision}:${member.principalPublicId}`),payload:{shareUrl:shareUrl(env,nextPublicId,nextSecret),r2Prefix:prefix,expiresAt}})!) : [notificationStatement(env, { shareId: notificationShareId, kind: "share_updated", recipientEmail: effectiveRecipient, dedupeKey: notificationDedupeKey("share_updated", notificationShareId, notificationRevision), payload: { shareUrl: shareUrl(env, nextPublicId, nextSecret), r2Prefix: prefix, expiresAt } })].filter((value):value is D1PreparedStatement=>Boolean(value));
      await env.DELIVERY_DB.batch([env.DELIVERY_DB.prepare("INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('staff',?,?,?,?,?)").bind(principal.id,`share.${lifecycle}`,'share',active.id,JSON.stringify({divisionId,r2Prefix:prefix,securityChanged:mustRotate,accessCodeChanged:securityChanged,recipientChanged,expiresAt,effectiveRecipient,imageLocationMapEnabled:Boolean(effectiveMapEnabled)})), ...notifications]);
      await env.OPS_DB.batch([await auditStatement(env,request,principal,`delivery.share.${lifecycle}`,"share",active.id,divisionId,{r2Prefix:prefix,securityChanged:mustRotate,accessCodeChanged:securityChanged,recipientChanged,expiresAt,imageLocationMapEnabled:Boolean(effectiveMapEnabled)})]);
      return{id:active.id,shareUrl:shareUrl(env,nextPublicId,nextSecret),accessCode:effectiveCodeChange.kind==="set"?effectiveCodeChange.accessCode:null,passwordProtected:Boolean(passwordHash),expiresAt,lifecycle,idempotentReplay:false};
    }
    throw new HTTPException(409,{message:"This share changed while you were editing it. Reopen the share and try again."});
  }

  const accessCode=codeChange.kind==="set"?codeChange.accessCode:null,password=accessCode?await hashAccessCode(accessCode,env.DELIVERY_ACCESS_CODE_PEPPER):null;
  const expiresAt=requestedExpiration===undefined?null:requestedExpiration;
  const projectId=project?.id||input.projectId||crypto.randomUUID(),shareId=crypto.randomUUID(),publicId=randomToken(16),secret=randomToken(32);
  const selectedRecipient=directoryRecipients?requestedRecipient||null:null;
  if(selectedRecipient)recipientEmail=selectedRecipient.recipients[0]?.email||null;
  const encrypted=await encryptDeliveryToken(secret,env.DELIVERY_TOKEN_SECRET,shareId);
  const createdNotifications = selectedRecipient?selectedRecipient.recipients.map(member=>notificationStatement(env,{shareId,kind:"share_created",recipientEmail:member.email,dedupeKey:notificationDedupeKey("share_created",shareId,member.principalPublicId),payload:{shareUrl:shareUrl(env,publicId,secret),clientName,projectName,r2Prefix:prefix,expiresAt}})!):[notificationStatement(env, { shareId, kind: "share_created", recipientEmail, payload: { shareUrl: shareUrl(env, publicId, secret), clientName, projectName, r2Prefix: prefix, expiresAt } })].filter((value):value is D1PreparedStatement=>Boolean(value));
  const statements:D1PreparedStatement[]=[];
  if(!project)statements.push(env.DELIVERY_DB.prepare("INSERT INTO projects (id,external_ref,client_name,project_name,r2_prefix,division_id,created_by) VALUES (?,?,?,?,?,?,NULL)").bind(projectId,input.externalRef?.trim()||null,clientName,projectName,prefix,divisionId));
  statements.push(
    env.DELIVERY_DB.prepare(`INSERT INTO shares (id,project_id,token_hash,public_id,label,password_hash,password_salt,password_iterations,password_algorithm,expires_at,recipient_email,image_location_map_enabled,created_by_type,created_by_id,idempotency_key,share_version,secret_ciphertext,secret_iv,r2_prefix,r2_object_key,division_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'staff',?,?,2,?,?,?,?,?)`).bind(shareId,projectId,await sha256(secret),publicId,input.label?.trim()||null,password?.hash||null,password?.salt||null,password?.iterations||null,password?.algorithm||null,expiresAt,recipientEmail,Number(Boolean(input.imageLocationMapEnabled&&!objectKey)),principal.id,idempotencyKey,encrypted.ciphertext,encrypted.iv,prefix,objectKey,divisionId),
    ...(selectedRecipient?shareAudienceSnapshotStatements(env,shareId,2,selectedRecipient,principal.id):[]),
    env.DELIVERY_DB.prepare("INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('staff',?,'share.created','share',?,?)").bind(principal.id,shareId,JSON.stringify({divisionId,r2Prefix:prefix,projectId,expiresAt,imageLocationMapEnabled:Boolean(input.imageLocationMapEnabled)})),
    ...createdNotifications,
  );
  await env.DELIVERY_DB.batch(statements);
  await env.OPS_DB.batch([await auditStatement(env,request,principal,"delivery.share.created","share",shareId,divisionId,{projectId,r2Prefix:prefix,expiresAt,imageLocationMapEnabled:Boolean(input.imageLocationMapEnabled)})]);
  return{id:shareId,shareUrl:shareUrl(env,publicId,secret),accessCode,passwordProtected:Boolean(password),expiresAt,lifecycle:"created",idempotentReplay:false};
}

/** Dedicated PA path: it may create an absent share or reuse an exactly
 * compatible one, but never enters the staff update/rotation branch. */
export async function createProjectAlphaDeliveryGuestShare(env:Env,input:{
  deliveryId:string;receiptId:string;fingerprint:string;r2Prefix:string;label:string|null;expiresAt:string;
  audience:{type:AudienceType;publicId:string;sourceVersion:string};
}):Promise<{shareId:string;reused:boolean}>{
  const prefix=normalizePrefix(input.r2Prefix),project=await env.DELIVERY_DB.prepare(`SELECT id,division_id,client_name,project_name
    FROM projects WHERE active=1 AND r2_prefix=? LIMIT 2`).bind(prefix).all<{id:string;division_id:string;client_name:string;project_name:string}>();
  if(project.results.length!==1)throw new HTTPException(409,{message:"Delivery project is not uniquely live"});
  const target=project.results[0]!,selected=await resolveProjectAlphaDeliveryPrincipal(env,prefix,input.audience.publicId,input.audience.sourceVersion);
  if(!selected.recipients.length)throw new HTTPException(409,{message:"Delivery audience has no eligible recipients"});
  await env.DELIVERY_DB.prepare(`UPDATE shares SET revoked_at=datetime('now'),revoked_reason='expired'
    WHERE revoked_at IS NULL AND expires_at IS NOT NULL AND datetime(expires_at)<=datetime('now')
      AND COALESCE(r2_prefix,(SELECT r2_prefix FROM projects WHERE id=shares.project_id))=?`).bind(prefix).run();
  const active=await activeShareForPrefix(env,prefix);
  if(active){
    const paOwned=active.created_by_type==="integration"&&Boolean(await env.DELIVERY_DB.prepare(`SELECT 1 ok FROM project_alpha_delivery_intent_receipts WHERE access_mode='guest' AND resource_id=? LIMIT 1`).bind(active.id).first("ok"));
    const current=await latestShareAudienceSnapshot(env,active.id),secret=await recoverShareSecret(env,active);
    const authority=paOwned?await env.DELIVERY_DB.prepare(`SELECT workspace_id,folder_binding_id,binding_source_version,directory_generation_id,
      principal_public_id,principal_source_version,label FROM project_alpha_delivery_guest_authority WHERE share_id=? AND status='active'`)
      .bind(active.id).first<{workspace_id:string;folder_binding_id:string;binding_source_version:string;directory_generation_id:string;principal_public_id:string;principal_source_version:string;label:string|null}>():null;
    const compatible=Boolean(paOwned&&authority&&current&&secret&&active.public_id&&active.label===(input.label??null)&&authority.label===(input.label??null)&&
      authority.workspace_id===selected.workspaceId&&authority.folder_binding_id===selected.folderBindingId&&
      authority.binding_source_version===(await env.DELIVERY_DB.prepare(`SELECT source_version FROM portal_v2_folder_bindings
        WHERE id=? AND workspace_id=? AND status='active' AND revoked_at IS NULL`).bind(selected.folderBindingId,selected.workspaceId).first<string>("source_version"))&&
      authority.directory_generation_id===selected.directoryGenerationId&&authority.principal_public_id===selected.audiencePublicId&&
      authority.principal_source_version===input.audience.sourceVersion&&!active.password_hash&&!active.image_location_map_enabled&&
      active.expires_at===input.expiresAt&&current.audienceType===selected.audienceType&&
      current.audiencePublicId===selected.audiencePublicId);
    if(!compatible)throw new HTTPException(409,{message:"An active share already exists for this delivery"});
    const statements:D1PreparedStatement[]=[
      env.DELIVERY_DB.prepare(`INSERT INTO project_alpha_delivery_intent_receipts(receipt_id,delivery_id,request_fingerprint,access_mode,resource_id) VALUES(?,?,?,?,?)`).bind(input.receiptId,input.deliveryId,input.fingerprint,"guest",active.id),
      env.DELIVERY_DB.prepare(`INSERT INTO project_alpha_delivery_intent_audit(id,receipt_id,action,actor_id,details_json) VALUES(?,?,'guest.accepted',?,?)`).bind(crypto.randomUUID(),input.receiptId,input.deliveryId,JSON.stringify({reused:true,audienceType:selected.audienceType,audiencePublicId:selected.audiencePublicId})),
      ...selected.recipients.map(member=>notificationStatement(env,{shareId:active.id,kind:"share_created",recipientEmail:member.email,
        dedupeKey:notificationDedupeKey("share_created",active.id,`${input.deliveryId}:${member.principalPublicId}`),
        payload:{shareUrl:shareUrl(env,active.public_id!,secret!),clientName:target.client_name,projectName:target.project_name,r2Prefix:prefix,expiresAt:input.expiresAt}})!),
    ];
    await env.DELIVERY_DB.batch(statements);return{shareId:active.id,reused:true};
  }
  const liveBindingSource=await env.DELIVERY_DB.prepare(`SELECT source_version FROM portal_v2_folder_bindings
    WHERE id=? AND workspace_id=? AND status='active' AND revoked_at IS NULL LIMIT 2`)
    .bind(selected.folderBindingId,selected.workspaceId).all<{source_version:string}>();
  if(liveBindingSource.results.length!==1)throw new HTTPException(409,{message:"Delivery folder authority is no longer live"});
  const shareId=crypto.randomUUID(),publicId=randomToken(16),secret=randomToken(32),encrypted=await encryptDeliveryToken(secret,env.DELIVERY_TOKEN_SECRET,shareId);
  await env.DELIVERY_DB.batch([
    env.DELIVERY_DB.prepare(`INSERT INTO shares(id,project_id,token_hash,public_id,label,expires_at,recipient_email,image_location_map_enabled,
      created_by_type,created_by_id,idempotency_key,share_version,secret_ciphertext,secret_iv,r2_prefix,division_id)
      VALUES(?,?,?,?,?,?,?,0,'integration',?,?,2,?,?,?,?)`).bind(shareId,target.id,await sha256(secret),publicId,input.label,
      input.expiresAt,selected.recipients[0]?.email??null,input.deliveryId,input.deliveryId,encrypted.ciphertext,encrypted.iv,prefix,target.division_id),
    ...shareAudienceSnapshotStatements(env,shareId,2,selected,input.deliveryId),
    env.DELIVERY_DB.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES('integration',?,'share.created','share',?,?)`).bind(input.deliveryId,shareId,JSON.stringify({r2Prefix:prefix,audienceType:selected.audienceType,audiencePublicId:selected.audiencePublicId})),
    env.DELIVERY_DB.prepare(`INSERT INTO project_alpha_delivery_intent_receipts(receipt_id,delivery_id,request_fingerprint,access_mode,resource_id) VALUES(?,?,?,?,?)`).bind(input.receiptId,input.deliveryId,input.fingerprint,"guest",shareId),
    env.DELIVERY_DB.prepare(`INSERT INTO project_alpha_delivery_guest_authority(share_id,workspace_id,folder_binding_id,binding_source_version,directory_generation_id,principal_public_id,principal_source_version,label)
      VALUES(?,?,?,(SELECT source_version FROM portal_v2_folder_bindings WHERE id=? AND workspace_id=? AND source_version=?
        AND status='active' AND revoked_at IS NULL),?,?,?,?)`).bind(shareId,selected.workspaceId,selected.folderBindingId,
      selected.folderBindingId,selected.workspaceId,liveBindingSource.results[0]!.source_version,
      selected.directoryGenerationId,selected.audiencePublicId,input.audience.sourceVersion,input.label),
    env.DELIVERY_DB.prepare(`INSERT INTO project_alpha_delivery_intent_audit(id,receipt_id,action,actor_id,details_json) VALUES(?,?,'guest.accepted',?,?)`).bind(crypto.randomUUID(),input.receiptId,input.deliveryId,JSON.stringify({reused:false,audienceType:selected.audienceType,audiencePublicId:selected.audiencePublicId})),
    ...selected.recipients.map(member=>notificationStatement(env,{shareId,kind:"share_created",recipientEmail:member.email,
      dedupeKey:notificationDedupeKey("share_created",shareId,`${input.deliveryId}:${member.principalPublicId}`),payload:{shareUrl:shareUrl(env,publicId,secret),clientName:target.client_name,projectName:target.project_name,r2Prefix:prefix,expiresAt:input.expiresAt}})!),
  ]);
  return{shareId,reused:false};
}

export async function revokeProjectAlphaDeliveryGuestShare(env:Env,input:{shareId:string;deliveryId:string;
  revokeReceiptId:string;originalReceiptId:string;fingerprint:string}):Promise<void>{
  const share=await env.DELIVERY_DB.prepare(`SELECT s.id,s.r2_prefix,p.client_name,p.project_name FROM shares s
    JOIN projects p ON p.id=s.project_id WHERE s.id=? AND s.created_by_type='integration' AND s.revoked_at IS NULL
    AND EXISTS(SELECT 1 FROM project_alpha_delivery_intent_receipts r WHERE r.receipt_id=? AND r.access_mode='guest' AND r.resource_id=s.id)`)
    .bind(input.shareId,input.originalReceiptId).first<{id:string;r2_prefix:string;client_name:string;project_name:string}>();
  if(!share)throw new HTTPException(409,{message:"Delivery share is not active"});
  const audience=await latestShareAudienceSnapshot(env,share.id);
  if(!audience)throw new HTTPException(409,{message:"Delivery share audience is unavailable"});
  const results=await env.DELIVERY_DB.batch([
    env.DELIVERY_DB.prepare(`UPDATE shares SET revoked_at=datetime('now'),revoked_reason='project_alpha_delivery_revoked',share_version=share_version+1
      WHERE id=? AND revoked_at IS NULL AND created_by_type='integration'
        AND EXISTS(SELECT 1 FROM project_alpha_delivery_guest_authority WHERE share_id=shares.id AND status='active')`).bind(share.id),
    env.DELIVERY_DB.prepare(`UPDATE project_alpha_delivery_guest_authority SET status='revoked',revoked_at=datetime('now') WHERE share_id=? AND status='active' AND changes()=1`).bind(share.id),
    env.DELIVERY_DB.prepare(`INSERT INTO project_alpha_delivery_intent_revocation_receipts(receipt_id,delivery_id,original_receipt_id,request_fingerprint) SELECT ?,?,?,? WHERE changes()=1`).bind(input.revokeReceiptId,input.deliveryId,input.originalReceiptId,input.fingerprint),
    env.DELIVERY_DB.prepare(`INSERT INTO project_alpha_delivery_intent_audit(id,receipt_id,action,actor_id,details_json) SELECT ?,?,'guest.revoked',?,? WHERE changes()=1`).bind(crypto.randomUUID(),input.originalReceiptId,input.deliveryId,JSON.stringify({reasonCode:"project_alpha_delivery_revoked"})),
    ...audience.recipients.map(member=>env.DELIVERY_DB.prepare(`INSERT OR IGNORE INTO delivery_notifications
      (id,dedupe_key,share_id,kind,recipient_email,payload_json) SELECT ?,?,?,'share_revoked',?,? WHERE changes()=1`)
      .bind(crypto.randomUUID(),notificationDedupeKey("share_revoked",share.id,`${input.deliveryId}:${member.principalPublicId}`),
        share.id,member.email,JSON.stringify({clientName:share.client_name,projectName:share.project_name,r2Prefix:share.r2_prefix}))),
  ]);
  if(!results[0]?.meta.changes)throw new HTTPException(409,{message:"Delivery share is not active"});
}

export interface DeliveryShareHistoryQuery {
  q?:string;
  prefix?:string;
  cursor?:string;
  limit?:number;
}

export interface DeliveryShareHistoryPage {
  shares:any[];
  nextCursor:string|null;
}

interface DeliveryShareHistoryCursor { createdAt:string; id:string }

function encodeDeliveryShareCursor(value:DeliveryShareHistoryCursor):string{
  return b64(encoder.encode(JSON.stringify([value.createdAt,value.id])));
}

function decodeDeliveryShareCursor(value:string|undefined):DeliveryShareHistoryCursor|null{
  if(!value)return null;
  if(value.length>512||!/^[A-Za-z0-9_-]+$/.test(value))throw new HTTPException(400,{message:"Share-history cursor is invalid"});
  try{
    const raw=atob(value.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(value.length/4)*4,"="));
    const parsed=JSON.parse(decoder.decode(Uint8Array.from(raw,character=>character.charCodeAt(0))));
    if(!Array.isArray(parsed)||parsed.length!==2||typeof parsed[0]!=="string"||typeof parsed[1]!=="string"||!parsed[0]||!parsed[1]||parsed[0].length>64||parsed[1].length>160)throw new Error("invalid");
    return{createdAt:parsed[0],id:parsed[1]};
  }catch(error){
    if(error instanceof HTTPException)throw error;
    throw new HTTPException(400,{message:"Share-history cursor is invalid"});
  }
}

function shareTargetLeaf(path:string):string{return path.replace(/\/$/,"").split("/").pop()||path;}

export async function listDeliveryShares(env:Env,principal:StaffPrincipal,options:DeliveryShareHistoryQuery={}):Promise<DeliveryShareHistoryPage>{
  await requirePermission(env,principal,"delivery.share.audit");
  const scope=await sqlScope(env,principal,"delivery.share.audit");
  const limit=options.limit??50;
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new HTTPException(400,{message:"Share-history limit must be between 1 and 100"});
  if(options.prefix!==undefined&&(options.prefix.length>1024||/[\0-\x1f\x7f]/.test(options.prefix)))
    throw new HTTPException(400,{message:"Folder prefix is invalid"});
  const prefix=options.prefix===undefined?null:normalizePrefix(options.prefix);
  const submittedQuery=(options.q||"").normalize("NFC").trim();
  const pathMode=/^path\s*:/i.test(submittedQuery);
  const query=(pathMode?submittedQuery.replace(/^path\s*:/i,""):submittedQuery).trim();
  if((submittedQuery&&!query)||query.length>160||/[\0-\x1f\x7f]/.test(query))throw new HTTPException(400,{message:"Share-history search text is invalid"});
  if(scope.deniedGlobal)return{shares:[],nextCursor:null};
  let scopeWhere="1=1",scopeValues:unknown[]=[];
  if(!scope.global){
    if(!scope.divisions.length)return{shares:[],nextCursor:null};
    scopeWhere=`COALESCE(s.division_id,p.division_id) IN (${scope.divisions.map(()=>"?").join(",")})`;
    scopeValues=scope.divisions;
  }
  const escaped=query.toLowerCase().replace(/[\\%_]/g,"\\$&"),like=`%${escaped}%`;
  const targetExpression="COALESCE(s.r2_object_key,s.r2_prefix,p.r2_prefix)";
  // Match the share's actual target, not just its project/parent folder. Binary
  // bounds preserve case and treat SQL wildcard characters as literal names.
  const prefixWhere=prefix?`AND ${targetExpression} COLLATE BINARY>=? AND ${targetExpression} COLLATE BINARY<?`:"";
  const prefixValues=prefix?[prefix,prefixUpperBound(prefix)]:[];
  const searchWhere=query?`AND (
    lower(COALESCE(s.label,'')) LIKE ? ESCAPE '\\' OR
    lower(p.client_name) LIKE ? ESCAPE '\\' OR
    lower(p.project_name) LIKE ? ESCAPE '\\' OR
    lower(${targetExpression}) LIKE ? ESCAPE '\\' OR
    lower(COALESCE(target_alias.display_name,'')) LIKE ? ESCAPE '\\'
  )`:"";
  const searchValues=query?[like,like,like,like,like]:[];
  let databaseCursor=decodeDeliveryShareCursor(options.cursor),exhausted=false;
  const matching:any[]=[];
  while(matching.length<limit+1&&!exhausted){
    const cursorWhere=databaseCursor?"AND (s.created_at<? OR (s.created_at=? AND s.id<?))":"";
    const cursorValues=databaseCursor?[databaseCursor.createdAt,databaseCursor.createdAt,databaseCursor.id]:[];
    const batchLimit=query?100:limit+1;
    const result=await env.DELIVERY_DB.prepare(`SELECT
      s.id,s.public_id,s.label,s.expires_at,s.revoked_at,s.revoked_reason,s.unavailable_since,
      s.created_at,s.last_accessed_at,s.access_count,(s.password_hash IS NOT NULL) password_protected,
      p.client_name,p.project_name,COALESCE(s.r2_prefix,p.r2_prefix) AS r2_prefix,
      COALESCE(s.division_id,p.division_id) AS division_id,${targetExpression} AS target_path,
      CASE WHEN s.r2_object_key IS NULL THEN 'folder' ELSE 'file' END AS target_kind,
      target_alias.display_name AS target_alias
      FROM shares s JOIN projects p ON p.id=s.project_id
      LEFT JOIN file_aliases target_alias ON target_alias.physical_key=${targetExpression}
      WHERE ${scopeWhere} ${prefixWhere} ${searchWhere} ${cursorWhere}
      ORDER BY s.created_at DESC,s.id DESC LIMIT ?`)
      .bind(...scopeValues,...prefixValues,...searchValues,...cursorValues,batchLimit).all<any>();
    exhausted=result.results.length<batchLimit;
    for(const row of result.results){
      databaseCursor={createdAt:row.created_at,id:row.id};
      const leaf=shareTargetLeaf(row.target_path),displayName=row.target_alias||leaf;
      const normalized=query.toLowerCase();
      const directlyRelated=!query||(pathMode
        ?String(row.target_path).toLowerCase().includes(normalized)
        :[row.label,row.client_name,row.project_name,displayName,leaf]
          .some(value=>String(value||"").toLowerCase().includes(normalized)));
      if(directlyRelated)matching.push({...row,display_name:displayName});
      if(matching.length>=limit+1)break;
    }
    if(!result.results.length)exhausted=true;
  }
  const shares=matching.slice(0,limit);
  return{
    shares,
    nextCursor:matching.length>limit?encodeDeliveryShareCursor({createdAt:shares.at(-1).created_at,id:shares.at(-1).id}):null,
  };
}

export async function revokeDeliveryShare(env:Env,request:Request,principal:StaffPrincipal,shareId:string){const share=await env.DELIVERY_DB.prepare("SELECT s.id,COALESCE(s.division_id,p.division_id) AS division_id,s.recipient_email,p.client_name,p.project_name,COALESCE(s.r2_prefix,p.r2_prefix) r2_prefix FROM shares s JOIN projects p ON p.id=s.project_id WHERE s.id=?").bind(shareId).first<{id:string;division_id:string|null;recipient_email:string|null;client_name:string;project_name:string;r2_prefix:string}>();if(!share)throw new HTTPException(404,{message:"Share not found"});await requirePermission(env,principal,"delivery.share.revoke",{divisionId:share.division_id},true);const audience=shareDirectoryRecipientsEnabled(env)?await latestShareAudienceSnapshot(env,shareId):null;const notifications=audience?audience.recipients.map(member=>notificationStatement(env,{shareId,kind:"share_revoked",recipientEmail:member.email,dedupeKey:notificationDedupeKey("share_revoked",shareId,member.principalPublicId),payload:{clientName:share.client_name,projectName:share.project_name,r2Prefix:share.r2_prefix}})!):[notificationStatement(env,{shareId,kind:"share_revoked",recipientEmail:share.recipient_email,payload:{clientName:share.client_name,projectName:share.project_name,r2Prefix:share.r2_prefix}})].filter((value):value is D1PreparedStatement=>Boolean(value));const result=await env.DELIVERY_DB.batch([env.DELIVERY_DB.prepare("UPDATE shares SET revoked_at=datetime('now'),revoked_reason='manual',share_version=share_version+1 WHERE id=? AND revoked_at IS NULL").bind(shareId),env.DELIVERY_DB.prepare("INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id) VALUES ('staff',?,'share.revoked','share',?)").bind(principal.id,shareId),...notifications]);if(!result[0]?.meta.changes)throw new HTTPException(404,{message:"Share not found or already revoked"});await env.OPS_DB.batch([await auditStatement(env,request,principal,"delivery.share.revoked","share",shareId,share.division_id)]);}
