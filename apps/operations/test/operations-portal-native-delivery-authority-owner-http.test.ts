import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ auth: vi.fn(), list: vi.fn(), listAuthorities: vi.fn(), issue: vi.fn(), revoke: vi.fn(),
  read: vi.fn(), dispatch: vi.fn(), reserve: vi.fn() }));
vi.mock("../src/worker/native-staff-auth", () => ({ authenticateNativeStaffWithAdmissionVersion: calls.auth }));
vi.mock("../src/worker/operations-portal-native-delivery-authority-issuer", async importOriginal => {
  const original = await importOriginal<typeof import("../src/worker/operations-portal-native-delivery-authority-issuer")>();
  return { ...original, listOperationsPortalNativeDeliveryCandidates: calls.list,
    listOperationsPortalNativeDeliveryAuthoritiesForOwner: calls.listAuthorities,
    issueOperationsPortalNativeDeliveryAuthority: calls.issue,
    revokeOperationsPortalNativeDeliveryAuthority: calls.revoke,
    readOperationsPortalNativeDeliveryAuthorityStatusForOwner: calls.read };
});
vi.mock("../src/worker/operations-portal-native-delivery-authority-dispatch", () => ({
  dispatchStagedOperationsPortalNativeDeliveryAuthority: calls.dispatch,
}));
vi.mock("../src/worker/operations-portal-native-delivery-recovery-invocations", () => ({
  reserveOperationsPortalNativeDeliveryRecoveryInvocation: calls.reserve,
}));
import { handleOperationsPortalNativeDeliveryAuthorityOwnerHttp as handle,
  type OperationsPortalNativeDeliveryAuthorityOwnerHttpDependencies as Dependencies }
  from "../src/worker/operations-portal-native-delivery-authority-owner-http";
import { OperationsPortalNativeDeliveryCandidateStaleError }
  from "../src/worker/operations-portal-native-delivery-authority-issuer";

const origin = "https://ops-staging.example.test";
const base = `${origin}/api/native-client-portal/operations-delivery-authority`;
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const actor = { identity: { kind: "native" as const, staffId: "manager", verifiedAccessSubject: "access|manager",
  email: "manager@example.invalid", displayName: "Manager", profileVersion: 2 }, admissionVersion: 3,
  verifiedUntil: "2099-01-01T00:00:00.000Z" };
const operationId = id(1), authorityId = id(2), recipientBindingId = id(3), folderReservationId = id(4), targetId = id(5);
const fingerprint = "a".repeat(64);
const review = { authorityId, revision: 1, state: "active", recipientBindingId, folderReservationId, targetId,
  targetClientRecordId: "client:one", workspaceId: "workspace:one", clientFolderBindingId: "folder:one",
  features: ["folder.list", "file.download"], expiresAt: "2099-01-01T00:00:00.000Z", latestOperationId: operationId };
const status = (transportStatus: "pending" | "acknowledged" | "dead" = "acknowledged") => ({ authority: review,
  latestAction: "delivery.grant", transportStatus,
  recoveryOperationId: transportStatus === "pending" ? operationId : null });
function deps(): Dependencies { return { environment: "staging", expectedHost: "ops-staging.example.test",
  configuration: { enabled: true, issuer: "https://team.cloudflareaccess.com", staffAudience: "a".repeat(16), origin,
    csrfSecret: "native-delivery-owner-test-csrf-secret-long-enough" }, database: {} as D1Database,
  dispatch: { OPS_DB: {} as D1Database, ENVIRONMENT: "staging", EXPECTED_HOST: "ops-staging.example.test",
    OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_DISPATCH_ENABLED: "true",
    OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY: { applyNativeDeliveryAuthority: vi.fn(),
      getNativeDeliveryAuthorityStatus: vi.fn() } } }; }
function request(path: string, value?: unknown, token?: string) {
  return new Request(`${base}/${path}`, { method: value === undefined ? "GET" : "POST",
    headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "X-Native-Staff-Request": "1",
      "Content-Type": "application/json", ...(token ? { "X-CSRF-Token": token } : {}) },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}
async function token(d: Dependencies) {
  const result = await handle(request("session"), d); expect(result.status).toBe(200);
  return (await result.json() as { csrfToken: string }).csrfToken;
}
const grant = () => ({ operationId, authorityId, recipientBindingId, folderReservationId, expectedRevision: 0,
  expectedCandidateFingerprint: fingerprint, features: ["folder.list", "file.download"],
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(), reasonCode: "Explicit folder share" });

describe("Ops native delivery owner HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks(); calls.auth.mockResolvedValue(actor); calls.list.mockResolvedValue({ items: [], next: null });
    calls.listAuthorities.mockResolvedValue({ items: [], nextAuthorityId: null });
    calls.issue.mockResolvedValue({ review, replayed: false }); calls.revoke.mockResolvedValue({ review, replayed: false });
    calls.read.mockResolvedValue(status()); calls.dispatch.mockResolvedValue({ operationId, state: "acknowledged" });
    calls.reserve.mockResolvedValue({ invocationId: id(6), operationId, authorityId, expectedRevision: 1,
      state: "authorized", replayed: false });
  });

  it.each(["disabled", "production"])("is absent for %s before authenticating", async mode => {
    const d = deps(), modified = mode === "disabled" ? { ...d, configuration: { ...d.configuration, enabled: false } }
      : { ...d, environment: "production" };
    expect((await handle(request("session"), modified)).status).toBe(404);
    expect(calls.auth).not.toHaveBeenCalled();
  });

  it("requires a complete staging-only private transport", async () => {
    const d = deps();
    expect((await handle(request("session"), { ...d, dispatch: { ...d.dispatch,
      OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_DISPATCH_ENABLED: "false" } })).status).toBe(503);
    expect(calls.auth).not.toHaveBeenCalled();
  });

  it("lists only an exact target and returns an actor-bound opaque cursor", async () => {
    calls.list.mockResolvedValue({ items: [{ candidateFingerprint: fingerprint, targetId }],
      next: { recipientBindingId, folderReservationId } });
    const d = deps(), result = await handle(request(`candidates?targetId=${targetId}`), d);
    expect(result.status).toBe(200);
    const body = await result.json() as { page: { nextCursor: string }; items: unknown[] };
    expect(body.page.nextCursor).toMatch(/^v1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/u);
    expect(calls.list).toHaveBeenCalledWith(d.database, { targetId, after: null, owner: actor });
    expect((await handle(request(`candidates?targetId=${targetId}&cursor=${body.page.nextCursor}`), d)).status).toBe(200);
    expect(calls.list).toHaveBeenLastCalledWith(d.database, { targetId,
      after: { recipientBindingId, folderReservationId }, owner: actor });
    expect((await handle(request(`candidates?targetId=${id(99)}&cursor=${body.page.nextCursor}`), d)).status).toBe(403);
    calls.auth.mockResolvedValue({ ...actor, identity: { ...actor.identity, staffId: "other-manager",
      verifiedAccessSubject: "access|other-manager" } });
    expect((await handle(request(`candidates?targetId=${targetId}&cursor=${body.page.nextCursor}`), d)).status).toBe(403);
    calls.auth.mockResolvedValue(actor);
    const altered = `${body.page.nextCursor.slice(0, -1)}${body.page.nextCursor.endsWith("0") ? "1" : "0"}`;
    expect((await handle(request(`candidates?targetId=${targetId}&cursor=${altered}`), d)).status).toBe(403);
  });

  it("discovers current and historical authorities for only the exact target", async () => {
    calls.listAuthorities.mockResolvedValue({ items: [status("pending")], nextAuthorityId: authorityId });
    const d = deps(), result = await handle(request(`authorities?targetId=${targetId}`), d);
    expect(result.status).toBe(200);
    const value = await result.json() as { items: Array<Record<string, unknown>>; page: { nextCursor: string } };
    expect(value.items[0]).toMatchObject({ authorityId, latestAction: "delivery.grant", transportStatus: "pending",
      recoveryOperationId: operationId });
    expect(value.page.nextCursor).toMatch(/^v1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/u);
    expect(calls.listAuthorities).toHaveBeenCalledWith(d.database, { targetId, afterAuthorityId: null, owner: actor });
    expect((await handle(request(`authorities?targetId=${targetId}&cursor=${value.page.nextCursor}`), d)).status).toBe(200);
    expect(calls.listAuthorities).toHaveBeenLastCalledWith(d.database, { targetId,
      afterAuthorityId: authorityId, owner: actor });
  });

  it("persists only the exact reviewed candidate fingerprint and frozen grant body", async () => {
    const d = deps(), csrf = await token(d), input = grant();
    const result = await handle(request("authorities", input, csrf), d);
    expect(result.status).toBe(200);
    expect(calls.issue).toHaveBeenCalledWith(d.database, { ...input, owner: actor });
    expect(calls.dispatch).toHaveBeenCalledWith(d.dispatch, operationId);
    expect(await result.json()).toMatchObject({ operationId, status: "acknowledged", replayed: false,
      recoveryOperationId: null, authority: { authorityId, transportStatus: "acknowledged" } });
  });

  it("returns an explicit stale-review conflict without granting or auto-refreshing", async () => {
    calls.issue.mockRejectedValue(new OperationsPortalNativeDeliveryCandidateStaleError());
    const d = deps(), result = await handle(request("authorities", grant(), await token(d)), d);
    expect(result.status).toBe(409); expect(await result.json()).toEqual({ error: "candidate_review_stale" });
    expect(calls.dispatch).not.toHaveBeenCalled();
  });

  it("does not expose unexpected database or transport diagnostics", async () => {
    calls.issue.mockRejectedValue(new Error("private SQL credentials"));
    const d = deps(), result = await handle(request("authorities", grant(), await token(d)), d);
    expect(result.status).toBe(503); expect(await result.json()).toEqual({ error: "unavailable" });
    expect(calls.dispatch).not.toHaveBeenCalled();
  });

  it("keeps uncertain transport pending with the exact recovery operation", async () => {
    calls.dispatch.mockResolvedValue({ operationId, state: "retry" }); calls.read.mockResolvedValue(status("pending"));
    const d = deps(), result = await handle(request("authorities", grant(), await token(d)), d);
    expect(result.status).toBe(202); expect(await result.json()).toMatchObject({ operationId, status: "pending",
      recoveryOperationId: operationId, authority: { recoveryOperationId: operationId, transportStatus: "pending" } });
  });

  it("recovers only the exact pending command through one current-manager invocation", async () => {
    calls.read.mockResolvedValue(status("pending"));
    const recovery = { invocationId: id(6), operationId, expectedRevision: 1, reason: "Retry exact pending share" };
    const d = deps(), result = await handle(request(`authorities/${authorityId}/recover`, recovery, await token(d)), d);
    expect(result.status).toBe(202);
    expect(calls.reserve).toHaveBeenCalledWith(d.database, { ...recovery, authorityId, owner: actor });
    expect(calls.dispatch).toHaveBeenCalledWith(d.dispatch, operationId, recovery.invocationId);
    expect(calls.issue).not.toHaveBeenCalled(); expect(calls.revoke).not.toHaveBeenCalled();
  });

  it("does not blindly rerun a consumed recovery invocation", async () => {
    calls.read.mockResolvedValue(status("pending")); calls.reserve.mockResolvedValue({ invocationId: id(6), operationId,
      authorityId, expectedRevision: 1, state: "claimed", replayed: true });
    const d = deps(); await handle(request(`authorities/${authorityId}/recover`, { invocationId: id(6), operationId,
      expectedRevision: 1, reason: "Retry exact pending share" }, await token(d)), d);
    expect(calls.dispatch).not.toHaveBeenCalled();
  });

  it("rejects extras, malformed features, stale revision and CSRF changes", async () => {
    const d = deps(), csrf = await token(d);
    expect((await handle(request("authorities", { ...grant(), issuer: "forged" }, csrf), d)).status).toBe(400);
    expect((await handle(request("authorities", { ...grant(), features: ["file.download", "folder.list"] }, csrf), d)).status).toBe(400);
    expect((await handle(request(`authorities/${authorityId}/recover`, { invocationId: id(6), operationId,
      expectedRevision: 2, reason: "stale" }, csrf), d)).status).toBe(409);
    const changed = request("authorities", grant(), csrf); changed.headers.set("Origin", "https://other.example.test");
    expect((await handle(changed, d)).status).toBe(403);
  });
});
