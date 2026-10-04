import { describe, expect, it, vi } from "vitest";
import { createOperationsHomeRouter } from "../src/worker/client-portal/operations-home-routes";
import type { Env } from "../src/worker/types";

const authority = "11111111-1111-4111-8111-111111111111";
const principal = { issuer: "https://access.example.test", subject: "person-one", email: "person@example.test" };
const path = `/home/${authority}`;
function fixture(allowed = true) {
  const statement = { bind: () => statement, all: vi.fn(async () => ({ success: true,
    results: allowed ? [{ authority_id: authority, workspace_id: "workspace-one", ownership_epoch: 1, grant_revision: 1 }] : [] })) };
  const rpc = vi.fn(async () => ({ ok: true, protocolVersion: 1, authorityId: authority,
    workspaceId: "workspace-one", ownershipEpoch: 1, grantRevision: 1,
    issuer: principal.issuer, subject: principal.subject,
    services: [{ serviceId: "service-one", providerId: "provider-one", displayLabel: "Inspection", revision: 1 }] }));
  // Isolated HTTP adapter fixture; actual SQL permission checks are exercised
  // against genuine ledger migrations in operations-service-home.test.ts.
  const env = { CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: "true",
    ENVIRONMENT: "staging", CLIENT_PORTAL_ORIGIN: "https://client.example.test",
    DELIVERY_DB: { withSession: () => ({ prepare: () => statement }) },
    CLIENT_PORTAL_SERVICE_METADATA_READER: { readServiceMetadata: rpc } } as unknown as Env;
  return { env, rpc, statement };
}
const request = (suffix = path, headers?: HeadersInit) => new Request(`https://client.example.test${suffix}`, { headers });

describe("independent Operations home HTTP admission", () => {
  it("discovers an exact service-only envelope without legacy workspace admission", async () => {
    const { env } = fixture();
    const response = await createOperationsHomeRouter({ resolvePrincipal: async () => principal })
      .fetch(request("/home", { "X-LTDS-Workspace-Id": "unrelated" }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resourceMode: "operations_home", homes: [{ authorityId: authority,
      workspaceId: "workspace-one", ownershipEpoch: 1, grantRevision: 1,
      services: [{ serviceId: "service-one", providerId: "provider-one", displayLabel: "Inspection", revision: 1 }] }] });
  });

  it("discovery distinguishes disabled from denied or unavailable without PA fallback", async () => {
    const router = createOperationsHomeRouter({ resolvePrincipal: async () => principal });
    const denied = fixture(false);
    expect((await router.fetch(request("/home"), denied.env)).status).toBe(403);
    const { env } = fixture();
    expect((await router.fetch(request("/home"), { ...env, CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: "false" })).status).toBe(404);
    expect((await router.fetch(request("/home"), { ...env, CLIENT_PORTAL_SERVICE_METADATA_READER: undefined })).status).toBe(503);
  });
  it("is default-off before any identity or storage lookup", async () => {
    const { env, rpc } = fixture();
    const resolvePrincipal = vi.fn(async () => principal);
    const router = createOperationsHomeRouter({ resolvePrincipal });
    for (const enabled of [undefined, "false"]) {
      const response = await router.fetch(request(), { ...env, CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: enabled });
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("requires client authentication and the configured portal origin", async () => {
    const { env, rpc } = fixture();
    const router = createOperationsHomeRouter({ resolvePrincipal: async () => null });
    expect((await router.fetch(request(), env)).status).toBe(401);
    expect((await router.fetch(new Request(`https://other.example.test${path}`), env)).status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("denies missing exact permission before RPC", async () => {
    const { env, rpc } = fixture(false);
    const response = await createOperationsHomeRouter({ resolvePrincipal: async () => principal }).fetch(request(), env);
    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns only label metadata without a PA session and ignores legacy workspace headers", async () => {
    const { env, rpc, statement } = fixture();
    const response = await createOperationsHomeRouter({ resolvePrincipal: async () => principal })
      .fetch(request(path, { "X-LTDS-Workspace-Id": "unrelated-pa-workspace" }), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ resourceMode: "operations_home", authorityId: authority,
      workspaceId: "workspace-one", ownershipEpoch: 1, grantRevision: 1,
      services: [{ serviceId: "service-one", providerId: "provider-one", displayLabel: "Inspection", revision: 1 }] });
    expect(rpc).toHaveBeenCalledOnce();
    expect(statement.all).toHaveBeenCalledTimes(2);
  });

  it("does not accept a forged identity header when production Access configuration is missing", async () => {
    const { env, rpc } = fixture();
    const response = await createOperationsHomeRouter().fetch(request(path, {
      "Cf-Access-Authenticated-User-Email": principal.email, "Cf-Access-Jwt-Assertion": "forged" }), env);
    expect(response.status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails closed on invalid authority IDs or unavailable private transport", async () => {
    const { env, rpc } = fixture();
    const router = createOperationsHomeRouter({ resolvePrincipal: async () => principal });
    expect((await router.fetch(request("/home/not-an-authority"), env)).status).toBe(403);
    rpc.mockRejectedValueOnce(new Error("transport lost"));
    expect((await router.fetch(request(), env)).status).toBe(503);
  });
});
