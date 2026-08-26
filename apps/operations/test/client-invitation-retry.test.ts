import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it, vi } from "vitest";

const acl = vi.hoisted(() => ({ isAdministrator: vi.fn(async () => true) }));
vi.mock("../src/worker/acl", () => acl);

import { retryClientPortalInvitation } from "../src/worker/client-identity-eligibility";
import type { Env, StaffPrincipal } from "../src/worker/types";

const active: Miniflare[] = [];
const principal = { id: "staff-admin" } as StaffPrincipal;

async function fixture() {
  const runtime = new Miniflare({
    compatibilityDate: "2026-08-06", modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DELIVERY_DB: "invitation-retry-migration" },
  });
  active.push(runtime);
  const database = await runtime.getD1Database("DELIVERY_DB");
  await database.exec(`
    CREATE TABLE pa_portal_principals(workspace_id TEXT, public_id TEXT, email_hint TEXT, status TEXT,
      PRIMARY KEY(workspace_id,public_id));
    CREATE TABLE portal_v2_invitations(id TEXT,workspace_id TEXT,invited_email TEXT,status TEXT,expires_at TEXT,created_at TEXT,
      PRIMARY KEY(id,workspace_id));
    CREATE TABLE portal_v2_invitation_email_outbox(invitation_id TEXT PRIMARY KEY,status TEXT,payload_json TEXT,attempts INTEGER,
      last_error_code TEXT,next_attempt_at TEXT,lease_expires_at TEXT,updated_at TEXT);
    INSERT INTO pa_portal_principals VALUES('workspace-one','principal-one','CLIENT@EXAMPLE.TEST','active');
    INSERT INTO portal_v2_invitations VALUES('invite-one','workspace-one','client@example.test','pending',datetime('now','+1 day'),datetime('now'));
    INSERT INTO portal_v2_invitation_email_outbox VALUES('invite-one','failed','{"token":"synthetic-test-token"}',3,
      'E_TEMP',datetime('now','+1 hour'),NULL,datetime('now'));
  `.replace(/\s*\n\s*/g, " "));
  // Use the deployed receipt/audit constraints and immutable triggers, not a
  // handwritten approximation that silently accepts the wrong hash encoding.
  const migration = await readFile(new URL("../../client/migrations/0149_portal_operations_management.sql", import.meta.url), "utf8");
  await database.exec(migration.replace(/^\s*--.*$/gm, "").replace(/\s*\n\s*/g, " "));
  const env = {
    DELIVERY_DB: database, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "true",
    CLIENT_PORTAL_OPERATIONS_MANAGEMENT_ENABLED: "true",
  } as Env;
  return { database, env };
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(active.splice(0).map(runtime => runtime.dispose()));
});

describe("invitation retry against the real management migration", () => {
  it("persists a 64-character hex receipt, queues once and replays without another audit", async () => {
    const { database, env } = await fixture();
    const result = await retryClientPortalInvitation(env, principal, "workspace-one", "principal-one", "retry-migration-0001");
    expect(result).toEqual({ outcome: "queued", invitationId: "invite-one", replayed: false });
    expect(await database.prepare("SELECT request_fingerprint FROM portal_v2_operations_management_mutations").first("request_fingerprint"))
      .toMatch(/^[a-f0-9]{64}$/);
    expect(await retryClientPortalInvitation(env, principal, "workspace-one", "principal-one", "retry-migration-0001"))
      .toEqual({ ...result, replayed: true });
    expect(await database.prepare("SELECT status,attempts,last_error_code FROM portal_v2_invitation_email_outbox").first())
      .toEqual({ status: "pending", attempts: 0, last_error_code: null });
    expect(await database.prepare("SELECT count(*) n FROM portal_v2_operations_management_audit").first("n")).toBe(1);
    await expect(database.prepare("UPDATE portal_v2_operations_management_mutations SET outcome='not_repairable'").run())
      .rejects.toThrow(/immutable/);
    await expect(retryClientPortalInvitation(env, principal, "workspace-one", "different-principal", "retry-migration-0001"))
      .rejects.toMatchObject({ status: 409 });
    // No identity/grant tables exist in this fixture: recovery may only touch
    // the exact existing invitation's outbox, receipt and audit.
  }, 30_000);

  it("records an already queued delivery without rescheduling or changing its attempts", async () => {
    const { database, env } = await fixture();
    await database.prepare("UPDATE portal_v2_invitation_email_outbox SET status='pending'").run();
    const before = await database.prepare("SELECT * FROM portal_v2_invitation_email_outbox").first();
    expect(await retryClientPortalInvitation(env, principal, "workspace-one", "principal-one", "retry-migration-0002"))
      .toMatchObject({ outcome: "already_queued", replayed: false });
    expect(await database.prepare("SELECT * FROM portal_v2_invitation_email_outbox").first()).toEqual(before);
  }, 30_000);

  it("uses the same trimmed, case-insensitive email match as the login summary", async () => {
    const { database, env } = await fixture();
    await database.prepare("UPDATE pa_portal_principals SET email_hint='  Client@Example.Test '").run();
    expect(await retryClientPortalInvitation(env, principal, "workspace-one", "principal-one", "retry-migration-normalized"))
      .toMatchObject({ outcome: "queued", invitationId: "invite-one" });
    expect(await database.prepare("SELECT status FROM portal_v2_invitation_email_outbox").first("status")).toBe("pending");
  }, 30_000);

  it.each(["accepted", "expired", "redacted"])("does not resurrect a %s invitation", async reason => {
    const { database, env } = await fixture();
    if (reason === "accepted") await database.prepare("UPDATE portal_v2_invitations SET status='accepted'").run();
    if (reason === "expired") await database.prepare("UPDATE portal_v2_invitations SET expires_at=datetime('now','-1 hour')").run();
    if (reason === "redacted") await database.prepare(`UPDATE portal_v2_invitation_email_outbox SET payload_json='{"redacted":true}'`).run();
    const before = await database.prepare("SELECT * FROM portal_v2_invitation_email_outbox").first();
    expect(await retryClientPortalInvitation(env, principal, "workspace-one", "principal-one", `retry-migration-${reason}`))
      .toMatchObject({ outcome: "not_repairable", replayed: false });
    expect(await database.prepare("SELECT * FROM portal_v2_invitation_email_outbox").first()).toEqual(before);
    expect(await database.prepare("SELECT action FROM portal_v2_operations_management_audit").first("action"))
      .toBe("invitation.retry.rejected");
  }, 30_000);

  it("rolls back the outbox and receipt when the required audit fails", async () => {
    const { database, env } = await fixture();
    await database.exec("CREATE TRIGGER reject_retry_audit BEFORE INSERT ON portal_v2_operations_management_audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
    const before = await database.prepare("SELECT * FROM portal_v2_invitation_email_outbox").first();
    await expect(retryClientPortalInvitation(env, principal, "workspace-one", "principal-one", "retry-migration-0003"))
      .rejects.toThrow(/audit unavailable/);
    expect(await database.prepare("SELECT * FROM portal_v2_invitation_email_outbox").first()).toEqual(before);
    expect(await database.prepare("SELECT count(*) n FROM portal_v2_operations_management_mutations").first("n")).toBe(0);
  }, 30_000);

  it("requires both rollout flags and administrator authority before any recovery write", async () => {
    const { database, env } = await fixture();
    await expect(retryClientPortalInvitation({ ...env, CLIENT_PORTAL_HIERARCHY_V2_ENABLED: "false" }, principal,
      "workspace-one", "principal-one", "retry-migration-0004")).rejects.toMatchObject({ status: 404 });
    await expect(retryClientPortalInvitation({ ...env, CLIENT_PORTAL_OPERATIONS_MANAGEMENT_ENABLED: "false" }, principal,
      "workspace-one", "principal-one", "retry-migration-0005")).rejects.toMatchObject({ status: 404 });
    acl.isAdministrator.mockResolvedValueOnce(false);
    await expect(retryClientPortalInvitation(env, principal, "workspace-one", "principal-one", "retry-migration-0006"))
      .rejects.toMatchObject({ status: 403 });
    expect(await database.prepare("SELECT count(*) n FROM portal_v2_operations_management_mutations").first("n")).toBe(0);
    expect(await database.prepare("SELECT status FROM portal_v2_invitation_email_outbox").first("status")).toBe("failed");
  }, 30_000);
});
