import {z} from "zod";
import type {Env} from "./types";

const bounded=z.string().trim().min(1).max(200);
const principal=z.string().trim().min(1).max(512);
const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const commandSchema=z.object({operationId:bounded,clientAuthorityId:uuid,workspaceId:bounded,bindingOperationId:bounded,
  issuer:principal,subject:principal,desiredState:z.enum(["active","revoked"]),expectedOwnershipEpoch:z.number().int().nonnegative(),
  expectedGrantRevision:z.number().int().nonnegative(),scopes:z.tuple([])}).strict();

export type ClientPortalAuthorityV2Command=z.infer<typeof commandSchema>;
export type ClientPortalAuthorityV2Result=Readonly<{operationId:string;clientAuthorityId:string;workspaceId:string;
  issuer:string;subject:string;ownershipEpoch:number;grantRevision:number;state:"active"|"revoked";replayed:boolean}>;
type ReceiptRow={request_fingerprint:string;client_authority_id:string;workspace_id:string;issuer:string;subject:string;
  ownership_epoch:number;grant_revision:number;resulting_state:"active"|"revoked"};
type WorkspaceHead={client_authority_id:string;ownership_epoch:number;state:"active"|"revoked";binding_operation_id:string};
type GrantHead={ownership_epoch:number;grant_revision:number;state:"active"|"revoked"};

const receiptColumns="request_fingerprint,client_authority_id,workspace_id,issuer,subject,ownership_epoch,grant_revision,resulting_state";
const canonical=(value:ClientPortalAuthorityV2Command)=>JSON.stringify({operationId:value.operationId,
  clientAuthorityId:value.clientAuthorityId,workspaceId:value.workspaceId,bindingOperationId:value.bindingOperationId,
  issuer:value.issuer,subject:value.subject,desiredState:value.desiredState,expectedOwnershipEpoch:value.expectedOwnershipEpoch,
  expectedGrantRevision:value.expectedGrantRevision,scopes:[]});
async function sha256(value:string){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))]
  .map(byte=>byte.toString(16).padStart(2,"0")).join("");}
const result=(operationId:string,row:ReceiptRow,replayed:boolean):ClientPortalAuthorityV2Result=>({operationId,
  clientAuthorityId:row.client_authority_id,workspaceId:row.workspace_id,issuer:row.issuer,subject:row.subject,
  ownershipEpoch:row.ownership_epoch,grantRevision:row.grant_revision,state:row.resulting_state,replayed});

/** Private v2 control-plane writer. Empty scopes and the absence of an authorization reader keep this release inert. */
export async function writeClientPortalAuthorityV2(
  env:Pick<Env,"DELIVERY_DB"|"CLIENT_PORTAL_AUTHORITY_V2_WRITER_ENABLED">,raw:unknown,
):Promise<ClientPortalAuthorityV2Result>{
  if(env.CLIENT_PORTAL_AUTHORITY_V2_WRITER_ENABLED!=="true")throw new Error("client-portal-authority-v2-writer-disabled");
  const parsed=commandSchema.safeParse(raw);if(!parsed.success)throw new Error("client-portal-authority-v2-invalid");
  const command=parsed.data,fingerprint=await sha256(canonical(command)),database=env.DELIVERY_DB.withSession("first-primary");
  const prior=await database.prepare(`SELECT ${receiptColumns} FROM portal_operations_authority_v2_receipts WHERE operation_id=?`)
    .bind(command.operationId).first<ReceiptRow>();
  if(prior){if(prior.request_fingerprint!==fingerprint)throw new Error("client-portal-authority-v2-operation-conflict");
    return result(command.operationId,prior,true);}
  const workspace=await database.prepare(`SELECT client_authority_id,ownership_epoch,state,binding_operation_id
    FROM portal_operations_workspace_authority_heads WHERE workspace_id=?`).bind(command.workspaceId).first<WorkspaceHead>();
  if(workspace){
    if(workspace.client_authority_id!==command.clientAuthorityId||workspace.binding_operation_id!==command.bindingOperationId
      ||workspace.state!=="active"||workspace.ownership_epoch!==command.expectedOwnershipEpoch)
      throw new Error("client-portal-authority-v2-cas-conflict");
  }else if(command.expectedOwnershipEpoch!==0||command.expectedGrantRevision!==0||command.desiredState!=="active"){
    throw new Error("client-portal-authority-v2-cas-conflict");
  }
  const ownershipEpoch=workspace?.ownership_epoch??1;
  const grant=await database.prepare(`SELECT ownership_epoch,grant_revision,state FROM portal_operations_principal_grant_heads
    WHERE workspace_id=? AND issuer=? AND subject=?`).bind(command.workspaceId,command.issuer,command.subject).first<GrantHead>();
  if((grant?.grant_revision??0)!==command.expectedGrantRevision||grant&&grant.ownership_epoch!==ownershipEpoch
    ||!grant&&command.desiredState==="revoked")throw new Error("client-portal-authority-v2-cas-conflict");
  const grantRevision=command.expectedGrantRevision+1,revokedAt=command.desiredState==="revoked"?new Date().toISOString():null;
  const statements=[];
  if(!workspace)statements.push(database.prepare(`INSERT INTO portal_operations_workspace_authority_heads
    (workspace_id,client_authority_id,ownership_epoch,state,binding_operation_id,last_operation_id)
    VALUES(?,?,1,'active',?,?)`).bind(command.workspaceId,command.clientAuthorityId,command.bindingOperationId,command.operationId));
  statements.push(grant
    ?database.prepare(`UPDATE portal_operations_principal_grant_heads SET state=?,grant_revision=?,last_operation_id=?,revoked_at=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE workspace_id=? AND issuer=? AND subject=?
      AND client_authority_id=? AND ownership_epoch=? AND grant_revision=?`)
      .bind(command.desiredState,grantRevision,command.operationId,revokedAt,command.workspaceId,command.issuer,command.subject,
        command.clientAuthorityId,ownershipEpoch,command.expectedGrantRevision)
    :database.prepare(`INSERT INTO portal_operations_principal_grant_heads
      (workspace_id,client_authority_id,issuer,subject,ownership_epoch,grant_revision,state,last_operation_id,revoked_at)
      VALUES(?,?,?,?,?,1,'active',?,NULL)`).bind(command.workspaceId,command.clientAuthorityId,command.issuer,command.subject,
        ownershipEpoch,command.operationId));
  statements.push(
    database.prepare(`INSERT INTO portal_operations_authority_v2_audit
      (operation_id,request_fingerprint,workspace_id,client_authority_id,issuer,subject,action,ownership_epoch,grant_revision,resulting_state)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(command.operationId,fingerprint,command.workspaceId,command.clientAuthorityId,
        command.issuer,command.subject,command.desiredState==="active"?"grant":"revoke",ownershipEpoch,grantRevision,command.desiredState),
    database.prepare(`INSERT INTO portal_operations_authority_v2_receipts
      (operation_id,request_fingerprint,workspace_id,client_authority_id,issuer,subject,ownership_epoch,grant_revision,resulting_state)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(command.operationId,fingerprint,command.workspaceId,command.clientAuthorityId,
        command.issuer,command.subject,ownershipEpoch,grantRevision,command.desiredState));
  try{await database.batch(statements);}catch(error){
    const raced=await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT ${receiptColumns}
      FROM portal_operations_authority_v2_receipts WHERE operation_id=?`).bind(command.operationId).first<ReceiptRow>();
    if(raced){if(raced.request_fingerprint!==fingerprint)throw new Error("client-portal-authority-v2-operation-conflict");
      return result(command.operationId,raced,true);}
    if(/constraint|operations portal v2|UNIQUE/i.test(String(error)))throw new Error("client-portal-authority-v2-cas-conflict");
    throw error;
  }
  return result(command.operationId,{request_fingerprint:fingerprint,client_authority_id:command.clientAuthorityId,
    workspace_id:command.workspaceId,issuer:command.issuer,subject:command.subject,ownership_epoch:ownershipEpoch,
    grant_revision:grantRevision,resulting_state:command.desiredState},false);
}

export async function readClientPortalAuthorityV2Status(
  env:Pick<Env,"DELIVERY_DB"|"CLIENT_PORTAL_AUTHORITY_V2_STATUS_ENABLED">,operationId:string,
):Promise<Omit<ClientPortalAuthorityV2Result,"replayed">|null>{
  if(env.CLIENT_PORTAL_AUTHORITY_V2_STATUS_ENABLED!=="true")throw new Error("client-portal-authority-v2-status-disabled");
  const row=await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT ${receiptColumns}
    FROM portal_operations_authority_v2_receipts WHERE operation_id=?`).bind(operationId).first<ReceiptRow>();
  if(!row)return null;const {replayed:_replayed,...status}=result(operationId,row,false);return status;
}
