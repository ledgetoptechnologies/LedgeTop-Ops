import { Miniflare } from "miniflare";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCatalogSourceContext, PRIMARY_ALPHA_SOURCE_ID, type CatalogSourceContext } from "@ltds/shared";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import compatibilityFixture from "../../../packages/shared/fixtures/project-alpha-catalog-v2.json";
import { listServiceCatalog } from "../src/worker/client-portal/request-v2";
import { applyCatalogProjectionDelivery, handleProjectAlphaCatalogRequest, parseCatalogProjectionDelivery } from "../src/worker/project-alpha-catalog";
import type { Env } from "../src/worker/types";

const applicationKey = "field_operations_catalog";
const secret = "catalog-test-secret-at-least-thirty-two-bytes";
const keyId = "catalog-test-v1";
const snapshotHash = "a".repeat(64);
const access = async () => undefined;

async function signature(body: string, timestamp: string, deliveryId: string, signingKeyId = keyId, signingSecret = secret): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}\nPOST\n/api/internal/project-alpha/catalog-v2\n${signingKeyId}\n${deliveryId}\n${body}`));
  return `sha256=${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
async function bodyHash(body:string):Promise<string>{const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(body));return[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");}

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
    const directory = new URL("../migrations/", import.meta.url);
    for (const filename of readdirSync(directory).filter(name => /^\d+.*\.sql$/.test(name) && name <= "0156_catalog_source_isolation.sql").sort()) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(filename, directory), "utf8"));
      if (statements.length) await db.batch(statements.map(statement => db.prepare(statement)));
    }
    env = {
      DELIVERY_DB: db,
      PROJECT_ALPHA_CATALOG_SYNC_ENABLED: "true",
      PROJECT_ALPHA_CATALOG_APPLICATION_KEY: applicationKey,
      PROJECT_ALPHA_CATALOG_HMAC_KEY_ID: keyId,
      PROJECT_ALPHA_CATALOG_HMAC_SECRET: secret,
    } as Env;
  }, 60_000);

  afterAll(async () => miniflare.dispose());

  async function deliver(payload: Record<string, unknown>, options: { timestamp?: string; signature?: string; keyId?: string; secret?: string; accessVerifier?: typeof access; sourceHeader?: string } = {}) {
    const body = JSON.stringify(payload);
    const timestamp = options.timestamp ?? new Date().toISOString();
    const signingKeyId = options.keyId ?? keyId;
    return handleProjectAlphaCatalogRequest(new Request("https://client.test/api/internal/project-alpha/catalog-v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Portal-Integration-Application-Key": applicationKey,
        "X-Portal-Integration-Timestamp": timestamp,
        "X-Portal-Integration-Body-SHA256": await bodyHash(body),
        "X-Portal-Integration-Key-Id": signingKeyId,
        "X-Portal-Integration-Delivery-Id": String(payload.deliveryId),
        "X-Portal-Integration-Signature": options.signature ?? await signature(body, timestamp,String(payload.deliveryId), signingKeyId, options.secret ?? secret),
        ...(options.sourceHeader ? { "X-Portal-Integration-Source-Id": options.sourceHeader } : {}),
      },
      body,
    }), env, options.accessVerifier ?? access);
  }

  async function apply(source: CatalogSourceContext, payload: Record<string, unknown>, targetEnv = env) {
    return applyCatalogProjectionDelivery(targetEnv, source, parseCatalogProjectionDelivery(payload, applicationKey), await bodyHash(JSON.stringify(payload)));
  }

  async function seed(source: CatalogSourceContext, generation = "shared-generation", sequence = 1, name = "Original service") {
    await apply(source, envelope("snapshot.page", `seed-page-${sequence}`, sequence, {
      sourceGeneration: generation, snapshotHash, pageCount: 1, pageNumber: 1, itemCount: 1,
      items: [{ ...item("svc-shared"), name }],
    }));
    await apply(source, envelope("snapshot.activate", `seed-activate-${sequence}`, sequence, {
      sourceGeneration: generation, snapshotHash, pageCount: 1, itemCount: 1,
    }));
  }

  /** Inject a competing write after all optimistic reads but before the batch. */
  function beforeWriteBatch(hook: () => Promise<void>): Env {
    let pending = true;
    const wrapped = new Proxy(db, {
      get(target, property) {
        if (property === "withSession") return (...args: Parameters<D1Database["withSession"]>) => {
          const session = target.withSession(...args);
          return new Proxy(session, {
            get(current, key) {
              if (key === "batch") return async (statements: D1PreparedStatement[]) => {
                if (pending) { pending = false; await hook(); }
                return current.batch(statements);
              };
              const value = Reflect.get(current, key);
              return typeof value === "function" ? value.bind(current) : value;
            },
          });
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { ...env, DELIVERY_DB: wrapped };
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

  it("accepts only the configured current or previous rotation key", async () => {
    const previousKeyId = "catalog-test-v0";
    const previousSecret = "catalog-previous-secret-at-least-thirty-two-bytes";
    env.PROJECT_ALPHA_CATALOG_PREVIOUS_HMAC_KEY_ID = previousKeyId;
    const payload = envelope("event", "catalog-rotation-14", 14, { event: { action: "tombstone", publicId: "svc-map", sourceVersion: "v4" } });
    expect((await deliver(payload, { keyId: previousKeyId, secret: previousSecret })).status).toBe(404);
    env.PROJECT_ALPHA_CATALOG_PREVIOUS_HMAC_SECRET = previousSecret;
    expect((await deliver(payload, { keyId: previousKeyId, secret: previousSecret })).status).toBe(200);
    expect((await deliver({ ...payload, deliveryId: "catalog-rotation-unknown" }, { keyId: "catalog-test-unknown" })).status).toBe(401);
    delete env.PROJECT_ALPHA_CATALOG_PREVIOUS_HMAC_KEY_ID;
    delete env.PROJECT_ALPHA_CATALOG_PREVIOUS_HMAC_SECRET;
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

  it("isolates identical source IDs, generations, sequences and receipts across two internal sources", async () => {
    const a = createCatalogSourceContext("project-alpha:catalog-a");
    const b = createCatalogSourceContext("project-alpha:catalog-b");
    await seed(a, "same-generation", 1, "A service");
    await seed(b, "same-generation", 1, "B service");
    expect((await db.prepare("SELECT source_id,name FROM pa_service_catalog_items WHERE source_id IN (?,?) AND active=1 ORDER BY source_id")
      .bind(a.sourceId, b.sourceId).all()).results).toEqual([{ source_id: a.sourceId, name: "A service" }, { source_id: b.sourceId, name: "B service" }]);
    const event = envelope("event", "same-event", 2, { sourceGeneration: "same-generation", event: { action: "tombstone", publicId: "svc-shared", sourceVersion: "v2" } });
    expect(await apply(a, event)).toBe("completed");
    expect(await apply(a, event)).toBe("duplicate");
    expect(await db.prepare("SELECT active FROM pa_service_catalog_items WHERE source_id=? AND public_id='svc-shared'").bind(b.sourceId).first("active")).toBe(1);
    expect(await apply(b, event)).toBe("completed");
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_service_catalog_projection_receipts WHERE delivery_id='same-event'").first("count")).toBe(2);
    await expect(apply(a, { ...event, sourceSequence: 3 })).rejects.toThrow("catalog-delivery-id-conflict");
  }, 15_000);

  it("a source snapshot only supersedes its own catalog and checkpoint", async () => {
    const a = createCatalogSourceContext("project-alpha:snapshot-a");
    const b = createCatalogSourceContext("project-alpha:snapshot-b");
    await seed(a); await seed(b);
    const bBefore = (await db.prepare("SELECT * FROM pa_service_catalog_checkpoint WHERE source_id=?").bind(b.sourceId).first());
    await apply(a, envelope("snapshot.page", "empty-page", 2, { sourceGeneration: "new-empty", snapshotHash, pageCount: 1, pageNumber: 1, itemCount: 0, items: [] }));
    await apply(a, envelope("snapshot.activate", "empty-activate", 2, { sourceGeneration: "new-empty", snapshotHash, pageCount: 1, itemCount: 0 }));
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_service_catalog_items WHERE source_id=? AND active=1").bind(a.sourceId).first("count")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_service_catalog_items WHERE source_id=? AND active=1").bind(b.sourceId).first("count")).toBe(1);
    expect(await db.prepare("SELECT * FROM pa_service_catalog_checkpoint WHERE source_id=?").bind(b.sourceId).first()).toEqual(bBefore);
    expect(await db.prepare("SELECT status FROM pa_service_catalog_generations WHERE source_id=? AND source_generation='shared-generation'").bind(b.sourceId).first("status")).toBe("active");
  }, 15_000);

  it("the authenticated HTTP endpoint stays primary despite a source header and rejects a body source selector", async () => {
    const other = createCatalogSourceContext("project-alpha:http-other");
    await seed(other, "catalog-2026-08-13", 14);
    const otherBefore = await db.prepare("SELECT * FROM pa_service_catalog_checkpoint WHERE source_id=?").bind(other.sourceId).first();
    const payload = envelope("event", "source-header-test", 15, { event: { action: "upsert", item: item("svc-http-primary") } });
    expect((await deliver(payload, { sourceHeader: other.sourceId })).status).toBe(200);
    expect(await db.prepare("SELECT source_id FROM pa_service_catalog_items WHERE public_id='svc-http-primary'").first("source_id")).toBe(PRIMARY_ALPHA_SOURCE_ID);
    expect(await db.prepare("SELECT * FROM pa_service_catalog_checkpoint WHERE source_id=?").bind(other.sourceId).first()).toEqual(otherBefore);
    expect((await deliver({ ...payload, deliveryId: "body-source", sourceId: other.sourceId })).status).toBe(422);
    expect((await listServiceCatalog(env)).some(service => service.publicId === "svc-shared")).toBe(false);
  }, 15_000);

  it("rolls back stale activation after an intervening event, including its receipt and audit", async () => {
    const source = createCatalogSourceContext("project-alpha:activation-race");
    await seed(source);
    await apply(source, envelope("snapshot.page", "race-page", 2, { sourceGeneration: "new-generation", snapshotHash, pageCount: 1, pageNumber: 1, itemCount: 0, items: [] }));
    const activation = envelope("snapshot.activate", "stale-activation", 2, { sourceGeneration: "new-generation", snapshotHash, pageCount: 1, itemCount: 0 });
    const raced = beforeWriteBatch(async () => {
      await apply(source, envelope("event", "winner-event", 2, { sourceGeneration: "shared-generation", event: { action: "upsert", item: item("svc-event-winner") } }));
    });
    await expect(apply(source, activation, raced)).rejects.toThrow("catalog-projection-conflict");
    expect(await db.prepare("SELECT name FROM pa_service_catalog_items WHERE source_id=? AND public_id='svc-event-winner' AND active=1").bind(source.sourceId).first("name")).not.toBeNull();
    expect(await db.prepare("SELECT status FROM pa_service_catalog_generations WHERE source_id=? AND source_generation='new-generation'").bind(source.sourceId).first("status")).toBe("staging");
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_service_catalog_projection_receipts WHERE source_id=? AND delivery_id='stale-activation'").bind(source.sourceId).first("count")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_service_catalog_projection_audit WHERE source_id=? AND delivery_id='stale-activation'").bind(source.sourceId).first("count")).toBe(0);
  }, 15_000);

  it("rejects a competing same-sequence event without deactivating the winner", async () => {
    const source = createCatalogSourceContext("project-alpha:event-race");
    await seed(source);
    const raced = beforeWriteBatch(async () => {
      await apply(source, envelope("event", "event-race-winner", 2, { sourceGeneration: "shared-generation", event: { action: "upsert", item: { ...item("svc-shared", "v2"), name: "Winning service" } } }));
    });
    await expect(apply(source, envelope("event", "event-race-loser", 2, { sourceGeneration: "shared-generation", event: { action: "tombstone", publicId: "svc-shared", sourceVersion: "v3" } }), raced)).rejects.toThrow("catalog-projection-conflict");
    expect(await db.prepare("SELECT name FROM pa_service_catalog_items WHERE source_id=? AND public_id='svc-shared' AND active=1").bind(source.sourceId).first("name")).toBe("Winning service");
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_service_catalog_projection_receipts WHERE source_id=? AND delivery_id='event-race-loser'").bind(source.sourceId).first("count")).toBe(0);
  }, 15_000);

  it("returns duplicate for a same-delivery write race without recording a second audit", async () => {
    const source = createCatalogSourceContext("project-alpha:receipt-race");
    await seed(source);
    const event = envelope("event", "same-receipt-race", 2, { sourceGeneration: "shared-generation", event: { action: "tombstone", publicId: "svc-shared", sourceVersion: "v2" } });
    const raced = beforeWriteBatch(async () => { await apply(source, event); });
    expect(await apply(source, event, raced)).toBe("duplicate");
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_service_catalog_projection_audit WHERE source_id=? AND delivery_id=?").bind(source.sourceId, event.deliveryId).first("count")).toBe(1);
  }, 15_000);

  it("rejects invalid internal source contexts without creating checkpoints or receipts", async () => {
    const before = await db.prepare(`SELECT
      (SELECT COUNT(*) FROM pa_service_catalog_checkpoint) checkpoints,
      (SELECT COUNT(*) FROM pa_service_catalog_projection_receipts) receipts`).first();
    const event = envelope("event", "invalid-source-event", 1, {
      event: { action: "tombstone", publicId: "svc-shared", sourceVersion: "v2" },
    });
    for (const sourceId of ["", "delivery:local", "project-alpha:", "Project-Alpha:primary",
      "project-alpha:Primary", " project-alpha:primary", "project-alpha:primary ",
      "project-alpha:-invalid", "project-alpha:invalid/child", `project-alpha:${"a".repeat(65)}`]) {
      expect(() => createCatalogSourceContext(sourceId), sourceId).toThrow("catalog-source-invalid");
      // A structurally typed caller cannot bypass the application boundary's
      // second validation simply by constructing the context object itself.
      await expect(apply({ sourceId }, event)).rejects.toThrow("catalog-source-invalid");
    }
    expect(await db.prepare(`SELECT
      (SELECT COUNT(*) FROM pa_service_catalog_checkpoint) checkpoints,
      (SELECT COUNT(*) FROM pa_service_catalog_projection_receipts) receipts`).first()).toEqual(before);
  });

  it("rejects a stale staged page after another writer completes and activates its generation", async () => {
    const source = createCatalogSourceContext("project-alpha:staging-race");
    const page = { sourceGeneration: "staging-race-generation", snapshotHash, pageCount: 2, itemCount: 2 };
    await apply(source, envelope("snapshot.page", "staging-race-first", 1, {
      ...page, pageNumber: 1, items: [item("svc-first")],
    }));
    const raced = beforeWriteBatch(async () => {
      await apply(source, envelope("snapshot.page", "staging-race-winner", 1, {
        ...page, pageNumber: 2, items: [{ ...item("svc-second"), name: "Winning staged service" }],
      }));
      await apply(source, envelope("snapshot.activate", "staging-race-activate", 1, page));
    });
    await expect(apply(source, envelope("snapshot.page", "staging-race-loser", 1, {
      ...page, pageNumber: 2, items: [{ ...item("svc-second"), name: "Late staged service" }],
    }), raced)).rejects.toThrow("catalog-projection-conflict");
    expect(await db.prepare("SELECT name FROM pa_service_catalog_items WHERE source_id=? AND public_id='svc-second' AND active=1")
      .bind(source.sourceId).first("name")).toBe("Winning staged service");
    expect(await db.prepare("SELECT status FROM pa_service_catalog_generations WHERE source_id=? AND source_generation=?")
      .bind(source.sourceId, page.sourceGeneration).first("status")).toBe("active");
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_service_catalog_projection_receipts WHERE source_id=? AND delivery_id='staging-race-loser'")
      .bind(source.sourceId).first("count")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_service_catalog_projection_audit WHERE source_id=? AND delivery_id='staging-race-loser'")
      .bind(source.sourceId).first("count")).toBe(0);
  }, 15_000);

  it.each(["event", "snapshot"] as const)("rolls back %s when version content conflicts after validation without checkpoint drift", async kind => {
    const source = createCatalogSourceContext(`project-alpha:version-race-${kind}`);
    await seed(source);
    const changed = { ...item("svc-shared", "v2"), name: "Requested version content" };
    if (kind === "snapshot") {
      await apply(source, envelope("snapshot.page", "version-race-page", 2, {
        sourceGeneration: "version-race-generation", snapshotHash, pageCount: 1, pageNumber: 1, itemCount: 1, items: [changed],
      }));
    }
    const before = await db.prepare("SELECT * FROM pa_service_catalog_checkpoint WHERE source_id=?").bind(source.sourceId).first();
    const raced = beforeWriteBatch(async () => {
      await db.prepare(`INSERT INTO pa_service_catalog_items
        (source_id,public_id,source_version,name,summary,category,display_order,geometry_requirement,question_schema_json,active,source_updated_at)
        VALUES(?,'svc-shared','v2','Previously stored different content',NULL,'Aerial services',10,'none','[]',0,'2026-08-13T18:00:00.000Z')`)
        .bind(source.sourceId).run();
    });
    const payload = kind === "event"
      ? envelope("event", "version-race-loser", 2, { sourceGeneration: "shared-generation", event: { action: "upsert", item: changed } })
      : envelope("snapshot.activate", "version-race-loser", 2, { sourceGeneration: "version-race-generation", snapshotHash, pageCount: 1, itemCount: 1 });
    await expect(apply(source, payload, raced)).rejects.toThrow("catalog-projection-conflict");
    expect(await db.prepare("SELECT * FROM pa_service_catalog_checkpoint WHERE source_id=?").bind(source.sourceId).first()).toEqual(before);
    expect(await db.prepare("SELECT name FROM pa_service_catalog_items WHERE source_id=? AND public_id='svc-shared' AND active=1")
      .bind(source.sourceId).first("name")).toBe("Original service");
    expect(await db.prepare("SELECT name FROM pa_service_catalog_items WHERE source_id=? AND public_id='svc-shared' AND source_version='v2'")
      .bind(source.sourceId).first("name")).toBe("Previously stored different content");
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_service_catalog_projection_receipts WHERE source_id=? AND delivery_id='version-race-loser'")
      .bind(source.sourceId).first("count")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) count FROM pa_service_catalog_projection_audit WHERE source_id=? AND delivery_id='version-race-loser'")
      .bind(source.sourceId).first("count")).toBe(0);
  }, 15_000);
});

describe("catalog producer contract parser", () => {
  it("does not coerce non-string values into a trusted source context", () => {
    const values: unknown[] = [undefined, null, 1, true, [PRIMARY_ALPHA_SOURCE_ID],
      new String(PRIMARY_ALPHA_SOURCE_ID), { toString: () => PRIMARY_ALPHA_SOURCE_ID }];
    for (const value of values) {
      expect(() => createCatalogSourceContext(value)).toThrow("catalog-source-invalid");
    }
    expect(createCatalogSourceContext(PRIMARY_ALPHA_SOURCE_ID)).toEqual({ sourceId: PRIMARY_ALPHA_SOURCE_ID });
  });

  it("requires immutable public ids and exact allowlisted wire fields", () => {
    expect(() => parseCatalogProjectionDelivery(envelope("event", "parser-ok", 1, { event: { action: "upsert", item: item("svc-map") } }), applicationKey)).not.toThrow();
    expect(() => parseCatalogProjectionDelivery(envelope("event", "parser-numeric-id", 1, { event: { action: "upsert", item: { ...item("svc-map"), publicId: 42 } } }), applicationKey)).toThrow();
    expect(() => parseCatalogProjectionDelivery({ ...envelope("event", "parser-secret", 1, { event: { action: "tombstone", publicId: "svc-map", sourceVersion: "v2" } }), apiKey: "must-not-be-in-body" }, applicationKey)).toThrow();
  });

  it("accepts the shared zero-question fixture and enforces every compatibility bound", () => {
    const valid = compatibilityFixture.validItems[0]!;
    expect(compatibilityFixture.producerPolicy).toMatchObject({
      publishedEntryTypes: ["service"], feesPublished: false, bundlesPublished: false,
    });
    expect(() => parseCatalogProjectionDelivery(envelope("event", "parser-shared-fixture", 1, { event: { action: "upsert", item: valid } }), applicationKey)).not.toThrow();
    for (const specimen of compatibilityFixture.invalidItems) {
      expect(
        () => parseCatalogProjectionDelivery(envelope("event", `parser-${specimen.name}`, 1, { event: { action: "upsert", item: specimen.item } }), applicationKey),
        specimen.name,
      ).toThrow();
    }
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
