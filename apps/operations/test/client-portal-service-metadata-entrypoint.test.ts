import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { readClientPortalServiceMetadataRpc } from "../src/worker/client-portal-service-metadata-entrypoint";

const request = { protocolVersion: 1 as const, authorityId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "workspace-one", ownershipEpoch: 1, grantRevision: 1,
  issuer: "https://access.example.test", subject: "person-one" };
function database(rows: unknown[]): D1Database {
  const statement = { bind: () => statement, all: async () => ({ success: true, results: rows }) };
  return { withSession: () => ({ prepare: () => statement }) } as unknown as D1Database;
}

describe("ClientPortalServiceMetadataReader private RPC", () => {
  it("is strict and default-off while echoing a valid disabled tuple", async () => {
    await expect(readClientPortalServiceMetadataRpc({ OPS_DB: database([]) }, request)).resolves.toEqual({
      ok: false, ...request, code: "disabled",
    });
    await expect(readClientPortalServiceMetadataRpc({ OPS_DB: database([]), CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED: "true" },
      { ...request, unexpected: true })).resolves.toEqual({ ok: false, protocolVersion: 1, code: "invalid_request" });
  });

  it("echoes the exact correlation tuple on success and denial", async () => {
    const enabled = { OPS_DB: database([{ service_id: "service-one", provider_id: "ltds",
      display_name: "Inspection", revision: 2 }]), CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED: "true" };
    await expect(readClientPortalServiceMetadataRpc(enabled, request)).resolves.toEqual({ ok: true, ...request,
      services: [{ serviceId: "service-one", providerId: "ltds", displayLabel: "Inspection", revision: 2 }] });
    await expect(readClientPortalServiceMetadataRpc({ ...enabled, OPS_DB: database([]) }, request)).resolves.toEqual({
      ok: false, ...request, code: "denied",
    });
  });
});
