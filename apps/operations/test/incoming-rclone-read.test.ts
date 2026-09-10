import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { downloadIncomingRcloneReadyObject, readIncomingRcloneReadyFacts, listIncomingRcloneReadyArchive } from "../src/worker/incoming-rclone-read";

let runtime: Miniflare; let db: D1Database; let r2: R2Bucket;
const sourceKey = "quarantine/request-one/upload-one/object", readyKey = "ready/request-one/upload-one/report.pdf";

async function fixture() {
  const source = await r2.put(sourceKey, new Uint8Array([0x50, 0x4b, 1, 2, 3, 4, 5, 6, 7, 8]));
  const ready = await r2.put(readyKey, new Uint8Array([0x50, 0x4b, 1, 2, 3, 4, 5, 6, 7, 8]));
  if (!source || !ready) throw new Error("fixture write failed");
  await db.batch([
    db.prepare("INSERT INTO file_requests(id,public_id,title,created_by,expires_at,max_files,max_bytes,session_version) VALUES('request-one','public-one','Receive','staff',datetime('now','+1 day'),5,999,1)"),
    db.prepare("INSERT INTO file_request_contributors(id,request_id,name,email,client_address_hash) VALUES('contributor-one','request-one','Contributor','c@example.test','hash')"),
    db.prepare("INSERT INTO file_request_uploads(id,request_id,contributor_id,object_key,upload_id,original_name,declared_size,actual_size,content_type,status,pickup_state,verification_state,etag) VALUES('upload-one','request-one','contributor-one',?,'multipart','report.pdf',10,10,'application/pdf','quarantined','awaiting_pickup','awaiting_verification',?)").bind(sourceKey, source.etag),
    db.prepare("INSERT INTO file_request_upload_basic_checks(upload_id,object_etag,object_bytes,object_version,check_version) VALUES('upload-one',?,?,?,'basic-v1')").bind(source.etag, source.size, source.version),
    db.prepare("INSERT INTO file_request_upload_promotion_journal(upload_id,source_identity,source_key,destination_key,state,destination_etag,destination_bytes,destination_version,published_at) VALUES('upload-one',? ,? ,?,'ready',?,?,?,datetime('now'))").bind(JSON.stringify({ version: 1, etag: source.etag.toLowerCase(), bytes: source.size, objectVersion: source.version }), sourceKey, readyKey, ready.etag, ready.size, ready.version),
  ]);
}

async function installArchive(names: string[]) {
  const entries = names.map(name => {
    const text = new TextEncoder().encode(name), bytes = new Uint8Array(46 + text.length), data = new DataView(bytes.buffer);
    data.setUint32(0, 0x02014b50, true); data.setUint16(8, 0x800, true); data.setUint16(28, text.length, true);
    bytes.set(text, 46); return bytes;
  });
  const directoryBytes = entries.reduce((sum, bytes) => sum + bytes.length, 0);
  const bytes = new Uint8Array(32 + directoryBytes + 22), data = new DataView(bytes.buffer);
  let offset = 32;
  for (const entry of entries) { bytes.set(entry, offset); offset += entry.length; }
  data.setUint32(offset, 0x06054b50, true); data.setUint16(offset + 8, names.length, true); data.setUint16(offset + 10, names.length, true);
  data.setUint32(offset + 12, directoryBytes, true); data.setUint32(offset + 16, 32, true);
  const source = await r2.put(sourceKey, bytes), ready = await r2.put(readyKey, bytes);
  if (!source || !ready) throw new Error("archive fixture failed");
  await db.batch([
    db.prepare("UPDATE file_request_uploads SET original_name='photos.zip',content_type='application/zip',declared_size=?,actual_size=?,etag=? WHERE id='upload-one'").bind(bytes.length, bytes.length, source.etag),
    db.prepare("UPDATE file_request_upload_basic_checks SET object_etag=?,object_bytes=?,object_version=? WHERE upload_id='upload-one'").bind(source.etag, bytes.length, source.version),
    db.prepare("UPDATE file_request_upload_promotion_journal SET source_identity=?,destination_etag=?,destination_bytes=?,destination_version=? WHERE upload_id='upload-one'").bind(JSON.stringify({ version: 1, etag: source.etag.toLowerCase(), bytes: source.size, objectVersion: source.version }), ready.etag, bytes.length, ready.version),
  ]);
}

describe("incoming rclone ready reads", () => {
  beforeAll(async () => { runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true, script: "export default { fetch(){ return new Response('ok'); } }", d1Databases: { DB: "incoming-ready-read" }, r2Buckets: { INCOMING: "incoming-ready-read" } }); db = await runtime.getD1Database("DB") as unknown as D1Database; r2 = await runtime.getR2Bucket("INCOMING") as unknown as R2Bucket;
    for (const name of ["0090_aliases_incoming_requests.sql", "0093_reusable_incoming_uploads.sql", "0116_incoming_upload_hardening.sql", "0199_incoming_upload_pickup_lifecycle.sql", "0211_incoming_upload_verification_lifecycle.sql", "0213_incoming_rclone_promotion.sql"]) { const sql = readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8").replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, ""); await db.exec(sql.replace(/\s*\n\s*/g, " ")); }
  });
  beforeEach(async () => { await db.exec("DELETE FROM file_request_upload_promotion_journal; DELETE FROM file_request_upload_basic_checks; DELETE FROM file_request_uploads; DELETE FROM file_request_contributors; DELETE FROM file_requests;"); await r2.delete([sourceKey, readyKey]); await fixture(); });
  afterAll(async () => runtime.dispose());
  const env = () => ({ DELIVERY_DB: db, INCOMING_BUCKET: r2 }) as never;

  it("uses HEAD only for facts and distinguishes a MOVE-removed ready object", async () => {
    let gets = 0; const factsEnv = { DELIVERY_DB: db, INCOMING_BUCKET: { head: r2.head.bind(r2), async get() { gets += 1; throw new Error("facts must not GET"); } } };
    await expect(readIncomingRcloneReadyFacts(factsEnv as never, "upload-one")).resolves.toMatchObject({ promotionState: "ready", objectAvailability: "present", downloadAvailable: true, fileName: "report.pdf" });
    expect(gets).toBe(0);
    await r2.delete(readyKey);
    await expect(readIncomingRcloneReadyFacts(env(), "upload-one")).resolves.toMatchObject({ promotionState: "ready", objectAvailability: "missing", downloadAvailable: false });
  });
  it("rejects a replaced ready object without falling back to staging", async () => {
    await r2.put(readyKey, new Uint8Array([9, 9, 9]));
    await expect(readIncomingRcloneReadyFacts(env(), "upload-one")).resolves.toMatchObject({ objectAvailability: "changed" });
    await expect(downloadIncomingRcloneReadyObject(env(), "upload-one", new Request("https://test/download"))).rejects.toMatchObject({ status: 404 });
  });
  it("rechecks revocation before opening bytes", async () => {
    await db.exec("UPDATE file_requests SET revoked_at=datetime('now') WHERE id='request-one'");
    await expect(downloadIncomingRcloneReadyObject(env(), "upload-one", new Request("https://test/download"))).rejects.toMatchObject({ status: 404 });
  });
  it("does not expose a ready object when the basic proof or retention fence changed", async () => {
    await db.exec("UPDATE file_request_upload_basic_checks SET object_bytes=11 WHERE upload_id='upload-one'");
    await expect(readIncomingRcloneReadyFacts(env(), "upload-one")).resolves.toMatchObject({ promotionState: "ready", objectAvailability: null, downloadAvailable: false });
    await db.exec("UPDATE file_request_upload_basic_checks SET object_bytes=10; UPDATE file_request_uploads SET created_at=datetime('now','-14 days','-1 second') WHERE id='upload-one'");
    await expect(readIncomingRcloneReadyFacts(env(), "upload-one")).resolves.toMatchObject({ objectAvailability: null, downloadAvailable: false });
  });
  it("serves a conditional byte range and falls back to full bytes for stale If-Range", async () => {
    const facts = await readIncomingRcloneReadyFacts(env(), "upload-one"); expect(facts.downloadAvailable).toBe(true);
    const ranged = await downloadIncomingRcloneReadyObject(env(), "upload-one", new Request("https://test/download", { headers: { Range: "bytes=2-4", "If-Range": `\"${(await r2.head(readyKey))!.etag}\"` } }));
    expect(ranged.status).toBe(206); expect(ranged.headers.get("Content-Range")).toBe("bytes 2-4/10"); expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const stale = await downloadIncomingRcloneReadyObject(env(), "upload-one", new Request("https://test/download", { headers: { Range: "bytes=2-4", "If-Range": "\"stale\"" } }));
    expect(stale.status).toBe(200); expect((await stale.arrayBuffer()).byteLength).toBe(10);
  });
  it("cancels a body when the conditional GET identity no longer matches", async () => {
    let cancelled = false;
    const bucket = {
      head: r2.head.bind(r2),
      async get() {
        return { key: readyKey, size: 10, etag: "replacement", version: "replacement-version",
          body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } }) };
      },
    };
    await expect(downloadIncomingRcloneReadyObject({ DELIVERY_DB: db, INCOMING_BUCKET: bucket } as never, "upload-one", new Request("https://test/download"))).rejects.toMatchObject({ status: 409 });
    expect(cancelled).toBe(true);
  });

  it("browses only immediate ZIP children with search and identity-bound pagination", async () => {
    await installArchive([...Array.from({ length: 101 }, (_, i) => `photo-${String(i).padStart(3, "0")}.jpg`), "folder/child.jpg"]);
    const first = await listIncomingRcloneReadyArchive(env(), "upload-one");
    expect(first.status).toBe("ready"); expect(first.items).toHaveLength(100); expect(first.nextCursor).toBeTruthy();
    expect(first.items.some(item => item.path === "folder/child.jpg")).toBe(false);
    const second = await listIncomingRcloneReadyArchive(env(), "upload-one", "", "", first.nextCursor);
    expect(second.items).toHaveLength(2); expect(second.nextCursor).toBeNull();
    const nested = await listIncomingRcloneReadyArchive(env(), "upload-one", "folder");
    expect(nested.items.map(item => item.path)).toEqual(["folder/child.jpg"]);
    expect((await listIncomingRcloneReadyArchive(env(), "upload-one", "", "100")).items.map(item => item.path)).toEqual(["photo-100.jpg"]);
    await expect(listIncomingRcloneReadyArchive(env(), "upload-one", "folder", "", first.nextCursor)).rejects.toMatchObject({ status: 400 });
    expect(JSON.stringify(first)).not.toContain("ready/request-one");
    expect(await db.prepare("SELECT verified_object_etag FROM file_request_uploads WHERE id='upload-one'").first()).toEqual({ verified_object_etag: null });
  });

  it("stops archive browsing after MOVE and never uses the retained source", async () => {
    await installArchive(["photo.jpg"]); await r2.delete(readyKey);
    await expect(listIncomingRcloneReadyArchive(env(), "upload-one")).rejects.toMatchObject({ status: 404 });
    expect(await r2.head(sourceKey)).not.toBeNull();
  });

  it("rejects invalid archive cursors before reading any archive bytes", async () => {
    await installArchive(["photo.jpg"]);
    let gets = 0;
    const guarded = { DELIVERY_DB: db, INCOMING_BUCKET: {
      head: r2.head.bind(r2), async get() { gets++; throw new Error("unexpected archive read"); },
    } };
    await expect(listIncomingRcloneReadyArchive(guarded as never, "upload-one", "", "", "invalid!")).rejects.toMatchObject({ status: 400 });
    expect(gets).toBe(0);
  });

  it("rechecks access between metadata ranges before returning directory names", async () => {
    await installArchive(["private/photo.jpg"]);
    let gets = 0;
    const guarded = { DELIVERY_DB: db, INCOMING_BUCKET: {
      head: r2.head.bind(r2),
      async get(key: string, options: R2GetOptions) {
        gets++;
        const object = await r2.get(key, options);
        await db.exec("UPDATE file_requests SET revoked_at=datetime('now') WHERE id='request-one'");
        return object;
      },
    } };
    await expect(listIncomingRcloneReadyArchive(guarded as never, "upload-one")).rejects.toMatchObject({ status: 404 });
    expect(gets).toBe(1);
  });
});
