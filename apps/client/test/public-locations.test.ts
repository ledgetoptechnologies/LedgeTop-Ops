import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {} }));
import { listPublicShareLocations, resolvePublicShareLocation } from "../src/worker/public-locations";
import worker from "../src/worker/index";
import { createSessionCookie } from "../src/worker/security";

const share = { id: "share-a", public_id: "public-a", project_id: "project-a", token_hash: "hash", label: null, password_hash: null, password_salt: null, password_iterations: null, password_algorithm: null, expires_at: null, revoked_at: null, revoked_reason: null, unavailable_since: null, share_version: 4, client_name: "Acme", project_name: "North", r2_prefix: "Jobs/Clients/Acme/" };

function fixture() {
  const calls: unknown[][] = [];
  const rows = [{ source_key: `${share.r2_prefix}photo.jpg`, source_etag: "etag-a", latitude: 44.5, longitude: -88.1, size: 1234, uploaded_at: "2026-08-01T00:00:00Z", content_type: "image/jpeg", thumbnail_source_etag: "etag-a", thumbnail_key: "_ltds/thumb.webp", thumbnail_etag: "thumb", thumbnail_size: 25, thumbnail_status: "ready" },
    { source_key: "Jobs/Clients/Other/leak.jpg", source_etag: "etag-b", latitude: 1, longitude: 2, size: 99, uploaded_at: "2026-08-01T00:00:00Z", content_type: "image/jpeg", thumbnail_source_etag: null, thumbnail_key: null, thumbnail_etag: null, thumbnail_size: null, thumbnail_status: null }];
  const database = { withSession() { return database; }, prepare() { const statement = { bind(...values: unknown[]) { calls.push(values); return statement; }, async all<T>() { return { results: rows as T[] }; } }; return statement; } };
  return { env: { DELIVERY_DB: database, DELIVERY_SESSION_SECRET: "s".repeat(48) } as never, calls };
}

describe("public share image locations", () => {
  it("requires an active share session and does not query locations while the privacy opt-in is disabled", async () => {
    let locationQueries = 0; const disabled = { ...share, image_location_map_enabled: 0 };
    const statementFor = (query: string) => {
      let values: unknown[] = [];
      const statement = { bind(...bound: unknown[]) { values = bound; return statement; }, async first<T>() {
        if (query.includes("FROM shares s LEFT JOIN projects") && query.includes("s.id=? AND s.public_id=?")) return values[1] === share.public_id ? disabled as T : null;
        if (query.includes("FROM shares s LEFT JOIN projects") && query.includes("s.id=?")) return disabled as T;
        return null;
      }, async all<T>() { if (query.includes("image-location.public-share-assets")) locationQueries += 1; return { results: [] as T[] }; }, async run() { return { meta: { changes: 1 } }; } };
      return statement;
    };
    const database = { prepare: statementFor, withSession() { return database; } }; const bucket = { async list() { return { objects: [{ key: `${share.r2_prefix}photo.jpg`, size: 1, etag: "a", customMetadata: {} }], delimitedPrefixes: [], truncated: false }; } };
    const secret = "s".repeat(48); const env = { ENVIRONMENT: "development", DELIVERY_DB: database, DATA_BUCKET: bucket, DELIVERY_SESSION_SECRET: secret, SESSION_KEY_ID: "v1", AUDIT_IP_SECRET: "a".repeat(48), PUBLIC_MANIFEST_RATE_LIMITER: { async limit() { return { success: true }; } } } as never;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as never; const url = "https://client.example/api/public/shares/public-a/locations";
    expect((await worker.fetch(new Request(url), env, ctx)).status).toBe(401);
    const cookie = (await createSessionCookie(secret, "v1", share.id, share.share_version, Date.now() + 60_000)).split(";")[0]!;
    const response = await worker.fetch(new Request(url, { headers: { Cookie: cookie } }), env, ctx);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ locations: { points: [], imageCount: 0, truncated: false }, mapboxPublicToken: null }); expect(locationQueries).toBe(0);
    expect((await worker.fetch(new Request("https://client.example/api/public/shares/public-b/locations", { headers: { Cookie: cookie } }), env, ctx)).status).toBe(404);
  });

  it("returns only valid coordinates with opaque share/version-bound representatives", async () => {
    const value = fixture(); const locations = await listPublicShareLocations(value.env, share as never);
    expect(locations).toMatchObject({ imageCount: 1, truncated: false, points: [{ latitude: 44.5, longitude: -88.1, imageCount: 1 }] });
    expect(locations.points[0]?.assetRef).toMatch(/^loc_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(locations)).not.toContain("Jobs/");
    expect(value.calls[0]).toEqual([share.r2_prefix, 501]);
  });

  it("resolves an opaque representative to scoped application URLs and rejects replay across share versions", async () => {
    const value = fixture(); const locations = await listPublicShareLocations(value.env, share as never); const ref = locations.points[0]!.assetRef!;
    const item = await resolvePublicShareLocation(value.env, share as never, ref);
    expect(item).toMatchObject({ name: "photo.jpg", kind: "image", size: 1234, thumbnailState: "ready" });
    expect(item.previewUrl).toMatch(/^\/api\/public\/shares\/public-a\/items\/.+\/source$/);
    expect(item.downloadUrl).toMatch(/^\/api\/public\/shares\/public-a\/items\/.+\/download$/);
    expect(JSON.stringify(item)).not.toContain("Jobs/");
    await expect(resolvePublicShareLocation(value.env, { ...share, share_version: 5 } as never, ref)).rejects.toMatchObject({ status: 404 });
  });
});
