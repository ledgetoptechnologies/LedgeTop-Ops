import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  boundStaff: vi.fn(),
  genericStaff: vi.fn(),
  rate: vi.fn(),
  permissions: vi.fn(),
  createGrant: vi.fn(),
  units: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {},
  WorkerEntrypoint: class {},
  DurableObject: class {},
}));
vi.mock("../src/worker/auth", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/auth")>(),
  authenticateBoundStaffForViewerRenewal: mocks.boundStaff,
  authenticateStaff: mocks.genericStaff,
}));
vi.mock("../src/worker/native-staff-onboarding-rate-limit", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/native-staff-onboarding-rate-limit")>(),
  consumeNativeStaffOnboardingRateLimit: mocks.rate,
}));
vi.mock("../src/worker/viewer-processing", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/viewer-processing")>(),
  viewerAdminPermissions: mocks.permissions,
  viewerProcessingEnabled: (env: { VIEWER_INTEGRATION_ENABLED?: string; VIEWER_PROCESSING_ENABLED?: string }) =>
    env.VIEWER_INTEGRATION_ENABLED === "true" && env.VIEWER_PROCESSING_ENABLED === "true",
}));
vi.mock("../src/worker/viewer-integration", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/viewer-integration")>(),
  viewerServiceClient: () => ({ createAdminGrant: mocks.createGrant }),
}));
vi.mock("../src/worker/viewer-units", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/viewer-units")>(),
  resolveViewerUnits: mocks.units,
}));

import worker from "../src/worker/index";
import type { Env } from "../src/worker/types";

const opsOrigin = "https://ops-staging.ledgetopdroneservices.com";
const viewerOrigin = "https://viewer-staging.ledgetopdroneservices.com";
const requestPath = "/api/viewer/workspace/session-renewal";
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const env = {
  ENVIRONMENT: "staging",
  EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com",
  OPERATIONS_ORIGINS: opsOrigin,
  VIEWER_BASE_URL: viewerOrigin,
  VIEWER_INTEGRATION_ENABLED: "true",
  VIEWER_PROCESSING_ENABLED: "true",
  VIEWER_WORKSPACE_RENEWAL_CORS_ENABLED: "true",
  OPERATIONS_SESSION_SECRET: "test-secret-that-is-at-least-thirty-two-characters-long",
  OPS_DB: {} as D1Database,
} as Env;

function request(path: string, init: RequestInit = {}, origin = viewerOrigin): Request {
  return new Request(`${opsOrigin}${path}`, {
    ...init,
    headers: { Origin: origin, ...(init.headers as Record<string, string> || {}) },
  });
}

describe("Viewer workspace renewal Worker routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.boundStaff.mockResolvedValue({
      principal: { id: "staff-owner-1", accessSubject: "access-subject-1" },
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    mocks.genericStaff.mockRejectedValue(new Error("generic same-origin auth must not handle renewal requests"));
    mocks.rate.mockResolvedValue(true);
    mocks.permissions.mockResolvedValue(["viewer.projects.read"]);
    mocks.createGrant.mockResolvedValue({
      grant: "one-use-grant-token-1234567890",
      grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      sessionTtlSeconds: 600,
      redeemUrl: `${viewerOrigin}/api/v1/admin-sessions/redeem`,
    });
    mocks.units.mockResolvedValue("imperial");
  });

  it("routes a credentialed preflight to the exact-origin renewal handler before generic API auth", async () => {
    const response = await worker.fetch(request(requestPath, {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,idempotency-key,x-csrf-token",
      },
    }), env, context);

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(viewerOrigin);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(mocks.genericStaff).not.toHaveBeenCalled();
    expect(mocks.boundStaff).not.toHaveBeenCalled();

    const rejected = await worker.fetch(request(requestPath, {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,idempotency-key,x-csrf-token",
      },
    }, "https://attacker.example"), env, context);
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(mocks.genericStaff).not.toHaveBeenCalled();
  });

  it("keeps the registered route default-off before either authentication path", async () => {
    const response = await worker.fetch(request(`${requestPath}/challenge`), {
      ...env,
      VIEWER_WORKSPACE_RENEWAL_CORS_ENABLED: "false",
    }, context);

    expect(response.status).toBe(404);
    expect(mocks.boundStaff).not.toHaveBeenCalled();
    expect(mocks.genericStaff).not.toHaveBeenCalled();
  });

  it("cannot enable renewal outside staging even if the feature flag is misconfigured", async () => {
    const response = await worker.fetch(request(requestPath), {
      ...env,
      ENVIRONMENT: "production",
      VIEWER_WORKSPACE_RENEWAL_CORS_ENABLED: "true",
    }, context);

    expect(response.status).toBe(404);
    expect(mocks.boundStaff).not.toHaveBeenCalled();
    expect(mocks.genericStaff).not.toHaveBeenCalled();
  });

  it("rejects unexpected preflight methods and requested headers", async () => {
    const cases: Array<[string, string]> = [
      ["GET", "content-type,idempotency-key,x-csrf-token"],
      ["POST", "content-type,idempotency-key,x-csrf-token,x-admin-override"],
    ];
    for (const [method, headers] of cases) {
      const response = await worker.fetch(request(requestPath, {
        method: "OPTIONS",
        headers: {
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": headers,
        },
      }), env, context);
      expect(response.status).toBe(403);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(viewerOrigin);
    }
    expect(mocks.boundStaff).not.toHaveBeenCalled();
  });

  it("completes challenge and grant issuance through the deployed Worker route graph", async () => {
    const challengeResponse = await worker.fetch(request(`${requestPath}/challenge`), env, context);
    expect(challengeResponse.status).toBe(200);
    const challenge = await challengeResponse.json() as { challenge: string };
    const requestId = crypto.randomUUID();
    const sessionId = "viewer-session-correlation-01";
    const response = await worker.fetch(request(requestPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": requestId,
        "X-CSRF-Token": challenge.challenge,
      },
      body: JSON.stringify({ protocolVersion: 1, requestId, sessionId, subject: "ops:staff-owner-1" }),
    }), env, context);

    expect(response.status).toBe(201);
    expect(mocks.boundStaff).toHaveBeenCalledTimes(2);
    expect(mocks.genericStaff).not.toHaveBeenCalled();
    expect(mocks.createGrant).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ protocolVersion: 1, requestId, sessionId });
  });
});
