import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ auth: vi.fn(), reserveWorkspace: vi.fn(), reserveFolder: vi.fn(), revokeFolder: vi.fn(),
  reservePublication: vi.fn(), reserveInvocation: vi.fn(), dispatch: vi.fn(), lookupProjectFolder: vi.fn(), confirmProjectFolder: vi.fn() }));
vi.mock("../src/worker/native-staff-auth", () => ({ authenticateNativeStaffWithAdmissionVersion: calls.auth }));
vi.mock("../src/worker/operations-portal-workspace-reservations", () => ({
  reserveOperationsPortalWorkspace: calls.reserveWorkspace, reserveOperationsPortalFolder: calls.reserveFolder,
  revokeOperationsPortalFolder: calls.revokeFolder,
}));
vi.mock("../src/worker/operations-portal-workspace-publication-outbox", () => ({
  reserveOperationsPortalWorkspacePublication: calls.reservePublication,
  dispatchOperationsPortalWorkspacePublication: calls.dispatch,
}));
vi.mock("../src/worker/operations-portal-workspace-publication-invocations", () => ({
  reserveOperationsPortalWorkspacePublicationInvocation: calls.reserveInvocation,
}));
vi.mock("../src/worker/operations-portal-shared-project-folders", () => ({
  lookupOperationsPortalSharedProjectFolder: calls.lookupProjectFolder,
  confirmOperationsPortalSharedProjectFolder: calls.confirmProjectFolder,
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
function folderInput(action: "reserve" | "revoke" = "reserve") { return { folder: action === "reserve"
  ? { operationId: id(10), targetId: id(2), reservationId: id(11), expectedRevision: 0,
    expectedWorkspaceRevision: 1, externalProjectId: "project-1", projectVersion: 7,
    opsFolderProjectId: "folder-project-1", opsDivisionId: "division-1", baseR2Prefix: "clients/root/",
    baseMatchMethod: "confirmed_exact", baseConfirmedBy: "source-receipt-1",
    baseConfirmedAt: "2026-10-02T12:00:00.000Z", clientFolderBindingId: "binding-1",
    selectedR2Prefix: "clients/root/selected/", reason: "Reserve exact selected folder" }
  : { operationId: id(12), targetId: id(2), reservationId: id(11), expectedRevision: 1,
    reason: "Revoke exact selected folder" }, publication: { operationId: id(13), publicationId: id(14),
    snapshotId: id(15), checkpointId: id(16), invocationId: id(17), expectedRevision: 4,
    reason: "Publish exact folder change" } }; }
function refreshInput() { return { targetId: id(2), publication: { operationId: id(20), publicationId: id(21),
  snapshotId: id(22), checkpointId: id(23), invocationId: id(24), expectedRevision: 4,
  reason: "Refresh current workspace membership" } }; }
async function csrf(d: Dependencies) { const response = await handle(new Request(`${base}/csrf`), d);
  return (await response.json() as { csrfToken: string }).csrfToken; }
function post(path: string, body: unknown, token: string, key: string) { return new Request(`${base}/${path}`, { method: "POST",
  headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json",
    "X-CSRF-Token": token, "Idempotency-Key": key }, body: JSON.stringify(body) }); }

describe("operations portal workspace owner HTTP", () => {
  beforeEach(() => { vi.clearAllMocks(); calls.auth.mockResolvedValue(actor);
    calls.reserveWorkspace.mockResolvedValue({ operationId: id(1), targetId: id(2), revision: 1, replayed: false });
    calls.reserveFolder.mockResolvedValue({ operationId: id(10), targetId: id(2), reservationId: id(11), revision: 1,
      state: "active", replayed: false });
    calls.revokeFolder.mockResolvedValue({ operationId: id(12), targetId: id(2), reservationId: id(11), revision: 2,
      state: "revoked", replayed: false });
    calls.reservePublication.mockResolvedValue({ operationId: id(4), publicationRevision: 1, replayed: false });
    calls.reserveInvocation.mockResolvedValue({ state: "authorized", replayed: false });
    calls.dispatch.mockResolvedValue({ operationId: id(4), status: "acknowledged" });
    calls.lookupProjectFolder.mockResolvedValue({ targetId: id(2), externalProjectId: "project-1", projectName: "Synthetic project",
      projectVersion: 7, association: null });
    calls.confirmProjectFolder.mockResolvedValue({ targetId: id(2), externalProjectId: "project-1", projectName: "Synthetic project",
      projectVersion: 7, association: { opsFolderProjectId: "project-1", opsDivisionId: "division-1", baseR2Prefix: "synthetic/project/",
        baseMatchMethod: "manual", baseConfirmedBy: "owner", baseConfirmedAt: "2026-10-02T12:00:00.000Z" } }); });

  it("looks up an exact native project proof without calling publication operations", async () => {
    const d = deps(), response = await handle(new Request(`${base}/project-folder?targetId=${id(2)}&externalProjectId=project-1`), d);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(calls.lookupProjectFolder).toHaveBeenCalledWith(d.database, actor, { targetId: id(2), externalProjectId: "project-1" });
    expect(calls.reserveWorkspace).not.toHaveBeenCalled(); expect(calls.dispatch).not.toHaveBeenCalled();
  });

  it.each([`targetId=${id(2)}`, `targetId=${id(2)}&externalProjectId=project-1&actor=forged`,
    `targetId=${id(2)}&targetId=${id(2)}&externalProjectId=project-1`, "targetId=invalid&externalProjectId=project-1"])
    ("rejects malformed or broadened folder lookup: %s", async query => {
      expect((await handle(new Request(`${base}/project-folder?${query}`), deps())).status).toBe(400);
      expect(calls.lookupProjectFolder).not.toHaveBeenCalled();
    });

  it("confirmation requires CSRF and sends only the exact full prior proof to the native service", async () => {
    const d = deps(), token = await csrf(d), body = { targetId: id(2), externalProjectId: "project-1", expectedProjectVersion: 7,
      expectedAssociation: null, opsDivisionId: "division-1", baseR2Prefix: "synthetic/project/" };
    expect((await handle(post("confirm-project-folder", body, "", id(31)), d)).status).toBe(403);
    expect(calls.confirmProjectFolder).not.toHaveBeenCalled();
    expect((await handle(post("confirm-project-folder", { ...body, confirmedBy: "forged" }, token, id(31)), d)).status).toBe(400);
    expect((await handle(post("confirm-project-folder", { ...body, expectedAssociation: {} }, token, id(31)), d)).status).toBe(400);
    const response = await handle(post("confirm-project-folder", body, token, id(31)), d);
    expect(response.status).toBe(200);
    expect(calls.confirmProjectFolder).toHaveBeenCalledWith(d.database, actor, body);
    expect(calls.dispatch).not.toHaveBeenCalled();
  });

  it("native folder authority denials remain denied and do not publish", async () => {
    calls.lookupProjectFolder.mockRejectedValue(new Error("operations_portal_shared_project_folder_denied"));
    expect((await handle(new Request(`${base}/project-folder?targetId=${id(2)}&externalProjectId=project-1`), deps())).status).toBe(403);
    expect(calls.dispatch).not.toHaveBeenCalled();
  });

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
    const corrupted = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    expect(corrupted).not.toBe(token);
    expect((await handle(post("reserve-and-publish", body, corrupted, id(1)), d)).status).toBe(403);
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

  it("refreshes only the current publication topology and preserves every replay ID", async () => {
    const d = deps(), token = await csrf(d), body = refreshInput();
    calls.reservePublication.mockResolvedValue({ operationId: id(20), publicationRevision: 5, replayed: false });
    calls.dispatch.mockResolvedValue({ operationId: id(20), status: "acknowledged" });
    const first = await handle(post("refresh-and-publish", body, token, id(20)), d);
    expect(first.status).toBe(200); expect(await first.json()).toEqual({ targetId: id(2),
      publicationOperationId: id(20), publicationRevision: 5, publicationState: "acknowledged",
      publicationReplayed: false });
    calls.reservePublication.mockResolvedValue({ operationId: id(20), publicationRevision: 5, replayed: true });
    calls.dispatch.mockResolvedValue({ operationId: id(20), status: "acknowledged", replayed: true });
    const replay = await handle(post("refresh-and-publish", body, token, id(20)), d);
    expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ publicationReplayed: true });
    const { invocationId: _invocationId, ...publication } = body.publication;
    expect(calls.reservePublication).toHaveBeenLastCalledWith(d.database, actor, { ...publication, targetId: id(2) });
    expect(calls.reserveInvocation).toHaveBeenLastCalledWith(d.database, actor, { invocationId: id(24),
      operationId: id(20), action: "publish", reason: body.publication.reason });
    expect(calls.dispatch).toHaveBeenLastCalledWith({ db: d.database, binding: d.publication,
      operationId: id(20), invocationId: id(24), action: "publish" });
    expect(calls.reserveWorkspace).not.toHaveBeenCalled(); expect(calls.reserveFolder).not.toHaveBeenCalled();
    expect(calls.revokeFolder).not.toHaveBeenCalled();
  });

  it("rejects unsafe refresh inputs before every domain mutation", async () => {
    const d = deps(), token = await csrf(d), valid = refreshInput();
    const duplicate = refreshInput(); duplicate.publication.invocationId = duplicate.publication.operationId;
    const zero = refreshInput(); zero.publication.expectedRevision = 0;
    const requests = [
      post("refresh-and-publish", valid, "", id(20)),
      post("refresh-and-publish", valid, token, id(99)),
      post("refresh-and-publish", { ...valid, actor: "forged" }, token, id(20)),
      post("refresh-and-publish", { ...valid, targetId: "invalid" }, token, id(20)),
      post("refresh-and-publish", duplicate, token, id(20)),
      post("refresh-and-publish", zero, token, id(20)),
    ];
    const crossSite = post("refresh-and-publish", valid, token, id(20)); crossSite.headers.set("Sec-Fetch-Site", "cross-site");
    requests.push(crossSite);
    for (const request of requests) expect((await handle(request, d)).status).toBe(request === requests[0] || request === crossSite ? 403 : 400);
    expect(calls.reservePublication).not.toHaveBeenCalled(); expect(calls.reserveInvocation).not.toHaveBeenCalled();
    expect(calls.dispatch).not.toHaveBeenCalled(); expect(calls.reserveWorkspace).not.toHaveBeenCalled();
    expect(calls.reserveFolder).not.toHaveBeenCalled(); expect(calls.revokeFolder).not.toHaveBeenCalled();
  });

  it("reserves the exact selected folder and publishes at the explicit current revision", async () => {
    const d = deps(), body = folderInput(), token = await csrf(d);
    calls.reservePublication.mockResolvedValue({ operationId: id(13), publicationRevision: 5, replayed: false });
    calls.dispatch.mockResolvedValue({ operationId: id(13), status: "acknowledged" });
    const response = await handle(post("reserve-folder-and-publish", body, token, id(10)), d);
    expect(response.status).toBe(200);
    expect(calls.reserveFolder).toHaveBeenCalledWith(d.database, actor, body.folder);
    expect(calls.reservePublication).toHaveBeenCalledWith(d.database, actor, expect.objectContaining({
      operationId: id(13), targetId: id(2), expectedRevision: 4 }));
    expect(await response.json()).toMatchObject({ reservationId: id(11), folderState: "active",
      publicationRevision: 5, publicationState: "acknowledged" });
  });

  it("short-circuits folder publication on real domain denial", async () => {
    calls.reserveFolder.mockRejectedValue(new Error("operations_portal_workspace_reservation_denied"));
    const d = deps(), body = folderInput(), response = await handle(post("reserve-folder-and-publish", body,
      await csrf(d), id(10)), d);
    expect(response.status).toBe(403); expect(calls.reservePublication).not.toHaveBeenCalled();
    expect(calls.reserveInvocation).not.toHaveBeenCalled(); expect(calls.dispatch).not.toHaveBeenCalled();
  });

  it("replays exact folder revocation and publication without changing IDs", async () => {
    const d = deps(), body = folderInput("revoke"), token = await csrf(d);
    calls.revokeFolder.mockResolvedValue({ operationId: id(12), targetId: id(2), reservationId: id(11), revision: 2,
      state: "revoked", replayed: true });
    calls.reservePublication.mockResolvedValue({ operationId: id(13), publicationRevision: 5, replayed: true });
    calls.dispatch.mockResolvedValue({ operationId: id(13), status: "acknowledged", replayed: true });
    const response = await handle(post("revoke-folder-and-publish", body, token, id(12)), d);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ folderState: "revoked",
      folderReplayed: true, publicationReplayed: true });
    expect(calls.revokeFolder).toHaveBeenCalledWith(d.database, actor, body.folder);
  });
});
