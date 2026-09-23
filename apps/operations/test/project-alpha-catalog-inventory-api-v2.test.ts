import { describe, expect, it, vi } from "vitest";
import { readProjectAlphaCatalogInventory, readProjectAlphaCatalogInventoryAfterVerifiedCapabilities, readProjectAlphaCatalogSnapshot } from "../src/worker/project-alpha-catalog-inventory-api-v2";

const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", application = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const epoch = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", request = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const connection = { baseUrl: "https://alpha.example.test", apiKey: "test-secret", expectedSourceInstanceId: source, expectedApplicationId: application, expectedHistoryEpoch: epoch };
const route = { method: "GET", path: "/api/v2/catalog/inventory", requiredCapability: "catalog.inventory.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
const item = (id: string, digest = "a".repeat(64)): Record<string, unknown> => ({ publicId: id, sourceVersion: `sha256-${digest}`, name: `Service ${id}`, summary: null, category: "Survey", displayOrder: 0, geometryRequirement: "optional", questions: [{ id: "area", label: "Area", type: "number", required: true, minimum: 0 }] });
const largeItem = (id: string): Record<string, unknown> => ({ ...item(id), summary: "x".repeat(1000), questions: Array.from({ length: 10 }, (_, q) => ({ id: `q${q}`, label: "x".repeat(200), type: "select", required: true, options: Array.from({ length: 50 }, (_, o) => ({ value: `v${o}`, label: "x".repeat(200) })) })) });
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": request } }); }
function capabilities() { return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, grantedCapabilities: [{ name: "api.capabilities.read" }, { name: "catalog.inventory.read" }], implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, route] }; }
function inventory(items = [item("1".repeat(32))], nextCursor: string | null = null, snapshotId = "b".repeat(64), totalCount = items.length) { return { apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, snapshotId, totalCount, items, nextCursor }; }
const changed = () => ({ apiVersion: "2", sourceInstanceId: source, applicationId: application, historyEpoch: epoch, requestId: request, error: { code: "catalog_snapshot_changed" } });

describe("read-only PA catalog v2 inventory", () => {
  it("preflights the exact endpoint and validates documented item fields", async () => {
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities()) : json(inventory()));
    await expect(readProjectAlphaCatalogInventory(connection, { limit: 1 }, send)).resolves.toMatchObject({ status: "observed", response: { totalCount: 1 } });
    const headers = new Headers(send.mock.calls[1]![1]!.headers);
    expect(headers.get("X-PA-Source-Instance-ID")).toBe(source); expect(headers.get("X-PA-Application-ID")).toBe(application); expect(headers.get("X-PA-History-Epoch")).toBe(epoch);
  });

  it("fails closed for invalid item content and duplicate question identities", async () => {
    for (const invalid of [item("not-an-id"), { ...item("1".repeat(32)), name: "<script>" },
      { ...item("1".repeat(32)), name: "N".repeat(256) },
      { ...item("1".repeat(32)), questions: [{ id: "x", label: "X", type: "text", required: true }, { id: "x", label: "Again", type: "text", required: false }] }]) {
      const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities()) : json(inventory([invalid as ReturnType<typeof item>])));
      await expect(readProjectAlphaCatalogInventory(connection, {}, send)).resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract" });
    }
  });

  it("accepts Project Alpha's generic 255-character service-name boundary", async () => {
    const bounded = { ...item("1".repeat(32)), name: "N".repeat(255) };
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities()) : json(inventory([bounded])));
    await expect(readProjectAlphaCatalogInventory(connection, {}, send)).resolves.toMatchObject({ status: "observed" });
  });

  it("accepts a response above 256 KiB and below the documented 1 MiB cap", async () => {
    const body = inventory([largeItem("1".repeat(32))]);
    const send = vi.fn<typeof fetch>(async () => json(body));
    await expect(readProjectAlphaCatalogInventoryAfterVerifiedCapabilities(connection, { limit: 1 }, send)).resolves.toMatchObject({ status: "observed" });
  });

  it("continues through the maximum requested page size until the full snapshot is complete", async () => {
    const ids = Array.from({ length: 201 }, (_, index) => index.toString(16).padStart(32, "0"));
    const send = vi.fn<typeof fetch>(async url => { const parsed = new URL(String(url)); if (parsed.pathname.endsWith("/capabilities")) return json(capabilities()); return parsed.searchParams.has("cursor") ? json(inventory([item(ids[200]!, "c".repeat(64))], null, "d".repeat(64), 201)) : json(inventory(ids.slice(0, 200).map(id => item(id)), "next_page", "d".repeat(64), 201)); });
    await expect(readProjectAlphaCatalogSnapshot(connection, {}, send)).resolves.toMatchObject({ status: "complete", totalCount: 201, pageCount: 2, attemptCount: 1 });
    expect(new URL(String(send.mock.calls[2]![0])).searchParams.get("cursor")).toBe("next_page");
  });

  it("discards mixed pages on 409 and publishes only a complete retry", async () => {
    const one = item("1".repeat(32)), two = item("2".repeat(32), "c".repeat(64)); let calls = 0;
    const send = vi.fn<typeof fetch>(async url => { if (String(url).endsWith("/capabilities")) return json(capabilities()); calls++; if (calls === 1) return json(inventory([one], "old_cursor", "d".repeat(64), 2)); if (calls === 2) return json(changed(), 409); if (calls === 3) return json(inventory([one], "new_cursor", "e".repeat(64), 2)); return json(inventory([two], null, "e".repeat(64), 2)); });
    const outcome = await readProjectAlphaCatalogSnapshot(connection, { limit: 1, maxAttempts: 2 }, send);
    expect(outcome).toMatchObject({ status: "complete", snapshotId: "e".repeat(64), totalCount: 2, attemptCount: 2 });
    if (outcome.status === "complete") expect(outcome.items.map(value => value.publicId)).toEqual([one.publicId, two.publicId]);
  });

  it("never completes mixed 200 pages, duplicates, or exhausted 409 retries", async () => {
    const first = item("1".repeat(32)), second = item("2".repeat(32));
    const mixed = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities()) : String(url).includes("cursor=") ? json(inventory([second], null, "e".repeat(64), 2)) : json(inventory([first], "next", "d".repeat(64), 2)));
    await expect(readProjectAlphaCatalogSnapshot(connection, { limit: 1 }, mixed)).resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract" });
    const duplicate = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities()) : String(url).includes("cursor=") ? json(inventory([first], null, "d".repeat(64), 2)) : json(inventory([first], "next", "d".repeat(64), 2)));
    await expect(readProjectAlphaCatalogSnapshot(connection, { limit: 1 }, duplicate)).resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract" });
    const conflicts = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities()) : json(changed(), 409));
    await expect(readProjectAlphaCatalogSnapshot(connection, { maxAttempts: 2 }, conflicts)).resolves.toEqual({ status: "conflict", reason: "http_status", httpStatus: 409 });
  });

  it("returns a typed incomplete result before accumulating an oversized catalog", async () => {
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities()) : json(inventory([item("1".repeat(32))], "next", "d".repeat(64), 10_001)));
    await expect(readProjectAlphaCatalogSnapshot(connection, {}, send)).resolves.toEqual({ status: "incomplete", reason: "too_large", totalCount: 10_001, maxItems: 10_000, accumulatedBytes: 0, maxBytes: 16 * 1024 * 1024 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("reports a page cap separately from a response-byte cap", async () => {
    const send = vi.fn<typeof fetch>(async url => String(url).endsWith("/capabilities") ? json(capabilities()) : json(inventory([item("1".repeat(32))], "next", "d".repeat(64), 2)));
    await expect(readProjectAlphaCatalogSnapshot(connection, { limit: 1, maxPages: 1 }, send)).resolves.toEqual({ status: "incomplete", reason: "pagination_limit", totalCount: 2, maxPages: 1 });
  });

  it("bounds accumulated serialized bytes without repeatedly serializing prior pages", async () => {
    const items = Array.from({ length: 20 }, (_, index) => largeItem(index.toString(16).padStart(32, "0")));
    let page = 0;
    const send = vi.fn<typeof fetch>(async url => {
      if (String(url).endsWith("/capabilities")) return json(capabilities());
      const start = page++ * 5, next = start + 5 < items.length ? `page_${page}` : null;
      return json(inventory(items.slice(start, start + 5), next, "d".repeat(64), items.length));
    });
    const outcome = await readProjectAlphaCatalogSnapshot(connection, { limit: 5, maxBytes: 600_000 }, send);
    expect(outcome).toMatchObject({ status: "incomplete", reason: "too_large", totalCount: 20, maxBytes: 600_000 });
    if (outcome.status === "incomplete" && outcome.reason === "too_large") expect(outcome.accumulatedBytes).toBeLessThanOrEqual(outcome.maxBytes);
    expect(page).toBe(2);
  });
});
