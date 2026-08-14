import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import projectionMigration from "../migrations/0122_project_alpha_service_catalog_projection.sql?raw";
import compatibilityMigration from "../migrations/0128_project_alpha_catalog_compatibility.sql?raw";
import compatibilityFixture from "../../../packages/shared/fixtures/project-alpha-catalog-v2.json";
import { listServiceCatalog } from "../src/worker/client-portal/request-v2";
import { handleProjectAlphaCatalogRequest, parseCatalogProjectionDelivery } from "../src/worker/project-alpha-catalog";
import type { Env } from "../src/worker/types";

const applicationKey = "field_operations_catalog";
const secret = "catalog-test-secret-at-least-thirty-two-bytes";
const snapshotHash = "a".repeat(64);
const access = async () => undefined;

async function signature(body: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  return `sha256=${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function item(publicId: string, sourceVersion = "v1") {
  return {
    publicId,
    sourceVersion,
    name: publicId === "svc-map" ? "2D Mapping" : "Site photography",
    summary: "Client-safe service summary.",
    category: "Aerial services",
    displayOrder: publicId === "svc-map" ? 20 : 10,
    geometryRequirement: publicId === "svc-map" ? "required" : "none",
    questions: [
      { id: "notes", label: "Notes", type: "text", required: false, maxLength: 500 },
      { id: "acreage", label: "Expected acreage", type: "number", required: false, minimum: 0, maximum: 100000 },
      { id: "rush", label: "Is this urgent?", type: "boolean", required: false },
      { id: "quality", label: "Quality", type: "select", required: true, options: [{ value: "standard", label: "Standard" }] },
      { id: "outputs", label: "Outputs", type: "multi-select", required: false, options: [{ value: "ortho", label: "Orthomosaic" }] },
    ],
  };
}

function envelope(kind: string, deliveryId: string, sourceSequence: number, extra: Record<string, unknown>) {
  return {
    schemaVersion: 2,
    applicationKey,
    deliveryId,
    occurredAt: "2026-08-13T18:00:00.000Z",
    sourceGeneration: "catalog-2026-08-13",
    sourceSequence,
    kind,
    ...extra,
  };
}

describe("Project Alpha sanitized service catalog projection", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-16",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "catalog-projection-test" },
    });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.prepare(`CREATE TABLE pa_service_catalog_items (
      public_id TEXT NOT NULL, source_version TEXT NOT NULL, name TEXT NOT NULL, summary TEXT,
      question_schema_json TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1,
      source_updated_at TEXT NOT NULL, mirrored_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(public_id,source_version))`).run();
    await db.prepare("CREATE UNIQUE INDEX idx_pa_service_catalog_current ON pa_service_catalog_items(public_id) WHERE active=1").run();
    for (const statement of projectionMigration.split(/;\s*(?:\n|$)/)) {
      const executable = statement.replace(/^\s*--.*$/gm, "").trim();
      if (!executable || /^PRAGMA\s+foreign_keys/i.test(executable)) continue;
      await db.prepare(executable).run();
    }
    for (const statement of compatibilityMigration.split(/;\s*(?:\n|$)/)) {
      const executable = statement.replace(/^\s*--.*$/gm, "").trim();
      if (!executable || /^PRAGMA\s+foreign_keys/i.test(executable)) continue;
      await db.prepare(executable).run();
    }
    env = {
      DELIVERY_DB: db,
      PROJECT_ALPHA_CATALOG_SYNC_ENABLED: "true",
      PROJECT_ALPHA_CATALOG_APPLICATION_KEY: applicationKey,
      PROJECT_ALPHA_CATALOG_HMAC_SECRET: secret,
    } as Env;
  });

  afterAll(async () => miniflare.dispose());

  async function deliver(payload: Record<string, unknown>, options: { timestamp?: string; signature?: string; accessVerifier?: typeof access } = {}) {
    const body = JSON.stringify(payload);
    const timestamp = options.timestamp ?? new Date().toISOString();
    return handleProjectAlphaCatalogRequest(new Request("https://client.test/api/internal/project-alpha/catalog-v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PA-Timestamp": timestamp,
        "X-PA-Delivery-ID": String(payload.deliveryId),
        "X-PA-Signature": options.signature ?? await signature(body, timestamp),
      },
      body,
    }), env, options.accessVerifier ?? access);
  }

  it("stages pages without changing reads, then atomically activates a complete generation", async () => {
    const firstPage = envelope("snapshot.page", "snapshot-page-1", 10, { snapshotHash, pageNumber: 1, pageCount: 2, itemCount: 3, items: [item("svc-map")] });
    const secondPage = envelope("snapshot.page", "snapshot-page-2", 10, { snapshotHash, pageNumber: 2, pageCount: 2, itemCount: 3, items: [
      item("svc-photo"),
      { ...item("svc-report"), category: "Reports", displayOrder: 0, geometryRequirement: "optional", questions: [] },
    ] });
    expect((await deliver(firstPage)).status).toBe(200);
    expect(await listServiceCatalog(env)).toEqual([]);

    const premature = await deliver(envelope("snapshot.activate", "snapshot-activate-early", 10, { snapshotHash, pageCount: 2, itemCount: 3 }));
    expect(premature.status).toBe(409);
    expect(await listServiceCatalog(env)).toEqual([]);

    expect((await deliver(secondPage)).status).toBe(200);
    const activated = await deliver(envelope("snapshot.activate", "snapshot-activate", 10, { snapshotHash, pageCount: 2, itemCount: 3 }));
    expect(activated.status).toBe(200);
    expect((await listServiceCatalog(env)).map(service => [service.publicId, service.sourceVersion, service.category, service.displayOrder, service.geometryRequirement])).toEqual([
      ["svc-photo", "v1", "Aerial services", 10, "none"],
      ["svc-map", "v1", "Aerial services", 20, "required"],
      ["svc-report", "v1", "Reports", 0, "optional"],
    ]);
    expect((await listServiceCatalog(env))[0]!.questions.at(-1)?.type).toBe("multi_select");
  });

  it("applies only ordered idempotent events and tombstones", async () => {
    const updatedItem = { ...item("svc-map", "v2"), category: "Mapping", displayOrder: 5, geometryRequirement: "optional" };
    const update = envelope("event", "catalog-event-11", 11, { event: { action: "upsert", item: updatedItem } });
    const first = await deliver(update);
    expect(first.status).toBe(200);
    expect((await first.json() as { status: string }).status).toBe("completed");
    const replay = await deliver(update);
    expect((await replay.json() as { status: string }).status).toBe("duplicate");
    expect((await listServiceCatalog(env)).find(service => service.publicId === "svc-map")).toMatchObject({
      sourceVersion: "v2", category: "Mapping", displayOrder: 5, geometryRequirement: "optional",
    });

    const reusedVersion = { ...updatedItem };
    reusedVersion.name = "Changed without a new version";
    expect((await deliver(envelope("event", "catalog-event-version-reuse", 12, { event: { action: "upsert", item: reusedVersion } }))).status).toBe(409);
    for (const [field, value] of [["category", "Changed category"], ["displayOrder", 999], ["geometryRequirement", "optional"]] as const) {
      const changed = { ...updatedItem, [field]: field === "geometryRequirement" ? "required" : value };
      expect((await deliver(envelope("event", `catalog-event-version-reuse-${field}`, 12, { event: { action: "upsert", item: changed } }))).status).toBe(409);
    }

    const gap = await deliver(envelope("event", "catalog-event-13", 13, { event: { action: "tombstone", publicId: "svc-photo", sourceVersion: "v2" } }));
    expect(gap.status).toBe(409);
    expect((await listServiceCatalog(env)).some(service => service.publicId === "svc-photo")).toBe(true);

    const removed = await deliver(envelope("event", "catalog-event-12", 12, { event: { action: "tombstone", publicId: "svc-photo", sourceVersion: "v2" } }));
    expect(removed.status).toBe(200);
    expect((await listServiceCatalog(env)).some(service => service.publicId === "svc-photo")).toBe(false);
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_service_catalog_projection_receipts WHERE status='completed'").first("count")).toBe(5);
  });

  it("rejects internal fields, markup, invalid question bounds, and delivery-id conflicts", async () => {
    const leaked = envelope("event", "catalog-leak", 13, { event: { action: "upsert", item: { ...item("svc-secret"), unitPrice: 12345 } } });
    expect((await deliver(leaked)).status).toBe(422);
    const markup = envelope("event", "catalog-markup", 13, { event: { action: "upsert", item: { ...item("svc-secret"), summary: "<b>internal</b>" } } });
    expect((await deliver(markup)).status).toBe(422);
    const tooMany = item("svc-secret");
    tooMany.questions = Array.from({ length: 11 }, (_, index) => ({ id: `q${index}`, label: `Question ${index}`, type: "boolean", required: false }));
    expect((await deliver(envelope("event", "catalog-questions", 13, { event: { action: "upsert", item: tooMany } }))).status).toBe(422);

    const conflict = { ...envelope("event", "catalog-event-12", 13, { event: { action: "tombstone", publicId: "svc-map", sourceVersion: "v3" } }) };
    expect((await deliver(conflict)).status).toBe(409);
  });

  it("is default-off and requires Access, a fresh timestamp, and an exact-body signature", async () => {
    const payload = envelope("event", "catalog-auth", 13, { event: { action: "tombstone", publicId: "svc-map", sourceVersion: "v3" } });
    const disabled = await deliver(payload);
    env.PROJECT_ALPHA_CATALOG_SYNC_ENABLED = "false";
    expect((await deliver(payload)).status).toBe(404);
    env.PROJECT_ALPHA_CATALOG_SYNC_ENABLED = "true";
    expect(disabled.status).toBe(200);

    expect((await deliver(envelope("event", "catalog-auth-bad-access", 14, { event: { action: "tombstone", publicId: "svc-map", sourceVersion: "v4" } }), { accessVerifier: async () => { throw new Error("catalog-access-invalid"); } })).status).toBe(401);
    expect((await deliver(envelope("event", "catalog-auth-expired", 14, { event: { action: "tombstone", publicId: "svc-map", sourceVersion: "v4" } }), { timestamp: "2020-01-01T00:00:00.000Z" })).status).toBe(401);
    expect((await deliver(envelope("event", "catalog-auth-signature", 14, { event: { action: "tombstone", publicId: "svc-map", sourceVersion: "v4" } }), { signature: `sha256=${"0".repeat(64)}` })).status).toBe(401);
  });

  it("rejects an oversized streamed body even when Content-Length is absent", async () => {
    const response = await handleProjectAlphaCatalogRequest(new Request(
      "https://client.test/api/internal/project-alpha/catalog-v2",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: new Uint8Array(128 * 1024 + 1),
      },
    ), env, access);
    expect(response.status).toBe(413);
  });
});

describe("catalog producer contract parser", () => {
  it("requires immutable public ids and exact allowlisted wire fields", () => {
    expect(() => parseCatalogProjectionDelivery(envelope("event", "parser-ok", 1, { event: { action: "upsert", item: item("svc-map") } }), applicationKey)).not.toThrow();
    expect(() => parseCatalogProjectionDelivery(envelope("event", "parser-numeric-id", 1, { event: { action: "upsert", item: { ...item("svc-map"), publicId: 42 } } }), applicationKey)).toThrow();
    expect(() => parseCatalogProjectionDelivery({ ...envelope("event", "parser-secret", 1, { event: { action: "tombstone", publicId: "svc-map", sourceVersion: "v2" } }), apiKey: "must-not-be-in-body" }, applicationKey)).toThrow();
  });

  it("accepts the shared zero-question fixture and enforces every compatibility bound", () => {
    const valid = compatibilityFixture.validItems[0]!;
    expect(() => parseCatalogProjectionDelivery(envelope("event", "parser-shared-fixture", 1, { event: { action: "upsert", item: valid } }), applicationKey)).not.toThrow();
    for (const invalid of [
      { ...valid, displayOrder: -1 },
      { ...valid, displayOrder: 1_000_001 },
      { ...valid, geometryRequirement: "sometimes" },
      { ...valid, category: "" },
      { ...valid, category: "x".repeat(101) },
      { ...valid, questions: Array.from({ length: 11 }, (_, index) => ({ id: `q${index}`, label: `Question ${index}`, type: "boolean", required: false })) },
    ]) {
      expect(() => parseCatalogProjectionDelivery(envelope("event", "parser-invalid-bound", 1, { event: { action: "upsert", item: invalid } }), applicationKey)).toThrow();
    }
    const { category: _category, ...missingCategory } = valid;
    expect(() => parseCatalogProjectionDelivery(envelope("event", "parser-missing-category", 1, { event: { action: "upsert", item: missingCategory } }), applicationKey)).toThrow();
  });
});
