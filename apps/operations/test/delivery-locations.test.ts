import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("../src/worker/delivery", () => ({
  authorizeDeliveryFolderPrefix: mocks.authorize,
  deliverySourceUrl: (_kind: string, id: string) => `/api/delivery/items/${id}/source`,
  encodeRef: (value: string) => `encoded-${value.split("/").pop()}`,
}));

import { listDeliveryFolderLocations, resolveDeliveryLocationAsset } from "../src/worker/delivery-locations";
import type { Env, StaffPrincipal } from "../src/worker/types";

const principal: StaffPrincipal = {
  id: "staff-a",
  email: "staff@example.test",
  displayName: "Staff",
  accessSubject: "subject-a",
  projectAlphaUserId: null,
};

function environment(rows: Array<{ latitude: number; longitude: number }>) {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const originals = { head: vi.fn(), get: vi.fn(), list: vi.fn() };
  const assetRows = rows.map((row, index) => ({
    ...row,
    source_key: `Jobs/Clients/Acme/Current/photo-${index}.jpg`,
    source_etag: `etag-${index}`,
    size: 4096,
    uploaded_at: "2026-08-07T12:00:00.000Z",
    content_type: "image/jpeg",
    media_kind: "image" as const,
    thumbnail_source_etag: `etag-${index}`,
    thumbnail_key: `_ltds/thumbnails/${index}.webp`,
    thumbnail_status: "ready" as const,
    thumbnail_error_code: null,
  }));
  const env = {
    DELIVERY_TOKEN_SECRET: "test-location-secret-that-is-at-least-32-characters",
    DATA_BUCKET: originals,
    DELIVERY_DB: {
      prepare(sql: string) {
        const call = { sql, binds: [] as unknown[] };
        calls.push(call);
        const statement = {
          bind(...binds: unknown[]) { call.binds = binds; return statement; },
          async all<T>() { return { results: assetRows as T[] }; },
          async first<T>() { return { image_count: assetRows.length } as T; },
        };
        return statement;
      },
    },
  } as unknown as Env;
  return { env, calls, originals };
}

describe("authorized Operations delivery location maps", () => {
  beforeEach(() => {
    mocks.authorize.mockReset().mockResolvedValue("Jobs/Clients/Acme/Current/");
  });

  it("authorizes the exact folder before aggregating opaque current representatives", async () => {
    const value = environment([
      { latitude: 44.5, longitude: -88.1 },
      { latitude: 44.5, longitude: -88.1 },
    ]);
    const result = await listDeliveryFolderLocations(value.env, principal, "Jobs/Clients/Acme/Current");
    expect(mocks.authorize).toHaveBeenCalledWith(value.env, principal, "Jobs/Clients/Acme/Current");
    expect(result).toEqual({
      points: [{
        latitude: 44.5,
        longitude: -88.1,
        imageCount: 2,
        assetRef: expect.stringMatching(/^loc_[A-Za-z0-9_-]{43}$/),
      }],
      totalImageCount: 2,
      unmappedImageCount: 0,
      imageCount: 2,
      truncated: false,
    });
    expect(value.calls[0]?.binds).toEqual(["Jobs/Clients/Acme/Current/", 501]);
    for (const condition of [
      "trim(file.etag,'\"')=location.source_etag",
      "location.folder_prefix=?",
      "location.status='ready'",
      "tombstone.restored_at IS NULL",
    ]) expect(value.calls[0]?.sql).toContain(condition);
    expect(JSON.stringify(result)).not.toMatch(/source|key|etag|photo/i);
    expect(value.originals.head).not.toHaveBeenCalled();
    expect(value.originals.get).not.toHaveBeenCalled();
    expect(value.originals.list).not.toHaveBeenCalled();
  });

  it("does not query location rows when assigned-folder authorization fails", async () => {
    const value = environment([{ latitude: 1, longitude: 2 }]);
    mocks.authorize.mockRejectedValue(new HTTPException(404, { message: "Folder not found" }));
    await expect(listDeliveryFolderLocations(value.env, principal, "Jobs/Clients/Other/"))
      .rejects.toMatchObject({ status: 404 });
    expect(value.calls).toHaveLength(0);
    expect(value.originals.get).not.toHaveBeenCalled();
  });

  it("drops invalid aggregate rows instead of emitting or counting them", async () => {
    const value = environment([
      { latitude: 44.5, longitude: -88.1 },
      { latitude: 91, longitude: -88.1 },
      { latitude: Number.NaN, longitude: -88.1 },
    ]);
    await expect(listDeliveryFolderLocations(value.env, principal, "Jobs/Clients/Acme/Current"))
      .resolves.toEqual({
        points: [{
          latitude: 44.5,
          longitude: -88.1,
          imageCount: 1,
          assetRef: expect.stringMatching(/^loc_[A-Za-z0-9_-]{43}$/),
        }],
        totalImageCount: 3,
        unmappedImageCount: 2,
        imageCount: 1,
        truncated: false,
      });
  });

  it("resolves a current representative after folder reauthorization without reading R2", async () => {
    const value = environment([{ latitude: 44.5, longitude: -88.1 }]);
    const listed = await listDeliveryFolderLocations(value.env, principal, "Jobs/Clients/Acme/Current");
    const assetRef = listed.points[0]?.assetRef;
    expect(assetRef).toBeTruthy();

    await expect(resolveDeliveryLocationAsset(
      value.env,
      principal,
      "Jobs/Clients/Acme/Current",
      assetRef!,
    )).resolves.toMatchObject({
      kind: "image",
      thumbnailState: "ready",
      thumbnailUrl: expect.stringContaining("/thumbnail"),
      previewUrl: expect.stringContaining("/source"),
      sourceUrl: expect.stringContaining("/source"),
      downloadUrl: expect.stringContaining("/download"),
    });
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(value.originals.head).not.toHaveBeenCalled();
    expect(value.originals.get).not.toHaveBeenCalled();
    expect(value.originals.list).not.toHaveBeenCalled();
  });

  it("returns 404 before querying locations for revoked or cross-client resolver access", async () => {
    const value = environment([{ latitude: 44.5, longitude: -88.1 }]);
    mocks.authorize.mockRejectedValue(new HTTPException(403, { message: "Access revoked" }));
    await expect(resolveDeliveryLocationAsset(
      value.env,
      principal,
      "Jobs/Clients/Other/",
      `loc_${"a".repeat(43)}`,
    )).rejects.toMatchObject({ status: 404 });
    expect(value.calls).toHaveLength(0);
    expect(value.originals.get).not.toHaveBeenCalled();
  });
});
