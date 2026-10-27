import { afterEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import worker from "../src/index";
import type { Env } from "../src/types";

describe("Ops Sync Worker entrypoint remains dormant before the approved cutover",()=>{
  let runtime:Miniflare|undefined;
  afterEach(async()=>{vi.unstubAllGlobals();await runtime?.dispose();runtime=undefined;});

  it("scheduled handler treats the absent 0225 control schema as a no-op",async()=>{
    runtime=new Miniflare({modules:true,script:"export default {fetch(){return new Response('unused')}}",cf:false,
      outboundService:()=>{throw Error("unexpected Worker outbound");},d1Databases:["OPS_DB"]});
    const db=await runtime.getD1Database("OPS_DB") as D1Database;
    const calls:Promise<unknown>[]=[];
    worker.scheduled({} as ScheduledController,{OPS_DB:db} as Env,{waitUntil(promise){calls.push(promise);}} as ExecutionContext);
    await expect(Promise.all(calls)).resolves.toEqual([0]);
  });

  it("scheduled handler treats an explicit disabled control as a no-op without provider credentials",async()=>{
    runtime=new Miniflare({modules:true,script:"export default {fetch(){return new Response('unused')}}",cf:false,
      outboundService:()=>{throw Error("unexpected Worker outbound");},d1Databases:["OPS_DB"]});
    const db=await runtime.getD1Database("OPS_DB") as D1Database;
    await db.prepare(`CREATE TABLE native_staff_access_reconciliation(singleton INTEGER PRIMARY KEY,enabled INTEGER,
      generation INTEGER,applied_generation INTEGER)`).run();
    await db.prepare("INSERT INTO native_staff_access_reconciliation VALUES(1,0,0,0)").run();
    const calls:Promise<unknown>[]=[];
    worker.scheduled({} as ScheduledController,{OPS_DB:db} as Env,{waitUntil(promise){calls.push(promise);}} as ExecutionContext);
    await expect(Promise.all(calls)).resolves.toEqual([0]);
    expect(await db.prepare("SELECT enabled,generation,applied_generation FROM native_staff_access_reconciliation").first())
      .toEqual({enabled:0,generation:0,applied_generation:0});
  });

  it("fetch handler rejects absent Access identity before doing any staff or provider work",async()=>{
    runtime=new Miniflare({modules:true,script:"export default {fetch(){return new Response('unused')}}",cf:false,
      outboundService:()=>{throw Error("unexpected Worker outbound");},d1Databases:["OPS_DB"]});
    const db=await runtime.getD1Database("OPS_DB") as D1Database;
    vi.stubGlobal("fetch",vi.fn(async()=>{throw Error("unexpected outbound fetch");}));
    const request=new Request("https://ops-sync.example/health") as Parameters<typeof worker.fetch>[0];
    const response=await worker.fetch(request,{OPS_DB:db,EXPECTED_HOST:"ops-sync.example"} as Env);
    expect(response.status).toBe(401);
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toMatchObject({results:[]});
    expect(fetch).not.toHaveBeenCalled();
  });
});
