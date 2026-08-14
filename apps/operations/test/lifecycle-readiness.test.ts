import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { reconcileFileIndex } from "../src/worker/file-events";
import { restoreTombstone } from "../src/worker/trash";
import type { Env, StaffPrincipal } from "../src/worker/types";

interface StoredObject {
  key: string;
  etag: string;
  httpEtag: string;
  size: number;
  uploaded: Date;
  httpMetadata: { contentType?: string };
  customMetadata: Record<string, string>;
}

describe("production lifecycle readiness", () => {
  let miniflare: Miniflare;
  let deliveryDb: D1Database;
  let opsDb: D1Database;
  let objects: Map<string, StoredObject>;
  let deleteObject: ReturnType<typeof vi.fn>;
  let headObject: ReturnType<typeof vi.fn>;
  let env: Env;
  const principal = { id: "staff-owner", email: "owner@example.test", displayName: "Owner" } as StaffPrincipal;

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-08-06",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DELIVERY_DB: "lifecycle-delivery", OPS_DB: "lifecycle-ops" },
    });
    deliveryDb = await miniflare.getD1Database("DELIVERY_DB") as unknown as D1Database;
    opsDb = await miniflare.getD1Database("OPS_DB") as unknown as D1Database;
    for (const sql of [
      "CREATE TABLE projects(id TEXT PRIMARY KEY,r2_prefix TEXT NOT NULL,active INTEGER NOT NULL)",
      "CREATE TABLE shares(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,r2_prefix TEXT,unavailable_since TEXT,revoked_at TEXT,expires_at TEXT,share_version INTEGER NOT NULL DEFAULT 1)",
      "CREATE TABLE file_index(r2_key TEXT PRIMARY KEY,etag TEXT NOT NULL,size INTEGER NOT NULL,uploaded_at TEXT NOT NULL,content_type TEXT,media_kind TEXT NOT NULL,last_seen_reconcile TEXT,indexed_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')))",
      "CREATE TABLE delivery_sync_health(source TEXT PRIMARY KEY,last_attempt_at TEXT,last_success_at TEXT,status TEXT,object_count INTEGER,details_json TEXT,updated_at TEXT DEFAULT (datetime('now')))",
      "CREATE TABLE preview_artifacts(artifact_prefix TEXT PRIMARY KEY,source_key TEXT NOT NULL,source_etag TEXT,manifest_etag TEXT NOT NULL,missing_since TEXT,last_seen_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')))",
      "CREATE TABLE delivery_tombstones(id TEXT PRIMARY KEY,physical_key TEXT NOT NULL,tombstone_kind TEXT NOT NULL,deleted_by TEXT NOT NULL,deleted_at TEXT NOT NULL,purge_after TEXT NOT NULL,purging_at TEXT,restored_by TEXT,restored_at TEXT)",
    ]) await deliveryDb.exec(sql);
    for (const sql of [
      "CREATE TABLE delivery_reconciliation_state(source TEXT PRIMARY KEY,last_success_at TEXT,last_visible_count INTEGER NOT NULL DEFAULT 0,last_visible_bytes INTEGER NOT NULL DEFAULT 0,updated_at TEXT DEFAULT (datetime('now')))",
      "CREATE TABLE delivery_reconciliation_alerts(id INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT NOT NULL,alert_type TEXT NOT NULL,details_json TEXT,created_at TEXT DEFAULT (datetime('now')),acknowledged_at TEXT)",
      "CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_type TEXT,actor_id TEXT,actor_email TEXT,actor_display_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,details_json TEXT)",
    ]) await opsDb.exec(sql);
  });

  afterAll(async () => miniflare.dispose());
  afterEach(() => vi.useRealTimers());

  beforeEach(async () => {
    await deliveryDb.exec("DELETE FROM shares; DELETE FROM projects; DELETE FROM file_index; DELETE FROM delivery_sync_health; DELETE FROM preview_artifacts; DELETE FROM delivery_tombstones;");
    await opsDb.exec("DELETE FROM delivery_reconciliation_state; DELETE FROM delivery_reconciliation_alerts; DELETE FROM audit_events;");
    objects = new Map();
    deleteObject = vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    });
    headObject = vi.fn(async (key: string) => objects.get(key) || null);
    env = {
      DELIVERY_DB: deliveryDb,
      OPS_DB: opsDb,
      DATA_BUCKET: {
        head: headObject,
        async list(options: { prefix?: string }) {
          return { objects: [...objects.values()].filter(object => object.key.startsWith(options.prefix || "")), truncated: false };
        },
        delete: deleteObject,
      } as never,
    } as unknown as Env;
  });

  it("rejects expired, malformed, and already-purging tombstones without restore side effects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
    await deliveryDb.batch([
      deliveryDb.prepare("INSERT INTO delivery_tombstones VALUES(?,?,?,?,?,?,?,?,?)")
        .bind("expired", "Jobs/client/expired.txt", "exact", "staff", "2026-08-01", "2026-08-13T11:59:59.999Z", null, null, null),
      deliveryDb.prepare("INSERT INTO delivery_tombstones VALUES(?,?,?,?,?,?,?,?,?)")
        .bind("deadline", "Jobs/client/deadline.txt", "exact", "staff", "2026-08-01", "2026-08-13T12:00:00.000Z", null, null, null),
      deliveryDb.prepare("INSERT INTO delivery_tombstones VALUES(?,?,?,?,?,?,?,?,?)")
        .bind("invalid", "Jobs/client/invalid.txt", "exact", "staff", "2026-08-01", "not-a-date", null, null, null),
      deliveryDb.prepare("INSERT INTO delivery_tombstones VALUES(?,?,?,?,?,?,?,?,?)")
        .bind("purging", "Jobs/client/purging.txt", "exact", "staff", "2026-08-01", "2026-08-20T12:00:00.000Z", "2026-08-13T11:00:00Z", null, null),
    ]);

    for (const id of ["expired", "deadline", "invalid", "purging"]) {
      await expect(restoreTombstone(env, principal, id)).rejects.toMatchObject({ status: 409 });
    }

    const restored = await deliveryDb.prepare("SELECT COUNT(*) count FROM delivery_tombstones WHERE restored_at IS NOT NULL").first<number>("count");
    const audits = await opsDb.prepare("SELECT COUNT(*) count FROM audit_events").first<number>("count");
    expect(restored).toBe(0);
    expect(audits).toBe(0);
    expect(headObject).not.toHaveBeenCalled();
  });

  it("restores before expiry exactly once and treats a retry as an idempotent success", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
    await deliveryDb.prepare("INSERT INTO delivery_tombstones VALUES(?,?,?,?,?,?,?,?,?)")
      .bind("restorable", "Jobs/client/restorable.txt", "exact", "staff", "2026-08-01", "2026-08-20T12:00:00.000Z", null, null, null).run();

    await expect(restoreTombstone(env, principal, "restorable")).resolves.toBeUndefined();
    await expect(restoreTombstone(env, principal, "restorable")).resolves.toBeUndefined();

    const row = await deliveryDb.prepare("SELECT restored_by,restored_at FROM delivery_tombstones WHERE id='restorable'")
      .first<{ restored_by: string; restored_at: string }>();
    expect(row).toEqual({ restored_by: principal.id, restored_at: "2026-08-13T12:00:00.000Z" });
    expect(await opsDb.prepare("SELECT COUNT(*) count FROM audit_events WHERE action='delivery.source_restored'").first<number>("count")).toBe(1);
    expect(headObject).toHaveBeenCalledTimes(1);
  });

  it("keeps missing shares, source index rows, preview relationships, and R2 derivatives on operator-review holds", async () => {
    await deliveryDb.batch([
      deliveryDb.prepare("INSERT INTO projects(id,r2_prefix,active) VALUES('project','Jobs/client/',1)"),
      deliveryDb.prepare("INSERT INTO shares(id,project_id,r2_prefix) VALUES('share','project','Jobs/client/')"),
      deliveryDb.prepare(`INSERT INTO file_index(r2_key,etag,size,uploaded_at,media_kind,last_seen_reconcile)
        VALUES('Jobs/client/source.txt','old',12,'2026-08-01','other','old-scan')`),
      deliveryDb.prepare(`INSERT INTO preview_artifacts(artifact_prefix,source_key,manifest_etag,updated_at)
        VALUES('Jobs/client/.previews/hash/','Jobs/client/source.txt','manifest','2026-08-01 00:00:00')`),
    ]);

    await expect(reconcileFileIndex(env)).resolves.toBe(0);
    const initiallyMissingShare = await deliveryDb.prepare("SELECT unavailable_since FROM shares WHERE id='share'").first<{ unavailable_since: string | null }>();
    const initiallyMissingPreview = await deliveryDb.prepare("SELECT missing_since FROM preview_artifacts WHERE artifact_prefix='Jobs/client/.previews/hash/'").first<{ missing_since: string | null }>();
    expect(initiallyMissingShare?.unavailable_since).toEqual(expect.any(String));
    expect(initiallyMissingPreview?.missing_since).toEqual(expect.any(String));
    expect(await opsDb.prepare("SELECT COUNT(*) count FROM delivery_reconciliation_alerts").first<number>("count")).toBe(0);
    await deliveryDb.batch([
      deliveryDb.prepare("UPDATE shares SET unavailable_since='2026-08-01 00:00:00' WHERE id='share'"),
      deliveryDb.prepare("UPDATE preview_artifacts SET missing_since='2026-08-01 00:00:00',updated_at='2026-08-01 00:00:00' WHERE artifact_prefix='Jobs/client/.previews/hash/'"),
    ]);
    await expect(reconcileFileIndex(env)).resolves.toBe(0);
    await expect(reconcileFileIndex(env)).resolves.toBe(0);

    const share = await deliveryDb.prepare("SELECT revoked_at,share_version,unavailable_since FROM shares WHERE id='share'")
      .first<{ revoked_at: string | null; share_version: number; unavailable_since: string }>();
    expect(share).toEqual({ revoked_at: null, share_version: 1, unavailable_since: "2026-08-01 00:00:00" });
    expect(await deliveryDb.prepare("SELECT COUNT(*) count FROM file_index WHERE r2_key='Jobs/client/source.txt'").first<number>("count")).toBe(1);
    expect(await deliveryDb.prepare("SELECT COUNT(*) count FROM preview_artifacts WHERE artifact_prefix='Jobs/client/.previews/hash/'").first<number>("count")).toBe(1);
    expect(deleteObject).not.toHaveBeenCalled();

    const alerts = await opsDb.prepare("SELECT alert_type,details_json FROM delivery_reconciliation_alerts ORDER BY alert_type")
      .all<{ alert_type: string; details_json: string }>();
    expect(alerts.results.map(row => row.alert_type)).toEqual(["preview_source_missing", "share_source_missing"]);
    expect(alerts.results.every(row => JSON.parse(row.details_json).action === "operator_review_required")).toBe(true);

    const source: StoredObject = {
      key: "Jobs/client/source.txt", etag: "current", httpEtag: '"current"', size: 12,
      uploaded: new Date("2026-08-13T12:00:00Z"), httpMetadata: { contentType: "text/plain" }, customMetadata: {},
    };
    objects.set(source.key, source);
    await expect(reconcileFileIndex(env)).resolves.toBe(1);

    expect((await deliveryDb.prepare("SELECT unavailable_since FROM shares WHERE id='share'").first<{ unavailable_since: string | null }>())?.unavailable_since).toBeNull();
    expect((await deliveryDb.prepare("SELECT missing_since FROM preview_artifacts WHERE artifact_prefix='Jobs/client/.previews/hash/'").first<{ missing_since: string | null }>())?.missing_since).toBeNull();
    expect(await opsDb.prepare("SELECT COUNT(*) count FROM delivery_reconciliation_alerts WHERE acknowledged_at IS NULL").first<number>("count")).toBe(0);
    expect(deleteObject).not.toHaveBeenCalled();
  });
});
