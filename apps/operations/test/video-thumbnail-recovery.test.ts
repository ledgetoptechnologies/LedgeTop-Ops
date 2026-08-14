import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { processLegacyVideoThumbnailRecovery } from "../src/worker/video-thumbnail-recovery";
import { thumbnailObjectKey } from "../src/worker/image-thumbnails";
import { THUMBNAIL_RENDER_PROFILE } from "../src/worker/thumbnail-renderer-contract";
import { dispatchThumbnailRendererApi } from "../src/worker/thumbnail-renderer-api";
import type { Env } from "../src/worker/types";

interface StoredObject {
  key: string;
  etag: string;
  httpEtag: string;
  size: number;
  uploaded: Date;
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
}

function migration(name: string): string {
  return readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/^\s*--.*$/gm, "")
    .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "")
    .replace(/\s*\n\s*/g, " ");
}

function object(key: string, etag: string, contentType: string, size = 4096,
  customMetadata: Record<string, string> = {}): StoredObject {
  return {
    key,
    etag,
    httpEtag: `"${etag}"`,
    size,
    uploaded: new Date("2026-08-01T12:00:00Z"),
    httpMetadata: { contentType },
    customMetadata,
  };
}

describe("legacy TrueNAS video thumbnail recovery", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let objects: Map<string, StoredObject>;
  let env: Env;

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-08-04",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "video-thumbnail-recovery" },
    });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec("CREATE TABLE file_index (r2_key TEXT PRIMARY KEY,etag TEXT NOT NULL,size INTEGER NOT NULL,uploaded_at TEXT NOT NULL,content_type TEXT,media_kind TEXT NOT NULL);");
    await db.exec("CREATE TABLE delivery_tombstones (id TEXT PRIMARY KEY,physical_key TEXT NOT NULL,tombstone_kind TEXT NOT NULL,restored_at TEXT);");
    for (const name of [
      "0106_image_thumbnail_jobs.sql",
      "0107_thumbnail_cleanup_jobs.sql",
      "0108_thumbnail_backfill_runs.sql",
      "0110_thumbnail_backfill_jobs_scope.sql",
      "0111_thumbnail_render_provenance.sql",
      "0131_video_thumbnail_recovery_backfill.sql",
    ]) await db.exec(migration(name));
  });

  afterAll(async () => miniflare.dispose());

  beforeEach(async () => {
    await db.exec(`DELETE FROM legacy_video_thumbnail_recovery;
      DELETE FROM image_thumbnail_backfill_runs;
      DELETE FROM image_thumbnail_jobs;
      DELETE FROM image_thumbnail_cleanup_jobs;
      DELETE FROM delivery_tombstones;
      DELETE FROM file_index;`);
    objects = new Map();
    env = {
      DELIVERY_DB: db,
      DATA_BUCKET: {
        async head(key: string) { return objects.get(key) || null; },
      } as never,
    } as unknown as Env;
  });

  async function addSource(source: StoredObject, mediaKind = "video", indexedEtag = source.httpEtag) {
    objects.set(source.key, source);
    await db.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,?,?,?,?,?)`).bind(source.key, indexedEtag, source.size, source.uploaded.toISOString(),
      source.httpMetadata.contentType || null, mediaKind).run();
  }

  async function addJob(source: StoredObject, status: "pending" | "processing" | "ready" | "failed", options: {
    errorCode?: string;
    thumbnailKey?: string;
    thumbnailEtag?: string;
    thumbnailSize?: number;
    provider?: "ltds-truenas" | "cloudflare-container";
    profile?: string;
    manifestKey?: string;
    manifestEtag?: string;
    attemptCount?: number;
    updatedAt?: string;
  } = {}) {
    const thumbnailKey = options.thumbnailKey || await thumbnailObjectKey(source.key, source.etag);
    await db.prepare(`INSERT INTO image_thumbnail_jobs(
      source_key,source_etag,source_size,thumbnail_key,thumbnail_etag,thumbnail_size,status,error_code,
      thumbnail_provider,thumbnail_profile,thumbnail_manifest_key,thumbnail_manifest_etag,attempt_count,last_event_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      source.key, source.etag, source.size, thumbnailKey, options.thumbnailEtag || null,
      options.thumbnailSize || null, status, options.errorCode || null, options.provider || null,
      options.profile || null, options.manifestKey || null, options.manifestEtag || null,
      options.attemptCount || 0, source.uploaded.toISOString(), options.updatedAt || "2026-08-12 00:00:00",
    ).run();
    return thumbnailKey;
  }

  it("seeds independently of generic backfills and remains idempotent", async () => {
    await db.prepare(`INSERT INTO image_thumbnail_backfill_runs(id,mode,scope_prefix,status)
      VALUES('active-generic','dry_run','Jobs/','running')`).run();

    await db.exec(migration("0131_video_thumbnail_recovery_backfill.sql"));
    await db.exec(migration("0131_video_thumbnail_recovery_backfill.sql"));

    expect(await db.prepare(`SELECT singleton,status,cursor,attempt_count FROM legacy_video_thumbnail_recovery`)
      .first()).toEqual({ singleton: 1, status: "queued", cursor: null, attempt_count: 0 });
    expect(await db.prepare("SELECT status FROM image_thumbnail_backfill_runs WHERE id='active-generic'")
      .first()).toEqual({ status: "running" });
  });

  it("repairs only cutoff-pinned exact-current videos and leaves them for authenticated claim", async () => {
    await db.prepare(`INSERT INTO legacy_video_thumbnail_recovery(singleton,cutoff_at)
      VALUES(1,'2026-08-13 00:00:00')`).run();
    const failedUnsupported = object("Jobs/Clients/Acme/failed-unsupported.mov", "failed-u", "video/quicktime");
    const failedChanged = object("Jobs/Clients/Acme/failed-changed.mp4", "failed-c", "video/mp4");
    const staleReady = object("Jobs/Clients/Acme/stale-ready.mov", "stale-ready", "video/quicktime");
    const validReady = object("Jobs/Clients/Acme/valid-ready.mov", "valid-ready", "video/quicktime");
    const unsupportedImage = object("Jobs/Clients/Acme/image.jpg", "image", "image/jpeg");
    const otherFailure = object("Jobs/Clients/Acme/other.mov", "other", "video/quicktime");
    const pending = object("Jobs/Clients/Acme/pending.mov", "pending", "video/quicktime");
    const tombstoned = object("Jobs/Clients/Acme/trashed.mov", "trash", "video/quicktime");
    const moved = object("Jobs/Clients/Acme/moved.mov", "moved", "video/quicktime", 0,
      { ltdsMoveMarker: "ltds-moved-source-v1" });
    const staleIndex = object("Jobs/Clients/Acme/stale-index.mov", "current", "video/quicktime");
    const postCutoff = object("Jobs/Clients/Acme/post-cutoff.mov", "post", "video/quicktime");
    for (const source of [failedUnsupported, failedChanged, staleReady, validReady, otherFailure, pending, tombstoned, moved, postCutoff]) {
      await addSource(source);
    }
    await addSource(unsupportedImage, "image");
    await addSource(staleIndex, "video", '"older"');

    await addJob(failedUnsupported, "failed", { errorCode: "unsupported_file" });
    await addJob(failedChanged, "failed", { errorCode: "source_changed" });
    await addJob(staleReady, "ready", {
      thumbnailKey: "_ltds/legacy/stale.webp", thumbnailEtag: "stale-thumb", thumbnailSize: 1000,
      provider: "cloudflare-container", profile: THUMBNAIL_RENDER_PROFILE,
      manifestKey: "_ltds/legacy/stale.json", manifestEtag: "stale-manifest",
    });
    const validKey = await addJob(validReady, "ready", {
      thumbnailEtag: "valid-thumb", thumbnailSize: 1000,
      provider: "cloudflare-container", profile: THUMBNAIL_RENDER_PROFILE,
    });
    objects.set(validKey, object(validKey, "valid-thumb", "image/webp", 1000, { sourceEtag: validReady.etag }));
    await addJob(unsupportedImage, "failed", { errorCode: "unsupported_file" });
    await addJob(otherFailure, "failed", { errorCode: "invalid_video" });
    await addJob(pending, "pending");
    await addJob(tombstoned, "failed", { errorCode: "unsupported_file" });
    await addJob(moved, "failed", { errorCode: "unsupported_file" });
    await addJob(staleIndex, "failed", { errorCode: "unsupported_file" });
    await addJob(postCutoff, "failed", { errorCode: "unsupported_file", updatedAt: "2026-08-14 00:00:00" });
    await db.prepare(`INSERT INTO delivery_tombstones(id,physical_key,tombstone_kind,restored_at)
      VALUES('trash','Jobs/Clients/Acme/trashed.mov','exact',NULL)`).run();

    await expect(processLegacyVideoThumbnailRecovery(env, 25)).resolves.toBe(3);

    for (const source of [failedUnsupported, failedChanged, staleReady]) {
      expect(await db.prepare(`SELECT status,error_code,attempt_count,queue_published_at,thumbnail_etag,
        thumbnail_provider,thumbnail_profile,thumbnail_manifest_key FROM image_thumbnail_jobs WHERE source_key=?`)
        .bind(source.key).first()).toEqual({
        status: "pending", error_code: null, attempt_count: 0, queue_published_at: null,
        thumbnail_etag: null, thumbnail_provider: null, thumbnail_profile: null, thumbnail_manifest_key: null,
      });
    }
    expect(await db.prepare("SELECT status,thumbnail_etag FROM image_thumbnail_jobs WHERE source_key=?")
      .bind(validReady.key).first()).toEqual({ status: "ready", thumbnail_etag: "valid-thumb" });
    for (const source of [unsupportedImage, otherFailure, tombstoned, moved, staleIndex, postCutoff]) {
      expect((await db.prepare("SELECT status FROM image_thumbnail_jobs WHERE source_key=?")
        .bind(source.key).first<{ status: string }>())?.status).toBe("failed");
    }
    expect((await db.prepare("SELECT status FROM image_thumbnail_jobs WHERE source_key=?")
      .bind(pending.key).first<{ status: string }>())?.status).toBe("pending");
    expect(await db.prepare(`SELECT status,scanned_count,recovered_count,skipped_count,completed_at
      FROM legacy_video_thumbnail_recovery WHERE singleton=1`).first()).toMatchObject({
      status: "completed", scanned_count: 5, recovered_count: 3, skipped_count: 2,
      completed_at: expect.any(String),
    });
    const cleanup = await db.prepare(`SELECT thumbnail_key FROM image_thumbnail_cleanup_jobs
      WHERE thumbnail_key IN ('_ltds/legacy/stale.webp','_ltds/legacy/stale.json') ORDER BY thumbnail_key`).all();
    expect(cleanup.results).toEqual([
      { thumbnail_key: "_ltds/legacy/stale.json" },
      { thumbnail_key: "_ltds/legacy/stale.webp" },
    ]);
    await expect(processLegacyVideoThumbnailRecovery(env, 25)).resolves.toBe(0);
  });

  it("requires a complete valid manifest before preserving a prebuilt TrueNAS thumbnail", async () => {
    await db.prepare(`INSERT INTO legacy_video_thumbnail_recovery(singleton,cutoff_at)
      VALUES(1,'2026-08-13 00:00:00')`).run();
    const cases = [
      { name: "missing", manifest: null },
      { name: "zero", manifest: object("_ltds/prebuilt/zero.json", "manifest-zero", "application/json", 0) },
      { name: "wrong-type", manifest: object("_ltds/prebuilt/wrong.json", "manifest-wrong", "text/plain", 120) },
      { name: "valid", manifest: object("_ltds/prebuilt/valid.json", "manifest-valid", "application/json", 120) },
    ] as const;

    for (const testCase of cases) {
      const source = object(`Jobs/Clients/Acme/prebuilt-${testCase.name}.mov`, `source-${testCase.name}`, "video/quicktime");
      await addSource(source);
      const thumbnailKey = `_ltds/prebuilt/${testCase.name}.webp`;
      const thumbnailEtag = `thumb-${testCase.name}`;
      objects.set(thumbnailKey, object(thumbnailKey, thumbnailEtag, "image/webp", 1000));
      if (testCase.manifest) objects.set(testCase.manifest.key, testCase.manifest);
      await addJob(source, "ready", {
        thumbnailKey, thumbnailEtag, thumbnailSize: 1000,
        provider: "ltds-truenas", profile: THUMBNAIL_RENDER_PROFILE,
        manifestKey: testCase.manifest?.key,
        manifestEtag: testCase.manifest?.etag,
      });
    }

    await expect(processLegacyVideoThumbnailRecovery(env, 25)).resolves.toBe(3);
    for (const name of ["missing", "zero", "wrong-type"]) {
      expect(await db.prepare("SELECT status FROM image_thumbnail_jobs WHERE source_key=?")
        .bind(`Jobs/Clients/Acme/prebuilt-${name}.mov`).first()).toEqual({ status: "pending" });
    }
    expect(await db.prepare("SELECT status FROM image_thumbnail_jobs WHERE source_key=?")
      .bind("Jobs/Clients/Acme/prebuilt-valid.mov").first()).toEqual({ status: "ready" });
  });

  it("does not reset a ready row that changes after the recovery snapshot", async () => {
    await db.prepare(`INSERT INTO legacy_video_thumbnail_recovery(singleton,cutoff_at)
      VALUES(1,'2026-08-13 00:00:00')`).run();
    const source = object("Jobs/Clients/Acme/concurrent-ready.mov", "concurrent-source", "video/quicktime");
    await addSource(source);
    await addJob(source, "ready", {
      thumbnailKey: "_ltds/legacy/concurrent.webp", thumbnailEtag: "missing-thumb", thumbnailSize: 1000,
      provider: "cloudflare-container", profile: THUMBNAIL_RENDER_PROFILE,
    });
    const originalHead = env.DATA_BUCKET.head.bind(env.DATA_BUCKET);
    env.DATA_BUCKET = {
      async head(key: string) {
        if (key === "_ltds/legacy/concurrent.webp") {
          await db.prepare(`UPDATE image_thumbnail_jobs SET thumbnail_size=777,thumbnail_provider='ltds-truenas',
            thumbnail_profile=?,thumbnail_manifest_key='_ltds/current.json',thumbnail_manifest_etag='current-manifest'
            WHERE source_key=?`).bind(THUMBNAIL_RENDER_PROFILE, source.key).run();
          return null;
        }
        return originalHead(key);
      },
    } as never;

    await expect(processLegacyVideoThumbnailRecovery(env, 25)).resolves.toBe(0);
    expect(await db.prepare(`SELECT status,thumbnail_size,thumbnail_provider,thumbnail_manifest_key
      FROM image_thumbnail_jobs WHERE source_key=?`).bind(source.key).first()).toEqual({
      status: "ready", thumbnail_size: 777, thumbnail_provider: "ltds-truenas",
      thumbnail_manifest_key: "_ltds/current.json",
    });
  });

  it("prevents an expired old lease from resetting or completing a newer run", async () => {
    await db.prepare(`INSERT INTO legacy_video_thumbnail_recovery(singleton,cutoff_at)
      VALUES(1,'2026-08-13 00:00:00')`).run();
    const source = object("Jobs/Clients/Acme/lease-race.mov", "lease-race", "video/quicktime");
    await addSource(source);
    await addJob(source, "failed", { errorCode: "unsupported_file" });

    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstBlocked = new Promise<void>(resolve => { signalFirst = resolve; });
    const firstRelease = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstEnv = {
      ...env,
      DATA_BUCKET: {
        async head(key: string) {
          if (key === source.key) { signalFirst(); await firstRelease; }
          return objects.get(key) || null;
        },
      },
    } as unknown as Env;
    const first = processLegacyVideoThumbnailRecovery(firstEnv, 25);
    await firstBlocked;
    await db.prepare(`UPDATE legacy_video_thumbnail_recovery SET lease_until=datetime('now','-1 second')
      WHERE singleton=1`).run();

    await expect(processLegacyVideoThumbnailRecovery(env, 25)).resolves.toBe(1);
    releaseFirst();
    await expect(first).resolves.toBe(0);
    expect(await db.prepare(`SELECT status,recovered_count,scanned_count,claim_token
      FROM legacy_video_thumbnail_recovery WHERE singleton=1`).first()).toEqual({
      status: "completed", recovered_count: 1, scanned_count: 1, claim_token: null,
    });
    expect(await db.prepare("SELECT status FROM image_thumbnail_jobs WHERE source_key=?")
      .bind(source.key).first()).toEqual({ status: "pending" });
  });

  it("leaves an expired unclaimed run reclaimable without advancing its cursor", async () => {
    await db.prepare(`INSERT INTO legacy_video_thumbnail_recovery(singleton,cutoff_at)
      VALUES(1,'2026-08-13 00:00:00')`).run();
    const source = object("Jobs/Clients/Acme/expired-alone.mov", "expired-alone", "video/quicktime");
    await addSource(source);
    await addJob(source, "failed", { errorCode: "unsupported_file" });

    let release!: () => void;
    let signal!: () => void;
    const blocked = new Promise<void>(resolve => { signal = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const expiringEnv = {
      ...env,
      DATA_BUCKET: {
        async head(key: string) {
          if (key === source.key) { signal(); await released; }
          return objects.get(key) || null;
        },
      },
    } as unknown as Env;
    const expired = processLegacyVideoThumbnailRecovery(expiringEnv, 25);
    await blocked;
    await db.prepare(`UPDATE legacy_video_thumbnail_recovery SET lease_until=datetime('now','-1 second')
      WHERE singleton=1`).run();
    release();

    await expect(expired).resolves.toBe(0);
    expect(await db.prepare(`SELECT status,cursor,scanned_count,recovered_count,claim_token
      FROM legacy_video_thumbnail_recovery WHERE singleton=1`).first()).toMatchObject({
      status: "running", cursor: null, scanned_count: 0, recovered_count: 0,
      claim_token: expect.any(String),
    });
    expect(await db.prepare("SELECT status FROM image_thumbnail_jobs WHERE source_key=?")
      .bind(source.key).first()).toEqual({ status: "failed" });

    await expect(processLegacyVideoThumbnailRecovery(env, 25)).resolves.toBe(1);
    expect(await db.prepare(`SELECT status,cursor,recovered_count,claim_token
      FROM legacy_video_thumbnail_recovery WHERE singleton=1`).first()).toEqual({
      status: "completed", cursor: source.key, recovered_count: 1, claim_token: null,
    });
    expect(await db.prepare("SELECT status FROM image_thumbnail_jobs WHERE source_key=?")
      .bind(source.key).first()).toEqual({ status: "pending" });
  });

  it("hands a recovered video to the authenticated TrueNAS claim endpoint", async () => {
    const secret = "thumbnail-renderer-secret-that-is-at-least-32-bytes";
    await db.prepare(`INSERT INTO legacy_video_thumbnail_recovery(singleton,cutoff_at)
      VALUES(1,'2026-08-13 00:00:00')`).run();
    const source = object("Jobs/Clients/Acme/claimable.mov", "claimable", "video/quicktime");
    await addSource(source);
    await addJob(source, "failed", { errorCode: "unsupported_file" });
    await expect(processLegacyVideoThumbnailRecovery(env, 25)).resolves.toBe(1);

    const response = await dispatchThumbnailRendererApi(new Request(
      "https://incoming.example.test/api/internal/thumbnail-renderer/v1/claim",
      { method: "POST", headers: { Authorization: `Bearer ${secret}` } },
    ), {
      ...env,
      THUMBNAIL_INGEST_EXPECTED_HOST: "incoming.example.test",
      THUMBNAIL_INGEST_SECRET: secret,
    } as Env);
    expect(response?.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      status: "claimed", sourceKey: source.key, sourceEtag: source.etag, mediaKind: "video",
      leaseId: expect.any(String),
    });
    expect(await db.prepare("SELECT status FROM image_thumbnail_jobs WHERE source_key=?")
      .bind(source.key).first()).toEqual({ status: "processing" });
  });
});
