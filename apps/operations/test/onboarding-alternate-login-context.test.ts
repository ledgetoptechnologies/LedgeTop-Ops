import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffLoginProof } from "../src/worker/staff-login-bindings";
import type { AuthenticatedNativeStaff } from "../src/worker/native-staff-auth";
const calls = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock("../src/worker/staff-login-bindings", async () => ({
  ...await vi.importActual<typeof import("../src/worker/staff-login-bindings")>("../src/worker/staff-login-bindings"),
  assertCurrentStaffLogin: calls.current,
}));
import { clientOnboardingIssuanceEvidence, issueClientOnboardingInvitation } from "../src/worker/client-onboarding-issuance";
import { issueClientOnboardingWithHandoff, revealClientOnboardingSecret } from "../src/worker/client-onboarding-handoff";

let login: StaffLoginProof, auth: AuthenticatedNativeStaff;
const body = () => ({ commandId: "11111111-1111-4111-8111-111111111111", invitationId: "22222222-2222-4222-8222-222222222222",
  invitationSecret: "a".repeat(64), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), targetClientRecordId: null,
  scopes: [{ businessAreaId: "business-alpha", divisionId: null }] });
const noDatabaseRead = vi.fn(() => { throw Error("unexpected database read"); });
const noDb = { withSession: noDatabaseRead } as unknown as D1Database;
const keyring = { activeKeyId: "synthetic", keys: { synthetic: "1".repeat(64) } };
beforeEach(() => {
  vi.clearAllMocks();
  login = Object.freeze({ kind: "alternate", staffId: "staff-owner", canonicalEmail: "owner@example.test",
    canonicalSubject: "access|owner", issuer: "https://synthetic.cloudflareaccess.com", email: "alternate@example.test",
    subject: "access|alternate", expiresAt: Math.floor(Date.now() / 1000) + 600,
    bindingId: "33333333-3333-4333-8333-333333333333", bindingVersion: 1, generation: 2 });
  auth = Object.freeze({ identity: Object.freeze({ kind: "native", staffId: "staff-owner", email: "owner@example.test",
    verifiedAccessSubject: "access|owner", displayName: "Owner", profileVersion: 3 }),
    verifiedUntil: new Date(login.expiresAt * 1000).toISOString(), verifiedLogin: login });
  calls.current.mockResolvedValue(true);
});

describe("onboarding retains alternate credential evidence outside canonical command coordinates", () => {
  it("keeps canonical command identity stable across the primary and linked login", async () => {
    const request = body(), { verifiedLogin: _proof, ...primary } = auth;
    expect(await clientOnboardingIssuanceEvidence({ authenticatedNativeStaff: auth, request }))
      .toEqual(await clientOnboardingIssuanceEvidence({ authenticatedNativeStaff: primary, request }));
  });
  it.each([{ staffId: "staff-other" }, { canonicalEmail: "other@example.test" }, { canonicalSubject: "access|other" }, { bindingVersion: 0 }])
    ("denies mismatched or malformed proof instead of stripping it: %j", async change => {
      await expect(clientOnboardingIssuanceEvidence({ authenticatedNativeStaff: { ...auth, verifiedLogin: { ...login, ...change } }, request: body() }))
        .rejects.toThrow("client_onboarding_issuance_denied");
    });
  it("checks actual login currency before any invitation write", async () => {
    calls.current.mockResolvedValue(false);
    await expect(issueClientOnboardingInvitation(noDb, { authenticatedNativeStaff: auth, request: body() }))
      .rejects.toThrow("client_onboarding_issuance_denied");
    expect(calls.current).toHaveBeenCalledWith(noDb, login); expect(noDatabaseRead).not.toHaveBeenCalled();
  });
  it("does not bypass the actual login check through handoff issuance or secret revelation", async () => {
    calls.current.mockResolvedValue(false);
    const { invitationId: _id, invitationSecret: _secret, ...request } = body();
    await expect(issueClientOnboardingWithHandoff(noDb, { authenticatedNativeStaff: auth, request }, keyring))
      .rejects.toThrow("client_onboarding_handoff_issue_denied");
    await expect(revealClientOnboardingSecret(noDb, { authenticatedNativeStaff: auth, commandId: request.commandId }, keyring))
      .rejects.toThrow("client_onboarding_handoff_reveal_denied");
    expect(calls.current).toHaveBeenCalledWith(noDb, login); expect(noDatabaseRead).not.toHaveBeenCalled();
  });
  it("rechecks after the invitation transaction before returning its receipt", async () => {
    const request = body();
    const statements: unknown[] = [];
    const session = { prepare() { const statement = { bind() { return statement; } }; statements.push(statement); return statement; },
      async batch() { return statements.map((_s, index) => ({ success: true, results: index === statements.length - 1
        ? [{ invitation_id: request.invitationId, expires_at: request.expiresAt, request_sha256: "unused", state: "pending" }] : [] })); } };
    // This request fails its final receipt fingerprint before the proof recheck;
    // use a matching fingerprint so revocation is the only post-write denial.
    const evidence = await clientOnboardingIssuanceEvidence({ authenticatedNativeStaff: auth, request });
    session.batch = async () => statements.map((_s, index) => ({ success: true, results: index === statements.length - 1
      ? [{ invitation_id: request.invitationId, expires_at: request.expiresAt, request_sha256: evidence.requestSha256, state: "pending" }] : [] }));
    const database = { withSession: () => session } as unknown as D1Database;
    calls.current.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(issueClientOnboardingInvitation(database, { authenticatedNativeStaff: auth, request }))
      .rejects.toThrow("client_onboarding_issuance_denied");
    expect(calls.current).toHaveBeenCalledTimes(2);
  });
});
