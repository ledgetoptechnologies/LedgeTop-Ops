import type { Env } from "./types";

interface ArchiveSpec {
  database: "ops" | "delivery";
  table: "audit_events" | "sync_runs" | "integration_event_receipts" | "audit_log" | "share_events"
    | "portal_authenticated_content_events";
  id: string;
  timestamp: string;
  days: number;
  /** A guarded append-only ledger is deleted only while this singleton gate is
   * enabled inside the same D1 batch as every exact-id deletion. */
  retentionGate?: string;
  /** The migration-owned trigger that proves direct deletes remain fail-closed. */
  retentionDeleteGuard?: string;
}

const ARCHIVES: ArchiveSpec[] = [
  { database: "delivery", table: "share_events", id: "id", timestamp: "created_at", days: 90 },
  { database: "delivery", table: "audit_log", id: "id", timestamp: "created_at", days: 365 },
  { database: "delivery", table: "portal_authenticated_content_events", id: "id", timestamp: "occurred_at", days: 365,
    retentionGate: "portal_authenticated_content_retention_control",
    retentionDeleteGuard: "portal_authenticated_content_events_retention_delete_guard" },
  { database: "ops", table: "audit_events", id: "id", timestamp: "created_at", days: 365 },
  { database: "ops", table: "sync_runs", id: "id", timestamp: "started_at", days: 90 },
  { database: "ops", table: "integration_event_receipts", id: "event_id", timestamp: "received_at", days: 30 },
];

async function guardedRetentionSchemaAvailable(database: D1Database, spec: ArchiveSpec): Promise<boolean> {
  if (!spec.retentionGate) return true;
  if (!spec.retentionDeleteGuard) throw new Error(`Retention schema for ${spec.table} is incomplete`);
  const names = (await database.prepare(`SELECT name FROM sqlite_master
    WHERE (type='table' AND name IN (?,?)) OR (type='trigger' AND name=?) ORDER BY name`)
    .bind(spec.table, spec.retentionGate, spec.retentionDeleteGuard).all<{ name: string }>()).results.map(row => row.name);
  if (names.length === 0) return false;
  if (names.length !== 3) throw new Error(`Retention schema for ${spec.table} is incomplete`);
  const control = await database.prepare(`SELECT delete_enabled,delete_before FROM ${spec.retentionGate} WHERE singleton=1`)
    .first<{ delete_enabled: number; delete_before: string | null }>();
  if (control?.delete_enabled !== 0 || control.delete_before !== null)
    throw new Error(`Retention gate for ${spec.table} is not safely closed`);
  return true;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) result.push(values.slice(offset, offset + size));
  return result;
}

async function archiveSpec(env: Env, spec: ArchiveSpec): Promise<number> {
  const database = spec.database === "ops" ? env.OPS_DB : env.DELIVERY_DB;
  if (!await guardedRetentionSchemaAvailable(database, spec)) return 0;
  const deleteBefore = new Date(Date.now() - spec.days * 24 * 60 * 60 * 1_000).toISOString();
  const result = await database.prepare(`SELECT * FROM ${spec.table} WHERE datetime(${spec.timestamp})<datetime(?) ORDER BY ${spec.timestamp} LIMIT 1000`)
    .bind(deleteBefore).all<Record<string, unknown>>();
  if (!result.results.length) return 0;
  const jsonl = `${result.results.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const source = new Blob([jsonl], { type: "application/x-ndjson" }).stream();
  const compressed = source.pipeThrough(new CompressionStream("gzip"));
  const day = new Date().toISOString().slice(0, 10);
  const key = `_ltds/audit-archive/${spec.database}/${spec.table}/${day}-${crypto.randomUUID()}.jsonl.gz`;
  await env.DATA_BUCKET.put(key, compressed, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { table: spec.table, rows: String(result.results.length), retentionDays: String(spec.days) },
  });
  if (spec.table === "integration_event_receipts") {
    // Event IDs are producer-local. Delete only the exact archived source/id
    // pairs; an old receipt must not remove another source's recent delivery.
    for (let offset = 0; offset < result.results.length; offset += 40) {
      const rows = result.results.slice(offset, offset + 40);
      await database.prepare(`DELETE FROM integration_event_receipts
        WHERE (projection_source_id,event_id) IN (VALUES ${rows.map(() => "(?,?)").join(",")})`)
        .bind(...rows.flatMap(row => [row.projection_source_id,row.event_id])).run();
    }
    return result.results.length;
  }
  const ids = result.results.map((row) => row[spec.id]);
  if (spec.retentionGate) {
    const deletions = chunks(ids, 40).map(batch => database.prepare(
      `DELETE FROM ${spec.table} WHERE ${spec.id} IN (${batch.map(() => "?").join(",")})`,
    ).bind(...batch));
    const results = await database.batch([
      database.prepare(`UPDATE ${spec.retentionGate} SET delete_enabled=1,delete_before=?
        WHERE singleton=1 AND delete_enabled=0 AND delete_before IS NULL`).bind(deleteBefore),
      ...deletions,
      database.prepare(`UPDATE ${spec.retentionGate} SET delete_enabled=0,delete_before=NULL
        WHERE singleton=1 AND delete_enabled=1 AND delete_before=?`).bind(deleteBefore),
    ]);
    return results.slice(1, -1).reduce((total, deleted) => total + (deleted.meta.changes ?? 0), 0);
  }
  await database.prepare(`DELETE FROM ${spec.table} WHERE ${spec.id} IN (${ids.map(() => "?").join(",")})`).bind(...ids).run();
  return ids.length;
}

export async function runRetention(env: Env): Promise<number> {
  let archived = 0;
  for (const spec of ARCHIVES) archived += await archiveSpec(env, spec);
  await env.OPS_DB.batch([
    env.OPS_DB.prepare("DELETE FROM idempotency_keys WHERE datetime(expires_at)<=datetime('now','-7 days')"),
    env.OPS_DB.prepare("DELETE FROM delivery_reconciliation_alerts WHERE datetime(created_at)<=datetime('now','-365 days')"),
  ]);
  await env.DELIVERY_DB.batch([
    env.DELIVERY_DB.prepare("DELETE FROM bulk_download_quota WHERE datetime(updated_at)<=datetime('now','-7 days')"),
    env.DELIVERY_DB.prepare("DELETE FROM bulk_download_jobs WHERE status IN ('expired','failed','cancelled') AND datetime(updated_at)<=datetime('now','-90 days')"),
    env.DELIVERY_DB.prepare("DELETE FROM public_rate_limits WHERE datetime(expires_at)<=datetime('now')"),
    env.DELIVERY_DB.prepare(`DELETE FROM file_request_contributors
      WHERE datetime(created_at)<=datetime('now','-90 days')
      AND NOT EXISTS (
        SELECT 1 FROM file_request_uploads u
        WHERE u.contributor_id=file_request_contributors.id
        AND u.status NOT IN ('accepted','expired')
      )`),
    env.DELIVERY_DB.prepare("UPDATE file_requests SET revoked_at=datetime('now'),revoked_reason='expired',updated_at=datetime('now') WHERE revoked_at IS NULL AND datetime(expires_at)<=datetime('now')"),
  ]);
  return archived;
}
