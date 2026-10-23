import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";
import { readFile } from "node:fs/promises";
import { reconcileNativeStaffAccess, desiredNativeStaffAccessEmails } from "../src/native-staff-access";
import { reconcileScheduledAccess } from "../src/index";
import type { Env } from "../src/types";

let runtime: Miniflare, db: D1Database;
const environment = () => ({ OPS_DB: db, CF_ACCOUNT_ID: "synthetic-account", CF_ACCESS_GROUP_ID: "synthetic-group",
  CF_ACCESS_GROUP_API_TOKEN: "synthetic-token" });
type Group = { id:string; name:string; include:unknown[]; exclude:unknown[]; require:unknown[]; is_default:boolean };
let group: Group, writes: Group[];
let intercept: ((method:string) => Promise<Response | undefined>) | undefined;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return {promise, resolve}; }
async function control() { return db.prepare("SELECT * FROM native_staff_access_reconciliation WHERE singleton=1").first<Record<string, unknown>>(); }
async function enable() { await db.prepare("UPDATE native_staff_access_reconciliation SET enabled=1,generation=1").run(); }
async function member(id:string, email:string, options:{native?:boolean;active?:number;legacyActive?:boolean;subject?:string;profileEmail?:string} = {}) {
  const subject = "subject:" + id;
  await db.prepare("INSERT INTO staff_users(id,email,access_subject,status) VALUES(?,?,?,?)")
    .bind(id,email,options.subject ?? subject,options.legacyActive === false ? "inactive" : "active").run();
  if (options.native !== false) {
    await db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active) VALUES(?,?,?)")
      .bind(id,subject,options.active ?? 1).run();
    await db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email) VALUES(?,?)").bind(id,options.profileEmail ?? email).run();
  }
}
beforeEach(async () => {
  runtime = new Miniflare({ modules:true, script:"export default {fetch(){return new Response('unused')}}", cf:false,
    outboundService:() => { throw Error("No Worker outbound in reconciliation tests"); }, d1Databases:["DB"] });
  db = await runtime.getD1Database("DB") as D1Database;
  // The exact additive control DDL, not a mocked claim/completion implementation.
  // Full lifecycle/event/identity constraints are exercised by the Operations lane.
  const migration = await readFile(new URL("../../operations/migrations/0225_native_staff_lifecycle_bridge.sql",import.meta.url),"utf8");
  const controlDdl = migration.slice(0,migration.indexOf("CREATE TABLE native_staff_lifecycle_fences"));
  for (const sql of unstable_splitSqlQuery(controlDdl).filter(s => !/^\s*PRAGMA\b/i.test(s))) await db.prepare(sql).run();
  await db.batch([
    db.prepare("CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,access_subject TEXT,status TEXT)"),
    db.prepare("CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER)"),
    db.prepare("CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,login_email TEXT)"),
    db.prepare("CREATE TABLE pa_users(id TEXT PRIMARY KEY,email TEXT,active INTEGER)"),
  ]);
  group = { id:"synthetic-group",name:"Managed staff",include:[{email:{email:"retired@example.invalid"}}],
    exclude:[{email:{email:"excluded@example.invalid"}}],require:[{auth_method:{auth_method:"mfa"}}],is_default:false };
  writes = []; intercept = undefined;
  vi.stubGlobal("fetch",vi.fn(async (_url:string, init?:RequestInit) => {
    const method = init?.method ?? "GET";
    const response = await intercept?.(method); if (response) return response;
    if (method === "PUT") { group = JSON.parse(String(init?.body)); group.id = "synthetic-group"; writes.push(structuredClone(group)); }
    return Response.json({success:true,result:group});
  }));
});
afterEach(async () => { vi.unstubAllGlobals(); await runtime.dispose(); });

describe("native staff Access reconciliation uses D1 claims and provider doubles", () => {
  it("keeps the default-off and pre-migration cron inert without credentials or PA authority",async () => {
    await member("unreviewed","unreviewed@example.invalid",{native:false});
    expect(await reconcileScheduledAccess({OPS_DB:db} as Env)).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    await db.prepare("DROP TABLE native_staff_access_reconciliation").run();
    expect(await reconcileScheduledAccess({OPS_DB:db} as Env)).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("derives only exact joined active native/legacy identities independently of PA records",async () => {
    await member("valid","valid@example.invalid"); await member("legacy","legacy@example.invalid",{native:false});
    await member("inactive","inactive@example.invalid",{active:0}); await member("legacy-off","legacyoff@example.invalid",{legacyActive:false});
    await member("wrong-subject","subject@example.invalid",{subject:"different-subject"});
    await member("wrong-email","Email@example.invalid",{profileEmail:"email@example.invalid"});
    await db.prepare("INSERT INTO pa_users VALUES('pa','pa@example.invalid',1)").run();
    expect(await desiredNativeStaffAccessEmails(db.withSession("first-primary"))).toEqual(["valid@example.invalid"]);
    await enable(); expect(await reconcileScheduledAccess(environment() as Env)).toBe(1);
    expect(writes[0]!.include).toEqual([{email:{email:"valid@example.invalid"}}]);
    expect(writes[0]!.exclude).toEqual([{email:{email:"excluded@example.invalid"}}]);
    expect(writes[0]!.require).toEqual([{auth_method:{auth_method:"mfa"}}]);
    expect(await control()).toMatchObject({generation:1,applied_generation:1,lease_id:null,attempt_generation:null,last_error:null});
    expect((await control())!.last_success_at).toEqual(expect.any(String));
    await db.prepare("UPDATE pa_users SET active=0,email='changed@example.invalid'").run();
    const count = writes.length; expect(await reconcileNativeStaffAccess(environment())).toMatchObject({status:"applied",members:1});
    expect(writes).toHaveLength(count); // Periodic verification still GETs, but PA changes no desired membership.
  });
  it("keeps provider failures pending without undoing local denial, then retries current state",async () => {
    await member("control","control@example.invalid"); await member("off","retired@example.invalid",{active:0,legacyActive:false}); await enable();
    intercept = async () => Response.json({success:false,result:null},{status:403});
    expect(await reconcileNativeStaffAccess(environment())).toEqual({status:"pending",members:0});
    expect(await control()).toMatchObject({generation:1,applied_generation:0,attempts:1,last_error:"reconciliation-pending",lease_id:null});
    expect(await db.prepare("SELECT active FROM native_staff_admissions WHERE staff_id='off'").first("active")).toBe(0);
    expect(await db.prepare("SELECT status FROM staff_users WHERE id='off'").first("status")).toBe("inactive");
    intercept = undefined; expect(await reconcileNativeStaffAccess(environment())).toEqual({status:"applied",members:1});
    expect(group.include).toEqual([{email:{email:"control@example.invalid"}}]); expect((await control())!.attempts).toBe(2);
  });
  it("holds an empty native cohort pending without any provider call or invented deny-all rules",async () => {
    await member("off","retired@example.invalid",{active:0,legacyActive:false}); await enable();
    const prior=structuredClone(group);
    expect(await reconcileNativeStaffAccess(environment())).toEqual({status:"pending",members:0});
    expect(fetch).not.toHaveBeenCalled(); expect(group).toEqual(prior);
    expect(await control()).toMatchObject({generation:1,applied_generation:0,last_error:"native-cohort-empty",lease_id:null});
    expect(await db.prepare("SELECT status FROM staff_users WHERE id='off'").first("status")).toBe("inactive");
  });
  it("does not overlap a live lease and refuses stale generations before provider writes",async () => {
    await member("valid","valid@example.invalid"); await enable();
    const entered=deferred(), release=deferred(); let first=true;
    intercept=async method=>{if(method==="GET" && first){first=false;entered.resolve();await release.promise;}return undefined;};
    const running=reconcileNativeStaffAccess(environment()); await entered.promise;
    expect(await reconcileNativeStaffAccess(environment())).toEqual({status:"busy",members:0});
    await db.prepare("UPDATE native_staff_access_reconciliation SET generation=2").run(); release.resolve();
    expect(await running).toEqual({status:"pending",members:0}); expect(writes).toEqual([]);
    expect(await control()).toMatchObject({generation:2,applied_generation:0,lease_id:null});
  });
  it("cannot acknowledge a newer generation after a successful stale PUT",async () => {
    await member("control","control@example.invalid"); await member("valid","valid@example.invalid"); await enable();
    intercept=async method=>{if(method==="PUT"){
      await db.batch([db.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id='valid'"),db.prepare("UPDATE staff_users SET status='inactive' WHERE id='valid'"),
        db.prepare("UPDATE native_staff_access_reconciliation SET generation=2")]);
    }return undefined;};
    expect(await reconcileNativeStaffAccess(environment())).toEqual({status:"pending",members:0});
    expect(await control()).toMatchObject({generation:2,applied_generation:0,lease_id:null});
    intercept=undefined; expect(await reconcileNativeStaffAccess(environment())).toEqual({status:"applied",members:1});
    expect(group.include).toEqual([{email:{email:"control@example.invalid"}}]); expect((await control())!.applied_generation).toBe(2);
  });
  it("recovers an unknown PUT acknowledgement by reading actual managed membership",async () => {
    await member("valid","valid@example.invalid"); await enable();
    intercept=async method=>{if(method==="PUT"){
      group.include=[{email:{email:"valid@example.invalid"}}]; throw Error("synthetic remote accepted then disconnected");
    }return undefined;};
    expect(await reconcileNativeStaffAccess(environment())).toEqual({status:"pending",members:0});
    expect(await control()).toMatchObject({applied_generation:0,last_error:"reconciliation-pending"});
    intercept=undefined; expect(await reconcileNativeStaffAccess(environment())).toEqual({status:"applied",members:1});
    expect(writes).toHaveLength(0); // Read-only retry observes the already-applied request.
  });
  it("does not let an expired holder complete a replacement lease and later repairs a delayed remote write",async () => {
    await member("control","control@example.invalid"); await member("valid","valid@example.invalid"); await enable();
    const entered=deferred(), release=deferred(); let first=true;
    intercept=async method=>{if(method==="PUT" && first){first=false;entered.resolve();await release.promise;}return undefined;};
    const old=reconcileNativeStaffAccess(environment()); await entered.promise;
    // Simulate a request surviving its local lease. No remote conditional-write
    // guarantee exists: its old body may still be applied after a newer write.
    await db.batch([db.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id='valid'"),db.prepare("UPDATE staff_users SET status='inactive' WHERE id='valid'"),
      db.prepare("UPDATE native_staff_access_reconciliation SET generation=2,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second')")]);
    expect(await reconcileNativeStaffAccess(environment())).toEqual({status:"applied",members:1});
    expect(group.include).toEqual([{email:{email:"control@example.invalid"}}]);
    const newer=await control(); release.resolve();
    expect(await old).toEqual({status:"pending",members:0});
    expect(await control()).toEqual(newer); // Old acknowledgement cannot alter newer lease/result metadata.
    expect(group.include).toEqual([{email:{email:"control@example.invalid"}},{email:{email:"valid@example.invalid"}}]);
    expect(await db.prepare("SELECT status FROM staff_users WHERE id='valid'").first("status")).toBe("inactive");
    // Even an already-applied generation is checked again. Local denial remains
    // authoritative during this explicitly acknowledged remote late-write window.
    expect(await reconcileNativeStaffAccess(environment())).toEqual({status:"applied",members:1});
    expect(group.include).toEqual([{email:{email:"control@example.invalid"}}]); expect((await control())!.attempts).toBe(3);
  });
  it("keeps mixed/unmanaged includes and changed readback constraints pending instead of replacing them",async () => {
    await member("valid","valid@example.invalid"); await enable();
    group.include=[{email:{email:"retired@example.invalid"},everyone:{}}];
    expect(await reconcileNativeStaffAccess(environment())).toEqual({status:"pending",members:0}); expect(writes).toHaveLength(0);
    group.include=[];
    intercept=async method=>{if(method==="GET" && writes.length){return Response.json({success:true,result:{...group,require:[]}});}return undefined;};
    expect(await reconcileNativeStaffAccess(environment())).toEqual({status:"pending",members:0});
    expect((await control())!.applied_generation).toBe(0);
  });
});
