import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperationsHomeRouter } from "../src/worker/client-portal/operations-home-routes";
import type { Env } from "../src/worker/types";

const authorityId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const recipientId = "33333333-3333-4333-8333-333333333333";
const principal = { issuer: "https://team.cloudflareaccess.com", subject: "verified|recipient", email: "ignored@example.invalid" };
const row = { authority_id: authorityId, target_id: targetId, recipient_binding_id: recipientId,
  workspace_id: "native-workspace", ownership_epoch: 1, grant_revision: 2 };
const services = [{ serviceId: "drone-data", providerId: "drone", displayLabel: "Drone services", revision: 1 }];

/** HTTP-adapter coverage only. The SQL and durable grant/receipt transitions are
 * covered separately by the native-authority real-D1 suite. No mocked row is
 * evidence that a real recipient was enrolled. */
function fixture() {
  let granted = true;
  const queries: string[] = [];
  const statement = { bind: vi.fn(() => statement), all: vi.fn(async () => ({ success: true, results: granted ? [row] : [] })) };
  const database = { withSession: vi.fn((constraint: string) => {
    expect(constraint).toBe("first-primary");
    return { prepare: (sql: string) => { queries.push(sql); return statement; } };
  }) };
  const rpc = vi.fn(async () => JSON.stringify({ ok: true, protocolVersion: 1, authorityId,
    workspaceId: row.workspace_id, ownershipEpoch: 1, grantRevision: 2,
    issuer: principal.issuer, subject: principal.subject, services }));
  const env = { ENVIRONMENT: "staging", CLIENT_PORTAL_ENABLED: "true",
    CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test",
    CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: "true",
    CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED: "true",
    DELIVERY_DB: database, CLIENT_PORTAL_SERVICE_METADATA_READER: { readServiceMetadata: rpc } } as unknown as Env;
  return { env, rpc, queries, statement, setGranted: (value: boolean) => { granted = value; } };
}
const request = (path = "/home") => new Request(`https://client-staging.example.test${path}`);
afterEach(() => vi.restoreAllMocks());

describe("native service-home HTTP protocol selection", () => {
  it("exposes only exact service labels through the native recipient reader", async () => {
    const test = fixture();
    const response = await createOperationsHomeRouter({ resolvePrincipal: async () => principal }).fetch(request(), test.env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ resourceMode: "operations_home", homes: [{ authorityId,
      workspaceId: row.workspace_id, ownershipEpoch: 1, grantRevision: 2, services }] });
    expect(test.queries.length).toBeGreaterThan(0);
    for (const sql of test.queries) {
      expect(sql).toContain("operations_portal_native_recipient_authority_heads");
      expect(sql).not.toContain("portal_operations_principal_grant_heads");
    }
    for (const call of test.statement.bind.mock.calls) expect(call).toEqual([principal.issuer, principal.subject]);
  });

  it("never falls back to legacy grants when native authority is absent or its schema is unavailable", async () => {
    const router = createOperationsHomeRouter({ resolvePrincipal: async () => principal });
    const absent = fixture();
    absent.setGranted(false);
    expect((await router.fetch(request(), absent.env)).status).toBe(403);
    expect(absent.rpc).not.toHaveBeenCalled();
    const unavailable = fixture();
    unavailable.statement.all.mockRejectedValueOnce(new Error("synthetic schema unavailable"));
    expect((await router.fetch(request(), unavailable.env)).status).toBe(503);
    expect(unavailable.rpc).not.toHaveBeenCalled();
    expect([...absent.queries, ...unavailable.queries].every(sql => !sql.includes("portal_operations_principal_grant_heads"))).toBe(true);
  });

  it("suppresses labels when native permission disappears during the metadata request", async () => {
    const test = fixture();
    test.rpc.mockImplementationOnce(async () => {
      test.setGranted(false);
      return JSON.stringify({ ok: true, protocolVersion: 1, authorityId, workspaceId: row.workspace_id,
        ownershipEpoch: 1, grantRevision: 2, issuer: principal.issuer, subject: principal.subject, services });
    });
    const response = await createOperationsHomeRouter({ resolvePrincipal: async () => principal })
      .fetch(request(`/home/${authorityId}`), test.env);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Client access is not provisioned" });
    expect(test.rpc).toHaveBeenCalledOnce();
    expect(test.statement.all).toHaveBeenCalledTimes(2);
  });
});
