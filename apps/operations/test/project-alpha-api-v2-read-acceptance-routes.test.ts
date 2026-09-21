import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  configured: vi.fn(),
  probe: vi.fn(),
  directory: vi.fn(),
  projects: vi.fn(),
  audit: vi.fn(),
  batch: vi.fn(),
}));

vi.mock("../src/worker/acl", () => ({ sqlScope: mocks.scope }));
vi.mock("../src/worker/project-alpha-api-v2-connections", () => ({
  withEnabledConfiguredProjectAlphaApiV2Connection: mocks.configured,
}));
vi.mock("../src/worker/project-alpha-api-v2", () => ({ probeProjectAlphaApiV2: mocks.probe }));
vi.mock("../src/worker/project-alpha-directory-command-api-v2", () => ({
  PROJECT_ALPHA_DIRECTORY_INVENTORY_ENDPOINT: { method: "GET", path: "/api/v2/directory/inventory", requiredCapability: "directory.inventory.read" },
  readProjectAlphaDirectoryInventory: mocks.directory,
}));
vi.mock("../src/worker/project-alpha-project-inventory-api-v2", () => ({
  PROJECT_ALPHA_PROJECT_INVENTORY_ENDPOINT: { method: "GET", path: "/api/v2/projects/inventory", requiredCapability: "projects.inventory.read" },
  readProjectAlphaProjectInventory: mocks.projects,
}));
vi.mock("../src/worker/request-security", () => ({ auditStatement: mocks.audit }));

import {
  PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ROUTE,
  registerProjectAlphaApiV2ReadAcceptanceRoutes,
} from "../src/worker/project-alpha-api-v2-read-acceptance-routes";

const principal: StaffPrincipal = {
  id: "admin", email: "admin@example.test", displayName: "Administrator",
  accessSubject: "access-subject", projectAlphaUserId: null,
};
const sourceId = "project-alpha:primary";
const sourceInstanceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const applicationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const historyEpoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function fixture(enabled = true, administrator = true) {
  const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  app.use("*", async (c, next) => {
    c.set("principal", principal);
    c.set("administrator", administrator);
    await next();
  });
  registerProjectAlphaApiV2ReadAcceptanceRoutes(app);
  const env = {
    PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ENABLED: enabled ? "true" : "false",
    OPS_DB: { batch: mocks.batch }, AUDIT_IP_SECRET: "audit-secret",
  } as unknown as Env;
  const send = (body: unknown = { sourceId }) => app.request(
    `https://ops.example.test${PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ROUTE}`,
    { method: "POST", headers: { Origin: "https://ops.example.test", "Content-Type": "application/json", "X-CSRF-Token": "middleware-tested" }, body: JSON.stringify(body) }, env);
  return { app, env, send };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue({ global: true, deniedGlobal: false });
  mocks.configured.mockImplementation(async (_env, _source, callback) => ({ status: "enabled", value: await callback({
    baseUrl: "https://private-pa.example.test", apiKey: "server-only-api-key",
    expectedSourceInstanceId: sourceInstanceId, expectedApplicationId: applicationId, expectedHistoryEpoch: historyEpoch,
  }) }));
  mocks.probe.mockResolvedValue({ status: "verified", sourceInstanceId, applicationId, historyEpoch, requestId,
    grantedCapabilities: ["api.capabilities.read", "directory.inventory.read", "projects.inventory.read"] });
  mocks.directory.mockResolvedValue({ status: "observed", inventory: {
    sourceId, sourceInstanceId, applicationId, historyEpoch, requestId,
    authorizationGeneration: "9", nextCursor: null, resources: [{ type: "organization", publicId: "e".repeat(32),
      revision: "4", present: true, lastAction: "upsert", projectionSha256: "f".repeat(64),
      binding: { externalId: "private-customer-record", status: "active", resourceRevision: "4" } }],
  } });
  mocks.projects.mockResolvedValue({ status: "observed", httpStatus: 200, response: {
    apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId,
    authorizationGeneration: "12", nextCursor: null, projects: [{ externalId: "private-project-record",
      publicId: "a".repeat(32), revision: "2", projectionSha256: "b".repeat(64), status: "active", archived: false }],
  } });
  mocks.audit.mockResolvedValue({});
  mocks.batch.mockResolvedValue([]);
});

describe("Project Alpha API-v2 read acceptance route", () => {
  it("is default-off before configuration or remote reads", async () => {
    expect((await fixture(false).send()).status).toBe(404);
    expect(mocks.configured).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.directory).not.toHaveBeenCalled();
    expect(mocks.projects).not.toHaveBeenCalled();
  });

  it("requires an administrator and deny-aware global integrations.manage", async () => {
    expect((await fixture(true, false).send()).status).toBe(403);
    mocks.scope.mockResolvedValueOnce({ global: true, deniedGlobal: true });
    expect((await fixture().send()).status).toBe(403);
    expect(mocks.configured).not.toHaveBeenCalled();
  });

  it("accepts only an explicitly selected source and runs capabilities before both inventories", async () => {
    const response = await fixture().send();
    expect(response.status).toBe(200);
    expect(mocks.configured).toHaveBeenCalledWith(expect.anything(), sourceId, expect.any(Function));
    expect(mocks.probe).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "server-only-api-key" }), [], fetch,
      expect.arrayContaining([
        expect.objectContaining({ method: "GET", path: "/api/v2/directory/inventory", requiredCapability: "directory.inventory.read" }),
        expect.objectContaining({ method: "GET", path: "/api/v2/projects/inventory", requiredCapability: "projects.inventory.read" }),
      ]));
    expect(mocks.probe.mock.invocationCallOrder[0]).toBeLessThan(mocks.directory.mock.invocationCallOrder[0]!);
    expect(mocks.probe.mock.invocationCallOrder[0]).toBeLessThan(mocks.projects.mock.invocationCallOrder[0]!);
    expect(mocks.directory).toHaveBeenCalledWith(expect.anything(), sourceId, { type: "all", limit: 200 }, fetch);
    expect(mocks.projects).toHaveBeenCalledWith(expect.anything(), { limit: 200 }, fetch);
  });

  it("returns only safe status, request IDs, counts, hashes, and identity/contract matches", async () => {
    const body = await (await fixture().send()).json() as Record<string, any>;
    expect(body).toMatchObject({ sourceId, readOnly: true,
      capabilities: { status: "verified", requestId, sourceInstanceId, applicationId, historyEpoch,
        capabilityCount: 3, exactIdentityMatch: true, exactContractMatch: true },
      directory: { status: "observed", requestId, authorizationGeneration: "9", count: 1, hasMore: false,
        metadataSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      projects: { status: "observed", requestId, authorizationGeneration: "12", count: 1, hasMore: false,
        metadataSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    const serialized = JSON.stringify(body);
    for (const privateValue of ["server-only-api-key", "private-pa.example.test", "private-customer-record", "private-project-record", "e".repeat(32), "a".repeat(32)])
      expect(serialized).not.toContain(privateValue);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.anything(), principal,
      "integration.project_alpha_api_v2_read_acceptance_completed", "project_alpha_api_v2_read_acceptance", sourceId,
      null, expect.objectContaining({ readOnly: true }));
  });

  it("does not run inventories after a failed capabilities contract", async () => {
    mocks.probe.mockResolvedValueOnce({ status: "unauthorized", reason: "missing_capability", httpStatus: 403, requestId });
    const body = await (await fixture().send()).json() as Record<string, any>;
    expect(body.capabilities).toEqual({ status: "unauthorized", reason: "missing_capability", httpStatus: 403,
      requestId, exactIdentityMatch: false, exactContractMatch: false });
    expect(body.directory).toEqual({ status: "not_attempted", reason: "capabilities" });
    expect(body.projects).toEqual({ status: "not_attempted", reason: "capabilities" });
    expect(mocks.directory).not.toHaveBeenCalled();
    expect(mocks.projects).not.toHaveBeenCalled();
  });

  it("rejects unknown body members and reports a disabled selected deployment connection without secrets", async () => {
    expect((await fixture().send({ sourceId, apiKey: "browser-supplied-secret" })).status).toBe(400);
    mocks.configured.mockResolvedValueOnce({ status: "disabled", sourceId });
    const body = await (await fixture().send()).json() as Record<string, any>;
    expect(body).toMatchObject({ capabilities: { status: "disabled", exactIdentityMatch: false, exactContractMatch: false },
      directory: { status: "not_attempted", reason: "connection" }, projects: { status: "not_attempted", reason: "connection" } });
    expect(JSON.stringify(body)).not.toContain("browser-supplied-secret");
  });

  it("is mounted after the normal authenticated mutation middleware, which supplies origin and CSRF enforcement", () => {
    const source = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
    const mutation = source.indexOf('app.use("/api/*"');
    const csrf = source.indexOf("await requireMutationSecurity", mutation);
    const route = source.indexOf("registerProjectAlphaApiV2ReadAcceptanceRoutes(app)");
    expect(mutation).toBeGreaterThanOrEqual(0);
    expect(csrf).toBeGreaterThan(mutation);
    expect(route).toBeGreaterThan(csrf);
  });
});
