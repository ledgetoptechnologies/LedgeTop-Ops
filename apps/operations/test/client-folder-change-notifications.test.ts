import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordClientFolderFileChange } from "../src/worker/client-folder-grants";

describe("client folder change notification debounce", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: any;

  beforeAll(async () => {
    miniflare = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default { fetch() { return new Response('ok'); } };", d1Databases: { DB: "folder-change" } });
    db = await miniflare.getD1Database("DB") as unknown as D1Database;
    await db.exec(`CREATE TABLE client_accounts(id TEXT PRIMARY KEY);
      CREATE TABLE client_identity_links(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,UNIQUE(id,account_id));
      CREATE TABLE client_folder_associations(id TEXT PRIMARY KEY,scope_type TEXT,project_id TEXT,account_id TEXT,r2_prefix TEXT,logical_grant_id TEXT,revoked_at TEXT);`);
    const migration = readFileSync(new URL("../../client/migrations/0115_client_workspace_notifications.sql", import.meta.url), "utf8");
    for (const statement of migration.split(/;\s*(?:\r?\n|$)/)
      .map(value => value.split(/\r?\n/).filter(line => !line.trim().startsWith("--")).join("\n").trim())
      .filter(value => value && !value.startsWith("PRAGMA"))) await db.prepare(statement).run();
    await db.batch([
      db.prepare("INSERT INTO client_accounts VALUES('account-a')"),
      db.prepare("INSERT INTO client_identity_links VALUES('identity-a','account-a')"),
      db.prepare("INSERT INTO client_folder_associations VALUES('association-a','client',NULL,'account-a','Jobs/Clients/Acme/','grant-a',NULL)"),
      db.prepare("INSERT INTO client_folder_notification_preferences(logical_grant_id,account_id,recipient_identity_id,mode,updated_by) VALUES('grant-a','account-a','identity-a','both','staff-a')"),
    ]);
    env = { DELIVERY_DB: db };
  });

  afterAll(async () => miniflare.dispose());

  it("waits five minutes and cancels an opposite event for the same scoped object", async () => {
    expect(await recordClientFolderFileChange(env, "Jobs/Clients/Acme/photo.jpg", true)).toBe(1);
    const pending = await db.prepare("SELECT status,datetime(next_attempt_at)>datetime('now') delayed,r2_key FROM client_folder_change_notifications").first<any>();
    expect(pending).toMatchObject({ status: "pending", delayed: 1, r2_key: "Jobs/Clients/Acme/photo.jpg" });
    expect(await recordClientFolderFileChange(env, "Jobs/Clients/Acme/photo.jpg", false)).toBe(1);
    expect(await db.prepare("SELECT status FROM client_folder_change_notifications").first("status")).toBe("cancelled");
    expect(await db.prepare("SELECT COUNT(*) count FROM client_portal_notifications").first("count")).toBe(0);
  });

  it("does not enqueue an event outside the granted prefix", async () => {
    expect(await recordClientFolderFileChange(env, "Jobs/Clients/Other/private.jpg", true)).toBe(0);
  });
});
