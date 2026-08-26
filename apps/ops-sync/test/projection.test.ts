import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";
import { applyEntitlementEvent, applyEntitlementEventForSource, applyProjectionEvent, applyProjectionEventForSource, completeEvent, recordAccessFailure, recordEventFailure } from "../src/projection";
import { createProjectAlphaSourceContext, prepareProjectAlphaSourceRecords, PRIMARY_PROJECT_ALPHA_SOURCE } from "../../operations/src/worker/project-alpha-source";
import { desiredAccessEmails } from "../src/access-group";
import { handleRequest } from "../src/index";
import type { EntitlementEvent, Env, ProjectionEvent } from "../src/types";
import { deliveryProjectionFixture, secondaryDeliverySnapshot } from "../../operations/test/helpers/delivery-projection-fixture";

let miniflare: Miniflare;
let db: D1Database;

function event(overrides: Partial<EntitlementEvent> = {}): EntitlementEvent {
  return {
    event_id:"6e36dfce-6349-4681-9601-9a4bbd830d18",
    event_type:"application_entitlement.changed",
    occurred_at:"2026-07-17T20:00:00.000000Z",
    schema_version:1,
    user:{id:"42",email:"pilot@example.com",display_name:"Test Pilot",active:true},
    entitlement:{application_key:"ltds_ops",enabled:true,role_key:"role-operator",business_unit_ids:["30"]},
    ...overrides,
  };
}

function env(deliveryDb?: D1Database): Env { return {OPS_DB:db,DELIVERY_DB:deliveryDb} as Env; }

const secondary=createProjectAlphaSourceContext("project-alpha:secondary");
function projection(entityType:ProjectionEvent["projection"]["entity_type"],entityId:string,data:Record<string,unknown>,at="2026-08-26T12:00:00Z"):ProjectionEvent {
  return {event_id:crypto.randomUUID(),event_type:"projection.changed",occurred_at:at,schema_version:1,application_key:"ltds_ops",
    projection:{entity_type:entityType,entity_id:entityId,action:"upsert",source_updated_at:at,data}};
}

function portalDatabase(state:{failNext:boolean;writes:Array<{sql:string;values:unknown[]}>;beforeWrite?:()=>Promise<void>}):D1Database {
  const database={
    prepare(sql:string){
      const statement={sql,values:[] as unknown[],bind(...values:unknown[]){this.values=values;return this;},async run(){const beforeWrite=state.beforeWrite;state.beforeWrite=undefined;await beforeWrite?.();if(state.failNext){state.failNext=false;throw new Error("delivery-unavailable");}state.writes.push({sql:this.sql,values:this.values});return{meta:{changes:1}};}};
      return statement;
    },
    async batch(statements:Array<{sql:string;values:unknown[]}>){const beforeWrite=state.beforeWrite;state.beforeWrite=undefined;await beforeWrite?.();if(state.failNext){state.failNext=false;throw new Error("delivery-unavailable");}state.writes.push(...statements.map(statement=>({sql:statement.sql,values:statement.values})));return statements.map(()=>({meta:{changes:1}}));},
  };
  return database as unknown as D1Database;
}

describe("entitlement projection",()=>{
  beforeEach(async()=>{
    miniflare=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});
    db=await miniflare.getD1Database("OPS_DB") as D1Database;
    const migrationsPath=resolve(import.meta.dirname,"../../operations/migrations");
    for(const migration of (await readdir(migrationsPath)).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&name.slice(0,4)<="0035").sort()){
      const sql=await readFile(resolve(migrationsPath,migration),"utf8");
      const statements=unstable_splitSqlQuery(sql.replace(/\r\n/g,"\n")).map(part=>part.trim()).filter(part=>part&&!/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?$/i.test(part));
      if(statements.length)await db.batch(statements.map(statement=>db.prepare(statement)));
    }
    await db.prepare("INSERT INTO divisions (id,name,code,project_alpha_business_unit_id) VALUES ('division-pa-30','PA 30','pa-30','30')").run();
  });
  afterEach(async()=>{vi.unstubAllGlobals();await miniflare.dispose();});

  it("grants, retries a pending event, completes idempotently, and revokes",async()=>{
    const grant=event();
    await expect(applyEntitlementEvent(env(),grant,"hash-a")).resolves.toBe("applied");
    expect(await db.prepare("SELECT status FROM staff_users WHERE project_alpha_user_id='42'").first("status")).toBe("active");
    expect(await db.prepare("SELECT role_id FROM staff_role_assignments WHERE staff_id='staff-pa-42'").first("role_id")).toBe("role-operator");
    expect(await db.prepare("SELECT scope FROM staff_role_assignments WHERE staff_id='staff-pa-42'").first("scope")).toBe("assigned");
    expect(await db.prepare("SELECT count(*) AS total FROM staff_divisions WHERE staff_id='staff-pa-42'").first("total")).toBe(0);
    await expect(applyEntitlementEvent(env(),grant,"hash-a")).resolves.toBe("applied");
    await completeEvent(env(),grant);
    await expect(applyEntitlementEvent(env(),grant,"hash-a")).resolves.toBe("duplicate");

    const revoke=event({event_id:"959204fb-5ac3-4d18-8798-7759bd56cbe9",event_type:"application_entitlement.revoked",occurred_at:"2026-07-17T20:01:00.000000Z"});
    await expect(applyEntitlementEvent(env(),revoke,"hash-b")).resolves.toBe("applied");
    expect(await db.prepare("SELECT status FROM staff_users WHERE project_alpha_user_id='42'").first("status")).toBe("inactive");
    expect(await db.prepare("SELECT count(*) AS total FROM staff_role_assignments WHERE staff_id='staff-pa-42'").first("total")).toBe(0);
  });

  it("preserves a per-event Access failure when projection completion is acknowledged",async()=>{
    const grant=event();
    await applyEntitlementEvent(env(),grant,"access-pending");
    await recordAccessFailure(env(),grant.event_id,"access-group-update-503");
    await completeEvent(env(),grant,true);
    expect(await db.prepare("SELECT status FROM integration_event_receipts WHERE event_id=?").bind(grant.event_id).first("status")).toBe("completed");
    expect(await db.prepare("SELECT last_error FROM integration_event_receipts WHERE event_id=?").bind(grant.event_id).first("last_error")).toBe("access-group-update-503");
  });

  it("maps PA administrators to immutable global admin access",async()=>{
    const admin=event({entitlement:{application_key:"ltds_ops",enabled:true,role_key:"role-admin",business_unit_ids:["30"]}});
    await expect(applyEntitlementEvent(env(),admin,"admin-hash")).resolves.toBe("applied");
    expect(await db.prepare("SELECT immutable FROM roles WHERE id='role-admin'").first("immutable")).toBe(1);
    expect(await db.prepare("SELECT role_id FROM staff_role_assignments WHERE staff_id='staff-pa-42'").first("role_id")).toBe("role-admin");
    expect(await db.prepare("SELECT scope FROM staff_role_assignments WHERE staff_id='staff-pa-42'").first("scope")).toBe("global");
    expect(await db.prepare("SELECT count(*) AS total FROM staff_divisions WHERE staff_id='staff-pa-42'").first("total")).toBe(0);
  });

  it("reduces non-admin PA entitlement labels to assigned-only operator access",async()=>{
    const legacy=event({entitlement:{application_key:"ltds_ops",enabled:true,role_key:"role-division-manager",business_unit_ids:["30"]}});
    await expect(applyEntitlementEvent(env(),legacy,"legacy-hash")).resolves.toBe("applied");
    const assignment=await db.prepare("SELECT role_id,scope,division_id FROM staff_role_assignments WHERE staff_id='staff-pa-42'").first<{role_id:string;scope:string;division_id:string|null}>();
    expect(assignment).toBeTruthy();
    expect(assignment!.role_id).toBe("role-operator");
    expect(assignment!.scope).toBe("assigned");
    expect(await db.prepare("SELECT role_key FROM pa_application_entitlements WHERE user_id='42'").first("role_key")).toBe("role-division-manager");
    const divisions=await db.prepare("SELECT count(*) AS total FROM staff_divisions WHERE staff_id='staff-pa-42'").first<{total:number}>();
    expect(divisions!.total).toBe(0);
  });

  it("ignores older events and never changes the protected Owner",async()=>{
    const ownerBefore=await db.prepare("SELECT status,sync_protected FROM staff_users WHERE id='staff-beau-koltz'").first<{status:string;sync_protected:number}>();
    const ownerEvent=event({user:{id:"1",email:"beaukoltz@ledgetopdroneservices.com",display_name:"Changed Name",active:false},entitlement:{application_key:"ltds_ops",enabled:false,role_key:"role-operator",business_unit_ids:[]}});
    await applyEntitlementEvent(env(),ownerEvent,"owner-hash");
    expect(await db.prepare("SELECT status,sync_protected FROM staff_users WHERE id='staff-beau-koltz'").first()).toEqual(ownerBefore);
    expect(await db.prepare("SELECT role_id FROM staff_role_assignments WHERE staff_id='staff-beau-koltz'").first("role_id")).toBe("role-owner");

    const newer=event({event_id:"92d580e2-4865-4f83-8a76-a011c510dcf1",occurred_at:"2026-07-17T21:00:00.000000Z"});
    await applyEntitlementEvent(env(),newer,"newer");
    const older=event({event_id:"bcb7fb95-73d9-421b-8bc8-96190fafcd7e",occurred_at:"2026-07-17T20:59:59.000000Z",entitlement:{application_key:"ltds_ops",enabled:false,role_key:"role-operator",business_unit_ids:[]}});
    await expect(applyEntitlementEvent(env(),older,"older")).resolves.toBe("ignored");
    expect(await db.prepare("SELECT enabled FROM pa_application_entitlements WHERE user_id='42'").first("enabled")).toBe(1);
  });

  it("updates email in place and prevents a pending older retry from rolling state back",async()=>{
    const first=event();
    await applyEntitlementEvent(env(),first,"first");
    const changed=event({event_id:"b43f5552-acde-4d8d-93a1-f09be56a91ec",occurred_at:"2026-07-17T20:02:00.000000Z",user:{id:"42",email:"new-pilot@example.com",display_name:"Renamed Pilot",active:true}});
    await applyEntitlementEvent(env(),changed,"changed");
    expect(await db.prepare("SELECT email FROM staff_users WHERE project_alpha_user_id='42'").first("email")).toBe("new-pilot@example.com");
    await expect(applyEntitlementEvent(env(),first,"first")).resolves.toBe("ignored");
    expect(await db.prepare("SELECT email FROM staff_users WHERE project_alpha_user_id='42'").first("email")).toBe("new-pilot@example.com");
  });

  it("accepts the task-assignment fingerprint added by migration 0008",async()=>{
    await expect(db.prepare("INSERT INTO pa_projection_fingerprints (collection,fingerprint,last_sync_id) VALUES ('task_assignments','abc','sync-1')").run()).resolves.toBeTruthy();
    expect(await db.prepare("SELECT collection FROM pa_projection_fingerprints WHERE collection='task_assignments'").first("collection")).toBe("task_assignments");
  });

  it("projects business units and derives task calendar changes incrementally",async()=>{
    const businessUnit:ProjectionEvent={event_id:"a0928e33-f38b-4a7c-88df-b601bb6d719e",event_type:"projection.changed",occurred_at:"2026-07-22T05:00:00.000000Z",schema_version:1,application_key:"ltds_ops",projection:{entity_type:"business_unit",entity_id:"30",action:"upsert",source_updated_at:"2026-07-22T05:00:00.000000Z",data:{id:30,name:"Green Bay",code:"green-bay",is_active:true}}};
    await expect(applyProjectionEvent(env(),businessUnit,"unit-hash")).resolves.toBe("applied");
    expect(await db.prepare("SELECT name FROM divisions WHERE project_alpha_business_unit_id='30'").first("name")).toBe("Green Bay");

    const task:ProjectionEvent={event_id:"ff2b7f4d-09a5-44e0-83cb-0423d41021d1",event_type:"projection.changed",occurred_at:"2026-07-22T05:01:00.000000Z",schema_version:1,application_key:"ltds_ops",projection:{entity_type:"task",entity_id:"110",action:"upsert",source_updated_at:"2026-07-22T05:01:00.000000Z",data:{id:110,project_id:40,business_unit_id:30,title:"Map site",status:"todo",due_at:"2026-07-23T18:00:00.000000Z"}}};
    await expect(applyProjectionEvent(env(),task,"task-hash")).resolves.toBe("applied");
    expect(await db.prepare("SELECT title FROM pa_calendar_events WHERE id='task:110' AND active=1").first("title")).toBe("Map site");

    const unscheduled:ProjectionEvent={...task,event_id:"d2266134-bd9a-47d9-aee2-46f771078e86",occurred_at:"2026-07-22T05:02:00.000000Z",projection:{...task.projection,source_updated_at:"2026-07-22T05:02:00.000000Z",data:{...task.projection.data,due_at:null}}};
    await expect(applyProjectionEvent(env(),unscheduled,"task-unscheduled-hash")).resolves.toBe("applied");
    expect(await db.prepare("SELECT active FROM pa_calendar_events WHERE id='task:110'").first("active")).toBe(0);
  });

  it("accepts client and organization projections and retries portal propagation before advancing the source version",async()=>{
    const state={failNext:true,writes:[] as Array<{sql:string;values:unknown[]}>};
    const delivery=portalDatabase(state);
    const client:ProjectionEvent={event_id:"0ab5f730-ce6a-4b0e-b0fe-e6ba9930936c",event_type:"projection.changed",occurred_at:"2026-08-01T14:00:00.000000Z",schema_version:1,application_key:"ltds_ops",projection:{entity_type:"client",entity_id:"70",action:"upsert",source_updated_at:"2026-08-01T13:59:00.000000Z",data:{id:70,name:"Portal Client",organization_id:80}}};
    await expect(applyProjectionEvent(env(delivery),client,"client-hash")).rejects.toThrow("delivery-unavailable");
    expect(await db.prepare("SELECT source_updated_at FROM pa_projection_entity_versions WHERE entity_type='client' AND entity_id='70'").first()).toBeNull();
    await expect(applyProjectionEvent(env(delivery),client,"client-hash")).resolves.toBe("applied");
    expect(await db.prepare("SELECT name FROM pa_clients WHERE id='70'").first("name")).toBe("Portal Client");
    expect(await db.prepare("SELECT source_updated_at FROM pa_projection_entity_versions WHERE entity_type='client' AND entity_id='70'").first("source_updated_at")).toBe(client.projection.source_updated_at);
    expect(state.writes.some(write=>write.sql.includes("client_accounts")&&write.values.includes("70"))).toBe(true);
    expect(state.writes.some(write=>write.sql.includes("ELSE 'active'"))).toBe(true);
    const portalWriteCount=state.writes.length;
    await expect(applyProjectionEvent(env(delivery),client,"client-hash")).resolves.toBe("applied");
    expect(state.writes).toHaveLength(portalWriteCount);
    await completeEvent(env(),client);
    await expect(applyProjectionEvent(env(delivery),client,"client-hash")).resolves.toBe("duplicate");

    const organization:ProjectionEvent={event_id:"3cd9380b-1b91-4622-873e-0e440dd97a6b",event_type:"projection.changed",occurred_at:"2026-08-01T14:01:00.000000Z",schema_version:1,application_key:"ltds_ops",projection:{entity_type:"organization",entity_id:"80",action:"revoke",source_updated_at:"2026-08-01T14:01:00.000000Z",data:{id:80,name:"Portal Organization"}}};
    await expect(applyProjectionEvent(env(delivery),organization,"organization-hash")).resolves.toBe("applied");
    expect(await db.prepare("SELECT active FROM pa_organizations WHERE id='80'").first("active")).toBe(0);
  });

  it("fails closed when a portal projection is missing DELIVERY_DB",async()=>{
    const client:ProjectionEvent={event_id:"4f19dfc1-4f73-46de-b364-da1b7c10fdc2",event_type:"projection.changed",occurred_at:"2026-08-01T14:02:00.000000Z",schema_version:1,application_key:"ltds_ops",projection:{entity_type:"client",entity_id:"72",action:"revoke",source_updated_at:"2026-08-01T14:02:00.000000Z",data:{id:72,name:"Revoked Client"}}};
    await expect(applyProjectionEvent(env(),client,"missing-delivery-hash")).rejects.toThrow("delivery-db-binding-required");
    expect(await db.prepare("SELECT source_updated_at FROM pa_projection_entity_versions WHERE entity_type='client' AND entity_id='72'").first()).toBeNull();
    expect(await db.prepare("SELECT status FROM integration_event_receipts WHERE event_id=?").bind(client.event_id).first("status")).toBe("pending");
    expect(await db.prepare("SELECT owner_event_id FROM pa_projection_entity_leases WHERE entity_type='client' AND entity_id='72'").first()).toBeNull();

    const state={failNext:false,writes:[] as Array<{sql:string;values:unknown[]}>};
    await expect(applyProjectionEvent(env(portalDatabase(state)),client,"missing-delivery-hash")).resolves.toBe("applied");
    expect(await db.prepare("SELECT source_updated_at FROM pa_projection_entity_versions WHERE entity_type='client' AND entity_id='72'").first("source_updated_at")).toBe(client.projection.source_updated_at);
    expect(state.writes.some(write=>write.sql.includes("client_accounts")&&write.values.includes(0)&&write.values.includes("72"))).toBe(true);
  });

  it("ignores an out-of-order incremental projection for the same entity",async()=>{
    const delivery=portalDatabase({failNext:false,writes:[]});
    const newer:ProjectionEvent={event_id:"2fab1100-9992-4fd1-b013-26b330a9db34",event_type:"projection.changed",occurred_at:"2026-07-22T05:03:00.000000Z",schema_version:1,application_key:"ltds_ops",projection:{entity_type:"project",entity_id:"40",action:"upsert",source_updated_at:"2026-07-22T05:03:00.000000Z",data:{id:40,name:"New name",business_unit_id:30,manager_user_id:42}}};
    const older:ProjectionEvent={...newer,event_id:"dcf7d00b-f313-45a7-815e-3cb97fe60fd0",occurred_at:"2026-07-22T05:02:00.000000Z",projection:{...newer.projection,source_updated_at:"2026-07-22T05:02:00.000000Z",data:{id:40,name:"Old name",business_unit_id:30}}};
    await expect(applyProjectionEvent(env(delivery),newer,"newer-project-hash")).resolves.toBe("applied");
    await expect(applyProjectionEvent(env(delivery),older,"older-project-hash")).resolves.toBe("ignored");
    expect(await db.prepare("SELECT name FROM pa_projects WHERE id='40'").first("name")).toBe("New name");
    expect(await db.prepare("SELECT manager_user_id FROM pa_projects WHERE id='40'").first("manager_user_id")).toBe("42");
  });

  it("serializes concurrent projection versions for one entity",async()=>{
    let signalPortalWrite!:()=>void;
    let releasePortalWrite!:()=>void;
    const portalWriteStarted=new Promise<void>(resolve=>{signalPortalWrite=resolve;});
    const portalWriteRelease=new Promise<void>(resolve=>{releasePortalWrite=resolve;});
    const state={
      failNext:false,
      writes:[] as Array<{sql:string;values:unknown[]}>,
      beforeWrite:async()=>{signalPortalWrite();await portalWriteRelease;},
    };
    const delivery=portalDatabase(state);
    const older:ProjectionEvent={event_id:"7e248a60-b2e1-44c2-995e-b2d3a2043503",event_type:"projection.changed",occurred_at:"2026-08-01T15:00:00.000000Z",schema_version:1,application_key:"ltds_ops",projection:{entity_type:"client",entity_id:"71",action:"upsert",source_updated_at:"2026-08-01T15:00:00.000000Z",data:{id:71,name:"Older Client"}}};
    const newer:ProjectionEvent={...older,event_id:"c3b37b91-717d-408d-a04a-53f6567cff7c",occurred_at:"2026-08-01T15:01:00.000000Z",projection:{...older.projection,source_updated_at:"2026-08-01T15:01:00.000000Z",data:{id:71,name:"Newer Client"}}};
    const olderRun=applyProjectionEvent(env(delivery),older,"older-client-hash");
    await portalWriteStarted;
    try {
      await expect(applyProjectionEvent(env(delivery),newer,"newer-client-hash")).rejects.toThrow("projection-global-busy");
    } finally {
      releasePortalWrite();
      await olderRun;
    }
    await expect(applyProjectionEvent(env(delivery),newer,"newer-client-hash")).resolves.toBe("applied");
    expect(await db.prepare("SELECT name FROM pa_clients WHERE id='71'").first("name")).toBe("Newer Client");
    expect(await db.prepare("SELECT event_id FROM pa_projection_entity_versions WHERE entity_type='client' AND entity_id='71'").first("event_id")).toBe(newer.event_id);
  });

  it("revokes stale portal project and folder grants after PA remap or deactivation",async()=>{
    await db.batch([
      db.prepare("INSERT INTO pa_clients(id,name,active,payload_json,last_sync_id) VALUES ('70','Prior client',1,'{}','seed'),('71','Current client',1,'{}','seed')"),
      db.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id) VALUES ('80','Prior organization',1,'{}','seed'),('81','Current organization',1,'{}','seed')"),
    ]);
    const state={failNext:false,writes:[] as Array<{sql:string;values:unknown[]}>};
    const delivery=portalDatabase(state);
    const remap:ProjectionEvent={event_id:"6d929e7a-1cc5-478c-8f83-0defe0db52e8",event_type:"projection.changed",occurred_at:"2026-08-01T16:00:00.000000Z",schema_version:1,application_key:"ltds_ops",projection:{entity_type:"project",entity_id:"50",action:"upsert",source_updated_at:"2026-08-01T16:00:00.000000Z",data:{id:50,name:"Remapped project",client_id:71,organization_id:81}}};
    await expect(applyProjectionEvent(env(delivery),remap,"remap-hash")).resolves.toBe("applied");
    const folderRevoke=state.writes.find(write=>write.sql.includes("UPDATE client_folder_associations SET revoked_at")&&write.values.includes("50"));
    const projectRevoke=state.writes.find(write=>write.sql.includes("UPDATE client_project_grants SET revoked_at")&&write.values.includes("50"));
    expect(folderRevoke?.values).toEqual(expect.arrayContaining(["50",1,"71","81"]));
    expect(projectRevoke?.values).toEqual(expect.arrayContaining(["50",1,"71","81"]));

    const revoke:ProjectionEvent={...remap,event_id:"2dd75fa6-7e84-4b6d-82b0-5f5ef2b28b63",occurred_at:"2026-08-01T16:01:00.000000Z",projection:{...remap.projection,action:"revoke",source_updated_at:"2026-08-01T16:01:00.000000Z"}};
    await expect(applyProjectionEvent(env(delivery),revoke,"revoke-hash")).resolves.toBe("applied");
    const inactiveRevoke=state.writes.filter(write=>write.sql.includes("UPDATE client_project_grants SET revoked_at")&&write.values.includes("50")).at(-1);
    expect(inactiveRevoke?.values).toEqual(expect.arrayContaining(["50",0]));
    expect(state.writes.some(write=>write.sql.includes("UPDATE projects SET project_name")&&write.values.includes(0)&&write.values.includes("50"))).toBe(true);
  });

  it("removes cross-client access in a real Delivery D1 after a PA project remap",async()=>{
    const deliveryMiniflare=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:["DELIVERY_DB"]});
    try{
      const delivery=await deliveryMiniflare.getD1Database("DELIVERY_DB") as D1Database;
      for(const statement of [
        "CREATE TABLE client_accounts(id TEXT PRIMARY KEY,status TEXT NOT NULL,project_alpha_client_id TEXT,project_alpha_organization_id TEXT,project_alpha_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary')",
        "CREATE TABLE projects(id TEXT PRIMARY KEY,project_alpha_project_id TEXT,project_name TEXT,status TEXT,summary TEXT,source_updated_at TEXT,active INTEGER NOT NULL,updated_at TEXT,project_alpha_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary')",
        "CREATE TABLE client_project_grants(account_id TEXT,project_id TEXT,can_request_service INTEGER NOT NULL,revoked_at TEXT,PRIMARY KEY(account_id,project_id))",
        "CREATE TABLE client_folder_associations(id TEXT PRIMARY KEY,scope_type TEXT,account_id TEXT,project_id TEXT,revoked_at TEXT)",
        "CREATE TABLE client_delivery_grants(account_id TEXT,project_id TEXT,revoked_at TEXT,PRIMARY KEY(account_id,project_id))",
        "CREATE TABLE client_member_project_grants(account_id TEXT,project_id TEXT,revoked_at TEXT,PRIMARY KEY(account_id,project_id))",
      ])await delivery.prepare(statement).run();
      await db.batch([
        db.prepare("INSERT INTO pa_clients(id,name,active,payload_json,last_sync_id) VALUES ('70','Prior client',1,'{}','seed'),('71','Current client',1,'{}','seed')"),
        db.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id) VALUES ('80','Prior organization',1,'{}','seed'),('81','Current organization',1,'{}','seed')"),
      ]);
      await delivery.batch([
        delivery.prepare("INSERT INTO client_accounts(id,status,project_alpha_client_id,project_alpha_organization_id) VALUES ('account-old','active','70','80')"),
        delivery.prepare("INSERT INTO projects(id,project_alpha_project_id,project_name,status,summary,source_updated_at,active,updated_at) VALUES ('portal-pa-50','50','Project','active',NULL,NULL,1,NULL)"),
        delivery.prepare("INSERT INTO client_project_grants VALUES ('account-old','portal-pa-50',1,NULL)"),
        delivery.prepare("INSERT INTO client_folder_associations VALUES ('folder-old','project','account-old','portal-pa-50',NULL)"),
      ]);
      const remap:ProjectionEvent={event_id:"05bdf255-32ce-45d7-b7f1-ebfd6c465120",event_type:"projection.changed",occurred_at:"2026-08-01T16:30:00.000000Z",schema_version:1,application_key:"ltds_ops",projection:{entity_type:"project",entity_id:"50",action:"upsert",source_updated_at:"2026-08-01T16:30:00.000000Z",data:{id:50,name:"Remapped project",client_id:71,organization_id:81}}};

      await expect(applyProjectionEvent(env(delivery),remap,"real-d1-remap-hash")).resolves.toBe("applied");
      expect(await delivery.prepare("SELECT revoked_at FROM client_project_grants WHERE account_id='account-old'").first("revoked_at")).toBeTruthy();
      expect(await delivery.prepare("SELECT revoked_at FROM client_folder_associations WHERE id='folder-old'").first("revoked_at")).toBeTruthy();
    }finally{await deliveryMiniflare.dispose();}
  });

  it("suspends a revoked client but preserves concrete-client account status on organization revoke",async()=>{
    const state={failNext:false,writes:[] as Array<{sql:string;values:unknown[]}>};
    const delivery=portalDatabase(state);
    const client:ProjectionEvent={event_id:"295036cb-3fe6-4527-991f-ec97dc38f30d",event_type:"projection.changed",occurred_at:"2026-08-01T17:00:00.000000Z",schema_version:1,application_key:"ltds_ops",projection:{entity_type:"client",entity_id:"70",action:"revoke",source_updated_at:"2026-08-01T17:00:00.000000Z",data:{id:70,name:"Revoked client",organization_id:80}}};
    await applyProjectionEvent(env(delivery),client,"client-revoke-hash");
    expect(state.writes.some(write=>write.sql.includes("project_alpha_organization_id")&&write.values.includes(0)&&write.values.includes("70"))).toBe(true);
    expect(state.writes.some(write=>write.sql.includes("scope_type='client'")&&write.sql.includes("status<>'active'"))).toBe(true);

    const organization:ProjectionEvent={event_id:"6da2e532-86b7-4d14-8c14-f741958021d7",event_type:"projection.changed",occurred_at:"2026-08-01T17:01:00.000000Z",schema_version:1,application_key:"ltds_ops",projection:{entity_type:"organization",entity_id:"80",action:"revoke",source_updated_at:"2026-08-01T17:01:00.000000Z",data:{id:80,name:"Revoked organization"}}};
    await applyProjectionEvent(env(delivery),organization,"organization-revoke-hash");
    const organizationStatus=state.writes.find(write=>write.sql.includes("project_alpha_organization_id=? AND project_alpha_client_id IS NULL")&&write.values.includes("80"));
    expect(organizationStatus?.values).toEqual(expect.arrayContaining([0,"80"]));
  });

  it("primary events, revocations and replay leave colliding Delivery ownership untouched", async () => {
    const { runtime, db: delivery } = await deliveryProjectionFixture();
    try {
      const before = await secondaryDeliverySnapshot(delivery);
      await applyProjectionEvent(env(delivery), projection("client", "70", { id: "70", name: "Primary client renamed" }), "client-source");
      expect(await delivery.prepare("SELECT client_name FROM projects WHERE id='local-client-project'").first("client_name")).toBe("Primary client renamed");
      await applyProjectionEvent(env(delivery), projection("organization", "80", { id: "80", name: "Primary organization renamed" }), "organization-source");
      expect(await delivery.prepare("SELECT client_name FROM projects WHERE id='local-org-project'").first("client_name")).toBe("Primary organization renamed");
      await applyProjectionEvent(env(delivery), projection("project", "50", { id: "50", name: "Primary project renamed", client_id: "70", organization_id: "80" }), "project-source");
      expect(await secondaryDeliverySnapshot(delivery)).toEqual(before);
      expect(await delivery.prepare("SELECT project_name FROM projects WHERE id='a-50'").first("project_name")).toBe("Primary project renamed");
      expect(await delivery.prepare("SELECT revoked_at FROM client_folder_associations WHERE id='local-suspended-folder'").first("revoked_at")).toBeTruthy();
      expect(await delivery.prepare("SELECT revoked_at FROM client_folder_associations WHERE id='local-active-folder'").first("revoked_at")).toBeNull();
      const revoked = projection("client", "70", { id: "70", name: "Primary revoked" }, "2026-08-26T13:00:00Z");
      revoked.projection.action = "revoke";
      await applyProjectionEvent(env(delivery), revoked, "revoked-source");
      await completeEvent(env(delivery), revoked);
      expect(await applyProjectionEvent(env(delivery), revoked, "revoked-source")).toBe("duplicate");
      expect(await secondaryDeliverySnapshot(delivery)).toEqual(before);
      expect(await delivery.prepare("SELECT status FROM client_accounts WHERE id='a-client'").first("status")).toBe("suspended");
      expect(await delivery.prepare("SELECT revoked_at FROM client_project_grants WHERE account_id='a-client' AND project_id='a-50'").first("revoked_at")).toBeTruthy();
      expect((await delivery.prepare(`SELECT id,project_alpha_source_id,project_alpha_project_id,active FROM projects
        WHERE id IN ('local-client-project','local-org-project') ORDER BY id`).all()).results).toEqual([
        { id: "local-client-project", project_alpha_source_id: null, project_alpha_project_id: null, active: 1 },
        { id: "local-org-project", project_alpha_source_id: null, project_alpha_project_id: null, active: 1 },
      ]);
      expect(await delivery.prepare("SELECT status FROM client_accounts WHERE id='local-active-client'").first("status")).toBe("active");
      expect(await delivery.prepare("SELECT revoked_at FROM client_folder_associations WHERE id='local-active-folder'").first("revoked_at")).toBeNull();
    } finally { await runtime.dispose(); }
  }, 30_000);

  it("keeps colliding event IDs, versions, receipts, failures and mapped client IDs independent by source",async()=>{
    const deliveryState={failNext:false,writes:[] as Array<{sql:string;values:unknown[]}>};
    const primaryEvent=projection("client","70",{id:70,name:"Primary client",organization_id:80},"2026-08-26T14:00:00Z");
    const secondaryEvent:ProjectionEvent={...primaryEvent,occurred_at:"2026-08-26T10:00:00Z",projection:{...primaryEvent.projection,source_updated_at:"2026-08-26T10:00:00Z",data:{id:70,name:"Secondary client",organization_id:80}}};
    await applyProjectionEvent(env(portalDatabase(deliveryState)),primaryEvent,"primary-hash");
    const portalWrites=deliveryState.writes.length;
    await expect(applyProjectionEventForSource(env(portalDatabase(deliveryState)),secondary,secondaryEvent,"secondary-hash")).resolves.toBe("applied");
    expect(deliveryState.writes).toHaveLength(portalWrites);
    const ids=await prepareProjectAlphaSourceRecords(db,secondary,[{kind:"client",externalId:"70"},{kind:"organization",externalId:"80"}]);
    expect(ids.get("client","70")).not.toBe("70");
    expect(await db.prepare("SELECT name,organization_id,payload_json FROM pa_clients WHERE id=? AND projection_source_id=?").bind(ids.get("client","70"),secondary.sourceId).first()).toEqual({name:"Secondary client",organization_id:ids.get("organization","80"),payload_json:JSON.stringify(secondaryEvent.projection.data)});
    expect(await db.prepare("SELECT name FROM pa_clients WHERE id='70'").first("name")).toBe("Primary client");
    expect(await db.prepare("SELECT count(*) total FROM pa_projection_entity_versions WHERE entity_type='client' AND entity_id='70'").first("total")).toBe(2);
    await recordEventFailure(env(),secondaryEvent.event_id,"secondary-only-failure",secondary);
    expect(await db.prepare("SELECT last_error FROM integration_event_receipts WHERE projection_source_id=? AND event_id=?").bind(PRIMARY_PROJECT_ALPHA_SOURCE.sourceId,primaryEvent.event_id).first("last_error")).toBeNull();
    await completeEvent(env(),secondaryEvent,true,secondary);
    expect(await db.prepare("SELECT status,last_error FROM integration_event_receipts WHERE projection_source_id=? AND event_id=?").bind(secondary.sourceId,secondaryEvent.event_id).first()).toEqual({status:"completed",last_error:"secondary-only-failure"});
    expect(await db.prepare("SELECT status FROM integration_event_receipts WHERE projection_source_id=? AND event_id=?").bind(PRIMARY_PROJECT_ALPHA_SOURCE.sourceId,primaryEvent.event_id).first("status")).toBe("pending");
    expect(await db.prepare("SELECT last_event_at FROM integration_reconciliation WHERE projection_source_id=? AND integration='project-alpha'").bind(secondary.sourceId).first("last_event_at")).toBe(secondaryEvent.occurred_at);
    expect(await db.prepare("SELECT last_event_at FROM integration_reconciliation WHERE projection_source_id=? AND integration='project-alpha'").bind(PRIMARY_PROJECT_ALPHA_SOURCE.sourceId).first("last_event_at")).toBeNull();
    await expect(applyProjectionEventForSource(env(),secondary,secondaryEvent,"secondary-hash")).resolves.toBe("duplicate");
    await expect(applyProjectionEventForSource(env(),secondary,secondaryEvent,"primary-hash")).rejects.toThrow("event-id-conflict");
  });

  it("maps every relational reference and synthesized calendar identity without changing payload JSON",async()=>{
    const rows:ProjectionEvent[]=[
      projection("business_unit","30",{name:"Secondary branch",code:"green-bay"}),
      projection("project","40",{name:"Secondary project",client_id:70,organization_id:80,business_unit_id:30,manager_user_id:42}),
      projection("project_assignment","90",{project_id:40,user_id:42}),
      projection("operation","100",{project_id:40,business_unit_id:30,title:"Flight",created_by:42,scheduled_start_at:"2026-08-27T12:00:00Z"}),
      projection("operation_assignment","100:42",{operation_id:100,user_id:42,assigned_by:43}),
      projection("task","110",{project_id:40,operation_id:100,business_unit_id:30,assignee_user_id:42,created_by:43,title:"Map site",due_at:"2026-08-28T12:00:00Z"}),
      projection("task_assignment","110:42",{task_id:110,user_id:42,assigned_by:43}),
    ];
    for(const row of rows)await applyProjectionEventForSource(env(),secondary,row,`hash-${row.event_id}`);
    const ids=await prepareProjectAlphaSourceRecords(db,secondary,[{kind:"project",externalId:"40"},{kind:"client",externalId:"70"},{kind:"organization",externalId:"80"},{kind:"business_unit",externalId:"30"},{kind:"user",externalId:"42"},{kind:"user",externalId:"43"},{kind:"operation",externalId:"100"},{kind:"task",externalId:"110"},{kind:"calendar_event",externalId:"operation:100"},{kind:"calendar_event",externalId:"task:110"}]);
    const project=await db.prepare("SELECT client_id,organization_id,business_unit_id,manager_user_id,payload_json FROM pa_projects WHERE id=?").bind(ids.get("project","40")).first();
    expect(project).toEqual({client_id:ids.get("client","70"),organization_id:ids.get("organization","80"),business_unit_id:ids.get("business_unit","30"),manager_user_id:ids.get("user","42"),payload_json:JSON.stringify(rows[1]!.projection.data)});
    expect(await db.prepare("SELECT project_id,user_id FROM pa_project_assignments WHERE projection_source_id=?").bind(secondary.sourceId).first()).toEqual({project_id:ids.get("project","40"),user_id:ids.get("user","42")});
    expect(await db.prepare("SELECT created_by_user_id FROM pa_operations WHERE id=?").bind(ids.get("operation","100")).first("created_by_user_id")).toBe(ids.get("user","42"));
    expect(await db.prepare("SELECT operation_id,user_id,assigned_by_user_id FROM pa_operation_assignments WHERE projection_source_id=?").bind(secondary.sourceId).first()).toEqual({operation_id:ids.get("operation","100"),user_id:ids.get("user","42"),assigned_by_user_id:ids.get("user","43")});
    expect(await db.prepare("SELECT operation_id,project_id,business_unit_id,assignee_user_id,created_by_user_id FROM pa_tasks WHERE id=?").bind(ids.get("task","110")).first()).toEqual({operation_id:ids.get("operation","100"),project_id:ids.get("project","40"),business_unit_id:ids.get("business_unit","30"),assignee_user_id:ids.get("user","42"),created_by_user_id:ids.get("user","43")});
    expect(await db.prepare("SELECT task_id,user_id,assigned_by_user_id FROM pa_task_assignments WHERE projection_source_id=?").bind(secondary.sourceId).first()).toEqual({task_id:ids.get("task","110"),user_id:ids.get("user","42"),assigned_by_user_id:ids.get("user","43")});
    for(const [kind,external] of [["operation","100"],["task","110"]] as const){
      expect(await db.prepare("SELECT source_id,project_id FROM pa_calendar_events WHERE id=?").bind(ids.get("calendar_event",`${kind}:${external}`)).first()).toEqual({source_id:ids.get(kind,external),project_id:ids.get("project","40")});
    }
    expect(await db.prepare("SELECT name FROM divisions WHERE project_alpha_business_unit_id='30'").first("name")).toBe("PA 30");
    expect(await db.prepare("SELECT count(*) total FROM divisions WHERE project_alpha_business_unit_id=?").bind(ids.get("business_unit","30")).first("total")).toBe(0);
    const revoke=projection("project","40",{name:"Secondary project",business_unit_id:31},"2026-08-26T13:00:00Z");revoke.projection.action="revoke";
    await applyProjectionEventForSource(env(),secondary,revoke,"revoke-secondary-project");
    expect(await db.prepare("SELECT active FROM pa_tasks WHERE id=?").bind(ids.get("task","110")).first("active")).toBe(0);
    expect(await db.prepare("SELECT active FROM pa_calendar_events WHERE id=?").bind(ids.get("calendar_event","task:110")).first("active")).toBe(0);
  },20_000);

  it("revalidates a forged source authority flag before leases, staff mutations or source metadata writes",async()=>{
    const forged={sourceId:secondary.sourceId,staffAuthority:true};
    await expect(applyEntitlementEventForSource(env(),forged,event(),"forged-admin")).rejects.toThrow("projection-source-authority-unsupported");
    expect(await db.prepare("SELECT count(*) total FROM integration_event_receipts").first("total")).toBe(0);
    expect(await db.prepare("SELECT count(*) total FROM pa_projection_entity_leases").first("total")).toBe(0);
    const branch=projection("business_unit","30",{name:"Secondary data only",code:"foreign-branch"});
    await applyProjectionEventForSource(env(),forged,branch,"forged-branch");
    expect(await db.prepare("SELECT name FROM divisions WHERE project_alpha_business_unit_id='30'").first("name")).toBe("PA 30");
    expect(await db.prepare("SELECT count(*) total FROM divisions WHERE name='Secondary data only'").first("total")).toBe(0);
    const invalid={sourceId:"not-a-source",staffAuthority:true};
    await expect(applyProjectionEventForSource(env(),invalid,branch,"invalid-source")).rejects.toThrow();
    await expect(completeEvent(env(),branch,false,invalid)).rejects.toThrow();
    await expect(recordEventFailure(env(),branch.event_id,"invalid-source",invalid)).rejects.toThrow();
    expect(await db.prepare("SELECT status,last_error FROM integration_event_receipts WHERE projection_source_id=? AND event_id=?").bind(secondary.sourceId,branch.event_id).first()).toEqual({status:"pending",last_error:null});
  });

  it("rejects secondary entitlement authority before any state mutation and excludes secondary business users",async()=>{
    const before=(await db.prepare("SELECT * FROM staff_users ORDER BY id").all()).results;
    const fetchMock=vi.fn();vi.stubGlobal("fetch",fetchMock);
    await expect(applyEntitlementEventForSource(env(),secondary,event({entitlement:{application_key:"ltds_ops",enabled:true,role_key:"role-admin",business_unit_ids:["30"]}}),"foreign-admin")).rejects.toThrow("projection-source-authority-unsupported");
    for(const table of ["integration_event_receipts","pa_projection_entity_leases","pa_projection_record_ids","pa_application_entitlements","pa_users"])
      expect(await db.prepare(`SELECT count(*) total FROM ${table} WHERE projection_source_id=?`).bind(secondary.sourceId).first("total")).toBe(0);
    expect((await db.prepare("SELECT * FROM staff_users ORDER BY id").all()).results).toEqual(before);
    expect(fetchMock).not.toHaveBeenCalled();
    // A secondary business user remains data only; the schema also refuses a
    // secondary entitlement even if a future caller bypasses the event wrapper.
    await applyEntitlementEvent(env(),event(),"primary-access");
    const foreignIds=await prepareProjectAlphaSourceRecords(db,secondary,[{kind:"user",externalId:"42"},{kind:"application_entitlement",externalId:"entitlement-42"}]);
    await db.prepare("INSERT INTO pa_users(projection_source_id,id,email,active,payload_json,last_sync_id) VALUES (?,?,'foreign@example.com',1,'{}','test')").bind(secondary.sourceId,foreignIds.get("user","42")).run();
    await expect(db.prepare("INSERT INTO pa_application_entitlements(projection_source_id,id,user_id,application_key,enabled,role_key,payload_json,last_sync_id) VALUES (?,?,?,'ltds_ops',1,'role-admin','{}','test')").bind(secondary.sourceId,foreignIds.get("application_entitlement","entitlement-42"),foreignIds.get("user","42")).run()).rejects.toThrow();
    const desired=await desiredAccessEmails(db);
    expect(desired).toContain("pilot@example.com");
    expect(desired).not.toContain("foreign@example.com");
  });

  it("does not let a secondary source claim or release a busy primary lease with the same event and entity IDs",async()=>{
    let started!:()=>void,release!:()=>void;
    const entered=new Promise<void>(resolve=>{started=resolve;});
    const resumed=new Promise<void>(resolve=>{release=resolve;});
    const state={failNext:false,writes:[] as Array<{sql:string;values:unknown[]}>,beforeWrite:async()=>{started();await resumed;}};
    const primaryEvent=projection("client","71",{name:"Primary held client"});
    const run=applyProjectionEvent(env(portalDatabase(state)),primaryEvent,"held-primary");
    await entered;
    try{
      await expect(applyProjectionEventForSource(env(),secondary,primaryEvent,"secondary-independent")).resolves.toBe("applied");
      expect(await db.prepare("SELECT count(*) total FROM pa_projection_entity_leases WHERE projection_source_id=? AND owner_event_id=?").bind(PRIMARY_PROJECT_ALPHA_SOURCE.sourceId,primaryEvent.event_id).first("total")).toBe(2);
      expect(await db.prepare("SELECT count(*) total FROM pa_projection_entity_leases WHERE projection_source_id=?").bind(secondary.sourceId).first("total")).toBe(0);
    }finally{release();await run;}
  });

  it("keeps authenticated public ingress primary-only despite source hints and rejects body selectors",async()=>{
    const item=projection("business_unit","30",{name:"Public primary branch",code:"public-primary"});
    const requestEnv={...env(),TEAM_DOMAIN:"https://primary.cloudflareaccess.com",CF_ACCESS_AUD:"primary-audience",APPLICATION_KEY:"ltds_ops",PROJECT_ALPHA_WEBHOOK_HMAC_SECRET:"test-hmac-secret",PROJECT_ALPHA_ALLOW_LEGACY_HMAC:"true"} as Env;
    const send=async(payload:unknown)=>{
      const raw=JSON.stringify(payload),timestamp=new Date().toISOString();
      const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(requestEnv.PROJECT_ALPHA_WEBHOOK_HMAC_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
      const bytes=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${timestamp}.${raw}`)));
      const signature=`sha256=${[...bytes].map(byte=>byte.toString(16).padStart(2,"0")).join("")}`;
      return handleRequest(new Request("https://ops-sync.example/v1/project-alpha/events?sourceId=project-alpha%3Asecondary",{method:"POST",headers:{"Content-Type":"application/json","X-PA-Timestamp":timestamp,"X-PA-Event-ID":item.event_id,"X-PA-Signature":signature,"X-Projection-Source":"project-alpha:secondary"},body:raw}),requestEnv,async()=>({}));
    };
    const response=await send(item);expect(response.status).toBe(200);
    expect(await db.prepare("SELECT projection_source_id,name FROM pa_business_units WHERE id='30'").first()).toEqual({projection_source_id:PRIMARY_PROJECT_ALPHA_SOURCE.sourceId,name:"Public primary branch"});
    expect((await send({...item,sourceId:secondary.sourceId})).status).toBe(422);
    expect(await db.prepare("SELECT count(*) total FROM integration_event_receipts WHERE projection_source_id=?").bind(secondary.sourceId).first("total")).toBe(0);
  });
});
