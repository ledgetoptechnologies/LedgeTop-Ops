import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { transitionFeedbackRecord } from "../../client/src/worker/client-portal/feedback-store";
import { reauthorizeFeedbackRecipient } from "../../client/src/worker/client-portal/feedback-target";
import { processClientFeedbackNotifications, type FeedbackNotificationDependencies } from "../src/worker/client-feedback-notifications";
import { feedbackFixture } from "./helpers/client-feedback-fixture";

describe("feedback completion email durable leases",{timeout:30_000},()=>{
  let f:Awaited<ReturnType<typeof feedbackFixture>>;
  beforeAll(async()=>{f=await feedbackFixture();},90_000);
  afterAll(async()=>f?.runtime.dispose());
  // Notices are immutable history. Keep previous test rows, but do not let
  // intentionally pending retries take the next scenario's bounded slot.
  beforeEach(async()=>{await f.db.prepare("UPDATE client_feedback_notification_outbox SET next_attempt_at='2099-01-01T00:00:00Z',lease_expires_at=CASE WHEN status='processing' THEN '2099-01-01T00:00:00Z' ELSE NULL END WHERE status IN ('pending','processing')").run();});
  async function pending(){
    const owner=await f.seed(),record=await owner.create("Private feedback not allowed in email");
    await transitionFeedbackRecord(f.db,record,"staff",{expectedRevision:1,status:"done",note:"Private completion note"},`complete-${crypto.randomUUID()}`,owner.authorization.guard);
    const row=await f.db.prepare("SELECT o.id,o.notification_id FROM client_feedback_notification_outbox o JOIN client_feedback_notifications n ON n.id=o.notification_id WHERE n.feedback_id=?").bind(record.id).first<{id:string;notification_id:string}>();
    const authorize:FeedbackNotificationDependencies["authorize"]=async()=>({authorization:{...owner.authorization,available:true},email:"author@example.test"});
    return {...owner,record,id:row!.id,notificationId:row!.notification_id,authorize};
  }
  const mailEnv=()=>({...f.env,NOTIFICATION_EMAIL:{send:async()=>{}} as unknown as SendEmail,NOTIFICATION_FROM:"portal@example.test"});
  const state=(id:string)=>f.db.prepare("SELECT status,attempt_count,lease_token,error_code,dispatch_fingerprint FROM client_feedback_notification_outbox WHERE id=?").bind(id).first();
  it("suppresses unconfigured mail without removing the private in-app notice",async()=>{
    const p=await pending(),send=vi.fn();
    await processClientFeedbackNotifications(f.env,{authorize:p.authorize,send});
    expect(await state(p.id)).toMatchObject({status:"suppressed",error_code:"mail-disabled",attempt_count:1,lease_token:null});
    expect(send).not.toHaveBeenCalled();
    expect(await f.db.prepare("SELECT id FROM client_feedback_notifications WHERE id=?").bind(p.notificationId).first()).toBeTruthy();
  });
  it("sends only a generic authenticated deep link with stable Message-ID",async()=>{
    const p=await pending(),send=vi.fn<FeedbackNotificationDependencies["send"]>(async()=>{});
    await processClientFeedbackNotifications(mailEnv(),{authorize:p.authorize,send});
    expect(send).toHaveBeenCalledOnce();
    const mail=send.mock.calls[0]![1];
    expect(mail).toMatchObject({to:"author@example.test",messageIdKey:`client-feedback:${p.notificationId}`});
    expect(JSON.stringify(mail)).toContain(`/portal/feedback/${p.record.id}`);
    expect(JSON.stringify(mail)).not.toMatch(/Private feedback|Private completion|North site|storageKey|pa-/);
    expect(await state(p.id)).toMatchObject({status:"sent",attempt_count:1,lease_token:null});
  });
  it("dispatches through the real migrated legacy recipient resolver without Client handle secrets",async()=>{
    const p=await pending(),send=vi.fn<FeedbackNotificationDependencies["send"]>(async()=>{});
    await processClientFeedbackNotifications(mailEnv(),{authorize:reauthorizeFeedbackRecipient,send});
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]).toMatchObject({to:`${p.authorization.context.accountId}@example.test`,messageIdKey:`client-feedback:${p.notificationId}`});
    expect(await state(p.id)).toMatchObject({status:"sent",attempt_count:1});
  });
  it("suppresses revoked or unmatched original recipient instead of email matching",async()=>{
    const p=await pending(),send=vi.fn();
    await processClientFeedbackNotifications(mailEnv(),{authorize:async()=>null,send});
    expect(send).not.toHaveBeenCalled();expect(await state(p.id)).toMatchObject({status:"suppressed",error_code:"recipient-unavailable"});
  });
  it("checks authorization again inside publication before sending",async()=>{
    const p=await pending(),send=vi.fn();
    const authorize:FeedbackNotificationDependencies["authorize"]=async()=>{
      const result=await p.authorize(f.env,p.record);
      await f.db.prepare("UPDATE client_accounts SET status='suspended' WHERE id=?").bind(p.authorization.context.accountId).run();
      return result;
    };
    await processClientFeedbackNotifications(mailEnv(),{authorize,send});
    expect(send).not.toHaveBeenCalled();expect(await state(p.id)).toMatchObject({status:"suppressed",error_code:"delivery-context-changed"});
  });
  it("allows only one concurrent claim and fences a late completion",async()=>{
    const p=await pending();let release!:()=>void,entered!:()=>void;
    const arrived=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve);
    const send=vi.fn(async()=>{entered();await wait;});
    const first=processClientFeedbackNotifications(mailEnv(),{authorize:p.authorize,send});
    await arrived;
    expect(await processClientFeedbackNotifications(mailEnv(),{authorize:p.authorize,send})).toEqual({processed:0});
    await f.db.prepare("UPDATE client_feedback_notification_outbox SET lease_token='new-owner' WHERE id=?").bind(p.id).run();
    release();await first;
    expect(send).toHaveBeenCalledOnce();expect(await state(p.id)).toMatchObject({status:"processing",lease_token:"new-owner"});
  });
  it("caps retries at three and stores only a safe failure code",async()=>{
    const p=await pending(),send=vi.fn(async()=>{throw new Error("secret smtp recipient and password");});
    for(let i=0;i<3;i++){
      await f.db.prepare("UPDATE client_feedback_notification_outbox SET next_attempt_at='2000-01-01T00:00:00Z' WHERE id=?").bind(p.id).run();
      await processClientFeedbackNotifications(mailEnv(),{authorize:p.authorize,send});
    }
    expect(send).toHaveBeenCalledTimes(3);expect(await state(p.id)).toMatchObject({status:"failed",attempt_count:3,error_code:"delivery-attempt-failed",lease_token:null});
    expect(JSON.stringify((await f.db.prepare("SELECT details_json FROM audit_log WHERE entity_id=?").bind(p.record.id).all()).results)).not.toMatch(/password|smtp|author@example/);
  });
  it("retries the identical composed payload but suppresses changed delivery origin",async()=>{
    const p=await pending(),send=vi.fn(async()=>{throw new Error("unknown acknowledgement");});
    await processClientFeedbackNotifications(mailEnv(),{authorize:p.authorize,send});
    await f.db.prepare("UPDATE client_feedback_notification_outbox SET next_attempt_at='2000-01-01T00:00:00Z' WHERE id=?").bind(p.id).run();
    await processClientFeedbackNotifications({...mailEnv(),DELIVERY_BASE_URL:"https://different.example.test"},{authorize:p.authorize,send});
    expect(send).toHaveBeenCalledOnce();expect(await state(p.id)).toMatchObject({status:"suppressed",error_code:"delivery-context-changed"});
  });
  it("does not send a different email under the old publication fingerprint",async()=>{
    const p=await pending(),send=vi.fn(async()=>{throw new Error("unknown acknowledgement");});
    await processClientFeedbackNotifications(mailEnv(),{authorize:p.authorize,send});
    await f.db.prepare("UPDATE client_feedback_notification_outbox SET next_attempt_at='2000-01-01T00:00:00Z' WHERE id=?").bind(p.id).run();
    const authorize:FeedbackNotificationDependencies["authorize"]=async()=>({authorization:{...p.authorization,available:true},email:"changed@example.test"});
    await processClientFeedbackNotifications(mailEnv(),{authorize,send});
    expect(send).toHaveBeenCalledOnce();expect(await state(p.id)).toMatchObject({status:"suppressed"});
  });
  it("recovers expired leases and terminalizes a final abandoned attempt",async()=>{
    const p=await pending(),send=vi.fn(async()=>{});
    await f.db.prepare("UPDATE client_feedback_notification_outbox SET status='processing',attempt_count=3,lease_token='dead-worker',lease_expires_at='2000-01-01T00:00:00Z' WHERE id=?").bind(p.id).run();
    await processClientFeedbackNotifications(mailEnv(),{authorize:p.authorize,send});
    expect(send).not.toHaveBeenCalled();expect(await state(p.id)).toMatchObject({status:"failed",attempt_count:3,error_code:"lease-expired",lease_token:null});
  });
});
