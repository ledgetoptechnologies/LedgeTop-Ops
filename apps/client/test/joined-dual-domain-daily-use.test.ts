import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

import deliveryWorker, { requestHostAllowed } from "../src/worker/index";
import { clientPortalRequestOriginAllowed } from "../src/worker/origin-policy";

const env = {
  ENVIRONMENT: "production",
  EXPECTED_HOST: "portal.drone.test",
  PUBLIC_BASE_URL: "https://portal.drone.test",
  PUBLIC_SHARE_ORIGIN: "https://portal.drone.test",
  CLIENT_PORTAL_ORIGIN: "https://portal.drone.test",
  CLIENT_PORTAL_ORIGINS: "https://portal.drone.test,https://portal.technology.test",
  LEGACY_CLIENT_ORIGINS: "https://client.drone.test",
} as const;

const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("J7 dual-domain authority boundary", () => {
  it.each(["portal.drone.test", "portal.technology.test"])("admits authenticated daily-use routes on %s", host => {
    for (const path of ["/portal", "/portal/projects/project-one?workspace=workspace-one", "/api/client/session", "/assets/client.js"])
      expect(requestHostAllowed(`https://${host}${path}`, env)).toBe(true);
  });

  it("keeps the public and producer namespaces off the secondary presentation host", () => {
    for (const path of ["/s/public-one", "/api/public/shares/public-one/manifest", "/client-share/client-one"])
      expect(requestHostAllowed(`https://portal.drone.test${path}`, env)).toBe(true);
    for (const path of ["/s/public-one", "/api/public/shares/public-one/manifest", "/client-share/client-one", "/api/internal/project-alpha/portal-v2"])
      expect(requestHostAllowed(`https://portal.technology.test${path}`, env)).toBe(false);
    expect(requestHostAllowed("https://portal.drone.test/api/internal/project-alpha/portal-v2", env)).toBe(true);
  });

  it.each(["portal.drone.test", "portal.technology.test"])("requires the exact same-origin portal mutation on %s", host => {
    const url = `https://${host}/api/client/v2/workspaces/workspace-one/feedback`;
    expect(clientPortalRequestOriginAllowed(new Request(url, { method: "POST", headers: { Origin: `https://${host}` } }), env)).toBe(true);
    expect(clientPortalRequestOriginAllowed(new Request(url, { method: "POST", headers: { Origin: "https://portal.attacker.test" } }), env)).toBe(false);
  });

  it.each(["portal.drone.test", "portal.technology.test"])("does not treat the hostname as client identity on %s", async host => {
    const response = await deliveryWorker.fetch(new Request(`https://${host}/api/client/session`), env as never, context);
    expect([401, 403, 404]).toContain(response.status);
    await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) });
  });

  it("serves both portal shells while rejecting a public-share path on the secondary host", async () => {
    const assets = vi.fn(async (input: RequestInfo | URL) => new Response(new URL(input instanceof Request ? input.url : input.toString()).pathname));
    const configured = { ...env, ASSETS: { fetch: assets } } as never;
    for (const host of ["portal.drone.test", "portal.technology.test"]) {
      const response = await deliveryWorker.fetch(new Request(`https://${host}/portal/projects?workspace=workspace-one`), configured, context);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("/portal/projects");
    }
    const rejected = await deliveryWorker.fetch(new Request("https://portal.technology.test/s/public-one"), configured, context);
    expect(rejected.status).toBe(404);
  });
});
