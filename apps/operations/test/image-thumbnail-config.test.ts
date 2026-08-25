import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const migration = readFileSync(new URL("../../client/migrations/0106_image_thumbnail_jobs.sql", import.meta.url), "utf8");
const cleanupMigration = readFileSync(new URL("../../client/migrations/0107_thumbnail_cleanup_jobs.sql", import.meta.url), "utf8");
const backfillMigration = readFileSync(new URL("../../client/migrations/0108_thumbnail_backfill_runs.sql", import.meta.url), "utf8");
const claimIndexMigration = readFileSync(new URL("../../client/migrations/0139_thumbnail_claim_queue_index.sql", import.meta.url), "utf8");
const trueNasProvenanceMigration = readFileSync(new URL("../../client/migrations/0140_truenas_thumbnail_provenance.sql", import.meta.url), "utf8");
const renderNotBeforeMigration = readFileSync(new URL("../../client/migrations/0151_thumbnail_render_not_before.sql", import.meta.url), "utf8");
const clientConfig = JSON.parse(readFileSync(new URL("../../client/wrangler.jsonc", import.meta.url), "utf8"));
const crud = readFileSync(new URL("../src/worker/r2-crud.ts", import.meta.url), "utf8");
const sourceDelete = readFileSync(new URL("../src/worker/source-delete.ts", import.meta.url), "utf8");
const trash = readFileSync(new URL("../src/worker/trash.ts", import.meta.url), "utf8");
const fileEvents = readFileSync(new URL("../src/worker/file-events.ts", import.meta.url), "utf8");
const clientUi = readFileSync(new URL("../../client/src/client/DeliveryApp.tsx", import.meta.url), "utf8");
const operationsUi = readFileSync(new URL("../src/client/OperationsApp.tsx", import.meta.url), "utf8");

describe("thumbnail deployment contract", () => {
  it("binds the private Container/R2/D1 services, producer, retry policy, and consumed DLQ without Images", () => {
    expect(config).not.toHaveProperty("images");
    expect(config).not.toHaveProperty("media");
    expect(config.durable_objects.bindings).toContainEqual({ name: "THUMBNAIL_RENDERER", class_name: "ThumbnailRendererContainer" });
    expect(config.exports).toEqual({ ThumbnailRendererContainer: { type: "durable-object", storage: "sqlite" } });
    expect(config.migrations).toBeUndefined();
    expect(config.containers).toContainEqual(expect.objectContaining({ class_name: "ThumbnailRendererContainer", max_instances: 4 }));
    expect(config.r2_buckets).toContainEqual({ binding: "DATA_BUCKET", bucket_name: "client-data" });
    expect(config.d1_databases.some((value: { binding: string }) => value.binding === "DELIVERY_DB")).toBe(true);
    expect(config.queues.producers).toContainEqual({ binding: "THUMBNAIL_QUEUE", queue: "ltds-thumbnail-jobs" });
    expect(config.queues.consumers).toContainEqual(expect.objectContaining({
      queue: "ltds-thumbnail-jobs",
      max_batch_size: 1,
      max_concurrency: 4,
      max_retries: 5,
      dead_letter_queue: "ltds-thumbnail-jobs-dlq",
    }));
    expect(config.queues.consumers).toContainEqual(expect.objectContaining({ queue: "ltds-thumbnail-jobs-dlq" }));
    expect(config.vars).toMatchObject({ FILE_EVENTS_QUEUE_NAME: "ltds-file-events", THUMBNAIL_QUEUE_NAME: "ltds-thumbnail-jobs", THUMBNAIL_DLQ_NAME: "ltds-thumbnail-jobs-dlq", THUMBNAIL_INGEST_EXPECTED_HOST: "ops.ledgetopdroneservices.com", THUMBNAIL_RENDERER_EXPECTED_HOST: "incoming.ledgetopdroneservices.com" });
    expect(clientConfig).not.toHaveProperty("images");
  });

  it("persists source identity, lease, attempts, errors, and dead-letter visibility", () => {
    expect(migration).toContain("CHECK (source_size >= 0)");
    for (const column of ["source_key", "source_etag", "thumbnail_key", "thumbnail_etag", "status", "attempt_count", "error_code", "error_message", "lease_until", "dead_lettered_at"]) {
      expect(migration).toContain(column);
    }
    expect(migration).toContain("CHECK (status IN ('pending','processing','ready','failed'))");
    expect(migration).not.toMatch(/preview|medium|large/i);
  });

  it("re-enables Operations thumbnails when deferred media state supplies a URL", () => {
    const start = operationsUi.indexOf("function OperationsThumbnail");
    const thumbnail = operationsUi.slice(start, operationsUi.indexOf("function FolderCard(", start));
    expect(thumbnail).toContain("useState(!item.thumbnailUrl)");
    expect(thumbnail).toContain("useEffect(() => setFailed(!item.thumbnailUrl), [item.id, item.thumbnailUrl])");
  });

  it("durably retires replaced and deleted versions with bounded cleanup visibility", () => {
    for (const value of ["image_thumbnail_cleanup_jobs", "attempt_count", "next_attempt_at", "error_code", "completed_at", "trg_image_thumbnail_retire_update", "trg_image_thumbnail_retire_delete"]) {
      expect(cleanupMigration).toContain(value);
    }
  });

  it("indexes the remaining general pending claim order", () => {
    expect(claimIndexMigration).toContain("idx_image_thumbnail_jobs_pending_queue");
    expect(claimIndexMigration).toContain("ON image_thumbnail_jobs(queue_published_at, source_key)");
    expect(claimIndexMigration).toContain("WHERE status = 'pending'");
    const database = new DatabaseSync(":memory:");
    database.exec(migration);
    database.exec(backfillMigration);
    database.exec(claimIndexMigration);
    const indexes = database.prepare("PRAGMA index_list('image_thumbnail_jobs')").all() as Array<{ name: string; partial: number }>;
    expect(indexes).toContainEqual(expect.objectContaining({ name: "idx_image_thumbnail_jobs_pending_queue", partial: 1 }));
    database.close();
  });

  it("adds a nullable render boundary without delaying the existing pending backlog", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(migration);
    database.exec(backfillMigration);
    database.prepare(`INSERT INTO image_thumbnail_jobs(
      source_key,source_etag,source_size,thumbnail_key,status,queue_published_at)
      VALUES('Jobs/Existing/photo.jpg','etag',10,'_ltds/existing.webp','pending',datetime('now'))`).run();

    database.exec(renderNotBeforeMigration);

    expect(database.prepare("SELECT render_not_before FROM image_thumbnail_jobs WHERE source_key='Jobs/Existing/photo.jpg'").get())
      .toEqual({ render_not_before: null });
    expect(database.prepare("PRAGMA index_list('image_thumbnail_jobs')").all())
      .toContainEqual(expect.objectContaining({ name: "idx_image_thumbnail_jobs_pending_render", partial: 1 }));
    expect(renderNotBeforeMigration).toContain("ALTER TABLE image_thumbnail_jobs ADD COLUMN render_not_before TEXT");
    database.close();
  });

  it("repairs only exact ready video rows mislabeled as Container output", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE image_thumbnail_jobs(
      source_key TEXT PRIMARY KEY, source_etag TEXT NOT NULL, source_size INTEGER NOT NULL,
      status TEXT NOT NULL, thumbnail_provider TEXT);
      CREATE TABLE file_index(
        r2_key TEXT PRIMARY KEY, etag TEXT NOT NULL, size INTEGER NOT NULL, media_kind TEXT NOT NULL);
      INSERT INTO image_thumbnail_jobs VALUES
        ('video.mov','video-etag',100,'ready','cloudflare-container'),
        ('image.jpg','image-etag',200,'ready','cloudflare-container'),
        ('pending.mov','pending-etag',300,'pending','cloudflare-container');
      INSERT INTO file_index VALUES
        ('video.mov','"video-etag"',100,'video'),
        ('image.jpg','image-etag',200,'image'),
        ('pending.mov','pending-etag',300,'video');`);
    database.exec(trueNasProvenanceMigration);
    expect(database.prepare("SELECT source_key,thumbnail_provider FROM image_thumbnail_jobs ORDER BY source_key").all()).toEqual([
      { source_key: "image.jpg", thumbnail_provider: "cloudflare-container" },
      { source_key: "pending.mov", thumbnail_provider: "cloudflare-container" },
      { source_key: "video.mov", thumbnail_provider: "ltds-truenas" },
    ]);
    database.close();
  });

  it("wires cleanup into move, trash, restore, and expiry without original fallback", () => {
    expect(crud).toContain("executeSourceDelete");
    expect(sourceDelete).toContain("removeThumbnailStateForPath(env, preview.key, preview.isFolder)");
    expect(trash).toContain("enqueueThumbnailsForPath(env, tombstone.physical_key");
    expect(trash).toContain("removeThumbnailStateForPath(env, tombstone.physical_key");
    expect(fileEvents).not.toContain("await finalizePreviewManifest(env");
    expect(clientUi.slice(clientUi.indexOf("function Thumbnail"))).not.toContain("BRAND.logoUrl");
    expect(operationsUi.slice(operationsUi.indexOf("function OperationsThumbnail"), operationsUi.indexOf("function FolderCard"))).not.toContain("BRAND.logoUrl");
  });
});
