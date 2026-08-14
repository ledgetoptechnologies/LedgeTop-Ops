import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { isMovedSourceMarker, type DeliveryItem, type DeliveryManifest } from "@ltds/shared";
import { decodeItemRef, encodeItemRef, indexedImmediateChildVisibility, isHiddenKey, keyWithinRoot, kindForKey, mimeForKey, normalizeRoot, parseRange, prefixHasVisibleContent, safeFileName, visibleImmediateChildPrefixes } from "./files";
import { createSessionCookie, hmac, parseCookie, randomSecret, sha256, verifyAccessCode, verifyRotatingSessionCookie } from "./security";
import { matchesEtag } from "./prepared-images";
import { serveAuthorizedThumbnail, thumbnailFieldsForObject, type ThumbnailJobRow } from "./thumbnails";
import { recordFirstAccessNotification } from "./notifications";
import { handleProjectAlphaPortalProjectionRequest } from "./project-alpha-portal";
import { friendlyBulkFailure } from "./bulk-download-errors";
import type { Env, ShareRow } from "./types";
export { BulkDownloadWorkflow } from "./workflow";
export { CloudTransferWorkflow } from "./cloud-transfer/workflow";
import { cleanupCloudTransfers } from "./cloud-transfer/cleanup";
import { decryptCloudSecret, decryptWithRotation, encryptCloudSecret, readGrantedSource } from "./cloud-transfer/grants";
import { activatePendingGoogleJob, cloudDb, getAuthorizedCloudJob, getGooglePickerAuthorization, listCloudItems, requestCloudCancellation, retryFailedCloudItems, validGoogleFolderId } from "./cloud-transfer/repository";
import { friendlyCloudFailure } from "./cloud-transfer/errors";
import { buildDropboxAuthorizationUrl, buildGoogleAuthorizationUrl, createOAuthState, createPkce, exchangeDropboxCode, exchangeGoogleCode, refreshGoogleToken } from "./cloud-transfer/oauth";
import type { CloudCredential } from "./cloud-transfer/types";
import { createCloudProviderAdapter } from "./cloud-transfer/providers";
import type { CloudProvider, CloudTransferEnv } from "./cloud-transfer/types";
import { listDownloadableObjects, summarizeDownloadableObjects } from "./downloadable-files";
import { listPublicShareLocations, resolvePublicShareLocation } from "./public-locations";
import { createClientPortalRouter } from "./client-portal/routes";
import { acceptRequestAttachmentScanReceipt, cleanupExpiredRequestAttachments, readRequestAttachmentScanReceipt } from "./client-portal/request-attachments";
import { createClientDelegatedPublicRouter } from "./client-delegated-public";
import { handleProjectAlphaCatalogRequest } from "./project-alpha-catalog";
import { projectAlphaPricingHintProvider } from "./client-portal/project-alpha-pricing-hint";
import { processInvitationEmailBatch } from "./client-portal/invitation-email";
export { friendlyBulkFailure } from "./bulk-download-errors";

type Variables = { share: ShareRow };
interface Tombstone { physical_key: string; tombstone_kind: "exact" | "prefix"; }
const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const COOKIE_NAME = "__Host-ltds_delivery";

function cloudEnv(env:Env):CloudTransferEnv{if(!env.CLOUD_TRANSFER_TOKEN_SECRET)throw new HTTPException(503,{message:"Cloud copy is not configured"});return env as CloudTransferEnv;}
function cloudProvider(value:string):CloudProvider{if(value==="dropbox")return"dropbox";if(value==="google"||value==="google-drive")return"google";throw new HTTPException(404,{message:"Cloud provider not found"});}
function cloudProviderEnabled(env:Env,provider:CloudProvider):boolean{
 if(!env.CLOUD_TRANSFER_TOKEN_SECRET||!env.CLOUD_TRANSFER_WORKFLOW)return false;
 return provider==="dropbox"?env.CLOUD_TRANSFER_DROPBOX_ENABLED==="true"&&Boolean(env.DROPBOX_CLIENT_ID&&env.DROPBOX_CLIENT_SECRET):env.CLOUD_TRANSFER_GOOGLE_ENABLED==="true"&&env.CLOUD_TRANSFER_GOOGLE_PICKER_CLIENT_ENABLED==="true"&&Boolean(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET&&env.GOOGLE_PICKER_API_KEY&&env.GOOGLE_CLOUD_PROJECT_NUMBER);
}
function requireSameOrigin(request:Request,env:Env):void{const origin=request.headers.get("Origin");if(!origin||origin!==new URL(env.PUBLIC_BASE_URL).origin)throw new HTTPException(403,{message:"This request is not allowed"});}
function cloudRedirectUri(env:Env,provider:CloudProvider):string{return`${env.PUBLIC_BASE_URL}/api/public/cloud-transfers/oauth/${provider}/callback`;}
function cloudStatus(value:string):string{return value==="partial"?"failed":value;}
function providerPublicName(provider:CloudProvider):"dropbox"|"google-drive"{return provider==="google"?"google-drive":"dropbox";}

export function requestHostAllowed(requestUrl:string,env:Pick<Env,"ENVIRONMENT"|"EXPECTED_HOST"|"CLIENT_PORTAL_ORIGIN">):boolean{
 if(env.ENVIRONMENT!=="production")return true;
 const requestHost=new URL(requestUrl).host;
 if(requestHost===env.EXPECTED_HOST)return true;
 if(!env.CLIENT_PORTAL_ORIGIN)return false;
 try{
  const portal=new URL(env.CLIENT_PORTAL_ORIGIN);
  return portal.protocol==="https:"&&portal.origin===env.CLIENT_PORTAL_ORIGIN&&portal.pathname==="/"&&requestHost===portal.host;
 }catch{return false;}
}

async function googlePickerCredential(env:CloudTransferEnv,authorizationId:string,row:{credential_ciphertext:string;credential_iv:string;key_id:string}):Promise<CloudCredential>{
 let credential=await decryptWithRotation<CloudCredential>({ciphertext:row.credential_ciphertext,iv:row.credential_iv,keyId:row.key_id},env,`authorization:${authorizationId}:google`);
 if(credential.expiresAt&&Date.parse(credential.expiresAt)<=Date.now()+120000){
  if(!credential.refreshToken||!env.GOOGLE_CLIENT_ID||!env.GOOGLE_CLIENT_SECRET)throw new HTTPException(401,{message:"Google authorization expired"});
  const refreshed=await refreshGoogleToken({clientId:env.GOOGLE_CLIENT_ID,clientSecret:env.GOOGLE_CLIENT_SECRET,refreshToken:credential.refreshToken});credential={...credential,...refreshed,refreshToken:refreshed.refreshToken||credential.refreshToken};
  const encrypted=await encryptCloudSecret(credential,env.CLOUD_TRANSFER_TOKEN_SECRET,`authorization:${authorizationId}:google`);
  await cloudDb(env).prepare("UPDATE cloud_transfer_authorizations SET credential_ciphertext=?,credential_iv=?,key_id=?,token_expires_at=?,last_used_at=datetime('now') WHERE id=? AND revoked_at IS NULL").bind(encrypted.ciphertext,encrypted.iv,env.CLOUD_TRANSFER_KEY_ID||"v1",credential.expiresAt||null,authorizationId).run();
 }
 return credential;
}

export function framePolicyForPath(path: string, method = "GET"): { frameAncestors: "'self'" | "'none'"; xFrameOptions: "SAMEORIGIN" | "DENY" } {
  const inlinePdf = (method === "GET" || method === "HEAD") && (
    /^\/api\/public\/shares\/[^/]+\/items\/[^/]+\/pdf$/.test(path) ||
    /^\/client-share\/api\/shares\/[^/]+\/items\/[^/]+\/pdf$/.test(path)
  );
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
    defaultSrc: ["'self'"], imgSrc: ["'self'", "https://ledgetopdroneservices.com", "https://*.cloudflarestream.com", "data:", "blob:"], styleSrc: ["'self'", "'unsafe-inline'"],
    scriptSrc: ["'self'"], connectSrc: ["'self'", "https://*.cloudflarestream.com", "https://*.r2.cloudflarestorage.com", "https://api.mapbox.com", "https://events.mapbox.com"], mediaSrc: ["'self'", "https://*.cloudflarestream.com", "blob:"], frameSrc: ["'self'", "https://*.cloudflarestream.com"], workerSrc: ["blob:"], frameAncestors: ["'none'"],
    baseUri: ["'none'"], objectSrc: ["'none'"], formAction: ["'self'"],
  },
  referrerPolicy: "no-referrer",
  xContentTypeOptions: "nosniff",
  xFrameOptions: "DENY",
  xXssProtection: false,
});
const frameablePdfSecurityHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"], imgSrc: ["'self'", "https://ledgetopdroneservices.com", "https://*.cloudflarestream.com", "data:", "blob:"], styleSrc: ["'self'", "'unsafe-inline'"],
    scriptSrc: ["'self'"], connectSrc: ["'self'", "https://*.cloudflarestream.com", "https://*.r2.cloudflarestorage.com", "https://api.mapbox.com", "https://events.mapbox.com"], mediaSrc: ["'self'", "https://*.cloudflarestream.com", "blob:"], frameSrc: ["'self'", "https://*.cloudflarestream.com"], workerSrc: ["blob:"], frameAncestors: ["'self'"],
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
  if (!requestHostAllowed(c.req.url,c.env)) return c.json({ error: "Not found" }, 404);
  await next();
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
  c.header("X-Robots-Tag", "noindex, nofollow");
  if (c.req.path.startsWith("/api/")) {
    c.header("Cloudflare-CDN-Cache-Control", "no-store");
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  }
});

function activeShareSql(extra: string): string {
  return `SELECT s.id,s.public_id,s.project_id,s.token_hash,s.label,s.password_hash,s.password_salt,s.password_iterations,s.password_algorithm,s.expires_at,s.revoked_at,s.revoked_reason,s.unavailable_since,s.share_version,s.recipient_email,s.image_location_map_enabled,
    p.client_name,p.project_name,COALESCE(s.r2_prefix,p.r2_prefix) AS r2_prefix FROM shares s JOIN projects p ON p.id=s.project_id
    WHERE ${extra} AND s.revoked_at IS NULL AND p.active=1 AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))`;
}

function unavailableShareSql(extra: string): string {
  return `SELECT s.id,s.public_id,s.project_id,s.token_hash,s.label,s.password_hash,s.password_salt,s.password_iterations,s.password_algorithm,s.expires_at,s.revoked_at,s.revoked_reason,s.unavailable_since,s.share_version,s.image_location_map_enabled,
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
  if (!result.success) {
    c.header("Retry-After", "60");
    throw new HTTPException(429, { message: "Too many requests. Please wait and try again." });
  }
}

type PublicRateLimitBinding =
  | "PUBLIC_MANIFEST_RATE_LIMITER"
  | "PUBLIC_MEDIA_RATE_LIMITER"
  | "PUBLIC_THUMBNAIL_RATE_LIMITER"
  | "PUBLIC_DOWNLOAD_RATE_LIMITER"
  | "PUBLIC_STREAM_RATE_LIMITER"
  | "PUBLIC_BULK_RATE_LIMITER";

export interface PublicRateLimitPolicy { binding: PublicRateLimitBinding; scope: string; }

export function classifyPublicRateLimit(method: string, path: string): PublicRateLimitPolicy {
  const bulkBase = "/api/public/shares/[^/]+/bulk-download";
  if (method === "POST" && new RegExp(`^${bulkBase}$`).test(path)) {
    return { binding: "PUBLIC_BULK_RATE_LIMITER", scope: "bulk-create" };
  }
  if ((method === "GET" || method === "HEAD") && new RegExp(`^${bulkBase}/[^/]+/file$`).test(path)) {
    return { binding: "PUBLIC_DOWNLOAD_RATE_LIMITER", scope: "bulk-file" };
  }
  if (method === "GET" && new RegExp(`^${bulkBase}/[^/]+$`).test(path)) {
    return { binding: "PUBLIC_MANIFEST_RATE_LIMITER", scope: "bulk-status" };
  }
  if (method === "GET" && path.endsWith("/download-summary")) return { binding: "PUBLIC_MANIFEST_RATE_LIMITER", scope: "download-summary" };
  if (method === "GET" && path.endsWith("/locations")) return { binding: "PUBLIC_MANIFEST_RATE_LIMITER", scope: "locations" };
  if (method === "GET" && path.endsWith("/manifest/media")) return { binding: "PUBLIC_MANIFEST_RATE_LIMITER", scope: "manifest-media" };
  if (path.endsWith("/manifest")) return { binding: "PUBLIC_MANIFEST_RATE_LIMITER", scope: "manifest" };
  if (path.endsWith("/thumbnail")) return { binding: "PUBLIC_THUMBNAIL_RATE_LIMITER", scope: "thumbnail" };
  if (path.endsWith("/stream-ticket")) return { binding: "PUBLIC_STREAM_RATE_LIMITER", scope: "stream" };
  if (path.endsWith("/download") || path.endsWith("/download-ticket")) return { binding: "PUBLIC_DOWNLOAD_RATE_LIMITER", scope: "download" };
  return { binding: "PUBLIC_MEDIA_RATE_LIMITER", scope: "media" };
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

async function visiblePublicChildPrefixes(env:Env,prefix:string,candidates:readonly string[],tombstones:Tombstone[]):Promise<Set<string>>{
  let indexed=new Set<string>(),visible=new Set<string>();
  try{
    const state=await indexedImmediateChildVisibility(primaryDb(env),candidates);
    indexed=state.indexed;visible=state.visible;
  }catch(error){
    console.warn(JSON.stringify({event:"public-manifest.folder-index-visibility-fallback",candidateCount:candidates.length,message:error instanceof Error?error.message:"unknown"}));
  }
  const unindexed=candidates.filter(candidate=>!indexed.has(candidate));
  if(unindexed.length){
    const fallback=await visibleImmediateChildPrefixes(env.DATA_BUCKET,prefix,unindexed,object=>!isTrashed(tombstones,object.key));
    for(const candidate of fallback)visible.add(candidate);
  }
  return visible;
}

async function assertNotTrashed(env: Env, key: string): Promise<void> {
  if (isTrashed(await loadTombstones(env), key)) throw new HTTPException(404, { message: "File not found" });
}

function aliasedPath(key: string, root: string, aliases: Map<string, string>): string {
  const relative = key.slice(root.length).replace(/\/$/, ""); const parts = relative.split("/"); const names: string[] = []; let physical = root;
  parts.forEach((part, index) => { physical += part; names.push(aliases.get(physical + (index === parts.length - 1 ? "" : "/")) || part); physical += "/"; });
  return names.join("/");
}

app.get("/health", c => c.json({ status: "ok", service: "ltds-delivery" }));

export async function serveAppShell(request: Request, assets: Pick<Fetcher, "fetch">): Promise<Response> {
  const response = await assets.fetch(request);
  const headers = new Headers(response.headers); headers.set("Cache-Control", "no-store"); headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, { status: response.status, headers });
}

app.get("/s/:publicId", c => serveAppShell(c.req.raw, c.env.ASSETS));

// Client-delegated bearer links have a deliberately separate visible, cookie,
// signing and API namespace. Staff `/s` credentials are never accepted here.
app.get("/client-share/:publicId", c => serveAppShell(c.req.raw, c.env.ASSETS));
app.route("/client-share/api", createClientDelegatedPublicRouter());

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
  const policy = classifyPublicRateLimit(c.req.method, c.req.path);
  await enforceRateLimit(c, c.env[policy.binding], policy.scope);
  await next();
});

app.get("/api/public/shares/:publicId/manifest", async c => {
  const started=Date.now();
  const share = c.get("share"); await requireAvailableFolder(c.env,share); const root = normalizeRoot(share.r2_prefix); const tombstones = await loadTombstones(c.env);
  const folderRef = c.req.query("folder") || ""; const relativeFolder = folderRef ? decodeItemRef(folderRef) : "";
  const prefix = relativeFolder ? `${keyWithinRoot(root, relativeFolder).replace(/\/$/, "")}/` : root;
  const listed = await c.env.DATA_BUCKET.list({ prefix, delimiter: "/", limit: 500, cursor: c.req.query("cursor"), include: ["httpMetadata", "customMetadata"] });
  const aliasKeys = [root, prefix, ...listed.delimitedPrefixes, ...listed.objects.map(object => object.key)]; let breadcrumbPhysical = root;
  for (const segment of relativeFolder.split("/").filter(Boolean)) { breadcrumbPhysical += `${segment}/`; aliasKeys.push(breadcrumbPhysical); }
  const aliases = await loadAliases(c.env, aliasKeys);
  const items: DeliveryItem[] = [];
  const candidateFolders=listed.delimitedPrefixes.filter(folderPrefix=>!isHiddenKey(folderPrefix)&&!isTrashed(tombstones,folderPrefix));
  const visibleFolders=await visiblePublicChildPrefixes(c.env,prefix,candidateFolders,tombstones);
  for (const folderPrefix of listed.delimitedPrefixes) {
    if (!visibleFolders.has(folderPrefix)) continue;
    const relative = folderPrefix.slice(root.length).replace(/\/$/, ""); if (!relative) continue;
    items.push({ id: encodeItemRef(relative), name: aliases.get(folderPrefix) || relative.split("/").pop() || relative, kind: "folder", size: null, uploadedAt: null });
  }
  for (const object of listed.objects) {
    if (object.key === prefix || object.key.endsWith("/") || isHiddenKey(object.key) || isTrashed(tombstones, object.key) || isMovedSourceMarker(object)) continue;
    const relative = object.key.slice(root.length); const id = encodeItemRef(relative); const kind = kindForKey(object.key);
    const base = `/api/public/shares/${encodeURIComponent(share.public_id!)}/items/${id}`;
    const item: DeliveryItem = { id, name: aliases.get(object.key) || relative.split("/").pop() || relative, kind, size: object.size, uploadedAt: object.uploaded.toISOString(), downloadUrl: `${base}/download`, previewStatus: kind === "video" ? "processing" : undefined, ...thumbnailFieldsForObject(object.key, kind, base, object.httpEtag, null, object.size, object.httpMetadata?.contentType) };
    item.sourceUrl = sourceUrlForItem(base, kind);
    if (kind === "image") { const e = (object.key.split(".").pop() || "").toLowerCase(); if (!["dng","arw","cr2","cr3","crw","nef","raf","rw2","orf","pef","srw","3fr","rwl","srf","sr2","x3f"].includes(e)) item.previewUrl = item.sourceUrl; }
    else if (kind === "audio" || kind === "text") item.previewUrl = `${base}/preview`;
    if (kind === "video") item.previewUrl = undefined;
    items.push(item);
  }
  const breadcrumbs: Array<{ id: string; name: string }> = []; let built = "";
  let physicalBreadcrumb = root;
  for (const segment of relativeFolder.split("/").filter(Boolean)) { built = built ? `${built}/${segment}` : segment; physicalBreadcrumb += `${segment}/`; breadcrumbs.push({ id: encodeItemRef(built), name: aliases.get(physicalBreadcrumb) || segment }); }
  const currentPhysical = relativeFolder ? prefix : root;
  const dropbox=cloudProviderEnabled(c.env,"dropbox"),google=cloudProviderEnabled(c.env,"google"); const manifest: DeliveryManifest = { share: { publicId: share.public_id!, label: share.label, clientName: share.client_name, projectName: aliases.get(root) || share.project_name, expiresAt: share.expires_at }, folder: { id: folderRef, name: aliases.get(currentPhysical) || relativeFolder.split("/").pop() || share.project_name, breadcrumbs }, items, nextCursor: listed.truncated ? listed.cursor : null, capabilities: { cloudTransfer: { dropbox, googleDrive: google, googlePicker: google } } };
  c.executionCtx.waitUntil(Promise.all([audit(c.env, c.req.raw, share.id, "manifest.viewed", folderRef), primaryDb(c.env).prepare("UPDATE shares SET access_count=access_count+1,last_accessed_at=datetime('now') WHERE id=?").bind(share.id).run()]));
  c.header("Server-Timing",`manifest;dur=${Math.max(0,Date.now()-started)}`);
  return c.json(manifest);
});

app.get("/api/public/shares/:publicId/manifest/media", async c => {
  const started=Date.now();
  const share = c.get("share"); await requireAvailableFolder(c.env, share); const root = normalizeRoot(share.r2_prefix); const tombstones = await loadTombstones(c.env);
  const folderRef = c.req.query("folder") || ""; const relativeFolder = folderRef ? decodeItemRef(folderRef) : "";
  const prefix = relativeFolder ? `${keyWithinRoot(root, relativeFolder).replace(/\/$/, "")}/` : root;
  const listed = await c.env.DATA_BUCKET.list({ prefix, delimiter: "/", limit: 500, cursor: c.req.query("cursor"), include: ["httpMetadata", "customMetadata"] });
  const candidates = listed.objects.flatMap(object => {
    if (!object.key.startsWith(prefix) || object.key === prefix || object.key.endsWith("/") || isHiddenKey(object.key) || isTrashed(tombstones, object.key) || isMovedSourceMarker(object)) return [];
    const relative = object.key.slice(root.length); const id = encodeItemRef(relative); const kind = kindForKey(object.key);
    if (kind !== "image" && kind !== "pdf" && kind !== "video") return [];
    const base = `/api/public/shares/${encodeURIComponent(share.public_id!)}/items/${id}`;
    return [{ id, key: object.key, kind, etag: object.httpEtag, size: object.size, contentType: object.httpMetadata?.contentType, base }];
  });
  const db = primaryDb(c.env); const thumbnailCandidates = candidates; const videoCandidates = candidates.filter(candidate => candidate.kind === "video");
  const [thumbnailRecords, videoRecords] = await Promise.all([
    thumbnailCandidates.length ? db.batch(thumbnailCandidates.map(candidate => db.prepare("SELECT source_etag,thumbnail_key,thumbnail_etag,thumbnail_size,status FROM image_thumbnail_jobs WHERE source_key=?").bind(candidate.key))) : [],
    videoCandidates.length ? db.batch(videoCandidates.map(candidate => db.prepare("SELECT stream_uid,stream_status FROM file_index WHERE r2_key=?").bind(candidate.key))) : [],
  ]);
  const thumbnails = new Map(thumbnailCandidates.map((candidate, index) => [candidate.id, thumbnailRecords[index]?.results[0] as ThumbnailJobRow | undefined]));
  const videos = new Map(videoCandidates.map((candidate, index) => [candidate.id, videoRecords[index]?.results[0] as { stream_uid?: string; stream_status?: string } | undefined]));
  const response={ items: candidates.map(candidate => {
    const thumbnail = thumbnails.get(candidate.id); const video = videos.get(candidate.id);
    return {
      id: candidate.id,
      ...thumbnailFieldsForObject(candidate.key, candidate.kind, candidate.base, candidate.etag, thumbnail, candidate.size, candidate.contentType),
      ...(candidate.kind === "video" ? { previewStatus: video?.stream_status === "ready" && video.stream_uid ? "ready" : "processing" } : {}),
    };
  }) };
  c.header("Server-Timing",`media;dur=${Math.max(0,Date.now()-started)}`);
  return c.json(response);
});

app.get("/api/public/shares/:publicId/download-summary", async c => {
  const share = c.get("share"); await requireAvailableFolder(c.env, share); const tombstones = await loadTombstones(c.env);
  const folderRef = c.req.query("folder") || "";
  const prefix = folderRef ? `${keyWithinRoot(share.r2_prefix, decodeItemRef(folderRef))}/` : normalizeRoot(share.r2_prefix);
  const objects = await listDownloadableObjects(c.env.DATA_BUCKET, prefix, tombstones);
  return c.json(summarizeDownloadableObjects(objects));
});

app.get("/api/public/shares/:publicId/locations", async c => {
  const share = c.get("share"); await requireAvailableFolder(c.env, share);
  if (share.image_location_map_enabled !== 1) return c.json({ locations: { points: [], imageCount: 0, truncated: false }, mapboxPublicToken: null });
  const locations = await listPublicShareLocations(c.env, share, c.req.query("folder") || "");
  return c.json({ locations, mapboxPublicToken: locations.points.length ? c.env.MAPBOX_PUBLIC_TOKEN || null : null });
});

app.get("/api/public/shares/:publicId/locations/:assetRef", async c => {
  const share = c.get("share"); await requireAvailableFolder(c.env, share);
  if (share.image_location_map_enabled !== 1) throw new HTTPException(404, { message: "Mapped image not found" });
  return c.json({ item: await resolvePublicShareLocation(c.env, share, c.req.param("assetRef"), c.req.query("folder") || "") });
});

export async function streamItem(c: any, disposition: "inline" | "attachment", raw = false, requiredKind?: "pdf"): Promise<Response> {
  const share = c.get("share") as ShareRow; const itemRef = c.req.param("itemRef") as string; const relative = decodeItemRef(itemRef); const key = keyWithinRoot(share.r2_prefix, relative);
  await assertNotTrashed(c.env, key);
  const kind = kindForKey(key);
  if (requiredKind && kind !== requiredKind) throw new HTTPException(415, { message: "PDF preview is not available for this file" });
  if (disposition === "inline" && !["image", "video", "audio", "pdf", "text"].includes(kind)) throw new HTTPException(415, { message: "Preview is not available for this file" });
  const head = await c.env.DATA_BUCKET.head(key); if (!head || isMovedSourceMarker(head)) throw new HTTPException(404, { message: "File not found" });
  if (!raw && disposition === "inline" && kind === "pdf") return streamItem(c, "inline", true, "pdf");
  if (!raw && disposition === "inline" && kind === "video") throw new HTTPException(409, { message: "Video preview is available through Stream" });
  let range: { offset: number; length: number } | undefined;
  const rangeHeader = c.req.header("Range"), ifRange = c.req.header("If-Range");
  try { range = parseRange(!ifRange || matchesEtag(ifRange, head.httpEtag) ? rangeHeader : undefined, head.size); } catch (error) { if (error instanceof HTTPException && error.status === 416) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head.size}`, "Accept-Ranges": "bytes" } }); throw error; }
  const headers = new Headers(); head.writeHttpMetadata(headers); headers.set("Content-Type", mimeForKey(key)); headers.set("ETag", head.httpEtag); headers.set("Accept-Ranges", "bytes"); headers.set("Cache-Control", "private, no-store"); headers.set("X-Content-Type-Options", "nosniff"); headers.set("Content-Disposition", `${disposition}; filename="${safeFileName(key)}"`);
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
  if (kind === "image") return streamItem(c, "inline", true);
  if (kind === "pdf") return streamItem(c, "inline", true, "pdf");
  if (kind === "audio" || kind === "text") return streamItem(c, "inline", true);
  throw new HTTPException(415, { message: "Preview unavailable" });
});

app.on(["GET", "HEAD"], "/api/public/shares/:publicId/items/:itemRef/source", c => streamItem(c, "inline", true));
app.on(["GET", "HEAD"], "/api/public/shares/:publicId/items/:itemRef/pdf", c => streamItem(c, "inline", true, "pdf"));

async function downloadItem(c: any): Promise<Response> {
  const share = c.get("share") as ShareRow; const itemRef = c.req.param("itemRef") as string;
  const relative = decodeItemRef(itemRef); const key = keyWithinRoot(share.r2_prefix, relative);
  await assertNotTrashed(c.env, key);
  const head = await c.env.DATA_BUCKET.head(key); if (!head || isMovedSourceMarker(head)) throw new HTTPException(404, { message: "File not found" });
  const alias = await primaryDb(c.env).prepare("SELECT display_name FROM file_aliases WHERE physical_key=?").bind(key).first<{ display_name: string }>();
  const rawName = alias?.display_name || safeFileName(key);
  const downloadName = rawName.replace(/[\0-\x1f\x7f"\\]/g, "_").slice(0, 180) || "file";
  let range: { offset: number; length: number } | undefined;
  const rangeHeader = c.req.header("Range"), ifRange = c.req.header("If-Range");
  try { range = parseRange(!ifRange || matchesEtag(ifRange, head.httpEtag) ? rangeHeader : undefined, head.size); }
  catch (error) { if (error instanceof HTTPException && error.status === 416) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head.size}`, "Accept-Ranges": "bytes" } }); throw error; }
  const headers = new Headers(); head.writeHttpMetadata(headers);
  headers.set("Content-Type", mimeForKey(key));
  headers.set("ETag", head.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Disposition", `attachment; filename="${downloadName}"`);
  if (range) { headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`); headers.set("Content-Length", String(range.length)); }
  else headers.set("Content-Length", String(head.size));
  if (c.req.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
  const object = await c.env.DATA_BUCKET.get(key, range ? { range } : undefined); if (!object) throw new HTTPException(404, { message: "File not found" });
  c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, "download.started", itemRef));
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

app.get("/api/public/shares/:publicId/items/:itemRef/download-ticket", async c => {
  const share = c.get("share") as ShareRow; const itemRef = c.req.param("itemRef") as string;
  const key = keyWithinRoot(share.r2_prefix, decodeItemRef(itemRef));
  await assertNotTrashed(c.env, key);
  const head = await c.env.DATA_BUCKET.head(key); if (!head || isMovedSourceMarker(head)) throw new HTTPException(404, { message: "File not found" });
  const base = baseForItem(share, itemRef);
  const sessionMaxMs = 12 * 60 * 60 * 1000;
  const shareRemainingMs = share.expires_at ? Math.max(0, new Date(share.expires_at).getTime() - Date.now()) : sessionMaxMs;
  const expiresAt = new Date(Date.now() + Math.min(sessionMaxMs, shareRemainingMs)).toISOString();
  return c.json({ url: `${c.env.PUBLIC_BASE_URL}${base}/download`, expiresAt });
});
app.on(["GET", "HEAD"], "/api/public/shares/:publicId/items/:itemRef/download", c => downloadItem(c));

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

app.on(["GET", "HEAD"], "/api/public/shares/:publicId/items/:itemRef/thumbnail", async c => {
  const share = c.get("share"); const itemRef = c.req.param("itemRef"); const key = keyWithinRoot(share.r2_prefix, decodeItemRef(itemRef));
  await assertNotTrashed(c.env, key);
  const kind = kindForKey(key);
  if (kind !== "image" && kind !== "pdf" && kind !== "video")
    throw new HTTPException(409, { message: "Thumbnail is not available for this file type", cause: { code: "THUMBNAIL_NOT_APPLICABLE" } });
  return serveAuthorizedThumbnail(c.env, key, { method: c.req.method, ifNoneMatch: c.req.header("If-None-Match"), kind });
});

export function bulkQuotaRetryAfterSeconds(now = Date.now()): number {
  const hour = 60 * 60 * 1000;
  return Math.max(1, Math.ceil((hour - (now % hour)) / 1000));
}

async function consumeBulkQuota(c: any, share: ShareRow): Promise<void> {
  const now = Date.now();
  const windowStart = Math.floor(now / (60 * 60 * 1000));
  const result = await primaryDb(c.env).prepare(`INSERT INTO bulk_download_quota (share_id,window_start,created_count) VALUES (?,?,1)
    ON CONFLICT(share_id,window_start) DO UPDATE SET created_count=created_count+1,updated_at=datetime('now') WHERE created_count < 3`).bind(share.id, windowStart).run();
  if (!result.meta.changes) {
    c.header("Retry-After", String(bulkQuotaRetryAfterSeconds(now)));
    throw new HTTPException(429, { message: "This delivery has reached its hourly bulk-download limit." });
  }
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
  return primaryDb(c.env).prepare("SELECT id,status,file_count,processed_files,total_bytes,processed_bytes,archive_size,error_code,error_message,expires_at,manifest_key,archive_key FROM bulk_download_jobs WHERE id=? AND share_id=? AND share_version=?").bind(jobId, share.id, share.share_version).first<any>();
}

async function streamArchive(c: any, job: any): Promise<Response> {
  const share = c.get("share") as ShareRow;
  const head = await c.env.DATA_BUCKET.head(job.archive_key); if (!head) throw new HTTPException(404, { message: "Archive not found" });
  const rangeHeader = c.req.header("Range"), ifRange = c.req.header("If-Range");
  let range: { offset: number; length: number } | undefined;
  try { range = parseRange(!ifRange || matchesEtag(ifRange, head.httpEtag) ? rangeHeader : undefined, head.size); }
  catch (error) { if (error instanceof HTTPException && error.status === 416) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head.size}`, "Accept-Ranges": "bytes" } }); throw error; }
  const normalized = `${share.project_name || share.client_name || "delivery"}.zip`.normalize("NFC");
  const ascii = normalized.replace(/[^\x20-\x7e]/g, "_").replace(/[\0-\x1f\x7f"\\]/g, "_").slice(0, 180) || "delivery.zip";
  const headers = new Headers();
  headers.set("Content-Type", "application/zip");
  headers.set("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(normalized)}`);
  headers.set("ETag", head.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  if (range) { headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`); headers.set("Content-Length", String(range.length)); }
  else headers.set("Content-Length", String(head.size));
  if (c.req.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
  const object = await c.env.DATA_BUCKET.get(job.archive_key, range ? { range } : undefined); if (!object) throw new HTTPException(404, { message: "Archive not found" });
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

export function readyBulkJobIsExpired(job: { status: string; expires_at: string }, now = Date.now()): boolean {
  const expiresAt = Date.parse(job.expires_at);
  return job.status === "ready" && Number.isFinite(expiresAt) && expiresAt <= now;
}

export function bulkJobProgress(job: {
  status: string;
  total_bytes: number | null;
  processed_bytes: number | null;
  archive_size: number | null;
}): { progress: number | null; message: string | null } {
  if (job.status === "ready") return { progress: 100, message: "Download ready" };
  if (job.status !== "running" || !job.total_bytes || job.total_bytes <= 0) return { progress: null, message: null };
  const progress = Math.min(99, Math.max(0, Math.round(((job.processed_bytes || 0) / job.total_bytes) * 100)));
  return { progress, message: job.archive_size == null ? "Checking files" : "Building ZIP" };
}

async function expireReadyBulkJob(c: any, job: any): Promise<void> {
  if (!readyBulkJobIsExpired(job)) return;
  await primaryDb(c.env).prepare("UPDATE bulk_download_jobs SET status='expired',updated_at=datetime('now') WHERE id=? AND status='ready' AND datetime(expires_at)<=datetime('now')").bind(job.id).run();
  job.status = "expired";
  c.executionCtx.waitUntil(c.env.DATA_BUCKET.delete([job.archive_key, job.manifest_key]));
}

app.post("/api/public/shares/:publicId/bulk-download", async c => {
  const share = c.get("share") as ShareRow; const request = validateBulkRequest(await c.req.json().catch(() => ({}))); await consumeBulkQuota(c, share);
  const jobId = randomSecret(16); const encodedShare = encodeURIComponent(share.public_id!); const manifestKey = `_ltds/tmp-downloads/${share.public_id}/${jobId}/manifest.json`; const archiveKey = `_ltds/tmp-downloads/${share.public_id}/${jobId}/archive.zip`; const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await primaryDb(c.env).prepare("INSERT INTO bulk_download_jobs (id,share_id,share_version,request_json,status,manifest_key,archive_key,expires_at) VALUES (?,?,?,?,?,?,?,?)").bind(jobId, share.id, share.share_version, JSON.stringify(request), "queued", manifestKey, archiveKey, expiresAt).run();
  try { await c.env.BULK_DOWNLOAD_WORKFLOW.create({ id: jobId, params: { jobId } }); }
  catch (error) {
    const failure = friendlyBulkFailure("workflow-create-failed");
    console.error(JSON.stringify({ event: "bulk-download.workflow-create-failed", jobId, shareId: share.id, error: error instanceof Error ? error.message : String(error) }));
    await primaryDb(c.env).prepare("UPDATE bulk_download_jobs SET status='failed',error_code=?,error_message=?,updated_at=datetime('now') WHERE id=?").bind(failure.code, failure.message, jobId).run();
    throw new HTTPException(503, { message: failure.message });
  }
  c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, "download.started", `bulk:${jobId}`));
  return c.json({ jobId, status: "queued", statusUrl: `/api/public/shares/${encodedShare}/bulk-download/${jobId}`, downloadUrl: null }, 202);
});

app.get("/api/public/shares/:publicId/bulk-download/:jobId", async c => {
  const job = await getBulkJob(c, c.req.param("jobId")); if (!job) throw new HTTPException(404, { message: "Download job not found" });
  await expireReadyBulkJob(c, job);
  const share = c.get("share") as ShareRow;
  const failure = job.error_code ? friendlyBulkFailure(job.error_code) : null;
  const progress = bulkJobProgress(job);
  const encodedShare = encodeURIComponent(share.public_id!);
  const response: Record<string, unknown> = { jobId: job.id, status: job.status, fileCount: job.file_count, processedFiles: job.processed_files, totalBytes: job.total_bytes, processedBytes: job.processed_bytes, archiveSize: job.archive_size, expiresAt: job.expires_at, error: failure, downloadUrl: null, ...progress };
  if (job.status === "ready") response.downloadUrl = `/api/public/shares/${encodedShare}/bulk-download/${job.id}/file`;
  return c.json(response);
});

app.on(["GET", "HEAD"], "/api/public/shares/:publicId/bulk-download/:jobId/file", async c => {
  const job = await getBulkJob(c, c.req.param("jobId")); if (!job) throw new HTTPException(404, { message: "Download is not ready" });
  await expireReadyBulkJob(c, job);
  if (job.status !== "ready") throw new HTTPException(job.status === "expired" ? 410 : 404, { message: job.status === "expired" ? "This prepared download has expired." : "Download is not ready" });
  return streamArchive(c, job);
});

app.post("/api/public/shares/:publicId/cloud-transfers/oauth/:provider/start",async c=>{
 requireSameOrigin(c.req.raw,c.env);const share=c.get("share") as ShareRow;const provider=cloudProvider(c.req.param("provider"));if(!cloudProviderEnabled(c.env,provider))throw new HTTPException(503,{message:"This cloud provider is not available yet"});
 const body=await c.req.json().catch(()=>({})) as {selection?:unknown;destination?:unknown;conflictMode?:unknown;callbackNonce?:unknown};
 const selection=validateBulkRequest(body.selection);const conflictMode=body.conflictMode==="skip"?"skip":"autorename";if(typeof body.callbackNonce!=="string"||!/^[A-Za-z0-9_-]{24,128}$/.test(body.callbackNonce))throw new HTTPException(400,{message:"Invalid callback nonce"});
 const windowStart=Math.floor(Date.now()/3600000);const quota=await primaryDb(c.env).prepare(`INSERT INTO cloud_transfer_quota(share_id,window_start,created_count,total_bytes) VALUES(?,?,1,0)
  ON CONFLICT(share_id,window_start) DO UPDATE SET created_count=created_count+1,updated_at=datetime('now') WHERE created_count<3`).bind(share.id,windowStart).run();
 if(!quota.meta.changes){c.header("Retry-After",String(bulkQuotaRetryAfterSeconds()));throw new HTTPException(429,{message:"This delivery has reached its hourly cloud-copy limit."});}
 const pkce=await createPkce(),state=createOAuthState(),stateHash=await sha256(state);const env=cloudEnv(c.env);const encrypted=await encryptCloudSecret({verifier:pkce.verifier,callbackNonce:body.callbackNonce},env.CLOUD_TRANSFER_TOKEN_SECRET,`oauth-state:${stateHash}:${provider}`);
 const destination=provider==="google"?{folderId:typeof body.destination==="string"&&body.destination?body.destination:"root",callbackNonce:body.callbackNonce}:{path:typeof body.destination==="string"&&body.destination?body.destination:"/LTDS Delivery",callbackNonce:body.callbackNonce};
 await primaryDb(c.env).prepare(`INSERT INTO cloud_oauth_states(state_hash,provider,share_id,share_version,selection_json,destination_json,conflict_mode,pkce_ciphertext,pkce_iv,key_id,expires_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,datetime('now','+10 minutes'))`).bind(stateHash,provider,share.id,share.share_version,JSON.stringify(selection),JSON.stringify(destination),conflictMode,encrypted.ciphertext,encrypted.iv,env.CLOUD_TRANSFER_KEY_ID||"v1").run();
 const redirectUri=cloudRedirectUri(c.env,provider);const clientId=provider==="dropbox"?c.env.DROPBOX_CLIENT_ID!:c.env.GOOGLE_CLIENT_ID!;
 const authorizationUrl=provider==="dropbox"?buildDropboxAuthorizationUrl({clientId,redirectUri,state,challenge:pkce.challenge}):buildGoogleAuthorizationUrl({clientId,redirectUri,state,challenge:pkce.challenge});
 return c.json({authorizationUrl});
});

app.get("/api/public/cloud-transfers/oauth/:provider/callback",async c=>{
 const provider=cloudProvider(c.req.param("provider")),state=c.req.query("state")||"",code=c.req.query("code")||"";if(!state||!code)throw new HTTPException(400,{message:"Cloud authorization was not completed"});
 const stateHash=await sha256(state),nowIso=new Date().toISOString();const row=await primaryDb(c.env).prepare(`SELECT * FROM cloud_oauth_states WHERE state_hash=? AND provider=? AND consumed_at IS NULL AND datetime(expires_at)>datetime(?)`).bind(stateHash,provider,nowIso).first<any>();
 if(!row)throw new HTTPException(400,{message:"Cloud authorization expired"});const consumed=await primaryDb(c.env).prepare("UPDATE cloud_oauth_states SET consumed_at=datetime('now') WHERE state_hash=? AND consumed_at IS NULL").bind(stateHash).run();if(!consumed.meta.changes)throw new HTTPException(400,{message:"Cloud authorization was already used"});
 const env=cloudEnv(c.env);const secret=await decryptCloudSecret<{verifier:string;callbackNonce:string}>(row.pkce_ciphertext,row.pkce_iv,env.CLOUD_TRANSFER_TOKEN_SECRET,`oauth-state:${stateHash}:${provider}`);
 const share=await primaryDb(c.env).prepare(activeShareSql("s.id=? AND s.share_version=?")).bind(row.share_id,row.share_version).first<ShareRow>();if(!share||!share.public_id)throw new HTTPException(404,{message:"This delivery is no longer available"});
 const redirectUri=cloudRedirectUri(c.env,provider);const token=provider==="dropbox"?await exchangeDropboxCode({clientId:c.env.DROPBOX_CLIENT_ID!,clientSecret:c.env.DROPBOX_CLIENT_SECRET!,redirectUri,code,verifier:secret.verifier}):await exchangeGoogleCode({clientId:c.env.GOOGLE_CLIENT_ID!,clientSecret:c.env.GOOGLE_CLIENT_SECRET!,redirectUri,code,verifier:secret.verifier});
 const authorizationId=randomSecret(16),jobId=randomSecret(16);const credential=await encryptCloudSecret(token,env.CLOUD_TRANSFER_TOKEN_SECRET,`authorization:${authorizationId}:${provider}`);const expiresAt=new Date(Date.now()+24*3600000).toISOString();
 const pendingGoogle=provider==="google";const destination=pendingGoogle?JSON.stringify({pendingPicker:true}):row.destination_json;
 await c.env.DELIVERY_DB.batch([
  primaryDb(c.env).prepare(`INSERT INTO cloud_transfer_authorizations(id,share_id,share_version,provider,credential_ciphertext,credential_iv,key_id,scopes,token_expires_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(authorizationId,share.id,share.share_version,provider,credential.ciphertext,credential.iv,env.CLOUD_TRANSFER_KEY_ID||"v1",token.scope||"",token.expiresAt||null,expiresAt),
  primaryDb(c.env).prepare(`INSERT INTO cloud_transfer_jobs(id,share_id,share_version,authorization_id,provider,selection_json,destination_json,conflict_mode,status,expires_at) VALUES(?,?,?,?,?,?,?,?, 'queued',?)`).bind(jobId,share.id,share.share_version,authorizationId,provider,row.selection_json,destination,row.conflict_mode,expiresAt),
 ]);
 if(!pendingGoogle){try{await c.env.CLOUD_TRANSFER_WORKFLOW.create({id:jobId,params:{jobId}});}catch(error){console.error(JSON.stringify({event:"cloud-transfer.workflow-create-failed",jobId,provider,error:error instanceof Error?error.message:String(error)}));await primaryDb(c.env).prepare("UPDATE cloud_transfer_jobs SET status='failed',error_code='transfer-failed',error_message=?,updated_at=datetime('now') WHERE id=?").bind(friendlyCloudFailure("transfer-failed").message,jobId).run();}}
 const url=new URL(`/s/${encodeURIComponent(share.public_id)}`,c.env.PUBLIC_BASE_URL);url.searchParams.set("cloudTransferNonce",secret.callbackNonce);url.searchParams.set("cloudTransferProvider",providerPublicName(provider));
 if(pendingGoogle)url.searchParams.set("cloudTransferAuthorization",authorizationId);else url.searchParams.set("cloudTransferJob",jobId);
 return c.redirect(url.toString(),302);
});

app.post("/api/public/shares/:publicId/cloud-transfers/google/authorizations/:authorizationId/token",async c=>{
 requireSameOrigin(c.req.raw,c.env);const share=c.get("share") as ShareRow,env=cloudEnv(c.env),authorizationId=c.req.param("authorizationId");
 const row=await getGooglePickerAuthorization(env,authorizationId,share.id,share.share_version);
 if(!row)throw new HTTPException(404,{message:"Google authorization not found"});const credential=await googlePickerCredential(env,authorizationId,row);if(!credential.accessToken)throw new HTTPException(401,{message:"Google authorization expired"});
 c.header("Cache-Control","no-store");c.header("Pragma","no-cache");c.header("Referrer-Policy","no-referrer");return c.json({accessToken:credential.accessToken,expiresAt:credential.expiresAt||null});
});

app.post("/api/public/shares/:publicId/cloud-transfers",async c=>{
 requireSameOrigin(c.req.raw,c.env);const share=c.get("share") as ShareRow,env=cloudEnv(c.env);const body=await c.req.json().catch(()=>({})) as {authorizationId?:unknown;folderId?:unknown};
 if(typeof body.authorizationId!=="string"||!/^[A-Za-z0-9_-]{16,128}$/.test(body.authorizationId)||!validGoogleFolderId(body.folderId))throw new HTTPException(400,{message:"A valid Google Drive destination is required"});
 const job=await activatePendingGoogleJob(env,{authorizationId:body.authorizationId,shareId:share.id,shareVersion:share.share_version,folderId:body.folderId});if(!job)throw new HTTPException(404,{message:"Google authorization not found or already used"});
 try{await c.env.CLOUD_TRANSFER_WORKFLOW.create({id:job.id,params:{jobId:job.id}});}catch(error){console.error(JSON.stringify({event:"cloud-transfer.workflow-create-failed",jobId:job.id,provider:"google",error:error instanceof Error?error.message:String(error)}));await cloudDb(env).prepare("UPDATE cloud_transfer_jobs SET status='failed',error_code='transfer-failed',error_message=?,updated_at=datetime('now') WHERE id=?").bind(friendlyCloudFailure("transfer-failed").message,job.id).run();throw new HTTPException(503,{message:"The cloud transfer could not be queued"});}
 return c.json({id:job.id,provider:"google-drive",status:"queued"},202);
});

app.get("/api/public/shares/:publicId/cloud-transfers/:jobId",async c=>{
 const share=c.get("share") as ShareRow,job=await getAuthorizedCloudJob(cloudEnv(c.env),c.req.param("jobId"),share.id,share.share_version);if(!job)throw new HTTPException(404,{message:"Cloud transfer not found"});const items=await listCloudItems(cloudEnv(c.env),job.id);
 return c.json({id:job.id,provider:providerPublicName(job.provider),status:cloudStatus(job.status),processedFiles:job.processed_files,totalFiles:job.file_count,processedBytes:job.processed_bytes,totalBytes:job.total_bytes,error:job.error_code?friendlyCloudFailure(job.error_code):null,items:items.map(item=>({id:item.id,name:item.relative_path,status:item.status==="completed"?"copied":item.status==="queued"?"waiting":item.status==="running"?"copying":item.status,processedBytes:item.uploaded_bytes,totalBytes:item.source_size,message:item.error_message||undefined}))});
});

app.post("/api/public/shares/:publicId/cloud-transfers/:jobId/cancel",async c=>{
 requireSameOrigin(c.req.raw,c.env);const share=c.get("share") as ShareRow;const env=cloudEnv(c.env);if(!(await requestCloudCancellation(env,c.req.param("jobId"),share.id,share.share_version)))throw new HTTPException(409,{message:"This transfer can no longer be cancelled"});const job=await getAuthorizedCloudJob(env,c.req.param("jobId"),share.id,share.share_version);return c.json({id:job!.id,provider:providerPublicName(job!.provider),status:"cancelling"});
});

app.post("/api/public/shares/:publicId/cloud-transfers/:jobId/retry",async c=>{
 requireSameOrigin(c.req.raw,c.env);const share=c.get("share") as ShareRow,env=cloudEnv(c.env),jobId=c.req.param("jobId");const count=await retryFailedCloudItems(env,jobId,share.id,share.share_version);if(!count)throw new HTTPException(409,{message:"There are no failed files to retry"});
 await c.env.CLOUD_TRANSFER_WORKFLOW.create({id:`${jobId}-retry-${randomSecret(8)}`,params:{jobId}});const job=(await getAuthorizedCloudJob(env,jobId,share.id,share.share_version))!;return c.json({id:job.id,provider:providerPublicName(job.provider),status:"running"});
});

app.on(["GET","HEAD"],"/api/public/cloud-transfers/source/:grant",async c=>{
 const object=await readGrantedSource(cloudEnv(c.env),c.req.param("grant"));const headers=new Headers();headers.set("Content-Type",object.httpMetadata?.contentType||"application/octet-stream");headers.set("Content-Length",String(object.size));headers.set("ETag",object.httpEtag);headers.set("Cache-Control","private, no-store");return new Response(c.req.method==="HEAD"?null:object.body,{headers});
});

export async function cleanupTemporaryZips(env: Env, now = Date.now()): Promise<void> {
  const nowIso = new Date(now).toISOString();
  await primaryDb(env).prepare("UPDATE bulk_download_jobs SET status='expired',updated_at=datetime(?) WHERE status IN ('queued','running','ready') AND datetime(expires_at)<=datetime(?)").bind(nowIso, nowIso).run();
  const expiredJobs = await primaryDb(env).prepare("SELECT manifest_key,archive_key,multipart_upload_id FROM bulk_download_jobs WHERE status='expired' AND updated_at=datetime(?) AND datetime(expires_at)<=datetime(?)")
    .bind(nowIso, nowIso).all<{ manifest_key: string; archive_key: string; multipart_upload_id: string | null }>();
  for (const job of expiredJobs.results) {
    if (!job.multipart_upload_id) continue;
    try {
      await env.DATA_BUCKET.resumeMultipartUpload(job.archive_key, job.multipart_upload_id).abort();
    } catch (error) {
      console.error(JSON.stringify({ event: "bulk-download.cleanup-abort-failed", archiveKey: job.archive_key, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  const artifactKeys = [...new Set(expiredJobs.results.flatMap(job => [job.manifest_key, job.archive_key]).filter(Boolean))];
  for (let offset = 0; offset < artifactKeys.length; offset += 1000) await env.DATA_BUCKET.delete(artifactKeys.slice(offset, offset + 1000));
  const activeJobs = await primaryDb(env).prepare("SELECT manifest_key,archive_key FROM bulk_download_jobs WHERE status IN ('queued','running','ready') AND datetime(expires_at)>datetime(?)")
    .bind(nowIso).all<{ manifest_key: string; archive_key: string }>();
  const protectedKeys = new Set(activeJobs.results.flatMap(job => [job.manifest_key, job.archive_key]).filter(Boolean));
  const cutoff = now - 24 * 60 * 60 * 1000;
  let cursor: string | undefined;
  do {
    const listed = await env.DATA_BUCKET.list({ prefix: "_ltds/tmp-downloads/", limit: 1000, cursor });
    const orphaned = listed.objects.filter(object => object.uploaded.getTime() < cutoff && !protectedKeys.has(object.key)).map(object => object.key);
    if (orphaned.length) await env.DATA_BUCKET.delete(orphaned);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  const currentWindow = Math.floor(now / (60 * 60 * 1000));
  await primaryDb(env).prepare("DELETE FROM bulk_download_quota WHERE window_start<?").bind(currentWindow - 48).run();
}

app.post("/api/internal/client-request-attachments/:attachmentId/scanned", async c => {
  const attachmentId = c.req.param("attachmentId");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(attachmentId)) throw new HTTPException(404, { message: "Quarantined attachment not found" });
  const receipt = await readRequestAttachmentScanReceipt(c.req.raw);
  const status = await acceptRequestAttachmentScanReceipt(c.env, c.req.header("Authorization") || null, attachmentId, receipt);
  return c.json({ ok: true, status });
});

// This path is not part of the browser API. It requires the dedicated
// Project Alpha Access audience plus a timestamped signature over exact bytes.
app.post("/api/internal/project-alpha/catalog-v2", c => handleProjectAlphaCatalogRequest(c.req.raw, c.env));
app.post("/api/internal/project-alpha/portal-v2", c => handleProjectAlphaPortalProjectionRequest(c.req.raw, c.env));

app.route("/api/client", createClientPortalRouter({ pricingHintProvider: projectAlphaPricingHintProvider }));
app.get("/", c => c.redirect("/portal", 302));

app.notFound(c => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  const status = error instanceof HTTPException ? error.status : 500;
  if (status >= 500) console.error(JSON.stringify({ event: "delivery.error", status, message: error instanceof Error ? error.message : "unknown" }));
  const code=error instanceof Error&&(error.cause as {code?:string}|undefined)?.code;
  return c.json({ error: status >= 500 ? "An unexpected error occurred" : error.message,...(code?{code}:{}) }, status);
});

export default { fetch: app.fetch, scheduled: (_event, env, ctx) => ctx.waitUntil(Promise.all([cleanupTemporaryZips(env),cleanupExpiredRequestAttachments(env),processInvitationEmailBatch(env),env.CLOUD_TRANSFER_TOKEN_SECRET?cleanupCloudTransfers(cloudEnv(env),{dropbox:createCloudProviderAdapter("dropbox",cloudEnv(env)),google:createCloudProviderAdapter("google",cloudEnv(env))}):Promise.resolve()]).then(()=>undefined)) } satisfies ExportedHandler<Env>;
