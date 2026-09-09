/**
 * Read-only contract for staff routes after their ACL has already succeeded.
 * Route integration MUST require `file_requests.view` (or stricter) before
 * calling either exported function. No private R2 key is returned to callers.
 */
import { HTTPException } from "hono/http-exception";
import type { IncomingEnv } from "./incoming";
import { readIncomingZipDirectory } from "./incoming-zip-directory";

type ReadyRow = { id: string; originalName: string; contentType: string; status: string; verificationState: string; requestActive: number; retained: number; actualEtag: string | null; actualBytes: number | null; objectKey: string;
  basicEtag: string | null; basicBytes: number | null; basicVersion: string | null; basicCheckVersion: string | null; journalState: string | null; sourceKey: string | null; sourceIdentity: string | null;
  destinationKey: string | null; destinationEtag: string | null; destinationBytes: number | null; destinationVersion: string | null };
type ByteRange = { offset: number; length: number };

export type IncomingRcloneReadyFacts = { promotionState: "not_started" | "pending" | "copying" | "publishing" | "ready" | "unavailable" | "failed"; objectAvailability: "present" | "missing" | "changed" | null; downloadAvailable: boolean; fileName: string; contentType: string };

async function row(env: IncomingEnv, uploadId: string): Promise<ReadyRow | null> {
  return env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT u.id,u.original_name originalName,u.content_type contentType,u.status,u.verification_state verificationState,u.etag actualEtag,u.actual_size actualBytes,u.object_key objectKey,
    CASE WHEN r.revoked_at IS NULL AND datetime(r.expires_at)>datetime('now') THEN 1 ELSE 0 END requestActive,
    CASE WHEN datetime(u.created_at,'+14 days')>datetime('now') THEN 1 ELSE 0 END retained,
    b.object_etag basicEtag,b.object_bytes basicBytes,b.object_version basicVersion,b.check_version basicCheckVersion,j.state journalState,j.source_key sourceKey,j.source_identity sourceIdentity,j.destination_key destinationKey,
    j.destination_etag destinationEtag,j.destination_bytes destinationBytes,j.destination_version destinationVersion
    FROM file_request_uploads u JOIN file_requests r ON r.id=u.request_id
    LEFT JOIN file_request_upload_basic_checks b ON b.upload_id=u.id
    LEFT JOIN file_request_upload_promotion_journal j ON j.upload_id=u.id WHERE u.id=?`).bind(uploadId).first<ReadyRow>();
}

function sourceMatchesBasic(row: ReadyRow): boolean {
  try {
    const source = JSON.parse(row.sourceIdentity || "") as Record<string, unknown>;
    return source.version === 1 && source.etag === row.basicEtag?.toLowerCase() && source.bytes === row.basicBytes && source.objectVersion === row.basicVersion;
  } catch { return false; }
}

function valid(row: ReadyRow | null): row is ReadyRow & { destinationKey: string; destinationEtag: string; destinationBytes: number; destinationVersion: string } {
  return !!row && row.status === "quarantined" && row.verificationState !== "rejected" && row.requestActive === 1
    && row.retained === 1 && row.basicEtag !== null && row.basicBytes !== null && row.basicVersion !== null && row.basicCheckVersion === "basic-v1" && row.basicEtag.toLowerCase() === row.actualEtag?.toLowerCase() && row.basicBytes === row.actualBytes
    && row.sourceKey === row.objectKey && sourceMatchesBasic(row) && row.journalState === "ready"
    && !!row.destinationKey && !!row.destinationEtag && row.destinationBytes !== null && Number.isSafeInteger(row.destinationBytes) && row.destinationBytes > 0 && !!row.destinationVersion;
}

function sameDestination(object: R2Object, expected: ReadyRow & { destinationEtag: string; destinationBytes: number; destinationVersion: string }): boolean {
  return object.size === expected.destinationBytes && object.etag.toLowerCase() === expected.destinationEtag.toLowerCase() && object.version === expected.destinationVersion;
}

function parseRange(value: string | null, size: number): ByteRange | null | "invalid" {
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
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Detail path: only HEADs a confirmed destination; it never reads bytes. */
export async function readIncomingRcloneReadyFacts(env: IncomingEnv, uploadId: string): Promise<IncomingRcloneReadyFacts> {
  const current = await row(env, uploadId);
  if (!current) throw new HTTPException(404, { message: "Incoming upload not found" });
  const base = { fileName: current.originalName, contentType: current.contentType };
  const promotionState = current.journalState && ["pending", "copying", "publishing", "ready", "unavailable", "failed"].includes(current.journalState)
    ? current.journalState as IncomingRcloneReadyFacts["promotionState"] : "not_started";
  if (!valid(current)) return { ...base, promotionState, objectAvailability: null, downloadAvailable: false };
  const object = await env.INCOMING_BUCKET.head(current.destinationKey);
  return object && sameDestination(object, current)
    ? { ...base, promotionState, objectAvailability: "present", downloadAvailable: true }
    : { ...base, promotionState, objectAvailability: object ? "changed" : "missing", downloadAvailable: false };
}

/** Explicit download only; never falls back to the quarantined source object. */
export async function downloadIncomingRcloneReadyObject(env: IncomingEnv, uploadId: string, request: Request): Promise<Response> {
  let current = await row(env, uploadId);
  if (!valid(current)) throw new HTTPException(404, { message: "Ready upload is unavailable" });
  const head = await env.INCOMING_BUCKET.head(current.destinationKey);
  if (!head || !sameDestination(head, current)) throw new HTTPException(404, { message: "Ready upload is unavailable" });
  const requested = parseRange(request.headers.get("Range"), head.size);
  if (requested === "invalid") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head.size}`, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  const stableEtag = `"${current.destinationEtag}"`;
  const range = requested && (!request.headers.get("If-Range") || request.headers.get("If-Range") === stableEtag) ? requested : null;
  // Recheck retention, revocation, basic proof, and the ready journal just
  // before opening bytes. This protects the ordinary D1 state-transition race.
  current = await row(env, uploadId);
  if (!valid(current) || !sameDestination(head, current)) throw new HTTPException(404, { message: "Ready upload is unavailable" });
  const object = await env.INCOMING_BUCKET.get(current.destinationKey, { ...(range ? { range } : {}), onlyIf: { etagMatches: head.etag } });
  if (!object || !("body" in object)) throw new HTTPException(409, { message: "Ready upload changed while it was being opened" });
  if (!sameDestination(object, current) || object.etag.toLowerCase() !== head.etag.toLowerCase() || object.version !== head.version || object.size !== head.size) {
    await object.body.cancel().catch(() => undefined);
    throw new HTTPException(409, { message: "Ready upload changed while it was being opened" });
  }
  const headers = new Headers({ "Content-Type": current.contentType, "Content-Disposition": attachmentDisposition(current.originalName), ETag: stableEtag,
    "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Length": String(range?.length ?? head.size) });
  if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

/** Authorized staff metadata browser. Never extracts members or returns keys. */
export async function listIncomingRcloneReadyArchive(
  env: IncomingEnv, uploadId: string, path = "", query = "", cursor: string | null = null,
) {
  const q = query.toLowerCase();
  if (path.length > 2048 || q.length > 128 || (path && (path.startsWith("/") || /^[A-Za-z]:/.test(path)
    || path.includes("\\") || /[\x00-\x1f\x7f]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")))) {
    throw new HTTPException(400, { message: "Invalid archive query" });
  }
  const initial = await row(env, uploadId);
  if (!valid(initial)) throw new HTTPException(404, { message: "Ready archive is unavailable" });
  const head = await env.INCOMING_BUCKET.head(initial.destinationKey);
  if (!head || !sameDestination(head, initial)) throw new HTTPException(404, { message: "Ready archive is unavailable" });
  const scopeBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ uploadId, etag: head.etag, version: head.version, path, q })));
  const scope = [...new Uint8Array(scopeBytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  let start = 0;
  if (cursor) {
    try {
      if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      const encoded = cursor.replace(/-/g, "+").replace(/_/g, "/");
      const decoded = JSON.parse(atob(encoded + "=".repeat((4 - encoded.length % 4) % 4))) as { scope?: unknown; start?: unknown };
      if (decoded.scope !== scope || typeof decoded.start !== "number" || !Number.isInteger(decoded.start) || decoded.start < 0 || decoded.start > 40_000) throw new Error();
      start = decoded.start;
    } catch { throw new HTTPException(400, { message: "Invalid archive cursor" }); }
  }
  const assertCurrent = async () => {
    const current = await row(env, uploadId);
    if (!valid(current) || current.destinationKey !== initial.destinationKey || !sameDestination(head, current)) {
      throw new HTTPException(404, { message: "Ready archive is unavailable" });
    }
  };
  let requestedBytes = 0, reads = 0;
  const directory = await readIncomingZipDirectory(head.size, async (offset, length) => {
    requestedBytes += length; reads++;
    if (reads > 4 || requestedBytes > 4 * 1024 * 1024 + 65_557 + 76) {
      throw new HTTPException(422, { message: "Archive directory exceeds browsing limits" });
    }
    await assertCurrent();
    const object = await env.INCOMING_BUCKET.get(initial.destinationKey, {
      range: { offset, length }, onlyIf: { etagMatches: head.etag },
    });
    if (!object || !("body" in object)) throw new HTTPException(409, { message: "Ready archive changed while opening" });
    if (!sameDestination(object, initial) || !object.range || !("offset" in object.range) || !("length" in object.range)
      || object.range.offset !== offset || object.range.length !== length) {
      await object.body.cancel().catch(() => undefined);
      throw new HTTPException(409, { message: "Ready archive changed while opening" });
    }
    const reader = object.body.getReader(), bytes = new Uint8Array(length);
    let used = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (used + chunk.value.byteLength > length) throw new HTTPException(409, { message: "Invalid archive range" });
        bytes.set(chunk.value, used); used += chunk.value.byteLength;
      }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    finally { reader.releaseLock(); }
    if (used !== length) throw new HTTPException(409, { message: "Incomplete archive range" });
    return bytes;
  });
  await assertCurrent();
  const finalHead = await env.INCOMING_BUCKET.head(initial.destinationKey);
  if (!finalHead || !sameDestination(finalHead, initial)) throw new HTTPException(404, { message: "Ready archive is no longer in R2" });
  if (directory.status !== "ready") return { status: "unavailable", reason: directory.reason, items: [], nextCursor: null };
  const matches = directory.entries.filter(entry => entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === path && entry.name.toLowerCase().includes(q));
  const items = matches.slice(start, start + 100);
  const nextCursor = start + 100 < matches.length
    ? btoa(JSON.stringify({ scope, start: start + 100 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "") : null;
  return { status: "ready", items, nextCursor };
}
