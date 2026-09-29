import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion,
  type AuthenticatedNativeStaffWithAdmissionVersion,
  type NativeStaffAccessConfiguration } from "./native-staff-auth";
import { dispatchNextPortalWorkspaceBinding, enqueuePortalWorkspaceBinding,
  type WorkspaceBindingEnv } from "./client-portal-workspace-binding-outbox";
import { selectPortalWorkspaceBinding } from "./client-portal-workspace-binding-selection";

type Route="session"|"select"|"apply";
export type WorkspaceBindingAdminHttpDependencies=Readonly<{
  environment?:string;
  expectedHost?:string;
  configuration:NativeStaffAccessConfiguration&Readonly<{origin:string;csrfSecret:string}>;
  database:D1Database;
  dispatch:WorkspaceBindingEnv;
}>;

const BASE="/api/native-client-portal/workspace-binding";
const BODY_LIMIT=4_096,BUCKET_SECONDS=600;
const HEX=/^[0-9a-f]{64}$/,AUDIENCE=/^[A-Za-z0-9_-]{16,128}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder=new TextEncoder();
const HEADERS={"Cache-Control":"no-store","Referrer-Policy":"no-referrer",
  "X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY"};

class HttpFailure extends Error{constructor(readonly status:number,readonly code:string){super(code)}}
const response=(status:number,body:Record<string,unknown>)=>new Response(JSON.stringify(body),{status,
  headers:{...HEADERS,"Content-Type":"application/json; charset=utf-8"}});
const exact=(value:unknown,names:readonly string[]):value is Record<string,unknown>=>Boolean(value&&typeof value==="object"
  &&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value))
  &&Reflect.ownKeys(value).length===names.length&&names.every(name=>Object.hasOwn(value,name)));

export function workspaceBindingAdminHttpRequest(method:string,path:string):Route|null{
  if(method==="GET"&&path===`${BASE}/session`)return"session";
  if(method==="POST"&&path===`${BASE}/select`)return"select";
  if(method==="POST"&&path===`${BASE}/apply`)return"apply";
  return null;
}

function snapshot(dependencies:WorkspaceBindingAdminHttpDependencies){
  try{
    const {configuration,database}=dependencies;
    if(dependencies.environment!=="staging"||configuration.enabled!==true)throw new HttpFailure(404,"not_found");
    if(!AUDIENCE.test(configuration.staffAudience)||encoder.encode(configuration.csrfSecret).byteLength<32
      ||encoder.encode(configuration.csrfSecret).byteLength>512||!database)throw Error();
    const issuer=new URL(configuration.issuer),origin=new URL(configuration.origin);
    if(issuer.protocol!=="https:"||!issuer.hostname.endsWith(".cloudflareaccess.com")
      ||issuer.hostname===".cloudflareaccess.com"||issuer.origin!==configuration.issuer||issuer.pathname!=="/"
      ||issuer.search||issuer.hash||issuer.username||issuer.password||issuer.port
      ||origin.protocol!=="https:"||origin.origin!==configuration.origin||origin.pathname!=="/"
      ||origin.hostname!==dependencies.expectedHost
      ||!/(?:^|[-.])staging(?:[-.]|$)/.test(origin.hostname)
      ||origin.search||origin.hash||origin.username||origin.password||origin.port)throw Error();
    const binding=dependencies.dispatch.CLIENT_AUTHORITY_WORKSPACE_BINDING;
    const dispatch=dependencies.dispatch.CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED==="true"
      &&binding&&typeof binding.bindWorkspace==="function"
      ?{OPS_DB:database,CLIENT_AUTHORITY_WORKSPACE_BINDING_OUTBOX_ENABLED:"true" as const,
        CLIENT_AUTHORITY_WORKSPACE_BINDING:binding}:null;
    return{access:{enabled:true,issuer:configuration.issuer,staffAudience:configuration.staffAudience},
      origin:configuration.origin,csrfSecret:configuration.csrfSecret,database,dispatch};
  }catch(error){if(error instanceof HttpFailure)throw error;throw new HttpFailure(503,"unavailable")}
}

async function hmac(secret:string,message:string){
  const key=await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC",key,encoder.encode(message))).toString("hex");
}
const message=(origin:string,access:NativeStaffAccessConfiguration,auth:AuthenticatedNativeStaffWithAdmissionVersion,bucket:number)=>
  JSON.stringify(["client-portal-workspace-binding-admin-csrf-v1",access.issuer,access.staffAudience,origin,
    auth.identity.staffId,auth.identity.verifiedAccessSubject,auth.identity.email,auth.admissionVersion,bucket]);
const token=(secret:string,origin:string,access:NativeStaffAccessConfiguration,
  auth:AuthenticatedNativeStaffWithAdmissionVersion,bucket:number)=>hmac(secret,message(origin,access,auth,bucket));
const safeEqual=(candidate:string,expected:string)=>candidate.length===64&&HEX.test(candidate)
  &&timingSafeEqual(Buffer.from(candidate,"hex"),Buffer.from(expected,"hex"));
async function requireCsrf(request:Request,secret:string,origin:string,access:NativeStaffAccessConfiguration,
  auth:AuthenticatedNativeStaffWithAdmissionVersion){
  const candidate=request.headers.get("X-CSRF-Token")??"",bucket=Math.floor(Date.now()/1000/BUCKET_SECONDS);
  const current=await token(secret,origin,access,auth,bucket),prior=await token(secret,origin,access,auth,bucket-1);
  if(!(Number(safeEqual(candidate,current))|Number(safeEqual(candidate,prior))))throw new HttpFailure(403,"denied");
}
const unexpired=(auth:AuthenticatedNativeStaffWithAdmissionVersion)=>{
  if(Date.parse(auth.verifiedUntil)<=Date.now())throw new HttpFailure(403,"denied");
};
async function body(request:Request,route:Exclude<Route,"session">):Promise<Record<string,unknown>>{
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type")??""))
    throw new HttpFailure(400,"invalid_request");
  let value:unknown;
  try{value=await readBoundedJson(request,BODY_LIMIT,"Client portal workspace binding admin");}
  catch(error){if(error&&typeof error==="object"&&"status" in error&&error.status===413)
    throw new HttpFailure(413,"request_too_large");throw new HttpFailure(400,"invalid_request");}
  if(route==="apply"){
    if(!exact(value,["selectionId"])||typeof value.selectionId!=="string"||!UUID.test(value.selectionId))
      throw new HttpFailure(400,"invalid_request");
    return value;
  }
  if(!exact(value,["selectionId","recordId","activationId","workspaceId","sourceWorkspaceId","checkpoint"]))
    throw new HttpFailure(400,"invalid_request");
  return value;
}

export async function handleWorkspaceBindingAdminHttp(request:Request,
  dependencies:WorkspaceBindingAdminHttpDependencies):Promise<Response>{
  try{
    const url=new URL(request.url),route=workspaceBindingAdminHttpRequest(request.method,url.pathname);
    if(!route)throw new HttpFailure(404,"not_found");
    const authority=snapshot(dependencies);
    if(url.origin!==authority.origin||url.search||url.hash)throw new HttpFailure(403,"denied");
    const origin=request.headers.get("Origin"),fetchSite=request.headers.get("Sec-Fetch-Site");
    if(fetchSite!==null&&fetchSite!=="same-origin")throw new HttpFailure(403,"denied");
    if(route==="session"){
      if(request.headers.get("X-Native-Staff-Request")!=="1"||(origin!==null&&origin!==authority.origin))
        throw new HttpFailure(403,"denied");
    }else if(origin!==authority.origin)throw new HttpFailure(403,"denied");
    let auth:AuthenticatedNativeStaffWithAdmissionVersion;
    try{auth=await authenticateNativeStaffWithAdmissionVersion(request,authority.database,authority.access);}
    catch{throw new HttpFailure(403,"denied");}
    unexpired(auth);
    if(route==="session")return response(200,{csrfToken:await token(authority.csrfSecret,authority.origin,
      authority.access,auth,Math.floor(Date.now()/1000/BUCKET_SECONDS)),verifiedUntil:auth.verifiedUntil});
    await requireCsrf(request,authority.csrfSecret,authority.origin,authority.access,auth);
    unexpired(auth);
    const input=await body(request,route);
    unexpired(auth);
    if(route==="select"){
      try{
        const selected=await selectPortalWorkspaceBinding(authority.database,auth,input);
        unexpired(auth);
        return response(200,{selectionId:selected.selectionId,clientAuthorityId:selected.clientAuthorityId,
          recordId:selected.recordId,activationId:selected.activationId,workspaceId:selected.workspaceId,
          sourceId:selected.sourceId,sourceWorkspaceId:selected.sourceWorkspaceId,rootType:selected.rootType,
          rootPublicId:selected.rootPublicId,checkpoint:selected.checkpoint,state:selected.state});
      }catch{throw new HttpFailure(403,"denied");}
    }
    const selectionId=input.selectionId as string;
    try{
      if(!authority.dispatch)throw new HttpFailure(503,"unavailable");
      const queued=await enqueuePortalWorkspaceBinding(authority.database,auth,selectionId);
      if(queued.state==="acknowledged")return response(200,{selectionId,status:"acknowledged"});
      if(queued.state==="rejected")return response(409,{selectionId,status:"rejected"});
      const result=await dispatchNextPortalWorkspaceBinding(authority.dispatch,selectionId);
      if(result.status==="acknowledged")return response(200,{selectionId,status:"acknowledged"});
      if(result.status==="retry")return response(202,{selectionId,status:"retry"});
      if(result.status==="rejected")return response(409,{selectionId,status:"rejected"});
      if(result.status==="idle")return response(202,{selectionId,status:"pending"});
      throw new HttpFailure(503,"unavailable");
    }catch(error){if(error instanceof HttpFailure)throw error;throw new HttpFailure(403,"denied");}
  }catch(error){const failure=error instanceof HttpFailure?error:new HttpFailure(503,"unavailable");
    return response(failure.status,{error:failure.code});}
}
