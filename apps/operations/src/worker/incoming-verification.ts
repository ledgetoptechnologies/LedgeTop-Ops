import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { IncomingEnv } from "./incoming";

const LEASE_SECONDS = 15 * 60;
const proofIdentitySchema = z.object({
  objectEtag: z.string().regex(/^[a-f0-9-]{1,128}$/i),
  objectBytes: z.number().int().positive(),
  objectVersion: z.string().min(1).max(1024).optional(),
});
const identitySchema = proofIdentitySchema.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/i) });

export const verificationStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("scanning"), claimToken: z.string().uuid() }),
  z.object({ state: z.literal("heartbeat"), claimToken: z.string().uuid() }),
  z.object({ state: z.literal("retry"), claimToken: z.string().uuid(), retryAfterSeconds: z.number().int().min(60).max(86400), errorCode: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i) }),
  z.object({ state: z.literal("verified"), claimToken: z.string().uuid(), ...identitySchema.shape }),
  z.object({ state: z.literal("invalidate"), retryAfterSeconds: z.number().int().min(60).max(86400), errorCode: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i), ...proofIdentitySchema.shape }),
]);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;
type CandidateCursor = { createdAt: string; id: string };
const CANDIDATE_LIMIT = 100;

type Row = { id: string; objectKey: string; status: string; verificationState: string; verificationClaimToken: string | null; verificationLeaseExpiresAt: string | null };
export type VerifiedObjectRow = { id: string; objectKey: string; originalName: string; contentType: string; verificationState: string; status: string; verifiedObjectEtag: string | null; verifiedObjectBytes: number | null; verifiedObjectVersion: string | null };

async function active(db: D1Database, uploadId: string, token: string): Promise<Row | null> {
  return db.withSession("first-primary").prepare(`SELECT id,object_key objectKey,status,verification_state verificationState,
    verification_claim_token verificationClaimToken,verification_lease_expires_at verificationLeaseExpiresAt FROM file_request_uploads
    WHERE id=? AND status='quarantined' AND verification_state='scanning' AND verification_claim_token=?
      AND verification_lease_expires_at IS NOT NULL AND datetime(verification_lease_expires_at)>datetime('now')`)
    .bind(uploadId, token).first<Row>();
}

function matches(object: R2Object, input: z.infer<typeof identitySchema>): boolean {
  return object.size === input.objectBytes && object.etag.toLowerCase() === input.objectEtag.toLowerCase()
    && (!input.objectVersion || object.version === input.objectVersion);
}

function clearProofSql(): string {
  return "verified_sha256=NULL,verified_object_etag=NULL,verified_object_bytes=NULL,verified_object_version=NULL,verified_at=NULL,verification_receipt_token=NULL";
}

export function verifiedObjectAvailable(row: VerifiedObjectRow, object: R2Object | null): boolean {
  if (!object) return false;
  return row.status === "quarantined" && row.verificationState === "verified" && row.verifiedObjectBytes === object.size
    && row.verifiedObjectEtag?.toLowerCase() === object.etag.toLowerCase() && row.verifiedObjectVersion === object.version;
}

function decodeCursor(value: string | null): CandidateCursor | null {
  if (!value) return null;
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new HTTPException(400, { message: "Invalid verification cursor" });
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || !Object.hasOwn(parsed, "createdAt") || !Object.hasOwn(parsed, "id")) throw new Error();
    const candidate = parsed as CandidateCursor;
    if (typeof candidate.createdAt !== "string" || typeof candidate.id !== "string" || !candidate.createdAt || !candidate.id || candidate.createdAt.length > 64 || candidate.id.length > 200) throw new Error();
    return candidate;
  } catch { throw new HTTPException(400, { message: "Invalid verification cursor" }); }
}

function encodeCursor(row: CandidateCursor): string {
  return btoa(JSON.stringify(row)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function verificationCandidates(env: IncomingEnv, cursorValue: string | null): Promise<Record<string, unknown>> {
  const cursor = decodeCursor(cursorValue);
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,request_id requestId,object_key objectKey,original_name originalName,
    verified_object_etag objectEtag,verified_object_bytes objectBytes,verified_object_version objectVersion,verified_sha256 sha256,created_at createdAt
    FROM file_request_uploads WHERE status='quarantined' AND verification_state='verified'
      AND verified_object_etag IS NOT NULL AND verified_object_bytes IS NOT NULL AND verified_object_version IS NOT NULL AND verified_sha256 IS NOT NULL
      AND (pickup_state='awaiting_pickup' OR (pickup_state='retry' AND pickup_next_attempt_at IS NOT NULL AND datetime(pickup_next_attempt_at)<=datetime('now'))
        OR (pickup_state='scanning' AND (pickup_lease_expires_at IS NULL OR datetime(pickup_lease_expires_at)<=datetime('now'))))
      AND (? IS NULL OR created_at>? OR (created_at=? AND id>?))
    ORDER BY created_at,id LIMIT ?`).bind(cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, CANDIDATE_LIMIT + 1)
    .all<{ id: string; requestId: string; objectKey: string; originalName: string; objectEtag: string; objectBytes: number; objectVersion: string; sha256: string; createdAt: string }>();
  const page = rows.results.slice(0, CANDIDATE_LIMIT), trailing = rows.results[CANDIDATE_LIMIT];
  return { uploads: page.map(({ createdAt: _createdAt, ...upload }) => upload), nextCursor: trailing ? encodeCursor({ createdAt: page.at(-1)!.createdAt, id: page.at(-1)!.id }) : null };
}

export async function verificationPending(env: IncomingEnv, cursorValue: string | null): Promise<Record<string, unknown>> {
  const cursor = decodeCursor(cursorValue);
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,request_id requestId,object_key objectKey,original_name originalName,
    etag objectEtag,actual_size objectBytes,created_at createdAt FROM file_request_uploads
    WHERE status='quarantined' AND (verification_state='awaiting_verification'
      OR (verification_state='retry' AND verification_next_attempt_at IS NOT NULL AND datetime(verification_next_attempt_at)<=datetime('now'))
      OR (verification_state='scanning' AND (verification_lease_expires_at IS NULL OR datetime(verification_lease_expires_at)<=datetime('now'))))
      AND (? IS NULL OR created_at>? OR (created_at=? AND id>?))
    ORDER BY created_at,id LIMIT ?`).bind(cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, CANDIDATE_LIMIT + 1)
    .all<{ id: string; requestId: string; objectKey: string; originalName: string; objectEtag: string | null; objectBytes: number | null; createdAt: string }>();
  const page = rows.results.slice(0, CANDIDATE_LIMIT), trailing = rows.results[CANDIDATE_LIMIT];
  return { uploads: page.map(({ createdAt: _createdAt, ...upload }) => upload), nextCursor: trailing ? encodeCursor({ createdAt: page.at(-1)!.createdAt, id: page.at(-1)!.id }) : null };
}

function parseRange(value: string | null, size: number): { offset: number; length: number } | null | "invalid" {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || value.includes(",") || (!match[1] && !match[2])) return "invalid";
  if (!match[1]) { const suffix = Number(match[2]); return Number.isSafeInteger(suffix) && suffix > 0 ? { offset: Math.max(0, size - suffix), length: Math.min(size, suffix) } : "invalid"; }
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return "invalid";
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_").slice(0, 180) || "download";
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function serveVerifiedIncomingObject(env: IncomingEnv, row: VerifiedObjectRow, request: Request): Promise<Response> {
  const head = await env.INCOMING_BUCKET.head(row.objectKey);
  if (!head || !verifiedObjectAvailable(row, head)) throw new HTTPException(404, { message: "Verified upload is unavailable" });
  const requested = parseRange(request.headers.get("Range"), head.size);
  if (requested === "invalid") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head.size}`, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  // The proof ETag is the stable validator delivered to clients. A stale
  // If-Range deliberately falls back to a full response so resume clients
  // cannot join byte ranges from different verified objects.
  const stableEtag = `"${row.verifiedObjectEtag}"`;
  const range = requested && (!request.headers.get("If-Range") || request.headers.get("If-Range") === stableEtag) ? requested : null;
  // Re-read the small state/proof row immediately before opening bytes. This
  // cannot make D1/R2 atomic, but closes the ordinary status-transition race
  // and the conditional R2 read fences a replacement after the HEAD.
  const current = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,object_key objectKey,original_name originalName,content_type contentType,status,
    verification_state verificationState,verified_object_etag verifiedObjectEtag,verified_object_bytes verifiedObjectBytes,verified_object_version verifiedObjectVersion
    FROM file_request_uploads WHERE id=?`).bind(row.id).first<VerifiedObjectRow>();
  if (!current || current.objectKey !== row.objectKey || !verifiedObjectAvailable(current, head)) throw new HTTPException(404, { message: "Verified upload is unavailable" });
  const object = await env.INCOMING_BUCKET.get(row.objectKey, { ...(range ? { range } : {}), onlyIf: { etagMatches: head.etag } });
  if (!object || !("body" in object))
    throw new HTTPException(409, { message: "Verified upload changed while it was being opened" });
  if (object.etag.toLowerCase() !== head.etag.toLowerCase() || object.version !== head.version || object.size !== head.size) {
    await object.body.cancel().catch(() => undefined);
    throw new HTTPException(409, { message: "Verified upload changed while it was being opened" });
  }
  const headers = new Headers({ "Content-Type": row.contentType, "Content-Disposition": attachmentDisposition(row.originalName), ETag: stableEtag, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Length": String(range?.length ?? head.size) });
  if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

export async function applyVerificationStatus(env: IncomingEnv, uploadId: string, input: VerificationStatus): Promise<Record<string, unknown>> {
  const db = env.DELIVERY_DB;
  const row = await db.withSession("first-primary").prepare(`SELECT id,object_key objectKey,status,verification_state verificationState,
    verification_claim_token verificationClaimToken,verification_lease_expires_at verificationLeaseExpiresAt FROM file_request_uploads WHERE id=?`)
    .bind(uploadId).first<Row>();
  if (!row || row.status !== "quarantined") throw new HTTPException(404, { message: "Quarantined upload not found" });

  if (input.state === "scanning") {
    const result = await db.prepare(`UPDATE file_request_uploads SET verification_state='scanning',verification_attempt_count=verification_attempt_count+1,
      verification_last_attempt_at=datetime('now'),verification_next_attempt_at=NULL,verification_last_error_code=NULL,
      verification_claim_token=?,verification_lease_expires_at=datetime('now','+${LEASE_SECONDS} seconds'),${clearProofSql()},updated_at=datetime('now')
      WHERE id=? AND status='quarantined' AND (verification_state='awaiting_verification'
        OR (verification_state='verified' AND NOT (pickup_state='scanning' AND pickup_lease_expires_at IS NOT NULL AND datetime(pickup_lease_expires_at)>datetime('now')))
        OR (verification_state='retry' AND verification_next_attempt_at IS NOT NULL AND datetime(verification_next_attempt_at)<=datetime('now'))
        OR (verification_state='scanning' AND (verification_lease_expires_at IS NULL OR datetime(verification_lease_expires_at)<=datetime('now'))))`)
      .bind(input.claimToken, row.id).run();
    let claim = await active(db, row.id, input.claimToken);
    if (!result.meta.changes) {
      if (!claim) throw new HTTPException(409, { message: "Upload is already claimed or not due for verification" });
      return { ok: true, state: "scanning", claimToken: input.claimToken, leaseExpiresAt: claim.verificationLeaseExpiresAt, replayed: true };
    }
    if (!await env.INCOMING_BUCKET.head(row.objectKey)) {
      await db.prepare(`UPDATE file_request_uploads SET verification_state='retry',verification_next_attempt_at=datetime('now','+60 seconds'),
        verification_last_error_code='quarantine_object_missing',verification_claim_token=NULL,verification_lease_expires_at=NULL,updated_at=datetime('now')
        WHERE id=? AND verification_state='scanning' AND verification_claim_token=?`).bind(row.id, input.claimToken).run();
      throw new HTTPException(409, { message: "Quarantined object is not available" });
    }
    claim = await active(db, row.id, input.claimToken);
    if (!claim) throw new HTTPException(409, { message: "Verification lease was lost" });
    return { ok: true, state: "scanning", claimToken: input.claimToken, leaseExpiresAt: claim.verificationLeaseExpiresAt, replayed: false };
  }
  if (input.state === "heartbeat") {
    const result = await db.prepare(`UPDATE file_request_uploads SET verification_lease_expires_at=datetime('now','+${LEASE_SECONDS} seconds'),updated_at=datetime('now')
      WHERE id=? AND status='quarantined' AND verification_state='scanning' AND verification_claim_token=?
       AND verification_lease_expires_at IS NOT NULL AND datetime(verification_lease_expires_at)>datetime('now')`).bind(row.id, input.claimToken).run();
    const claim = await active(db, row.id, input.claimToken);
    if (!result.meta.changes || !claim) throw new HTTPException(409, { message: "Verification lease is no longer active" });
    return { ok: true, state: "scanning", claimToken: input.claimToken, leaseExpiresAt: claim.verificationLeaseExpiresAt };
  }
  if (input.state === "retry") {
    const result = await db.prepare(`UPDATE file_request_uploads SET verification_state='retry',verification_last_attempt_at=datetime('now'),
      verification_next_attempt_at=datetime('now','+' || ? || ' seconds'),verification_last_error_code=?,verification_claim_token=NULL,
      verification_lease_expires_at=NULL,${clearProofSql()},updated_at=datetime('now') WHERE id=? AND status='quarantined'
      AND verification_state='scanning' AND verification_claim_token=? AND verification_lease_expires_at IS NOT NULL
      AND datetime(verification_lease_expires_at)>datetime('now')`).bind(input.retryAfterSeconds, input.errorCode.toLowerCase(), row.id, input.claimToken).run();
    if (!result.meta.changes) throw new HTTPException(409, { message: "Verification lease is no longer active" });
    return { ok: true, state: "retry" };
  }
  if (input.state === "invalidate") {
    const result = await db.prepare(`UPDATE file_request_uploads SET verification_state='retry',verification_next_attempt_at=datetime('now','+' || ? || ' seconds'),
      verification_last_error_code=?,verification_claim_token=NULL,verification_lease_expires_at=NULL,${clearProofSql()},updated_at=datetime('now')
      WHERE id=? AND status='quarantined' AND verification_state='verified' AND verified_object_etag=? AND verified_object_bytes=?
        AND verified_object_version=? AND NOT (pickup_state='scanning' AND pickup_lease_expires_at IS NOT NULL AND datetime(pickup_lease_expires_at)>datetime('now'))`)
      .bind(input.retryAfterSeconds, input.errorCode.toLowerCase(), row.id, input.objectEtag.toLowerCase(), input.objectBytes, input.objectVersion ?? null).run();
    if (!result.meta.changes) throw new HTTPException(409, { message: "Verified proof is no longer current or pickup is active" });
    return { ok: true, state: "retry" };
  }
  const prior = await db.prepare(`SELECT status,verification_state verificationState,verified_sha256 verifiedSha256,verified_object_etag verifiedObjectEtag,
    verified_object_bytes verifiedObjectBytes,verified_object_version verifiedObjectVersion,verification_receipt_token verificationReceiptToken,verified_at verifiedAt
    FROM file_request_uploads WHERE id=?`).bind(row.id).first<{ status: string; verificationState: string; verifiedSha256: string | null; verifiedObjectEtag: string | null; verifiedObjectBytes: number | null; verifiedObjectVersion: string | null; verificationReceiptToken: string | null; verifiedAt: string | null }>();
  if (prior?.status === "quarantined" && prior.verificationState === "verified" && prior.verificationReceiptToken === input.claimToken
    && prior.verifiedSha256 === input.sha256.toLowerCase() && prior.verifiedObjectEtag?.toLowerCase() === input.objectEtag.toLowerCase()
    && prior.verifiedObjectBytes === input.objectBytes && (!input.objectVersion || prior.verifiedObjectVersion === input.objectVersion)) {
    const current = await env.INCOMING_BUCKET.head(row.objectKey);
    if (current && current.size === prior.verifiedObjectBytes && current.etag.toLowerCase() === prior.verifiedObjectEtag.toLowerCase() && current.version === prior.verifiedObjectVersion)
      return { ok: true, state: "verified", verifiedAt: prior.verifiedAt, replayed: true };
  }
  const object = await env.INCOMING_BUCKET.head(row.objectKey);
  if (!object || !matches(object, input)) throw new HTTPException(409, { message: "Quarantined object identity changed" });
  const result = await db.prepare(`UPDATE file_request_uploads SET verification_state='verified',verified_sha256=?,verified_object_etag=?,
    verified_object_bytes=?,verified_object_version=?,verified_at=datetime('now'),verification_next_attempt_at=NULL,verification_last_error_code=NULL,
    verification_claim_token=NULL,verification_lease_expires_at=NULL,verification_receipt_token=?,updated_at=datetime('now') WHERE id=? AND status='quarantined'
    AND verification_state='scanning' AND verification_claim_token=? AND verification_lease_expires_at IS NOT NULL
    AND datetime(verification_lease_expires_at)>datetime('now')`).bind(input.sha256.toLowerCase(), object.etag.toLowerCase(), object.size, object.version, input.claimToken, row.id, input.claimToken).run();
  if (!result.meta.changes) throw new HTTPException(409, { message: "Verification lease is no longer active" });
  const verified = await db.prepare("SELECT verified_at verifiedAt FROM file_request_uploads WHERE id=? AND verification_state='verified'").bind(row.id).first<{ verifiedAt: string }>();
  return { ok: true, state: "verified", verifiedAt: verified?.verifiedAt, replayed: false };
}
