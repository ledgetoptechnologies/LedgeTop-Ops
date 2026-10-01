import { beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks = vi.hoisted(() => ({
  authenticateStaff: vi.fn(),
  isAdministrator: vi.fn(),
  sqlScope: vi.fn(),
  refresh: vi.fn(),
  audit: vi.fn(),
  batch: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
vi.mock("../src/worker/acl", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/acl")>(),
  isAdministrator: mocks.isAdministrator,
  sqlScope: mocks.sqlScope,
}));
vi.mock("../src/worker/project-alpha-project-binding-revision-refresh", () => ({ refreshProjectAlphaProjectBinding: mocks.refresh }));
vi.mock("../src/worker/request-security", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/request-security")>(),
  auditStatement: mocks.audit,
}));

import worker from "../src/worker/index";
import { csrfToken } from "../src/worker/request-security";
import { PROJECT_ALPHA_PROJECT_BINDING_REFRESH_ROUTE } from "../src/worker/project-alpha-project-binding-refresh-routes";

const principal: StaffPrincipal = {
  id: "staff-admin", email: "admin@example.test", displayName: "Admin",
  accessSubject: "stable-access-subject", projectAlphaUserId: null,
};
const command = {
  sourceId: "project-alpha:primary",
  externalProjectId: "ops/project-acceptance",
  commandId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};
const executionCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function environment(overrides: Record<string, unknown> = {}) {
  return {
    ENVIRONMENT: "staging",
    EXPECTED_HOST: "ops-staging.example.test",
    OPERATIONS_ORIGINS: "https://ops-staging.example.test",
    OPERATIONS_SESSION_SECRET: "test-only-operations-session-secret-32-bytes",
    AUDIT_IP_SECRET: "test-only-audit-secret",
    PROJECT_ALPHA_PROJECT_BINDING_REFRESH_ENABLED: "true",
    OPS_DB: { batch: mocks.batch },
    ...overrides,
  } as unknown as Env;
}

async function send(env: Env, headers: Record<string, string> = {}) {
  const csrf = await csrfToken(env, principal);
  return worker.fetch(new Request(`https://ops-staging.example.test${PROJECT_ALPHA_PROJECT_BINDING_REFRESH_ROUTE}`, {
    method: "POST",
    headers: {
      Origin: "https://ops-staging.example.test",
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
      "Idempotency-Key": command.commandId,
      ...headers,
    },
    body: JSON.stringify(command),
  }), env, executionCtx);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateStaff.mockResolvedValue(principal);
  mocks.isAdministrator.mockResolvedValue(true);
  mocks.sqlScope.mockResolvedValue({ global: true, deniedGlobal: false });
  mocks.refresh.mockResolvedValue({ status: "acknowledged", receiptId: "synthetic-receipt", replayed: false, postStatusConfirmed: true });
  mocks.audit.mockResolvedValue({});
  mocks.batch.mockResolvedValue([]);
});

describe("Project Alpha project-binding refresh through the Operations Worker", () => {
  it("runs the real worker authentication and mutation middleware before refresh", async () => {
    const env = environment();
    const response = await send(env);
    expect(response.status).toBe(200);
    expect(mocks.authenticateStaff).toHaveBeenCalledOnce();
    expect(mocks.isAdministrator).toHaveBeenCalledOnce();
    expect(mocks.sqlScope).toHaveBeenCalledWith(env, principal, "integrations.manage");
    expect(mocks.refresh).toHaveBeenCalledWith(env, command);
    expect(mocks.batch).toHaveBeenCalledOnce();
  });

  it("rejects unauthenticated requests before checking authority or refreshing", async () => {
    mocks.authenticateStaff.mockRejectedValueOnce(new HTTPException(401, { message: "Authentication required" }));
    expect((await send(environment())).status).toBe(401);
    expect(mocks.isAdministrator).not.toHaveBeenCalled();
    expect(mocks.sqlScope).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("rejects non-administrators and deny-aware missing global integration authority", async () => {
    mocks.isAdministrator.mockResolvedValueOnce(false);
    expect((await send(environment())).status).toBe(403);
    expect(mocks.refresh).not.toHaveBeenCalled();

    mocks.sqlScope.mockResolvedValueOnce({ global: true, deniedGlobal: true });
    expect((await send(environment())).status).toBe(403);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("rejects invalid origin and CSRF before any binding or permission work", async () => {
    expect((await send(environment(), { Origin: "https://attacker.example.test" })).status).toBe(403);
    expect((await send(environment(), { "X-CSRF-Token": "invalid" })).status).toBe(403);
    expect(mocks.sqlScope).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("keeps the endpoint unavailable when the staging flag is off", async () => {
    expect((await send(environment({ PROJECT_ALPHA_PROJECT_BINDING_REFRESH_ENABLED: "false" }))).status).toBe(404);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("keeps the staging-only endpoint unavailable in production even if its flag drifts on", async () => {
    const env = environment({ ENVIRONMENT: "production", EXPECTED_HOST: "ops-staging.example.test",
      PROJECT_ALPHA_PROJECT_BINDING_REFRESH_ENABLED: "true" });
    expect((await send(env)).status).toBe(404);
    expect(mocks.authenticateStaff).toHaveBeenCalledOnce();
    expect(mocks.isAdministrator).toHaveBeenCalledOnce();
    expect(mocks.sqlScope).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.batch).not.toHaveBeenCalled();
  });
});
