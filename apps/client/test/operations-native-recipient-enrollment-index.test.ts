import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ proof: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {} }));
vi.mock("../src/worker/client-portal/access-identity", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/client-portal/access-identity")>(),
  resolveCloudflareRecipientEnrollmentProof: calls.proof,
}));

import worker, { requestHostAllowed } from "../src/worker/index";
import { configuredPublicShareOrigin } from "../src/worker/origin-policy";
import { publishOperationsPortalWorkspaceRpc } from "../src/worker/operations-portal-workspace-publication-entrypoint";
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
    { CLIENT_PORTAL_ENABLED: undefined },
    { CLIENT_PORTAL_ENABLED: "false" },
    { CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED: undefined },
  ])("keeps consent absent with missing or disabled normal-route flags %#", async overrides => {
    expect((await worker.fetch(session(), env(overrides), execution)).status).toBe(404);
    expect(calls.proof).not.toHaveBeenCalled();
  });

  it.each([
    { overrides: { OPERATIONS_PORTAL_NATIVE_RECIPIENT_ENROLLMENT: { inspectNativeEnrollment: vi.fn() } }, status: 503 },
    { overrides: { OPERATIONS_PORTAL_NATIVE_RECIPIENT_ENROLLMENT: { redeemNativeEnrollment: vi.fn() } }, status: 503 },
    { overrides: { OPERATIONS_PORTAL_NATIVE_RECIPIENT_ENROLLMENT: undefined }, status: 503 },
    { overrides: { ENVIRONMENT: "development" }, status: 503 },
    { overrides: { CLIENT_PORTAL_ORIGIN: "https://other.example.test" }, status: 404 },
  ])("fails closed for missing dependency or invalid deployment configuration %#", async ({ overrides, status }) => {
    expect((await worker.fetch(session(), env(overrides as Partial<Env>), execution)).status).toBe(status);
    expect(calls.proof).not.toHaveBeenCalled();
  });

  const portal = "https://client-staging.ledgetopdroneservices.com";
  const delivery = "https://delivery-staging.ledgetopdroneservices.com";
  function separateHosts(overrides: Partial<Env> = {}): Env {
    return env({ ENVIRONMENT: "staging", EXPECTED_HOST: new URL(delivery).hostname,
      PUBLIC_BASE_URL: delivery, PUBLIC_SHARE_ORIGIN: delivery,
      CLIENT_PORTAL_ORIGIN: portal, CLIENT_PORTAL_ORIGINS: `${portal},https://portal-staging.ledgetopdroneservices.com`,
      CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_EXPECTED_HOST: new URL(portal).hostname, ...overrides });
  }
  function nativeRequest(path = "session", body?: unknown, token?: string) {
    return new Request(`${portal}/api/client/operations/recipient-enrollment/${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { Origin: portal, "Sec-Fetch-Site": "same-origin",
        "X-Operations-Enrollment-Request": "1", ...(body === undefined ? {} : {
          "Content-Type": "application/json", "X-CSRF-Token": token ?? "" }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
  }

  it("opens and redeems native consent on its configured portal host while retaining the delivery host", async () => {
    const intentId = "00000001-0000-4000-8000-000000000000", opaqueToken = "a".repeat(64);
    const operationId = "00000002-0000-4000-8000-000000000000";
    const target = { targetId: "00000003-0000-4000-8000-000000000000", targetRevision: 1, clientRecordId: "native-client" };
    const inspect = vi.fn().mockResolvedValue(JSON.stringify({ intentId, revision: 1, state: "issued",
      target: { ...target, displayLabel: "Synthetic native client" }, expiresAt: "2099-01-01T00:00:00.000Z" }));
    const redeem = vi.fn().mockResolvedValue(JSON.stringify({ intentId, revision: 2, state: "pending" }));
    const configured = separateHosts({ OPERATIONS_PORTAL_NATIVE_RECIPIENT_ENROLLMENT: {
      inspectNativeEnrollment: inspect, redeemNativeEnrollment: redeem,
      fetch: vi.fn(async () => new Response(null, { status: 404 })),
      connect: vi.fn(() => { throw new Error("Native consent does not open sockets"); }) } });
    const opened = await worker.fetch(nativeRequest(), configured, execution);
    expect(opened.status).toBe(200);
    const { csrfToken } = await opened.json() as { csrfToken: string };
    expect(csrfToken).toMatch(/^\d{1,12}\.[0-9a-f]{64}$/u);
    expect((await worker.fetch(nativeRequest("inspect", { intentId, opaqueToken }, csrfToken), configured, execution)).status).toBe(200);
    const result = await worker.fetch(nativeRequest("redeem", { intentId, opaqueToken, operationId,
      acknowledged: true, acknowledgedTarget: target }, csrfToken), configured, execution);
    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({ intentId, revision: 2, state: "pending" });
    expect(redeem).toHaveBeenCalledExactlyOnceWith({ protocolVersion: 1, intentId, opaqueToken, operationId,
      acknowledged: true, acknowledgedTarget: target, principal: { issuer: "https://team.cloudflareaccess.com", subject: "access|recipient" },
      recipientLabel: "person@example.test", verifiedUntil: "2099-01-01T00:00:00.000Z" });
    expect(configured.EXPECTED_HOST).toBe("delivery-staging.ledgetopdroneservices.com");
    expect(configuredPublicShareOrigin(configured)).toBe(delivery);
    for (const path of ["/s/example", "/api/public/shares/example/manifest"]) {
      expect(requestHostAllowed(`${delivery}${path}`, configured)).toBe(true);
      expect(requestHostAllowed(`${portal}${path}`, configured)).toBe(false);
    }
    expect(requestHostAllowed(`${portal}/api/internal/project-alpha/portal-v2`, configured)).toBe(true);
    expect(requestHostAllowed(`${delivery}/api/internal/project-alpha/portal-v2`, configured)).toBe(false);
  });

  it("retains the delivery-host fence on the existing private workspace publication entrypoint", async () => {
    const configured = separateHosts({ CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true" });
    // Malformed input reaches the existing validator only on the unchanged private host.
    await expect(publishOperationsPortalWorkspaceRpc(configured, {})).resolves.toMatchObject({ ok: false, code: "invalid" });
    await expect(publishOperationsPortalWorkspaceRpc({ ...configured, EXPECTED_HOST: new URL(portal).hostname }, {}))
      .resolves.toMatchObject({ ok: false, code: "disabled" });
  });

  it.each([undefined, "", "other.example.test", "CLIENT-STAGING.LEDGETOPDRONESERVICES.COM"])(
    "keeps distinct-host consent closed for missing or mismatched dedicated host %s", async expectedHost => {
      const response = await worker.fetch(nativeRequest(), separateHosts({
        CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_EXPECTED_HOST: expectedHost }), execution);
      expect(response.status).toBe(503);
      expect(calls.proof).not.toHaveBeenCalled();
    });

  it("still requires signed Client identity and native consent CSRF on the dedicated portal host", async () => {
    const configured = separateHosts();
    calls.proof.mockResolvedValueOnce(null);
    expect((await worker.fetch(nativeRequest(), configured, execution)).status).toBe(401);
    expect((await worker.fetch(nativeRequest("inspect", {
      intentId: "00000001-0000-4000-8000-000000000000", opaqueToken: "a".repeat(64) }, "invalid"), configured, execution)).status).toBe(403);
    expect(configured.OPERATIONS_PORTAL_NATIVE_RECIPIENT_ENROLLMENT!.inspectNativeEnrollment).not.toHaveBeenCalled();
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
