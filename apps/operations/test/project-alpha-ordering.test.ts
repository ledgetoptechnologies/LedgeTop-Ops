import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { applyProjectionEvent, completeEvent } from "../../ops-sync/src/projection";
import type { Env as OpsSyncEnv, ProjectionEvent } from "../../ops-sync/src/types";
import { syncProjectAlpha } from "../src/worker/project-alpha";
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

async function migrateOperations(db: D1Database): Promise<void> {
  const directory = resolve(import.meta.dirname, "../migrations");
  for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
    const statements = splitD1MigrationStatements(await readFile(resolve(directory, name), "utf8"));
    if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
  }
}

const collections=["users","business_units","worker_business_units","clients","organizations","projects","project_assignments","service_locations","application_entitlements","operations","operation_assignments","tasks","task_assignments","calendar_events"];

afterEach(()=>vi.unstubAllGlobals());

describe("Project Alpha snapshot/webhook ordering",()=>{
  it("repairs a retired PA identity by the active entitled email after snapshots stabilize",async()=>{
    const miniflare=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB","DELIVERY_DB"]});
    try{
      const ops=await miniflare.getD1Database("OPS_DB") as D1Database;
      const delivery=await miniflare.getD1Database("DELIVERY_DB") as D1Database;
      await migrateOperations(ops);
      for(const statement of [
        "CREATE TABLE client_accounts(id TEXT PRIMARY KEY,status TEXT NOT NULL,display_name TEXT,project_alpha_client_id TEXT,project_alpha_organization_id TEXT,updated_at TEXT)",
        "CREATE TABLE projects(id TEXT PRIMARY KEY,project_alpha_project_id TEXT,project_name TEXT,client_name TEXT,status TEXT,summary TEXT,source_updated_at TEXT,active INTEGER NOT NULL,updated_at TEXT)",
        "CREATE TABLE client_project_grants(account_id TEXT,project_id TEXT,can_request_service INTEGER NOT NULL,revoked_at TEXT,PRIMARY KEY(account_id,project_id))",
        "CREATE TABLE client_folder_associations(id TEXT PRIMARY KEY,scope_type TEXT,account_id TEXT,project_id TEXT,revoked_at TEXT)",
        "CREATE TABLE client_delivery_grants(account_id TEXT,project_id TEXT,revoked_at TEXT,PRIMARY KEY(account_id,project_id))",
        "CREATE TABLE client_member_project_grants(account_id TEXT,project_id TEXT,revoked_at TEXT,PRIMARY KEY(account_id,project_id))",
      ])await delivery.prepare(statement).run();
      await ops.prepare("INSERT INTO staff_users(id,email,display_name,project_alpha_user_id,status,provisioning_source) VALUES('legacy','kstirn@example.com','Kollins','retired-pa-user','inactive','project-alpha')").run();

      vi.stubGlobal("fetch",vi.fn(async()=>Response.json({
        generated_at:"2026-08-13T01:55:16.744842Z",
        ...Object.fromEntries(collections.map((name)=>[name,name==="users"?[{id:"current-pa-user",email:"kstirn@example.com",display_name:"Kollins",active:true,updated_at:"2026-08-13T01:55:16.744842Z"}]:name==="application_entitlements"?[{id:"entitlement-current",user_id:"current-pa-user",application_key:"ltds_ops",enabled:true,role_key:"role-operator",updated_at:"2026-08-13T01:55:16.744842Z"}]:[]])),
        has_more:false,next_page:null,
      })));
      await syncProjectAlpha({OPS_DB:ops,DELIVERY_DB:delivery,PROJECT_ALPHA_BASE_URL:"https://pa.example.test",PROJECT_ALPHA_API_KEY:"read-only",APPLICATION_KEY:"ltds_ops"} as Env);

      expect(await ops.prepare("SELECT project_alpha_user_id FROM staff_users WHERE id='legacy'").first("project_alpha_user_id")).toBe("current-pa-user");
      expect(await ops.prepare("SELECT status FROM staff_users WHERE id='legacy'").first("status")).toBe("active");
    }finally{await miniflare.dispose();}
  },30_000);

  it("preserves a newer webhook projection when an older snapshot runs afterward",async()=>{
    const miniflare=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB","DELIVERY_DB"]});
    try{
      const ops=await miniflare.getD1Database("OPS_DB") as D1Database;
      const delivery=await miniflare.getD1Database("DELIVERY_DB") as D1Database;
      await migrateOperations(ops);
      for(const statement of [
        "CREATE TABLE client_accounts(id TEXT PRIMARY KEY,status TEXT NOT NULL,display_name TEXT,project_alpha_client_id TEXT,project_alpha_organization_id TEXT,updated_at TEXT)",
        "CREATE TABLE projects(id TEXT PRIMARY KEY,project_alpha_project_id TEXT,project_name TEXT,client_name TEXT,status TEXT,summary TEXT,source_updated_at TEXT,active INTEGER NOT NULL,updated_at TEXT)",
        "CREATE TABLE client_project_grants(account_id TEXT,project_id TEXT,can_request_service INTEGER NOT NULL,revoked_at TEXT,PRIMARY KEY(account_id,project_id))",
        "CREATE TABLE client_folder_associations(id TEXT PRIMARY KEY,scope_type TEXT,account_id TEXT,project_id TEXT,revoked_at TEXT)",
        "CREATE TABLE client_delivery_grants(account_id TEXT,project_id TEXT,revoked_at TEXT,PRIMARY KEY(account_id,project_id))",
        "CREATE TABLE client_member_project_grants(account_id TEXT,project_id TEXT,revoked_at TEXT,PRIMARY KEY(account_id,project_id))",
      ])await delivery.prepare(statement).run();

      await ops.prepare(`INSERT INTO pa_clients(id,name,organization_id,active,payload_json,last_sync_id)
        VALUES('10','Current client',NULL,1,'{}','seed')`).run();
      await delivery.batch([
        delivery.prepare("INSERT INTO client_accounts(id,status,display_name,project_alpha_client_id,project_alpha_organization_id,updated_at) VALUES('account-10','active','Current client','10',NULL,datetime('now'))"),
        delivery.prepare("INSERT INTO projects(id,project_alpha_project_id,project_name,client_name,status,summary,source_updated_at,active,updated_at) VALUES('portal-50','50','Seed project','Current client','active',NULL,NULL,1,datetime('now'))"),
        delivery.prepare("INSERT INTO client_project_grants(account_id,project_id,can_request_service,revoked_at) VALUES('account-10','portal-50',1,NULL)"),
        delivery.prepare("INSERT INTO client_folder_associations(id,scope_type,account_id,project_id,revoked_at) VALUES('folder-50','project','account-10','portal-50',NULL)"),
        delivery.prepare("INSERT INTO client_delivery_grants(account_id,project_id,revoked_at) VALUES('account-10','portal-50',NULL)"),
        delivery.prepare("INSERT INTO client_member_project_grants(account_id,project_id,revoked_at) VALUES('account-10','portal-50',NULL)"),
      ]);

      const newer:ProjectionEvent={event_id:"74ec3f15-eedd-467a-a8cc-ccbed9065d9b",event_type:"projection.changed",occurred_at:"2026-08-02T12:01:00.000000Z",schema_version:1,application_key:"ltds_ops",projection:{entity_type:"project",entity_id:"50",action:"upsert",source_updated_at:"2026-08-02T12:00:00.000000Z",data:{id:50,name:"New webhook name",client_id:10,business_unit_id:30}}};
      const webhookEnv={OPS_DB:ops,DELIVERY_DB:delivery} as OpsSyncEnv;
      await applyProjectionEvent(webhookEnv,newer,"newer-before-snapshot");
      await completeEvent(webhookEnv,newer);

      let snapshotGeneratedAt="2026-08-01T12:00:00.000Z";
      let snapshotProjects:unknown[]=[{id:50,name:"Old snapshot name",client_id:10,updated_at:"2026-08-01T11:59:00.000Z"}];
      vi.stubGlobal("fetch",vi.fn(async()=>Response.json({
        generated_at:snapshotGeneratedAt,
        ...Object.fromEntries(collections.map((name)=>[name,name==="clients"?[{id:10,name:"Current client",active:true,updated_at:snapshotGeneratedAt}]:name==="projects"?snapshotProjects:[]])),
        has_more:false,next_page:null,
      })));
      const snapshotEnv={OPS_DB:ops,DELIVERY_DB:delivery,PROJECT_ALPHA_BASE_URL:"https://pa.example.test",PROJECT_ALPHA_API_KEY:"read-only",APPLICATION_KEY:"ltds_ops"} as Env;
      await syncProjectAlpha(snapshotEnv);

      expect(await ops.prepare("SELECT name FROM pa_projects WHERE id='50'").first("name")).toBe("New webhook name");
      expect(await ops.prepare("SELECT source_updated_at FROM pa_projection_entity_versions WHERE entity_type='project' AND entity_id='50'").first("source_updated_at")).toBe(newer.projection.source_updated_at);
      expect(await delivery.prepare("SELECT project_name FROM projects WHERE id='portal-50'").first("project_name")).toBe("New webhook name");
      expect(await delivery.prepare("SELECT active FROM projects WHERE id='portal-50'").first("active")).toBe(1);
      expect(await delivery.prepare("SELECT status FROM client_accounts WHERE id='account-10'").first("status")).toBe("active");
      for(const table of ["client_project_grants","client_folder_associations","client_delivery_grants","client_member_project_grants"]){
        expect(await delivery.prepare(`SELECT revoked_at FROM ${table} WHERE project_id='portal-50'`).first("revoked_at")).toBeNull();
      }

      // Once a stable snapshot is newer than the webhook and omits the project,
      // the same authoritative state path must deactivate it and revoke access.
      snapshotGeneratedAt="2026-08-03T12:00:00.000Z";
      snapshotProjects=[];
      await syncProjectAlpha(snapshotEnv);
      expect(await ops.prepare("SELECT active FROM pa_projects WHERE id='50'").first("active")).toBe(0);
      expect(await delivery.prepare("SELECT active FROM projects WHERE id='portal-50'").first("active")).toBe(0);
      for(const table of ["client_project_grants","client_folder_associations","client_delivery_grants","client_member_project_grants"]){
        expect(await delivery.prepare(`SELECT revoked_at FROM ${table} WHERE project_id='portal-50'`).first("revoked_at")).not.toBeNull();
      }
    }finally{await miniflare.dispose();}
  },30_000);
});
