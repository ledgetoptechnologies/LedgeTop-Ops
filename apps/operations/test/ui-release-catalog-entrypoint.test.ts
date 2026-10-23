import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
import worker from "../src/worker/index";
import { findUiReleaseManifest } from "../../../packages/shared/src/ui-release-catalog";
import { uiReleasePrefix } from "../../../packages/shared/src/ui-release-assets";
import type { Env } from "../src/worker/types";

const id = "cfcf5cf992084f7b3658763cdf362fbc37101665", origin = "https://ops.ledgetop.app";
const context = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

describe("registered Operations candidate at the actual Worker boundary", () => {
  it.each(["shell", "immutable asset after selector rollback"])("routes a real catalog HEAD: %s", async mode => {
    // The catalog's real hashes and file list are used, without mocking the
    // registry. HEAD verifies routing/metadata; native artifact byte tests
    // separately verify the catalog digests against the actual built files.
    const manifest = findUiReleaseManifest("operations", id)!;
    expect(manifest).not.toBeNull();
    const prefix = uiReleasePrefix(manifest);
    const file = manifest.files.find(entry => mode === "shell" ? entry.path === "/index.html" : entry.path.endsWith(".js"))!;
    const fetchRelease = vi.fn(async (_input: RequestInfo | URL) => new Response(null,
      { headers: { "Content-Type": file.mime, "Content-Length": String(file.size) } }));
    const legacy = vi.fn();
    const env = { ENVIRONMENT: "production", EXPECTED_HOST: "ops.ledgetop.app", PUBLIC_BASE_URL: origin,
      UI_ACTIVE_RELEASE: mode === "shell" ? id : "", ASSETS: { fetch: legacy },
      UI_RELEASE_ASSETS: { fetch: fetchRelease } } as unknown as Env;
    const path = mode === "shell" ? "/viewer/session/association/model?private=query" : `${prefix}${file.path}`;
    const response = await worker.fetch!(new Request(`${origin}${path}`, { method: "HEAD", headers: { Accept: "text/html" } }), env, context);
    expect(response.status).toBe(200); expect(await response.text()).toBe("");
    expect(response.headers.get("Content-Type")).toBe(file.mime); expect(response.headers.get("Content-Length")).toBe(String(file.size));
    expect(fetchRelease).toHaveBeenCalledTimes(1);
    const sent = fetchRelease.mock.calls[0]![0] as Request;
    expect(sent.url).toBe(`https://ui-release.invalid${prefix}${file.path}`);
    expect(sent.method).toBe("HEAD"); expect(legacy).not.toHaveBeenCalled();
  });
});
