import { expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {} }));
import worker from "../src/worker/index";
import { findUiReleaseManifest } from "../../../packages/shared/src/ui-release-catalog";
import type { Env } from "../src/worker/types";

it("routes HEAD presentation and retained assets using the real checked-in Client release pin", async () => {
  const id = "cfcf5cf992084f7b3658763cdf362fbc37101665", manifest = findUiReleaseManifest("client", id);
  expect(manifest).not.toBeNull();
  const prefix = `/_ui/client/${id}`, js = manifest!.files.find(file => file.path.endsWith(".js"))!;
  expect(js).toBeDefined();
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const request = input as Request, url = new URL(request.url);
    const file = manifest!.files.find(file => url.pathname === prefix + file.path)!;
    expect(file).toBeDefined(); expect(request.method).toBe("HEAD"); expect([...request.headers]).toEqual([]);
    return new Response(null, { headers: { "Content-Type": file.mime, "Content-Length": String(file.size) } });
  });
  const env = { ENVIRONMENT: "production", EXPECTED_HOST: "delivery.example.test", PUBLIC_BASE_URL: "https://delivery.example.test",
    PUBLIC_SHARE_ORIGIN: "https://delivery.example.test", CLIENT_PORTAL_ORIGIN: "https://portal.example.test",
    UI_ACTIVE_RELEASE: id, UI_RELEASE_ASSETS: { fetch }, ASSETS: { fetch: vi.fn(() => { throw new Error("No legacy fallback"); }) } } as unknown as Env;
  const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const shell = await worker.fetch(new Request("https://portal.example.test/portal/viewer/native/workspace/project/association/model?private=1", { method: "HEAD", headers: { Cookie: "private" } }), env, context);
  expect(shell.status).toBe(200); expect(shell.headers.get("Cache-Control")).toBe("no-store");
  expect((fetch.mock.calls[0]![0] as Request).url).toBe(`https://ui-release.invalid${prefix}/index.html`);
  env.UI_ACTIVE_RELEASE = "";
  const asset = await worker.fetch(new Request(`https://portal.example.test${prefix}${js.path}`, { method: "HEAD" }), env, context);
  expect(asset.status).toBe(200); expect(asset.headers.get("Content-Length")).toBe(String(js.size));
  expect(asset.headers.get("Cache-Control")).toContain("immutable"); expect(env.ASSETS.fetch).not.toHaveBeenCalled();
});
