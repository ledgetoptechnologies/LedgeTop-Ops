import { HTTPException } from "hono/http-exception";
import { assertNotTrashed, createTombstone, type TrashObjectIdentity } from "./trash";
import { notificationStatement } from "./notifications";
import { artifactDirectory } from "./artifacts";
import { decodeRef, normalizePrefix } from "./delivery";
import type { Env, StaffPrincipal } from "./types";
import { removeThumbnailStateForPath } from "./image-thumbnails";

const BATCH = 1000;

export interface DeletePreview { key: string; isFolder: boolean; typedName: string; objectCount: number; byteCount: number; shareCount: number; warnings: string[] }

export function validateDeleteConfirmation(confirmation: unknown, typedName: string): void {
  if (typeof confirmation !== "string" || confirmation !== typedName) throw new HTTPException(400, { message: `Type ${typedName} exactly to confirm deletion` });
}

export async function derivativePrefixes(key: string, isFolder: boolean): Promise<string[]> {
  if (isFolder) return [];
  return [await artifactDirectory(key)];
}

async function listKeys(bucket: R2Bucket, prefix: string, exact = false): Promise<Array<{ key: string; size: number; etag: string }>> {
  if (exact) { const head = await bucket.head(prefix); return head ? [{ key: prefix, size: head.size, etag: head.etag }] : []; }
  const output: Array<{ key: string; size: number; etag: string }> = []; let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: BATCH, cursor });
    output.push(...page.objects.filter(object => !object.key.endsWith("/")).map(object => ({ key: object.key, size: object.size, etag: object.etag })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return output;
}

async function resolveTarget(env: Env, itemRef: string): Promise<{ key: string; isFolder: boolean; objects: Array<{ key: string; size: number; etag: string }> }> {
  const decoded = decodeRef(itemRef); const key = decoded.endsWith("/") ? normalizePrefix(decoded) : decoded;
  await assertNotTrashed(env, key);
  const exact = await listKeys(env.DATA_BUCKET, key, true);
  if (exact.length) return { key, isFolder: false, objects: exact };
  const objects = await listKeys(env.DATA_BUCKET, key.endsWith("/") ? key : `${key}/`);
  if (!objects.length) throw new HTTPException(404, { message: "Source file or folder not found" });
  return { key: key.endsWith("/") ? key : `${key}/`, isFolder: true, objects };
}

export async function previewSourceDelete(env: Env, itemRef: string): Promise<DeletePreview> {
  const target = await resolveTarget(env, itemRef); const sharePrefix = target.isFolder ? target.key : `${target.key}/`;
  const shares = await env.DELIVERY_DB.prepare(`SELECT COUNT(*) count FROM shares s JOIN projects p ON p.id=s.project_id
    WHERE s.revoked_at IS NULL AND p.active=1 AND
    (COALESCE(s.r2_prefix,p.r2_prefix)=? OR substr(COALESCE(s.r2_prefix,p.r2_prefix),1,length(?))=?)`)
    .bind(target.key, sharePrefix, sharePrefix).first<{ count: number }>();
  const typedName = target.key.replace(/\/$/, "").split("/").pop() || target.key;
  return { key: target.key, isFolder: target.isFolder, typedName, objectCount: target.objects.length, byteCount: target.objects.reduce((sum, object) => sum + object.size, 0), shareCount: Number(shares?.count || 0), warnings: ["TrueNAS is the source of truth and can resync this path.", "The source will be hidden immediately and purged from R2 after 7 days unless restored.", ...(target.isFolder ? ["All descendants will be moved to Trash together."] : []), ...(Number(shares?.count || 0) ? ["Descendant delivery shares will be revoked immediately."] : [])] };
}

export async function executeSourceDelete(env: Env, principal: StaffPrincipal, itemRef: string, confirmation: unknown): Promise<DeletePreview> {
  const preview = await previewSourceDelete(env, itemRef);
  validateDeleteConfirmation(confirmation, preview.typedName);
  const prefix = preview.isFolder ? preview.key : `${preview.key}/`;
  const target = await resolveTarget(env, itemRef);
  if (target.key !== preview.key || target.isFolder !== preview.isFolder) throw new HTTPException(409, { message: "The source changed while deletion was being confirmed; review it and try again" });
  const affected = await env.DELIVERY_DB.prepare(`SELECT s.id,COALESCE(s.division_id,p.division_id) division_id,
    s.recipient_email,p.client_name,p.project_name,COALESCE(s.r2_prefix,p.r2_prefix) r2_prefix
    FROM shares s JOIN projects p ON p.id=s.project_id
    WHERE s.revoked_at IS NULL AND p.active=1 AND
    (COALESCE(s.r2_prefix,p.r2_prefix)=? OR substr(COALESCE(s.r2_prefix,p.r2_prefix),1,length(?))=?)`)
    .bind(preview.key, prefix, prefix).all<{ id: string; division_id: string | null; recipient_email: string | null; client_name: string; project_name: string; r2_prefix: string }>();
  const byKey = new Map<string, TrashObjectIdentity>(target.objects.map(object =>
    [object.key, { key: object.key, etag: object.etag, size: object.size, relation: "source" }]));
  const artifacts = await env.DELIVERY_DB.prepare(`SELECT artifact_prefix FROM preview_artifacts
    WHERE source_key=? OR substr(source_key,1,length(?))=?`).bind(preview.key, prefix, prefix).all<{ artifact_prefix: string }>();
  const artifactPrefixes = new Set(artifacts.results.map(row => row.artifact_prefix));
  if (!preview.isFolder) artifactPrefixes.add(await artifactDirectory(preview.key));
  for (const artifactPrefix of artifactPrefixes) {
    for (const object of await listKeys(env.DATA_BUCKET, artifactPrefix)) {
      byKey.set(object.key, { key: object.key, etag: object.etag, size: object.size, relation: "derived" });
    }
  }
  const tombstone = await createTombstone(env, principal, preview.key, preview.isFolder, [...byKey.values()]);
  await removeThumbnailStateForPath(env, preview.key, preview.isFolder);
  const statements: D1PreparedStatement[] = [];
  for (const share of affected.results) {
    statements.push(env.DELIVERY_DB.prepare("UPDATE shares SET revoked_at=datetime('now'),revoked_reason='staff_deleted_source',share_version=share_version+1 WHERE id=? AND revoked_at IS NULL").bind(share.id));
    statements.push(env.DELIVERY_DB.prepare("INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES('staff',?,'share.auto_revoked','share',?,?)").bind(principal.id, share.id, JSON.stringify({ reason: "staff_deleted_source", sourceKey: preview.key })));
    const notification = notificationStatement(env, { shareId: share.id, kind: "share_revoked", recipientEmail: share.recipient_email,
      payload: { clientName: share.client_name, projectName: share.project_name, r2Prefix: share.r2_prefix } });
    if (notification) statements.push(notification);
  }
  try {
    if (statements.length) await env.DELIVERY_DB.batch(statements);
  } catch (error) {
    await env.DELIVERY_DB.prepare("DELETE FROM delivery_tombstones WHERE id=? AND restored_at IS NULL").bind(tombstone.id).run();
    throw error;
  }
  await env.OPS_DB.batch([env.OPS_DB.prepare("INSERT INTO audit_events(actor_type,actor_id,actor_email,actor_display_name,action,entity_type,entity_id,details_json) VALUES('staff',?,?,?,?,?,?,?)").bind(principal.id, principal.email, principal.displayName, "delivery.source_deleted", "file", preview.key, JSON.stringify({ reason: "staff_deleted_source", objectCount: preview.objectCount, byteCount: preview.byteCount, shareCount: affected.results.length }))]);
  return { ...preview, key: tombstone.physical_key, warnings: [...preview.warnings, "The source remains in Trash for 7 days and can be restored by an administrator."] };
}
