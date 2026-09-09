import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));

import { dispatchIncomingPublicRequest } from "../src/worker/incoming";
import { verificationCandidates, verificationPending } from "../src/worker/incoming-verification";

let runtime: Miniflare;
let db: D1Database;
const createdAt = "2026-09-08 12:00:00";

function candidate(index: number, state: "verified" | "awaiting_verification", pickup = "awaiting_pickup") {
  const id = `upload-${String(index).padStart(3, "0")}`;
  return db.prepare(`INSERT INTO file_request_uploads(id,request_id,contributor_id,object_key,upload_id,original_name,declared_size,actual_size,content_type,status,
    etag,created_at,pickup_state,verification_state,verified_sha256,verified_object_etag,verified_object_bytes,verified_object_version)
    VALUES(?,?,?,?,?,?,?,?,?,'quarantined',?,?,?,?,?,?,?,?)`)
    .bind(id, "request-one", "contributor-one", `quarantine/request-one/${id}/object`, `multipart-${id}`, `${id}.zip`, 10, 10, "application/zip",
      "etag", createdAt, pickup, state, state === "verified" ? "a".repeat(64) : null, state === "verified" ? "abcdef" : null,
      state === "verified" ? 10 : null, state === "verified" ? "r2-v1" : null);
}

describe("incoming verification candidate pagination", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true, script: "export default { fetch(){ return new Response('ok'); } }", d1Databases: { DB: "verification-candidates" } });
    db = await runtime.getD1Database("DB") as unknown as D1Database;
    for (const name of ["0090_aliases_incoming_requests.sql", "0093_reusable_incoming_uploads.sql", "0116_incoming_upload_hardening.sql", "0198_incoming_upload_owner_notifications.sql", "0199_incoming_upload_pickup_lifecycle.sql", "0211_incoming_upload_verification_lifecycle.sql"]) {
      const sql = readFileSync(new URL(`../../client/migrations/${name}`, import.meta.url), "utf8").replace(/^\s*--.*$/gm, "").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*ON;\s*/i, "");
      await db.exec(sql.replace(/\s*\n\s*/g, " "));
    }
  });
  beforeEach(async () => {
    await db.exec("DELETE FROM file_request_uploads; DELETE FROM file_request_contributors; DELETE FROM file_requests;");
    await db.batch([
      db.prepare("INSERT INTO file_requests(id,public_id,title,created_by,expires_at,max_files,max_bytes,session_version) VALUES('request-one','public-one','Receive','staff',datetime('now','+1 day'),500,999999,1)"),
      db.prepare("INSERT INTO file_request_contributors(id,request_id,name,email,client_address_hash) VALUES('contributor-one','request-one','Contributor','c@example.test','hash')"),
    ]);
  });
  afterAll(async () => { await runtime.dispose(); });

  it("pages verified candidates without skips or duplicates when created_at ties", async () => {
    await db.batch(Array.from({ length: 205 }, (_, index) => candidate(index, "verified")));
    const first = await verificationCandidates({ DELIVERY_DB: db } as never, null) as { uploads: Array<{ id: string }>; nextCursor: string | null };
    const second = await verificationCandidates({ DELIVERY_DB: db } as never, first.nextCursor) as typeof first;
    const third = await verificationCandidates({ DELIVERY_DB: db } as never, second.nextCursor) as typeof first;
    expect(first.uploads).toHaveLength(100); expect(second.uploads).toHaveLength(100); expect(third.uploads).toHaveLength(5); expect(third.nextCursor).toBeNull();
    const ids = [...first.uploads, ...second.uploads, ...third.uploads].map(row => row.id);
    expect(new Set(ids).size).toBe(205);
    expect(ids).toEqual([...ids].sort());
  });

  it("pages pending work separately and filters future retry and active leases", async () => {
    await db.batch(Array.from({ length: 101 }, (_, index) => candidate(index, "awaiting_verification")));
    await db.batch([
      candidate(201, "verified", "retry"), candidate(202, "verified", "scanning"), candidate(203, "awaiting_verification", "retry"), candidate(204, "awaiting_verification", "scanning"),
    ]);
    await db.batch([
      db.prepare("UPDATE file_request_uploads SET pickup_next_attempt_at=datetime('now','+1 hour') WHERE id='upload-201'"),
      db.prepare("UPDATE file_request_uploads SET pickup_lease_expires_at=datetime('now','+1 hour') WHERE id='upload-202'"),
      db.prepare("UPDATE file_request_uploads SET verification_state='retry',verification_next_attempt_at=datetime('now','+1 hour') WHERE id='upload-203'"),
      db.prepare("UPDATE file_request_uploads SET verification_state='scanning',verification_lease_expires_at=datetime('now','+1 hour') WHERE id='upload-204'"),
    ]);
    const first = await verificationPending({ DELIVERY_DB: db } as never, null) as { uploads: Array<{ id: string }>; nextCursor: string | null };
    const second = await verificationPending({ DELIVERY_DB: db } as never, first.nextCursor) as typeof first;
    expect([...first.uploads, ...second.uploads].map(row => row.id)).toHaveLength(101);
    expect((await verificationCandidates({ DELIVERY_DB: db } as never, null) as { uploads: unknown[] }).uploads).toEqual([]);
  });

  it("rejects malformed cursors and keeps listing endpoints off a wrong host", async () => {
    await expect(verificationCandidates({ DELIVERY_DB: db } as never, "not*base64")).rejects.toMatchObject({ status: 400 });
    const env = { DELIVERY_DB: db, INCOMING_BUCKET: {}, INCOMING_BASE_URL: "https://incoming.example", INCOMING_EXPECTED_HOST: "incoming.example", INCOMING_PICKUP_SECRET: "secret" };
    expect(await dispatchIncomingPublicRequest(new Request("https://other.example/api/internal/uploads/verification-candidates"), env as never, {} as ExecutionContext)).toBeNull();
    expect(await dispatchIncomingPublicRequest(new Request("https://other.example/api/internal/uploads/verification-pending"), env as never, {} as ExecutionContext)).toBeNull();
  });
});
