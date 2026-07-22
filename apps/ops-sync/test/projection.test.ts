import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { applyEntitlementEvent, applyProjectionEvent, completeEvent } from "../src/projection";
import type { EntitlementEvent, Env, ProjectionEvent } from "../src/types";

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

function env(): Env { return {OPS_DB:db} as Env; }

describe("entitlement projection",()=>{
  beforeEach(async()=>{
    miniflare=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:["OPS_DB"]});
    db=await miniflare.getD1Database("OPS_DB") as D1Database;
    for(const migration of ["0001_operations.sql","0002_seed_acl.sql","0004_project_alpha_authority.sql","0005_project_alpha_ops_acl.sql","0007_pa_projection_fingerprints.sql","0008_project_units_task_assignments.sql"]){
      const sql=await readFile(resolve(import.meta.dirname,"../../operations/migrations",migration),"utf8");
      for(const statement of sql.replace(/\r\n/g,"\n").split(";").map((part)=>part.trim()).filter((part)=>part && !part.startsWith("PRAGMA foreign_keys"))){
        await db.prepare(statement).run();
      }
    }
    await db.prepare("INSERT INTO divisions (id,name,code,project_alpha_business_unit_id) VALUES ('division-pa-30','PA 30','pa-30','30')").run();
  });
  afterEach(async()=>miniflare.dispose());

  it("grants, retries a pending event, completes idempotently, and revokes",async()=>{
    const grant=event();
    await expect(applyEntitlementEvent(env(),grant,"hash-a")).resolves.toBe("applied");
    expect(await db.prepare("SELECT status FROM staff_users WHERE project_alpha_user_id='42'").first("status")).toBe("active");
    expect(await db.prepare("SELECT role_id FROM staff_role_assignments WHERE staff_id='staff-pa-42'").first("role_id")).toBe("role-operator");
    expect(await db.prepare("SELECT scope FROM staff_role_assignments WHERE staff_id='staff-pa-42'").first("scope")).toBe("assigned");
    expect(await db.prepare("SELECT division_id FROM staff_divisions WHERE staff_id='staff-pa-42'").first("division_id")).toBe("division-pa-30");
    await expect(applyEntitlementEvent(env(),grant,"hash-a")).resolves.toBe("applied");
    await completeEvent(env(),grant);
    await expect(applyEntitlementEvent(env(),grant,"hash-a")).resolves.toBe("duplicate");

    const revoke=event({event_id:"959204fb-5ac3-4d18-8798-7759bd56cbe9",event_type:"application_entitlement.revoked",occurred_at:"2026-07-17T20:01:00.000000Z"});
    await expect(applyEntitlementEvent(env(),revoke,"hash-b")).resolves.toBe("applied");
    expect(await db.prepare("SELECT status FROM staff_users WHERE project_alpha_user_id='42'").first("status")).toBe("inactive");
    expect(await db.prepare("SELECT count(*) AS total FROM staff_role_assignments WHERE staff_id='staff-pa-42'").first("total")).toBe(0);
  });

  it("maps PA administrators to immutable global admin access",async()=>{
    const admin=event({entitlement:{application_key:"ltds_ops",enabled:true,role_key:"role-admin",business_unit_ids:["30"]}});
    await expect(applyEntitlementEvent(env(),admin,"admin-hash")).resolves.toBe("applied");
    expect(await db.prepare("SELECT immutable FROM roles WHERE id='role-admin'").first("immutable")).toBe(1);
    expect(await db.prepare("SELECT role_id FROM staff_role_assignments WHERE staff_id='staff-pa-42'").first("role_id")).toBe("role-admin");
    expect(await db.prepare("SELECT scope FROM staff_role_assignments WHERE staff_id='staff-pa-42'").first("scope")).toBe("global");
    expect(await db.prepare("SELECT count(*) AS total FROM staff_divisions WHERE staff_id='staff-pa-42'").first("total")).toBe(0);
  });

  it("downgrades legacy PA manager roles to assignment-scoped employee access",async()=>{
    const legacy=event({entitlement:{application_key:"ltds_ops",enabled:true,role_key:"role-division-manager",business_unit_ids:["30"]}});
    await expect(applyEntitlementEvent(env(),legacy,"legacy-hash")).resolves.toBe("applied");
    const assignment=await db.prepare("SELECT role_id,scope,division_id FROM staff_role_assignments WHERE staff_id='staff-pa-42'").first<{role_id:string;scope:string;division_id:string|null}>();
    expect(assignment).toEqual({role_id:"role-operator",scope:"assigned",division_id:null});
    expect(await db.prepare("SELECT role_key FROM pa_application_entitlements WHERE user_id='42'").first("role_key")).toBe("role-division-manager");
    expect(await db.prepare("SELECT division_id FROM staff_divisions WHERE staff_id='staff-pa-42'").first("division_id")).toBe("division-pa-30");
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

  it("ignores an out-of-order incremental projection for the same entity",async()=>{
    const newer:ProjectionEvent={event_id:"2fab1100-9992-4fd1-b013-26b330a9db34",event_type:"projection.changed",occurred_at:"2026-07-22T05:03:00.000000Z",schema_version:1,application_key:"ltds_ops",projection:{entity_type:"project",entity_id:"40",action:"upsert",source_updated_at:"2026-07-22T05:03:00.000000Z",data:{id:40,name:"New name",business_unit_id:30}}};
    const older:ProjectionEvent={...newer,event_id:"dcf7d00b-f313-45a7-815e-3cb97fe60fd0",occurred_at:"2026-07-22T05:02:00.000000Z",projection:{...newer.projection,source_updated_at:"2026-07-22T05:02:00.000000Z",data:{id:40,name:"Old name",business_unit_id:30}}};
    await expect(applyProjectionEvent(env(),newer,"newer-project-hash")).resolves.toBe("applied");
    await expect(applyProjectionEvent(env(),older,"older-project-hash")).resolves.toBe("ignored");
    expect(await db.prepare("SELECT name FROM pa_projects WHERE id='40'").first("name")).toBe("New name");
  });
});
