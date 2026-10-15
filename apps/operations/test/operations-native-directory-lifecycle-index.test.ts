import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lifecycle: vi.fn(async (_request: Request, _dependencies: unknown) => new Response("lifecycle")),
}));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {}, WorkflowEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/operations-portal-native-directory-lifecycle-owner-http", () => ({
  OPERATIONS_NATIVE_DIRECTORY_LIFECYCLE_OWNER_BASE: "/api/native-client-portal/directory-lifecycle",
  handleOperationsNativeDirectoryLifecycleOwnerHttp: mocks.lifecycle,
}));

import worker from "../src/worker/index";
import type { Env } from "../src/worker/types";

const origin = "https://ops-staging.example.test";
const base = "/api/native-client-portal/directory-lifecycle";
const execution = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
function environment(overrides: Partial<Env> = {}): Env {
  return { ENVIRONMENT: "staging", EXPECTED_HOST: "ops-staging.example.test", PUBLIC_BASE_URL: origin,
    TEAM_DOMAIN: "https://team.cloudflareaccess.com", OPERATIONS_AUD: "a".repeat(16),
    OPERATIONS_SESSION_SECRET: "synthetic-entrypoint-secret-at-least-32-bytes", OPS_DB: {} as D1Database,
    ...overrides } as Env;
}
const send = (path: string, overrides: Partial<Env> = {}) => worker.fetch!(new Request(`${origin}${path}`),
  environment(overrides), execution);

describe("native Directory lifecycle index mount", () => {
  beforeEach(() => mocks.lifecycle.mockClear());

  it.each([undefined, "false", "TRUE", "1"])("is absent before the handler when the local flag is %s", async flag => {
    const response = await send(`${base}/session`, { NATIVE_DIRECTORY_LIFECYCLE_ENABLED: flag });
    expect(response.status).toBe(404); expect(mocks.lifecycle).not.toHaveBeenCalled();
  });

  it("remains unavailable outside staging even when the local flag is true", async () => {
    const response = await send(`${base}/session`, {
      ENVIRONMENT: "production",
      NATIVE_DIRECTORY_LIFECYCLE_ENABLED: "true",
    });
    expect(response.status).toBe(404);
    expect(mocks.lifecycle).not.toHaveBeenCalled();
  });

  it("passes exact established native-auth configuration only when explicitly enabled", async () => {
    const response = await send(`${base}/session`, { NATIVE_DIRECTORY_LIFECYCLE_ENABLED: "true" });
    expect(await response.text()).toBe("lifecycle");
    expect(mocks.lifecycle).toHaveBeenCalledOnce();
    expect(mocks.lifecycle.mock.calls[0]?.[1]).toMatchObject({
      environment: "staging", enabledFlag: "true", expectedHost: "ops-staging.example.test",
      configuration: { enabled: true, issuer: "https://team.cloudflareaccess.com", staffAudience: "a".repeat(16),
        origin, csrfSecret: "synthetic-entrypoint-secret-at-least-32-bytes" },
    });
  });

  it("does not capture neighboring paths", async () => {
    const response = await send(`${base}-extra/session`, { NATIVE_DIRECTORY_LIFECYCLE_ENABLED: "true" });
    expect(await response.text()).not.toBe("lifecycle"); expect(mocks.lifecycle).not.toHaveBeenCalled();
  });
});
