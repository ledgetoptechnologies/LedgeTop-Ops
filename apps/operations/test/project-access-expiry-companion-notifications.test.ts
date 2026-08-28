import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";
import {
  dispatchProjectAccessExpiryCompanionNotices,
  reconcileProjectAccessExpiryCompanionNotices,
  type ProjectAccessCompanionNoticeDependencies,
} from "../src/worker/project-access-expiry-companion-notifications";

const migration = readFileSync(new URL("../../client/migrations/0169_project_access_expiry_notifications.sql", import.meta.url), "utf8");

const deliverySchema = `
  PRAGMA foreign_keys=ON;
  CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,verified_email TEXT,status TEXT,revoked_at TEXT);
  CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,status TEXT);
  CREATE TABLE portal_v2_workspace_memberships(id TEXT PRIMARY KEY,workspace_id TEXT,identity_id TEXT,status TEXT,
    expires_at TEXT,revoked_at TEXT,UNIQUE(workspace_id,identity_id));
  CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT,source_workspace_id TEXT);
  CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT,status TEXT,complete INTEGER);
  CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT);
  CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,active INTEGER,
    PRIMARY KEY(workspace_id,generation_id,entity_type,public_id));
  CREATE TABLE portal_project_access_terms(id TEXT PRIMARY KEY,workspace_id TEXT,source_id TEXT,project_public_id TEXT,
    kind TEXT,mode TEXT,expires_at TEXT);
  CREATE TABLE portal_project_access_deadlines(access_terms_id TEXT PRIMARY KEY,deadline_at TEXT);
  CREATE TABLE portal_v2_entitlements(id TEXT PRIMARY KEY,workspace_id TEXT,identity_id TEXT,capability TEXT,effect TEXT,
    scope_type TEXT,scope_public_id TEXT,status TEXT,valid_from TEXT,expires_at TEXT,revoked_at TEXT,access_terms_id TEXT);
  CREATE TABLE portal_v2_invitations(id TEXT PRIMARY KEY,workspace_id TEXT,token_hash TEXT,invited_email TEXT,
    invited_by_identity_id TEXT,status TEXT,expires_at TEXT,revoked_at TEXT,accepted_at TEXT,accepted_by_identity_id TEXT,created_at TEXT);
  CREATE TABLE portal_v2_invitation_entitlements(invitation_id TEXT,capability TEXT,scope_type TEXT,scope_public_id TEXT,
    access_terms_id TEXT,PRIMARY KEY(invitation_id,capability,scope_type,scope_public_id));
  CREATE TABLE portal_v2_folder_bindings(id TEXT PRIMARY KEY,workspace_id TEXT,owner_scope_type TEXT,owner_public_id TEXT,
    source_version TEXT,status TEXT,UNIQUE(id,workspace_id));
  CREATE TABLE portal_v2_authenticated_delivery_grants(id TEXT PRIMARY KEY,workspace_id TEXT,folder_binding_id TEXT,
    binding_source_version TEXT,audience_type TEXT,status TEXT,expires_at TEXT,revoked_at TEXT,access_terms_id TEXT,
    created_by_staff_id TEXT);
  CREATE TABLE portal_v2_authenticated_delivery_grant_recipients(grant_id TEXT,workspace_id TEXT,principal_public_id TEXT,
    identity_id TEXT,principal_source_version TEXT,PRIMARY KEY(grant_id,identity_id));
  CREATE TABLE pa_portal_principals(workspace_id TEXT,public_id TEXT,identity_id TEXT,source_version TEXT,status TEXT,
    PRIMARY KEY(workspace_id,public_id));
  CREATE TABLE portal_v2_identity_denials(id TEXT PRIMARY KEY,identity_id TEXT,workspace_id TEXT,scope_type TEXT,
    scope_public_id TEXT,status TEXT,valid_from TEXT,expires_at TEXT);
  CREATE TABLE portal_v2_membership_audit(id TEXT PRIMARY KEY,workspace_id TEXT,details_json TEXT);
  CREATE TABLE client_delegated_share_events(id TEXT PRIMARY KEY,workspace_id TEXT,event_type TEXT,details_json TEXT);
  CREATE TABLE portal_workspace_invitation_approvals(id TEXT PRIMARY KEY,invitation_id TEXT,actor_staff_id TEXT);
`;

const opsSchema = `CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,status TEXT);`;

function iso(offsetMs: number): string {
  return new Date(Date.now()+offsetMs).toISOString();
}

describe("companion expiry migration", () => {
  it("upgrades populated history, replays, and protects companion identity and audit", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(deliverySchema);
      db.exec(`INSERT INTO portal_v2_identities VALUES('recipient','recipient@example.test','active',NULL);
        INSERT INTO portal_v2_workspace_memberships VALUES('member','workspace-a','recipient','active',NULL,NULL);
        INSERT INTO portal_project_access_terms VALUES('terms-a','workspace-a','project-alpha:one','project-a','collaborator','specific_date','2099-01-01T00:00:00Z');
        INSERT INTO portal_v2_invitations VALUES('invite-a','workspace-a','token','recipient@example.test','inviter-a','pending','2099-01-01T00:00:00Z',NULL,NULL,NULL,datetime('now'));
        UPDATE portal_v2_invitations SET invited_by_identity_id='inviter-b' WHERE id='invite-a';`);
      db.exec(migration); db.exec(migration);
      db.exec("UPDATE portal_v2_invitations SET invited_by_identity_id='inviter-prelink' WHERE id='invite-a'");
      db.exec(`INSERT INTO portal_v2_invitation_entitlements VALUES('invite-a','delivery.view','project','project-a','terms-a')`);
      expect(() => db.exec("UPDATE portal_v2_invitations SET invited_by_identity_id='inviter-c' WHERE id='invite-a'")).toThrow(/provenance is immutable/);
      db.exec("UPDATE portal_v2_invitations SET status='accepted',accepted_by_identity_id='recipient' WHERE id='invite-a'");
      expect(() => db.exec("UPDATE portal_v2_invitations SET accepted_by_identity_id='other-recipient' WHERE id='invite-a'")).toThrow(/provenance is immutable/);
      expect(() => db.exec(`INSERT OR REPLACE INTO portal_v2_invitations VALUES(
        'invite-a','workspace-a','replacement-token','recipient@example.test','replacement-inviter','accepted',
        '2099-01-01T00:00:00Z',NULL,datetime('now'),'replacement-recipient',datetime('now'))`)).toThrow(/cannot be replaced/);
      const id = "a".repeat(64);
      db.exec(`INSERT INTO portal_project_access_companion_notice_outbox
        (id,access_terms_id,workspace_id,source_id,project_public_id,recipient_role,origin_id,companion_actor_id,event_type,effective_expires_at,message_id_key)
        VALUES('${id}','terms-a','workspace-a','project-alpha:one','project-a','inviter','invite-a','inviter-a','warning_7d','2099-01-01T00:00:00Z','project-access-companion:${id}')`);
      expect(() => db.exec(`UPDATE portal_project_access_companion_notice_outbox SET origin_id='invite-b' WHERE id='${id}'`)).toThrow(/immutable/);
      const audit = "b".repeat(64);
      db.exec(`INSERT INTO portal_project_access_companion_notice_audit
        (id,outbox_id,workspace_id,project_public_id,recipient_role,event_type,action,attempt_count)
        VALUES('${audit}','${id}','workspace-a','project-a','inviter','warning_7d','notice.staged',0)`);
      expect(() => db.exec(`DELETE FROM portal_project_access_companion_notice_audit WHERE id='${audit}'`)).toThrow(/immutable/);
      const claim = "c".repeat(64);
      db.exec(`INSERT INTO portal_project_access_companion_recipient_claims
        (id,access_terms_id,event_type,effective_expires_at,recipient_email_hash,winner_outbox_id)
        VALUES('${claim}','terms-a','warning_7d','2099-01-01T00:00:00Z','${"d".repeat(64)}','${id}')`);
      expect(() => db.exec(`UPDATE portal_project_access_companion_recipient_claims SET winner_outbox_id='other' WHERE id='${claim}'`)).toThrow(/immutable/);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { db.close(); }
  });
});

describe("project access companion expiry processor", {timeout:120_000}, () => {
  let runtime: Miniflare;
  let delivery: D1Database;
  let ops: D1Database;
  let env: Env;

  beforeEach(async () => {
    runtime = new Miniflare({compatibilityDate:"2026-08-06",modules:true,
      script:"export default {fetch(){return new Response('ok')}}",
      d1Databases:{DELIVERY_DB:"companion-delivery",OPS_DB:"companion-ops"}});
    delivery = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    ops = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    await delivery.exec(deliverySchema.replace(/\s*\n\s*/g," "));
    await delivery.exec(migration.replace(/--.*$/gm,"").replace(/\s*\n\s*/g," "));
    await ops.exec(opsSchema);
    env = {DELIVERY_DB:delivery,OPS_DB:ops,PUBLIC_BASE_URL:"https://ops.example.test",
      DELIVERY_BASE_URL:"https://client.example.test",PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED:"true",
      CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:"true",SMTP_NOTIFICATIONS_ENABLED:"true",
      SMTP_HOST:"smtp.example.test",SMTP_USERNAME:"smtp@example.test",SMTP_PASSWORD:"password",
      SMTP_FROM:"notify@example.test",NOTIFICATION_FROM:"notify@example.test",
      NOTIFICATION_EMAIL:{send:async()=>{}} as unknown as SendEmail} as unknown as Env;
  });
  afterEach(async () => runtime?.dispose());

  async function seedBase(expiresAt=iso(12*60*60_000)): Promise<void> {
    await delivery.batch([
      delivery.prepare("INSERT INTO portal_v2_workspaces VALUES('workspace-a','project-alpha:one','active')"),
      delivery.prepare("INSERT INTO pa_portal_workspace_sources VALUES('workspace-a','project-alpha:one','source-workspace-a')"),
      delivery.prepare("INSERT INTO portal_v2_directory_generations VALUES('generation-a','workspace-a','active',1)"),
      delivery.prepare("INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-a','generation-a')"),
      delivery.prepare("INSERT INTO portal_v2_directory_entities VALUES('workspace-a','generation-a','project','project-a',1)"),
      delivery.prepare("INSERT INTO portal_project_access_terms VALUES('terms-a','workspace-a','project-alpha:one','project-a','collaborator','specific_date',?)").bind(expiresAt),
      delivery.prepare("INSERT INTO portal_v2_identities VALUES('recipient','recipient@example.test','active',NULL)"),
      delivery.prepare("INSERT INTO portal_v2_workspace_memberships VALUES('recipient-member','workspace-a','recipient','active',NULL,NULL)"),
      delivery.prepare(`INSERT INTO portal_v2_entitlements VALUES('recipient-entitlement','workspace-a','recipient','delivery.view','allow',
        'project','project-a','active',datetime('now','-1 day'),NULL,NULL,'terms-a')`),
    ]);
  }

  async function seedInvitation(invitation="invite-a", inviter="inviter", email="inviter@example.test",
    acceptedIdentity="recipient"): Promise<void> {
    await delivery.batch([
      delivery.prepare("INSERT OR IGNORE INTO portal_v2_identities VALUES(?,?,'active',NULL)").bind(inviter,email),
      delivery.prepare("INSERT OR IGNORE INTO portal_v2_workspace_memberships VALUES(?,?,?,'active',NULL,NULL)")
        .bind(`member-${inviter}`,"workspace-a",inviter),
      delivery.prepare(`INSERT INTO portal_v2_invitations VALUES(?,?,'token',?,?,'accepted',datetime('now','+1 day'),NULL,
        datetime('now'),?,datetime('now','-1 day'))`).bind(invitation,"workspace-a","recipient@example.test",inviter,acceptedIdentity),
      delivery.prepare("INSERT INTO portal_v2_invitation_entitlements VALUES(?,'delivery.view','project','project-a','terms-a')").bind(invitation),
    ]);
  }

  async function seedGrant(input: {id?:string;creator?:string;email?:string;audience?:string;project?:string}={}): Promise<void> {
    const id=input.id??"grant-a",creator=input.creator??"staff-a",project=input.project??"project-a";
    await ops.prepare("INSERT OR IGNORE INTO staff_users VALUES(?,?, 'active')").bind(creator,input.email??`${creator}@example.test`).run();
    await delivery.batch([
      delivery.prepare("INSERT OR IGNORE INTO portal_v2_folder_bindings VALUES(?,?,'project',?,'binding-v1','active')")
        .bind(`binding-${id}`,"workspace-a",project),
      delivery.prepare(`INSERT INTO portal_v2_authenticated_delivery_grants VALUES(?,?,?,'binding-v1',?,'active',NULL,NULL,'terms-a',?)`)
        .bind(id,"workspace-a",`binding-${id}`,input.audience??"principal",creator),
    ]);
    if ((input.audience??"principal") === "principal") await delivery.batch([
      delivery.prepare("INSERT OR IGNORE INTO pa_portal_principals VALUES('workspace-a','principal-recipient','recipient','principal-v1','active')"),
      delivery.prepare("INSERT INTO portal_v2_authenticated_delivery_grant_recipients VALUES(?,'workspace-a','principal-recipient','recipient','principal-v1')").bind(id),
    ]);
  }

  const companionRows = () => delivery.prepare(`SELECT recipient_role,origin_id,companion_actor_id,event_type,status,
    attempt_count,error_code,message_id_key FROM portal_project_access_companion_notice_outbox ORDER BY recipient_role,origin_id`).all();

  it("uses the exact invitation inviter, never the separate approval actor", async () => {
    await seedBase(); await seedInvitation();
    await delivery.prepare("INSERT INTO portal_workspace_invitation_approvals VALUES('approval-a','invite-a','approver-staff')").run();
    expect(await reconcileProjectAccessExpiryCompanionNotices(env)).toEqual({staged:1,suppressed:0});
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    expect(await dispatchProjectAccessExpiryCompanionNotices(env,{send})).toBe(1);
    expect(send.mock.calls[0]![1]).toMatchObject({to:"inviter@example.test",subject:expect.stringContaining("collaborator")});
    expect(JSON.stringify(send.mock.calls[0]![1])).not.toContain("approver-staff");
  });

  it("rejects an invitation origin whose current collaborator authority is not the accepted identity", async () => {
    await seedBase();
    await delivery.batch([
      delivery.prepare("INSERT INTO portal_v2_identities VALUES('other-recipient','other@example.test','active',NULL)"),
      delivery.prepare("INSERT INTO portal_v2_workspace_memberships VALUES('other-member','workspace-a','other-recipient','active',NULL,NULL)"),
    ]);
    await seedInvitation("invite-a","inviter","inviter@example.test","other-recipient");
    expect(await reconcileProjectAccessExpiryCompanionNotices(env)).toEqual({staged:0,suppressed:0});
  });

  it("uses the exact principal-grant creator and labels that person as access creator, not manager", async () => {
    await seedBase(); await seedGrant();
    expect(await reconcileProjectAccessExpiryCompanionNotices(env)).toEqual({staged:1,suppressed:0});
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    await dispatchProjectAccessExpiryCompanionNotices(env,{send});
    expect(send.mock.calls[0]![1]).toMatchObject({to:"staff-a@example.test"});
    expect(`${send.mock.calls[0]![1].text} ${send.mock.calls[0]![1].html}`).toContain("you created");
    expect(JSON.stringify(send.mock.calls[0]![1])).not.toMatch(/manager/i);
  });

  it("fails closed for ambiguous invitation and same-creator grant origins and ignores dynamic grants", async () => {
    await seedBase();
    await seedInvitation("invite-a","inviter-a","a@example.test");
    await seedInvitation("invite-b","inviter-b","b@example.test");
    await seedGrant({id:"grant-a",creator:"staff-a"});
    await seedGrant({id:"grant-b",creator:"staff-a"});
    await seedGrant({id:"grant-dynamic",creator:"staff-dynamic",audience:"organization"});
    expect(await reconcileProjectAccessExpiryCompanionNotices(env)).toEqual({staged:0,suppressed:0});
    expect((await companionRows()).results).toEqual([]);
  });

  it("rejects inactive, revoked, cross-project, and cross-tenant origins", async () => {
    await seedBase(); await seedInvitation();
    await delivery.prepare("UPDATE portal_v2_workspace_memberships SET status='suspended' WHERE identity_id='inviter'").run();
    await seedGrant({id:"grant-wrong-project",creator:"staff-a",project:"project-other"});
    await seedGrant({id:"grant-revoked",creator:"staff-b"});
    await delivery.prepare("UPDATE portal_v2_authenticated_delivery_grants SET status='revoked',revoked_at=datetime('now') WHERE id='grant-revoked'").run();
    await ops.prepare("UPDATE staff_users SET status='inactive' WHERE id='staff-a'").run();
    expect(await reconcileProjectAccessExpiryCompanionNotices(env)).toEqual({staged:0,suppressed:0});
  });

  it("suppresses a companion whose current e-mail is already a collaborator recipient", async () => {
    await seedBase(); await seedInvitation("invite-a","inviter","recipient@example.test");
    await reconcileProjectAccessExpiryCompanionNotices(env);
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    await dispatchProjectAccessExpiryCompanionNotices(env,{send});
    expect(send).not.toHaveBeenCalled();
    expect((await companionRows()).results[0]).toMatchObject({status:"suppressed",error_code:"duplicate-recipient"});
  });

  it("uses the final current inviter e-mail after a preflight race", async () => {
    await seedBase(); await seedInvitation(); await reconcileProjectAccessExpiryCompanionNotices(env);
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    await dispatchProjectAccessExpiryCompanionNotices(env,{send,beforeFinalAuthorization:async()=>{
      await delivery.prepare("UPDATE portal_v2_identities SET verified_email='current-inviter@example.test' WHERE id='inviter'").run();
    }});
    expect(send.mock.calls[0]![1].to).toBe("current-inviter@example.test");
  });

  it("uses the final current staff e-mail after a preflight race", async () => {
    await seedBase(); await seedGrant(); await reconcileProjectAccessExpiryCompanionNotices(env);
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    await dispatchProjectAccessExpiryCompanionNotices(env,{send,beforeFinalAuthorization:async()=>{
      await ops.prepare("UPDATE staff_users SET email='current-staff@example.test' WHERE id='staff-a'").run();
    }});
    expect(send.mock.calls[0]![1].to).toBe("current-staff@example.test");
  });

  it("reauthorizes after the recipient claim and never sends a stale staff e-mail", async () => {
    await seedBase(); await seedGrant(); await reconcileProjectAccessExpiryCompanionNotices(env);
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    await dispatchProjectAccessExpiryCompanionNotices(env,{send,afterRecipientClaim:async()=>{
      await ops.prepare("UPDATE staff_users SET email='post-claim@example.test' WHERE id='staff-a'").run();
    }});
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1].to).toBe("post-claim@example.test");
    expect(send.mock.calls[0]![1].to).not.toBe("staff-a@example.test");
  });

  it("does not send from an owner whose lease is reclaimed immediately before SMTP", async () => {
    await seedBase(); await seedGrant(); await reconcileProjectAccessExpiryCompanionNotices(env);
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    await dispatchProjectAccessExpiryCompanionNotices(env,{send,beforeSendLeaseCheck:async()=>{
      await delivery.prepare(`UPDATE portal_project_access_companion_notice_outbox
        SET attempt_count=attempt_count+1,lease_token='replacement-owner',
          lease_expires_at=datetime('now','+5 minutes')
        WHERE status='processing'`).run();
      await delivery.prepare(`UPDATE portal_project_access_companion_recipient_reservations
        SET lease_token='replacement-owner',lease_expires_at=datetime('now','+5 minutes'),updated_at=datetime('now')`).run();
    }});
    expect(send).not.toHaveBeenCalled();
    expect(await delivery.prepare(`SELECT status,attempt_count,lease_token
      FROM portal_project_access_companion_notice_outbox`).first()).toEqual({
        status:"processing",attempt_count:2,lease_token:"replacement-owner",
      });
    expect(await delivery.prepare("SELECT count(*) count FROM portal_project_access_companion_recipient_claims").first())
      .toEqual({count:0});
  });

  it("rereads final authority after the send hook and suppresses a new denial", async () => {
    await seedBase(); await seedInvitation(); await reconcileProjectAccessExpiryCompanionNotices(env);
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    await dispatchProjectAccessExpiryCompanionNotices(env,{send,beforeSendLeaseCheck:async()=>{
      await delivery.prepare(`INSERT INTO portal_v2_identity_denials VALUES('deny-at-send','inviter','workspace-a','project',
        'project-a','active',datetime('now','-1 day'),NULL)`).run();
    }});
    expect(send).not.toHaveBeenCalled();
    expect((await companionRows()).results[0]).toMatchObject({status:"suppressed",error_code:"authority-changed"});
    expect(await delivery.prepare("SELECT count(*) count FROM portal_project_access_companion_recipient_claims").first())
      .toEqual({count:0});
  });

  it("rereads final authority after the send hook and suppresses membership loss", async () => {
    await seedBase(); await seedInvitation(); await reconcileProjectAccessExpiryCompanionNotices(env);
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    await dispatchProjectAccessExpiryCompanionNotices(env,{send,beforeSendLeaseCheck:async()=>{
      await delivery.prepare("UPDATE portal_v2_workspace_memberships SET status='suspended' WHERE identity_id='inviter'").run();
    }});
    expect(send).not.toHaveBeenCalled();
    expect((await companionRows()).results[0]).toMatchObject({status:"suppressed",error_code:"authority-changed"});
    expect(await delivery.prepare("SELECT count(*) count FROM portal_project_access_companion_recipient_claims").first())
      .toEqual({count:0});
  });

  it("requires the final send-hook e-mail hash to match the reserved recipient", async () => {
    await seedBase(); await seedGrant(); await reconcileProjectAccessExpiryCompanionNotices(env);
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    await dispatchProjectAccessExpiryCompanionNotices(env,{send,beforeSendLeaseCheck:async()=>{
      await ops.prepare("UPDATE staff_users SET email='changed-at-send@example.test' WHERE id='staff-a'").run();
    }});
    expect(send).not.toHaveBeenCalled();
    expect((await companionRows()).results[0]).toMatchObject({status:"suppressed",error_code:"authority-changed"});
    expect(await delivery.prepare("SELECT count(*) count FROM portal_project_access_companion_recipient_claims").first())
      .toEqual({count:0});
  });

  it("releases an unsent stale address so a second actor can claim it after the winner moves", async () => {
    await seedBase(); await seedInvitation("invite-a","inviter","shared@example.test");
    await seedGrant({creator:"staff-a",email:"shared@example.test"});
    await reconcileProjectAccessExpiryCompanionNotices(env);
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    await dispatchProjectAccessExpiryCompanionNotices(env,{send,afterRecipientClaim:async()=>{
      await delivery.prepare(`UPDATE portal_v2_identities SET verified_email='moved@example.test'
        WHERE id='inviter' AND verified_email='shared@example.test'`).run();
    }});
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map(call=>call[1].to).sort()).toEqual(["moved@example.test","shared@example.test"]);
    expect((await companionRows()).results).toEqual([
      expect.objectContaining({recipient_role:"access_creator",status:"sent",error_code:null}),
      expect.objectContaining({recipient_role:"inviter",status:"sent",error_code:null}),
    ]);
    expect(await delivery.prepare("SELECT count(*) count FROM portal_project_access_companion_recipient_claims").first())
      .toEqual({count:2});
    expect(await delivery.prepare(`SELECT count(*) count FROM portal_project_access_companion_notice_audit
      WHERE action='notice.sent'`).first()).toEqual({count:2});
  });

  it("suppresses a denial added after the recipient claim", async () => {
    await seedBase(); await seedInvitation(); await reconcileProjectAccessExpiryCompanionNotices(env);
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    await dispatchProjectAccessExpiryCompanionNotices(env,{send,afterRecipientClaim:async()=>{
      await delivery.prepare(`INSERT INTO portal_v2_identity_denials VALUES('deny-after-claim','inviter','workspace-a','global',
        'global','active',datetime('now','-1 day'),NULL)`).run();
    }});
    expect(send).not.toHaveBeenCalled();
    expect((await companionRows()).results[0]).toMatchObject({status:"suppressed",error_code:"authority-changed"});
  });

  it("suppresses inviter membership loss after the recipient claim", async () => {
    await seedBase(); await seedInvitation(); await reconcileProjectAccessExpiryCompanionNotices(env);
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    await dispatchProjectAccessExpiryCompanionNotices(env,{send,afterRecipientClaim:async()=>{
      await delivery.prepare("UPDATE portal_v2_workspace_memberships SET status='suspended' WHERE identity_id='inviter'").run();
    }});
    expect(send).not.toHaveBeenCalled();
    expect((await companionRows()).results[0]).toMatchObject({status:"suppressed",error_code:"authority-changed"});
  });

  it("suppresses a final-read race when the inviter membership changes", async () => {
    await seedBase(); await seedInvitation(); await reconcileProjectAccessExpiryCompanionNotices(env);
    const inviterSend=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    await dispatchProjectAccessExpiryCompanionNotices(env,{send:inviterSend,beforeFinalAuthorization:async()=>{
      await delivery.prepare("UPDATE portal_v2_workspace_memberships SET status='suspended' WHERE identity_id='inviter'").run();
    }});
    expect(inviterSend).not.toHaveBeenCalled();
    expect((await companionRows()).results[0]).toMatchObject({status:"suppressed",error_code:"authority-changed"});
  });

  it("excludes a denied inviter and suppresses a denial added during the final-read race", async () => {
    await seedBase(); await seedInvitation();
    await delivery.prepare(`INSERT INTO portal_v2_identity_denials VALUES('deny-inviter','inviter','workspace-a','project',
      'project-a','active',datetime('now','-1 day'),NULL)`).run();
    expect(await reconcileProjectAccessExpiryCompanionNotices(env)).toEqual({staged:0,suppressed:0});
    await delivery.prepare("DELETE FROM portal_v2_identity_denials").run();
    await reconcileProjectAccessExpiryCompanionNotices(env);
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    await dispatchProjectAccessExpiryCompanionNotices(env,{send,beforeFinalAuthorization:async()=>{
      await delivery.prepare(`INSERT INTO portal_v2_identity_denials VALUES('deny-race','inviter','workspace-a','workspace',
        'workspace-a','active',datetime('now','-1 day'),NULL)`).run();
    }});
    expect(send).not.toHaveBeenCalled();
    expect((await companionRows()).results[0]).toMatchObject({status:"suppressed",error_code:"authority-changed"});
  });

  it("deterministically sends one companion when inviter and access creator resolve to the same e-mail", async () => {
    await seedBase(); await seedInvitation("invite-a","inviter","shared@example.test");
    await seedGrant({creator:"staff-a",email:"shared@example.test"});
    expect(await reconcileProjectAccessExpiryCompanionNotices(env)).toEqual({staged:2,suppressed:0});
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    expect(await dispatchProjectAccessExpiryCompanionNotices(env,{send})).toBe(2);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1].to).toBe("shared@example.test");
    expect((await companionRows()).results).toEqual([
      expect.objectContaining({recipient_role:"access_creator",status:"suppressed",error_code:"duplicate-recipient"}),
      expect.objectContaining({recipient_role:"inviter",status:"sent",error_code:null}),
    ]);
  });

  it("deduplicates on final addresses when an access-creator e-mail changes after preflight", async () => {
    await seedBase(); await seedInvitation("invite-a","inviter","shared@example.test");
    await seedGrant({creator:"staff-a",email:"staff-before@example.test"});
    await reconcileProjectAccessExpiryCompanionNotices(env);
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async()=>{});
    await dispatchProjectAccessExpiryCompanionNotices(env,{send,beforeFinalAuthorization:async()=>{
      await ops.prepare("UPDATE staff_users SET email='shared@example.test' WHERE id='staff-a'").run();
    }});
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1].to).toBe("shared@example.test");
    expect((await companionRows()).results.filter(row=>row.status==="suppressed")).toHaveLength(1);
  });

  it("keeps companion retry state isolated, caps at three, redacts errors, and keeps Message-ID stable", async () => {
    await seedBase(); await seedGrant(); await reconcileProjectAccessExpiryCompanionNotices(env);
    await delivery.prepare(`INSERT INTO portal_project_access_notice_outbox
      (id,access_terms_id,workspace_id,source_id,project_public_id,identity_id,event_type,effective_expires_at,message_id_key)
      SELECT lower(hex(randomblob(32))),access_terms_id,workspace_id,source_id,project_public_id,'recipient',event_type,
        effective_expires_at,'collaborator-independent' FROM portal_project_access_companion_notice_outbox`).run();
    const ids:string[]=[];
    const send=vi.fn<ProjectAccessCompanionNoticeDependencies["send"]>(async(_env,mail)=>{
      ids.push(mail.messageIdKey!); throw new Error("private smtp recipient@example.test password");
    });
    for(let attempt=0;attempt<3;attempt++) {
      await delivery.prepare("UPDATE portal_project_access_companion_notice_outbox SET next_attempt_at='2000-01-01T00:00:00Z' WHERE status='pending'").run();
      await dispatchProjectAccessExpiryCompanionNotices(env,{send});
    }
    expect(new Set(ids).size).toBe(1);
    expect((await companionRows()).results[0]).toMatchObject({status:"failed",attempt_count:3,error_code:"delivery-attempt-failed"});
    expect(await delivery.prepare("SELECT status,attempt_count FROM portal_project_access_notice_outbox").first())
      .toEqual({status:"pending",attempt_count:0});
    expect(JSON.stringify((await delivery.prepare("SELECT action,reason_code FROM portal_project_access_companion_notice_audit").all()).results))
      .not.toMatch(/smtp|password|recipient@example/);
  });
});
