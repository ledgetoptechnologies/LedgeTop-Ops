import { readFileSync, readdirSync } from "node:fs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { controlDeliveryNotificationBatch, listCombinedDeliveryNotifications, listDeliveryNotificationBatches, registerNotificationCenterRoutes } from "../src/worker/notification-center";
import * as native from "../src/worker/native-delivery-notification-center";
import { csrfToken, requireMutationSecurity } from "../src/worker/request-security";
import { requiresAdministratorForMutation } from "../src/worker/r2-crud-validation";
import type { Env, StaffPrincipal } from "../src/worker/types";

const staff: StaffPrincipal = { id: "staff", email: "staff@example.test", displayName: "Staff", accessSubject: "access-staff", projectAlphaUserId: null };
const requestKey = "notification-action-0001";

describe("folder notification center — real D1 authority and control receipts", () => {
  let mf: Miniflare, db: D1Database, ops: D1Database, env: Env;
  beforeAll(async () => {
    mf = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default { fetch(){return new Response('ok')} }", d1Databases: { DB: "notification-center", OPS: "notification-center-ops" } });
    db = await mf.getD1Database("DB") as unknown as D1Database;
    ops = await mf.getD1Database("OPS") as unknown as D1Database;
    const directory = new URL("../../client/migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) {
      const sql = readFileSync(new URL(name, directory), "utf8").replace(/\r\n/g, "\n").replace(/^\s*--.*$/gm, "");
      if (/\bCREATE\s+TRIGGER\b/i.test(sql)) await db.exec(sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " "));
      else {
        const statements = sql.split(/;\s*(?:\n|$)/).map(value => value.trim()).filter(value => value && !/^PRAGMA/i.test(value));
        if (name === "0103_client_portal_workspace.sql") await db.batch(statements.map(sql => db.prepare(sql)));
        else for (const statement of statements) await db.prepare(statement).run();
      }
    }
    await ops.exec(`CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,access_subject TEXT,project_alpha_user_id TEXT,status TEXT);
      CREATE TABLE pa_projects(id TEXT PRIMARY KEY,client_id TEXT,organization_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE project_folders(id TEXT PRIMARY KEY,project_id TEXT,division_id TEXT,r2_prefix TEXT UNIQUE);
      CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
      CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);`.replace(/\s*\n\s*/g, " "));
    env = { DELIVERY_DB: db, OPS_DB: ops, OPERATIONS_SESSION_SECRET: "notification-test-only-session-secret-0123456789", PUBLIC_BASE_URL: "https://ops.example.test" } as Env;
  }, 90_000);
  afterAll(async () => mf.dispose());
  beforeEach(async () => {
    vi.restoreAllMocks();
    for (const table of ["client_folder_notification_batch_controls", "client_folder_notification_batches", "client_accounts", "audit_log"])
      await db.prepare(`DELETE FROM ${table}`).run();
    await ops.batch([ops.prepare("DELETE FROM project_folders"), ops.prepare("DELETE FROM pa_projects"), ops.prepare("DELETE FROM staff_permission_overrides")]);
    await ops.prepare("INSERT OR REPLACE INTO staff_users VALUES(?,?,?,NULL,'active')").bind(staff.id,staff.email,staff.accessSubject).run();
    for (const permission of ["audit", "create", "revoke"])
      await ops.prepare("INSERT INTO staff_permission_overrides VALUES('staff',?,'allow','global',NULL)").bind(`delivery.share.${permission}`).run();
    await owner("a", "division-a");
  });

  async function owner(id: string, division: string) {
    await ops.batch([ops.prepare("INSERT INTO pa_projects(id,client_id,organization_id,active) VALUES(?,?,NULL,1)").bind(`project-${id}`, `client-${id}`),
      ops.prepare("INSERT INTO project_folders VALUES(?,?,?,?)").bind(`folder-${id}`, `project-${id}`, division, `Jobs/Clients/${id}/`)]);
    await db.batch([
      db.prepare("INSERT INTO client_accounts(project_alpha_source_id,id,display_name,status,project_alpha_client_id) VALUES ('project-alpha:primary',?,?,'active',?)").bind(id, `Client ${id}`, `client-${id}`),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES(?,?,'https://issuer.test',?,?)").bind(`identity-${id}`, id, `subject-${id}`, `${id}@example.test`),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES(?,?,'manager')").bind(id, `identity-${id}`),
      db.prepare("INSERT INTO client_folder_associations(id,scope_type,account_id,r2_prefix,logical_grant_id,division_id,created_by) VALUES(?,'client',?,?,?,?,'staff')")
        .bind(`association-${id}`, id, `Jobs/Clients/${id}/Delivery/`, `grant-${id}`, division),
      db.prepare("INSERT INTO client_folder_notification_preferences(logical_grant_id,account_id,recipient_identity_id,mode,updated_by) VALUES(?,?,?,'both','staff')")
        .bind(`grant-${id}`, id, `identity-${id}`),
    ]);
  }
  function batchStatement(id: string, account = "a", status = "pending") {
    return db.prepare(`INSERT INTO client_folder_notification_batches(id,account_id,logical_grant_id,recipient_identity_id,association_id,status,revision,added_count,removed_count,eligible_at,created_at)
      VALUES(?,?,?,?,?,?,7,40,2,datetime('now','+5 minutes'),'2026-08-25 12:00:00')`)
      .bind(id, account, `grant-${account}`, `identity-${account}`, `association-${account}`, status);
  }
  async function batch(id = "batch-a", account = "a", status = "pending") { await batchStatement(id, account, status).run(); }
  async function current() { return db.prepare("SELECT revision,status,attempt_count,eligible_at FROM client_folder_notification_batches WHERE id='batch-a'").first(); }
  const list = (query: Parameters<typeof listDeliveryNotificationBatches>[2] = {}, useEnv = env, actor = staff) => listDeliveryNotificationBatches(useEnv, actor, query);
  const control = (action: "cancel" | "send-now", revision = 7, key = requestKey, useEnv = env) => controlDeliveryNotificationBatch(useEnv, staff, "batch-a", action, revision, key);
  async function count(table: string) { return db.prepare(`SELECT COUNT(*) count FROM ${table}`).first<number>("count"); }

  it("returns bounded public presentation, not paths, authority IDs or provider errors", async () => {
    await batch();
    await db.prepare("UPDATE client_folder_notification_batches SET last_error='secret SMTP recipient and token'").run();
    const page = await list();
    expect(page.coverage).toBe("legacy_folder_changes");
    expect(page.items).toMatchObject([{ id: "batch-a", revision: 7, accountName: "Client a", folderLabel: "Delivery", recipientEmail: "a@example.test",
      addedCount: 40, removedCount: 2, errorCode: "delivery-attempt-failed", canSendNow: true, canCancel: true }]);
    expect(JSON.stringify(page)).not.toMatch(/Jobs\/|client-a|grant-a|identity-a|SMTP|lease_token/);
    expect(page.nextCursor).toBeNull();
  });
  it("does not let a division-specific deny hide authorized divisions", async () => {
    await owner("b", "division-b"); await batch(); await batch("batch-b", "b");
    await ops.prepare("INSERT INTO staff_permission_overrides VALUES('staff','delivery.share.audit','deny','division','division-a')").run();
    expect((await list()).items.map(row => row.id)).toEqual(["batch-b"]);
    await expect(control("cancel")).rejects.toMatchObject({ status: 404 });
  });
  it("rejects a global deny even when allowed locally", async () => {
    await batch();
    await ops.prepare("INSERT INTO staff_permission_overrides VALUES('staff','delivery.share.audit','deny','global',NULL)").run();
    await expect(list()).rejects.toMatchObject({ status: 403 });
  });
  it("uses current longest-prefix ownership rather than the stored grant division", async () => {
    await batch();
    expect((await list()).items).toHaveLength(1);
    await ops.prepare("UPDATE pa_projects SET client_id='someone-else'").run();
    expect((await list()).items).toEqual([]);
    await expect(control("send-now")).rejects.toMatchObject({ status: 404 });
  });
  it.each(["identity", "grant", "preference"])("does not offer send for revoked %s, while keeping auditable history", async kind => {
    await batch();
    await db.prepare(kind === "identity" ? "UPDATE client_identity_links SET revoked_at=datetime('now')"
      : kind === "grant" ? "UPDATE client_folder_associations SET revoked_at=datetime('now')" : "UPDATE client_folder_notification_preferences SET mode='off'").run();
    expect((await list()).items[0]).toMatchObject({ canSendNow: false, canCancel: true });
    await expect(control("send-now")).rejects.toMatchObject({ status: 409 });
    expect(await control("cancel")).toMatchObject({ status: "cancelled" });
  });
  it("separates pending/history and searches literal client, leaf-folder and recipient text", async () => {
    await batch(); await batch("sent", "a", "sent");
    expect((await list({ q: "DELIVERY" })).items.map(row => row.id)).toEqual(["batch-a"]);
    expect((await list({ q: "a@example.test", view: "history" })).items.map(row => row.id)).toEqual(["sent"]);
    expect((await list({ q: "%" })).items).toEqual([]);
    expect((await list({ q: "Jobs/Clients" })).items).toEqual([]);
    await expect(list({ view: "all" })).rejects.toMatchObject({ status: 400 });
    await expect(list({ q: "x".repeat(201) })).rejects.toMatchObject({ status: 400 });
    await expect(list({ q: "İ".repeat(200) })).rejects.toMatchObject({ status: 400 });
  });
  it("advances past an empty unauthorized scan without exposing the candidate boundary", async () => {
    await owner("b", "division-b");
    await ops.prepare("INSERT INTO staff_permission_overrides VALUES('staff','delivery.share.audit','deny','division','division-b')").run();
    const statements = Array.from({ length: 100 }, (_, index) => batchStatement(`z-${String(index).padStart(3,"0")}`, "b", "processing"));
    statements.push(batchStatement("a-visible")); await db.batch(statements);
    const first = await list(); expect(first.items).toEqual([]); expect(first.nextCursor).toBeTypeOf("string");
    // Ciphertext can coincidentally contain any short base64url substring.
    // Verify authenticated encryption, not the absence of two random letters.
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    const [ivPart, bodyPart] = first.nextCursor!.split(".");
    const decode = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));
    const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`notification-center:v1:${env.OPERATIONS_SESSION_SECRET}`));
    const key = await crypto.subtle.importKey("raw", material, "AES-GCM", false, ["decrypt"]);
    const encryption = { name: "AES-GCM", iv: decode(ivPart!), additionalData: new TextEncoder().encode(staff.id) };
    const decrypted = await crypto.subtle.decrypt(encryption, key, decode(bodyPart!));
    expect(JSON.parse(new TextDecoder().decode(decrypted)).after).toEqual(["2026-08-25 12:00:00", "z-000"]);
    const wrongKey = await crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["decrypt"]);
    await expect(crypto.subtle.decrypt(encryption, wrongKey, decode(bodyPart!))).rejects.toThrow();
    const second = await list({ cursor: first.nextCursor! });
    expect(second.items.map(row => row.id)).toEqual(["a-visible"]); expect(second.nextCursor).toBeNull();
  }, 15_000);
  it("pages after the last examined row, preserving a 26th visible result", async () => {
    await db.batch(Array.from({ length: 26 }, (_, index) => batchStatement(`row-${String(index).padStart(2,"0")}`, "a", "processing")));
    const first = await list(); const second = await list({ cursor: first.nextCursor! });
    expect(first.items).toHaveLength(25); expect(second.items).toHaveLength(1);
    expect(new Set([...first.items,...second.items].map(row => row.id)).size).toBe(26);
  }, 15_000);
  it("binds encrypted cursors to actor, search, view and permission snapshot", async () => {
    await db.batch(Array.from({ length: 26 }, (_, index) => batchStatement(`row-${index}`, "a", "processing")));
    const cursor = (await list()).nextCursor!;
    await expect(list({ cursor: `${cursor}x` })).rejects.toMatchObject({ status: 400 });
    await expect(list({ cursor, q: "new" })).rejects.toMatchObject({ status: 409 });
    await expect(list({ cursor, view: "history" })).rejects.toMatchObject({ status: 409 });
    await ops.prepare("INSERT INTO staff_permission_overrides SELECT 'other',permission_key,effect,scope,division_id FROM staff_permission_overrides").run();
    await expect(list({ cursor }, env, { ...staff, id: "other" })).rejects.toMatchObject({ status: 400 });
    await ops.prepare("DELETE FROM staff_permission_overrides WHERE permission_key='delivery.share.create'").run();
    await expect(list({ cursor })).rejects.toMatchObject({ status: 409 });
  }, 15_000);
  it("makes a pending notice eligible, preserving attempt budget and recording one audit receipt", async () => {
    await batch(); await db.prepare("UPDATE client_folder_notification_batches SET attempt_count=2").run();
    expect(await control("send-now")).toMatchObject({ revision: 8, status: "pending", replayed: false });
    expect(await current()).toMatchObject({ revision: 8, status: "pending", attempt_count: 2 });
    expect(await db.prepare("SELECT eligible_at<=datetime('now') due FROM client_folder_notification_batches").first("due")).toBe(1);
    expect(await count("client_folder_notification_batch_controls")).toBe(1);
    expect(await db.prepare("SELECT action FROM audit_log").first("action")).toBe("client.folder.notification.send_requested");
  });
  it("cancels only the notice and replays the same receipt without extra writes", async () => {
    await batch();
    const first = await control("cancel"); const replay = await control("cancel");
    expect(first).toMatchObject({ revision: 8, status: "cancelled", replayed: false });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(await count("audit_log")).toBe(1); expect(await count("client_folder_associations")).toBe(1);
    expect(await db.prepare("SELECT revoked_at FROM client_folder_associations").first("revoked_at")).toBeNull();
    await expect(control("send-now")).rejects.toMatchObject({ status: 409 });
  });
  it.each(["processing", "sent", "failed", "cancelled", "suppressed"])("does not control %s notices or write orphan receipts", async status => {
    await batch("batch-a", "a", status);
    await expect(control("cancel")).rejects.toMatchObject({ status: 409 });
    expect(await count("client_folder_notification_batch_controls")).toBe(0); expect(await count("audit_log")).toBe(0);
  });
  it("rejects stale revision, exhausted retry and missing action scope", async () => {
    await batch(); await expect(control("cancel", 6)).rejects.toMatchObject({ status: 409 });
    await db.prepare("UPDATE client_folder_notification_batches SET attempt_count=3").run();
    await expect(control("send-now")).rejects.toMatchObject({ status: 409 });
    await ops.prepare("DELETE FROM staff_permission_overrides WHERE permission_key='delivery.share.revoke'").run();
    expect((await list()).items[0]).toMatchObject({ canSendNow: false, canCancel: false });
    await expect(control("cancel")).rejects.toMatchObject({ status: 404 });
  });
  it("deduplicates concurrent clicks atomically", async () => {
    await batch();
    const outcomes = await Promise.all([control("cancel"), control("cancel")]);
    expect(outcomes.map(row => row.revision)).toEqual([8,8]);
    expect(outcomes.map(row => row.replayed).sort()).toEqual([false,true]);
    expect(await count("audit_log")).toBe(1); expect(await count("client_folder_notification_batch_controls")).toBe(1);
  });
  it("rolls back status and receipt if the audit insert fails", async () => {
    await batch();
    await db.exec("CREATE TRIGGER reject_notification_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'test-audit-unavailable'); END;");
    try {
      await expect(control("cancel")).rejects.toThrow();
      expect(await current()).toMatchObject({ revision: 7, status: "pending" });
      expect(await count("client_folder_notification_batch_controls")).toBe(0);
    } finally { await db.exec("DROP TRIGGER reject_notification_audit;"); }
  });
  it("refuses receipt replay after authority is revoked", async () => {
    await batch(); await control("cancel");
    await ops.prepare("UPDATE pa_projects SET client_id='new-owner'").run();
    await expect(control("cancel")).rejects.toMatchObject({ status: 404 });
    expect(await count("audit_log")).toBe(1);
  });
  it("fails closed across a worker claim immediately before the control transaction", async () => {
    await batch();
    const raceDb = new Proxy(db, { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        await db.prepare("UPDATE client_folder_notification_batches SET status='processing',revision=revision+1").run();
        return db.batch(statements);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    }});
    await expect(control("cancel", 7, requestKey, { ...env, DELIVERY_DB: raceDb })).rejects.toMatchObject({ status: 409 });
    expect(await count("client_folder_notification_batch_controls")).toBe(0); expect(await count("audit_log")).toBe(0);
  });
  it("checks authority again after a committed action, retaining its receipt on an uncertain result", async () => {
    await batch();
    const raceDb = new Proxy(db, { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const result = await db.batch(statements);
        await ops.prepare("UPDATE pa_projects SET client_id='new-owner'").run();
        return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    }});
    await expect(control("cancel", 7, requestKey, { ...env, DELIVERY_DB: raceDb })).rejects.toMatchObject({ status: 409 });
    expect(await current()).toMatchObject({ status: "cancelled", revision: 8 });
    expect(await count("client_folder_notification_batch_controls")).toBe(1);
  });
  it("reports schema readiness failure rather than an empty page", async () => {
    await db.exec("ALTER TABLE client_folder_notification_batch_controls RENAME TO pending_control_upgrade;");
    try { await expect(list()).rejects.toMatchObject({ status: 503 }); }
    finally { await db.exec("ALTER TABLE pending_control_upgrade RENAME TO client_folder_notification_batch_controls;"); }
  });

  // These tests exercise the real legacy D1 feed and the unified API/merge.
  // Native audience/claim/migration correctness has its own real-D1 suite.
  function nativeFeed(ids: string[], visible = true) {
    type NativeRow = Awaited<ReturnType<typeof native.nativeNotificationCandidates>>[number];
    const rows = ids.map(id => ({ id, scopeKey: id, createdAt: "2026-08-25T12:00:00.000Z", status: "processing" } as NativeRow));
    vi.spyOn(native,"nativeDeliveryNotificationsReady").mockResolvedValue(true);
    const candidates = vi.spyOn(native,"nativeNotificationCandidates").mockImplementation(async (_env,_view,after,limit=101) =>
      rows.filter(row => !after || row.createdAt<after[0] || (row.createdAt===after[0] && row.id<after[1]))
        .sort((a,b)=>a.id===b.id?0:a.id>b.id?-1:1).slice(0,limit));
    vi.spyOn(native,"readNativeDeliveryNotificationScope").mockResolvedValue(visible ? {
      divisionId:"division-a",sourceId:"project-alpha:primary",sourceName:"Primary Alpha",workspaceId:"workspace-a",
      workspaceName:"Native workspace",folderLabel:"Delivery",recipientEmail:null,contextProof:"fixed-scope-proof",
    } : null);
    vi.spyOn(native,"presentNativeDeliveryNotification").mockImplementation((row,scope) => ({
      kind:"portal_delivery",id:row.id,revision:1,status:"processing",eligibleAt:row.createdAt,createdAt:row.createdAt,
      updatedAt:row.createdAt,deliveredAt:null,errorCode:null,canSendNow:false,canCancel:false,sourceName:scope.sourceName,
      workspaceName:scope.workspaceName,eventLabel:"Delivery available",folderLabel:scope.folderLabel,recipientEmail:null,deliveryMode:"staged",
    }));
    return { candidates };
  }

  it("merges typed native and folder feeds with stable per-feed cursors even at identical timestamps", async () => {
    nativeFeed(Array.from({length:26},(_,i)=>`nb_${String(i).padStart(3,"0")}`));
    await db.batch(Array.from({length:26},(_,i)=>batchStatement(`nb_${String(i).padStart(3,"0")}`,"a","processing")));
    const items: Array<{kind:string;id:string}> = [];
    let cursor: string|undefined;
    for (let page=0;page<3;page+=1) {
      const result=await listCombinedDeliveryNotifications(env,staff,{cursor});
      expect(result.coverage).toBe("delivery_notifications_v2");
      expect(result.availability).toEqual({folderChanges:true,nativeDeliveries:true});
      expect(result.items.length).toBeLessThanOrEqual(25);
      items.push(...result.items);
      cursor=result.nextCursor??undefined;
    }
    expect(cursor).toBeUndefined();
    expect(items).toHaveLength(52);
    expect(new Set(items.map(row=>`${row.kind}:${row.id}`)).size).toBe(52);
    expect(items.slice(0,26).every(row=>row.kind==="portal_delivery")).toBe(true);
    expect(items.slice(26).every(row=>row.kind==="folder_changes")).toBe(true);
  },30_000);

  it("advances a bounded unauthorized native scan without hiding the next legacy page",async()=>{
    const {candidates}=nativeFeed(Array.from({length:51},(_,i)=>`nb_${String(i).padStart(3,"0")}`),false);
    await batch("legacy-visible");
    const first=await listCombinedDeliveryNotifications(env,staff,{});
    expect(first.items).toEqual([]);expect(first.nextCursor).toBeTypeOf("string");
    const next=await listCombinedDeliveryNotifications(env,staff,{cursor:first.nextCursor!});
    expect(next.items.map(row=>row.id)).toEqual(["legacy-visible"]);expect(next.nextCursor).toBeNull();
    expect(candidates.mock.calls[0]?.[3]).toBe(51);
    expect(candidates.mock.calls[1]?.[2]).toEqual(["2026-08-25T12:00:00.000Z","nb_001"]);
  },15_000);

  it("reports unavailable native coverage and invalidates a cursor when its upgrade state changes",async()=>{
    nativeFeed([]);
    await db.batch(Array.from({length:26},(_,i)=>batchStatement(`row-${i}`,"a","processing")));
    vi.spyOn(native,"nativeDeliveryNotificationsReady").mockResolvedValue(false);
    const page=await listCombinedDeliveryNotifications(env,staff,{});
    expect(page.availability).toEqual({folderChanges:true,nativeDeliveries:false});
    expect(native.nativeNotificationCandidates).not.toHaveBeenCalled();
    vi.spyOn(native,"nativeDeliveryNotificationsReady").mockResolvedValue(true);
    await expect(listCombinedDeliveryNotifications(env,staff,{cursor:page.nextCursor!})).rejects.toMatchObject({status:409});
  },15_000);

  it("binds combined cursors to actor, filters and current authority",async()=>{
    nativeFeed(Array.from({length:26},(_,i)=>`nb_${String(i).padStart(3,"0")}`));
    const cursor=(await listCombinedDeliveryNotifications(env,staff,{})).nextCursor!;
    await expect(listCombinedDeliveryNotifications(env,staff,{cursor:`${cursor}x`})).rejects.toMatchObject({status:400});
    for (const query of [{q:"other"},{view:"history"}])
      await expect(listCombinedDeliveryNotifications(env,staff,{cursor,...query})).rejects.toMatchObject({status:409});
    await ops.prepare("INSERT INTO staff_permission_overrides SELECT 'other',permission_key,effect,scope,division_id FROM staff_permission_overrides").run();
    await ops.prepare("INSERT OR REPLACE INTO staff_users VALUES('other',?,?,NULL,'active')").bind(staff.email,staff.accessSubject).run();
    await expect(listCombinedDeliveryNotifications(env,{...staff,id:"other"},{cursor})).rejects.toMatchObject({status:400});
    await ops.prepare("DELETE FROM staff_permission_overrides WHERE permission_key='delivery.share.create'").run();
    await expect(listCombinedDeliveryNotifications(env,staff,{cursor})).rejects.toMatchObject({status:409});
  },15_000);

  it("checks current native scope again before returning a selected row",async()=>{
    nativeFeed(["nb_a"]);
    vi.spyOn(native,"readNativeDeliveryNotificationScope").mockResolvedValueOnce({
      divisionId:"division-a",sourceId:"project-alpha:primary",sourceName:"Alpha",workspaceId:"workspace-a",
      workspaceName:"Workspace",folderLabel:"Delivery",recipientEmail:null,contextProof:"before",
    }).mockResolvedValue(null);
    await expect(listCombinedDeliveryNotifications(env,staff,{})).rejects.toMatchObject({status:409});
  });
  it.each(["status='suspended'","access_subject='rebound'","email='changed@example.test'","project_alpha_user_id='another-user'"])("rechecks active staff identity after combined hydration (%s)",async change=>{
    nativeFeed(["nb_a"]);
    const readScope=vi.mocked(native.readNativeDeliveryNotificationScope).getMockImplementation()!;
    vi.spyOn(native,"readNativeDeliveryNotificationScope").mockImplementationOnce(async(...args)=>{
      const scope=await readScope(...args);
      await ops.prepare(`UPDATE staff_users SET ${change} WHERE id='staff'`).run();
      return scope;
    });
    await expect(listCombinedDeliveryNotifications(env,staff,{})).rejects.toMatchObject({status:403});
  });

  function app() {
    const result = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
    result.use("/api/*", async (c, next) => {
      c.set("principal", staff);
      c.set("administrator", false);
      if (["POST","PUT","PATCH","DELETE"].includes(c.req.method)) {
        if (requiresAdministratorForMutation(c.req.method, c.req.path)) throw new HTTPException(403);
        await requireMutationSecurity(c.req.raw, c.env, staff);
      }
      await next();
    });
    registerNotificationCenterRoutes(result);
    return result;
  }
  it("enforces real origin/CSRF checks with the narrowly delegated staff route", async () => {
    await batch();
    const target = app(), url = "https://ops.example.test/api/notifications/deliveries/batch-a/cancel";
    const headers = { "Content-Type": "application/json", "Idempotency-Key": requestKey, Origin: env.PUBLIC_BASE_URL, "X-CSRF-Token": await csrfToken(env,staff) };
    expect((await target.request(url, { method: "POST", headers: { ...headers, Origin: "https://evil.test" }, body: '{"expectedRevision":7}' }, env)).status).toBe(403);
    expect((await target.request(url, { method: "POST", headers: { ...headers, "X-CSRF-Token": "bad" }, body: '{"expectedRevision":7}' }, env)).status).toBe(403);
    expect((await target.request(url, { method: "POST", headers, body: '{"expectedRevision":7}' }, env)).status).toBe(200);
  });
  it.each([['{"expectedRevision":7,"recipient":"other@example.test"}',400],['{"expectedRevision":7.5}',400],["x".repeat(1025),413]])("rejects malformed or excessive action body (%s)", async (body,status) => {
    await batch();
    const response = await app().request("https://ops.example.test/api/notifications/deliveries/batch-a/cancel", { method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": requestKey, Origin: env.PUBLIC_BASE_URL, "X-CSRF-Token": await csrfToken(env,staff) }, body: String(body) }, env);
    expect(response.status).toBe(status); expect(await current()).toMatchObject({ revision: 7, status: "pending" });
  });
  it("does not exempt unknown notification routes or methods from the administrator gate", () => {
    for (const action of ["cancel","send-now"]) expect(requiresAdministratorForMutation("POST",`/api/notifications/deliveries/batch-a/${action}`)).toBe(false);
    for (const path of ["/api/notifications/deliveries/batch-a/retry","/api/notifications/deliveries/batch-a/cancel/extra","/api/notifications/deliveries/a%2Fb/cancel","/api/notifications/settings"])
      expect(requiresAdministratorForMutation("POST",path)).toBe(true);
    for (const method of ["DELETE","PATCH","PUT"]) expect(requiresAdministratorForMutation(method,"/api/notifications/deliveries/batch-a/cancel")).toBe(true);
  });
  it("delegates only staged native controls, never direct legacy notices or a different kind",()=>{
    for(const action of ["cancel","send-now"])
      expect(requiresAdministratorForMutation("POST",`/api/notifications/deliveries/portal_delivery/nb_a/${action}`)).toBe(false);
    for(const path of ["portal_delivery/nd_a/cancel","portal_delivery/nb_a/retry","portal_delivery/nb_a/cancel/extra","other/nb_a/cancel","portal_delivery/nb_a%2Fb/cancel"])
      expect(requiresAdministratorForMutation("POST",`/api/notifications/deliveries/${path}`)).toBe(true);
    for(const method of ["PUT","PATCH","DELETE"])
      expect(requiresAdministratorForMutation(method,"/api/notifications/deliveries/portal_delivery/nb_a/cancel")).toBe(true);
  });
  it("rejects ambiguous combined list/detail queries and retains the legacy list contract",async()=>{
    nativeFeed([]);await batch();
    const target=app(),url="https://ops.example.test/api/notifications/deliveries";
    expect(await (await target.request(url,{},env)).json()).toMatchObject({coverage:"legacy_folder_changes"});
    const combined=await target.request(`${url}?format=combined`,{},env);
    expect(combined.headers.get("Cache-Control")).toBe("no-store");
    expect(await combined.json()).toMatchObject({coverage:"delivery_notifications_v2"});
    for(const query of ["format=old","format=combined&format=combined","view=pending&view=history","q=a&q=b","kind=portal_delivery"])
      expect((await target.request(`${url}?${query}`,{},env)).status).toBe(400);
    expect((await target.request(`${url}/portal_delivery/nb_a?kind=folder_changes`,{},env)).status).toBe(400);
  });
  it("uses native typed endpoints behind origin/CSRF checks without dispatching the legacy control",async()=>{
    const controlNative=vi.spyOn(native,"controlNativeDeliveryNotification").mockResolvedValue({
      ok:true,id:"nb_a",action:"cancel",revision:8,status:"cancelled",replayed:false,
    });
    const target=app(),url="https://ops.example.test/api/notifications/deliveries/portal_delivery/nb_a/cancel";
    const headers={"Content-Type":"application/json","Idempotency-Key":requestKey,Origin:env.PUBLIC_BASE_URL,"X-CSRF-Token":await csrfToken(env,staff)};
    for(const override of [{Origin:"https://evil.test"},{"X-CSRF-Token":"bad"}])
      expect((await target.request(url,{method:"POST",headers:{...headers,...override},body:'{"expectedRevision":7}'},env)).status).toBe(403);
    expect(controlNative).not.toHaveBeenCalled();
    const response=await target.request(url,{method:"POST",headers,body:'{"expectedRevision":7}'},env);
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({kind:"portal_delivery",id:"nb_a",status:"cancelled"});
    expect(controlNative).toHaveBeenCalledTimes(1);
    const called=controlNative.mock.calls[0]!;
    // Avoid deep-inspecting Miniflare's RPC-backed binding proxies in matchers.
    expect(called[0].DELIVERY_DB===env.DELIVERY_DB).toBe(true);
    expect(called[1]).toEqual(staff);
    expect(called.slice(2)).toEqual(["nb_a","cancel",7,requestKey]);
    expect(await count("client_folder_notification_batch_controls")).toBe(0);
  });
});
