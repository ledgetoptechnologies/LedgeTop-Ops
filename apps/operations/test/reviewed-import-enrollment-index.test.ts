import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ enrollment: vi.fn(async (_request: Request, _dependencies: unknown) => new Response("enrollment")) }));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {}, WorkflowEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/reviewed-import-enrollment-http", () => ({
  REVIEWED_IMPORT_ENROLLMENT_BASE: "/api/native-directory/reviewed-import-enrollment",
  handleReviewedImportEnrollmentHttp: mocks.enrollment,
}));
import worker from "../src/worker/index";
import type { Env } from "../src/worker/types";
const origin = "https://ops-staging.example.test", base = "/api/native-directory/reviewed-import-enrollment";
const execution = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
function send(path: string, overrides: Partial<Env> = {}) {
  const env = { ENVIRONMENT: "staging", EXPECTED_HOST: "ops-staging.example.test", PUBLIC_BASE_URL: origin,
    TEAM_DOMAIN: "https://team.cloudflareaccess.com", OPERATIONS_AUD: "a".repeat(16),
    OPERATIONS_SESSION_SECRET: "synthetic-import-entrypoint-secret-at-least-32-bytes", OPS_DB: {} as D1Database,
    ...overrides } as Env;
  return worker.fetch!(new Request(`${origin}${path}`), env, execution);
}
describe("reviewed import enrollment index mount", () => {
  beforeEach(() => mocks.enrollment.mockClear());
  it.each([undefined, "false", "TRUE", "1"])("is absent without exact opt-in (%s)", async flag => {
    expect((await send(`${base}/session`, { REVIEWED_IMPORT_ENROLLMENT_ENABLED: flag })).status).toBe(404);
    expect(mocks.enrollment).not.toHaveBeenCalled();
  });
  it("cannot be activated in production", async () => {
    expect((await send(`${base}/session`, { ENVIRONMENT: "production", REVIEWED_IMPORT_ENROLLMENT_ENABLED: "true" })).status).toBe(404);
    expect(mocks.enrollment).not.toHaveBeenCalled();
  });
  it("passes native-auth configuration and the server-owned resolver only in staging", async () => {
    expect(await (await send(`${base}/session`, { REVIEWED_IMPORT_ENROLLMENT_ENABLED: "true" })).text()).toBe("enrollment");
    expect(mocks.enrollment).toHaveBeenCalledOnce();
    expect(mocks.enrollment.mock.calls[0]?.[1]).toMatchObject({ environment: "staging", enabledFlag: "true",
      expectedHost: "ops-staging.example.test", resolveDestinations: expect.any(Function),
      configuration: { enabled: true, origin, issuer: "https://team.cloudflareaccess.com", staffAudience: "a".repeat(16) } });
  });
  it("does not intercept neighboring paths", async () => {
    expect(await (await send(`${base}-extra/session`, { REVIEWED_IMPORT_ENROLLMENT_ENABLED: "true" })).text()).not.toBe("enrollment");
    expect(mocks.enrollment).not.toHaveBeenCalled();
  });
});
