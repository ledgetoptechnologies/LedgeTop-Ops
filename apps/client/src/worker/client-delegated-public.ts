import { type DeliveryItem, type DeliveryManifest, isMovedSourceMarker } from "@ltds/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  decodeItemRef,
  encodeItemRef,
  indexedImmediateChildVisibility,
  isHiddenKey,
  keyWithinRoot,
  kindForKey,
  mimeForKey,
  normalizeRoot,
  parseRange,
  safeFileName,
  streamPlayerUrl,
} from "./files";
import { listDownloadableObjects, summarizeDownloadableObjects } from "./downloadable-files";
import { matchesEtag } from "./prepared-images";
import { listScopedDeliveryLocations, resolveScopedDeliveryLocation } from "./public-locations";
import { hmac, parseCookie, sha256, verifyAccessCode } from "./security";
import { serveAuthorizedThumbnail, thumbnailFieldsForObject, type ThumbnailJobRow } from "./thumbnails";
import type { Env } from "./types";
import {
  authorizeClientDelegatedPublicDelivery,
  CLIENT_DELEGATED_SHARE_COOKIE,
  createClientDelegatedShareSessionCookie,
  verifyClientDelegatedShareSessionCookie,
  type AuthorizedClientDelegatedPublicDelivery,
} from "./client-portal/delegated-shares";

type Variables = { delegatedShare: AuthorizedClientDelegatedPublicDelivery };
interface Tombstone { physical_key: string; tombstone_kind: "exact" | "prefix"; }

const API_ROOT = "/shares";
const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
export const CLIENT_DELEGATED_FOLDER_PAGE_SIZE = 150;
const MEDIA_LOOKUP_BATCH_SIZE = 75;

interface DelegatedMediaCandidate {
  id:string;
  key:string;
  kind:Exclude<DeliveryItem["kind"],"folder">;
  etag:string;
  size:number;
  contentType?:string;
  base:string;
}

async function delegatedMediaPatches(
  database:D1Database,
  candidates:readonly DelegatedMediaCandidate[],
):Promise<Map<string,Partial<DeliveryItem>&{id:string}>>{
  const thumbnailByKey=new Map<string,ThumbnailJobRow>();
  const videoByKey=new Map<string,{stream_uid?:string;stream_status?:string}>();
  for(let offset=0;offset<candidates.length;offset+=MEDIA_LOOKUP_BATCH_SIZE){
    const batch=candidates.slice(offset,offset+MEDIA_LOOKUP_BATCH_SIZE);
    if(!batch.length)continue;
    const keys=batch.map(candidate=>candidate.key),videos=batch.filter(candidate=>candidate.kind==="video");
    const [thumbnailRows,videoRows]=await Promise.all([
      database.prepare(`SELECT source_key,source_etag,thumbnail_key,thumbnail_etag,thumbnail_size,status
        FROM image_thumbnail_jobs WHERE source_key IN (${keys.map(()=>"?").join(",")})`).bind(...keys)
        .all<ThumbnailJobRow&{source_key:string}>(),
      videos.length?database.prepare(`SELECT r2_key,stream_uid,stream_status FROM file_index
        WHERE r2_key IN (${videos.map(()=>"?").join(",")})`).bind(...videos.map(candidate=>candidate.key))
        .all<{r2_key:string;stream_uid?:string;stream_status?:string}>():Promise.resolve({results:[]} as {results:Array<{r2_key:string;stream_uid?:string;stream_status?:string}>}),
    ]);
    for(const row of thumbnailRows.results)thumbnailByKey.set(row.source_key,row);
    for(const row of videoRows.results)videoByKey.set(row.r2_key,row);
  }
  return new Map(candidates.map(candidate=>{
    const video=videoByKey.get(candidate.key);
    return[candidate.id,{
      id:candidate.id,
      ...thumbnailFieldsForObject(candidate.key,candidate.kind,candidate.base,candidate.etag,
        thumbnailByKey.get(candidate.key),candidate.size,candidate.contentType),
      ...(candidate.kind==="video"?{previewStatus:video?.stream_status==="ready"&&video.stream_uid
        ?"ready":video?.stream_status==="error"?"unavailable":"processing"}:{}),
    }];
  }));
}

function db(env: Pick<Env, "DELIVERY_DB">): D1Database {
  const candidate = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return candidate.withSession?.("first-primary") ?? candidate;
}

function configured(env: Env): boolean {
  return env.CLIENT_DELEGATED_SHARES_ENABLED === "true" &&
    Boolean(env.CLIENT_DELEGATED_SHARE_SESSION_SECRET && env.CLIENT_DELEGATED_SHARE_SESSION_SECRET.length >= 32) &&
    Boolean(env.CLIENT_DELEGATED_SHARE_KEY_ID && /^[A-Za-z0-9_-]{1,32}$/.test(env.CLIENT_DELEGATED_SHARE_KEY_ID));
}

async function clientAddressHash(env: Env, request: Request): Promise<string> {
  return hmac(env.AUDIT_IP_SECRET, request.headers.get("CF-Connecting-IP") || "unknown");
}

async function enforceRateLimit(
  c: { env: Env; req: { raw: Request }; header(name: string, value: string): void },
  limiter: RateLimit,
  scope: string,
  shareId: string,
): Promise<void> {
  const addressHash = await clientAddressHash(c.env, c.req.raw);
  const result = await limiter.limit({ key: `client-share:${scope}:${shareId}:${addressHash}` });
  if (!result.success) {
    c.header("Retry-After", "60");
    throw new HTTPException(429, { message: "Too many requests. Please wait and try again." });
  }
}

function rateLimitFor(method: string, path: string): { binding: keyof Pick<Env,
  "PUBLIC_MANIFEST_RATE_LIMITER" | "PUBLIC_MEDIA_RATE_LIMITER" | "PUBLIC_THUMBNAIL_RATE_LIMITER" |
  "PUBLIC_DOWNLOAD_RATE_LIMITER" | "PUBLIC_STREAM_RATE_LIMITER">; scope: string } {
  if (path.endsWith("/download-summary") || path.endsWith("/manifest") || path.endsWith("/manifest/media") || path.endsWith("/locations"))
    return { binding: "PUBLIC_MANIFEST_RATE_LIMITER", scope: "manifest" };
  if (path.endsWith("/thumbnail")) return { binding: "PUBLIC_THUMBNAIL_RATE_LIMITER", scope: "thumbnail" };
  if (path.endsWith("/stream-ticket")) return { binding: "PUBLIC_STREAM_RATE_LIMITER", scope: "stream" };
  if (path.endsWith("/download") || path.endsWith("/download-ticket"))
    return { binding: "PUBLIC_DOWNLOAD_RATE_LIMITER", scope: "download" };
  return { binding: "PUBLIC_MEDIA_RATE_LIMITER", scope: method === "HEAD" ? "media-head" : "media" };
}

async function audit(
  env: Env,
  request: Request,
  share: AuthorizedClientDelegatedPublicDelivery,
  eventType: string,
  itemRef?: string,
): Promise<void> {
  const details = JSON.stringify({
    ...(itemRef ? { itemRef } : {}),
    addressHash: await clientAddressHash(env, request),
    userAgent: (request.headers.get("user-agent") || "").slice(0, 240),
  });
  await db(env).prepare(`INSERT INTO client_delegated_share_events
    (id,workspace_id,delegation_id,share_id,actor_type,event_type,details_json)
    VALUES (?,?,?,?,'public',?,?)`)
    .bind(crypto.randomUUID(), share.workspaceId, share.delegationId, share.shareId, eventType, details).run();
}

async function loadTombstones(env: Env): Promise<Tombstone[]> {
  const result = await db(env).prepare("SELECT physical_key,tombstone_kind FROM delivery_tombstones WHERE restored_at IS NULL")
    .all<Tombstone>();
  return result.results;
}

function isTrashed(tombstones: readonly Tombstone[], key: string): boolean {
  return tombstones.some(tombstone => tombstone.tombstone_kind === "exact"
    ? tombstone.physical_key === key
    : key.startsWith(tombstone.physical_key));
}

async function assertVisibleObject(env: Env, key: string): Promise<R2Object> {
  if (isHiddenKey(key) || isTrashed(await loadTombstones(env), key))
    throw new HTTPException(404, { message: "File not found" });
  const object = await env.DATA_BUCKET.head(key);
  if (!object || isMovedSourceMarker(object)) throw new HTTPException(404, { message: "File not found" });
  return object;
}

async function loadAliases(env: Env, keys: string[]): Promise<Map<string, string>> {
  const aliases = new Map<string, string>();
  const unique = [...new Set(keys)];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100);
    if (!batch.length) continue;
    const result = await db(env).prepare(`SELECT physical_key,display_name FROM file_aliases
      WHERE physical_key IN (${batch.map(() => "?").join(",")})`).bind(...batch)
      .all<{ physical_key: string; display_name: string }>();
    for (const row of result.results) aliases.set(row.physical_key, row.display_name);
  }
  return aliases;
}

async function visibleChildPrefixes(
  env: Env,
  candidates: readonly string[],
): Promise<{visible:Set<string>;reconciliationNeeded:boolean}> {
  const visible = new Set<string>();
  let indexed = new Set<string>();
  try {
    const state = await indexedImmediateChildVisibility(db(env), candidates);
    indexed = state.indexed;
    for (const value of state.visible) visible.add(value);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "client-share.folder-index-reconciliation-needed",
      candidateCount: candidates.length,
      reason: "lookup_failed",
      errorName: error instanceof Error ? error.name : "unknown",
    }));
  }
  const unindexed=candidates.filter(candidate=>!indexed.has(candidate));
  if(unindexed.length)console.warn(JSON.stringify({
    event:"client-share.folder-index-reconciliation-needed",candidateCount:candidates.length,
    unindexedCount:unindexed.length,reason:"index_lag",
  }));
  // Fail closed when neither visibility index knows the prefix. This avoids
  // both recursive subtree scans and disclosure of stale folder names.
  return {visible,reconciliationNeeded:unindexed.length>0};
}

function itemBase(publicId: string, itemRef: string): string {
  return `/client-share/api/shares/${encodeURIComponent(publicId)}/items/${encodeURIComponent(itemRef)}`;
}

function sourceUrl(base: string, kind: DeliveryItem["kind"]): string | undefined {
  if (!["image", "video", "audio", "pdf", "text"].includes(kind)) return undefined;
  return `${base}/${kind === "pdf" ? "pdf" : "source"}`;
}

function aliasedPath(key: string, root: string, aliases: Map<string, string>): string {
  const relative = key.slice(root.length).replace(/\/$/, "");
  const names: string[] = [];
  let physical = root;
  relative.split("/").forEach((segment, index, segments) => {
    physical += segment;
    names.push(aliases.get(physical + (index === segments.length - 1 ? "" : "/")) || segment);
    physical += "/";
  });
  return names.join("/");
}

async function streamItem(
  c: any,
  disposition: "inline" | "attachment",
  requiredKind?: "pdf",
): Promise<Response> {
  const share = c.get("delegatedShare") as AuthorizedClientDelegatedPublicDelivery;
  const itemRef = c.req.param("itemRef") as string;
  const key = keyWithinRoot(share.deliveryPrefix, decodeItemRef(itemRef));
  const kind = kindForKey(key);
  if (requiredKind && kind !== requiredKind) throw new HTTPException(415, { message: "PDF preview is not available" });
  if (disposition === "inline" && !["image", "video", "audio", "pdf", "text"].includes(kind))
    throw new HTTPException(415, { message: "Preview is not available" });
  const head = await assertVisibleObject(c.env, key);
  let range: { offset: number; length: number } | undefined;
  try {
    range = parseRange(!c.req.header("If-Range") || matchesEtag(c.req.header("If-Range"), head.httpEtag)
      ? c.req.header("Range") : undefined, head.size);
  } catch (error) {
    if (error instanceof HTTPException && error.status === 416)
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${head.size}`, "Accept-Ranges": "bytes" } });
    throw error;
  }
  const alias = disposition === "attachment"
    ? await db(c.env).prepare("SELECT display_name FROM file_aliases WHERE physical_key=?").bind(key)
      .first<{ display_name: string }>()
    : null;
  const fileName = (alias?.display_name || safeFileName(key)).replace(/[\0-\x1f\x7f"\\]/g, "_").slice(0, 180) || "file";
  const headers = new Headers();
  head.writeHttpMetadata(headers);
  headers.set("Content-Type", mimeForKey(key));
  headers.set("ETag", head.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Disposition", `${disposition}; filename="${fileName}"`);
  if (range) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    headers.set("Content-Length", String(range.length));
  } else headers.set("Content-Length", String(head.size));
  if (c.req.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
  const object = await c.env.DATA_BUCKET.get(key, range ? { range } : undefined);
  if (!object) throw new HTTPException(404, { message: "File not found" });
  c.executionCtx.waitUntil(audit(c.env, c.req.raw, share,
    disposition === "attachment" ? "client_share.download.started" : "client_share.preview.viewed", itemRef));
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

export function createClientDelegatedPublicRouter(): Hono<{ Bindings: Env; Variables: Variables }> {
  const router = new Hono<{ Bindings: Env; Variables: Variables }>();

  router.post(`${API_ROOT}/:publicId/session`, async c => {
    if (!configured(c.env)) return c.json({ error: "Client share links are not available", code: "feature-disabled" }, 503);
    await enforceRateLimit(c, c.env.PUBLIC_SESSION_RATE_LIMITER, "session", c.req.param("publicId"));
    const body: { secret?: unknown; accessCode?: unknown } =
      await c.req.json<{ secret?: unknown; accessCode?: unknown }>().catch(() => ({}));
    const secret = typeof body.secret === "string" ? body.secret : "";
    if (secret.length < 32 || secret.length > 128) throw new HTTPException(404, { message: "This link is invalid, expired, or revoked" });
    const candidate = await db(c.env).prepare(`SELECT id,share_version FROM client_delegated_shares
      WHERE public_id=? AND token_hash=? AND status='active' AND revoked_at IS NULL
        AND datetime(expires_at)>datetime('now')`)
      .bind(c.req.param("publicId"), await sha256(secret)).first<{ id: string; share_version: number }>();
    if (!candidate) throw new HTTPException(404, { message: "This link is invalid, expired, or revoked" });
    const share = await authorizeClientDelegatedPublicDelivery(c.env, {
      publicId: c.req.param("publicId"), shareVersion: candidate.share_version, expectedShareId: candidate.id,
    });
    if (!share) throw new HTTPException(404, { message: "This link is invalid, expired, or revoked" });
    if (share.passwordHash && share.passwordSalt) {
      const accessCode = typeof body.accessCode === "string" ? body.accessCode : "";
      if (!accessCode) return c.json({ error: "Access code required", code: "ACCESS_CODE_REQUIRED" }, 401);
      await enforceRateLimit(c, c.env.ACCESS_CODE_RATE_LIMITER, "access-code", share.shareId);
      let valid = await verifyAccessCode(accessCode, share.passwordHash, share.passwordSalt, 1,
        share.passwordAlgorithm, c.env.DELIVERY_ACCESS_CODE_PEPPER);
      if (!valid && c.env.DELIVERY_PREVIOUS_ACCESS_CODE_PEPPER)
        valid = await verifyAccessCode(accessCode, share.passwordHash, share.passwordSalt, 1,
          share.passwordAlgorithm, c.env.DELIVERY_PREVIOUS_ACCESS_CODE_PEPPER);
      if (!valid) return c.json({ error: "The access code is not correct", code: "ACCESS_CODE_INVALID" }, 401);
    }
    const expiresAt = Math.min(Date.now() + SESSION_MAX_MS, Date.parse(share.shareExpiresAt));
    c.header("Set-Cookie", await createClientDelegatedShareSessionCookie(
      c.env.CLIENT_DELEGATED_SHARE_SESSION_SECRET!, c.env.CLIENT_DELEGATED_SHARE_KEY_ID!,
      { shareId: share.shareId, shareVersion: share.shareVersion, expiresAt },
    ));
    c.executionCtx.waitUntil(audit(c.env, c.req.raw, share, "client_share.session.created"));
    return c.json({ publicId: share.publicId, canonicalPath: `/client-share/${encodeURIComponent(share.publicId)}` });
  });

  router.use(`${API_ROOT}/:publicId/*`, async (c, next) => {
    if (!configured(c.env)) throw new HTTPException(404, { message: "This link is invalid, expired, or revoked" });
    const session = await verifyClientDelegatedShareSessionCookie(
      c.env.CLIENT_DELEGATED_SHARE_SESSION_SECRET!, c.env.CLIENT_DELEGATED_SHARE_KEY_ID!,
      parseCookie(c.req.header("Cookie"), CLIENT_DELEGATED_SHARE_COOKIE),
    );
    const share = await authorizeClientDelegatedPublicDelivery(c.env, {
      publicId: c.req.param("publicId"), shareVersion: session.shareVersion, expectedShareId: session.shareId,
    });
    if (!share) throw new HTTPException(404, { message: "This link is invalid, expired, or revoked" });
    c.set("delegatedShare", share);
    const policy = rateLimitFor(c.req.method, c.req.path);
    await enforceRateLimit(c, c.env[policy.binding], policy.scope, share.shareId);
    await next();
  });

  router.get(`${API_ROOT}/:publicId/manifest`, async c => {
    const started=Date.now();
    const share = c.get("delegatedShare");
    const root = normalizeRoot(share.deliveryPrefix);
    const tombstones = await loadTombstones(c.env);
    const folderRef = c.req.query("folder") || "";
    const relativeFolder = folderRef ? decodeItemRef(folderRef) : "";
    const prefix = relativeFolder ? `${keyWithinRoot(root, relativeFolder).replace(/\/$/, "")}/` : root;
    const listed = await c.env.DATA_BUCKET.list({
      prefix, delimiter: "/", limit: CLIENT_DELEGATED_FOLDER_PAGE_SIZE, cursor: c.req.query("cursor"),
      include: ["httpMetadata", "customMetadata"],
    });
    const listedAt=Date.now();
    const aliasKeys = [root, prefix, ...listed.delimitedPrefixes, ...listed.objects.map(object => object.key)];
    let breadcrumbPhysical = root;
    for (const segment of relativeFolder.split("/").filter(Boolean)) {
      breadcrumbPhysical += `${segment}/`;
      aliasKeys.push(breadcrumbPhysical);
    }
    const mediaCandidates:DelegatedMediaCandidate[]=listed.objects.flatMap(object=>{
      if(!object.key.startsWith(prefix)||object.key===prefix||object.key.endsWith("/")||
        isHiddenKey(object.key)||isTrashed(tombstones,object.key)||isMovedSourceMarker(object))return[];
      const relative=object.key.slice(root.length),id=encodeItemRef(relative),kind=kindForKey(object.key);
      if(kind!=="image"&&kind!=="pdf"&&kind!=="video")return[];
      return[{id,key:object.key,kind,etag:object.httpEtag,size:object.size,
        contentType:object.httpMetadata?.contentType,base:itemBase(share.publicId,id)}];
    });
    const items: DeliveryItem[] = [];
    const candidateFolders = listed.delimitedPrefixes.filter(folderPrefix =>
      folderPrefix.startsWith(prefix) && !isHiddenKey(folderPrefix) && !isTrashed(tombstones, folderPrefix));
    const [aliases,folderVisibility,mediaPatches]=await Promise.all([
      loadAliases(c.env,aliasKeys),visibleChildPrefixes(c.env,candidateFolders),
      delegatedMediaPatches(db(c.env),mediaCandidates),
    ]);
    for (const folderPrefix of listed.delimitedPrefixes) {
      if (!folderVisibility.visible.has(folderPrefix)) continue;
      const relative = folderPrefix.slice(root.length).replace(/\/$/, "");
      if (!relative) continue;
      items.push({ id: encodeItemRef(relative), name: aliases.get(folderPrefix) || relative.split("/").pop() || relative,
        kind: "folder", size: null, uploadedAt: null });
    }
    for (const object of listed.objects) {
      if (!object.key.startsWith(prefix) || object.key === prefix || object.key.endsWith("/") ||
          isHiddenKey(object.key) || isTrashed(tombstones, object.key) || isMovedSourceMarker(object)) continue;
      const relative = object.key.slice(root.length);
      const id = encodeItemRef(relative);
      const kind = kindForKey(object.key);
      const base = itemBase(share.publicId, id);
      const item: DeliveryItem = {
        id,
        name: aliases.get(object.key) || relative.split("/").pop() || relative,
        kind,
        size: object.size,
        uploadedAt: object.uploaded.toISOString(),
        downloadUrl: `${base}/download`,
        previewStatus: kind === "video" ? "processing" : undefined,
        ...thumbnailFieldsForObject(object.key, kind, base, object.httpEtag, null, object.size, object.httpMetadata?.contentType),
        ...(mediaPatches.get(id)||{}),
      };
      item.sourceUrl = sourceUrl(base, kind);
      if (kind === "image") {
        const extension = (object.key.split(".").pop() || "").toLowerCase();
        if (!["dng", "arw", "cr2", "cr3", "crw", "nef", "raf", "rw2", "orf", "pef", "srw", "3fr", "rwl", "srf", "sr2", "x3f"].includes(extension))
          item.previewUrl = item.sourceUrl;
      } else if (kind === "audio" || kind === "text") item.previewUrl = `${base}/preview`;
      items.push(item);
    }
    const breadcrumbs: Array<{ id: string; name: string }> = [];
    let built = "";
    let physical = root;
    for (const segment of relativeFolder.split("/").filter(Boolean)) {
      built = built ? `${built}/${segment}` : segment;
      physical += `${segment}/`;
      breadcrumbs.push({ id: encodeItemRef(built), name: aliases.get(physical) || segment });
    }
    const currentPhysical = relativeFolder ? prefix : root;
    const projectName = share.label || aliases.get(root) || "Shared files";
    const manifest: DeliveryManifest & {mediaHydrated:true;reconciliationNeeded:boolean} = {
      share: { publicId: share.publicId, label: share.label, clientName: "Client-shared delivery", projectName, expiresAt: share.shareExpiresAt },
      folder: { id: folderRef, name: aliases.get(currentPhysical) || relativeFolder.split("/").pop() || projectName, breadcrumbs },
      items,
      nextCursor: listed.truncated ? listed.cursor : null,
      capabilities: { cloudTransfer: { dropbox: false, googleDrive: false, googlePicker: false } },
      mediaHydrated:true,
      reconciliationNeeded:folderVisibility.reconciliationNeeded,
    };
    c.executionCtx.waitUntil(audit(c.env, c.req.raw, share, "client_share.manifest.viewed", folderRef));
    c.header("Server-Timing",`r2;dur=${Math.max(0,listedAt-started)},hydrate;dur=${Math.max(0,Date.now()-listedAt)},manifest;dur=${Math.max(0,Date.now()-started)}`);
    return c.json(manifest);
  });

  router.get(`${API_ROOT}/:publicId/manifest/media`, async c => {
    const started=Date.now();
    const share = c.get("delegatedShare");
    const root = normalizeRoot(share.deliveryPrefix);
    const tombstones = await loadTombstones(c.env);
    const folderRef = c.req.query("folder") || "";
    const relativeFolder = folderRef ? decodeItemRef(folderRef) : "";
    const prefix = relativeFolder ? `${keyWithinRoot(root, relativeFolder).replace(/\/$/, "")}/` : root;
    const listed = await c.env.DATA_BUCKET.list({ prefix, delimiter: "/", limit: CLIENT_DELEGATED_FOLDER_PAGE_SIZE,
      cursor: c.req.query("cursor"), include: ["httpMetadata", "customMetadata"] });
    const listedAt=Date.now();
    const candidates = listed.objects.flatMap(object => {
      if (!object.key.startsWith(prefix) || object.key === prefix || object.key.endsWith("/") ||
          isHiddenKey(object.key) || isTrashed(tombstones, object.key) || isMovedSourceMarker(object)) return [];
      const relative = object.key.slice(root.length);
      const id = encodeItemRef(relative);
      const kind = kindForKey(object.key);
      if (kind !== "image" && kind !== "pdf" && kind !== "video") return [];
      return [{ id, key: object.key, kind, etag: object.httpEtag, size: object.size,
        contentType: object.httpMetadata?.contentType, base: itemBase(share.publicId, id) }];
    });
    const patches=await delegatedMediaPatches(db(c.env),candidates);
    c.header("Server-Timing",`r2;dur=${Math.max(0,listedAt-started)},hydrate;dur=${Math.max(0,Date.now()-listedAt)}`);
    return c.json({items:candidates.map(candidate=>patches.get(candidate.id)!)});
  });

  router.get(`${API_ROOT}/:publicId/download-summary`, async c => {
    const share = c.get("delegatedShare");
    const tombstones = await loadTombstones(c.env);
    const folderRef = c.req.query("folder") || "";
    const prefix = folderRef
      ? `${keyWithinRoot(share.deliveryPrefix, decodeItemRef(folderRef)).replace(/\/$/, "")}/`
      : normalizeRoot(share.deliveryPrefix);
    return c.json(summarizeDownloadableObjects(await listDownloadableObjects(c.env.DATA_BUCKET, prefix, tombstones)));
  });

  router.get(`${API_ROOT}/:publicId/locations`, async c => {
    const share = c.get("delegatedShare");
    if (!share.imageLocationMapEnabled) return c.json({
      locations: { points: [], imageCount: 0, truncated: false }, mapboxPublicToken: null,
    });
    const locations = await listScopedDeliveryLocations(
      c.env,
      c.env.CLIENT_DELEGATED_SHARE_SESSION_SECRET!,
      {
        id: share.shareId,
        version: share.shareVersion,
        deliveryPrefix: share.deliveryPrefix,
        assetApiBase: `/client-share/api/shares/${encodeURIComponent(share.publicId)}`,
        refContext: "client-delegated-location:v1",
      },
      c.req.query("folder") || "",
    );
    c.executionCtx.waitUntil(audit(c.env, c.req.raw, share, "client_share.locations.viewed", c.req.query("folder") || ""));
    return c.json({ locations, mapboxPublicToken: locations.points.length ? c.env.MAPBOX_PUBLIC_TOKEN || null : null });
  });

  router.get(`${API_ROOT}/:publicId/locations/:assetRef`, async c => {
    const share = c.get("delegatedShare");
    if (!share.imageLocationMapEnabled) throw new HTTPException(404, { message: "Mapped image not found" });
    const item = await resolveScopedDeliveryLocation(
      c.env,
      c.env.CLIENT_DELEGATED_SHARE_SESSION_SECRET!,
      {
        id: share.shareId,
        version: share.shareVersion,
        deliveryPrefix: share.deliveryPrefix,
        assetApiBase: `/client-share/api/shares/${encodeURIComponent(share.publicId)}`,
        refContext: "client-delegated-location:v1",
      },
      c.req.param("assetRef"),
      c.req.query("folder") || "",
    );
    c.executionCtx.waitUntil(audit(c.env, c.req.raw, share, "client_share.location_asset.viewed", c.req.param("assetRef")));
    return c.json({ item });
  });

  router.on(["GET", "HEAD"], `${API_ROOT}/:publicId/items/:itemRef/preview`, async c => {
    const share = c.get("delegatedShare");
    const kind = kindForKey(keyWithinRoot(share.deliveryPrefix, decodeItemRef(c.req.param("itemRef"))));
    if (!["image", "pdf", "audio", "text"].includes(kind)) throw new HTTPException(415, { message: "Preview unavailable" });
    return streamItem(c, "inline", kind === "pdf" ? "pdf" : undefined);
  });
  router.on(["GET", "HEAD"], `${API_ROOT}/:publicId/items/:itemRef/source`, c => streamItem(c, "inline"));
  router.on(["GET", "HEAD"], `${API_ROOT}/:publicId/items/:itemRef/pdf`, c => streamItem(c, "inline", "pdf"));
  router.on(["GET", "HEAD"], `${API_ROOT}/:publicId/items/:itemRef/download`, c => streamItem(c, "attachment"));

  router.get(`${API_ROOT}/:publicId/items/:itemRef/download-ticket`, async c => {
    const share = c.get("delegatedShare");
    const itemRef = c.req.param("itemRef");
    await assertVisibleObject(c.env, keyWithinRoot(share.deliveryPrefix, decodeItemRef(itemRef)));
    return c.json({
      url: `${itemBase(share.publicId, itemRef)}/download`,
      expiresAt: new Date(Math.min(Date.now() + SESSION_MAX_MS, Date.parse(share.shareExpiresAt))).toISOString(),
    });
  });

  router.post(`${API_ROOT}/:publicId/items/:itemRef/stream-ticket`, async c => {
    const share = c.get("delegatedShare");
    const itemRef = c.req.param("itemRef");
    const key = keyWithinRoot(share.deliveryPrefix, decodeItemRef(itemRef));
    await assertVisibleObject(c.env, key);
    if (kindForKey(key) !== "video") throw new HTTPException(415, { message: "Stream preview unavailable" });
    const row = await db(c.env).prepare("SELECT stream_uid,stream_status FROM file_index WHERE r2_key=?").bind(key)
      .first<{ stream_uid: string | null; stream_status: string | null }>();
    if (row?.stream_status !== "ready" || !row.stream_uid || !c.env.STREAM_CUSTOMER_CODE)
      throw new HTTPException(404, { message: "Video preview unavailable" });
    const token = await c.env.STREAM.video(row.stream_uid).generateToken();
    c.executionCtx.waitUntil(audit(c.env, c.req.raw, share, "client_share.preview.viewed", itemRef));
    return c.json({ url: streamPlayerUrl(c.env.STREAM_CUSTOMER_CODE, token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
  });

  router.on(["GET", "HEAD"], `${API_ROOT}/:publicId/items/:itemRef/thumbnail`, async c => {
    const share = c.get("delegatedShare");
    const key = keyWithinRoot(share.deliveryPrefix, decodeItemRef(c.req.param("itemRef")));
    await assertVisibleObject(c.env, key);
    const kind = kindForKey(key);
    if (kind !== "image" && kind !== "pdf" && kind !== "video")
      throw new HTTPException(409, { message: "Thumbnail is not available for this file type" });
    return serveAuthorizedThumbnail(c.env, key, {
      method: c.req.method, ifNoneMatch: c.req.header("If-None-Match"), kind,
    });
  });

  return router;
}
