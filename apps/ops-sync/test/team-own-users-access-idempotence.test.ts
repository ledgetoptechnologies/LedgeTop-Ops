// Team "own users" R6: the Access-group carry-over reconciler is idempotent and
// never drops the admitted owner. Same harness as native-staff-access.test.ts:
// local D1 (Miniflare) with the exact 0225 control DDL and a provider double for
// the Access group API. Synthetic identities only; no network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { unstable_splitSqlQuery } from "wrangler";
import { readFile } from "node:fs/promises";
import { reconcileNativeStaffAccess } from "../src/native-staff-access";
import { reconcileScheduledAccess } from "../src/index";
import type { Env } from "../src/types";

let runtime: Miniflare, db: D1Database;
type Group = { id: string; name: string; include: unknown[]; exclude: unknown[]; require: unknown[]; is_default: boolean };
let group: Group, writes: Group[];
const environment = () => ({ OPS_DB: db, CF_ACCOUNT_ID: "synthetic-account", CF_ACCESS_GROUP_ID: "synthetic-group",
  CF_ACCESS_GROUP_API_TOKEN: "synthetic-token", TEAM_DOMAIN: "https://tenant.cloudflareaccess.com" });
const control = () => db.prepare("SELECT enabled,generation,applied_generation,lease_id,attempt_generation,last_error FROM native_staff_access_reconciliation WHERE singleton=1").first();
const staffState = async () => (await db.prepare(`SELECT s.id,s.status,s.access_subject,a.active,p.login_email FROM staff_users s
  LEFT JOIN native_staff_admissions a ON a.staff_id=s.id LEFT JOIN native_staff_profiles p ON p.staff_id=s.id ORDER BY s.id`).all()).results;
async function member(id: string, email: string, options: { native?: boolean; owner?: boolean } = {}) {
  await db.prepare("INSERT INTO staff_users(id,email,access_subject,status) VALUES(?,?,?,'active')").bind(id, email, `subject:${id}`).run();
  if (options.native !== false) {
    await db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active) VALUES(?,?,1)").bind(id, `subject:${id}`).run();
    await db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email) VALUES(?,?)").bind(id, email).run();
  }
  if (options.owner) await db.prepare("INSERT INTO staff_role_assignments(staff_id,role_id,scope) VALUES(?,'role-owner','global')").bind(id).run();
}

beforeEach(async () => {
  runtime = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('unused')}}", cf: false,
    outboundService: () => { throw Error("No Worker outbound in reconciliation tests"); }, d1Databases: ["DB"] });
  db = await runtime.getD1Database("DB") as D1Database;
  const migration = await readFile(new URL("../../operations/migrations/0225_native_staff_lifecycle_bridge.sql", import.meta.url), "utf8");
  const controlDdl = migration.slice(0, migration.indexOf("CREATE TABLE native_staff_lifecycle_fences"));
  for (const sql of unstable_splitSqlQuery(controlDdl).filter(s => !/^\s*PRAGMA\b/i.test(s))) await db.prepare(sql).run();
  await db.batch([
    db.prepare("CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,display_name TEXT DEFAULT 'Synthetic Staff',project_alpha_user_id TEXT,access_subject TEXT,status TEXT)"),
    db.prepare("CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,bound_access_subject TEXT,active INTEGER)"),
    db.prepare("CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,login_email TEXT,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT DEFAULT 'synthetic')"),
    db.prepare("CREATE TABLE pa_users(id TEXT PRIMARY KEY,email TEXT,active INTEGER)"),
    db.prepare("CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT)"),
    db.prepare("CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT)"),
  ]);
  group = { id: "synthetic-group", name: "Managed staff", include: [{ email: { email: "retired@example.invalid" } }],
    exclude: [], require: [{ auth_method: { auth_method: "mfa" } }], is_default: false };
  writes = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "PUT") { group = JSON.parse(String(init?.body)); group.id = "synthetic-group"; writes.push(structuredClone(group)); }
    return Response.json({ success: true, result: group });
  }));
});
afterEach(async () => { vi.unstubAllGlobals(); await runtime.dispose(); });

describe("team own-users R6: idempotent Access carry-over that keeps the owner", () => {
  it("leaves staff rows untouched and makes no provider call while the 0225 gate is off, however often it runs", async () => {
    await member("owner", "owner@example.test", { owner: true }); await member("legacy", "legacy@example.test", { native: false });
    const before = await staffState(), controlBefore = await control();
    for (let run = 0; run < 3; run++) expect(await reconcileScheduledAccess({ OPS_DB: db } as Env)).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(await staffState()).toEqual(before);
    expect(await control()).toEqual(controlBefore);
  });

  it("running the enabled reconciliation twice yields the same group and state, with the owner included both times", async () => {
    await member("owner", "owner@example.test", { owner: true }); await member("operator", "operator@example.test");
    await db.prepare("UPDATE native_staff_access_reconciliation SET enabled=1,generation=1").run();
    const expected = [{ email: { email: "operator@example.test" } }, { email: { email: "owner@example.test" } }];

    expect(await reconcileNativeStaffAccess(environment())).toEqual({ status: "applied", members: 2 });
    const firstGroup = structuredClone(group), firstControl = await control(), firstStaff = await staffState();
    expect(group.include).toEqual(expected);
    expect(group.require).toEqual([{ auth_method: { auth_method: "mfa" } }]);
    expect(writes).toHaveLength(1);

    expect(await reconcileNativeStaffAccess(environment())).toEqual({ status: "applied", members: 2 });
    expect(writes).toHaveLength(1); // already converged: verification only, no second PUT
    expect(group).toEqual(firstGroup);
    expect(await control()).toEqual(firstControl);
    expect(await staffState()).toEqual(firstStaff);
    expect(firstControl).toMatchObject({ applied_generation: 1, lease_id: null, last_error: null });
  });

  it("offboarding another staff member re-converges once and still keeps the owner", async () => {
    await member("owner", "owner@example.test", { owner: true }); await member("leaver", "leaver@example.test");
    await db.prepare("UPDATE native_staff_access_reconciliation SET enabled=1,generation=1").run();
    await reconcileNativeStaffAccess(environment());
    await db.prepare("UPDATE staff_users SET status='inactive' WHERE id='leaver'").run();
    await db.prepare("UPDATE native_staff_access_reconciliation SET generation=generation+1").run();
    for (let run = 0; run < 2; run++) expect(await reconcileNativeStaffAccess(environment())).toEqual({ status: "applied", members: 1 });
    expect(group.include).toEqual([{ email: { email: "owner@example.test" } }]);
    expect(writes).toHaveLength(2);
  });
});
