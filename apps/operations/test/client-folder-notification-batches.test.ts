import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";

const mocks = vi.hoisted(() => ({ send: vi.fn(), alert: vi.fn() }));
vi.mock("../src/worker/mailer", () => ({ sendNotificationMail: mocks.send }));
vi.mock("../src/worker/alerts", () => ({ sendAdminAlert: mocks.alert }));
import { adoptLegacyClientFolderNotifications, authorizeClientFolderNotificationBatch,
  processClientFolderNotificationBatches, readClientFolderNotificationBatchScope,
  recordClientFolderBatchChange } from "../src/worker/client-folder-notification-batches";

describe("durable client folder notification batches", () => {
  let mf: Miniflare;
  let db: D1Database;
  let ops: D1Database;
  let env: Env;
  type UpgradeSnapshot = { account: Record<string, unknown> | null; identity: Record<string, unknown> | null;
    grant: Record<string, unknown> | null; pending: Record<string, unknown> | null };
  let upgradeBefore: UpgradeSnapshot | null = null;
  let upgradeAfter: UpgradeSnapshot | null = null;
  let upgradeForeignKeyViolations: unknown[] = [];
  let upgradeBatchCount: number | null = null;
  let upgradeInboxCount: number | null = null;
  const prefix = "Jobs/Clients/Acme/Delivery/";
  const identity = { id: "unused", account_id: "a", logical_grant_id: "g", association_id: "association", recipient_identity_id: "i" };

  beforeAll(async () => {
    mf = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default { fetch(){return new Response('ok')} }", d1Databases: { DB: "notification-batches", OPS: "notification-batches-ops" } });
    db = await mf.getD1Database("DB") as unknown as D1Database;
    ops = await mf.getD1Database("OPS") as unknown as D1Database;
    const upgradeSnapshot = async (): Promise<UpgradeSnapshot> => ({
      account: await db.prepare("SELECT * FROM client_accounts WHERE id='upgrade-account'").first<Record<string, unknown>>(),
      identity: await db.prepare("SELECT * FROM client_identity_links WHERE id='upgrade-identity'").first<Record<string, unknown>>(),
      grant: await db.prepare("SELECT * FROM client_folder_associations WHERE id='upgrade-association'").first<Record<string, unknown>>(),
      pending: await db.prepare("SELECT * FROM client_folder_change_notifications WHERE id='upgrade-pending'").first<Record<string, unknown>>(),
    });
    // Exercise the production upgrade chain, including pre-existing rows/FKs.
    const directory = new URL("../../client/migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) {
      if (name === "0153_client_folder_notification_batches.sql") {
        // Populate the actual pre-upgrade schema before either new migration.
        await db.batch([
          db.prepare("INSERT INTO client_accounts(id,display_name,status,project_alpha_client_id) VALUES('upgrade-account','Existing upgrade client','active','upgrade-client')"),
          db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES('upgrade-identity','upgrade-account','https://issuer.test','upgrade-subject','upgrade@example.test')"),
          db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES('upgrade-account','upgrade-identity','manager')"),
          db.prepare("INSERT INTO client_folder_associations(id,scope_type,account_id,r2_prefix,logical_grant_id,division_id,created_by) VALUES('upgrade-association','client','upgrade-account','Jobs/Clients/Upgrade/','upgrade-grant','upgrade-division','staff')"),
          db.prepare("INSERT INTO client_folder_notification_preferences(logical_grant_id,account_id,recipient_identity_id,mode,updated_by) VALUES('upgrade-grant','upgrade-account','upgrade-identity','both','staff')"),
          db.prepare(`INSERT INTO client_folder_change_notifications(id,logical_grant_id,association_id,account_id,recipient_identity_id,
            object_fingerprint,r2_key,baseline_present,current_present,attempt_count,created_at)
            VALUES('upgrade-pending','upgrade-grant','upgrade-association','upgrade-account','upgrade-identity',?,
              'Jobs/Clients/Upgrade/photo.jpg',0,1,1,'2026-08-20 12:00:00')`).bind("c".repeat(64)),
        ]);
        upgradeBefore = await upgradeSnapshot();
      }
      const sql = readFileSync(new URL(name, directory), "utf8").replace(/\r\n/g, "\n").replace(/^\s*--.*$/gm, "");
      if (/\bCREATE\s+TRIGGER\b/i.test(sql)) {
        await db.exec(sql.replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " "));
      } else {
        const statements = sql.split(/;\s*(?:\n|$)/).map(value => value.trim()).filter(value => value && !/^PRAGMA/i.test(value));
        if (name === "0103_client_portal_workspace.sql") await db.batch(statements.map(sql => db.prepare(sql)));
        else for (const statement of statements) await db.prepare(statement).run();
      }
    }
    upgradeAfter = await upgradeSnapshot();
    upgradeForeignKeyViolations = (await db.prepare("PRAGMA foreign_key_check").all()).results;
    upgradeBatchCount = await db.prepare("SELECT COUNT(*) count FROM client_folder_notification_batches").first<number>("count");
    upgradeInboxCount = await db.prepare("SELECT COUNT(*) count FROM client_portal_notifications").first<number>("count");
    await ops.exec("CREATE TABLE pa_projects(id TEXT PRIMARY KEY,client_id TEXT,organization_id TEXT,active INTEGER,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary'); CREATE TABLE project_folders(id TEXT PRIMARY KEY,project_id TEXT,division_id TEXT,r2_prefix TEXT UNIQUE);");
    env = { DELIVERY_DB: db, OPS_DB: ops, DELIVERY_BASE_URL: "https://client.example.test" } as Env;
  }, 60_000);
  afterAll(async () => mf.dispose());

  beforeEach(async () => {
    mocks.send.mockReset().mockResolvedValue(undefined);
    mocks.alert.mockReset().mockResolvedValue(undefined);
    for (const table of ["client_folder_notification_batches", "client_folder_notification_object_state", "client_folder_change_notifications", "client_portal_notifications",
      "client_folder_notification_preferences", "client_folder_associations", "client_account_members", "client_identity_links", "client_accounts", "file_index"]) {
      await db.prepare(`DELETE FROM ${table}`).run();
    }
    await ops.batch([ops.prepare("DELETE FROM project_folders"), ops.prepare("DELETE FROM pa_projects"),
      ops.prepare("INSERT INTO pa_projects(id,client_id,organization_id,active) VALUES('p','client-a','org-a',1)"),
      ops.prepare("INSERT INTO project_folders VALUES('folder','p','division-a','Jobs/Clients/Acme/')")]);
    await db.batch([
      db.prepare("INSERT INTO client_accounts(project_alpha_source_id,id,display_name,status,project_alpha_client_id,project_alpha_organization_id) VALUES ('project-alpha:primary','a','Acme','active','client-a','org-a')"),
      db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES('i','a','https://issuer.test','subject','recipient@example.test')"),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES('a','i','manager')"),
      db.prepare("INSERT INTO client_folder_associations(id,scope_type,account_id,r2_prefix,logical_grant_id,division_id,created_by) VALUES('association','client','a',?,'g','division-a','staff')").bind(prefix),
      db.prepare("INSERT INTO client_folder_notification_preferences(logical_grant_id,account_id,recipient_identity_id,mode,updated_by) VALUES('g','a','i','both','staff')"),
    ]);
  });

  async function event(name: string, present = true) {
    const key = `${prefix}${name}`;
    if (present) await db.prepare("INSERT OR REPLACE INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,'etag',10,datetime('now'),'image/jpeg','image')").bind(key).run();
    else await db.prepare("DELETE FROM file_index WHERE r2_key=?").bind(key).run();
    return recordClientFolderBatchChange(env, key, present);
  }
  async function due() { await db.prepare("UPDATE client_folder_notification_batches SET eligible_at=datetime('now','-1 minute') WHERE status='pending'").run(); }
  async function row() { return db.prepare("SELECT * FROM client_folder_notification_batches ORDER BY created_at,id LIMIT 1").first<Record<string, unknown>>(); }

  it("preserves populated legacy account, identity, grant and pending notification across migrations 0153 and 0154", () => {
    expect(upgradeBefore).not.toBeNull();
    expect(upgradeBefore?.account).toMatchObject({ id: "upgrade-account", display_name: "Existing upgrade client", status: "active" });
    expect(upgradeBefore?.pending).toMatchObject({ id: "upgrade-pending", status: "pending", attempt_count: 1, created_at: "2026-08-20 12:00:00" });
    expect(upgradeAfter).toEqual({ ...upgradeBefore, account: { ...upgradeBefore?.account, project_alpha_source_id: "project-alpha:primary" } });
    expect(upgradeForeignKeyViolations).toEqual([]);
    expect(upgradeBatchCount).toBe(0);
    expect(upgradeInboxCount).toBe(0);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("groups forty files into one inbox message and one email with exact counts", async () => {
    for (let index = 0; index < 40; index += 1) await event(`${index}.jpg`);
    expect(await db.prepare("SELECT COUNT(*) FROM client_folder_notification_batches").first("COUNT(*)")).toBe(1);
    expect(await row()).toMatchObject({ status: "pending", added_count: 40, removed_count: 0 });
    expect(await processClientFolderNotificationBatches(env)).toBe(0);
    await due();
    expect(await processClientFolderNotificationBatches(env)).toBe(1);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0]![1]).toMatchObject({ to: "recipient@example.test", text: expect.stringContaining("40 files added") });
    expect(await db.prepare("SELECT COUNT(*) FROM client_portal_notifications").first("COUNT(*)")).toBe(1);
    expect(await row()).toMatchObject({ status: "sent", attempt_count: 1 });
  }, 30_000);

  it("does not reset grace or revision on duplicate events, including after send", async () => {
    await event("photo.jpg");
    await due();
    const before = await row();
    expect(await event("photo.jpg")).toBe(0);
    expect(await row()).toEqual(before);
    await processClientFolderNotificationBatches(env);
    expect(await event("photo.jpg")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) FROM client_folder_notification_batches").first("COUNT(*)")).toBe(1);
  });

  it("cancels opposite events for added-only preferences and creates a new window for a real later add", async () => {
    await db.prepare("UPDATE client_folder_notification_preferences SET mode='added'").run();
    await event("photo.jpg");
    await event("photo.jpg", false);
    expect(await row()).toMatchObject({ status: "cancelled", added_count: 0, removed_count: 0 });
    expect(await event("photo.jpg", false)).toBe(0);
    await event("photo.jpg");
    await due();
    await processClientFolderNotificationBatches(env);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect a manually cancelled notification on duplicate events", async () => {
    await event("photo.jpg");
    await db.prepare("UPDATE client_folder_notification_batches SET status='cancelled',sealed_at=datetime('now'),revision=revision+1").run();
    expect(await event("photo.jpg")).toBe(0);
    await due(); await processClientFolderNotificationBatches(env);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("freezes a claimed batch and queues uploads during send in a separate successor", async () => {
    await event("first.jpg"); await due();
    mocks.send.mockImplementationOnce(async () => { await event("second.jpg"); });
    await processClientFolderNotificationBatches(env);
    const batches = await db.prepare("SELECT status,added_count FROM client_folder_notification_batches ORDER BY status").all();
    expect(batches.results).toEqual([{ status: "pending", added_count: 1 }, { status: "sent", added_count: 1 }]);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("retains sealed contents on retry, deduplicates inbox, and does not absorb new files", async () => {
    await event("first.jpg"); await due();
    mocks.send.mockRejectedValueOnce(new Error("private SMTP detail recipient@example.test"));
    await processClientFolderNotificationBatches(env);
    expect(await row()).toMatchObject({ status: "pending", attempt_count: 1, last_error: "notification-dispatch-failed", sealed_at: expect.any(String) });
    await event("second.jpg");
    expect(await db.prepare("SELECT COUNT(*) FROM client_folder_notification_batches").first("COUNT(*)")).toBe(2);
    await due(); await processClientFolderNotificationBatches(env);
    expect(await db.prepare("SELECT COUNT(*) FROM client_portal_notifications").first("COUNT(*)")).toBe(2);
  });

  it("does not send different content under the same message ID after an uncertain failure", async () => {
    await event("first.jpg"); await event("second.jpg"); await due();
    mocks.send.mockRejectedValueOnce(new Error("provider acceptance unknown"));
    await processClientFolderNotificationBatches(env);
    const original = await db.prepare("SELECT body FROM client_portal_notifications").first("body");
    await event("second.jpg", false);
    await db.prepare("UPDATE client_folder_notification_batches SET eligible_at=datetime('now','-1 minute') WHERE sealed_at IS NOT NULL").run();
    await processClientFolderNotificationBatches(env);
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT status,last_error FROM client_folder_notification_batches WHERE dispatch_fingerprint IS NOT NULL").first())
      .toMatchObject({ status: "suppressed", last_error: "published-summary-no-longer-current" });
    expect(await db.prepare("SELECT body FROM client_portal_notifications").first("body")).toBe(original);
  });

  it("uses a fixed SQL budget for one hundred subscribed recipients", async () => {
    const statements: D1PreparedStatement[] = [];
    for (let index = 1; index < 100; index += 1) {
      statements.push(db.prepare("INSERT INTO client_identity_links(id,account_id,issuer,subject,email) VALUES(?,'a','https://issuer.test',?,?)")
        .bind(`i${index}`, `subject${index}`, `recipient${index}@example.test`),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES('a',?,'member')").bind(`i${index}`),
      db.prepare("INSERT INTO client_folder_notification_preferences(logical_grant_id,account_id,recipient_identity_id,mode,updated_by) VALUES('g','a',?,'both','staff')").bind(`i${index}`));
    }
    await db.batch(statements);
    let prepared = 0;
    const measuredDb = { withSession() { return this; }, prepare(sql: string) { prepared += 1; return db.prepare(sql); },
      batch(statements: D1PreparedStatement[]) { return db.batch(statements); },
      exec(sql: string) { return db.exec(sql); }, dump() { return db.dump(); }, getBookmark() { return null; } };
    expect(await recordClientFolderBatchChange({ ...env, DELIVERY_DB: measuredDb } as Env, `${prefix}photo.jpg`, true)).toBe(100);
    expect(prepared).toBeLessThan(15);
    expect(await db.prepare("SELECT COUNT(*) FROM client_folder_notification_batches").first("COUNT(*)")).toBe(100);
  }, 30_000);

  it.each(["success", "failure"])("fences stale %s after lease ownership changes", async outcome => {
    await event("photo.jpg"); await due();
    mocks.send.mockImplementationOnce(async () => {
      await db.prepare("UPDATE client_folder_notification_batches SET lease_token='new-worker',revision=revision+1 WHERE status='processing'").run();
      if (outcome === "failure") throw new Error("old worker failed");
    });
    await processClientFolderNotificationBatches(env);
    expect(await row()).toMatchObject({ status: "processing", lease_token: "new-worker", last_error: null });
  });

  it("suppresses revoked eligibility, ownership changes, and net state no longer in the index", async () => {
    await event("photo.jpg"); await due();
    await ops.prepare("UPDATE pa_projects SET client_id='other-client'").run();
    await processClientFolderNotificationBatches(env);
    expect(await row()).toMatchObject({ status: "suppressed" });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT COUNT(*) FROM client_portal_notifications").first("COUNT(*)")).toBe(0);
  });

  it("retains history for a revoked recipient but does not authorize dispatch", async () => {
    await db.prepare("UPDATE client_identity_links SET revoked_at=datetime('now')").run();
    expect(await readClientFolderNotificationBatchScope(env, identity)).toMatchObject({ divisionId: "division-a", recipientEmail: null });
    expect(await authorizeClientFolderNotificationBatch(env, identity)).toBeNull();
    expect(await readClientFolderNotificationBatchScope(env, { ...identity, account_id: "forged" })).toBeNull();
  });

  it("uses the longest current folder owner and accepts legacy prefixes without trailing slash", async () => {
    await ops.prepare("UPDATE project_folders SET r2_prefix='Jobs/Clients/Acme'").run();
    expect(await authorizeClientFolderNotificationBatch(env, identity)).toMatchObject({ divisionId: "division-a" });
    await ops.batch([ops.prepare("INSERT INTO pa_projects(id,client_id,organization_id,active) VALUES('other','other-client',NULL,1)"),
      ops.prepare("INSERT INTO project_folders VALUES('nested','other','division-other',?)").bind(prefix)]);
    expect(await authorizeClientFolderNotificationBatch(env, identity)).toBeNull();
  });

  it("adopts old pending rows exactly once, preserving retry budget without invoking the old sender", async () => {
    await db.prepare(`INSERT INTO client_folder_change_notifications(id,logical_grant_id,association_id,account_id,recipient_identity_id,object_fingerprint,r2_key,baseline_present,current_present,attempt_count)
      VALUES('legacy','g','association','a','i',?, ?,0,1,2)`).bind("a".repeat(64), `${prefix}old.jpg`).run();
    expect(await adoptLegacyClientFolderNotifications(env)).toBe(1);
    expect(await adoptLegacyClientFolderNotifications(env)).toBe(0);
    expect(await row()).toMatchObject({ status: "pending", added_count: 1, attempt_count: 2 });
    expect(await db.prepare("SELECT status FROM client_folder_change_notifications WHERE id='legacy'").first("status")).toBe("suppressed");
  });

  it("never adopts an active legacy lease, but recovers it after expiry", async () => {
    await db.prepare(`INSERT INTO client_folder_change_notifications(id,logical_grant_id,association_id,account_id,recipient_identity_id,object_fingerprint,r2_key,baseline_present,current_present,status,lease_expires_at)
      VALUES('legacy','g','association','a','i',?, ?,0,1,'processing',datetime('now','+15 minutes'))`).bind("a".repeat(64), `${prefix}old.jpg`).run();
    expect(await adoptLegacyClientFolderNotifications(env)).toBe(0);
    await db.prepare("UPDATE client_folder_change_notifications SET lease_expires_at=datetime('now','-1 minute')").run();
    expect(await adoptLegacyClientFolderNotifications(env)).toBe(1);
  });

  it("does not let an older terminal observation hide an active legacy lease", async () => {
    const key = `${prefix}old.jpg`;
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`client-folder-object:${key}`));
    const hash = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
    await db.batch([
      db.prepare(`INSERT INTO client_folder_change_notifications(id,logical_grant_id,association_id,account_id,recipient_identity_id,object_fingerprint,r2_key,baseline_present,current_present,status)
        VALUES('older','g','association','a','i',?, ?,1,0,'sent')`).bind(hash, key),
      db.prepare(`INSERT INTO client_folder_change_notifications(id,logical_grant_id,association_id,account_id,recipient_identity_id,object_fingerprint,r2_key,baseline_present,current_present,status,lease_expires_at)
        VALUES('active','g','association','a','i',?, ?,0,1,'processing',datetime('now','+15 minutes'))`).bind(hash, key),
    ]);
    expect(await recordClientFolderBatchChange(env, key, true)).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) FROM client_folder_notification_object_state").first("COUNT(*)")).toBe(0);
    await db.prepare("UPDATE client_folder_change_notifications SET lease_expires_at=datetime('now','-1 minute') WHERE id='active'").run();
    expect(await adoptLegacyClientFolderNotifications(env)).toBe(1);
    expect(await row()).toMatchObject({ status: "pending", added_count: 1 });
  });

  it("adopts a current grant version into a successor rather than losing it behind an older open batch", async () => {
    await event("first.jpg");
    await db.batch([
      db.prepare("UPDATE client_folder_associations SET revoked_at=datetime('now'),superseded_by_id='association-v2' WHERE id='association'"),
      db.prepare("INSERT INTO client_folder_associations(id,scope_type,account_id,r2_prefix,logical_grant_id,grant_version,division_id,created_by) VALUES('association-v2','client','a',?,'g',2,'division-a','staff')").bind(prefix),
      db.prepare(`INSERT INTO client_folder_change_notifications(id,logical_grant_id,association_id,account_id,recipient_identity_id,object_fingerprint,r2_key,baseline_present,current_present)
        VALUES('legacy','g','association-v2','a','i',?, ?,0,1)`).bind("b".repeat(64), `${prefix}second.jpg`),
    ]);
    expect(await adoptLegacyClientFolderNotifications(env)).toBe(1);
    const batches = await db.prepare("SELECT association_id,status,added_count FROM client_folder_notification_batches ORDER BY association_id").all();
    expect(batches.results).toEqual([
      { association_id: "association", status: "suppressed", added_count: 1 },
      { association_id: "association-v2", status: "pending", added_count: 1 },
    ]);
  });

  it("does not suppress a newer grant batch when recipient selection becomes stale before the transaction", async () => {
    await event("first.jpg");
    async function replace(prior: string, next: string, version: number) {
      await db.batch([
        db.prepare("UPDATE client_folder_associations SET revoked_at=datetime('now'),superseded_by_id=? WHERE id=?").bind(next, prior),
        db.prepare("INSERT INTO client_folder_associations(id,scope_type,account_id,r2_prefix,logical_grant_id,grant_version,division_id,created_by) VALUES(?,'client','a',?,'g',?,'division-a','staff')").bind(next, prefix, version),
      ]);
    }
    await replace("association", "association-b", 2);
    let raced = false;
    const racingDb = { withSession() { return this; }, prepare(sql: string) { return db.prepare(sql); },
      async batch(statements: D1PreparedStatement[]) {
        if (!raced) {
          raced = true;
          await replace("association-b", "association-c", 3);
          await recordClientFolderBatchChange(env, `${prefix}current.jpg`, true);
        }
        return db.batch(statements);
      }, exec(sql: string) { return db.exec(sql); }, dump() { return db.dump(); }, getBookmark() { return null; } };
    expect(await recordClientFolderBatchChange({ ...env, DELIVERY_DB: racingDb } as Env, `${prefix}stale.jpg`, true)).toBe(0);
    expect(await db.prepare("SELECT status,added_count FROM client_folder_notification_batches WHERE association_id='association-c'").first())
      .toMatchObject({ status: "pending", added_count: 1 });
  });

  it("does not resurrect already-cancelled legacy changes on redelivered remove events", async () => {
    const key = `${prefix}removed.jpg`;
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`client-folder-object:${key}`));
    const hash = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
    await db.prepare(`INSERT INTO client_folder_change_notifications(id,logical_grant_id,association_id,account_id,recipient_identity_id,object_fingerprint,r2_key,baseline_present,current_present,status)
      VALUES('legacy','g','association','a','i',?, ?,0,0,'cancelled')`).bind(hash, key).run();
    expect(await recordClientFolderBatchChange(env, key, false)).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) FROM client_folder_notification_batches").first("COUNT(*)")).toBe(0);
  });

  it("closes an expired final attempt instead of leaving processing forever", async () => {
    await event("photo.jpg");
    await db.prepare("UPDATE client_folder_notification_batches SET status='processing',sealed_at=datetime('now'),attempt_count=3,lease_token='dead',lease_expires_at=datetime('now','-1 minute')").run();
    await processClientFolderNotificationBatches(env);
    expect(await row()).toMatchObject({ status: "failed", lease_token: null, last_error: "attempts-exhausted" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
