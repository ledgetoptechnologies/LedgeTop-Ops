import { describe, expect, it, vi } from "vitest";
import {
  readConfiguredProjectAlphaDirectoryInventory,
  sendConfiguredProjectAlphaDirectoryBindingRevokeCommand,
  sendProjectAlphaDirectoryLifecycleCommand,
  sendProjectAlphaDirectoryOrganizationRelationshipCommand,
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

  it("rejects identity, replay-conflict-shaped contracts, and malformed bounds without leaking errors", async () => {
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capability(endpoints.lifecycle("client", "archive"))) : json({ ...lifecycle("archive"), sourceInstanceId: "foreign" }));
    const result = await sendProjectAlphaDirectoryLifecycleCommand(connection, "client", client, "archive", { commandId: requestId, expectedRevision: "1", expectedAuthorizationGeneration: "0" }, send);
    expect(result).toMatchObject({ status: "uncertain", reason: "invalid_contract" }); expect(JSON.stringify(result)).not.toContain("transport-secret");
    await expect(sendProjectAlphaDirectoryLifecycleCommand(connection, "client", client, "archive", { commandId: "bad", expectedRevision: "1", expectedAuthorizationGeneration: "0" }, send)).resolves.toMatchObject({ status: "rejected", reason: "invalid_command" });
  });
});
