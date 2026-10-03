import { beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ auth: vi.fn(), issue: vi.fn(), read: vi.fn(), cancel: vi.fn(), confirm: vi.fn(),
  revoke: vi.fn(), workspaceRead: vi.fn(), workspaceRevoke: vi.fn(), workspaceInvocation: vi.fn(), command: vi.fn(), materialize: vi.fn(), dispatch: vi.fn() }));
vi.mock("../src/worker/operations-portal-native-workspace-cleanup", () => ({
  reserveOperationsPortalNativeWorkspaceCleanupRecovery: calls.workspaceInvocation,
}));
vi.mock("../src/worker/native-staff-auth", () => ({ authenticateNativeStaffWithAdmissionVersion: calls.auth }));
vi.mock("../src/worker/operations-portal-native-recipient-authority", () => ({
  issueOperationsPortalNativeRecipientIntent: calls.issue, readOperationsPortalNativeRecipientIntentForOwner: calls.read,
  cancelOperationsPortalNativeRecipientIntent: calls.cancel, confirmOperationsPortalNativeRecipientIntent: calls.confirm,
  revokeOperationsPortalNativeRecipient: calls.revoke,
  readOperationsPortalNativeAuthorityCommand: calls.command,
  readOperationsPortalNativeWorkspaceCleanupForOwner: calls.workspaceRead,
  revokeOperationsPortalNativeWorkspaceAuthority: calls.workspaceRevoke,
}));
vi.mock("../src/worker/operations-portal-native-recipient-authority-dispatch", () => ({
  materializeOperationsPortalNativeRecipientAuthority: calls.materialize, dispatchOperationsPortalNativeRecipientAuthority: calls.dispatch,
}));
import { handleOperationsNativeRecipientOwnerHttp as handle, type OperationsNativeRecipientOwnerHttpDependencies as Dependencies }
  from "../src/worker/operations-portal-native-recipient-owner-http";

const origin = "https://ops-staging.example.test", base = `${origin}/api/native-client-portal/operations-recipient-enrollment`;
const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const operationId = id(1), intentId = id(2), targetId = id(3);
const actor = { identity: { kind: "native", staffId: "manager", verifiedAccessSubject: "access|manager",
  email: "manager@example.invalid", displayName: "Manager", profileVersion: 2 }, admissionVersion: 3,
  verifiedUntil: "2099-01-01T00:00:00.000Z" };
function deps(): Dependencies { return { environment: "staging", expectedHost: "ops-staging.example.test",
  configuration: { enabled: true, issuer: "https://team.cloudflareaccess.com", staffAudience: "a".repeat(16), origin,
    recipientOrigin: "https://client-staging.example.test", csrfSecret: "native-owner-test-csrf-secret-long-enough" },
  database: {} as D1Database, dispatch: { OPS_DB: {} as D1Database,
    OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true",
    OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: { applyNativeAuthority: vi.fn(), getNativeAuthorityStatus: vi.fn() } } }; }
function request(path: string, body?: unknown, token?: string) { return new Request(`${base}/${path}`, {
  method: body === undefined ? "GET" : "POST", headers: { Origin: origin, "Sec-Fetch-Site": "same-origin",
    "X-Native-Staff-Request": "1", "Content-Type": "application/json", ...(token ? { "X-CSRF-Token": token } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}); }
async function token(d: Dependencies) { const result = await handle(request("session"), d); expect(result.status).toBe(200);
  return (await result.json() as { csrfToken: string }).csrfToken; }
const issue = () => ({ operationId, targetId, targetClientRecordId: "client:one", expiresAt: "2099-01-01T00:00:00.000Z" });
const mutation = () => ({ operationId, expectedRevision: 2 });

describe("Ops-native recipient owner HTTP boundary", () => {
  beforeEach(() => { vi.clearAllMocks(); calls.auth.mockResolvedValue(actor);
    calls.issue.mockResolvedValue({ review: { intentId, state: "issued" }, opaqueToken: "f".repeat(64), replayed: false });
    calls.read.mockResolvedValue({ intentId, state: "active" }); calls.cancel.mockResolvedValue({ review: { intentId, state: "cancelled" } });
    calls.confirm.mockResolvedValue({ authorityOperationId: operationId, replayed: false });
    calls.revoke.mockResolvedValue({ authorityOperationId: operationId, replayed: false });
    calls.workspaceRead.mockResolvedValue({ targetId, state: "revoking", ownershipEpoch: 2, recoveryOperationId: operationId });
    calls.workspaceRevoke.mockResolvedValue({ operationId, targetId, state: "revoking", ownershipEpoch: 2, replayed: false });
    calls.workspaceInvocation.mockResolvedValue({ operationId, state: "authorized" });
    calls.materialize.mockResolvedValue({ operationId }); calls.dispatch.mockResolvedValue({ status: "acknowledged", operationId });
  });
  it.each(["disabled", "production"])("is absent for %s without authentication or writes", async mode => {
    const d = deps(), modified = mode === "disabled" ? { ...d, configuration: { ...d.configuration, enabled: false } }
      : { ...d, environment: "production" };
    for (const path of ["session", `workspaces/${targetId}`, `workspaces/${targetId}/revoke`]) {
      expect((await handle(request(path, path.endsWith("/revoke")
        ? { operationId, expectedOwnershipEpoch: 1, reason: "cleanup" } : undefined), modified)).status).toBe(404);
    }
    expect(calls.auth).not.toHaveBeenCalled(); expect(calls.workspaceRevoke).not.toHaveBeenCalled();
  });
  it("rejects an incomplete private transport before issuing intents", async () => {
    const d = deps(); expect((await handle(request("session"), { ...d, dispatch: { OPS_DB: d.database } })).status).toBe(503);
    expect(calls.issue).not.toHaveBeenCalled();
  });
  it("requires a current signed native identity and rechecks its deadline", async () => {
    calls.auth.mockRejectedValue(Error("private")); const denied = await handle(request("session"), deps());
    expect(denied.status).toBe(403); expect(await denied.text()).not.toContain("private");
    calls.auth.mockResolvedValue({ ...actor, verifiedUntil: "2000-01-01T00:00:00.000Z" });
    expect((await handle(request("session"), deps())).status).toBe(403);
  });
  it("issues only the explicit target and returns the one-time token privately", async () => {
    const d = deps(), csrf = await token(d), result = await handle(request("intents", issue(), csrf), d);
    expect(result.status).toBe(201); expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(result.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(calls.issue).toHaveBeenCalledWith(d.database, { ...issue(), owner: actor });
  });
  it("reads only through the currently authorized manager ledger method", async () => {
    const d = deps(); expect((await handle(request(`intents/${intentId}`), d)).status).toBe(200);
    expect(calls.read).toHaveBeenCalledWith(d.database, intentId, actor);
    expect(calls.materialize).not.toHaveBeenCalled(); expect(calls.dispatch).not.toHaveBeenCalled();
  });
  it.each(["confirm", "revoke"])("%s transports only its exact durable operation", async action => {
    const d = deps(), csrf = await token(d), result = await handle(request(`intents/${intentId}/${action}`, mutation(), csrf), d);
    expect(result.status).toBe(200); expect(calls.materialize).toHaveBeenCalledWith(d.database, operationId);
    expect(calls.dispatch).toHaveBeenCalledWith(d.dispatch, operationId);
    expect(await result.json()).toMatchObject({ operationId, status: "acknowledged", intent: { state: "active" } });
  });
  it("keeps ambiguous transport pending rather than claiming active access", async () => {
    calls.dispatch.mockResolvedValue({ status: "retry", operationId }); calls.read.mockResolvedValue({ intentId, state: "confirming" });
    const d = deps(), csrf = await token(d), result = await handle(request(`intents/${intentId}/confirm`, mutation(), csrf), d);
    expect(result.status).toBe(202); expect(await result.json()).toMatchObject({ status: "pending", intent: { state: "confirming" } });
  });
  it("cancels drafts without transporting or granting access", async () => {
    const d = deps(), csrf = await token(d); expect((await handle(request(`intents/${intentId}/cancel`, mutation(), csrf), d)).status).toBe(200);
    expect(calls.cancel).toHaveBeenCalledWith(d.database, { ...mutation(), intentId, owner: actor });
    expect(calls.materialize).not.toHaveBeenCalled(); expect(calls.dispatch).not.toHaveBeenCalled();
  });
  it.each([{ owner: true }, { subject: "forged" }, { issuer: "forged" }, { email: "forged" }, { selectionId: targetId }])
    ("rejects extra authority or legacy inputs %j", async extra => {
      const d = deps(), csrf = await token(d); expect((await handle(request("intents", { ...issue(), ...extra }, csrf), d)).status).toBe(400);
      expect(calls.issue).not.toHaveBeenCalled();
    });
  it("rejects missing CSRF, cross-origin requests and identity changes", async () => {
    const d = deps(), csrf = await token(d); expect((await handle(request("intents", issue()), d)).status).toBe(403);
    const cross = request("intents", issue(), csrf); cross.headers.set("Origin", "https://other.example.test");
    expect((await handle(cross, d)).status).toBe(403);
    calls.auth.mockResolvedValue({ ...actor, identity: { ...actor.identity, verifiedAccessSubject: "access|other" } });
    expect((await handle(request("intents", issue(), csrf), d)).status).toBe(403); expect(calls.issue).not.toHaveBeenCalled();
  });
  it("rejects malformed identifiers, revision ambiguity, GET mutations and query tokens", async () => {
    const d = deps(), csrf = await token(d);
    expect((await handle(request(`intents/${intentId}/confirm`), d)).status).toBe(404);
    expect((await handle(request(`intents/${"x".repeat(36)}`), d)).status).toBe(404);
    expect((await handle(request(`intents/${intentId}/confirm`, { operationId, expectedRevision: "2" }, csrf), d)).status).toBe(400);
    expect((await handle(request("session?token=private"), d)).status).toBe(403);
    expect(calls.confirm).not.toHaveBeenCalled();
  });
  it("does not expose private transport or database errors", async () => {
    calls.materialize.mockRejectedValue(Error("private internal SQL")); const d = deps(), csrf = await token(d);
    const result = await handle(request(`intents/${intentId}/confirm`, mutation(), csrf), d);
    expect(result.status).toBe(503); expect(await result.text()).not.toContain("private internal SQL");
    expect(calls.dispatch).not.toHaveBeenCalled();
  });
  const recoveryReview = () => ({ intentId, revision: 3, state: "confirming", recipientBindingId: id(4),
    target: { targetId, targetRevision: 2, clientRecordId: "client:one" },
    principal: { issuer: "https://team.cloudflareaccess.com", subject: "access|recipient" } });
  const recoveryCommand = () => ({ operation_id: operationId, action: "recipient.grant", enrollment_intent_id: intentId,
    target_id: targetId, target_revision: 2, target_client_record_id: "client:one", recipient_binding_id: id(4),
    issuer: "https://team.cloudflareaccess.com", subject: "access|recipient" });
  it("recovers a pending exact operation without re-entering grant/revoke creation", async () => {
    calls.read.mockResolvedValue(recoveryReview()); calls.command.mockResolvedValue(recoveryCommand());
    const d = deps(), csrf = await token(d), result = await handle(request(`intents/${intentId}/recover`,
      { operationId, expectedRevision: 3 }, csrf), d);
    expect(result.status).toBe(200); expect(calls.command).toHaveBeenCalledWith(d.database, operationId);
    expect(calls.materialize).toHaveBeenCalledWith(d.database, operationId);
    expect(calls.dispatch).toHaveBeenCalledWith(d.dispatch, operationId);
    expect(calls.confirm).not.toHaveBeenCalled(); expect(calls.revoke).not.toHaveBeenCalled(); expect(calls.issue).not.toHaveBeenCalled();
  });
  it.each(["revoking", "revoked"])("recovers exact revocation in %s without creating another command", async state => {
    calls.read.mockResolvedValue({ ...recoveryReview(), state });
    calls.command.mockResolvedValue({ ...recoveryCommand(), action: "recipient.revoke" });
    const d = deps(), csrf = await token(d), result = await handle(request(`intents/${intentId}/recover`,
      { operationId, expectedRevision: 3 }, csrf), d);
    expect(result.status).toBe(200);
    expect(calls.materialize).toHaveBeenCalledWith(d.database, operationId);
    expect(calls.dispatch).toHaveBeenCalledWith(d.dispatch, operationId);
    expect(calls.confirm).not.toHaveBeenCalled(); expect(calls.revoke).not.toHaveBeenCalled();
  });
  it.each(["retry", "idle"])("leaves recovery %s pending without claiming acknowledgement", async status => {
    calls.read.mockResolvedValue(recoveryReview()); calls.command.mockResolvedValue(recoveryCommand());
    calls.dispatch.mockResolvedValue({ status, operationId });
    const d = deps(), csrf = await token(d), result = await handle(request(`intents/${intentId}/recover`,
      { operationId, expectedRevision: 3 }, csrf), d);
    expect(result.status).toBe(202);
    expect(await result.json()).toMatchObject({ operationId, status: "pending", intent: { state: "confirming" } });
    expect(calls.confirm).not.toHaveBeenCalled(); expect(calls.revoke).not.toHaveBeenCalled();
  });
  it.each([{ subject: "different-person" }, { target_id: id(9) }, { enrollment_intent_id: id(9) }, { action: "workspace.revoke" }])
    ("rejects recovery command mismatch %j", async extra => {
      calls.read.mockResolvedValue(recoveryReview()); calls.command.mockResolvedValue({ ...recoveryCommand(), ...extra });
      const d = deps(), csrf = await token(d); expect((await handle(request(`intents/${intentId}/recover`,
        { operationId, expectedRevision: 3 }, csrf), d)).status).toBe(403);
      expect(calls.materialize).not.toHaveBeenCalled(); expect(calls.dispatch).not.toHaveBeenCalled();
    });
  it("reads cleanup through historical workspace authority rather than current client topology", async () => {
    const d = deps(), result = await handle(request(`workspaces/${targetId}`), d);
    expect(result.status).toBe(200);
    expect(calls.workspaceRead).toHaveBeenCalledWith(d.database, targetId, actor);
    expect(calls.read).not.toHaveBeenCalled(); expect(calls.dispatch).not.toHaveBeenCalled();
  });
  it("revokes only the explicit workspace operation under current owner authority", async () => {
    const d = deps(), csrf = await token(d), input = { operationId, expectedOwnershipEpoch: 1, reason: "Owner requested cleanup" };
    const result = await handle(request(`workspaces/${targetId}/revoke`, input, csrf), d);
    expect(result.status).toBe(200);
    expect(calls.workspaceRevoke).toHaveBeenCalledWith(d.database, { ...input, targetId, owner: actor });
    expect(calls.materialize).toHaveBeenCalledWith(d.database, operationId);
    expect(calls.workspaceInvocation).toHaveBeenCalledWith(d.database, {
      invocationId: expect.any(String), operationId, owner: actor,
    });
    expect(calls.dispatch).toHaveBeenCalledWith(d.dispatch, operationId, calls.workspaceInvocation.mock.calls[0]![1].invocationId);
    expect(calls.confirm).not.toHaveBeenCalled(); expect(calls.revoke).not.toHaveBeenCalled();
  });
  it.each(["revoking", "revoked"])("recovers the stored workspace revoke in %s without issuing a command", async state => {
    calls.workspaceRead.mockResolvedValue({ targetId, state, ownershipEpoch: 2, recoveryOperationId: operationId });
    calls.command.mockResolvedValue({ operation_id: operationId, target_id: targetId, action: "workspace.revoke", resulting_ownership_epoch: 2 });
    const d = deps(), csrf = await token(d), result = await handle(request(`workspaces/${targetId}/recover`,
      { operationId, expectedOwnershipEpoch: 2 }, csrf), d);
    expect(result.status).toBe(200); expect(calls.workspaceRevoke).not.toHaveBeenCalled();
    expect(calls.materialize).toHaveBeenCalledWith(d.database, operationId);
    if (state === "revoking") {
      expect(calls.workspaceInvocation).toHaveBeenCalledWith(d.database, { invocationId: expect.any(String), operationId, owner: actor });
      expect(calls.dispatch).toHaveBeenCalledWith(d.dispatch, operationId, calls.workspaceInvocation.mock.calls[0]![1].invocationId);
    } else {
      expect(calls.workspaceInvocation).not.toHaveBeenCalled();
      expect(calls.dispatch).toHaveBeenCalledWith(d.dispatch, operationId);
    }
  });
  it("denies workspace transport if fresh recovery authorization fails", async () => {
    calls.workspaceInvocation.mockRejectedValue(Error("operations_portal_native_workspace_cleanup_denied"));
    const d = deps(), csrf = await token(d);
    const result = await handle(request(`workspaces/${targetId}/revoke`, { operationId, expectedOwnershipEpoch: 1, reason: "cleanup" }, csrf), d);
    expect(result.status).toBe(403); expect(calls.dispatch).not.toHaveBeenCalled();
  });
  it("retries the same workspace business command with a new server-only invoker proof", async () => {
    calls.dispatch.mockResolvedValue({ status: "retry", operationId });
    const d = deps(), csrf = await token(d), input = { operationId, expectedOwnershipEpoch: 1, reason: "cleanup" };
    expect((await handle(request(`workspaces/${targetId}/revoke`, input, csrf), d)).status).toBe(202);
    calls.auth.mockResolvedValue({ ...actor, verifiedUntil: "2099-02-01T00:00:00.000Z" });
    expect((await handle(request(`workspaces/${targetId}/revoke`, input, csrf), d)).status).toBe(202);
    const first = calls.workspaceInvocation.mock.calls[0]![1], second = calls.workspaceInvocation.mock.calls[1]![1];
    expect(first.operationId).toBe(second.operationId); expect(first.invocationId).not.toBe(second.invocationId);
    expect(second.owner.verifiedUntil).toBe("2099-02-01T00:00:00.000Z");
    expect(calls.dispatch.mock.calls.map(call => call[1])).toEqual([operationId, operationId]);
  });
  it.each(["wrong-operation", "wrong-target", "wrong-action", "wrong-epoch", "wrong-command-epoch", "active-workspace"])
    ("blocks workspace recovery for %s before transport", async mismatch => {
      calls.workspaceRead.mockResolvedValue({ targetId, state: mismatch === "active-workspace" ? "active" : "revoking",
        ownershipEpoch: mismatch === "wrong-epoch" ? 3 : 2,
        recoveryOperationId: mismatch === "wrong-operation" ? id(9) : operationId });
      calls.command.mockResolvedValue({ operation_id: operationId,
        target_id: mismatch === "wrong-target" ? id(9) : targetId,
        action: mismatch === "wrong-action" ? "recipient.grant" : "workspace.revoke",
        resulting_ownership_epoch: mismatch === "wrong-command-epoch" ? 1 : 2 });
      const d = deps(), csrf = await token(d);
      expect((await handle(request(`workspaces/${targetId}/recover`, { operationId, expectedOwnershipEpoch: 2 }, csrf), d)).status).toBe(403);
      expect(calls.workspaceRevoke).not.toHaveBeenCalled(); expect(calls.materialize).not.toHaveBeenCalled();
      expect(calls.dispatch).not.toHaveBeenCalled();
    });
  it("rejects extra authority, malformed cleanup reason and missing CSRF", async () => {
    const d = deps(), csrf = await token(d), input = { operationId, expectedOwnershipEpoch: 1, reason: "cleanup" };
    for (const invalid of [{ ...input, owner: true }, { ...input, reason: "\nprivate" },
      { ...input, reason: " " }, { ...input, expectedOwnershipEpoch: "1" }]) {
      expect((await handle(request(`workspaces/${targetId}/revoke`, invalid, csrf), d)).status).toBe(400);
    }
    expect((await handle(request(`workspaces/${targetId}/revoke`, input), d)).status).toBe(403);
    expect(calls.workspaceRevoke).not.toHaveBeenCalled();
  });
  it("keeps uncertain workspace cleanup pending without claiming remote acknowledgement", async () => {
    calls.dispatch.mockResolvedValue({ operationId, status: "retry" });
    const d = deps(), csrf = await token(d), result = await handle(request(`workspaces/${targetId}/revoke`,
      { operationId, expectedOwnershipEpoch: 1, reason: "cleanup" }, csrf), d);
    expect(result.status).toBe(202);
    expect(await result.json()).toMatchObject({ operationId, status: "pending", workspace: { state: "revoking" } });
  });
  it("returns a bounded denial when the cleanup core rejects current owner authority", async () => {
    calls.workspaceRead.mockRejectedValue(new Error("operations_portal_native_workspace_cleanup_denied"));
    const result = await handle(request(`workspaces/${targetId}`), deps());
    expect(result.status).toBe(403); expect(await result.json()).toEqual({ error: "denied" });
    expect(calls.materialize).not.toHaveBeenCalled(); expect(calls.dispatch).not.toHaveBeenCalled();
  });
  it("does not recover an old grant after revocation or a stale review revision", async () => {
    calls.command.mockResolvedValue(recoveryCommand()); const d = deps(), csrf = await token(d);
    for (const intent of [{ ...recoveryReview(), state: "revoked" }, { ...recoveryReview(), revision: 4 }]) {
      calls.read.mockResolvedValue(intent); expect((await handle(request(`intents/${intentId}/recover`,
        { operationId, expectedRevision: 3 }, csrf), d)).status).toBe(403);
    }
    expect(calls.dispatch).not.toHaveBeenCalled();
  });
});
