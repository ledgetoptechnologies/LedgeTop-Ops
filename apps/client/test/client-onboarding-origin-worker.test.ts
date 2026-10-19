import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {} }));
import worker from "../src/worker/index";
import type { Env } from "../src/worker/types";

const invitationId = "00000000-0000-4000-8000-000000000001";
const submissionId = "00000000-0000-4000-8000-000000000002";
const invitationSecret = "ab".repeat(32);
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function setup(environment: "staging" | "production") {
  const portal = "https://portal.example.test", share = "https://delivery.example.test";
  const alias = "https://portal-alias.example.test", retired = "https://retired.example.test";
  const legacy = "https://legacy.example.test";
  const result = { ok: true, protocolVersion: 1, state: "pending", invitationId,
    expiresAt: "2099-01-01T00:00:00.000Z" };
  const session = vi.fn().mockResolvedValue(result);
  const submit = vi.fn().mockResolvedValue({ ...result, state: "submitted", submissionId, fieldsSha256: "c".repeat(64) });
  const status = vi.fn().mockResolvedValue({ ...result, state: "submitted", submissionId, fieldsSha256: "c".repeat(64) });
  const limit = vi.fn().mockResolvedValue({ success: true });
  const assets = vi.fn().mockResolvedValue(new Response("existing public-link shell"));
  const env = { ENVIRONMENT: environment, EXPECTED_HOST: new URL(share).hostname,
    PUBLIC_BASE_URL: share, PUBLIC_SHARE_ORIGIN: share, CLIENT_PORTAL_ORIGIN: portal,
    CLIENT_PORTAL_ORIGINS: `${portal},${alias}`, CLIENT_PORTAL_RETIRED_ORIGINS: retired,
    LEGACY_CLIENT_ORIGINS: `${legacy},${retired}`, CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: "true",
    CLIENT_ONBOARDING_RECIPIENT_BRIDGE: { session, submit, status }, PUBLIC_SESSION_RATE_LIMITER: { limit },
    ASSETS: { fetch: assets } } as unknown as Env;
  function request(host: string, route = "session", origin: string | null = host) {
    return new Request(`${host}/api/client-onboarding/${invitationId}/${route}`, { method: "POST",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ invitationSecret, ...(route !== "session" ? { submissionId } : {}),
        ...(route === "submit" ? { fields: { name: "synthetic fixture" } } : {}) }) });
  }
  return { env, portal, share, alias, retired, legacy, session, submit, status, limit, assets, request };
}

describe.each(["staging", "production"] as const)("canonical onboarding global Worker admission: %s", environment => {
  it.each(["session", "submit", "status"] as const)("routes canonical %s through global middleware to the bridge", async route => {
    const f = setup(environment);
    const response = await worker.fetch(f.request(f.portal, route), f.env, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: true, protocolVersion: 1, invitationId });
    expect(f[route]).toHaveBeenCalledExactlyOnceWith({ protocolVersion: 1, invitationId, invitationSecret,
      ...(route !== "session" ? { submissionId } : {}),
      ...(route === "submit" ? { fields: { name: "synthetic fixture" } } : {}) });
  });

  it("denies aliases, public-share, retired, legacy and unrelated hosts before quota or RPC", async () => {
    const f = setup(environment);
    for (const host of [f.alias, f.share, f.retired, f.legacy, "https://unrelated.example.test"]) {
      for (const route of ["session", "submit", "status"]) {
        const response = await worker.fetch(f.request(host, route), f.env, context);
        expect(response.status).toBe(404);
        expect(response.headers.get("Location")).toBeNull();
      }
    }
    expect(f.limit).not.toHaveBeenCalled();
    expect(f.session).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled(); expect(f.status).not.toHaveBeenCalled();
  });

  it("requires matching Origin even at the canonical portal", async () => {
    const f = setup(environment);
    for (const origin of [null, f.alias, f.share]) {
      expect((await worker.fetch(f.request(f.portal, "session", origin), f.env, context)).status).toBe(403);
    }
    expect(f.limit).not.toHaveBeenCalled(); expect(f.session).not.toHaveBeenCalled();
  });

  it("keeps the disabled bridge and similarly prefixed unknown routes closed", async () => {
    const f = setup(environment);
    expect((await worker.fetch(f.request(f.portal), { ...f.env, CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: "false" }, context)).status).toBe(404);
    const request = new Request(`${f.portal}/api/client-onboarding-extra/${invitationId}/session`, { method: "POST",
      headers: { Origin: f.portal, "Content-Type": "application/json" }, body: JSON.stringify({ invitationSecret }) });
    expect((await worker.fetch(request, f.env, context)).status).toBe(404);
    expect(f.limit).not.toHaveBeenCalled(); expect(f.session).not.toHaveBeenCalled();
  });

  it("preserves existing public links on canonical and explicit legacy public hosts", async () => {
    const f = setup(environment);
    for (const host of [f.share, f.legacy, f.retired]) {
      const response = await worker.fetch(new Request(`${host}/s/existing-public-link`), f.env, context);
      expect(response.status).toBe(200); expect(response.headers.get("Location")).toBeNull();
    }
    expect(f.assets).toHaveBeenCalledTimes(3); expect(f.session).not.toHaveBeenCalled();
  });
});
