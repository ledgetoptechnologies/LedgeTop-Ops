import { HTTPException } from "hono/http-exception";

const MAX_KEY_LENGTH=1000;
function reservedSegment(value:string):boolean{const segment=value.toLowerCase();return segment==="dump"||segment==="_ltds"||segment===".previews";}

export function normalizeCrudKey(value:unknown,folder=false):string{
  if(typeof value!=="string"||value.length>MAX_KEY_LENGTH)throw new HTTPException(400,{message:"A valid R2 path is required"});
  const normalized=value.trim().replace(/\\/g,"/").replace(/^\/+/,"").replace(/\/{2,}/g,"/"),clean=normalized.replace(/\/+$/,""),parts=clean.split("/");
  if(!clean||parts.some(part=>!part||part==="."||part===".."||reservedSegment(part)))throw new HTTPException(400,{message:"The R2 path is reserved or invalid"});
  if(!clean.startsWith("Jobs/Clients/")||clean==="Jobs/Clients")throw new HTTPException(400,{message:"R2 paths must be under Jobs/Clients"});
  return folder?`${clean}/`:clean;
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
  const streamTicket=normalizedMethod==="POST"&&parts.length===5&&parts[0]==="api"&&parts[1]==="delivery"&&parts[2]==="items"&&delegatedRouteToken(parts[3])&&parts[4]==="stream-ticket";
  return !shareCreate&&!shareRevoke&&!streamTicket;
}
