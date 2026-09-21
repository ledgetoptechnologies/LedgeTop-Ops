import { beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../src/worker/types";

const calls = vi.hoisted(() => ({ legacy: vi.fn(), monitor: vi.fn(), quota: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: calls.legacy }));
vi.mock("../src/worker/native-staff-onboarding-rate-limit", () => ({
  consumeNativeStaffOnboardingRateLimit: calls.quota,
  pruneNativeStaffOnboardingRateLimits: vi.fn(),
}));
vi.mock("../src/worker/project-alpha-api-v2-monitor-control-http", async original => ({
  ...await original<typeof import("../src/worker/project-alpha-api-v2-monitor-control-http")>(),
  handleProjectAlphaApiV2MonitorControlHttp: calls.monitor,
}));
import worker from "../src/worker/index";

const origin = "https://ops.example.test";
const database: D1Database = { prepare: unavailable, batch: unavailable, exec: unavailable,
  withSession: unavailable, dump: unavailable };
const context: ExecutionContext = { waitUntil() {}, passThroughOnException() {}, props: {},
  get exports(): Cloudflare.Exports { return unavailable(); }, get tracing(): Tracing { return unavailable(); } };

function unavailable(): never { throw Error("unexpected binding use"); }

function environment(controlEnabled = "false"): Env {
  return { ENVIRONMENT: "production", EXPECTED_HOST: "ops.example.test", OPERATIONS_ORIGINS: origin,
    PUBLIC_BASE_URL: origin, INCOMING_EXPECTED_HOST: "incoming.example.test",
    INCOMING_BASE_URL: "https://incoming.example.test", OPS_DB: database,
    TEAM_DOMAIN: "https://synthetic-team.cloudflareaccess.com",
    OPERATIONS_AUD: "synthetic-staff-audience",
    NATIVE_INTEGRATION_CONTROL_ENABLED: controlEnabled, NATIVE_INTEGRATION_CONTROL_ORIGIN: origin,
    PROJECT_ALPHA_API_V2_CONNECTIONS: "server-only-configured-connections",
    OPERATIONS_SESSION_SECRET: "synthetic-native-control-csrf-secret-at-least-thirty-two-bytes",
  } as Env;
}

function send(path: string, method = "GET", env = environment()) {
  return worker.fetch(new Request(`${origin}${path}`, { method }), env, context);
}

beforeEach(() => {
  calls.legacy.mockReset().mockRejectedValue(new HTTPException(401, { message: "legacy sign-in required" }));
  calls.monitor.mockReset().mockImplementation(() => new Response(JSON.stringify({ route: "monitor" }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  }));
  calls.quota.mockReset().mockResolvedValue(true);
});

describe("native monitor reserved namespace routing", () => {
  it("dispatches exact supported routes before legacy auth, including while disabled", async () => {
    const env = environment("false");
    for (const [path, method] of [["session", "GET"], ["state", "GET"], ["", "POST"]] as const) {
      const response = await send(`/api/native-integrations/monitor${path ? `/${path}` : ""}`, method, env);
      expect(response.status).toBe(200);
    }
    expect(calls.monitor).toHaveBeenCalledTimes(3);
    for (const call of calls.monitor.mock.calls)
      expect(call[1]).toMatchObject({ database, projectAlphaConnectionsJson: "server-only-configured-connections",
        configuration: { enabled: false, issuer: env.TEAM_DOMAIN, staffAudience: env.OPERATIONS_AUD,
          origin, csrfSecret: env.OPERATIONS_SESSION_SECRET },
        consumeRateLimit: expect.any(Function) });
    expect(calls.legacy).not.toHaveBeenCalled();
  });

  it("passes the dedicated gate and origin without changing the server-only config", async () => {
    const env = environment("true");
    const response = await send("/api/native-integrations/monitor/session", "GET", env);
    expect(response.status).toBe(200);
    expect(calls.monitor).toHaveBeenCalledOnce();
    expect(calls.monitor.mock.calls[0]?.[1]).toMatchObject({
      configuration: { enabled: true, origin },
      projectAlphaConnectionsJson: "server-only-configured-connections",
    });
    expect(calls.legacy).not.toHaveBeenCalled();
  });

  it("rejects unknown methods and descendants before legacy auth", async () => {
    for (const [path, method] of [["/api/native-integrations/monitor", "GET"],
      ["/api/native-integrations/monitor/session", "POST"],
      ["/api/native-integrations/monitor/unknown", "GET"],
      ["/api/native-integrations/monitor/state/extra", "GET"]] as const)
      expect((await send(path, method)).status).toBe(404);
    expect(calls.monitor).not.toHaveBeenCalled();
    expect(calls.legacy).not.toHaveBeenCalled();
  });
});
