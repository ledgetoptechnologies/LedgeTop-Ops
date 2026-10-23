import { expect, it } from "vitest";
import { employeeWorkerdTransportFixture, employeeWorkerdGatewayOrigin } from "./windows-employee-workerd.fixture";

it("full employee Ops Workerd verifies real RS256 identity and native D1 admission/grants before gateway access", async () => {
  const rootId = "11111111-1111-4111-8111-111111111111", gatewayId = "22222222-2222-4222-8222-222222222222";
  const observed: string[] = [];
  const f = await employeeWorkerdTransportFixture({ rootId, gatewayId, fingerprint: "a".repeat(64), gatewayOrigin: employeeWorkerdGatewayOrigin,
    gatewayKey: new Uint8Array(32).fill(73), outboundGateway: async request => {
      expect(request.url).toBe(employeeWorkerdGatewayOrigin + "/v1/read"); expect(request.method).toBe("POST");
      expect(request.headers.has("Cf-Access-Jwt-Assertion")).toBe(false); expect(request.headers.has("Cf-Access-Token")).toBe(false);
      const body = await request.json() as { operation: string }; observed.push(body.operation);
      // Explicit unavailable gateway is not fabricated file/list proof. Real TLS/Docker bytes are a separate harness.
      return new Response("Owned gateway unavailable in boundary-only acceptance", { status: 503 });
    } });
  const fetch = (path: string, token = f.token) => f.fetch(new Request(f.opsOrigin + path, { headers: { "Cf-Access-Jwt-Assertion": token } }));
  try {
    expect(f.fullOpsComposition).toBe(true); expect(f.bundle.exports).toHaveLength(17);
    const roots = await fetch("/api/staff/files/roots"); expect(roots.status).toBe(200);
    expect((await roots.json() as { roots: unknown[] }).roots).toEqual([{ rootId, gatewayId, displayName: "Synthetic PC container files" }]);
    const bob = await fetch("/api/staff/files/roots", f.otherToken); expect(bob.status).toBe(200); expect((await bob.json() as { roots: unknown[] }).roots).toEqual([]);
    expect((await fetch(`/api/staff/files/roots/${rootId}/entries?path=`, f.otherToken)).status).toBe(403);
    const parts = f.token.split("."); parts[2] = (parts[2]![0] === "A" ? "B" : "A") + parts[2]!.slice(1);
    expect((await fetch("/api/staff/files/roots", parts.join("."))).status).toBe(401);
    expect(f.observations.gatewayRequests).toBe(0);
    expect((await fetch(`/api/staff/files/roots/${rootId}/entries?path=`)).status).toBe(503);
    expect(observed).toEqual(["list"]); expect(f.observations.gatewayRequests).toBe(1);
    await f.revoke();
    expect((await fetch(`/api/staff/files/roots/${rootId}/entries?path=`)).status).toBe(403);
    expect(f.observations.gatewayRequests).toBe(1); expect(f.observations.jwksRequests).toBeGreaterThan(0);
    expect(f.observations.forbiddenNetwork).toEqual([]);
  } finally { await f.runtime.dispose(); }
});
