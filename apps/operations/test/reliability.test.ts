import { describe, expect, it, vi } from "vitest";
import { aliasParent, normalizeAliasKey, validateDisplayName } from "../src/worker/aliases";
import { canonicalPreviewSource, finalizePreviewManifest, handleRemovedSource, hidden, imageLocationJobForCreatedObject, previewDerivative, previewManifest, thumbnailJobForCreatedObject } from "../src/worker/file-events";
import { derivativePrefixes, validateDeleteConfirmation } from "../src/worker/source-delete";
import { artifactDirectory, previewIdentity } from "../src/worker/artifacts";
import { r2PurgeEnabled, tombstoneMatches, trashSnapshotBlockReason } from "../src/worker/trash";
import { PDF_THUMBNAIL_MAX_INPUT_BYTES, THUMBNAIL_MAX_INPUT_BYTES } from "../src/worker/image-thumbnails";

describe("delivery reliability controls", () => {
  it("maps only bounded image and PDF uploads throughout Jobs to thumbnail queue payloads", () => {
    expect(thumbnailJobForCreatedObject("PutObject", "Jobs/Internal/root-photo.jpg", "image", { httpEtag: '"root-etag"', size: 2048 })).toEqual({ sourceKey: "Jobs/Internal/root-photo.jpg", sourceEtag: '"root-etag"', sourceSize: 2048, delaySeconds: 900 });
    expect(thumbnailJobForCreatedObject("CompleteMultipartUpload", "Jobs/Clients/Synthetic/photo.jpg", "image", { httpEtag: '"source-etag"', size: 4096, customMetadata: { browserUploadSession: "session" } })).toEqual({ sourceKey: "Jobs/Clients/Synthetic/photo.jpg", sourceEtag: '"source-etag"', sourceSize: 4096, delaySeconds: 30 });
    expect(thumbnailJobForCreatedObject("PutObject", "Jobs/Internal/report.pdf", "pdf", { httpEtag: '"pdf-etag"', size: PDF_THUMBNAIL_MAX_INPUT_BYTES, httpMetadata: { contentType: "application/pdf" } })).toEqual({ sourceKey: "Jobs/Internal/report.pdf", sourceEtag: '"pdf-etag"', sourceSize: PDF_THUMBNAIL_MAX_INPUT_BYTES, delaySeconds: 900 });
    expect(thumbnailJobForCreatedObject("PutObject", "Jobs/Clients/Synthetic/flight.mp4", "video", { httpEtag: '"video-etag"', size: 8192, httpMetadata: { contentType: "video/mp4" } })).toBeNull();
    expect(thumbnailJobForCreatedObject("PutObject", "Jobs/Clients/Synthetic/flight.mov", "video", { httpEtag: '"mov-etag"', size: 8192, httpMetadata: { contentType: "video/quicktime" } })).toBeNull();
    expect(thumbnailJobForCreatedObject("PutObject", "Jobs/Internal/too-large.jpg", "image", { httpEtag: '"large-image"', size: THUMBNAIL_MAX_INPUT_BYTES + 1, httpMetadata: { contentType: "image/jpeg" } })).toBeNull();
    expect(thumbnailJobForCreatedObject("PutObject", "Jobs/Internal/too-large.pdf", "pdf", { httpEtag: '"large-pdf"', size: PDF_THUMBNAIL_MAX_INPUT_BYTES + 1, httpMetadata: { contentType: "application/pdf" } })).toBeNull();
    expect(thumbnailJobForCreatedObject("CompleteMultipartUpload", "Jobs/Clients/Synthetic/archive.zip", "other", { httpEtag: '"archive"', size: 10 })).toBeNull();
    expect(imageLocationJobForCreatedObject("PutObject", "Jobs/Clients/Synthetic/source.tiff", "image", { httpEtag: '"tiff-etag"' }))
      .toEqual({ sourceKey: "Jobs/Clients/Synthetic/source.tiff", sourceEtag: '"tiff-etag"' });
  });
  it("ignores stale delete events and runs thumbnail cleanup for a real source delete", async () => {
    const queries: string[] = [];
    const prepare = vi.fn((sql: string) => {
      queries.push(sql);
      const statement = {
        bind() { return statement; },
        async first() { return null; },
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 1 } }; },
      };
      return statement;
    });
    const deleteObject = vi.fn();
    const liveHead = vi.fn(async (): Promise<{ httpEtag: string } | null> => ({ httpEtag: '"replacement"' }));
    const env = {
      DATA_BUCKET: { head: liveHead, delete: deleteObject },
      DELIVERY_DB: { prepare, async batch(statements: Array<{ run(): Promise<unknown> }>) { return Promise.all(statements.map(statement => statement.run())); } },
    } as any;

    await expect(handleRemovedSource(env, "Jobs/Clients/Synthetic/photo.jpg")).resolves.toBe("stale");
    expect(prepare).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();

    liveHead.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(handleRemovedSource(env, "Jobs/Clients/Synthetic/photo.jpg")).resolves.toBe("removed");
    expect(queries.some(query => query.includes("thumbnail.current-row"))).toBe(true);
    expect(queries).toContain("SELECT etag FROM file_index WHERE r2_key=?");
    expect(queries).not.toContain("DELETE FROM file_index WHERE r2_key=?");
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("uses the removed ETag and rebuilds current index state when a source resurrects", async () => {
    const queries: string[] = [];
    let registeredThumbnailKey: string | null = null;
    const prepare = vi.fn((sql: string) => {
      queries.push(sql);
      let values: unknown[] = [];
      const statement = {
        bind(...input: unknown[]) { values = input; return statement; },
        async first() {
          if (sql === "SELECT etag FROM file_index WHERE r2_key=?") return { etag: '"old"' };
          if (sql.includes("thumbnail.current-row") && registeredThumbnailKey) {
            return { source_etag: "new", thumbnail_key: registeredThumbnailKey, status: "pending", error_code: null, queue_published_at: null };
          }
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          if (sql.includes("thumbnail.register")) registeredThumbnailKey = String(values[3]);
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    });
    const replacement = {
      httpEtag: '"new"', size: 160, uploaded: new Date("2026-08-07T12:00:00Z"),
      httpMetadata: { contentType: "image/tiff" },
    };
    const head = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(replacement)
      .mockResolvedValueOnce(replacement);
    const send = vi.fn(async () => undefined);
    const env = {
      DATA_BUCKET: { head },
      DELIVERY_DB: { prepare, async batch(statements: Array<{ run(): Promise<unknown> }>) { return Promise.all(statements.map(statement => statement.run())); } },
      THUMBNAIL_QUEUE: { send },
    } as any;

    await expect(handleRemovedSource(env, "Jobs/Clients/Synthetic/source.tiff", '"old"')).resolves.toBe("removed");
    expect(queries).toContain("DELETE FROM image_asset_locations WHERE source_key=? AND source_etag=?");
    expect(queries).toContain("DELETE FROM file_index WHERE r2_key=? AND trim(etag,'\"')=trim(?,'\"')");
    expect(queries.some(query => query.includes("INSERT INTO file_index"))).toBe(true);
    expect(send).toHaveBeenCalledWith(
      { kind: "image-thumbnail.v1", sourceKey: "Jobs/Clients/Synthetic/source.tiff", sourceEtag: "new" },
      { delaySeconds: 30 },
    );
  });
  it("rejects reserved segments everywhere in Operations paths", () => {
    for (const key of ["_ltds/a.jpg", "jobs/_ltds/a.jpg", "jobs/client/.previews/hash/thumb.webp", "jobs/client/dump/a.jpg", "jobs/dump/client/a.jpg"]) expect(hidden(key)).toBe(true);
    expect(hidden("jobs/client/unedited/a.jpg")).toBe(false);
  });

  it("recognizes only canonical preview manifests and source roots", () => {
    const hash = "a".repeat(64);
    expect(previewManifest(`Jobs/Clients/Acme/Edited/.previews/${hash}/manifest.json`)).toBe(true);
    expect(previewDerivative(`Jobs/Clients/Acme/Edited/.previews/${hash}/thumb.webp`)).toBe(true);
    expect(previewDerivative(`Jobs/Clients/Acme/Edited/.previews/${hash}/source.jpg`)).toBe(false);
    expect(previewManifest(`Jobs/Clients/Acme/Edited/_ltds/previews/${hash}/manifest.json`)).toBe(false);
    expect(previewManifest(`Jobs/Clients/Acme/Edited/.previews/not-a-hash/manifest.json`)).toBe(false);
    expect(canonicalPreviewSource("Jobs/Clients/Acme/Edited/photo.jpg")).toBe(true);
    expect(canonicalPreviewSource("Jobs/Acme/Edited/photo.jpg")).toBe(false);
    expect(canonicalPreviewSource("Jobs/Clients/Acme/Dump/photo.jpg")).toBe(false);
    expect(canonicalPreviewSource("Jobs/Clients/Acme/.previews/hash/thumb.webp")).toBe(false);
  });

  it("validates aliases without allowing hierarchy or control spoofing", () => {
    expect(validateDisplayName(" Client-facing name ")).toBe("Client-facing name");
    expect(() => validateDisplayName("folder/name")).toThrow();
    expect(() => validateDisplayName("..")) .toThrow();
    expect(() => validateDisplayName("bad\nname")).toThrow();
    for (const name of ["CON", "client?.jpg", "folder.", "_ltds", ".previews", "dump"]) expect(() => validateDisplayName(name)).toThrow();
    expect(() => normalizeAliasKey("jobs/client/dump/")) .toThrow();
    expect(aliasParent("jobs/client/photo.jpg")).toBe("jobs/client/");
    expect(aliasParent("jobs/client/edited/")).toBe("jobs/client/");
  });

  it("targets only the deterministic sibling derivative namespace", async () => {
    const prefixes = await derivativePrefixes("Jobs/client/photo.jpg", false);
    expect(prefixes).toHaveLength(1);
    expect(prefixes[0]).toMatch(/^Jobs\/client\/\.previews\/[a-f0-9]{64}\/$/);
    await expect(derivativePrefixes("Jobs/client/edited/", true)).resolves.toEqual([]);
  });

  it("uses the NFC filename, not the client path, as preview identity", async () => {
    await expect(previewIdentity("Jobs/A/cafe\u0301.JPG")).resolves.toBe(await previewIdentity("Jobs/B/café.JPG"));
    await expect(artifactDirectory("Jobs/A/photo.jpg")).resolves.toMatch(/^Jobs\/A\/\.previews\/[a-f0-9]{64}\/$/);
  });

  it("finalizes a bounded provisional manifest with the exact R2 source identity", async () => {
    const sourceKey = "Jobs/Clients/Acme/Edited/photo.jpg";
    const prefix = await artifactDirectory(sourceKey);
    const manifestKey = `${prefix}manifest.json`;
    const manifest = {
      sourceKey,
      sourceEtag: "pending",
      sourceSize: 200,
      producerVersion: "ltds-preview/2.0.0",
      createdAt: "2026-07-26T23:59:00Z",
      finalizationStatus: "pending-r2",
      derivatives: {
        thumb: { key: `${prefix}thumb.webp`, mime: "image/webp", width: 520, height: 340, bytes: 80 },
        preview: { key: `${prefix}preview.webp`, mime: "image/webp", width: 1600, height: 1200, bytes: 400 },
      },
    };
    const stored = new Map<string, { size: number; etag: string; body?: unknown }>([
      [sourceKey, { size: 200, etag: "\"source-etag\"" }],
      [manifestKey, { size: JSON.stringify(manifest).length, etag: "\"manifest-old\"", body: manifest }],
      [`${prefix}thumb.webp`, { size: 80, etag: "\"thumb\"" }],
      [`${prefix}preview.webp`, { size: 400, etag: "\"preview\"" }],
    ]);
    let recorded: unknown[] = [];
    const statement = { bind(...values: unknown[]) { recorded = values; return statement; }, async run() { return { meta: { changes: 1 } }; } };
    const env: any = {
      DATA_BUCKET: {
        async head(key: string) { const value = stored.get(key); return value ? { size: value.size, httpEtag: value.etag } : null; },
        async get(key: string) { const value = stored.get(key); return value?.body ? { async json() { return value.body; } } : null; },
      },
      DELIVERY_DB: { prepare() { return statement; } },
    };
    await expect(finalizePreviewManifest(env, manifestKey)).resolves.toBe("ready");
    expect(recorded).toEqual([prefix, sourceKey, "\"source-etag\"", "\"manifest-old\"", JSON.stringify({ thumb: "\"thumb\"", preview: "\"preview\"" })]);
  });

  it("rejects stale or oversized provisional preview metadata", async () => {
    const sourceKey = "Jobs/Clients/Acme/Edited/photo.jpg";
    const prefix = await artifactDirectory(sourceKey);
    const manifestKey = `${prefix}manifest.json`;
    const badManifest = { sourceKey, sourceEtag: "pending", sourceSize: 199, producerVersion: "test", createdAt: "2026-07-26T23:59:00Z", derivatives: {} };
    const env: any = {
      DATA_BUCKET: {
        async head(key: string) {
          if (key === manifestKey) return { size: JSON.stringify(badManifest).length, httpEtag: "\"manifest\"" };
          if (key === sourceKey) return { size: 200, httpEtag: "\"source\"" };
          return null;
        },
        async get() { return { async json() { return badManifest; } }; },
      },
      DELIVERY_DB: { prepare() { throw new Error("invalid manifests must not write D1"); } },
    };
    await expect(finalizePreviewManifest(env, manifestKey)).resolves.toBe("invalid");
  });

  it("requires an exact typed-name delete confirmation", () => {
    expect(() => validateDeleteConfirmation("folder", "folder")).not.toThrow();
    expect(() => validateDeleteConfirmation("Folder", "folder")).toThrow();
    expect(() => validateDeleteConfirmation("folder ", "folder")).toThrow();
  });

  it("matches trash tombstones without crossing folder boundaries", () => {
    expect(tombstoneMatches({ physical_key: "Jobs/client/photo.jpg", tombstone_kind: "exact" }, "Jobs/client/photo.jpg")).toBe(true);
    expect(tombstoneMatches({ physical_key: "Jobs/client/photo.jpg", tombstone_kind: "exact" }, "Jobs/client/photo.jpg.bak")).toBe(false);
    expect(tombstoneMatches({ physical_key: "Jobs/client/", tombstone_kind: "prefix" }, "Jobs/client/edited/photo.jpg")).toBe(true);
    expect(tombstoneMatches({ physical_key: "Jobs/client/", tombstone_kind: "prefix" }, "Jobs/client-old/photo.jpg")).toBe(false);
  });
  it("blocks legacy, changed, and newly discovered objects from purge", () => {
    const manifest = [{ object_key: "Jobs/client/photo.jpg", object_etag: "v1", object_size: 100, relation: "source" as const, purged_at: null }];
    expect(trashSnapshotBlockReason([], [])).toBe("legacy_or_empty_manifest");
    expect(trashSnapshotBlockReason(manifest, [{ key: "Jobs/client/photo.jpg", etag: "v2", size: 100, relation: "source" }]))
      .toBe("object_identity_changed:Jobs/client/photo.jpg");
    expect(trashSnapshotBlockReason(manifest, [
      { key: "Jobs/client/photo.jpg", etag: "v1", size: 100, relation: "source" },
      { key: "Jobs/client/new.jpg", etag: "v1", size: 20, relation: "source" },
    ])).toBe("unmanifested_object:Jobs/client/new.jpg");
  });

  it("allows unchanged identities and an idempotently missing object", () => {
    const manifest = [
      { object_key: "Jobs/client/photo.jpg", object_etag: "v1", object_size: 100, relation: "source" as const, purged_at: null },
      { object_key: "Jobs/client/.previews/hash/thumb.webp", object_etag: "thumb-v1", object_size: 20, relation: "derived" as const, purged_at: null },
    ];
    expect(trashSnapshotBlockReason(manifest, [
      { key: "Jobs/client/photo.jpg", etag: "v1", size: 100, relation: "source" },
      { key: "Jobs/client/.previews/hash/thumb.webp", etag: "thumb-v1", size: 20, relation: "derived" },
    ])).toBeNull();
    expect(trashSnapshotBlockReason(manifest, [])).toBeNull();
  });

  it("keeps irreversible R2 purge fail-closed unless explicitly enabled", () => {
    expect(r2PurgeEnabled({})).toBe(false);
    expect(r2PurgeEnabled({ R2_PURGE_ENABLED: "false" })).toBe(false);
    expect(r2PurgeEnabled({ R2_PURGE_ENABLED: "TRUE" })).toBe(false);
    expect(r2PurgeEnabled({ R2_PURGE_ENABLED: "true" })).toBe(true);
  });

});
