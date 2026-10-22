import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isMovedSourceMarker } from "@ltds/shared";
import type { Env } from "../types";
import { isHiddenKey, parseRange, safeFileName, validateRelativePath } from "../files";
import { nativeDeliveryDeploymentEnabled } from "../operations-native-delivery-deployment";
import { resolveCloudflareRecipientEnrollmentProof } from "./access-identity";
import { authorizeWindowsPortalSuccessor, type WindowsPortalSuccessorContext } from "./windows-portal-successor-authorization";
import { decodeWindowsPortalSuccessorHandle, encodeWindowsPortalSuccessorHandle,
  windowsPortalSuccessorHandleMatchesContext, type WindowsPortalSuccessorHandle } from "./windows-portal-successor-handles";
import { appendWindowsPortalSuccessorContentStart, type WindowsPortalSuccessorContentAuditEnv } from "./windows-portal-successor-content-audit";
import type { VerifiedClientPrincipal } from "./types";

type Principal = Pick<VerifiedClientPrincipal, "issuer" | "subject">;
export type WindowsPortalSuccessorRouteEnv = Parameters<typeof authorizeWindowsPortalSuccessor>[0] & WindowsPortalSuccessorContentAuditEnv & Env;
type Human = { principal: VerifiedClientPrincipal; verifiedUntil: string };
type FileRow = { r2_key: string; etag: string; size: number; content_type: string | null };
const BASE = "/api/client/operations/data/windows-successor";
const visibleSql = `instr(lower('/'||f.r2_key||'/'),'/_ltds/')=0 AND instr(lower('/'||f.r2_key||'/'),'/.previews/')=0
  AND instr(lower('/'||f.r2_key||'/'),'/dump/')=0 AND NOT EXISTS(SELECT 1 FROM delivery_tombstones t
    WHERE t.restored_at IS NULL AND (t.physical_key=f.r2_key OR (t.tombstone_kind='prefix' AND substr(f.r2_key,1,length(t.physical_key))=t.physical_key)))`;
function fail(status: 400 | 401 | 403 | 404 | 412 | 503): never { throw new HTTPException(status, { message: "Windows download is unavailable" }); }
function live(until: number, signal?: AbortSignal) {
  if (!Number.isSafeInteger(until) || until <= Date.now()) return fail(401);
  if (signal?.aborted) return fail(404);
}
function sameContext(a: WindowsPortalSuccessorContext, b: WindowsPortalSuccessorContext): boolean {
  return a.originalRequestFingerprint === b.originalRequestFingerprint && a.selectedR2Prefix === b.selectedR2Prefix
    && a.continuity.grantOperationId === b.continuity.grantOperationId && a.continuity.grantFingerprint === b.continuity.grantFingerprint
    && a.continuity.chainSha256 === b.continuity.chainSha256 && a.continuity.publicationCount === b.continuity.publicationCount
    && ["first", "current"].every(which => {
      const k = which as "first" | "current";
      return Object.entries(a.continuity[k]).every(([name, value]) => b.continuity[k][name as keyof typeof b.continuity.current] === value);
    });
}
async function current(env: WindowsPortalSuccessorRouteEnv, expected: WindowsPortalSuccessorContext, principal: Principal,
  until: number, signal?: AbortSignal): Promise<WindowsPortalSuccessorContext> {
  live(until, signal);
  const proof = await authorizeWindowsPortalSuccessor(env, principal, expected.originalGrant.authority.authorityId);
  live(until, signal);
  if (!proof.ok) return fail(proof.code === "unavailable" ? 503 : 404);
  if (!sameContext(expected, proof.successorContext)) return fail(404);
  return proof.successorContext;
}
async function index(env: WindowsPortalSuccessorRouteEnv, context: WindowsPortalSuccessorContext, path: string): Promise<FileRow> {
  if (!path || path.length > 1024 || validateRelativePath(path) !== path || isHiddenKey(path)) return fail(404);
  const key = context.selectedR2Prefix + path;
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT f.r2_key,f.etag,f.size,f.content_type
    FROM file_index f WHERE f.r2_key=? AND ${visibleSql}`).bind(key).first<FileRow>();
  if (!row || row.r2_key !== key || typeof row.etag !== "string" || !row.etag || row.etag.length > 256
    || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > 2 ** 40) return fail(404);
  return row;
}
function checksum(object: R2Object): string | null {
  const sha = object.checksums?.sha256;
  return sha?.byteLength === 32 ? [...new Uint8Array(sha)].map(v => v.toString(16).padStart(2, "0")).join("") : null;
}
function objectMatches(object: R2Object | null, row: FileRow, handle?: WindowsPortalSuccessorHandle): object is R2Object {
  return !!object && !isMovedSourceMarker(object) && object.httpEtag === `"${object.etag}"`
    && /^"[\x21\x23-\x7e]+"$/u.test(object.httpEtag) && object.httpEtag.length <= 256
    && (row.etag === object.httpEtag || `"${row.etag}"` === object.httpEtag) && object.size === row.size
    && typeof object.version === "string" && object.version.length > 0 && object.version.length <= 256
    && object.version.trim() === object.version && !/[\u0000-\u001f\u007f]/u.test(object.version)
    && checksum(object) !== null && (!handle || object.httpEtag === handle.etag && object.version === handle.providerVersion
      && checksum(object) === handle.sha256 && object.size === handle.size);
}
function name(key: string): string {
  const bound = (value: string) => { let out = ""; for (const character of value) {
    const safe = /^[\uD800-\uDFFF]$/u.test(character) ? "_" : character; if (out.length + safe.length > 150) break; out += safe;
  } return out; };
  let result = bound((key.split("/").at(-1) ?? "").replace(/[\p{Cc}<>:"/\\|?*]/gu, "_").trim()).trim().replace(/[. ]+$/u, "");
  if (!result || result === "." || result === "..") result = "download";
  if (/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(result) || result === ".ltds-downloads-v1") result = bound(`_${result}`);
  return result;
}
async function logicalId(env: WindowsPortalSuccessorRouteEnv, context: WindowsPortalSuccessorContext, path: string): Promise<string> {
  const secret = env.DELIVERY_SESSION_SECRET; if (!secret || secret.length < 32) return fail(503);
  const g = context.originalGrant, e = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", e.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // Exact ordinary desktop identity domain/material: publication renewal must not create a new queued resource.
  const material = JSON.stringify([g.recipient.issuer, g.recipient.subject, g.authority.authorityId, g.target.targetId, g.resource.clientFolderBindingId, path]);
  const digest = await crypto.subtle.sign("HMAC", key, e.encode(`operations-native-desktop-logical-file-v1\0${material}`));
  return "ondf1_" + [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("");
}

/** Source-only helper for future queue resolution. Epoch-ms human expiry must come from verified Access.
 * No caller-provided original context is upgraded silently to a later publication. */
export async function prepareWindowsPortalSuccessorManifest(env: WindowsPortalSuccessorRouteEnv, context: WindowsPortalSuccessorContext,
  principal: Principal, verifiedUntil: number, path: string, signal?: AbortSignal): Promise<Response> {
  const expected = structuredClone(context), person = { issuer: principal.issuer, subject: principal.subject };
  let proof = await current(env, expected, person, verifiedUntil, signal);
  const row = await index(env, proof, path);
  proof = await current(env, expected, person, verifiedUntil, signal);
  const head = await env.DATA_BUCKET.head(row.r2_key);
  if (!objectMatches(head, row)) return fail(404);
  const pins = { path, etag: head.httpEtag, providerVersion: head.version, sha256: checksum(head)!, size: head.size };
  proof = await current(env, expected, person, verifiedUntil, signal);
  const after = await index(env, proof, path);
  if (after.etag !== row.etag || after.size !== row.size) return fail(404);
  const token = await encodeWindowsPortalSuccessorHandle(env, proof, person, verifiedUntil, pins);
  const handle = await decodeWindowsPortalSuccessorHandle(env, token); if (!handle) return fail(404);
  const logicalFileId = await logicalId(env, proof, path);
  proof = await current(env, expected, person, verifiedUntil, signal);
  if (!await windowsPortalSuccessorHandleMatchesContext(handle, proof, person, verifiedUntil)) return fail(404);
  live(verifiedUntil, signal);
  return Response.json({ schemaVersion: 1, logicalFileId, remoteVersion: pins.providerVersion, strongETag: pins.etag,
    size: pins.size, sha256: pins.sha256, name: name(row.r2_key), downloadPath: `${BASE}/files/${token}/download`,
    expiresAt: Math.floor(handle.expires / 1000) });
}

/** No production index imports/mounts this router. Dedicated successor selectors/audit only. */
export function createWindowsPortalSuccessorRouter(input: Readonly<{ enabled: boolean; portalOrigin: string; issuer: string; audience: string }>) {
  const config = Object.freeze({ ...input });
  const router = new Hono<{ Bindings: WindowsPortalSuccessorRouteEnv; Variables: { human: Human } }>().basePath(BASE);
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store"); c.header("Cloudflare-CDN-Cache-Control", "no-store"); c.header("X-Content-Type-Options", "nosniff");
    if (config.enabled !== true || c.env.CLIENT_PORTAL_ENABLED !== "true" || !nativeDeliveryDeploymentEnabled(c.env)
      || c.env.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED !== "true" || c.env.CLIENT_PORTAL_ORIGIN !== config.portalOrigin
      || c.env.CLIENT_ACCESS_TEAM_DOMAIN?.replace(/\/$/u, "") !== config.issuer) return fail(503);
    if (new URL(c.req.url).origin !== config.portalOrigin || c.req.header("Origin") !== undefined && c.req.header("Origin") !== config.portalOrigin
      || c.req.header("Sec-Fetch-Site")?.toLowerCase() === "cross-site") return fail(403);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.body(null, 405);
    if (new URL(c.req.url).search) return fail(400);
    const human = await resolveCloudflareRecipientEnrollmentProof(c.req.raw, { ...c.env, CLIENT_ACCESS_AUD: config.audience, CLIENT_ACCESS_AUDS: config.audience });
    if (!human) return fail(401); live(Date.parse(human.verifiedUntil), c.req.raw.signal);
    c.set("human", human); return next();
  });
  router.on(["GET", "HEAD"], "/files/:fileHandle/download", async c => {
    const raw = c.req.param("fileHandle");
    if (new URL(c.req.url).pathname !== `${BASE}/files/${raw}/download`) return fail(404);
    const handle = await decodeWindowsPortalSuccessorHandle(c.env, raw); if (!handle) return fail(404);
    const human = c.get("human"), until = Date.parse(human.verifiedUntil), signal = c.req.raw.signal;
    async function checked() {
      live(until, signal);
      const result = await authorizeWindowsPortalSuccessor(c.env, human.principal, handle!.authorityId);
      if (!result.ok) return fail(result.code === "unavailable" ? 503 : 404);
      if (!await windowsPortalSuccessorHandleMatchesContext(handle!, result.successorContext, human.principal, until)) return fail(404);
      live(until, signal); return result.successorContext;
    }
    async function checkedFile() {
      const proof = await checked(), row = await index(c.env, proof, handle!.path);
      if (row.size !== handle!.size || !(row.etag === handle!.etag || `"${row.etag}"` === handle!.etag)) return fail(404);
      const after = await checked(); return { context: after, row };
    }
    let selected = await checkedFile();
    const head = await c.env.DATA_BUCKET.head(selected.row.r2_key);
    if (!objectMatches(head, selected.row, handle)) return fail(404);
    selected = await checkedFile();
    if (c.req.header("If-Match") !== undefined && c.req.header("If-Match") !== handle.etag && c.req.header("If-Match") !== "*") return fail(412);
    let range: ReturnType<typeof parseRange>;
    try {
      range = parseRange(!c.req.header("If-Range") || c.req.header("If-Range") === handle.etag ? c.req.header("Range") : undefined, handle.size);
      if (range && handle.size === 0) throw Error();
    } catch {
      await checkedFile();
      return new Response(null, { status: 416, headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes */${handle.size}`, "Cache-Control": "private, no-store" } });
    }
    const downloadName = name(selected.row.r2_key), asciiName = safeFileName(downloadName).replace(/[^\x20-\x7e]/gu, "_");
    const headers = new Headers({ "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
      "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      ETag: handle.etag, "Accept-Ranges": "bytes", "Content-Length": String(range?.length ?? handle.size) });
    if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${handle.size}`);
    await checkedFile();
    if (c.req.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
    if (!range && c.req.header("If-None-Match") === handle.etag) { headers.delete("Content-Length"); return new Response(null, { status: 304, headers }); }
    const object = await c.env.DATA_BUCKET.get(selected.row.r2_key, { ...(range ? { range } : {}), onlyIf: { etagMatches: head!.etag } });
    if (!object || !("body" in object)) return fail(404);
    try {
      if (!objectMatches(object, selected.row, handle)) return fail(404);
      selected = await checkedFile();
      try { await appendWindowsPortalSuccessorContentStart(c.env, { principal: human.principal, context: selected.context,
        storageKey: selected.row.r2_key, indexedETag: selected.row.etag, strongETag: handle.etag,
        providerVersion: handle.providerVersion, sha256: handle.sha256, size: handle.size }); }
      catch { return fail(503); }
      selected = await checkedFile();
      const afterAudit = await c.env.DATA_BUCKET.head(selected.row.r2_key);
      if (!objectMatches(afterAudit, selected.row, handle)) return fail(404);
      await checkedFile(); live(until, signal);
      return new Response(object.body, { status: range ? 206 : 200, headers });
    } catch (error) { await object.body.cancel().catch(() => undefined); throw error; }
  });
  router.onError((error, c) => c.json({ error: "Windows download is unavailable" }, error instanceof HTTPException ? error.status : 503));
  return router;
}
