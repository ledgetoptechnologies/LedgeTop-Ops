import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers",()=>({WorkerEntrypoint:class{}}));
import { stageOpsInventoryCatalogPage, type OpsInventoryCatalogPage } from "../src/worker/ops-inventory-catalog-staging";
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const source={sourceId:"project-alpha:primary",sourceInstanceId:"11111111-1111-4111-8111-111111111111",
  applicationId:"22222222-2222-4222-8222-222222222222",historyEpoch:"33333333-3333-4333-8333-333333333333"};
const item={publicId:"a".repeat(32),version:"b".repeat(64),name:"Site photography",summary:null,category:"Photography",
  displayOrder:10,geometryRequirement:"optional" as const,questions:[{id:"notes",label:"Notes",type:"text" as const,required:false}]};
const page=():OpsInventoryCatalogPage=>({protocolVersion:1,...source,pageIndex:0,apiVersion:"2",
  requestId:"44444444-4444-4444-8444-444444444444",snapshotId:"c".repeat(64),totalCount:1,items:[item],nextCursor:null});

describe("route-less Operations inventory catalog staging",()=>{
  let runtime:Miniflare,db:D1Database;
  const env=(enabled="true")=>({DELIVERY_DB:db,OPS_INVENTORY_CATALOG_SYNC_ENABLED:enabled}) as Env;
  const count=async(table:string)=>Number(await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"));
  beforeAll(async()=>{
    runtime=new Miniflare({compatibilityDate:"2026-07-16",modules:true,script:"export default {fetch(){return new Response('test')}}",
      d1Databases:{DELIVERY_DB:"ops-inventory-catalog-staging"}});
    db=await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const sql=readFileSync(new URL("../migrations/0214_ops_inventory_catalog_staging.sql",import.meta.url),"utf8");
    await db.batch(splitD1MigrationStatements(sql).map(statement=>db.prepare(statement)));
    // A sentinel with the production table name proves this receiver never
    // reaches the existing live catalog path.
    await db.prepare("CREATE TABLE pa_service_catalog_items(marker TEXT)").run();
  });
  afterAll(async()=>runtime?.dispose());
  beforeEach(async()=>{await db.batch([
    db.prepare("DELETE FROM ops_inventory_catalog_staging_items"),db.prepare("DELETE FROM ops_inventory_catalog_staging_pages"),
    db.prepare("DELETE FROM ops_inventory_catalog_staging_sources"),
  ]);});
  async function provision(state:"disabled"|"staging"="staging"){
    await db.prepare(`INSERT INTO ops_inventory_catalog_staging_sources
      (source_id,source_instance_id,application_id,history_epoch,state) VALUES(?,?,?,?,?)`)
      .bind(source.sourceId,source.sourceInstanceId,source.applicationId,source.historyEpoch,state).run();
  }

  it("is default-off and writes nothing even for a provisioned staging source",async()=>{
    await provision();
    await expect(stageOpsInventoryCatalogPage(env("false"),page())).resolves.toMatchObject({ok:false,code:"disabled"});
    expect(await count("ops_inventory_catalog_staging_pages")).toBe(0);
    expect(await count("ops_inventory_catalog_staging_items")).toBe(0);
  });

  it("default-denies absent, disabled, or mismatched operator registry authority",async()=>{
    await expect(stageOpsInventoryCatalogPage(env(),page())).resolves.toMatchObject({ok:false,code:"source-unavailable"});
    await provision("disabled");
    await expect(stageOpsInventoryCatalogPage(env(),page())).resolves.toMatchObject({ok:false,code:"source-unavailable"});
    await db.prepare("UPDATE ops_inventory_catalog_staging_sources SET state='staging'").run();
    await expect(stageOpsInventoryCatalogPage(env(),{...page(),historyEpoch:"55555555-5555-4555-8555-555555555555"}))
      .resolves.toMatchObject({ok:false,code:"source-unavailable"});
    expect(await count("ops_inventory_catalog_staging_pages")).toBe(0);
  });

  it("stages an exact page, returns an idempotent replay, and rejects changed page content",async()=>{
    await provision();const first=await stageOpsInventoryCatalogPage(env(),page());
    expect(first).toMatchObject({ok:true,status:"staged",receiptHash:expect.stringMatching(/^[a-f0-9]{64}$/)});
    await expect(stageOpsInventoryCatalogPage(env(),page())).resolves.toEqual({...first,status:"duplicate"});
    await expect(stageOpsInventoryCatalogPage(env(),{...page(),totalCount:2})).resolves.toMatchObject({ok:false,code:"conflict"});
    expect(await count("ops_inventory_catalog_staging_pages")).toBe(1);
    expect(await count("ops_inventory_catalog_staging_items")).toBe(1);
  });

  it("rejects duplicate IDs within a page and across distinct pages in one snapshot",async()=>{
    await provision();
    await expect(stageOpsInventoryCatalogPage(env(),{...page(),items:[item,{...item}]})).resolves.toMatchObject({ok:false,code:"invalid"});
    await expect(stageOpsInventoryCatalogPage(env(),page())).resolves.toMatchObject({ok:true,status:"staged"});
    await expect(stageOpsInventoryCatalogPage(env(),{...page(),pageIndex:1,
      requestId:"66666666-6666-4666-8666-666666666666"})).resolves.toMatchObject({ok:false,code:"conflict"});
  });

  it("strictly rejects malformed items and bounded-page violations without partial writes",async()=>{
    await provision();
    await expect(stageOpsInventoryCatalogPage(env(),{...page(),items:[{...item,extra:true}]})).resolves.toMatchObject({ok:false,code:"invalid"});
    await expect(stageOpsInventoryCatalogPage(env(),{...page(),items:[{...item,name:"<script>"}]})).resolves.toMatchObject({ok:false,code:"invalid"});
    await expect(stageOpsInventoryCatalogPage(env(),{...page(),nextCursor:"not+a+base64url"})).resolves.toMatchObject({ok:false,code:"invalid"});
    expect(await count("ops_inventory_catalog_staging_pages")).toBe(0);
    expect(await count("ops_inventory_catalog_staging_items")).toBe(0);
  });

  it("keeps staged rows invisible to the existing live catalog tables",async()=>{
    await provision();await stageOpsInventoryCatalogPage(env(),page());
    expect(await count("pa_service_catalog_items")).toBe(0);
    const staged=await db.prepare("SELECT item_json FROM ops_inventory_catalog_staging_items").first<{item_json:string}>();
    expect(JSON.parse(staged!.item_json)).toMatchObject({publicId:item.publicId,name:item.name});
  });
});
