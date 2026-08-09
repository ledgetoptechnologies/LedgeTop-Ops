import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const migration = readFileSync(new URL("../../client/migrations/0106_image_thumbnail_jobs.sql", import.meta.url), "utf8");
const cleanupMigration = readFileSync(new URL("../../client/migrations/0107_thumbnail_cleanup_jobs.sql", import.meta.url), "utf8");
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
    expect(config.containers).toContainEqual(expect.objectContaining({ class_name: "ThumbnailRendererContainer", max_instances: 1 }));
    expect(config.r2_buckets).toContainEqual({ binding: "DATA_BUCKET", bucket_name: "client-data" });
    expect(config.d1_databases.some((value: { binding: string }) => value.binding === "DELIVERY_DB")).toBe(true);
    expect(config.queues.producers).toContainEqual({ binding: "THUMBNAIL_QUEUE", queue: "ltds-thumbnail-jobs" });
    expect(config.queues.consumers).toContainEqual(expect.objectContaining({ queue: "ltds-thumbnail-jobs", max_retries: 5, dead_letter_queue: "ltds-thumbnail-jobs-dlq" }));
    expect(config.queues.consumers).toContainEqual(expect.objectContaining({ queue: "ltds-thumbnail-jobs-dlq" }));
    expect(config.vars).toMatchObject({ FILE_EVENTS_QUEUE_NAME: "ltds-file-events", THUMBNAIL_QUEUE_NAME: "ltds-thumbnail-jobs", THUMBNAIL_DLQ_NAME: "ltds-thumbnail-jobs-dlq", THUMBNAIL_INGEST_EXPECTED_HOST: "ops.ledgetopdroneservices.com" });
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

  it("durably retires replaced and deleted versions with bounded cleanup visibility", () => {
    for (const value of ["image_thumbnail_cleanup_jobs", "attempt_count", "next_attempt_at", "error_code", "completed_at", "trg_image_thumbnail_retire_update", "trg_image_thumbnail_retire_delete"]) {
      expect(cleanupMigration).toContain(value);
    }
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
