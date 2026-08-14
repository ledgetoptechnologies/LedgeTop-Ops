import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import hierarchyMigration from "../migrations/0121_client_workspace_hierarchy_v2.sql?raw";
import membershipMigration from "../migrations/0123_portal_v2_membership_management.sql?raw";
import scrubMigration from "../migrations/0127_portal_invitation_secret_scrub.sql?raw";
import accessReceiptMigration from "../migrations/0133_portal_invitation_access_enrollment_receipts.sql?raw";
import {
  invitationRecipientEmailHash,
  recordInvitationAccessEnrollmentReceipt,
  revokeInvitationAccessEnrollmentReceipt,
} from "../src/worker/client-portal/access-enrollment-receipts";
import {
  invitationEmailDeliveryEnabled,
  processInvitationEmailBatch,
} from "../src/worker/client-portal/invitation-email";
import type { Env } from "../src/worker/types";

function executableMigration(sql: string): string {
  return sql.replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " ");
}

describe("workspace invitation email delivery", () => {
  let miniflare: Miniflare;
  let database: D1Database;
  let sent: EmailMessageBuilder[];
  let env: Env;

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-16", modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: `invitation-email-${crypto.randomUUID()}` },
    });
    database = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await database.exec("CREATE TABLE client_accounts(id TEXT PRIMARY KEY);");
    // This focused fixture needs the additive v2 schema, not 0121's legacy
    // backfill SELECTs (those are covered by the full migration suite).
    await database.exec(executableMigration(hierarchyMigration.split("INSERT OR IGNORE INTO portal_v2_identities")[0]!));
    await database.exec(executableMigration(membershipMigration));
    await database.exec(executableMigration(scrubMigration));
    await database.exec(executableMigration(accessReceiptMigration));
    await database.prepare("PRAGMA foreign_keys=ON").run();
    await database.batch([
      database.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email) VALUES ('inviter','https://access.test','inviter','manager@example.test')"),
      database.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_client_public_id,display_name,status) VALUES ('workspace-a','standalone_client','client-a','Acme & Sons','active')"),
    ]);
    sent = [];
    env = {
      DELIVERY_DB: database,
      CLIENT_PORTAL_ENABLED: "true",
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
      CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED: "true",
      CLIENT_PORTAL_ACCESS_ENROLLMENT_READY: "true",
      CLIENT_PORTAL_INVITATION_EMAIL_ENABLED: "true",
      CLIENT_PORTAL_INVITATION_FROM: "portal@ledgetopdroneservices.com",
      CLIENT_PORTAL_INVITATION_FROM_NAME: "LTDS Portal",
      CLIENT_PORTAL_ORIGIN: "https://client.example",
      CLIENT_PORTAL_INVITATION_EMAIL: { send: async message => { sent.push(message as EmailMessageBuilder); return { messageId: `message-${sent.length}` }; } },
      ENVIRONMENT: "development",
    } as Env;
  }, 30_000);

  afterEach(async () => miniflare.dispose());

  async function queueInvitation(options: { id?: string; token?: string; email?: string; payload?: unknown; status?: string; expiresAt?: string; workspaceId?: string; enrolled?: boolean } = {}) {
    const id = options.id ?? "invite-a";
    const token = options.token ?? "A".repeat(43);
    const email = options.email ?? "person@example.test";
    const workspaceId = options.workspaceId ?? "workspace-a";
    const expiresAt = options.expiresAt ?? "2099-01-01T00:00:00.000Z";
    const recipientEmailHash = await invitationRecipientEmailHash(email);
    expect(recipientEmailHash).not.toBeNull();
    await database.batch([
      database.prepare(`INSERT INTO portal_v2_invitations
        (id,workspace_id,token_hash,invited_email,invited_by_identity_id,status,expires_at)
        VALUES (?,?,?,?,?,?,?)`).bind(id, workspaceId, (`H${id}${"x".repeat(43)}`).slice(0, 43), email, "inviter", options.status ?? "pending", expiresAt),
      database.prepare(`INSERT INTO portal_v2_invitation_email_outbox(id,invitation_id,recipient_email,payload_json,next_attempt_at,recipient_email_hash)
        VALUES (?,?,?,?,'2000-01-01T00:00:00.000Z',?)`).bind(`outbox-${id}`, id, email, JSON.stringify(options.payload ?? { invitationId: id, token, expiresAt }), recipientEmailHash),
    ]);
    if (options.enrolled !== false && (options.status ?? "pending") === "pending" && Date.parse(expiresAt) > Date.now()) {
      expect(await recordInvitationAccessEnrollmentReceipt(env, {
        invitationId: id, workspaceId, email, enrollmentVersion: 1,
        providerReceiptHash: "R".repeat(43), enrolledAt: "2026-08-13T00:00:00.000Z",
      })).toBe(true);
    }
  }

  it("fails closed unless every rollout flag, sender, origin, and binding is configured", () => {
    expect(invitationEmailDeliveryEnabled(env)).toBe(true);
    expect(invitationEmailDeliveryEnabled({ ...env, CLIENT_PORTAL_ACCESS_ENROLLMENT_READY: "false" })).toBe(false);
    expect(invitationEmailDeliveryEnabled({ ...env, CLIENT_PORTAL_INVITATION_EMAIL_ENABLED: "false" })).toBe(false);
    expect(invitationEmailDeliveryEnabled({ ...env, CLIENT_PORTAL_INVITATION_EMAIL: undefined })).toBe(false);
    expect(invitationEmailDeliveryEnabled({ ...env, CLIENT_PORTAL_INVITATION_FROM: "invalid" })).toBe(false);
    expect(invitationEmailDeliveryEnabled({ ...env, CLIENT_PORTAL_ORIGIN: "http://client.example" })).toBe(false);
  });

  it("does not lease or send queued invitations until Access enrollment is attested", async () => {
    await queueInvitation({ id: "not-enrolled" });
    const result = await processInvitationEmailBatch(
      { ...env, CLIENT_PORTAL_ACCESS_ENROLLMENT_READY: "false" },
      { now: new Date("2026-08-13T12:00:00.000Z") },
    );
    expect(result).toEqual({ claimed: 0, sent: 0, retried: 0, failed: 0, cancelled: 0 });
    expect(sent).toHaveLength(0);
    expect(await database.prepare("SELECT status,attempts FROM portal_v2_invitation_email_outbox WHERE invitation_id='not-enrolled'").first())
      .toMatchObject({ status: "pending", attempts: 0 });
  });

  it("requires a matching, live per-invitation Access enrollment receipt", async () => {
    await queueInvitation({ id: "receipt-required", enrolled: false });
    const now = new Date("2026-08-13T12:00:00.000Z");
    expect((await processInvitationEmailBatch(env, { now })).claimed).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await recordInvitationAccessEnrollmentReceipt(env, {
      invitationId: "receipt-required", workspaceId: "workspace-a", email: "wrong@example.test",
      enrollmentVersion: 1, providerReceiptHash: "W".repeat(43), enrolledAt: now.toISOString(),
    })).toBe(false);
    expect(await recordInvitationAccessEnrollmentReceipt(env, {
      invitationId: "receipt-required", workspaceId: "workspace-a", email: "person@example.test",
      enrollmentVersion: 1, providerReceiptHash: "C".repeat(43), enrolledAt: now.toISOString(),
    })).toBe(true);
    expect((await processInvitationEmailBatch(env, { now })).sent).toBe(1);
  });

  it("keeps same-email workspace receipts independent and rejects stale revocation", async () => {
    await database.prepare("INSERT INTO portal_v2_workspaces(id,root_type,pa_client_public_id,display_name,status) VALUES ('workspace-b','standalone_client','client-b','Beta','active')").run();
    await queueInvitation({ id: "workspace-a-invite", email: "shared@example.test" });
    await queueInvitation({ id: "workspace-b-invite", email: "shared@example.test", workspaceId: "workspace-b" });
    expect(await recordInvitationAccessEnrollmentReceipt(env, {
      invitationId: "workspace-b-invite", workspaceId: "workspace-b", email: "shared@example.test",
      enrollmentVersion: 2, providerReceiptHash: "N".repeat(43), enrolledAt: "2026-08-13T00:00:00.000Z",
    })).toBe(true);
    expect(await revokeInvitationAccessEnrollmentReceipt(env, "workspace-b-invite", "workspace-b", 1)).toBe(false);
    expect(await revokeInvitationAccessEnrollmentReceipt(env, "workspace-a-invite", "workspace-a", 1)).toBe(true);
    const result = await processInvitationEmailBatch(env, { now: new Date("2026-08-13T12:00:00.000Z"), limit: 25 });
    expect(result.sent).toBe(1);
    expect(sent.map(message => message.to)).toEqual(["shared@example.test"]);
    expect(await database.prepare("SELECT revoked_at FROM portal_v2_invitation_access_enrollment_receipts WHERE invitation_id='workspace-b-invite'").first("revoked_at")).toBeNull();
  });

  it("leases once, sends a fragment-only token link, and scrubs the plaintext token", async () => {
    await queueInvitation();
    const now = new Date("2026-08-13T12:00:00.000Z");
    const [first, second] = await Promise.all([
      processInvitationEmailBatch(env, { now }),
      processInvitationEmailBatch(env, { now }),
    ]);
    expect(first.sent + second.sent).toBe(1);
    expect(sent).toHaveLength(1);
    const message = sent[0]!;
    expect(message.to).toBe("person@example.test");
    expect(message.subject).toContain("Acme & Sons");
    expect(message.text).toContain("https://client.example/portal/invitations/accept#token=");
    expect(message.html).toContain("Acme &amp; Sons");
    const row = await database.prepare("SELECT status,payload_json,sent_at,lease_expires_at FROM portal_v2_invitation_email_outbox WHERE id='outbox-invite-a'")
      .first<{ status: string; payload_json: string; sent_at: string | null; lease_expires_at: string | null }>();
    expect(row).toMatchObject({ status: "sent", payload_json: '{"redacted":true}', lease_expires_at: null });
    expect(row?.sent_at).not.toBeNull();
  });

  it("retries transient failures with backoff and permanently fails invalid sender responses", async () => {
    await queueInvitation({ id: "retry" });
    let calls = 0;
    env.CLIENT_PORTAL_INVITATION_EMAIL = { send: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("temporary"), { code: "E_INTERNAL_SERVER_ERROR" });
      return { messageId: "eventual" };
    } };
    const first = await processInvitationEmailBatch(env, { now: new Date("2026-08-13T12:00:00.000Z") });
    expect(first).toMatchObject({ claimed: 1, retried: 1, sent: 0 });
    expect(await database.prepare("SELECT status FROM portal_v2_invitation_email_outbox WHERE id='outbox-retry'").first("status")).toBe("failed");
    const second = await processInvitationEmailBatch(env, { now: new Date("2026-08-13T12:02:00.000Z") });
    expect(second.sent).toBe(1);

    await queueInvitation({ id: "permanent" });
    env.CLIENT_PORTAL_INVITATION_EMAIL = { send: async () => { throw Object.assign(new Error("sender"), { code: "E_SENDER_NOT_VERIFIED" }); } };
    expect((await processInvitationEmailBatch(env, { now: new Date("2026-08-13T13:00:00.000Z") })).failed).toBe(1);
    expect(await database.prepare("SELECT attempts,payload_json FROM portal_v2_invitation_email_outbox WHERE id='outbox-permanent'")
      .first()).toMatchObject({ attempts: 20, payload_json: '{"redacted":true}' });
  });

  it("cancels and scrubs revoked, accepted, expired, mismatched, and malformed invitations without sending", async () => {
    await queueInvitation({ id: "revoked", status: "revoked" });
    await queueInvitation({ id: "accepted", status: "accepted" });
    await queueInvitation({ id: "expired", expiresAt: "2000-01-01T00:00:00.000Z" });
    await queueInvitation({ id: "mismatch", payload: { invitationId: "another", token: "B".repeat(43), expiresAt: "2099-01-01T00:00:00.000Z" } });
    await queueInvitation({ id: "malformed", payload: { invitationId: "malformed", token: "secret", expiresAt: "nope", extra: true } });
    const result = await processInvitationEmailBatch(env, { now: new Date("2026-08-13T12:00:00.000Z"), limit: 25 });
    expect(result).toMatchObject({ failed: 2, sent: 0 });
    expect(sent).toHaveLength(0);
    const rows = await database.prepare("SELECT invitation_id,status,payload_json FROM portal_v2_invitation_email_outbox ORDER BY invitation_id").all<{ invitation_id: string; status: string; payload_json: string }>();
    expect(rows.results.every(row => ["cancelled", "failed"].includes(row.status) && row.payload_json === '{"redacted":true}')).toBe(true);
  });

  it("cannot revive a row revoked while the external send is in flight", async () => {
    await queueInvitation({ id: "race" });
    env.CLIENT_PORTAL_INVITATION_EMAIL = { send: async () => {
      await database.batch([
        database.prepare("UPDATE portal_v2_invitations SET status='revoked',revoked_at=datetime('now') WHERE id='race'"),
        database.prepare("UPDATE portal_v2_invitation_email_outbox SET status='cancelled',payload_json='{\"redacted\":true}',lease_expires_at=NULL WHERE invitation_id='race' AND status='processing'"),
      ]);
      return { messageId: "already-handed-off" };
    } };
    const result = await processInvitationEmailBatch(env, { now: new Date("2026-08-13T12:00:00.000Z") });
    expect(result.sent).toBe(0);
    expect(await database.prepare("SELECT status,payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id='race'").first())
      .toMatchObject({ status: "cancelled", payload_json: '{"redacted":true}' });
  });

  it("cannot mark mail sent when its exact enrollment receipt is revoked during handoff", async () => {
    await queueInvitation({ id: "receipt-race" });
    env.CLIENT_PORTAL_INVITATION_EMAIL = { send: async () => {
      expect(await revokeInvitationAccessEnrollmentReceipt(env, "receipt-race", "workspace-a", 1)).toBe(true);
      return { messageId: "provider-handoff" };
    } };
    const result = await processInvitationEmailBatch(env, { now: new Date("2026-08-13T12:00:00.000Z") });
    expect(result).toMatchObject({ claimed: 1, sent: 0, cancelled: 1 });
    expect(await database.prepare("SELECT status,payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id='receipt-race'").first())
      .toMatchObject({ status: "cancelled", payload_json: '{"redacted":true}' });
  });

  it("reclaims an expired processing lease but never steals a live lease", async () => {
    await queueInvitation({ id: "lease" });
    await database.prepare(`UPDATE portal_v2_invitation_email_outbox SET
      status='processing',attempts=1,lease_expires_at='2026-08-13T11:59:00.000Z'
      WHERE invitation_id='lease'`).run();
    expect((await processInvitationEmailBatch(env, { now: new Date("2026-08-13T12:00:00.000Z") })).sent).toBe(1);
    expect(sent).toHaveLength(1);

    await queueInvitation({ id: "live-lease" });
    await database.prepare(`UPDATE portal_v2_invitation_email_outbox SET
      status='processing',attempts=1,lease_expires_at='2026-08-13T12:05:00.000Z'
      WHERE invitation_id='live-lease'`).run();
    expect((await processInvitationEmailBatch(env, { now: new Date("2026-08-13T12:00:00.000Z") })).claimed).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("scrubs acceptance in the same D1 update even before the scheduler runs", async () => {
    await queueInvitation({ id: "accepted-now" });
    await database.prepare("UPDATE portal_v2_invitations SET status='accepted',accepted_at=datetime('now') WHERE id='accepted-now'").run();
    expect(await database.prepare("SELECT status,payload_json,lease_expires_at FROM portal_v2_invitation_email_outbox WHERE invitation_id='accepted-now'").first())
      .toMatchObject({ status: "cancelled", payload_json: '{"redacted":true}', lease_expires_at: null });
    expect(await database.prepare("SELECT revoked_at FROM portal_v2_invitation_access_enrollment_receipts WHERE invitation_id='accepted-now'").first("revoked_at"))
      .not.toBeNull();
  });

  it("migration 0127 idempotently scrubs terminal rows that predate the trigger", async () => {
    await database.prepare("DROP TRIGGER portal_v2_invitation_scrub_terminal").run();
    await queueInvitation({ id: "legacy-terminal", status: "revoked" });
    expect(String(await database.prepare("SELECT payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id='legacy-terminal'").first("payload_json"))).toContain("token");
    await database.exec(executableMigration(scrubMigration));
    await database.exec(executableMigration(scrubMigration));
    expect(await database.prepare("SELECT status,payload_json FROM portal_v2_invitation_email_outbox WHERE invitation_id='legacy-terminal'").first())
      .toMatchObject({ status: "cancelled", payload_json: '{"redacted":true}' });
  });
});
