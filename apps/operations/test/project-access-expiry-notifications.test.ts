import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";
import { buildSmtpMessage } from "../src/worker/mailer";
import {
  dispatchProjectAccessExpiryNotices,
  processProjectAccessExpiryNotifications,
  reconcileProjectAccessExpiryNotices,
  type ProjectAccessNoticeDependencies,
} from "../src/worker/project-access-expiry-notifications";

const migration = readFileSync(new URL("../../client/migrations/0169_project_access_expiry_notifications.sql", import.meta.url), "utf8");

const baseSchema = `
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
  CREATE TABLE portal_v2_authenticated_delivery_grants(id TEXT PRIMARY KEY,workspace_id TEXT,audience_type TEXT,status TEXT,
    expires_at TEXT,revoked_at TEXT,access_terms_id TEXT);
  CREATE TABLE portal_v2_authenticated_delivery_grant_recipients(grant_id TEXT,workspace_id TEXT,principal_public_id TEXT,
    identity_id TEXT,principal_source_version TEXT,PRIMARY KEY(grant_id,identity_id));
  CREATE TABLE pa_portal_principals(workspace_id TEXT,public_id TEXT,identity_id TEXT,source_version TEXT,status TEXT,
    PRIMARY KEY(workspace_id,public_id));
  CREATE TABLE portal_v2_identity_denials(id TEXT PRIMARY KEY,identity_id TEXT,workspace_id TEXT,scope_type TEXT,
    scope_public_id TEXT,status TEXT,valid_from TEXT,expires_at TEXT);
  CREATE TABLE portal_v2_membership_audit(id TEXT PRIMARY KEY,workspace_id TEXT,details_json TEXT);
  CREATE TABLE client_delegated_share_events(id TEXT PRIMARY KEY,workspace_id TEXT,event_type TEXT,details_json TEXT);
`;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe("project access expiry migration", () => {
  it("upgrades populated ledgers safely, replays, and makes old/new history immutable", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(baseSchema);
      database.exec(`INSERT INTO portal_v2_identities VALUES('person-a','person@example.test','active',NULL);
        INSERT INTO portal_v2_workspace_memberships VALUES('member-a','workspace-a','person-a','active',NULL,NULL);
        INSERT INTO portal_project_access_terms VALUES('terms-a','workspace-a','project-alpha:one','project-a','collaborator','specific_date','2099-01-01T00:00:00.000Z');
        INSERT INTO portal_v2_membership_audit VALUES('membership-event-a','workspace-a','{}');
        INSERT INTO client_delegated_share_events VALUES('share-event-a','workspace-a','created','{}');`);
      database.exec(migration);
      database.exec(migration);
      expect(database.prepare("SELECT id FROM portal_v2_membership_audit").all()).toEqual([{id:"membership-event-a"}]);
      expect(database.prepare("SELECT id FROM client_delegated_share_events").all()).toEqual([{id:"share-event-a"}]);
      expect(() => database.exec("UPDATE portal_v2_membership_audit SET details_json='[]' WHERE id='membership-event-a'")).toThrow(/immutable/);
      expect(() => database.exec("UPDATE client_delegated_share_events SET details_json='[]' WHERE id='share-event-a'")).toThrow(/immutable/);
      database.exec(`INSERT INTO portal_project_access_notice_outbox
        (id,access_terms_id,workspace_id,source_id,project_public_id,identity_id,event_type,effective_expires_at,message_id_key)
        VALUES('${"a".repeat(64)}','terms-a','workspace-a','project-alpha:one','project-a','person-a','warning_7d','2099-01-01T00:00:00.000Z','project-access:${"a".repeat(64)}')`);
      expect(() => database.exec(`UPDATE portal_project_access_notice_outbox SET identity_id='person-b' WHERE id='${"a".repeat(64)}'`)).toThrow(/immutable/);
      database.exec(`INSERT INTO portal_project_access_notice_audit
        (id,outbox_id,workspace_id,project_public_id,identity_id,event_type,action,attempt_count)
        VALUES('${"b".repeat(64)}','${"a".repeat(64)}','workspace-a','project-a','person-a','warning_7d','notice.staged',0)`);
      expect(() => database.exec(`DELETE FROM portal_project_access_notice_audit WHERE id='${"b".repeat(64)}'`)).toThrow(/immutable/);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { database.close(); }
  });
});

describe("project access expiry processor", {timeout: 90_000}, () => {
  let runtime: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeEach(async () => {
    runtime = new Miniflare({compatibilityDate:"2026-08-06",modules:true,
      script:"export default {fetch(){return new Response('ok')}}",d1Databases:{DELIVERY_DB:"access-notices"}});
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec(baseSchema.replace(/\s*\n\s*/g," "));
    await db.exec(migration.replace(/--.*$/gm,"").replace(/\s*\n\s*/g," "));
    env = {DELIVERY_DB:db,DELIVERY_BASE_URL:"https://client.example.test",
      PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED:"true",CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:"true",
      SMTP_NOTIFICATIONS_ENABLED:"true",SMTP_HOST:"smtp.example.test",SMTP_USERNAME:"smtp@example.test",
      SMTP_PASSWORD:"test-only-password",SMTP_FROM:"notify@example.test",
      NOTIFICATION_FROM:"notify@example.test",NOTIFICATION_EMAIL:{send:async()=>{}} as unknown as SendEmail} as unknown as Env;
  });
  afterEach(async () => runtime?.dispose());

  async function seed(input: {workspace?:string;identity?:string;terms?:string;project?:string;expiresAt:string;
    authority?:"entitlement"|"principal"|"dynamic"}): Promise<void> {
    const workspace = input.workspace ?? "workspace-a", identity = input.identity ?? "person-a";
    const terms = input.terms ?? "terms-a", project = input.project ?? "project-a";
    const source = workspace === "workspace-a" ? "project-alpha:one" : "project-alpha:two";
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO portal_v2_workspaces VALUES(?,?, 'active')").bind(workspace,source),
      db.prepare("INSERT OR IGNORE INTO pa_portal_workspace_sources VALUES(?,?,?)").bind(workspace,source,workspace),
      db.prepare("INSERT OR IGNORE INTO portal_v2_directory_generations VALUES(?,?, 'active',1)").bind(`generation-${workspace}`,workspace),
      db.prepare("INSERT OR IGNORE INTO portal_v2_directory_checkpoints VALUES(?,?)").bind(workspace,`generation-${workspace}`),
      db.prepare("INSERT OR IGNORE INTO portal_v2_directory_entities VALUES(?,?,'project',?,1)").bind(workspace,`generation-${workspace}`,project),
      db.prepare("INSERT OR IGNORE INTO portal_v2_identities VALUES(?,?, 'active',NULL)").bind(identity,`${identity}@example.test`),
      db.prepare("INSERT OR IGNORE INTO portal_v2_workspace_memberships VALUES(?,?,?,'active',NULL,NULL)").bind(`member-${workspace}-${identity}`,workspace,identity),
      db.prepare("INSERT INTO portal_project_access_terms VALUES(?,?,?,?, 'collaborator','specific_date',?)").bind(terms,workspace,source,project,input.expiresAt),
    ]);
    if ((input.authority ?? "entitlement") === "entitlement") {
      await db.prepare(`INSERT INTO portal_v2_entitlements VALUES(?,?,?,'delivery.view','allow','project',?,'active',datetime('now','-1 day'),NULL,NULL,?)`)
        .bind(`entitlement-${terms}`,workspace,identity,project,terms).run();
    } else {
      const dynamic = input.authority === "dynamic";
      await db.prepare("INSERT INTO portal_v2_authenticated_delivery_grants VALUES(?,?,?,'active',NULL,NULL,?)")
        .bind(`grant-${terms}`,workspace,dynamic?"organization":"principal",terms).run();
      if (!dynamic) await db.batch([
        db.prepare("INSERT INTO pa_portal_principals VALUES(?,?,?,?, 'active')").bind(workspace,`principal-${identity}`,identity,"principal-v1"),
        db.prepare("INSERT INTO portal_v2_authenticated_delivery_grant_recipients VALUES(?,?,?,?,?)")
          .bind(`grant-${terms}`,workspace,`principal-${identity}`,identity,"principal-v1"),
      ]);
    }
  }

  async function seedAdditionalEntitledTerms(input: {prefix:string;count:number;expiresAt:string;prestage?:boolean}): Promise<void> {
    const statements:D1PreparedStatement[]=[];
    for (let index=0;index<input.count;index++) {
      const terms=`${input.prefix}-${index}`;
      statements.push(
        db.prepare("INSERT INTO portal_project_access_terms VALUES(?,?,?,?,'collaborator','specific_date',?)")
          .bind(terms,"workspace-a","project-alpha:one","project-a",input.expiresAt),
        db.prepare(`INSERT INTO portal_v2_entitlements VALUES(?,?,?,'delivery.view','allow','project',?,'active',datetime('now','-1 day'),NULL,NULL,?)`)
          .bind(`entitlement-${terms}`,"workspace-a","person-a","project-a",terms),
      );
      if (input.prestage) {
        const id=(index+1).toString(16).padStart(64,"0");
        statements.push(db.prepare(`INSERT INTO portal_project_access_notice_outbox
          (id,access_terms_id,workspace_id,source_id,project_public_id,identity_id,event_type,effective_expires_at,message_id_key)
          VALUES(?,?,?,?,?,?,'warning_7d',?,?)`).bind(id,terms,"workspace-a","project-alpha:one","project-a","person-a",
            input.expiresAt,`preexisting:${id}`));
      }
    }
    for (let offset=0;offset<statements.length;offset+=50) await db.batch(statements.slice(offset,offset+50));
  }

  const rows = () => db.prepare("SELECT event_type,status,attempt_count,error_code,message_id_key FROM portal_project_access_notice_outbox ORDER BY event_type").all();

  it("is inert by default and does not inspect an unavailable database", async () => {
    const off = {PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED:"false",
      DELIVERY_DB:new Proxy({}, {get(){throw new Error("database touched");}})} as unknown as Env;
    await expect(processProjectAccessExpiryNotifications(off)).resolves.toEqual({enabled:false,staged:0,suppressed:0,processed:0});
  });

  it("stages only exact identity authorities and keeps tenants isolated", async () => {
    await seed({expiresAt:iso(6*86400_000)});
    await seed({workspace:"workspace-b",identity:"person-b",terms:"terms-b",project:"project-b",expiresAt:iso(6*86400_000),authority:"principal"});
    await seed({workspace:"workspace-c",identity:"person-c",terms:"terms-c",project:"project-c",expiresAt:iso(6*86400_000),authority:"dynamic"});
    expect(await reconcileProjectAccessExpiryNotices(env)).toEqual({staged:2,suppressed:0});
    const staged = await db.prepare("SELECT workspace_id,identity_id,event_type FROM portal_project_access_notice_outbox ORDER BY workspace_id").all();
    expect(staged.results).toEqual([
      {workspace_id:"workspace-a",identity_id:"person-a",event_type:"warning_7d"},
      {workspace_id:"workspace-b",identity_id:"person-b",event_type:"warning_7d"},
    ]);
  });

  it("filters more than 100 far-future authorities before bounding due work", async () => {
    const nowMs=Date.now();
    await seed({terms:"terms-due",expiresAt:new Date(nowMs+6*86400_000).toISOString()});
    await seedAdditionalEntitledTerms({prefix:"terms-future",count:101,
      expiresAt:new Date(nowMs+30*86400_000).toISOString()});
    expect(await reconcileProjectAccessExpiryNotices(env,nowMs)).toEqual({staged:1,suppressed:0});
    expect(await db.prepare("SELECT access_terms_id,event_type FROM portal_project_access_notice_outbox").all())
      .toMatchObject({results:[{access_terms_id:"terms-due",event_type:"warning_7d"}]});
  });

  it("excludes more than 100 already-reconciled rows before bounding new due work", async () => {
    const nowMs=Date.now();
    await seed({terms:"terms-target",expiresAt:new Date(nowMs+5*86400_000).toISOString()});
    await seedAdditionalEntitledTerms({prefix:"terms-existing",count:101,
      expiresAt:new Date(nowMs+6*86400_000).toISOString(),prestage:true});
    expect(await reconcileProjectAccessExpiryNotices(env,nowMs)).toEqual({staged:1,suppressed:0});
    expect(await db.prepare("SELECT event_type FROM portal_project_access_notice_outbox WHERE access_terms_id='terms-target'").first())
      .toEqual({event_type:"warning_7d"});
  });

  it("deduplicates replay and suppresses an obsolete seven-day warning", async () => {
    const expiry = iso(12*60*60_000);
    await seed({expiresAt:expiry});
    expect(await reconcileProjectAccessExpiryNotices(env,Date.parse(expiry)-6*86400_000)).toEqual({staged:1,suppressed:0});
    expect(await reconcileProjectAccessExpiryNotices(env,Date.parse(expiry)-6*86400_000)).toEqual({staged:0,suppressed:0});
    expect(await reconcileProjectAccessExpiryNotices(env)).toEqual({staged:1,suppressed:1});
    expect((await rows()).results).toEqual([
      expect.objectContaining({event_type:"warning_24h",status:"pending"}),
      expect.objectContaining({event_type:"warning_7d",status:"suppressed",error_code:"obsolete-window"}),
    ]);
  });

  it("rechecks authority immediately before sending and suppresses revocation", async () => {
    await seed({expiresAt:iso(12*60*60_000)});
    await reconcileProjectAccessExpiryNotices(env);
    await db.prepare("UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now')").run();
    const send = vi.fn<ProjectAccessNoticeDependencies["send"]>(async()=>{});
    expect(await dispatchProjectAccessExpiryNotices(env,{send})).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect((await rows()).results[0]).toMatchObject({status:"suppressed",attempt_count:1,error_code:"authority-changed"});
  });

  it("uses the final authority recipient when verified email changes after preflight", async () => {
    await seed({expiresAt:iso(12*60*60_000)});
    await reconcileProjectAccessExpiryNotices(env);
    const send = vi.fn<ProjectAccessNoticeDependencies["send"]>(async()=>{});
    const beforeFinalAuthorization = vi.fn(async()=>{
      await db.prepare("UPDATE portal_v2_identities SET verified_email='current@example.test' WHERE id='person-a'").run();
    });
    expect(await dispatchProjectAccessExpiryNotices(env,{send,beforeFinalAuthorization})).toBe(1);
    expect(beforeFinalAuthorization).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1].to).toBe("current@example.test");
    expect(send.mock.calls[0]![1].to).not.toBe("person-a@example.test");
  });

  it("refuses binding-only delivery because it cannot preserve the stable SMTP Message-ID", async () => {
    await seed({expiresAt:iso(12*60*60_000)});
    await reconcileProjectAccessExpiryNotices(env);
    const send = vi.fn<ProjectAccessNoticeDependencies["send"]>(async()=>{});
    const bindingOnly = {...env,SMTP_NOTIFICATIONS_ENABLED:"false"} as Env;
    expect(await dispatchProjectAccessExpiryNotices(bindingOnly,{send})).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect((await rows()).results[0]).toMatchObject({status:"suppressed",error_code:"mail-disabled"});
  });

  it("sends expired exact terms with a stable Message-ID and no authority mutation", async () => {
    await seed({expiresAt:iso(-60*60_000)});
    expect(await reconcileProjectAccessExpiryNotices(env)).toEqual({staged:1,suppressed:0});
    const send = vi.fn<ProjectAccessNoticeDependencies["send"]>(async()=>{});
    expect(await dispatchProjectAccessExpiryNotices(env,{send})).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]).toMatchObject({to:"person-a@example.test",messageIdKey:expect.stringMatching(/^project-access:[a-f0-9]{64}$/)});
    const smtpMessage=buildSmtpMessage(send.mock.calls[0]![1],env.SMTP_FROM!);
    expect(smtpMessage).toContain(`Message-ID: <${send.mock.calls[0]![1].messageIdKey!.replace(":","-")}@example.test>`);
    expect(JSON.stringify(send.mock.calls[0]![1])).not.toMatch(/"workspace-a"|"project-a"|"terms-a"/);
    expect((await rows()).results[0]).toMatchObject({event_type:"expired",status:"sent",attempt_count:1});
    expect(await db.prepare("SELECT status,revoked_at FROM portal_v2_entitlements").first()).toEqual({status:"active",revoked_at:null});
  });

  it("caps retries at three, redacts provider errors, and reuses Message-ID", async () => {
    await seed({expiresAt:iso(12*60*60_000)});
    await reconcileProjectAccessExpiryNotices(env);
    const ids:string[]=[];
    const send = vi.fn<ProjectAccessNoticeDependencies["send"]>(async(_env,mail)=>{ids.push(mail.messageIdKey!);throw new Error("smtp secret password recipient@example.test");});
    for (let attempt=0; attempt<3; attempt++) {
      await db.prepare("UPDATE portal_project_access_notice_outbox SET next_attempt_at='2000-01-01T00:00:00Z' WHERE status='pending'").run();
      await dispatchProjectAccessExpiryNotices(env,{send});
    }
    expect(ids).toHaveLength(3);expect(new Set(ids).size).toBe(1);
    expect((await rows()).results[0]).toMatchObject({status:"failed",attempt_count:3,error_code:"delivery-attempt-failed"});
    const audit = JSON.stringify((await db.prepare("SELECT action,reason_code FROM portal_project_access_notice_audit").all()).results);
    expect(audit).not.toMatch(/smtp|password|recipient@example/);
  });

  it("suppresses current denials and terminalizes abandoned third attempts", async () => {
    await seed({expiresAt:iso(12*60*60_000)});
    await db.prepare("INSERT INTO portal_v2_identity_denials VALUES('deny-a','person-a','workspace-a','project','project-a','active',datetime('now','-1 day'),NULL)").run();
    expect(await reconcileProjectAccessExpiryNotices(env)).toEqual({staged:0,suppressed:0});
    await db.prepare("DELETE FROM portal_v2_identity_denials").run();
    await reconcileProjectAccessExpiryNotices(env);
    const fail = vi.fn<ProjectAccessNoticeDependencies["send"]>(async()=>{throw new Error("private provider error");});
    for (let attempt=0; attempt<2; attempt++) {
      await db.prepare("UPDATE portal_project_access_notice_outbox SET next_attempt_at='2000-01-01T00:00:00Z' WHERE status='pending'").run();
      await dispatchProjectAccessExpiryNotices(env,{send:fail});
    }
    await db.prepare(`UPDATE portal_project_access_notice_outbox SET status='processing',attempt_count=3,
      lease_token='abandoned',lease_expires_at='2000-01-01T00:00:00Z' WHERE status='pending' AND attempt_count=2`).run();
    const send = vi.fn<ProjectAccessNoticeDependencies["send"]>(async()=>{});
    expect(await dispatchProjectAccessExpiryNotices(env,{send})).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect((await rows()).results[0]).toMatchObject({status:"failed",attempt_count:3,error_code:"lease-expired"});
  });
});
