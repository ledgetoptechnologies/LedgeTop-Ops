import { describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { dispatchThumbnailRendererApi } from "../src/worker/thumbnail-renderer-api";

const HOST = "incoming.example.test";
const SECRET = "thumbnail-renderer-secret-that-is-at-least-32-bytes";

function videoClaimFixture(input: {
  sourceKey?: string;
  sourceEtag?: string;
  sourceSize?: number;
  contentType?: string;
  renderNotBefore?: string | null;
  errorCode?: string | null;
} = {}) {
  const job = {
    source_key: input.sourceKey || "Jobs/Clients/Acme/flight.mov",
    source_etag: input.sourceEtag || "video-etag",
    source_size: input.sourceSize || 4096,
    thumbnail_key: "_ltds/derivatives/thumbnails/v1/managed/abc.webp",
    attempt_count: 0,
    status: "pending",
    lease_until: null as string | null,
    thumbnail_provider: null as string | null,
    error_code: input.errorCode ?? null as string | null,
    queue_published_at: null as string | null,
    render_not_before: input.renderNotBefore ?? null as string | null,
  };
  const queries: string[] = [];
  const health = { attempts: 0, writes: 0, throttleOpen: true };
  const prepare = vi.fn((sql: string) => {
    queries.push(sql);
    let values: unknown[] = [];
    const statement = {
      bind(...input: unknown[]) { values = input; return statement; },
      async first() {
        if (sql.includes("image_thumbnail_jobs") && sql.includes("ORDER BY") && sql.includes("queue_published_at")) {
          const due = !job.render_not_before ||
            Date.parse(`${job.render_not_before.replace(" ", "T")}Z`) <= Date.now();
          return job.status === "pending" && due ? { ...job } : null;
        }
        if (sql.includes("FROM image_thumbnail_jobs") && sql.includes("status='processing'")) {
          return job.status === "processing" ? { ...job } : null;
        }
        if (sql.includes("FROM image_thumbnail_jobs") && sql.includes("WHERE thumbnail_key=?")) {
          return job.status === "processing" && values[0] === job.thumbnail_key ? { ...job } : null;
        }
        throw new Error(`Unhandled first query: ${sql}`);
      },
      async run() {
        if (sql.includes("INSERT INTO delivery_sync_health")) {
          health.attempts += 1;
          if (!health.throttleOpen) return { meta: { changes: 0 } };
          health.writes += 1;
          health.throttleOpen = false;
          return { meta: { changes: 1 } };
        }
        if (sql.includes("SET status='processing'")) {
          const [leaseUntil, attempts, sourceKey, sourceEtag] = values as [string, number, string, string];
          if (job.status !== "pending" || sourceKey !== job.source_key || sourceEtag !== job.source_etag) return { meta: { changes: 0 } };
          job.status = "processing";
          job.attempt_count = attempts;
          job.lease_until = leaseUntil;
          job.error_code = null;
          return { meta: { changes: 1 } };
        }
        if (sql.includes("SET lease_until=?")) {
          const [leaseUntil, sourceKey, sourceEtag, thumbnailKey, attemptCount] = values as [string, string, string, string, number];
          const current = job.status === "processing" && sourceKey === job.source_key && sourceEtag === job.source_etag &&
            thumbnailKey === job.thumbnail_key && attemptCount === job.attempt_count;
          if (current) job.lease_until = leaseUntil;
          return { meta: { changes: current ? 1 : 0 } };
        }
        if (sql.includes("SET status='ready'")) {
          const [, , provider, , sourceKey, sourceEtag, thumbnailKey, attemptCount] = values as [string, number, string, string, string, string, string, number];
          const current = job.status === "processing" && sourceKey === job.source_key && sourceEtag === job.source_etag &&
            thumbnailKey === job.thumbnail_key && attemptCount === job.attempt_count;
          if (current) { job.status = "ready"; job.lease_until = null; job.thumbnail_provider = provider; }
          return { meta: { changes: current ? 1 : 0 } };
        }
        if (sql.includes("SET status=?")) {
          const [status, errorCode, , terminal, sourceKey, sourceEtag, thumbnailKey, attemptCount] = values as [string, string, string, boolean, string, string, string, number];
          const current = job.status === "processing" && sourceKey === job.source_key && sourceEtag === job.source_etag &&
            thumbnailKey === job.thumbnail_key && attemptCount === job.attempt_count;
          if (current) {
            job.status = status;
            job.lease_until = null;
            job.error_code = errorCode;
            if (status === "pending") {
              job.queue_published_at = null;
              job.render_not_before = "2026-08-24 12:00:00";
            } else if (!terminal) {
              throw new Error("terminal failure binding mismatch");
            }
          }
          return { meta: { changes: current ? 1 : 0 } };
        }
        if (sql.includes("SET queue_published_at=datetime('now')")) {
          const [sourceKey, sourceEtag] = values as [string, string];
          const current = job.status === "pending" && sourceKey === job.source_key && sourceEtag === job.source_etag;
          if (current) job.queue_published_at = "2026-08-24 12:00:00";
          return { meta: { changes: current ? 1 : 0 } };
        }
        throw new Error(`Unhandled run query: ${sql}`);
      },
    };
    return statement;
  });
  const head = vi.fn(async (key: string) => key === job.source_key ? {
    key,
    httpEtag: `"${job.source_etag}"`,
    size: job.source_size,
    httpMetadata: { contentType: input.contentType || "video/quicktime" },
  } : null);
  return { job, queries, prepare, head, health };
}

function validWebpBytes(): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  new DataView(bytes.buffer).setUint32(4, bytes.byteLength - 8, true);
  bytes.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20], 8);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  bytes.set([0, 0, 0, 0x9d, 0x01, 0x2a], 20);
  new DataView(bytes.buffer).setUint16(26, 320, true);
  new DataView(bytes.buffer).setUint16(28, 240, true);
  return bytes;
}

describe("private TrueNAS thumbnail renderer API", () => {
  it("leases supported stills through the unified TrueNAS contract", async () => {
    const value = videoClaimFixture({
      sourceKey: "Jobs/Clients/Acme/photo.jpg",
      sourceEtag: "image-etag",
      contentType: "image/jpeg",
    });
    const response = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/claim?includeKind=all`,
      { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } },
    ), {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head: value.head },
    } as never);

    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      status: "claimed",
      sourceKey: value.job.source_key,
      sourceEtag: value.job.source_etag,
      mediaKind: "image",
      sourceContentType: "image/jpeg",
    });
    expect(value.queries.some(sql => sql.includes("source.media_kind IN ('image','pdf','video')"))).toBe(true);
    expect(value.job.status).toBe("processing");
    expect(value.health.writes).toBe(1);
  });

  it("leases a still returned by the lower-capacity Cloudflare fallback", async () => {
    const value = videoClaimFixture({
      sourceKey: "Jobs/Clients/Acme/large-photo.jpg",
      sourceEtag: "large-image-etag",
      sourceSize: 200 * 1024 * 1024,
      contentType: "image/jpeg",
      errorCode: "pixel_limit_exceeded",
    });
    const response = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/claim?includeKind=all`,
      { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } },
    ), {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head: value.head },
    } as never);

    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      status: "claimed",
      sourceKey: value.job.source_key,
      mediaKind: "image",
    });
    expect(value.job).toMatchObject({ status: "processing", attempt_count: 1, error_code: null });
    expect(value.queries.some(sql => sql.includes("job.error_code='pixel_limit_exceeded'"))).toBe(true);
  });

  it("keeps the authenticated claim endpoint and leases video to TrueNAS", async () => {
    const value = videoClaimFixture();
    const claimStartedAt = Date.now();
    const request = new Request(`https://${HOST}/api/internal/thumbnail-renderer/v1/claim?includeKind=video`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const response = await dispatchThumbnailRendererApi(request, {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head: value.head },
    } as never);

    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "claimed",
      sourceKey: value.job.source_key,
      sourceEtag: value.job.source_etag,
      sourceSize: value.job.source_size,
      mediaKind: "video",
      sourceContentType: "video/quicktime",
      thumbnailKey: value.job.thumbnail_key,
    });
    expect(body.leaseId).toEqual(expect.any(String));
    expect(body.r2SourceUrl).toContain("/api/internal/thumbnail-renderer/v1/source/");
    expect(value.job).toMatchObject({ status: "processing", attempt_count: 1 });
    const initialLeaseMs = Date.parse(value.job.lease_until!) - claimStartedAt;
    expect(initialLeaseMs).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(initialLeaseMs).toBeLessThan(15 * 60 * 1000 + 2_000);
    expect(value.queries.some(sql => sql.includes("source.media_kind='video'") && sql.includes("INDEXED BY idx_file_index_kind"))).toBe(true);
    expect(value.health.writes).toBe(0);
  });

  it("does not lease a future render boundary and leases the same exact row once due", async () => {
    const value = videoClaimFixture({
      contentType: "image/jpeg",
      sourceKey: "Jobs/Clients/Acme/prebuilt.jpg",
      renderNotBefore: new Date(Date.now() + 15 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19),
    });
    const env = {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head: value.head },
    } as never;
    const request = () => new Request(`https://${HOST}/api/internal/thumbnail-renderer/v1/claim?includeKind=all`, {
      method: "POST", headers: { Authorization: `Bearer ${SECRET}` },
    });

    const future = await dispatchThumbnailRendererApi(request(), env);
    expect(await future!.json()).toEqual({ status: "idle" });
    expect(value.head).not.toHaveBeenCalled();
    expect(value.queries.some(sql => sql.includes("job.render_not_before IS NULL") && sql.includes("datetime(job.render_not_before)<=datetime('now')"))).toBe(true);

    value.job.render_not_before = new Date(Date.now() - 1_000).toISOString().replace("T", " ").slice(0, 19);
    const due = await dispatchThumbnailRendererApi(request(), env);
    expect(await due!.json()).toMatchObject({ status: "claimed", sourceKey: value.job.source_key });
    expect(value.head).toHaveBeenCalledTimes(1);
  });

  it("returns authoritative video content type when the object name has a misleading image suffix", async () => {
    const value = videoClaimFixture({ sourceKey: "Jobs/Clients/Acme/disguised.jpg", contentType: "video/mp4" });
    const response = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/claim?includeKind=all`,
      { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } },
    ), {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head: value.head },
    } as never);

    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      sourceKey: "Jobs/Clients/Acme/disguised.jpg",
      mediaKind: "video",
      sourceContentType: "video/mp4",
    });
  });

  it("uses the signed unified lease to keep primary health fresh while every slot is busy", async () => {
    const value = videoClaimFixture({
      sourceKey: "Jobs/Clients/Acme/photo.jpg",
      sourceEtag: "image-etag",
      contentType: "image/jpeg",
    });
    const queue = { send: vi.fn() };
    const apiEnv = {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head: value.head },
      THUMBNAIL_QUEUE: queue,
    } as never;
    const claimed = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/claim?includeKind=all`,
      { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } },
    ), apiEnv);
    const claim = await claimed!.json() as { leaseId: string; sourceKey: string };
    expect(value.health.writes).toBe(1);

    value.health.throttleOpen = true;
    const heartbeat = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/heartbeat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sourceKey: claim.sourceKey, leaseId: claim.leaseId }),
      },
    ), apiEnv);

    expect(heartbeat?.status).toBe(200);
    expect(value.health.writes).toBe(2);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("throttles repeated fresh unified polls to one D1 health write per interval", async () => {
    const value = videoClaimFixture({ contentType: "image/jpeg", sourceKey: "Jobs/Clients/Acme/photo.jpg" });
    const env = {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head: value.head },
    } as never;
    const request = () => new Request(`https://${HOST}/api/internal/thumbnail-renderer/v1/claim?includeKind=all`, {
      method: "POST", headers: { Authorization: `Bearer ${SECRET}` },
    });

    expect((await dispatchThumbnailRendererApi(request(), env))?.status).toBe(200);
    expect((await dispatchThumbnailRendererApi(request(), env))?.status).toBe(200);

    expect(value.health).toMatchObject({ attempts: 2, writes: 1 });
    expect(value.queries.some(sql => sql.includes("datetime('now','-30 seconds')"))).toBe(true);
  });

  it("durably republishes a retryable unified still failure for Cloudflare fallback", async () => {
    const value = videoClaimFixture({
      sourceKey: "Jobs/Clients/Acme/photo.jpg",
      sourceEtag: "image-etag",
      contentType: "image/jpeg",
    });
    const send = vi.fn(async () => undefined);
    const apiEnv = {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head: value.head },
      THUMBNAIL_QUEUE: { send },
    } as never;
    const claimed = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/claim?includeKind=all`,
      { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } },
    ), apiEnv);
    const claim = await claimed!.json() as { leaseId: string; sourceKey: string };
    const failed = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/fail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sourceKey: claim.sourceKey, leaseId: claim.leaseId, errorCode: "decode_failed" }),
      },
    ), apiEnv);

    expect(failed?.status).toBe(200);
    expect(await failed!.json()).toEqual({ status: "retrying" });
    expect(send).toHaveBeenCalledWith({
      kind: "image-thumbnail.v1",
      sourceKey: value.job.source_key,
      sourceEtag: value.job.source_etag,
    });
    expect(value.job).toMatchObject({
      status: "pending",
      error_code: "decode_failed",
      queue_published_at: "2026-08-24 12:00:00",
    });
    expect(value.queries.some(sql => sql.includes("job.error_code IS NULL OR job.error_code='pixel_limit_exceeded' OR source.media_kind='video'"))).toBe(true);
  });

  it("leaves a durable unpublished marker when retryable failure publication is unavailable", async () => {
    const value = videoClaimFixture({ contentType: "application/pdf", sourceKey: "Jobs/Clients/Acme/report.pdf" });
    const apiEnv = {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head: value.head },
      THUMBNAIL_QUEUE: { send: vi.fn(async () => { throw new Error("queue unavailable"); }) },
    } as never;
    const claimed = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/claim?includeKind=all`,
      { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } },
    ), apiEnv);
    const claim = await claimed!.json() as { leaseId: string; sourceKey: string };
    const failed = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/fail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sourceKey: claim.sourceKey, leaseId: claim.leaseId, errorCode: "decode_failed" }),
      },
    ), apiEnv);

    expect(failed?.status).toBe(200);
    expect(value.job).toMatchObject({ status: "pending", error_code: "decode_failed", queue_published_at: null });
  });

  it("records successful renderer completions as TrueNAS provenance", async () => {
    const value = videoClaimFixture();
    const bytes = validWebpBytes();
    const claimEnv = {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head: value.head },
    } as never;
    const claimed = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/claim?includeKind=video`,
      { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } },
    ), claimEnv);
    const claim = await claimed!.json() as { leaseId: string; thumbnailKey: string };
    const head = vi.fn(async (key: string) => key === claim.thumbnailKey ? {
      httpEtag: '"thumbnail-etag"', size: bytes.byteLength,
      httpMetadata: { contentType: "image/webp" },
    } : { httpEtag: '"video-etag"', size: 4096, httpMetadata: { contentType: "video/quicktime" } });
    const response = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/complete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          leaseId: claim.leaseId,
          thumbnailKey: claim.thumbnailKey,
          thumbnailEtag: "thumbnail-etag",
          thumbnailSize: bytes.byteLength,
        }),
      },
    ), {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: {
        head,
        get: vi.fn(async () => ({ body: new ReadableStream(), arrayBuffer: async () => bytes.buffer })),
      },
    } as never);

    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ status: "ready" });
    expect(value.job.thumbnail_provider).toBe("ltds-truenas");
  });

  it("drives an idle video claim from the video index instead of an image-only pending backlog", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`CREATE TABLE image_thumbnail_jobs(
      source_key TEXT PRIMARY KEY,source_etag TEXT NOT NULL,source_size INTEGER NOT NULL,
      thumbnail_key TEXT NOT NULL,attempt_count INTEGER NOT NULL,status TEXT NOT NULL,
      lease_until TEXT,queue_published_at TEXT,render_not_before TEXT);
      CREATE TABLE file_index(
        r2_key TEXT PRIMARY KEY,etag TEXT NOT NULL,size INTEGER NOT NULL,
        media_kind TEXT NOT NULL,stream_status TEXT);
      CREATE INDEX idx_file_index_kind ON file_index(media_kind,stream_status);`);
    const insertJob = database.prepare("INSERT INTO image_thumbnail_jobs VALUES(?,?,?,?,0,'pending',NULL,?,NULL)");
    const insertFile = database.prepare("INSERT INTO file_index VALUES(?,?,?,'image',NULL)");
    database.exec("BEGIN");
    for (let index = 0; index < 25_000; index += 1) {
      const key = `Jobs/Clients/Backfill/image-${String(index).padStart(5, "0")}.jpg`;
      insertJob.run(key, `etag-${index}`, 4096, `_ltds/derivatives/thumbnails/v1/managed/${index}.webp`, String(index));
      insertFile.run(key, `etag-${index}`, 4096);
    }
    database.exec("COMMIT");

    let candidateSql = "";
    const prepare = (sql: string) => {
      candidateSql = sql;
      const statement = database.prepare(sql);
      let values: SQLInputValue[] = [];
      return {
        bind(...input: SQLInputValue[]) { values = input; return this; },
        async first() { return statement.get(...values) || null; },
      };
    };
    const head = vi.fn();
    const started = performance.now();
    const response = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/claim?includeKind=video`,
      { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } },
    ), {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare },
      DATA_BUCKET: { head },
    } as never);
    const elapsedMs = performance.now() - started;
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ status: "idle" });
    expect(head).not.toHaveBeenCalled();
    expect(elapsedMs).toBeLessThan(2_000);
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${candidateSql}`).all() as Array<{ detail: string }>;
    const sourceLoop = plan.findIndex(row => row.detail.includes("idx_file_index_kind"));
    const jobLoop = plan.findIndex(row => row.detail.includes("image_thumbnail_jobs"));
    expect(sourceLoop).toBeGreaterThanOrEqual(0);
    expect(jobLoop).toBeGreaterThan(sourceLoop);
    database.close();
  });

  it("rejects claim access before D1 or R2 without the renderer secret", async () => {
    const value = videoClaimFixture();
    const response = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/claim`,
      { method: "POST" },
    ), {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head: value.head },
    } as never);

    expect(response?.status).toBe(401);
    expect(value.prepare).not.toHaveBeenCalled();
    expect(value.head).not.toHaveBeenCalled();
  });

  it("does not expose the renderer API on the incoming upload host", async () => {
    const value = videoClaimFixture();
    const response = await dispatchThumbnailRendererApi(new Request(
      "https://incoming.example.test/api/internal/thumbnail-renderer/v1/claim?includeKind=video",
      { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } },
    ), {
      THUMBNAIL_INGEST_EXPECTED_HOST: "ops.example.test",
      INCOMING_EXPECTED_HOST: "incoming.example.test",
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head: value.head },
    } as never);

    expect(response).toBeNull();
    expect(value.prepare).not.toHaveBeenCalled();
    expect(value.head).not.toHaveBeenCalled();
  });

  it("serves an exact leased source range through the R2 range option", async () => {
    const value = videoClaimFixture();
    const sourceKey = value.job.source_key;
    const get = vi.fn(async (_key: string, options: unknown) => ({
      body: new ReadableStream<Uint8Array>(),
      httpEtag: '"video-etag"',
      size: 4096,
      httpMetadata: { contentType: "video/quicktime" },
    }));
    const claimResponse = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/claim`,
      { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } },
    ), {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head: value.head },
    } as never);
    const claim = await claimResponse!.json() as { r2SourceUrl: string };
    const response = await dispatchThumbnailRendererApi(new Request(
      new URL(claim.r2SourceUrl, `https://${HOST}`).toString(),
      { headers: { Authorization: `Bearer ${SECRET}`, Range: "bytes=100-199" } },
    ), {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: {
        head: vi.fn(async () => ({ httpEtag: '"video-etag"', size: 4096 })),
        get,
      },
    } as never);

    expect(response?.status).toBe(206);
    expect(response?.headers.get("Content-Range")).toBe("bytes 100-199/4096");
    expect(response?.headers.get("Content-Length")).toBe("100");
    expect(get).toHaveBeenCalledWith(sourceKey, {
      onlyIf: { etagMatches: "video-etag" },
      range: { offset: 100, length: 100 },
    });
  });

  it("rejects a stale lease after a newer claim attempt without reading R2", async () => {
    const value = videoClaimFixture();
    const claimed = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/claim`,
      { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } },
    ), {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head: value.head },
    } as never);
    const lease = await claimed!.json() as { r2SourceUrl: string };
    value.job.attempt_count += 1;
    const head = vi.fn();
    const get = vi.fn();

    const response = await dispatchThumbnailRendererApi(new Request(
      new URL(lease.r2SourceUrl, `https://${HOST}`).toString(),
      { headers: { Authorization: `Bearer ${SECRET}` } },
    ), {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head, get },
    } as never);

    expect(response?.status).toBe(404);
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("binds heartbeat and failure transitions to the exact claimed attempt", async () => {
    const value = videoClaimFixture();
    const apiEnv = {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head: value.head },
    } as never;
    const claimed = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/claim`,
      { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } },
    ), apiEnv);
    const claim = await claimed!.json() as { leaseId: string; sourceKey: string };
    const initialLeaseUntil = value.job.lease_until;

    const heartbeat = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/heartbeat`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sourceKey: claim.sourceKey, leaseId: claim.leaseId }),
      },
    ), apiEnv);
    expect(heartbeat?.status).toBe(200);
    expect(value.job.lease_until).toBe(initialLeaseUntil);

    value.job.attempt_count += 1;
    const staleFailure = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/fail`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sourceKey: claim.sourceKey, leaseId: claim.leaseId, errorCode: "decode_failed" }),
      },
    ), apiEnv);
    expect(staleFailure?.status).toBe(404);
    expect(value.job.status).toBe("processing");
  });

  it("does not let an older completion win after the job is reclaimed during R2 verification", async () => {
    const value = videoClaimFixture();
    const bytes = validWebpBytes();
    const claimEnv = {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head: value.head },
    } as never;
    const claimed = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/claim`,
      { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } },
    ), claimEnv);
    const claim = await claimed!.json() as { leaseId: string; thumbnailKey: string };
    const head = vi.fn(async (key: string) => key === claim.thumbnailKey ? {
      httpEtag: '"thumbnail-etag"', size: bytes.byteLength,
      httpMetadata: { contentType: "image/webp" },
    } : { httpEtag: '"video-etag"', size: 4096, httpMetadata: { contentType: "video/quicktime" } });
    const get = vi.fn(async () => {
      value.job.attempt_count += 1;
      return { body: new ReadableStream(), arrayBuffer: async () => bytes.buffer };
    });
    const response = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/complete`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          leaseId: claim.leaseId,
          thumbnailKey: claim.thumbnailKey,
          thumbnailEtag: "thumbnail-etag",
          thumbnailSize: bytes.byteLength,
        }),
      },
    ), {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare: value.prepare },
      DATA_BUCKET: { head, get },
    } as never);

    expect(response?.status).toBe(404);
    expect(value.job.status).toBe("processing");
    expect(value.job.attempt_count).toBe(2);
  });

  it("does not expose R2 when the requested source has no current processing lease", async () => {
    const head = vi.fn();
    const get = vi.fn();
    const prepare = vi.fn((_sql: string) => {
      const statement = { bind() { return statement; }, async first() { return null; } };
      return statement;
    });
    const response = await dispatchThumbnailRendererApi(new Request(
      `https://${HOST}/api/internal/thumbnail-renderer/v1/source/forged?key=${encodeURIComponent("Jobs/Other/private.mov")}`,
      { headers: { Authorization: `Bearer ${SECRET}` } },
    ), {
      THUMBNAIL_INGEST_EXPECTED_HOST: HOST,
      THUMBNAIL_INGEST_SECRET: SECRET,
      DELIVERY_DB: { prepare },
      DATA_BUCKET: { head, get },
    } as never);

    expect(response?.status).toBe(404);
    expect(head).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});
