import {WorkerEntrypoint} from "cloudflare:workers";
import {
  writeClientAuthorityWorkspaceBinding,
  type ClientAuthorityWorkspaceBindingCommand,
} from "./client-authority-workspace-binding";
import type {Env} from "./types";

const FIELDS=["protocolVersion","operationId","clientAuthorityId","workspaceId","projectionSourceId","sourceWorkspaceId",
  "rootType","rootPublicId","expectedCheckpoint"] as const;
const CHECKPOINT_FIELDS=["sourceGeneration","sourceSequence","snapshotGenerationId"] as const;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROOT_PUBLIC_ID=/^[0-9a-f]{32}$/;
const MAX_BYTES=16*1024;

export type ClientAuthorityWorkspaceBindingRpcCommand=Readonly<ClientAuthorityWorkspaceBindingCommand&{protocolVersion:1}>;
export type ClientAuthorityWorkspaceBindingRpcReceipt=
  |Readonly<{ok:true;protocolVersion:1;status:"recorded"|"duplicate";operationId:string;clientAuthorityId:string;
    workspaceId:string;projectionSourceId:string;sourceWorkspaceId:string;rootType:"organization"|"standalone_client";
    rootPublicId:string;checkpoint:{sourceGeneration:string;sourceSequence:number;snapshotGenerationId:string};
    state:"inactive";revision:1}>
  |Readonly<{ok:false;protocolVersion:1;code:"disabled"|"invalid"|"conflict"|"temporarily-unavailable";retryable:boolean}>;

function plainRecord(input:unknown,fields:readonly string[]):Record<string,unknown>|null{
  try{
    if(input===null||typeof input!=="object"||Array.isArray(input)||Object.getPrototypeOf(input)!==Object.prototype)return null;
    const descriptors=Object.getOwnPropertyDescriptors(input),keys=Object.keys(descriptors);
    if(keys.length!==fields.length||keys.some(key=>!fields.includes(key)||!("value" in descriptors[key]!)))return null;
    return Object.fromEntries(keys.map(key=>[key,descriptors[key]!.value]));
  }catch{return null;}
}
function bounded(value:unknown):value is string{return typeof value==="string"&&value.length>=1&&value.length<=200&&value.trim()===value;}
function parse(input:unknown):ClientAuthorityWorkspaceBindingRpcCommand|null{
  const value=plainRecord(input,FIELDS);if(!value||value.protocolVersion!==1)return null;
  const checkpoint=plainRecord(value.expectedCheckpoint,CHECKPOINT_FIELDS);if(!checkpoint)return null;
  if(!bounded(value.operationId)||typeof value.clientAuthorityId!=="string"||!UUID.test(value.clientAuthorityId)
    ||!bounded(value.workspaceId)||!bounded(value.projectionSourceId)||!bounded(value.sourceWorkspaceId)
    ||(value.rootType!=="organization"&&value.rootType!=="standalone_client")
    ||typeof value.rootPublicId!=="string"||!ROOT_PUBLIC_ID.test(value.rootPublicId)
    ||!bounded(checkpoint.sourceGeneration)||!Number.isSafeInteger(checkpoint.sourceSequence)||Number(checkpoint.sourceSequence)<=0
    ||!bounded(checkpoint.snapshotGenerationId))return null;
  const command={...value,expectedCheckpoint:checkpoint};
  try{if(new TextEncoder().encode(JSON.stringify(command)).byteLength>MAX_BYTES)return null;}catch{return null;}
  return Object.freeze({...command,expectedCheckpoint:Object.freeze({...checkpoint})}) as ClientAuthorityWorkspaceBindingRpcCommand;
}
const failure=(code:"disabled"|"invalid"|"conflict"|"temporarily-unavailable",retryable=false):ClientAuthorityWorkspaceBindingRpcReceipt=>
  ({ok:false,protocolVersion:1,code,retryable});

/** Private, route-less Operations adapter. The writer's independent release flag remains the final gate. */
export async function bindClientAuthorityWorkspace(
  env:Pick<Env,"DELIVERY_DB"|"CLIENT_AUTHORITY_WORKSPACE_BINDING_WRITER_ENABLED">,input:unknown,
):Promise<ClientAuthorityWorkspaceBindingRpcReceipt>{
  const command=parse(input);if(!command)return failure("invalid");
  const {protocolVersion:_protocolVersion,...writerCommand}=command;
  try{
    const result=await writeClientAuthorityWorkspaceBinding(env,writerCommand);
    return {ok:true,protocolVersion:1,status:result.replayed?"duplicate":"recorded",operationId:result.operationId,
      clientAuthorityId:result.clientAuthorityId,workspaceId:result.workspaceId,projectionSourceId:result.projectionSourceId,
      sourceWorkspaceId:result.sourceWorkspaceId,rootType:result.rootType,rootPublicId:result.rootPublicId,
      checkpoint:result.checkpoint,state:"inactive",revision:1};
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    if(message==="client-authority-workspace-binding-writer-disabled")return failure("disabled",true);
    if(message==="client-authority-workspace-binding-invalid")return failure("invalid");
    if(message==="client-authority-workspace-binding-operation-conflict"||message==="client-authority-workspace-binding-conflict")
      return failure("conflict");
    return failure("temporarily-unavailable",true);
  }
}

export class ClientAuthorityWorkspaceBindingIngress extends WorkerEntrypoint<Env>{
  bindWorkspace(input:unknown){return bindClientAuthorityWorkspace(this.env,input);}
}
