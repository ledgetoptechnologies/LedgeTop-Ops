import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { isMovedSourceMarker, type DeliveryItem, type DeliveryManifest } from "@ltds/shared";
import { decodeItemRef, encodeItemRef, indexedImmediateChildVisibility, isHiddenKey, keyWithinRoot, kindForKey, mimeForKey, normalizeRoot, parseRange, prefixHasBrowsableEntry, safeFileName, streamPlayerUrl } from "./files";
import { BULK_DOWNLOAD_RESUME_COOKIE, createBulkDownloadResumeCookie, createSessionCookie, hmac, parseCookie, randomSecret, sha256, verifyAccessCode, verifyRotatingBulkDownloadResumeCookie, verifyRotatingSessionCookie } from "./security";
import { matchesEtag } from "./prepared-images";
import { serveAuthorizedThumbnail, thumbnailFieldsForObject, type ThumbnailJobRow } from "./thumbnails";
import { recordFirstAccessNotification } from "./notifications";
export { OpsSyncPortalProjectionIngress } from "./ops-sync-portal-entrypoint";
import { handleProjectAlphaServiceAssignmentsRequest, handleRegisteredProjectAlphaServiceAssignmentsRequest } from "./project-alpha-service-assignments";
import { friendlyBulkFailure } from "./bulk-download-errors";
import type { Env, ShareRow } from "./types";
export { BulkDownloadWorkflow } from "./workflow";
import { BULK_DOWNLOAD_RETENTION_MS } from "./workflow";
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
import { reconcileExpiredClientDelegatedShares } from "./client-portal/delegated-shares";
import { clientPortalEntryOrigin, configuredPublicRequestOrigins, legacyClientRedirectLocation, malformedPortalLaunchRedirect, requestHostAllowed, requirePublicShareOrigin } from "./origin-policy";
import {
  classifyPublicShareLifecycle,
  logPublicShareOutcome,
  publicShareLifecycleException,
  publicShareSessionExpiresAt,
  shouldRenewPublicShareSession,
  temporaryPublicShareException,
  type PublicShareLifecycleRow,
} from "./public-share-lifecycle";
export { friendlyBulkFailure } from "./bulk-download-errors";

type Variables = { share: ShareRow };
interface Tombstone { physical_key: string; tombstone_kind: "exact" | "prefix"; }
interface PublicMediaRow {
  r2_key:string;etag:string|null;size:number|null;content_type:string|null;media_kind:string|null;
  stream_uid:string|null;stream_status:string|null;source_etag:string|null;thumbnail_key:string|null;
  thumbnail_etag:string|null;thumbnail_size:number|null;thumbnail_status:ThumbnailJobRow["status"]|null;
}
const app = new Hono<{ Bindings: Env; Variables: Variables }>();
const COOKIE_NAME = "__Host-ltds_delivery";
const PUBLIC_DELIVERY_PAGE_SIZE=150;
const PUBLIC_MEDIA_LOOKUP_CHUNK_SIZE=50;

function cloudEnv(env:Env):CloudTransferEnv{if(!env.CLOUD_TRANSFER_TOKEN_SECRET)throw new HTTPException(503,{message:"Cloud copy is not configured"});return env as CloudTransferEnv;}
function cloudProvider(value:string):CloudProvider{if(value==="dropbox")return"dropbox";if(value==="google"||value==="google-drive")return"google";throw new HTTPException(404,{message:"Cloud provider not found"});}
function cloudProviderEnabled(env:Env,provider:CloudProvider):boolean{
 if(!env.CLOUD_TRANSFER_TOKEN_SECRET||!env.CLOUD_TRANSFER_WORKFLOW)return false;
 return provider==="dropbox"?env.CLOUD_TRANSFER_DROPBOX_ENABLED==="true"&&Boolean(env.DROPBOX_CLIENT_ID&&env.DROPBOX_CLIENT_SECRET):env.CLOUD_TRANSFER_GOOGLE_ENABLED==="true"&&env.CLOUD_TRANSFER_GOOGLE_PICKER_CLIENT_ENABLED==="true"&&Boolean(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET&&env.GOOGLE_PICKER_API_KEY&&env.GOOGLE_CLOUD_PROJECT_NUMBER);
}
export function requireSameOrigin(request:Request,env:Env):void{
  let requestOrigin:string;
  try{requestOrigin=new URL(request.url).origin;}catch{throw new HTTPException(403,{message:"This request is not allowed"});}
  const allowed=configuredPublicRequestOrigins(env);
  if(!allowed||request.headers.get("Origin")!==requestOrigin||!allowed.includes(requestOrigin))
    throw new HTTPException(403,{message:"This request is not allowed"});
}
export function cloudTransferResumeOrigin(env:Env,candidate:unknown):string{
  const allowed=configuredPublicRequestOrigins(env);
  return typeof candidate==="string"&&allowed?.includes(candidate)?candidate:requirePublicShareOrigin(env);
}
function cloudRedirectUri(env:Env,provider:CloudProvider):string{return`${requirePublicShareOrigin(env)}/api/public/cloud-transfers/oauth/${provider}/callback`;}
function cloudStatus(value:string):string{return value==="partial"?"failed":value;}
function providerPublicName(provider:CloudProvider):"dropbox"|"google-drive"{return provider==="google"?"google-drive":"dropbox";}

export { requestHostAllowed } from "./origin-policy";

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
    scriptSrc: ["'self'"], connectSrc: ["'self'", "https://*.cloudflarestream.com", "https://*.r2.cloudflarestorage.com", "https://api.mapbox.com", "https://events.mapbox.com"], mediaSrc: ["'self'", "https://*.cloudflarestream.com", "blob:"], frameSrc: ["'self'", "https://*.cloudflarestream.com", "https://viewer.ledgetopdroneservices.com", "https://viewer-staging.ledgetopdroneservices.com"], workerSrc: ["blob:"], frameAncestors: ["'none'"],
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
  const malformedLaunch = (c.req.method === "GET" || c.req.method === "HEAD")
    ? malformedPortalLaunchRedirect(c.req.url, c.env)
    : null;
  if (malformedLaunch) return c.redirect(malformedLaunch, 308);
  const legacyRedirect = (c.req.method === "GET" || c.req.method === "HEAD")
    ? legacyClientRedirectLocation(c.req.url, c.env)
    : null;
  if (legacyRedirect) return c.redirect(legacyRedirect, 308);
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
  return `SELECT s.id,s.public_id,s.project_id,s.token_hash,s.label,s.password_hash,s.password_salt,s.password_iterations,s.password_algorithm,s.expires_at,s.revoked_at,s.revoked_reason,s.unavailable_since,s.share_version,s.recipient_email,s.image_location_map_enabled,s.r2_object_key,
    p.client_name,p.project_name,COALESCE(s.r2_prefix,p.r2_prefix) AS r2_prefix FROM shares s JOIN projects p ON p.id=s.project_id
    WHERE ${extra} AND s.revoked_at IS NULL AND p.active=1 AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))`;
}

function lifecycleShareSql(extra: string): string {
  return `SELECT s.id,s.public_id,s.project_id,s.token_hash,s.label,s.password_hash,s.password_salt,s.password_iterations,s.password_algorithm,s.expires_at,s.revoked_at,s.revoked_reason,s.unavailable_since,s.share_version,s.recipient_email,s.image_location_map_enabled,s.r2_object_key,
    COALESCE(p.client_name,'') client_name,COALESCE(p.project_name,'') project_name,COALESCE(s.r2_prefix,p.r2_prefix,'') AS r2_prefix,
    CASE WHEN p.id IS NULL THEN 0 ELSE 1 END project_exists,COALESCE(p.active,0) project_active
    FROM shares s LEFT JOIN projects p ON p.id=s.project_id WHERE ${extra}`;
}

async function lifecycleShareQuery(env:Env,sql:string,bindings:unknown[]):Promise<PublicShareLifecycleRow|null>{
  try{return await primaryDb(env).prepare(sql).bind(...bindings).first<PublicShareLifecycleRow>();}
  catch{throw temporaryPublicShareException("database");}
}

async function findByRouteAndSecret(env: Env, routeId:string, secret: string): Promise<PublicShareLifecycleRow | null> {
  if (secret.length < 32 || secret.length > 128) return null;
  const hash=await sha256(secret);
  return routeId.length>30
    ? lifecycleShareQuery(env,lifecycleShareSql("s.token_hash=?"),[hash])
    : lifecycleShareQuery(env,lifecycleShareSql("s.public_id=? AND s.token_hash=?"),[routeId,hash]);
}

export async function markUnavailableFolder(env:{DELIVERY_DB:PublicIdDatabase},share:ShareRow):Promise<never>{
  const db = sessionDb(env.DELIVERY_DB);
  try{
    if(!share.revoked_at){
      const revoked=await db.prepare("UPDATE shares SET revoked_at=datetime('now'),revoked_reason='folder_unavailable' WHERE id=? AND revoked_at IS NULL AND unavailable_since IS NOT NULL AND datetime(unavailable_since)<=datetime('now','-24 hours')").bind(share.id).run();
      if(revoked.meta.changes)await db.prepare("INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('system','delivery-worker','share.auto_revoked','share',?,?)").bind(share.id,JSON.stringify({reason:"folder_unavailable",r2Prefix:share.r2_prefix})).run();
      else await db.prepare("UPDATE shares SET unavailable_since=datetime('now') WHERE id=? AND revoked_at IS NULL AND unavailable_since IS NULL").bind(share.id).run();
    }
  }catch{throw temporaryPublicShareException("database");}
  throw publicShareLifecycleException("resource_removed");
}

async function requireAvailableFolder(env:Env,share:ShareRow):Promise<void>{
  let browsable=false;
  try{browsable=share.r2_object_key?Boolean(await env.DATA_BUCKET.head(share.r2_object_key)):await prefixHasBrowsableEntry(env.DATA_BUCKET,share.r2_prefix);}
  catch{throw temporaryPublicShareException("storage");}
  if(!browsable)await markUnavailableFolder(env,share);
  if(share.unavailable_since){
    try{await sessionDb(env.DELIVERY_DB).prepare("UPDATE shares SET unavailable_since=NULL WHERE id=? AND revoked_at IS NULL").bind(share.id).run();}
    catch{throw temporaryPublicShareException("database");}
  }
}

function keyWithinShare(share:ShareRow,itemRef:string):string{
  const key=keyWithinRoot(share.r2_prefix,decodeItemRef(itemRef));
  if(share.r2_object_key&&key!==share.r2_object_key)throw new HTTPException(404,{message:"File not found"});
  return key;
}

function requireFolderShareFeature(share:ShareRow):void{
  if(share.r2_object_key)throw new HTTPException(404,{message:"This action is not available for a single-file link"});
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
  if (method === "POST" && path.endsWith("/manifest/media")) return { binding: "PUBLIC_MANIFEST_RATE_LIMITER", scope: "manifest-media" };
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

async function loadTombstones(env: Env, scope: string): Promise<Tombstone[]> {
  const result = await primaryDb(env).prepare(`SELECT physical_key,tombstone_kind
    FROM delivery_tombstones WHERE restored_at IS NULL AND (
      (physical_key>=? AND physical_key<?)
      OR (tombstone_kind='prefix' AND substr(?,1,length(physical_key))=physical_key)
    )`).bind(scope, `${scope}\uffff`, scope).all<Tombstone>();
  return result.results;
}

function isTrashed(tombstones: Tombstone[], key: string): boolean {
  return tombstones.some(tombstone => tombstone.tombstone_kind === "exact" ? tombstone.physical_key === key : key.startsWith(tombstone.physical_key));
}

async function visiblePublicChildPrefixes(env:Env,candidates:readonly string[]):Promise<Set<string>>{
  const visible=new Set<string>();
  try{
    const state=await indexedImmediateChildVisibility(primaryDb(env),candidates);
    for(const candidate of state.visible)visible.add(candidate);
    const missing=candidates.length-state.indexed.size;
    if(missing>0)console.info({event:"public_manifest.folder_index_reconciliation_needed",candidateCount:candidates.length,missingIndexCount:missing});
  }catch(error){
    console.warn(JSON.stringify({event:"public-manifest.folder-index-visibility-fallback",candidateCount:candidates.length,message:error instanceof Error?error.message:"unknown"}));
  }
  // Fail closed for a prefix absent from both visibility indexes. Recursively
  // probing it would make folder-open time scale with the full subtree, while
  // showing it optimistically could disclose stale/tombstoned folder names.
  return visible;
}

async function assertNotTrashed(env: Env, key: string): Promise<void> {
  if (isTrashed(await loadTombstones(env, key), key)) throw new HTTPException(404, { message: "File not found" });
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
  let share = candidateSecret ? await findByRouteAndSecret(c.env,routeId,candidateSecret) : null;
  if (!share) {
    throw new HTTPException(404, { message: "This delivery link is invalid.", cause: { code: "SHARE_INVALID" } });
  }
  c.set("share",share);
  const lifecycle=classifyPublicShareLifecycle(share);
  if(lifecycle!=="active")throw publicShareLifecycleException(lifecycle);
  await requireAvailableFolder(c.env,share);

  if (share.password_hash && share.password_salt && share.password_iterations) {
    if (!body.accessCode){logPublicShareOutcome(c.req.raw,{outcome:"ACCESS_CODE_REQUIRED",status:401,shareId:share.id});return c.json({ error: "Access code required", code: "ACCESS_CODE_REQUIRED" }, 401);}
    const addressHash = await clientHash(c.env, c.req.raw);
    const [shareLimit, clientLimit] = await Promise.all([
      c.env.ACCESS_CODE_RATE_LIMITER.limit({ key: `${share.id}:${addressHash}` }),
      c.env.ACCESS_CODE_RATE_LIMITER.limit({ key: `client:${addressHash}` }),
    ]);
    if (!shareLimit.success || !clientLimit.success) throw new HTTPException(429, { message: "Too many attempts. Please wait before trying again.", cause:{code:"ACCESS_CODE_RATE_LIMITED"} });
    let validCode = await verifyAccessCode(body.accessCode, share.password_hash, share.password_salt, share.password_iterations,share.password_algorithm,c.env.DELIVERY_ACCESS_CODE_PEPPER);
    if (!validCode && c.env.DELIVERY_PREVIOUS_ACCESS_CODE_PEPPER) {
      validCode = await verifyAccessCode(body.accessCode, share.password_hash, share.password_salt, share.password_iterations,share.password_algorithm,c.env.DELIVERY_PREVIOUS_ACCESS_CODE_PEPPER);
      if (validCode) {
        const nextSalt = randomSecret(16);
        const nextHash = await hmac(c.env.DELIVERY_ACCESS_CODE_PEPPER, `access-code:v1:${nextSalt}:${body.accessCode}`);
        const upgraded = await primaryDb(c.env).prepare("UPDATE shares SET password_hash=?,password_salt=?,password_iterations=1,password_algorithm='hmac-sha256-v1',share_version=share_version+1 WHERE id=? AND password_hash=? AND share_version=? AND revoked_at IS NULL")
          .bind(nextHash, nextSalt, share.id, share.password_hash, share.share_version).run();
        if (upgraded.meta.changes) share = {
          ...share,
          password_hash: nextHash,
          password_salt: nextSalt,
          password_iterations: 1,
          password_algorithm: "hmac-sha256-v1",
          share_version: share.share_version + 1,
        };
      }
    }
    if (!validCode) {
      c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, "unlock.failed"));
      logPublicShareOutcome(c.req.raw,{outcome:"ACCESS_CODE_INVALID",status:401,shareId:share.id});
      return c.json({ error: "The access code is not correct", code: "ACCESS_CODE_INVALID" }, 401);
    }
    // Bind the successful access-code check to the exact credential generation.
    // A concurrent staff code/token rotation must not let an old code mint a
    // cookie for the newly current share version.
    const current = await lifecycleShareQuery(c.env,lifecycleShareSql("s.id=? AND s.token_hash=?"),[share.id,share.token_hash]);
    if (!current
      || current.share_version !== share.share_version
      || current.password_hash !== share.password_hash
      || current.password_salt !== share.password_salt
      || current.password_iterations !== share.password_iterations
      || current.password_algorithm !== share.password_algorithm) {
      throw new HTTPException(401,{message:"The delivery credentials changed. Open the current link and try again.",cause:{code:"SHARE_SESSION_STALE"}});
    }
    const currentLifecycle=classifyPublicShareLifecycle(current);
    if(currentLifecycle!=="active")throw publicShareLifecycleException(currentLifecycle);
    share=current;
  }

  let route:{publicId:string;shareVersion:number};
  try{route=await ensurePublicId(c.env,share);}catch(error){if(error instanceof HTTPException)throw error;throw temporaryPublicShareException("database");}
  const expiresAt = publicShareSessionExpiresAt(share.expires_at);
  c.header("Set-Cookie", await createSessionCookie(c.env.DELIVERY_SESSION_SECRET, c.env.SESSION_KEY_ID, share.id,route.shareVersion, expiresAt));
  c.executionCtx.waitUntil(recordFirstAccessNotification(c.env, share));
  c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, "session.created"));
  return c.json({ publicId:route.publicId, canonicalPath: `/s/${route.publicId}` });
});

app.use("/api/public/shares/:publicId/*", async (c, next) => {
  const authStarted=Date.now();
  // The signed cookie is only a transport credential. D1 remains the first
  // primary authorization source for every protected public request.
  const sessionCookie=parseCookie(c.req.header("Cookie"), COOKIE_NAME);
  const signingKeys = {
    current: { keyId: c.env.SESSION_KEY_ID, secret: c.env.DELIVERY_SESSION_SECRET },
    previous: c.env.PREVIOUS_SESSION_KEY_ID && c.env.DELIVERY_PREVIOUS_SESSION_SECRET
      ? { keyId: c.env.PREVIOUS_SESSION_KEY_ID, secret: c.env.DELIVERY_PREVIOUS_SESSION_SECRET }
      : null,
  };
  let usedBulkResume = false;
  let session: { shareId: string; shareVersion: number; expiresAt: number };
  try {
    session = await verifyRotatingSessionCookie(sessionCookie, signingKeys.current, signingKeys.previous);
  } catch (sessionError) {
    const resumePath = /^\/api\/public\/shares\/[^/]+\/bulk-download\/([^/]+)\/file$/.exec(c.req.path);
    if ((c.req.method !== "GET" && c.req.method !== "HEAD") || !resumePath) throw sessionError;
    const resumed = await verifyRotatingBulkDownloadResumeCookie(
      parseCookie(c.req.header("Cookie"), BULK_DOWNLOAD_RESUME_COOKIE),
      signingKeys.current,
      signingKeys.previous,
    );
    if (resumed.jobId !== resumePath[1]) throw new HTTPException(401, { message: "Invalid download resume authorization", cause: { code: "BULK_DOWNLOAD_RESUME_INVALID" } });
    session = resumed;
    usedBulkResume = true;
  }
  const share=await lifecycleShareQuery(c.env,lifecycleShareSql("s.id=? AND s.public_id=?"),[session.shareId,c.req.param("publicId")]);
  if(!share){
    const existing=await lifecycleShareQuery(c.env,lifecycleShareSql("s.id=?"),[session.shareId]);
    if(existing)throw new HTTPException(404,{message:"This delivery link is invalid.",cause:{code:"SHARE_INVALID"}});
    throw publicShareLifecycleException("resource_removed");
  }
  c.set("share", share);
  const lifecycle=classifyPublicShareLifecycle(share);
  if(lifecycle!=="active")throw publicShareLifecycleException(lifecycle);
  if(share.share_version!==session.shareVersion)throw new HTTPException(401,{message:"This delivery session is stale.",cause:{code:"SHARE_SESSION_STALE"}});
  const policy = classifyPublicRateLimit(c.req.method, c.req.path);
  await enforceRateLimit(c, c.env[policy.binding], policy.scope);
  const authDuration=Date.now()-authStarted;
  await next();
  const timing=c.res.headers.get("Server-Timing");
  c.header("Server-Timing",`${timing?`${timing}, `:""}auth;dur=${Math.max(0,authDuration)}`);
  if(!usedBulkResume&&shouldRenewPublicShareSession({sessionExpiresAt:session.expiresAt,cookieKeyId:sessionCookie?.split(".",1)[0]||null,currentKeyId:c.env.SESSION_KEY_ID})){
    c.header("Set-Cookie",await createSessionCookie(c.env.DELIVERY_SESSION_SECRET,c.env.SESSION_KEY_ID,share.id,share.share_version,publicShareSessionExpiresAt(share.expires_at)),{append:true});
  }
});

app.get("/api/public/shares/:publicId/manifest", async c => {
  const started=Date.now();
  const share = c.get("share"); const root = normalizeRoot(share.r2_prefix);
  const folderRef = c.req.query("folder") || ""; const relativeFolder = folderRef ? decodeItemRef(folderRef) : "";
  if(share.r2_object_key){
    if(folderRef||c.req.query("cursor"))throw new HTTPException(404,{message:"Folder not found"});
    const object=await c.env.DATA_BUCKET.head(share.r2_object_key);
    if(!object||isMovedSourceMarker(object)){await markUnavailableFolder(c.env,share);throw publicShareLifecycleException("resource_removed");}
    const relative=share.r2_object_key.slice(root.length),id=encodeItemRef(relative),kind=kindForKey(share.r2_object_key),base=`/api/public/shares/${encodeURIComponent(share.public_id!)}/items/${id}`;
    const aliases=await loadAliases(c.env,[root,share.r2_object_key]);
    const item:DeliveryItem={id,name:aliases.get(share.r2_object_key)||relative.split("/").pop()||relative,kind,size:object.size,uploadedAt:object.uploaded.toISOString(),downloadUrl:`${base}/download`,previewStatus:kind==="video"?"processing":undefined,...thumbnailFieldsForObject(share.r2_object_key,kind,base,object.httpEtag,null,object.size,object.httpMetadata?.contentType)};
    item.sourceUrl=sourceUrlForItem(base,kind);if(kind==="image"&&!['dng','arw','cr2','cr3','crw','nef','raf','rw2','orf','pef','srw','3fr','rwl','srf','sr2','x3f'].includes((share.r2_object_key.split('.').pop()||'').toLowerCase()))item.previewUrl=item.sourceUrl;else if(kind==="audio"||kind==="text")item.previewUrl=`${base}/preview`;
    const manifest:DeliveryManifest={share:{publicId:share.public_id!,label:share.label,clientName:share.client_name,projectName:share.project_name,expiresAt:share.expires_at},folder:{id:"",name:item.name,breadcrumbs:[]},items:[item],nextCursor:null,capabilities:{cloudTransfer:{dropbox:false,googleDrive:false,googlePicker:false}}};
    c.executionCtx.waitUntil(Promise.all([audit(c.env,c.req.raw,share.id,"manifest.viewed",id),primaryDb(c.env).prepare("UPDATE shares SET access_count=access_count+1,last_accessed_at=datetime('now') WHERE id=?").bind(share.id).run()]));
    return c.json(manifest);
  }
  const prefix = relativeFolder ? `${keyWithinRoot(root, relativeFolder).replace(/\/$/, "")}/` : root;
  const tombstones = await loadTombstones(c.env,prefix);
  const storageStarted=Date.now();
  let listed:R2Objects;
  try{listed=await c.env.DATA_BUCKET.list({ prefix, delimiter: "/", limit: PUBLIC_DELIVERY_PAGE_SIZE, cursor: c.req.query("cursor"), include: ["httpMetadata", "customMetadata"] });}
  catch{throw temporaryPublicShareException("storage");}
  const storageDuration=Date.now()-storageStarted;
  const aliasKeys = [root, prefix, ...listed.delimitedPrefixes, ...listed.objects.map(object => object.key)]; let breadcrumbPhysical = root;
  for (const segment of relativeFolder.split("/").filter(Boolean)) { breadcrumbPhysical += `${segment}/`; aliasKeys.push(breadcrumbPhysical); }
  const aliases = await loadAliases(c.env, aliasKeys);
  const items: DeliveryItem[] = [];
  const candidateFolders=listed.delimitedPrefixes.filter(folderPrefix=>!isHiddenKey(folderPrefix)&&!isTrashed(tombstones,folderPrefix));
  const visibleFolders=await visiblePublicChildPrefixes(c.env,candidateFolders);
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
  if(!folderRef&&!c.req.query("cursor")&&!listed.truncated&&items.length===0)await markUnavailableFolder(c.env,share);
  const dropbox=cloudProviderEnabled(c.env,"dropbox"),google=cloudProviderEnabled(c.env,"google"); const manifest: DeliveryManifest = { share: { publicId: share.public_id!, label: share.label, clientName: share.client_name, projectName: aliases.get(root) || share.project_name, expiresAt: share.expires_at }, folder: { id: folderRef, name: aliases.get(currentPhysical) || relativeFolder.split("/").pop() || share.project_name, breadcrumbs }, items, nextCursor: listed.truncated ? listed.cursor : null, capabilities: { cloudTransfer: { dropbox, googleDrive: google, googlePicker: google } } };
  c.executionCtx.waitUntil(Promise.all([audit(c.env, c.req.raw, share.id, "manifest.viewed", folderRef), primaryDb(c.env).prepare("UPDATE shares SET access_count=access_count+1,last_accessed_at=datetime('now') WHERE id=?").bind(share.id).run()]));
  c.header("Server-Timing",`storage;dur=${Math.max(0,storageDuration)}, list;dur=${Math.max(0,Date.now()-started)}`);
  return c.json(manifest);
});

app.post("/api/public/shares/:publicId/manifest/media", async c => {
  const started=Date.now();
  const share = c.get("share"); const root = normalizeRoot(share.r2_prefix);
  const folderRef = c.req.query("folder") || ""; const relativeFolder = folderRef ? decodeItemRef(folderRef) : "";
  const prefix = relativeFolder ? `${keyWithinRoot(root, relativeFolder).replace(/\/$/, "")}/` : root;
  const tombstones = await loadTombstones(c.env,prefix);
  const body:{items?:unknown}=await c.req.json<{items?:unknown}>().catch(()=>({} as {items?:unknown}));
  if(!Array.isArray(body.items)||body.items.length>PUBLIC_DELIVERY_PAGE_SIZE)throw new HTTPException(400,{message:"Media item list is invalid"});
  const requestedItems:unknown[]=body.items;
  const candidates=[...new Set(requestedItems)].flatMap(value=>{
    if(typeof value!=="string")return[];
    let relative:string;try{relative=decodeItemRef(value);}catch{return[];}
    let key:string;try{key=keyWithinShare(share,value);}catch{return[];}const immediate=key.slice(prefix.length);
    if(!key.startsWith(prefix)||!immediate||(!share.r2_object_key&&immediate.includes("/"))||isHiddenKey(key)||isTrashed(tombstones,key))return[];
    const kind=kindForKey(key);if(kind!=="image"&&kind!=="pdf"&&kind!=="video")return[];
    return[{id:value,key,kind,base:`/api/public/shares/${encodeURIComponent(share.public_id!)}/items/${encodeURIComponent(value)}`}];
  });
  const db=primaryDb(c.env),rows:PublicMediaRow[]=[];const databaseStarted=Date.now();
  for(let offset=0;offset<candidates.length;offset+=PUBLIC_MEDIA_LOOKUP_CHUNK_SIZE){
    const chunk=candidates.slice(offset,offset+PUBLIC_MEDIA_LOOKUP_CHUNK_SIZE);if(!chunk.length)continue;
    const result=await db.prepare(`WITH requested(r2_key) AS (VALUES ${chunk.map(()=>"(?)").join(",")})
      SELECT requested.r2_key,file.etag,file.size,file.content_type,file.media_kind,file.stream_uid,file.stream_status,
        thumbnail.source_etag,thumbnail.thumbnail_key,thumbnail.thumbnail_etag,thumbnail.thumbnail_size,thumbnail.status thumbnail_status
      FROM requested LEFT JOIN file_index file ON file.r2_key=requested.r2_key
      LEFT JOIN image_thumbnail_jobs thumbnail ON thumbnail.source_key=requested.r2_key`).bind(...chunk.map(candidate=>candidate.key)).all<PublicMediaRow>();
    rows.push(...result.results);
  }
  const records=new Map(rows.map(row=>[row.r2_key,row]));
  const response={ items: candidates.flatMap(candidate => {
    const row=records.get(candidate.key);if(!row||row.size===null||!row.etag)return[];
    const thumbnail:ThumbnailJobRow|undefined=row.source_etag&&row.thumbnail_key&&row.thumbnail_status?{source_etag:row.source_etag,thumbnail_key:row.thumbnail_key,thumbnail_etag:row.thumbnail_etag,thumbnail_size:row.thumbnail_size,status:row.thumbnail_status}:undefined;
    return {
      id: candidate.id,
      ...thumbnailFieldsForObject(candidate.key,candidate.kind,candidate.base,row.etag,thumbnail,row.size,row.content_type||undefined),
      ...(candidate.kind === "video" ? { previewStatus: row.stream_status === "ready" && row.stream_uid ? "ready" : "processing" } : {}),
    };
  }) };
  c.header("Server-Timing",`database;dur=${Math.max(0,Date.now()-databaseStarted)}, media;dur=${Math.max(0,Date.now()-started)}`);
  return c.json(response);
});

app.get("/api/public/shares/:publicId/download-summary", async c => {
  const share = c.get("share"); await requireAvailableFolder(c.env, share);
  if(share.r2_object_key){const object=await c.env.DATA_BUCKET.head(share.r2_object_key);if(!object)throw new HTTPException(404,{message:"File not found"});return c.json(summarizeDownloadableObjects([object]));}
  const folderRef = c.req.query("folder") || "";
  const prefix = folderRef ? `${keyWithinRoot(share.r2_prefix, decodeItemRef(folderRef))}/` : normalizeRoot(share.r2_prefix);
  const tombstones = await loadTombstones(c.env,prefix);
  const objects = await listDownloadableObjects(c.env.DATA_BUCKET, prefix, tombstones);
  return c.json(summarizeDownloadableObjects(objects));
});

app.get("/api/public/shares/:publicId/locations", async c => {
  const share = c.get("share"); await requireAvailableFolder(c.env, share);
  if (share.r2_object_key||share.image_location_map_enabled !== 1) return c.json({ locations: { points: [], imageCount: 0, truncated: false }, mapboxPublicToken: null });
  const locations = await listPublicShareLocations(c.env, share, c.req.query("folder") || "");
  return c.json({ locations, mapboxPublicToken: locations.points.length ? c.env.MAPBOX_PUBLIC_TOKEN || null : null });
});

app.get("/api/public/shares/:publicId/locations/:assetRef", async c => {
  const share = c.get("share"); await requireAvailableFolder(c.env, share);
  if (share.r2_object_key||share.image_location_map_enabled !== 1) throw new HTTPException(404, { message: "Mapped image not found" });
  return c.json({ item: await resolvePublicShareLocation(c.env, share, c.req.param("assetRef"), c.req.query("folder") || "") });
});

export async function streamItem(c: any, disposition: "inline" | "attachment", raw = false, requiredKind?: "pdf"): Promise<Response> {
  const share = c.get("share") as ShareRow; const itemRef = c.req.param("itemRef") as string; const key = keyWithinShare(share,itemRef);
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
  const share = c.get("share"); const itemRef = c.req.param("itemRef"); const key = keyWithinShare(share,itemRef);
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
  const key = keyWithinShare(share,itemRef);
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
  const key = keyWithinShare(share,itemRef);
  await assertNotTrashed(c.env, key);
  const head = await c.env.DATA_BUCKET.head(key); if (!head || isMovedSourceMarker(head)) throw new HTTPException(404, { message: "File not found" });
  const base = baseForItem(share, itemRef);
  const sessionMaxMs = 12 * 60 * 60 * 1000;
  const shareRemainingMs = share.expires_at ? Math.max(0, new Date(share.expires_at).getTime() - Date.now()) : sessionMaxMs;
  const expiresAt = new Date(Date.now() + Math.min(sessionMaxMs, shareRemainingMs)).toISOString();
  return c.json({ url: `${requirePublicShareOrigin(c.env)}${base}/download`, expiresAt });
});
app.on(["GET", "HEAD"], "/api/public/shares/:publicId/items/:itemRef/download", c => downloadItem(c));

async function createStreamTicket(c: any): Promise<{ url: string; expiresAt: string }> {
  const share = c.get("share") as ShareRow; const itemRef = c.req.param("itemRef") as string; const key = keyWithinShare(share,itemRef);
  await assertNotTrashed(c.env, key);
  if (kindForKey(key) !== "video") throw new HTTPException(415, { message: "Stream preview unavailable" });
  const row = await primaryDb(c.env).prepare("SELECT stream_uid,stream_status FROM file_index WHERE r2_key=?").bind(key).first<{ stream_uid: string | null; stream_status: string | null }>();
  if (row?.stream_status !== "ready" || !row.stream_uid || !c.env.STREAM_CUSTOMER_CODE) throw new HTTPException(404, { message: "Video preview unavailable" });
  const token = await c.env.STREAM.video(row.stream_uid).generateToken();
  c.executionCtx.waitUntil(audit(c.env, c.req.raw, share.id, "preview.viewed", itemRef));
  return { url: streamPlayerUrl(c.env.STREAM_CUSTOMER_CODE, token), expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
}

app.post("/api/public/shares/:publicId/items/:itemRef/stream-ticket", async c => c.json(await createStreamTicket(c)));

app.on(["GET", "HEAD"], "/api/public/shares/:publicId/items/:itemRef/thumbnail", async c => {
  const share = c.get("share"); const itemRef = c.req.param("itemRef"); const key = keyWithinShare(share,itemRef);
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
  return primaryDb(c.env).prepare("SELECT id,status,file_count,processed_files,total_bytes,processed_bytes,archive_size,error_code,error_message,expires_at,manifest_key,archive_key,parent_job_id,part_index,part_count FROM bulk_download_jobs WHERE id=? AND share_id=? AND share_version=?").bind(jobId, share.id, share.share_version).first<any>();
}

async function getBulkParts(c: any, parentJobId: string): Promise<any[]> {
  const share = c.get("share") as ShareRow;
  return (await primaryDb(c.env).prepare("SELECT id,status,file_count,processed_files,total_bytes,processed_bytes,archive_size,error_code,error_message,expires_at,manifest_key,archive_key,parent_job_id,part_index,part_count FROM bulk_download_jobs WHERE parent_job_id=? AND share_id=? AND share_version=? ORDER BY part_index ASC")
    .bind(parentJobId, share.id, share.share_version).all<any>()).results;
}

async function streamArchive(c: any, job: any): Promise<Response> {
  const share = c.get("share") as ShareRow;
  const head = await c.env.DATA_BUCKET.head(job.archive_key); if (!head) throw new HTTPException(404, { message: "Archive not found" });
  const rangeHeader = c.req.header("Range"), ifRange = c.req.header("If-Range");
  let range: { offset: number; length: number } | undefined;
  try { range = parseRange(!ifRange || matchesEtag(ifRange, head.httpEtag) ? rangeHeader : undefined, head.size); }
  catch (error) { if (error instanceof HTTPException && error.status === 416) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head.size}`, "Accept-Ranges": "bytes" } }); throw error; }
  const partSuffix = job.parent_job_id && job.part_count > 1
    ? `-part-${String(job.part_index).padStart(Math.max(2, String(job.part_count).length), "0")}-of-${String(job.part_count).padStart(Math.max(2, String(job.part_count).length), "0")}`
    : "";
  const normalized = `${share.project_name || share.client_name || "delivery"}${partSuffix}.zip`.normalize("NFC");
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

export function bulkDownloadResumeExpiresAt(
  job: { expires_at: string },
  share: Pick<ShareRow, "expires_at">,
  now = Date.now(),
): number | null {
  const jobExpiry = Date.parse(job.expires_at);
  if (!Number.isFinite(jobExpiry) || jobExpiry <= now) return null;
  const shareExpiry = share.expires_at ? Date.parse(share.expires_at) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(shareExpiry) && share.expires_at) return null;
  const expiresAt = Math.min(jobExpiry, shareExpiry);
  return expiresAt > now ? expiresAt : null;
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
  c.executionCtx.waitUntil(c.env.DATA_BUCKET.delete([job.archive_key, job.manifest_key, `${job.manifest_key}.final.json`]));
}

app.post("/api/public/shares/:publicId/bulk-download", async c => {
  const share = c.get("share") as ShareRow;requireFolderShareFeature(share); const request = validateBulkRequest(await c.req.json().catch(() => ({}))); await consumeBulkQuota(c, share);
  const jobId = randomSecret(16); const encodedShare = encodeURIComponent(share.public_id!); const manifestKey = `_ltds/tmp-downloads/${share.public_id}/${jobId}/manifest.json`; const archiveKey = `_ltds/tmp-downloads/${share.public_id}/${jobId}/archive.zip`; const expiresAt = new Date(Date.now() + BULK_DOWNLOAD_RETENTION_MS).toISOString();
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
  requireFolderShareFeature(c.get("share") as ShareRow);
  const job = await getBulkJob(c, c.req.param("jobId")); if (!job) throw new HTTPException(404, { message: "Download job not found" });
  await expireReadyBulkJob(c, job);
  const share = c.get("share") as ShareRow;
  let parts: any[] = [];
  if (!job.parent_job_id && job.part_count > 1) {
    parts = await getBulkParts(c, job.id);
    for (const part of parts) await expireReadyBulkJob(c, part);
    const completeSet = parts.length === job.part_count;
    const failed = parts.find(part => part.status === "failed");
    const allReady = completeSet && parts.every(part => part.status === "ready");
    const anyExpired = parts.some(part => part.status === "expired");
    job.status = failed ? "failed" : anyExpired ? "expired" : allReady ? "ready" : "running";
    job.file_count = parts.reduce((total, part) => total + (part.file_count || 0), 0);
    job.processed_files = parts.reduce((total, part) => total + (part.processed_files || 0), 0);
    job.total_bytes = parts.reduce((total, part) => total + (part.total_bytes || 0), 0);
    job.processed_bytes = parts.reduce((total, part) => total + (part.processed_bytes || 0), 0);
    job.archive_size = allReady ? parts.reduce((total, part) => total + (part.archive_size || 0), 0) : null;
    job.error_code = failed?.error_code || null;
    job.error_message = failed?.error_message || null;
    if (parts.length) job.expires_at = parts.reduce((earliest, part) => Date.parse(part.expires_at) < Date.parse(earliest) ? part.expires_at : earliest, parts[0]!.expires_at);
  }
  const failure = job.error_code ? friendlyBulkFailure(job.error_code) : null;
  const progress = bulkJobProgress(job);
  const encodedShare = encodeURIComponent(share.public_id!);
  const response: Record<string, unknown> = { jobId: job.id, status: job.status, fileCount: job.file_count, processedFiles: job.processed_files, totalBytes: job.total_bytes, processedBytes: job.processed_bytes, archiveSize: job.archive_size, expiresAt: job.expires_at, error: failure, downloadUrl: null, partCount: job.part_count || 1, downloads: [], ...progress };
  if (job.status === "ready") {
    const readyParts = parts.length ? parts : [job];
    const downloads = readyParts.map(part => ({
      part: part.part_index || 1,
      partCount: part.part_count || 1,
      size: part.archive_size,
      downloadUrl: `/api/public/shares/${encodedShare}/bulk-download/${part.id}/file`,
    }));
    response.downloads = downloads;
    if (downloads.length === 1) response.downloadUrl = downloads[0]!.downloadUrl;
    for (const part of readyParts) {
      const resumeExpiresAt = bulkDownloadResumeExpiresAt(part, share);
      if (!resumeExpiresAt) continue;
      // The browser download manager can issue Range requests for the entire
      // prepared-archive retention window. D1 share/version/revocation checks
      // still run on every resumed request.
      c.header("Set-Cookie", await createBulkDownloadResumeCookie({
        secret: c.env.DELIVERY_SESSION_SECRET,
        keyId: c.env.SESSION_KEY_ID,
        shareId: share.id,
        shareVersion: share.share_version,
        publicId: share.public_id!,
        jobId: part.id,
        expiresAt: resumeExpiresAt,
      }), { append: true });
    }
  }
  return c.json(response);
});

app.on(["GET", "HEAD"], "/api/public/shares/:publicId/bulk-download/:jobId/file", async c => {
  requireFolderShareFeature(c.get("share") as ShareRow);
  const job = await getBulkJob(c, c.req.param("jobId")); if (!job) throw new HTTPException(404, { message: "Download is not ready" });
  await expireReadyBulkJob(c, job);
  if (job.status !== "ready") throw new HTTPException(job.status === "expired" ? 410 : 404, { message: job.status === "expired" ? "This prepared download has expired." : "Download is not ready" });
  return streamArchive(c, job);
});

app.post("/api/public/shares/:publicId/cloud-transfers/oauth/:provider/start",async c=>{
 requireSameOrigin(c.req.raw,c.env);const share=c.get("share") as ShareRow;requireFolderShareFeature(share);const provider=cloudProvider(c.req.param("provider"));if(!cloudProviderEnabled(c.env,provider))throw new HTTPException(503,{message:"This cloud provider is not available yet"});
 const body=await c.req.json().catch(()=>({})) as {selection?:unknown;destination?:unknown;conflictMode?:unknown;callbackNonce?:unknown};
 const selection=validateBulkRequest(body.selection);const conflictMode=body.conflictMode==="skip"?"skip":"autorename";if(typeof body.callbackNonce!=="string"||!/^[A-Za-z0-9_-]{24,128}$/.test(body.callbackNonce))throw new HTTPException(400,{message:"Invalid callback nonce"});
 const windowStart=Math.floor(Date.now()/3600000);const quota=await primaryDb(c.env).prepare(`INSERT INTO cloud_transfer_quota(share_id,window_start,created_count,total_bytes) VALUES(?,?,1,0)
  ON CONFLICT(share_id,window_start) DO UPDATE SET created_count=created_count+1,updated_at=datetime('now') WHERE created_count<3`).bind(share.id,windowStart).run();
 if(!quota.meta.changes){c.header("Retry-After",String(bulkQuotaRetryAfterSeconds()));throw new HTTPException(429,{message:"This delivery has reached its hourly cloud-copy limit."});}
 const pkce=await createPkce(),state=createOAuthState(),stateHash=await sha256(state);const env=cloudEnv(c.env),requestOrigin=new URL(c.req.url).origin;const encrypted=await encryptCloudSecret({verifier:pkce.verifier,callbackNonce:body.callbackNonce,requestOrigin},env.CLOUD_TRANSFER_TOKEN_SECRET,`oauth-state:${stateHash}:${provider}`);
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
 const env=cloudEnv(c.env);const secret=await decryptCloudSecret<{verifier:string;callbackNonce:string;requestOrigin?:string}>(row.pkce_ciphertext,row.pkce_iv,env.CLOUD_TRANSFER_TOKEN_SECRET,`oauth-state:${stateHash}:${provider}`);
 const share=await primaryDb(c.env).prepare(activeShareSql("s.id=? AND s.share_version=?")).bind(row.share_id,row.share_version).first<ShareRow>();if(!share||!share.public_id)throw new HTTPException(404,{message:"This delivery is no longer available"});
 requireFolderShareFeature(share);
 const redirectUri=cloudRedirectUri(c.env,provider);const token=provider==="dropbox"?await exchangeDropboxCode({clientId:c.env.DROPBOX_CLIENT_ID!,clientSecret:c.env.DROPBOX_CLIENT_SECRET!,redirectUri,code,verifier:secret.verifier}):await exchangeGoogleCode({clientId:c.env.GOOGLE_CLIENT_ID!,clientSecret:c.env.GOOGLE_CLIENT_SECRET!,redirectUri,code,verifier:secret.verifier});
 const authorizationId=randomSecret(16),jobId=randomSecret(16);const credential=await encryptCloudSecret(token,env.CLOUD_TRANSFER_TOKEN_SECRET,`authorization:${authorizationId}:${provider}`);const expiresAt=new Date(Date.now()+24*3600000).toISOString();
 const pendingGoogle=provider==="google";const destination=pendingGoogle?JSON.stringify({pendingPicker:true}):row.destination_json;
 await c.env.DELIVERY_DB.batch([
  primaryDb(c.env).prepare(`INSERT INTO cloud_transfer_authorizations(id,share_id,share_version,provider,credential_ciphertext,credential_iv,key_id,scopes,token_expires_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(authorizationId,share.id,share.share_version,provider,credential.ciphertext,credential.iv,env.CLOUD_TRANSFER_KEY_ID||"v1",token.scope||"",token.expiresAt||null,expiresAt),
  primaryDb(c.env).prepare(`INSERT INTO cloud_transfer_jobs(id,share_id,share_version,authorization_id,provider,selection_json,destination_json,conflict_mode,status,expires_at) VALUES(?,?,?,?,?,?,?,?, 'queued',?)`).bind(jobId,share.id,share.share_version,authorizationId,provider,row.selection_json,destination,row.conflict_mode,expiresAt),
 ]);
 if(!pendingGoogle){try{await c.env.CLOUD_TRANSFER_WORKFLOW.create({id:jobId,params:{jobId}});}catch(error){console.error(JSON.stringify({event:"cloud-transfer.workflow-create-failed",jobId,provider,error:error instanceof Error?error.message:String(error)}));await primaryDb(c.env).prepare("UPDATE cloud_transfer_jobs SET status='failed',error_code='transfer-failed',error_message=?,updated_at=datetime('now') WHERE id=?").bind(friendlyCloudFailure("transfer-failed").message,jobId).run();}}
 const url=new URL(`/s/${encodeURIComponent(share.public_id)}`,cloudTransferResumeOrigin(c.env,secret.requestOrigin));url.searchParams.set("cloudTransferNonce",secret.callbackNonce);url.searchParams.set("cloudTransferProvider",providerPublicName(provider));
 if(pendingGoogle)url.searchParams.set("cloudTransferAuthorization",authorizationId);else url.searchParams.set("cloudTransferJob",jobId);
 return c.redirect(url.toString(),302);
});

app.post("/api/public/shares/:publicId/cloud-transfers/google/authorizations/:authorizationId/token",async c=>{
 requireSameOrigin(c.req.raw,c.env);const share=c.get("share") as ShareRow;requireFolderShareFeature(share);const env=cloudEnv(c.env),authorizationId=c.req.param("authorizationId");
 const row=await getGooglePickerAuthorization(env,authorizationId,share.id,share.share_version);
 if(!row)throw new HTTPException(404,{message:"Google authorization not found"});const credential=await googlePickerCredential(env,authorizationId,row);if(!credential.accessToken)throw new HTTPException(401,{message:"Google authorization expired"});
 c.header("Cache-Control","no-store");c.header("Pragma","no-cache");c.header("Referrer-Policy","no-referrer");return c.json({accessToken:credential.accessToken,expiresAt:credential.expiresAt||null});
});

app.post("/api/public/shares/:publicId/cloud-transfers",async c=>{
 requireSameOrigin(c.req.raw,c.env);const share=c.get("share") as ShareRow;requireFolderShareFeature(share);const env=cloudEnv(c.env);const body=await c.req.json().catch(()=>({})) as {authorizationId?:unknown;folderId?:unknown};
 if(typeof body.authorizationId!=="string"||!/^[A-Za-z0-9_-]{16,128}$/.test(body.authorizationId)||!validGoogleFolderId(body.folderId))throw new HTTPException(400,{message:"A valid Google Drive destination is required"});
 const job=await activatePendingGoogleJob(env,{authorizationId:body.authorizationId,shareId:share.id,shareVersion:share.share_version,folderId:body.folderId});if(!job)throw new HTTPException(404,{message:"Google authorization not found or already used"});
 try{await c.env.CLOUD_TRANSFER_WORKFLOW.create({id:job.id,params:{jobId:job.id}});}catch(error){console.error(JSON.stringify({event:"cloud-transfer.workflow-create-failed",jobId:job.id,provider:"google",error:error instanceof Error?error.message:String(error)}));await cloudDb(env).prepare("UPDATE cloud_transfer_jobs SET status='failed',error_code='transfer-failed',error_message=?,updated_at=datetime('now') WHERE id=?").bind(friendlyCloudFailure("transfer-failed").message,job.id).run();throw new HTTPException(503,{message:"The cloud transfer could not be queued"});}
 return c.json({id:job.id,provider:"google-drive",status:"queued"},202);
});

app.get("/api/public/shares/:publicId/cloud-transfers/:jobId",async c=>{
 const share=c.get("share") as ShareRow;requireFolderShareFeature(share);const job=await getAuthorizedCloudJob(cloudEnv(c.env),c.req.param("jobId"),share.id,share.share_version);if(!job)throw new HTTPException(404,{message:"Cloud transfer not found"});const items=await listCloudItems(cloudEnv(c.env),job.id);
 return c.json({id:job.id,provider:providerPublicName(job.provider),status:cloudStatus(job.status),processedFiles:job.processed_files,totalFiles:job.file_count,processedBytes:job.processed_bytes,totalBytes:job.total_bytes,error:job.error_code?friendlyCloudFailure(job.error_code):null,items:items.map(item=>({id:item.id,name:item.relative_path,status:item.status==="completed"?"copied":item.status==="queued"?"waiting":item.status==="running"?"copying":item.status,processedBytes:item.uploaded_bytes,totalBytes:item.source_size,message:item.error_message||undefined}))});
});

app.post("/api/public/shares/:publicId/cloud-transfers/:jobId/cancel",async c=>{
 requireSameOrigin(c.req.raw,c.env);const share=c.get("share") as ShareRow;requireFolderShareFeature(share);const env=cloudEnv(c.env);if(!(await requestCloudCancellation(env,c.req.param("jobId"),share.id,share.share_version)))throw new HTTPException(409,{message:"This transfer can no longer be cancelled"});const job=await getAuthorizedCloudJob(env,c.req.param("jobId"),share.id,share.share_version);return c.json({id:job!.id,provider:providerPublicName(job!.provider),status:"cancelling"});
});

app.post("/api/public/shares/:publicId/cloud-transfers/:jobId/retry",async c=>{
 requireSameOrigin(c.req.raw,c.env);const share=c.get("share") as ShareRow;requireFolderShareFeature(share);const env=cloudEnv(c.env),jobId=c.req.param("jobId");const count=await retryFailedCloudItems(env,jobId,share.id,share.share_version);if(!count)throw new HTTPException(409,{message:"There are no failed files to retry"});
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
  const artifactKeys = [...new Set(expiredJobs.results.flatMap(job => [job.manifest_key, job.archive_key, `${job.manifest_key}.final.json`]).filter(Boolean))];
  for (let offset = 0; offset < artifactKeys.length; offset += 1000) await env.DATA_BUCKET.delete(artifactKeys.slice(offset, offset + 1000));
  const activeJobs = await primaryDb(env).prepare("SELECT manifest_key,archive_key FROM bulk_download_jobs WHERE status IN ('queued','running','ready') AND datetime(expires_at)>datetime(?)")
    .bind(nowIso).all<{ manifest_key: string; archive_key: string }>();
  const protectedKeys = new Set(activeJobs.results.flatMap(job => [job.manifest_key, job.archive_key, `${job.manifest_key}.final.json`]).filter(Boolean));
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
app.post("/api/internal/project-alpha/service-assignments-v1", c => handleProjectAlphaServiceAssignmentsRequest(c.req.raw, c.env));
app.post("/api/internal/project-alpha/sources/:sourceId/service-assignments-v1",
  c => handleRegisteredProjectAlphaServiceAssignmentsRequest(c.req.raw, c.env, c.req.param("sourceId")));

app.route("/api/client", createClientPortalRouter({ pricingHintProvider: projectAlphaPricingHintProvider }));
app.on(["GET", "HEAD"], "/portal", c => serveAppShell(c.req.raw, c.env.ASSETS));
app.on(["GET", "HEAD"], "/portal/*", c => serveAppShell(c.req.raw, c.env.ASSETS));
app.on(["GET", "HEAD"], "/assets/*", c => {
  const path = new URL(c.req.url).pathname;
  if (/%(?:2e|2f|5c)/i.test(path)) throw new HTTPException(404, { message: "Asset not found" });
  return c.env.ASSETS.fetch(c.req.raw);
});
app.get("/", c => c.redirect(new URL("/portal", clientPortalEntryOrigin(c.req.url, c.env)).toString(), 302));

app.notFound(c => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  const message = error instanceof Error ? error.message : String(error);
  const schemaOutdated = c.req.path.startsWith("/api/client/") &&
    /no such (?:table|column):/i.test(message);
  const status = schemaOutdated
    ? 503
    : error instanceof HTTPException
      ? error.status
      : 500;
  const cause=error instanceof Error?error.cause as {code?:string;layer?:"database"|"storage"}|undefined:undefined;
  const code=cause?.code;
  const publicShareRequest=c.req.path.startsWith("/api/public/shares/");
  if(publicShareRequest&&status>=400)logPublicShareOutcome(c.req.raw,{outcome:code||"UNEXPECTED_FAILURE",status,shareId:c.get("share")?.id,layer:cause?.layer});
  if (status >= 500&&!publicShareRequest) console.error(JSON.stringify({ event: "delivery.error", status, message: error instanceof Error ? error.message : "unknown" }));
  return c.json(schemaOutdated
    ? {
        error: "Client portal data is temporarily unavailable while its database update finishes.",
        code: "CLIENT_PORTAL_SCHEMA_OUTDATED",
      }
    : { error: status >= 500 ? "An unexpected error occurred" : error.message,...(code?{code}:{}) }, status);
});

export default { fetch: app.fetch, scheduled: (event, env, ctx) => {
  const tasks: Promise<unknown>[] = [processInvitationEmailBatch(env)];
  // Invitation delivery has a five-minute SLA. Heavier storage cleanup stays
  // on the existing hourly trigger so the more frequent mail poll does not
  // multiply R2/D1 maintenance work.
  if (event.cron === "15 * * * *") tasks.push(
    cleanupTemporaryZips(env),
    cleanupExpiredRequestAttachments(env),
    reconcileExpiredClientDelegatedShares(env).then(result => {
      if (result.sharesExpired || result.delegationsExpired || result.sharesAtLimit || result.delegationsAtLimit)
        console.log(JSON.stringify({ event: "client-delegated-share.expiry-reconciled", ...result }));
    }),
    env.CLOUD_TRANSFER_TOKEN_SECRET
      ? cleanupCloudTransfers(cloudEnv(env), { dropbox: createCloudProviderAdapter("dropbox", cloudEnv(env)), google: createCloudProviderAdapter("google", cloudEnv(env)) })
      : Promise.resolve(),
  );
  ctx.waitUntil(Promise.all(tasks).then(() => undefined));
} } satisfies ExportedHandler<Env>;
