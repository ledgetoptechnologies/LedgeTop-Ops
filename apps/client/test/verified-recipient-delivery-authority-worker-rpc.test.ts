import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ready = {
  ENVIRONMENT: "staging",
  EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com",
  CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_WRITER_ENABLED: "true",
  CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_STATUS_ENABLED: "true",
};
const variants = [
  { name: "production", bindings: { ...ready, ENVIRONMENT: "production" }, code: "disabled" },
  { name: "missing-environment", bindings: Object.fromEntries(
    Object.entries(ready).filter(([key]) => key !== "ENVIRONMENT")), code: "disabled" },
  { name: "wrong-host", bindings: { ...ready, EXPECTED_HOST: "portal.ledgetopdroneservices.com" }, code: "disabled" },
  { name: "default-off", bindings: { ...ready,
    CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_WRITER_ENABLED: "false",
    CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_STATUS_ENABLED: "false" }, code: "disabled" },
  { name: "missing-flags", bindings: { ENVIRONMENT: ready.ENVIRONMENT,
    EXPECTED_HOST: ready.EXPECTED_HOST }, code: "disabled" },
  { name: "staging", bindings: ready, code: "invalid" },
];

describe("verified-recipient named RPC in the actual Workers runtime", () => {
  let runtime: Miniflare;
  beforeAll(async () => {
    // Bundle the actual module without mocking cloudflare:workers or storage.
    // No build artifact dependency: CI runs application tests before app build.
    const result = await build({
      configFile: false, logLevel: "silent",
      ssr: { noExternal: true },
      build: { ssr: fileURLToPath(new URL("../src/worker/verified-recipient-delivery-authority-entrypoint.ts", import.meta.url)),
        target: "esnext", write: false, minify: false,
        rollupOptions: { external: id => id.startsWith("cloudflare:") } },
    });
    const output = Array.isArray(result) ? result[0] : result;
    if (!output || !("output" in output)) throw new Error("RPC test bundle missing");
    const chunk = output.output.find(item => item.type === "chunk" && item.isEntry);
    if (!chunk || chunk.type !== "chunk") throw new Error("RPC test entrypoint missing");
    runtime = new Miniflare({ workers: [
      { name: "rpc-driver", modules: true, compatibilityDate: "2026-07-16",
        serviceBindings: Object.fromEntries(variants.map(candidate => [candidate.name,
          { name: `authority-${candidate.name}`, entrypoint: "VerifiedRecipientDeliveryAuthorityIngress" }])),
        script: `export default { async fetch(request, env) {
          const [name, action] = new URL(request.url).pathname.split('/').slice(1);
          if (!Object.hasOwn(env, name)) return new Response(null, {status: 404});
          const authority = env[name];
          if (action === 'http') return authority.fetch(request);
          const result = action === 'apply'
            ? await authority.applyAuthority({unexpected: true})
            : await authority.getAuthorityStatus({unexpected: true});
          return Response.json(result);
        } };` },
      ...variants.map(candidate => (
      { name: `authority-${candidate.name}`, modules: true, compatibilityDate: "2026-07-16",
        compatibilityFlags: ["nodejs_compat"], script: chunk.code, bindings: candidate.bindings }
      )),
    ] });
  }, 60_000);
  afterAll(async () => { if (runtime) await runtime.dispose(); });

  for (const candidate of variants) it(`${candidate.name} preserves its gate over real named RPC without a database`, async () => {
    for (const action of ["apply", "status"]) {
      const response = await runtime.dispatchFetch(`https://rpc.example.test/${candidate.name}/${action}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: false,
        protocol: "verified-recipient-delivery-authority", protocolVersion: 1,
        code: candidate.code, retryable: candidate.code === "disabled" });
    }
    // The private entrypoint must not turn HTTP access into authority access.
    const response = await runtime.dispatchFetch(`https://rpc.example.test/${candidate.name}/http`);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
