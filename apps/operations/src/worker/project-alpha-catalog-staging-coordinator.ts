import { readProjectAlphaCatalogSnapshot, type ProjectAlphaCatalogInventoryItem,
  type ProjectAlphaCatalogSnapshotOutcome } from "./project-alpha-catalog-inventory-api-v2";
import { withEnabledConfiguredProjectAlphaApiV2Connection,
  type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";

const SOURCE_ID=/^[a-z][a-z0-9_.:-]{0,127}$/;
const PROJECT_ALPHA_SOURCE_ID=/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const SNAPSHOT_ID=/^[0-9a-f]{64}$/;
// Match the established Client catalog projection contract before staging.
const MAX_PAGE_ITEMS=50;
const MAX_SNAPSHOT_ITEMS=500;
const MAX_PAGE_BYTES=1024*1024-64*1024;

export type OpsCatalogStagingPage=Readonly<{
  protocolVersion:1;registryId:number;sourceId:string;pageIndex:number;apiVersion:"2";sourceInstanceId:string;applicationId:string;
  historyEpoch:string;requestId:string;snapshotId:string;totalCount:number;items:readonly ProjectAlphaCatalogInventoryItem[];
  nextCursor:string|null;
}>;
export type OpsCatalogStagingReceipt=
  |Readonly<{ok:true;protocolVersion:1;status:"staged"|"duplicate";receiptHash:string}>
  |Readonly<{ok:false;protocolVersion:1;code:"disabled"|"invalid"|"source-unavailable"|"conflict"|"temporarily-unavailable";retryable:boolean}>;
export interface OpsCatalogStagingBinding{stageCatalogInventoryPage(input:OpsCatalogStagingPage):Promise<OpsCatalogStagingReceipt>}
export type OpsCatalogPromotionRequest=Readonly<{registryId:number;sourceId:string;sourceInstanceId:string;applicationId:string;
  historyEpoch:string;snapshotId:string;expectedSourceSequence:number}>;
export type OpsCatalogPromotionReceipt=
  |Readonly<{ok:true;protocolVersion:1;status:"promoted"|"duplicate";generationId:string;sourceSequence:number}>
  |Readonly<{ok:false;protocolVersion:1;code:"disabled"|"invalid"|"source-unavailable"|"incomplete"|"stale"|"conflict"|"temporarily-unavailable";retryable:boolean}>;
export interface OpsCatalogPromotionBinding{promoteCatalogInventorySnapshot(input:OpsCatalogPromotionRequest):Promise<OpsCatalogPromotionReceipt>}
export type ProjectAlphaCatalogStagingEnvironment=ProjectAlphaApiV2ConnectionEnvironment&Readonly<{
  PROJECT_ALPHA_CATALOG_STAGING_COORDINATOR_ENABLED?:string;
  PROJECT_ALPHA_CATALOG_PROMOTION_COORDINATOR_ENABLED?:string;
  OPS_INVENTORY_CATALOG_STAGING?:OpsCatalogStagingBinding;
  OPS_INVENTORY_CATALOG_PROMOTION?:OpsCatalogPromotionBinding;
}>;
export type ProjectAlphaCatalogStagingOutcome=
  |Readonly<{status:"disabled"}>
  |Readonly<{status:"rejected";reason:"invalid_command"}>
  |Readonly<{status:"blocked";reason:"configuration"|"source_disabled"|"source_read"|"snapshot_mismatch"|"catalog_contract"|"catalog_limit"|"page_too_large"|"staging"|"promotion";stageCode?:"disabled"|"invalid"|"source-unavailable"|"conflict"|"temporarily-unavailable";promotionCode?:"disabled"|"invalid"|"source-unavailable"|"incomplete"|"stale"|"conflict"|"temporarily-unavailable";retryable?:boolean}>
  |Readonly<{status:"complete";snapshotId:string;totalCount:number;pageCount:number;stagedCount:number;duplicateCount:number;
    promotion?:Readonly<{status:"promoted"|"duplicate";generationId:string;sourceSequence:number}>}>;

type Dependencies=Readonly<{
  readSnapshot:(connection:Readonly<ProjectAlphaApiV2Connection>)=>Promise<ProjectAlphaCatalogSnapshotOutcome>;
}>;

function canonical(value:unknown):string{
  if(Array.isArray(value))return`[${value.map(canonical).join(",")}]`;
  if(value!==null&&typeof value==="object")return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function bytes(value:unknown):number{return new TextEncoder().encode(canonical(value)).byteLength;}
async function deterministicRequestId(registryId:number,sourceId:string,connection:Readonly<ProjectAlphaApiV2Connection>,snapshotId:string,pageIndex:number):Promise<string>{
  const material=canonical(["ops-catalog-staging-page:v1",registryId,sourceId,connection.expectedSourceInstanceId,connection.expectedApplicationId,
    connection.expectedHistoryEpoch,snapshotId,pageIndex]);
  const digest=[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(material)))]
    .map(value=>value.toString(16).padStart(2,"0")).join("").slice(0,32).split("");
  digest[12]="4";digest[16]=((Number.parseInt(digest[16]!,16)&3)|8).toString(16);
  return`${digest.slice(0,8).join("")}-${digest.slice(8,12).join("")}-${digest.slice(12,16).join("")}-${digest.slice(16,20).join("")}-${digest.slice(20).join("")}`;
}
function page(sourceId:string,connection:Readonly<ProjectAlphaApiV2Connection>,snapshot:Extract<ProjectAlphaCatalogSnapshotOutcome,{status:"complete"}>,
  registryId:number,pageIndex:number,items:readonly ProjectAlphaCatalogInventoryItem[],nextCursor:string|null,requestId:string):OpsCatalogStagingPage{
  return{protocolVersion:1,registryId,sourceId,pageIndex,apiVersion:"2",sourceInstanceId:connection.expectedSourceInstanceId,
    applicationId:connection.expectedApplicationId,historyEpoch:connection.expectedHistoryEpoch!,requestId,snapshotId:snapshot.snapshotId,
    totalCount:snapshot.totalCount,items,nextCursor};
}

async function paginate(registryId:number,sourceId:string,connection:Readonly<ProjectAlphaApiV2Connection>,snapshot:Extract<ProjectAlphaCatalogSnapshotOutcome,{status:"complete"}>):Promise<OpsCatalogStagingPage[]|null>{
  if(!connection.expectedHistoryEpoch)return null;
  if(snapshot.items.length===0){const empty=page(sourceId,connection,snapshot,registryId,0,[],null,
    await deterministicRequestId(registryId,sourceId,connection,snapshot.snapshotId,0));return bytes(empty)<=MAX_PAGE_BYTES?[empty]:null;}
  const pages:OpsCatalogStagingPage[]=[];let offset=0;
  while(offset<snapshot.items.length){
    const pageIndex=pages.length,id=await deterministicRequestId(registryId,sourceId,connection,snapshot.snapshotId,pageIndex);let end=offset;
    while(end<snapshot.items.length&&end-offset<MAX_PAGE_ITEMS){
      const candidateCursor=end+1<snapshot.items.length?`page_${pageIndex+1}`:null;
      const candidate=page(sourceId,connection,snapshot,registryId,pageIndex,snapshot.items.slice(offset,end+1),candidateCursor,id);
      if(bytes(candidate)>MAX_PAGE_BYTES)break;
      end++;
    }
    if(end===offset)return null;
    const next=end<snapshot.items.length?`page_${pageIndex+1}`:null;
    pages.push(page(sourceId,connection,snapshot,registryId,pageIndex,snapshot.items.slice(offset,end),next,id));offset=end;
  }
  return pages;
}

/**
 * Dormant one-shot bridge from an enabled PA v2 source to Client's staging-only
 * RPC. Nothing invokes this from fetch/scheduled handlers, and no credential is
 * serialized into the RPC payload or returned in its outcome.
 */
export async function stageConfiguredProjectAlphaCatalogSnapshot(env:ProjectAlphaCatalogStagingEnvironment,
  command:Readonly<{registryId:number;sourceId:string;expectedSnapshotId?:string;expectedSourceSequence?:number}>,dependencies:Partial<Dependencies>={}):Promise<ProjectAlphaCatalogStagingOutcome>{
  if(env.PROJECT_ALPHA_CATALOG_STAGING_COORDINATOR_ENABLED!=="true")return{status:"disabled"};
  const promotionEnabled=env.PROJECT_ALPHA_CATALOG_PROMOTION_COORDINATOR_ENABLED==="true",keys=command&&typeof command==="object"?Object.keys(command):[];
  if(!command||!keys.every(key=>key==="registryId"||key==="sourceId"||key==="expectedSnapshotId"||key==="expectedSourceSequence")
    ||!Number.isSafeInteger(command.registryId)||command.registryId<1||typeof command.sourceId!=="string"||!SOURCE_ID.test(command.sourceId)
    ||(promotionEnabled&&(!PROJECT_ALPHA_SOURCE_ID.test(command.sourceId)||typeof command.expectedSnapshotId!=="string"||!SNAPSHOT_ID.test(command.expectedSnapshotId)
      ||!Number.isSafeInteger(command.expectedSourceSequence)||command.expectedSourceSequence!<0))
    ||(!promotionEnabled&&(command.expectedSnapshotId!==undefined||command.expectedSourceSequence!==undefined)))return{status:"rejected",reason:"invalid_command"};
  if(!env.OPS_INVENTORY_CATALOG_STAGING)return{status:"blocked",reason:"configuration"};
  if(promotionEnabled&&!env.OPS_INVENTORY_CATALOG_PROMOTION)return{status:"blocked",reason:"configuration"};
  const readSnapshot=dependencies.readSnapshot??(connection=>readProjectAlphaCatalogSnapshot(connection));
  const selected=await withEnabledConfiguredProjectAlphaApiV2Connection(env,command.sourceId,async connection=>{
    const snapshot=await readSnapshot(connection);
    if(snapshot.status!=="complete")return{status:"blocked",reason:"source_read"} as const;
    if(promotionEnabled&&snapshot.snapshotId!==command.expectedSnapshotId)return{status:"blocked",reason:"snapshot_mismatch"} as const;
    if(snapshot.items.some(item=>[...item.name].length>160))return{status:"blocked",reason:"catalog_contract"} as const;
    if(snapshot.items.length>MAX_SNAPSHOT_ITEMS)return{status:"blocked",reason:"catalog_limit"} as const;
    const pages=await paginate(command.registryId,command.sourceId,connection,snapshot);
    if(!pages)return{status:"blocked",reason:"page_too_large"} as const;
    let stagedCount=0,duplicateCount=0;
    for(const value of pages){
      let receipt:OpsCatalogStagingReceipt;
      try{receipt=await env.OPS_INVENTORY_CATALOG_STAGING!.stageCatalogInventoryPage(value);}
      catch{return{status:"blocked",reason:"staging",stageCode:"temporarily-unavailable",retryable:true} as const;}
      if(!receipt.ok)return{status:"blocked",reason:"staging",stageCode:receipt.code,retryable:receipt.retryable} as const;
      if(receipt.status==="staged")stagedCount++;else duplicateCount++;
    }
    if(!promotionEnabled)return{status:"complete",snapshotId:snapshot.snapshotId,totalCount:snapshot.totalCount,pageCount:pages.length,stagedCount,duplicateCount} as const;
    let promotion:OpsCatalogPromotionReceipt;
    try{promotion=await env.OPS_INVENTORY_CATALOG_PROMOTION!.promoteCatalogInventorySnapshot({registryId:command.registryId,
      sourceId:command.sourceId,sourceInstanceId:connection.expectedSourceInstanceId,applicationId:connection.expectedApplicationId,
      historyEpoch:connection.expectedHistoryEpoch!,snapshotId:snapshot.snapshotId,expectedSourceSequence:command.expectedSourceSequence!});}
    catch{return{status:"blocked",reason:"promotion",promotionCode:"temporarily-unavailable",retryable:true} as const;}
    if(!promotion.ok)return{status:"blocked",reason:"promotion",promotionCode:promotion.code,retryable:promotion.retryable} as const;
    return{status:"complete",snapshotId:snapshot.snapshotId,totalCount:snapshot.totalCount,pageCount:pages.length,stagedCount,duplicateCount,
      promotion:{status:promotion.status,generationId:promotion.generationId,sourceSequence:promotion.sourceSequence}} as const;
  });
  if(selected.status==="disabled")return{status:"blocked",reason:"source_disabled"};
  if(selected.status==="misconfigured")return{status:"blocked",reason:"configuration"};
  return selected.value;
}
