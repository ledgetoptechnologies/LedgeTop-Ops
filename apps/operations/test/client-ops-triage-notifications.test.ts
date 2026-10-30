import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import type { Env } from "../src/worker/types";

const sendMail=vi.hoisted(()=>vi.fn(async(..._args:unknown[])=>undefined));
vi.mock("../src/worker/mailer",()=>({sendNotificationMail:sendMail}));
import { processClientOpsTriageInquiryNotifications } from "../src/worker/notifications";

describe("typed inquiry staff-triage outbox",()=>{
  let runtime:Miniflare,db:D1Database,env:Env;
  let exhaustedNoticeId:string;
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",
      script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:"triage-notification-test"}});
    db=await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec("CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY);"+
      "CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_type TEXT NOT NULL,actor_id TEXT,action TEXT NOT NULL,entity_type TEXT,entity_id TEXT,details_json TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')));");
    const migration=readFileSync(new URL("../../client/migrations/0242_client_ops_triage_inquiries.sql",import.meta.url),"utf8");
    await db.batch(splitD1MigrationStatements(migration).map(sql=>db.prepare(sql)));
    await db.prepare("INSERT INTO portal_v2_identities(id) VALUES('identity-notify')").run();
    const inquiryId=crypto.randomUUID();
    await db.prepare("INSERT INTO client_ops_triage_inquiries(id,portal_identity_id,authorizing_workspace_id,authorizing_source_id,"+
      "kind,title,details,location,idempotency_key,request_fingerprint) VALUES(?,'identity-notify','workspace','project-alpha:primary',"+
      "'website','New <site> inquiry','Please update the site.\\nSecond line.','North <field>','notification-idempotency-0001',?)")
      .bind(inquiryId,"a".repeat(64)).run();
    await db.prepare("INSERT INTO client_ops_triage_notification_outbox(id,inquiry_id,event_type,recipient_kind,dedupe_key,payload_json) "+
      "VALUES(? ,?,'inquiry_submitted','staff_triage',?,'{}')").bind(crypto.randomUUID(),inquiryId,
        inquiryId+":inquiry_submitted:staff_triage").run();
    const exhaustedId=crypto.randomUUID();exhaustedNoticeId=crypto.randomUUID();
    await db.prepare("INSERT INTO client_ops_triage_inquiries(id,portal_identity_id,authorizing_workspace_id,authorizing_source_id,"+
      "kind,title,details,idempotency_key,request_fingerprint) VALUES(?,'identity-notify','workspace','project-alpha:primary',"+
      "'drone','Expired claim','Do not resend after attempt limit.','notification-idempotency-0002',?)")
      .bind(exhaustedId,"b".repeat(64)).run();
    await db.prepare("INSERT INTO client_ops_triage_notification_outbox"+
      "(id,inquiry_id,event_type,recipient_kind,dedupe_key,payload_json,status,attempt_count,lease_expires_at) "+
      "VALUES(?,?,'inquiry_submitted','staff_triage',?,'{}','processing',3,'2000-01-01 00:00:00')")
      .bind(exhaustedNoticeId,exhaustedId,exhaustedId+":inquiry_submitted:staff_triage").run();
    env={DELIVERY_DB:db,CLIENT_REQUEST_TRIAGE_TO:"ops-owner@example.test",PUBLIC_BASE_URL:"https://ops.example.test"} as Env;
  });
  afterAll(async()=>{await runtime?.dispose();});
  it("uses only the configured internal recipient, safely renders the inquiry, and marks the fixed outbox sent",async()=>{
    sendMail.mockClear();
    expect(await processClientOpsTriageInquiryNotifications(env)).toBe(2);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const message=sendMail.mock.calls[0]![1] as {to:string;subject:string;text:string;html:string;messageIdKey:string};
    expect(message.to).toBe("ops-owner@example.test");
    expect(message.subject).toContain("website inquiry");
    expect(message.html).toContain("New &lt;site&gt; inquiry");
    expect(message.html).toContain("North &lt;field&gt;");
    expect(message.html).toContain("/operations/inbox?source=inquiries");
    expect(message.messageIdKey).toBeTruthy();
    expect(await db.prepare("SELECT status FROM client_ops_triage_notification_outbox WHERE id=(SELECT id FROM client_ops_triage_notification_outbox WHERE status='sent' LIMIT 1)")
      .first("status")).toBe("sent");
    expect(await db.prepare("SELECT status,last_error FROM client_ops_triage_notification_outbox WHERE id=?").bind(exhaustedNoticeId)
      .first<{status:string;last_error:string}>()).toEqual({status:"failed",last_error:"delivery-attempt-limit-after-expired-lease"});
    expect(await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='client.ops_triage_inquiry_notification.sent'")
      .first("n")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='client.ops_triage_inquiry_notification.failed'")
      .first("n")).toBe(1);
  });
});
