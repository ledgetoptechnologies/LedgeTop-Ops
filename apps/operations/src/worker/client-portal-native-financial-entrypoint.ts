import { WorkerEntrypoint } from "cloudflare:workers";
import type { ClientPortalServiceMetadataRequestV1 } from "../../../../packages/shared/src/client-portal-service-metadata";
import { readClientPortalNativeFinancialDocuments,prepareNativeFinancialReadWitness, type NativeFinancialReadResult } from "./client-portal-native-financial-reader";
import type { NativeFinancialMappingRow } from "./project-alpha-financial-mapping";
import type { Env } from "./types";

const MAX_GRANTS=20,MAX_WIRE_BYTES=512*1024;
type EntrypointEnv=Pick<Env,"OPS_DB"|"PROJECT_ALPHA_API_V2_CONNECTIONS">&{CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED?:string};
type GrantRow={grant_id:string;source_child:number;revision:number;context_json:string|null;
 parent_revision:number;parent_finalization_id:string|null};
export type NativeFinancialEnvelope=Readonly<{ok:true;protocolVersion:1;authorityId:string;workspaceId:string;
  ownershipEpoch:number;grantRevision:number;collections:readonly Extract<NativeFinancialReadResult,{status:"ok"}>[]}>
  |Readonly<{ok:false;protocolVersion:1;code:"disabled"|"denied"|"unavailable"|"overflow"}>;

function grantStatement(env:EntrypointEnv,input:ClientPortalServiceMetadataRequestV1):D1PreparedStatement{
    return env.OPS_DB.withSession("first-primary").prepare(`SELECT selected.grant_id,selected.source_child,
      selected.revision,selected.context_json,selected.parent_revision,selected.parent_finalization_id FROM (
      SELECT parent_grant_id,grant_id,1 source_child,revision,context_json,parent_revision,parent_finalization_id
        FROM operations_portal_native_billing_source_live_authority
      UNION ALL SELECT grant_id parent_grant_id,grant_id,0 source_child,revision,NULL context_json,
        revision parent_revision,NULL parent_finalization_id FROM operations_portal_native_billing_live_authority parent
        WHERE NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_source_commands history WHERE history.parent_grant_id=parent.grant_id)
      ) selected JOIN operations_portal_native_billing_live_authority live ON live.grant_id=selected.parent_grant_id
      JOIN operations_portal_native_recipient_authority_heads recipient
        ON recipient.recipient_binding_id=live.recipient_binding_id
      JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=recipient.target_id
      WHERE workspace.client_authority_id=? AND workspace.workspace_id=? AND workspace.ownership_epoch=?
       AND recipient.grant_revision=? AND recipient.issuer=? AND recipient.subject=?
      ORDER BY selected.grant_id LIMIT ?`).bind(input.authorityId,input.workspaceId,input.ownershipEpoch,
        input.grantRevision,input.issuer,input.subject,MAX_GRANTS+1);
}
async function grantIds(env:EntrypointEnv,input:ClientPortalServiceMetadataRequestV1):Promise<GrantRow[]|null>{
  try{
    const rows=(await grantStatement(env,input).all<GrantRow>()).results;
    return rows.length>MAX_GRANTS||new Set(rows.map(row=>row.grant_id)).size!==rows.length?null:rows;
  }catch{return null;}
}

export async function readClientPortalNativeFinancialCollections(env:EntrypointEnv,
  input:ClientPortalServiceMetadataRequestV1,send:typeof fetch=fetch):Promise<NativeFinancialEnvelope>{
  if(env.CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED!=="true")return{ok:false,protocolVersion:1,code:"disabled"};
  const before=await grantIds(env,input);
  if(!before?.length)return{ok:false,protocolVersion:1,code:before?"denied":"unavailable"};
  const reads=await Promise.all(before.map(row=>readClientPortalNativeFinancialDocuments(env,{...input,grantId:row.grant_id},send)));
  // A stale source binding suppresses only its explicitly scoped child; legacy denials retain the old all-or-nothing fence.
  const values=reads.filter((value,index)=>!(value.status==="denied"&&before[index]!.source_child===1));
  if(!values.length)return{ok:false,protocolVersion:1,code:"denied"};
  if(values.some(value=>value.status!=="ok"))return{ok:false,protocolVersion:1,
    code:values.some(value=>value.status==="unavailable")?"unavailable":"denied"};
  const successes=values as Extract<NativeFinancialReadResult,{status:"ok"}>[];
  const witnesses=await Promise.all(successes.map(value=>prepareNativeFinancialReadWitness(env,value)));
  if(witnesses.some(witness=>!witness))return{ok:false,protocolVersion:1,code:"denied"};
  // One read-only transaction snapshots EVERY surviving mapping and the authority list.
  // No await follows validation: a finished sibling cannot leak a source retired while another fetch was pending.
  let snapshot:D1Result[];
  try{snapshot=await env.OPS_DB.withSession("first-primary").batch([
    ...witnesses.map(witness=>witness!.statement),grantStatement(env,input)]);}catch{return{ok:false,protocolVersion:1,code:"unavailable"};}
  if(snapshot.length!==witnesses.length+1||snapshot.some(result=>result.success!==true))return{ok:false,protocolVersion:1,code:"unavailable"};
  const after=snapshot.at(-1)!.results as GrantRow[];
  if(!after||after.length!==before.length||after.some((row,index)=>JSON.stringify(row)!==JSON.stringify(before[index])))
    return{ok:false,protocolVersion:1,code:"denied"};
  const final:typeof successes=[];
  for(let index=0;index<successes.length;index++){
    if(witnesses[index]!.matches(snapshot[index]!.results as NativeFinancialMappingRow[]))final.push(successes[index]!);
    else if(before.find(row=>row.grant_id===successes[index]!.grantId)?.source_child!==1)
      return{ok:false,protocolVersion:1,code:"denied"};
  }
  if(!final.length)return{ok:false,protocolVersion:1,code:"denied"};
  return{ok:true,protocolVersion:1,authorityId:input.authorityId,workspaceId:input.workspaceId,
    ownershipEpoch:input.ownershipEpoch,grantRevision:input.grantRevision,
    collections:final};
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
