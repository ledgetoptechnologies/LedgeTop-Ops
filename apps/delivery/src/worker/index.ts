import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { DeliveryItem, DeliveryManifest } from "@ltds/shared";
import { decodeItemRef, encodeItemRef, isHiddenKey, keyWithinRoot, kindForKey, mimeForKey, normalizeRoot, parseRange, prefixHasVisibleContent, safeFileName } from "./files";
import { createSessionCookie, hmac, parseCookie, randomSecret, sha256, verifyAccessCode, verifySessionCookie } from "./security";
import { streamZip, type ZipSource } from "./zip";
import type { Env, ShareRow } from "./types";

type Variables = { share: ShareRow };
const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const COOKIE_NAME = "__Host-ltds_delivery";

app.use("*", secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"], imgSrc: ["'self'", "https://ledgetopdroneservices.com", "https://*.cloudflarestream.com", "data:"], styleSrc: ["'self'", "'unsafe-inline'"],
    scriptSrc: ["'self'"], connectSrc: ["'self'", "https://*.cloudflarestream.com"], mediaSrc: ["'self'", "https://*.cloudflarestream.com", "blob:"], frameSrc: ["'self'", "https://*.cloudflarestream.com"], frameAncestors: ["'none'"],
    baseUri: ["'none'"], objectSrc: ["'none'"], formAction: ["'self'"],
  },
  referrerPolicy: "no-referrer",
  xContentTypeOptions: "nosniff",
  xFrameOptions: "DENY",
  xXssProtection: false,
}));

app.use("*", async (c, next) => {
  if (c.env.ENVIRONMENT === "production" && new URL(c.req.url).host !== c.env.EXPECTED_HOST) return c.json({ error: "Not found" }, 404);
  await next();
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("X-Robots-Tag", "noindex, nofollow");
  if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
});

function activeShareSql(extra: string): string {
  return `SELECT s.id,s.public_id,s.project_id,s.token_hash,s.label,s.password_hash,s.password_salt,s.password_iterations,s.password_algorithm,s.expires_at,s.revoked_at,s.revoked_reason,s.unavailable_since,s.share_version,
    p.client_name,p.project_name,COALESCE(s.r2_prefix,p.r2_prefix) AS r2_prefix FROM shares s JOIN projects p ON p.id=s.project_id
    WHERE ${extra} AND s.revoked_at IS NULL AND p.active=1 AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))`;
}

function unavailableShareSql(extra: string): string {
  return `SELECT s.id,s.public_id,s.project_id,s.token_hash,s.label,s.password_hash,s.password_salt,s.password_iterations,s.password_algorithm,s.expires_at,s.revoked_at,s.revoked_reason,s.unavailable_since,s.share_version,
    p.client_name,p.project_name,COALESCE(s.r2_prefix,p.r2_prefix) AS r2_prefix FROM shares s JOIN projects p ON p.id=s.project_id
    WHERE ${extra} AND s.revoked_at IS NOT NULL AND s.revoked_reason='folder_unavailable'`;
}

async function findByPublicId(env: Env, publicId: string): Promise<ShareRow | null> {
  return env.DELIVERY_DB.prepare(activeShareSql("s.public_id=?")).bind(publicId).first<ShareRow>();
}

async function findBySecret(env: Env, secret: string): Promise<ShareRow | null> {
  if (secret.length < 32 || secret.length > 128) return null;
  return env.DELIVERY_DB.prepare(activeShareSql("s.token_hash=?")).bind(await sha256(secret)).first<ShareRow>();
}

async function findUnavailableBySecret(env: Env, secret: string): Promise<ShareRow | null> {
  if (secret.length < 32 || secret.length > 128) return null;
  return env.DELIVERY_DB.prepare(unavailableShareSql("s.token_hash=?")).bind(await sha256(secret)).first<ShareRow>();
}

export async function markUnavailableFolder(env:{DELIVERY_DB:PublicIdDatabase},share:ShareRow):Promise<never>{
  if(!share.revoked_at){
    const revoked=await env.DELIVERY_DB.prepare("UPDATE shares SET revoked_at=datetime('now'),revoked_reason='folder_unavailable' WHERE id=? AND revoked_at IS NULL AND unavailable_since IS NOT NULL AND datetime(unavailable_since)<=datetime('now','-24 hours')").bind(share.id).run();
    if(revoked.meta.changes)await env.DELIVERY_DB.prepare("INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('system','delivery-worker','share.auto_revoked','share',?,?)").bind(share.id,JSON.stringify({reason:"folder_unavailable",r2Prefix:share.r2_prefix})).run();
    else await env.DELIVERY_DB.prepare("UPDATE shares SET unavailable_since=datetime('now') WHERE id=? AND revoked_at IS NULL AND unavailable_since IS NULL").bind(share.id).run();
  }
  throw new HTTPException(410,{message:"This link is no longer valid because the shared folder was moved or removed.",cause:{code:"SHARED_FOLDER_UNAVAILABLE"}});
}

async function requireAvailableFolder(env:Env,share:ShareRow):Promise<void>{
  if(!(await prefixHasVisibleContent(env.DATA_BUCKET,share.r2_prefix)))await markUnavailableFolder(env,share);
  if(share.unavailable_since)await env.DELIVERY_DB.prepare("UPDATE shares SET unavailable_since=NULL WHERE id=? AND revoked_at IS NULL").bind(share.id).run();
}

interface PublicIdStatement {
  bind(...values:unknown[]):PublicIdStatement;
  run():Promise<{meta:{changes:number}}>;
  first<T>():Promise<T|null>;
}
interface PublicIdDatabase {prepare(query:string):PublicIdStatement}

export async function ensurePublicId(env: {DELIVERY_DB:PublicIdDatabase}, share: ShareRow): Promise<{publicId:string;shareVersion:number}> {
  let expectedVersion=share.share_version;
  if (share.public_id) {
    const current=await env.DELIVERY_DB.prepare("SELECT public_id,share_version FROM shares WHERE id=? AND token_hash=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM projects WHERE projects.id=shares.project_id AND projects.active=1)").bind(share.id,share.token_hash).first<{public_id:string|null;share_version:number}>();
    if(current?.public_id)return{publicId:current.public_id,shareVersion:current.share_version};
    throw new HTTPException(404,{message:"This delivery link is invalid, expired, or revoked"});
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const publicId = randomSecret(16);
    const result = await env.DELIVERY_DB.prepare("UPDATE shares SET public_id=?,share_version=share_version+1 WHERE id=? AND token_hash=? AND public_id IS NULL AND share_version=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM projects WHERE projects.id=shares.project_id AND projects.active=1)").bind(publicId,share.id,share.token_hash,expectedVersion).run();
    if (result.meta.changes) return{publicId,shareVersion:expectedVersion+1};
    const current = await env.DELIVERY_DB.prepare("SELECT public_id,share_version FROM shares WHERE id=? AND token_hash=? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM projects WHERE projects.id=shares.project_id AND projects.active=1)").bind(share.id,share.token_hash).first<{ public_id: string | null;share_version:number }>();
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
  return clientHash(env, request).then(addressHash => env.DELIVERY_DB.prepare(
    "INSERT INTO share_events (share_id,event_type,item_ref,client_address_hash,user_agent) VALUES (?,?,?,?,?)",
  ).bind(shareId, eventType, itemRef || null, addressHash, (request.headers.get("user-agent") || "").slice(0, 240)).run());
}

app.get("/health", c => c.json({ status: "ok", service: "ltds-delivery" }));

export async function serveAppShell(request: Request, assets: Pick<Fetcher, "fetch">): Promise<Response> {
  const response = await assets.fetch(request);
  const headers = new Headers(response.headers); headers.set("Cache-Control", "no-store"); headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, { status: response.status, headers });
}

app.get("/s/:publicId", c => serveAppShell(c.req.raw, c.env.ASSETS));

app.post("/api/public/shares/:routeId/session", async c => {
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
    if (!(await verifyAccessCode(body.accessCode, share.password_hash, share.password_salt, share.password_iterations,share.password_algorithm,c.env.DELIVERY_ACCESS_CODE_PEPPER))) {
      c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, "unlock.failed"));
      return c.json({ error: "The access code is not correct", code: "ACCESS_CODE_INVALID" }, 401);
    }
  }

  const route = await ensurePublicId(c.env, share);
  const shareExpiry = share.expires_at ? new Date(share.expires_at).getTime() : Number.POSITIVE_INFINITY;
  const expiresAt = Math.min(Date.now() + 12 * 60 * 60 * 1000, shareExpiry);
  c.header("Set-Cookie", await createSessionCookie(c.env.DELIVERY_SESSION_SECRET, c.env.SESSION_KEY_ID, share.id,route.shareVersion, expiresAt));
  c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, "session.created"));
  return c.json({ publicId:route.publicId, canonicalPath: `/s/${route.publicId}` });
});

app.use("/api/public/shares/:publicId/*", async (c, next) => {
  const session = await verifySessionCookie(c.env.DELIVERY_SESSION_SECRET, c.env.SESSION_KEY_ID, parseCookie(c.req.header("Cookie"), COOKIE_NAME));
  const share = await c.env.DELIVERY_DB.prepare(activeShareSql("s.id=? AND s.public_id=? AND s.share_version=?")).bind(session.shareId, c.req.param("publicId"),session.shareVersion).first<ShareRow>();
  if (!share){const unavailable=await c.env.DELIVERY_DB.prepare(unavailableShareSql("s.id=? AND s.public_id=?")).bind(session.shareId,c.req.param("publicId")).first<ShareRow>();if(unavailable)await markUnavailableFolder(c.env,unavailable);throw new HTTPException(404, { message: "This delivery link is invalid, expired, or revoked" });}
  c.set("share", share); await next();
});

app.get("/api/public/shares/:publicId/manifest", async c => {
  const share = c.get("share"); await requireAvailableFolder(c.env,share); const root = normalizeRoot(share.r2_prefix);
  const folderRef = c.req.query("folder") || ""; const relativeFolder = folderRef ? decodeItemRef(folderRef) : "";
  const prefix = relativeFolder ? `${keyWithinRoot(root, relativeFolder).replace(/\/$/, "")}/` : root;
  const listed = await c.env.DATA_BUCKET.list({ prefix, delimiter: "/", limit: 500, cursor: c.req.query("cursor") });
  const items: DeliveryItem[] = [];
  for (const folderPrefix of listed.delimitedPrefixes) {
    if (isHiddenKey(folderPrefix)) continue;
    const relative = folderPrefix.slice(root.length).replace(/\/$/, ""); if (!relative) continue;
    items.push({ id: encodeItemRef(relative), name: relative.split("/").pop() || relative, kind: "folder", size: null, uploadedAt: null });
  }
  const videos: Array<{ index: number; key: string }> = [];
  for (const object of listed.objects) {
    if (object.key === prefix || object.key.endsWith("/") || isHiddenKey(object.key)) continue;
    const relative = object.key.slice(root.length); const id = encodeItemRef(relative); const kind = kindForKey(object.key);
    const base = `/api/public/shares/${encodeURIComponent(share.public_id!)}/items/${id}`;
    const item: DeliveryItem = { id, name: relative.split("/").pop() || relative, kind, size: object.size, uploadedAt: object.uploaded.toISOString(), downloadUrl: `${base}/download` };
    if (["image", "video", "audio", "pdf", "text"].includes(kind)) item.previewUrl = `${base}/preview`;
    if (kind === "image") item.thumbnailUrl = `${base}/thumbnail`;
    if (kind === "video") videos.push({ index: items.length, key: object.key });
    items.push(item);
  }
  if (videos.length && c.env.STREAM_CUSTOMER_CODE) {
    const records = await c.env.DELIVERY_DB.batch(videos.map(video => c.env.DELIVERY_DB.prepare("SELECT stream_uid,stream_status FROM file_index WHERE r2_key=?").bind(video.key)));
    await Promise.all(records.map(async (result, index) => {
      const row = result.results[0] as { stream_uid?: string; stream_status?: string } | undefined; const item = items[videos[index]!.index];
      if (item && row?.stream_status === "ready" && row.stream_uid) {
        const token = await c.env.STREAM.video(row.stream_uid).generateToken();
        item.streamUrl = `https://customer-${c.env.STREAM_CUSTOMER_CODE}.cloudflarestream.com/${token}/iframe`;
        item.thumbnailUrl = `https://customer-${c.env.STREAM_CUSTOMER_CODE}.cloudflarestream.com/${token}/thumbnails/thumbnail.jpg?time=1s&height=340`;
      }
    }));
  }
  const breadcrumbs: Array<{ id: string; name: string }> = []; let built = "";
  for (const segment of relativeFolder.split("/").filter(Boolean)) { built = built ? `${built}/${segment}` : segment; breadcrumbs.push({ id: encodeItemRef(built), name: segment }); }
  const manifest: DeliveryManifest = { share: { publicId: share.public_id!, label: share.label, clientName: share.client_name, projectName: share.project_name, expiresAt: share.expires_at }, folder: { id: folderRef, name: relativeFolder.split("/").pop() || share.project_name, breadcrumbs }, items, nextCursor: listed.truncated ? listed.cursor : null };
  c.executionCtx.waitUntil(Promise.all([audit(c.env, c.req.raw, share.id, "manifest.viewed", folderRef), c.env.DELIVERY_DB.prepare("UPDATE shares SET access_count=access_count+1,last_accessed_at=datetime('now') WHERE id=?").bind(share.id).run()]));
  return c.json(manifest);
});

async function streamItem(c: any, disposition: "inline" | "attachment"): Promise<Response> {
  const share = c.get("share") as ShareRow; const itemRef = c.req.param("itemRef") as string; const relative = decodeItemRef(itemRef); const key = keyWithinRoot(share.r2_prefix, relative);
  const kind = kindForKey(key); if (disposition === "inline" && !["image", "video", "audio", "pdf", "text"].includes(kind)) throw new HTTPException(415, { message: "Preview is not available for this file" });
  const head = await c.env.DATA_BUCKET.head(key); if (!head) throw new HTTPException(404, { message: "File not found" });
  if (disposition === "inline" && kind === "image") {
    const object = await c.env.DATA_BUCKET.get(key); if (!object) throw new HTTPException(404, { message: "File not found" });
    const output = await c.env.IMAGES.input(object.body).transform({ width: 2400, height: 1800, fit: "scale-down" }).output({ format: "image/webp", quality: 84 });
    const transformed = output.response(); const headers = new Headers(transformed.headers);
    headers.set("Cache-Control", "private, max-age=86400, stale-while-revalidate=604800"); headers.set("ETag", `W/\"${head.httpEtag}-preview\"`); headers.set("Content-Disposition", `inline; filename=\"${safeFileName(key)}\"`); headers.set("X-Content-Type-Options", "nosniff");
    return new Response(transformed.body, { status: transformed.status, headers });
  }
  let range: { offset: number; length: number } | undefined;
  try { range = parseRange(c.req.header("Range"), head.size); } catch (error) { if (error instanceof HTTPException && error.status === 416) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head.size}`, "Accept-Ranges": "bytes" } }); throw error; }
  const headers = new Headers(); head.writeHttpMetadata(headers); headers.set("Content-Type", mimeForKey(key)); headers.set("ETag", head.httpEtag); headers.set("Accept-Ranges", "bytes"); headers.set("Cache-Control", "private, no-store"); headers.set("X-Content-Type-Options", "nosniff"); headers.set("Content-Disposition", `${disposition}; filename="${safeFileName(key)}"`);
  if (range) { headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`); headers.set("Content-Length", String(range.length)); } else headers.set("Content-Length", String(head.size));
  if (c.req.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
  const object = await c.env.DATA_BUCKET.get(key, range ? { range } : undefined); if (!object) throw new HTTPException(404, { message: "File not found" });
  c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, disposition === "attachment" ? "download.started" : "preview.viewed", itemRef));
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

app.on(["GET", "HEAD"], "/api/public/shares/:publicId/items/:itemRef/preview", c => streamItem(c, "inline"));
app.on(["GET", "HEAD"], "/api/public/shares/:publicId/items/:itemRef/download", c => streamItem(c, "attachment"));

app.get("/api/public/shares/:publicId/items/:itemRef/thumbnail", async c => {
  const share = c.get("share"); const itemRef = c.req.param("itemRef"); const key = keyWithinRoot(share.r2_prefix, decodeItemRef(itemRef));
  if (kindForKey(key) !== "image") throw new HTTPException(415, { message: "Thumbnail unavailable" });
  const head = await c.env.DATA_BUCKET.head(key); if (!head) throw new HTTPException(404, { message: "File not found" }); if (head.size > 20 * 1024 * 1024) throw new HTTPException(415, { message: "Image is too large for a thumbnail" });
  const object = await c.env.DATA_BUCKET.get(key); if (!object) throw new HTTPException(404, { message: "File not found" });
  const output = await c.env.IMAGES.input(object.body).transform({ width: 520, height: 340, fit: "cover" }).output({ format: "image/webp", quality: 72 });
  const transformed = output.response(); const headers = new Headers(transformed.headers); headers.set("Cache-Control", "private, max-age=86400, stale-while-revalidate=604800"); headers.set("Content-Disposition", "inline"); headers.set("X-Content-Type-Options", "nosniff");
  return new Response(transformed.body, { status: transformed.status, headers });
});

async function enumerateBulkSources(c: any): Promise<ZipSource[]> {
  const share = c.get("share") as ShareRow;
  const body = await c.req.json().catch(() => ({})) as { all?: boolean; items?: string[] };
  const refs = Array.isArray(body.items) ? body.items.slice(0, 2000) : [];
  const prefixes = new Set<string>(); const files = new Map<string, { size: number }>();
  if (body.all || !refs.length) prefixes.add(normalizeRoot(share.r2_prefix));
  for (const ref of refs) {
    const relative = decodeItemRef(ref); const key = keyWithinRoot(share.r2_prefix, relative);
    const head = await c.env.DATA_BUCKET.head(key);
    if (head) files.set(key, { size: head.size });
    else prefixes.add(key.endsWith("/") ? key : `${key}/`);
  }
  for (const prefix of prefixes) {
    let cursor: string | undefined;
    do {
      const listed = await c.env.DATA_BUCKET.list({ prefix, limit: 1000, cursor });
      for (const object of listed.objects) if (!object.key.endsWith("/") && !isHiddenKey(object.key)) files.set(object.key, { size: object.size });
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
  const entries = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
  const total = entries.reduce((sum, [, value]) => sum + value.size, 0);
  if (entries.length > 2000) throw new HTTPException(413, { message: "This selection contains more than 2,000 files." });
  if (total > 20 * 1024 * 1024 * 1024) throw new HTTPException(413, { message: "This selection is larger than the 20 GB download limit." });
  const root = normalizeRoot(share.r2_prefix);
  return entries.map(([key, value]) => ({ name: key.slice(root.length), size: value.size, open: async () => { const object = await c.env.DATA_BUCKET.get(key); if (!object) throw new Error("A selected file is no longer available"); return object.body; } }));
}

app.post("/api/public/shares/:publicId/bulk-download", async c => {
  const share = c.get("share") as ShareRow; const sources = await enumerateBulkSources(c);
  if (!sources.length) throw new HTTPException(404, { message: "There are no files available to download." });
  c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, "download.started", `bulk:${sources.length}`));
  const filename = `${(share.client_name || share.project_name || "delivery").replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "delivery"}.zip`;
  return new Response(streamZip(sources), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename=\"${filename}\"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
});

app.notFound(c => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  const status = error instanceof HTTPException ? error.status : 500;
  if (status >= 500) console.error(JSON.stringify({ event: "delivery.error", status, message: error instanceof Error ? error.message : "unknown" }));
  const code=error instanceof Error&&(error.cause as {code?:string}|undefined)?.code;
  return c.json({ error: status >= 500 ? "An unexpected error occurred" : error.message,...(code?{code}:{}) }, status);
});

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
