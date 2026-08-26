import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";

const dispatch=vi.hoisted(()=>vi.fn());
vi.mock("cloudflare:workers",()=>({WorkflowEntrypoint:class{},WorkerEntrypoint:class{},DurableObject:class{}}));
vi.mock("../src/worker/notifications",async importOriginal=>({
  ...await importOriginal<typeof import("../src/worker/notifications")>(),processProjectAlphaDeliveryPortalNotifications:dispatch,
}));
import worker from "../src/worker/index";
afterEach(()=>{vi.restoreAllMocks();dispatch.mockReset();});

describe("isolated native delivery notification schedule",()=>{
  const event={cron:"4-59/15 * * * *",scheduledTime:1787751840000,noRetry(){}};
  const context=()=>({waitUntil:vi.fn(()=>{throw new Error("Unrelated detached work");}),passThroughOnException(){}}) as unknown as ExecutionContext;
  it("preserves other schedules and awaits native dispatch without unrelated bindings",async()=>{
    const config=readFileSync(new URL("../wrangler.jsonc",import.meta.url),"utf8");
    expect(config).toContain('"crons": ["*/15 * * * *", "*/5 * * * *", "2-57/5 * * * *", "17 * * * *", "4-59/15 * * * *"]');
    const source=readFileSync(new URL("../src/worker/index.ts",import.meta.url),"utf8");
    expect(source.match(/processProjectAlphaDeliveryPortalNotifications\(env\)/g)).toHaveLength(1);
    const env=new Proxy({} as Env,{get(){throw new Error("Unrelated environment access");}}),ctx=context();
    const log=vi.spyOn(console,"log").mockImplementation(()=>{});
    let finish!:(count:number)=>void,returned=false;
    dispatch.mockImplementation(()=>new Promise<number>(resolve=>{finish=resolve;}));
    const running=worker.scheduled(event,env,ctx).then(()=>{returned=true;});
    expect(returned).toBe(false);expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]===env).toBe(true);
    finish(3);await running;
    expect(returned).toBe(true);expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({event:"native_delivery_notifications.tick",processed:3}));
  });
  it("reports failure without logging recipient or transport details",async()=>{
    dispatch.mockRejectedValue(new Error("secret transport private@example.test"));
    const log=vi.spyOn(console,"error").mockImplementation(()=>{}),ctx=context();
    await expect(worker.scheduled(event,{} as Env,ctx)).rejects.toThrow("Native delivery notification dispatch failed");
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({event:"native_delivery_notifications.error"}));
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
  it("does not dispatch on an unrecognized schedule",async()=>{
    const env=new Proxy({} as Env,{get(){throw new Error("Unrelated binding");}});
    await worker.scheduled({...event,cron:"3-58/15 * * * *"},env,context());
    expect(dispatch).not.toHaveBeenCalled();
  });
});
