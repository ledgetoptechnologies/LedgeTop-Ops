import { WorkerEntrypoint } from "cloudflare:workers";
import type { ClientPortalServiceMetadataRequestV1 } from "../../../../packages/shared/src/client-portal-service-metadata";
import { readClientPortalNativeFinancialDocuments, type NativeFinancialReadResult } from "./client-portal-native-financial-reader";
import type { Env } from "./types";

const MAX_GRANTS=20,MAX_WIRE_BYTES=512*1024;
type EntrypointEnv=Pick<Env,"OPS_DB"|"PROJECT_ALPHA_API_V2_CONNECTIONS">&{CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED?:string};
type GrantRow={grant_id:string};
export type NativeFinancialEnvelope=Readonly<{ok:true;protocolVersion:1;authorityId:string;workspaceId:string;
  ownershipEpoch:number;grantRevision:number;collections:readonly Extract<NativeFinancialReadResult,{status:"ok"}>[]}>
  |Readonly<{ok:false;protocolVersion:1;code:"disabled"|"denied"|"unavailable"|"overflow"}>;

async function grantIds(env:EntrypointEnv,input:ClientPortalServiceMetadataRequestV1):Promise<string[]|null>{
  try{
    const rows=(await env.OPS_DB.withSession("first-primary").prepare(`SELECT live.grant_id
      FROM operations_portal_native_billing_live_authority live
      JOIN operations_portal_native_recipient_authority_heads recipient
        ON recipient.recipient_binding_id=live.recipient_binding_id
      JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=recipient.target_id
      WHERE workspace.client_authority_id=? AND workspace.workspace_id=? AND workspace.ownership_epoch=?
       AND recipient.grant_revision=? AND recipient.issuer=? AND recipient.subject=?
      ORDER BY live.grant_id LIMIT ?`).bind(input.authorityId,input.workspaceId,input.ownershipEpoch,
        input.grantRevision,input.issuer,input.subject,MAX_GRANTS+1).all<GrantRow>()).results;
    return rows.length>MAX_GRANTS||new Set(rows.map(row=>row.grant_id)).size!==rows.length?null:rows.map(row=>row.grant_id);
  }catch{return null;}
}

export async function readClientPortalNativeFinancialCollections(env:EntrypointEnv,
  input:ClientPortalServiceMetadataRequestV1,send:typeof fetch=fetch):Promise<NativeFinancialEnvelope>{
  if(env.CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED!=="true")return{ok:false,protocolVersion:1,code:"disabled"};
  const before=await grantIds(env,input);
  if(!before?.length)return{ok:false,protocolVersion:1,code:before?"denied":"unavailable"};
  const values=await Promise.all(before.map(grantId=>readClientPortalNativeFinancialDocuments(env,{...input,grantId},send)));
  if(values.some(value=>value.status!=="ok"))return{ok:false,protocolVersion:1,
    code:values.some(value=>value.status==="unavailable")?"unavailable":"denied"};
  const after=await grantIds(env,input);
  if(!after||after.length!==before.length||after.some((id,index)=>id!==before[index]))
    return{ok:false,protocolVersion:1,code:"denied"};
  return{ok:true,protocolVersion:1,authorityId:input.authorityId,workspaceId:input.workspaceId,
    ownershipEpoch:input.ownershipEpoch,grantRevision:input.grantRevision,
    collections:values as Extract<NativeFinancialReadResult,{status:"ok"}>[]};
}

function wire(value:NativeFinancialEnvelope){const encoded=JSON.stringify(value);
  return new TextEncoder().encode(encoded).byteLength<=MAX_WIRE_BYTES?encoded:
    JSON.stringify({ok:false,protocolVersion:1,code:"overflow"});}

/** Private named service-binding entrypoint; never mounted as HTTP. */
export class ClientPortalNativeFinancialReader extends WorkerEntrypoint<Env>{
  async readFinancialDocuments(input:ClientPortalServiceMetadataRequestV1):Promise<string>{
    return wire(await readClientPortalNativeFinancialCollections(this.env,input));
  }
}
