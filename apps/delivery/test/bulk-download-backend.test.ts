import { describe, expect, it, vi } from "vitest";
import deliveryWranglerConfig from "../wrangler.jsonc?raw";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

import deliveryWorker, {
  bulkQuotaRetryAfterSeconds,
  bulkJobProgress,
  classifyPublicRateLimit,
  cleanupTemporaryZips,
  friendlyBulkFailure,
  readyBulkJobIsExpired,
} from "../src/worker/index";
import { encodeItemRef } from "../src/worker/files";
import { createSessionCookie } from "../src/worker/security";
import {
  assemblyProgressBytes,
  classifyWorkflowFailure,
  crcProgressBytes,
  readSourceRange,
  shouldCheckpointCrcChunk,
  shouldCheckpointCrcFile,
  snapshot,
} from "../src/worker/workflow";
import type { Env, ShareRow } from "../src/worker/types";

const share: ShareRow = {
  id: "share-1",
  public_id: "public",
  project_id: "project-1",
  token_hash: "hash",
  label: null,
  password_hash: null,
  password_salt: null,
  password_iterations: null,
  password_algorithm: null,
  expires_at: null,
  revoked_at: null,
  revoked_reason: null,
  unavailable_since: null,
  share_version: 2,
  client_name: "Client",
  project_name: "Delivery",
  r2_prefix: "jobs/client/",
};

describe("bulk-download rate-limit policy", () => {
  const root = "/api/public/shares/public/bulk-download";

  it("separates creation, status polling, and archive retrieval", () => {
    expect(classifyPublicRateLimit("POST", root)).toEqual({ binding: "PUBLIC_BULK_RATE_LIMITER", scope: "bulk-create" });
    expect(classifyPublicRateLimit("GET", `${root}/job-1`)).toEqual({ binding: "PUBLIC_MANIFEST_RATE_LIMITER", scope: "bulk-status" });
    expect(classifyPublicRateLimit("GET", `${root}/job-1/file`)).toEqual({ binding: "PUBLIC_DOWNLOAD_RATE_LIMITER", scope: "bulk-file" });
  });

  it("keeps non-bulk routes on their established policies", () => {
    expect(classifyPublicRateLimit("GET", "/api/public/shares/public/manifest")).toEqual({ binding: "PUBLIC_MANIFEST_RATE_LIMITER", scope: "manifest" });
    expect(classifyPublicRateLimit("GET", "/api/public/shares/public/items/item/thumbnail")).toEqual({ binding: "PUBLIC_THUMBNAIL_RATE_LIMITER", scope: "thumbnail" });
  });

  it("calculates the remaining hourly quota window", () => {
    expect(bulkQuotaRetryAfterSeconds(Date.UTC(2026, 6, 27, 12, 0, 0))).toBe(3600);
    expect(bulkQuotaRetryAfterSeconds(Date.UTC(2026, 6, 27, 12, 59, 59, 250))).toBe(1);
  });
});

describe("bulk-download Worker limits and progress", () => {
  it("configures the maximum supported Workflow CPU allowance", () => {
    const config = JSON.parse(deliveryWranglerConfig) as {
      limits?: { cpu_ms?: number; subrequests?: number };
    };
    expect(config.limits).toEqual({ cpu_ms: 300_000, subrequests: 25_000 });
  });

  it("reports monotonic two-phase progress without moving backwards", () => {
    expect(crcProgressBytes(100, 0)).toBe(0);
    expect(crcProgressBytes(100, 40)).toBe(20);
    expect(crcProgressBytes(100, 100)).toBe(50);
    expect(assemblyProgressBytes(100, 110, 0)).toBe(50);
    expect(assemblyProgressBytes(100, 110, 55)).toBe(75);
    expect(assemblyProgressBytes(100, 110, 110)).toBe(100);
    expect(assemblyProgressBytes(100, 110, 220)).toBe(100);
    expect(crcProgressBytes(0, 40)).toBe(0);
  });

  it("coalesces CRC progress writes to preserve the Workflow subrequest budget", () => {
    const mib = 1024 * 1024;
    expect(shouldCheckpointCrcChunk(0, 8 * mib)).toBe(false);
    expect(shouldCheckpointCrcChunk(56 * mib, 64 * mib)).toBe(true);
    expect(shouldCheckpointCrcChunk(64 * mib, 72 * mib)).toBe(false);
    expect(shouldCheckpointCrcFile(24, 2_000)).toBe(false);
    expect(shouldCheckpointCrcFile(25, 2_000)).toBe(true);
    expect(shouldCheckpointCrcFile(1_999, 2_000)).toBe(false);
    expect(shouldCheckpointCrcFile(2_000, 2_000)).toBe(true);
  });

  it("labels CRC and assembly phases for the polling client", () => {
    expect(bulkJobProgress({ status: "queued", total_bytes: 100, processed_bytes: 0, archive_size: null }))
      .toEqual({ progress: null, message: null });
    expect(bulkJobProgress({ status: "running", total_bytes: 100, processed_bytes: 20, archive_size: null }))
      .toEqual({ progress: 20, message: "Checking files" });
    expect(bulkJobProgress({ status: "running", total_bytes: 100, processed_bytes: 75, archive_size: 110 }))
      .toEqual({ progress: 75, message: "Building ZIP" });
    expect(bulkJobProgress({ status: "ready", total_bytes: 100, processed_bytes: 100, archive_size: 110 }))
      .toEqual({ progress: 100, message: "Download ready" });
  });
});

function authenticatedEnv(
  rateLimitSuccess: boolean,
  quotaChanges = 1,
  jobOverrides: Record<string, unknown> = {},
): Env {
  const statementFor = (query: string) => {
    const statement = {
      bind(..._values: unknown[]) { return statement; },
      async first<T>() {
        if (query.includes("FROM shares s JOIN projects")) return share as T;
        if (query.includes("FROM bulk_download_jobs")) {
          return {
            id: "job-1",
            status: "queued",
            file_count: 28,
            processed_files: 0,
            total_bytes: 500,
            processed_bytes: 0,
            archive_size: null,
            error_code: null,
            error_message: null,
            expires_at: "2026-07-28T12:00:00.000Z",
            manifest_key: "tmp/manifest.json",
            archive_key: "tmp/archive.zip",
            ...jobOverrides,
          } as T;
        }
        return null;
      },
      async all<T>() { return { results: [] as T[] }; },
      async run() { return { meta: { changes: query.includes("bulk_download_quota") ? quotaChanges : 1 } }; },
    };
    return statement;
  };
  const database = { prepare: statementFor, withSession() { return database; } };
  const successLimiter = { async limit() { return { success: true }; } };
  const testedLimiter = { async limit() { return { success: rateLimitSuccess }; } };
  return {
    ENVIRONMENT: "development",
    EXPECTED_HOST: "delivery.example",
    DELIVERY_DB: database,
    DATA_BUCKET: { async delete() {} } as unknown as R2Bucket,
    ASSETS: { fetch: async () => new Response() },
    IMAGES: {} as Env["IMAGES"],
    STREAM: {} as Env["STREAM"],
    ACCESS_CODE_RATE_LIMITER: successLimiter,
    PUBLIC_SESSION_RATE_LIMITER: successLimiter,
    PUBLIC_MANIFEST_RATE_LIMITER: testedLimiter,
    PUBLIC_MEDIA_RATE_LIMITER: successLimiter,
    PUBLIC_THUMBNAIL_RATE_LIMITER: successLimiter,
    PUBLIC_DOWNLOAD_RATE_LIMITER: successLimiter,
    PUBLIC_STREAM_RATE_LIMITER: successLimiter,
    PUBLIC_BULK_RATE_LIMITER: quotaChanges === 0 ? successLimiter : testedLimiter,
    PUBLIC_BASE_URL: "https://delivery.example",
    SESSION_KEY_ID: "v1",
    DELIVERY_SESSION_SECRET: "s".repeat(48),
    DELIVERY_ACCESS_CODE_PEPPER: "p".repeat(48),
    AUDIT_IP_SECRET: "a".repeat(48),
    R2_S3_ENDPOINT: "",
    R2_BUCKET_NAME: "",
    R2_ACCESS_KEY_ID: "",
    R2_SECRET_ACCESS_KEY: "",
    BULK_DOWNLOAD_WORKFLOW: {} as Workflow,
  } as unknown as Env;
}

async function sessionCookie(env: Env): Promise<string> {
  return (await createSessionCookie(env.DELIVERY_SESSION_SECRET, env.SESSION_KEY_ID, share.id, share.share_version, Date.now() + 60_000)).split(";")[0]!;
}

const executionCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("bulk-download 429 responses", () => {
  it("allows status polling beyond three requests without using the creation limiter", async () => {
    const env = authenticatedEnv(true);
    let creationCalls = 0;
    env.PUBLIC_BULK_RATE_LIMITER = { async limit() { creationCalls += 1; return { success: false }; } };
    const cookie = await sessionCookie(env);
    for (let index = 0; index < 5; index += 1) {
      const response = await deliveryWorker.fetch(new Request("https://delivery.example/api/public/shares/public/bulk-download/job-1", {
        headers: { Cookie: cookie },
      }), env, executionCtx);
      expect(response.status).toBe(200);
      expect((await response.json() as { status: string }).status).toBe("queued");
    }
    expect(creationCalls).toBe(0);
  });

  it("preserves Retry-After through Hono error handling for status polling", async () => {
    const env = authenticatedEnv(false);
    const response = await deliveryWorker.fetch(new Request("https://delivery.example/api/public/shares/public/bulk-download/job-1", {
      headers: { Cookie: await sessionCookie(env) },
    }), env, executionCtx);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
  });

  it("returns the remaining hourly window when the exact D1 quota is exhausted", async () => {
    const env = authenticatedEnv(true, 0);
    const response = await deliveryWorker.fetch(new Request("https://delivery.example/api/public/shares/public/bulk-download", {
      method: "POST",
      headers: { Cookie: await sessionCookie(env), "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    }), env, executionCtx);
    expect(response.status).toBe(429);
    const retryAfter = Number(response.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(3600);
  });

  it("transitions an elapsed ready job before creating another signed URL", async () => {
    const env = authenticatedEnv(true, 1, { status: "ready", expires_at: "2020-01-01T00:00:00.000Z" });
    const response = await deliveryWorker.fetch(new Request("https://delivery.example/api/public/shares/public/bulk-download/job-1", {
      headers: { Cookie: await sessionCookie(env) },
    }), env, executionCtx);
    const body = await response.json() as { status: string; downloadUrl: string | null };
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "expired", downloadUrl: null });
  });
});

describe("bulk-download snapshot identities", () => {
  function snapshotEnv(
    requestedKey: string,
    headValue: { size: number; etag: string; httpEtag: string } | null,
    listedObjects: Array<{ key: string; size: number; etag: string; httpEtag: string }> = [],
    aliases: Array<{ physical_key: string; display_name: string }> = [],
  ) {
    const listPrefixes: string[] = [];
    const database = {
      prepare(query: string) {
        const statement = {
          bind(..._values: unknown[]) { return statement; },
          async first<T>() {
            return (query.includes("FROM shares s JOIN projects") ? { id: share.id, share_version: share.share_version, r2_prefix: share.r2_prefix } : null) as T | null;
          },
          async all<T>() {
            return { results: (query.includes("FROM file_aliases") ? aliases : []) as T[] };
          },
        };
        return statement;
      },
      withSession() { return database; },
    };
    const env = {
      DELIVERY_DB: database,
      DATA_BUCKET: {
        async head(key: string) { return key === requestedKey ? headValue : null; },
        async list({ prefix }: { prefix: string }) {
          listPrefixes.push(prefix);
          return { objects: listedObjects, truncated: false };
        },
      },
    } as unknown as Env;
    return { env, listPrefixes };
  }

  it("stores the unquoted R2 etag and does not expand an exact file into prefix siblings", async () => {
    const exactKey = "jobs/client/photo.jpg";
    const value = snapshotEnv(exactKey, { size: 5, etag: "source-etag", httpEtag: "\"source-etag\"" }, [
      { key: "jobs/client/photo.jpg.bak", size: 7, etag: "sibling-etag", httpEtag: "\"sibling-etag\"" },
    ]);
    const result = await snapshot(value.env, {
      id: "job-1",
      share_id: share.id,
      share_version: share.share_version,
      request_json: JSON.stringify({ items: [encodeItemRef("photo.jpg")] }),
      manifest_key: "manifest",
      archive_key: "archive",
    });
    expect(value.listPrefixes).toEqual([]);
    expect(result.sources).toEqual([expect.objectContaining({ physicalKey: exactKey, etag: "source-etag", size: 5 })]);
  });

  it("uses unquoted etags while recursively expanding selected folders", async () => {
    const value = snapshotEnv("jobs/client/edited", null, [
      { key: "jobs/client/edited/photo.jpg", size: 5, etag: "source-etag", httpEtag: "\"source-etag\"" },
    ]);
    const result = await snapshot(value.env, {
      id: "job-1",
      share_id: share.id,
      share_version: share.share_version,
      request_json: JSON.stringify({ items: [encodeItemRef("edited")] }),
      manifest_key: "manifest",
      archive_key: "archive",
    });
    expect(value.listPrefixes).toEqual(["jobs/client/edited/"]);
    expect(result.sources[0]?.etag).toBe("source-etag");
  });

  it("preserves nested folder and file aliases in archive names", async () => {
    const value = snapshotEnv("jobs/client/edited", null, [
      { key: "jobs/client/edited/photo.jpg", size: 5, etag: "source-etag", httpEtag: "\"source-etag\"" },
    ], [
      { physical_key: "jobs/client/edited/", display_name: "Finals" },
      { physical_key: "jobs/client/edited/photo.jpg", display_name: "Hero.jpg" },
    ]);
    const result = await snapshot(value.env, {
      id: "job-1",
      share_id: share.id,
      share_version: share.share_version,
      request_json: JSON.stringify({ items: [encodeItemRef("edited")] }),
      manifest_key: "manifest",
      archive_key: "archive",
    });
    expect(result.sources[0]?.name).toBe("Finals/Hero.jpg");
  });

  it("rejects empty, over-file-limit, and over-byte-limit selections", async () => {
    const baseJob = {
      id: "job-1",
      share_id: share.id,
      share_version: share.share_version,
      request_json: JSON.stringify({ all: true }),
      manifest_key: "manifest",
      archive_key: "archive",
    };
    const empty = snapshotEnv("", null);
    await expect(snapshot(empty.env, baseJob)).rejects.toThrow("empty-selection");

    const tooMany = snapshotEnv("", null, Array.from({ length: 2_001 }, (_, index) => ({
      key: `jobs/client/file-${index}.bin`,
      size: 1,
      etag: `etag-${index}`,
      httpEtag: `"etag-${index}"`,
    })));
    await expect(snapshot(tooMany.env, baseJob)).rejects.toThrow("file-limit");

    const tooLarge = snapshotEnv("", null, [
      { key: "jobs/client/part-1.bin", size: 11 * 1024 * 1024 * 1024, etag: "etag-1", httpEtag: "\"etag-1\"" },
      { key: "jobs/client/part-2.bin", size: 10 * 1024 * 1024 * 1024, etag: "etag-2", httpEtag: "\"etag-2\"" },
    ]);
    await expect(snapshot(tooLarge.env, baseJob)).rejects.toThrow("byte-limit");
  });
});

describe("bulk-download CRC source reads", () => {
  it("uses the raw R2 etag for conditional ranges and rejects quoted identities", async () => {
    const calls: Array<{ key: string; options: unknown }> = [];
    const bucket = {
      async get(key: string, options: { range: { offset: number; length: number }; onlyIf: { etagMatches: string } }) {
        calls.push({ key, options });
        if (options.onlyIf.etagMatches !== "source-etag") return null;
        return { async arrayBuffer() { return new Uint8Array([2, 3]).buffer; } };
      },
    } as unknown as R2Bucket;

    await expect(readSourceRange(bucket, { physicalKey: "jobs/client/photo.jpg", etag: "source-etag" }, 1, 2))
      .resolves.toEqual(new Uint8Array([2, 3]));
    expect(calls).toEqual([{
      key: "jobs/client/photo.jpg",
      options: { range: { offset: 1, length: 2 }, onlyIf: { etagMatches: "source-etag" } },
    }]);
    await expect(readSourceRange(bucket, { physicalKey: "jobs/client/photo.jpg", etag: "\"source-etag\"" }, 1, 2))
      .rejects.toThrow("source-changed-or-disappeared");
  });
});

describe("bulk-download failures and cleanup", () => {
  it("treats the ready-state retention timestamp as an exact signing boundary", () => {
    expect(readyBulkJobIsExpired({ status: "ready", expires_at: "2026-07-27T12:00:00.000Z" }, Date.parse("2026-07-27T12:00:00.000Z"))).toBe(true);
    expect(readyBulkJobIsExpired({ status: "ready", expires_at: "2026-07-27T12:00:00.001Z" }, Date.parse("2026-07-27T12:00:00.000Z"))).toBe(false);
    expect(readyBulkJobIsExpired({ status: "running", expires_at: "2020-01-01T00:00:00.000Z" }, Date.now())).toBe(false);
  });

  it("maps source mutations and unexpected errors to stable client-safe failures", () => {
    expect(classifyWorkflowFailure("Conditional ETag should not be wrapped in quotes")).toEqual(friendlyBulkFailure("source-changed"));
    expect(classifyWorkflowFailure("Error: Worker exceeded CPU time limit.")).toEqual(friendlyBulkFailure("preparation-capacity"));
    expect(classifyWorkflowFailure("exceededCpu")).toEqual(friendlyBulkFailure("preparation-capacity"));
    expect(friendlyBulkFailure("preparation-capacity")).toEqual({
      code: "preparation-capacity",
      message: "This selection exceeded the archive preparation capacity. Choose a smaller selection and try again.",
    });
    expect(classifyWorkflowFailure("secret internal stack detail")).toEqual(friendlyBulkFailure("workflow-failed"));
    expect(friendlyBulkFailure("secret internal stack detail")).toEqual(friendlyBulkFailure("workflow-failed"));
  });

  it("deletes artifacts for expired active jobs, marks them expired, and prunes old quotas", async () => {
    const deleted: string[][] = [];
    const aborted: Array<{ key: string; uploadId: string }> = [];
    const queries: Array<{ query: string; values: unknown[] }> = [];
    const database = {
      prepare(query: string) {
        const record = { query, values: [] as unknown[] }; queries.push(record);
        const statement = {
          bind(...values: unknown[]) { record.values = values; return statement; },
          async all<T>() {
            if (query.includes("status='expired'")) {
              return { results: [{ manifest_key: "tmp/job/manifest.json", archive_key: "tmp/job/archive.zip", multipart_upload_id: "upload-1" }] as T[] };
            }
            return { results: [{ manifest_key: "tmp/active/manifest.json", archive_key: "tmp/active/archive.zip" }] as T[] };
          },
          async run() { return { meta: { changes: 1 } }; },
        };
        return statement;
      },
      withSession() { return database; },
    };
    const env = {
      DELIVERY_DB: database,
      DATA_BUCKET: {
        async delete(keys: string[]) { deleted.push(keys); },
        resumeMultipartUpload(key: string, uploadId: string) {
          return { async abort() { aborted.push({ key, uploadId }); } };
        },
        async list() {
          return {
            objects: [
              { key: "tmp/orphan/archive.zip", uploaded: new Date("2026-07-25T00:00:00Z") },
              { key: "tmp/active/archive.zip", uploaded: new Date("2026-07-25T00:00:00Z") },
            ],
            truncated: false,
          };
        },
      },
    } as unknown as Env;
    const now = Date.UTC(2026, 6, 27, 12);
    await cleanupTemporaryZips(env, now);
    expect(aborted).toEqual([{ key: "tmp/job/archive.zip", uploadId: "upload-1" }]);
    expect(deleted).toEqual([
      ["tmp/job/manifest.json", "tmp/job/archive.zip"],
      ["tmp/orphan/archive.zip"],
    ]);
    const expireUpdateIndex = queries.findIndex(record => record.query.includes("SET status='expired'"));
    const claimedJobsIndex = queries.findIndex(record => record.query.includes("status='expired'") && record.query.startsWith("SELECT"));
    expect(expireUpdateIndex).toBeGreaterThanOrEqual(0);
    expect(expireUpdateIndex).toBeLessThan(claimedJobsIndex);
    expect(queries[expireUpdateIndex]?.values).toEqual([new Date(now).toISOString(), new Date(now).toISOString()]);
    expect(queries.find(record => record.query.includes("DELETE FROM bulk_download_quota"))?.values).toEqual([Math.floor(now / 3_600_000) - 48]);
  });
});
