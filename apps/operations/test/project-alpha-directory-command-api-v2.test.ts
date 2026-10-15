import { describe, expect, it, vi } from "vitest";
import {
  readProjectAlphaDirectoryInventoryAfterVerifiedCapabilities,
  readConfiguredProjectAlphaDirectoryInventory,
  sendConfiguredProjectAlphaDirectoryBindingRevokeCommand,
  sendProjectAlphaDirectoryLifecycleCommand,
  sendProjectAlphaDirectoryOrganizationRelationshipCommand,
  validatedProjectAlphaDirectoryRelationshipGenerationConflict,
  type ProjectAlphaDirectoryBindingRevokeCommand,
  type ProjectAlphaDirectoryLifecycleCommand,
  type ProjectAlphaDirectoryRelationshipCommand,
} from "../src/worker/project-alpha-directory-command-api-v2";
import type { ProjectAlphaApiV2Endpoint } from "../src/worker/project-alpha-api-v2";

const sourceId = "project-alpha:source-a";
const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const application = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const client = "1".repeat(32), organization = "2".repeat(32);
const connection = { baseUrl: "https://source-a.example.test", apiKey: "transport-secret", expectedSourceInstanceId: source, expectedApplicationId: application, expectedHistoryEpoch: epoch };
const env = { PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: { [sourceId]: { sourceId, enabled: true, baseUrl: connection.baseUrl, apiKey: connection.apiKey, sourceInstanceId: source, applicationId: application, historyEpoch: epoch } } }) };
const endpoints = {
  lifecycle: (kind: "client" | "organization", action: "archive" | "restore") => ({ method: "POST", path: `/api/v2/directory/${kind}s/${"{publicId}"}/${action}/commands`, requiredCapability: `directory.${kind}s.${action}`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true }),
  relationship: (action: "assign" | "remove" | "move") => ({ method: "POST", path: `/api/v2/directory/clients/{publicId}/organization/${action}/commands`, requiredCapability: `directory.clients.organization.${action}`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true }),
  revoke: (kind: "client" | "organization") => ({ method: "POST", path: `/api/v2/directory/${kind}s/bindings/revoke/commands`, requiredCapability: `directory.${kind}s.unbind`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true }),
  inventory: () => ({ method: "GET", path: "/api/v2/directory/inventory", requiredCapability: "directory.inventory.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true }),
};
function capability(endpoint: ProjectAlphaApiV2Endpoint) {
  return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId, grantedCapabilities: [{ name: "api.capabilities.read" }, { name: endpoint.requiredCapability }], implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, endpoint] };
}
function json(value: unknown, status = 200, request = requestId) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": request } }); }
const lifecycle = (action: "archive" | "restore") => ({ sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId, replayed: false, result: { action, resource: { type: "client", publicId: client, revision: "2", present: action === "restore" }, authorizationGeneration: "0" } });

describe("dormant PA directory command and inventory transport", () => {
  const relationshipCommand: ProjectAlphaDirectoryRelationshipCommand = {
    commandId: requestId, expectedClientRevision: "1", expectedAuthorizationGeneration: "0",
    expectedCurrentOrganizationPublicId: null,
    organization: { externalId: "org/exact", publicId: organization, expectedRevision: "1" },
  };
  const generationConflict = () => ({ apiVersion: "2", sourceInstanceId: source, applicationId: application,
    historyEpoch: epoch, requestId, error: { code: "authorization_generation_conflict" } });
  async function conflictOutcome(response: Response) {
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities")
      ? json(capability(endpoints.relationship("assign"))) : response);
    return sendProjectAlphaDirectoryOrganizationRelationshipCommand(connection, client, "assign", relationshipCommand, send);
  }

  it("retains private provenance only for the exact relationship generation-conflict contract", async () => {
    const outcome = await conflictOutcome(json(generationConflict(), 409));
    expect(outcome).toEqual({ status: "conflict", reason: "http_status", httpStatus: 409, requestId });
    const proof = validatedProjectAlphaDirectoryRelationshipGenerationConflict(outcome);
    expect(proof).toEqual({ command: relationshipCommand, response: generationConflict(), destinationOrigin: connection.baseUrl,
      requestPath: `/api/v2/directory/clients/${client}/organization/assign/commands` });
    expect(validatedProjectAlphaDirectoryRelationshipGenerationConflict({ ...outcome })).toBeNull();
    expect(validatedProjectAlphaDirectoryRelationshipGenerationConflict(JSON.parse(JSON.stringify(outcome)))).toBeNull();
    if (proof?.command.organization) Reflect.set(proof.command.organization, "externalId", "changed-copy");
    expect(validatedProjectAlphaDirectoryRelationshipGenerationConflict(outcome)?.command).toEqual(relationshipCommand);
  });

  it.each([
    ["generic", { error: "Conflict" }],
    ["foreign source", { ...generationConflict(), sourceInstanceId: application }],
    ["foreign application", { ...generationConflict(), applicationId: source }],
    ["foreign epoch", { ...generationConflict(), historyEpoch: source }],
    ["mismatched request", { ...generationConflict(), requestId: source }],
    ["wrong version", { ...generationConflict(), apiVersion: "3" }],
    ["wrong code", { ...generationConflict(), error: { code: "revision_conflict" } }],
    ["private error field", { ...generationConflict(), error: { code: "authorization_generation_conflict", detail: "private" } }],
    ["extra field", { ...generationConflict(), secret: "private" }],
  ])("does not brand %s conflicts", async (_name, body) => {
    const outcome = await conflictOutcome(json(body, 409));
    expect(outcome).toMatchObject({ status: "conflict", httpStatus: 409 });
    expect(validatedProjectAlphaDirectoryRelationshipGenerationConflict(outcome)).toBeNull();
    expect(JSON.stringify(outcome)).not.toContain("private");
  });

  it.each(["Set-Cookie", "Location", "Cache-Control", "Content-Type", "X-Request-ID"])("does not brand untrusted %s headers", async header => {
    const response = json(generationConflict(), 409);
    if (header === "Set-Cookie" || header === "Location") response.headers.set(header, "private");
    else response.headers.delete(header);
    const outcome = await conflictOutcome(response);
    expect(validatedProjectAlphaDirectoryRelationshipGenerationConflict(outcome)).toBeNull();
  });

  it("rejects duplicate JSON keys, invalid UTF-8 and oversized conflict bodies without exposing them", async () => {
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId };
    for (const body of [JSON.stringify(generationConflict()).replace('"apiVersion":"2"', '"apiVersion":"2","apiVersion":"2"'),
      new Uint8Array([0xff]), "private".repeat(12_000)]) {
      const outcome = await conflictOutcome(new Response(body, { status: 409, headers }));
      expect(validatedProjectAlphaDirectoryRelationshipGenerationConflict(outcome)).toBeNull();
      expect(JSON.stringify(outcome)).not.toContain("private");
    }
  });

  it("bounds a stalled conflict body even when stream cancellation never resolves", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"apiVersion":"2"')); },
        cancel() { cancelled = true; return new Promise<void>(() => undefined); },
      }), { status: 409, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId } });
      const pending = conflictOutcome(response);
      await vi.advanceTimersByTimeAsync(10_001);
      const outcome = await pending;
      expect(cancelled).toBe(true);
      expect(outcome).toMatchObject({ status: "conflict", httpStatus: 409 });
      expect(validatedProjectAlphaDirectoryRelationshipGenerationConflict(outcome)).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("is default-off before any capability or command fetch", async () => {
    const send = vi.fn<typeof fetch>();
    const disabled = { PROJECT_ALPHA_API_V2_CONNECTIONS: env.PROJECT_ALPHA_API_V2_CONNECTIONS!.replace('"enabled":true', '"enabled":false') };
    await expect(sendConfiguredProjectAlphaDirectoryBindingRevokeCommand(disabled, sourceId, "client", { commandId: requestId, externalId: "ops/client", expectedPublicId: client, expectedRevision: "1", expectedAuthorizationGeneration: "0" }, send)).resolves.toEqual({ status: "disabled", sourceId });
    expect(send).not.toHaveBeenCalled();
  });

  it("preflights and sends the exact lifecycle path, body, identity headers, and original command id", async () => {
    const command: ProjectAlphaDirectoryLifecycleCommand = { commandId: requestId, expectedRevision: "1", expectedAuthorizationGeneration: "0" };
    const send = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/capabilities")) return json(capability(endpoints.lifecycle("client", "archive")));
      expect(String(url)).toBe(`https://source-a.example.test/api/v2/directory/clients/${client}/archive/commands`);
      expect(init?.method).toBe("POST"); expect(JSON.parse(String(init?.body))).toEqual(command);
      const headers = new Headers(init?.headers); expect(headers.get("Authorization")).toBe("Bearer transport-secret"); expect(headers.get("X-PA-Source-Instance-ID")).toBe(source); expect(headers.get("X-PA-Application-ID")).toBe(application); expect(headers.get("X-PA-History-Epoch")).toBe(epoch);
      return json(lifecycle("archive"));
    });
    await expect(sendProjectAlphaDirectoryLifecycleCommand(connection, "client", client, "archive", command, send)).resolves.toMatchObject({ status: "acknowledged", response: { result: { resource: { publicId: client, present: false } } } });
  });

  it("uses distinct relationship and revoke endpoint capabilities and accepts replay receipts", async () => {
    const relationship: ProjectAlphaDirectoryRelationshipCommand = { commandId: requestId, expectedClientRevision: "1", expectedAuthorizationGeneration: "0", expectedCurrentOrganizationPublicId: null, organization: { externalId: "org/exact", publicId: organization, expectedRevision: "1" } };
    const revoke: ProjectAlphaDirectoryBindingRevokeCommand = { commandId: requestId, externalId: "org/exact", expectedPublicId: organization, expectedRevision: "1", expectedAuthorizationGeneration: "0" };
    const send = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/capabilities")) return json(capability(endpoints.relationship("assign")));
      expect(String(url)).toContain("/api/v2/directory/clients/"); return json({ sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId, replayed: true, result: { action: "assign", client: { publicId: client, revision: "2" }, organizationPublicId: organization, authorizationGeneration: "1" } });
    });
    await expect(sendProjectAlphaDirectoryOrganizationRelationshipCommand(connection, client, "assign", relationship, send)).resolves.toMatchObject({ status: "acknowledged", response: { replayed: true } });
    const revokeSend = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capability(endpoints.revoke("organization"))) : json({ sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId, replayed: true, result: { action: "revoke", binding: { resourceType: "organization", externalId: "org/exact", publicId: organization, resourceRevision: "1", status: "tombstoned" }, authorizationGeneration: "1" } }));
    await expect(sendConfiguredProjectAlphaDirectoryBindingRevokeCommand(env, sourceId, "organization", revoke, revokeSend)).resolves.toMatchObject({ status: "acknowledged", response: { replayed: true } });
  });

  it("keeps inventory bounded, cursor-ordered, historical, non-authoritative, and source isolated", async () => {
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capability(endpoints.inventory())) : json({ sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId, authorizationGeneration: "4", resources: [{ type: "client", publicId: client, revision: "2", present: false, lastAction: "delete", projectionSha256: "a".repeat(64), binding: { externalId: "ops/client", status: "tombstoned", resourceRevision: "1" } }], nextCursor: null }));
    const result = await readConfiguredProjectAlphaDirectoryInventory(env, sourceId, { type: "client", limit: 1 }, send);
    expect(result).toMatchObject({ status: "observed", inventory: { authoritative: false, sourceId, authorizationGeneration: "4", resources: [{ present: false, lastAction: "delete", binding: { status: "tombstoned" } }] } });
    expect(String(send.mock.calls[1]![0])).toBe(`https://source-a.example.test/api/v2/directory/inventory?type=client&limit=1`);
  });

  it("can reuse a capabilities verification from the same bounded request", async () => {
    const send = vi.fn<typeof fetch>(async () => json({ sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId, authorizationGeneration: "4", resources: [], nextCursor: null }));
    await expect(readProjectAlphaDirectoryInventoryAfterVerifiedCapabilities(connection, sourceId, { type: "all", limit: 200 }, send)).resolves.toMatchObject({ status: "observed", inventory: { resources: [] } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]![0])).toBe(`https://source-a.example.test/api/v2/directory/inventory?type=all&limit=200`);
  });

  it("rejects identity, replay-conflict-shaped contracts, and malformed bounds without leaking errors", async () => {
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capability(endpoints.lifecycle("client", "archive"))) : json({ ...lifecycle("archive"), sourceInstanceId: "foreign" }));
    const result = await sendProjectAlphaDirectoryLifecycleCommand(connection, "client", client, "archive", { commandId: requestId, expectedRevision: "1", expectedAuthorizationGeneration: "0" }, send);
    expect(result).toMatchObject({ status: "uncertain", reason: "invalid_contract" }); expect(JSON.stringify(result)).not.toContain("transport-secret");
    await expect(sendProjectAlphaDirectoryLifecycleCommand(connection, "client", client, "archive", { commandId: "bad", expectedRevision: "1", expectedAuthorizationGeneration: "0" }, send)).resolves.toMatchObject({ status: "rejected", reason: "invalid_command" });
  });
});
