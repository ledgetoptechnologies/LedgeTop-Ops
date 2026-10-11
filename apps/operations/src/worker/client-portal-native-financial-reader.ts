import type { ClientPortalServiceMetadataRequestV1 } from "../../../../packages/shared/src/client-portal-service-metadata";
import { resolveTrustedNativeFinancialMapping, type NativeFinancialTarget } from "./project-alpha-financial-mapping";
import { readConfiguredProjectAlphaFinancialDocuments, selectorFromTrustedFinancialMapping,
  type FinancialCollection, type TrustedFinancialMapping } from "./project-alpha-financial-transport";
import type { Env } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type ReaderEnv = Pick<Env, "OPS_DB" | "PROJECT_ALPHA_API_V2_CONNECTIONS"> & {
  CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED?: string;
};
export type NativeFinancialReadRequest = ClientPortalServiceMetadataRequestV1 & Readonly<{ grantId: string }>;
export type NativeFinancialReadResult = Readonly<{ status: "ok"; grantId: string; revision: number;
  value: FinancialCollection }> | Readonly<{ status: "disabled" | "denied" | "unavailable" | "incompatible" }>;

type Authority = { grant_id: string; revision: number; entity_kind: "organization" | "client" | "project";
  native_entity_id: string };
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
  const rows=(await db.withSession("first-primary").prepare(`SELECT live.grant_id,live.revision,live.entity_kind,live.native_entity_id
    FROM operations_portal_native_billing_live_authority live
    JOIN operations_portal_native_recipient_authority_heads recipient
      ON recipient.recipient_binding_id=live.recipient_binding_id
    JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=recipient.target_id
    WHERE live.grant_id=? AND workspace.client_authority_id=? AND workspace.workspace_id=?
      AND workspace.ownership_epoch=? AND recipient.grant_revision=? AND recipient.issuer=? AND recipient.subject=?
    LIMIT 2`).bind(input.grantId,input.authorityId,input.workspaceId,input.ownershipEpoch,input.grantRevision,
      input.issuer,input.subject).all<Authority>()).results;
  return rows.length===1 ? rows[0]! : null;
}

function target(row:Authority):NativeFinancialTarget {
  return row.entity_kind==="project" ? {kind:"project",externalProjectId:row.native_entity_id}
    : {kind:row.entity_kind,recordId:row.native_entity_id};
}
const sameMapping=(a:TrustedFinancialMapping,b:TrustedFinancialMapping)=>JSON.stringify(a)===JSON.stringify(b);

/** Unmounted private composition. Browser values only identify an already-live recipient grant;
 * the current billing ledger and trusted native mapping independently derive all PA selectors. */
export async function readClientPortalNativeFinancialDocuments(env:ReaderEnv,inputValue:unknown,
  send:typeof fetch=fetch):Promise<NativeFinancialReadResult>{
  const input=request(inputValue);
  if(!input) return {status:"denied"};
  if(env.CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED!=="true") return {status:"disabled"};
  const before=await authority(env.OPS_DB,input);
  if(!before) return {status:"denied"};
  const mapping=await resolveTrustedNativeFinancialMapping(env,target(before));
  const selector=mapping && selectorFromTrustedFinancialMapping(mapping);
  if(!mapping||!selector) return {status:"denied"};
  const result=await readConfiguredProjectAlphaFinancialDocuments(env,mapping,selector,send);
  if(result.status!=="ok") return {status:result.status==="unavailable"?"unavailable":"incompatible"};
  const after=await authority(env.OPS_DB,input);
  const currentMapping=after && await resolveTrustedNativeFinancialMapping(env,target(after));
  const finalAuthority=currentMapping && await authority(env.OPS_DB,input);
  if(!after||!finalAuthority||after.grant_id!==before.grant_id||after.revision!==before.revision
    ||after.entity_kind!==before.entity_kind||after.native_entity_id!==before.native_entity_id
    ||finalAuthority.grant_id!==after.grant_id||finalAuthority.revision!==after.revision
    ||finalAuthority.entity_kind!==after.entity_kind||finalAuthority.native_entity_id!==after.native_entity_id
    ||!currentMapping||!sameMapping(mapping,currentMapping)) return {status:"denied"};
  return {status:"ok",grantId:before.grant_id,revision:before.revision,value:result.value};
}
