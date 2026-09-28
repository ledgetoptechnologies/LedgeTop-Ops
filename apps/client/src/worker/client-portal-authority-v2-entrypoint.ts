import {WorkerEntrypoint} from "cloudflare:workers";
import {readClientPortalAuthorityV2Status,readClientPortalAuthorityV3Status,writeClientPortalAuthorityV2,
  writeClientPortalAuthorityV3} from "./client-portal-authority-v2";
import type {Env} from "./types";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS=["protocolVersion","operationId","clientAuthorityId","workspaceId","bindingOperationId","issuer","subject",
  "desiredState","expectedOwnershipEpoch","expectedGrantRevision","scopes"] as const;
const FIELDS_V3=["protocolVersion","operationId","clientAuthorityId","workspaceId","bindingOperationId","issuer","subject",
  "desiredState","expectedOwnershipEpoch","expectedGrantRevision","permissions"] as const;
function plain(input:unknown,fields:readonly string[]):Record<string,unknown>|null{try{
  if(!input||typeof input!=="object"||Array.isArray(input)||Object.getPrototypeOf(input)!==Object.prototype)return null;
  if(Reflect.ownKeys(input).some(key=>typeof key!=="string"))return null;
  const descriptors=Object.getOwnPropertyDescriptors(input),keys=Object.keys(descriptors);
  if(keys.length!==fields.length||keys.some(key=>!fields.includes(key)||!("value" in descriptors[key]!)))return null;
  return Object.fromEntries(keys.map(key=>[key,descriptors[key]!.value]));}catch{return null;}}
const bounded=(value:unknown,max=200):value is string=>typeof value==="string"&&value.length>=1&&value.length<=max&&value.trim()===value;
const failure=(code:"disabled"|"invalid"|"conflict"|"temporarily-unavailable",retryable=false)=>
  ({ok:false as const,protocolVersion:2 as const,code,retryable});
const failureV3=(code:"disabled"|"invalid"|"conflict"|"temporarily-unavailable",retryable=false)=>
  ({ok:false as const,protocolVersion:3 as const,code,retryable});

export async function applyClientPortalAuthorityV2(
  env:Pick<Env,"DELIVERY_DB"|"CLIENT_PORTAL_AUTHORITY_V2_WRITER_ENABLED">,input:unknown,
){
  const value=plain(input,FIELDS);
  if(!value||value.protocolVersion!==2||!bounded(value.operationId)||typeof value.clientAuthorityId!=="string"||!UUID.test(value.clientAuthorityId)
    ||!bounded(value.workspaceId)||!bounded(value.bindingOperationId)||!bounded(value.issuer,512)||!bounded(value.subject,512)
    ||(value.desiredState!=="active"&&value.desiredState!=="revoked")||!Number.isSafeInteger(value.expectedOwnershipEpoch)
    ||Number(value.expectedOwnershipEpoch)<0||!Number.isSafeInteger(value.expectedGrantRevision)||Number(value.expectedGrantRevision)<0
    ||!Array.isArray(value.scopes)||value.scopes.length!==0)return failure("invalid");
  try{if(new TextEncoder().encode(JSON.stringify(value)).byteLength>16*1024)return failure("invalid");
    const {protocolVersion:_protocolVersion,...command}=value;const receipt=await writeClientPortalAuthorityV2(env,command);
    return {ok:true as const,protocolVersion:2 as const,status:receipt.replayed?"duplicate" as const:"recorded" as const,...receipt};
  }catch(error){const message=error instanceof Error?error.message:String(error);
    if(message==="client-portal-authority-v2-writer-disabled")return failure("disabled",true);
    if(message==="client-portal-authority-v2-invalid")return failure("invalid");
    if(message.includes("conflict"))return failure("conflict");return failure("temporarily-unavailable",true);}
}

export async function applyClientPortalAuthorityV3(
  env:Pick<Env,"DELIVERY_DB"|"CLIENT_PORTAL_AUTHORITY_V2_WRITER_ENABLED">,input:unknown,
){
  const value=plain(input,FIELDS_V3),permissions=value?.permissions;
  if(!value||value.protocolVersion!==3||!bounded(value.operationId)||typeof value.clientAuthorityId!=="string"||!UUID.test(value.clientAuthorityId)
    ||!bounded(value.workspaceId)||!bounded(value.bindingOperationId)||!bounded(value.issuer,512)||!bounded(value.subject,512)
    ||(value.desiredState!=="active"&&value.desiredState!=="revoked")||!Number.isSafeInteger(value.expectedOwnershipEpoch)
    ||Number(value.expectedOwnershipEpoch)<0||!Number.isSafeInteger(value.expectedGrantRevision)||Number(value.expectedGrantRevision)<0
    ||!Array.isArray(permissions)||permissions.length>1
    ||(permissions.length===1&&permissions[0]!=="operations.service_home.read")
    ||(value.desiredState==="revoked"&&permissions.length!==0))return failureV3("invalid");
  try{if(new TextEncoder().encode(JSON.stringify(value)).byteLength>16*1024)return failureV3("invalid");
    const {protocolVersion:_protocolVersion,...command}=value;const receipt=await writeClientPortalAuthorityV3(env,command);
    return {ok:true as const,protocolVersion:3 as const,status:receipt.replayed?"duplicate" as const:"recorded" as const,...receipt};
  }catch(error){const message=error instanceof Error?error.message:String(error);
    if(message==="client-portal-authority-v2-writer-disabled")return failureV3("disabled",true);
    if(message==="client-portal-authority-v2-invalid")return failureV3("invalid");
    if(message.includes("conflict"))return failureV3("conflict");return failureV3("temporarily-unavailable",true);}
}

export async function getClientPortalAuthorityV2Status(
  env:Pick<Env,"DELIVERY_DB"|"CLIENT_PORTAL_AUTHORITY_V2_STATUS_ENABLED">,input:unknown,
){
  const value=plain(input,["protocolVersion","operationId"]);
  if(!value||value.protocolVersion!==2||!bounded(value.operationId))return {...failure("invalid"),code:"invalid" as const};
  try{const receipt=await readClientPortalAuthorityV2Status(env,value.operationId);
    return receipt?{ok:true as const,protocolVersion:2 as const,status:"recorded" as const,...receipt}
      :{ok:false as const,protocolVersion:2 as const,code:"not_found" as const,retryable:false};
  }catch(error){return error instanceof Error&&error.message==="client-portal-authority-v2-status-disabled"
    ?failure("disabled",true):failure("temporarily-unavailable",true);}
}

export async function getClientPortalAuthorityV3Status(
  env:Pick<Env,"DELIVERY_DB"|"CLIENT_PORTAL_AUTHORITY_V2_STATUS_ENABLED">,input:unknown,
){
  const value=plain(input,["protocolVersion","operationId"]);
  if(!value||value.protocolVersion!==3||!bounded(value.operationId))return failureV3("invalid");
  try{const receipt=await readClientPortalAuthorityV3Status(env,value.operationId);
    return receipt?{ok:true as const,protocolVersion:3 as const,status:"recorded" as const,...receipt}
      :{ok:false as const,protocolVersion:3 as const,code:"not_found" as const,retryable:false};
  }catch(error){return error instanceof Error&&error.message==="client-portal-authority-v2-status-disabled"
    ?failureV3("disabled",true):failureV3("temporarily-unavailable",true);}
}

export class ClientPortalAuthorityV2Ingress extends WorkerEntrypoint<Env>{
  applyAuthority(input:unknown){return applyClientPortalAuthorityV2(this.env,input);}
  getAuthorityStatus(input:unknown){return getClientPortalAuthorityV2Status(this.env,input);}
  applyAuthorityV3(input:unknown){return applyClientPortalAuthorityV3(this.env,input);}
  getAuthorityV3Status(input:unknown){return getClientPortalAuthorityV3Status(this.env,input);}
}
