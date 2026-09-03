import { describe, expect, it, vi } from "vitest";
import deliveryWranglerConfig from "../wrangler.jsonc?raw";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

import deliveryWorker, {
  bulkQuotaRetryAfterSeconds,
  bulkDownloadResumeExpiresAt,
  bulkJobProgress,
  classifyPublicRateLimit,
  cleanupTemporaryZips,
  friendlyBulkFailure,
  readyBulkJobIsExpired,
} from "../src/worker/index";
import { encodeItemRef } from "../src/worker/files";
import { BULK_DOWNLOAD_RESUME_COOKIE, createBulkDownloadResumeCookie, createSessionCookie } from "../src/worker/security";
import {
  assemblyProgressBytes,
  BULK_DOWNLOAD_RETENTION_DURATION,
  BULK_DOWNLOAD_RETENTION_MS,
  classifyWorkflowFailure,
  crcProgressBytes,
  estimateBulkPreparation,
  MAX_ARCHIVE_SOURCE_BYTES,
  partitionBulkSnapshot,
  planCrcWorkUnits,
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
      workflows?: Array<{ binding?: string; limits?: { steps?: number } }>;
    };
    expect(config.limits).toEqual({ cpu_ms: 300_000, subrequests: 25_000 });
    expect(config.workflows?.find(workflow => workflow.binding === "BULK_DOWNLOAD_WORKFLOW")?.limits)
      .toEqual({ steps: 25_000 });
    expect(config.workflows?.find(workflow => workflow.binding === "CLOUD_TRANSFER_WORKFLOW")?.limits)
      .toBeUndefined();
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
    expect(shouldCheckpointCrcFile(0, 24, 2_000)).toBe(false);
    expect(shouldCheckpointCrcFile(24, 25, 2_000)).toBe(true);
    expect(shouldCheckpointCrcFile(1_975, 1_999, 2_000)).toBe(false);
    expect(shouldCheckpointCrcFile(1_999, 2_000, 2_000)).toBe(true);
  });

  it("keeps a 10,626-file, 34.3 GiB delivery within one Workflow ZIP", () => {
    const fileCount = 10_626;
    const totalBytes = Math.floor(34.3 * 1024 ** 3);
    const baseSize = Math.floor(totalBytes / fileCount);
    const sources = Array.from({ length: fileCount }, (_, index) => ({
      name: `photos/DJI_${String(index).padStart(5, "0")}.jpg`,
      size: baseSize + (index < totalBytes % fileCount ? 1 : 0),
    }));
    const estimate = estimateBulkPreparation(sources);
    expect(estimate.archiveSize).toBeGreaterThan(totalBytes);
    expect(estimate.workflowSteps).toBeLessThan(24_900);
    expect(estimate.uploadParts).toBeLessThan(10_000);
  });

  it("batches many small files by bytes and object count instead of rejecting their count", () => {
    const units = planCrcWorkUnits(Array.from({ length: 10_626 }, () => ({ size: 1 })));
    expect(units).toHaveLength(Math.ceil(10_626 / 64));
    expect(units.every(unit => unit.kind === "batch" && unit.indexes.length <= 64 && unit.totalBytes <= 8 * 1024 * 1024)).toBe(true);
  });

  it("prefers one archive and deterministically splits only beyond per-archive capacity", () => {
    const makeSource = (index: number, size: number) => ({
      physicalKey: `jobs/client/file-${index}.bin`, key: `jobs/client/file-${index}.bin`,
      name: `file-${index}.bin`, size, etag: `etag-${index}`,
    });
    const small = {
      root: "jobs/client/", shareId: "share-1", shareVersion: 2,
      sources: Array.from({ length: 10_626 }, (_, index) => makeSource(index, 1024)),
    };
    expect(partitionBulkSnapshot(small)).toHaveLength(1);

    const oversized = {
      ...small,
      sources: [makeSource(0, 60 * 1024 ** 3), makeSource(1, 50 * 1024 ** 3), makeSource(2, 5 * 1024 ** 3)],
    };
    const first = partitionBulkSnapshot(oversized);
    expect(first.map(part => part.sources.map(source => source.name))).toEqual([
      ["file-0.bin"],
      ["file-1.bin", "file-2.bin"],
    ]);
    expect(partitionBulkSnapshot(oversized)).toEqual(first);
    expect(first.every(part => part.sources.reduce((total, source) => total + source.size, 0) <= MAX_ARCHIVE_SOURCE_BYTES)).toBe(true);
  });

  it("fails clearly when one source cannot fit a safe archive part", () => {
    expect(() => partitionBulkSnapshot({
      root: "jobs/client/", shareId: "share-1", shareVersion: 2,
      sources: [{ physicalKey: "jobs/client/huge.bin", key: "jobs/client/huge.bin", name: "huge.bin", size: MAX_ARCHIVE_SOURCE_BYTES + 1, etag: "etag" }],
    })).toThrow("single-source-capacity");
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
  partRows: Array<Record<string, unknown>> = [],
): Env {
  const statementFor = (query: string) => {
    const statement = {
      bind(..._values: unknown[]) { return statement; },
      async first<T>() {
        if (query.includes("FROM shares s LEFT JOIN projects")) return share as T;
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
      async all<T>() { return { results: (query.includes("parent_job_id=?") ? partRows : []) as T[] }; },
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

  it("transitions an elapsed ready job to expired before serving the archive", async () => {
    const env = authenticatedEnv(true, 1, { status: "ready", expires_at: "2020-01-01T00:00:00.000Z" });
    const response = await deliveryWorker.fetch(new Request("https://delivery.example/api/public/shares/public/bulk-download/job-1", {
      headers: { Cookie: await sessionCookie(env) },
    }), env, executionCtx);
    const body = await response.json() as { status: string; downloadUrl: string | null };
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "expired", downloadUrl: null });
  });
});

describe("bulk-download browser resume", () => {
  function readyArchiveEnv(jobOverrides: Record<string, unknown> = {}) {
    const env = authenticatedEnv(true, 1, {
      status: "ready",
      expires_at: "2099-01-01T00:00:00.000Z",
      archive_key: "tmp/archive.zip",
      archive_size: 10,
      ...jobOverrides,
    });
    const bytes = Uint8Array.from({ length: 10 }, (_, index) => index);
    const reads: Array<{ offset: number; length: number } | undefined> = [];
    env.DATA_BUCKET = {
      async head(key: string) {
        return key === "tmp/archive.zip"
          ? { size: bytes.length, etag: "archive-etag", httpEtag: '"archive-etag"' }
          : null;
      },
      async get(key: string, options?: { range?: { offset: number; length: number } }) {
        if (key !== "tmp/archive.zip") return null;
        reads.push(options?.range);
        const range = options?.range;
        const body = range ? bytes.slice(range.offset, range.offset + range.length) : bytes;
        return { body };
      },
      async delete() {},
    } as unknown as R2Bucket;
    return { env, reads };
  }

  it("serves stable metadata and byte ranges for browser-managed resume", async () => {
    const { env, reads } = readyArchiveEnv();
    const cookie = await sessionCookie(env);
    const url = "https://delivery.example/api/public/shares/public/bulk-download/job-1/file";

    const head = await deliveryWorker.fetch(new Request(url, { method: "HEAD", headers: { Cookie: cookie } }), env, executionCtx);
    expect(head.status).toBe(200);
    expect(head.headers.get("Accept-Ranges")).toBe("bytes");
    expect(head.headers.get("Content-Length")).toBe("10");
    expect(head.headers.get("ETag")).toBe('"archive-etag"');

    const partial = await deliveryWorker.fetch(new Request(url, {
      headers: { Cookie: cookie, Range: "bytes=3-6", "If-Range": '"archive-etag"' },
    }), env, executionCtx);
    expect(partial.status).toBe(206);
    expect(partial.headers.get("Content-Range")).toBe("bytes 3-6/10");
    expect(partial.headers.get("Content-Length")).toBe("4");
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(Uint8Array.from([3, 4, 5, 6]));
    expect(reads.at(-1)).toEqual({ offset: 3, length: 4 });
  });

  it("issues a job-scoped resume cookie and accepts it without widening the delivery session", async () => {
    const { env } = readyArchiveEnv();
    const statusUrl = "https://delivery.example/api/public/shares/public/bulk-download/job-1";
    const status = await deliveryWorker.fetch(new Request(statusUrl, { headers: { Cookie: await sessionCookie(env) } }), env, executionCtx);
    expect(status.status).toBe(200);
    const setCookie = status.headers.get("Set-Cookie") || "";
    expect(setCookie).toContain(`${BULK_DOWNLOAD_RESUME_COOKIE}=`);
    expect(setCookie).toContain("Path=/api/public/shares/public/bulk-download/job-1/file");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    // The ordinary rolling portal session may be renewed by middleware, but it
    // keeps its normal 12-hour lifetime; only the exact archive URL receives
    // the longer job-scoped credential.
    expect(setCookie).toMatch(/__Host-ltds_delivery=[^,]+Max-Age=43(?:19\d|200)/);

    const resume = (await createBulkDownloadResumeCookie({
      secret: env.DELIVERY_SESSION_SECRET,
      keyId: env.SESSION_KEY_ID,
      shareId: share.id,
      shareVersion: share.share_version,
      publicId: "public",
      jobId: "job-1",
      expiresAt: Date.now() + 60_000,
    })).split(";")[0]!;
    const fileUrl = `${statusUrl}/file`;
    const resumed = await deliveryWorker.fetch(new Request(fileUrl, { headers: { Cookie: resume, Range: "bytes=7-9" } }), env, executionCtx);
    expect(resumed.status).toBe(206);
    expect(new Uint8Array(await resumed.arrayBuffer())).toEqual(Uint8Array.from([7, 8, 9]));

    const wrongJob = await deliveryWorker.fetch(new Request(
      "https://delivery.example/api/public/shares/public/bulk-download/job-2/file",
      { headers: { Cookie: resume, Range: "bytes=7-9" } },
    ), env, executionCtx);
    expect(wrongJob.status).toBe(401);
  });

  it("returns the whole stable archive for stale If-Range and 416 outside its bounds", async () => {
    const { env, reads } = readyArchiveEnv();
    const cookie = await sessionCookie(env);
    const url = "https://delivery.example/api/public/shares/public/bulk-download/job-1/file";

    const stale = await deliveryWorker.fetch(new Request(url, {
      headers: { Cookie: cookie, Range: "bytes=3-6", "If-Range": '"older-etag"' },
    }), env, executionCtx);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("Content-Length")).toBe("10");
    expect(reads.at(-1)).toBeUndefined();

    const invalid = await deliveryWorker.fetch(new Request(url, {
      headers: { Cookie: cookie, Range: "bytes=10-20" },
    }), env, executionCtx);
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("Content-Range")).toBe("bytes */10");
    expect(invalid.headers.get("Accept-Ranges")).toBe("bytes");
  });

  it("aggregates every ready child archive and issues a scoped resume credential for each part", async () => {
    const partRows = [1, 2].map(part => ({
      id: `job-1-p0${part}`, parent_job_id: "job-1", part_index: part, part_count: 2,
      status: "ready", file_count: 5, processed_files: 5, total_bytes: 100,
      processed_bytes: 100, archive_size: 110, error_code: null, error_message: null,
      expires_at: "2099-01-01T00:00:00.000Z", manifest_key: `part-${part}.json`, archive_key: `part-${part}.zip`,
    }));
    const env = authenticatedEnv(true, 1, { status: "running", part_count: 2 }, partRows);
    const response = await deliveryWorker.fetch(new Request(
      "https://delivery.example/api/public/shares/public/bulk-download/job-1",
      { headers: { Cookie: await sessionCookie(env) } },
    ), env, executionCtx);
    expect(response.status).toBe(200);
    const body = await response.json() as { status: string; downloadUrl: string | null; downloads: Array<{ part: number; downloadUrl: string }> };
    expect(body.status).toBe("ready");
    expect(body.downloadUrl).toBeNull();
    expect(body.downloads).toEqual([
      { part: 1, partCount: 2, size: 110, downloadUrl: "/api/public/shares/public/bulk-download/job-1-p01/file" },
      { part: 2, partCount: 2, size: 110, downloadUrl: "/api/public/shares/public/bulk-download/job-1-p02/file" },
    ]);
    const cookies = response.headers.get("Set-Cookie") || "";
    expect(cookies.match(new RegExp(`${BULK_DOWNLOAD_RESUME_COOKIE}=`, "g"))).toHaveLength(2);
    expect(cookies).toContain("Path=/api/public/shares/public/bulk-download/job-1-p01/file");
    expect(cookies).toContain("Path=/api/public/shares/public/bulk-download/job-1-p02/file");
  });

  it("treats one expired child as terminal instead of polling a partial archive set forever", async () => {
    const partRows = [
      { id: "job-1-p01", parent_job_id: "job-1", part_index: 1, part_count: 2, status: "expired", file_count: 5, processed_files: 5, total_bytes: 100, processed_bytes: 100, archive_size: 110, error_code: null, error_message: null, expires_at: "2020-01-01T00:00:00.000Z", manifest_key: "part-1.json", archive_key: "part-1.zip" },
      { id: "job-1-p02", parent_job_id: "job-1", part_index: 2, part_count: 2, status: "ready", file_count: 5, processed_files: 5, total_bytes: 100, processed_bytes: 100, archive_size: 110, error_code: null, error_message: null, expires_at: "2099-01-01T00:00:00.000Z", manifest_key: "part-2.json", archive_key: "part-2.zip" },
    ];
    const env = authenticatedEnv(true, 1, { status: "running", part_count: 2 }, partRows);
    const response = await deliveryWorker.fetch(new Request(
      "https://delivery.example/api/public/shares/public/bulk-download/job-1",
      { headers: { Cookie: await sessionCookie(env) } },
    ), env, executionCtx);
    await expect(response.json()).resolves.toMatchObject({ status: "expired", downloads: [] });
  });

  it("uses stable numbered filenames for split archives", async () => {
    const { env } = readyArchiveEnv({ parent_job_id: "parent", part_index: 2, part_count: 3 });
    const response = await deliveryWorker.fetch(new Request(
      "https://delivery.example/api/public/shares/public/bulk-download/job-1/file",
      { headers: { Cookie: await sessionCookie(env) } },
    ), env, executionCtx);
    expect(response.headers.get("Content-Disposition")).toContain("Delivery-part-02-of-03.zip");
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

  it("rejects empty and over-byte-limit selections without imposing a descendant file-count cap", async () => {
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

    const manyFiles = snapshotEnv("", null, Array.from({ length: 10_626 }, (_, index) => ({
      key: `jobs/client/file-${index}.bin`,
      size: 1,
      etag: `etag-${index}`,
      httpEtag: `"etag-${index}"`,
    })));
    await expect(snapshot(manyFiles.env, baseJob)).resolves.toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({ physicalKey: "jobs/client/file-0.bin" }),
        expect.objectContaining({ physicalKey: "jobs/client/file-10625.bin" }),
      ]),
    });

    const tooLarge = snapshotEnv("", null, [
      { key: "jobs/client/part-1.bin", size: 55 * 1024 * 1024 * 1024, etag: "etag-1", httpEtag: "\"etag-1\"" },
      { key: "jobs/client/part-2.bin", size: 55 * 1024 * 1024 * 1024, etag: "etag-2", httpEtag: "\"etag-2\"" },
    ]);
    const oversizedSnapshot = await snapshot(tooLarge.env, baseJob);
    expect(partitionBulkSnapshot(oversizedSnapshot)).toHaveLength(2);
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
  it("retains prepared archives long enough for slow resumable downloads", () => {
    expect(BULK_DOWNLOAD_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(BULK_DOWNLOAD_RETENTION_DURATION).toBe("7 days");
  });

  it("extends resumable authorization through archive retention without passing share expiry", () => {
    const now = Date.parse("2026-07-27T12:00:00.000Z");
    const job = { expires_at: "2026-07-28T12:00:00.000Z" };
    expect(bulkDownloadResumeExpiresAt(job, { expires_at: null }, now)).toBe(Date.parse(job.expires_at));
    expect(bulkDownloadResumeExpiresAt(job, { expires_at: "2026-07-27T18:00:00.000Z" }, now))
      .toBe(Date.parse("2026-07-27T18:00:00.000Z"));
    expect(bulkDownloadResumeExpiresAt({ expires_at: "2026-07-27T11:59:59.000Z" }, { expires_at: null }, now)).toBeNull();
  });

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
