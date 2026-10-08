import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  configured: vi.fn(),
  sourceIds: vi.fn(),
  probe: vi.fn(),
  directory: vi.fn(),
  projects: vi.fn(),
  catalog: vi.fn(),
  audit: vi.fn(),
  batch: vi.fn(),
}));

vi.mock("../src/worker/acl", () => ({ sqlScope: mocks.scope }));
vi.mock("../src/worker/project-alpha-api-v2-connections", () => ({
  listEnabledProjectAlphaApiV2SourceIds: mocks.sourceIds,
  withEnabledConfiguredProjectAlphaApiV2Connection: mocks.configured,
}));
vi.mock("../src/worker/project-alpha-api-v2", () => ({ probeProjectAlphaApiV2: mocks.probe }));
vi.mock("../src/worker/project-alpha-directory-command-api-v2", () => ({
  PROJECT_ALPHA_DIRECTORY_INVENTORY_ENDPOINT: { method: "GET", path: "/api/v2/directory/inventory", requiredCapability: "directory.inventory.read" },
  readProjectAlphaDirectoryInventoryAfterVerifiedCapabilities: mocks.directory,
}));
vi.mock("../src/worker/project-alpha-project-inventory-api-v2", () => ({
  PROJECT_ALPHA_PROJECT_INVENTORY_ENDPOINT: { method: "GET", path: "/api/v2/projects/inventory", requiredCapability: "projects.inventory.read" },
  readProjectAlphaProjectInventoryAfterVerifiedCapabilities: mocks.projects,
}));
vi.mock("../src/worker/project-alpha-catalog-inventory-api-v2", () => ({
  PROJECT_ALPHA_CATALOG_INVENTORY_ENDPOINT: { method: "GET", path: "/api/v2/catalog/inventory", requiredCapability: "catalog.inventory.read" },
  readProjectAlphaCatalogInventoryAfterVerifiedCapabilities: mocks.catalog,
}));
vi.mock("../src/worker/request-security", () => ({ auditStatement: mocks.audit }));

import {
  PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ROUTE,
  PROJECT_ALPHA_API_V2_SOURCES_ROUTE,
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
  mocks.sourceIds.mockReturnValue(["project-alpha:primary", "project-alpha:staging"]);
  mocks.probe.mockResolvedValue({ status: "verified", sourceInstanceId, applicationId, historyEpoch, requestId,
    grantedCapabilities: ["api.capabilities.read", "directory.inventory.read", "projects.inventory.read", "catalog.inventory.read"] });
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
  mocks.catalog.mockResolvedValue({ status: "observed", httpStatus: 200, response: {
    apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId,
    snapshotId: "c".repeat(64), totalCount: 1, items: [{ opaque: true }], nextCursor: null,
  } });
  mocks.audit.mockResolvedValue({});
  mocks.batch.mockResolvedValue([]);
});

describe("Project Alpha API-v2 read acceptance route", () => {
  it("lists only credential-free enabled source IDs for a globally authorized administrator", async () => {
    const { app, env } = fixture();
    const response = await app.request(`https://ops.example.test${PROJECT_ALPHA_API_V2_SOURCES_ROUTE}`, { method: "GET" }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ sources: ["project-alpha:primary", "project-alpha:staging"], stagingDirectoryOwnerViewGrantEnabled: false });
    expect(JSON.stringify(body)).not.toContain("apiKey");
    expect(JSON.stringify(body)).not.toContain("private-pa");
  });

  it("hides source discovery when disabled and denies non-admin or denied scope", async () => {
    const disabled = fixture(false);
    expect((await disabled.app.request(`https://ops.example.test${PROJECT_ALPHA_API_V2_SOURCES_ROUTE}`, { method: "GET" }, disabled.env)).status).toBe(404);
    expect(mocks.sourceIds).not.toHaveBeenCalled();

    const notAdmin = fixture(true, false);
    expect((await notAdmin.app.request(`https://ops.example.test${PROJECT_ALPHA_API_V2_SOURCES_ROUTE}`, { method: "GET" }, notAdmin.env)).status).toBe(403);
    mocks.scope.mockResolvedValueOnce({ global: false, deniedGlobal: false });
    const denied = fixture();
    expect((await denied.app.request(`https://ops.example.test${PROJECT_ALPHA_API_V2_SOURCES_ROUTE}`, { method: "GET" }, denied.env)).status).toBe(403);
  });

  it("is default-off before configuration or remote reads", async () => {
    expect((await fixture(false).send()).status).toBe(404);
    expect(mocks.configured).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.directory).not.toHaveBeenCalled();
    expect(mocks.projects).not.toHaveBeenCalled();
    expect(mocks.catalog).not.toHaveBeenCalled();
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
    expect(mocks.probe).toHaveBeenNthCalledWith(2, expect.objectContaining({ apiKey: "server-only-api-key" }), [], fetch,
      [expect.objectContaining({ method: "GET", path: "/api/v2/catalog/inventory", requiredCapability: "catalog.inventory.read" })]);
    expect(mocks.probe.mock.invocationCallOrder[0]).toBeLessThan(mocks.directory.mock.invocationCallOrder[0]!);
    expect(mocks.probe.mock.invocationCallOrder[0]).toBeLessThan(mocks.projects.mock.invocationCallOrder[0]!);
    expect(mocks.probe.mock.invocationCallOrder[0]).toBeLessThan(mocks.catalog.mock.invocationCallOrder[0]!);
    expect(mocks.directory).toHaveBeenCalledWith(expect.anything(), sourceId, { type: "all", limit: 200 }, fetch);
    expect(mocks.projects).toHaveBeenCalledWith(expect.anything(), { limit: 200 }, fetch);
    expect(mocks.catalog).toHaveBeenCalledWith(expect.anything(), { limit: 200 }, fetch);
  });

  it("returns only safe status, request IDs, counts, hashes, and identity/contract matches", async () => {
    const body = await (await fixture().send()).json() as Record<string, any>;
    expect(body).toMatchObject({ sourceId, readOnly: true,
      capabilities: { status: "verified", requestId, sourceInstanceId, applicationId, historyEpoch,
        capabilityCount: 4, exactIdentityMatch: true, exactContractMatch: true },
      directory: { status: "observed", requestId, authorizationGeneration: "9", count: 1, hasMore: false,
        metadataSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      projects: { status: "observed", requestId, authorizationGeneration: "12", count: 1, hasMore: false,
        metadataSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      catalog: { status: "observed", requestId, snapshotId: "c".repeat(64), totalCount: 1, pageCount: 1,
        hasMore: false, envelopeSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      clientWrites: { meaning: "advertised_prerequisites_only",
        create: { status: "advertised", exactIdentityMatch: true, exactContractMatch: true },
        profileWrite: { status: "advertised", exactIdentityMatch: true, exactContractMatch: true } },
    });
    const serialized = JSON.stringify(body);
    for (const privateValue of ["server-only-api-key", "private-pa.example.test", "private-customer-record", "private-project-record", "e".repeat(32), "a".repeat(32)])
      expect(serialized).not.toContain(privateValue);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.anything(), principal,
      "integration.project_alpha_api_v2_read_acceptance_completed", "project_alpha_api_v2_read_acceptance", sourceId,
      null, expect.objectContaining({ readOnly: true }));
  });

  it("checks client create and profile-write advertisements through capabilities probes only", async () => {
    await fixture().send();
    expect(mocks.probe).toHaveBeenNthCalledWith(3, expect.objectContaining({ apiKey: "server-only-api-key" }), [], fetch, [{
      method: "POST", path: "/api/v2/directory/clients/commands", requiredCapability: "directory.clients.create",
      requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true,
    }], ["directory.clients.create"]);
    expect(mocks.probe).toHaveBeenNthCalledWith(4, expect.objectContaining({ apiKey: "server-only-api-key" }), [], fetch, [{
      method: "POST", path: "/api/v2/directory/clients/{publicId}/profile/commands", requiredCapability: "directory.clients.write",
      requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true,
    }], ["directory.clients.write"]);
    expect(mocks.configured).toHaveBeenCalledTimes(1);
  });

  it("reports missing endpoint or granted capability per action without exposing capability names", async () => {
    mocks.probe
      .mockResolvedValueOnce({ status: "verified", sourceInstanceId, applicationId, historyEpoch, requestId,
        grantedCapabilities: ["api.capabilities.read", "directory.inventory.read", "projects.inventory.read"] })
      .mockResolvedValueOnce({ status: "verified", sourceInstanceId, applicationId, historyEpoch, requestId,
        grantedCapabilities: ["api.capabilities.read", "catalog.inventory.read"] })
      .mockResolvedValueOnce({ status: "incompatible", reason: "missing_endpoint", requestId })
      .mockResolvedValueOnce({ status: "unauthorized", reason: "missing_capability", requestId });
    const body = await (await fixture().send()).json() as Record<string, any>;
    expect(body.clientWrites).toEqual({ meaning: "advertised_prerequisites_only",
      create: { status: "unavailable", reason: "missing_endpoint", exactIdentityMatch: false, exactContractMatch: false },
      profileWrite: { status: "unavailable", reason: "missing_capability", exactIdentityMatch: false, exactContractMatch: false } });
    expect(JSON.stringify(body.clientWrites)).not.toContain("directory.clients");
  });

  it("fails advertised write readiness closed on exact connection identity mismatches", async () => {
    mocks.probe
      .mockResolvedValueOnce({ status: "verified", sourceInstanceId, applicationId, historyEpoch, requestId, grantedCapabilities: [] })
      .mockResolvedValueOnce({ status: "verified", sourceInstanceId, applicationId, historyEpoch, requestId, grantedCapabilities: [] })
      .mockResolvedValueOnce({ status: "incompatible", reason: "source_mismatch", requestId })
      .mockResolvedValueOnce({ status: "incompatible", reason: "application_mismatch", requestId });
    const body = await (await fixture().send()).json() as Record<string, any>;
    expect(body.clientWrites.create).toMatchObject({ status: "unavailable", reason: "source_mismatch", exactIdentityMatch: false });
    expect(body.clientWrites.profileWrite).toMatchObject({ status: "unavailable", reason: "application_mismatch", exactIdentityMatch: false });
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
    expect(mocks.catalog).not.toHaveBeenCalled();
  });

  it("keeps established inventories diagnostic when the additive catalog endpoint is unavailable", async () => {
    mocks.probe.mockResolvedValueOnce({ status: "verified", sourceInstanceId, applicationId, historyEpoch, requestId,
      grantedCapabilities: ["api.capabilities.read", "directory.inventory.read", "projects.inventory.read"] });
    mocks.probe.mockResolvedValueOnce({ status: "incompatible", reason: "missing_endpoint", httpStatus: 404, requestId });
    const body = await (await fixture().send()).json() as Record<string, any>;
    expect(body.directory.status).toBe("observed");
    expect(body.projects.status).toBe("observed");
    expect(body.catalog).toEqual({ status: "not_attempted", reason: "capabilities", capability: {
      status: "incompatible", reason: "missing_endpoint", httpStatus: 404, requestId,
      exactIdentityMatch: false, exactContractMatch: false,
    } });
    expect(mocks.catalog).not.toHaveBeenCalled();
  });

  it("rejects unknown body members and reports a disabled selected deployment connection without secrets", async () => {
    expect((await fixture().send({ sourceId, apiKey: "browser-supplied-secret" })).status).toBe(400);
    mocks.configured.mockResolvedValueOnce({ status: "disabled", sourceId });
    const body = await (await fixture().send()).json() as Record<string, any>;
    expect(body).toMatchObject({ capabilities: { status: "disabled", exactIdentityMatch: false, exactContractMatch: false },
      directory: { status: "not_attempted", reason: "connection" }, projects: { status: "not_attempted", reason: "connection" }, catalog: { status: "not_attempted", reason: "connection" } });
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
