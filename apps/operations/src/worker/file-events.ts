import { mediaKind, mime } from "./delivery";
import type { Env } from "./types";
import { artifactDirectory } from "./artifacts";
import { sendAdminAlert } from "./alerts";
import { notificationStatement } from "./notifications";

export interface R2Notification {
  action: string;
  object?: { key?: string; size?: number; eTag?: string };
  bucket?: string;
}

interface TusState { etag: string; stream_uid: string | null; stream_status: string | null; stream_upload_url: string | null; stream_upload_offset: number | null }
const TUS_VERSION = "1.0.0";
const TUS_CHUNK = 50 * 1024 * 1024;

export function hidden(key: string): boolean {
  const parts = key.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.some(part => part.toLowerCase() === "dump" || part.toLowerCase() === "_ltds");
}
function created(action: string): boolean { return ["PutObject", "CopyObject", "CompleteMultipartUpload"].some(value => action.includes(value)); }
function removed(action: string): boolean { return action.includes("Delete") || action.includes("Lifecycle"); }
function metadata(value: string): string { let binary = ""; for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte); return btoa(binary); }

function previewManifest(key: string): boolean {
  return /(?:^|\/)_ltds\/previews\/[a-f0-9]{64}\/manifest\.json$/i.test(key);
}

async function recordPreviewManifest(env: Env, key: string, etag: string): Promise<void> {
  const object = await env.DATA_BUCKET.get(key, { range: { offset: 0, length: 64 * 1024 } });
  if (!object) return;
  const manifest = await object.json<{ sourceKey?: unknown; sourceEtag?: unknown; sourceSize?: unknown; producerVersion?: unknown; createdAt?: unknown }>().catch(() => null);
  if (!manifest || typeof manifest.sourceKey !== "string" || hidden(manifest.sourceKey) ||
    typeof manifest.sourceEtag !== "string" || typeof manifest.sourceSize !== "number" ||
    typeof manifest.producerVersion !== "string" || !manifest.producerVersion.trim() ||
    typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) return;
  const prefix = key.slice(0, -"manifest.json".length);
  if (prefix !== await artifactDirectory(manifest.sourceKey)) return;
  await env.DELIVERY_DB.prepare(`INSERT INTO preview_artifacts(artifact_prefix,source_key,source_etag,manifest_etag)
    VALUES(?,?,?,?) ON CONFLICT(artifact_prefix) DO UPDATE SET source_key=excluded.source_key,
    source_etag=excluded.source_etag,manifest_etag=excluded.manifest_etag,missing_since=NULL,
    last_seen_at=datetime('now'),updated_at=datetime('now')`).bind(
    prefix, manifest.sourceKey, manifest.sourceEtag, etag,
  ).run();
}

async function beginTusUpload(env: Env, key: string, size: number, etag: string): Promise<{ uid: string; url: string; offset: number }> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.STREAM_ACCOUNT_ID}/stream`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STREAM_API_TOKEN}`,
      "Tus-Resumable": TUS_VERSION,
      "Upload-Length": String(size),
      "Upload-Metadata": `name ${metadata(key.split("/").pop() || "video")},requiresignedurls ${metadata("true")},allowedorigins ${metadata(JSON.stringify(["delivery.ledgetopdroneservices.com"]))}`,
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
  for (const message of batch.messages) {
    try {
      const event = message.body; const key = event.object?.key;
      if (!key) { message.ack(); continue; }
      if (previewManifest(key)) {
        if (removed(event.action)) await env.DELIVERY_DB.prepare("DELETE FROM preview_artifacts WHERE artifact_prefix=?").bind(key.slice(0, -"manifest.json".length)).run();
        else if (created(event.action)) { const head = await env.DATA_BUCKET.head(key); if (head) await recordPreviewManifest(env, key, head.httpEtag); }
        message.ack(); continue;
      }
      if (removed(event.action) || hidden(key)) { await env.DELIVERY_DB.prepare("DELETE FROM file_index WHERE r2_key=?").bind(key).run(); message.ack(); continue; }
      if (!created(event.action)) { message.ack(); continue; }
      const head = await env.DATA_BUCKET.head(key); if (!head) { message.retry(); continue; }
      const kind = mediaKind(key);
      const existing = await env.DELIVERY_DB.prepare("SELECT etag,stream_uid,stream_status,stream_upload_url,stream_upload_offset FROM file_index WHERE r2_key=?").bind(key).first<TusState>();
      if (existing?.etag === head.httpEtag && existing.stream_uid && !existing.stream_upload_url) { message.ack(); continue; }
      let stream = { uid: existing?.stream_uid || null, status: existing?.stream_status || null, error: null as string | null };
      if (kind === "video") stream = await uploadVideo(env, key, head.size, head.httpEtag);
      await env.DELIVERY_DB.batch([
        env.DELIVERY_DB.prepare(`INSERT INTO file_index (r2_key,etag,size,uploaded_at,content_type,media_kind,stream_uid,stream_status,stream_error) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(r2_key) DO UPDATE SET etag=excluded.etag,size=excluded.size,uploaded_at=excluded.uploaded_at,content_type=excluded.content_type,media_kind=excluded.media_kind,stream_uid=excluded.stream_uid,stream_status=excluded.stream_status,stream_error=excluded.stream_error,updated_at=datetime('now')`).bind(key, head.httpEtag, head.size, head.uploaded.toISOString(), mime(key), kind, stream.uid, stream.status, stream.error),
        env.DELIVERY_DB.prepare(`INSERT INTO delivery_sync_health (source,last_attempt_at,last_success_at,status,details_json) VALUES ('truenas',datetime('now'),datetime('now'),'healthy',?) ON CONFLICT(source) DO UPDATE SET last_attempt_at=datetime('now'),last_success_at=datetime('now'),status='healthy',details_json=excluded.details_json,updated_at=datetime('now')`).bind(JSON.stringify({ lastKey: key })),
      ]);
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
  const marker = crypto.randomUUID(); let cursor: string | undefined; let count = 0; let visibleBytes = 0;
  const activeShares = await env.DELIVERY_DB.prepare(`SELECT s.id,COALESCE(s.r2_prefix,p.r2_prefix) r2_prefix,s.unavailable_since,s.recipient_email,s.public_id,p.client_name,p.project_name FROM shares s JOIN projects p ON p.id=s.project_id WHERE s.revoked_at IS NULL AND p.active=1 AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))`).all<{ id:string; r2_prefix:string; unavailable_since:string|null; recipient_email:string|null; public_id:string|null; client_name:string; project_name:string }>();
  const presentShares = new Set<string>();
  try {
    do {
      const listed = await env.DATA_BUCKET.list({ limit: 1000, cursor }); const statements: D1PreparedStatement[] = [];
      for (const object of listed.objects) {
        if (object.key.endsWith("/") || hidden(object.key)) continue;
        visibleBytes += object.size;
        for (const share of activeShares.results) if (object.key.startsWith(share.r2_prefix.endsWith("/") ? share.r2_prefix : `${share.r2_prefix}/`)) presentShares.add(share.id);
        statements.push(env.DELIVERY_DB.prepare(`INSERT INTO file_index (r2_key,etag,size,uploaded_at,content_type,media_kind,last_seen_reconcile) VALUES (?,?,?,?,?,?,?) ON CONFLICT(r2_key) DO UPDATE SET etag=excluded.etag,size=excluded.size,uploaded_at=excluded.uploaded_at,content_type=excluded.content_type,media_kind=excluded.media_kind,last_seen_reconcile=excluded.last_seen_reconcile,updated_at=datetime('now')`).bind(object.key, object.httpEtag, object.size, object.uploaded.toISOString(), mime(object.key), mediaKind(object.key), marker)); count += 1;
      }
      if (statements.length) await env.DELIVERY_DB.batch(statements); cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    const shareUpdates:D1PreparedStatement[]=[]; let revocationCount = 0;
    for(const share of activeShares.results){
      if(presentShares.has(share.id)){if(share.unavailable_since)shareUpdates.push(env.DELIVERY_DB.prepare("UPDATE shares SET unavailable_since=NULL WHERE id=? AND revoked_at IS NULL").bind(share.id));continue;}
      if(!share.unavailable_since)shareUpdates.push(env.DELIVERY_DB.prepare("UPDATE shares SET unavailable_since=datetime('now') WHERE id=? AND revoked_at IS NULL AND unavailable_since IS NULL").bind(share.id));
      else if(Date.parse(`${share.unavailable_since.replace(" ","T")}Z`)+24*60*60*1000<=Date.now()){
        shareUpdates.push(env.DELIVERY_DB.prepare("UPDATE shares SET revoked_at=datetime('now'),revoked_reason='folder_unavailable',share_version=share_version+1 WHERE id=? AND revoked_at IS NULL").bind(share.id));
        shareUpdates.push(env.DELIVERY_DB.prepare("INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('system','reconciliation','share.auto_revoked','share',?,?)").bind(share.id,JSON.stringify({reason:"folder_unavailable",r2Prefix:share.r2_prefix})));
        const notification = notificationStatement(env, { shareId: share.id, kind: "share_revoked", recipientEmail: share.recipient_email, payload: { publicId: share.public_id, clientName: share.client_name, projectName: share.project_name, r2Prefix: share.r2_prefix } });
        if (notification) shareUpdates.push(notification);
        revocationCount += 1;
      }
    }
    const previous = await env.OPS_DB.prepare("SELECT last_visible_count,last_visible_bytes FROM delivery_reconciliation_state WHERE source='truenas'").first<{last_visible_count:number;last_visible_bytes:number}>();
    const visibleDrop = Boolean(previous && previous.last_visible_count > 0 && count < previous.last_visible_count * 0.5);
    if (visibleDrop || revocationCount > 5) {
      const details = { visibleCount: count, previousVisibleCount: previous?.last_visible_count || 0, visibleBytes, previousVisibleBytes: previous?.last_visible_bytes || 0, revocationCount, reasons: [visibleDrop ? "visible_object_drop_over_50_percent" : null, revocationCount > 5 ? "revocation_count_over_5" : null].filter(Boolean) };
      await env.OPS_DB.prepare("INSERT INTO delivery_reconciliation_alerts(source,alert_type,details_json) VALUES('truenas','circuit_breaker',?)").bind(JSON.stringify(details)).run();
      await env.DELIVERY_DB.prepare(`INSERT INTO delivery_sync_health (source,last_attempt_at,status,details_json) VALUES ('reconciliation',datetime('now'),'error',?) ON CONFLICT(source) DO UPDATE SET last_attempt_at=datetime('now'),status='error',details_json=excluded.details_json,updated_at=datetime('now')`).bind(JSON.stringify({ error: "reconciliation circuit breaker", ...details })).run();
      await sendAdminAlert(env, "Delivery reconciliation paused", `Automatic share revocation and pruning were paused. ${JSON.stringify(details)}`);
      return count;
    }
    await env.DELIVERY_DB.batch([
      env.DELIVERY_DB.prepare("DELETE FROM file_index WHERE last_seen_reconcile IS NOT NULL AND last_seen_reconcile<>?").bind(marker),
      env.DELIVERY_DB.prepare(`INSERT INTO delivery_sync_health (source,last_attempt_at,last_success_at,status,object_count) VALUES ('reconciliation',datetime('now'),datetime('now'),'healthy',?) ON CONFLICT(source) DO UPDATE SET last_attempt_at=datetime('now'),last_success_at=datetime('now'),status='healthy',object_count=excluded.object_count,updated_at=datetime('now')`).bind(count),
      ...shareUpdates,
    ]);
    await env.OPS_DB.prepare(`INSERT INTO delivery_reconciliation_state(source,last_success_at,last_visible_count,last_visible_bytes) VALUES('truenas',datetime('now'),?,?) ON CONFLICT(source) DO UPDATE SET last_success_at=datetime('now'),last_visible_count=excluded.last_visible_count,last_visible_bytes=excluded.last_visible_bytes,updated_at=datetime('now')`).bind(count, visibleBytes).run();
    const artifacts = await env.DELIVERY_DB.prepare(`SELECT artifact_prefix,source_key,missing_since FROM preview_artifacts
      WHERE NOT EXISTS (SELECT 1 FROM file_index WHERE r2_key=preview_artifacts.source_key) OR missing_since IS NOT NULL LIMIT 200`)
      .all<{artifact_prefix:string;source_key:string;missing_since:string|null}>();
    for (const artifact of artifacts.results) {
      const source = await env.DATA_BUCKET.head(artifact.source_key);
      if (source) {
        if (artifact.missing_since) await env.DELIVERY_DB.prepare("UPDATE preview_artifacts SET missing_since=NULL,updated_at=datetime('now') WHERE artifact_prefix=?").bind(artifact.artifact_prefix).run();
        continue;
      }
      if (!artifact.missing_since) {
        await env.DELIVERY_DB.prepare("UPDATE preview_artifacts SET missing_since=datetime('now'),updated_at=datetime('now') WHERE artifact_prefix=? AND missing_since IS NULL").bind(artifact.artifact_prefix).run();
        continue;
      }
      if (Date.parse(`${artifact.missing_since.replace(" ","T")}Z`) + 24 * 60 * 60 * 1000 > Date.now()) continue;
      let artifactCursor: string | undefined;
      do {
        const page = await env.DATA_BUCKET.list({ prefix: artifact.artifact_prefix, limit: 1000, cursor: artifactCursor });
        if (page.objects.length) await env.DATA_BUCKET.delete(page.objects.map(object => object.key));
        artifactCursor = page.truncated ? page.cursor : undefined;
      } while (artifactCursor);
      await env.DELIVERY_DB.prepare("DELETE FROM preview_artifacts WHERE artifact_prefix=?").bind(artifact.artifact_prefix).run();
    }
    return count;
  } catch (error) {
    await env.DELIVERY_DB.prepare(`INSERT INTO delivery_sync_health (source,last_attempt_at,status,details_json) VALUES ('reconciliation',datetime('now'),'error',?) ON CONFLICT(source) DO UPDATE SET last_attempt_at=datetime('now'),status='error',details_json=excluded.details_json,updated_at=datetime('now')`).bind(JSON.stringify({ error: error instanceof Error ? error.message : "unknown" })).run();
    await sendAdminAlert(env, "Delivery reconciliation failed", error instanceof Error ? error.message : "Unknown reconciliation error");
    throw error;
  }
}
