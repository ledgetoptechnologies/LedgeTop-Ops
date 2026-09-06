import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

type Row = Record<string, unknown>;

const at = "2026-09-06T12:34:56.789Z";
const outboxStates = ["pending", "processing", "sent", "suppressed", "failed"] as const;

describe("native draft quote notification populated migration", () => {
  let runtime: Miniflare;
  let db: D1Database;
  let outboxBefore: Row[];
  let inboxBefore: Row[];
  let tableInfoBefore: Record<string, Row[]>;
  let foreignKeysBefore: Record<string, Row[]>;
  let indexesBefore: Record<string, Row[]>;
  let triggersBefore: Row[];
  let outboxWaterBefore: number;
  let inboxWaterBefore: number;

  async function rows(sql: string): Promise<Row[]> {
    return (await db.prepare(sql).all<Row>()).results;
  }

  async function tableMetadata(pragma: "table_info" | "foreign_key_list" | "index_list", table: string) {
    return rows(`PRAGMA ${pragma}('${table}')`);
  }

  beforeAll(async () => {
    runtime = new Miniflare({
      compatibilityDate: "2026-08-06",
      modules: true,
      script: "export default {fetch(){return new Response('native-draft-quote-notification-migration')}}",
      d1Databases: { DELIVERY_DB: "native-draft-quote-notification-migration" },
    });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;

    const directory = new URL("../migrations/", import.meta.url);
    const names = readdirSync(directory)
      .filter(name => /^\d+.*\.sql$/.test(name) && name < "0201_")
      .sort();
    for (const name of names) {
      const migration = readFileSync(new URL(name, directory), "utf8");
      const statements = splitD1MigrationStatements(migration);
      if (statements.length) await db.batch(statements.map(sql => db.prepare(sql)));
    }

    await db.batch([
      db.prepare("INSERT INTO client_accounts(id,display_name,status) VALUES('account','Migration client','active')"),
      db.prepare(`INSERT INTO client_identity_links(id,account_id,issuer,subject,email)
        VALUES('identity','account','https://issuer.test','migration-subject','person@example.test')`),
      db.prepare("INSERT INTO client_account_members(account_id,identity_id,role) VALUES('account','identity','manager')"),
      db.prepare(`INSERT INTO client_service_requests
        (id,account_id,created_by_identity_id,request_type,title,details,idempotency_key,request_fingerprint,status,created_at,updated_at)
        VALUES('request','account','identity','service','Migration request','Preserve notification history',
          'migration-request-key-0001',?,'under_review',?,?)`).bind("r".repeat(43), at, at),
      db.prepare(`INSERT INTO client_portal_notification_outbox
        (id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json)
        VALUES('outbox-deleted','request','request_submitted','submitted','staff_triage','outbox-deleted','{}')`),
      ...outboxStates.map((status, index) => db.prepare(`INSERT INTO client_portal_notification_outbox
        (id,request_id,event_type,status_value,recipient_kind,dedupe_key,payload_json,status,attempt_count,
          next_attempt_at,lease_expires_at,last_error,delivered_at,created_at,updated_at)
        VALUES(?,'request','request_status_changed','under_review','client_requester',?,?,?, ?,?,?,?,?,?,?)`)
        .bind(`outbox-${status}`, `dedupe-${status}`, JSON.stringify({ status, unicode: "Élevation" }), status,
          index, `2026-09-0${index + 1}T01:02:03.000Z`, status === "processing" ? "2026-09-06T13:00:00.000Z" : null,
          status === "suppressed" ? "recipient-disabled" : status === "failed" ? "provider-error" : null,
          status === "sent" ? "2026-09-03T02:03:04.000Z" : null, `2026-08-0${index + 1}T01:02:03.000Z`,
          `2026-08-1${index + 1}T01:02:03.000Z`)),
      db.prepare("DELETE FROM client_portal_notification_outbox WHERE id='outbox-deleted'"),
      db.prepare(`INSERT INTO client_portal_notifications
        (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body)
        VALUES('inbox-deleted','account','identity','request_status','service_request','request','inbox-deleted','Deleted','Deleted body')`),
      db.prepare(`INSERT INTO client_portal_notifications
        (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body,action_path,read_at,dismissed_at,created_at)
        VALUES
        ('inbox-unread','account','identity','request_status','service_request','request','inbox-unread','Unread','Unread body','/portal/requests',NULL,NULL,?),
        ('inbox-read','account','identity','request_reply','service_request','request','inbox-read','Read','Read body','/portal/requests',?,NULL,?),
        ('inbox-dismissed','account','identity','estimate_ready','service_request','request','inbox-dismissed','Dismissed','Dismissed body',NULL,NULL,?,?),
        ('inbox-read-dismissed','account','identity','request_completed','service_request','request','inbox-read-dismissed','Read and dismissed','Read and dismissed body','/portal/requests',?,?,?)`)
        .bind(at, at, at, at, at, at, at, at),
      db.prepare("DELETE FROM client_portal_notifications WHERE id='inbox-deleted'"),
    ]);

    outboxBefore = await rows("SELECT rowid AS storage_rowid,* FROM client_portal_notification_outbox ORDER BY id");
    inboxBefore = await rows("SELECT rowid AS storage_rowid,* FROM client_portal_notifications ORDER BY id");
    outboxWaterBefore = Number((await db.prepare("SELECT MAX(rowid) water FROM client_portal_notification_outbox").first<Row>())?.water);
    inboxWaterBefore = Number((await db.prepare("SELECT MAX(rowid) water FROM client_portal_notifications").first<Row>())?.water);
    tableInfoBefore = Object.fromEntries(await Promise.all(["client_portal_notification_outbox", "client_portal_notifications"]
      .map(async table => [table, await tableMetadata("table_info", table)])));
    foreignKeysBefore = Object.fromEntries(await Promise.all(["client_portal_notification_outbox", "client_portal_notifications"]
      .map(async table => [table, await tableMetadata("foreign_key_list", table)])));
    indexesBefore = Object.fromEntries(await Promise.all(["client_portal_notification_outbox", "client_portal_notifications"]
      .map(async table => [table, await tableMetadata("index_list", table)])));
    triggersBefore = await rows(`SELECT name,sql FROM sqlite_schema
      WHERE type='trigger' AND tbl_name IN ('client_portal_notification_outbox','client_portal_notifications') ORDER BY name`);

    const migration = readFileSync(new URL("0201_native_draft_quote_notifications.sql", directory), "utf8");
    await db.batch(splitD1MigrationStatements(migration).map(sql => db.prepare(sql)));
  }, 60_000);

  afterAll(async () => runtime?.dispose());

  it("preserves every outbox lifecycle field and inbox read/dismiss state byte-for-byte", async () => {
    expect(await rows("SELECT rowid AS storage_rowid,* FROM client_portal_notification_outbox ORDER BY id")).toEqual(outboxBefore);
    expect(await rows("SELECT rowid AS storage_rowid,* FROM client_portal_notifications ORDER BY id")).toEqual(inboxBefore);
    expect(outboxBefore.map(row => row.status).sort()).toEqual([...outboxStates].sort());
    expect(inboxBefore.map(row => [row.id, row.read_at, row.dismissed_at])).toEqual([
      ["inbox-dismissed", null, at],
      ["inbox-read", at, null],
      ["inbox-read-dismissed", at, at],
      ["inbox-unread", null, null],
    ]);
    expect(outboxWaterBefore).toBe(outboxBefore.length + 1);
    expect(inboxWaterBefore).toBe(inboxBefore.length + 1);
  });

  it("retains columns, foreign keys, indexes, triggers and database integrity", async () => {
    for (const table of ["client_portal_notification_outbox", "client_portal_notifications"]) {
      expect(await tableMetadata("table_info", table)).toEqual(tableInfoBefore[table]);
      expect(await tableMetadata("foreign_key_list", table)).toEqual(foreignKeysBefore[table]);
      expect(await tableMetadata("index_list", table)).toEqual(indexesBefore[table]);
      expect((await rows(`PRAGMA quick_check('${table}')`)).map(row => row.quick_check)).toEqual(["ok"]);
    }
    expect(await rows(`SELECT name,sql FROM sqlite_schema
      WHERE type='trigger' AND tbl_name IN ('client_portal_notification_outbox','client_portal_notifications') ORDER BY name`))
      .toEqual(triggersBefore);
    expect(await rows("PRAGMA foreign_key_check")).toEqual([]);
    expect((await tableMetadata("index_list", "client_portal_notification_outbox"))
      .some(row => row.name === "idx_client_portal_notification_outbox_ready")).toBe(true);
    expect((await tableMetadata("index_list", "client_portal_notifications"))
      .some(row => row.name === "idx_client_portal_notifications_inbox")).toBe(true);
  });

  it("admits only the new native draft-quote event shapes while retaining legacy constraints", async () => {
    await db.batch([
      db.prepare(`INSERT INTO client_portal_notification_outbox
        (id,request_id,event_type,recipient_kind,dedupe_key,payload_json)
        VALUES('native-outbox','request','pa_draft_quote_created','native_request_owner','native-dedupe','{"quote":"draft"}')`),
      db.prepare(`INSERT INTO client_portal_notifications
        (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body)
        VALUES('native-inbox','account','identity','pa_draft_quote_created','service_request','request','native-inbox-dedupe','Draft quote ready','Open the client hub')`),
    ]);
    expect(Number(await db.prepare("SELECT rowid FROM client_portal_notification_outbox WHERE id='native-outbox'").first("rowid")))
      .toBeGreaterThan(outboxWaterBefore);
    expect(Number(await db.prepare("SELECT rowid FROM client_portal_notifications WHERE id='native-inbox'").first("rowid")))
      .toBeGreaterThan(inboxWaterBefore);
    await expect(db.prepare(`INSERT INTO client_portal_notification_outbox
      (id,request_id,event_type,recipient_kind,dedupe_key,payload_json)
      VALUES('bad-event','request','unknown','client_requester','bad-event','{}')`).run()).rejects.toThrow(/CHECK/i);
    await expect(db.prepare(`INSERT INTO client_portal_notification_outbox
      (id,request_id,event_type,recipient_kind,dedupe_key,payload_json)
      VALUES('bad-recipient','request','pa_draft_quote_created','unknown','bad-recipient','{}')`).run()).rejects.toThrow(/CHECK/i);
    await expect(db.prepare(`INSERT INTO client_portal_notification_outbox
      (id,request_id,event_type,recipient_kind,dedupe_key,payload_json)
      VALUES('bad-json','request','pa_draft_quote_created','native_request_owner','bad-json','not-json')`).run()).rejects.toThrow(/CHECK/i);
    await expect(db.prepare(`INSERT INTO client_portal_notification_outbox
      (id,request_id,event_type,recipient_kind,dedupe_key,payload_json)
      VALUES('duplicate-dedupe','request','request_submitted','staff_triage','native-dedupe','{}')`).run()).rejects.toThrow(/UNIQUE/i);
    await expect(db.prepare(`INSERT INTO client_portal_notification_outbox
      (id,request_id,event_type,recipient_kind,dedupe_key,payload_json)
      VALUES('orphan','missing','pa_draft_quote_created','native_request_owner','orphan','{}')`).run()).rejects.toThrow(/FOREIGN KEY/i);
    await expect(db.prepare(`INSERT INTO client_portal_notifications
      (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body)
      VALUES('bad-inbox-event','account','identity','unknown','service_request','request','bad-inbox-event','Bad','Bad')`).run()).rejects.toThrow(/CHECK/i);
    await expect(db.prepare(`INSERT INTO client_portal_notifications
      (id,account_id,recipient_identity_id,event_type,source_type,source_id,dedupe_key,title,body)
      VALUES('orphan-inbox','account','missing','pa_draft_quote_created','service_request','request','orphan-inbox','Bad','Bad')`).run()).rejects.toThrow(/FOREIGN KEY/i);
  });
});
