import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("incoming upload hardening migration", () => {
  let miniflare: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-08-06",
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DB: "incoming-hardening" },
    });
    db = await miniflare.getD1Database("DB") as unknown as D1Database;
    await db.batch([
      db.prepare("CREATE TABLE file_requests (id TEXT PRIMARY KEY,reserved_files INTEGER NOT NULL DEFAULT 0,reserved_bytes INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL DEFAULT (datetime('now')))"),
      db.prepare("CREATE TABLE file_request_uploads (id TEXT PRIMARY KEY,request_id TEXT NOT NULL,declared_size INTEGER NOT NULL,quota_released_at TEXT,updated_at TEXT NOT NULL DEFAULT (datetime('now')),FOREIGN KEY(request_id) REFERENCES file_requests(id))"),
    ]);
    const migration = readFileSync(new URL("../../client/migrations/0116_incoming_upload_hardening.sql", import.meta.url), "utf8")
      .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "")
      .replace(/^\s*--.*$/gm, "");
    await db.exec(migration.replace(/\s*\n\s*/g, " "));
  });

  afterAll(async () => miniflare.dispose());

  it("decrements reserved quota once for new Workers", async () => {
    await db.batch([
      db.prepare("INSERT INTO file_requests(id,reserved_files,reserved_bytes) VALUES('request-new',1,25)"),
      db.prepare("INSERT INTO file_request_uploads(id,request_id,declared_size) VALUES('upload-new','request-new',25)"),
    ]);
    await db.prepare("UPDATE file_request_uploads SET quota_released_at=datetime('now'),quota_release_managed=1 WHERE id='upload-new' AND quota_released_at IS NULL").run();
    await db.prepare("UPDATE file_request_uploads SET quota_released_at=datetime('now'),quota_release_managed=1 WHERE id='upload-new' AND quota_released_at IS NULL").run();
    expect(await db.prepare("SELECT reserved_files,reserved_bytes FROM file_requests WHERE id='request-new'").first()).toEqual({ reserved_files: 0, reserved_bytes: 0 });
  });

  it("does not double-decrement during a rolling deploy with an older Worker", async () => {
    await db.batch([
      db.prepare("INSERT INTO file_requests(id,reserved_files,reserved_bytes) VALUES('request-old',1,25)"),
      db.prepare("INSERT INTO file_request_uploads(id,request_id,declared_size) VALUES('upload-old','request-old',25)"),
    ]);
    await db.prepare("UPDATE file_request_uploads SET quota_released_at=datetime('now') WHERE id='upload-old'").run();
    expect(await db.prepare("SELECT reserved_files,reserved_bytes FROM file_requests WHERE id='request-old'").first()).toEqual({ reserved_files: 1, reserved_bytes: 25 });
    await db.prepare("UPDATE file_requests SET reserved_files=reserved_files-1,reserved_bytes=reserved_bytes-25 WHERE id='request-old'").run();
    expect(await db.prepare("SELECT reserved_files,reserved_bytes FROM file_requests WHERE id='request-old'").first()).toEqual({ reserved_files: 0, reserved_bytes: 0 });
  });

  it("accepts only a 64-character resume fingerprint", async () => {
    await db.prepare("INSERT INTO file_requests(id) VALUES('request-fingerprint')").run();
    await expect(db.prepare("INSERT INTO file_request_uploads(id,request_id,declared_size,resume_fingerprint) VALUES('bad','request-fingerprint',1,'short')").run()).rejects.toThrow();
    await db.prepare("INSERT INTO file_request_uploads(id,request_id,declared_size,resume_fingerprint) VALUES('good','request-fingerprint',1,?)").bind("a".repeat(64)).run();
  });
});
