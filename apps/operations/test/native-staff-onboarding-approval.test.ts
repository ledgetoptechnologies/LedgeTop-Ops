import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

const calls = vi.hoisted(() => ({ verify: vi.fn(), jwks: vi.fn() }));
vi.mock("jose", () => ({ jwtVerify: calls.verify }));
vi.mock("../src/worker/access-jwks", () => ({ accessJwksResolver: calls.jwks }));

import { createNativeStaffOnboarding, revealNativeStaffOnboarding, snapshotNativeStaffHandoffKeyring } from "../src/worker/native-staff-onboarding-create";
import { authenticateNativeStaffOnboardingClaimant, claimNativeStaffOnboarding } from "../src/worker/native-staff-onboarding-claim";
import { approveNativeStaffOnboarding, readNativeStaffOnboardingReview } from "../src/worker/native-staff-onboarding-approval";
import { cancelNativeStaffOnboarding } from "../src/worker/native-staff-onboarding-cancel";

let runtime: Miniflare, db: D1Database;
let sequence = 0;
const uuid = () => `50000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
const issuer = "https://synthetic-team.cloudflareaccess.com", audience = "claim-audience-123456",
  keyring = snapshotNativeStaffHandoffKeyring({ activeKeyId: "test-key", keys: { "test-key": "a".repeat(64) } });
const expires = () => new Date(Date.now() + 600_000).toISOString();

async function staff(id: string, capabilities: readonly string[], denies: readonly string[] = []) {
  const email = `${id}@example.test`, subject = `access|${id}`;
  await db.batch([
    db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject) VALUES(?,?,?,?)").bind(id, email, id, subject),
    db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(id, subject, id),
    db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(id, email, id),
    ...capabilities.map(capability => db.prepare(`INSERT INTO native_staff_management_delegations
      (id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES(?,?,?,'allow','global',?)`)
      .bind(`${id}:${capability}`, id, capability, id)),
    ...denies.map(capability => db.prepare(`INSERT INTO native_staff_management_delegations
      (id,actor_staff_id,capability,effect,scope_kind,granted_by) VALUES(?,?,?,'deny','global',?)`)
      .bind(`${id}:deny:${capability}`, id, capability, id)),
  ]);
  return { id, email, subject };
}
function actor(person: { id: string; email: string; subject: string }) {
  return { staffId: person.id, verifiedAccessSubject: person.subject, admissionVersion: 1,
    profileVersion: 1, email: person.email, verifiedUntil: expires() };
}
async function pendingInvite() {
  const creator = await staff(`creator-${++sequence}`, ["staff.onboarding.create"]);
  const input = { commandId: uuid(), loginEmail: `invite-${++sequence}@example.test`, displayName: "New Operations Staff",
    expiresAt: expires(), reason: "Synthetic approval contract test" };
  const created = await createNativeStaffOnboarding(db, input, { identity: { kind: "native", staffId: creator.id,
    verifiedAccessSubject: creator.subject, email: creator.email, displayName: creator.id, profileVersion: 1 },
    admissionVersion: 1, verifiedUntil: expires() }, keyring);
  return { created, input, creator };
}
async function claimedInvite() {
  const pending = await pendingInvite();
  const { created, input, creator } = pending;
  const revelation = await revealNativeStaffOnboarding(db, input.commandId, { identity: { kind: "native", staffId: creator.id,
    verifiedAccessSubject: creator.subject, email: creator.email, displayName: creator.id, profileVersion: 1 },
    admissionVersion: 1, verifiedUntil: expires() }, keyring);
  const now = Math.floor(Date.now() / 1000);
  calls.verify.mockResolvedValue({ payload: { aud: audience, type: "app", sub: `access|invitee-${sequence}`,
    email: input.loginEmail, iat: now - 1, exp: now + 300 } });
  const claimant = await authenticateNativeStaffOnboardingClaimant(new Request("https://claim.invalid/", {
    headers: { "Cf-Access-Jwt-Assertion": "synthetic.claimant.assertion" },
  }), { enabled: true, environment: "staging", issuer, staffAudience: "staff-audience-123456", claimantAudience: audience });
  await claimNativeStaffOnboarding(db, { onboardingId: created.onboardingId, invitationSecret: revelation.invitationSecret }, claimant);
  return { created, input, claimant, revelation, creator };
}

describe("native Operations staff invitation approval contract", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", cf: false,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name) && name.slice(0, 4) <= "0076").sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    const approvalMigration = readFileSync(new URL("../migrations/0242_native_staff_onboarding_approval_actor_authority.sql", import.meta.url), "utf8");
    await db.batch(splitD1MigrationStatements(approvalMigration).map(sql => db.prepare(sql)));
  }, 90_000);
  afterAll(async () => runtime?.dispose());
  beforeEach(() => { vi.clearAllMocks(); calls.jwks.mockReturnValue("synthetic-jwks"); });

  it("rejects creation when the generated proposed staff ID collides with an admitted reviewer", async () => {
    const collidingId = `staff-${uuid()}`;
    const creator = await staff(collidingId, ["staff.onboarding.create"]);
    const createCommandId = uuid();
    const input = { commandId: createCommandId, loginEmail: `collision-${++sequence}@example.test`,
      displayName: "Collision Test", expiresAt: expires(), reason: "Synthetic target collision check" };
    const nativeCrypto = globalThis.crypto;
    const randomUUID = vi.spyOn(nativeCrypto, "randomUUID");
    randomUUID.mockReturnValueOnce(uuid() as ReturnType<typeof nativeCrypto.randomUUID>)
      .mockReturnValueOnce(collidingId.slice("staff-".length) as ReturnType<typeof nativeCrypto.randomUUID>);
    try {
      await expect(createNativeStaffOnboarding(db, input, { identity: { kind: "native", staffId: creator.id,
        verifiedAccessSubject: creator.subject, email: creator.email, displayName: creator.id, profileVersion: 1 },
        admissionVersion: 1, verifiedUntil: expires() }, keyring)).rejects.toThrow("native_staff_onboarding_create_denied");
    } finally { randomUUID.mockRestore(); }
    expect(await db.prepare("SELECT count(*) n FROM native_staff_pending_onboarding WHERE proposed_staff_id=?")
      .bind(collidingId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_management_commands WHERE command_id=?")
      .bind(createCommandId).first("n")).toBe(0);
  });

  it("reviews and approves a claimed identity atomically with no ACL or PA link, then replays exactly", async () => {
    const invite = await claimedInvite(), approver = await staff(`approver-${++sequence}`, ["staff.onboarding.approve"]);
    const before = await db.prepare(`SELECT capability,effect,active,version FROM native_staff_management_delegations
      WHERE actor_staff_id=? ORDER BY capability,effect`).bind(approver.id).all();
    const review = await readNativeStaffOnboardingReview(db, invite.created.onboardingId, actor(approver));
    expect(review).toMatchObject({ onboardingId: invite.created.onboardingId, state: "claimed", version: 2,
      loginEmail: invite.input.loginEmail, claimedAccessSubject: invite.claimant.subject,
      proposal: { memberships: [], directoryGrants: [], managementGrants: [] } });
    expect(JSON.stringify(review)).not.toContain(invite.revelation.invitationSecret);
    expect(Object.hasOwn(review as object, "invitationSecret")).toBe(false);

    const approval = { commandId: uuid(), onboardingId: invite.created.onboardingId, expectedVersion: 2,
      proposalSha256: review.proposalSha256, claimEvidenceSha256: review.claimEvidenceSha256,
      reason: "Synthetic approval by a different admitted administrator" };
    const result = await approveNativeStaffOnboarding(db, approval, actor(approver));
    expect(result).toMatchObject({ commandId: approval.commandId, resultVersion: 3, state: "approved", replayed: false });
    expect(await approveNativeStaffOnboarding(db, approval, actor(approver))).toEqual({ ...result, replayed: true });

    expect(await db.prepare(`SELECT state,version,terminal_by_staff_id,approval_command_id FROM native_staff_pending_onboarding
      WHERE onboarding_id=?`).bind(invite.created.onboardingId).first()).toEqual({ state: "approved", version: 3,
      terminal_by_staff_id: approver.id, approval_command_id: approval.commandId });
    expect(await db.prepare(`SELECT email,access_subject,project_alpha_user_id,status,provisioning_source,sync_protected
      FROM staff_users WHERE id=?`).bind(invite.created.proposedStaffId).first()).toEqual({
      email: invite.input.loginEmail, access_subject: invite.claimant.subject, project_alpha_user_id: null,
      status: "active", provisioning_source: "local", sync_protected: 1,
    });
    expect(await db.prepare("SELECT active,version,bound_access_subject,admitted_by FROM native_staff_admissions WHERE staff_id=?")
      .bind(invite.created.proposedStaffId).first()).toMatchObject({ active: 1, version: 1,
        bound_access_subject: invite.claimant.subject, admitted_by: approver.id });
    expect(await db.prepare("SELECT count(*) n FROM native_staff_profiles WHERE staff_id=?")
      .bind(invite.created.proposedStaffId).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_target_memberships WHERE staff_id=?")
      .bind(invite.created.proposedStaffId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_directory_grants WHERE staff_id=?")
      .bind(invite.created.proposedStaffId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_management_delegations WHERE actor_staff_id=?")
      .bind(invite.created.proposedStaffId).first("n")).toBe(0);
    expect((await db.prepare(`SELECT capability,effect,active,version FROM native_staff_management_delegations
      WHERE actor_staff_id=? ORDER BY capability,effect`).bind(approver.id).all()).results).toEqual(before.results);
  });

  it("allows only one competing approval command to materialize the same claimed identity", async () => {
    const invite = await claimedInvite(), approver = await staff(`race-approver-${++sequence}`, ["staff.onboarding.approve"]);
    const review = await readNativeStaffOnboardingReview(db, invite.created.onboardingId, actor(approver));
    const first = { commandId: uuid(), onboardingId: invite.created.onboardingId, expectedVersion: 2,
      proposalSha256: review.proposalSha256, claimEvidenceSha256: review.claimEvidenceSha256,
      reason: "Synthetic competing approval" };
    const second = { ...first, commandId: uuid() };
    const outcomes = await Promise.allSettled([
      approveNativeStaffOnboarding(db, first, actor(approver)),
      approveNativeStaffOnboarding(db, second, actor(approver)),
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_management_commands WHERE command_id IN (?,?)")
      .bind(first.commandId, second.commandId).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE id=?")
      .bind(invite.created.proposedStaffId).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM native_directory_grants WHERE staff_id=?")
      .bind(invite.created.proposedStaffId).first("n")).toBe(0);
  });

  it("commits only one terminal outcome when approval races cancellation", async () => {
    const invite = await claimedInvite(), reviewer = await staff(`race-reviewer-${++sequence}`,
      ["staff.onboarding.approve", "staff.onboarding.cancel"]);
    const review = await readNativeStaffOnboardingReview(db, invite.created.onboardingId, actor(reviewer));
    const approval = { commandId: uuid(), onboardingId: invite.created.onboardingId, expectedVersion: 2,
      proposalSha256: review.proposalSha256, claimEvidenceSha256: review.claimEvidenceSha256,
      reason: "Synthetic racing approval" };
    const cancellation = { commandId: uuid(), onboardingId: invite.created.onboardingId, expectedVersion: 2,
      reason: "Synthetic racing cancellation" };
    const outcomes = await Promise.allSettled([
      approveNativeStaffOnboarding(db, approval, actor(reviewer)),
      cancelNativeStaffOnboarding(db, cancellation, actor(reviewer)),
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const terminal = await db.prepare("SELECT state,version FROM native_staff_pending_onboarding WHERE onboarding_id=?")
      .bind(invite.created.onboardingId).first<{ state: string; version: number }>();
    expect(terminal?.version).toBe(3);
    expect(["approved", "cancelled"]).toContain(terminal?.state);
    expect(await db.prepare("SELECT count(*) n FROM native_staff_management_commands WHERE command_id IN (?,?)")
      .bind(approval.commandId, cancellation.commandId).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE id=?")
      .bind(invite.created.proposedStaffId).first("n")).toBe(terminal?.state === "approved" ? 1 : 0);
  });

  it("denies review when an approval delegation is absent or explicitly denied", async () => {
    const invite = await claimedInvite();
    const absent = await staff(`no-approve-${++sequence}`, []);
    const denied = await staff(`denied-approve-${++sequence}`, ["staff.onboarding.approve"], ["staff.onboarding.approve"]);
    await expect(readNativeStaffOnboardingReview(db, invite.created.onboardingId, actor(absent)))
      .rejects.toThrow("native_staff_onboarding_approval_denied");
    await expect(readNativeStaffOnboardingReview(db, invite.created.onboardingId, actor(denied)))
      .rejects.toThrow("native_staff_onboarding_approval_denied");
  });

  it("enforces approver authority at the D1 fence even when service checks are bypassed", async () => {
    const invite = await claimedInvite(), unapproved = await staff(`direct-deny-${++sequence}`, []);
    const pending = await db.prepare(`SELECT proposal_sha256,claim_evidence_sha256 FROM native_staff_pending_onboarding
      WHERE onboarding_id=?`).bind(invite.created.onboardingId).first<{ proposal_sha256: string; claim_evidence_sha256: string }>();
    expect(pending).not.toBeNull();
    const resultJson = JSON.stringify({ contractVersion: 1, capability: "staff.onboarding.approve",
      targetOnboardingId: invite.created.onboardingId, proposedStaffId: invite.created.proposedStaffId,
      proposalSha256: pending!.proposal_sha256, claimEvidenceSha256: pending!.claim_evidence_sha256,
      claimedAccessSubject: invite.claimant.subject,
      proposal: { memberships: [], directoryGrants: [], managementGrants: [] }, resultVersion: 3 });
    await expect(db.prepare(`INSERT INTO native_staff_management_fences(target_kind,target_onboarding_id,target_proposed_staff_id,
      command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,
      expected_version,result_version,reason,display_name,result_json,result_sha256,mutation_writes)
      VALUES('onboarding',?,?,?,? ,1,'staff.onboarding.approve',?,?,NULL,2,3,'direct attempt',NULL,?,?,1)`)
      .bind(invite.created.onboardingId, invite.created.proposedStaffId, uuid(), "f".repeat(64), unapproved.id,
        unapproved.subject, resultJson, "e".repeat(64)).run())
      .rejects.toThrow(/onboarding approval requires current global allow authority/u);
    expect(await db.prepare("SELECT state,version FROM native_staff_pending_onboarding WHERE onboarding_id=?")
      .bind(invite.created.onboardingId).first()).toEqual({ state: "claimed", version: 2 });
  });

  it.each(["pending", "claimed"] as const)("cancels a %s invitation atomically and replays under current authority", async state => {
    const invite = state === "pending" ? await pendingInvite() : await claimedInvite();
    const canceller = await staff(`canceller-${++sequence}`, ["staff.onboarding.cancel"]);
    const expectedVersion = state === "pending" ? 1 : 2;
    const input = { commandId: uuid(), onboardingId: invite.created.onboardingId, expectedVersion,
      reason: "Synthetic cancellation test" };
    const first = await cancelNativeStaffOnboarding(db, input, actor(canceller));
    expect(first).toEqual({ commandId: input.commandId, onboardingId: input.onboardingId,
      resultVersion: expectedVersion + 1, state: "cancelled", replayed: false });
    expect(await cancelNativeStaffOnboarding(db, input, actor(canceller))).toEqual({ ...first, replayed: true });
    expect(await db.prepare(`SELECT state,version,terminal_by_staff_id FROM native_staff_pending_onboarding
      WHERE onboarding_id=?`).bind(input.onboardingId).first()).toEqual({ state: "cancelled",
      version: expectedVersion + 1, terminal_by_staff_id: canceller.id });
    expect(await db.prepare("SELECT count(*) n FROM staff_users WHERE id=?")
      .bind(invite.created.proposedStaffId).first("n")).toBe(0);
    expect(JSON.stringify(first)).not.toContain("invitationSecret");
  });

  it("denies cancellation without explicit allow or when an explicit global deny is present", async () => {
    const invite = await pendingInvite();
    const absent = await staff(`no-cancel-${++sequence}`, []);
    const denied = await staff(`denied-cancel-${++sequence}`, ["staff.onboarding.cancel"], ["staff.onboarding.cancel"]);
    const input = { commandId: uuid(), onboardingId: invite.created.onboardingId, expectedVersion: 1,
      reason: "Synthetic denied cancellation" };
    await expect(cancelNativeStaffOnboarding(db, input, actor(absent)))
      .rejects.toThrow("native_staff_onboarding_cancel_denied");
    await expect(cancelNativeStaffOnboarding(db, input, actor(denied)))
      .rejects.toThrow("native_staff_onboarding_cancel_denied");
    const pending = await db.prepare(`SELECT proposed_staff_id,proposal_sha256,claim_evidence_sha256
      FROM native_staff_pending_onboarding WHERE onboarding_id=?`).bind(input.onboardingId)
      .first<{ proposed_staff_id: string; proposal_sha256: string; claim_evidence_sha256: string | null }>();
    expect(pending).not.toBeNull();
    const directResult = JSON.stringify({ contractVersion: 1, capability: "staff.onboarding.cancel",
      targetOnboardingId: input.onboardingId, targetProposedStaffId: pending!.proposed_staff_id,
      proposalSha256: pending!.proposal_sha256, claimEvidenceSha256: null, resultVersion: 2 });
    await expect(db.prepare(`INSERT INTO native_staff_management_fences(target_kind,target_onboarding_id,target_proposed_staff_id,
      command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,
      expected_version,result_version,reason,display_name,result_json,result_sha256,mutation_writes)
      VALUES('onboarding',?,?,?, ?,1,'staff.onboarding.cancel',?,?,NULL,1,2,'direct attempt',NULL,?,?,1)`)
      .bind(input.onboardingId, pending!.proposed_staff_id, uuid(), "f".repeat(64), denied.id,
        denied.subject, directResult, "e".repeat(64)).run())
      .rejects.toThrow(/onboarding cancellation (?:actor or allow is unavailable|is denied)/u);
    expect(await db.prepare("SELECT state,version FROM native_staff_pending_onboarding WHERE onboarding_id=?")
      .bind(input.onboardingId).first()).toEqual({ state: "pending", version: 1 });
  });
});
