import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleOperationsPortalNativeBillingAuthorityOwnerHttp as handle,
  type OperationsPortalNativeBillingAuthorityOwnerHttpDependencies as Dependencies }
  from "../src/worker/operations-portal-native-billing-authority-owner-http";

const origin = "https://ops-staging.example.test";
const base = `${origin}/api/native-client-portal/operations-billing-authority`;
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const actor = { identity: { kind: "native" as const, staffId: "billing-manager",
  verifiedAccessSubject: "access|billing-manager", email: "billing-manager@example.invalid",
  displayName: "Billing Manager", profileVersion: 2 }, admissionVersion: 3,
  verifiedUntil: "2099-01-01T00:00:00.000Z" };
const targetId = id(1), recipientBindingId = id(2), grantId = id(3), operationId = id(4);
const entity = { kind: "project" as const, nativeId: "ops/project:alpha" };
const fingerprint = "a".repeat(64);
const selection = { targetId, recipientBindingId, entity, expiresAt: null };
const review = { ...selection, expectedRevision: 0, reviewFingerprint: fingerprint, grantId: null };
const authority = { ...selection, grantId, revision: 1, state: "active", live: true };
const authenticate = vi.fn();
const core = { review: vi.fn(), grant: vi.fn(), revoke: vi.fn(), readStatus: vi.fn() };
function deps(): Dependencies { return { environment: "staging", expectedHost: "ops-staging.example.test",
  lifecycleFlag: "true", configuration: { enabled: true, issuer: "https://team.cloudflareaccess.com",
    staffAudience: "a".repeat(16), origin, csrfSecret: "billing-owner-test-csrf-secret-long-enough" },
  database: {} as D1Database, core, authenticate }; }
function request(route: string, value?: unknown, overrides: Record<string, string> = {}) {
  return new Request(`${base}/${route}`, { method: value === undefined ? "GET" : "POST",
    headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "X-Native-Staff-Request": "1",
      "Content-Type": "application/json", ...overrides },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}
async function csrf(d: Dependencies) {
  const result = await handle(request("session"), d);
  expect(result.status).toBe(200);
  return (await result.json() as { csrfToken: string }).csrfToken;
}

describe("Ops native billing owner HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks(); authenticate.mockResolvedValue(actor);
    core.review.mockResolvedValue(review);
    core.grant.mockResolvedValue({ status: "applied", operationId, authority,
      canonicalWire: "SECRET" });
    core.revoke.mockResolvedValue({ status: "replayed", operationId, authority,
      claimToken: "SECRET" });
    core.readStatus.mockResolvedValue({ ...authority, canonicalWire: "SECRET", actorProof: "SECRET" });
  });

  it.each(["flag-off", "wrong-host", "bad-origin-config"])(
    "is closed before authentication for %s", async mode => {
      const d = deps();
      const changed: Dependencies = mode === "flag-off" ? { ...d, lifecycleFlag: "false" }
        : mode === "wrong-host" ? { ...d, expectedHost: "ops.example.test" }
        : { ...d, configuration: { ...d.configuration, origin: "http://ops-staging.example.test" } };
      expect((await handle(request("session"), changed)).status).toBe(mode === "flag-off" ? 404 : 503);
      expect(authenticate).not.toHaveBeenCalled();
    });

  it("accepts an exact configured production deployment", async () => {
    const production = "https://ops.example.test", d = deps();
    const response = await handle(new Request(`${production}/api/native-client-portal/operations-billing-authority/session`,
      { headers: { Origin: production, "Sec-Fetch-Site": "same-origin", "X-Native-Staff-Request": "1" } }),
    { ...d, environment: "production", expectedHost: "ops.example.test",
      configuration: { ...d.configuration, origin: production } });
    expect(response.status).toBe(200); expect(authenticate).toHaveBeenCalledOnce();
  });

  it("requires normal authentication, same-origin request metadata, and actor-bound CSRF", async () => {
    const d = deps();
    authenticate.mockRejectedValueOnce(new Error("forged assertion"));
    expect((await handle(request("session"), d)).status).toBe(403);
    expect((await handle(request("session", undefined, { "Sec-Fetch-Site": "cross-site" }), d)).status).toBe(403);
    expect((await handle(request("session", undefined, { Origin: "https://other.example.test" }), d)).status).toBe(403);
    const token = await csrf(d);
    expect(token).toMatch(/^\d+\.[0-9a-f]{64}$/u);
    const body = { ...selection, confirm: true, operationId, grantId, expectedRevision: 0,
      reviewFingerprint: fingerprint };
    expect((await handle(request("grants", body), d)).status).toBe(403);
    expect((await handle(request("grants", body, { "X-CSRF-Token": token,
      Origin: "https://other.example.test" }), d)).status).toBe(403);
    authenticate.mockResolvedValueOnce({ ...actor, identity: { ...actor.identity,
      staffId: "another-manager", verifiedAccessSubject: "access|another-manager" } });
    expect((await handle(request("grants", body, { "X-CSRF-Token": token }), d)).status).toBe(403);
    authenticate.mockResolvedValueOnce({ ...actor, identity: { ...actor.identity,
      profileVersion: actor.identity.profileVersion + 1 } });
    expect((await handle(request("grants", body, { "X-CSRF-Token": token }), d)).status).toBe(403);
    expect(core.grant).not.toHaveBeenCalled();
  });

  it("accepts exact reviewed identity input and redacts every core extra", async () => {
    const d = deps(), token = await csrf(d);
    const reviewed = await handle(request("review", selection, { "X-CSRF-Token": token }), d);
    expect(reviewed.status).toBe(200);
    expect(await reviewed.json()).toEqual({ review });
    expect(core.review).toHaveBeenCalledWith(d.database, actor, selection);
    const body = { ...selection, confirm: true, operationId, grantId, expectedRevision: 0,
      reviewFingerprint: fingerprint };
    const granted = await handle(request("grants", body, { "X-CSRF-Token": token }), d);
    expect(granted.status).toBe(200);
    expect(await granted.json()).toEqual({ operationId, status: "applied", authority });
    expect(granted.headers.get("Cache-Control")).toBe("no-store");
    expect(core.grant).toHaveBeenCalledWith(d.database, actor, { ...selection, operationId, grantId,
      expectedRevision: 0, reviewFingerprint: fingerprint });
    const status = await handle(request(`grants/${grantId}`), d);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ authority });
    expect(core.readStatus).toHaveBeenCalledWith(d.database, actor, grantId);
    const revoked = await handle(request(`grants/${grantId}/revoke`,
      { confirm: true, operationId, expectedRevision: 1 }, { "X-CSRF-Token": token }), d);
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ operationId, status: "replayed", authority });
    expect(core.revoke).toHaveBeenCalledWith(d.database, actor,
      { operationId, grantId, expectedRevision: 1 });
  });

  it("rejects unknown browser fields, forged actor proof, and missing explicit confirmation", async () => {
    const d = deps(), token = await csrf(d);
    const headers = { "X-CSRF-Token": token };
    for (const value of [
      { ...selection, actorProof: { staffId: "owner" } },
      { ...selection, entity: { ...entity, resourceScope: "*" } },
      { ...selection, canonicalCommandJson: "{}" },
      { ...selection, recipientBindingId: "invalid" },
    ]) expect((await handle(request("review", value, headers), d)).status).toBe(400);
    const body = { ...selection, operationId, grantId, expectedRevision: 0,
      reviewFingerprint: fingerprint };
    for (const value of [{ ...body, confirm: false }, { ...body, confirm: true, claimToken: "forged" },
      { ...body, confirm: true, actorProof: {} }])
      expect((await handle(request("grants", value, headers), d)).status).toBe(400);
    expect((await handle(request(`grants/${grantId}/revoke`,
      { operationId, expectedRevision: 1 }, headers), d)).status).toBe(400);
    expect(core.review).not.toHaveBeenCalled();
    expect(core.grant).not.toHaveBeenCalled();
    expect(core.revoke).not.toHaveBeenCalled();
  });

  it("returns only generic failures and never leaks thrown core values", async () => {
    const d = deps(), token = await csrf(d);
    core.review.mockRejectedValueOnce(new Error("secret canonical proof"));
    const result = await handle(request("review", selection, { "X-CSRF-Token": token }), d);
    expect(result.status).toBe(503);
    expect(await result.text()).toBe('{"error":"unavailable"}');
  });

  it("maps issuer denial to 403 without disclosing ledger details", async () => {
    const d = deps(), token = await csrf(d);
    core.review.mockRejectedValueOnce(new Error("native_billing_authority_denied"));
    const result = await handle(request("review", selection, { "X-CSRF-Token": token }), d);
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ error: "denied" });
  });

  it("maps issuer conflicts to a redacted 409 without exposing its reason", async () => {
    const d = deps(), token = await csrf(d);
    core.grant.mockResolvedValueOnce({ status: "conflict", reason: "authority",
      canonicalWire: "SECRET" });
    const result = await handle(request("grants", { ...selection, confirm: true,
      operationId, grantId, expectedRevision: 0, reviewFingerprint: fingerprint },
    { "X-CSRF-Token": token }), d);
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({ error: "conflict" });
  });
});
