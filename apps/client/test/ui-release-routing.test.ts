import { describe, expect, it, vi } from "vitest";

const release = vi.hoisted(() => {
  const id = "a".repeat(40), prefix = `/_ui/client/${id}`;
  const html = "<p>new portal</p>", js = "export{};";
  const manifest = { schemaVersion: 1, application: "client", releaseId: id, files: [
    { path: "/index.html", size: html.length, mime: "text/html", sha256: "0".repeat(64) },
    { path: "/assets/main.js", size: js.length, mime: "text/javascript", sha256: "1".repeat(64) },
  ] };
  return { id, prefix, html, js, manifest };
});
vi.mock("../../../packages/shared/src/ui-release-catalog", () => ({
  findUiReleaseManifest: (app: string, id: unknown) => app === "client" && id === release.id ? release.manifest : null,
  uiReleaseForRequest: (app: string, value: string | URL) => app === "client" && new URL(value).pathname.startsWith(`${release.prefix}/`) ? release.manifest : null,
}));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {} }));
import worker from "../src/worker/index";
import { clientPortalRequestOriginAllowed, clientUiReleaseOriginAllowed, requestHostAllowed, requestNamespace } from "../src/worker/origin-policy";
import { selectedClientUiReleaseShell } from "../src/worker/ui-release-routes";
import type { Env } from "../src/worker/types";

const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
function fixture() {
  const portal = "https://portal.example.test", alias = "https://portal-alias.example.test";
  const publicOrigin = "https://delivery.example.test", legacy = "https://legacy.example.test", retired = "https://retired.example.test";
  const assets = vi.fn(async () => new Response("retained legacy shell", { headers: { "Content-Type": "text/html" } }));
  const fetchRelease = vi.fn(async (input: RequestInfo | URL) => {
    const request = input as Request, shell = new URL(request.url).pathname.endsWith("/index.html");
    return new Response(request.method === "HEAD" ? null : shell ? release.html : release.js,
      { headers: { "Content-Type": shell ? "text/html" : "text/javascript", "Content-Length": String(shell ? release.html.length : release.js.length) } });
  });
  const prepare = vi.fn(() => { throw new Error("UI presentation must not query private storage"); });
  const env = { ENVIRONMENT: "production", EXPECTED_HOST: "delivery.example.test", PUBLIC_BASE_URL: publicOrigin,
    PUBLIC_SHARE_ORIGIN: publicOrigin, CLIENT_PORTAL_ORIGIN: portal, CLIENT_PORTAL_ORIGINS: `${portal},${alias},${publicOrigin}`,
    LEGACY_CLIENT_ORIGINS: `${legacy},${retired}`, CLIENT_PORTAL_RETIRED_ORIGINS: retired,
    CLIENT_PORTAL_ENABLED: "true", CLIENT_ACCESS_TEAM_DOMAIN: "https://auth.example.test", CLIENT_ACCESS_AUD: "portal-audience",
    ASSETS: { fetch: assets }, UI_RELEASE_ASSETS: { fetch: fetchRelease }, DELIVERY_DB: { prepare } } as unknown as Env;
  const request = (path: string, init?: RequestInit, origin = portal) => worker.fetch(new Request(`${origin}${path}`, init), env, context);
  return { env, portal, alias, publicOrigin, legacy, retired, assets, fetchRelease, prepare, request };
}

describe("Client additive UI routing through real Hono admission", () => {
  it.each([undefined, ""])("retains the original shell for default-off selector %s", async selector => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = selector;
    for (const path of ["/portal", "/portal/viewer/native/workspace/project/association/model"]) {
      const response = await f.request(path);
      expect(response.status).toBe(200); expect(await response.text()).toBe("retained legacy shell");
      expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    }
    expect(f.assets).toHaveBeenCalledTimes(2); expect(f.fetchRelease).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });

  it("selects a registered shell for portal deep links and strips credentials/query upstream", async () => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = release.id;
    const response = await f.request("/portal/viewer/native/workspace/project/association/model?workspace=private", {
      headers: { Cookie: "portal-session=private", Authorization: "Bearer private", Referer: `${f.portal}/portal/private` },
    });
    expect(response.status).toBe(200); expect(await response.text()).toBe(release.html);
    expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'"); expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    const sent = f.fetchRelease.mock.calls[0]![0] as Request;
    expect(sent.url).toBe(`https://ui-release.invalid${release.prefix}/index.html`);
    expect([...sent.headers]).toEqual([]); expect(f.assets).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });

  it.each([" ", "unknown", "b".repeat(40)])("fails closed for invalid nonempty selector %s", async selector => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = selector;
    const response = await f.request("/portal"); expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(f.assets).not.toHaveBeenCalled(); expect(f.fetchRelease).not.toHaveBeenCalled();
  });

  it("requires the optional binding for active HTML without touching installed legacy assets", async () => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = release.id; delete f.env.UI_RELEASE_ASSETS;
    expect((await f.request("/portal")).status).toBe(503);
    expect((await f.request(`${release.prefix}/assets/main.js`)).status).toBe(503);
    expect((await f.request("/assets/retained.js")).status).toBe(200); expect(f.assets).toHaveBeenCalledTimes(1);
  });

  it("serves registered assets independently of HTML rollback and rejects wrong app/release/file", async () => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = "invalid-selector";
    const response = await f.request(`${release.prefix}/assets/main.js?private=query`, { headers: { Cookie: "private" } });
    expect(response.status).toBe(200); expect(await response.text()).toBe(release.js);
    expect(response.headers.get("Cache-Control")).toContain("immutable");
    const sent = f.fetchRelease.mock.calls[0]![0] as Request;
    expect(sent.url).toBe(`https://ui-release.invalid${release.prefix}/assets/main.js`); expect([...sent.headers]).toEqual([]);
    for (const path of [release.prefix.replace("/client/", "/operations/") + "/assets/main.js", `/_ui/client/${"b".repeat(40)}/assets/main.js`, `${release.prefix}/unknown.js`, "/_ui"]) {
      const denied = await f.request(path); expect(denied.status).toBe(404); expect(denied.headers.get("Location")).toBeNull();
    }
    expect(f.fetchRelease).toHaveBeenCalledTimes(1);
    f.env.UI_ACTIVE_RELEASE = "";
    expect(await (await f.request("/portal")).text()).toBe("retained legacy shell");
    expect(await (await f.request(`${release.prefix}/assets/main.js`)).text()).toBe(release.js);
  });

  it("keeps release namespace portal-only without redirects on public, legacy or retired hosts", async () => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = release.id;
    expect(requestNamespace(`${release.prefix}/assets/main.js`)).toBe("ui-release");
    for (const origin of [f.publicOrigin, f.legacy, f.retired, "https://unrelated.example.test"]) {
      expect(clientUiReleaseOriginAllowed(`${origin}${release.prefix}/assets/main.js`, f.env)).toBe(false);
      const response = await f.request(`${release.prefix}/assets/main.js`, undefined, origin);
      expect(response.status).toBe(404); expect(response.headers.get("Location")).toBeNull();
    }
    expect(clientUiReleaseOriginAllowed(`${f.alias}/portal`, f.env)).toBe(true);
    expect((await f.request(`${release.prefix}/assets/main.js`, undefined, f.alias)).status).toBe(200);
  });

  it("preserves public links, onboarding presentation, legacy assets and portal redirects", async () => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = release.id; f.env.CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED = "true";
    for (const origin of [f.publicOrigin, f.legacy]) for (const path of ["/s/retained-link", "/client-share/retained-link", "/assets/retained.js"]) {
      expect(await (await f.request(path, undefined, origin)).text()).toBe("retained legacy shell");
    }
    expect(await (await f.request("/onboarding/invitation-one")).text()).toBe("retained legacy shell");
    const root = await f.request("/"); expect(root.status).toBe(302); expect(root.headers.get("Location")).toBe(`${f.portal}/portal`);
    const oldPortal = await f.request("/portal/viewer/existing", undefined, f.legacy);
    expect(oldPortal.status).toBe(308); expect(oldPortal.headers.get("Location")).toBe(`${f.portal}/portal/viewer/existing`);
    expect(f.fetchRelease).not.toHaveBeenCalled();
    expect(await selectedClientUiReleaseShell(new Request(`${f.portal}/api/client/session`), f.env)).toBeNull();
  });

  it("handles HEAD, unsupported methods and upstream MIME/error responses with security headers", async () => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = release.id;
    for (const path of ["/portal", `${release.prefix}/assets/main.js`]) {
      const response = await f.request(path, { method: "HEAD" }); expect(response.status).toBe(200); expect(await response.text()).toBe("");
    }
    const denied = await f.request(`${release.prefix}/assets/main.js`, { method: "POST", body: "private" });
    expect(denied.status).toBe(405); expect(denied.headers.get("Allow")).toBe("GET, HEAD");
    f.fetchRelease.mockImplementationOnce(async () => new Response("fallback HTML", { headers: { "Content-Type": "text/html" } }));
    const mime = await f.request(`${release.prefix}/assets/main.js`); expect(mime.status).toBe(502); expect(mime.headers.get("Cache-Control")).toBe("no-store");
    expect(mime.headers.get("X-Content-Type-Options")).toBe("nosniff");
    f.fetchRelease.mockImplementationOnce(async () => { throw new Error("private upstream error"); });
    const failed = await f.request("/portal"); expect(failed.status).toBe(502); expect(await failed.text()).not.toContain("private");
  });

  it("does not widen API origins, session admission or CSRF", async () => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = release.id;
    expect((await f.request("/api/client/session")).status).toBe(401);
    expect((await f.request("/api/client/session", undefined, f.retired)).status).toBe(404);
    expect(requestHostAllowed(`${f.alias}/api/client-onboarding/invitation/session`, f.env)).toBe(false);
    expect(clientPortalRequestOriginAllowed(new Request(`${f.portal}/api/client/profile`, { method: "POST", headers: { Origin: f.alias } }), f.env)).toBe(false);
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.fetchRelease).not.toHaveBeenCalled();
  });
});
