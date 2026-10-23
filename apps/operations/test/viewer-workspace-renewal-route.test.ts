import { beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";

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

function productionFixture() {
  const productionOps = "https://ops.ledgetopdroneservices.com";
  const productionViewer = "https://viewer.ledgetopdroneservices.com";
  return {
    viewerOrigin: productionViewer,
    env: { ...env, ENVIRONMENT: "production", EXPECTED_HOST: "ops.ledgetopdroneservices.com",
      OPERATIONS_ORIGINS: productionOps, VIEWER_BASE_URL: productionViewer } as Env,
    request: (path: string, init: RequestInit = {}) => new Request(productionOps + path, {
      ...init, headers: { Origin: productionViewer, ...(init.headers as Record<string, string> || {}) },
    }),
  };
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
      grant: "one-use-grant-token-1234567890-1234567890",
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

  it("keeps unknown environments disabled even if the feature flag is misconfigured", async () => {
    const response = await worker.fetch(request(requestPath), {
      ...env,
      ENVIRONMENT: "development",
      VIEWER_WORKSPACE_RENEWAL_CORS_ENABLED: "true",
    }, context);

    expect(response.status).toBe(404);
    expect(mocks.boundStaff).not.toHaveBeenCalled();
    expect(mocks.genericStaff).not.toHaveBeenCalled();
  });

  it("renews through the production route with exact origins and current bound-staff authority", async () => {
    const productionOps = "https://ops.ledgetopdroneservices.com";
    const productionViewer = "https://viewer.ledgetopdroneservices.com";
    const productionEnv = { ...env, ENVIRONMENT: "production", EXPECTED_HOST: "ops.ledgetopdroneservices.com",
      OPERATIONS_ORIGINS: productionOps, VIEWER_BASE_URL: productionViewer } as Env;
    const renewalRequest = (path: string, init: RequestInit = {}, origin = productionViewer) => new Request(productionOps + path, {
      ...init, headers: { Origin: origin, ...(init.headers as Record<string, string> || {}) },
    });
    mocks.createGrant.mockResolvedValue({ grant: "one-use-grant-token-1234567890-1234567890",
      grantExpiresAt: new Date(Date.now() + 60_000).toISOString(), sessionTtlSeconds: 600,
      redeemUrl: productionViewer + "/api/v1/admin-sessions/redeem" });
    const preflight = await worker.fetch(renewalRequest(requestPath, { method: "OPTIONS", headers: {
      "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,idempotency-key,x-csrf-token",
    } }), productionEnv, context);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(productionViewer);
    const challengeResponse = await worker.fetch(renewalRequest(`${requestPath}/challenge`), productionEnv, context);
    expect(challengeResponse.status).toBe(200);
    const challenge = await challengeResponse.json() as { challenge: string };
    const requestId = crypto.randomUUID();
    const response = await worker.fetch(renewalRequest(requestPath, { method: "POST", headers: {
      "Content-Type": "application/json", "Idempotency-Key": requestId, "X-CSRF-Token": challenge.challenge,
    }, body: JSON.stringify({ protocolVersion: 1, requestId, sessionId: "viewer-session-correlation-01", subject: "ops:staff-owner-1" }) }), productionEnv, context);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ sessionId: "viewer-session-correlation-01", redeemUrl: productionViewer + "/api/v1/admin-sessions/redeem" });
    expect(mocks.boundStaff).toHaveBeenCalledTimes(2);
    expect(mocks.genericStaff).not.toHaveBeenCalled();
    expect(mocks.createGrant).toHaveBeenCalledOnce();
    mocks.createGrant.mockClear();
    const foreignOrigin = await worker.fetch(renewalRequest(`${requestPath}/challenge`, {}, "https://attacker.example"), productionEnv, context);
    expect(foreignOrigin.status).toBe(403);
    expect(foreignOrigin.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(mocks.createGrant).not.toHaveBeenCalled();
  });

  it.each(["https://ops.ledgetopdroneservices.com","https://ops.ledgetop.app"])(
    "binds renewal grants to the actual verified staff URL %s, not the Viewer Origin header or canonical primary",async controllerOrigin=>{
      const production=productionFixture();
      const candidate={...production.env,EXPECTED_HOST:"ops.ledgetop.app",
        OPERATIONS_ORIGINS:"https://ops.ledgetop.app,https://ops.ledgetopdroneservices.com"} as Env;
      const makeRequest=(path:string,init:RequestInit={})=>new Request(controllerOrigin+path,{...init,
        headers:{Origin:production.viewerOrigin,...init.headers as Record<string,string>}});
      const challengeResponse=await worker.fetch(makeRequest(`${requestPath}/challenge`),candidate,context);
      expect(challengeResponse.status).toBe(200);
      const {challenge}=await challengeResponse.json() as {challenge:string};
      const requestId=crypto.randomUUID(),sessionId="viewer-session-correlation-01";
      const response=await worker.fetch(makeRequest(requestPath,{method:"POST",headers:{"Content-Type":"application/json",
        "Idempotency-Key":requestId,"X-CSRF-Token":challenge},body:JSON.stringify({protocolVersion:1,requestId,sessionId,subject:"ops:staff-owner-1"})}),candidate,context);
      expect(response.status).toBe(201);
      expect(mocks.createGrant).toHaveBeenCalledWith(expect.objectContaining({controllerOrigin,targetSessionId:sessionId}));
      const denied=await worker.fetch(new Request("https://portal.ledgetop.app"+requestPath+"/challenge",{headers:{Origin:production.viewerOrigin}}),candidate,context);
      expect(denied.status).toBe(404);
      expect(mocks.createGrant).toHaveBeenCalledTimes(1);
    });

  it("returns authenticated production failures as exact-origin CORS JSON without minting a grant", async () => {
    const production = productionFixture();
    mocks.boundStaff.mockRejectedValue(new HTTPException(401, { message: "Invalid Cloudflare Access authentication" }));
    for (const method of ["GET", "POST"]) {
      const response = await worker.fetch(production.request(method === "GET" ? `${requestPath}/challenge` : requestPath,
        { method }), production.env, context);
      expect(response.status).toBe(401);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(production.viewerOrigin);
      expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
      expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Location")).toBeNull();
      expect(await response.json()).toEqual({ error: "Invalid Cloudflare Access authentication" });
    }
    expect(mocks.boundStaff).toHaveBeenCalledTimes(2);
    expect(mocks.genericStaff).not.toHaveBeenCalled();
    expect(mocks.permissions).not.toHaveBeenCalled();
    expect(mocks.createGrant).not.toHaveBeenCalled();
  });

  it("rejects a production challenge after the current Access identity changes even when the request subject matches", async () => {
    const production = productionFixture();
    const challengeResponse = await worker.fetch(production.request(`${requestPath}/challenge`), production.env, context);
    expect(challengeResponse.status).toBe(200);
    const challenge = await challengeResponse.json() as { challenge: string };
    mocks.boundStaff.mockResolvedValue({ principal: { id: "staff-owner-2", accessSubject: "access-subject-2" },
      expiresAt: Math.floor(Date.now() / 1000) + 600 });
    const requestId = crypto.randomUUID();
    const response = await worker.fetch(production.request(requestPath, { method: "POST", headers: {
      "Content-Type": "application/json", "Idempotency-Key": requestId, "X-CSRF-Token": challenge.challenge,
    }, body: JSON.stringify({ protocolVersion: 1, requestId, sessionId: "viewer-session-correlation-01", subject: "ops:staff-owner-2" }) }), production.env, context);
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(production.viewerOrigin);
    expect(await response.json()).toEqual({ error: "Renewal CSRF challenge is invalid or expired" });
    expect(mocks.boundStaff).toHaveBeenCalledTimes(2);
    expect(mocks.permissions).not.toHaveBeenCalled();
    expect(mocks.createGrant).not.toHaveBeenCalled();
  });

  it("refuses production renewal when verified Access authority has at most sixty seconds left", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-18T06:01:00Z"));
      const production = productionFixture();
      for (const seconds of [60, 59, 1]) {
        mocks.boundStaff.mockResolvedValue({ principal: { id: "staff-owner-1", accessSubject: "access-subject-1" },
          expiresAt: Math.floor(Date.now() / 1000) + seconds });
        const challengeResponse = await worker.fetch(production.request(`${requestPath}/challenge`), production.env, context);
        expect(challengeResponse.status).toBe(200);
        const challenge = await challengeResponse.json() as { challenge: string };
        const requestId = crypto.randomUUID();
        const response = await worker.fetch(production.request(requestPath, { method: "POST", headers: {
          "Content-Type": "application/json", "Idempotency-Key": requestId, "X-CSRF-Token": challenge.challenge,
        }, body: JSON.stringify({ protocolVersion: 1, requestId, sessionId: "viewer-session-correlation-01", subject: "ops:staff-owner-1" }) }), production.env, context);
        expect(response.status).toBe(401);
        expect(response.headers.get("Access-Control-Allow-Origin")).toBe(production.viewerOrigin);
        expect(await response.json()).toEqual({ error: "Operations authorization is too close to expiry to renew" });
      }
      expect(mocks.createGrant).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("bounds streamed bodies without Content-Length and rejects duplicate identity fields", async () => {
    const oversized = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(" ".repeat(2049))); controller.close();
    } });
    const response = await worker.fetch(request(requestPath, { method: "POST", headers: { "Content-Type": "application/json" },
      body: oversized, duplex: "half" } as RequestInit), env, context);
    expect(response.status).toBe(413);
    const duplicate = await worker.fetch(request(requestPath, { method: "POST", headers: { "Content-Type": "application/json" },
      body: '{"subject":"ops:staff-owner-1","subject":"ops:other"}' }), env, context);
    expect(duplicate.status).toBe(400);
    expect(mocks.createGrant).not.toHaveBeenCalled();
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
