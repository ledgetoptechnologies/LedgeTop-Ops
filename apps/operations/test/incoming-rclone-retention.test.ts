import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanupIncomingRclonePromotionRetention, runIncomingRcloneRetention } from "../src/worker/incoming-rclone-retention";

let runtime: Miniflare; let db: D1Database;
const uploadId = "upload-one", readyKey = "ready/request-one/upload-one/report.pdf";
async function fixture(status = "expired", state = "copying", multipartUploadId: string | null = "multipart-one") {
  await db.batch([
    db.prepare("INSERT INTO file_requests(id,public_id,title,created_by,expires_at,max_files,max_bytes,session_version) VALUES('request-one','public-one','Receive','staff',datetime('now','+1 day'),500,999999,1)"),
    db.prepare("INSERT INTO file_request_contributors(id,request_id,name,email,client_address_hash) VALUES('contributor-one','request-one','Contributor','c@example.test','hash')"),
    db.prepare("INSERT INTO file_request_uploads(id,request_id,contributor_id,object_key,upload_id,original_name,declared_size,content_type,status) VALUES(?,?,?,?,?,'report.pdf',10,'application/pdf',?)")
      .bind(uploadId, "request-one", "contributor-one", "quarantine/request-one/upload-one/object", "source-multipart", status),
    db.prepare("INSERT INTO file_request_upload_promotion_journal(upload_id,source_identity,source_key,destination_key,multipart_upload_id,state,destination_etag,destination_bytes,destination_version) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(uploadId, JSON.stringify({ version: 1, etag: "abcdef", bytes: 10, objectVersion: "source-v1" }), "quarantine/request-one/upload-one/object", readyKey, multipartUploadId, state, state === "ready" ? "dest-etag" : null, state === "ready" ? 10 : null, state === "ready" ? "dest-v1" : null),
  ]);
}
function bucket(object: R2Object | null = null, abortFails = false) {
  const calls: string[] = [];
  return { calls, async head() { return object; }, resumeMultipartUpload(key: string, id: string) { return { key, uploadId: id, async abort() { calls.push(`${key}:${id}`); if (abortFails) throw new Error("abort failed"); } }; } };
}
describe("incoming rclone retention", () => {
  beforeAll(async () => { runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true, script: "export default { fetch(){return new Response('ok')} }", d1Databases: { DB: "rclone-retention" } }); db = await runtime.getD1Database("DB") as unknown as D1Database;
    for (const name of ["0090_aliases_incoming_requests.sql", "0093_reusable_incoming_uploads.sql", "0116_incoming_upload_hardening.sql", "0199_incoming_upload_pickup_lifecycle.sql", "0211_incoming_upload_verification_lifecycle.sql", "0213_incoming_rclone_promotion.sql"]) { const sql = readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8").replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, ""); await db.exec(sql.replace(/\s*\n\s*/g, " ")); }
  });
  beforeEach(async () => db.exec("DELETE FROM file_request_upload_promotion_journal; DELETE FROM file_request_uploads; DELETE FROM file_request_contributors; DELETE FROM file_requests;")); afterAll(async () => runtime.dispose());
  it("requires the lifecycle expiry fence before touching promotion state", async () => { await fixture("quarantined"); const r2 = bucket(); expect(await cleanupIncomingRclonePromotionRetention({ DELIVERY_DB: db, INCOMING_BUCKET: r2 } as never, uploadId)).toEqual({ kind: "not_expired" }); expect(r2.calls).toEqual([]); });
  it("fences and aborts only the persisted in-progress multipart upload", async () => { await fixture(); const r2 = bucket(); expect(await cleanupIncomingRclonePromotionRetention({ DELIVERY_DB: db, INCOMING_BUCKET: r2 } as never, uploadId)).toEqual({ kind: "multipart_aborted" }); expect(r2.calls).toEqual([`${readyKey}:multipart-one`]); expect(await db.prepare("SELECT state,error_code FROM file_request_upload_promotion_journal WHERE upload_id=?").bind(uploadId).first()).toEqual({ state: "unavailable", error_code: "retention_expired" }); });
  it("retains a matching ready object for bucket lifecycle without deleting it", async () => { await fixture("expired", "ready", null); const r2 = bucket({ key: readyKey, size: 10, etag: "dest-etag", version: "dest-v1" } as R2Object); expect(await cleanupIncomingRclonePromotionRetention({ DELIVERY_DB: db, INCOMING_BUCKET: r2 } as never, uploadId)).toEqual({ kind: "ready_retained" }); });
  it("treats MOVE absence as no-op and replaced ready as review, never accepted", async () => { await fixture("expired", "ready", null); const absent = bucket(); expect(await cleanupIncomingRclonePromotionRetention({ DELIVERY_DB: db, INCOMING_BUCKET: absent } as never, uploadId)).toEqual({ kind: "ready_missing" }); const changed = bucket({ key: readyKey, size: 10, etag: "other", version: "dest-v1" } as R2Object); expect(await cleanupIncomingRclonePromotionRetention({ DELIVERY_DB: db, INCOMING_BUCKET: changed } as never, uploadId)).toEqual({ kind: "needs_review", reason: "destination_changed" }); });
  it("expires aged work once, releases quota once, and leaves ready bytes to lifecycle", async () => { await fixture("quarantined", "ready", null); await db.prepare("UPDATE file_request_uploads SET created_at=datetime('now','-15 days') WHERE id=?").bind(uploadId).run(); await db.prepare("UPDATE file_requests SET reserved_files=1,reserved_bytes=10 WHERE id='request-one'").run(); const r2 = bucket({ key: readyKey, size: 10, etag: "dest-etag", version: "dest-v1" } as R2Object); const env={ INCOMING_RCLONE_PROMOTION_ENABLED:"true", DELIVERY_DB:db, INCOMING_BUCKET:r2 }; expect(await runIncomingRcloneRetention(env as never)).toMatchObject({processed:1,completed:1}); expect(await runIncomingRcloneRetention(env as never)).toMatchObject({processed:0}); expect(await db.prepare("SELECT status,quota_released_at FROM file_request_uploads WHERE id=?").bind(uploadId).first()).toMatchObject({status:"expired"}); expect(await db.prepare("SELECT reserved_files,reserved_bytes FROM file_requests WHERE id='request-one'").first()).toEqual({reserved_files:0,reserved_bytes:0}); });
});
