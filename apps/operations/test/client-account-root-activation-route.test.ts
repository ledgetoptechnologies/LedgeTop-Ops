import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateStaff: vi.fn(),
  isAdministrator: vi.fn(),
  sqlScope: vi.fn(),
  requireMutationSecurity: vi.fn(),
  listActivation: vi.fn(),
  activateRoot: vi.fn(),
  reconcileWorkspaces: vi.fn(),
  syncProjectAlpha: vi.fn(),
  auditStatement: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
vi.mock("../src/worker/acl", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/acl")>(),
  isAdministrator: mocks.isAdministrator,
  sqlScope: mocks.sqlScope,
}));
vi.mock("../src/worker/request-security", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/request-security")>(),
  requireMutationSecurity: mocks.requireMutationSecurity,
  auditStatement: mocks.auditStatement,
}));
vi.mock("../src/worker/project-alpha", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/project-alpha")>(),
  syncProjectAlpha: mocks.syncProjectAlpha,
}));
vi.mock("../src/worker/client-account-root-activation", () => ({
  listClientAccountRootActivation: mocks.listActivation,
  activateClientAccountRoot: mocks.activateRoot,
}));
vi.mock("../src/worker/client-portal-workspace-reconciliation", () => ({
  reconcileClientPortalWorkspaces: mocks.reconcileWorkspaces,
}));

import worker from "../src/worker/index";

const principal = {
  id: "staff-admin",
  email: "admin@example.test",
  displayName: "Admin",
  accessSubject: "access-admin",
  projectAlphaUserId: null,
};
const executionCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const env = {
  ENVIRONMENT: "development",
  EXPECTED_HOST: "ops.example",
  INCOMING_EXPECTED_HOST: "incoming.example",
  OPS_DB: { batch: vi.fn() },
};

describe("client account root activation routes", () => {
  beforeEach(() => {
    mocks.authenticateStaff.mockReset().mockResolvedValue(principal);
    mocks.isAdministrator.mockReset().mockResolvedValue(true);
    mocks.sqlScope.mockReset().mockResolvedValue({
      global: true, deniedGlobal: false, divisions: [], deniedDivisions: [], assigned: false, own: false,
    });
    mocks.requireMutationSecurity.mockReset().mockResolvedValue(undefined);
    mocks.listActivation.mockReset().mockResolvedValue({ workspaceMigrationApplied: false, accounts: [], sources: [] });
    mocks.activateRoot.mockReset().mockResolvedValue({ accountId: "account-a", unchanged: false });
    mocks.reconcileWorkspaces.mockReset().mockResolvedValue({ enabled: true, sources: [] });
    mocks.syncProjectAlpha.mockReset().mockResolvedValue({ status: "success", records: 2, changedCollections: [] });
    mocks.auditStatement.mockReset().mockResolvedValue({});
    vi.mocked(env.OPS_DB.batch).mockReset().mockResolvedValue([]);
  });

  it("requires an administrator and global operations.manage for both preflight and activation", async () => {
    mocks.isAdministrator.mockResolvedValue(false);
    const deniedRead = await worker.fetch(
      new Request("https://ops.example/api/admin/client-account-activation"), env as never, executionCtx,
    );
    expect(deniedRead.status).toBe(403);
    expect(mocks.listActivation).not.toHaveBeenCalled();

    const deniedWrite = await worker.fetch(new Request(
      "https://ops.example/api/admin/client-account-activation/account-a",
      { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://ops.example" },
        body: JSON.stringify({ projectAlphaClientId: "pa-client", expectedUpdatedAt: "v1" }) },
    ), env as never, executionCtx);
    expect(deniedWrite.status).toBe(403);
    expect(mocks.activateRoot).not.toHaveBeenCalled();

    mocks.isAdministrator.mockResolvedValue(true);
    mocks.sqlScope.mockResolvedValue({
      global: false, deniedGlobal: false, divisions: [], deniedDivisions: [], assigned: false, own: false,
    });
    const noGlobalGrant = await worker.fetch(
      new Request("https://ops.example/api/admin/client-account-activation"), env as never, executionCtx,
    );
    expect(noGlobalGrant.status).toBe(403);
    expect(mocks.listActivation).not.toHaveBeenCalled();
  });

  it("runs the standard mutation-security check before invoking the audited activation service", async () => {
    const response = await worker.fetch(new Request(
      "https://ops.example/api/admin/client-account-activation/account-a",
      { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://ops.example" },
        body: JSON.stringify({ projectAlphaClientId: "pa-client", expectedUpdatedAt: "v1" }) },
    ), env as never, executionCtx);
    expect(response.status).toBe(200);
    expect(mocks.requireMutationSecurity).toHaveBeenCalledOnce();
    expect(mocks.activateRoot).toHaveBeenCalledWith(
      expect.anything(), principal, "account-a",
      { projectAlphaClientId: "pa-client", expectedUpdatedAt: "v1" },
    );
  });

  it("exposes reconciliation only as an explicit protected administrator recovery action", async () => {
    const response = await worker.fetch(new Request(
      "https://ops.example/api/admin/client-account-activation/reconcile",
      { method: "POST", headers: { Origin: "https://ops.example" } },
    ), env as never, executionCtx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true, sources: [] });
    expect(mocks.requireMutationSecurity).toHaveBeenCalledOnce();
    expect(mocks.reconcileWorkspaces).toHaveBeenCalledOnce();
    expect(mocks.activateRoot).not.toHaveBeenCalled();

    mocks.sqlScope.mockResolvedValue({
      global: false, deniedGlobal: false, divisions: [], deniedDivisions: [], assigned: false, own: false,
    });
    const denied = await worker.fetch(new Request(
      "https://ops.example/api/admin/client-account-activation/reconcile",
      { method: "POST", headers: { Origin: "https://ops.example" } },
    ), env as never, executionCtx);
    expect(denied.status).toBe(403);
    expect(mocks.reconcileWorkspaces).toHaveBeenCalledOnce();
  });

  it("does not invoke activation when same-origin/CSRF validation fails", async () => {
    mocks.requireMutationSecurity.mockRejectedValue(new Error("csrf denied"));
    const response = await worker.fetch(new Request(
      "https://ops.example/api/admin/client-account-activation/account-a",
      { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify({ projectAlphaClientId: "pa-client", expectedUpdatedAt: "v1" }) },
    ), env as never, executionCtx);
    expect(response.status).toBe(500);
    expect(mocks.activateRoot).not.toHaveBeenCalled();
  });

  it("reconciles only after a successful primary manual sync and preserves a disabled response", async () => {
    mocks.syncProjectAlpha.mockResolvedValueOnce({ status: "disabled", records: 0, changedCollections: [] });
    const disabled = await worker.fetch(new Request(
      "https://ops.example/api/admin/integrations/project-alpha/sync",
      { method: "POST", headers: { Origin: "https://ops.example" } },
    ), env as never, executionCtx);
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ status: "disabled", records: 0, changedCollections: [] });
    expect(mocks.reconcileWorkspaces).not.toHaveBeenCalled();

    const success = await worker.fetch(new Request(
      "https://ops.example/api/admin/integrations/project-alpha/sync",
      { method: "POST", headers: { Origin: "https://ops.example" } },
    ), env as never, executionCtx);
    expect(success.status).toBe(200);
    expect(await success.json()).toMatchObject({
      status: "success",
      clientPortalReconciliation: { enabled: true, sources: [] },
    });
    expect(mocks.reconcileWorkspaces).toHaveBeenCalledOnceWith(expect.anything(), "project-alpha:primary");
  });
});
