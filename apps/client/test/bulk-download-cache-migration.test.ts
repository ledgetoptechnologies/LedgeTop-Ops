import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import migration from "../migrations/0196_bulk_download_archive_cache.sql?raw";

describe("bulk-download archive-cache migration", () => {
  it("is additive and keeps checksums for concurrent immutable versions of one key", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE shares(id TEXT PRIMARY KEY);
      CREATE TABLE bulk_download_jobs(
        id TEXT PRIMARY KEY, share_id TEXT NOT NULL, share_version INTEGER NOT NULL,
        status TEXT NOT NULL, expires_at TEXT NOT NULL, archive_key TEXT
      );`);
    db.exec(migration);
    const jobColumns = db.prepare("PRAGMA table_info(bulk_download_jobs)").all() as Array<{ name: string }>;
    expect(jobColumns.map(column => column.name)).toContain("archive_fingerprint");
    expect(db.prepare("PRAGMA index_info(idx_bulk_download_jobs_archive_key_live)").all()
      .map(column => (column as { name: string }).name)).toEqual(["archive_key", "status", "expires_at"]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bulk_download_cleanup_cursors'").get())
      .toEqual({ name: "bulk_download_cleanup_cursors" });

    const checksum = db.prepare("INSERT INTO bulk_download_object_checksums(r2_key,etag,size,crc32) VALUES(?,?,?,?)");
    checksum.run("Jobs/file.tif", "old", 10, 1);
    checksum.run("Jobs/file.tif", "new", 12, 2);
    expect(db.prepare("SELECT etag,size,crc32 FROM bulk_download_object_checksums ORDER BY etag").all()).toEqual([
      { etag: "new", size: 12, crc32: 2 },
      { etag: "old", size: 10, crc32: 1 },
    ]);
    expect(() => checksum.run("Jobs/file.tif", "bad", 12, -1)).toThrow();

    db.prepare("INSERT INTO shares(id) VALUES(?)").run("share");
    const insertCache = db.prepare(`INSERT INTO bulk_download_archive_cache
      (share_id,share_version,selection_fingerprint,archive_key,archive_etag,archive_size,file_count,total_bytes,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?)`);
    insertCache.run("share", 4, "a".repeat(64), "cache/a.zip", "etag", 100, 2, 42, "2026-10-01T00:00:00Z");
    expect(() => insertCache.run("share", 4, "a".repeat(64), "cache/b.zip", "etag", 100, 2, 42, "2026-10-01T00:00:00Z")).toThrow();
    const insertGeneration = db.prepare(`INSERT INTO bulk_download_archive_generations
      (archive_key,archive_etag,archive_size,state) VALUES(?,?,?,?)`);
    insertGeneration.run("cache/a.zip", "etag", 100, "active");
    expect(() => insertGeneration.run("cache/b.zip", "etag", 100, "unknown")).toThrow();
    expect(() => insertGeneration.run("cache/c.zip", "etag", 0, "active")).toThrow();
    db.prepare("UPDATE bulk_download_archive_generations SET state='deleting',deletion_started_at=datetime('now') WHERE archive_key=?")
      .run("cache/a.zip");
    expect(db.prepare("SELECT state FROM bulk_download_archive_generations WHERE archive_key=?").get("cache/a.zip"))
      .toEqual({ state: "deleting" });
    db.close();
  });
});
