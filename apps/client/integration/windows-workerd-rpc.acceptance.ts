import { expect, it, vi } from "vitest";
// Node-only bootstrap imports a publication writer platform class. Fresh esbuild output
// is not transformed by Vitest: Workerd resolves its real cloudflare:workers base.
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { workerdRpcTransportFixture } from "./windows-workerd-rpc.fixture";
it("actual named Ops Workerd RPC and actual Client composition enforce current synthetic D1 authority", async () => {
  const f = await workerdRpcTransportFixture();
  try {
    expect(f.fullOpsComposition).toBe(true);
    expect(await f.rpc()).toMatchObject({ ok: true, protocolVersion: 1 });
    expect(await f.rpc({ feature: "folder.list" })).toMatchObject({ ok: true, feature: "folder.list" });
    expect(await f.rpc({ disabled: true })).toMatchObject({ ok: false, code: "disabled" });
    expect(await f.rpc({ wire: "{}" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await f.rpc({ feature: "file.download" })).toMatchObject({ ok: false, code: "invalid" });
    const response = await f.fetch(new Request(f.workerOrigin + "/api/client/operations/data/windows-catalog/deliveries", { headers: { "Cf-Access-Jwt-Assertion": f.token } }));
    expect(response.status).toBe(200); expect((await response.json()).items).toHaveLength(1);
    await f.revoke();
    expect(await f.rpc()).toMatchObject({ ok: false, code: "denied" });
    const denied = await f.fetch(new Request(f.workerOrigin + "/api/client/operations/data/windows-catalog/deliveries", { headers: { "Cf-Access-Jwt-Assertion": f.token } }));
    expect(denied.status).toBe(404);
    expect(f.observations.jwksRequests).toBeGreaterThan(0); expect(f.observations.forbiddenNetwork).toEqual([]);
    console.log(JSON.stringify({ kind: "local-workerd-rpc-v1", actualNamedEntrypoint: true, actualClientComposition: true, fullOpsComposition: f.fullOpsComposition, opsOnlyRevokeDenied: true, localOnly: true, bundles: f.bundles, observations: f.observations }));
  } finally { await f.runtime.dispose(); }
});
