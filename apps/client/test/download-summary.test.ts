import { describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {} }));
import worker, { classifyPublicRateLimit } from "../src/worker/index";
import {
  createDownloadTombstoneIndex, DOWNLOAD_TOMBSTONES_FOR_SCOPE_SQL, downloadTombstoneScopeBounds,
  listDownloadableObjects, summarizeDownloadableObjects,
} from "../src/worker/downloadable-files";
import { encodeItemRef } from "../src/worker/files";
import { createSessionCookie } from "../src/worker/security";

describe("authorized download-all summary", () => {
  it("indexes exact and prefix tombstones without changing their raw-key boundaries", () => {
    const isTombstoned = createDownloadTombstoneIndex([
      { physical_key: "Jobs/Clients/Acme/exact.txt", tombstone_kind: "exact" },
      { physical_key: "Jobs/Clients/Acme/Field/", tombstone_kind: "prefix" },
      { physical_key: "legacy-prefix", tombstone_kind: "prefix" },
    ]);

    expect(isTombstoned("Jobs/Clients/Acme/exact.txt")).toBe(true);
    expect(isTombstoned("Jobs/Clients/Acme/exact.txt/child")).toBe(false);
    expect(isTombstoned("Jobs/Clients/Acme/Field/flight/photo.jpg")).toBe(true);
    expect(isTombstoned("Jobs/Clients/Acme/Field-archive/photo.jpg")).toBe(false);
    expect(isTombstoned("legacy-prefix-sibling.txt")).toBe(true);
    expect(isTombstoned("Jobs/Other/private.txt")).toBe(false);
  });

  it("selects scoped tombstones in SQLite for high Unicode descendants and prefix ancestors", async () => {
    const runtime = new Miniflare({
      compatibilityDate: "2026-07-16",
      modules: true,
      script: "export default {}",
      d1Databases: { DELIVERY_DB: crypto.randomUUID() },
    });
    try {
      const database = await runtime.getD1Database("DELIVERY_DB");
      await database.prepare("CREATE TABLE delivery_tombstones (physical_key TEXT NOT NULL, tombstone_kind TEXT NOT NULL, restored_at TEXT)").run();
      const root = "Jobs/Clients/Acme/";
      const descendantKeys = [
        `${root}plain.txt`,
        `${root}\uffff-high.txt`,
        `${root}\u{10000}-astral.txt`,
      ];
      const rows = [
        ...descendantKeys.map(key => database.prepare("INSERT INTO delivery_tombstones VALUES(?, 'exact', NULL)").bind(key)),
        database.prepare("INSERT INTO delivery_tombstones VALUES(?, 'prefix', NULL)").bind("Jobs/Clients/"),
        database.prepare("INSERT INTO delivery_tombstones VALUES(?, 'prefix', NULL)").bind("Jobs/Clients/Acme-backup/"),
        database.prepare("INSERT INTO delivery_tombstones VALUES(?, 'exact', NULL)").bind("Jobs/Clients/Acme"),
        database.prepare("INSERT INTO delivery_tombstones VALUES(?, 'exact', 'restored')").bind(`${root}restored.txt`),
      ];
      await database.batch(rows);

      const scope = downloadTombstoneScopeBounds(root);
      const result = await database.prepare(DOWNLOAD_TOMBSTONES_FOR_SCOPE_SQL)
        .bind(scope.root, scope.upperExclusive, scope.root).all<{ physical_key: string; tombstone_kind: string }>();
      expect(result.results.map((row: { physical_key: string }) => row.physical_key).sort()).toEqual([
        ...descendantKeys,
        "Jobs/Clients/",
      ].sort());
      expect(scope.upperExclusive).toBe("Jobs/Clients/Acme0");
    } finally {
      await runtime.dispose();
    }
  });

  it("handles a large tombstone and object set with bounded lookup work", async () => {
    const root = "Jobs/Clients/Scale/";
    const tombstones = Array.from({ length: 8_000 }, (_, index) => ({
      physical_key: `${root}deleted-${index}/`,
      tombstone_kind: "prefix" as const,
    }));
    const visible = Array.from({ length: 8_000 }, (_, index) => ({
      key: `${root}visible-${index}/photo.jpg`, size: 1, etag: `etag-${index}`, customMetadata: {},
    }));
    const deleted = tombstones.map((tombstone, index) => ({
      key: `${tombstone.physical_key}photo.jpg`, size: 1, etag: `deleted-${index}`, customMetadata: {},
    }));
    const bucket = { list: vi.fn(async () => ({ objects: [...visible, ...deleted], truncated: false })) };

    const objects = await listDownloadableObjects(bucket as never, root, tombstones);
    expect(objects).toHaveLength(visible.length);
    expect(objects[0]?.key).toBe(`${root}visible-0/photo.jpg`);
    expect(objects.at(-1)?.key).toBe(`${root}visible-7999/photo.jpg`);
  });

  it("uses the manifest limiter and rejects requests without a share session", async () => {
    expect(classifyPublicRateLimit("GET", "/api/public/shares/public/download-summary"))
      .toEqual({ binding: "PUBLIC_MANIFEST_RATE_LIMITER", scope: "download-summary" });
    const response = await worker.fetch(new Request("https://client.example/api/public/shares/public/download-summary"), {
      ENVIRONMENT: "development", DELIVERY_SESSION_SECRET: "s".repeat(48), SESSION_KEY_ID: "v1",
    } as never, { waitUntil() {}, passThroughOnException() {} } as never);
    expect(response.status).toBe(401);
  });

  it("binds the aggregate to the active cookie share and never accepts a browser-supplied root", async () => {
    const share = { id: "share-a", public_id: "public-a", project_id: "project-a", token_hash: "hash", label: null, password_hash: null, password_salt: null, password_iterations: null, password_algorithm: null, expires_at: null, revoked_at: null, revoked_reason: null, unavailable_since: null, share_version: 3, client_name: "Acme", project_name: "North", r2_prefix: "Jobs/Clients/Acme/" };
    const summaryPrefixes: string[] = [];
    const statementFor = (query: string) => {
      let values: unknown[] = [];
      const statement = { bind(...bound: unknown[]) { values = bound; return statement; }, async first<T>() {
        if (query.includes("FROM shares s LEFT JOIN projects") && query.includes("s.id=? AND s.public_id=?")) return values[1] === share.public_id ? share as T : null;
        if (query.includes("FROM shares s LEFT JOIN projects") && query.includes("s.id=?")) return share as T;
        return null;
      }, async all<T>() { return { results: [] as T[] }; }, async run() { return { meta: { changes: 1 } }; } };
      return statement;
    };
    const database = { prepare: statementFor, withSession() { return database; } };
    const bucket = { async list(options: { prefix: string; delimiter?: string }) {
      if (options.delimiter) {
        expect(options.prefix).toBe(share.r2_prefix);
        return { objects: [{ key: `${share.r2_prefix}photo.jpg`, size: 25, etag: "a", customMetadata: {} }], delimitedPrefixes: [], truncated: false };
      }
      summaryPrefixes.push(options.prefix);
      return { objects: [{ key: `${options.prefix}photo.jpg`, size: 25, etag: "a", customMetadata: {} }], truncated: false };
    } };
    const secret = "s".repeat(48); const cookie = (await createSessionCookie(secret, "v1", share.id, share.share_version, Date.now() + 60_000)).split(";")[0]!;
    const env = { ENVIRONMENT: "development", DELIVERY_SESSION_SECRET: secret, SESSION_KEY_ID: "v1", AUDIT_IP_SECRET: "a".repeat(48), DELIVERY_DB: database, DATA_BUCKET: bucket, PUBLIC_MANIFEST_RATE_LIMITER: { async limit() { return { success: true }; } } } as never;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
    const valid = await worker.fetch(new Request("https://client.example/api/public/shares/public-a/download-summary?root=Jobs/Other/", { headers: { Cookie: cookie } }), env, ctx);
    expect(valid.status).toBe(200); expect(await valid.json()).toEqual({ fileCount: 1, totalBytes: 25, knownBytes: 25, unknownSizeCount: 0 }); expect(summaryPrefixes).toEqual([share.r2_prefix]);
    const folder = encodeItemRef("Field/Edited");
    const nested = await worker.fetch(new Request(`https://client.example/api/public/shares/public-a/download-summary?folder=${folder}`, { headers: { Cookie: cookie } }), env, ctx);
    expect(nested.status).toBe(200); expect(await nested.json()).toEqual({ fileCount: 1, totalBytes: 25, knownBytes: 25, unknownSizeCount: 0 });
    expect(summaryPrefixes).toEqual([share.r2_prefix, `${share.r2_prefix}Field/Edited/`]);
    const invalid = await worker.fetch(new Request(`https://client.example/api/public/shares/public-a/download-summary?folder=${encodeItemRef("../Other")}`, { headers: { Cookie: cookie } }), env, ctx);
    expect(invalid.status).toBe(404); expect(summaryPrefixes).toHaveLength(2);
    const crossShare = await worker.fetch(new Request("https://client.example/api/public/shares/public-b/download-summary", { headers: { Cookie: cookie } }), env, ctx);
    expect(crossShare.status).toBe(404); expect(summaryPrefixes).toHaveLength(2);
  });

  it("paginates only the authorized root and excludes hidden, moved, marker, tombstoned, and out-of-scope objects", async () => {
    const calls: Array<{ prefix: string; cursor?: string }> = [];
    const bucket = { list: vi.fn(async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
      calls.push({ prefix, cursor });
      if (!cursor) return { objects: [
        { key: `${prefix}photo.jpg`, size: 100, etag: "a", customMetadata: {} },
        { key: `${prefix}nested/report.pdf`, size: 200, etag: "b", customMetadata: {} },
        { key: `${prefix}_ltds/private.bin`, size: 900, etag: "c", customMetadata: {} },
        { key: `${prefix}moved.jpg`, size: 300, etag: "d", customMetadata: { ltdsMoveMarker: "ltds-moved-source-v1" } },
        { key: "Jobs/Other/leak.txt", size: 999, etag: "e", customMetadata: {} },
      ], truncated: true, cursor: "next" };
      return { objects: [
        { key: `${prefix}tombstoned.txt`, size: 400, etag: "f", customMetadata: {} },
        { key: `${prefix}folder/`, size: 0, etag: "g", customMetadata: {} },
        { key: `${prefix}video.mp4`, size: 500, etag: "h", customMetadata: {} },
      ], truncated: false };
    }) };
    const objects = await listDownloadableObjects(bucket as never, "Jobs/Clients/Acme/", [{ physical_key: "Jobs/Clients/Acme/tombstoned.txt", tombstone_kind: "exact" }]);
    expect(objects.map(object => object.key)).toEqual(["Jobs/Clients/Acme/photo.jpg", "Jobs/Clients/Acme/nested/report.pdf", "Jobs/Clients/Acme/video.mp4"]);
    expect(summarizeDownloadableObjects(objects)).toEqual({ fileCount: 3, totalBytes: 800, knownBytes: 800, unknownSizeCount: 0 });
    expect(calls).toEqual([{ prefix: "Jobs/Clients/Acme/", cursor: undefined }, { prefix: "Jobs/Clients/Acme/", cursor: "next" }]);
  });

  it("does not claim a total when a size is unknown or unsafe", () => {
    expect(summarizeDownloadableObjects([{ size: 12 }, { size: Number.NaN }, { size: -1 }]))
      .toEqual({ fileCount: 3, totalBytes: null, knownBytes: 12, unknownSizeCount: 2 });
  });
});
