import { describe, expect, it, vi } from "vitest";

const release = vi.hoisted(() => {
  const id = "a".repeat(40), prefix = `/_ui/operations/${id}`;
  const html = "<p>new Operations shell</p>", js = "export{};";
  return { id, prefix, html, js, manifest: { schemaVersion: 1, application: "operations", releaseId: id, files: [
    { path: "/index.html", size: html.length, mime: "text/html", sha256: "0".repeat(64) },
    { path: "/assets/main.js", size: js.length, mime: "text/javascript", sha256: "1".repeat(64) },
  ] } };
});
vi.mock("../../../packages/shared/src/ui-release-catalog", () => ({
  findUiReleaseManifest: (application: string, id: unknown) => application === "operations" && id === release.id ? release.manifest : null,
  uiReleaseForRequest: (application: string, value: string | URL) => application === "operations"
    && new URL(value).pathname.startsWith(`${release.prefix}/`) ? release.manifest : null,
}));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
import worker from "../src/worker/index";
import { dispatchOperationsUiReleaseRequest } from "../src/worker/ui-release-routes";
import type { Env } from "../src/worker/types";

const origin = "https://ops.ledgetop.app", alias = "https://ops.alias.example.test", incoming = "https://incoming.example.test";
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
function fixture() {
  const assets = vi.fn(async () => new Response("retained legacy Operations HTML", { headers: { "Content-Type": "text/html" } }));
  const fetchRelease = vi.fn(async (input: RequestInfo | URL) => {
    const request = input as Request, shell = new URL(request.url).pathname.endsWith("/index.html");
    return new Response(request.method === "HEAD" ? null : shell ? release.html : release.js,
      { headers: { "Content-Type": shell ? "text/html" : "text/javascript",
        "Content-Length": String(shell ? release.html.length : release.js.length) } });
  });
  const prepare = vi.fn(() => { throw new Error("UI presentation must not read private storage"); });
  const env = { ENVIRONMENT: "production", EXPECTED_HOST: "ops.ledgetop.app", PUBLIC_BASE_URL: origin,
    OPERATIONS_ORIGINS: `${origin},${alias}`, INCOMING_BASE_URL: incoming, INCOMING_EXPECTED_HOST: "incoming.example.test",
    TEAM_DOMAIN: "https://access.example.test", OPERATIONS_AUD: "staff-audience", OPERATIONS_SESSION_SECRET: "s".repeat(32),
    THUMBNAIL_RENDERER_EXPECTED_HOST: "ops.ledgetop.app", ASSETS: { fetch: assets },
    UI_RELEASE_ASSETS: { fetch: fetchRelease }, OPS_DB: { prepare } } as unknown as Env;
  const request = (path: string, init: RequestInit = {}, requestOrigin = origin) => worker.fetch!(
    new Request(`${requestOrigin}${path}`, { ...init, headers: { Accept: "text/html", ...init.headers } }), env, context);
  return { env, assets, fetchRelease, prepare, request };
}

describe("Operations additive UI through the actual Worker entrypoint", () => {
  it.each([undefined, ""])("retains legacy HTML for absent/empty selector %s", async selector => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = selector;
    for (const path of ["/", "/dashboard", "/viewer/session/association/model", "/operations/projects"]) {
      const response = await f.request(path);
      expect(response.status).toBe(200); expect(await response.text()).toBe("retained legacy Operations HTML");
    }
    expect(f.assets).toHaveBeenCalledTimes(4); expect(f.fetchRelease).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });

  it.each(["/", "/dashboard", "/viewer/session/association/model"])("selects registered HTML after normal host middleware: %s", async path => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = release.id;
    const response = await f.request(`${path}?private=query`, { headers: {
      Cookie: "staff-session=private", Authorization: "Bearer private", "Cf-Access-Jwt-Assertion": "private", Referer: `${origin}/private`,
    } });
    expect(response.status).toBe(200); expect(await response.text()).toBe(release.html);
    expect(response.headers.get("Cache-Control")).toBe("no-store"); expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
    const sent = f.fetchRelease.mock.calls[0]![0] as Request;
    expect(sent.url).toBe(`https://ui-release.invalid${release.prefix}/index.html`);
    expect([...sent.headers]).toEqual([]); expect(f.assets).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });

  it("preserves HTML HEAD without a body and uses an upstream HEAD", async () => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = release.id;
    const response = await f.request("/viewer/models", { method: "HEAD" });
    expect(response.status).toBe(200); expect(await response.text()).toBe("");
    expect(response.headers.get("Content-Length")).toBe(String(release.html.length));
    expect((f.fetchRelease.mock.calls[0]![0] as Request).method).toBe("HEAD");
  });

  it.each([" ", "unknown", "b".repeat(40)])("fails closed for invalid nonempty HTML selector %s", async selected => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = selected;
    const response = await f.request("/viewer"); expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(f.fetchRelease).not.toHaveBeenCalled(); expect(f.assets).not.toHaveBeenCalled();
  });

  it("requires the optional binding for selected HTML and registered immutable files", async () => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = release.id; delete f.env.UI_RELEASE_ASSETS;
    expect((await f.request("/viewer")).status).toBe(503);
    expect((await f.request(`${release.prefix}/assets/main.js`)).status).toBe(503);
    expect(f.assets).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "unknown"])("keeps registered files available independently of HTML selection %s", async selector => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = selector;
    const response = await f.request(`${release.prefix}/assets/main.js?private=discard`, { headers: { Cookie: "private", Authorization: "private" } });
    expect(response.status).toBe(200); expect(await response.text()).toBe(release.js);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    const sent = f.fetchRelease.mock.calls[0]![0] as Request;
    expect(sent.url).toBe(`https://ui-release.invalid${release.prefix}/assets/main.js`); expect([...sent.headers]).toEqual([]);
    expect(f.assets).not.toHaveBeenCalled();
  });

  it.each(["/assets/old.js", "/api", "/r/public-link", "/administration/staging/directory-maintenance-authority", "/unknown"])(
    "never treats the existing namespace as UI presentation: %s", async path => {
      const f = fixture(); f.env.UI_ACTIVE_RELEASE = release.id;
      expect(await dispatchOperationsUiReleaseRequest(new Request(`${origin}${path}`, { headers: { Accept: "text/html" } }), f.env)).toBeNull();
      expect((await f.request(path)).status).toBe(path === "/api" ? 401 : 404);
      expect(f.fetchRelease).not.toHaveBeenCalled(); expect(f.assets).not.toHaveBeenCalled();
    });

  it.each([
    `/_ui/operations/${"b".repeat(40)}/assets/main.js`, `/_ui/client/${release.id}/assets/main.js`,
    `${release.prefix}/unknown.js`, `${release.prefix}/%61ssets/main.js`, `${release.prefix}/index.html/extra`,
  ])("does not turn an unknown release/file into the SPA: %s", async path => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = release.id;
    expect((await f.request(path)).status).toBe(404); expect(f.fetchRelease).not.toHaveBeenCalled(); expect(f.assets).not.toHaveBeenCalled();
  });

  it.each([undefined, "", release.id, "invalid"])("retains admitted staff alias HTML independently of selection %s", async selected => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = selected;
    for (const path of ["/dashboard", "/viewer", "/viewer/session/association/model"]) {
      const response = await f.request(path, { headers: { "X-Forwarded-Host": "ops.ledgetop.app", "X-Forwarded-Proto": "https" } }, alias);
      expect(response.status).toBe(200); expect(await response.text()).toBe("retained legacy Operations HTML");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    }
    expect((await f.request(`${release.prefix}/assets/main.js`, {}, alias)).status).toBe(404);
    expect(f.assets).toHaveBeenCalledTimes(3); expect(f.fetchRelease).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });

  it("rejects untrusted origins even with forwarded host headers", async () => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = release.id;
    for (const host of ["https://attacker.example.test", "http://ops.ledgetop.app", "https://ops.ledgetop.app:8443",
      "http://ops.alias.example.test", "https://ops.alias.example.test:8443"])
      for (const path of ["/viewer", `${release.prefix}/assets/main.js`]) {
        const response = await f.request(path, { headers: { "X-Forwarded-Host": "ops.ledgetop.app", "X-Forwarded-Proto": "https" } }, host);
        expect(response.status).toBe(404);
      }
    expect(f.fetchRelease).not.toHaveBeenCalled(); expect(f.assets).not.toHaveBeenCalled();
  });

  it("serves only explicit HTML GET/HEAD presentation and immutable GET/HEAD assets", async () => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = release.id;
    for (const headers of [{ Accept: "application/json" }, { Accept: "text/html;q=0" }, { Accept: "*/*" }])
      expect((await f.request("/viewer", { headers })).status).toBe(404);
    expect((await f.request("/viewer", { method: "POST" })).status).toBe(404);
    const immutable = await f.request(`${release.prefix}/assets/main.js`, { method: "POST" });
    expect(immutable.status).toBe(405); expect(immutable.headers.get("Allow")).toBe("GET, HEAD");
    expect(f.fetchRelease).not.toHaveBeenCalled(); expect(f.assets).not.toHaveBeenCalled();
  });

  it("keeps normal API staff authentication and health handling ahead of UI fallback", async () => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = "invalid";
    for (const path of ["/api/unknown", "/api/admin/unknown", "/api/session"])
      expect((await f.request(path)).status).toBe(401);
    const health = await f.request("/health"); expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", service: "ltds-ops" });
    expect(f.fetchRelease).not.toHaveBeenCalled(); expect(f.assets).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
  });

  it("leaves Incoming, Viewer machine and thumbnail dispatch precedence unchanged", async () => {
    const f = fixture();
    for (const [host, path, method] of [
      [incoming, "/health", "GET"], [incoming, "/r/upload-request", "GET"], [incoming, "/api/viewer/events", "POST"],
      [origin, "/api/internal/thumbnail-ingest/v1", "POST"], [origin, "/api/internal/thumbnail-renderer/v1/claim", "POST"],
    ]) {
      const baseline = await f.request(path!, { method }, host);
      f.env.UI_ACTIVE_RELEASE = release.id;
      const selected = await f.request(path!, { method }, host);
      expect(selected.status).toBe(baseline.status); expect(await selected.text()).toBe(await baseline.text());
      delete f.env.UI_ACTIVE_RELEASE;
    }
    expect(f.fetchRelease).not.toHaveBeenCalled(); expect(f.assets).not.toHaveBeenCalled();
  });

  it.each([
    ["/administration/client-portal/operations-recipients", "CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED"],
    ["/administration/client-portal/operations-delivery-authority", "OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED"],
    ["/administration/client-portal/operations-workspaces", "OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED"],
    ["/administration/client-portal/operations-billing-authority", "OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED"],
    ["/administration/client-portal/operations-billing-permissions", "OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED"],
  ] as const)("does not bypass the existing default-off native-owner gate: %s", async (path, flag) => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = release.id;
    expect((await f.request(path)).status).toBe(404);
    f.env[flag] = "false"; expect((await f.request(path)).status).toBe(404);
    expect(f.fetchRelease).not.toHaveBeenCalled(); expect(f.assets).not.toHaveBeenCalled();
  });

  it("switches an admitted native-owner page only after its existing flag and origin checks", async () => {
    const f = fixture(); f.env.UI_ACTIVE_RELEASE = release.id;
    f.env.OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED = "true";
    const path = "/administration/client-portal/operations-delivery-authority";
    const response = await f.request(path); expect(response.status).toBe(200); expect(await response.text()).toBe(release.html);
    expect(f.fetchRelease).toHaveBeenCalledTimes(1);
    expect((await f.request(path, {}, alias)).status).toBe(404); expect(f.fetchRelease).toHaveBeenCalledTimes(1);
    const api = await f.request("/api/native-client-portal/operations-delivery-authority/session");
    expect(api.status).not.toBe(200); expect(f.fetchRelease).toHaveBeenCalledTimes(1); expect(f.assets).not.toHaveBeenCalled();
  });
});
