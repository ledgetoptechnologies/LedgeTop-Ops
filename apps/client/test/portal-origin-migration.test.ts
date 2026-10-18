import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {} }));
import worker, { requireSameOrigin } from "../src/worker/index";
import { clientPortalRequestOriginAllowed, configuredPublicRequestOrigins, configuredRetiredPortalOrigins,
  legacyClientRedirectLocation, malformedPortalLaunchRedirect, requestHostAllowed } from "../src/worker/origin-policy";
import { createSessionCookie } from "../src/worker/security";
import { nativeDeliveryDeploymentEnabled, NATIVE_DELIVERY_PORTAL_PRODUCTION_PROFILE,
  NATIVE_DELIVERY_PRODUCTION_PROFILE } from "../src/worker/operations-native-delivery-deployment";
import type { Env } from "../src/worker/types";

function migration(environment: "production" | "staging") {
  const prefix = environment === "staging" ? "-staging" : "";
  const portal = `https://portal${prefix}.ledgetopdroneservices.com`;
  const retired = `https://client${prefix}.ledgetopdroneservices.com`;
  const publicOrigin = environment === "staging" ? "https://delivery-staging.ledgetopdroneservices.com" : portal;
  return { ENVIRONMENT: environment, EXPECTED_HOST: new URL(publicOrigin).hostname,
    PUBLIC_BASE_URL: publicOrigin, PUBLIC_SHARE_ORIGIN: publicOrigin, CLIENT_PORTAL_ORIGIN: portal,
    CLIENT_PORTAL_ORIGINS: `${portal},https://portal${prefix}.ledgetoptechnologies.com`,
    CLIENT_PORTAL_RETIRED_ORIGINS: retired,
    ...(environment === "production" ? { LEGACY_CLIENT_ORIGINS: retired,
      CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE: NATIVE_DELIVERY_PORTAL_PRODUCTION_PROFILE } : {}),
    CLIENT_PORTAL_ENABLED: "true", CLIENT_ACCESS_TEAM_DOMAIN: "https://auth.example.test", CLIENT_ACCESS_AUD: "canonical-client-audience",
    SESSION_KEY_ID: "unchanged-key", DELIVERY_SESSION_SECRET: "unchanged-existing-session-secret-at-least-32-characters",
  };
}
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe.each(["production", "staging"] as const)("canonical portal migration: %s", environment => {
  it("redirects browser entries and never redirects API credentials or request bodies", async () => {
    const configuration = migration(environment), old = configuration.CLIENT_PORTAL_RETIRED_ORIGINS;
    const prepare = vi.fn(() => { throw new Error("retired hosts must not reach storage"); });
    const env = { ...configuration, DELIVERY_DB: { prepare } } as unknown as Env;
    for (const method of ["GET", "HEAD"]) {
      const response = await worker.fetch(new Request(`${old}/portal/account?workspace=existing-client`, { method }), env, context);
      expect(response.status).toBe(308);
      expect(response.headers.get("Location")).toBe(`${configuration.CLIENT_PORTAL_ORIGIN}/portal/account?workspace=existing-client`);
    }
    expect(legacyClientRedirectLocation(`${old}/`, configuration)).toBe(`${configuration.CLIENT_PORTAL_ORIGIN}/portal`);
    expect(malformedPortalLaunchRedirect(`${old}/portal%2A?__cf_access_message=logged_out&workspace=existing`, configuration))
      .toBe(`${configuration.CLIENT_PORTAL_ORIGIN}/portal?workspace=existing`);
    for (const path of ["/api/client/session", "/api/client/operations/data/deliveries", "/api/internal/project-alpha/portal-v2"]) {
      for (const method of ["GET", "POST"]) {
        const response = await worker.fetch(new Request(`${old}${path}`, { method,
          headers: { Cookie: "CF_Authorization=old-private-cookie", Origin: old },
          ...(method === "POST" ? { body: "private profile information" } : {}) }), env, context);
        expect(response.status).toBe(404);
        expect(response.headers.get("Location")).toBeNull();
      }
    }
    expect((await worker.fetch(new Request(`${old}/portal`, { method: "POST", body: "private" }), env, context)).status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("keeps primary portal APIs authenticated and denies retired-origin CSRF", async () => {
    const configuration = migration(environment), portal = configuration.CLIENT_PORTAL_ORIGIN;
    const prepare = vi.fn(() => { throw new Error("unauthenticated calls must not reach storage"); });
    const response = await worker.fetch(new Request(`${portal}/api/client/session`),
      { ...configuration, DELIVERY_DB: { prepare } } as unknown as Env, context);
    expect(response.status).toBe(401);
    expect(prepare).not.toHaveBeenCalled();
    expect(clientPortalRequestOriginAllowed(new Request(`${portal}/api/client/profile`, { method: "POST", headers: { Origin: portal } }), configuration)).toBe(true);
    const old = configuration.CLIENT_PORTAL_RETIRED_ORIGINS;
    expect(clientPortalRequestOriginAllowed(new Request(`${old}/api/client/profile`, { method: "POST", headers: { Origin: old } }), configuration)).toBe(false);
    expect(requestHostAllowed(`${old}/api/client/profile`, configuration)).toBe(false);
    const native = await worker.fetch(new Request(`${portal}/api/client/operations/data/deliveries`),
      { ...configuration, CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: "true", DELIVERY_DB: { prepare } } as unknown as Env, context);
    expect(native.status).toBe(401);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("preserves the canonical public share routes without widening a retired staging host", async () => {
    const configuration = migration(environment), old = configuration.CLIENT_PORTAL_RETIRED_ORIGINS;
    const assets = vi.fn(async () => new Response("existing public link app shell"));
    const env = { ...configuration, ASSETS: { fetch: assets } } as unknown as Env;
    const origins = configuredPublicRequestOrigins(configuration)!;
    expect(origins).toEqual(environment === "production" ? [configuration.PUBLIC_SHARE_ORIGIN, old] : [configuration.PUBLIC_SHARE_ORIGIN]);
    for (const origin of origins) {
      for (const path of ["/s/existing-public-link?folder=current", "/client-share/existing-client-link"]) {
        const response = await worker.fetch(new Request(`${origin}${path}`), env, context);
        expect(response.status).toBe(200);
        expect(response.headers.get("Location")).toBeNull();
      }
      expect((await worker.fetch(new Request(`${origin}/api/public/shares/existing-public-link/manifest`), env, context)).status).toBe(401);
      expect(() => requireSameOrigin(new Request(`${origin}/api/public/shares/existing-public-link/session`,
        { method: "POST", headers: { Origin: origin } }), env)).not.toThrow();
    }
    if (environment === "staging") {
      for (const path of ["/s/existing-public-link", "/client-share/existing-client-link", "/api/public/shares/existing-public-link/manifest"])
        expect((await worker.fetch(new Request(`${old}${path}`), env, context)).status).toBe(404);
    }
  });

  it("accepts existing bearer cookies on their original share host and still rechecks the current share version", async () => {
    const configuration = migration(environment), expiresAt = Date.now() + 4 * 60 * 60_000;
    const cookie = await createSessionCookie(configuration.DELIVERY_SESSION_SECRET, configuration.SESSION_KEY_ID, "existing-share", 7, expiresAt);
    const cookieHeader = cookie.split(";")[0];
    if (!cookieHeader) throw new Error("Expected a signed session cookie header");
    let currentVersion = 7;
    const first = vi.fn(async () => ({ id: "existing-share", public_id: "existing-public-link", share_version: currentVersion,
      project_exists: 1, project_active: 1, revoked_at: null, revoked_reason: null, expires_at: null, unavailable_since: null,
      r2_object_key: "retained-photo.jpg", image_location_map_enabled: 0 }));
    const statement = { bind: () => statement, first };
    const prepare = vi.fn(() => statement);
    const env = { ...configuration, DELIVERY_DB: { prepare },
      DATA_BUCKET: { head: async () => ({ key: "retained-photo.jpg" }) },
      AUDIT_IP_SECRET: "unchanged-audit-secret-at-least-32-characters",
      PUBLIC_MANIFEST_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as Env;
    const origin = environment === "production" ? configuration.CLIENT_PORTAL_RETIRED_ORIGINS : configuration.PUBLIC_SHARE_ORIGIN;
    const request = () => new Request(`${origin}/api/public/shares/existing-public-link/locations`, { headers: { Cookie: cookieHeader } });
    const response = await worker.fetch(request(), env, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBeNull();
    await expect(response.json()).resolves.toEqual({ locations: { points: [], imageCount: 0, truncated: false }, mapboxPublicToken: null });
    expect(first).toHaveBeenCalledTimes(1);
    currentVersion = 8;
    expect((await worker.fetch(request(), env, context)).status).toBe(401);
  });
});

it("rejects malformed retired aliases without adding them to public access", () => {
  const configuration = migration("staging");
  for (const retired of [configuration.CLIENT_PORTAL_ORIGIN, "http://old.example", "https://old.example/path",
    "https://old.example,https://old.example", "https://old.example,"]) {
    const env = { ...configuration, CLIENT_PORTAL_RETIRED_ORIGINS: retired };
    expect(configuredRetiredPortalOrigins(env)).toBeNull();
    expect(requestHostAllowed(`${configuration.CLIENT_PORTAL_ORIGIN}/api/client/session`, env)).toBe(false);
    expect(configuredPublicRequestOrigins(env)).toEqual([configuration.PUBLIC_SHARE_ORIGIN]);
  }
});

it("admits only the exact canonical native deployment profile/origin pair", () => {
  const configuration = migration("production");
  expect(nativeDeliveryDeploymentEnabled(configuration)).toBe(true);
  expect(nativeDeliveryDeploymentEnabled({ ...configuration,
    CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE: NATIVE_DELIVERY_PRODUCTION_PROFILE })).toBe(false);
  expect(nativeDeliveryDeploymentEnabled({ ...configuration, CLIENT_PORTAL_ORIGIN: "https://client.ledgetopdroneservices.com" })).toBe(false);
  expect(nativeDeliveryDeploymentEnabled(migration("staging"))).toBe(true);
  expect(nativeDeliveryDeploymentEnabled({ ...migration("staging"), CLIENT_PORTAL_ORIGIN: "https://other-staging.example" })).toBe(false);
});
