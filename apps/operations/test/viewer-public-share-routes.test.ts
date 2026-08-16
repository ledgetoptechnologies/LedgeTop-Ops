import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateStaff: vi.fn(),
  isAdministrator: vi.fn(),
  sqlScope: vi.fn(),
  requireMutationSecurity: vi.fn(),
  auditStatement: vi.fn(),
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
vi.mock("../src/worker/request-security", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/request-security")>(),
  requireMutationSecurity: mocks.requireMutationSecurity,
  auditStatement: mocks.auditStatement,
}));

import worker from "../src/worker/index";

const principal = {
  id: "staff-one", email: "staff@example.test", displayName: "Staff One",
  accessSubject: "access-staff-one", projectAlphaUserId: null,
};
const executionCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const model = {
  id: "model-one", title: "Survey model", provider: "webodm", status: "ready", available: true,
  activeVersion: {
    id: "version-one", providerVersionId: "provider-version-one",
    createdAt: "2026-08-16T12:00:00.000Z", updatedAt: "2026-08-16T12:00:00.000Z",
  },
  updatedAt: "2026-08-16T12:00:00.000Z",
};
const share = {
  id: "share-one", modelId: "model-one", versionPolicy: "latest", modelVersionId: null,
  hasPassword: true, permissions: { view: true, measure: true, cameras: true, download: false },
  label: "Client demo", createdBy: "ops:staff-one",
  createdAt: "2026-08-16T12:00:00.000Z", updatedAt: "2026-08-16T12:00:00.000Z",
  expiresAt: "2026-08-23T12:00:00.000Z", revokedAt: null, revokedBy: null, revokeReason: null,
  accessCount: 0, lastAccessedAt: null,
};

function environment(publicSharesEnabled = true) {
  const batches: unknown[][] = [];
  return {
    EXPECTED_HOST: "ops.example.test",
    PUBLIC_BASE_URL: "https://ops.example.test",
    INCOMING_EXPECTED_HOST: "incoming.example.test",
    INCOMING_BASE_URL: "https://incoming.example.test",
    ENVIRONMENT: "development",
    VIEWER_INTEGRATION_ENABLED: "true",
    VIEWER_PUBLIC_SHARES_ENABLED: publicSharesEnabled ? "true" : "false",
    VIEWER_BASE_URL: "https://viewer.example.test",
    VIEWER_SERVICE_KEY_ID: "ops-v1",
    VIEWER_SERVICE_HMAC_SECRET: "viewer-shared-secret-32-characters-minimum",
    OPS_DB: { async batch(statements: unknown[]) { batches.push(statements); return []; } },
    batches,
  };
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://ops.example.test${path}`, {
    ...init,
    headers: { Origin: "https://ops.example.test", "Content-Type": "application/json", ...init.headers },
  });
}

describe("Operations Viewer public-share routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.authenticateStaff.mockReset().mockResolvedValue(principal);
    mocks.isAdministrator.mockReset().mockResolvedValue(false);
    mocks.sqlScope.mockReset().mockResolvedValue({
      global: true, deniedGlobal: false, divisions: [], assigned: false, own: false, deniedDivisions: [],
    });
    mocks.requireMutationSecurity.mockReset().mockResolvedValue(undefined);
    mocks.auditStatement.mockReset().mockResolvedValue({ audit: true });
  });

  it("lists only metadata with viewer.view and never returns a bearer URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ shares: [share] })));
    const response = await worker.fetch(
      request("/api/viewer/models/model-one/shares"), environment() as never, executionCtx,
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({ shares: [share] });
    expect(mocks.sqlScope).toHaveBeenCalledWith(expect.anything(), principal, "viewer.view");
    expect(mocks.requireMutationSecurity).not.toHaveBeenCalled();
    expect(JSON.stringify(payload)).not.toContain("viewUrl");
  });

  it("creates an expiring optional-password link with exact permission, CSRF, idempotency, and audit", async () => {
    const outbound = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/models") return Response.json({ models: [model] });
      expect(url.pathname).toBe("/api/v1/models/model-one/shares");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ "Idempotency-Key": "viewer-public-share-create-0001" });
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        createdBy: "ops:staff-one", label: "Client demo", password: "strong-demo-password",
        permissions: { view: true, measure: true, cameras: true, download: false },
      });
      return Response.json({
        share: { ...share, expiresAt: body.expiresAt },
        token: "a-secure-token-that-is-never-listed",
        viewUrl: "https://viewer.example.test/view/a-secure-token-that-is-never-listed",
        embedUrl: "https://viewer.example.test/embed/a-secure-token-that-is-never-listed",
      }, { status: 201 });
    });
    vi.stubGlobal("fetch", outbound);
    const env = environment();
    const response = await worker.fetch(request("/api/viewer/models/model-one/shares", {
      method: "POST",
      headers: { "Idempotency-Key": "viewer-public-share-create-0001" },
      body: JSON.stringify({
        label: "Client demo", expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        password: "strong-demo-password",
        permissions: { view: true, measure: true, cameras: true, download: false },
      }),
    }), env as never, executionCtx);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      share: { ...share, expiresAt: expect.any(String) },
      viewUrl: "https://viewer.example.test/view/a-secure-token-that-is-never-listed",
    });
    expect(mocks.sqlScope).toHaveBeenCalledWith(expect.anything(), principal, "viewer.share.create");
    expect(mocks.requireMutationSecurity).toHaveBeenCalledOnce();
    expect(mocks.auditStatement).toHaveBeenCalledWith(
      expect.anything(), expect.any(Request), principal, "viewer.share.created", "viewer_public_share", "share-one", null,
      expect.objectContaining({ passwordProtected: true, viewerModelId: "model-one" }),
    );
    expect(env.batches).toHaveLength(1);
  });

  it("revokes with the distinct viewer.share.revoke permission", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ share: {
      ...share, revokedAt: new Date().toISOString(), revokedBy: "ops-v1", revokeReason: "Demo complete",
    } })));
    const env = environment();
    const response = await worker.fetch(request("/api/viewer/shares/share-one", {
      method: "DELETE", headers: { "Idempotency-Key": "viewer-public-share-revoke-0001" },
      body: JSON.stringify({ reason: "Demo complete" }),
    }), env as never, executionCtx);
    expect(response.status).toBe(200);
    expect(mocks.sqlScope).toHaveBeenCalledWith(expect.anything(), principal, "viewer.share.revoke");
    expect(mocks.requireMutationSecurity).toHaveBeenCalledOnce();
    expect(mocks.auditStatement).toHaveBeenCalledWith(
      expect.anything(), expect.any(Request), principal, "viewer.share.revoked", "viewer_public_share", "share-one", null,
      { viewerModelId: "model-one", reason: "Demo complete" },
    );
  });

  it("fails closed before contacting Viewer when the public-share gate or exact permission is absent", async () => {
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const disabled = await worker.fetch(request("/api/viewer/models/model-one/shares"), environment(false) as never, executionCtx);
    expect(disabled.status).toBe(404);
    expect(outbound).not.toHaveBeenCalled();

    mocks.sqlScope.mockResolvedValueOnce({
      global: false, deniedGlobal: false, divisions: [], assigned: false, own: false, deniedDivisions: [],
    });
    const denied = await worker.fetch(request("/api/viewer/models/model-one/shares", {
      method: "POST", headers: { "Idempotency-Key": "viewer-public-share-create-0002" },
      body: JSON.stringify({ expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }),
    }), environment() as never, executionCtx);
    expect(denied.status).toBe(403);
    expect(outbound).not.toHaveBeenCalled();
  });

  it("preserves Viewer idempotency conflicts and does not write a misleading audit event", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/models") return Response.json({ models: [model] });
      return Response.json({ error: "Idempotency-Key was already used for a different request" }, { status: 409 });
    }));
    const env = environment();
    const response = await worker.fetch(request("/api/viewer/models/model-one/shares", {
      method: "POST",
      headers: { "Idempotency-Key": "viewer-public-share-conflict-0001" },
      body: JSON.stringify({ expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }),
    }), env as never, executionCtx);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "3D Viewer request conflicts with an earlier request" });
    expect(mocks.auditStatement).not.toHaveBeenCalled();
    expect(env.batches).toHaveLength(0);
  });
});
