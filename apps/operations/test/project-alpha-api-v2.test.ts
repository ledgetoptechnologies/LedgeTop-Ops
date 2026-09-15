import { describe, expect, it, vi } from "vitest";
import { probeProjectAlphaDirectoryApiV2 } from "../src/worker/project-alpha-api-v2";

const sourceInstanceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const applicationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const historyEpoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const requestId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const connection = { baseUrl: "https://project-alpha.example.test", apiKey: "test-key", expectedSourceInstanceId: sourceInstanceId, expectedApplicationId: applicationId, expectedHistoryEpoch: historyEpoch };

function response(capabilities: readonly [string, string], endpointCapabilities: readonly [string, string] = capabilities) {
  return new Response(JSON.stringify({
    apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId,
    grantedCapabilities: ["api.capabilities.read", ...capabilities].map(name => ({ name })),
    implementedEndpoints: [
      { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
      { method: "POST", path: "/api/v2/directory/organizations/commands", requiredCapability: endpointCapabilities[0], requiresSourceInstanceId: true, requiresApplicationId: true, requiresUpdatePublicId: true, requiresHistoryEpoch: true },
      { method: "POST", path: "/api/v2/directory/clients/commands", requiredCapability: endpointCapabilities[1], requiresSourceInstanceId: true, requiresApplicationId: true, requiresUpdatePublicId: true, requiresHistoryEpoch: true },
    ],
  }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId } });
}

describe("Project Alpha directory API-v2 creation preflight", () => {
  it("accepts the PA create scopes on both exact command routes", async () => {
    const createScopes = ["directory.organizations.create", "directory.clients.create"] as const;
    const send = vi.fn<typeof fetch>(async () => response(createScopes));

    await expect(probeProjectAlphaDirectoryApiV2(connection, send)).resolves.toMatchObject({
      status: "verified", grantedCapabilities: ["api.capabilities.read", ...createScopes],
    });
    expect(String(send.mock.calls[0]![0])).toBe("https://project-alpha.example.test/api/v2/capabilities");
  });

  it("rejects legacy write-scope endpoint metadata", async () => {
    const createScopes = ["directory.organizations.create", "directory.clients.create"] as const;
    const send = vi.fn<typeof fetch>(async () => response(createScopes, ["directory.organizations.write", "directory.clients.write"]));

    await expect(probeProjectAlphaDirectoryApiV2(connection, send)).resolves.toMatchObject({ status: "incompatible", reason: "missing_endpoint" });
  });
});
