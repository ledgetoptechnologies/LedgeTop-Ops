import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("../src/worker/client-portal-native-financial-reader", () => ({
  readClientPortalNativeFinancialDocuments: mocks.read,
}));

import { ClientPortalNativeFinancialReader } from "../src/worker/client-portal-native-financial-entrypoint";

const request = {
  protocolVersion: 1 as const,
  authorityId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "workspace-1",
  ownershipEpoch: 2,
  grantRevision: 3,
  issuer: "https://issuer.example.test",
  subject: "recipient-1",
};
const grantId = "20000000-0000-4000-8000-000000000002";

function database(grants = [grantId]): D1Database {
  return {
    withSession: () => ({
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: grants.map(grant_id => ({ grant_id })) }) }),
      }),
    }),
  } as unknown as D1Database;
}

async function invoke(env: Record<string, unknown>): Promise<string> {
  return ClientPortalNativeFinancialReader.prototype.readFinancialDocuments.call({ env }, request);
}

describe("ClientPortalNativeFinancialReader wire serialization (unit boundary)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the default-off envelope as a JSON string", async () => {
    const wire = await invoke({ OPS_DB: database(), PROJECT_ALPHA_API_V2_CONNECTIONS: "[]" });
    expect(typeof wire).toBe("string");
    expect(JSON.parse(wire)).toEqual({ ok: false, protocolVersion: 1, code: "disabled" });
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("returns a successful bounded collection as a JSON string", async () => {
    mocks.read.mockResolvedValue({ status: "ok", grantId, revision: 1, value: { documents: [] } });
    const wire = await invoke({ OPS_DB: database(), PROJECT_ALPHA_API_V2_CONNECTIONS: "[]",
      CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED: "true" });
    expect(typeof wire).toBe("string");
    expect(JSON.parse(wire)).toEqual({ ok: true, protocolVersion: 1, authorityId: request.authorityId,
      workspaceId: request.workspaceId, ownershipEpoch: request.ownershipEpoch,
      grantRevision: request.grantRevision,
      collections: [{ status: "ok", grantId, revision: 1, value: { documents: [] } }] });
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("replaces an oversized success with only the overflow envelope", async () => {
    mocks.read.mockResolvedValue({ status: "ok", grantId, revision: 1,
      value: { documents: [{ privatePayload: "x".repeat(512 * 1024) }] } });
    const wire = await invoke({ OPS_DB: database(), PROJECT_ALPHA_API_V2_CONNECTIONS: "[]",
      CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED: "true" });
    expect(typeof wire).toBe("string");
    expect(wire).toBe('{"ok":false,"protocolVersion":1,"code":"overflow"}');
    expect(wire).not.toContain("privatePayload");
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });
});
