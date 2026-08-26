import { HTTPException } from "hono/http-exception";

const MAX_KEY_LENGTH=1000;
const MAX_R2_KEY_BYTES=1024;
export const MAX_BROWSER_UPLOAD_FILES = 100;
export const MAX_BROWSER_UPLOAD_BYTES = 500 * 1024 ** 3;
export const MAX_BROWSER_UPLOAD_FILE_BYTES = 500 * 1024 ** 3;
function reservedSegment(value:string):boolean{const segment=value.toLowerCase();return segment==="dump"||segment==="_ltds"||segment===".previews";}

export function normalizeCrudKey(value:unknown,folder=false):string{
  if(typeof value!=="string"||value.length>MAX_KEY_LENGTH||/[\0-\x1f\x7f]/.test(value))throw new HTTPException(400,{message:"A valid R2 path is required"});
  const normalized=value.trim().replace(/\\/g,"/").replace(/^\/+/,"").replace(/\/{2,}/g,"/"),clean=normalized.replace(/\/+$/,""),parts=clean.split("/");
  if(!clean||parts.some(part=>!part||part==="."||part===".."||reservedSegment(part)))throw new HTTPException(400,{message:"The R2 path is reserved or invalid"});
  const deliveryRoot=clean==="Jobs/Clients";
  if((deliveryRoot&&!folder)||(!deliveryRoot&&!clean.startsWith("Jobs/Clients/")))throw new HTTPException(400,{message:"R2 paths must be under Jobs/Clients"});
  const result=folder?`${clean}/`:clean;
  if(new TextEncoder().encode(result).byteLength>MAX_R2_KEY_BYTES)throw new HTTPException(400,{message:"The R2 path exceeds the 1,024-byte storage limit"});
  return result;
}

/**
 * Delete-only escape hatch for Operations administrators.  It deliberately does
 * not change the ordinary CRUD root: create, copy, move, rename and upload stay
 * confined to Jobs/Clients.  The Jobs root itself and every system-reserved
 * segment remain forbidden.
 */
export function normalizeAdministratorDeleteKey(value:unknown,folder=false):string{
  if(typeof value!=="string"||value.length>MAX_KEY_LENGTH||/[\0-\x1f\x7f]/.test(value))throw new HTTPException(400,{message:"A valid R2 path is required"});
  const normalized=value.trim().replace(/\\/g,"/").replace(/^\/+/,"").replace(/\/{2,}/g,"/"),clean=normalized.replace(/\/+$/,""),parts=clean.split("/");
  if(!clean||clean==="Jobs"||!clean.startsWith("Jobs/")||parts.some(part=>!part||part==="."||part===".."||reservedSegment(part)||part.toLowerCase()==="incoming"))throw new HTTPException(400,{message:"Administrator deletion is limited to non-system content under Jobs/"});
  const result=folder?`${clean}/`:clean;
  if(new TextEncoder().encode(result).byteLength>MAX_R2_KEY_BYTES)throw new HTTPException(400,{message:"The R2 path exceeds the 1,024-byte storage limit"});
  return result;
}

export function normalizeUploadRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_KEY_LENGTH || value.startsWith("/") ||
    value.includes("\\") || value.endsWith("/") || value.includes("//") || /[\0-\x1f\x7f]/.test(value)) {
    throw new HTTPException(400, { message: "Upload relative path is invalid" });
  }
  const normalized = value.normalize("NFC");
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || reservedSegment(part))) {
    throw new HTTPException(400, { message: "Upload relative path is invalid" });
  }
  return normalized;
}

export function browserUploadContentType(value: unknown): string {
  if (value === undefined || value === null || value === "") return "application/octet-stream";
  if (typeof value !== "string" || value.length > 200 ||
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value)) {
    throw new HTTPException(400, { message: "Upload content type is invalid" });
  }
  const normalized = value.toLowerCase();
  if (["text/html", "image/svg+xml", "application/xhtml+xml", "application/javascript", "text/javascript"].includes(normalized)) {
    throw new HTTPException(415, { message: "Active web content cannot be uploaded to delivery storage" });
  }
  return normalized;
}

export function browserUploadObjectKey(rootPrefix: unknown, relativePath: unknown): { root: string; relative: string; key: string } {
  const root = normalizeCrudKey(rootPrefix, true);
  const relative = normalizeUploadRelativePath(relativePath);
  const key = normalizeCrudKey(`${root}${relative}`, false);
  if (!key.startsWith(root)) throw new HTTPException(400, { message: "Upload path escapes the selected folder" });
  return { root, relative, key };
}

export function assertSafeCrudDestination(source:string,target:string,folder:boolean):void{
  const normalizedSource=normalizeCrudKey(source,folder),normalizedTarget=normalizeCrudKey(target,folder);
  if(normalizedSource===normalizedTarget)throw new HTTPException(400,{message:"Source and destination must differ"});
  if(folder&&normalizedTarget.startsWith(normalizedSource))throw new HTTPException(400,{message:"A folder cannot be copied, moved, or renamed into one of its own descendants"});
}

export function operationsMultipartPartSize(size:number):number{const minimum=32*1024**2,fiveMiB=5*1024**2;return Math.max(minimum,Math.ceil(Math.ceil(size/10_000)/fiveMiB)*fiveMiB);}

function pathParts(path:string):string[]{return path.split("?")[0]!.split("/").filter(Boolean);}
function delegatedRouteToken(value:string|undefined):boolean{return Boolean(value&&/^[A-Za-z0-9_-]+$/.test(value));}

export function requiresAdministratorForMutation(method:string,path:string):boolean{
  const normalizedMethod=method.toUpperCase();
  if(!["POST","PUT","PATCH","DELETE"].includes(normalizedMethod))return false;
  const parts=pathParts(path);
  const shareCreate=normalizedMethod==="POST"&&parts.length===3&&parts[0]==="api"&&parts[1]==="delivery"&&parts[2]==="shares";
  const shareRevoke=normalizedMethod==="DELETE"&&parts.length===4&&parts[0]==="api"&&parts[1]==="delivery"&&parts[2]==="shares"&&delegatedRouteToken(parts[3]);
  const internalFolderGrantCreate=normalizedMethod==="POST"&&parts.length===5&&parts[0]==="api"&&parts[1]==="client-portal"&&parts[2]==="accounts"&&delegatedRouteToken(parts[3])&&parts[4]==="folder-grants";
  const internalFolderGrantRevoke=normalizedMethod==="DELETE"&&parts.length===6&&parts[0]==="api"&&parts[1]==="client-portal"&&parts[2]==="accounts"&&delegatedRouteToken(parts[3])&&parts[4]==="folder-grants"&&delegatedRouteToken(parts[5]);
  // Notification-only controls use current folder-scoped delivery permissions.
  // No other notification endpoint or method bypasses the administrator gate.
  const folderNotificationControl=normalizedMethod==="POST"&&parts.length===5&&parts[0]==="api"&&parts[1]==="notifications"&&parts[2]==="deliveries"&&delegatedRouteToken(parts[3])&&["send-now","cancel"].includes(parts[4]||"");
  // This exact endpoint independently checks current source/division authority.
  const feedbackTransition=normalizedMethod==="POST"&&parts.length===5&&parts[0]==="api"&&parts[1]==="operations"&&parts[2]==="feedback"&&delegatedRouteToken(parts[3])&&parts[4]==="status";
  const streamTicket=normalizedMethod==="POST"&&parts.length===5&&parts[0]==="api"&&parts[1]==="delivery"&&parts[2]==="items"&&delegatedRouteToken(parts[3])&&parts[4]==="stream-ticket";
  const incomingLink=parts.length>=3&&parts[0]==="api"&&parts[1]==="delivery"&&parts[2]==="incoming-link";
  const dropboxImport=parts.length>=3&&parts[0]==="api"&&parts[1]==="dropbox-import";
  const viewerPublicShareCreate=normalizedMethod==="POST"&&parts.length===5&&parts[0]==="api"&&parts[1]==="viewer"&&parts[2]==="models"&&delegatedRouteToken(parts[3])&&parts[4]==="shares";
  const viewerPublicShareRevoke=normalizedMethod==="DELETE"&&parts.length===4&&parts[0]==="api"&&parts[1]==="viewer"&&parts[2]==="shares"&&delegatedRouteToken(parts[3]);
  const jobBrief=parts[0]==="api"&&parts[1]==="operations"&&delegatedRouteToken(parts[2])&&parts[3]==="job-brief"&&(
    (normalizedMethod==="PUT"&&parts.length===4)||
    (normalizedMethod==="PUT"&&parts.length===5&&parts[4]==="sops")||
    (normalizedMethod==="POST"&&parts.length===6&&parts[4]==="attachments"&&["upload","reference"].includes(parts[5]||""))
  );
  return !shareCreate&&!shareRevoke&&!internalFolderGrantCreate&&!internalFolderGrantRevoke&&!folderNotificationControl&&!feedbackTransition&&!streamTicket&&!incomingLink&&!dropboxImport&&!viewerPublicShareCreate&&!viewerPublicShareRevoke&&!jobBrief;
}
