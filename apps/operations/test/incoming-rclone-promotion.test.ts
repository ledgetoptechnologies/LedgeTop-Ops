import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { beginIncomingRclonePromotion, readIncomingRclonePromotionStatus, resumeIncomingRclonePromotionStep } from "../src/worker/incoming-rclone-promotion";

type ObjectIdentity = { key: string; size: number; etag: string; version: string };
let runtime: Miniflare;
let db: D1Database;
const source: ObjectIdentity = { key: "quarantine/request-one/upload-one/object", size: 10, etag: "abcdef", version: "source-version" };

function object(identity: ObjectIdentity, range?: { offset: number; length: number }) {
  return { ...identity, range, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(range?.length ?? identity.size)); controller.close(); } }) };
}
function fakeBucket() {
  let sourcePresent = true;
  let completeCalls = 0;
  let createCalls = 0;
  const uploaded: Array<{ partNumber: number; size: number }> = [];
  const bucket = {
    async head(key: string) { return key === source.key && sourcePresent ? object(source) : null; },
    async get(key: string, options: { range: { offset: number; length: number } }) {
      if (key !== source.key || !sourcePresent) return null;
      return object(source, options.range);
    },
    async createMultipartUpload(key: string) { createCalls += 1; return { key, uploadId: "multipart-one" }; },
    resumeMultipartUpload(key: string, uploadId: string) {
      return { key, uploadId,
        async uploadPart(partNumber: number, body: ReadableStream<Uint8Array>) {
          const reader = body.getReader(); let size = 0;
          for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; }
          uploaded.push({ partNumber, size }); return { partNumber, etag: `part-${partNumber}` };
        },
        async complete() { completeCalls += 1; return object({ key, size: source.size, etag: "dest-etag", version: "dest-version" }); },
      };
    },
    get completeCalls() { return completeCalls; }, get createCalls() { return createCalls; }, get uploaded() { return uploaded; }, removeSource() { sourcePresent = false; },
  };
  return bucket;
}

async function insertUpload(identity = source) {
  await db.batch([
    db.prepare("INSERT INTO file_requests(id,public_id,title,created_by,expires_at,max_files,max_bytes,session_version) VALUES('request-one','public-one','Receive','staff',datetime('now','+1 day'),500,999999,1)"),
    db.prepare("INSERT INTO file_request_contributors(id,request_id,name,email,client_address_hash) VALUES('contributor-one','request-one','Contributor','c@example.test','hash')"),
    db.prepare(`INSERT INTO file_request_uploads(id,request_id,contributor_id,object_key,upload_id,original_name,declared_size,actual_size,content_type,status,etag,pickup_state,verification_state,created_at)
      VALUES('upload-one','request-one','contributor-one',?,'r2-multipart','report.pdf',?,?,'application/pdf','quarantined',?,'awaiting_pickup','awaiting_verification',datetime('now'))`).bind(identity.key, identity.size, identity.size, identity.etag),
  ]);
}

describe("incoming rclone promotion journal", () => {
  beforeAll(async () => {
    // Module functions execute in Node for unit tests; production executes in
    // workerd, where FixedLengthStream is native. The isolate test below
    // validates that native known-length path against Miniflare R2.
    vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array, Uint8Array> { constructor(_length: number) { super(); } });
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true, script: "export default { fetch(){ return new Response('ok'); } }", d1Databases: { DB: "incoming-promotion" }, r2Buckets: { INCOMING: "incoming-promotion" } });
    db = await runtime.getD1Database("DB") as unknown as D1Database;
    for (const name of ["0090_aliases_incoming_requests.sql", "0093_reusable_incoming_uploads.sql", "0116_incoming_upload_hardening.sql", "0199_incoming_upload_pickup_lifecycle.sql", "0211_incoming_upload_verification_lifecycle.sql", "0213_incoming_rclone_promotion.sql"]) {
      const sql = readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8").replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "");
      await db.exec(sql.replace(/\s*\n\s*/g, " "));
    }
  });
  beforeEach(async () => { await db.exec("DELETE FROM file_request_upload_promotion_journal; DELETE FROM file_request_upload_basic_checks; DELETE FROM file_request_uploads; DELETE FROM file_request_contributors; DELETE FROM file_requests;"); await insertUpload(); });
  afterAll(async () => { vi.unstubAllGlobals(); await runtime.dispose(); });

  it("streams exactly one bounded range per step and does not infer local delivery", async () => {
    const bucket = fakeBucket(); const env = { DELIVERY_DB: db, INCOMING_BUCKET: bucket };
    const persisted = await db.prepare("SELECT substr(created_at,1,10) createdDate FROM file_request_uploads WHERE id='upload-one'").first<{ createdDate: string }>();
    expect(persisted?.createdDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const begun = await beginIncomingRclonePromotion(env as never, "upload-one");
    expect(begun.state).toBe("pending");
    expect(begun.destinationKey).toMatch(new RegExp(`^ready/Contributor/${persisted!.createdDate}--[a-f0-9]{20}/report\\.pdf$`));
    expect((await resumeIncomingRclonePromotionStep(env as never, "upload-one")).state).toBe("copying");
    expect((await resumeIncomingRclonePromotionStep(env as never, "upload-one")).completedParts).toBe(1);
    const final = await resumeIncomingRclonePromotionStep(env as never, "upload-one");
    expect(final.state).toBe("ready"); expect(bucket.uploaded).toEqual([{ partNumber: 1, size: 10 }]); expect(bucket.completeCalls).toBe(1);
    // rclone MOVE can immediately remove ready/; publication remains final and
    // a status read makes no assertion about a local copy.
    expect((await resumeIncomingRclonePromotionStep(env as never, "upload-one")).state).toBe("ready");
    expect(bucket.completeCalls).toBe(1);
  });

  it("preserves every preexisting journal destination despite contributor changes", async () => {
    const bucket = fakeBucket(); const env = { DELIVERY_DB: db, INCOMING_BUCKET: bucket };
    await db.prepare("INSERT INTO file_request_upload_basic_checks(upload_id,object_etag,object_bytes,object_version,check_version) VALUES('upload-one',?,?,?,'basic-v1')")
      .bind(source.etag, source.size, source.version).run();
    await db.prepare("UPDATE file_request_contributors SET name='Renamed contributor' WHERE id='contributor-one'").run();
    const oldKey = "ready/request-one/upload-one/report.pdf";
    const sourceIdentity = JSON.stringify({ version: 1, etag: source.etag, bytes: source.size, objectVersion: source.version });
    for (const state of ["pending", "copying", "publishing", "ready"] as const) {
      await db.prepare("DELETE FROM file_request_upload_promotion_journal WHERE upload_id='upload-one'").run();
      await db.prepare(`INSERT INTO file_request_upload_promotion_journal(upload_id,source_identity,source_key,destination_key,state,multipart_upload_id,publication_started_at,published_at)
        VALUES('upload-one',?,?,?, ?, CASE WHEN ?='copying' THEN 'legacy-multipart' END,
          CASE WHEN ?='publishing' THEN datetime('now') END, CASE WHEN ?='ready' THEN datetime('now') END)`)
        .bind(sourceIdentity, source.key, oldKey, state, state, state, state).run();
      expect((await beginIncomingRclonePromotion(env as never, "upload-one")).destinationKey).toBe(oldKey);
      expect((await resumeIncomingRclonePromotionStep(env as never, "upload-one")).destinationKey).toBe(oldKey);
      expect((await readIncomingRclonePromotionStatus(env as never, "upload-one"))?.destinationKey).toBe(oldKey);
    }
  });

  it("fails closed on the journal destination uniqueness constraint before R2 publication", async () => {
    const bucket = fakeBucket(); const env = { DELIVERY_DB: db, INCOMING_BUCKET: bucket };
    const planned = await beginIncomingRclonePromotion(env as never, "upload-one");
    await db.prepare("DELETE FROM file_request_upload_promotion_journal WHERE upload_id='upload-one'").run();
    await db.prepare(`INSERT INTO file_request_uploads(id,request_id,contributor_id,object_key,upload_id,original_name,declared_size,actual_size,content_type,status,etag,pickup_state,verification_state,created_at)
      VALUES('upload-two','request-one','contributor-one','quarantine/request-one/upload-two/object','r2-two','other.pdf',10,10,'application/pdf','quarantined','abcdef','awaiting_pickup','awaiting_verification',datetime('now'))`).run();
    await db.prepare(`INSERT INTO file_request_upload_promotion_journal(upload_id,source_identity,source_key,destination_key,state)
      VALUES('upload-two',?,?,?,'pending')`).bind(JSON.stringify({ version: 1, etag: source.etag, bytes: source.size, objectVersion: source.version }), source.key, planned.destinationKey).run();
    await expect(beginIncomingRclonePromotion(env as never, "upload-one")).rejects.toThrow("promotion_journal_create_failed");
    expect(await db.prepare("SELECT destination_key FROM file_request_upload_promotion_journal WHERE upload_id='upload-one'").first()).toBeNull();
    expect(bucket.createCalls).toBe(0);
    expect(bucket.completeCalls).toBe(0);
  });

  it("marks a changed source unavailable before multipart bytes are read", async () => {
    const bucket = fakeBucket(); const env = { DELIVERY_DB: db, INCOMING_BUCKET: bucket };
    await beginIncomingRclonePromotion(env as never, "upload-one"); await resumeIncomingRclonePromotionStep(env as never, "upload-one");
    bucket.removeSource();
    const result = await resumeIncomingRclonePromotionStep(env as never, "upload-one");
    expect(result).toMatchObject({ state: "unavailable", errorCode: "quarantine_object_changed", completedParts: 0 });
    expect(bucket.uploaded).toEqual([]);
  });

  it("keeps an ambiguous multipart completion fenced as publishing", async () => {
    const bucket = fakeBucket(); const env = { DELIVERY_DB: db, INCOMING_BUCKET: bucket };
    await beginIncomingRclonePromotion(env as never, "upload-one"); await resumeIncomingRclonePromotionStep(env as never, "upload-one"); await resumeIncomingRclonePromotionStep(env as never, "upload-one");
    // Simulate a worker death after durable pre-complete fencing. Recovery
    // must not complete a potentially already moved object a second time.
    await db.prepare("UPDATE file_request_upload_promotion_journal SET state='publishing',publication_started_at=datetime('now') WHERE upload_id='upload-one'").run();
    expect((await resumeIncomingRclonePromotionStep(env as never, "upload-one")).state).toBe("publishing");
    expect(bucket.completeCalls).toBe(0);
    expect((await readIncomingRclonePromotionStatus(env as never, "upload-one"))?.publicationStartedAt).not.toBeNull();
  });

  it("keeps transient part failures retryable without losing the journal", async () => {
    const bucket = fakeBucket(); const originalResume = bucket.resumeMultipartUpload.bind(bucket); let failOnce = true;
    bucket.resumeMultipartUpload = (key: string, uploadId: string) => {
      const multipart = originalResume(key, uploadId); const uploadPart = multipart.uploadPart.bind(multipart);
      return { ...multipart, async uploadPart(partNumber: number, body: ReadableStream<Uint8Array>) {
        if (failOnce) { failOnce = false; throw new Error("r2_timeout"); }
        return uploadPart(partNumber, body);
      } };
    };
    const env = { DELIVERY_DB: db, INCOMING_BUCKET: bucket };
    await beginIncomingRclonePromotion(env as never, "upload-one"); await resumeIncomingRclonePromotionStep(env as never, "upload-one");
    expect(await resumeIncomingRclonePromotionStep(env as never, "upload-one")).toMatchObject({ state: "copying", errorCode: "r2_timeout", completedParts: 0 });
    expect(await resumeIncomingRclonePromotionStep(env as never, "upload-one")).toMatchObject({ state: "copying", errorCode: null, completedParts: 1 });
  });

  it("fences revocation before publication and never completes after it", async () => {
    const bucket = fakeBucket(); const env = { DELIVERY_DB: db, INCOMING_BUCKET: bucket };
    await beginIncomingRclonePromotion(env as never, "upload-one"); await resumeIncomingRclonePromotionStep(env as never, "upload-one"); await resumeIncomingRclonePromotionStep(env as never, "upload-one");
    await db.prepare("UPDATE file_requests SET revoked_at=datetime('now') WHERE id='request-one'").run();
    expect(await resumeIncomingRclonePromotionStep(env as never, "upload-one")).toMatchObject({ state: "unavailable", errorCode: "promotion_not_eligible" });
    expect(bucket.completeCalls).toBe(0);
  });

  it("stops publication after retention expires even if lifecycle cleanup has not run", async () => {
    const bucket = fakeBucket(); const env = { DELIVERY_DB: db, INCOMING_BUCKET: bucket };
    await beginIncomingRclonePromotion(env as never, "upload-one");
    await resumeIncomingRclonePromotionStep(env as never, "upload-one");
    await resumeIncomingRclonePromotionStep(env as never, "upload-one");
    await db.prepare("UPDATE file_request_uploads SET created_at=datetime('now','-15 days') WHERE id='upload-one'").run();
    expect(await resumeIncomingRclonePromotionStep(env as never, "upload-one")).toMatchObject({ state: "unavailable", errorCode: "promotion_not_eligible" });
    expect(bucket.completeCalls).toBe(0);
    expect(await db.prepare("SELECT status FROM file_request_uploads WHERE id='upload-one'").first()).toEqual({ status: "quarantined" });
  });

  it("runs the actual promotion module in a Worker isolate with real D1 and R2", async () => {
    const workerDir = fileURLToPath(new URL("../src/worker/", import.meta.url));
    const bundled = await build({ bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", stdin: {
      resolveDir: workerDir, sourcefile: "promotion-isolate.ts", contents: `
        import { beginIncomingRclonePromotion, resumeIncomingRclonePromotionStep } from "./incoming-rclone-promotion";
        export default { async fetch(request, env) {
          const uploadId = new URL(request.url).searchParams.get("upload") || "upload-one";
          const result = new URL(request.url).pathname === "/begin"
            ? await beginIncomingRclonePromotion(env, uploadId)
            : await resumeIncomingRclonePromotionStep(env, uploadId);
          return Response.json(result);
        } };
      `,
    } });
    const isolated = new Miniflare({ compatibilityDate: "2026-08-06", modules: true, d1Databases: { DELIVERY_DB: "incoming-isolate" }, r2Buckets: { INCOMING_BUCKET: "incoming-isolate" }, script: bundled.outputFiles[0]!.text });
    const isolatedDb = await isolated.getD1Database("DELIVERY_DB") as unknown as D1Database;
    for (const name of ["0090_aliases_incoming_requests.sql", "0093_reusable_incoming_uploads.sql", "0116_incoming_upload_hardening.sql", "0199_incoming_upload_pickup_lifecycle.sql", "0211_incoming_upload_verification_lifecycle.sql", "0213_incoming_rclone_promotion.sql"]) {
      const sql = readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8").replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "");
      await isolatedDb.exec(sql.replace(/\s*\n\s*/g, " "));
    }
    const r2 = await isolated.getR2Bucket("INCOMING_BUCKET") as unknown as R2Bucket;
    const bytes = new Uint8Array(5 * 1024 * 1024 + 10); bytes[0] = 0x50; bytes[1] = 0x4b; // harmless short ZIP header
    const isolateSource = { ...source, size: bytes.byteLength };
    const stored = await r2.put(isolateSource.key, bytes);
    if (!stored) throw new Error("R2 source put unexpectedly conditional");
    const savedDb = db; db = isolatedDb;
    await insertUpload({ ...isolateSource, etag: stored.etag, version: stored.version });
    db = savedDb;
    async function call(path: string) { return (await (await isolated.dispatchFetch(`https://worker.test${path}?upload=upload-one`)).json()) as { state: string; destinationKey: string; destinationBytes: number | null }; }
    expect((await call("/begin")).state).toBe("pending");
    let result = await call("/resume");
    for (let step = 0; step < 3 && result.state !== "ready"; step += 1) result = await call("/resume");
    expect(result.state).toBe("ready");
    const ready = await r2.head(result.destinationKey);
    expect(ready?.size).toBe(bytes.byteLength);
    expect(result.destinationBytes).toBe(bytes.byteLength);
    await r2.delete(result.destinationKey);
    expect((await call("/resume")).state).toBe("ready");
    expect(await r2.head(result.destinationKey)).toBeNull();
    expect(await isolatedDb.prepare("SELECT verified_object_etag FROM file_request_uploads WHERE id='upload-one'").first()).toEqual({ verified_object_etag: null });
    await isolated.dispose();
  });
});
