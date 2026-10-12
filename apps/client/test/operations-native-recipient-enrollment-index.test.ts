import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ proof: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {} }));
vi.mock("../src/worker/client-portal/access-identity", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/client-portal/access-identity")>(),
  resolveCloudflareRecipientEnrollmentProof: calls.proof,
}));

import worker from "../src/worker/index";
import type { Env } from "../src/worker/types";

const origin = "https://portal.example.test";
const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
function env(overrides: Partial<Env> = {}): Env {
  return { ENVIRONMENT: "production", EXPECTED_HOST: "portal.example.test", PUBLIC_BASE_URL: origin,
    PUBLIC_SHARE_ORIGIN: origin, CLIENT_PORTAL_ORIGIN: origin, CLIENT_PORTAL_ORIGINS: origin,
    CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "true",
    CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_CSRF_SECRET: "production-native-enrollment-csrf-secret",
    OPERATIONS_PORTAL_NATIVE_RECIPIENT_ENROLLMENT: {
      inspectNativeEnrollment: vi.fn(), redeemNativeEnrollment: vi.fn(),
    }, ...overrides } as unknown as Env;
}
function session(url = `${origin}/api/client/operations/recipient-enrollment/session`, headers: HeadersInit = {}) {
  return new Request(url, { headers: { Origin: origin, "Sec-Fetch-Site": "same-origin",
    "X-Operations-Enrollment-Request": "1", ...headers } });
}

describe("standard Client Worker native recipient enrollment mount", () => {
  beforeEach(() => calls.proof.mockReset().mockResolvedValue({ principal: {
    issuer: "https://team.cloudflareaccess.com", subject: "access|recipient", email: "person@example.test",
  }, verifiedUntil: "2099-01-01T00:00:00.000Z" }));

  it("is absent by default and serves a production session only with exact configuration", async () => {
    expect((await worker.fetch(session(), env({ CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "false" }), execution)).status).toBe(404);
    expect(calls.proof).not.toHaveBeenCalled();
    expect((await worker.fetch(session(), env(), execution)).status).toBe(200);
    expect(calls.proof).toHaveBeenCalledOnce();
  });

  it.each([
    { overrides: { OPERATIONS_PORTAL_NATIVE_RECIPIENT_ENROLLMENT: undefined }, status: 503 },
    { overrides: { ENVIRONMENT: "development" }, status: 503 },
    { overrides: { CLIENT_PORTAL_ORIGIN: "https://other.example.test" }, status: 404 },
  ])("fails closed for missing dependency or invalid deployment configuration %#", async ({ overrides, status }) => {
    expect((await worker.fetch(session(), env(overrides as Partial<Env>), execution)).status).toBe(status);
    expect(calls.proof).not.toHaveBeenCalled();
  });

  it("does not infer the trusted origin from forwarded headers", async () => {
    const response = await worker.fetch(session("https://other.example.test/api/client/operations/recipient-enrollment/session", {
      Origin: "https://other.example.test", "X-Forwarded-Host": "portal.example.test",
      "X-Forwarded-Proto": "https", Forwarded: "host=portal.example.test;proto=https",
    }), env(), execution);
    expect(response.status).not.toBe(200);
    expect(calls.proof).not.toHaveBeenCalled();
  });
});
