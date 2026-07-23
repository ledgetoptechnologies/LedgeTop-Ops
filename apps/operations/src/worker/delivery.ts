import { HTTPException } from "hono/http-exception";
import type { DeliveryItem } from "@ltds/shared";
import { accessCodeMatches, decryptDeliveryToken, encryptDeliveryToken, hashAccessCode, randomToken, sha256 } from "./crypto";
import { requirePermission, sqlScope } from "./acl";
import { auditStatement } from "./request-security";
import type { Env, StaffPrincipal } from "./types";

const encoder = new TextEncoder(); const decoder = new TextDecoder("utf-8", { fatal: true });
const MIME: Record<string,string> = { avif:"image/avif",bmp:"image/bmp",gif:"image/gif",jpeg:"image/jpeg",jpg:"image/jpeg",png:"image/png",tif:"image/tiff",tiff:"image/tiff",webp:"image/webp",mp4:"video/mp4",m4v:"video/x-m4v",webm:"video/webm",mov:"video/quicktime",mp3:"audio/mpeg",m4a:"audio/mp4",wav:"audio/wav",ogg:"audio/ogg",pdf:"application/pdf",txt:"text/plain; charset=utf-8",csv:"text/csv; charset=utf-8",json:"application/json; charset=utf-8" };

function b64(bytes: Uint8Array): string { let value=""; for(const byte of bytes)value+=String.fromCharCode(byte); return btoa(value).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
export function encodeRef(value:string):string{return b64(encoder.encode(value));}
export function decodeRef(value:string):string{if(!/^[A-Za-z0-9_-]+$/.test(value))throw new HTTPException(400,{message:"Invalid item reference"});try{const raw=atob(value.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(value.length/4)*4,"="));return validateRelative(decoder.decode(Uint8Array.from(raw,c=>c.charCodeAt(0))));}catch(error){if(error instanceof HTTPException)throw error;throw new HTTPException(400,{message:"Invalid item reference"});}}
function validateRelative(value:string):string{if(!value||value.startsWith("/")||value.includes("\\")||/[\0-\x1f\x7f]/.test(value))throw new HTTPException(400,{message:"Invalid item path"});const parts=value.split("/");if(parts.some(part=>!part||part==="."||part===".."||part.toLowerCase()==="dump"||part.toLowerCase()==="_ltds"))throw new HTTPException(404,{message:"Item not found"});return parts.join("/");}
export function normalizePrefix(value:string):string{const prefix=value.trim().replace(/\\/g,"/").replace(/^\/+/,"").replace(/\/{2,}/g,"/").replace(/\/$/,"");if(!prefix||prefix.split("/").some(part=>!part||part==="."||part===".."||part.toLowerCase()==="dump"||part.toLowerCase()==="_ltds"))throw new HTTPException(400,{message:"Folder prefix is invalid"});return `${prefix}/`;}
function hidden(key:string):boolean{const parts=key.replace(/\\/g,"/").split("/").filter(Boolean);return parts.some(part=>part.toLowerCase()==="dump"||part.toLowerCase()==="_ltds");}
function ext(key:string):string{const name=key.split("/").pop()||"";return name.includes(".")?(name.split(".").pop()||"").toLowerCase():"";}
export function mime(key:string):string{return MIME[ext(key)]||"application/octet-stream";}
export function mediaKind(key:string):DeliveryItem["kind"]{const value=mime(key);if(value.startsWith("image/"))return"image";if(value.startsWith("video/"))return"video";if(value.startsWith("audio/"))return"audio";if(value==="application/pdf")return"pdf";if(value.startsWith("text/")||value.startsWith("application/json"))return"text";return"other";}

interface FolderAssociation { division_id: string; r2_prefix: string }

async function browseRoots(env:Env,principal:StaffPrincipal):Promise<{global:boolean;roots:Array<{prefix:string;name:string;divisionId:string}>}>{const scope=await sqlScope(env,principal,"delivery.browse");if(scope.global)return{global:true,roots:[]};if(!scope.divisions.length)return{global:false,roots:[]};const result=await env.OPS_DB.prepare(`SELECT pf.r2_prefix,p.name,pf.division_id FROM project_folders pf LEFT JOIN pa_projects p ON p.id=pf.project_id WHERE pf.division_id IN (${scope.divisions.map(()=>"?").join(",")}) ORDER BY p.name,pf.r2_prefix`).bind(...scope.divisions).all<{r2_prefix:string;name:string|null;division_id:string}>();return{global:false,roots:result.results.map(row=>({prefix:normalizePrefix(row.r2_prefix),name:row.name||row.r2_prefix,divisionId:row.division_id}))};}

export function resolveDivisionAssociation(prefix:string,associations:FolderAssociation[]):string|null{const matches=associations.map(row=>({divisionId:row.division_id,prefix:normalizePrefix(row.r2_prefix)})).filter(row=>prefix.startsWith(row.prefix));if(!matches.length)return null;const longest=Math.max(...matches.map(row=>row.prefix.length));const divisions=[...new Set(matches.filter(row=>row.prefix.length===longest).map(row=>row.divisionId))];if(divisions.length!==1)throw new HTTPException(409,{message:"Folder is associated with multiple divisions and requires review"});return divisions[0]!;}

async function inferDivisionId(env:Env,prefix:string):Promise<string|null>{const associations=await env.OPS_DB.prepare("SELECT division_id,r2_prefix FROM project_folders ORDER BY length(r2_prefix) DESC").all<FolderAssociation>();return resolveDivisionAssociation(prefix,associations.results);}

export function resolveShareExpiration(value:string|null|undefined,maxDays:number,now=Date.now()):string|null{if(value===null||value===undefined||value==="")return null;const requested=new Date(value);if(Number.isNaN(requested.getTime())||requested.getTime()<=now||requested.getTime()>now+maxDays*86400000)throw new HTTPException(400,{message:`Expiration must be within ${maxDays} days`});return requested.toISOString();}

export async function listDeliveryFolder(env:Env,principal:StaffPrincipal,prefixValue:string,cursor?:string){
  await requirePermission(env,principal,"delivery.browse");
  const access=await browseRoots(env,principal);
  if(!access.global&&!prefixValue){const activeShares=await env.DELIVERY_DB.prepare(`SELECT COALESCE(s.r2_prefix,p.r2_prefix) r2_prefix FROM shares s JOIN projects p ON p.id=s.project_id WHERE s.revoked_at IS NULL AND p.active=1 AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))`).all<{r2_prefix:string}>();const shared=(key:string)=>activeShares.results.some(share=>{try{return key.startsWith(normalizePrefix(share.r2_prefix));}catch{return false;}});return{prefix:"",folders:access.roots.map(root=>({id:encodeRef(root.prefix.slice(0,-1)),prefix:root.prefix,name:root.name,isShared:shared(root.prefix)})),files:[],nextCursor:null};}
  const prefix=prefixValue?normalizePrefix(prefixValue):"";
  if(!access.global&&!access.roots.some(root=>prefix.startsWith(root.prefix)))throw new HTTPException(404,{message:"Folder not found"});
  const listed=await env.DATA_BUCKET.list({prefix,delimiter:"/",limit:500,cursor});
  const activeShares=await env.DELIVERY_DB.prepare(`SELECT COALESCE(s.r2_prefix,p.r2_prefix) r2_prefix FROM shares s JOIN projects p ON p.id=s.project_id WHERE s.revoked_at IS NULL AND p.active=1 AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))`).all<{r2_prefix:string}>();
  const shared=(key:string)=>activeShares.results.some(share=>{try{return key.startsWith(normalizePrefix(share.r2_prefix));}catch{return false;}});
  const folders=listed.delimitedPrefixes.filter(value=>!hidden(value)).map(value=>({id:encodeRef(value.slice(0,-1)),prefix:value,name:value.slice(prefix.length).replace(/\/$/,""),isShared:shared(value)}));
  const files=listed.objects.filter(object=>object.key!==prefix&&!object.key.endsWith("/")&&!hidden(object.key));
  const items=files.map(object=>{const id=encodeRef(object.key);const kind=mediaKind(object.key);return{id,name:object.key.slice(prefix.length),kind,size:object.size,uploadedAt:object.uploaded.toISOString(),isShared:shared(object.key),previewUrl:["image","video","audio","pdf","text"].includes(kind)?`/api/delivery/items/${id}/preview`:undefined,thumbnailUrl:kind==="image"?`/api/delivery/items/${id}/thumbnail`:undefined,downloadUrl:`/api/delivery/items/${id}/download`};});
  if(env.STREAM_CUSTOMER_CODE){
    const videos=files.map((object,index)=>({object,index})).filter(value=>mediaKind(value.object.key)==="video");
    if(videos.length){
      const rows=await env.DELIVERY_DB.batch(videos.map(video=>env.DELIVERY_DB.prepare("SELECT stream_uid,stream_status FROM file_index WHERE r2_key=?").bind(video.object.key)));
      await Promise.all(rows.map(async(result,index)=>{const row=result.results[0] as {stream_uid?:string;stream_status?:string}|undefined;if(row?.stream_status!=="ready"||!row.stream_uid)return;const token=await env.STREAM.video(row.stream_uid).generateToken();const item=items[videos[index]!.index]!;item.previewUrl=`/api/delivery/items/${encodeRef(videos[index]!.object.key)}/preview`;item.thumbnailUrl=`https://customer-${env.STREAM_CUSTOMER_CODE}.cloudflarestream.com/${token}/thumbnails/thumbnail.jpg?time=1s&height=340`;}));
    }
  }
  return{prefix,folders,files:items,nextCursor:listed.truncated?listed.cursor:null};
}

export async function authorizeItem(env:Env,principal:StaffPrincipal,itemRef:string):Promise<string>{await requirePermission(env,principal,"delivery.browse");const key=decodeRef(itemRef);if(hidden(key))throw new HTTPException(404,{message:"Item not found"});const access=await browseRoots(env,principal);if(!access.global&&!access.roots.some(root=>key.startsWith(root.prefix)))throw new HTTPException(404,{message:"Item not found"});return key;}

export interface ShareInput{clientName?:string;projectName?:string;r2Prefix?:string;projectId?:string;externalRef?:string;label?:string;accessCode?:string;generateAccessCode?:boolean;removeAccessCode?:boolean;expiresAt?:string|null;}
export function deriveShareMetadata(prefix:string,input:Pick<ShareInput,"clientName"|"projectName">={}):{clientName:string;projectName:string}{const folderName=normalizePrefix(prefix).slice(0,-1).split("/").pop()||"Shared folder";return{clientName:input.clientName?.trim()||folderName,projectName:input.projectName?.trim()||folderName};}

interface ProjectRow { id:string;division_id:string|null;r2_prefix:string }
interface ActiveShareRow {
  id:string;project_id:string;public_id:string|null;password_hash:string|null;password_salt:string|null;password_iterations:number|null;password_algorithm:string|null;
  expires_at:string|null;idempotency_key:string|null;share_version:number;secret_ciphertext:string|null;secret_iv:string|null;division_id:string|null;
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

async function authorizeSharePrefix(env:Env,principal:StaffPrincipal,prefix:string,projectId?:string):Promise<{project:ProjectRow|null;divisionId:string|null}>{
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

async function activeShareForPrefix(env:Env,prefix:string):Promise<ActiveShareRow|null>{
  return env.DELIVERY_DB.prepare(`SELECT s.id,s.project_id,s.public_id,s.password_hash,s.password_salt,s.password_iterations,s.password_algorithm,s.expires_at,s.idempotency_key,s.share_version,s.secret_ciphertext,s.secret_iv,COALESCE(s.division_id,p.division_id) AS division_id
    FROM shares s JOIN projects p ON p.id=s.project_id
    WHERE COALESCE(s.r2_prefix,p.r2_prefix)=? AND s.revoked_at IS NULL AND p.active=1
      AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))
    ORDER BY s.created_at DESC LIMIT 1`).bind(prefix).first<ActiveShareRow>();
}

async function recoverShareSecret(env:Env,share:ActiveShareRow):Promise<string|null>{
  if(!share.secret_ciphertext||!share.secret_iv)return null;
  try{return await decryptDeliveryToken(share.secret_ciphertext,share.secret_iv,env.DELIVERY_TOKEN_SECRET,share.id);}catch{return null;}
}

function shareUrl(env:Env,publicId:string,secret:string):string{return`${env.DELIVERY_BASE_URL.replace(/\/$/,"")}/s/${publicId}#${secret}`;}

export async function getActiveDeliveryShare(env:Env,principal:StaffPrincipal,prefixValue:string){
  const prefix=normalizePrefix(prefixValue);await authorizeSharePrefix(env,principal,prefix);const share=await activeShareForPrefix(env,prefix);
  if(!share)return null;await requirePermission(env,principal,"delivery.share.create",{divisionId:share.division_id},true);const secret=await recoverShareSecret(env,share);
  return{id:share.id,shareUrl:secret&&share.public_id?shareUrl(env,share.public_id,secret):null,passwordProtected:Boolean(share.password_hash),expiresAt:share.expires_at,recoverable:Boolean(secret&&share.public_id)};
}

export async function createDeliveryShare(env:Env,request:Request,principal:StaffPrincipal,input:ShareInput,idempotencyKey:string):Promise<ShareLifecycleResult>{
  if(!idempotencyKey||idempotencyKey.length>120)throw new HTTPException(400,{message:"Idempotency-Key is required"});
  if(!input.r2Prefix)throw new HTTPException(400,{message:"r2Prefix is required"});
  const prefix=normalizePrefix(input.r2Prefix),{clientName,projectName}=deriveShareMetadata(prefix,input);
  const{project,divisionId}=await authorizeSharePrefix(env,principal,prefix,input.projectId);
  const owner=Boolean(await env.OPS_DB.prepare("SELECT 1 ok FROM staff_role_assignments WHERE staff_id=? AND role_id='role-owner' AND scope='global'").bind(principal.id).first());
  const requestedExpiration=input.expiresAt===undefined?undefined:resolveShareExpiration(input.expiresAt,owner?365:90);
  const codeChange=resolveAccessCodeChange(input);

  await env.DELIVERY_DB.prepare(`UPDATE shares SET revoked_at=datetime('now'),revoked_reason='expired' WHERE revoked_at IS NULL AND expires_at IS NOT NULL
    AND datetime(expires_at)<=datetime('now') AND COALESCE(r2_prefix,(SELECT r2_prefix FROM projects WHERE id=shares.project_id))=?`).bind(prefix).run();
  await env.DELIVERY_DB.prepare(`UPDATE shares SET revoked_at=datetime('now'),revoked_reason='project_inactive' WHERE revoked_at IS NULL
    AND COALESCE(r2_prefix,(SELECT r2_prefix FROM projects WHERE id=shares.project_id))=?
    AND EXISTS (SELECT 1 FROM projects WHERE projects.id=shares.project_id AND projects.active=0)`).bind(prefix).run();
  let active=await activeShareForPrefix(env,prefix);
  if(active){
    for(let attempt=0;attempt<2;attempt+=1){
      await requirePermission(env,principal,"delivery.share.create",{divisionId:active.division_id},true);
      const previousSecret=await recoverShareSecret(env,active),replay=active.idempotency_key===idempotencyKey;
      if(attempt===0&&replay&&previousSecret&&active.public_id)return{id:active.id,shareUrl:shareUrl(env,active.public_id,previousSecret),accessCode:null,passwordProtected:Boolean(active.password_hash),expiresAt:active.expires_at,lifecycle:"reused",idempotentReplay:true};

      const sameCode=codeChange.kind==="set"&&Boolean(active.password_hash&&active.password_salt)&&await accessCodeMatches(codeChange.accessCode!,active.password_hash!,active.password_salt!,active.password_algorithm,env.DELIVERY_ACCESS_CODE_PEPPER);
      const securityEquivalent=codeChange.kind==="preserve"||(codeChange.kind==="remove"&&!active.password_hash)||(codeChange.kind==="set"&&sameCode);
      if(attempt>0&&!securityEquivalent)throw new HTTPException(409,{message:"This share changed while you were editing it. Reopen the share and try again."});

      const effectiveCodeChange=securityEquivalent?{kind:"preserve" as const,accessCode:null}:codeChange;
      const securityChanged=effectiveCodeChange.kind!=="preserve",expiresAt=requestedExpiration===undefined?active.expires_at:requestedExpiration;
      const expirationChanged=expiresAt!==active.expires_at,mustRotate=securityChanged||!previousSecret,publicIdChanged=!active.public_id;
      if(!mustRotate&&!expirationChanged&&!publicIdChanged)return{id:active.id,shareUrl:shareUrl(env,active.public_id!,previousSecret!),accessCode:sameCode?codeChange.accessCode:null,passwordProtected:Boolean(active.password_hash),expiresAt:active.expires_at,lifecycle:"reused",idempotentReplay:replay};

      const nextPublicId=active.public_id||randomToken(16),nextSecret=mustRotate?randomToken(32):previousSecret!;
      const encrypted=mustRotate?await encryptDeliveryToken(nextSecret,env.DELIVERY_TOKEN_SECRET,active.id):{ciphertext:active.secret_ciphertext!,iv:active.secret_iv!};
      const password=effectiveCodeChange.kind==="set"?await hashAccessCode(effectiveCodeChange.accessCode!,env.DELIVERY_ACCESS_CODE_PEPPER):null;
      const passwordHash=effectiveCodeChange.kind==="preserve"?active.password_hash:password?.hash||null;
      const passwordSalt=effectiveCodeChange.kind==="preserve"?active.password_salt:password?.salt||null;
      const passwordIterations=effectiveCodeChange.kind==="preserve"?active.password_iterations:password?.iterations||null;
      const passwordAlgorithm=effectiveCodeChange.kind==="preserve"?active.password_algorithm:password?.algorithm||null;
      const lifecycle:ShareLifecycleResult["lifecycle"]=mustRotate?"rotated":"updated",tokenHash=mustRotate?await sha256(nextSecret):null;
      const updated=await env.DELIVERY_DB.prepare(`UPDATE shares SET token_hash=COALESCE(?,token_hash),public_id=COALESCE(public_id,?),secret_ciphertext=?,secret_iv=?,password_hash=?,password_salt=?,password_iterations=?,password_algorithm=?,expires_at=?,idempotency_key=?,r2_prefix=?,division_id=COALESCE(division_id,?),share_version=share_version+1 WHERE id=? AND share_version=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM projects WHERE projects.id=shares.project_id AND projects.active=1)`).bind(tokenHash,nextPublicId,encrypted.ciphertext,encrypted.iv,passwordHash,passwordSalt,passwordIterations,passwordAlgorithm,expiresAt,idempotencyKey,prefix,divisionId,active.id,active.share_version).run();
      if(!updated.meta.changes){const latest=await activeShareForPrefix(env,prefix);if(!latest)throw new HTTPException(409,{message:"This share changed while you were editing it. Reopen the share and try again."});active=latest;continue;}

      await env.DELIVERY_DB.prepare("INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('staff',?,?,?,?,?)").bind(principal.id,`share.${lifecycle}`,'share',active.id,JSON.stringify({divisionId,r2Prefix:prefix,securityChanged,expiresAt})).run();
      await env.OPS_DB.batch([await auditStatement(env,request,principal,`delivery.share.${lifecycle}`,"share",active.id,divisionId,{r2Prefix:prefix,securityChanged,expiresAt})]);
      return{id:active.id,shareUrl:shareUrl(env,nextPublicId,nextSecret),accessCode:effectiveCodeChange.kind==="set"?effectiveCodeChange.accessCode:null,passwordProtected:Boolean(passwordHash),expiresAt,lifecycle,idempotentReplay:false};
    }
    throw new HTTPException(409,{message:"This share changed while you were editing it. Reopen the share and try again."});
  }

  const accessCode=codeChange.kind==="set"?codeChange.accessCode:null,password=accessCode?await hashAccessCode(accessCode,env.DELIVERY_ACCESS_CODE_PEPPER):null;
  const expiresAt=requestedExpiration===undefined?null:requestedExpiration;
  const projectId=project?.id||input.projectId||crypto.randomUUID(),shareId=crypto.randomUUID(),publicId=randomToken(16),secret=randomToken(32);
  const encrypted=await encryptDeliveryToken(secret,env.DELIVERY_TOKEN_SECRET,shareId);
  const statements:D1PreparedStatement[]=[];
  if(!project)statements.push(env.DELIVERY_DB.prepare("INSERT INTO projects (id,external_ref,client_name,project_name,r2_prefix,division_id,created_by) VALUES (?,?,?,?,?,?,NULL)").bind(projectId,input.externalRef?.trim()||null,clientName,projectName,prefix,divisionId));
  statements.push(
    env.DELIVERY_DB.prepare(`INSERT INTO shares (id,project_id,token_hash,public_id,label,password_hash,password_salt,password_iterations,password_algorithm,expires_at,created_by_type,created_by_id,idempotency_key,share_version,secret_ciphertext,secret_iv,r2_prefix,division_id) VALUES (?,?,?,?,?,?,?,?,?,?,'staff',?,?,2,?,?,?,?)`).bind(shareId,projectId,await sha256(secret),publicId,input.label?.trim()||null,password?.hash||null,password?.salt||null,password?.iterations||null,password?.algorithm||null,expiresAt,principal.id,idempotencyKey,encrypted.ciphertext,encrypted.iv,prefix,divisionId),
    env.DELIVERY_DB.prepare("INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('staff',?,'share.created','share',?,?)").bind(principal.id,shareId,JSON.stringify({divisionId,r2Prefix:prefix,projectId,expiresAt})),
  );
  await env.DELIVERY_DB.batch(statements);
  await env.OPS_DB.batch([await auditStatement(env,request,principal,"delivery.share.created","share",shareId,divisionId,{projectId,r2Prefix:prefix,expiresAt})]);
  return{id:shareId,shareUrl:shareUrl(env,publicId,secret),accessCode,passwordProtected:Boolean(password),expiresAt,lifecycle:"created",idempotentReplay:false};
}

export async function listDeliveryShares(env:Env,principal:StaffPrincipal){await requirePermission(env,principal,"delivery.share.audit");const scope=await sqlScope(env,principal,"delivery.share.audit");if(scope.deniedGlobal)return[];let where="1=1",values:unknown[]=[];if(!scope.global){if(!scope.divisions.length)return[];where=`COALESCE(s.division_id,p.division_id) IN (${scope.divisions.map(()=>"?").join(",")})`;values=scope.divisions;}const result=await env.DELIVERY_DB.prepare(`SELECT s.id,s.public_id,s.label,s.expires_at,s.revoked_at,s.revoked_reason,s.created_at,s.last_accessed_at,s.access_count,(s.password_hash IS NOT NULL) password_protected,p.client_name,p.project_name,COALESCE(s.r2_prefix,p.r2_prefix) AS r2_prefix,COALESCE(s.division_id,p.division_id) AS division_id FROM shares s JOIN projects p ON p.id=s.project_id WHERE ${where} ORDER BY s.created_at DESC LIMIT 200`).bind(...values).all();return result.results;}

export async function revokeDeliveryShare(env:Env,request:Request,principal:StaffPrincipal,shareId:string){const share=await env.DELIVERY_DB.prepare("SELECT s.id,COALESCE(s.division_id,p.division_id) AS division_id FROM shares s JOIN projects p ON p.id=s.project_id WHERE s.id=?").bind(shareId).first<{id:string;division_id:string|null}>();if(!share)throw new HTTPException(404,{message:"Share not found"});await requirePermission(env,principal,"delivery.share.revoke",{divisionId:share.division_id},true);const result=await env.DELIVERY_DB.batch([env.DELIVERY_DB.prepare("UPDATE shares SET revoked_at=datetime('now'),revoked_reason='manual' WHERE id=? AND revoked_at IS NULL").bind(shareId),env.DELIVERY_DB.prepare("INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id) VALUES ('staff',?,'share.revoked','share',?)").bind(principal.id,shareId)]);if(!result[0]?.meta.changes)throw new HTTPException(404,{message:"Share not found or already revoked"});await env.OPS_DB.batch([await auditStatement(env,request,principal,"delivery.share.revoked","share",shareId,share.division_id)]);}
