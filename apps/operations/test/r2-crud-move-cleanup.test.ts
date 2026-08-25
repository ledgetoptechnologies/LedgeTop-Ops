import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import thumbnailJobsMigration from "../../client/migrations/0106_image_thumbnail_jobs.sql?raw";
import thumbnailCleanupMigration from "../../client/migrations/0107_thumbnail_cleanup_jobs.sql?raw";
import thumbnailBackfillMigration from "../../client/migrations/0108_thumbnail_backfill_runs.sql?raw";
import locationMigration from "../../client/migrations/0109_image_asset_locations.sql?raw";
import thumbnailProvenanceMigration from "../../client/migrations/0111_thumbnail_render_provenance.sql?raw";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/delivery", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/delivery")>(),
  authorizeDeliveryFolderPrefix: vi.fn(async (_env, _principal, prefix: string) => `${prefix.replace(/\/$/, "")}/`),
}));
vi.mock("../src/worker/image-thumbnails", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/image-thumbnails")>(),
  enqueueThumbnailJob: vi.fn(async () => ({ enqueued: true, state: "pending" })),
}));

import { listDeliveryFolderLocations } from "../src/worker/delivery-locations";
import { processR2OperationJobs } from "../src/worker/r2-crud";
import { enqueueThumbnailJob } from "../src/worker/image-thumbnails";
import { isMovedSourceMarker } from "@ltds/shared";

const source = "Jobs/Clients/Acme/Old/photo.jpg";
const target = "Jobs/Clients/Other/New/photo.jpg";
const oldPrefix = "Jobs/Clients/Acme/Old/";
const principal = {
  id: "viewer",
  email: "viewer@example.test",
  displayName: "Viewer",
  accessSubject: "viewer",
  projectAlphaUserId: null,
};

async function applySql(db: D1Database, sql: string) {
  for (const statement of sql.split(/;\s*(?:\n|$)/)
    .map(value => value.replace(/^\s*--.*$/gm, "").trim())
    .filter(value => value && !/^PRAGMA\s+foreign_keys/i.test(value)))
    await db.prepare(statement).run();
}

async function applyTriggerMigration(db: D1Database, sql: string) {
  await db.exec(sql
    .replace(/^\s*--.*$/gm, "")
    .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "")
    .replace(/\s*\n\s*/g, " "));
}

function object(key: string, etag: string, contentType = "image/jpeg", customMetadata: Record<string,string> = {}) {
  return {
    key,
    size: 4,
    etag,
    httpEtag: `"${etag}"`,
    uploaded: new Date("2026-08-05T12:00:00Z"),
    httpMetadata: { contentType } as Record<string,string>,
    customMetadata,
    body: new ReadableStream(),
    async arrayBuffer() { return new Uint8Array([1, 2, 3, 4]).buffer; },
  };
}

describe("R2 move location cleanup", () => {
  let miniflare: Miniflare;
  let deliveryDb: D1Database;
  let opsDb: D1Database;

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-22",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "r2-move-delivery", OPS_DB: "r2-move-ops" },
    });
    deliveryDb = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    opsDb = await miniflare.getD1Database("OPS_DB") as unknown as D1Database;
    await applySql(deliveryDb, `
      CREATE TABLE file_index(
        r2_key TEXT PRIMARY KEY, etag TEXT NOT NULL, size INTEGER NOT NULL,
        uploaded_at TEXT, content_type TEXT, media_kind TEXT NOT NULL,
        stream_uid TEXT, stream_status TEXT, stream_error TEXT, updated_at TEXT
      );
      CREATE TABLE delivery_tombstones(
        physical_key TEXT PRIMARY KEY, tombstone_kind TEXT NOT NULL, restored_at TEXT
      );
      CREATE TABLE projects(id TEXT PRIMARY KEY, active INTEGER NOT NULL, r2_prefix TEXT);
      CREATE TABLE shares(id TEXT PRIMARY KEY, project_id TEXT, r2_prefix TEXT, revoked_at TEXT, expires_at TEXT, share_version INTEGER, revoked_reason TEXT);
      CREATE TABLE audit_log(actor_type TEXT, actor_id TEXT, action TEXT, entity_type TEXT, entity_id TEXT, details_json TEXT);
    `);
    await applySql(deliveryDb, thumbnailJobsMigration);
    await applyTriggerMigration(deliveryDb, thumbnailCleanupMigration);
    await applySql(deliveryDb, thumbnailBackfillMigration);
    await applyTriggerMigration(deliveryDb, thumbnailProvenanceMigration);
    await applySql(deliveryDb, locationMigration);
    await deliveryDb.prepare("PRAGMA foreign_keys = ON").run();
    await applySql(opsDb, `
      CREATE TABLE r2_operation_jobs(
        id TEXT PRIMARY KEY, kind TEXT, status TEXT, requested_by TEXT,
        source_key TEXT, target_key TEXT, conflict_policy TEXT, payload_json TEXT,
        cursor TEXT, processed_items INTEGER DEFAULT 0, total_items INTEGER,
        lease_until TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT, claim_token TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT, completed_at TEXT, error_code TEXT, error_message TEXT
      );
      CREATE TABLE r2_event_suppressions(
        event_key TEXT PRIMARY KEY, reason TEXT, expires_at TEXT
      );
    `);
  });

  beforeEach(async () => {
    await deliveryDb.batch([
      deliveryDb.prepare("DELETE FROM image_asset_locations"),
      deliveryDb.prepare("DELETE FROM delivery_tombstones"),
      deliveryDb.prepare("DELETE FROM file_index"),
    ]);
    await opsDb.prepare("DELETE FROM r2_operation_jobs").run();
    await opsDb.prepare("DELETE FROM r2_event_suppressions").run();
    vi.mocked(enqueueThumbnailJob).mockClear();
  });

  afterAll(async () => miniflare.dispose());

  async function seedJob(kind: "copy" | "move" = "move", conflict = "fail", sourceKey = source, targetKey = target,
    contentType = "image/jpeg", mediaKind = "image") {
    await deliveryDb.batch([
      deliveryDb.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,'image')")
        .bind(sourceKey, '"etag-source"', 4, "2026-08-05T12:00:00Z", contentType),
      deliveryDb.prepare("INSERT INTO image_asset_locations(source_key,source_etag,folder_prefix,latitude,longitude,status,processed_at) VALUES(?,?,?,?,?,'ready',datetime('now'))")
        .bind(sourceKey, "etag-source", `${sourceKey.slice(0, sourceKey.lastIndexOf("/") + 1)}`, 44.5, -88.1),
    ]);
    if(mediaKind!=="image")await deliveryDb.prepare("UPDATE file_index SET media_kind=? WHERE r2_key=?").bind(mediaKind,sourceKey).run();
    await opsDb.prepare("INSERT INTO r2_operation_jobs(id,kind,status,requested_by,source_key,target_key,conflict_policy,payload_json) VALUES('job-1','batch','queued','staff-a',?,?,?,?)")
      .bind(sourceKey, targetKey, conflict, JSON.stringify([{ kind, sourceKey, targetKey, conflict, sharePolicy: "revoke" }])).run();
  }

  async function seedMove() { await seedJob(); }

  function environment(onBeforeSourceRetire?: (stored: Map<string, ReturnType<typeof object>>) => Promise<void>,
    initial: Array<ReturnType<typeof object>> = [object(source, "etag-source")]) {
    const stored = new Map<string, ReturnType<typeof object>>(initial.map(value => [value.key, value]));
    const putKeys: string[] = [];
    const dataBucket = {
      async head(key: string) { return stored.get(key) ?? null; },
      async get(key: string, options?: { onlyIf?: { etagMatches?: string } }) {
        const current=stored.get(key)??null;
        if(current&&options?.onlyIf?.etagMatches&&current.etag!==options.onlyIf.etagMatches)return null;
        return current;
      },
      async put(key: string, body?: unknown, options?: { onlyIf?: { etagMatches?: string } | Headers; httpMetadata?: Record<string,string>; customMetadata?: Record<string,string> }) {
        putKeys.push(key);
        if(key===source&&body===null){
          await onBeforeSourceRetire?.(stored);
          const current=stored.get(key);
          const etagMatches = options?.onlyIf instanceof Headers ? undefined : options?.onlyIf?.etagMatches;
          if(!current||current.etag!==etagMatches)return null;
          const marker=object(key,"etag-marker");
          marker.size=0;
          marker.httpMetadata=options?.httpMetadata??{};
          marker.customMetadata=options?.customMetadata??{};
          stored.set(key,marker);
          return marker;
        }
        const current=stored.get(key);
        const condition=options?.onlyIf instanceof Headers?options.onlyIf:null;
        if(condition?.get("If-None-Match")==="*"&&current)return null;
        if(condition?.has("If-Match")&&current?.httpEtag!==condition.get("If-Match"))return null;
        const etagMatches=options?.onlyIf instanceof Headers?undefined:options?.onlyIf?.etagMatches;
        if(!condition&&etagMatches&&current?.etag!==etagMatches)return null;
        const sourceValue=stored.get(source);
        const value = object(key, "etag-target", options?.httpMetadata?.contentType||sourceValue?.httpMetadata.contentType||"application/octet-stream", options?.customMetadata||{});
        stored.set(key, value);
        return value;
      },
      async delete(key: string) { stored.delete(key); },
      async list() { return { objects: [], delimitedPrefixes: [], truncated: false }; },
    };
    return {
      env: {
        DELIVERY_DB: deliveryDb,
        OPS_DB: opsDb,
        DATA_BUCKET: dataBucket,
        THUMBNAIL_QUEUE: { send: vi.fn() },
        DELIVERY_TOKEN_SECRET: "r2-move-location-asset-test-secret",
      } as any,
      dataBucket,
      stored,
      putKeys,
    };
  }

  it("removes the old index, location, and map point synchronously with a successful move", async () => {
    await seedMove();
    const value = environment();

    await processR2OperationJobs(value.env);

    expect(isMovedSourceMarker((await value.dataBucket.head(source))!)).toBe(true);
    expect(await value.dataBucket.head(target)).not.toBeNull();
    expect(await deliveryDb.prepare("SELECT r2_key FROM file_index WHERE r2_key=?").bind(source).first()).toBeNull();
    expect(await deliveryDb.prepare("SELECT source_key FROM image_asset_locations WHERE source_key=?").bind(source).first()).toBeNull();
    await expect(listDeliveryFolderLocations(value.env, principal as any, oldPrefix)).resolves.toEqual({
      points: [], totalImageCount: 0, unmappedImageCount: 0, imageCount: 0, truncated: false,
    });
  });

  it("retires the exact source without an unconditional R2 delete", async () => {
    await seedMove();
    const value = environment();
    value.dataBucket.delete = vi.fn(value.dataBucket.delete);

    await processR2OperationJobs(value.env);

    expect(value.dataBucket.delete).not.toHaveBeenCalledWith(source);
    expect(isMovedSourceMarker((await value.dataBucket.head(source))!)).toBe(true);
    expect(await deliveryDb.prepare("SELECT r2_key FROM file_index WHERE r2_key=?").bind(source).first()).toBeNull();
    expect(await deliveryDb.prepare("SELECT source_key FROM image_asset_locations WHERE source_key=?").bind(source).first()).toBeNull();
    await expect(listDeliveryFolderLocations(value.env, principal as any, oldPrefix)).resolves.toEqual({
      points: [], totalImageCount: 0, unmappedImageCount: 0, imageCount: 0, truncated: false,
    });
    expect(await opsDb.prepare("SELECT status,error_message FROM r2_operation_jobs WHERE id='job-1'").first()).toEqual({status:"completed",error_message:null});
  });

  it("does not erase location state for a newer replacement at the old key", async () => {
    await seedMove();
    const value = environment(async stored => {
      stored.set(source, object(source, "etag-replacement"));
      await deliveryDb.prepare("UPDATE file_index SET etag='\"etag-replacement\"',updated_at=datetime('now') WHERE r2_key=?")
        .bind(source).run();
      await deliveryDb.prepare(`INSERT INTO image_asset_locations(source_key,source_etag,folder_prefix,latitude,longitude,status,processed_at)
        VALUES(?,'etag-replacement',?,45.25,-89.75,'ready',datetime('now'))
        ON CONFLICT(source_key) DO UPDATE SET source_etag=excluded.source_etag,folder_prefix=excluded.folder_prefix,
          latitude=excluded.latitude,longitude=excluded.longitude,status=excluded.status,updated_at=datetime('now')`)
        .bind(source, oldPrefix).run();
    });

    await processR2OperationJobs(value.env);

    expect((await value.dataBucket.head(source))?.httpEtag).toBe('"etag-replacement"');
    expect(await deliveryDb.prepare("SELECT etag FROM file_index WHERE r2_key=?").bind(source).first("etag"))
      .toBe('"etag-replacement"');
    expect(await deliveryDb.prepare("SELECT source_etag FROM image_asset_locations WHERE source_key=?").bind(source).first("source_etag"))
      .toBe("etag-replacement");
    await expect(listDeliveryFolderLocations(value.env, principal as any, oldPrefix)).resolves.toEqual({
      points: [{
        latitude: 45.25,
        longitude: -89.75,
        imageCount: 1,
        assetRef: expect.stringMatching(/^loc_[A-Za-z0-9_-]{43}$/),
      }],
      totalImageCount: 1,
      unmappedImageCount: 0,
      imageCount: 1,
      truncated: false,
    });
  });

  it("idempotently recovers a move retry after a post-retirement share-state failure", async () => {
    await seedMove();
    const value = environment();
    let failShareRead = true;
    const originalDelivery = deliveryDb;
    value.env.DELIVERY_DB = new Proxy(originalDelivery, {
      get(targetDb, property) {
        if (property !== "prepare") {
          const member = Reflect.get(targetDb, property);
          return typeof member === "function" ? member.bind(targetDb) : member;
        }
        return (sql: string) => {
          const statement = targetDb.prepare(sql);
          if (!sql.includes("SELECT s.id FROM shares")) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty !== "bind") {
                const member = Reflect.get(statementTarget, statementProperty);
                return typeof member === "function" ? member.bind(statementTarget) : member;
              }
              return (...values: unknown[]) => {
                const bound = statementTarget.bind(...values);
                return new Proxy(bound, {
                  get(boundTarget, boundProperty) {
                    if (boundProperty === "all") return async () => {
                      if (failShareRead) {
                        failShareRead = false;
                        throw new Error("synthetic post-retirement share outage");
                      }
                      return boundTarget.all();
                    };
                    const member = Reflect.get(boundTarget, boundProperty);
                    return typeof member === "function" ? member.bind(boundTarget) : member;
                  },
                });
              };
            },
          });
        };
      },
    }) as unknown as D1Database;

    await processR2OperationJobs(value.env);

    expect(isMovedSourceMarker((await value.dataBucket.head(source))!)).toBe(true);
    expect(await value.dataBucket.head(target)).not.toBeNull();
    expect(await opsDb.prepare("SELECT status,attempt_count,error_message FROM r2_operation_jobs WHERE id='job-1'").first())
      .toEqual({ status: "queued", attempt_count: 1, error_message: "synthetic post-retirement share outage" });
    expect(value.putKeys.filter(key => key === target)).toHaveLength(1);

    await opsDb.prepare("UPDATE r2_operation_jobs SET next_attempt_at=datetime('now','-1 second') WHERE id='job-1'").run();
    await processR2OperationJobs(value.env);

    expect(await opsDb.prepare("SELECT status,error_message FROM r2_operation_jobs WHERE id='job-1'").first())
      .toEqual({ status: "completed", error_message: null });
    expect(isMovedSourceMarker((await value.dataBucket.head(source))!)).toBe(true);
    expect(value.putKeys.filter(key => key === target)).toHaveLength(1);
    expect([...value.stored.keys()].sort()).toEqual([source, target].sort());
    expect(await deliveryDb.prepare("SELECT r2_key FROM file_index WHERE r2_key=?").bind(source).first()).toBeNull();
    expect(await deliveryDb.prepare("SELECT r2_key FROM file_index WHERE r2_key=?").bind(target).first("r2_key")).toBe(target);
    expect(await opsDb.prepare("SELECT COUNT(*) count FROM r2_event_suppressions").first()).toEqual({ count: 0 });
  });

  it.each(["copy", "move"] as const)("fails a raced %s destination without overwrite or suppression poisoning", async kind => {
    await seedJob(kind, "fail");
    const value = environment();
    const originalHead = value.dataBucket.head.bind(value.dataBucket);
    let destinationHeads = 0;
    value.dataBucket.head = async (key: string) => {
      if (key === target && ++destinationHeads === 2) value.stored.set(target, object(target, "etag-race-winner"));
      return originalHead(key);
    };

    await processR2OperationJobs(value.env);

    expect(await opsDb.prepare("SELECT status FROM r2_operation_jobs WHERE id='job-1'").first("status")).toBe("failed");
    expect((await value.dataBucket.head(target))?.httpEtag).toBe('"etag-race-winner"');
    expect((await value.dataBucket.head(source))?.httpEtag).toBe('"etag-source"');
    expect(value.putKeys).not.toContain(target);
    expect(await opsDb.prepare("SELECT COUNT(*) count FROM r2_event_suppressions").first()).toEqual({ count: 0 });
  });

  it.each(["copy", "move"] as const)("auto-renames a raced %s destination without overwriting either winner", async kind => {
    const candidate2 = "Jobs/Clients/Other/New/photo (2).jpg";
    const candidate3 = "Jobs/Clients/Other/New/photo (3).jpg";
    await seedJob(kind, "rename");
    const value = environment(undefined, [
      object(source, "etag-source"),
      object(target, "etag-existing"),
    ]);
    const originalHead = value.dataBucket.head.bind(value.dataBucket);
    let candidateHeads = 0;
    value.dataBucket.head = async (key: string) => {
      if (key === candidate2 && ++candidateHeads === 2) value.stored.set(candidate2, object(candidate2, "etag-race-winner"));
      return originalHead(key);
    };

    await processR2OperationJobs(value.env);

    expect(await opsDb.prepare("SELECT status FROM r2_operation_jobs WHERE id='job-1'").first("status")).toBe("completed");
    expect((await value.dataBucket.head(target))?.httpEtag).toBe('"etag-existing"');
    expect((await value.dataBucket.head(candidate2))?.httpEtag).toBe('"etag-race-winner"');
    expect(await value.dataBucket.head(candidate3)).not.toBeNull();
    expect(value.putKeys).toContain(candidate3);
    expect(isMovedSourceMarker((await value.dataBucket.head(source))!)).toBe(kind === "move");
    expect(await opsDb.prepare("SELECT COUNT(*) count FROM r2_event_suppressions").first()).toEqual({ count: 0 });
  });

  it.each(["copy", "move"] as const)("preserves video/mp4 metadata and queues TrueNAS thumbnail work after %s", async kind => {
    const videoSource = "Jobs/Clients/Acme/Old/flight.mp4";
    const videoTarget = "Jobs/Clients/Other/New/flight.mp4";
    await seedJob(kind, "fail", videoSource, videoTarget, "video/mp4", "video");
    const value = environment(undefined, [object(videoSource, "etag-source", "video/mp4")]);

    await processR2OperationJobs(value.env);

    expect(await opsDb.prepare("SELECT status FROM r2_operation_jobs WHERE id='job-1'").first("status")).toBe("completed");
    expect((await value.dataBucket.head(videoTarget))?.httpMetadata.contentType).toBe("video/mp4");
    expect(await deliveryDb.prepare("SELECT content_type,media_kind FROM file_index WHERE r2_key=?")
      .bind(videoTarget).first()).toEqual({ content_type: "video/mp4", media_kind: "video" });
    expect(vi.mocked(enqueueThumbnailJob)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueThumbnailJob).mock.calls[0]?.[1]).toMatchObject({
      sourceKey: videoTarget,
      sourceEtag: '"etag-target"',
      sourceSize: 4,
    });
    if (kind === "move") expect(isMovedSourceMarker((await value.dataBucket.head(videoSource))!)).toBe(true);
    else expect((await value.dataBucket.head(videoSource))?.httpEtag).toBe('"etag-source"');
  });
});
