import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import type { Env } from "../src/worker/types";

const mail=vi.hoisted(()=>{
  class DeliveryUncertain extends Error { constructor(){super("notification_mail_delivery_uncertain");} }
  return {send:vi.fn(),preflight:vi.fn(),failureCode:vi.fn(()=>"mail-transport-unknown"),DeliveryUncertain};
});
vi.mock("../src/worker/mailer",()=>({sendNotificationMail:mail.send,
  validateNotificationMailTransport:mail.preflight,notificationMailFailureCode:mail.failureCode,
  NotificationMailDeliveryUncertain:mail.DeliveryUncertain}));
import { processClientOpsTriageInquiryNotifications, processOperationsPrincipalInquiryNotifications } from "../src/worker/notifications";

describe("typed inquiry staff-triage outbox",()=>{
  let runtime:Miniflare,db:D1Database,opsDb:D1Database,env:Env;
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",
      script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:"triage-notification-test",OPS_DB:"ops-triage-notification-test"}});
    db=await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    opsDb=await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    await db.exec("CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY);"+
      "CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_type TEXT NOT NULL,actor_id TEXT,action TEXT NOT NULL,entity_type TEXT,entity_id TEXT,details_json TEXT,created_at TEXT NOT NULL DEFAULT(datetime('now')));");
    const migration=readFileSync(new URL("../../client/migrations/0242_client_ops_triage_inquiries.sql",import.meta.url),"utf8");
    await db.batch(splitD1MigrationStatements(migration).map(sql=>db.prepare(sql)));
    await db.prepare("INSERT INTO portal_v2_identities(id) VALUES('identity-notify')").run();
    await opsDb.batch([
      opsDb.prepare("CREATE TABLE operations_native_principal_inquiries(inquiry_id TEXT PRIMARY KEY,kind TEXT,title TEXT,details TEXT,location TEXT)"),
      opsDb.prepare("CREATE TABLE operations_native_principal_inquiry_outbox(outbox_id TEXT PRIMARY KEY,inquiry_id TEXT,event_type TEXT,dedupe_key TEXT UNIQUE,payload_json TEXT,state TEXT,attempts INTEGER,available_at INTEGER,lease_token TEXT,lease_expires_at INTEGER,last_error TEXT,created_at TEXT,updated_at TEXT)"),
      opsDb.prepare("CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_type TEXT,actor_id TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details_json TEXT)"),
    ]);
    env={DELIVERY_DB:db,CLIENT_REQUEST_TRIAGE_TO:"ops-owner@example.test",PUBLIC_BASE_URL:"https://ops.example.test",
      SMTP_NOTIFICATIONS_ENABLED:"false",NOTIFICATION_FROM:"notifications@example.test",
      NOTIFICATION_EMAIL:{send:vi.fn()} as never,OPS_DB:opsDb} as unknown as Env;
  });
  beforeEach(async()=>{
    await db.batch([
      db.prepare("DELETE FROM client_ops_triage_notification_outbox"),
      db.prepare("DELETE FROM client_ops_triage_inquiries"),
      db.prepare("DELETE FROM audit_log"),
    ]);
    await opsDb.batch([opsDb.prepare("DELETE FROM operations_native_principal_inquiry_outbox"),
      opsDb.prepare("DELETE FROM operations_native_principal_inquiries"),opsDb.prepare("DELETE FROM audit_log")]);
    mail.send.mockReset().mockResolvedValue(undefined);
    mail.preflight.mockReset();
    mail.failureCode.mockReset().mockReturnValue("mail-transport-unknown");
    vi.spyOn(console,"error").mockImplementation(()=>{});
  });
  afterAll(async()=>{vi.restoreAllMocks();await runtime?.dispose();});

  async function enqueue(options:{status?:string;attemptCount?:number;lease?:string}={}){
    const inquiryId=crypto.randomUUID(),notificationId=crypto.randomUUID();
    await db.prepare("INSERT INTO client_ops_triage_inquiries(id,portal_identity_id,authorizing_workspace_id,authorizing_source_id,"+
      "kind,title,details,location,idempotency_key,request_fingerprint) VALUES(?,'identity-notify','workspace','project-alpha:primary',"+
      "'website','New <site> inquiry','Please update the site.\\nSecond line.','North <field>','notification-idempotency-0001',?)")
      .bind(inquiryId,"a".repeat(64)).run();
    await db.prepare("INSERT INTO client_ops_triage_notification_outbox"+
      "(id,inquiry_id,event_type,recipient_kind,dedupe_key,payload_json,status,attempt_count,lease_expires_at) "+
      "VALUES(?,?,'inquiry_submitted','staff_triage',?,'{}',?,?,?)")
      .bind(notificationId,inquiryId,inquiryId+":inquiry_submitted:staff_triage",options.status??"pending",
        options.attemptCount??0,options.lease??null).run();
    return {inquiryId,notificationId};
  }
  async function outbox(notificationId:string){
    return db.prepare("SELECT status,attempt_count,last_error FROM client_ops_triage_notification_outbox WHERE id=?")
      .bind(notificationId).first<{status:string;attempt_count:number;last_error:string|null}>();
  }
  async function enqueueOperations(){
    const id=crypto.randomUUID(),outboxId=crypto.randomUUID();
    await opsDb.prepare("INSERT INTO operations_native_principal_inquiries(inquiry_id,kind,title,details,location) VALUES(?,'website','Ops-owned inquiry','Please review this.',NULL)").bind(id).run();
    await opsDb.prepare("INSERT INTO operations_native_principal_inquiry_outbox(outbox_id,inquiry_id,event_type,dedupe_key,payload_json,state,attempts,available_at,created_at,updated_at) VALUES(?,?,'inquiry_submitted',?,'{}','pending',0,unixepoch()*1000,datetime('now'),datetime('now'))")
      .bind(outboxId,id,id+":submitted").run();
    return {id,outboxId};
  }

  it("preflights before claim and preserves attempts when transport configuration is invalid",async()=>{
    const {notificationId}=await enqueue();
    const privateFailure=new Error("private SMTP configuration details");
    mail.preflight.mockImplementationOnce(()=>{throw privateFailure;});
    mail.failureCode.mockReturnValueOnce("mail-configuration-invalid");
    expect(await processClientOpsTriageInquiryNotifications(env)).toBe(0);
    expect(mail.send).not.toHaveBeenCalled();
    expect(await outbox(notificationId)).toEqual({status:"pending",attempt_count:0,last_error:null});
    expect(console.error).toHaveBeenCalledWith(JSON.stringify({
      event:"client.ops_triage_inquiry_notification.transport_unavailable",failureCode:"mail-configuration-invalid"}));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private SMTP configuration details");
  });

  it("renders safely, sends once to the configured recipient, and marks acceptance sent",async()=>{
    const {notificationId}=await enqueue();
    expect(await processClientOpsTriageInquiryNotifications(env)).toBe(1);
    expect(mail.preflight).toHaveBeenCalledTimes(1);
    expect(mail.send).toHaveBeenCalledTimes(1);
    const message=mail.send.mock.calls[0]![1] as {to:string;subject:string;text:string;html:string;messageIdKey:string};
    expect(message.to).toBe("ops-owner@example.test");
    expect(message.subject).toContain("website inquiry");
    expect(message.html).toContain("New &lt;site&gt; inquiry");
    expect(message.html).toContain("North &lt;field&gt;");
    expect(message.html).toContain("/operations/inbox?source=inquiries");
    expect(message.messageIdKey).toBe(notificationId);
    expect(await outbox(notificationId)).toMatchObject({status:"sent",attempt_count:1,last_error:null});
    expect(await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='client.ops_triage_inquiry_notification.sent'")
      .first("n")).toBe(1);
  });

  it("keeps the Operations-owned outbox inert by default and delivers only through the existing staff transport when enabled",async()=>{
    const {id,outboxId}=await enqueueOperations();
    expect(await processOperationsPrincipalInquiryNotifications({...env,CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED:"false"} as Env)).toBe(0);
    expect(mail.send).not.toHaveBeenCalled();
    expect((await opsDb.prepare("SELECT state,attempts FROM operations_native_principal_inquiry_outbox WHERE outbox_id=?").bind(outboxId).first<{state:string;attempts:number}>())?.state).toBe("pending");
    expect(await processOperationsPrincipalInquiryNotifications({...env,CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED:"true"} as Env)).toBe(1);
    const message=mail.send.mock.calls.at(-1)![1] as {to:string;subject:string;messageIdKey:string};
    expect(message.to).toBe("ops-owner@example.test");expect(message.subject).toContain("Ops-owned inquiry");expect(message.messageIdKey).toBe(outboxId);
    expect((await opsDb.prepare("SELECT state,attempts FROM operations_native_principal_inquiry_outbox WHERE outbox_id=?").bind(outboxId).first<{state:string;attempts:number}>())?.state).toBe("delivered");
    expect(await opsDb.prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_id=? AND action='operations.native_principal_inquiry_notification.delivered'").bind(id).first("n")).toBe(1);
  });

  it("holds ambiguous SMTP acceptance without a retry or raw error storage",async()=>{
    const {notificationId}=await enqueue();
    mail.send.mockRejectedValueOnce(new mail.DeliveryUncertain());
    expect(await processClientOpsTriageInquiryNotifications(env)).toBe(1);
    expect(await outbox(notificationId)).toEqual({status:"uncertain",attempt_count:1,last_error:"mail-delivery-outcome-uncertain"});
    expect(await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='client.ops_triage_inquiry_notification.uncertain'")
      .first("n")).toBe(1);
    expect(await processClientOpsTriageInquiryNotifications(env)).toBe(0);
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it("retries typed definitive pre-dispatch transport failures with only the safe failure code",async()=>{
    const {notificationId}=await enqueue();
    mail.send.mockRejectedValueOnce(new Error("private SMTP server response"));
    mail.failureCode.mockReturnValue("mail-smtp-rejected");
    expect(await processClientOpsTriageInquiryNotifications(env)).toBe(1);
    expect(await outbox(notificationId)).toMatchObject({status:"pending",attempt_count:1,last_error:"mail-smtp-rejected"});
    const audits=await db.prepare("SELECT details_json FROM audit_log WHERE action='client.ops_triage_inquiry_notification.retry_scheduled'")
      .all<{details_json:string}>();
    expect(audits.results[0]?.details_json).toContain("mail-smtp-rejected");
    expect(audits.results[0]?.details_json).not.toContain("private SMTP server response");
  });

  it("holds an accepted send as uncertain when D1 receipt persistence fails",async()=>{
    const {notificationId}=await enqueue();
    await db.exec("CREATE TRIGGER fail_inquiry_sent_receipt BEFORE UPDATE OF status ON client_ops_triage_notification_outbox "+
      "WHEN NEW.status='sent' BEGIN SELECT RAISE(ABORT,'receipt_write_failed'); END;");
    await expect(processClientOpsTriageInquiryNotifications(env)).rejects.toThrow();
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(await outbox(notificationId)).toMatchObject({status:"processing",attempt_count:1});
    await db.prepare("UPDATE client_ops_triage_notification_outbox SET lease_expires_at='2000-01-01 00:00:00' WHERE id=?")
      .bind(notificationId).run();
    expect(await processClientOpsTriageInquiryNotifications(env)).toBe(1);
    expect(await outbox(notificationId)).toEqual({status:"uncertain",attempt_count:1,
      last_error:"mail-delivery-outcome-uncertain-after-expired-lease"});
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it("moves every expired processing lease to uncertain instead of resending, including a prior final attempt",async()=>{
    const {notificationId}=await enqueue({status:"processing",attemptCount:3,lease:"2000-01-01 00:00:00"});
    expect(await processClientOpsTriageInquiryNotifications(env)).toBe(1);
    expect(await outbox(notificationId)).toEqual({status:"uncertain",attempt_count:3,
      last_error:"mail-delivery-outcome-uncertain-after-expired-lease"});
    expect(mail.send).not.toHaveBeenCalled();
    expect(await processClientOpsTriageInquiryNotifications(env)).toBe(0);
  });
});
