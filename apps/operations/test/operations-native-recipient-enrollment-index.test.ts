import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/native-staff-auth", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/native-staff-auth")>(),
  authenticateNativeStaffWithAdmissionVersion: calls.auth,
}));

import worker from "../src/worker/index";
import type { Env } from "../src/worker/types";

const origin = "https://ops.example.test";
const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
function env(overrides: Partial<Env> = {}): Env {
  return { ENVIRONMENT: "production", EXPECTED_HOST: "ops.example.test", OPERATIONS_ORIGINS: origin,
    PUBLIC_BASE_URL: origin, DELIVERY_BASE_URL: "https://portal.example.test",
    TEAM_DOMAIN: "https://team.cloudflareaccess.com", OPERATIONS_AUD: "a".repeat(16),
    OPERATIONS_SESSION_SECRET: "production-native-owner-csrf-secret-long-enough",
    CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "true", CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED: "true",
    OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "true", OPS_DB: {} as D1Database,
    OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: {
      applyNativeAuthority: vi.fn(), getNativeAuthorityStatus: vi.fn(),
    }, ...overrides } as unknown as Env;
}
function session(url = `${origin}/api/native-client-portal/operations-recipient-enrollment/session`, headers: HeadersInit = {}) {
  return new Request(url, { headers: { Origin: origin, "Sec-Fetch-Site": "same-origin",
    "X-Native-Staff-Request": "1", ...headers } });
}

describe("standard Operations Worker native recipient enrollment mount", () => {
  beforeEach(() => calls.auth.mockReset().mockResolvedValue({ identity: { kind: "native", staffId: "manager",
    verifiedAccessSubject: "access|manager", email: "manager@example.test", displayName: "Manager", profileVersion: 1 },
    admissionVersion: 1, verifiedUntil: "2099-01-01T00:00:00.000Z" }));

  it("is absent by default and serves a production session only with exact configuration", async () => {
    expect((await worker.fetch(session(), env({ CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED: "false" }), execution)).status).toBe(404);
    expect(calls.auth).not.toHaveBeenCalled();
    expect((await worker.fetch(session(), env(), execution)).status).toBe(200);
    expect(calls.auth).toHaveBeenCalledOnce();
  });

  it("returns the new private recipient entry origin without changing the separate public share origin", async () => {
    const settings = env({ DELIVERY_BASE_URL: "https://portal.ledgetop.app",
      PUBLIC_SHARE_ORIGIN: "https://portal.ledgetopdroneservices.com" });
    const response = await worker.fetch(session(), settings, execution);
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.json()).toMatchObject({ recipientOrigin: "https://portal.ledgetop.app" });
    expect(settings.PUBLIC_SHARE_ORIGIN).toBe("https://portal.ledgetopdroneservices.com");
  });

  it.each([
    { CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED: undefined },
    { CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: undefined },
    { CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: "false" },
  ])("keeps enrollment absent with missing or disabled normal-route flags %#", async overrides => {
    expect((await worker.fetch(session(), env(overrides), execution)).status).toBe(404);
    expect(calls.auth).not.toHaveBeenCalled();
  });

  it.each([
    { OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: undefined },
    { OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED: "false" },
    { OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: { applyNativeAuthority: vi.fn() } },
    { OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: { getNativeAuthorityStatus: vi.fn() } },
    { OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY: undefined },
    { ENVIRONMENT: "development" },
    { PUBLIC_BASE_URL: "https://other.example.test" },
  ])("fails closed for missing dependency or invalid deployment configuration %#", async overrides => {
    expect((await worker.fetch(session(), env(overrides as Partial<Env>), execution)).status).toBe(503);
    expect(calls.auth).not.toHaveBeenCalled();
  });

  it("does not infer the trusted origin from forwarded headers", async () => {
    const response = await worker.fetch(session(
      "https://other.example.test/api/native-client-portal/operations-recipient-enrollment/session", {
        Origin: "https://other.example.test", "X-Forwarded-Host": "ops.example.test",
        "X-Forwarded-Proto": "https", Forwarded: "host=ops.example.test;proto=https",
      }), env(), execution);
    expect(response.status).not.toBe(200);
    expect(calls.auth).not.toHaveBeenCalled();
  });
});
