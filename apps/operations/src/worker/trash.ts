import { HTTPException } from "hono/http-exception";
import { aliasMap } from "./aliases";
import { artifactDirectory } from "./artifacts";
import { normalizePrefix } from "./delivery";
import type { Env, StaffPrincipal } from "./types";

const BATCH = 1000;

export interface Tombstone {
  id: string;
  physical_key: string;
  tombstone_kind: "exact" | "prefix";
  deleted_by: string;
  deleted_at: string;
  purge_after: string;
  purging_at?: string | null;
  restored_by: string | null;
  restored_at: string | null;
}

export function tombstoneMatches(tombstone: Pick<Tombstone, "physical_key" | "tombstone_kind">, key: string): boolean {
  return tombstone.tombstone_kind === "exact" ? tombstone.physical_key === key : key.startsWith(tombstone.physical_key);
}

export async function activeTombstones(env: Env): Promise<Tombstone[]> {
  const result = await env.DELIVERY_DB.prepare(`SELECT id,physical_key,tombstone_kind,deleted_by,deleted_at,purge_after,restored_by,restored_at
    FROM delivery_tombstones WHERE restored_at IS NULL ORDER BY deleted_at DESC`).all<Tombstone>();
  return result.results;
}

export async function assertNotTrashed(env: Env, key: string): Promise<void> {
  const row = await env.DELIVERY_DB.prepare(`SELECT id FROM delivery_tombstones
    WHERE restored_at IS NULL AND (physical_key=? OR (tombstone_kind='prefix' AND substr(?,1,length(physical_key))=physical_key)) LIMIT 1`)
    .bind(key, key).first<{ id: string }>();
  if (row) throw new HTTPException(404, { message: "File or folder not found" });
}

export async function createTombstone(env: Env, principal: StaffPrincipal, key: string, isFolder: boolean): Promise<Tombstone> {
  const physicalKey = isFolder ? normalizePrefix(key) : key;
  const id = crypto.randomUUID();
  const deletedAt = new Date();
  const purgeAfter = new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DELIVERY_DB.prepare(`INSERT INTO delivery_tombstones
    (id,physical_key,tombstone_kind,deleted_by,deleted_at,purge_after) VALUES (?,?,?,?,?,?)`)
    .bind(id, physicalKey, isFolder ? "prefix" : "exact", principal.id, deletedAt.toISOString(), purgeAfter).run();
  return { id, physical_key: physicalKey, tombstone_kind: isFolder ? "prefix" : "exact", deleted_by: principal.id, deleted_at: deletedAt.toISOString(), purge_after: purgeAfter, restored_by: null, restored_at: null };
}

export async function listTrash(env: Env): Promise<Array<Tombstone & { display_name: string }>> {
  const rows = await activeTombstones(env);
  const aliases = await aliasMap(env, rows.map(row => row.physical_key));
  return rows.map(row => ({ ...row, display_name: aliases.get(row.physical_key) || row.physical_key.replace(/\/$/, "").split("/").pop() || row.physical_key }));
}

export async function restoreTombstone(env: Env, principal: StaffPrincipal, id: string): Promise<void> {
  const tombstone = await env.DELIVERY_DB.prepare("SELECT id,physical_key FROM delivery_tombstones WHERE id=? AND restored_at IS NULL AND purging_at IS NULL").bind(id).first<{ id: string; physical_key: string }>();
  if (!tombstone) throw new HTTPException(404, { message: "Trash item not found or already restored" });
  const restoredAt = new Date().toISOString();
  const restored = await env.DELIVERY_DB.prepare("UPDATE delivery_tombstones SET restored_by=?,restored_at=? WHERE id=? AND restored_at IS NULL AND purging_at IS NULL").bind(principal.id, restoredAt, id).run();
  if (restored.meta.changes !== 1) throw new HTTPException(409, { message: "This item is already being purged and can no longer be restored" });
  await env.OPS_DB.prepare(`INSERT INTO audit_events(actor_type,actor_id,actor_email,actor_display_name,action,entity_type,entity_id,details_json)
    VALUES('staff',?,?,?,?,?,?,?)`).bind(principal.id, principal.email, principal.displayName, "delivery.source_restored", "trash", id, JSON.stringify({ physicalKey: tombstone.physical_key })).run();
}

async function deleteListed(bucket: R2Bucket, prefix: string): Promise<number> {
  let cursor: string | undefined;
  let count = 0;
  do {
    const page = await bucket.list({ prefix, limit: BATCH, cursor });
    const keys = page.objects.map(object => object.key);
    if (keys.length) { await bucket.delete(keys); count += keys.length; }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return count;
}

async function deleteExactOrPrefix(bucket: R2Bucket, key: string, kind: "exact" | "prefix"): Promise<number> {
  if (kind === "exact") { if (await bucket.head(key)) { await bucket.delete(key); return 1; } return 0; }
  return deleteListed(bucket, key);
}

export async function purgeTrash(env: Env): Promise<number> {
  const result = await env.DELIVERY_DB.prepare(`SELECT id,physical_key,tombstone_kind,deleted_by,deleted_at,purge_after,purging_at
    FROM delivery_tombstones WHERE restored_at IS NULL AND datetime(purge_after)<=datetime('now')
    AND (purging_at IS NULL OR datetime(purging_at)<=datetime('now','-30 minutes')) ORDER BY purge_after LIMIT 25`).all<Tombstone>();
  let purged = 0;
  for (const tombstone of result.results) {
    const claimed = await env.DELIVERY_DB.prepare(`UPDATE delivery_tombstones SET purging_at=datetime('now')
      WHERE id=? AND restored_at IS NULL AND datetime(purge_after)<=datetime('now')
      AND (purging_at IS NULL OR datetime(purging_at)<=datetime('now','-30 minutes'))`).bind(tombstone.id).run();
    if (claimed.meta.changes !== 1) continue;
    const prefix = tombstone.tombstone_kind === "prefix" ? tombstone.physical_key : `${tombstone.physical_key}/`;
    const artifacts = await env.DELIVERY_DB.prepare(`SELECT artifact_prefix FROM preview_artifacts
      WHERE source_key=? OR substr(source_key,1,length(?))=?`).bind(tombstone.physical_key, prefix, prefix).all<{ artifact_prefix: string }>();
    const artifactPrefixes = new Set(artifacts.results.map(row => row.artifact_prefix));
    if (tombstone.tombstone_kind === "exact") artifactPrefixes.add(await artifactDirectory(tombstone.physical_key));
    const deletedObjects = await deleteExactOrPrefix(env.DATA_BUCKET, tombstone.physical_key, tombstone.tombstone_kind);
    for (const artifactPrefix of artifactPrefixes) await deleteListed(env.DATA_BUCKET, artifactPrefix);
    await env.DELIVERY_DB.batch([
      env.DELIVERY_DB.prepare(`DELETE FROM file_aliases WHERE physical_key=? OR substr(physical_key,1,length(?))=?`).bind(tombstone.physical_key, prefix, prefix),
      env.DELIVERY_DB.prepare(`DELETE FROM file_index WHERE r2_key=? OR substr(r2_key,1,length(?))=?`).bind(tombstone.physical_key, prefix, prefix),
      env.DELIVERY_DB.prepare(`DELETE FROM preview_artifacts WHERE source_key=? OR substr(source_key,1,length(?))=?`).bind(tombstone.physical_key, prefix, prefix),
      env.DELIVERY_DB.prepare("DELETE FROM delivery_tombstones WHERE id=? AND restored_at IS NULL").bind(tombstone.id),
    ]);
    await env.OPS_DB.prepare(`INSERT INTO audit_events(actor_type,action,entity_type,entity_id,details_json)
      VALUES('system','delivery.source_purged','trash',?,?)`).bind(tombstone.id, JSON.stringify({ physicalKey: tombstone.physical_key, deletedObjects })).run();
    purged += 1;
  }
  return purged;
}
