import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
import worker from "../src/worker/index";
import { encodeItemRef } from "../src/worker/files";
import { createSessionCookie } from "../src/worker/security";
import type { ShareRow } from "../src/worker/types";

const share: ShareRow = { id: "share-a", public_id: "public-a", project_id: "project-a", token_hash: "hash", label: null, password_hash: null, password_salt: null, password_iterations: null, password_algorithm: null, expires_at: null, revoked_at: null, revoked_reason: null, unavailable_since: null, share_version: 1, client_name: "Synthetic", project_name: "Gallery", r2_prefix: "Jobs/Clients/Synthetic/" };
const relative = "Edited/photo.jpg";
const sourceKey = `${share.r2_prefix}${relative}`;
const thumbnailKey = "_ltds/thumbnails/v1/opaque.webp";

async function fixture(status: "pending" | "failed" | "ready" = "ready", options: { active?: boolean; cookieVersion?: number; relativePath?: string; contentType?: string; sourceSize?: number } = {}) {
  const reads: string[] = [];
  const fixtureRelative = options.relativePath || relative;
  const fixtureSourceKey = `${share.r2_prefix}${fixtureRelative}`;
  const statementFor = (query: string) => {
    let values: unknown[] = [];
    const statement = {
      bind(...bound: unknown[]) { values = bound; return statement; },
      async first<T>() {
        if (query.includes("FROM image_thumbnail_jobs")) return { source_etag: '"source"', thumbnail_key: thumbnailKey, thumbnail_etag: status === "ready" ? '"thumb"' : null, thumbnail_size: status === "ready" ? 5 : null, status } as T;
        if (query.includes("FROM shares s LEFT JOIN projects")) {
          if (options.active === false) return null;
          if (query.includes("s.public_id=?") && !values.includes(share.public_id)) return null;
          if (query.includes("s.id=?") && !values.includes(share.id)) return null;
          return share as T;
        }
        return null;
      },
      async all<T>() { return { results: [] as T[] }; },
      async run() { return { meta: { changes: 1 } }; },
    };
    return statement;
  };
  const database = { prepare: statementFor, withSession() { return database; } };
  const bucket = {
    async head(key: string) {
      reads.push(`head:${key}`);
      if (key === fixtureSourceKey) return { size: options.sourceSize ?? 100, etag: "source", httpEtag: '"source"', httpMetadata: { contentType: options.contentType || "image/jpeg" } };
      if (key === thumbnailKey) return { size: 5, etag: "thumb", httpEtag: '"thumb"' };
      return null;
    },
    async get(key: string) { reads.push(`get:${key}`); return key === thumbnailKey ? { size: 5, body: new Blob(["thumb"]).stream() } : null; },
  };
  const limiter = { async limit() { return { success: true }; } };
  const secret = "s".repeat(48);
  const env: any = { ENVIRONMENT: "development", EXPECTED_HOST: "client.example", DELIVERY_DB: database, DATA_BUCKET: bucket, PUBLIC_THUMBNAIL_RATE_LIMITER: limiter, DELIVERY_SESSION_SECRET: secret, SESSION_KEY_ID: "v1", AUDIT_IP_SECRET: "a".repeat(48) };
  const cookie = (await createSessionCookie(secret, "v1", share.id, options.cookieVersion ?? share.share_version, Date.now() + 60_000)).split(";")[0]!;
  const ctx = { waitUntil() {}, passThroughOnException() {}, abort() {}, exports: {} as Cloudflare.Exports, props: undefined, tracing: undefined as never } as unknown as ExecutionContext;
  const path = `/api/public/shares/${share.public_id}/items/${encodeURIComponent(encodeItemRef(fixtureRelative))}/thumbnail`;
  return { env, cookie, ctx, path, reads, sourceKey: fixtureSourceKey };
}

describe("thumbnail route authorization", () => {
  it("serves only the authorized thumbnail object", async () => {
    const value = await fixture("ready");
    const response = await worker.fetch(new Request(`https://client.example${value.path}`, { headers: { Cookie: value.cookie } }), value.env, value.ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("thumb");
    expect(value.reads).toEqual([`head:${sourceKey}`, `head:${thumbnailKey}`, `get:${thumbnailKey}`]);
    expect(value.reads).not.toContain(`get:${sourceKey}`);
  });

  it.each(["pending", "failed"] as const)("returns harmless %s status without reading R2", async status => {
    const value = await fixture(status);
    const response = await worker.fetch(new Request(`https://client.example${value.path}`, { headers: { Cookie: value.cookie } }), value.env, value.ctx);
    expect(response.status).toBe(409);
    expect(value.reads).toEqual([]);
  });

  it("denies unauthenticated and cross-share requests with zero R2 reads", async () => {
    const value = await fixture("ready");
    expect((await worker.fetch(new Request(`https://client.example${value.path}`), value.env, value.ctx)).status).toBe(401);
    const crossPath = value.path.replace(`/shares/${share.public_id}/`, "/shares/public-b/");
    expect((await worker.fetch(new Request(`https://client.example${crossPath}`, { headers: { Cookie: value.cookie } }), value.env, value.ctx)).status).toBe(404);
    expect(value.reads).toEqual([]);
  });

  it("serves an eligible PDF derivative and never reads the PDF body", async () => {
    const value = await fixture("ready", { relativePath: "Edited/report.pdf", contentType: "application/pdf", sourceSize: 4096 });
    const response = await worker.fetch(new Request(`https://client.example${value.path}`, { headers: { Cookie: value.cookie } }), value.env, value.ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("thumb");
    expect(value.reads).toEqual([`head:${value.sourceKey}`, `head:${thumbnailKey}`, `get:${thumbnailKey}`]);
    expect(value.reads).not.toContain(`get:${value.sourceKey}`);
  });

  it.each([
    ["Edited/flight.mov", "video/quicktime"],
    ["Edited/flight.mp4", "video/mp4"],
  ] as const)("serves an authorized TrueNAS video thumbnail without reading the video body: %s", async (relativePath, contentType) => {
    const value = await fixture("ready", { relativePath, contentType, sourceSize: 4096 });
    const response = await worker.fetch(new Request(`https://client.example${value.path}`, { headers: { Cookie: value.cookie } }), value.env, value.ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("thumb");
    expect(value.reads).toEqual([`head:${value.sourceKey}`, `head:${thumbnailKey}`, `get:${thumbnailKey}`]);
    expect(value.reads).not.toContain(`get:${value.sourceKey}`);
  });

  it.each([
    ["Edited/huge.pdf", "application/pdf", 256 * 1024 * 1024 + 1, [`head:${share.r2_prefix}Edited/huge.pdf`]],
    ["Edited/huge.jpg", "image/jpeg", 512 * 1024 * 1024 + 1, [`head:${share.r2_prefix}Edited/huge.jpg`]],
  ] as const)("denies unsupported or oversized thumbnails without reading an original body: %s", async (relativePath, contentType, sourceSize, expectedReads) => {
    const value = await fixture("ready", { relativePath, contentType, sourceSize });
    const response = await worker.fetch(new Request(`https://client.example${value.path}`, { headers: { Cookie: value.cookie } }), value.env, value.ctx);
    expect(response.status).toBe(409);
    expect(value.reads).toEqual(expectedReads);
    expect(value.reads).not.toContain(`get:${value.sourceKey}`);
  });

  it("denies revoked or expired shares and revoked session versions with zero R2 reads", async () => {
    const revoked = await fixture("ready", { active: false });
    expect((await worker.fetch(new Request(`https://client.example${revoked.path}`, { headers: { Cookie: revoked.cookie } }), revoked.env, revoked.ctx)).status).toBe(410);
    expect(revoked.reads).toEqual([]);

    const staleSession = await fixture("ready", { cookieVersion: share.share_version - 1 });
    expect((await worker.fetch(new Request(`https://client.example${staleSession.path}`, { headers: { Cookie: staleSession.cookie } }), staleSession.env, staleSession.ctx)).status).toBe(401);
    expect(staleSession.reads).toEqual([]);
  });

  it("returns the authoritative listing before separately hydrating authorized media state", async () => {
    const pdfKey = `${share.r2_prefix}report.pdf`;
    const videoKey = `${share.r2_prefix}flight.mov`;
    const thumbnailQueries: string[] = [];
    const tombstoneScopes: unknown[][] = [];
    const objects = [
      {
        key: pdfKey,
        size: 4096,
        etag: "pdf-source",
        httpEtag: '"pdf-source"',
        uploaded: new Date("2026-08-01T12:00:00.000Z"),
        httpMetadata: { contentType: "application/pdf" },
        customMetadata: {},
      },
      {
        key: videoKey,
        size: 8192,
        etag: "video-source",
        httpEtag: '"video-source"',
        uploaded: new Date("2026-08-01T12:01:00.000Z"),
        httpMetadata: { contentType: "video/quicktime" },
        customMetadata: {},
      },
    ];
    const statementFor = (query: string) => {
      let values: unknown[] = [];
      const statement = {
        query,
        get values() { return values; },
        bind(...bound: unknown[]) { values = bound; return statement; },
        async first<T>() {
          if (query.includes("FROM shares s LEFT JOIN projects") && query.includes("s.id=? AND s.public_id=?")) return share as T;
          return null;
        },
        async all<T>() {
          if (query.includes("FROM delivery_tombstones")) {
            tombstoneScopes.push([...values]);
            return { results: [] as T[] };
          }
          if (query.includes("WITH requested(r2_key)")) {
            thumbnailQueries.push(...values.map(String));
            return { results: values.map(value => {
              const key = String(value);
              return {
                r2_key: key,
                etag: key === videoKey ? '"video-source"' : '"pdf-source"',
                size: key === videoKey ? 8192 : 4096,
                content_type: key === videoKey ? "video/quicktime" : "application/pdf",
                media_kind: key === videoKey ? "video" : "pdf",
                stream_uid: null,
                stream_status: key === videoKey ? "pending" : null,
                source_etag: key === videoKey ? '"video-source"' : '"pdf-source"',
                thumbnail_key: thumbnailKey,
                thumbnail_etag: '"thumb"',
                thumbnail_size: 5,
                thumbnail_status: "ready",
              };
            }) as T[] };
          }
          return { results: [] as T[] };
        },
        async run() { return { meta: { changes: 1 } }; },
      };
      return statement;
    };
    const database = {
      prepare: statementFor,
      withSession() { return database; },
      async batch(statements: Array<ReturnType<typeof statementFor>>) {
        return statements.map(statement => {
          if (statement.query.includes("FROM image_thumbnail_jobs")) {
            thumbnailQueries.push(String(statement.values[0]));
            const key = String(statement.values[0]);
            return { results: [{
              source_etag: key === videoKey ? '"video-source"' : '"pdf-source"',
              thumbnail_key: thumbnailKey,
              thumbnail_etag: '"thumb"',
              thumbnail_size: 5,
              status: "ready",
            }] };
          }
          return { results: [] };
        });
      },
    };
    let listCalls = 0;
    const bucket = {
      async list() {
        listCalls += 1;
        return { objects, delimitedPrefixes: [], truncated: false };
      },
    };
    const limiter = { async limit() { return { success: true }; } };
    const secret = "s".repeat(48);
    const env: any = {
      ENVIRONMENT: "development",
      EXPECTED_HOST: "client.example",
      DELIVERY_DB: database,
      DATA_BUCKET: bucket,
      PUBLIC_MANIFEST_RATE_LIMITER: limiter,
      DELIVERY_SESSION_SECRET: secret,
      SESSION_KEY_ID: "v1",
      AUDIT_IP_SECRET: "a".repeat(48),
    };
    const cookie = (await createSessionCookie(secret, "v1", share.id, share.share_version, Date.now() + 60_000)).split(";")[0]!;
    const ctx = { waitUntil() {}, passThroughOnException() {}, abort() {}, exports: {} as Cloudflare.Exports, props: undefined, tracing: undefined as never } as unknown as ExecutionContext;
    const response = await worker.fetch(new Request(
      `https://client.example/api/public/shares/${share.public_id}/manifest`,
      { headers: { Cookie: cookie } },
    ), env, ctx);

    expect(response.status).toBe(200);
    expect(response.headers.get("Server-Timing")).toMatch(/storage;dur=\d+, list;dur=\d+, auth;dur=\d+/);
    const manifest = await response.json() as { items: Array<Record<string, unknown>> };
    const pdf = manifest.items.find(item => item.name === "report.pdf");
    const video = manifest.items.find(item => item.name === "flight.mov");
    expect(pdf).toMatchObject({ kind: "pdf", thumbnailState: "pending", thumbnailFallbackKind: "pdf" });
    expect(pdf).not.toHaveProperty("thumbnailUrl");
    expect(video).toMatchObject({ kind: "video", thumbnailState: "pending", thumbnailFallbackKind: "video" });
    expect(video).not.toHaveProperty("thumbnailUrl");
    expect(thumbnailQueries).toEqual([]);

    const mediaResponse = await worker.fetch(new Request(
      `https://client.example/api/public/shares/${share.public_id}/manifest/media`,
      {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ items: [pdf?.id, video?.id] }),
      },
    ), env, ctx);
    expect(mediaResponse.status).toBe(200);
    expect(mediaResponse.headers.get("Server-Timing")).toMatch(/database;dur=\d+, media;dur=\d+, auth;dur=\d+/);
    const media = await mediaResponse.json() as { items: Array<Record<string, unknown>> };
    const pdfPatch = media.items.find(item => item.id === pdf?.id);
    const videoPatch = media.items.find(item => item.id === video?.id);
    expect(pdfPatch).toMatchObject({ thumbnailState: "ready", thumbnailFallbackKind: "pdf" });
    expect(pdfPatch?.thumbnailUrl).toMatch(/\/items\/.+\/thumbnail$/);
    expect(videoPatch).toMatchObject({ previewStatus: "processing", thumbnailState: "ready", thumbnailFallbackKind: "video" });
    expect(videoPatch?.thumbnailUrl).toMatch(/\/items\/.+\/thumbnail$/);
    expect(thumbnailQueries).toEqual([pdfKey, videoKey]);
    expect(listCalls).toBe(1);
    expect(tombstoneScopes).toEqual([
      [share.r2_prefix, `${share.r2_prefix}\uffff`, share.r2_prefix],
      [share.r2_prefix, `${share.r2_prefix}\uffff`, share.r2_prefix],
    ]);
  });
});
