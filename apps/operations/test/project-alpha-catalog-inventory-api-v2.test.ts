import { describe, expect, it, vi } from "vitest";
import { readProjectAlphaCatalogInventory, readProjectAlphaCatalogInventoryAfterVerifiedCapabilities } from "../src/worker/project-alpha-catalog-inventory-api-v2";

const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const application = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const request = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const connection = { baseUrl: "https://alpha.example.test", apiKey: "test-secret", expectedSourceInstanceId: source, expectedApplicationId: application, expectedHistoryEpoch: epoch };
const route = { method: "GET", path: "/api/v2/catalog/inventory", requiredCapability: "catalog.inventory.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };

function json(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": request } });
}
function capabilities() {
  return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request,
    grantedCapabilities: [{ name: "api.capabilities.read" }, { name: "catalog.inventory.read" }],
    implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, route] };
}
function inventory() {
  return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request,
    snapshotId: "a".repeat(64), totalCount: 1, items: [{ intentionally: "opaque-until-question-contract" }], nextCursor: null };
}

describe("dormant PA catalog v2 inventory transport", () => {
  it("preflights the exact capability, sends identity headers, and retains an opaque item array", async () => {
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities()) : json(inventory()));
    await expect(readProjectAlphaCatalogInventory(connection, { limit: 1 }, send)).resolves.toEqual({ status: "observed", httpStatus: 200, response: inventory() });
    expect(String(send.mock.calls[1]![0])).toBe("https://alpha.example.test/api/v2/catalog/inventory?limit=1");
    const headers = new Headers(send.mock.calls[1]![1]!.headers);
    expect(headers.get("X-PA-Source-Instance-ID")).toBe(source);
    expect(headers.get("X-PA-Application-ID")).toBe(application);
    expect(headers.get("X-PA-History-Epoch")).toBe(epoch);
  });

  it("does not treat content as ready when the immutable envelope is malformed", async () => {
    for (const body of [{ ...inventory(), snapshotId: "not-a-hash" }]) {
      const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities()) : json(body));
      await expect(readProjectAlphaCatalogInventory(connection, {}, send)).resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract" });
    }
  });

  it("can make one bounded inventory read after a preceding capability verification", async () => {
    const send = vi.fn<typeof fetch>(async () => json(inventory()));
    await expect(readProjectAlphaCatalogInventoryAfterVerifiedCapabilities(connection, { cursor: "opaque", limit: 1 }, send)).resolves.toMatchObject({ status: "observed" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]![0])).toBe("https://alpha.example.test/api/v2/catalog/inventory?limit=1&cursor=opaque");
  });

  it("accepts a valid envelope above the former 256 KiB limit and below PA's documented 1 MiB cap", async () => {
    const body = { ...inventory(), items: [{ opaque: "x".repeat(300 * 1024) }] };
    const send = vi.fn<typeof fetch>(async () => json(body));
    await expect(readProjectAlphaCatalogInventoryAfterVerifiedCapabilities(connection, { limit: 1 }, send))
      .resolves.toMatchObject({ status: "observed", response: { totalCount: 1 } });
  });
});
