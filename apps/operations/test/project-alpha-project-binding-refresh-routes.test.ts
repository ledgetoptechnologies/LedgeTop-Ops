import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), scope: vi.fn(), audit: vi.fn(), batch: vi.fn() }));
vi.mock("../src/worker/project-alpha-project-binding-revision-refresh", () => ({ refreshProjectAlphaProjectBinding: mocks.refresh }));
vi.mock("../src/worker/acl", () => ({ sqlScope: mocks.scope }));
vi.mock("../src/worker/request-security", () => ({ auditStatement: mocks.audit }));

import { PROJECT_ALPHA_PROJECT_BINDING_REFRESH_ROUTE, registerProjectAlphaProjectBindingRefreshRoutes } from "../src/worker/project-alpha-project-binding-refresh-routes";

const principal: StaffPrincipal = { id: "admin", email: "admin@example.test", displayName: "Admin", accessSubject: "subject", projectAlphaUserId: null };
const body = { sourceId: "project-alpha:primary", externalProjectId: "ops/project-1", commandId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };

function fixture(enabled = true, administrator = true) {
  const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  app.use("*", async (c, next) => { c.set("principal", principal); c.set("administrator", administrator); await next(); });
  registerProjectAlphaProjectBindingRefreshRoutes(app);
  const env = { ENVIRONMENT: "staging", PROJECT_ALPHA_PROJECT_BINDING_REFRESH_ENABLED: enabled ? "true" : "false", OPS_DB: { batch: mocks.batch } } as unknown as Env;
  return { env, send: (value = body, idempotency = body.commandId) => app.request(`https://ops.example.test${PROJECT_ALPHA_PROJECT_BINDING_REFRESH_ROUTE}`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency }, body: JSON.stringify(value),
  }, env) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue({ global: true, deniedGlobal: false });
  mocks.audit.mockResolvedValue({});
  mocks.batch.mockResolvedValue([]);
  mocks.refresh.mockResolvedValue({ status: "acknowledged", receiptId: "receipt", replayed: false, postStatusConfirmed: true });
});

describe("staging project binding refresh route", () => {
  it("is default-off before invoking the refresh service", async () => {
    expect((await fixture(false).send()).status).toBe(404);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("requires administrator and deny-aware global integration authority", async () => {
    expect((await fixture(true, false).send()).status).toBe(403);
    mocks.scope.mockResolvedValueOnce({ global: true, deniedGlobal: true });
    expect((await fixture().send()).status).toBe(403);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("requires the exact idempotency key and forwards only explicit selection", async () => {
    expect((await fixture().send(body, "other-command")).status).toBe(400);
    expect(mocks.refresh).not.toHaveBeenCalled();
    const response = await fixture().send();
    expect(response.status).toBe(200);
    expect(mocks.refresh).toHaveBeenCalledWith(expect.anything(), body);
    expect(JSON.stringify(mocks.refresh.mock.calls)).not.toContain("apiKey");
  });
});
