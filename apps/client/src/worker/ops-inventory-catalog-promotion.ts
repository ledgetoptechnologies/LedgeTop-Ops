import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./types";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256=/^[0-9a-f]{64}$/;
const SOURCE=/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
export interface OpsInventoryCatalogPromotionAuthority {registryId:number;sourceId:string;sourceInstanceId:string;
  applicationId:string;historyEpoch:string;snapshotId:string;expectedSourceSequence:number}
export type OpsInventoryCatalogPromotionResult=
  |{ok:true;protocolVersion:1;status:"promoted"|"duplicate";generationId:string;sourceSequence:number}
  |{ok:false;protocolVersion:1;code:"disabled"|"invalid"|"source-unavailable"|"incomplete"|"stale"|"conflict"|"temporarily-unavailable";retryable:boolean};
type Db=Pick<D1Database,"prepare"|"batch">;
interface RegistryRow {registry_id:number;source_id:string;source_instance_id:string;application_id:string;history_epoch:string;state:string}
interface CheckpointRow {active_generation_id:string|null;source_generation:string;source_sequence:number}
interface GenerationRow {id:string;source_generation:string;source_sequence:number;snapshot_hash:string;page_count:number;item_count:number;status:string;complete:number}
interface PageSummary {page_count:number;item_count:number;min_page:number|null;max_page:number|null;terminal_count:number;total_min:number|null;total_max:number|null;oversized_count:number}

function validAuthority(value:unknown):value is OpsInventoryCatalogPromotionAuthority{
  if(typeof value!=="object"||value===null||Array.isArray(value))return false;
  const v=value as Record<string,unknown>,keys=Object.keys(v);
  return keys.length===7&&["registryId","sourceId","sourceInstanceId","applicationId","historyEpoch","snapshotId","expectedSourceSequence"].every(k=>Object.hasOwn(v,k))
    &&Number.isSafeInteger(v.registryId)&&Number(v.registryId)>0&&typeof v.sourceId==="string"&&SOURCE.test(v.sourceId)
    &&typeof v.sourceInstanceId==="string"&&UUID.test(v.sourceInstanceId)&&typeof v.applicationId==="string"&&UUID.test(v.applicationId)
    &&typeof v.historyEpoch==="string"&&UUID.test(v.historyEpoch)&&typeof v.snapshotId==="string"&&SHA256.test(v.snapshotId)
    &&Number.isSafeInteger(v.expectedSourceSequence)&&Number(v.expectedSourceSequence)>=0;
}
function generationIdentity(authority:OpsInventoryCatalogPromotionAuthority){return{
  id:`ops-inventory:${authority.registryId}:${authority.snapshotId}`,
  sourceGeneration:`${authority.historyEpoch}:${authority.snapshotId}`,
};}
function sameGeneration(row:GenerationRow,identity:ReturnType<typeof generationIdentity>,sequence:number,pages:number,items:number){
  return row.id===identity.id&&row.source_generation===identity.sourceGeneration&&row.source_sequence===sequence
    &&row.snapshot_hash===identity.id.slice(identity.id.lastIndexOf(":")+1)&&row.page_count===pages&&row.item_count===items;
}
function failure(code:Exclude<OpsInventoryCatalogPromotionResult,{ok:true}>["code"],retryable=false):OpsInventoryCatalogPromotionResult{
  return{ok:false,protocolVersion:1,code,retryable};
}

/** Promote one exact, complete staging generation. The authority is an
 * operator-selected registry identity, not an inbound browser credential. */
export async function promoteOpsInventoryCatalogSnapshot(env:Pick<Env,"DELIVERY_DB"|"OPS_INVENTORY_CATALOG_PROMOTION_ENABLED">,
  input:unknown):Promise<OpsInventoryCatalogPromotionResult>{
  if(env.OPS_INVENTORY_CATALOG_PROMOTION_ENABLED!=="true")return failure("disabled",true);
  if(!validAuthority(input))return failure("invalid");
  const db:Db=env.DELIVERY_DB.withSession("first-primary"),identity=generationIdentity(input);
  try{
    const registry=await db.prepare(`SELECT registry_id,source_id,source_instance_id,application_id,history_epoch,state
      FROM ops_inventory_catalog_staging_sources WHERE registry_id=? AND source_id=? AND source_instance_id=? AND application_id=? AND history_epoch=?`)
      .bind(input.registryId,input.sourceId,input.sourceInstanceId,input.applicationId,input.historyEpoch).first<RegistryRow>();
    if(registry?.state!=="staging")return failure("source-unavailable");
    const competing=Number(await db.prepare(`SELECT count(*) FROM ops_inventory_catalog_staging_sources
      WHERE source_id=? AND state='staging' AND registry_id<>?`).bind(input.sourceId,input.registryId).first("count(*)"));
    if(competing!==0)return failure("source-unavailable");
    const summary=await db.prepare(`SELECT count(*) page_count,COALESCE(sum(item_count),0) item_count,min(page_index) min_page,max(page_index) max_page,
      sum(CASE WHEN next_cursor IS NULL THEN 1 ELSE 0 END) terminal_count,min(total_count) total_min,max(total_count) total_max,
      sum(CASE WHEN item_count>50 THEN 1 ELSE 0 END) oversized_count
      FROM ops_inventory_catalog_staging_pages WHERE registry_id=? AND snapshot_id=?`).bind(input.registryId,input.snapshotId).first<PageSummary>();
    const stagedItems=Number(await db.prepare(`SELECT count(*) FROM ops_inventory_catalog_staging_items
      WHERE registry_id=? AND snapshot_id=?`).bind(input.registryId,input.snapshotId).first("count(*)"));
    const pageCountMismatch=Number(await db.prepare(`SELECT count(*) FROM ops_inventory_catalog_staging_pages page
      WHERE page.registry_id=? AND page.snapshot_id=? AND page.item_count<>(SELECT count(*) FROM ops_inventory_catalog_staging_items item
        WHERE item.registry_id=page.registry_id AND item.snapshot_id=page.snapshot_id AND item.page_index=page.page_index)`)
      .bind(input.registryId,input.snapshotId).first("count(*)"));
    const canonicalItemMismatch=Number(await db.prepare(`SELECT count(*) FROM ops_inventory_catalog_staging_items
      WHERE registry_id=? AND snapshot_id=? AND (length(trim(json_extract(item_json,'$.name'))) NOT BETWEEN 1 AND 160
        OR json_extract(item_json,'$.publicId')<>public_id OR json_extract(item_json,'$.sourceVersion')<>content_version
        OR json_type(item_json,'$.questions')<>'array')`).bind(input.registryId,input.snapshotId).first("count(*)"));
    if(!summary||summary.page_count<1||summary.page_count>100||summary.item_count>500||summary.oversized_count!==0
      ||summary.min_page!==0||summary.max_page!==summary.page_count-1||summary.terminal_count!==1
      ||summary.total_min!==summary.total_max||summary.total_min!==summary.item_count||stagedItems!==summary.item_count
      ||pageCountMismatch!==0||canonicalItemMismatch!==0)return failure("incomplete");
    const nonTerminal=Number(await db.prepare(`SELECT count(*) FROM ops_inventory_catalog_staging_pages
      WHERE registry_id=? AND snapshot_id=? AND ((page_index<? AND next_cursor IS NULL) OR (page_index=? AND next_cursor IS NOT NULL))`)
      .bind(input.registryId,input.snapshotId,summary.page_count-1,summary.page_count-1).first("count(*)"));
    if(nonTerminal!==0)return failure("incomplete");
    const checkpoint=await db.prepare(`SELECT active_generation_id,source_generation,source_sequence FROM pa_service_catalog_checkpoint WHERE source_id=?`)
      .bind(input.sourceId).first<CheckpointRow>();
    const currentSequence=checkpoint?.source_sequence??0,sequence=input.expectedSourceSequence+1;
    const existing=await db.prepare(`SELECT * FROM pa_service_catalog_generations WHERE source_id=? AND (id=? OR source_generation=?) LIMIT 1`)
      .bind(input.sourceId,identity.id,identity.sourceGeneration).first<GenerationRow>();
    if(existing){
      if(sameGeneration(existing,identity,existing.source_sequence,summary.page_count,summary.item_count)&&existing.status==="active"&&existing.complete===1
        &&checkpoint?.active_generation_id===existing.id&&checkpoint.source_sequence===existing.source_sequence)
        return{ok:true,protocolVersion:1,status:"duplicate",generationId:existing.id,sourceSequence:existing.source_sequence};
      return failure(existing.source_sequence<=(checkpoint?.source_sequence??0)?"stale":"conflict");
    }
    if(currentSequence!==input.expectedSourceSequence)return failure("stale");
    const versionConflict=await db.prepare(`SELECT 1 FROM ops_inventory_catalog_staging_items staged
      JOIN pa_service_catalog_items current ON current.source_id=? AND current.public_id=staged.public_id AND current.source_version=staged.content_version
      WHERE staged.registry_id=? AND staged.snapshot_id=? AND (current.name<>json_extract(staged.item_json,'$.name')
        OR COALESCE(current.summary,'')<>COALESCE(json_extract(staged.item_json,'$.summary'),'') OR current.category<>json_extract(staged.item_json,'$.category')
        OR current.display_order<>json_extract(staged.item_json,'$.displayOrder') OR current.geometry_requirement<>json_extract(staged.item_json,'$.geometryRequirement')
        OR current.question_schema_json<>json_extract(staged.item_json,'$.questions')) LIMIT 1`)
      .bind(input.sourceId,input.registryId,input.snapshotId).first();
    if(versionConflict)return failure("conflict");
    const expectedSequence=input.expectedSourceSequence,expectedGeneration=checkpoint?.active_generation_id??null;
    // The staging ingress can append pages while the checks above run. Recheck
    // completeness inside D1's atomic batch before copying any canonical row.
    const snapshotGuard=`EXISTS(WITH target(registry_id,snapshot_id,expected_pages,expected_items) AS (VALUES(?,?,?,?)),
      pages AS (SELECT count(*) page_count,COALESCE(sum(page.item_count),0) item_count,min(page.page_index) min_page,
        max(page.page_index) max_page,min(page.total_count) total_min,max(page.total_count) total_max,
        sum(CASE WHEN page.next_cursor IS NULL THEN 1 ELSE 0 END) terminal_count,
        sum(CASE WHEN page.page_index=(SELECT expected_pages-1 FROM target) AND page.next_cursor IS NULL THEN 1 ELSE 0 END) final_terminal_count,
        sum(CASE WHEN page.item_count>50 THEN 1 ELSE 0 END) oversized_count
        FROM ops_inventory_catalog_staging_pages page JOIN target ON page.registry_id=target.registry_id AND page.snapshot_id=target.snapshot_id)
      SELECT 1 FROM target,pages WHERE pages.page_count=target.expected_pages AND pages.page_count BETWEEN 1 AND 100
        AND pages.item_count=target.expected_items AND pages.item_count<=500 AND pages.min_page=0
        AND pages.max_page=pages.page_count-1 AND pages.total_min=pages.item_count AND pages.total_max=pages.item_count
        AND pages.terminal_count=1 AND pages.final_terminal_count=1 AND pages.oversized_count=0
        AND (SELECT count(*) FROM ops_inventory_catalog_staging_items item
          WHERE item.registry_id=target.registry_id AND item.snapshot_id=target.snapshot_id)=target.expected_items
        AND NOT EXISTS(SELECT 1 FROM ops_inventory_catalog_staging_pages page
          WHERE page.registry_id=target.registry_id AND page.snapshot_id=target.snapshot_id AND page.item_count<>(
            SELECT count(*) FROM ops_inventory_catalog_staging_items item WHERE item.registry_id=page.registry_id
              AND item.snapshot_id=page.snapshot_id AND item.page_index=page.page_index))
        AND NOT EXISTS(SELECT 1 FROM ops_inventory_catalog_staging_items item
          WHERE item.registry_id=target.registry_id AND item.snapshot_id=target.snapshot_id AND (
            length(trim(json_extract(item.item_json,'$.name'))) NOT BETWEEN 1 AND 160
            OR json_extract(item.item_json,'$.publicId')<>item.public_id
            OR json_extract(item.item_json,'$.sourceVersion')<>item.content_version
            OR json_type(item.item_json,'$.questions')<>'array')))`;
    const authorityGuard=`EXISTS(SELECT 1 FROM ops_inventory_catalog_staging_sources WHERE registry_id=? AND source_id=? AND source_instance_id=?
      AND application_id=? AND history_epoch=? AND state='staging') AND NOT EXISTS(SELECT 1 FROM ops_inventory_catalog_staging_sources
      WHERE source_id=? AND state='staging' AND registry_id<>?) AND NOT EXISTS(SELECT 1 FROM pa_service_catalog_generations
      WHERE source_id=? AND (id=? OR source_generation=?)) AND COALESCE((SELECT source_sequence FROM pa_service_catalog_checkpoint WHERE source_id=?),0)=?
      AND COALESCE((SELECT active_generation_id FROM pa_service_catalog_checkpoint WHERE source_id=?),'')=COALESCE(?, '')
      AND ${snapshotGuard}`;
    const guardBindings=[input.registryId,input.sourceId,input.sourceInstanceId,input.applicationId,input.historyEpoch,input.sourceId,input.registryId,
      input.sourceId,identity.id,identity.sourceGeneration,input.sourceId,expectedSequence,input.sourceId,expectedGeneration,
      input.registryId,input.snapshotId,summary.page_count,summary.item_count];
    const statements:D1PreparedStatement[]=[
      db.prepare(`INSERT INTO pa_portal_source_write_fences(source_id,write_guard) VALUES(?,CASE WHEN ${authorityGuard} THEN 1 ELSE 0 END)
        ON CONFLICT(source_id) DO UPDATE SET write_guard=excluded.write_guard`).bind(input.sourceId,...guardBindings),
      db.prepare(`INSERT INTO pa_service_catalog_generations(id,source_id,source_generation,source_sequence,snapshot_hash,page_count,item_count,status,complete,activated_at)
        VALUES(?,?,?,?,?,?,?,'active',1,datetime('now'))`).bind(identity.id,input.sourceId,identity.sourceGeneration,sequence,input.snapshotId,summary.page_count,summary.item_count),
      db.prepare(`INSERT INTO pa_service_catalog_generation_pages(generation_id,source_id,page_number,item_count,payload_hash)
        SELECT ?,source_id,page_index+1,item_count,receipt_hash FROM ops_inventory_catalog_staging_pages WHERE registry_id=? AND snapshot_id=? ORDER BY page_index`)
        .bind(identity.id,input.registryId,input.snapshotId),
      db.prepare(`INSERT INTO pa_service_catalog_generation_items(generation_id,source_id,page_number,public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json)
        SELECT ?,?,page_index+1,public_id,content_version,json_extract(item_json,'$.name'),json_extract(item_json,'$.summary'),json_extract(item_json,'$.category'),
          json_extract(item_json,'$.displayOrder'),json_extract(item_json,'$.geometryRequirement'),json_extract(item_json,'$.questions')
        FROM ops_inventory_catalog_staging_items WHERE registry_id=? AND snapshot_id=? ORDER BY page_index,public_id`)
        .bind(identity.id,input.sourceId,input.registryId,input.snapshotId),
      db.prepare("UPDATE pa_service_catalog_items SET active=0 WHERE source_id=? AND active=1").bind(input.sourceId),
      db.prepare(`INSERT INTO pa_service_catalog_items(source_id,public_id,source_version,name,summary,question_schema_json,active,source_updated_at,mirrored_at,source_generation,source_sequence,category,display_order,geometry_requirement)
        SELECT ?,public_id,content_version,json_extract(item_json,'$.name'),json_extract(item_json,'$.summary'),json_extract(item_json,'$.questions'),1,datetime('now'),datetime('now'),?,?,
          json_extract(item_json,'$.category'),json_extract(item_json,'$.displayOrder'),json_extract(item_json,'$.geometryRequirement')
        FROM ops_inventory_catalog_staging_items WHERE registry_id=? AND snapshot_id=?
        ON CONFLICT(source_id,public_id,source_version) DO UPDATE SET active=1,mirrored_at=datetime('now'),source_generation=excluded.source_generation,source_sequence=excluded.source_sequence`)
        .bind(input.sourceId,identity.sourceGeneration,sequence,input.registryId,input.snapshotId),
      db.prepare("UPDATE pa_service_catalog_entity_state SET active=0,source_sequence=?,updated_at=datetime('now') WHERE source_id=?").bind(sequence,input.sourceId),
      db.prepare(`INSERT INTO pa_service_catalog_entity_state(source_id,public_id,source_version,source_sequence,active)
        SELECT ?,public_id,content_version,?,1 FROM ops_inventory_catalog_staging_items WHERE registry_id=? AND snapshot_id=?
        ON CONFLICT(source_id,public_id) DO UPDATE SET source_version=excluded.source_version,source_sequence=excluded.source_sequence,active=1,updated_at=datetime('now')`)
        .bind(input.sourceId,sequence,input.registryId,input.snapshotId),
      db.prepare("UPDATE pa_service_catalog_generations SET status='superseded' WHERE source_id=? AND status='active' AND id<>?").bind(input.sourceId,identity.id),
      checkpoint?db.prepare(`UPDATE pa_service_catalog_checkpoint SET active_generation_id=?,source_generation=?,source_sequence=?,updated_at=datetime('now') WHERE source_id=? AND source_sequence=?`)
        .bind(identity.id,identity.sourceGeneration,sequence,input.sourceId,expectedSequence)
        :db.prepare(`INSERT INTO pa_service_catalog_checkpoint(source_id,active_generation_id,source_generation,source_sequence) VALUES(?,?,?,?)`)
          .bind(input.sourceId,identity.id,identity.sourceGeneration,sequence),
    ];
    await db.batch(statements);
    return{ok:true,protocolVersion:1,status:"promoted",generationId:identity.id,sourceSequence:sequence};
  }catch(error){
    const current=await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT generation.*,checkpoint.active_generation_id checkpoint_generation,
      checkpoint.source_sequence checkpoint_sequence FROM pa_service_catalog_generations generation JOIN pa_service_catalog_checkpoint checkpoint
      ON checkpoint.source_id=generation.source_id WHERE generation.source_id=? AND generation.source_generation=?`)
      .bind(input.sourceId,identity.sourceGeneration).first<GenerationRow&{checkpoint_generation:string|null;checkpoint_sequence:number}>().catch(()=>null);
    if(current&&current.status==="active"&&current.complete===1&&current.checkpoint_generation===current.id&&current.checkpoint_sequence===current.source_sequence)
      return{ok:true,protocolVersion:1,status:"duplicate",generationId:current.id,sourceSequence:current.source_sequence};
    const message=error instanceof Error?error.message:String(error);
    if(/pa_portal_source_write_guard|UNIQUE|constraint/i.test(message))return failure("conflict");
    return failure("temporarily-unavailable",true);
  }
}

/** Service-binding-only coordinator. No HTTP route or public link is added. */
export class OpsInventoryCatalogPromotionCoordinator extends WorkerEntrypoint<Env>{
  promoteCatalogInventorySnapshot(input:unknown){return promoteOpsInventoryCatalogSnapshot(this.env,input);}
}
