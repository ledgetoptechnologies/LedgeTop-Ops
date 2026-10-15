import type { ClientPortalServiceMetadataRequestV1 } from "../../../../packages/shared/src/client-portal-service-metadata";
import { resolveTrustedNativeFinancialMappingEvidence,prepareTrustedNativeFinancialMappingQuery,nativeFinancialMappingEvidenceFromRows,
  type NativeFinancialMappingEvidence,type NativeFinancialMappingRow,type NativeFinancialTarget } from "./project-alpha-financial-mapping";
import { readConfiguredProjectAlphaFinancialDocuments, selectorFromTrustedFinancialMapping,
  type FinancialCollection } from "./project-alpha-financial-transport";
import type { Env } from "./types";
import type { NativeBillingSourceContext } from "../../../../packages/shared/src/operations-portal-native-billing-source-authority";
import { sameNativeBillingSourceIdentity,nativeBillingSourceContextFromEvidence as context } from "./operations-portal-native-billing-source-context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type ReaderEnv = Pick<Env, "OPS_DB" | "PROJECT_ALPHA_API_V2_CONNECTIONS"> & {
  CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED?: string;
};
export type NativeFinancialReadRequest = ClientPortalServiceMetadataRequestV1 & Readonly<{ grantId: string }>;
export type NativeFinancialReadResult = Readonly<{ status: "ok"; grantId: string; revision: number;
  value: FinancialCollection }> | Readonly<{ status: "disabled" | "denied" | "unavailable" | "incompatible" }>;

type Authority = { grant_id: string; revision: number; entity_kind: "organization" | "client" | "project";
  native_entity_id: string; context_json?:string;parent_revision?:number;parent_finalization_id?:string };
const KEYS = ["protocolVersion","authorityId","workspaceId","ownershipEpoch","grantRevision","issuer","subject","grantId"];

function request(value: unknown): NativeFinancialReadRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value), names = Object.keys(descriptors);
  if (names.length !== KEYS.length || names.some(key => !KEYS.includes(key) || !("value" in descriptors[key]!))) return null;
  const row = Object.fromEntries(names.map(key => [key,descriptors[key]!.value])) as Record<string,unknown>;
  if (row.protocolVersion !== 1 || typeof row.authorityId !== "string" || !UUID.test(row.authorityId)
    || typeof row.grantId !== "string" || !UUID.test(row.grantId)
    || typeof row.workspaceId !== "string" || row.workspaceId.length<1 || row.workspaceId.length>200 || row.workspaceId.trim()!==row.workspaceId || row.workspaceId.includes("\0")
    || typeof row.issuer !== "string" || row.issuer.length<1 || row.issuer.length>512 || row.issuer.trim()!==row.issuer || row.issuer.includes("\0")
    || typeof row.subject !== "string" || row.subject.length<1 || row.subject.length>512 || row.subject.trim()!==row.subject || row.subject.includes("\0")
    || typeof row.ownershipEpoch !== "number" || !Number.isSafeInteger(row.ownershipEpoch) || row.ownershipEpoch<1
    || typeof row.grantRevision !== "number" || !Number.isSafeInteger(row.grantRevision) || row.grantRevision<1) return null;
  return {protocolVersion:1,authorityId:row.authorityId,workspaceId:row.workspaceId,
    ownershipEpoch:row.ownershipEpoch,grantRevision:row.grantRevision,issuer:row.issuer,
    subject:row.subject,grantId:row.grantId} as NativeFinancialReadRequest;
}

async function authority(db:D1Database,input:NativeFinancialReadRequest):Promise<Authority|null>{
  const source=(await db.withSession("first-primary").prepare(`SELECT child.grant_id,child.revision,live.entity_kind,live.native_entity_id,
    child.context_json,child.parent_revision,child.parent_finalization_id
    FROM operations_portal_native_billing_source_live_authority child
    JOIN operations_portal_native_billing_live_authority live ON live.grant_id=child.parent_grant_id
    JOIN operations_portal_native_recipient_authority_heads recipient ON recipient.recipient_binding_id=live.recipient_binding_id
    JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=recipient.target_id
    WHERE child.grant_id=? AND workspace.client_authority_id=? AND workspace.workspace_id=?
     AND workspace.ownership_epoch=? AND recipient.grant_revision=? AND recipient.issuer=? AND recipient.subject=? LIMIT 2`)
    .bind(input.grantId,input.authorityId,input.workspaceId,input.ownershipEpoch,input.grantRevision,input.issuer,input.subject)
    .all<Authority>()).results;
  if(source.length)return source.length===1?source[0]!:null;
  const rows=(await db.withSession("first-primary").prepare(`SELECT live.grant_id,live.revision,live.entity_kind,live.native_entity_id
    FROM operations_portal_native_billing_live_authority live
    JOIN operations_portal_native_recipient_authority_heads recipient
      ON recipient.recipient_binding_id=live.recipient_binding_id
    JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=recipient.target_id
    WHERE live.grant_id=? AND NOT EXISTS(SELECT 1 FROM operations_portal_native_billing_source_commands history
      WHERE history.parent_grant_id=live.grant_id) AND workspace.client_authority_id=? AND workspace.workspace_id=?
      AND workspace.ownership_epoch=? AND recipient.grant_revision=? AND recipient.issuer=? AND recipient.subject=?
    LIMIT 2`).bind(input.grantId,input.authorityId,input.workspaceId,input.ownershipEpoch,input.grantRevision,
      input.issuer,input.subject).all<Authority>()).results;
  return rows.length===1 ? rows[0]! : null;
}

function target(row:Authority):NativeFinancialTarget {
  const sourceId=row.context_json?(JSON.parse(row.context_json) as NativeBillingSourceContext).sourceId:undefined;
  return row.entity_kind==="project" ? {kind:"project",externalProjectId:row.native_entity_id,...(sourceId?{sourceId}:{})}
    : {kind:row.entity_kind,recordId:row.native_entity_id,...(sourceId?{sourceId}:{})};
}
// Private local witnesses never become wire fields or cached bearer handles. Weak keys do not retain completed requests.
const witnesses=new WeakMap<object,{target:NativeFinancialTarget;evidence:NativeFinancialMappingEvidence}>();
/** The aggregate must batch ALL prepared witnesses and its final authority query together:
 * repeated asynchronous local rechecks would recreate the sibling-fetch race. No PA call occurs here. */
export async function prepareNativeFinancialReadWitness(env:ReaderEnv,result:Extract<NativeFinancialReadResult,{status:"ok"}>){
 const witness=witnesses.get(result);if(!witness)return null;
 const query=await prepareTrustedNativeFinancialMappingQuery(env,witness.target);if(!query)return null;
 return {statement:env.OPS_DB.withSession("first-primary").prepare(query.sql).bind(...query.params),
  matches:(rows:NativeFinancialMappingRow[])=>{
   const current=nativeFinancialMappingEvidenceFromRows(env,witness.target,rows);
   return current!==null&&JSON.stringify(current)===JSON.stringify(witness.evidence);
  }};
}

/** Unmounted private composition. Browser values only identify an already-live recipient grant;
 * the current billing ledger and trusted native mapping independently derive all PA selectors. */
export async function readClientPortalNativeFinancialDocuments(env:ReaderEnv,inputValue:unknown,
  send:typeof fetch=fetch):Promise<NativeFinancialReadResult>{
  const input=request(inputValue);
  if(!input) return {status:"denied"};
  if(env.CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED!=="true") return {status:"disabled"};
  const before=await authority(env.OPS_DB,input);
  if(!before) return {status:"denied"};
  const pinned=before.context_json?JSON.parse(before.context_json) as NativeBillingSourceContext:null;
  const evidence=await resolveTrustedNativeFinancialMappingEvidence(env,target(before)),mapping=evidence?.mapping;
  if(pinned&&(!evidence||!sameNativeBillingSourceIdentity(pinned,context(evidence))))return {status:"denied"};
  const selector=mapping && selectorFromTrustedFinancialMapping(mapping);
  if(!evidence||!mapping||!selector) return {status:"denied"};
  const result=await readConfiguredProjectAlphaFinancialDocuments(env,mapping,selector,send);
  if(result.status!=="ok") return {status:result.status==="unavailable"?"unavailable":"incompatible"};
  const after=await authority(env.OPS_DB,input);
  const current=after&&await resolveTrustedNativeFinancialMappingEvidence(env,target(after));
  const finalAuthority=current&&await authority(env.OPS_DB,input);
  if(!after||!current||!finalAuthority||JSON.stringify(before)!==JSON.stringify(after)
    ||JSON.stringify(after)!==JSON.stringify(finalAuthority)||JSON.stringify(evidence)!==JSON.stringify(current))return {status:"denied"};
  const output={status:"ok" as const,grantId:before.grant_id,revision:before.revision,value:result.value};
  witnesses.set(output,{target:target(before),evidence});
  return output;
}
