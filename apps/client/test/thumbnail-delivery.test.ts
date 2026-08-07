import { describe, expect, it, vi } from "vitest";
import { thumbnailFallbackKindForFile } from "@ltds/shared";
import { serveAuthorizedThumbnail, thumbnailFieldsForObject, thumbnailStateForObject, type ThumbnailJobRow } from "../src/worker/thumbnails";

const sourceKey = "Jobs/Clients/Synthetic/Edited/photo.jpg";
const thumbnailKey = "_ltds/thumbnails/v1/hash.webp";

function fixture(job: ThumbnailJobRow | null) {
  const original = new TextEncoder().encode("synthetic-full-resolution-original");
  const thumbnail = new TextEncoder().encode("tiny-webp-thumbnail");
  const sourceHead = { size: original.byteLength, etag: "source-etag", httpEtag: '"source-etag"' };
  const thumbnailHead = { size: thumbnail.byteLength, etag: "thumb-etag", httpEtag: '"thumb-etag"' };
  const head = vi.fn(async (key: string) => key === sourceKey ? sourceHead : key === thumbnailKey ? thumbnailHead : null);
  const get = vi.fn(async (key: string) => key === thumbnailKey ? { ...thumbnailHead, body: new Blob([thumbnail]).stream() } : null);
  const statement = {
    bind() { return statement; },
    async first<T>() { return job as T | null; },
  };
  return {
    original,
    thumbnail,
    head,
    get,
    env: { DELIVERY_DB: { prepare: () => statement }, DATA_BUCKET: { head, get } },
  };
}

describe("authorized thumbnail delivery", () => {
  it("serves only the ready derivative and never the full original", async () => {
    const job: ThumbnailJobRow = { source_etag: '"source-etag"', thumbnail_key: thumbnailKey, thumbnail_etag: '"thumb-etag"', thumbnail_size: 19, status: "ready" };
    const value = fixture(job);
    job.thumbnail_size = value.thumbnail.byteLength;
    const response = await serveAuthorizedThumbnail(value.env, sourceKey, { method: "GET" });
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(value.thumbnail);
    expect(bytes).not.toEqual(value.original);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(value.get).toHaveBeenCalledWith(thumbnailKey, { onlyIf: { etagMatches: "thumb-etag" } });
    expect(value.get).not.toHaveBeenCalledWith(sourceKey, expect.anything());
  });

  it.each(["pending", "processing", "failed"] as const)("returns status for %s jobs with zero R2 reads", async status => {
    const value = fixture({ source_etag: '"source-etag"', thumbnail_key: thumbnailKey, thumbnail_etag: null, thumbnail_size: null, status });
    await expect(serveAuthorizedThumbnail(value.env, sourceKey, { method: "GET" })).rejects.toMatchObject({ status: 409 });
    expect(value.head).not.toHaveBeenCalled();
    expect(value.get).not.toHaveBeenCalled();
  });

  it("treats missing and stale jobs as pending and exposes stable fallback kinds", () => {
    expect(thumbnailStateForObject('"current"', null)).toBe("pending");
    expect(thumbnailStateForObject('"current"', { source_etag: '"old"', thumbnail_key: thumbnailKey, thumbnail_etag: '"thumb"', thumbnail_size: 1, status: "ready" })).toBe("pending");
    expect(thumbnailFallbackKindForFile("delivery.zip", "other")).toBe("archive");
    expect(thumbnailFallbackKindForFile("report.pdf", "pdf")).toBe("pdf");
    expect(thumbnailFallbackKindForFile("flight.mov", "video")).toBe("video");
    expect(thumbnailFallbackKindForFile("notes.docx", "other")).toBe("document");
    expect(thumbnailFallbackKindForFile("measurements.xlsx", "other")).toBe("spreadsheet");
    expect(thumbnailFallbackKindForFile("opaque.bin", "other")).toBe("unknown");
  });

  it("builds the list contract so pending and unsupported files can only use local fallbacks", () => {
    const ready: ThumbnailJobRow = { source_etag: '"current"', thumbnail_key: thumbnailKey, thumbnail_etag: '"thumb"', thumbnail_size: 10, status: "ready" };
    expect(thumbnailFieldsForObject("Jobs/Clients/Synthetic/photo.jpg", "image", "/api/items/opaque", '"current"', ready)).toEqual({ thumbnailState: "ready", thumbnailFallbackKind: "image", thumbnailUrl: "/api/items/opaque/thumbnail" });
    const pending = thumbnailFieldsForObject("Jobs/Clients/Synthetic/photo.jpg", "image", "/api/items/opaque", '"new"', ready);
    expect(pending).toEqual({ thumbnailState: "pending", thumbnailFallbackKind: "image" });
    expect(pending).not.toHaveProperty("thumbnailUrl");
    expect(Object.values(pending)).not.toContain("/api/items/opaque/source");

    const unsupported = thumbnailFieldsForObject("Jobs/Clients/Synthetic/archive.zip", "other", "/api/items/archive", '"zip"', null);
    expect(unsupported).toEqual({ thumbnailState: "not_applicable", thumbnailFallbackKind: "archive" });
    expect(unsupported).not.toHaveProperty("thumbnailUrl");

    const videoReady = thumbnailFieldsForObject("Jobs/Clients/Synthetic/flight.mp4", "video", "/api/items/video", '"current"', ready, 4096, "video/mp4");
    expect(videoReady).toEqual({ thumbnailState: "ready", thumbnailFallbackKind: "video", thumbnailUrl: "/api/items/video/thumbnail" });
    expect(thumbnailFieldsForObject("Jobs/Clients/Synthetic/flight.mov", "video", "/api/items/mov", '"current"', null, 4096, "video/quicktime"))
      .toEqual({ thumbnailState: "not_applicable", thumbnailFallbackKind: "video" });
    expect(thumbnailFieldsForObject("Jobs/Clients/Synthetic/huge.mp4", "video", "/api/items/huge", '"current"', null, 100_000_000, "video/mp4"))
      .toEqual({ thumbnailState: "not_applicable", thumbnailFallbackKind: "video" });
  });
});
