import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processDeliveryNotifications, processProjectAlphaDeliveryPortalNotifications } from "../src/worker/notifications";
import { sendNotificationMail } from "../src/worker/mailer";
import { decryptDeliveryToken, encryptDeliveryToken } from "../src/worker/crypto";
import type { Env } from "../src/worker/types";

vi.mock("../src/worker/mailer", () => ({ sendNotificationMail: vi.fn(async () => undefined) }));
const directory = new URL("../../client/migrations/", import.meta.url);
// Exercise the rolling-deploy expand phase. The contract migration is applied
// only after this compatible sender drains legacy fragment-bearing rows.
const migrations = readdirSync(directory).filter(name => /^\d+_.+\.sql$/.test(name) && !name.startsWith("0178_")).sort()
  .map(name => readFileSync(new URL(name, directory), "utf8"));
const prefix = "jobs/shared/project/", email = "same-email@example.test";
const currentTokenSecret = "current-delivery-token-secret-used-by-tests";
const previousTokenSecret = "previous-delivery-token-secret-used-by-tests";
let beforeRun:((sql:string)=>Promise<void>)|null=null,insideHook=false;

// Real production SQL and full migration chain. Only mail transport is mocked;
// the D1-shaped adapter never fabricates query or authorization results.
function asD1(db: DatabaseSync): D1Database {
  const adapter = {
    withSession: () => adapter,
    async batch(statements: { run(): Promise<unknown> }[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    prepare(sql: string) {
      let bindings: SQLInputValue[] = [];
      const statement = {
        bind(...values: SQLInputValue[]) { bindings = values; return statement; },
        async first(column?: string) {
          const row = db.prepare(sql).get(...bindings);
          return column === undefined ? row ?? null : row?.[column] ?? null;
        },
        async all() { return { results: db.prepare(sql).all(...bindings) }; },
        async run() {
          if(beforeRun&&!insideHook){insideHook=true;try{await beforeRun(sql);}finally{insideHook=false;}}
          return { meta: { changes: Number(db.prepare(sql).run(...bindings).changes) } };
        },
      };
      return statement;
    },
  };
  return adapter as unknown as D1Database;
}

describe("delivery notification source and live ownership", () => {
  let db: DatabaseSync, env: Env;
  beforeEach(() => {
    beforeRun=null;insideHook=false;
    vi.mocked(sendNotificationMail).mockClear();
    db = new DatabaseSync(":memory:");
    for (const sql of migrations) { db.exec("BEGIN"); db.exec(sql); db.exec("COMMIT"); }
    env = { DELIVERY_DB: asD1(db), DELIVERY_BASE_URL: "https://client.example.test",
      PUBLIC_SHARE_ORIGIN: "https://delivery.example.test",
      DELIVERY_TOKEN_SECRET: currentTokenSecret,
      DELIVERY_PREVIOUS_TOKEN_SECRET: previousTokenSecret,
      CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true", CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: "true",
      CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: "true", AUTHENTICATED_DELIVERY_GRANTS_ENABLED: "true" } as Env;
    for (const name of ["primary", "secondary"]) {
      const source = `project-alpha:${name}`, workspace = `workspace-${name}`, generation = `generation-${name}`;
      db.prepare("INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES(?,?,?)")
        .run(workspace, source, workspace);
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,project_alpha_source_id)
        VALUES(?,'organization','same-organization',?,?)`).run(workspace, name, source);
      db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
        VALUES(?,?,'snapshot',1,'active',1)`).run(generation, workspace);
      db.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)")
        .run(workspace, generation);
      db.prepare(`INSERT INTO portal_v2_directory_entities
        (workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version)
        VALUES(?,?,'project','same-project',NULL,'Project','binding-v1')`).run(workspace, generation);
      db.prepare(`INSERT INTO portal_v2_folder_bindings
        (id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version)
        VALUES(?,?,'project','same-project',?,'project_alpha','binding-v1')`).run(`binding-${name}`, workspace, prefix);
      db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,email_hint,display_name,source_version,status)
        VALUES(?,'same-principal',?,?,'principal-v1','active')`).run(workspace, email, name);
    }
  });
  afterEach(() => { expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]); db.close(); });

  function receipt(name: string, kind: "guest" | "portal", resource: string) {
    db.prepare(`INSERT INTO project_alpha_delivery_intent_receipts
      (receipt_id,delivery_id,request_fingerprint,access_mode,resource_id,project_alpha_source_id)
      VALUES(?,?,?,?,?,?)`).run(`receipt-${name}`, `delivery-${name}`, "a".repeat(64), kind, resource, `project-alpha:${name}`);
  }
  async function guest(name: string, encryptionSecret = currentTokenSecret) {
    const shareId = `share-${name}`, publicId = `public-${name}`, bearer = `bearer-secret-${name}`;
    const encrypted = await encryptDeliveryToken(bearer, encryptionSecret, shareId);
    db.prepare(`INSERT INTO projects(id,client_name,project_name,r2_prefix,project_alpha_source_id,project_alpha_project_id)
      VALUES(?,'Client','Project',?,?,'same-project')`).run(`project-${name}`, prefix, `project-alpha:${name}`);
    db.prepare(`INSERT INTO shares(id,project_id,token_hash,r2_prefix,created_by_type,created_by_id,recipient_email,
      public_id,secret_ciphertext,secret_iv)
      VALUES(?,?,?,?,'integration',?,?,?,?,?)`).run(shareId, `project-${name}`, `hash-${name}`, prefix,
        `delivery-${name}`, email, publicId, encrypted.ciphertext, encrypted.iv);
    receipt(name, "guest", `share-${name}`);
    db.prepare(`INSERT INTO project_alpha_delivery_guest_authority
      (share_id,workspace_id,folder_binding_id,binding_source_version,directory_generation_id,principal_public_id,principal_source_version)
      VALUES(?,?,?,'binding-v1',?,'same-principal','principal-v1')`)
      .run(`share-${name}`, `workspace-${name}`, `binding-${name}`, `generation-${name}`);
    db.prepare(`INSERT INTO delivery_share_audience_snapshots
      (share_id,share_version,workspace_id,folder_binding_id,owner_scope_type,owner_public_id,directory_generation_id,
       audience_type,audience_public_id,audience_display_name,selected_by_staff_id)
      VALUES(?,1,?,?,'project','same-project',?,'principal','same-principal','Recipient','integration')`)
      .run(shareId,`workspace-${name}`,`binding-${name}`,`generation-${name}`);
    db.prepare(`INSERT INTO delivery_share_recipient_members
      (share_id,share_version,recipient_principal_public_id,recipient_display_name,recipient_normalized_email)
      VALUES(?,1,'same-principal','Recipient',?)`).run(shareId,email);
    db.prepare(`INSERT INTO delivery_notifications
      (id,dedupe_key,share_id,kind,recipient_email,payload_json,share_version,recipient_authority_kind,recipient_principal_public_id)
      VALUES(?,?,?,'share_created',?,?,1,'directory_principal','same-principal')`).run(`notice-${name}`, `dedupe-${name}`, `share-${name}`, email,
        JSON.stringify({ projectName: "Project", publicId }));
    return { shareId, publicId, bearer, encrypted };
  }
  async function ordinary(name: string, status: "queued" | "failed" = "queued") {
    const shareId = `ordinary-share-${name}`, publicId = `ordinary-public-${name}`, bearer = `ordinary-bearer-${name}`;
    const encrypted = await encryptDeliveryToken(bearer, currentTokenSecret, shareId);
    db.prepare(`INSERT INTO projects(id,client_name,project_name,r2_prefix)
      VALUES(?,'Client','Ordinary project',?)`).run(`ordinary-project-${name}`,`jobs/ordinary/${name}/`);
    db.prepare(`INSERT INTO shares(id,project_id,token_hash,r2_prefix,created_by_type,created_by_id,recipient_email,
      public_id,secret_ciphertext,secret_iv,share_version)
      VALUES(?,?,?,?,'staff','staff',?,?,?,?,2)`).run(shareId,`ordinary-project-${name}`,`ordinary-hash-${name}`,
        `jobs/ordinary/${name}/`,email,publicId,encrypted.ciphertext,encrypted.iv);
    db.prepare(`INSERT INTO delivery_notifications
      (id,dedupe_key,share_id,kind,recipient_email,payload_json,status,share_version,recipient_authority_kind)
      VALUES(?,?,?,'share_created',?,?,?,2,'direct_email')`).run(`ordinary-notice-${name}`,`ordinary-dedupe-${name}`,
        shareId,email,JSON.stringify({projectName:"Ordinary project",publicId}),status);
    return {shareId,publicId,bearer};
  }
  function portal(name: string, attempted = true) {
    receipt(name, "portal", `grant-${name}`);
    db.prepare(`INSERT INTO project_alpha_delivery_portal_grants
      (id,receipt_id,workspace_id,folder_binding_id,binding_source_version,audience_type,audience_public_id,audience_source_version,actor_id)
      VALUES(?,?,?,?,'binding-v1','principal','same-principal','principal-v1',?)`)
      .run(`grant-${name}`, `receipt-${name}`, `workspace-${name}`, `binding-${name}`, `delivery-${name}`);
    db.prepare(`INSERT INTO project_alpha_delivery_portal_notification_outbox
      (id,receipt_id,grant_id,principal_public_id,principal_source_version,event_type,attempt_count)
      VALUES(?,?,?,'same-principal','principal-v1','granted',?)`).run(`notice-${name}`, `receipt-${name}`, `grant-${name}`, attempted ? 1 : 0);
  }
  function activateSecondarySource(){
    db.prepare(`INSERT INTO pa_portal_source_authorities(source_id,producer_binding_id,snapshot_origin,snapshot_base_path,
      application_key,state,active_revision,version,connector_revision,connector_version)
      VALUES('project-alpha:secondary','secondary-notification-source','https://secondary.example.test','/','project-alpha','active',1,1,1,1)`).run();
    db.prepare(`INSERT INTO pa_portal_source_authority_revisions(source_id,revision,credential_ref,access_issuer,access_audience,
      access_subject,current_key_id,current_key_fingerprint,created_by)
      VALUES('project-alpha:secondary',1,'secondary','https://access.example.test','audience','subject','key',?,'fixture')`).run("a".repeat(64));
  }

  it("sends valid primary guest mail despite another source's identical prefix, IDs and email", async () => {
    const share = await guest("primary");
    expect(await processDeliveryNotifications(env)).toBe(1);
    expect(sendNotificationMail).toHaveBeenCalledTimes(1);
    expect(sendNotificationMail).toHaveBeenCalledWith(env, expect.objectContaining({ to: email, messageIdKey: "notice-primary" }));
    expect(vi.mocked(sendNotificationMail).mock.calls[0]?.[1].text)
      .toContain(`https://delivery.example.test/s/${share.publicId}#${share.bearer}`);
    const stored = db.prepare("SELECT payload_json FROM delivery_notifications").get()?.payload_json;
    expect(stored).not.toContain("shareUrl");
    expect(stored).not.toContain("#");
    expect(db.prepare("SELECT status FROM delivery_notifications").get()?.status).toBe("sent");
  });

  it("recovers a previous-key bearer at send time and rotates the saved ciphertext", async () => {
    const share = await guest("primary", previousTokenSecret);
    expect(await processDeliveryNotifications(env)).toBe(1);
    const saved = db.prepare("SELECT secret_ciphertext,secret_iv FROM shares WHERE id=?").get(share.shareId) as
      { secret_ciphertext: string; secret_iv: string };
    expect(saved.secret_ciphertext).not.toBe(share.encrypted.ciphertext);
    expect(await decryptDeliveryToken(saved.secret_ciphertext, saved.secret_iv, currentTokenSecret, share.shareId))
      .toBe(share.bearer);
    expect(vi.mocked(sendNotificationMail).mock.calls[0]?.[1].text)
      .toContain(`https://delivery.example.test/s/${share.publicId}#${share.bearer}`);
    expect(db.prepare("SELECT payload_json FROM delivery_notifications").get()?.payload_json).not.toContain("#");
  });

  it("suppresses a queued ordinary-share notice after recipient credential rotation", async () => {
    const share=await ordinary("queued-rotation");
    const rotated=await encryptDeliveryToken("rotated-bearer",currentTokenSecret,share.shareId);
    db.prepare(`UPDATE shares SET share_version=3,recipient_email='new-recipient@example.test',
      public_id='rotated-public',secret_ciphertext=?,secret_iv=? WHERE id=?`)
      .run(rotated.ciphertext,rotated.iv,share.shareId);
    expect(await processDeliveryNotifications(env)).toBe(1);
    expect(sendNotificationMail).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status,last_error FROM delivery_notifications WHERE id=?").get(`ordinary-notice-queued-rotation`))
      .toEqual({status:"failed",last_error:"recipient-no-longer-eligible"});
  });

  it("does not let a previously failed ordinary-share notice deliver a later generation when requeued", async () => {
    const share=await ordinary("failed-rotation","failed");
    const rotated=await encryptDeliveryToken("rotated-bearer",currentTokenSecret,share.shareId);
    db.prepare(`UPDATE shares SET share_version=3,recipient_email='new-recipient@example.test',
      public_id='rotated-public',secret_ciphertext=?,secret_iv=? WHERE id=?`)
      .run(rotated.ciphertext,rotated.iv,share.shareId);
    db.prepare("UPDATE delivery_notifications SET status='queued',next_attempt_at=datetime('now') WHERE id=?")
      .run(`ordinary-notice-failed-rotation`);
    expect(await processDeliveryNotifications(env)).toBe(1);
    expect(sendNotificationMail).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status,last_error FROM delivery_notifications WHERE id=?").get(`ordinary-notice-failed-rotation`))
      .toEqual({status:"failed",last_error:"recipient-no-longer-eligible"});
  });

  it("records provider acceptance after a concurrent recipient rotation without claiming the row was sent",async()=>{
    const share=await ordinary("accepted-rotation");
    vi.mocked(sendNotificationMail).mockImplementationOnce(async()=>{
      const rotated=await encryptDeliveryToken("replacement-bearer",currentTokenSecret,share.shareId);
      db.exec("BEGIN");
      try{
        db.prepare(`UPDATE shares SET share_version=3,recipient_email='replacement@example.test',token_hash='replacement-hash',
          public_id='replacement-public',secret_ciphertext=?,secret_iv=? WHERE id=? AND share_version=2`)
          .run(rotated.ciphertext,rotated.iv,share.shareId);
        db.prepare(`UPDATE delivery_notifications SET status='failed',lease_until=NULL,last_error='share-authorization-rotated'
          WHERE share_id=? AND status='sending'`).run(share.shareId);
        db.exec("COMMIT");
      }catch(error){db.exec("ROLLBACK");throw error;}
    });
    expect(await processDeliveryNotifications(env)).toBe(1);
    expect(sendNotificationMail).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT status,sent_at,last_error FROM delivery_notifications WHERE id=?")
      .get("ordinary-notice-accepted-rotation")).toEqual({status:"failed",sent_at:null,last_error:"provider-accepted-after-suppression"});
    expect(db.prepare("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1").get()?.action)
      .toBe("notification.provider_accepted_after_suppression");
    expect(()=>db.prepare("UPDATE delivery_notifications SET status='queued',last_error=NULL WHERE id=?")
      .run("ordinary-notice-accepted-rotation")).toThrow(/provider accepted after notification suppression is terminal/);
  });

  it("drains an expand-phase legacy URL when the historical share has no encrypted bearer", async () => {
    const share = await guest("primary");
    const legacyUrl = `https://delivery.example.test/s/${share.publicId}#${"L".repeat(43)}`;
    db.prepare("UPDATE shares SET secret_ciphertext=NULL,secret_iv=NULL WHERE id=?").run(share.shareId);
    db.prepare("UPDATE delivery_notifications SET payload_json=? WHERE id='notice-primary'")
      .run(JSON.stringify({ projectName: "Project", publicId: share.publicId, shareUrl: legacyUrl }));
    expect(await processDeliveryNotifications(env)).toBe(1);
    expect(vi.mocked(sendNotificationMail).mock.calls[0]?.[1].text).toContain(legacyUrl);
    expect(db.prepare("SELECT status FROM delivery_notifications WHERE id='notice-primary'").get()?.status).toBe("sent");
  });

  it("rejects credentials embedded in an expand-phase legacy URL", async () => {
    const share = await guest("primary");
    const legacyUrl = `https://user:password@delivery.example.test/s/${share.publicId}#${"L".repeat(43)}`;
    db.prepare("UPDATE shares SET secret_ciphertext=NULL,secret_iv=NULL WHERE id=?").run(share.shareId);
    db.prepare("UPDATE delivery_notifications SET payload_json=? WHERE id='notice-primary'")
      .run(JSON.stringify({ projectName: "Project", publicId: share.publicId, shareUrl: legacyUrl }));
    expect(await processDeliveryNotifications(env)).toBe(1);
    expect(sendNotificationMail).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status,last_error FROM delivery_notifications WHERE id='notice-primary'").get())
      .toEqual({ status: "queued", last_error: "Delivery link bearer cannot be recovered" });
  });

  it("suppresses guest mail rather than borrowing the overlapping primary recipient", async () => {
    await guest("secondary");
    db.exec("UPDATE pa_portal_principals SET status='suspended' WHERE workspace_id='workspace-secondary'");
    expect(await processDeliveryNotifications(env)).toBe(1);
    expect(sendNotificationMail).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status,last_error FROM delivery_notifications").get())
      .toEqual({ status: "failed", last_error: "recipient-no-longer-eligible" });
    expect(db.prepare("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1").get()?.action).toBe("notification.suppressed");
  });

  it("suppresses a guest notice whose exact source generation is no longer selected", async () => {
    await guest("primary");
    db.exec(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
      VALUES('generation-next','workspace-primary','snapshot-next',2,'active',1);
      UPDATE portal_v2_directory_checkpoints SET active_generation_id='generation-next',source_sequence=2 WHERE workspace_id='workspace-primary'`);
    await processDeliveryNotifications(env);
    expect(sendNotificationMail).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM delivery_notifications").get()?.status).toBe("failed");
  });

  it("retains attempted primary portal mail while terminally suppressing a synthetic secondary portal notice", async () => {
    portal("primary"); portal("secondary");
    expect(await processProjectAlphaDeliveryPortalNotifications(env)).toBe(1);
    expect(sendNotificationMail).toHaveBeenCalledTimes(1);
    expect(sendNotificationMail).toHaveBeenCalledWith(env, expect.objectContaining({ to: email, messageIdKey: "notice-primary" }));
    expect(db.prepare("SELECT id,status FROM project_alpha_delivery_portal_notification_outbox ORDER BY id").all()).toEqual([
      { id: "notice-primary", status: "sent" }, { id: "notice-secondary", status: "suppressed" },
    ]);
    expect(db.prepare("SELECT last_error FROM project_alpha_delivery_portal_notification_outbox WHERE id='notice-secondary'").get()?.last_error)
      .toBe("authorization-no-longer-live");
  });

  it("sends a registered secondary-source revocation through the source-qualified direct lane",async()=>{
    activateSecondarySource();portal("secondary");
    db.exec(`UPDATE project_alpha_delivery_portal_grants SET status='revoked',grant_version=grant_version+1,revoked_at=datetime('now') WHERE id='grant-secondary';
      UPDATE project_alpha_delivery_portal_notification_outbox SET event_type='revoked' WHERE id='notice-secondary'`);
    expect(await processProjectAlphaDeliveryPortalNotifications(env)).toBe(1);
    expect(sendNotificationMail).toHaveBeenCalledWith(env,expect.objectContaining({
      to:email,messageIdKey:"notice-secondary",subject:"Portal delivery access revoked",
    }));
    expect(db.prepare("SELECT status FROM project_alpha_delivery_portal_notification_outbox WHERE id='notice-secondary'").get()?.status).toBe("sent");
  });

  it("suppresses a secondary-source direct revocation after its authority is suspended",async()=>{
    activateSecondarySource();portal("secondary");
    db.exec(`UPDATE project_alpha_delivery_portal_grants SET status='revoked',grant_version=grant_version+1,revoked_at=datetime('now') WHERE id='grant-secondary';
      UPDATE project_alpha_delivery_portal_notification_outbox SET event_type='revoked' WHERE id='notice-secondary';
      UPDATE pa_portal_source_authorities SET state='suspended',version=version+1 WHERE source_id='project-alpha:secondary'`);
    expect(await processProjectAlphaDeliveryPortalNotifications(env)).toBe(0);
    expect(sendNotificationMail).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM project_alpha_delivery_portal_notification_outbox WHERE id='notice-secondary'").get()?.status).toBe("suppressed");
  });

  it("keeps the publication result authoritative when suspension races after its final guard",async()=>{
    activateSecondarySource();portal("secondary");
    db.exec(`UPDATE project_alpha_delivery_portal_grants SET status='revoked',grant_version=grant_version+1,revoked_at=datetime('now') WHERE id='grant-secondary';
      UPDATE project_alpha_delivery_portal_notification_outbox SET event_type='revoked' WHERE id='notice-secondary'`);
    vi.mocked(sendNotificationMail).mockImplementationOnce(async()=>{
      db.exec("UPDATE pa_portal_source_authorities SET state='suspended',version=version+1 WHERE source_id='project-alpha:secondary'");
      expect(await processProjectAlphaDeliveryPortalNotifications(env)).toBe(0);
    });
    expect(await processProjectAlphaDeliveryPortalNotifications(env)).toBe(1);
    expect(sendNotificationMail).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT status,last_error FROM project_alpha_delivery_portal_notification_outbox WHERE id='notice-secondary'").get())
      .toEqual({status:"sent",last_error:null});
  });

  it("does not let an expired direct-notification claimant publish after a newer claimant wins",async()=>{
    portal("primary");
    beforeRun=async sql=>{
      if(!sql.includes("SET lease_expires_at=datetime('now','+15 minutes'),updated_at=datetime('now')"))return;
      beforeRun=null;
      db.exec("UPDATE project_alpha_delivery_portal_notification_outbox SET lease_expires_at=datetime('now','-1 second') WHERE id='notice-primary'");
      expect(await processProjectAlphaDeliveryPortalNotifications(env)).toBe(1);
    };
    expect(await processProjectAlphaDeliveryPortalNotifications(env)).toBe(1);
    expect(sendNotificationMail).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT status,attempt_count FROM project_alpha_delivery_portal_notification_outbox WHERE id='notice-primary'").get())
      .toEqual({status:"sent",attempt_count:3});
  });

  it("terminally fails an exhausted direct notification without a fourth provider attempt",async()=>{
    portal("primary");
    db.exec("UPDATE project_alpha_delivery_portal_notification_outbox SET attempt_count=3 WHERE id='notice-primary'");
    expect(await processProjectAlphaDeliveryPortalNotifications(env)).toBe(0);
    expect(sendNotificationMail).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status,attempt_count,last_error FROM project_alpha_delivery_portal_notification_outbox WHERE id='notice-primary'").get())
      .toEqual({status:"failed",attempt_count:3,last_error:"attempts-exhausted"});
  });

  it("rotates the direct lane so a twenty-sixth registered source is handled on the next tick",async()=>{
    for(let index=0;index<26;index+=1){
      const name=`fair${String(index).padStart(2,"0")}`,source=`project-alpha:${name}`,workspace=`workspace-${name}`,generation=`generation-${name}`;
      db.prepare("INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES(?,?,?)").run(workspace,source,workspace);
      db.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,project_alpha_source_id)
        VALUES(?,'organization','same-organization',?,?)`).run(workspace,name,source);
      db.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
        VALUES(?,?,'snapshot',1,'active',1)`).run(generation,workspace);
      db.prepare("INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)").run(workspace,generation);
      db.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version)
        VALUES(?,?,'project','same-project',NULL,'Project','binding-v1')`).run(workspace,generation);
      db.prepare(`INSERT INTO portal_v2_folder_bindings(id,workspace_id,owner_scope_type,owner_public_id,r2_prefix,source_type,source_version)
        VALUES(?,?,'project','same-project',?,'project_alpha','binding-v1')`).run(`binding-${name}`,workspace,prefix);
      db.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,email_hint,display_name,source_version,status)
        VALUES(?,'same-principal',?,?,'principal-v1','active')`).run(workspace,email,name);
      db.prepare(`INSERT INTO pa_portal_source_authorities(source_id,producer_binding_id,snapshot_origin,snapshot_base_path,
        application_key,state,active_revision,version,connector_revision,connector_version)
        VALUES(?,?,?,'/','project-alpha','active',1,1,1,1)`).run(source,`binding-${name}`,`https://${name}.example.test`);
      db.prepare(`INSERT INTO pa_portal_source_authority_revisions(source_id,revision,credential_ref,access_issuer,access_audience,
        access_subject,current_key_id,current_key_fingerprint,created_by)
        VALUES(?,1,?,'https://access.example.test','audience','subject','key',?,'fixture')`).run(source,name,"a".repeat(64));
      portal(name);
      db.prepare("UPDATE project_alpha_delivery_portal_grants SET status='revoked',grant_version=grant_version+1,revoked_at=datetime('now') WHERE id=?")
        .run(`grant-${name}`);
      db.prepare("UPDATE project_alpha_delivery_portal_notification_outbox SET event_type='revoked' WHERE id=?").run(`notice-${name}`);
    }
    const pendingPlan=JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN SELECT id,project_alpha_source_id source_id
      FROM project_alpha_delivery_portal_notification_outbox INDEXED BY idx_project_alpha_delivery_notification_ready_pending
      WHERE status='pending' AND attempt_count<3 AND next_attempt_at<=datetime('now')
      ORDER BY next_attempt_at,created_at,id LIMIT 25`).all());
    const processingPlan=JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN SELECT id,project_alpha_source_id source_id
      FROM project_alpha_delivery_portal_notification_outbox INDEXED BY idx_project_alpha_delivery_notification_ready_processing
      WHERE status='processing' AND attempt_count<3 AND lease_expires_at<=datetime('now')
      ORDER BY lease_expires_at,created_at,id LIMIT 25`).all());
    const sourceDirectPlan=JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM project_alpha_delivery_portal_notification_outbox
      INDEXED BY idx_project_alpha_delivery_notification_source_direct_pending
      WHERE project_alpha_source_id=? AND status='pending' AND attempt_count<3 AND next_attempt_at<=datetime('now')
        AND NOT(event_type='granted' AND attempt_count=0 AND lease_expires_at IS NULL)
      ORDER BY next_attempt_at,created_at,id LIMIT 25`).all("project-alpha:fair00"));
    const exhaustedPendingPlan=JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM project_alpha_delivery_portal_notification_outbox
      INDEXED BY idx_project_alpha_delivery_notification_pending_exhausted
      WHERE status='pending' AND attempt_count>=3 AND next_attempt_at<=datetime('now')
      ORDER BY next_attempt_at,created_at,id LIMIT 50`).all());
    const exhaustedProcessingPlan=JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM project_alpha_delivery_portal_notification_outbox
      INDEXED BY idx_project_alpha_delivery_notification_processing_exhausted
      WHERE status='processing' AND attempt_count>=3 AND lease_expires_at<=datetime('now')
      ORDER BY lease_expires_at,created_at,id LIMIT 50`).all());
    expect(pendingPlan).toContain("idx_project_alpha_delivery_notification_ready_pending");
    expect(processingPlan).toContain("idx_project_alpha_delivery_notification_ready_processing");
    expect(sourceDirectPlan).toContain("idx_project_alpha_delivery_notification_source_direct_pending");
    expect(exhaustedPendingPlan).toContain("idx_project_alpha_delivery_notification_pending_exhausted");
    expect(exhaustedProcessingPlan).toContain("idx_project_alpha_delivery_notification_processing_exhausted");
    expect(sourceDirectPlan+exhaustedPendingPlan+exhaustedProcessingPlan).not.toContain("USE TEMP B-TREE");
    expect(await processProjectAlphaDeliveryPortalNotifications(env)).toBe(25);
    expect(sendNotificationMail).toHaveBeenCalledTimes(25);
    expect(db.prepare("SELECT count(*) count FROM project_alpha_delivery_portal_notification_outbox WHERE status='pending'").get()?.count).toBe(1);
    expect(await processProjectAlphaDeliveryPortalNotifications(env)).toBe(1);
    expect(sendNotificationMail).toHaveBeenCalledTimes(26);
    expect(db.prepare("SELECT count(*) count FROM project_alpha_delivery_portal_notification_outbox WHERE status='sent'").get()?.count).toBe(26);
  });

  it("stages untouched primary portal mail without borrowing another source's overlapping recipient", async () => {
    portal("primary", false); portal("secondary", false);
    expect(await processProjectAlphaDeliveryPortalNotifications(env)).toBe(0);
    expect(sendNotificationMail).not.toHaveBeenCalled();
    const staged = db.prepare("SELECT id,status,source_id FROM portal_delivery_notification_batches").all();
    expect(staged).toEqual([{ id: expect.any(String), status: "pending", source_id: "project-alpha:primary" }]);
    expect(db.prepare("SELECT last_error FROM project_alpha_delivery_portal_notification_outbox WHERE id='notice-secondary'").get()?.last_error)
      .toBe("authorization-no-longer-live");
    db.exec("UPDATE portal_delivery_notification_batches SET eligible_at=datetime('now','-1 second')");
    expect(await processProjectAlphaDeliveryPortalNotifications(env)).toBe(1);
    expect(sendNotificationMail).toHaveBeenCalledTimes(1);
    expect(sendNotificationMail).toHaveBeenCalledWith(env, expect.objectContaining({ to: email, messageIdKey: `native-batch-${staged[0]!.id}` }));
    expect(db.prepare("SELECT status FROM portal_delivery_notification_batches").get()?.status).toBe("sent");
  });

  it.each(["guest", "portal"] as const)("suppresses %s mail when the owner's source revision no longer matches its binding", async kind => {
    if (kind === "guest") await guest("primary"); else portal("primary");
    db.exec("UPDATE portal_v2_directory_entities SET source_version='owner-v2' WHERE workspace_id='workspace-primary'");
    if (kind === "guest") await processDeliveryNotifications(env); else await processProjectAlphaDeliveryPortalNotifications(env);
    expect(sendNotificationMail).not.toHaveBeenCalled();
    const table = kind === "guest" ? "delivery_notifications" : "project_alpha_delivery_portal_notification_outbox";
    expect(db.prepare(`SELECT status FROM ${table}`).get()?.status).toBe(kind === "guest" ? "failed" : "suppressed");
  });
});
