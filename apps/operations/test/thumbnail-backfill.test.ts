import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { processThumbnailBackfills, THUMBNAIL_BACKFILL_PREFIX } from "../src/worker/thumbnail-backfill";
import { thumbnailObjectKey } from "../src/worker/image-thumbnails";
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
    await db.exec(migration("0108_thumbnail_backfill_runs.sql"));
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
    await db.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,?,?,?,?,'image')`)
      .bind(source.key, etag, size, source.uploaded.toISOString(), source.httpMetadata.contentType || null).run();
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

  it("dry-runs only the exact private prefix using metadata and reports every skip/readiness state", async () => {
    const fresh = object("Jobs/Clients/Acme/fresh.jpg", "fresh");
    const unsupported = object("Jobs/Clients/Acme/clip.mov", "video", "video/quicktime");
    const derived = object("Jobs/Clients/Acme/_ltds/derived.jpg", "derived");
    const trashed = object("Jobs/Clients/Acme/trashed.png", "trashed", "image/png");
    const unindexed = object("Jobs/Clients/Acme/unindexed.webp", "unindexed", "image/webp");
    const staleIndex = object("Jobs/Clients/Acme/stale-index.jpg", "current");
    const ready = object("Jobs/Clients/Acme/ready.jpg", "ready");
    const staleReady = object("Jobs/Clients/Acme/stale-ready.jpg", "stale-ready");
    const pending = object("Jobs/Clients/Acme/pending.jpg", "pending");
    const failed = object("Jobs/Clients/Acme/failed.jpg", "failed");
    const outside = object("Jobs/Other/never-inventoried.jpg", "outside");
    for (const item of [fresh, unsupported, derived, trashed, unindexed, staleIndex, ready, staleReady, pending, failed, outside]) {
      objects.set(item.key, item);
    }
    for (const item of [fresh, unsupported, derived, trashed, ready, staleReady, pending, failed]) await indexSource(item);
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
      discovered_count: 10,
      eligible_count: 5,
      queued_count: 2,
      skipped_count: 5,
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
    const trashed = object("Jobs/Clients/Acme/Deep/trashed.jpg", "trashed");
    const survivor = object("Jobs/Clients/Acme/Deep/survivor.jpg", "survivor");
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
      VALUES('empty-prefix','','prefix',NULL),('near-prefix','Jobs/Clients/Ac','prefix',NULL),
        ('target',?,'exact',NULL)`).bind(trashed.key).run();
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
    expect(JSON.parse(String(tombstoneQueries[0]?.values[0]))).toEqual([survivor.key, trashed.key]);
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
  });

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

  it("stops an enqueue run when the current-month Images quota is exhausted", async () => {
    const source = object("Jobs/Clients/Acme/quota.jpg", "quota-etag");
    objects.set(source.key, source);
    await indexSource(source);
    await insertJob(source, "failed", { errorCode: "images_quota_exceeded" });
    await db.prepare("UPDATE image_thumbnail_jobs SET failed_at=datetime('now') WHERE source_key=?")
      .bind(source.key).run();
    await createRun("quota-stop", "enqueue");

    await expect(processThumbnailBackfills(env)).resolves.toBe(0);
    expect(await metrics("quota-stop")).toMatchObject({
      status: "failed",
      cursor: null,
      page_count: 0,
      discovered_count: 0,
      queued_count: 0,
      error_code: "images_quota_exceeded",
      completed_at: expect.any(String),
    });
    expect(listCalls).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("finishes an explicit same-month quota recovery probe in a durable operator-visible state", async () => {
    const source = object("Jobs/Clients/Acme/quota-resume.jpg", "same-etag");
    objects.set(source.key, source);
    await indexSource(source);
    await insertJob(source, "failed", { errorCode: "images_quota_exceeded" });
    await db.prepare("UPDATE image_thumbnail_jobs SET failed_at=datetime('now') WHERE source_key=?")
      .bind(source.key).run();
    await createRun("quota-resume", "enqueue");
    await db.prepare("UPDATE image_thumbnail_backfill_runs SET error_code='resume_images_quota' WHERE id='quota-resume'").run();

    await expect(processThumbnailBackfills(env)).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ sourceKey: source.key, sourceEtag: "same-etag" }));
    expect(await db.prepare("SELECT status,error_code,attempt_count,queue_published_at FROM image_thumbnail_jobs WHERE source_key=?")
      .bind(source.key).first()).toMatchObject({
      status: "pending", error_code: null, attempt_count: 0, queue_published_at: expect.any(String),
    });
    expect(await metrics("quota-resume")).toMatchObject({
      status: "failed", cursor: null, page_count: 1, discovered_count: 1,
      eligible_count: 1, queued_count: 1, error_code: "quota_probe_pending",
      completed_at: expect.any(String),
    });
  });

  it("publishes only one quota probe page and requires a separate normal enqueue run", async () => {
    const first = object("Jobs/Clients/QuotaProbe/source-000.jpg", "quota-etag-0");
    objects.set(first.key, first);
    for (let index = 1; index < 100; index += 1) {
      const key = `Jobs/Clients/QuotaProbe/source-${String(index).padStart(3, "0")}.mov`;
      objects.set(key, object(key, `unsupported-${index}`, "video/quicktime"));
    }
    const last = object("Jobs/Clients/QuotaProbe/source-100.jpg", "quota-etag-100");
    objects.set(last.key, last);
    await indexSource(first);
    await indexSource(last);
    await insertJob(first, "failed", { errorCode: "images_quota_exceeded" });
    await insertJob(last, "failed", { errorCode: "images_quota_exceeded" });
    await db.prepare("UPDATE image_thumbnail_jobs SET failed_at=datetime('now')").run();
    await createRun("quota-probe-page", "enqueue");
    await db.prepare("UPDATE image_thumbnail_backfill_runs SET error_code='resume_images_quota' WHERE id='quota-probe-page'").run();

    await expect(processThumbnailBackfills(env)).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(listCalls).toHaveLength(1);
    expect(await metrics("quota-probe-page")).toMatchObject({
      status: "failed", cursor: "100", page_count: 1, discovered_count: 100,
      eligible_count: 1, queued_count: 1, skipped_count: 99,
      error_code: "quota_probe_pending",
      completed_at: expect.any(String),
    });

    await expect(processThumbnailBackfills(env)).resolves.toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(listCalls).toHaveLength(1);

    // The operator has confirmed entitlement/results. Age the unprobed quota
    // failure out of the current-month guard and create a distinct normal run.
    await db.prepare(`UPDATE image_thumbnail_jobs
      SET failed_at=datetime('now','start of month','-1 second')
      WHERE status='failed' AND error_code='images_quota_exceeded'`).run();
    await createRun("quota-follow-up", "enqueue");

    await expect(processThumbnailBackfills(env)).resolves.toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await metrics("quota-follow-up")).toMatchObject({
      status: "completed", cursor: null, page_count: 2, discovered_count: 101,
      eligible_count: 2, queued_count: 1, skipped_count: 99, pending_count: 1,
      error_code: null,
    });
  });

  it("does not downgrade a failed quota probe into an automatic retry", async () => {
    const source = object("Jobs/Clients/Acme/quota-probe-outage.jpg", "probe-etag");
    objects.set(source.key, source);
    await indexSource(source);
    await insertJob(source, "failed", { errorCode: "images_quota_exceeded" });
    await db.prepare("UPDATE image_thumbnail_jobs SET failed_at=datetime('now') WHERE source_key=?")
      .bind(source.key).run();
    await createRun("quota-probe-outage", "enqueue");
    await db.prepare("UPDATE image_thumbnail_backfill_runs SET error_code='resume_images_quota' WHERE id='quota-probe-outage'").run();
    send.mockRejectedValueOnce(new Error("synthetic queue outage"));

    await expect(processThumbnailBackfills(env)).resolves.toBe(0);
    expect(await metrics("quota-probe-outage")).toMatchObject({
      status: "failed", cursor: null, page_count: 0, queued_count: 0,
      error_code: "quota_probe_pending", completed_at: expect.any(String),
    });
    await expect(processThumbnailBackfills(env)).resolves.toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("automatically makes a prior-month quota failure eligible for the same-version next-month run", async () => {
    const source = object("Jobs/Clients/Acme/quota-next-month.jpg", "same-etag");
    objects.set(source.key, source);
    await indexSource(source);
    await insertJob(source, "failed", { errorCode: "images_quota_exceeded" });
    await db.prepare("UPDATE image_thumbnail_jobs SET failed_at=datetime('now','start of month','-1 second') WHERE source_key=?")
      .bind(source.key).run();
    await createRun("quota-next-month", "enqueue");

    await expect(processThumbnailBackfills(env)).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await metrics("quota-next-month")).toMatchObject({ status: "completed", queued_count: 1 });
  });
});
