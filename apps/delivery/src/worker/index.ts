import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { type DeliveryItem, type DeliveryManifest } from "@ltds/shared";
import { decodeItemRef, encodeItemRef, isHiddenKey, keyWithinRoot, kindForKey, mimeForKey, normalizeRoot, parseRange, prefixHasVisibleContent, safeFileName } from "./files";
import { createSessionCookie, hmac, parseCookie, presignR2Get, randomSecret, sha256, verifyAccessCode, verifyRotatingSessionCookie } from "./security";
import { matchesEtag, servePreparedImage } from "./prepared-images";
import { recordFirstAccessNotification } from "./notifications";
import type { Env, ShareRow } from "./types";
export { BulkDownloadWorkflow } from "./workflow";

type Variables = { share: ShareRow };
interface Tombstone { physical_key: string; tombstone_kind: "exact" | "prefix"; }
const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const COOKIE_NAME = "__Host-ltds_delivery";

export function framePolicyForPath(path: string, method = "GET"): { frameAncestors: "'self'" | "'none'"; xFrameOptions: "SAMEORIGIN" | "DENY" } {
  const inlinePdf = (method === "GET" || method === "HEAD") && /^\/api\/public\/shares\/[^/]+\/items\/[^/]+\/pdf$/.test(path);
  return inlinePdf
    ? { frameAncestors: "'self'", xFrameOptions: "SAMEORIGIN" }
    : { frameAncestors: "'none'", xFrameOptions: "DENY" };
}

function sessionDb<T extends { prepare: (...args: any[]) => any }>(db: T): T {
  const candidate = db as T & { withSession?: (consistency: "first-primary") => T };
  return typeof candidate.withSession === "function" ? candidate.withSession("first-primary") : db;
}

function primaryDb(env: Pick<Env, "DELIVERY_DB">): D1Database {
  return sessionDb(env.DELIVERY_DB);
}

const lockedSecurityHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"], imgSrc: ["'self'", "https://ledgetopdroneservices.com", "https://*.cloudflarestream.com", "data:"], styleSrc: ["'self'", "'unsafe-inline'"],
    scriptSrc: ["'self'"], connectSrc: ["'self'", "https://*.cloudflarestream.com"], mediaSrc: ["'self'", "https://*.cloudflarestream.com", "blob:"], frameSrc: ["'self'", "https://*.cloudflarestream.com"], frameAncestors: ["'none'"],
    baseUri: ["'none'"], objectSrc: ["'none'"], formAction: ["'self'"],
  },
  referrerPolicy: "no-referrer",
  xContentTypeOptions: "nosniff",
  xFrameOptions: "DENY",
  xXssProtection: false,
});
const frameablePdfSecurityHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"], imgSrc: ["'self'", "https://ledgetopdroneservices.com", "https://*.cloudflarestream.com", "data:"], styleSrc: ["'self'", "'unsafe-inline'"],
    scriptSrc: ["'self'"], connectSrc: ["'self'", "https://*.cloudflarestream.com"], mediaSrc: ["'self'", "https://*.cloudflarestream.com", "blob:"], frameSrc: ["'self'", "https://*.cloudflarestream.com"], frameAncestors: ["'self'"],
    baseUri: ["'none'"], objectSrc: ["'none'"], formAction: ["'self'"],
  },
  referrerPolicy: "no-referrer",
  xContentTypeOptions: "nosniff",
  xFrameOptions: "SAMEORIGIN",
  xXssProtection: false,
});
app.use("*", (c, next) => framePolicyForPath(c.req.path, c.req.method).xFrameOptions === "SAMEORIGIN"
  ? frameablePdfSecurityHeaders(c, next)
  : lockedSecurityHeaders(c, next));

app.use("*", async (c, next) => {
  if (c.env.ENVIRONMENT === "production" && new URL(c.req.url).host !== c.env.EXPECTED_HOST) return c.json({ error: "Not found" }, 404);
  await next();
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("X-Robots-Tag", "noindex, nofollow");
  if (c.req.path.startsWith("/api/")) {
    c.header("Cloudflare-CDN-Cache-Control", "no-store");
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  }
});

function activeShareSql(extra: string): string {
  return `SELECT s.id,s.public_id,s.project_id,s.token_hash,s.label,s.password_hash,s.password_salt,s.password_iterations,s.password_algorithm,s.expires_at,s.revoked_at,s.revoked_reason,s.unavailable_since,s.share_version,s.recipient_email,
    p.client_name,p.project_name,COALESCE(s.r2_prefix,p.r2_prefix) AS r2_prefix FROM shares s JOIN projects p ON p.id=s.project_id
    WHERE ${extra} AND s.revoked_at IS NULL AND p.active=1 AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))`;
}

function unavailableShareSql(extra: string): string {
  return `SELECT s.id,s.public_id,s.project_id,s.token_hash,s.label,s.password_hash,s.password_salt,s.password_iterations,s.password_algorithm,s.expires_at,s.revoked_at,s.revoked_reason,s.unavailable_since,s.share_version,
    p.client_name,p.project_name,COALESCE(s.r2_prefix,p.r2_prefix) AS r2_prefix FROM shares s JOIN projects p ON p.id=s.project_id
    WHERE ${extra} AND s.revoked_at IS NOT NULL AND s.revoked_reason='folder_unavailable'`;
}

async function findByPublicId(env: Env, publicId: string): Promise<ShareRow | null> {
  return primaryDb(env).prepare(activeShareSql("s.public_id=?")).bind(publicId).first<ShareRow>();
}

async function findBySecret(env: Env, secret: string): Promise<ShareRow | null> {
  if (secret.length < 32 || secret.length > 128) return null;
  return primaryDb(env).prepare(activeShareSql("s.token_hash=?")).bind(await sha256(secret)).first<ShareRow>();
}

async function findUnavailableBySecret(env: Env, secret: string): Promise<ShareRow | null> {
  if (secret.length < 32 || secret.length > 128) return null;
  return primaryDb(env).prepare(unavailableShareSql("s.token_hash=?")).bind(await sha256(secret)).first<ShareRow>();
}

export async function markUnavailableFolder(env:{DELIVERY_DB:PublicIdDatabase},share:ShareRow):Promise<never>{
  const db = sessionDb(env.DELIVERY_DB);
  if(!share.revoked_at){
    const revoked=await db.prepare("UPDATE shares SET revoked_at=datetime('now'),revoked_reason='folder_unavailable' WHERE id=? AND revoked_at IS NULL AND unavailable_since IS NOT NULL AND datetime(unavailable_since)<=datetime('now','-24 hours')").bind(share.id).run();
    if(revoked.meta.changes)await db.prepare("INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('system','delivery-worker','share.auto_revoked','share',?,?)").bind(share.id,JSON.stringify({reason:"folder_unavailable",r2Prefix:share.r2_prefix})).run();
    else await db.prepare("UPDATE shares SET unavailable_since=datetime('now') WHERE id=? AND revoked_at IS NULL AND unavailable_since IS NULL").bind(share.id).run();
  }
  throw new HTTPException(410,{message:"This link is no longer valid because the shared folder was moved or removed.",cause:{code:"SHARED_FOLDER_UNAVAILABLE"}});
}

async function requireAvailableFolder(env:Env,share:ShareRow):Promise<void>{
  if(!(await prefixHasVisibleContent(env.DATA_BUCKET,share.r2_prefix)))await markUnavailableFolder(env,share);
  if(share.unavailable_since)await sessionDb(env.DELIVERY_DB).prepare("UPDATE shares SET unavailable_since=NULL WHERE id=? AND revoked_at IS NULL").bind(share.id).run();
}

interface PublicIdStatement {
  bind(...values:unknown[]):PublicIdStatement;
  run():Promise<{meta:{changes:number}}>;
  first<T>():Promise<T|null>;
}
interface PublicIdDatabase {prepare(query:string):PublicIdStatement;withSession?(consistency:"first-primary"):PublicIdDatabase}

export async function ensurePublicId(env: {DELIVERY_DB:PublicIdDatabase}, share: ShareRow): Promise<{publicId:string;shareVersion:number}> {
  const db = sessionDb(env.DELIVERY_DB);
  let expectedVersion=share.share_version;
  if (share.public_id) {
    const current=await db.prepare("SELECT public_id,share_version FROM shares WHERE id=? AND token_hash=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM projects WHERE projects.id=shares.project_id AND projects.active=1)").bind(share.id,share.token_hash).first<{public_id:string|null;share_version:number}>();
    if(current?.public_id)return{publicId:current.public_id,shareVersion:current.share_version};
    throw new HTTPException(404,{message:"This delivery link is invalid, expired, or revoked"});
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const publicId = randomSecret(16);
    const result = await db.prepare("UPDATE shares SET public_id=?,share_version=share_version+1 WHERE id=? AND token_hash=? AND public_id IS NULL AND share_version=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM projects WHERE projects.id=shares.project_id AND projects.active=1)").bind(publicId,share.id,share.token_hash,expectedVersion).run();
    if (result.meta.changes) return{publicId,shareVersion:expectedVersion+1};
    const current = await db.prepare("SELECT public_id,share_version FROM shares WHERE id=? AND token_hash=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM projects WHERE projects.id=shares.project_id AND projects.active=1)").bind(share.id,share.token_hash).first<{ public_id: string | null;share_version:number }>();
    if (current?.public_id) return{publicId:current.public_id,shareVersion:current.share_version};
    if(!current)throw new HTTPException(404,{message:"This delivery link is invalid, expired, or revoked"});
    expectedVersion=current.share_version;
  }
  throw new HTTPException(503, { message: "Delivery link could not be upgraded" });
}

async function clientHash(env: Env, request: Request): Promise<string> {
  return hmac(env.AUDIT_IP_SECRET, request.headers.get("CF-Connecting-IP") || "unknown");
}

function audit(env: Env, request: Request, shareId: string, eventType: string, itemRef?: string): Promise<unknown> {
  return clientHash(env, request).then(addressHash => primaryDb(env).prepare(
    "INSERT INTO share_events (share_id,event_type,item_ref,client_address_hash,user_agent) VALUES (?,?,?,?,?)",
  ).bind(shareId, eventType, itemRef || null, addressHash, (request.headers.get("user-agent") || "").slice(0, 240)).run());
}

async function enforceRateLimit(c: any, limiter: RateLimit, scope: string): Promise<void> {
  const addressHash = await clientHash(c.env, c.req.raw);
  const share = c.get("share") as ShareRow | undefined;
  const result = await limiter.limit({ key: `${scope}:${share?.id || "session"}:${addressHash}` });
  if (!result.success) throw new HTTPException(429, { message: "Too many requests. Please wait and try again." });
}

function baseForItem(share: ShareRow, itemRef: string): string {
  return `/api/public/shares/${encodeURIComponent(share.public_id!)}/items/${encodeURIComponent(itemRef)}`;
}

export function sourceUrlForItem(base: string, kind: DeliveryItem["kind"]): string | undefined {
  if (!["image", "video", "audio", "pdf", "text"].includes(kind)) return undefined;
  return `${base}/${kind === "pdf" ? "pdf" : "source"}`;
}

async function loadAliases(env: Env, keys: string[]): Promise<Map<string, string>> {
  const aliases = new Map<string, string>(); const unique = [...new Set(keys)];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100); if (!batch.length) continue;
    const result = await primaryDb(env).prepare(`SELECT physical_key,display_name FROM file_aliases WHERE physical_key IN (${batch.map(() => "?").join(",")})`).bind(...batch).all<{ physical_key: string; display_name: string }>();
    for (const row of result.results) aliases.set(row.physical_key, row.display_name);
  }
  return aliases;
}

async function loadTombstones(env: Env): Promise<Tombstone[]> {
  const result = await primaryDb(env).prepare("SELECT physical_key,tombstone_kind FROM delivery_tombstones WHERE restored_at IS NULL").all<Tombstone>();
  return result.results;
}

function isTrashed(tombstones: Tombstone[], key: string): boolean {
  return tombstones.some(tombstone => tombstone.tombstone_kind === "exact" ? tombstone.physical_key === key : key.startsWith(tombstone.physical_key));
}

async function assertNotTrashed(env: Env, key: string): Promise<void> {
  if (isTrashed(await loadTombstones(env), key)) throw new HTTPException(404, { message: "File not found" });
}

function aliasedPath(key: string, root: string, aliases: Map<string, string>): string {
  const relative = key.slice(root.length).replace(/\/$/, ""); const parts = relative.split("/"); const names: string[] = []; let physical = root;
  parts.forEach((part, index) => { physical += part; names.push(aliases.get(physical + (index === parts.length - 1 ? "" : "/")) || part); physical += "/"; });
  return names.join("/");
}

async function requirePreparedImage(c: any, key: string, variant: "thumbnail" | "preview" | "poster"): Promise<Response> {
  return servePreparedImage({
    bucket: c.env.DATA_BUCKET,
    database: primaryDb(c.env),
    ifNoneMatch: c.req.header("If-None-Match"),
  }, key, variant);
}

async function preparedOrOriginalImage(c: any, key: string, variant: "thumbnail" | "preview"): Promise<Response> {
  try {
    return await requirePreparedImage(c, key, variant);
  } catch (error) {
    if (!(error instanceof HTTPException) || error.status !== 404) throw error;
  }
  return streamItem(c, "inline", true);
}

app.get("/health", c => c.json({ status: "ok", service: "ltds-delivery" }));

export async function serveAppShell(request: Request, assets: Pick<Fetcher, "fetch">): Promise<Response> {
  const response = await assets.fetch(request);
  const headers = new Headers(response.headers); headers.set("Cache-Control", "no-store"); headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, { status: response.status, headers });
}

app.get("/s/:publicId", c => serveAppShell(c.req.raw, c.env.ASSETS));

app.post("/api/public/shares/:routeId/session", async c => {
  await enforceRateLimit(c, c.env.PUBLIC_SESSION_RATE_LIMITER, "session");
  const body: { secret?: string; accessCode?: string } = await c.req.json<{ secret?: string; accessCode?: string }>().catch(() => ({}));
  const routeId = c.req.param("routeId");
  const candidateSecret = body.secret || (routeId.length > 30 ? routeId : "");
  const byPublic = routeId.length <= 30 ? await findByPublicId(c.env, routeId) : null;
  const share = candidateSecret ? await findBySecret(c.env, candidateSecret) : null;
  if (!share || (byPublic && byPublic.id !== share.id)) {
    const unavailable=candidateSecret?await findUnavailableBySecret(c.env,candidateSecret):null;
    if(unavailable&&(routeId.length>30||unavailable.public_id===routeId))await markUnavailableFolder(c.env,unavailable);
    throw new HTTPException(404, { message: "This delivery link is invalid, expired, or revoked" });
  }
  await requireAvailableFolder(c.env,share);

  if (share.password_hash && share.password_salt && share.password_iterations) {
    if (!body.accessCode) return c.json({ error: "Access code required", code: "ACCESS_CODE_REQUIRED" }, 401);
    const addressHash = await clientHash(c.env, c.req.raw);
    const [shareLimit, clientLimit] = await Promise.all([
      c.env.ACCESS_CODE_RATE_LIMITER.limit({ key: `${share.id}:${addressHash}` }),
      c.env.ACCESS_CODE_RATE_LIMITER.limit({ key: `client:${addressHash}` }),
    ]);
    if (!shareLimit.success || !clientLimit.success) throw new HTTPException(429, { message: "Too many attempts. Please wait before trying again." });
    let validCode = await verifyAccessCode(body.accessCode, share.password_hash, share.password_salt, share.password_iterations,share.password_algorithm,c.env.DELIVERY_ACCESS_CODE_PEPPER);
    if (!validCode && c.env.DELIVERY_PREVIOUS_ACCESS_CODE_PEPPER) {
      validCode = await verifyAccessCode(body.accessCode, share.password_hash, share.password_salt, share.password_iterations,share.password_algorithm,c.env.DELIVERY_PREVIOUS_ACCESS_CODE_PEPPER);
      if (validCode) {
        const nextSalt = randomSecret(16);
        const nextHash = await hmac(c.env.DELIVERY_ACCESS_CODE_PEPPER, `access-code:v1:${nextSalt}:${body.accessCode}`);
        await primaryDb(c.env).prepare("UPDATE shares SET password_hash=?,password_salt=?,password_iterations=1,password_algorithm='hmac-sha256-v1',share_version=share_version+1 WHERE id=? AND password_hash=? AND revoked_at IS NULL")
          .bind(nextHash, nextSalt, share.id, share.password_hash).run();
      }
    }
    if (!validCode) {
      c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, "unlock.failed"));
      return c.json({ error: "The access code is not correct", code: "ACCESS_CODE_INVALID" }, 401);
    }
  }

  const route = await ensurePublicId(c.env, share);
  const shareExpiry = share.expires_at ? new Date(share.expires_at).getTime() : Number.POSITIVE_INFINITY;
  const expiresAt = Math.min(Date.now() + 12 * 60 * 60 * 1000, shareExpiry);
  c.header("Set-Cookie", await createSessionCookie(c.env.DELIVERY_SESSION_SECRET, c.env.SESSION_KEY_ID, share.id,route.shareVersion, expiresAt));
  c.executionCtx.waitUntil(recordFirstAccessNotification(c.env, share));
  c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, "session.created"));
  return c.json({ publicId:route.publicId, canonicalPath: `/s/${route.publicId}` });
});

app.use("/api/public/shares/:publicId/*", async (c, next) => {
  // The signed cookie is only a transport credential. D1 remains the first
  // primary authorization source for every protected public request.
  const session = await verifyRotatingSessionCookie(
    parseCookie(c.req.header("Cookie"), COOKIE_NAME),
    { keyId: c.env.SESSION_KEY_ID, secret: c.env.DELIVERY_SESSION_SECRET },
    c.env.PREVIOUS_SESSION_KEY_ID && c.env.DELIVERY_PREVIOUS_SESSION_SECRET
      ? { keyId: c.env.PREVIOUS_SESSION_KEY_ID, secret: c.env.DELIVERY_PREVIOUS_SESSION_SECRET }
      : null,
  );
  const share = await primaryDb(c.env).prepare(activeShareSql("s.id=? AND s.public_id=? AND s.share_version=?")).bind(session.shareId, c.req.param("publicId"),session.shareVersion).first<ShareRow>();
  if (!share){const unavailable=await primaryDb(c.env).prepare(unavailableShareSql("s.id=? AND s.public_id=?")).bind(session.shareId,c.req.param("publicId")).first<ShareRow>();if(unavailable)await markUnavailableFolder(c.env,unavailable);throw new HTTPException(404, { message: "This delivery link is invalid, expired, or revoked" });}
  c.set("share", share);
  const path = c.req.path;
  const [limiter,scope]:[RateLimit,string] = path.includes("/bulk-download") ? [c.env.PUBLIC_BULK_RATE_LIMITER,"bulk"]
    : path.endsWith("/manifest") ? [c.env.PUBLIC_MANIFEST_RATE_LIMITER,"manifest"]
    : path.endsWith("/thumbnail") ? [c.env.PUBLIC_THUMBNAIL_RATE_LIMITER,"thumbnail"]
    : path.endsWith("/stream-ticket") ? [c.env.PUBLIC_STREAM_RATE_LIMITER,"stream"]
    : path.endsWith("/download") || path.endsWith("/download-ticket") ? [c.env.PUBLIC_DOWNLOAD_RATE_LIMITER,"download"]
    : [c.env.PUBLIC_MEDIA_RATE_LIMITER,"media"];
  await enforceRateLimit(c, limiter, scope);
  await next();
});

app.get("/api/public/shares/:publicId/manifest", async c => {
  const share = c.get("share"); await requireAvailableFolder(c.env,share); const root = normalizeRoot(share.r2_prefix); const tombstones = await loadTombstones(c.env);
  const folderRef = c.req.query("folder") || ""; const relativeFolder = folderRef ? decodeItemRef(folderRef) : "";
  const prefix = relativeFolder ? `${keyWithinRoot(root, relativeFolder).replace(/\/$/, "")}/` : root;
  const listed = await c.env.DATA_BUCKET.list({ prefix, delimiter: "/", limit: 500, cursor: c.req.query("cursor") });
  const aliasKeys = [root, prefix, ...listed.delimitedPrefixes, ...listed.objects.map(object => object.key)]; let breadcrumbPhysical = root;
  for (const segment of relativeFolder.split("/").filter(Boolean)) { breadcrumbPhysical += `${segment}/`; aliasKeys.push(breadcrumbPhysical); }
  const aliases = await loadAliases(c.env, aliasKeys);
  const items: DeliveryItem[] = [];
  for (const folderPrefix of listed.delimitedPrefixes) {
    if (isHiddenKey(folderPrefix) || isTrashed(tombstones, folderPrefix)) continue;
    const relative = folderPrefix.slice(root.length).replace(/\/$/, ""); if (!relative) continue;
    items.push({ id: encodeItemRef(relative), name: aliases.get(folderPrefix) || relative.split("/").pop() || relative, kind: "folder", size: null, uploadedAt: null });
  }
  const videos: Array<{ index: number; key: string }> = [];
  for (const object of listed.objects) {
    if (object.key === prefix || object.key.endsWith("/") || isHiddenKey(object.key) || isTrashed(tombstones, object.key)) continue;
    const relative = object.key.slice(root.length); const id = encodeItemRef(relative); const kind = kindForKey(object.key);
    const base = `/api/public/shares/${encodeURIComponent(share.public_id!)}/items/${id}`;
    const item: DeliveryItem = { id, name: aliases.get(object.key) || relative.split("/").pop() || relative, kind, size: object.size, uploadedAt: object.uploaded.toISOString(), downloadUrl: `${base}/download`, previewStatus: kind === "video" ? "processing" : undefined };
    if (["image", "audio", "text"].includes(kind)) item.previewUrl = `${base}/preview`;
    item.sourceUrl = sourceUrlForItem(base, kind);
    if (kind === "image" || kind === "video" || kind === "pdf") item.thumbnailUrl = `${base}/thumbnail`;
    if (kind === "video") item.previewUrl = undefined;
    if (kind === "video") videos.push({ index: items.length, key: object.key });
    items.push(item);
  }
  if (videos.length) {
    const db = primaryDb(c.env); const records = await db.batch(videos.map(video => db.prepare("SELECT stream_uid,stream_status FROM file_index WHERE r2_key=?").bind(video.key)));
    await Promise.all(records.map(async (result, index) => {
      const row = result.results[0] as { stream_uid?: string; stream_status?: string } | undefined; const item = items[videos[index]!.index];
      if (item && row?.stream_status === "ready" && row.stream_uid) item.previewStatus = "ready";
    }));
  }
  const breadcrumbs: Array<{ id: string; name: string }> = []; let built = "";
  let physicalBreadcrumb = root;
  for (const segment of relativeFolder.split("/").filter(Boolean)) { built = built ? `${built}/${segment}` : segment; physicalBreadcrumb += `${segment}/`; breadcrumbs.push({ id: encodeItemRef(built), name: aliases.get(physicalBreadcrumb) || segment }); }
  const currentPhysical = relativeFolder ? prefix : root;
  const manifest: DeliveryManifest = { share: { publicId: share.public_id!, label: share.label, clientName: share.client_name, projectName: aliases.get(root) || share.project_name, expiresAt: share.expires_at }, folder: { id: folderRef, name: aliases.get(currentPhysical) || relativeFolder.split("/").pop() || share.project_name, breadcrumbs }, items, nextCursor: listed.truncated ? listed.cursor : null };
  c.executionCtx.waitUntil(Promise.all([audit(c.env, c.req.raw, share.id, "manifest.viewed", folderRef), primaryDb(c.env).prepare("UPDATE shares SET access_count=access_count+1,last_accessed_at=datetime('now') WHERE id=?").bind(share.id).run()]));
  return c.json(manifest);
});

export async function streamItem(c: any, disposition: "inline" | "attachment", raw = false, requiredKind?: "pdf"): Promise<Response> {
  const share = c.get("share") as ShareRow; const itemRef = c.req.param("itemRef") as string; const relative = decodeItemRef(itemRef); const key = keyWithinRoot(share.r2_prefix, relative);
  await assertNotTrashed(c.env, key);
  const kind = kindForKey(key);
  if (requiredKind && kind !== requiredKind) throw new HTTPException(415, { message: "PDF preview is not available for this file" });
  if (disposition === "inline" && !["image", "video", "audio", "pdf", "text"].includes(kind)) throw new HTTPException(415, { message: "Preview is not available for this file" });
  const head = await c.env.DATA_BUCKET.head(key); if (!head) throw new HTTPException(404, { message: "File not found" });
  if (!raw && disposition === "inline" && (kind === "image" || kind === "pdf")) return requirePreparedImage(c, key, "preview");
  if (!raw && disposition === "inline" && kind === "video") throw new HTTPException(409, { message: "Video preview is available through Stream" });
  let range: { offset: number; length: number } | undefined;
  const rangeHeader = c.req.header("Range"), ifRange = c.req.header("If-Range");
  try { range = parseRange(!ifRange || matchesEtag(ifRange, head.httpEtag) ? rangeHeader : undefined, head.size); } catch (error) { if (error instanceof HTTPException && error.status === 416) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head.size}`, "Accept-Ranges": "bytes" } }); throw error; }
  const headers = new Headers(); head.writeHttpMetadata(headers); headers.set("Content-Type", mimeForKey(key)); headers.set("ETag", head.httpEtag); headers.set("Accept-Ranges", "bytes"); headers.set("Cache-Control", disposition === "inline" ? "private, no-cache" : "private, no-store"); headers.set("X-Content-Type-Options", "nosniff"); headers.set("Content-Disposition", `${disposition}; filename="${safeFileName(key)}"`);
  if (range) { headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`); headers.set("Content-Length", String(range.length)); } else headers.set("Content-Length", String(head.size));
  if (!range && disposition === "inline" && matchesEtag(c.req.header("If-None-Match"), head.httpEtag)) { headers.delete("Content-Length"); return new Response(null, { status: 304, headers }); }
  if (c.req.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
  const object = await c.env.DATA_BUCKET.get(key, range ? { range } : undefined); if (!object) throw new HTTPException(404, { message: "File not found" });
  c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, disposition === "attachment" ? "download.started" : "preview.viewed", itemRef));
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

app.on(["GET", "HEAD"], "/api/public/shares/:publicId/items/:itemRef/preview", async c => {
  const share = c.get("share"); const itemRef = c.req.param("itemRef"); const key = keyWithinRoot(share.r2_prefix, decodeItemRef(itemRef));
  await assertNotTrashed(c.env, key);
  const kind = kindForKey(key);
  if (kind === "image") return preparedOrOriginalImage(c, key, "preview");
  if (kind === "pdf") return requirePreparedImage(c, key, "preview");
  if (kind === "audio" || kind === "text") return streamItem(c, "inline", true);
  throw new HTTPException(415, { message: "Preview unavailable" });
});

app.on(["GET", "HEAD"], "/api/public/shares/:publicId/items/:itemRef/source", c => streamItem(c, "inline", true));
app.on(["GET", "HEAD"], "/api/public/shares/:publicId/items/:itemRef/pdf", c => streamItem(c, "inline", true, "pdf"));

async function downloadTicket(c: any): Promise<{ url: string; expiresAt: string }> {
  const share = c.get("share") as ShareRow; const itemRef = c.req.param("itemRef") as string; const key = keyWithinRoot(share.r2_prefix, decodeItemRef(itemRef));
  await assertNotTrashed(c.env, key);
  const head = await c.env.DATA_BUCKET.head(key); if (!head) throw new HTTPException(404, { message: "File not found" });
  if (!c.env.R2_S3_ENDPOINT || !c.env.R2_BUCKET_NAME || !c.env.R2_ACCESS_KEY_ID || !c.env.R2_SECRET_ACCESS_KEY) throw new HTTPException(503, { message: "Downloads are temporarily unavailable" });
  const alias = await primaryDb(c.env).prepare("SELECT display_name FROM file_aliases WHERE physical_key=?").bind(key).first<{display_name:string}>();
  const ticket = await presignR2Get({ endpoint: c.env.R2_S3_ENDPOINT, bucket: c.env.R2_BUCKET_NAME, accessKeyId: c.env.R2_ACCESS_KEY_ID, secretAccessKey: c.env.R2_SECRET_ACCESS_KEY, expiresInSeconds: 120, downloadName: alias?.display_name || safeFileName(key) }, key);
  c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, "download.started", itemRef));
  return ticket;
}

app.get("/api/public/shares/:publicId/items/:itemRef/download-ticket", async c => c.json(await downloadTicket(c)));
app.get("/api/public/shares/:publicId/items/:itemRef/download", async c => c.redirect((await downloadTicket(c)).url, 302));

async function createStreamTicket(c: any): Promise<{ url: string; expiresAt: string }> {
  const share = c.get("share") as ShareRow; const itemRef = c.req.param("itemRef") as string; const key = keyWithinRoot(share.r2_prefix, decodeItemRef(itemRef));
  await assertNotTrashed(c.env, key);
  if (kindForKey(key) !== "video") throw new HTTPException(415, { message: "Stream preview unavailable" });
  const row = await primaryDb(c.env).prepare("SELECT stream_uid,stream_status FROM file_index WHERE r2_key=?").bind(key).first<{ stream_uid: string | null; stream_status: string | null }>();
  if (row?.stream_status !== "ready" || !row.stream_uid || !c.env.STREAM_CUSTOMER_CODE) throw new HTTPException(404, { message: "Video preview unavailable" });
  const token = await c.env.STREAM.video(row.stream_uid).generateToken();
  c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, "preview.viewed", itemRef));
  return { url: `https://customer-${c.env.STREAM_CUSTOMER_CODE}.cloudflarestream.com/${token}/iframe`, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
}

app.post("/api/public/shares/:publicId/items/:itemRef/stream-ticket", async c => c.json(await createStreamTicket(c)));

app.get("/api/public/shares/:publicId/items/:itemRef/thumbnail", async c => {
  const share = c.get("share"); const itemRef = c.req.param("itemRef"); const key = keyWithinRoot(share.r2_prefix, decodeItemRef(itemRef));
  await assertNotTrashed(c.env, key);
  if (!(await c.env.DATA_BUCKET.head(key))) throw new HTTPException(404, { message: "File not found" });
  if (kindForKey(key) === "image") return requirePreparedImage(c, key, "thumbnail");
  if (kindForKey(key) === "pdf") return requirePreparedImage(c, key, "thumbnail");
  if (kindForKey(key) === "video") return requirePreparedImage(c, key, "poster");
  throw new HTTPException(415, { message: "Thumbnail unavailable" });
});

async function consumeBulkQuota(c: any, share: ShareRow): Promise<void> {
  const windowStart = Math.floor(Date.now() / (60 * 60 * 1000));
  const result = await primaryDb(c.env).prepare(`INSERT INTO bulk_download_quota (share_id,window_start,created_count) VALUES (?,?,1)
    ON CONFLICT(share_id,window_start) DO UPDATE SET created_count=created_count+1,updated_at=datetime('now') WHERE created_count < 3`).bind(share.id, windowStart).run();
  if (!result.meta.changes) throw new HTTPException(429, { message: "This delivery has reached its hourly bulk-download limit." });
}

function validateBulkRequest(value: unknown): { all?: boolean; items?: string[] } {
  const body = value as { all?: unknown; items?: unknown };
  if (body.all === true && body.items === undefined) return { all: true };
  if (Array.isArray(body.items) && body.items.length > 0 && body.items.length <= 2000 && body.items.every(item => typeof item === "string")) {
    const items = body.items as string[]; if (new Set(items).size !== items.length) throw new HTTPException(400, { message: "The selection contains duplicate items." });
    for (const item of items) decodeItemRef(item);
    return { items };
  }
  throw new HTTPException(400, { message: "Specify either all=true or a non-empty items selection." });
}

async function getBulkJob(c: any, jobId: string): Promise<any> {
  const share = c.get("share") as ShareRow;
  return primaryDb(c.env).prepare("SELECT id,status,file_count,processed_files,total_bytes,processed_bytes,archive_size,error_code,error_message,expires_at,archive_key FROM bulk_download_jobs WHERE id=? AND share_id=? AND share_version=?").bind(jobId, share.id, share.share_version).first<any>();
}

async function archiveTicket(c: any, job: any): Promise<{ url: string; expiresAt: string }> {
  if (!c.env.R2_S3_ENDPOINT || !c.env.R2_BUCKET_NAME || !c.env.R2_ACCESS_KEY_ID || !c.env.R2_SECRET_ACCESS_KEY) throw new HTTPException(503, { message: "Downloads are temporarily unavailable" });
  const share = c.get("share") as ShareRow;
  return presignR2Get({ endpoint: c.env.R2_S3_ENDPOINT, bucket: c.env.R2_BUCKET_NAME, accessKeyId: c.env.R2_ACCESS_KEY_ID, secretAccessKey: c.env.R2_SECRET_ACCESS_KEY, expiresInSeconds: 120, downloadName: `${share.project_name || share.client_name || "delivery"}.zip` }, job.archive_key);
}

app.post("/api/public/shares/:publicId/bulk-download", async c => {
  const share = c.get("share") as ShareRow; const request = validateBulkRequest(await c.req.json().catch(() => ({}))); await consumeBulkQuota(c, share);
  const jobId = randomSecret(16); const encodedShare = encodeURIComponent(share.public_id!); const manifestKey = `_ltds/tmp-downloads/${share.public_id}/${jobId}/manifest.json`; const archiveKey = `_ltds/tmp-downloads/${share.public_id}/${jobId}/archive.zip`; const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await primaryDb(c.env).prepare("INSERT INTO bulk_download_jobs (id,share_id,share_version,request_json,status,manifest_key,archive_key,expires_at) VALUES (?,?,?,?,?,?,?,?)").bind(jobId, share.id, share.share_version, JSON.stringify(request), "queued", manifestKey, archiveKey, expiresAt).run();
  try { await c.env.BULK_DOWNLOAD_WORKFLOW.create({ id: jobId, params: { jobId } }); }
  catch (error) { await primaryDb(c.env).prepare("UPDATE bulk_download_jobs SET status='failed',error_code='workflow-create-failed',error_message=?,updated_at=datetime('now') WHERE id=?").bind(error instanceof Error ? error.message.slice(0, 240) : "workflow-create-failed", jobId).run(); throw new HTTPException(503, { message: "The download could not be queued." }); }
  c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, "download.started", `bulk:${jobId}`));
  return c.json({ jobId, status: "queued", statusUrl: `/api/public/shares/${encodedShare}/bulk-download/${jobId}`, downloadUrl: null }, 202);
});

app.get("/api/public/shares/:publicId/bulk-download/:jobId", async c => {
  const job = await getBulkJob(c, c.req.param("jobId")); if (!job) throw new HTTPException(404, { message: "Download job not found" });
  const response: Record<string, unknown> = { jobId: job.id, status: job.status, fileCount: job.file_count, processedFiles: job.processed_files, totalBytes: job.total_bytes, processedBytes: job.processed_bytes, archiveSize: job.archive_size, expiresAt: job.expires_at, error: job.error_code ? { code: job.error_code, message: job.error_message } : null, downloadUrl: null };
  if (job.status === "ready") response.downloadUrl = (await archiveTicket(c, job)).url;
  return c.json(response);
});

app.get("/api/public/shares/:publicId/bulk-download/:jobId/file", async c => {
  const job = await getBulkJob(c, c.req.param("jobId")); if (!job || job.status !== "ready") throw new HTTPException(404, { message: "Download is not ready" });
  return c.redirect((await archiveTicket(c, job)).url, 302);
});

async function cleanupTemporaryZips(env: Env): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; let cursor: string | undefined;
  do { const listed = await env.DATA_BUCKET.list({ prefix: "_ltds/tmp-downloads/", limit: 1000, cursor }); const expired = listed.objects.filter(object => object.uploaded.getTime() < cutoff).map(object => object.key); if (expired.length) await env.DATA_BUCKET.delete(expired); cursor = listed.truncated ? listed.cursor : undefined; } while (cursor);
  await primaryDb(env).prepare("UPDATE bulk_download_jobs SET status='expired',updated_at=datetime('now') WHERE status IN ('queued','running','ready') AND datetime(expires_at)<=datetime('now')").run();
}

app.notFound(c => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  const status = error instanceof HTTPException ? error.status : 500;
  if (status >= 500) console.error(JSON.stringify({ event: "delivery.error", status, message: error instanceof Error ? error.message : "unknown" }));
  const code=error instanceof Error&&(error.cause as {code?:string}|undefined)?.code;
  return c.json({ error: status >= 500 ? "An unexpected error occurred" : error.message,...(code?{code}:{}) }, status);
});

export default { fetch: app.fetch, scheduled: (_event, env, ctx) => ctx.waitUntil(cleanupTemporaryZips(env)) } satisfies ExportedHandler<Env>;
