import { readFileSync,readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import {
  nativeFeedbackEnabledForSource,
  nativeFeedbackNotificationsSchemaAvailable,
  nativeFeedbackSourceIds,
} from "../src/worker/client-portal/native-feedback-authority";
import type { Env } from "../src/worker/types";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

describe("native feedback source gate",()=>{
  const a="project-alpha:customer-a",b="project-alpha:customer_b";

  it("defaults empty and admits only a bounded, unique, exact source list",()=>{
    expect([...nativeFeedbackSourceIds({})]).toEqual([]);
    expect(nativeFeedbackEnabledForSource({CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS:` ${a},${b} `},a)).toBe(true);
    expect(nativeFeedbackEnabledForSource({CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS:` ${a},${b} `},"project-alpha:other")).toBe(false);
    for(const invalid of [
      `${a},${a}`,
      "project-alpha:primary",
      `${a}, project-alpha:UPPER`,
      `${a},project-alpha:primary`,
      Array.from({length:33},(_,index)=>`project-alpha:s${index}`).join(","),
      "x".repeat(4097),
    ]) expect([...nativeFeedbackSourceIds({CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS:invalid})]).toEqual([]);
  });
});

describe("native feedback completion notification schema readiness",()=>{
  let runtime:Miniflare;
  beforeAll(()=>{runtime=new Miniflare({compatibilityDate:"2026-08-06",modules:true,
    script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:"native-feedback-notification-readiness"}});});
  afterAll(async()=>runtime.dispose());

  it("fails closed before 0188 and observes only its exact table and triggers after cache expiry",async()=>{
    const db=await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    const directory=new URL("../migrations/",import.meta.url);
    for(const name of readdirSync(directory).filter(name=>/^\d+.*\.sql$/.test(name)&&name<"0188").sort()){
      const statements=splitD1MigrationStatements(readFileSync(new URL(name,directory),"utf8"));
      if(statements.length)await db.batch(statements.map(sql=>db.prepare(sql)));
    }
    const env={DELIVERY_DB:db} as Env;
    expect(await nativeFeedbackNotificationsSchemaAvailable(env,{now:1_000})).toBe(false);
    const migration=splitD1MigrationStatements(readFileSync(new URL("0188_native_feedback_completion_notices.sql",directory),"utf8"));
    await db.batch(migration.map(sql=>db.prepare(sql)));
    expect(await nativeFeedbackNotificationsSchemaAvailable(env,{now:1_001})).toBe(false);
    expect(await nativeFeedbackNotificationsSchemaAvailable(env,{now:31_001})).toBe(true);
    await db.prepare("DROP TRIGGER portal_native_feedback_notification_completion").run();
    expect(await nativeFeedbackNotificationsSchemaAvailable(env,{refresh:true,now:31_002})).toBe(false);
  },120_000);
});
