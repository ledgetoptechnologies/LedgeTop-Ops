import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { DeliveryItem, DeliveryManifest } from "@ltds/shared";
import { decodeItemRef, encodeItemRef, isHiddenKey, keyWithinRoot, kindForKey, mimeForKey, normalizeRoot, parseRange, safeFileName } from "./files";
import { createSessionCookie, hmac, parseCookie, randomSecret, sha256, verifyAccessCode, verifySessionCookie } from "./security";
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
  return `SELECT s.id,s.public_id,s.project_id,s.token_hash,s.label,s.password_hash,s.password_salt,s.password_iterations,s.expires_at,s.revoked_at,
    p.client_name,p.project_name,p.r2_prefix FROM shares s JOIN projects p ON p.id=s.project_id
    WHERE ${extra} AND s.revoked_at IS NULL AND p.active=1 AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))`;
}

async function findByPublicId(env: Env, publicId: string): Promise<ShareRow | null> {
  return env.DELIVERY_DB.prepare(activeShareSql("s.public_id=?")).bind(publicId).first<ShareRow>();
}

async function findBySecret(env: Env, secret: string): Promise<ShareRow | null> {
  if (secret.length < 32 || secret.length > 128) return null;
  return env.DELIVERY_DB.prepare(activeShareSql("s.token_hash=?")).bind(await sha256(secret)).first<ShareRow>();
}

async function ensurePublicId(env: Env, share: ShareRow): Promise<string> {
  if (share.public_id) return share.public_id;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const publicId = randomSecret(16);
    const result = await env.DELIVERY_DB.prepare("UPDATE shares SET public_id=?, share_version=2 WHERE id=? AND public_id IS NULL").bind(publicId, share.id).run();
    if (result.meta.changes) return publicId;
    const current = await env.DELIVERY_DB.prepare("SELECT public_id FROM shares WHERE id=?").bind(share.id).first<{ public_id: string | null }>();
    if (current?.public_id) return current.public_id;
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
  if (!share || (byPublic && byPublic.id !== share.id)) throw new HTTPException(404, { message: "This delivery link is invalid, expired, or revoked" });

  if (share.password_hash && share.password_salt && share.password_iterations) {
    const addressHash = await clientHash(c.env, c.req.raw);
    const [shareLimit, clientLimit] = await Promise.all([
      c.env.ACCESS_CODE_RATE_LIMITER.limit({ key: `${share.id}:${addressHash}` }),
      c.env.ACCESS_CODE_RATE_LIMITER.limit({ key: `client:${addressHash}` }),
    ]);
    if (!shareLimit.success || !clientLimit.success) throw new HTTPException(429, { message: "Too many attempts. Please wait before trying again." });
    if (!body.accessCode) return c.json({ error: "Access code required", code: "ACCESS_CODE_REQUIRED" }, 401);
    if (!(await verifyAccessCode(body.accessCode, share.password_hash, share.password_salt, share.password_iterations))) {
      c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, "unlock.failed"));
      return c.json({ error: "The access code is not correct", code: "ACCESS_CODE_REQUIRED" }, 401);
    }
  }

  const publicId = await ensurePublicId(c.env, share);
  const shareExpiry = share.expires_at ? new Date(share.expires_at).getTime() : Number.POSITIVE_INFINITY;
  const expiresAt = Math.min(Date.now() + 12 * 60 * 60 * 1000, shareExpiry);
  c.header("Set-Cookie", await createSessionCookie(c.env.DELIVERY_SESSION_SECRET, c.env.SESSION_KEY_ID, share.id, expiresAt));
  c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, "session.created"));
  return c.json({ publicId, canonicalPath: `/s/${publicId}` });
});

app.use("/api/public/shares/:publicId/*", async (c, next) => {
  const session = await verifySessionCookie(c.env.DELIVERY_SESSION_SECRET, c.env.SESSION_KEY_ID, parseCookie(c.req.header("Cookie"), COOKIE_NAME));
  const share = await c.env.DELIVERY_DB.prepare(activeShareSql("s.id=? AND s.public_id=?")).bind(session.shareId, c.req.param("publicId")).first<ShareRow>();
  if (!share) throw new HTTPException(404, { message: "This delivery link is invalid, expired, or revoked" });
  c.set("share", share); await next();
});

app.get("/api/public/shares/:publicId/manifest", async c => {
  const share = c.get("share"); const root = normalizeRoot(share.r2_prefix);
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
  const transformed = output.response(); const headers = new Headers(transformed.headers); headers.set("Cache-Control", "private, max-age=3600"); headers.set("Content-Disposition", "inline"); headers.set("X-Content-Type-Options", "nosniff");
  return new Response(transformed.body, { status: transformed.status, headers });
});

app.notFound(c => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  const status = error instanceof HTTPException ? error.status : 500;
  if (status >= 500) console.error(JSON.stringify({ event: "delivery.error", status, message: error instanceof Error ? error.message : "unknown" }));
  return c.json({ error: status >= 500 ? "An unexpected error occurred" : error.message }, status);
});

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
