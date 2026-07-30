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

export interface TrashObjectIdentity {
  key: string;
  etag: string;
  size: number;
  relation: "source" | "derived";
}

export interface TrashObjectRow {
  object_key: string;
  object_etag: string;
  object_size: number;
  relation: "source" | "derived";
  purged_at: string | null;
}

export function r2PurgeEnabled(env: Pick<Env, "R2_PURGE_ENABLED">): boolean {
  return env.R2_PURGE_ENABLED === "true";
}

export function trashSnapshotBlockReason(manifest: TrashObjectRow[], current: TrashObjectIdentity[]): string | null {
  if (!manifest.length) return "legacy_or_empty_manifest";
  const expected = new Map(manifest.map(object => [object.object_key, object]));
  for (const object of current) {
    const recorded = expected.get(object.key);
    if (!recorded) return `unmanifested_object:${object.key}`;
    if (recorded.object_etag !== object.etag || recorded.object_size !== object.size) return `object_identity_changed:${object.key}`;
  }
  return null;
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

export async function createTombstone(env: Env, principal: StaffPrincipal, key: string, isFolder: boolean, objects: TrashObjectIdentity[]): Promise<Tombstone> {
  const physicalKey = isFolder ? normalizePrefix(key) : key;
  const id = crypto.randomUUID();
  const deletedAt = new Date();
  const purgeAfter = new Date(deletedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DELIVERY_DB.prepare(`INSERT INTO delivery_tombstones
    (id,physical_key,tombstone_kind,deleted_by,deleted_at,purge_after) VALUES (?,?,?,?,?,?)`)
    .bind(id, physicalKey, isFolder ? "prefix" : "exact", principal.id, deletedAt.toISOString(), purgeAfter).run();
  try {
    for (let offset = 0; offset < objects.length; offset += 75) {
      await env.DELIVERY_DB.batch(objects.slice(offset, offset + 75).map(object => env.DELIVERY_DB.prepare(`INSERT INTO delivery_trash_objects
        (tombstone_id,object_key,object_etag,object_size,relation) VALUES (?,?,?,?,?)`)
        .bind(id, object.key, object.etag, object.size, object.relation)));
    }
    await env.DELIVERY_DB.prepare("UPDATE delivery_tombstones SET manifested_at=datetime('now') WHERE id=? AND restored_at IS NULL")
      .bind(id).run();
  } catch (error) {
    await env.DELIVERY_DB.prepare("DELETE FROM delivery_tombstones WHERE id=? AND restored_at IS NULL").bind(id).run();
    throw error;
  }
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

async function listObjects(bucket: R2Bucket, prefix: string, exact: boolean, relation: "source" | "derived"): Promise<TrashObjectIdentity[]> {
  if (exact) {
    const object = await bucket.head(prefix);
    return object ? [{ key: prefix, etag: object.etag, size: object.size, relation }] : [];
  }
  const objects: TrashObjectIdentity[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: BATCH, cursor });
    objects.push(...page.objects.filter(object => !object.key.endsWith("/"))
      .map(object => ({ key: object.key, etag: object.etag, size: object.size, relation })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

async function currentTrashObjects(env: Env, tombstone: Tombstone): Promise<TrashObjectIdentity[]> {
  const source = await listObjects(env.DATA_BUCKET, tombstone.physical_key, tombstone.tombstone_kind === "exact", "source");
  const prefix = tombstone.tombstone_kind === "prefix" ? tombstone.physical_key : `${tombstone.physical_key}/`;
  const artifacts = await env.DELIVERY_DB.prepare(`SELECT artifact_prefix FROM preview_artifacts
    WHERE source_key=? OR substr(source_key,1,length(?))=?`).bind(tombstone.physical_key, prefix, prefix).all<{ artifact_prefix: string }>();
  const artifactPrefixes = new Set(artifacts.results.map(row => row.artifact_prefix));
  if (tombstone.tombstone_kind === "exact") artifactPrefixes.add(await artifactDirectory(tombstone.physical_key));
  const byKey = new Map(source.map(object => [object.key, object]));
  for (const artifactPrefix of artifactPrefixes) {
    for (const object of await listObjects(env.DATA_BUCKET, artifactPrefix, false, "derived")) byKey.set(object.key, object);
  }
  return [...byKey.values()];
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
    const manifest = await env.DELIVERY_DB.prepare(`SELECT object_key,object_etag,object_size,relation,purged_at
      FROM delivery_trash_objects WHERE tombstone_id=? ORDER BY object_key`).bind(tombstone.id).all<TrashObjectRow>();
    const blockedReason = trashSnapshotBlockReason(manifest.results, await currentTrashObjects(env, tombstone));
    if (blockedReason) {
      await env.DELIVERY_DB.prepare("UPDATE delivery_tombstones SET purging_at=NULL,purge_blocked_reason=? WHERE id=? AND restored_at IS NULL")
        .bind(blockedReason, tombstone.id).run();
      await env.OPS_DB.prepare(`INSERT INTO audit_events(actor_type,action,entity_type,entity_id,details_json)
        VALUES('system','delivery.source_purge_blocked','trash',?,?)`)
        .bind(tombstone.id, JSON.stringify({ physicalKey: tombstone.physical_key, reason: blockedReason })).run();
      continue;
    }
    let deletedObjects = 0;
    let interrupted = false;
    for (const recorded of manifest.results) {
      if (recorded.purged_at) continue;
      const object = await env.DATA_BUCKET.head(recorded.object_key);
      if (object && (object.etag !== recorded.object_etag || object.size !== recorded.object_size)) {
        const reason = `object_identity_changed:${recorded.object_key}`;
        await env.DELIVERY_DB.prepare("UPDATE delivery_tombstones SET purging_at=NULL,purge_blocked_reason=? WHERE id=? AND restored_at IS NULL")
          .bind(reason, tombstone.id).run();
        interrupted = true;
        break;
      }
      if (object) { await env.DATA_BUCKET.delete(recorded.object_key); deletedObjects += 1; }
      await env.DELIVERY_DB.prepare("UPDATE delivery_trash_objects SET purged_at=datetime('now') WHERE tombstone_id=? AND object_key=? AND purged_at IS NULL")
        .bind(tombstone.id, recorded.object_key).run();
    }
    if (interrupted) continue;
    const pending = await env.DELIVERY_DB.prepare("SELECT COUNT(*) count FROM delivery_trash_objects WHERE tombstone_id=? AND purged_at IS NULL")
      .bind(tombstone.id).first<{ count: number }>();
    if (Number(pending?.count || 0) > 0) continue;
    const prefix = tombstone.tombstone_kind === "prefix" ? tombstone.physical_key : `${tombstone.physical_key}/`;
    await env.DELIVERY_DB.batch([
      env.DELIVERY_DB.prepare(`DELETE FROM file_aliases WHERE physical_key=? OR substr(physical_key,1,length(?))=?`).bind(tombstone.physical_key, prefix, prefix),
      env.DELIVERY_DB.prepare(`DELETE FROM file_index WHERE r2_key=? OR substr(r2_key,1,length(?))=?`).bind(tombstone.physical_key, prefix, prefix),
      env.DELIVERY_DB.prepare(`DELETE FROM preview_artifacts WHERE source_key=? OR substr(source_key,1,length(?))=?`).bind(tombstone.physical_key, prefix, prefix),
      env.DELIVERY_DB.prepare("DELETE FROM delivery_tombstones WHERE id=? AND restored_at IS NULL AND purging_at IS NOT NULL").bind(tombstone.id),
    ]);
    await env.OPS_DB.prepare(`INSERT INTO audit_events(actor_type,action,entity_type,entity_id,details_json)
      VALUES('system','delivery.source_purged','trash',?,?)`).bind(tombstone.id, JSON.stringify({ physicalKey: tombstone.physical_key, deletedObjects })).run();
    purged += 1;
  }
  return purged;
}
