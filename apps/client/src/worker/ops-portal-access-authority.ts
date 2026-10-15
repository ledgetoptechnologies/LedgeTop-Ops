import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./types";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const OPS_PORTAL_AUTHORITY_MAX_BYTES=16*1024;
export type OpsPortalAuthorityCommand=Readonly<{protocolVersion:1;operationId:string;idempotencyKey:string;
  clientAuthorityId:string;issuer:string;subject:string;desiredState:"active"|"revoked";expectedRevision:number}>;
export type OpsPortalAuthorityReceipt=
  |Readonly<{ok:true;protocolVersion:1;status:"recorded"|"duplicate";revision:number;state:"active"|"revoked"}>
  |Readonly<{ok:false;protocolVersion:1;code:"disabled"|"invalid"|"conflict"|"temporarily-unavailable";retryable:boolean}>;

function canonical(value:unknown):string{
  if(Array.isArray(value))return`[${value.map(canonical).join(",")}]`;
  if(value!==null&&typeof value==="object")return`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function sha256(value:string){return[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))]
  .map(v=>v.toString(16).padStart(2,"0")).join("");}
function parse(input:unknown):OpsPortalAuthorityCommand|null{
  try{
    if(!input||typeof input!=="object"||Array.isArray(input)||Object.getPrototypeOf(input)!==Object.prototype)return null;
    const descriptors=Object.getOwnPropertyDescriptors(input),keys=Object.keys(descriptors);
    if(keys.length!==8||keys.some(key=>!("value" in descriptors[key]!)))return null;
    const v=Object.fromEntries(keys.map(key=>[key,descriptors[key]!.value])) as Record<string,unknown>;
    const valid=keys.every(k=>["protocolVersion","operationId","idempotencyKey","clientAuthorityId","issuer","subject","desiredState","expectedRevision"].includes(k))
      &&v.protocolVersion===1&&typeof v.operationId==="string"&&UUID.test(v.operationId)
      &&typeof v.clientAuthorityId==="string"&&UUID.test(v.clientAuthorityId)
      &&typeof v.idempotencyKey==="string"&&IDEMPOTENCY.test(v.idempotencyKey)
      &&typeof v.issuer==="string"&&v.issuer.length>=1&&v.issuer.length<=512&&v.issuer.trim()===v.issuer
      &&typeof v.subject==="string"&&v.subject.length>=1&&v.subject.length<=512&&v.subject.trim()===v.subject
      &&(v.desiredState==="active"||v.desiredState==="revoked")&&Number.isSafeInteger(v.expectedRevision)&&Number(v.expectedRevision)>=0;
    return valid?Object.freeze({...v}) as OpsPortalAuthorityCommand:null;
  }catch{return null;}
}
const failure=(code:"disabled"|"invalid"|"conflict"|"temporarily-unavailable",retryable=false):OpsPortalAuthorityReceipt=>({ok:false,protocolVersion:1,code,retryable});

/** Shadow receiver only. Authorization tables are intentionally absent here. */
export async function recordOpsPortalAuthority(env:Pick<Env,"DELIVERY_DB"|"OPS_PORTAL_ACCESS_AUTHORITY_SHADOW_ENABLED">,input:unknown):Promise<OpsPortalAuthorityReceipt>{
  if(env.OPS_PORTAL_ACCESS_AUTHORITY_SHADOW_ENABLED!=="true")return failure("disabled",true);
  const command=parse(input);if(!command)return failure("invalid");
  const encoded=canonical(command);if(new TextEncoder().encode(encoded).byteLength>OPS_PORTAL_AUTHORITY_MAX_BYTES)return failure("invalid");
  const db=env.DELIVERY_DB.withSession("first-primary"),fingerprint=await sha256(encoded);
  const prior=await db.prepare(`SELECT request_fingerprint,result_revision,result_state FROM operations_portal_access_authority_receipts WHERE idempotency_key=?`)
    .bind(command.idempotencyKey).first<{request_fingerprint:string;result_revision:number;result_state:"active"|"revoked"}>();
  if(prior)return prior.request_fingerprint===fingerprint
    ?{ok:true,protocolVersion:1,status:"duplicate",revision:prior.result_revision,state:prior.result_state}:failure("conflict");
  const current=await db.prepare(`SELECT revision,state FROM operations_portal_access_authorities WHERE client_authority_id=? AND issuer=? AND subject=?`)
    .bind(command.clientAuthorityId,command.issuer,command.subject).first<{revision:number;state:string}>();
  if((current?.revision??0)!==command.expectedRevision)return failure("conflict");
  const revision=command.expectedRevision+1,revokedAt=command.desiredState==="revoked"?new Date().toISOString():null;
  try{
    await db.batch([
      db.prepare(`INSERT INTO operations_portal_access_authorities(client_authority_id,issuer,subject,state,revision,last_operation_id,revoked_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(client_authority_id,issuer,subject) DO UPDATE SET state=excluded.state,revision=excluded.revision,
        last_operation_id=excluded.last_operation_id,revoked_at=excluded.revoked_at,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE operations_portal_access_authorities.revision=?`).bind(command.clientAuthorityId,command.issuer,command.subject,command.desiredState,revision,command.operationId,revokedAt,command.expectedRevision),
      db.prepare(`INSERT INTO operations_portal_access_authority_audit(operation_id,client_authority_id,issuer,subject,action,revision)
        SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM operations_portal_access_authorities WHERE client_authority_id=? AND issuer=? AND subject=? AND revision=? AND last_operation_id=?)`)
        .bind(command.operationId,command.clientAuthorityId,command.issuer,command.subject,command.desiredState==="active"?"binding.activated":"binding.revoked",revision,command.clientAuthorityId,command.issuer,command.subject,revision,command.operationId),
      db.prepare(`INSERT INTO operations_portal_access_authority_receipts(idempotency_key,request_fingerprint,client_authority_id,issuer,subject,operation_id,result_revision,result_state)
        SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM operations_portal_access_authority_audit WHERE operation_id=?)`)
        .bind(command.idempotencyKey,fingerprint,command.clientAuthorityId,command.issuer,command.subject,command.operationId,revision,command.desiredState,command.operationId),
    ]);
    const receipt=await db.prepare(`SELECT result_revision,result_state FROM operations_portal_access_authority_receipts WHERE idempotency_key=? AND request_fingerprint=?`)
      .bind(command.idempotencyKey,fingerprint).first<{result_revision:number;result_state:"active"|"revoked"}>();
    return receipt?{ok:true,protocolVersion:1,status:"recorded",revision:receipt.result_revision,state:receipt.result_state}:failure("conflict");
  }catch(error){
    if(/UNIQUE|constraint/i.test(String(error)))return failure("conflict");
    return failure("temporarily-unavailable",true);
  }
}

export class OpsPortalAccessAuthorityIngress extends WorkerEntrypoint<Env>{
  recordAuthority(input:unknown){return recordOpsPortalAuthority(this.env,input);}
}
