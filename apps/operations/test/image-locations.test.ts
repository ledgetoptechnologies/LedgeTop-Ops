import migration from "../../client/migrations/0109_image_asset_locations.sql?raw";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteImageLocation,
  enqueueImageLocationBackfill,
  processImageLocation,
} from "../src/worker/image-locations";
import type { Env } from "../src/worker/types";

function gpsTiff(): Uint8Array {
  const bytes = new Uint8Array(160), view = new DataView(bytes.buffer);
  bytes.set([0x49, 0x49]); view.setUint16(2, 42, true); view.setUint32(4, 8, true);
  view.setUint16(8, 1, true); view.setUint16(10, 0x8825, true); view.setUint16(12, 4, true);
  view.setUint32(14, 1, true); view.setUint32(18, 26, true); view.setUint16(26, 4, true);
  const entries = [[1, 2, 2, "N"], [2, 5, 3, 80], [3, 2, 2, "W"], [4, 5, 3, 104]] as const;
  entries.forEach(([tag, type, count, value], index) => {
    const offset = 28 + index * 12;
    view.setUint16(offset, tag, true); view.setUint16(offset + 2, type, true); view.setUint32(offset + 4, count, true);
    if (typeof value === "string") { bytes[offset + 8] = value.charCodeAt(0); bytes[offset + 9] = 0; }
    else view.setUint32(offset + 8, value, true);
  });
  [[44, 1], [30, 1], [0, 1]].forEach(([n, d], index) => { view.setUint32(80 + index * 8, n!, true); view.setUint32(84 + index * 8, d!, true); });
  [[88, 1], [6, 1], [0, 1]].forEach(([n, d], index) => { view.setUint32(104 + index * 8, n!, true); view.setUint32(108 + index * 8, d!, true); });
  return bytes;
}

async function applySql(db: D1Database, sql: string) {
  for (const statement of sql.split(/;\s*(?:\n|$)/)
    .map(value => value.replace(/^\s*--.*$/gm, "").trim())
    .filter(value => value && !/^PRAGMA\s+foreign_keys/i.test(value)))
    await db.prepare(statement).run();
}

describe("image location extraction lifecycle", () => {
  let miniflare: Miniflare;
  let db: D1Database;
  const sourceKey = "Jobs/Clients/Acme/Delivery/photo.jpg";

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-22",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DB: "image-location-tests" },
    });
    db = await miniflare.getD1Database("DB") as unknown as D1Database;
    await applySql(db, `
      CREATE TABLE file_index(r2_key TEXT PRIMARY KEY,etag TEXT NOT NULL,size INTEGER NOT NULL,media_kind TEXT NOT NULL);
      CREATE TABLE delivery_tombstones(physical_key TEXT PRIMARY KEY,tombstone_kind TEXT NOT NULL,restored_at TEXT);`);
    await applySql(db, migration);
    await db.prepare("PRAGMA foreign_keys = ON").run();
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM image_asset_locations"),
      db.prepare("DELETE FROM delivery_tombstones"),
      db.prepare("DELETE FROM file_index"),
      db.prepare("INSERT INTO file_index(r2_key,etag,size,media_kind) VALUES(?,?,?,'image')").bind(sourceKey, "etag-1", gpsTiff().byteLength),
    ]);
  });

  afterAll(async () => miniflare.dispose());

  function env(bytes: Uint8Array, get = vi.fn(async () => ({
    httpEtag: '"etag-1"',
    body: new ReadableStream(),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }))) {
    return {
      DELIVERY_DB: db,
      DATA_BUCKET: { get },
      THUMBNAIL_QUEUE: { send: vi.fn(async () => undefined) },
    } as unknown as Env;
  }

  it("extracts once per exact version and clears stale coordinates on replacement", async () => {
    const value = env(gpsTiff());
    await expect(processImageLocation(value, { sourceKey, sourceEtag: "etag-1", sourceSize: gpsTiff().byteLength })).resolves.toBe("ready");
    await expect(processImageLocation(value, { sourceKey, sourceEtag: "etag-1", sourceSize: gpsTiff().byteLength })).resolves.toBe("duplicate");
    expect(value.DATA_BUCKET.get).toHaveBeenCalledTimes(1);
    expect(await db.prepare("SELECT source_etag,status,latitude,longitude,attempt_count FROM image_asset_locations WHERE source_key=?").bind(sourceKey).first())
      .toMatchObject({ source_etag: "etag-1", status: "ready", latitude: 44.5, longitude: -88.1, attempt_count: 1 });

    await db.prepare("UPDATE file_index SET etag='etag-2',size=4 WHERE r2_key=?").bind(sourceKey).run();
    const replacementGet = vi.fn(async () => ({
      httpEtag: '"etag-2"', body: new ReadableStream(),
      arrayBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer,
    }));
    const replacement = env(Uint8Array.from([]), replacementGet);
    await expect(processImageLocation(replacement, { sourceKey, sourceEtag: "etag-2", sourceSize: 4 })).resolves.toBe("absent");
    expect(await db.prepare("SELECT source_etag,status,latitude,longitude,attempt_count FROM image_asset_locations WHERE source_key=?").bind(sourceKey).first())
      .toMatchObject({ source_etag: "etag-2", status: "absent", latitude: null, longitude: null, attempt_count: 1 });
  });

  it("retries transient reads without reusing partial coordinates", async () => {
    const get = vi.fn()
      .mockRejectedValueOnce(new Error("R2 temporarily unavailable"))
      .mockResolvedValueOnce({
        httpEtag: '"etag-1"', body: new ReadableStream(),
        arrayBuffer: async () => gpsTiff().buffer,
      });
    const value = env(gpsTiff(), get);
    await expect(processImageLocation(value, { sourceKey, sourceEtag: "etag-1", sourceSize: gpsTiff().byteLength })).rejects.toThrow("temporarily unavailable");
    expect(await db.prepare("SELECT status,latitude,longitude FROM image_asset_locations WHERE source_key=?").bind(sourceKey).first())
      .toMatchObject({ status: "failed", latitude: null, longitude: null });
    await expect(processImageLocation(value, { sourceKey, sourceEtag: "etag-1", sourceSize: gpsTiff().byteLength })).resolves.toBe("ready");
    expect(await db.prepare("SELECT status,attempt_count FROM image_asset_locations WHERE source_key=?").bind(sourceKey).first())
      .toMatchObject({ status: "ready", attempt_count: 2 });
  });

  it("does not read source bytes after a tombstone races the queue claim", async () => {
    await db.prepare("INSERT INTO delivery_tombstones(physical_key,tombstone_kind) VALUES(?,'exact')").bind(sourceKey).run();
    const value = env(gpsTiff());
    await expect(processImageLocation(value, { sourceKey, sourceEtag: "etag-1", sourceSize: gpsTiff().byteLength }))
      .resolves.toBe("obsolete");
    expect(value.DATA_BUCKET.get).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT 1 found FROM image_asset_locations WHERE source_key=?").bind(sourceKey).first()).toBeNull();
  });

  it("rejects a delayed old-version job before registration or R2 reads", async () => {
    await db.prepare("UPDATE file_index SET etag='etag-2' WHERE r2_key=?").bind(sourceKey).run();
    const value = env(gpsTiff());
    await expect(processImageLocation(value, { sourceKey, sourceEtag: "etag-1", sourceSize: gpsTiff().byteLength }))
      .resolves.toBe("obsolete");
    expect(value.DATA_BUCKET.get).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT 1 found FROM image_asset_locations WHERE source_key=?").bind(sourceKey).first()).toBeNull();
  });

  it("deletes exact location state with the source cleanup path", async () => {
    const value = env(gpsTiff());
    await processImageLocation(value, { sourceKey, sourceEtag: "etag-1", sourceSize: gpsTiff().byteLength });
    await deleteImageLocation(value, sourceKey);
    expect(await db.prepare("SELECT 1 found FROM image_asset_locations WHERE source_key=?").bind(sourceKey).first()).toBeNull();
  });

  it("backfills only live non-trashed image versions through the existing queue", async () => {
    const value = env(gpsTiff());
    await expect(enqueueImageLocationBackfill(value, 25)).resolves.toBe(1);
    expect(value.THUMBNAIL_QUEUE.send).toHaveBeenCalledWith({ kind: "image-thumbnail.v1", sourceKey, sourceEtag: "etag-1" });
    expect(await db.prepare("SELECT status,last_enqueued_at IS NOT NULL enqueued FROM image_asset_locations WHERE source_key=?").bind(sourceKey).first())
      .toMatchObject({ status: "pending", enqueued: 1 });
    await db.prepare("INSERT INTO delivery_tombstones(physical_key,tombstone_kind) VALUES(?,'exact')").bind(sourceKey).run();
    await db.prepare("DELETE FROM image_asset_locations").run();
    await expect(enqueueImageLocationBackfill(value, 25)).resolves.toBe(0);
  });
});
