import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateStaff: vi.fn(),
  isAdministrator: vi.fn(),
  sqlScope: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {},
}));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
vi.mock("../src/worker/acl", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/acl")>(),
  isAdministrator: mocks.isAdministrator,
  sqlScope: mocks.sqlScope,
}));

import worker from "../src/worker/index";

const principal = {
  id: "staff-one", email: "staff@example.test", displayName: "Staff One",
  accessSubject: "access-staff-one", projectAlphaUserId: null,
};
const executionCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function environment(configured = true) {
  return {
    EXPECTED_HOST: "ops.example.test",
    PUBLIC_BASE_URL: "https://ops.example.test",
    INCOMING_EXPECTED_HOST: "incoming.example.test",
    INCOMING_BASE_URL: "https://incoming.example.test",
    ENVIRONMENT: "development",
    VIEWER_INTEGRATION_ENABLED: "false",
    VIEWER_BASE_URL: configured ? "https://viewer.example.test" : "",
    VIEWER_SERVICE_KEY_ID: configured ? "ops-v1" : "",
    VIEWER_SERVICE_HMAC_SECRET: configured ? "viewer-shared-secret-32-characters-minimum" : "",
  };
}

function request(): Request {
  return new Request("https://ops.example.test/api/viewer/connection-preflight");
}

describe("Operations Viewer connection preflight", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.authenticateStaff.mockReset().mockResolvedValue(principal);
    mocks.isAdministrator.mockReset().mockResolvedValue(false);
    mocks.sqlScope.mockReset().mockResolvedValue({
      global: true, deniedGlobal: false, divisions: [], assigned: false, own: false, deniedDivisions: [],
    });
  });

  it("tests disabled Viewer configuration, public probes, and signed service auth without exposing details", async () => {
    const outbound = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/health") return Response.json({ ok: true });
      if (url.pathname === "/api/v1/ready") {
        return Response.json({ ok: false, missing: ["/private/server/path", "viewer database"] }, { status: 503 });
      }
      if (url.pathname === "/api/v1/models") {
        expect(init?.headers).toMatchObject({ "X-LTDS-Key-Id": "ops-v1" });
        return Response.json({ models: [{
          id: "model-secret-id", title: "Private survey", provider: "webodm", status: "ready", available: true,
          activeVersion: {
            id: "version-secret-id", providerVersionId: "provider-secret-id",
            createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z",
          },
          updatedAt: "2026-08-17T00:00:00.000Z",
        }] });
      }
      throw new Error(`unexpected Viewer request ${url.pathname}`);
    });
    vi.stubGlobal("fetch", outbound);

    const response = await worker.fetch(request(), environment() as never, executionCtx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const payload = await response.json();
    expect(payload).toEqual({
      integrationEnabled: false,
      configured: true,
      publicHealthReachable: true,
      publicHealthOk: true,
      publicReadyReachable: true,
      publicReady: false,
      readinessIssueCount: 2,
      serviceAuthReachable: true,
      modelCount: 1,
      readyModelCount: 1,
    });
    expect(JSON.stringify(payload)).not.toContain("model-secret-id");
    expect(JSON.stringify(payload)).not.toContain("private/server/path");
    expect(JSON.stringify(payload)).not.toContain("viewer-shared-secret");
    expect(mocks.sqlScope).toHaveBeenCalledWith(expect.anything(), principal, "viewer.manage");
    expect(outbound).toHaveBeenCalledTimes(3);
  });

  it("reports incomplete configuration without making an outbound request", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch(request(), environment(false) as never, executionCtx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      integrationEnabled: false,
      configured: false,
      publicHealthReachable: false,
      publicReadyReachable: false,
      serviceAuthReachable: false,
      modelCount: null,
      readyModelCount: null,
    });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("requires exact global viewer.manage before probing Viewer", async () => {
    mocks.sqlScope.mockResolvedValue({
      global: false, deniedGlobal: false, divisions: [], assigned: false, own: false, deniedDivisions: [],
    });
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const response = await worker.fetch(request(), environment() as never, executionCtx);
    expect(response.status).toBe(403);
    expect(outbound).not.toHaveBeenCalled();
    expect(mocks.sqlScope).toHaveBeenCalledWith(expect.anything(), principal, "viewer.manage");
  });
});
