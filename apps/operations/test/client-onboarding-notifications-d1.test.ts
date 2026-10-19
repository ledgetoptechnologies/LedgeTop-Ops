import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { processClientOnboardingNotifications, clientOnboardingNotificationConfiguration } from "../src/worker/client-onboarding-notifications";
import { readClientOnboardingNotificationRecipient } from "../src/worker/client-onboarding-review";
import type { Env } from "../src/worker/types";
import type { OutboundMail } from "../src/worker/mailer";
import * as mailer from "../src/worker/mailer";

let runtime: Miniflare;
let db: D1Database;
let sequence = 0;
const staffId = "onboarding-notice-reviewer";
const uuid = () => `30000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`;
const expiry = new Date(Date.now() + 3_600_000).toISOString();
const fields = { clientType: "consumer", name: "Private client name", email: "client@example.test",
  phone: "", organizationName: "", organizationEmail: "", organizationPhone: "",
  addressLine1: "Private address", addressLine2: "", city: "Town", state: "WI", postalCode: "53000", country: "US" };

async function event() {
  const invitation = uuid(), command = uuid(), submission = uuid();
  const createdAt = new Date(Date.UTC(2020, 0, 1, 0, 0, sequence)).toISOString();
  await db.prepare(`INSERT INTO client_onboarding_invitations
    (invitation_id,secret_sha256,issued_by,bound_access_subject,expires_at,state,version)
    VALUES(?,?,?,'access|notice-reviewer',?,'pending',1)`).bind(invitation, "a".repeat(64), staffId, expiry).run();
  await db.prepare(`INSERT INTO client_onboarding_issuance_commands
    (invitation_id,command_id,request_sha256,scopes_json,issuer_admission_version,issuer_profile_version,issuer_email,verified_until)
    VALUES(?,?,?, ?,1,1,'reviewer@example.test',?)`)
    .bind(invitation, command, "b".repeat(64), JSON.stringify([{ businessAreaId: "area:a", divisionId: null }]), expiry).run();
  await db.prepare(`INSERT INTO client_onboarding_submissions
    (invitation_id,submission_id,fields_json,fields_sha256,created_at) VALUES(?,?,?,?,?)`)
    .bind(invitation, submission, JSON.stringify(fields), "c".repeat(64), createdAt).run();
  const env = { OPS_DB: db, CLIENT_ONBOARDING_NOTIFICATIONS_ENABLED: "true",
    CLIENT_ONBOARDING_NOTIFICATIONS_NOT_BEFORE: createdAt,
    CLIENT_ONBOARDING_NOTIFICATION_STAFF_IDS: JSON.stringify([staffId]),
    CLIENT_ONBOARDING_ADMIN_ORIGIN: "https://ops.example.test",
    NOTIFICATION_EMAIL: { send: vi.fn() }, NOTIFICATION_FROM: "notices@example.test" } as unknown as Env;
  return { submission, env };
}

describe("durable onboarding review notifications", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)
      && (name.slice(0, 4) <= "0095" || name.startsWith("0213_"))).sort()) {
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
      if (name.startsWith("0057_")) await db.prepare("INSERT INTO native_business_areas(id,name) VALUES('area:a','Area A')").run();
    }
    await db.batch([
      db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,'reviewer@example.test','Reviewer','access|notice-reviewer')`).bind(staffId),
      db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,'access|notice-reviewer',1,?)").bind(staffId, staffId),
      db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,'reviewer@example.test','Reviewer')").bind(staffId),
      db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by)
        VALUES('notice-allow',?,'directory.profile.edit','allow','global',?)`).bind(staffId, staffId),
    ]);
  }, 120_000);
  afterAll(async () => runtime?.dispose());

  it("does nothing when disabled and rejects an unsafe enabled configuration", async () => {
    expect(await processClientOnboardingNotifications({} as Env)).toEqual({ staged: 0, sent: 0, uncertain: 0 });
    expect(() => clientOnboardingNotificationConfiguration({ CLIENT_ONBOARDING_NOTIFICATIONS_ENABLED: "true" }))
      .toThrow("configuration_invalid");
  });

  it("sends one generic staff-only notice and preserves the submission through cron replay", async () => {
    const { submission, env } = await event();
    const send = vi.fn(async (_env: Env, _mail: OutboundMail) => {});
    expect(await processClientOnboardingNotifications(env, send)).toEqual({ staged: 1, sent: 1, uncertain: 0 });
    await processClientOnboardingNotifications(env, send);
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0]?.[1];
    expect(mail).toMatchObject({ to: "reviewer@example.test" });
    expect(JSON.stringify(mail)).toContain(`/administration/client-onboarding?submission=${submission}`);
    expect(JSON.stringify(mail)).not.toMatch(/Private client|Private address|client@example|#{1}|a{64}/);
    expect(await db.prepare("SELECT state,attempt_count FROM client_onboarding_review_notification_recipients WHERE submission_id=?")
      .bind(submission).first()).toMatchObject({ state: "sent", attempt_count: 1 });
    expect(await db.prepare("SELECT count(*) total FROM client_onboarding_submissions WHERE submission_id=?").bind(submission).first())
      .toEqual({ total: 1 });
  });

  it("holds an ambiguous delivery and never retries it automatically", async () => {
    const { submission, env } = await event();
    const send = vi.fn(async () => { throw Error("private provider diagnostic"); });
    expect(await processClientOnboardingNotifications(env, send)).toEqual({ staged: 1, sent: 0, uncertain: 1 });
    await processClientOnboardingNotifications(env, send);
    await processClientOnboardingNotifications(env, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT state,attempt_count FROM client_onboarding_review_notification_recipients WHERE submission_id=?")
      .bind(submission).first()).toMatchObject({ state: "reconciliation_required", attempt_count: 1 });
  });

  it("invalidates an already read authority witness when a deny is committed", async () => {
    const { submission, env } = await event();
    const recipient = await readClientOnboardingNotificationRecipient(db, submission, staffId);
    expect(recipient).not.toBeNull();
    await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by)
      VALUES('notice-deny',?,'directory.profile.edit','deny','global',?)`).bind(staffId, staffId).run();
    expect(await db.prepare(`SELECT 1 allowed WHERE ${recipient!.guard.sql}`).bind(...recipient!.guard.bindings).first()).toBeNull();
    const send = vi.fn(async () => {});
    expect(await processClientOnboardingNotifications(env, send)).toEqual({ staged: 0, sent: 0, uncertain: 0 });
    expect(send).not.toHaveBeenCalled();
    await db.prepare("UPDATE native_directory_grants SET active=0 WHERE id='notice-deny'").run();
  });

  it("does not claim work when the email transport is unavailable or leak its details", async () => {
    const { submission, env } = await event();
    const unavailable = { ...env, NOTIFICATION_EMAIL: undefined } as unknown as Env;
    await expect(processClientOnboardingNotifications(unavailable)).rejects.toThrow(/^client_onboarding_notifications_failed$/);
    expect(await db.prepare("SELECT count(*) total FROM client_onboarding_review_notification_recipients WHERE submission_id=?")
      .bind(submission).first()).toEqual({ total: 0 });
  });

  it("does not backfill events before the explicit rollout cutoff", async () => {
    const { env } = await event();
    env.CLIENT_ONBOARDING_NOTIFICATIONS_NOT_BEFORE = "2025-01-01T00:00:00.000Z";
    const send = vi.fn(async () => {});
    expect(await processClientOnboardingNotifications(env, send)).toEqual({ staged: 0, sent: 0, uncertain: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("cannot stage a notice for an inactive staff account", async () => {
    const { env } = await event();
    await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(staffId).run();
    try {
      const send = vi.fn(async () => {});
      expect(await processClientOnboardingNotifications(env, send)).toEqual({ staged: 0, sent: 0, uncertain: 0 });
      expect(send).not.toHaveBeenCalled();
    } finally { await db.prepare("UPDATE staff_users SET status='active' WHERE id=?").bind(staffId).run(); }
  });

  it("does not resend after provider acceptance followed by a failed database acknowledgement", async () => {
    const { submission, env } = await event();
    await db.prepare(`CREATE TRIGGER notification_test_lost_ack BEFORE UPDATE ON client_onboarding_review_notification_recipients
      WHEN NEW.state='sent' AND NEW.submission_id='${submission}'
      BEGIN SELECT RAISE(ABORT,'private simulated acknowledgement loss'); END`).run();
    const send = vi.fn(async () => {});
    try {
      await expect(processClientOnboardingNotifications(env, send)).rejects.toThrow(/^client_onboarding_notifications_failed$/);
      expect(send).toHaveBeenCalledTimes(1);
    } finally { await db.prepare("DROP TRIGGER notification_test_lost_ack").run(); }
    await db.prepare(`UPDATE client_onboarding_review_notification_recipients
      SET lease_until='2000-01-01T00:00:00.000Z',version=version+1 WHERE submission_id=?`).bind(submission).run();
    await processClientOnboardingNotifications(env, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT state,attempt_count FROM client_onboarding_review_notification_recipients WHERE submission_id=?")
      .bind(submission).first()).toMatchObject({ state: "reconciliation_required", attempt_count: 1 });
  });

  it("walks more than one delivery page without dropping staff tuples or repeating mail", async () => {
    const second = "onboarding-notice-second";
    await db.batch([
      db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,'second@example.test','Second','access|second')").bind(second),
      db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,'access|second',1,?)").bind(second, staffId),
      db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,'second@example.test','Second')").bind(second),
      db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by)
        VALUES('notice-second-allow',?,'directory.profile.edit','allow','global',?)`).bind(second, staffId),
    ]);
    const first = await event();
    for (let index = 0; index < 4; index++) await event();
    first.env.CLIENT_ONBOARDING_NOTIFICATION_STAFF_IDS = JSON.stringify([staffId, second]);
    const send = vi.fn(async (_env: Env, _mail: OutboundMail) => {});
    for (let cycle = 0; cycle < 5; cycle++) await processClientOnboardingNotifications(first.env, send);
    expect(send).toHaveBeenCalledTimes(10);
    expect(send.mock.calls.filter(([, message]) => message.to === "reviewer@example.test")).toHaveLength(5);
    expect(send.mock.calls.filter(([, message]) => message.to === "second@example.test")).toHaveLength(5);
    expect(new Set(send.mock.calls.map(([, message]) => message.messageIdKey)).size).toBe(10);
  });

  it("caps definitive pre-acceptance failures at three transport attempts", async () => {
    const { submission, env } = await event();
    // Exercise the dispatcher policy at the existing typed transport-classifier
    // boundary. This fixture does not claim real SMTP acceptance or rejection.
    const classify = vi.spyOn(mailer, "notificationMailFailureCode").mockReturnValue("mail-smtp-rejected");
    const send = vi.fn(async () => { throw Error("definitive transport fixture"); });
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        for (let cycle = 0; cycle < 3 && send.mock.calls.length < attempt; cycle++)
          await processClientOnboardingNotifications(env, send);
        expect(send).toHaveBeenCalledTimes(attempt);
        await db.prepare(`UPDATE client_onboarding_review_notification_recipients
          SET next_attempt_at='2000-01-01T00:00:00.000Z',version=version+1
          WHERE submission_id=? AND state='pending'`).bind(submission).run();
      }
      for (let cycle = 0; cycle < 3; cycle++) await processClientOnboardingNotifications(env, send);
      expect(send).toHaveBeenCalledTimes(3);
      expect(await db.prepare("SELECT state,attempt_count FROM client_onboarding_review_notification_recipients WHERE submission_id=?")
        .bind(submission).first()).toMatchObject({ state: "reconciliation_required", attempt_count: 3 });
    } finally { classify.mockRestore(); }
  });
});
