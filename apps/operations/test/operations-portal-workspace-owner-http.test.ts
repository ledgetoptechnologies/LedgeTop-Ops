import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ auth: vi.fn(), reserveWorkspace: vi.fn(), reservePublication: vi.fn(),
  reserveInvocation: vi.fn(), dispatch: vi.fn() }));
vi.mock("../src/worker/native-staff-auth", () => ({ authenticateNativeStaffWithAdmissionVersion: calls.auth }));
vi.mock("../src/worker/operations-portal-workspace-reservations", () => ({
  reserveOperationsPortalWorkspace: calls.reserveWorkspace,
}));
vi.mock("../src/worker/operations-portal-workspace-publication-outbox", () => ({
  reserveOperationsPortalWorkspacePublication: calls.reservePublication,
  dispatchOperationsPortalWorkspacePublication: calls.dispatch,
}));
vi.mock("../src/worker/operations-portal-workspace-publication-invocations", () => ({
  reserveOperationsPortalWorkspacePublicationInvocation: calls.reserveInvocation,
}));
import { handleOperationsPortalWorkspaceOwnerHttp as handle,
  type OperationsPortalWorkspaceOwnerHttpDependencies as Dependencies }
  from "../src/worker/operations-portal-workspace-owner-http";

const origin = "https://ops-staging.example.test", base = `${origin}/api/native-client-portal/operations-workspaces`;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { identity: { kind: "native" as const, staffId: "owner", verifiedAccessSubject: "access|owner",
  email: "owner@example.invalid", displayName: "Owner", profileVersion: 2 }, admissionVersion: 3,
  verifiedUntil: "2099-01-01T00:00:00.000Z" };
function deps(): Dependencies { return { environment: "staging", expectedHost: "ops-staging.example.test",
  configuration: { enabled: true, origin, issuer: "https://team.cloudflareaccess.com", staffAudience: "a".repeat(16),
    csrfSecret: "operations-workspace-owner-csrf-secret-long-enough" }, database: {} as D1Database,
  publication: { publishWorkspace: vi.fn(), getPublicationStatus: vi.fn() } }; }
function input() { return { workspace: { operationId: id(1), targetId: id(2), clientAuthorityId: id(3),
  workspaceId: "client-workspace-1", rootKind: "organization", rootRecordId: "organization-record-1",
  rootRecordVersion: 4, relationshipVersion: null, expectedRevision: 0, reason: "Create exact staging workspace" },
  publication: { operationId: id(4), publicationId: id(5), snapshotId: id(6), checkpointId: id(7),
    invocationId: id(8), expectedRevision: 0, reason: "Publish exact staging workspace" } }; }
async function csrf(d: Dependencies) { const response = await handle(new Request(`${base}/csrf`), d);
  return (await response.json() as { csrfToken: string }).csrfToken; }
function post(path: string, body: unknown, token: string, key: string) { return new Request(`${base}/${path}`, { method: "POST",
  headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json",
    "X-CSRF-Token": token, "Idempotency-Key": key }, body: JSON.stringify(body) }); }

describe("operations portal workspace owner HTTP", () => {
  beforeEach(() => { vi.clearAllMocks(); calls.auth.mockResolvedValue(actor);
    calls.reserveWorkspace.mockResolvedValue({ operationId: id(1), targetId: id(2), revision: 1, replayed: false });
    calls.reservePublication.mockResolvedValue({ operationId: id(4), publicationRevision: 1, replayed: false });
    calls.reserveInvocation.mockResolvedValue({ state: "authorized", replayed: false });
    calls.dispatch.mockResolvedValue({ operationId: id(4), status: "acknowledged" }); });

  it.each([
    ["disabled", (d: Dependencies) => ({ ...d, configuration: { ...d.configuration, enabled: false } })],
    ["production", (d: Dependencies) => ({ ...d, environment: "production" })],
    ["wrong expected host", (d: Dependencies) => ({ ...d, expectedHost: "other-staging.example.test" })],
  ])("is absent before authentication when %s", async (_label, modify) => {
    const response = await handle(new Request(`${base}/csrf`), modify(deps()));
    expect(response.status).toBe(404); expect(calls.auth).not.toHaveBeenCalled();
  });

  it("is absent on the wrong request origin before authentication", async () => {
    const response = await handle(new Request(`https://other-staging.example.test/api/native-client-portal/operations-workspaces/csrf`), deps());
    expect(response.status).toBe(404); expect(calls.auth).not.toHaveBeenCalled();
  });

  it("rejects failed native authentication without invoking a domain operation", async () => {
    calls.auth.mockRejectedValue(new Error("native_staff_access_denied"));
    const response = await handle(new Request(`${base}/csrf`), deps());
    expect(response.status).toBe(403); expect(calls.reserveWorkspace).not.toHaveBeenCalled();
  });

  it("requires the actor-bound CSRF token and exact same-origin browser context", async () => {
    const d = deps(), token = await csrf(d), body = input();
    expect((await handle(post("reserve-and-publish", body, "", id(1)), d)).status).toBe(403);
    expect((await handle(post("reserve-and-publish", body, `${token.slice(0, -1)}0`, id(1)), d)).status).toBe(403);
    const crossOrigin = post("reserve-and-publish", body, token, id(1));
    crossOrigin.headers.set("Origin", "https://evil.example.test");
    expect((await handle(crossOrigin, d)).status).toBe(403);
    const crossSite = post("reserve-and-publish", body, token, id(1)); crossSite.headers.set("Sec-Fetch-Site", "cross-site");
    expect((await handle(crossSite, d)).status).toBe(403);
    expect(calls.reserveWorkspace).not.toHaveBeenCalled();
  });

  it("rejects extras and an idempotency key that does not bind the exact workspace operation", async () => {
    const d = deps(), token = await csrf(d), body = input();
    expect((await handle(post("reserve-and-publish", { ...body, actor: "forged" }, token, id(1)), d)).status).toBe(400);
    expect((await handle(post("reserve-and-publish", body, token, id(99)), d)).status).toBe(400);
    expect(calls.reserveWorkspace).not.toHaveBeenCalled();
  });

  it("rejects invalid root/version combinations and oversized bodies before domain work", async () => {
    const d = deps(), token = await csrf(d), organization = input();
    (organization.workspace as { relationshipVersion: number | null }).relationshipVersion = 3;
    expect((await handle(post("reserve-and-publish", organization, token, id(1)), d)).status).toBe(400);
    for (const relationshipVersion of ["bogus", 0, -1]) {
      const invalidOrganization = input();
      (invalidOrganization.workspace as { relationshipVersion: unknown }).relationshipVersion = relationshipVersion;
      expect((await handle(post("reserve-and-publish", invalidOrganization, token, id(1)), d)).status).toBe(400);
    }
    const standalone = input(); standalone.workspace.rootKind = "standalone_client";
    expect((await handle(post("reserve-and-publish", standalone, token, id(1)), d)).status).toBe(400);
    const stale = input(); stale.workspace.rootRecordVersion = 0;
    expect((await handle(post("reserve-and-publish", stale, token, id(1)), d)).status).toBe(400);
    const oversized = input(); oversized.workspace.reason = "x".repeat(9_000);
    expect((await handle(post("reserve-and-publish", oversized, token, id(1)), d)).status).toBe(413);
    expect(calls.reserveWorkspace).not.toHaveBeenCalled();
  });

  it("short-circuits publication when current domain authority denies reservation", async () => {
    calls.reserveWorkspace.mockRejectedValue(new Error("operations_portal_workspace_reservation_denied"));
    const d = deps(), body = input(), response = await handle(post("reserve-and-publish", body, await csrf(d), id(1)), d);
    expect(response.status).toBe(403); expect(await response.json()).toEqual({ error: "denied" });
    expect(calls.reservePublication).not.toHaveBeenCalled(); expect(calls.reserveInvocation).not.toHaveBeenCalled();
    expect(calls.dispatch).not.toHaveBeenCalled();
  });

  it("derives the actor and preserves exact IDs for an idempotent replay", async () => {
    const d = deps(), token = await csrf(d), body = input();
    expect((await handle(post("reserve-and-publish", body, token, id(1)), d)).status).toBe(200);
    calls.reserveWorkspace.mockResolvedValue({ operationId: id(1), targetId: id(2), revision: 1, replayed: true });
    calls.reservePublication.mockResolvedValue({ operationId: id(4), publicationRevision: 1, replayed: true });
    calls.dispatch.mockResolvedValue({ operationId: id(4), status: "acknowledged", replayed: true });
    const replay = await handle(post("reserve-and-publish", body, token, id(1)), d);
    expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ workspaceReplayed: true,
      publicationReplayed: true, publicationOperationId: id(4) });
    expect(calls.reserveWorkspace).toHaveBeenLastCalledWith(d.database, actor, body.workspace);
    const { invocationId: _invocationId, ...publication } = body.publication;
    expect(calls.reservePublication).toHaveBeenLastCalledWith(d.database, actor, { ...publication, targetId: id(2) });
  });

  it("recovers only an exact uncertain publication through a new actor-bound invocation", async () => {
    const d = deps(), token = await csrf(d), recovery = { operationId: id(4), invocationId: id(9),
      reason: "Recover exact staging publication" };
    calls.dispatch.mockResolvedValue({ operationId: id(4), status: "acknowledged", replayed: true });
    const response = await handle(post("recover-publication", recovery, token, id(9)), d);
    expect(response.status).toBe(200);
    expect(calls.reserveInvocation).toHaveBeenCalledWith(d.database, actor, { ...recovery, action: "recover" });
    expect(calls.dispatch).toHaveBeenCalledWith({ db: d.database, binding: d.publication,
      operationId: id(4), invocationId: id(9), action: "recover" });
  });
});
