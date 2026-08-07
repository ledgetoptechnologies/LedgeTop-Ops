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
        if (query.includes("s.id=? AND s.public_id=?")) return options.active !== false && values[1] === share.public_id ? share as T : null;
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
  const ctx: ExecutionContext = { waitUntil() {}, passThroughOnException() {}, exports: {}, props: undefined, tracing: undefined as never };
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

  it("serves an eligible MP4 derivative and never reads the video body", async () => {
    const value = await fixture("ready", { relativePath: "Edited/flight.mp4", contentType: "video/mp4", sourceSize: 4096 });
    const response = await worker.fetch(new Request(`https://client.example${value.path}`, { headers: { Cookie: value.cookie } }), value.env, value.ctx);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("thumb");
    expect(value.reads).toEqual([`head:${value.sourceKey}`, `head:${value.sourceKey}`, `head:${thumbnailKey}`, `get:${thumbnailKey}`]);
    expect(value.reads).not.toContain(`get:${value.sourceKey}`);
  });

  it.each([
    ["Edited/flight.mov", "video/quicktime", 4096],
    ["Edited/flight.mp4", "application/octet-stream", 4096],
    ["Edited/flight.mp4", "video/mp4", 100_000_000],
  ] as const)("denies unsupported video thumbnails without reading an original body: %s", async (relativePath, contentType, sourceSize) => {
    const value = await fixture("ready", { relativePath, contentType, sourceSize });
    const response = await worker.fetch(new Request(`https://client.example${value.path}`, { headers: { Cookie: value.cookie } }), value.env, value.ctx);
    expect(response.status).toBe(409);
    expect(value.reads).toEqual([`head:${value.sourceKey}`]);
    expect(value.reads).not.toContain(`get:${value.sourceKey}`);
  });

  it("denies revoked or expired shares and revoked session versions with zero R2 reads", async () => {
    const revoked = await fixture("ready", { active: false });
    expect((await worker.fetch(new Request(`https://client.example${revoked.path}`, { headers: { Cookie: revoked.cookie } }), revoked.env, revoked.ctx)).status).toBe(404);
    expect(revoked.reads).toEqual([]);

    const staleSession = await fixture("ready", { cookieVersion: share.share_version - 1 });
    expect((await worker.fetch(new Request(`https://client.example${staleSession.path}`, { headers: { Cookie: staleSession.cookie } }), staleSession.env, staleSession.ctx)).status).toBe(401);
    expect(staleSession.reads).toEqual([]);
  });
});
