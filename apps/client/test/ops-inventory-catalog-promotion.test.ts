import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
vi.mock("cloudflare:workers",()=>({WorkerEntrypoint:class{}}));
import { promoteOpsInventoryCatalogSnapshot,type OpsInventoryCatalogPromotionAuthority } from "../src/worker/ops-inventory-catalog-promotion";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import type { Env } from "../src/worker/types";

const authority:OpsInventoryCatalogPromotionAuthority={registryId:1,sourceId:"project-alpha:primary",
  sourceInstanceId:"11111111-1111-4111-8111-111111111111",applicationId:"22222222-2222-4222-8222-222222222222",
  historyEpoch:"33333333-3333-4333-8333-333333333333",snapshotId:"c".repeat(64),expectedSourceSequence:0};
const item=(id:string,name:string)=>({publicId:id.repeat(32),sourceVersion:`sha256-${id.repeat(64)}`,name,summary:null,
  category:"Survey",displayOrder:id==="a"?1:2,geometryRequirement:"optional",questions:[]});
const canonicalSchema=`
CREATE TABLE pa_service_catalog_generations(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,source_generation TEXT NOT NULL,
 source_sequence INTEGER NOT NULL,snapshot_hash TEXT NOT NULL,page_count INTEGER NOT NULL,item_count INTEGER NOT NULL,
 status TEXT NOT NULL,complete INTEGER NOT NULL,created_at TEXT DEFAULT(datetime('now')),activated_at TEXT,
 UNIQUE(source_id,source_generation),UNIQUE(source_id,source_sequence));
CREATE TABLE pa_service_catalog_generation_pages(generation_id TEXT,source_id TEXT,page_number INTEGER,item_count INTEGER,payload_hash TEXT,
 PRIMARY KEY(generation_id,source_id,page_number),FOREIGN KEY(generation_id,source_id) REFERENCES pa_service_catalog_generations(id,source_id));
CREATE UNIQUE INDEX generation_source ON pa_service_catalog_generations(id,source_id);
CREATE TABLE pa_service_catalog_generation_items(generation_id TEXT,source_id TEXT,page_number INTEGER,public_id TEXT,source_version TEXT,name TEXT,
 summary TEXT,category TEXT,display_order INTEGER,geometry_requirement TEXT,question_schema_json TEXT,
 PRIMARY KEY(generation_id,source_id,public_id),FOREIGN KEY(generation_id,source_id,page_number) REFERENCES pa_service_catalog_generation_pages(generation_id,source_id,page_number));
CREATE TABLE pa_service_catalog_items(source_id TEXT,public_id TEXT,source_version TEXT,name TEXT,summary TEXT,question_schema_json TEXT,
 active INTEGER,source_updated_at TEXT,mirrored_at TEXT,source_generation TEXT,source_sequence INTEGER,category TEXT,display_order INTEGER,
 geometry_requirement TEXT,PRIMARY KEY(source_id,public_id,source_version));
CREATE UNIQUE INDEX current_catalog_item ON pa_service_catalog_items(source_id,public_id) WHERE active=1;
CREATE TABLE pa_service_catalog_checkpoint(source_id TEXT PRIMARY KEY,active_generation_id TEXT,source_generation TEXT,source_sequence INTEGER,updated_at TEXT DEFAULT(datetime('now')));
CREATE TABLE pa_service_catalog_entity_state(source_id TEXT,public_id TEXT,source_version TEXT,source_sequence INTEGER,active INTEGER,updated_at TEXT DEFAULT(datetime('now')),PRIMARY KEY(source_id,public_id));
CREATE TABLE pa_portal_source_write_fences(source_id TEXT PRIMARY KEY,write_guard INTEGER NOT NULL CONSTRAINT pa_portal_source_write_guard CHECK(write_guard=1));
CREATE TABLE shares(id TEXT PRIMARY KEY,token TEXT NOT NULL);
`;

describe("route-less staged catalog promotion",()=>{
  let runtime:Miniflare,db:D1Database;
  const env=(enabled="true",database=db)=>({DELIVERY_DB:database,OPS_INVENTORY_CATALOG_PROMOTION_ENABLED:enabled}) as Env;
  beforeAll(async()=>{runtime=new Miniflare({compatibilityDate:"2026-07-16",modules:true,script:"export default {fetch(){return new Response('test')}}",
    d1Databases:{DELIVERY_DB:"catalog-promotion"}});db=await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const staging=readFileSync(new URL("../migrations/0214_ops_inventory_catalog_staging.sql",import.meta.url),"utf8");
    await db.batch([...splitD1MigrationStatements(staging),...splitD1MigrationStatements(canonicalSchema)].map(sql=>db.prepare(sql)));
  });
  afterAll(async()=>runtime?.dispose());
  beforeEach(async()=>{await db.batch(["ops_inventory_catalog_staging_items","ops_inventory_catalog_staging_pages","ops_inventory_catalog_staging_sources",
    "pa_service_catalog_generation_items","pa_service_catalog_generation_pages","pa_service_catalog_items","pa_service_catalog_entity_state",
    "pa_service_catalog_generations","pa_service_catalog_checkpoint","pa_portal_source_write_fences","shares"].map(table=>db.prepare(`DELETE FROM ${table}`)));
    await db.prepare("INSERT INTO shares VALUES('public-link','unchanged-token')").run();
  });
  async function stage(options:{state?:"staging"|"disabled";terminal?:boolean;gap?:boolean;epoch?:string}={}){
    const state=options.state??"staging",epoch=options.epoch??authority.historyEpoch;
    await db.prepare(`INSERT INTO ops_inventory_catalog_staging_sources(registry_id,source_id,source_instance_id,application_id,history_epoch,state)
      VALUES(?,?,?,?,?,?)`).bind(authority.registryId,authority.sourceId,authority.sourceInstanceId,authority.applicationId,epoch,state).run();
    const pages=options.gap?[0,2]:[0,1];
    for(const [ordinal,pageIndex] of pages.entries()){
      const value=item(ordinal===0?"a":"b",ordinal===0?"Aerial survey":"Boundary survey"),terminal=options.terminal===false?false:ordinal===pages.length-1;
      await db.prepare(`INSERT INTO ops_inventory_catalog_staging_pages(registry_id,source_id,snapshot_id,page_index,request_id,total_count,item_count,next_cursor,receipt_hash)
        VALUES(?,?,?,?,?,?,?,?,?)`).bind(authority.registryId,authority.sourceId,authority.snapshotId,pageIndex,`${ordinal+4}`.repeat(8)+`-${ordinal+4}`.repeat(4)+`-4${ordinal+4}${ordinal+4}${ordinal+4}-8${ordinal+4}${ordinal+4}${ordinal+4}-${ordinal+4}`.repeat(12),2,1,terminal?null:`cursor${ordinal}`,`${ordinal+1}`.repeat(64)).run();
      await db.prepare(`INSERT INTO ops_inventory_catalog_staging_items(registry_id,snapshot_id,public_id,page_index,content_version,item_json) VALUES(?,?,?,?,?,?)`)
        .bind(authority.registryId,authority.snapshotId,value.publicId,pageIndex,value.sourceVersion,JSON.stringify(value)).run();
    }
  }
  const tableCount=async(table:string)=>Number(await db.prepare(`SELECT count(*) n FROM ${table}`).first("n"));

  it("is independently default-off",async()=>{await stage();expect(await promoteOpsInventoryCatalogSnapshot(env("false"),authority)).toMatchObject({ok:false,code:"disabled"});
    expect(await tableCount("pa_service_catalog_items")).toBe(0);});
  it("rejects disabled, incomplete, non-contiguous, and unterminated staging generations",async()=>{
    await stage({state:"disabled"});expect(await promoteOpsInventoryCatalogSnapshot(env(),authority)).toMatchObject({ok:false,code:"source-unavailable"});
    await db.batch([db.prepare("DELETE FROM ops_inventory_catalog_staging_items"),db.prepare("DELETE FROM ops_inventory_catalog_staging_pages"),
      db.prepare("DELETE FROM ops_inventory_catalog_staging_sources")]);await stage({gap:true});
    expect(await promoteOpsInventoryCatalogSnapshot(env(),authority)).toMatchObject({ok:false,code:"incomplete"});
    await db.batch([db.prepare("DELETE FROM ops_inventory_catalog_staging_items"),db.prepare("DELETE FROM ops_inventory_catalog_staging_pages"),db.prepare("DELETE FROM ops_inventory_catalog_staging_sources")]);
    await stage({terminal:false});expect(await promoteOpsInventoryCatalogSnapshot(env(),authority)).toMatchObject({ok:false,code:"incomplete"});
  });
  it("atomically promotes an exact snapshot and idempotently replays it without changing public links",async()=>{await stage();
    const first=await promoteOpsInventoryCatalogSnapshot(env(),authority);expect(first).toMatchObject({ok:true,status:"promoted",sourceSequence:1});
    expect(await tableCount("pa_service_catalog_items")).toBe(2);expect(await tableCount("pa_service_catalog_generation_pages")).toBe(2);
    expect(await promoteOpsInventoryCatalogSnapshot(env(),authority)).toEqual({...first,status:"duplicate"});
    expect(await db.prepare("SELECT token FROM shares WHERE id='public-link'").first("token")).toBe("unchanged-token");
  });
  it("fences stale epochs and source rotation",async()=>{await stage();await promoteOpsInventoryCatalogSnapshot(env(),authority);
    await db.prepare("UPDATE ops_inventory_catalog_staging_sources SET state='disabled'").run();
    expect(await promoteOpsInventoryCatalogSnapshot(env(),authority)).toMatchObject({ok:false,code:"source-unavailable"});
    const rotated={...authority,registryId:2,historyEpoch:"99999999-9999-4999-8999-999999999999",snapshotId:"d".repeat(64),expectedSourceSequence:1};
    await db.prepare(`INSERT INTO ops_inventory_catalog_staging_sources(registry_id,source_id,source_instance_id,application_id,history_epoch,state)
      VALUES(?,?,?,?,?,'staging')`).bind(rotated.registryId,rotated.sourceId,rotated.sourceInstanceId,rotated.applicationId,rotated.historyEpoch).run();
    expect(await promoteOpsInventoryCatalogSnapshot(env(),rotated)).toMatchObject({ok:false,code:"incomplete"});
  });
  it("rejects an otherwise valid snapshot when its explicit checkpoint authority is stale",async()=>{await stage();
    await db.prepare("INSERT INTO pa_service_catalog_checkpoint(source_id,active_generation_id,source_generation,source_sequence) VALUES(?,NULL,'other',4)")
      .bind(authority.sourceId).run();
    expect(await promoteOpsInventoryCatalogSnapshot(env(),authority)).toMatchObject({ok:false,code:"stale"});
    expect(await tableCount("pa_service_catalog_generations")).toBe(0);
  });
  it("serializes concurrent promotion attempts",async()=>{await stage();const results=await Promise.all([
    promoteOpsInventoryCatalogSnapshot(env(),authority),promoteOpsInventoryCatalogSnapshot(env(),authority)]);
    expect(results.map(result=>result.ok&&result.status).sort()).toEqual(["duplicate","promoted"]);expect(await tableCount("pa_service_catalog_generations")).toBe(1);
  });
  it("rechecks snapshot completeness inside the copy transaction after a concurrent page arrives",async()=>{await stage();
    const racing=new Proxy(db,{get(target,property){if(property==="withSession")return()=>racing;
      if(property==="batch")return async(statements:D1PreparedStatement[])=>{
        await db.prepare(`INSERT INTO ops_inventory_catalog_staging_pages
          (registry_id,source_id,snapshot_id,page_index,request_id,total_count,item_count,next_cursor,receipt_hash)
          VALUES(?,?,?,?,?,?,?,NULL,?)`)
          .bind(authority.registryId,authority.sourceId,authority.snapshotId,2,"concurrent-page",2,0,"d".repeat(64)).run();
        return db.batch(statements);
      };
      const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;}});
    expect(await promoteOpsInventoryCatalogSnapshot(env("true",racing),authority)).toMatchObject({ok:false,code:"conflict"});
    expect(await tableCount("pa_service_catalog_generations")).toBe(0);
    expect(await tableCount("pa_service_catalog_items")).toBe(0);
    expect(await db.prepare("SELECT token FROM shares WHERE id='public-link'").first("token")).toBe("unchanged-token");
  });
  it("rolls back every canonical write when the atomic batch fails",async()=>{await stage();
    const failing=new Proxy(db,{get(target,property){if(property==="withSession")return()=>failing;if(property==="batch")return async(statements:D1PreparedStatement[])=>
      db.batch([...statements,db.prepare("INSERT INTO table_that_does_not_exist VALUES(1)")]);const value=Reflect.get(target,property);return typeof value==="function"?value.bind(target):value;}});
    expect(await promoteOpsInventoryCatalogSnapshot(env("true",failing),authority)).toMatchObject({ok:false,code:"temporarily-unavailable"});
    expect(await tableCount("pa_service_catalog_items")).toBe(0);expect(await tableCount("pa_service_catalog_generations")).toBe(0);
  });
});
