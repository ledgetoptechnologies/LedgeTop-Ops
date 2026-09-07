import { mediaKind, mime } from "./delivery";
import type { Env } from "./types";
import { artifactDirectory } from "./artifacts";
import { sendAdminAlert } from "./alerts";
import { canonicalThumbnailSourceKey, enqueueThumbnailJob, handleRemovedPrebuiltThumbnail, prebuiltThumbnailArtifactKey, removeThumbnailStateForPath, THUMBNAIL_PREBUILT_GRACE_SECONDS, THUMBNAIL_SIDECAR_GRACE_SECONDS, thumbnailSourceEligible } from "./image-thumbnails";
import { deleteImageLocation, enqueueImageLocationJob } from "./image-locations";
import { isMovedSourceMarker } from "@ltds/shared";
import { recordClientFolderFileChange } from "./client-folder-grants";
import { authenticatedDeliveryChangeBatchSequenceReady, authenticatedDeliveryChangeNotificationsReady, authenticatedDeliveryNotificationsEnabled, recordAuthenticatedDeliveryObjectChange } from "./authenticated-delivery-change-notifications";
import { acceptAuthenticatedDeliveryChangeReceipt, readAcceptedDeliveryChangeReceipt, type AcceptedDeliveryChangeSnapshot } from "./delivery-change-receipts";
import { deliveryChangeProjectionReady } from "./delivery-change-projector";
import { deliveryIndexRecoveryEnabled, prepareDeliveryIndexCreateAcceptance, prepareDeliveryIndexDeleteAcceptance, prepareDeliveryIndexRepair, readDeliveryIndexObservation, type DeliveryIndexObservation, type DeliveryIndexStreamState } from "./delivery-index-acceptance";
import { d1TablesPresent } from "./schema-readiness";

export interface R2Notification {
  action: string;
  object?: { key?: string; size?: number; eTag?: string };
  bucket?: string;
  eventTime?: string;
}

function notificationEventTime(eventTime: unknown, fallback: unknown): string | null {
  const supplied = typeof eventTime === "string" ? Date.parse(eventTime) : Number.NaN;
  if (Number.isFinite(supplied)) return new Date(supplied).toISOString();
  if (!(fallback instanceof Date)) return null;
  const fallbackTime = fallback.getTime();
  return Number.isFinite(fallbackTime) ? fallback.toISOString() : null;
}

interface TusState { etag: string; stream_uid: string | null; stream_status: string | null; stream_upload_url: string | null; stream_upload_offset: number | null }
const TUS_VERSION = "1.0.0";
const TUS_CHUNK = 50 * 1024 * 1024;
const PREVIEW_MANIFEST_MAX_BYTES = 64 * 1024;
const PREVIEW_VARIANT_MAX_BYTES = { thumb: 100 * 1024, poster: 100 * 1024, preview: 512_000 } as const;

export function streamAllowedOriginHosts(env: Pick<Env, "DELIVERY_BASE_URL" | "CLIENT_PORTAL_ORIGINS">): string[] {
  const raw = env.CLIENT_PORTAL_ORIGINS?.split(",").map(value => value.trim()) ?? [env.DELIVERY_BASE_URL];
  if (!raw.length || raw.length > 4 || raw.some(value => !value)) throw new Error("stream-allowed-origins-invalid");
  const origins = raw.map(value => {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
        throw new Error("stream-allowed-origins-invalid");
      return url;
    } catch {
      throw new Error("stream-allowed-origins-invalid");
    }
  });
  const primary = new URL(env.DELIVERY_BASE_URL).origin;
  if (!origins.some(url => url.origin === primary) || new Set(origins.map(url => url.origin)).size !== origins.length)
    throw new Error("stream-allowed-origins-invalid");
  return origins.map(url => url.hostname);
}

interface PreviewDerivative {
  key?: unknown;
  mime?: unknown;
  width?: unknown;
  height?: unknown;
  bytes?: unknown;
}

interface PreviewManifest {
  sourceKey?: unknown;
  sourceEtag?: unknown;
  sourceSize?: unknown;
  producerVersion?: unknown;
  createdAt?: unknown;
  derivatives?: unknown;
  finalizationStatus?: unknown;
  finalizedAt?: unknown;
  [key: string]: unknown;
}

export function hidden(key: string): boolean {
  const parts = key.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.some(part => {
    const value = part.toLowerCase();
    return value === "dump" || value === "_ltds" || value === ".previews";
  });
}
function created(action: string): boolean { return ["PutObject", "CopyObject", "CompleteMultipartUpload"].some(value => action.includes(value)); }
function removed(action: string): boolean { return action.includes("Delete") || action.includes("Lifecycle"); }
function metadata(value: string): string { let binary = ""; for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte); return btoa(binary); }
function sameObjectVersion(left: string | undefined, right: string): boolean {
  return !left || left.replace(/^"|"$/g, "") === right.replace(/^"|"$/g, "");
}
function databaseTimestampMillis(value: string): number {
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value.replace(" ", "T")}Z`);
}

const DELIVERY_RECOVERY_TABLES = [
  "delivery_file_index_revisions",
  "portal_authenticated_delivery_change_receipts",
  "portal_authenticated_delivery_change_receipt_targets",
  "portal_authenticated_delivery_change_receipt_seals",
  "portal_authenticated_delivery_change_receipt_deliveries",
] as const;

/** Recovery is fail-closed during a partial migration. The old consumer is
 * retained byte-for-byte behind the disabled flag, while an enabled but
 * incomplete rollout retries instead of silently creating legacy-only state. */
async function deliveryIndexRecoveryReady(env: Env): Promise<boolean> {
  if (!deliveryIndexRecoveryEnabled(env)) return false;
  if (!(await authenticatedDeliveryChangeNotificationsReady(env))
    || !(await deliveryChangeProjectionReady(env))
    || !(await authenticatedDeliveryChangeBatchSequenceReady(env))
    || !(await d1TablesPresent(env.DELIVERY_DB, DELIVERY_RECOVERY_TABLES)))
    throw new Error("delivery-index-recovery-schema-unavailable");
  try {
    const db = env.DELIVERY_DB.withSession("first-primary");
    await db.prepare("SELECT provider_version,notification_observation_version FROM file_index LIMIT 0").all();
    await db.prepare("SELECT revision FROM delivery_file_index_revisions LIMIT 0").all();
    await db.prepare("SELECT accepted_sequence,provider_object_version FROM portal_authenticated_delivery_change_object_versions LIMIT 0").all();
    await db.prepare("SELECT accepted_sequence,provider_object_version FROM portal_authenticated_delivery_change_batch_items LIMIT 0").all();
    const triggerRows = await db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (
      'delivery_file_index_revision_insert','delivery_file_index_revision_update','delivery_file_index_revision_delete',
      'delivery_file_index_legacy_identity_update','delivery_file_index_key_immutable','delivery_file_index_revision_no_delete',
      'delivery_file_index_revision_monotonic','authenticated_delivery_change_sequence_pair_insert',
      'authenticated_delivery_change_sequence_pair_update','portal_authenticated_delivery_change_object_version_update',
      'authenticated_delivery_change_batch_item_sequence_pair_insert','authenticated_delivery_change_batch_item_sequence_pair_update')`).all<{ name: string }>();
    if (triggerRows.results.length !== 12) throw new Error("delivery-index-recovery-schema-unavailable");
  } catch (error) {
    if (error instanceof Error && /delivery-index-recovery-schema-unavailable|no such (table|column)/i.test(error.message))
      throw new Error("delivery-index-recovery-schema-unavailable");
    throw error;
  }
  return true;
}

function recoveryDelivery(env: Env, batch: MessageBatch<R2Notification>, message: { id: string }): { queue: string; id: string } {
  if (typeof batch.queue !== "string" || batch.queue !== env.FILE_EVENTS_QUEUE_NAME || typeof message.id !== "string" || !message.id)
    throw new Error("delivery-change-receipt-delivery-invalid");
  return { queue: batch.queue, id: message.id };
}

function recoveryVersionMatches(head: R2Object | null, receipt: AcceptedDeliveryChangeSnapshot): head is R2Object {
  return Boolean(head && head.version === receipt.objectVersion && receipt.present
    && receipt.etag && sameObjectVersion(receipt.etag, head.httpEtag));
}

async function markDeliveryHealthy(env: Env, key: string): Promise<void> {
  await env.DELIVERY_DB.prepare(`INSERT INTO delivery_sync_health
    (source,last_attempt_at,last_success_at,status,details_json) VALUES ('truenas',datetime('now'),datetime('now'),'healthy',?)
    ON CONFLICT(source) DO UPDATE SET last_attempt_at=datetime('now'),last_success_at=datetime('now'),status='healthy',details_json=excluded.details_json,updated_at=datetime('now')`)
    .bind(JSON.stringify({ lastKey: key })).run();
}

async function replayCreatedSideEffects(env: Env, key: string, head: R2Object): Promise<void> {
  const current = await env.DATA_BUCKET.head(key);
  if (!current || current.version !== head.version || !sameObjectVersion(current.httpEtag, head.httpEtag)) return;
  head = current;
  const indexed = await readDeliveryIndexObservation(env.DELIVERY_DB.withSession("first-primary"), key);
  if (indexed.current?.providerVersion !== head.version || !sameObjectVersion(indexed.current.etag, head.httpEtag)) return;
  await markDeliveryHealthy(env, key);
  await recordClientFolderFileChange(env, key, true);
  await enqueueCurrentDerivatives(env, key, head);
}

async function enqueueCurrentDerivatives(env: Env, key: string, head: R2Object): Promise<void> {
  const current = await env.DATA_BUCKET.head(key);
  if (!current || current.version !== head.version || isMovedSourceMarker(current)) return;
  head = current;
  const kind = mediaKind(key);
  const thumbnailJob = thumbnailJobForCreatedObject("PutObject", key, kind, head, head.uploaded.toISOString());
  if (thumbnailJob) await enqueueThumbnailJob(env, thumbnailJob);
  else if (canonicalThumbnailSourceKey(key)) {
    const locationJob = imageLocationJobForCreatedObject("PutObject", key, kind, head);
    if (locationJob) await enqueueImageLocationJob(env, locationJob);
    await removeThumbnailStateForPath(env, key);
  }
}

async function replayRemovedSideEffects(env: Env, receipt: Pick<AcceptedDeliveryChangeSnapshot, "key" | "etag">): Promise<void> {
  const current = await env.DATA_BUCKET.head(receipt.key);
  // A replacement (including a replacement with identical bytes/ETag) owns
  // the key now; an old delete replay must not retire its derivatives or emit
  // a stale legacy notice.
  if (current) {
    await repairCurrentIndexAndDerivatives(env, receipt.key);
    return;
  }
  await removeThumbnailStateForPath(env, receipt.key, false, receipt.etag || undefined);
  if (receipt.etag) await deleteImageLocation(env, receipt.key, receipt.etag);
  if (!(await env.DATA_BUCKET.head(receipt.key))) await recordClientFolderFileChange(env, receipt.key, false);
  await repairCurrentIndexAndDerivatives(env, receipt.key);
}

/** Repairs only current source metadata/derivatives, never receipt recipients
 * or a legacy added notice. This closes a removal's resurrection window. */
async function repairCurrentIndexAndDerivatives(env: Env, key: string): Promise<void> {
  const db = env.DELIVERY_DB.withSession("first-primary");
  const snapshot = await readDeliveryIndexObservation(db, key);
  const current = await env.DATA_BUCKET.head(key);
  if (!current || isMovedSourceMarker(current)) return;
  await prepareDeliveryIndexRepair(db, snapshot, current).run();
  const confirmed = await readDeliveryIndexObservation(db, key);
  if (confirmed.current?.providerVersion !== current.version || !sameObjectVersion(confirmed.current.etag, current.httpEtag))
    throw new Error("delivery-index-repair-fence-lost");
  await enqueueCurrentDerivatives(env, key, current);
}

async function removeUnknownProviderSource(
  env: Env, key: string, snapshot: DeliveryIndexObservation, etag?: string,
): Promise<boolean> {
  if (await env.DATA_BUCKET.head(key)) return false;
  const expectedEtag = etag || snapshot.current?.etag;
  if (!expectedEtag) return false;
  const deleted = await env.DELIVERY_DB.prepare(`DELETE FROM file_index WHERE r2_key=? AND trim(etag,'\"')=trim(?,'\"')
      AND COALESCE((SELECT revision FROM delivery_file_index_revisions WHERE r2_key=?),0)=? RETURNING r2_key`)
    .bind(key, expectedEtag, key, snapshot.revision).first<{ r2_key: string }>();
  if (!deleted) return false;
  console.log(JSON.stringify({ event: "delivery_change.legacy_cleanup", reason: "provider-identity-unavailable" }));
  // Do not emit cleanup/legacy state for a replacement that appeared during
  // the D1 CAS window. Its create event/reconciliation owns the new version.
  if (await env.DATA_BUCKET.head(key)) {
    await repairCurrentIndexAndDerivatives(env, key);
    return true;
  }
  await removeThumbnailStateForPath(env, key, false, expectedEtag);
  if (expectedEtag) await deleteImageLocation(env, key, expectedEtag);
  if (!(await env.DATA_BUCKET.head(key))) await recordClientFolderFileChange(env, key, false);
  await repairCurrentIndexAndDerivatives(env, key);
  return true;
}

export function thumbnailJobForCreatedObject(
  action: string,
  key: string,
  _kind: string,
  head: Pick<R2Object, "httpEtag" | "size" | "httpMetadata" | "customMetadata">,
  eventTime?: string,
): { sourceKey: string; sourceEtag: string; sourceSize: number; eventTime?: string; delaySeconds: number } | null {
  return created(action) && canonicalThumbnailSourceKey(key) && thumbnailSourceEligible(key, head.size, head.httpMetadata?.contentType)
    ? { sourceKey: key, sourceEtag: head.httpEtag, sourceSize: head.size, ...(eventTime ? { eventTime } : {}),
        delaySeconds: head.customMetadata?.browserUploadSession ? THUMBNAIL_SIDECAR_GRACE_SECONDS : THUMBNAIL_PREBUILT_GRACE_SECONDS }
    : null;
}

export function imageLocationJobForCreatedObject(
  action: string,
  key: string,
  kind: string,
  head: Pick<R2Object, "httpEtag">,
): { sourceKey: string; sourceEtag: string } | null {
  return created(action) && kind === "image" && canonicalThumbnailSourceKey(key)
    ? { sourceKey: key, sourceEtag: head.httpEtag }
    : null;
}

/**
 * A delete event may arrive after a replacement at the same key. Live objects
 * make that event stale. On a real removal, retain the source-identity-scoped
 * thumbnail row and exact source-version object are retired through the
 * durable cleanup ledger. A final live-source check repairs resurrection.
 */
export async function handleRemovedSource(
  env: Env,
  key: string,
  removedEtag?: string,
): Promise<"stale" | "removed"> {
  if (await env.DATA_BUCKET.head(key)) return "stale";
  const indexed = await env.DELIVERY_DB.prepare("SELECT etag FROM file_index WHERE r2_key=?")
    .bind(key).first<{ etag: string }>();
  const expectedEtag = removedEtag || indexed?.etag;
  // A replacement can appear after the first HEAD while this delayed delete
  // notification is being handled. Never retire its versioned derivative.
  if (await env.DATA_BUCKET.head(key)) return "stale";
  await removeThumbnailStateForPath(env, key, false, expectedEtag);
  if (expectedEtag) {
    await deleteImageLocation(env, key, expectedEtag);
    await env.DELIVERY_DB.prepare("DELETE FROM file_index WHERE r2_key=? AND trim(etag,'\"')=trim(?,'\"')")
      .bind(key, expectedEtag).run();
  }
  const resurrected = await env.DATA_BUCKET.head(key);
  if (resurrected) {
    const kind = mediaKind(key);
    await env.DELIVERY_DB.prepare(`INSERT INTO file_index
      (r2_key,etag,size,uploaded_at,content_type,media_kind)
      VALUES(?,?,?,?,?,?) ON CONFLICT(r2_key) DO UPDATE SET
        etag=excluded.etag,size=excluded.size,uploaded_at=excluded.uploaded_at,
        content_type=excluded.content_type,media_kind=excluded.media_kind,updated_at=datetime('now')`)
      .bind(key, resurrected.httpEtag, resurrected.size, resurrected.uploaded.toISOString(), mime(key), kind)
      .run();
    const stable = await env.DATA_BUCKET.head(key);
    if (stable && stable.httpEtag === resurrected.httpEtag && canonicalThumbnailSourceKey(key)) {
      if (thumbnailSourceEligible(key, stable.size, stable.httpMetadata?.contentType)) {
        await enqueueThumbnailJob(env, {
          sourceKey: key,
          sourceEtag: stable.httpEtag,
          sourceSize: stable.size,
          eventTime: stable.uploaded.toISOString(),
        });
      } else if (kind === "image") {
        await enqueueImageLocationJob(env, { sourceKey: key, sourceEtag: stable.httpEtag });
      }
    }
  }
  return "removed";
}

export function previewManifest(key: string): boolean {
  return /(?:^|\/)\.previews\/[a-f0-9]{64}\/manifest\.json$/i.test(key);
}

export function previewDerivative(key: string): boolean {
  return /(?:^|\/)\.previews\/[a-f0-9]{64}\/(?:thumb|preview|poster)\.webp$/i.test(key);
}

export function canonicalPreviewSource(key: string): boolean {
  return key.startsWith("Jobs/Clients/") && !hidden(key);
}

function cleanEtag(value: string): string {
  return value.replace(/^"|"$/g, "");
}

function expectedPreviewVariants(sourceKey: string): Array<keyof typeof PREVIEW_VARIANT_MAX_BYTES> {
  const kind = mediaKind(sourceKey);
  if (kind === "image" || kind === "pdf") return ["thumb", "preview"];
  if (kind === "video") return ["poster"];
  return [];
}

function validDerivative(value: unknown, expectedKey: string, maxBytes: number): value is PreviewDerivative {
  if (!value || typeof value !== "object") return false;
  const derivative = value as PreviewDerivative;
  return derivative.key === expectedKey &&
    derivative.mime === "image/webp" &&
    typeof derivative.width === "number" && Number.isSafeInteger(derivative.width) && derivative.width > 0 && derivative.width <= 20_000 &&
    typeof derivative.height === "number" && Number.isSafeInteger(derivative.height) && derivative.height > 0 && derivative.height <= 20_000 &&
    typeof derivative.bytes === "number" && Number.isSafeInteger(derivative.bytes) && derivative.bytes > 0 && derivative.bytes <= maxBytes;
}

async function recordPreviewManifest(env: Env, prefix: string, sourceKey: string, sourceEtag: string, manifestEtag: string, derivativeEtags: Record<string, string>): Promise<void> {
  await env.DELIVERY_DB.prepare(`INSERT INTO preview_artifacts(artifact_prefix,source_key,source_etag,manifest_etag,derivative_etags_json)
    VALUES(?,?,?,?,?) ON CONFLICT(artifact_prefix) DO UPDATE SET source_key=excluded.source_key,
    source_etag=excluded.source_etag,manifest_etag=excluded.manifest_etag,derivative_etags_json=excluded.derivative_etags_json,missing_since=NULL,
    last_seen_at=datetime('now'),updated_at=datetime('now')`).bind(prefix, sourceKey, sourceEtag, manifestEtag, JSON.stringify(derivativeEtags)).run();
}

export type PreviewFinalizeResult = "ready" | "pending" | "invalid";

export async function finalizePreviewManifest(env: Env, key: string): Promise<PreviewFinalizeResult> {
  if (!previewManifest(key)) return "invalid";
  const manifestHead = await env.DATA_BUCKET.head(key);
  if (!manifestHead) return "pending";
  if (manifestHead.size <= 0 || manifestHead.size > PREVIEW_MANIFEST_MAX_BYTES) return "invalid";
  const object = await env.DATA_BUCKET.get(key);
  if (!object) return "pending";
  const manifest = await object.json<PreviewManifest>().catch(() => null);
  if (!manifest || typeof manifest.sourceKey !== "string" || !canonicalPreviewSource(manifest.sourceKey) ||
    typeof manifest.sourceEtag !== "string" || typeof manifest.sourceSize !== "number" ||
    !Number.isSafeInteger(manifest.sourceSize) || manifest.sourceSize <= 0 ||
    typeof manifest.producerVersion !== "string" || !manifest.producerVersion.trim() ||
    typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !manifest.derivatives || typeof manifest.derivatives !== "object") return "invalid";

  const prefix = key.slice(0, -"manifest.json".length);
  if (prefix !== await artifactDirectory(manifest.sourceKey)) return "invalid";
  const variants = expectedPreviewVariants(manifest.sourceKey);
  if (!variants.length) return "invalid";
  const source = await env.DATA_BUCKET.head(manifest.sourceKey);
  if (!source) return "pending";
  if (manifest.sourceSize !== source.size) return "invalid";

  const derivatives = manifest.derivatives as Record<string, unknown>;
  const derivativeEtags: Record<string, string> = {};
  for (const variant of variants) {
    const derivativeKey = `${prefix}${variant}.webp`;
    const derivative = derivatives[variant];
    if (!validDerivative(derivative, derivativeKey, PREVIEW_VARIANT_MAX_BYTES[variant])) return "invalid";
    const derivativeHead = await env.DATA_BUCKET.head(derivativeKey);
    if (!derivativeHead) return "pending";
    if (derivativeHead.size !== derivative.bytes || derivativeHead.size > PREVIEW_VARIANT_MAX_BYTES[variant]) return "invalid";
    derivativeEtags[variant] = derivativeHead.httpEtag;
  }

  const suppliedEtag = cleanEtag(manifest.sourceEtag);
  const actualEtag = cleanEtag(source.httpEtag);
  if (suppliedEtag && suppliedEtag !== "pending" && suppliedEtag !== actualEtag) return "invalid";
  const finalManifestHead = await env.DATA_BUCKET.head(key);
  const finalSource = await env.DATA_BUCKET.head(manifest.sourceKey);
  if (!finalManifestHead || !finalSource || finalManifestHead.httpEtag !== manifestHead.httpEtag || finalSource.httpEtag !== source.httpEtag) return "pending";
  for (const [variant, etag] of Object.entries(derivativeEtags)) {
    const current = await env.DATA_BUCKET.head(`${prefix}${variant}.webp`);
    if (!current || current.httpEtag !== etag) return "pending";
  }
  await recordPreviewManifest(env, prefix, manifest.sourceKey, finalSource.httpEtag, finalManifestHead.httpEtag, derivativeEtags);
  return "ready";
}

async function beginTusUpload(env: Env, key: string, size: number, etag: string): Promise<{ uid: string; url: string; offset: number }> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.STREAM_ACCOUNT_ID}/stream`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STREAM_API_TOKEN}`,
      "Tus-Resumable": TUS_VERSION,
      "Upload-Length": String(size),
      "Upload-Metadata": `name ${metadata(key.split("/").pop() || "video")},requiresignedurls ${metadata("true")},allowedorigins ${metadata(JSON.stringify(streamAllowedOriginHosts(env)))}`,
    },
  });
  const location = response.headers.get("Location"); const uid = response.headers.get("stream-media-id");
  if (response.status !== 201 || !location || !uid) throw new Error(`stream-tus-create-${response.status}`);
  const url = new URL(location, response.url).toString();
  await env.DELIVERY_DB.prepare(`UPDATE file_index SET stream_uid=?,stream_status='pending',stream_upload_url=?,stream_upload_offset=0,stream_error=NULL,updated_at=datetime('now') WHERE r2_key=? AND etag=?`).bind(uid, url, key, etag).run();
  return { uid, url, offset: 0 };
}

async function resumeOffset(env: Env, url: string): Promise<number> {
  const response = await fetch(url, { method: "HEAD", headers: { Authorization: `Bearer ${env.STREAM_API_TOKEN}`, "Tus-Resumable": TUS_VERSION } });
  const value = Number(response.headers.get("Upload-Offset"));
  if (!response.ok || !Number.isSafeInteger(value) || value < 0) throw new Error(`stream-tus-head-${response.status}`);
  return value;
}

async function uploadVideo(env: Env, key: string, size: number, etag: string): Promise<{ uid: string | null; status: string; error: string | null }> {
  if (!env.STREAM_API_TOKEN || !env.STREAM_ACCOUNT_ID) return { uid: null, status: "disabled", error: null };
  let state = await env.DELIVERY_DB.prepare("SELECT etag,stream_uid,stream_status,stream_upload_url,stream_upload_offset FROM file_index WHERE r2_key=?").bind(key).first<TusState>();
  if (!state || state.etag !== etag) {
    await env.DELIVERY_DB.prepare(`INSERT INTO file_index (r2_key,etag,size,uploaded_at,content_type,media_kind,stream_status) VALUES (?,?,?,datetime('now'),?,'video','pending') ON CONFLICT(r2_key) DO UPDATE SET etag=excluded.etag,size=excluded.size,content_type=excluded.content_type,media_kind='video',stream_uid=NULL,stream_status='pending',stream_upload_url=NULL,stream_upload_offset=0,stream_error=NULL,updated_at=datetime('now')`).bind(key, etag, size, mime(key)).run();
    state = await env.DELIVERY_DB.prepare("SELECT etag,stream_uid,stream_status,stream_upload_url,stream_upload_offset FROM file_index WHERE r2_key=?").bind(key).first<TusState>();
  }
  let uid = state?.stream_uid || ""; let uploadUrl = state?.stream_upload_url || ""; let offset = state?.stream_upload_offset || 0;
  if (!uploadUrl || !uid) { const createdUpload = await beginTusUpload(env, key, size, etag); uid = createdUpload.uid; uploadUrl = createdUpload.url; offset = 0; }
  else offset = await resumeOffset(env, uploadUrl);

  while (offset < size) {
    const length = Math.min(TUS_CHUNK, size - offset);
    const object = await env.DATA_BUCKET.get(key, { range: { offset, length } });
    if (!object) throw new Error("r2-object-disappeared-during-stream-upload");
    const response = await fetch(uploadUrl, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${env.STREAM_API_TOKEN}`, "Tus-Resumable": TUS_VERSION, "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream", "Content-Length": String(length) },
      body: object.body,
    });
    const nextOffset = Number(response.headers.get("Upload-Offset"));
    if (response.status !== 204 || !Number.isSafeInteger(nextOffset) || nextOffset <= offset) throw new Error(`stream-tus-patch-${response.status}`);
    offset = nextOffset;
    await env.DELIVERY_DB.prepare("UPDATE file_index SET stream_upload_offset=?,updated_at=datetime('now') WHERE r2_key=? AND etag=?").bind(offset, key, etag).run();
  }
  await env.DELIVERY_DB.prepare("UPDATE file_index SET stream_status='pending',stream_upload_url=NULL,stream_upload_offset=?,stream_error=NULL,updated_at=datetime('now') WHERE r2_key=? AND etag=?").bind(offset, key, etag).run();
  return { uid, status: "pending", error: null };
}

export async function consumeFileEvents(batch: MessageBatch<R2Notification>, env: Env): Promise<void> {
  const recovery = await deliveryIndexRecoveryReady(env);
  for (const message of batch.messages) {
    try {
      const event = message.body; const key = event.object?.key;
      if (!key) { message.ack(); continue; }
      if (prebuiltThumbnailArtifactKey(key)) {
        if (removed(event.action)) await handleRemovedPrebuiltThumbnail(env, key, event.object?.eTag);
        message.ack(); continue;
      }
      if (previewManifest(key)) {
        // Legacy preview artifacts are intentionally ignored. This release only
        // creates fixed still thumbnails through the dedicated queue pipeline.
        message.ack(); continue;
      }
      if (previewDerivative(key)) {
        message.ack(); continue;
      }
      if (removed(event.action)) {
        if (!hidden(key)) {
          if (recovery) {
            // The alias is authoritative and must be read before HEAD/index:
            // delete acceptance removes the index row, and a retry may run
            // after the source object has been replaced or deleted.
            const alias = await readAcceptedDeliveryChangeReceipt(env, {
              ...recoveryDelivery(env, batch, message), key, present: false,
            });
            if (alias) {
              await replayRemovedSideEffects(env, alias);
              message.ack(); continue;
            }
            const snapshot = await readDeliveryIndexObservation(env.DELIVERY_DB.withSession("first-primary"), key);
            const firstHead = await env.DATA_BUCKET.head(key);
            if (firstHead) { message.ack(); continue; }
            const eventEtag = event.object?.eTag;
            if (eventEtag && snapshot.current && !sameObjectVersion(eventEtag, snapshot.current.etag)) {
              message.ack(); continue;
            }
            const eventAt = notificationEventTime(event.eventTime, message.timestamp);
            if (!eventAt) throw new Error("file-event-notification-timestamp-unavailable");
            // A second check narrows (but cannot make R2/D1 atomic) the
            // replacement window. The provider-version + revision CAS is the
            // durable fence for the remaining race.
            if (await env.DATA_BUCKET.head(key)) { message.ack(); continue; }
            if (snapshot.current?.providerVersion) {
              await acceptAuthenticatedDeliveryChangeReceipt(env, {
                key, present: false, objectVersion: snapshot.current.providerVersion,
                etag: snapshot.current.etag, eventAt, delivery: recoveryDelivery(env, batch, message),
              }, prepareDeliveryIndexDeleteAcceptance(env.DELIVERY_DB.withSession("first-primary"), snapshot));
              await replayRemovedSideEffects(env, {
                key, etag: snapshot.current.etag,
              });
            } else {
              // Legacy rows have no trustworthy R2 upload identity. They may
              // be retired only by the revision-fenced cleanup path and never
              // produce a synthetic native receipt.
              await removeUnknownProviderSource(env, key, snapshot, eventEtag);
            }
            message.ack(); continue;
          }
          const indexedVersion = await env.DELIVERY_DB.prepare("SELECT etag FROM file_index WHERE r2_key=?")
            .bind(key).first<string>("etag");
          const notificationVersionCurrent = !event.object?.eTag || !indexedVersion || sameObjectVersion(event.object.eTag,indexedVersion);
          const needsNotificationTime = notificationVersionCurrent && authenticatedDeliveryNotificationsEnabled(env);
          // A current delete may mutate the shared index before its notification
          // stage. Refuse it before either mutation if neither the R2 payload nor
          // the immutable queue message supplies a usable event time.
          const eventAt = needsNotificationTime ? notificationEventTime(event.eventTime, message.timestamp) : null;
          if (needsNotificationTime && !eventAt) throw new Error("file-event-notification-timestamp-unavailable");
          const removal = await handleRemovedSource(env, key, event.object?.eTag);
          if (removal === "removed") {
            await recordClientFolderFileChange(env, key, false);
            if (notificationVersionCurrent && eventAt)
              await recordAuthenticatedDeliveryObjectChange(env,key,false,indexedVersion || event.object?.eTag,eventAt);
          }
        }
        else await env.DELIVERY_DB.prepare("DELETE FROM file_index WHERE r2_key=?").bind(key).run();
        message.ack(); continue;
      }
      if (hidden(key)) {
        await env.DELIVERY_DB.prepare("DELETE FROM file_index WHERE r2_key=?").bind(key).run(); message.ack(); continue;
      }
      if (!created(event.action)) { message.ack(); continue; }
      if (recovery) {
        // Read the revision tombstone before HEAD. This snapshot, not a
        // later key-only read, is the input to the atomic index/receipt CAS.
        const alias = await readAcceptedDeliveryChangeReceipt(env, {
          ...recoveryDelivery(env, batch, message), key, present: true,
        });
        if (alias) {
          const current = await env.DATA_BUCKET.head(key);
          if (recoveryVersionMatches(current, alias)) await replayCreatedSideEffects(env, key, current);
          message.ack(); continue;
        }
        const snapshot = await readDeliveryIndexObservation(env.DELIVERY_DB.withSession("first-primary"), key);
        const suppressed=await env.OPS_DB.prepare("DELETE FROM r2_event_suppressions WHERE object_key=? AND event_kind='create' AND datetime(expires_at)>datetime('now') RETURNING object_key").bind(key).first();
        if(suppressed){message.ack();continue;}
        const head = await env.DATA_BUCKET.head(key); if (!head) { message.retry(); continue; }
        if(isMovedSourceMarker(head)){
          const movedEtag=head.customMetadata?.ltdsMovedSourceEtag;
          if(movedEtag){
            const retired = await env.DELIVERY_DB.prepare(`DELETE FROM file_index WHERE r2_key=? AND trim(etag,'\"')=trim(?,'\"')
              AND COALESCE((SELECT revision FROM delivery_file_index_revisions WHERE r2_key=?),0)=? RETURNING r2_key`)
              .bind(key,movedEtag,key,snapshot.revision).first();
            const current = await env.DATA_BUCKET.head(key);
            if(retired && current?.version === head.version && isMovedSourceMarker(current)) {
              await deleteImageLocation(env,key,movedEtag);
              await removeThumbnailStateForPath(env,key,false,movedEtag);
            }
            await repairCurrentIndexAndDerivatives(env,key);
          }
          message.ack();continue;
        }
        const kind = mediaKind(key);
        const eventAt = notificationEventTime(event.eventTime, head.uploaded) ?? notificationEventTime(undefined, message.timestamp);
        if (!eventAt) throw new Error("file-event-notification-timestamp-unavailable");
        const existing = await env.DELIVERY_DB.prepare("SELECT etag,stream_uid,stream_status,stream_upload_url,stream_upload_offset FROM file_index WHERE r2_key=?").bind(key).first<TusState>();
        let stream: DeliveryIndexStreamState = { uid: existing?.stream_uid || null, status: existing?.stream_status || null, error: null };
        // Preserve the pre-existing completed Stream upload fast path. A
        // matching create must not erase its durable UID while accepting the
        // provider-aware index row; only new video rows use the disabled state.
        if (kind === "video" && !(existing?.etag === head.httpEtag && existing.stream_uid && !existing.stream_upload_url))
          stream = { uid: null, status: "disabled", error: null };
        const eventCurrent = sameObjectVersion(event.object?.eTag,head.httpEtag);
        if (eventCurrent) {
          await acceptAuthenticatedDeliveryChangeReceipt(env, {
            key, present: true, objectVersion: head.version, etag: head.httpEtag,
            eventAt, delivery: recoveryDelivery(env, batch, message),
          }, prepareDeliveryIndexCreateAcceptance(env.DELIVERY_DB.withSession("first-primary"), snapshot, head, stream));
        } else {
          // A delayed event cannot authorize a notification for the current
          // upload. Repair only the provider-aware index identity, without a
          // receipt or recipient discovery.
          const repaired = await prepareDeliveryIndexRepair(env.DELIVERY_DB.withSession("first-primary"), snapshot, head, stream).run();
          if (Number(repaired.meta.changes || 0) !== 1) {
            const confirmed = await readDeliveryIndexObservation(env.DELIVERY_DB.withSession("first-primary"), key);
            if (confirmed.current?.providerVersion !== head.version || !sameObjectVersion(confirmed.current.etag, head.httpEtag))
              throw new Error("delivery-index-repair-fence-lost");
          }
        }
        await replayCreatedSideEffects(env, key, head);
        message.ack(); continue;
      }
      const suppressed=await env.OPS_DB.prepare("DELETE FROM r2_event_suppressions WHERE object_key=? AND event_kind='create' AND datetime(expires_at)>datetime('now') RETURNING object_key").bind(key).first();
      if(suppressed){message.ack();continue;}
      const head = await env.DATA_BUCKET.head(key); if (!head) { message.retry(); continue; }
      if(isMovedSourceMarker(head)){
        const movedEtag=head.customMetadata?.ltdsMovedSourceEtag;
        if(movedEtag){
          await deleteImageLocation(env,key,movedEtag);
          await removeThumbnailStateForPath(env,key,false,movedEtag);
          await env.DELIVERY_DB.prepare("DELETE FROM file_index WHERE r2_key=? AND trim(etag,'\"')=trim(?,'\"')").bind(key,movedEtag).run();
        }
        message.ack();continue;
      }
      const kind = mediaKind(key);
      const eventAt = notificationEventTime(event.eventTime, head.uploaded) ?? notificationEventTime(undefined, message.timestamp);
      if (!eventAt) throw new Error("file-event-notification-timestamp-unavailable");
      const existing = await env.DELIVERY_DB.prepare("SELECT etag,stream_uid,stream_status,stream_upload_url,stream_upload_offset FROM file_index WHERE r2_key=?").bind(key).first<TusState>();
      if (existing?.etag === head.httpEtag && existing.stream_uid && !existing.stream_upload_url) {
        const thumbnailJob = thumbnailJobForCreatedObject(event.action, key, kind, head, event.eventTime);
        if (thumbnailJob) await enqueueThumbnailJob(env, thumbnailJob);
        if (sameObjectVersion(event.object?.eTag,head.httpEtag))
          await recordAuthenticatedDeliveryObjectChange(env,key,true,head.httpEtag,eventAt);
        message.ack(); continue;
      }
      let stream = { uid: existing?.stream_uid || null, status: existing?.stream_status || null, error: null as string | null };
      // Stream ingestion/transcoding and video thumbnail extraction remain
      // disabled; video items use the client-bundled file-kind icon.
      if (kind === "video") stream = { uid: null, status: "disabled", error: null };
      await env.DELIVERY_DB.batch([
        env.DELIVERY_DB.prepare(`INSERT INTO file_index (r2_key,etag,size,uploaded_at,content_type,media_kind,stream_uid,stream_status,stream_error) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(r2_key) DO UPDATE SET etag=excluded.etag,size=excluded.size,uploaded_at=excluded.uploaded_at,content_type=excluded.content_type,media_kind=excluded.media_kind,stream_uid=excluded.stream_uid,stream_status=excluded.stream_status,stream_error=excluded.stream_error,updated_at=datetime('now')`).bind(key, head.httpEtag, head.size, head.uploaded.toISOString(), mime(key), kind, stream.uid, stream.status, stream.error),
        env.DELIVERY_DB.prepare(`INSERT INTO delivery_sync_health (source,last_attempt_at,last_success_at,status,details_json) VALUES ('truenas',datetime('now'),datetime('now'),'healthy',?) ON CONFLICT(source) DO UPDATE SET last_attempt_at=datetime('now'),last_success_at=datetime('now'),status='healthy',details_json=excluded.details_json,updated_at=datetime('now')`).bind(JSON.stringify({ lastKey: key })),
      ]);
      await recordClientFolderFileChange(env, key, true);
      if (sameObjectVersion(event.object?.eTag,head.httpEtag))
        await recordAuthenticatedDeliveryObjectChange(env,key,true,head.httpEtag,eventAt);
      const thumbnailJob = thumbnailJobForCreatedObject(event.action, key, kind, head, event.eventTime);
      if (thumbnailJob) await enqueueThumbnailJob(env, thumbnailJob);
      else if (canonicalThumbnailSourceKey(key)) {
        const locationJob = imageLocationJobForCreatedObject(event.action, key, kind, head);
        if (locationJob) await enqueueImageLocationJob(env, locationJob);
        await removeThumbnailStateForPath(env, key);
      }
      message.ack();
    } catch (error) {
      console.error(JSON.stringify({ event: "file-index.error", message: error instanceof Error ? error.message : "unknown" }));
      message.retry();
    }
  }
}

export async function refreshStreamStatuses(env: Env): Promise<number> {
  if (!env.STREAM_API_TOKEN || !env.STREAM_ACCOUNT_ID) return 0;
  const pending = await env.DELIVERY_DB.prepare("SELECT r2_key,stream_uid FROM file_index WHERE media_kind='video' AND stream_status='pending' AND stream_uid IS NOT NULL AND stream_upload_url IS NULL LIMIT 100").all<{ r2_key: string; stream_uid: string }>();
  let updated = 0;
  for (const row of pending.results) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.STREAM_ACCOUNT_ID}/stream/${row.stream_uid}`, { headers: { Authorization: `Bearer ${env.STREAM_API_TOKEN}` } });
    const body: { success?: boolean; result?: { readyToStream?: boolean; status?: { state?: string; errorReasonText?: string } } } = await response.json<{ success?: boolean; result?: { readyToStream?: boolean; status?: { state?: string; errorReasonText?: string } } }>().catch(() => ({}));
    if (!response.ok || !body.success) continue;
    const status = body.result?.readyToStream ? "ready" : body.result?.status?.state === "error" ? "error" : "pending";
    await env.DELIVERY_DB.prepare("UPDATE file_index SET stream_status=?,stream_error=?,updated_at=datetime('now') WHERE r2_key=? AND stream_uid=?").bind(status, body.result?.status?.errorReasonText?.slice(0, 240) || null, row.r2_key, row.stream_uid).run();
    updated += 1;
  }
  return updated;
}

export async function reconcileFileIndex(env: Env): Promise<number> {
  const recovery = await deliveryIndexRecoveryReady(env);
  const marker = crypto.randomUUID(); let cursor: string | undefined; let count = 0; let visibleBytes = 0;
  const activeShares = await env.DELIVERY_DB.prepare(`SELECT s.id,COALESCE(s.r2_prefix,p.r2_prefix) r2_prefix,s.unavailable_since FROM shares s JOIN projects p ON p.id=s.project_id WHERE s.revoked_at IS NULL AND p.active=1 AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))`).all<{ id:string; r2_prefix:string; unavailable_since:string|null }>();
  const presentShares = new Set<string>();
  try {
    do {
      const listed = await env.DATA_BUCKET.list({ limit: 1000, cursor, include:["httpMetadata","customMetadata"] }); const statements: D1PreparedStatement[] = [];
      for (const object of listed.objects) {
        if (object.key.endsWith("/") || hidden(object.key) || isMovedSourceMarker(object)) continue;
        if (recovery) {
          const db = env.DELIVERY_DB.withSession("first-primary");
          const snapshot = await readDeliveryIndexObservation(db, object.key);
          // An unchanged immutable upload needs no source-metadata write or
          // extra HEAD. A changed/unknown listing is only a candidate: observe
          // R2 again after the index snapshot before repairing its metadata.
          const unchanged = snapshot.current?.providerVersion === object.version;
          const current = unchanged ? object : await env.DATA_BUCKET.head(object.key);
          if (!current || isMovedSourceMarker(current)) continue;
          if (!unchanged) await prepareDeliveryIndexRepair(db, snapshot, current).run();
          const confirmed = unchanged ? snapshot : await readDeliveryIndexObservation(db, object.key);
          if (confirmed.current?.providerVersion !== current.version
            || !sameObjectVersion(confirmed.current.etag, current.httpEtag)) continue;
          // last_seen_reconcile is bookkeeping only; bind it to the repaired
          // provider identity so an older list page cannot mark a replacement.
          await db.prepare(`UPDATE file_index SET last_seen_reconcile=? WHERE r2_key=? AND provider_version=?
            AND COALESCE((SELECT revision FROM delivery_file_index_revisions WHERE r2_key=?),0)=?`)
            .bind(marker, object.key, current.version, object.key, confirmed.revision).run();
          visibleBytes += current.size;
          for (const share of activeShares.results) if (current.key.startsWith(share.r2_prefix.endsWith("/") ? share.r2_prefix : `${share.r2_prefix}/`)) presentShares.add(share.id);
          count += 1;
          if (canonicalThumbnailSourceKey(current.key) && thumbnailSourceEligible(current.key, current.size, current.httpMetadata?.contentType)) {
            await enqueueThumbnailJob(env, { sourceKey: current.key, sourceEtag: current.httpEtag, sourceSize: current.size, eventTime: current.uploaded.toISOString() });
          }
          continue;
        } else {
          visibleBytes += object.size;
          for (const share of activeShares.results) if (object.key.startsWith(share.r2_prefix.endsWith("/") ? share.r2_prefix : `${share.r2_prefix}/`)) presentShares.add(share.id);
          statements.push(env.DELIVERY_DB.prepare(`INSERT INTO file_index (r2_key,etag,size,uploaded_at,content_type,media_kind,last_seen_reconcile) VALUES (?,?,?,?,?,?,?) ON CONFLICT(r2_key) DO UPDATE SET etag=excluded.etag,size=excluded.size,uploaded_at=excluded.uploaded_at,content_type=excluded.content_type,media_kind=excluded.media_kind,last_seen_reconcile=excluded.last_seen_reconcile,updated_at=datetime('now')`).bind(object.key, object.httpEtag, object.size, object.uploaded.toISOString(), mime(object.key), mediaKind(object.key), marker));
        }
        count += 1;
        if (canonicalThumbnailSourceKey(object.key) && thumbnailSourceEligible(object.key, object.size, object.httpMetadata?.contentType)) {
          await enqueueThumbnailJob(env, { sourceKey: object.key, sourceEtag: object.httpEtag, sourceSize: object.size, eventTime: object.uploaded.toISOString() });
        }
      }
      if (statements.length) await env.DELIVERY_DB.batch(statements); cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    const unresolvedShareHolds = await env.OPS_DB.prepare(`SELECT json_extract(details_json,'$.shareId') share_id
      FROM delivery_reconciliation_alerts WHERE source='truenas' AND alert_type='share_source_missing'
      AND acknowledged_at IS NULL AND json_valid(details_json)`).all<{ share_id: string | null }>();
    const shareHoldIds = new Set(unresolvedShareHolds.results.map(row => row.share_id).filter((value): value is string => Boolean(value)));
    const shareUpdates:D1PreparedStatement[]=[];
    const shareHoldStatements:D1PreparedStatement[]=[];
    const shareAcknowledgements:D1PreparedStatement[]=[];
    for(const share of activeShares.results){
      if(presentShares.has(share.id)){
        if(share.unavailable_since)shareUpdates.push(env.DELIVERY_DB.prepare("UPDATE shares SET unavailable_since=NULL WHERE id=? AND revoked_at IS NULL").bind(share.id));
        if(shareHoldIds.has(share.id)) shareAcknowledgements.push(env.OPS_DB.prepare(`UPDATE delivery_reconciliation_alerts SET acknowledged_at=datetime('now')
          WHERE source='truenas' AND alert_type='share_source_missing' AND acknowledged_at IS NULL
          AND json_valid(details_json) AND json_extract(details_json,'$.shareId')=?`).bind(share.id));
        continue;
      }
      if(!share.unavailable_since)shareUpdates.push(env.DELIVERY_DB.prepare("UPDATE shares SET unavailable_since=datetime('now') WHERE id=? AND revoked_at IS NULL AND unavailable_since IS NULL").bind(share.id));
      else if((!Number.isFinite(databaseTimestampMillis(share.unavailable_since))||databaseTimestampMillis(share.unavailable_since)+24*60*60*1000<=Date.now())&&!shareHoldIds.has(share.id)){
        shareHoldStatements.push(env.OPS_DB.prepare(`INSERT INTO delivery_reconciliation_alerts(source,alert_type,details_json)
          SELECT 'truenas','share_source_missing',? WHERE NOT EXISTS (
            SELECT 1 FROM delivery_reconciliation_alerts WHERE source='truenas' AND alert_type='share_source_missing'
            AND acknowledged_at IS NULL AND json_valid(details_json) AND json_extract(details_json,'$.shareId')=?
          )`).bind(JSON.stringify({ shareId: share.id, r2Prefix: share.r2_prefix, unavailableSince: share.unavailable_since, action: "operator_review_required" }), share.id));
      }
    }
    const previous = await env.OPS_DB.prepare("SELECT last_visible_count,last_visible_bytes FROM delivery_reconciliation_state WHERE source='truenas'").first<{last_visible_count:number;last_visible_bytes:number}>();
    const visibleDrop = Boolean(previous && previous.last_visible_count > 0 && count < previous.last_visible_count * 0.5);
    if (visibleDrop) {
      const details = { visibleCount: count, previousVisibleCount: previous?.last_visible_count || 0, visibleBytes, previousVisibleBytes: previous?.last_visible_bytes || 0, reasons: ["visible_object_drop_over_50_percent"] };
      await env.OPS_DB.prepare("INSERT INTO delivery_reconciliation_alerts(source,alert_type,details_json) VALUES('truenas','circuit_breaker',?)").bind(JSON.stringify(details)).run();
      await env.DELIVERY_DB.prepare(`INSERT INTO delivery_sync_health (source,last_attempt_at,status,details_json) VALUES ('reconciliation',datetime('now'),'error',?) ON CONFLICT(source) DO UPDATE SET last_attempt_at=datetime('now'),status='error',details_json=excluded.details_json,updated_at=datetime('now')`).bind(JSON.stringify({ error: "reconciliation circuit breaker", ...details })).run();
      await sendAdminAlert(env, "Delivery reconciliation paused", `Repair and missing-state updates were paused. ${JSON.stringify(details)}`);
      return count;
    }
    await env.DELIVERY_DB.batch([
      env.DELIVERY_DB.prepare(`INSERT INTO delivery_sync_health (source,last_attempt_at,last_success_at,status,object_count) VALUES ('reconciliation',datetime('now'),datetime('now'),'healthy',?) ON CONFLICT(source) DO UPDATE SET last_attempt_at=datetime('now'),last_success_at=datetime('now'),status='healthy',object_count=excluded.object_count,updated_at=datetime('now')`).bind(count),
      ...shareUpdates,
    ]);
    if (shareAcknowledgements.length) await env.OPS_DB.batch(shareAcknowledgements);
    const shareHoldResults = shareHoldStatements.length ? await env.OPS_DB.batch(shareHoldStatements) : [];
    const newShareHolds = shareHoldResults.reduce((total, result) => total + Number(result.meta.changes || 0), 0);
    await env.OPS_DB.prepare(`INSERT INTO delivery_reconciliation_state(source,last_success_at,last_visible_count,last_visible_bytes) VALUES('truenas',datetime('now'),?,?) ON CONFLICT(source) DO UPDATE SET last_success_at=datetime('now'),last_visible_count=excluded.last_visible_count,last_visible_bytes=excluded.last_visible_bytes,updated_at=datetime('now')`).bind(count, visibleBytes).run();
    const artifacts = await env.DELIVERY_DB.prepare(`SELECT artifact_prefix,source_key,missing_since FROM preview_artifacts
      ORDER BY updated_at,artifact_prefix LIMIT 200`)
      .all<{artifact_prefix:string;source_key:string;missing_since:string|null}>();
    const unresolvedPreviewHolds = await env.OPS_DB.prepare(`SELECT json_extract(details_json,'$.artifactPrefix') artifact_prefix
      FROM delivery_reconciliation_alerts WHERE source='truenas' AND alert_type='preview_source_missing'
      AND acknowledged_at IS NULL AND json_valid(details_json)`).all<{ artifact_prefix: string | null }>();
    const previewHoldPrefixes = new Set(unresolvedPreviewHolds.results.map(row => row.artifact_prefix).filter((value): value is string => Boolean(value)));
    let newPreviewHolds = 0;
    for (const artifact of artifacts.results) {
      const source = await env.DATA_BUCKET.head(artifact.source_key);
      if (source) {
        await env.DELIVERY_DB.prepare("UPDATE preview_artifacts SET missing_since=NULL,last_seen_at=datetime('now'),updated_at=datetime('now') WHERE artifact_prefix=?").bind(artifact.artifact_prefix).run();
        if (previewHoldPrefixes.has(artifact.artifact_prefix)) await env.OPS_DB.prepare(`UPDATE delivery_reconciliation_alerts SET acknowledged_at=datetime('now')
          WHERE source='truenas' AND alert_type='preview_source_missing' AND acknowledged_at IS NULL
          AND json_valid(details_json) AND json_extract(details_json,'$.artifactPrefix')=?`).bind(artifact.artifact_prefix).run();
        continue;
      }
      if (!artifact.missing_since) {
        await env.DELIVERY_DB.prepare("UPDATE preview_artifacts SET missing_since=datetime('now'),updated_at=datetime('now') WHERE artifact_prefix=? AND missing_since IS NULL").bind(artifact.artifact_prefix).run();
        continue;
      }
      await env.DELIVERY_DB.prepare("UPDATE preview_artifacts SET updated_at=datetime('now') WHERE artifact_prefix=?").bind(artifact.artifact_prefix).run();
      const missingSince = databaseTimestampMillis(artifact.missing_since);
      if (Number.isFinite(missingSince) && missingSince + 24 * 60 * 60 * 1000 > Date.now()) continue;
      if (!previewHoldPrefixes.has(artifact.artifact_prefix)) {
        const created = await env.OPS_DB.prepare(`INSERT INTO delivery_reconciliation_alerts(source,alert_type,details_json)
          SELECT 'truenas','preview_source_missing',? WHERE NOT EXISTS (
            SELECT 1 FROM delivery_reconciliation_alerts WHERE source='truenas' AND alert_type='preview_source_missing'
            AND acknowledged_at IS NULL AND json_valid(details_json) AND json_extract(details_json,'$.artifactPrefix')=?
          )`).bind(JSON.stringify({ artifactPrefix: artifact.artifact_prefix, sourceKey: artifact.source_key, missingSince: artifact.missing_since, action: "operator_review_required" }), artifact.artifact_prefix).run();
        newPreviewHolds += Number(created.meta.changes || 0);
      }
    }
    if (newShareHolds || newPreviewHolds) await sendAdminAlert(env, "Delivery reconciliation requires review", `${newShareHolds} share source hold(s) and ${newPreviewHolds} preview source hold(s) require operator review. No access or objects were removed.`);
    return count;
  } catch (error) {
    await env.DELIVERY_DB.prepare(`INSERT INTO delivery_sync_health (source,last_attempt_at,status,details_json) VALUES ('reconciliation',datetime('now'),'error',?) ON CONFLICT(source) DO UPDATE SET last_attempt_at=datetime('now'),status='error',details_json=excluded.details_json,updated_at=datetime('now')`).bind(JSON.stringify({ error: error instanceof Error ? error.message : "unknown" })).run();
    await sendAdminAlert(env, "Delivery reconciliation failed", error instanceof Error ? error.message : "Unknown reconciliation error");
    throw error;
  }
}
