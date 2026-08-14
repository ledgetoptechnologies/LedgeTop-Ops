import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { processThumbnailBackfills, THUMBNAIL_BACKFILL_PREFIX } from "../src/worker/thumbnail-backfill";
import { PDF_THUMBNAIL_MAX_INPUT_BYTES, THUMBNAIL_MAX_INPUT_BYTES, thumbnailObjectKey } from "../src/worker/image-thumbnails";
import type { Env } from "../src/worker/types";

interface StoredObject {
  key: string;
  version: string;
  etag: string;
  httpEtag: string;
  size: number;
  uploaded: Date;
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
  storageClass: "Standard";
  checksums: Record<string, never>;
}

interface BackfillMetrics {
  status: string;
  cursor: string | null;
  page_count: number;
  attempt_count: number;
  discovered_count: number;
  eligible_count: number;
  queued_count: number;
  skipped_count: number;
  ready_count: number;
  failed_dlq_count: number;
  pending_count: number;
  error_code: string | null;
  completed_at: string | null;
}

function migration(name: string): string {
  return readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/^\s*--.*$/gm, "")
    .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "")
    .replace(/\s*\n\s*/g, " ");
}

function object(key: string, etag: string, contentType = "image/jpeg", size = 4096,
  customMetadata: Record<string, string> = {}): StoredObject {
  return {
    key,
    version: `version-${etag}`,
    etag,
    httpEtag: `"${etag}"`,
    size,
    uploaded: new Date("2026-08-01T12:00:00Z"),
    httpMetadata: { contentType },
    customMetadata,
    storageClass: "Standard",
    checksums: {},
  };
}

describe("thumbnail metadata backfill", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  let objects: Map<string, StoredObject>;
  let listCalls: Array<{ prefix?: string; limit?: number; cursor?: string; include?: string[] }>;
  let headCalls: string[];
  let get: ReturnType<typeof vi.fn>;
  let send: ReturnType<typeof vi.fn>;
  let env: Env;

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-08-04",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "thumbnail-backfill" },
    });
    db = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.exec("CREATE TABLE file_index (r2_key TEXT PRIMARY KEY, etag TEXT NOT NULL, size INTEGER NOT NULL, uploaded_at TEXT NOT NULL, content_type TEXT, media_kind TEXT NOT NULL); CREATE TABLE delivery_tombstones (id TEXT PRIMARY KEY, physical_key TEXT NOT NULL, tombstone_kind TEXT NOT NULL, restored_at TEXT);");
    await db.exec(migration("0106_image_thumbnail_jobs.sql"));
    await db.exec(migration("0107_thumbnail_cleanup_jobs.sql"));
    await db.exec(migration("0108_thumbnail_backfill_runs.sql"));
    await db.prepare(`INSERT INTO image_thumbnail_backfill_runs(id,mode,scope_prefix,status)
      VALUES('legacy-completed','dry_run','Jobs/Clients/','completed')`).run();
    await db.exec(migration("0110_thumbnail_backfill_jobs_scope.sql"));
    await db.exec(migration("0111_thumbnail_render_provenance.sql"));
    expect(await db.prepare("SELECT scope_prefix,status FROM image_thumbnail_backfill_runs WHERE id='legacy-completed'").first())
      .toEqual({ scope_prefix: "Jobs/Clients/", status: "completed" });
    expect(await db.prepare("SELECT thumbnail_provider,thumbnail_profile FROM image_thumbnail_jobs LIMIT 1").first())
      .toBeNull();
  });

  afterAll(async () => miniflare.dispose());

  beforeEach(async () => {
    await db.exec("DELETE FROM image_thumbnail_backfill_runs; DELETE FROM image_thumbnail_jobs; DELETE FROM delivery_tombstones; DELETE FROM file_index;");
    objects = new Map();
    listCalls = [];
    headCalls = [];
    get = vi.fn(async () => { throw new Error("Backfill inventory must not read source bodies"); });
    send = vi.fn(async () => undefined);
    const bucket = {
      async list(options: { prefix?: string; limit?: number; cursor?: string; include?: string[] }) {
        listCalls.push({ ...options });
        const candidates = [...objects.values()]
          .filter(item => item.key.startsWith(options.prefix || ""))
          .sort((left, right) => left.key.localeCompare(right.key));
        const start = options.cursor ? Number(options.cursor) : 0;
        const limit = options.limit || 1000;
        const page = candidates.slice(start, start + limit);
        const next = start + page.length;
        return {
          objects: page,
          truncated: next < candidates.length,
          ...(next < candidates.length ? { cursor: String(next) } : {}),
        };
      },
      async head(key: string) {
        headCalls.push(key);
        return objects.get(key) || null;
      },
      get,
    };
    env = {
      DELIVERY_DB: db,
      DATA_BUCKET: bucket as never,
      THUMBNAIL_QUEUE: { send } as never,
    } as unknown as Env;
  });

  async function indexSource(source: StoredObject, etag = source.httpEtag, size = source.size) {
    const mediaKind = source.httpMetadata.contentType === "application/pdf" ? "pdf" : "image";
    await db.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,?,?,?,?,?)`)
      .bind(source.key, etag, size, source.uploaded.toISOString(), source.httpMetadata.contentType || null, mediaKind).run();
  }

  async function createRun(id: string, mode: "dry_run" | "enqueue") {
    await db.prepare(`INSERT INTO image_thumbnail_backfill_runs(id,mode,scope_prefix,status)
      VALUES(?,?,?,'queued')`).bind(id, mode, THUMBNAIL_BACKFILL_PREFIX).run();
  }

  async function metrics(id: string): Promise<BackfillMetrics> {
    const row = await db.prepare("SELECT * FROM image_thumbnail_backfill_runs WHERE id=?").bind(id).first<BackfillMetrics>();
    if (!row) throw new Error(`Missing backfill run ${id}`);
    return row;
  }

  async function insertJob(source: StoredObject, status: "pending" | "processing" | "ready" | "failed", options: {
    queuePublished?: boolean;
    errorCode?: string;
    deadLettered?: boolean;
    thumbnailEtag?: string;
    thumbnailSize?: number;
  } = {}) {
    const thumbnailKey = await thumbnailObjectKey(source.key, source.httpEtag);
    await db.prepare(`INSERT INTO image_thumbnail_jobs(
      source_key,source_etag,source_size,thumbnail_key,thumbnail_etag,thumbnail_size,status,error_code,
      dead_lettered_at,queue_published_at,last_event_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(source.key, source.etag, source.size, thumbnailKey, options.thumbnailEtag || null,
        options.thumbnailSize || null, status, options.errorCode || null,
        options.deadLettered ? "2026-08-02 00:00:00" : null,
        options.queuePublished ? "2026-08-01 12:01:00" : null,
        source.uploaded.toISOString()).run();
    return thumbnailKey;
  }

  it("dry-runs the exact private Jobs prefix using metadata and reports every skip/readiness state", async () => {
    const rootJobs = object("Jobs/Internal/root.jpg", "root");
    const rootPdf = object("Jobs/Internal/report.pdf", "pdf", "application/pdf", PDF_THUMBNAIL_MAX_INPUT_BYTES);
    const fresh = object("Jobs/Clients/Acme/fresh.jpg", "fresh");
    const oversizedImage = object("Jobs/Clients/Acme/oversized.jpg", "large-image", "image/jpeg", THUMBNAIL_MAX_INPUT_BYTES + 1);
    const oversizedPdf = object("Jobs/Clients/Acme/oversized.pdf", "large-pdf", "application/pdf", PDF_THUMBNAIL_MAX_INPUT_BYTES + 1);
    const truenasVideo = object("Jobs/Clients/Acme/clip.mov", "video", "video/quicktime");
    const derived = object("Jobs/Clients/Acme/_ltds/derived.jpg", "derived");
    const trashed = object("Jobs/Clients/Acme/trashed.png", "trashed", "image/png");
    const unindexed = object("Jobs/Clients/Acme/unindexed.webp", "unindexed", "image/webp");
    const staleIndex = object("Jobs/Clients/Acme/stale-index.jpg", "current");
    const ready = object("Jobs/Clients/Acme/ready.jpg", "ready");
    const staleReady = object("Jobs/Clients/Acme/stale-ready.jpg", "stale-ready");
    const pending = object("Jobs/Clients/Acme/pending.jpg", "pending");
    const failed = object("Jobs/Clients/Acme/failed.jpg", "failed");
    const outside = object("Archive/never-inventoried.jpg", "outside");
    for (const item of [rootJobs, rootPdf, fresh, oversizedImage, oversizedPdf, truenasVideo, derived, trashed, unindexed, staleIndex, ready, staleReady, pending, failed, outside]) {
      objects.set(item.key, item);
    }
    for (const item of [rootJobs, rootPdf, fresh, oversizedImage, oversizedPdf, truenasVideo, derived, trashed, ready, staleReady, pending, failed]) await indexSource(item);
    await indexSource(staleIndex, '"older-etag"');
    await db.prepare(`INSERT INTO delivery_tombstones(id,physical_key,tombstone_kind,restored_at)
      VALUES('trash',?,'exact',NULL)`).bind(trashed.key).run();

    const readyKey = await insertJob(ready, "ready", { thumbnailEtag: '"ready-thumb"', thumbnailSize: 1000 });
    objects.set(readyKey, object(readyKey, "ready-thumb", "image/webp", 1000, { sourceEtag: ready.httpEtag }));
    const staleReadyKey = await insertJob(staleReady, "ready", { thumbnailEtag: '"stale-thumb"', thumbnailSize: 1000 });
    objects.set(staleReadyKey, object(staleReadyKey, "stale-thumb", "image/webp", 1000, { sourceEtag: '"old-source"' }));
    await insertJob(pending, "pending", { queuePublished: true });
    await insertJob(failed, "failed", { errorCode: "invalid_image", deadLettered: true });
    await createRun("dry-mixed", "dry_run");

    await expect(processThumbnailBackfills(env)).resolves.toBe(1);

    expect(await metrics("dry-mixed")).toMatchObject({
      status: "completed",
      cursor: null,
      page_count: 1,
      discovered_count: 14,
      eligible_count: 8,
      queued_count: 5,
      skipped_count: 6,
      ready_count: 1,
      failed_dlq_count: 1,
      pending_count: 1,
    });
    expect(listCalls).toEqual([{ prefix: THUMBNAIL_BACKFILL_PREFIX, limit: 100, include: ["httpMetadata", "customMetadata"] }]);
    expect(headCalls.sort()).toEqual([readyKey, staleReadyKey].sort());
    expect(get).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("filters a high-cardinality adversarial tombstone set to page keys and their real ancestors", async () => {
    const trashed = object("Jobs/Internal/Deep/Trash/trashed.jpg", "trashed");
    const survivor = object("Jobs/Internal/Deep/survivor.jpg", "survivor");
    objects.set(trashed.key, trashed);
    objects.set(survivor.key, survivor);
    await indexSource(trashed);
    await indexSource(survivor);

    await db.batch(Array.from({ length: 20 }, (_, ordinal) => db.prepare(`INSERT INTO delivery_tombstones(
      id,physical_key,tombstone_kind,restored_at) VALUES(?,?,?,NULL)`)
      .bind(`unrelated-${ordinal}`, `Jobs/Clients/Other-${ordinal}/`, "prefix")));
    // These malformed/near-prefix rows would match a startsWith check after an
    // unbounded SELECT, but neither is an actual ancestor candidate.
    await db.prepare(`INSERT INTO delivery_tombstones(id,physical_key,tombstone_kind,restored_at)
      VALUES('empty-prefix','','prefix',NULL),('near-prefix','Jobs/Internal/Deep/Tra','prefix',NULL),
        ('target','Jobs/Internal/Deep/Trash/','prefix',NULL)`).run();
    const tombstoneQueries: Array<{ sql: string; values: unknown[] }> = [];
    const recordingDb = new Proxy(db, {
      get(target, property) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("thumbnail.backfill-tombstones")) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty !== "bind") {
                const value = Reflect.get(statementTarget, statementProperty);
                return typeof value === "function" ? value.bind(statementTarget) : value;
              }
              return (...values: unknown[]) => {
                tombstoneQueries.push({ sql, values });
                return statementTarget.bind(...values);
              };
            },
          });
        };
      },
    });
    env = { ...env, DELIVERY_DB: recordingDb as unknown as D1Database };
    await createRun("bounded-tombstones", "dry_run");

    await expect(processThumbnailBackfills(env)).resolves.toBe(1);
    expect(await metrics("bounded-tombstones")).toMatchObject({
      status: "completed", discovered_count: 2, eligible_count: 1, skipped_count: 1, queued_count: 1,
    });
    expect(tombstoneQueries).toHaveLength(1);
    expect(tombstoneQueries[0]?.sql).toContain("json_each(?)");
    expect(tombstoneQueries[0]?.sql).not.toMatch(/SELECT\s+physical_key\s*,\s*tombstone_kind\s+FROM\s+delivery_tombstones/i);
    expect(JSON.parse(String(tombstoneQueries[0]?.values[0]))).toEqual([survivor.key, trashed.key].sort((left, right) => left.localeCompare(right)));
    expect(get).not.toHaveBeenCalled();
  });

  it("records queue publication and does not republish the same ETag on a later run", async () => {
    const source = object("Jobs/Clients/Acme/queue-once.jpg", "same-etag");
    objects.set(source.key, source);
    await indexSource(source);
    await createRun("enqueue-one", "enqueue");

    await expect(processThumbnailBackfills(env)).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await metrics("enqueue-one")).toMatchObject({ status: "completed", eligible_count: 1, queued_count: 1 });
    expect(await db.prepare("SELECT status,queue_published_at FROM image_thumbnail_jobs WHERE source_key=?")
      .bind(source.key).first()).toMatchObject({ status: "pending", queue_published_at: expect.any(String) });

    await createRun("enqueue-repeat", "enqueue");
    await expect(processThumbnailBackfills(env)).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await metrics("enqueue-repeat")).toMatchObject({
      status: "completed", eligible_count: 1, queued_count: 0, pending_count: 1,
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("bounds each dry-run turn to ten 100-object pages and resumes from the persisted cursor", async () => {
    for (let index = 0; index < 1001; index += 1) {
      const key = `Jobs/Clients/Scale/clip-${String(index).padStart(4, "0")}.mov`;
      objects.set(key, object(key, `etag-${index}`, "video/quicktime"));
    }
    await createRun("bounded", "dry_run");

    await expect(processThumbnailBackfills(env)).resolves.toBe(10);
    expect(listCalls).toHaveLength(10);
    expect(listCalls.every(call => call.limit === 100 && call.prefix === THUMBNAIL_BACKFILL_PREFIX)).toBe(true);
    expect(await metrics("bounded")).toMatchObject({
      status: "queued", cursor: "1000", page_count: 10, discovered_count: 1000, skipped_count: 1000,
    });

    await expect(processThumbnailBackfills(env)).resolves.toBe(1);
    expect(listCalls.at(-1)?.cursor).toBe("1000");
    expect(await metrics("bounded")).toMatchObject({
      status: "completed", cursor: null, page_count: 11, discovered_count: 1001, skipped_count: 1001,
      completed_at: expect.any(String),
    });
    expect(get).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  }, 10_000);

  it("persists a retry-visible run and queue failure without consuming source bytes", async () => {
    const source = object("Jobs/Clients/Acme/retry.jpg", "retry-etag");
    objects.set(source.key, source);
    await indexSource(source);
    send.mockRejectedValueOnce(new Error("synthetic queue outage"));
    await createRun("retry", "enqueue");

    await expect(processThumbnailBackfills(env)).resolves.toBe(0);
    expect(await metrics("retry")).toMatchObject({
      status: "queued", cursor: null, attempt_count: 1, error_code: "backfill_retry", completed_at: null,
    });
    expect(await db.prepare("SELECT status,error_code,queue_published_at FROM image_thumbnail_jobs WHERE source_key=?")
      .bind(source.key).first()).toEqual({ status: "failed", error_code: "queue_publish_failed", queue_published_at: null });
    expect(get).not.toHaveBeenCalled();
  });

  it("resumes exact-version legacy transform failures into the private server renderer without a quota probe", async () => {
    const sources = [
      object("Jobs/Internal/legacy-renderer.jpg", "renderer"),
      object("Jobs/Clients/Acme/legacy-large.jpg", "large"),
      object("Jobs/Clients/Acme/legacy-quota.pdf", "quota", "application/pdf"),
    ];
    const errors = ["renderer_unavailable", "input_too_large", "images_quota_exceeded"];
    for (const [index, source] of sources.entries()) {
      objects.set(source.key, source);
      await indexSource(source);
      await insertJob(source, "failed", { errorCode: errors[index] });
    }
    await db.prepare(`UPDATE image_thumbnail_jobs SET attempt_count=6,
      thumbnail_provider='cloudflare-container',thumbnail_profile='legacy-profile'`).run();
    await createRun("legacy-resume", "enqueue");

    await expect(processThumbnailBackfills(env)).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map(([message]) => message)).toEqual(expect.arrayContaining(
      sources.map(source => expect.objectContaining({ sourceKey: source.key, sourceEtag: source.etag })),
    ));
    const resumed = await db.prepare(`SELECT source_key,status,error_code,attempt_count,queue_published_at,
      thumbnail_provider,thumbnail_profile
      FROM image_thumbnail_jobs ORDER BY source_key`).all<Record<string, unknown>>();
    expect(resumed.results).toHaveLength(3);
    for (const row of resumed.results) {
      expect(row).toMatchObject({
        status: "pending",
        error_code: null,
        attempt_count: 0,
        queue_published_at: expect.any(String),
        thumbnail_provider: null,
        thumbnail_profile: null,
      });
    }
    expect(await metrics("legacy-resume")).toMatchObject({
      status: "completed", cursor: null, page_count: 1, discovered_count: 3,
      eligible_count: 3, queued_count: 3, failed_dlq_count: 0, error_code: null,
      completed_at: expect.any(String),
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps an exact current TrueNAS prebuilt mapping without requiring object custom metadata", async () => {
    const source = object("Jobs/Clients/Acme/prebuilt.jpg", "source-prebuilt");
    const fingerprint = "a".repeat(64);
    const prefix = `_ltds/derivatives/thumbnails/v1/prebuilt/${source.key}/${fingerprint}`;
    const thumbnailKey = `${prefix}.webp`;
    const manifestKey = `${prefix}.json`;
    const thumbnail = object(thumbnailKey, "prebuilt-thumb", "image/webp", 1024);
    const manifest = object(manifestKey, "prebuilt-manifest", "application/json", 2048);
    objects.set(source.key, source);
    objects.set(thumbnailKey, thumbnail);
    objects.set(manifestKey, manifest);
    await indexSource(source);
    await db.prepare(`INSERT INTO image_thumbnail_jobs(
      source_key,source_etag,source_size,thumbnail_key,thumbnail_etag,thumbnail_size,status,last_event_at,
      thumbnail_provider,thumbnail_profile,thumbnail_manifest_key,thumbnail_manifest_etag)
      VALUES(?,?,?,?,?,?,'ready',datetime('now'),'ltds-truenas','ltds-thumbnail-320x240-webp-v1',?,?)`)
      .bind(source.key, source.etag, source.size, thumbnailKey, thumbnail.httpEtag, thumbnail.size,
        manifestKey, manifest.httpEtag).run();
    await createRun("prebuilt-current", "enqueue");

    await expect(processThumbnailBackfills(env)).resolves.toBe(1);

    expect(await metrics("prebuilt-current")).toMatchObject({
      status: "completed", eligible_count: 1, ready_count: 1, queued_count: 0, pending_count: 0,
    });
    expect(send).not.toHaveBeenCalled();
    expect(headCalls).toEqual([thumbnailKey, manifestKey]);
    expect(await db.prepare(`SELECT thumbnail_key,status,thumbnail_provider,thumbnail_profile,
      thumbnail_manifest_key FROM image_thumbnail_jobs WHERE source_key=?`).bind(source.key).first()).toEqual({
      thumbnail_key: thumbnailKey,
      status: "ready",
      thumbnail_provider: "ltds-truenas",
      thumbnail_profile: "ltds-thumbnail-320x240-webp-v1",
      thumbnail_manifest_key: manifestKey,
    });
    expect(await db.prepare(`SELECT thumbnail_key FROM image_thumbnail_cleanup_jobs
      WHERE thumbnail_key IN (?,?)`).bind(thumbnailKey, manifestKey).first()).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});
