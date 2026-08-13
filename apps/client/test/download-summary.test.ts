import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
import worker, { classifyPublicRateLimit } from "../src/worker/index";
import { listDownloadableObjects, summarizeDownloadableObjects } from "../src/worker/downloadable-files";
import { createSessionCookie } from "../src/worker/security";

describe("authorized download-all summary", () => {
  it("uses the manifest limiter and rejects requests without a share session", async () => {
    expect(classifyPublicRateLimit("GET", "/api/public/shares/public/download-summary"))
      .toEqual({ binding: "PUBLIC_MANIFEST_RATE_LIMITER", scope: "download-summary" });
    const response = await worker.fetch(new Request("https://client.example/api/public/shares/public/download-summary"), {
      ENVIRONMENT: "development", DELIVERY_SESSION_SECRET: "s".repeat(48), SESSION_KEY_ID: "v1",
    } as never, { waitUntil() {}, passThroughOnException() {} } as never);
    expect(response.status).toBe(401);
  });

  it("binds the aggregate to the active cookie share and never accepts a browser-supplied root", async () => {
    const share = { id: "share-a", public_id: "public-a", project_id: "project-a", token_hash: "hash", label: null, password_hash: null, password_salt: null, password_iterations: null, password_algorithm: null, expires_at: null, revoked_at: null, revoked_reason: null, unavailable_since: null, share_version: 3, client_name: "Acme", project_name: "North", r2_prefix: "Jobs/Clients/Acme/" };
    let summaryLists = 0;
    const statementFor = (query: string) => {
      let values: unknown[] = [];
      const statement = { bind(...bound: unknown[]) { values = bound; return statement; }, async first<T>() {
        if (query.includes("FROM shares s JOIN projects p") && query.includes("s.id=? AND s.public_id=?")) return values[1] === share.public_id ? share as T : null;
        return null;
      }, async all<T>() { return { results: [] as T[] }; }, async run() { return { meta: { changes: 1 } }; } };
      return statement;
    };
    const database = { prepare: statementFor, withSession() { return database; } };
    const bucket = { async list(options: { prefix: string; delimiter?: string }) {
      expect(options.prefix).toBe(share.r2_prefix);
      if (options.delimiter) return { objects: [{ key: `${share.r2_prefix}photo.jpg`, size: 25, etag: "a", customMetadata: {} }], delimitedPrefixes: [], truncated: false };
      summaryLists += 1;
      return { objects: [{ key: `${share.r2_prefix}photo.jpg`, size: 25, etag: "a", customMetadata: {} }], truncated: false };
    } };
    const secret = "s".repeat(48); const cookie = (await createSessionCookie(secret, "v1", share.id, share.share_version, Date.now() + 60_000)).split(";")[0]!;
    const env = { ENVIRONMENT: "development", DELIVERY_SESSION_SECRET: secret, SESSION_KEY_ID: "v1", AUDIT_IP_SECRET: "a".repeat(48), DELIVERY_DB: database, DATA_BUCKET: bucket, PUBLIC_MANIFEST_RATE_LIMITER: { async limit() { return { success: true }; } } } as never;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
    const valid = await worker.fetch(new Request("https://client.example/api/public/shares/public-a/download-summary?root=Jobs/Other/", { headers: { Cookie: cookie } }), env, ctx);
    expect(valid.status).toBe(200); expect(await valid.json()).toEqual({ fileCount: 1, totalBytes: 25, knownBytes: 25, unknownSizeCount: 0 }); expect(summaryLists).toBe(1);
    const crossShare = await worker.fetch(new Request("https://client.example/api/public/shares/public-b/download-summary", { headers: { Cookie: cookie } }), env, ctx);
    expect(crossShare.status).toBe(404); expect(summaryLists).toBe(1);
  });

  it("paginates only the authorized root and excludes hidden, moved, marker, tombstoned, and out-of-scope objects", async () => {
    const calls: Array<{ prefix: string; cursor?: string }> = [];
    const bucket = { list: vi.fn(async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
      calls.push({ prefix, cursor });
      if (!cursor) return { objects: [
        { key: `${prefix}photo.jpg`, size: 100, etag: "a", customMetadata: {} },
        { key: `${prefix}nested/report.pdf`, size: 200, etag: "b", customMetadata: {} },
        { key: `${prefix}_ltds/private.bin`, size: 900, etag: "c", customMetadata: {} },
        { key: `${prefix}moved.jpg`, size: 300, etag: "d", customMetadata: { ltdsMoveMarker: "ltds-moved-source-v1" } },
        { key: "Jobs/Other/leak.txt", size: 999, etag: "e", customMetadata: {} },
      ], truncated: true, cursor: "next" };
      return { objects: [
        { key: `${prefix}tombstoned.txt`, size: 400, etag: "f", customMetadata: {} },
        { key: `${prefix}folder/`, size: 0, etag: "g", customMetadata: {} },
        { key: `${prefix}video.mp4`, size: 500, etag: "h", customMetadata: {} },
      ], truncated: false };
    }) };
    const objects = await listDownloadableObjects(bucket as never, "Jobs/Clients/Acme/", [{ physical_key: "Jobs/Clients/Acme/tombstoned.txt", tombstone_kind: "exact" }]);
    expect(objects.map(object => object.key)).toEqual(["Jobs/Clients/Acme/photo.jpg", "Jobs/Clients/Acme/nested/report.pdf", "Jobs/Clients/Acme/video.mp4"]);
    expect(summarizeDownloadableObjects(objects)).toEqual({ fileCount: 3, totalBytes: 800, knownBytes: 800, unknownSizeCount: 0 });
    expect(calls).toEqual([{ prefix: "Jobs/Clients/Acme/", cursor: undefined }, { prefix: "Jobs/Clients/Acme/", cursor: "next" }]);
  });

  it("does not claim a total when a size is unknown or unsafe", () => {
    expect(summarizeDownloadableObjects([{ size: 12 }, { size: Number.NaN }, { size: -1 }]))
      .toEqual({ fileCount: 3, totalBytes: null, knownBytes: 12, unknownSizeCount: 2 });
  });
});
