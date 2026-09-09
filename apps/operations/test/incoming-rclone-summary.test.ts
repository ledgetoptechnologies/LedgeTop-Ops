import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { summarizeIncomingRclonePromotions } from "../src/worker/incoming-rclone-summary";

describe("incoming rclone promotion summary", () => {
  it("does not query when disabled", async () => {
    let queried = false;
    const env = { INCOMING_RCLONE_PROMOTION_ENABLED: "false", DELIVERY_DB: { withSession() { queried = true; throw new Error("must not query"); } } };
    await expect(summarizeIncomingRclonePromotions(env as never, ["upload-one"])).resolves.toEqual(new Map());
    expect(queried).toBe(false);
  });
  it("uses one bounded authorized-ID query and maps only safe states", async () => {
    let binds: unknown[] = []; let sql = "";
    const env = { INCOMING_RCLONE_PROMOTION_ENABLED: "true", DELIVERY_DB: { withSession() { return { prepare(value: string) { sql = value; return { bind(...values: unknown[]) { binds = values; return { all: async () => ({ results: [{ uploadId: "upload-one", state: "ready" }, { uploadId: "upload-two", state: "failed" }, { uploadId: "upload-three", state: null }] }) }; } }; } }; } } };
    const result = await summarizeIncomingRclonePromotions(env as never, ["upload-one", "upload-one", "upload-two", "upload-three", "bad/path"]);
    expect([...result]).toEqual([["upload-one", "ready"], ["upload-two", "failed"]]);
    expect(binds).toEqual(["upload-one", "upload-two", "upload-three"]);
    expect(sql).toContain("needs_attention"); expect(sql).not.toContain("destination_key");
  });
  it("caps the query at fifty IDs", async () => {
    let count = 0; const ids = Array.from({ length: 60 }, (_, i) => `upload-${String(i).padStart(3, "0")}`);
    const env = { INCOMING_RCLONE_PROMOTION_ENABLED: "true", DELIVERY_DB: { withSession() { return { prepare() { return { bind(...values: unknown[]) { count = values.length; return { all: async () => ({ results: [] }) }; } }; } }; } } };
    await summarizeIncomingRclonePromotions(env as never, ids); expect(count).toBe(50);
  });
  it("uses durable journal/outbox precedence and only returns authorized IDs", async () => {
    const runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DB: "summary-real" } });
    try {
      const db = await runtime.getD1Database("DB") as unknown as D1Database;
      for (const name of ["0090_aliases_incoming_requests.sql", "0093_reusable_incoming_uploads.sql", "0116_incoming_upload_hardening.sql", "0199_incoming_upload_pickup_lifecycle.sql", "0211_incoming_upload_verification_lifecycle.sql", "0213_incoming_rclone_promotion.sql"]) {
        const sql = readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8").replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, ""); await db.exec(sql.replace(/\s*\n\s*/g, " "));
      }
      await db.batch([
        db.prepare("INSERT INTO file_requests(id,public_id,title,created_by,expires_at,max_files,max_bytes,session_version) VALUES('r','p','t','s',datetime('now','+1 day'),9,999,1)"),
        db.prepare("INSERT INTO file_request_contributors(id,request_id,name,email,client_address_hash) VALUES('c','r','c','c@x','h')"),
        ...["upload-publishing","upload-attention","upload-ready","upload-outbox"].map(id => db.prepare("INSERT INTO file_request_uploads(id,request_id,contributor_id,object_key,upload_id,original_name,declared_size,content_type,status) VALUES(?,'r','c',?,'m','x',1,'application/pdf','quarantined')").bind(id,`quarantine/r/${id}/object`)),
        db.prepare("INSERT INTO file_request_upload_promotion_journal(upload_id,source_identity,source_key,destination_key,state) VALUES('upload-publishing','{}','a','b','publishing')"),
        db.prepare("INSERT INTO file_request_upload_promotion_journal(upload_id,source_identity,source_key,destination_key,state) VALUES('upload-ready','{}','c','d','ready')"),
        ...["upload-publishing","upload-attention","upload-ready","upload-outbox"].map(id => db.prepare("INSERT INTO file_request_upload_promotion_outbox(upload_id,segment,state) VALUES(?,0,'needs_attention')").bind(id)),
      ]);
      const result = await summarizeIncomingRclonePromotions({ INCOMING_RCLONE_PROMOTION_ENABLED: "true", DELIVERY_DB: db } as never, ["upload-publishing", "upload-attention", "upload-ready"]);
      expect(Object.fromEntries(result)).toEqual({ "upload-publishing": "publishing", "upload-attention": "failed", "upload-ready": "ready" });
      expect(result.has("upload-outbox")).toBe(false);
    } finally { await runtime.dispose(); }
  });
});
