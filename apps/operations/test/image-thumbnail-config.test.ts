import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const migration = readFileSync(new URL("../../client/migrations/0106_image_thumbnail_jobs.sql", import.meta.url), "utf8");

describe("thumbnail deployment contract", () => {
  it("binds the Images/R2/D1 services, producer, retry policy, and consumed DLQ", () => {
    expect(config.images).toEqual({ binding: "IMAGES" });
    expect(config.r2_buckets).toContainEqual({ binding: "DATA_BUCKET", bucket_name: "client-data" });
    expect(config.d1_databases.some((value: { binding: string }) => value.binding === "DELIVERY_DB")).toBe(true);
    expect(config.queues.producers).toContainEqual({ binding: "THUMBNAIL_QUEUE", queue: "ltds-thumbnail-jobs" });
    expect(config.queues.consumers).toContainEqual(expect.objectContaining({ queue: "ltds-thumbnail-jobs", max_retries: 5, dead_letter_queue: "ltds-thumbnail-jobs-dlq" }));
    expect(config.queues.consumers).toContainEqual(expect.objectContaining({ queue: "ltds-thumbnail-jobs-dlq" }));
  });

  it("persists source identity, lease, attempts, errors, and dead-letter visibility", () => {
    expect(migration).toContain("CHECK (source_size >= 0)");
    for (const column of ["source_key", "source_etag", "thumbnail_key", "thumbnail_etag", "status", "attempt_count", "error_code", "error_message", "lease_until", "dead_lettered_at"]) {
      expect(migration).toContain(column);
    }
    expect(migration).toContain("CHECK (status IN ('pending','processing','ready','failed'))");
    expect(migration).not.toMatch(/preview|medium|large/i);
  });
});
