import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  rate: vi.fn(),
  permissions: vi.fn(),
  serviceCreate: vi.fn(),
  units: vi.fn(),
}));

vi.mock("../src/worker/auth", () => ({ authenticateBoundStaffForViewerRenewal: mocks.authenticate }));
vi.mock("../src/worker/native-staff-onboarding-rate-limit", () => ({ consumeNativeStaffOnboardingRateLimit: mocks.rate }));
vi.mock("../src/worker/viewer-processing", () => ({
  viewerAdminPermissions: mocks.permissions,
  viewerProcessingEnabled: (env: { VIEWER_INTEGRATION_ENABLED?: string; VIEWER_PROCESSING_ENABLED?: string }) =>
    env.VIEWER_INTEGRATION_ENABLED === "true" && env.VIEWER_PROCESSING_ENABLED === "true",
}));
vi.mock("../src/worker/viewer-integration", () => ({
  viewerServiceClient: () => ({ createAdminGrant: mocks.serviceCreate }),
}));
vi.mock("../src/worker/viewer-units", () => ({ resolveViewerUnits: mocks.units }));

import { dispatchViewerWorkspaceRenewal } from "../src/worker/viewer-workspace-renewal";
import type { Env, StaffPrincipal } from "../src/worker/types";

const viewerOrigin = "https://viewer-staging.ledgetopdroneservices.com";
const opsOrigin = "https://ops-staging.ledgetopdroneservices.com";
const principal: StaffPrincipal = {
  id: "staff-owner-1", email: "owner@example.test", displayName: "Owner",
  accessSubject: "access-subject-1", projectAlphaUserId: null,
};
const env = {
  ENVIRONMENT: "staging", EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com",
  OPERATIONS_ORIGINS: opsOrigin, VIEWER_BASE_URL: viewerOrigin,
  VIEWER_INTEGRATION_ENABLED: "true", VIEWER_PROCESSING_ENABLED: "true",
  VIEWER_WORKSPACE_RENEWAL_CORS_ENABLED: "true", OPERATIONS_SESSION_SECRET: "test-secret-that-is-at-least-thirty-two-characters-long",
  OPS_DB: {} as D1Database,
} as Env;

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://${env.EXPECTED_HOST}${path}`, {
    ...init,
    headers: { Origin: viewerOrigin, ...(init.headers as Record<string, string> || {}) },
  });
}

describe("Viewer no-opener workspace renewal transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({ principal, expiresAt: Math.floor(Date.now() / 1000) + 600 });
    mocks.rate.mockResolvedValue(true);
    mocks.permissions.mockResolvedValue(["viewer.projects.read", "viewer.shares.create"]);
    mocks.units.mockResolvedValue("imperial");
    mocks.serviceCreate.mockResolvedValue({
      grant: "one-use-grant-token-1234567890", grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      sessionTtlSeconds: 600, redeemUrl: `${viewerOrigin}/api/v1/admin-sessions/redeem`,
    });
  });

  it("serves credentialed preflight only for the exact Viewer origin and allowed headers", async () => {
    const response = await dispatchViewerWorkspaceRenewal(request("/api/viewer/workspace/session-renewal", {
      method: "OPTIONS", headers: {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,idempotency-key,x-csrf-token",
      },
    }), env);
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(viewerOrigin);
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, Idempotency-Key, X-CSRF-Token");

    const rejected = await dispatchViewerWorkspaceRenewal(new Request(`https://${env.EXPECTED_HOST}/api/viewer/workspace/session-renewal`, {
      method: "OPTIONS", headers: {
        Origin: "https://attacker.example", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,idempotency-key,x-csrf-token",
      },
    }), env);
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it("issues a scoped challenge then an idempotent grant capped by Access expiry", async () => {
    const challengeResponse = await dispatchViewerWorkspaceRenewal(request("/api/viewer/workspace/session-renewal/challenge"), env);
    expect(challengeResponse.status).toBe(200);
    const challenge = await challengeResponse.json() as { protocolVersion: number; challenge: string; expiresAt: number };
    expect(challenge.protocolVersion).toBe(1);
    expect(challenge.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const requestId = crypto.randomUUID();
    const sessionId = "viewer-session-correlation-01";
    const response = await dispatchViewerWorkspaceRenewal(request("/api/viewer/workspace/session-renewal", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": requestId, "X-CSRF-Token": challenge.challenge },
      body: JSON.stringify({ protocolVersion: 1, requestId, sessionId, subject: `ops:${principal.id}` }),
    }), env);
    expect(response.status).toBe(201);
    expect(mocks.serviceCreate).toHaveBeenCalledOnce();
    const issued = mocks.serviceCreate.mock.calls[0]![0];
    expect(issued.subject).toBe(`ops:${principal.id}`);
    expect(issued.idempotencyKey).toBe(requestId);
    expect(Date.parse(issued.authorizationExpiresAt)).toBeLessThanOrEqual((Math.floor(Date.now() / 1000) + 600) * 1000);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toMatchObject({ protocolVersion: 1, requestId, sessionId, sessionTtlSeconds: 600 });
    expect(Object.keys(payload).sort()).toEqual(["grant", "grantExpiresAt", "protocolVersion", "redeemUrl", "requestId", "sessionId", "sessionTtlSeconds"]);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 15_000);
      const retry = await dispatchViewerWorkspaceRenewal(request("/api/viewer/workspace/session-renewal", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": requestId, "X-CSRF-Token": challenge.challenge },
        body: JSON.stringify({ protocolVersion: 1, requestId, sessionId, subject: `ops:${principal.id}` }),
      }), env);
      expect(retry.status).toBe(201);
      expect(await retry.json()).toMatchObject({ protocolVersion: 1, requestId, sessionId });
      expect(mocks.serviceCreate).toHaveBeenCalledTimes(2);
      expect(mocks.serviceCreate.mock.calls[1]![0]).toEqual(issued);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects subject substitution, stale CSRF, and unauthorized permissions before minting", async () => {
    const challengeResponse = await dispatchViewerWorkspaceRenewal(request("/api/viewer/workspace/session-renewal/challenge"), env);
    const challenge = await challengeResponse.json() as { challenge: string };
    const requestId = crypto.randomUUID();
    const forged = await dispatchViewerWorkspaceRenewal(request("/api/viewer/workspace/session-renewal", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestId, "X-CSRF-Token": challenge.challenge },
      body: JSON.stringify({ protocolVersion: 1, requestId, sessionId: "viewer-session-correlation-01", subject: "ops:someone-else" }),
    }), env);
    expect(forged.status).toBe(403);

    const stale = await dispatchViewerWorkspaceRenewal(request("/api/viewer/workspace/session-renewal", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestId, "X-CSRF-Token": "stale" },
      body: JSON.stringify({ protocolVersion: 1, requestId, sessionId: "viewer-session-correlation-01", subject: `ops:${principal.id}` }),
    }), env);
    expect(stale.status).toBe(403);

    mocks.permissions.mockResolvedValue([]);
    const response = await dispatchViewerWorkspaceRenewal(request("/api/viewer/workspace/session-renewal", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestId, "X-CSRF-Token": challenge.challenge },
      body: JSON.stringify({ protocolVersion: 1, requestId, sessionId: "viewer-session-correlation-01", subject: `ops:${principal.id}` }),
    }), env);
    expect(response.status).toBe(403);
    expect(mocks.serviceCreate).not.toHaveBeenCalled();
  });

  it("keeps the route absent by default and fails closed when the durable limiter is unavailable", async () => {
    const disabledEnv = { ...env, VIEWER_WORKSPACE_RENEWAL_CORS_ENABLED: undefined } as Env;
    expect((await dispatchViewerWorkspaceRenewal(request("/api/viewer/workspace/session-renewal/challenge"), disabledEnv)).status).toBe(404);
    mocks.rate.mockRejectedValue(new Error("limiter unavailable"));
    const failed = await dispatchViewerWorkspaceRenewal(request("/api/viewer/workspace/session-renewal/challenge"), env);
    expect(failed.status).toBe(503);
    expect(mocks.serviceCreate).not.toHaveBeenCalled();
  });

  it("rejects malformed Viewer session correlation handles without treating them as authority", async () => {
    const challengeResponse = await dispatchViewerWorkspaceRenewal(request("/api/viewer/workspace/session-renewal/challenge"), env);
    const challenge = await challengeResponse.json() as { challenge: string };
    const requestId = crypto.randomUUID();
    const malformed = await dispatchViewerWorkspaceRenewal(request("/api/viewer/workspace/session-renewal", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestId, "X-CSRF-Token": challenge.challenge },
      body: JSON.stringify({ protocolVersion: 1, requestId, sessionId: "../../other", subject: `ops:${principal.id}` }),
    }), env);
    expect(malformed.status).toBe(400);
    expect(mocks.serviceCreate).not.toHaveBeenCalled();
  });
});
