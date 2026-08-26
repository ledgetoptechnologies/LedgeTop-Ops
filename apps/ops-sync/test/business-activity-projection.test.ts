import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { applyProjectionEventForSource, completeEvent } from "../src/projection";
import { createProjectAlphaSourceContext } from "../../operations/src/worker/project-alpha-source";
import { syncProjectAlphaForSource } from "../../operations/src/worker/project-alpha";
import type { Env, ProjectionEvent } from "../src/types";
import type { Env as OperationsEnv } from "../../operations/src/worker/types";

let runtime:Miniflare,db:D1Database;
const source=createProjectAlphaSourceContext("project-alpha:activity-producer");
const at="2026-08-01T01:00:00.000Z";
const id=()=>crypto.randomUUID();
const event=(kind:"organization"|"client"|"project",external:string,data:Record<string,unknown>,time=at):ProjectionEvent=>({
  event_id:id(),event_type:"projection.changed",occurred_at:time,schema_version:1,application_key:"ltds_ops",
  projection:{entity_type:kind,entity_id:external,action:"upsert",source_updated_at:time,data},
});
const environment=(database=db)=>({OPS_DB:database} as Env); // Secondary projection deliberately has no Delivery binding.
async function rows(eventId:string){return(await db.prepare("SELECT * FROM client_business_activity WHERE projection_source_id=? AND event_key=?")
  .bind(source.sourceId,"event:"+eventId).all<Record<string,unknown>>()).results;}
beforeAll(async()=>{
  runtime=new Miniflare({modules:true,script:"export default {fetch(){return new Response('producer')}}",d1Databases:["OPS_DB"]});
  db=await runtime.getD1Database("OPS_DB") as D1Database;
  const directory=resolve(import.meta.dirname,"../../operations/migrations");
  for(const name of(await readdir(directory)).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&name.slice(0,4)<="0037").sort())
    await db.batch(splitD1MigrationStatements(await readFile(resolve(directory,name),"utf8")).map(sql=>db.prepare(sql)));
},120_000);
afterEach(()=>vi.unstubAllGlobals());
afterAll(async()=>{await runtime?.dispose();});

// Sequential real-D1 projections can exceed five seconds and must finish before the next case.
describe("business activity at actual authenticated-projection producer seam",{timeout:30_000},()=>{
  it("appends one minimal same-batch record for applied source events and never an invented actor",async()=>{
    const root=event("organization",id(),{name:"Event organization",updated_at:at,user_id:"not-an-actor",billing_secret:"private"});
    expect(await applyProjectionEventForSource(environment(),source,root,"payload")).toBe("applied");
    expect(await rows(root.event_id)).toHaveLength(1);
    const serialized=JSON.stringify(await rows(root.event_id));
    expect(serialized).not.toMatch(/not-an-actor|billing_secret|private/);
    await completeEvent(environment(),root,false,source);
    expect(await applyProjectionEventForSource(environment(),source,root,"payload")).toBe("duplicate");
    expect(await rows(root.event_id)).toHaveLength(1);
  });
  it("does not append ignored older/equal versions; pending retry after the version marker remains exactly once",async()=>{
    const external=id(),current=event("organization",external,{name:"Current"});
    await applyProjectionEventForSource(environment(),source,current,"current");
    expect(await applyProjectionEventForSource(environment(),source,current,"current")).toBe("applied");
    const old=event("organization",external,{name:"Old"},"2026-07-01T00:00:00Z");
    expect(await applyProjectionEventForSource(environment(),source,old,"old")).toBe("ignored");
    expect(await rows(current.event_id)).toHaveLength(1);expect(await rows(old.event_id)).toHaveLength(0);
  });
  it("captures exact mapped owner; moving the client never changes the old immutable event owner",async()=>{
    const org=id(),person=id(),work=id();
    for(const value of [event("organization",org,{name:"Owner"}),event("client",person,{name:"Client",organization_id:org}),
      event("project",work,{name:"Project",client_id:person})])
      await applyProjectionEventForSource(environment(),source,value,value.event_id);
    const row=await db.prepare("SELECT * FROM client_business_activity WHERE projection_source_id=? AND record_kind='project' ORDER BY sequence DESC LIMIT 1").bind(source.sourceId).first<Record<string,unknown>>();
    expect(row?.root_kind).toBe("organization");expect(row?.root_id).not.toBe(org);expect(row?.record_id).not.toBe(work);
    const next=id();await applyProjectionEventForSource(environment(),source,event("organization",next,{name:"New"}),"new");
    const moved=event("client",person,{name:"Client",organization_id:next},"2026-08-02T00:00:00Z");
    await applyProjectionEventForSource(environment(),source,moved,"move");
    expect(await db.prepare("SELECT root_id FROM client_business_activity WHERE sequence=?").bind(row!.sequence).first("root_id")).toBe(row?.root_id);
  });
  it("rolls back the source row and ledger together when the exact applied-row transaction fails",async()=>{
    const rawStatements=new WeakMap<D1PreparedStatement,D1PreparedStatement>(), sqls=new WeakMap<D1PreparedStatement,string>();
    const wrap=(raw:D1PreparedStatement,sql:string):D1PreparedStatement=>{
      const proxy=new Proxy(raw,{get(target,property){
        if(property==="bind")return(...values:unknown[])=>wrap(target.bind(...values),sql);
        const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;
      }});rawStatements.set(proxy,raw);sqls.set(proxy,sql);return proxy;
    };
    let injected=false;
    const raced=new Proxy(db,{get(target,property){
      if(property==="prepare")return(sql:string)=>wrap(target.prepare(sql),sql);
      if(property==="batch")return async <T>(statements:D1PreparedStatement[]):Promise<D1Result<T>[]>=>{
        const raw=statements.map(s=>rawStatements.get(s)??s);
        if(!injected&&statements.some(s=>sqls.get(s)?.includes("INSERT INTO client_business_activity"))){
          injected=true;raw.push(target.prepare("INSERT INTO client_business_activity_state(singleton) VALUES(2)"));
        }
        return target.batch<T>(raw);
      };
      const value=Reflect.get(target,property,target);return typeof value==="function"?value.bind(target):value;
    }});
    const root=event("organization",id(),{name:"Never committed"});
    await expect(applyProjectionEventForSource(environment(raced),source,root,"rollback")).rejects.toThrow();
    expect(injected).toBe(true);expect(await rows(root.event_id)).toHaveLength(0);
    expect(await db.prepare("SELECT count(*) n FROM pa_organizations WHERE last_sync_id=?").bind("event:"+root.event_id).first("n")).toBe(0);
  });
  it("observes first snapshot child-before-owner dates, does not use generatedAt, and identical replay adds nothing",async()=>{
    const snapshotSource=createProjectAlphaSourceContext("project-alpha:activity-snapshot");
    const names=["users","business_units","worker_business_units","clients","organizations","projects","project_assignments","service_locations",
      "application_entitlements","operations","operation_assignments","tasks","task_assignments","calendar_events"];
    const payload={...Object.fromEntries(names.map(name=>[name,[]])),generated_at:"2026-08-20T00:00:00Z",has_more:false,next_page:null,
      organizations:[{id:"1",name:"Snapshot org",updated_at:"2026-01-01 00:00:00"}],
      clients:[{id:"2",name:"Snapshot contact",organization_id:"1",updated_at:"2026-01-02 00:00:00"}],
      projects:[{id:"3",name:"Snapshot project",client_id:"2",updated_at:"2026-01-03 00:00:00"},{id:"4",name:"Unknown date",organization_id:"1"}]};
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json(payload)));
    const env={OPS_DB:db} as OperationsEnv;
    const connection={baseUrl:"https://snapshot.example.test",apiKey:"fixture-only",applicationKey:"ltds_ops"};
    await syncProjectAlphaForSource(env,snapshotSource,connection);
    const first=(await db.prepare("SELECT * FROM client_business_activity WHERE projection_source_id=? ORDER BY sequence").bind(snapshotSource.sourceId).all()).results;
    expect(first).toHaveLength(3);expect(first.every(row=>row.origin==="source_observation")).toBe(true);
    expect(first.map(row=>row.occurred_at)).toEqual(expect.arrayContaining(["2026-01-01T00:00:00.000Z","2026-01-02T00:00:00.000Z","2026-01-03T00:00:00.000Z"]));
    await syncProjectAlphaForSource(env,snapshotSource,connection);
    expect((await db.prepare("SELECT * FROM client_business_activity WHERE projection_source_id=? ORDER BY sequence").bind(snapshotSource.sourceId).all()).results).toEqual(first);
  },60_000);
});
