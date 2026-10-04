import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const productionBindings = {
  ENVIRONMENT: "production",
  EXPECTED_HOST: "portal.ledgetopdroneservices.com",
  CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "false",
};

describe("operations publication export from the production Client main module", () => {
  let runtime: Miniflare;
  beforeAll(async () => {
    // Run the checked-in Cloudflare Vite production build. A config-free SSR
    // bundle does not represent the module uploaded by this application.
    const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const built = spawnSync(process.execPath, [path.join(clientRoot, "scripts", "build.mjs")], {
      cwd: clientRoot, encoding: "utf8", timeout: 120_000,
      env: { ...process.env, WRANGLER_WRITE_LOGS: "false" },
    });
    if (built.status !== 0) throw new Error(`production Client build failed: ${built.stderr.slice(0, 1000)}`);
    const productionScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
      "../dist/ledgetop_clients/index.js");
    runtime = new Miniflare({ workers: [
      { name: "production-main-caller", modules: true, compatibilityDate: "2026-07-16",
        compatibilityFlags: ["nodejs_compat"],
        serviceBindings: { PUBLICATION: { name: "production-main",
          entrypoint: "OperationsPortalWorkspacePublicationIngress" } },
        script: `function response(value) {
          const primitive = typeof value === 'string';
          return new Response(primitive ? value : JSON.stringify(value), {headers: {
            'content-type': 'application/json', 'x-rpc-result-type': typeof value,
            'x-rpc-result-symbol-count': primitive ? '0' : String(Object.getOwnPropertySymbols(value).length)}});
        }
        export default { async fetch(request, env) {
          const action = new URL(request.url).pathname.slice(1);
          if (action === 'http') return env.PUBLICATION.fetch(request);
          const body = await request.text();
          if (new TextEncoder().encode(body).byteLength > 20000) return new Response(null, {status: 413});
          const input = JSON.parse(body);
          if (action === 'publish') return response(await env.PUBLICATION.publishWorkspace(input));
          if (action === 'status') return response(await env.PUBLICATION.getPublicationStatus(input));
          if (action === 'disposition') return response(await env.PUBLICATION.getPublicationDisposition(input));
          if (action === 'cancel') return response(await env.PUBLICATION.cancelWorkspacePublication(input));
          return new Response(null, {status: 404});
        } };` },
      { name: "production-main", modules: true, compatibilityDate: "2026-07-16",
        compatibilityFlags: ["nodejs_compat"], scriptPath: productionScript, bindings: productionBindings,
        d1Databases: { DELIVERY_DB: crypto.randomUUID() },
        r2Buckets: ["DATA_BUCKET"],
      },
    ] });
  }, 180_000);
  afterAll(async () => { if (runtime) await runtime.dispose(); });

  async function call(action: string, body: unknown) {
    return runtime.dispatchFetch(`https://production-main.example.test/${action}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  it("keeps all four named RPC methods primitive and default-off before storage", async () => {
    const database = await runtime.getD1Database("DELIVERY_DB", "production-main");
    await database.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all();
    const schema = async () => (await database.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all()).results;
    const before = await schema();
    for (const action of ["publish", "status", "disposition", "cancel"]) {
      const result = await call(action, { unexpected: true });
      expect(result.status).toBe(200);
      expect(result.headers.get("x-rpc-result-type")).toBe("string");
      expect(result.headers.get("x-rpc-result-symbol-count")).toBe("0");
      expect(await result.json()).toEqual({ ok: false, protocol: "operations-portal-workspace-publication",
        protocolVersion: 1, code: "disabled", retryable: true });
    }
    expect(await schema()).toEqual(before);
  });

  it("does not expose the private named entrypoint over HTTP", async () => {
    const result = await call("http", { ignored: true });
    expect(result.status).toBe(404);
    expect(result.headers.get("cache-control")).toBe("no-store");
  });
});
