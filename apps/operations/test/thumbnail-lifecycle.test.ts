import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import {
  drainThumbnailCleanup,
  enqueueThumbnailJob,
  enqueueThumbnailsForPath,
  normalizeThumbnailEventTime,
  processThumbnailJob,
  PDF_THUMBNAIL_MAX_INPUT_BYTES,
  removeThumbnailStateForPath,
  THUMBNAIL_MAX_INPUT_BYTES,
  thumbnailObjectKey,
  THUMBNAIL_JOB_KIND,
} from "../src/worker/image-thumbnails";
import type { Env } from "../src/worker/types";

interface StoredObject {
  key: string;
  etag: string;
  httpEtag: string;
  size: number;
  uploaded: Date;
  httpMetadata: { contentType?: string };
}

describe("thumbnail lifecycle cleanup", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let objects: Map<string, StoredObject>;
  let deletes: string[];
  let sends: unknown[];
  let failDeletes = false;
  let onDelete: ((key: string) => Promise<void>) | undefined;
  let env: Env;

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-22",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "thumbnail-lifecycle" },
    });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec("CREATE TABLE file_index(r2_key TEXT PRIMARY KEY,etag TEXT NOT NULL,size INTEGER NOT NULL,media_kind TEXT NOT NULL);");
    for (const migration of ["0106_image_thumbnail_jobs.sql", "0107_thumbnail_cleanup_jobs.sql", "0108_thumbnail_backfill_runs.sql", "0109_image_asset_locations.sql", "0111_thumbnail_render_provenance.sql"]) {
      const sql = readFileSync(new URL(`../../client/migrations/${migration}`, import.meta.url), "utf8")
        .replace(/\r\n/g, "\n")
        .replace(/^\s*--.*$/gm, "")
        .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "")
        .replace(/\s*\n\s*/g, " ");
      await db.exec(sql);
    }
  });

  afterAll(async () => miniflare.dispose());

  beforeEach(async () => {
    await db.exec("DELETE FROM image_thumbnail_jobs; DELETE FROM image_thumbnail_cleanup_jobs; DELETE FROM delivery_tombstones;").catch(async () => {
      await db.exec("CREATE TABLE IF NOT EXISTS delivery_tombstones(id TEXT PRIMARY KEY,physical_key TEXT NOT NULL,tombstone_kind TEXT NOT NULL,restored_at TEXT); DELETE FROM image_thumbnail_jobs; DELETE FROM image_thumbnail_cleanup_jobs; DELETE FROM delivery_tombstones;");
    });
    objects = new Map();
    deletes = [];
    sends = [];
    failDeletes = false;
    onDelete = undefined;
    const bucket = {
      async head(key: string) { return objects.get(key) || null; },
      async list(options: { prefix?: string; cursor?: string }) {
        return { objects: [...objects.values()].filter(object => object.key.startsWith(options.prefix || "")), truncated: false };
      },
      async delete(key: string | string[]) {
        if (failDeletes) throw new Error("synthetic delete outage");
        for (const item of Array.isArray(key) ? key : [key]) {
          deletes.push(item);
          objects.delete(item);
          await onDelete?.(item);
        }
      },
    };
    env = {
      DELIVERY_DB: db,
      DATA_BUCKET: bucket as never,
      THUMBNAIL_QUEUE: { async send(message: unknown) { sends.push(message); } } as never,
    } as unknown as Env;
  });

  function store(key: string, etag: string, contentType = "image/jpeg", size = 4096) {
    const object: StoredObject = { key, etag, httpEtag: `"${etag}"`, size, uploaded: new Date("2026-08-01T12:00:00Z"), httpMetadata: { contentType } };
    objects.set(key, object);
    return object;
  }

  async function insertReady(sourceKey: string, sourceEtag: string) {
    const thumbnailKey = await thumbnailObjectKey(sourceKey, sourceEtag);
    store(thumbnailKey, `thumb-${sourceEtag}`, "image/webp", 1000);
    await db.prepare(`INSERT INTO image_thumbnail_jobs
      (source_key,source_etag,source_size,thumbnail_key,thumbnail_etag,thumbnail_size,status,last_event_at)
      VALUES(?,?,?,?,?,1000,'ready',datetime('2026-08-01T12:00:00Z'))`)
      .bind(sourceKey, sourceEtag, 4096, thumbnailKey, `"thumb-${sourceEtag}"`).run();
    return thumbnailKey;
  }

  it("retires the exact old version on replacement and ignores an older event", async () => {
    const sourceKey = "Jobs/Clients/Synthetic/photo.jpg";
    const oldKey = await insertReady(sourceKey, "old");
    const current = store(sourceKey, "new");

    await expect(enqueueThumbnailJob(env, { sourceKey, sourceEtag: current.httpEtag, sourceSize: current.size, eventTime: "2026-08-02T12:00:00Z" }))
      .resolves.toEqual({ enqueued: true, state: "pending" });
    const row = await db.prepare("SELECT source_etag,thumbnail_key,status FROM image_thumbnail_jobs WHERE source_key=?").bind(sourceKey).first<{ source_etag: string; thumbnail_key: string; status: string }>();
    expect(row).toMatchObject({ source_etag: "new", status: "pending" });
    expect(row?.thumbnail_key).toBe(await thumbnailObjectKey(sourceKey, "new"));
    expect(objects.has(oldKey)).toBe(false);
    expect(deletes).toContain(oldKey);
    expect(sends).toHaveLength(1);

    await expect(enqueueThumbnailJob(env, { sourceKey, sourceEtag: "old", sourceSize: 4096, eventTime: "2026-08-01T11:00:00Z" }))
      .resolves.toEqual({ enqueued: false, state: "pending" });
    expect(sends).toHaveLength(1);
    expect((await db.prepare("SELECT source_etag FROM image_thumbnail_jobs WHERE source_key=?").bind(sourceKey).first<{ source_etag: string }>())?.source_etag).toBe("new");
  });

  it("clamps untrusted future event times to the consumer clock", () => {
    const now = new Date("2026-08-07T04:00:00.000Z");
    expect(normalizeThumbnailEventTime("9999-12-31T23:59:59.999Z", now)).toBe(now.toISOString());
    expect(normalizeThumbnailEventTime("2026-08-01T12:00:00Z", now)).toBe("2026-08-01T12:00:00.000Z");
  });

  it("removes exact and prefix thumbnail state without crossing client paths", async () => {
    const first = "Jobs/Clients/Acme/a.jpg";
    const second = "Jobs/Clients/Acme/folder/b.jpg";
    const other = "Jobs/Clients/Acme-Other/c.jpg";
    const keys = [await insertReady(first, "a"), await insertReady(second, "b"), await insertReady(other, "c")];
    await removeThumbnailStateForPath(env, "Jobs/Clients/Acme/", true);
    const remaining = await db.prepare("SELECT source_key FROM image_thumbnail_jobs ORDER BY source_key").all<{ source_key: string }>();
    expect(remaining.results.map(row => row.source_key)).toEqual([other]);
    expect(objects.has(keys[0]!)).toBe(false);
    expect(objects.has(keys[1]!)).toBe(false);
    expect(objects.has(keys[2]!)).toBe(true);
  });

  it("re-arms retained cleanup rows when the same prebuilt version is recreated and deleted again", async () => {
    const sourceKey = "Jobs/Clients/Synthetic/repeated-prebuilt.jpg";
    const sourceEtag = "same-source-version";
    const fingerprint = "b".repeat(64);
    const base = `_ltds/derivatives/thumbnails/v1/prebuilt/${sourceKey}/${fingerprint}`;
    const thumbnailKey = `${base}.webp`;
    const manifestKey = `${base}.json`;

    const register = async () => {
      store(thumbnailKey, "same-thumbnail-version", "image/webp", 1000);
      store(manifestKey, "same-manifest-version", "application/json", 2000);
      await db.prepare(`INSERT INTO image_thumbnail_jobs(
        source_key,source_etag,source_size,thumbnail_key,thumbnail_etag,thumbnail_size,status,last_event_at,
        thumbnail_provider,thumbnail_profile,thumbnail_manifest_key,thumbnail_manifest_etag)
        VALUES(?,?,?,?,?,1000,'ready',datetime('now'),'ltds-truenas','ltds-thumbnail-320x240-webp-v1',?,?)`)
        .bind(sourceKey, sourceEtag, 4096, thumbnailKey, '"same-thumbnail-version"', manifestKey, '"same-manifest-version"').run();
    };

    await register();
    await removeThumbnailStateForPath(env, sourceKey, false, sourceEtag);
    expect(objects.has(thumbnailKey)).toBe(false);
    expect(objects.has(manifestKey)).toBe(false);

    await register();
    await removeThumbnailStateForPath(env, sourceKey, false, sourceEtag);

    expect(objects.has(thumbnailKey)).toBe(false);
    expect(objects.has(manifestKey)).toBe(false);
    expect(deletes.filter((key) => key === thumbnailKey)).toHaveLength(2);
    expect(deletes.filter((key) => key === manifestKey)).toHaveLength(2);
    const cleanup = await db.prepare(`SELECT thumbnail_key,status,attempt_count,artifact_etag,completed_at
      FROM image_thumbnail_cleanup_jobs WHERE thumbnail_key IN (?,?) ORDER BY thumbnail_key`)
      .bind(thumbnailKey, manifestKey).all<Record<string, unknown>>();
    expect(cleanup.results).toHaveLength(2);
    for (const row of cleanup.results) {
      expect(row).toMatchObject({ status: "completed", attempt_count: 1, completed_at: expect.any(String) });
      expect(row.artifact_etag).toMatch(/same-(?:manifest|thumbnail)-version/);
    }
  });

  it("requeues only bounded images and PDFs when a trashed path is restored", async () => {
    store("Jobs/Clients/Restore/photo.jpg", "image");
    store("Jobs/Clients/Restore/report.pdf", "pdf", "application/pdf", PDF_THUMBNAIL_MAX_INPUT_BYTES);
    store("Jobs/Clients/Restore/clip.mov", "video", "video/quicktime");
    store("Jobs/Clients/Restore/too-large.jpg", "large", "image/jpeg", THUMBNAIL_MAX_INPUT_BYTES + 1);
    store("Jobs/Clients/Restore/archive.zip", "zip", "application/zip");
    await expect(enqueueThumbnailsForPath(env, "Jobs/Clients/Restore/", true)).resolves.toBe(2);
    expect(sends).toEqual([
      { kind: THUMBNAIL_JOB_KIND, sourceKey: "Jobs/Clients/Restore/photo.jpg", sourceEtag: "image" },
      { kind: THUMBNAIL_JOB_KIND, sourceKey: "Jobs/Clients/Restore/report.pdf", sourceEtag: "pdf" },
    ]);
  });

  it("keeps cleanup failure visible after bounded attempts and can safely recover", async () => {
    const sourceKey = "Jobs/Clients/Synthetic/delete.jpg";
    const thumbnailKey = await insertReady(sourceKey, "delete");
    failDeletes = true;
    await removeThumbnailStateForPath(env, sourceKey);
    for (let attempt = 1; attempt < 8; attempt += 1) {
      await db.prepare("UPDATE image_thumbnail_cleanup_jobs SET status='pending',next_attempt_at=datetime('now') WHERE thumbnail_key=?").bind(thumbnailKey).run();
      await drainThumbnailCleanup(env);
    }
    const failed = await db.prepare("SELECT status,attempt_count,error_code FROM image_thumbnail_cleanup_jobs WHERE thumbnail_key=?").bind(thumbnailKey).first<{ status: string; attempt_count: number; error_code: string }>();
    expect(failed).toEqual({ status: "failed", attempt_count: 8, error_code: "cleanup_exhausted" });
    expect(objects.has(thumbnailKey)).toBe(true);

    failDeletes = false;
    await db.prepare("UPDATE image_thumbnail_cleanup_jobs SET status='pending',attempt_count=0,next_attempt_at=datetime('now') WHERE thumbnail_key=?").bind(thumbnailKey).run();
    await expect(drainThumbnailCleanup(env)).resolves.toBe(1);
    expect(objects.has(thumbnailKey)).toBe(false);
  });

  it("reclaims an expired cleanup lease after a terminated worker", async () => {
    const sourceKey = "Jobs/Clients/Synthetic/lease.jpg";
    const thumbnailKey = await insertReady(sourceKey, "lease");
    await db.prepare("DELETE FROM image_thumbnail_jobs WHERE source_key=?").bind(sourceKey).run();
    await db.prepare(`UPDATE image_thumbnail_cleanup_jobs SET status='processing',lease_until=datetime('now','-1 minute') WHERE thumbnail_key=?`)
      .bind(thumbnailKey).run();
    await expect(drainThumbnailCleanup(env)).resolves.toBe(1);
    expect(objects.has(thumbnailKey)).toBe(false);
    expect((await db.prepare("SELECT status,lease_until FROM image_thumbnail_cleanup_jobs WHERE thumbnail_key=?").bind(thumbnailKey).first())?.status).toBe("completed");
  });

  it("regenerates a same-version thumbnail that is revived during cleanup", async () => {
    const sourceKey = "Jobs/Clients/Synthetic/revive.jpg";
    const sourceEtag = "same-version";
    const thumbnailKey = await insertReady(sourceKey, sourceEtag);
    onDelete = async (key) => {
      if (key !== thumbnailKey) return;
      await db.prepare(`INSERT INTO image_thumbnail_jobs
        (source_key,source_etag,source_size,thumbnail_key,thumbnail_etag,thumbnail_size,status,last_event_at)
        VALUES(?,?,?,?,?,1000,'ready',datetime('now'))`)
        .bind(sourceKey, sourceEtag, 4096, thumbnailKey, '"revived"').run();
    };
    await removeThumbnailStateForPath(env, sourceKey);
    const revived = await db.prepare("SELECT status,thumbnail_etag FROM image_thumbnail_jobs WHERE source_key=?").bind(sourceKey).first<{ status: string; thumbnail_etag: string | null }>();
    expect(revived).toEqual({ status: "pending", thumbnail_etag: null });
    expect(sends).toContainEqual({ kind: THUMBNAIL_JOB_KIND, sourceKey, sourceEtag });
  });

  it("rejects forged or retired jobs before any R2 read", async () => {
    const head = vi.spyOn(env.DATA_BUCKET, "head");
    const get = vi.fn();
    (env.DATA_BUCKET as unknown as { get: typeof get }).get = get;
    await expect(processThumbnailJob(env, { kind: THUMBNAIL_JOB_KIND, sourceKey: "Jobs/Clients/Synthetic/missing.jpg", sourceEtag: "missing" }))
      .resolves.toEqual({ outcome: "obsolete" });
    await expect(processThumbnailJob(env, { kind: THUMBNAIL_JOB_KIND, sourceKey: "_ltds/private.jpg", sourceEtag: "forged" }))
      .resolves.toEqual({ outcome: "obsolete" });
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});
