import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./types";

const UUID_V4=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256=/^[0-9a-f]{64}$/;
const PUBLIC_ID=/^[0-9a-f]{32}$/;
const SOURCE_ID=/^[a-z][a-z0-9_.:-]{0,127}$/;
const QUESTION_ID=/^[a-z][a-z0-9_:-]{0,63}$/;
const CURSOR=/^[A-Za-z0-9_-]{1,512}$/;
export const OPS_INVENTORY_CATALOG_RPC_LIMIT_BYTES=1024*1024;
export const OPS_INVENTORY_CATALOG_RPC_HEADROOM_BYTES=64*1024;
/** Caller contract: re-page the snapshot so canonical page bytes stay at or
 * below this value. The remaining 64 KiB is reserved for RPC framing and any
 * future transport metadata; the caller never attempts a near-limit call. */
export const OPS_INVENTORY_CATALOG_MAX_PAGE_BYTES=
  OPS_INVENTORY_CATALOG_RPC_LIMIT_BYTES-OPS_INVENTORY_CATALOG_RPC_HEADROOM_BYTES;

type InventoryOption={value:string;label:string};
type InventoryQuestion={id:string;label:string;type:"text"|"number"|"boolean"|"select"|"multi-select";required:boolean;
  helpText?:string|null;options?:InventoryOption[];minimum?:number;maximum?:number};
export type OpsInventoryCatalogItem={publicId:string;sourceVersion:string;name:string;summary:string|null;category:string;
  displayOrder:number;geometryRequirement:"none"|"optional"|"required";questions:InventoryQuestion[]};
export type OpsInventoryCatalogPage={protocolVersion:1;sourceId:string;pageIndex:number;apiVersion:"2";sourceInstanceId:string;
  applicationId:string;historyEpoch:string;requestId:string;snapshotId:string;totalCount:number;
  items:OpsInventoryCatalogItem[];nextCursor:string|null};
export type OpsInventoryCatalogStageResult=
  |{ok:true;protocolVersion:1;status:"staged"|"duplicate";receiptHash:string}
  |{ok:false;protocolVersion:1;code:"disabled"|"invalid"|"source-unavailable"|"conflict"|"temporarily-unavailable";retryable:boolean};

function exactKeys(value:Record<string,unknown>,required:string[],optional:string[]=[]):boolean{
  const keys=Object.keys(value);return required.every(key=>Object.hasOwn(value,key))
    &&keys.every(key=>required.includes(key)||optional.includes(key));
}
function text(value:unknown,min:number,max:number):value is string{
  if(typeof value!=="string"){return false;}const size=[...value].length;
  return size>=min&&size<=max&&!/[<>\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200E\u200F\u202A-\u202E\u2066-\u2069]/u.test(value);
}
function plain(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value);}
function validQuestion(value:unknown):value is InventoryQuestion{
  if(!plain(value)||!exactKeys(value,["id","label","type","required"],["helpText","options","minimum","maximum"]))return false;
  if(typeof value.id!=="string"||!QUESTION_ID.test(value.id)||!text(value.label,1,200)||typeof value.required!=="boolean")return false;
  if(Object.hasOwn(value,"helpText")&&value.helpText!==null&&!text(value.helpText,1,500))return false;
  if(!["text","number","boolean","select","multi-select"].includes(String(value.type)))return false;
  const select=value.type==="select"||value.type==="multi-select";
  if(select){
    if(!Array.isArray(value.options)||value.options.length<1||value.options.length>50)return false;
    const seen=new Set<string>();for(const option of value.options){
      if(!plain(option)||!exactKeys(option,["value","label"])||!text(option.value,1,100)||!text(option.label,1,200)||seen.has(option.value))return false;
      seen.add(option.value);
    }
  }else if(Object.hasOwn(value,"options"))return false;
  if(value.type==="number"){
    if(Object.hasOwn(value,"minimum")&&(typeof value.minimum!=="number"||!Number.isFinite(value.minimum)))return false;
    if(Object.hasOwn(value,"maximum")&&(typeof value.maximum!=="number"||!Number.isFinite(value.maximum)))return false;
    if(typeof value.minimum==="number"&&typeof value.maximum==="number"&&value.minimum>value.maximum)return false;
  }else if(Object.hasOwn(value,"minimum")||Object.hasOwn(value,"maximum"))return false;
  return true;
}
function validItem(value:unknown):value is OpsInventoryCatalogItem{
  if(!plain(value)||!exactKeys(value,["publicId","sourceVersion","name","summary","category","displayOrder","geometryRequirement","questions"]))return false;
  if(typeof value.publicId!=="string"||!PUBLIC_ID.test(value.publicId)||typeof value.sourceVersion!=="string"||!/^sha256-[0-9a-f]{64}$/.test(value.sourceVersion)
    ||!text(value.name,1,255)||(value.summary!==null&&!text(value.summary,1,1000))||!text(value.category,1,100)
    ||!Number.isInteger(value.displayOrder)||Number(value.displayOrder)<0||Number(value.displayOrder)>1_000_000
    ||!["none","optional","required"].includes(String(value.geometryRequirement))||!Array.isArray(value.questions)||value.questions.length>10)return false;
  const ids=new Set<string>();for(const question of value.questions){if(!validQuestion(question)||ids.has(question.id))return false;ids.add(question.id);}return true;
}
function canonical(value:unknown):string{
  if(Array.isArray(value))return`[${value.map(canonical).join(",")}]`;
  if(plain(value))return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function opsInventoryCatalogPageBytes(value:OpsInventoryCatalogPage):number{
  return new TextEncoder().encode(canonical(value)).byteLength;
}
async function sha256(value:string):Promise<string>{return[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))]
  .map(byte=>byte.toString(16).padStart(2,"0")).join("");}
function validPage(input:unknown):input is OpsInventoryCatalogPage{
  if(!plain(input)||!exactKeys(input,["protocolVersion","sourceId","pageIndex","apiVersion","sourceInstanceId","applicationId","historyEpoch","requestId","snapshotId","totalCount","items","nextCursor"]))return false;
  if(input.protocolVersion!==1||input.apiVersion!=="2"||typeof input.sourceId!=="string"||!SOURCE_ID.test(input.sourceId)
    ||!Number.isInteger(input.pageIndex)||Number(input.pageIndex)<0||Number(input.pageIndex)>100_000
    ||typeof input.sourceInstanceId!=="string"||!UUID_V4.test(input.sourceInstanceId)||typeof input.applicationId!=="string"||!UUID_V4.test(input.applicationId)
    ||typeof input.historyEpoch!=="string"||!UUID_V4.test(input.historyEpoch)||typeof input.requestId!=="string"||!UUID_V4.test(input.requestId)
    ||typeof input.snapshotId!=="string"||!SHA256.test(input.snapshotId)||!Number.isInteger(input.totalCount)||Number(input.totalCount)<0||Number(input.totalCount)>1_000_000
    ||!Array.isArray(input.items)||input.items.length>200||(input.nextCursor!==null&&(typeof input.nextCursor!=="string"||!CURSOR.test(input.nextCursor))))return false;
  if(input.nextCursor!==null&&input.items.length===0)return false;
  const ids=new Set<string>();for(const item of input.items){if(!validItem(item)||ids.has(item.publicId))return false;ids.add(item.publicId);}return true;
}

export async function stageOpsInventoryCatalogPage(env:Pick<Env,"DELIVERY_DB"|"OPS_INVENTORY_CATALOG_SYNC_ENABLED">,input:unknown):Promise<OpsInventoryCatalogStageResult>{
  if(env.OPS_INVENTORY_CATALOG_SYNC_ENABLED!=="true")return{ok:false,protocolVersion:1,code:"disabled",retryable:true};
  if(!validPage(input))return{ok:false,protocolVersion:1,code:"invalid",retryable:false};
  const serialized=canonical(input);if(new TextEncoder().encode(serialized).byteLength>OPS_INVENTORY_CATALOG_MAX_PAGE_BYTES)return{ok:false,protocolVersion:1,code:"invalid",retryable:false};
  const receiptHash=await sha256(serialized),db=env.DELIVERY_DB.withSession("first-primary");
  try{
    const source=await db.prepare(`SELECT registry_id,state FROM ops_inventory_catalog_staging_sources
      WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch=? AND authority_kind='operations-worker'`)
      .bind(input.sourceId,input.sourceInstanceId,input.applicationId,input.historyEpoch).first<{registry_id:number;state:string}>();
    if(source?.state!=="staging")return{ok:false,protocolVersion:1,code:"source-unavailable",retryable:false};
    const existing=await db.prepare(`SELECT receipt_hash FROM ops_inventory_catalog_staging_pages
      WHERE registry_id=? AND snapshot_id=? AND page_index=?`).bind(source.registry_id,input.snapshotId,input.pageIndex).first<{receipt_hash:string}>();
    if(existing)return existing.receipt_hash===receiptHash?{ok:true,protocolVersion:1,status:"duplicate",receiptHash}
      :{ok:false,protocolVersion:1,code:"conflict",retryable:false};
    const snapshot=await db.prepare(`SELECT total_count FROM ops_inventory_catalog_staging_pages
      WHERE registry_id=? AND snapshot_id=? LIMIT 1`).bind(source.registry_id,input.snapshotId).first<{total_count:number}>();
    if(snapshot&&snapshot.total_count!==input.totalCount)return{ok:false,protocolVersion:1,code:"conflict",retryable:false};
    const stagedCount=Number(await db.prepare(`SELECT COUNT(*) count FROM ops_inventory_catalog_staging_items
      WHERE registry_id=? AND snapshot_id=?`).bind(source.registry_id,input.snapshotId).first("count"));
    if(stagedCount+input.items.length>input.totalCount)return{ok:false,protocolVersion:1,code:"conflict",retryable:false};
    if(input.items.length){
      const placeholders=input.items.map(()=>"?").join(",");
      const duplicate=await db.prepare(`SELECT public_id FROM ops_inventory_catalog_staging_items
        WHERE registry_id=? AND snapshot_id=? AND public_id IN (${placeholders}) LIMIT 1`)
        .bind(source.registry_id,input.snapshotId,...input.items.map(item=>item.publicId)).first();
      if(duplicate)return{ok:false,protocolVersion:1,code:"conflict",retryable:false};
    }
    const results=await db.batch([
      db.prepare(`INSERT INTO ops_inventory_catalog_staging_pages
        (registry_id,source_id,snapshot_id,page_index,request_id,total_count,item_count,next_cursor,receipt_hash)
        SELECT registry_id,?,?,?,?,?,?,?,? FROM ops_inventory_catalog_staging_sources
        WHERE registry_id=? AND source_id=? AND source_instance_id=? AND application_id=? AND history_epoch=?
          AND authority_kind='operations-worker' AND state='staging'`)
        .bind(input.sourceId,input.snapshotId,input.pageIndex,input.requestId,input.totalCount,input.items.length,input.nextCursor,receiptHash,
          source.registry_id,input.sourceId,input.sourceInstanceId,input.applicationId,input.historyEpoch),
      ...input.items.map(item=>db.prepare(`INSERT INTO ops_inventory_catalog_staging_items
        (registry_id,snapshot_id,public_id,page_index,content_version,item_json) VALUES(?,?,?,?,?,?)`)
        .bind(source.registry_id,input.snapshotId,item.publicId,input.pageIndex,item.sourceVersion,canonical(item))),
    ]);
    if(Number(results[0]?.meta.changes??0)!==1)return{ok:false,protocolVersion:1,code:"source-unavailable",retryable:false};
    return{ok:true,protocolVersion:1,status:"staged",receiptHash};
  }catch(error){
    const message=error instanceof Error?error.message:"";
    if(/UNIQUE|constraint/i.test(message)){
      const source=await db.prepare(`SELECT registry_id,state FROM ops_inventory_catalog_staging_sources
        WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch=? AND authority_kind='operations-worker'`)
        .bind(input.sourceId,input.sourceInstanceId,input.applicationId,input.historyEpoch).first<{registry_id:number;state:string}>();
      if(!source||source.state!=="staging")return{ok:false,protocolVersion:1,code:"source-unavailable",retryable:false};
      const replay=await db.prepare(`SELECT receipt_hash FROM ops_inventory_catalog_staging_pages
        WHERE registry_id=? AND snapshot_id=? AND page_index=?`).bind(source.registry_id,input.snapshotId,input.pageIndex).first<{receipt_hash:string}>();
      if(replay?.receipt_hash===receiptHash)return{ok:true,protocolVersion:1,status:"duplicate",receiptHash};
      return{ok:false,protocolVersion:1,code:"conflict",retryable:false};
    }
    return{ok:false,protocolVersion:1,code:"temporarily-unavailable",retryable:true};
  }
}

/** Route-less, service-binding-only staging boundary. It never activates catalog rows. */
export class OpsInventoryCatalogStagingIngress extends WorkerEntrypoint<Env>{
  stageCatalogInventoryPage(input:unknown):Promise<OpsInventoryCatalogStageResult>{return stageOpsInventoryCatalogPage(this.env,input);}
}
