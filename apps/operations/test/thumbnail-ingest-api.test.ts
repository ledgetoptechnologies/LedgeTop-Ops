import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { dispatchThumbnailIngestRequest } from "../src/worker/thumbnail-ingest-api";
import { drainThumbnailCleanup, handleRemovedPrebuiltThumbnail, reconcileManagedThumbnailOrphans, reconcileThumbnailRegistrations, thumbnailObjectKey } from "../src/worker/image-thumbnails";
import type { Env } from "../src/worker/types";

vi.mock("@cloudflare/containers", () => ({ getContainer: vi.fn() }));

const HOST = "ops.example.test";
const SECRET = "synthetic-thumbnail-ingest-secret-000000000000";
const SOURCE_KEY = "Jobs/Clients/Synthetic/photo.jpg";
const SOURCE_ETAG = "source-v1";
const SOURCE_SIZE = 1000;
const FINGERPRINT = "a".repeat(64);
const PREFIX = `_ltds/derivatives/thumbnails/v1/prebuilt/${SOURCE_KEY}/`;
const MANIFEST_KEY = `${PREFIX}${FINGERPRINT}.json`;
const THUMBNAIL_KEY = `${PREFIX}${FINGERPRINT}.webp`;

interface StoredObject {
  key: string;
  etag: string;
  httpEtag: string;
  size: number;
  uploaded: Date;
  httpMetadata: { contentType?: string };
  customMetadata?: Record<string, string>;
  checksums?: { sha256?: ArrayBuffer };
  bytes?: Uint8Array<ArrayBuffer>;
}

function migration(name: string): string {
  return readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n").replace(/^\s*--.*$/gm, "")
    .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "").replace(/\s*\n\s*/g, " ");
}

function webp(width = 320, height = 240): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(bytes.buffer).setUint32(4, 22, true);
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  bytes.set([(width - 1) & 0xff, ((width - 1) >>> 8) & 0xff, 0], 24);
  bytes.set([(height - 1) & 0xff, ((height - 1) >>> 8) & 0xff, 0], 27);
  return bytes;
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

function manifest(bytes = webp(), overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    provider: "ltds-truenas",
    sourceKey: SOURCE_KEY,
    sourceEtag: SOURCE_ETAG,
    sourceSize: SOURCE_SIZE,
    sourceMime: "image/jpeg",
    sourceFingerprint: { algorithm: "sha256", value: FINGERPRINT },
    rendererVersion: "synthetic-1.0.0",
    profile: "ltds-thumbnail-320x240-webp-v1",
    thumbnail: { key: THUMBNAIL_KEY, mime: "image/webp", width: 320, height: 240, bytes: bytes.byteLength, sha256: sha256(bytes) },
    createdAt: "2026-08-08T00:00:00Z",
    ...overrides,
  };
}

function request(manifestEtag = "manifest-v1", thumbnailEtag = "thumbnail-v1", secret = SECRET): Request {
  return new Request(`https://${HOST}/api/internal/thumbnail-ingest/v1`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, provider: "ltds-truenas", manifestKey: MANIFEST_KEY, manifestEtag, thumbnailKey: THUMBNAIL_KEY, thumbnailEtag }),
  });
}

describe("private prebuilt thumbnail registration", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let objects: Map<string, StoredObject>;
  let heads: string[];
  let gets: string[];
  let deletes: string[];
  let sends: unknown[];
  let env: Env;

  beforeAll(async () => {
    miniflare = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "thumbnail-prebuilt-ingest" } });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec("CREATE TABLE file_index(r2_key TEXT PRIMARY KEY,etag TEXT NOT NULL,size INTEGER NOT NULL,content_type TEXT,media_kind TEXT NOT NULL);");
    await db.exec("CREATE TABLE delivery_tombstones(id TEXT PRIMARY KEY,physical_key TEXT NOT NULL,tombstone_kind TEXT NOT NULL,restored_at TEXT);");
    for (const name of ["0106_image_thumbnail_jobs.sql", "0107_thumbnail_cleanup_jobs.sql", "0108_thumbnail_backfill_runs.sql", "0111_thumbnail_render_provenance.sql", "0151_thumbnail_render_not_before.sql"]) {
      await db.exec(migration(name));
    }
  });

  afterAll(async () => miniflare.dispose());

  beforeEach(async () => {
    await db.exec("DELETE FROM image_thumbnail_jobs; DELETE FROM image_thumbnail_cleanup_jobs; DELETE FROM file_index; DELETE FROM delivery_tombstones;");
    await db.exec("UPDATE image_thumbnail_registration_reconciliation SET cursor=NULL,scanned_count=0,cleaned_count=0,completed_cycles=0 WHERE singleton=1;");
    await db.exec("UPDATE image_thumbnail_managed_orphan_reconciliation SET cursor=NULL,scanned_count=0,cleaned_count=0,completed_cycles=0 WHERE singleton=1;");
    await db.prepare("INSERT INTO file_index(r2_key,etag,size,content_type,media_kind) VALUES(?,?,?,?,?)")
      .bind(SOURCE_KEY, `\"${SOURCE_ETAG}\"`, SOURCE_SIZE, "image/jpeg", "image").run();
    objects = new Map(); heads = []; gets = []; deletes = []; sends = [];
    objects.set(SOURCE_KEY, { key: SOURCE_KEY, etag: SOURCE_ETAG, httpEtag: `\"${SOURCE_ETAG}\"`, size: SOURCE_SIZE,
      uploaded: new Date(), httpMetadata: { contentType: "image/jpeg" },
      checksums: { sha256: Uint8Array.from(Buffer.from(FINGERPRINT, "hex")).buffer } });
    const thumbnailBytes = webp();
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest(thumbnailBytes)));
    objects.set(MANIFEST_KEY, { key: MANIFEST_KEY, etag: "manifest-v1", httpEtag: "\"manifest-v1\"", size: manifestBytes.byteLength,
      uploaded: new Date(), httpMetadata: { contentType: "application/json" }, bytes: manifestBytes });
    objects.set(THUMBNAIL_KEY, { key: THUMBNAIL_KEY, etag: "thumbnail-v1", httpEtag: "\"thumbnail-v1\"", size: thumbnailBytes.byteLength,
      uploaded: new Date(), httpMetadata: { contentType: "image/webp" }, bytes: thumbnailBytes });
    const bucket = {
      async head(key: string) { heads.push(key); return objects.get(key) || null; },
      async get(key: string, options?: { onlyIf?: { etagMatches?: string } }) {
        gets.push(key);
        const object = objects.get(key);
        if (!object || (options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== object.etag)) return null;
        const bytes = object.bytes ? Uint8Array.from(object.bytes) : new Uint8Array();
        return { ...object, body: new ReadableStream(), async arrayBuffer() { return Uint8Array.from(bytes).buffer; },
          async json<T>() { return JSON.parse(new TextDecoder().decode(bytes)) as T; } };
      },
      async delete(key: string | string[]) { for (const item of Array.isArray(key) ? key : [key]) { deletes.push(item); objects.delete(item); } },
      async list(options: { prefix?: string; limit?: number; cursor?: string }) {
        const found = [...objects.values()].filter((object) => object.key.startsWith(options.prefix || ""));
        return { objects: found.slice(0, options.limit || 1000), truncated: false };
      },
    };
    env = { DELIVERY_DB: db, DATA_BUCKET: bucket as never,
      THUMBNAIL_QUEUE: { async send(value: unknown) { sends.push(value); } } as never,
      THUMBNAIL_INGEST_SECRET: SECRET, THUMBNAIL_INGEST_EXPECTED_HOST: HOST } as unknown as Env;
  });

  it("rejects bad app authentication before any D1 or R2 access", async () => {
    const denied = { THUMBNAIL_INGEST_SECRET: SECRET, THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      DELIVERY_DB: { prepare() { throw new Error("no D1"); } }, DATA_BUCKET: { head() { throw new Error("no R2"); } } } as unknown as Env;
    expect((await dispatchThumbnailIngestRequest(request("manifest-v1", "thumbnail-v1", "wrong-secret-that-is-long-enough-000000"), denied))?.status).toBe(401);
  });

  it("fails closed when only the retired renderer secret alias is configured", async () => {
    const denied = { THUMBNAIL_RENDERER_AGENT_SECRET: SECRET, THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      DELIVERY_DB: { prepare() { throw new Error("no D1"); } }, DATA_BUCKET: { head() { throw new Error("no R2"); } } } as unknown as Env;
    expect((await dispatchThumbnailIngestRequest(request(), denied))?.status).toBe(401);
  });

  it("independently validates and registers exact current manifest, source, and bounded WebP identities", async () => {
    const response = await dispatchThumbnailIngestRequest(request(), env);
    expect(response?.status).toBe(200);
    expect(gets).toEqual([MANIFEST_KEY, THUMBNAIL_KEY]);
    expect(gets).not.toContain(SOURCE_KEY);
    expect(await db.prepare(`SELECT source_etag,thumbnail_key,thumbnail_etag,status,thumbnail_provider,thumbnail_profile,
      thumbnail_manifest_key,thumbnail_manifest_etag FROM image_thumbnail_jobs`).first()).toMatchObject({
        source_etag: SOURCE_ETAG, thumbnail_key: THUMBNAIL_KEY, thumbnail_etag: "thumbnail-v1", status: "ready",
        thumbnail_provider: "ltds-truenas", thumbnail_profile: "ltds-thumbnail-320x240-webp-v1",
        thumbnail_manifest_key: MANIFEST_KEY, thumbnail_manifest_etag: "manifest-v1",
      });
  });

  it("fails closed when the current R2 object has no matching full-object SHA-256", async () => {
    objects.get(SOURCE_KEY)!.checksums = undefined;
    expect((await dispatchThumbnailIngestRequest(request(), env))?.status).toBe(409);
    objects.get(SOURCE_KEY)!.checksums = { sha256: Uint8Array.from(Buffer.from("b".repeat(64), "hex")).buffer };
    expect((await dispatchThumbnailIngestRequest(request(), env))?.status).toBe(409);
    expect(await db.prepare("SELECT source_key FROM image_thumbnail_jobs").first()).toBeNull();
  });

  it("rejects same-name inference, stale source identity, invalid output hash, and trash", async () => {
    const bad = manifest(webp(), { sourceKey: "Jobs/Clients/Other/photo.jpg" });
    const badBytes = new TextEncoder().encode(JSON.stringify(bad));
    objects.set(MANIFEST_KEY, { ...objects.get(MANIFEST_KEY)!, size: badBytes.byteLength, bytes: badBytes });
    expect((await dispatchThumbnailIngestRequest(request(), env))?.status).toBe(400);
    const validManifest = manifest();
    objects.set(MANIFEST_KEY, { ...objects.get(MANIFEST_KEY)!, bytes: new TextEncoder().encode(JSON.stringify({
      ...validManifest, thumbnail: { ...validManifest.thumbnail, sha256: "b".repeat(64) },
    })) });
    objects.get(MANIFEST_KEY)!.size = objects.get(MANIFEST_KEY)!.bytes!.byteLength;
    expect((await dispatchThumbnailIngestRequest(request(), env))?.status).toBe(400);
    objects.get(MANIFEST_KEY)!.bytes = new TextEncoder().encode(JSON.stringify(manifest()));
    objects.get(MANIFEST_KEY)!.size = objects.get(MANIFEST_KEY)!.bytes!.byteLength;
    await db.prepare("UPDATE file_index SET etag='replacement' WHERE r2_key=?").bind(SOURCE_KEY).run();
    expect((await dispatchThumbnailIngestRequest(request(), env))?.status).toBe(409);
    await db.prepare("INSERT INTO delivery_tombstones(id,physical_key,tombstone_kind,restored_at) VALUES('trash',?,'exact',NULL)").bind(SOURCE_KEY).run();
    expect((await dispatchThumbnailIngestRequest(request(), env))?.status).toBe(409);
    expect(await db.prepare("SELECT source_key FROM image_thumbnail_jobs").first()).toBeNull();
  });

  it("does not let a delayed delete retire a recreated prebuilt object", async () => {
    expect((await dispatchThumbnailIngestRequest(request(), env))?.status).toBe(200);
    objects.set(THUMBNAIL_KEY, { ...objects.get(THUMBNAIL_KEY)!, etag: "thumbnail-v2", httpEtag: "\"thumbnail-v2\"" });
    await expect(handleRemovedPrebuiltThumbnail(env, THUMBNAIL_KEY, "thumbnail-v1")).resolves.toBe("stale");
    expect(await db.prepare("SELECT source_key FROM image_thumbnail_jobs").first()).not.toBeNull();
    expect(deletes).toEqual([]);
  });

  it("invalidates a real prebuilt deletion and queues the managed fallback", async () => {
    expect((await dispatchThumbnailIngestRequest(request(), env))?.status).toBe(200);
    objects.delete(THUMBNAIL_KEY);
    await expect(handleRemovedPrebuiltThumbnail(env, THUMBNAIL_KEY, "thumbnail-v1")).resolves.toBe("removed");
    expect(sends).toEqual([{ kind: "image-thumbnail.v1", sourceKey: SOURCE_KEY, sourceEtag: SOURCE_ETAG }]);
    expect((await db.prepare("SELECT thumbnail_key,status FROM image_thumbnail_jobs WHERE source_key=?").bind(SOURCE_KEY).first<{thumbnail_key:string;status:string}>()))
      .toMatchObject({ thumbnail_key: await thumbnailObjectKey(SOURCE_KEY, SOURCE_ETAG), status: "pending" });
  });

  it("reconciles a replaced artifact without deleting its newer R2 version", async () => {
    expect((await dispatchThumbnailIngestRequest(request(), env))?.status).toBe(200);
    objects.set(THUMBNAIL_KEY, { ...objects.get(THUMBNAIL_KEY)!, etag: "thumbnail-v2", httpEtag: "\"thumbnail-v2\"" });
    await expect(reconcileThumbnailRegistrations(env)).resolves.toEqual({ scanned: 1, invalidated: 1, completedCycle: true });
    await drainThumbnailCleanup(env, 10);
    expect(objects.get(THUMBNAIL_KEY)?.etag).toBe("thumbnail-v2");
    expect(deletes).not.toContain(THUMBNAIL_KEY);
  });

  it("sweeps only old unreferenced managed objects and never inventories prebuilt ownership", async () => {
    const oldManaged = "_ltds/derivatives/thumbnails/v1/managed/orphan.webp";
    const freshManaged = "_ltds/derivatives/thumbnails/v1/managed/fresh.webp";
    objects.set(oldManaged, { key: oldManaged, etag: "old", httpEtag: "\"old\"", size: 30,
      uploaded: new Date("2026-08-08T01:00:00Z"), httpMetadata: { contentType: "image/webp" } });
    objects.set(freshManaged, { key: freshManaged, etag: "fresh", httpEtag: "\"fresh\"", size: 30,
      uploaded: new Date("2026-08-08T03:30:00Z"), httpMetadata: { contentType: "image/webp" } });
    await expect(reconcileManagedThumbnailOrphans(env, 100, new Date("2026-08-08T04:00:00Z")))
      .resolves.toEqual({ scanned: 2, cleaned: 1, completedCycle: true });
    expect(objects.has(oldManaged)).toBe(false);
    expect(objects.has(freshManaged)).toBe(true);
    expect(objects.has(MANIFEST_KEY)).toBe(true);
    expect(objects.has(THUMBNAIL_KEY)).toBe(true);
  });
});
