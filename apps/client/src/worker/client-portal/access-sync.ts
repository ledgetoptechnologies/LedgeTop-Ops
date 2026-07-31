import type { Env } from "../types";

/**
 * Client Access provisioning is intentionally an internal-worker seam. The
 * public delivery/client Worker records desired state only; it never receives
 * a Cloudflare management token and never calls Cloudflare's control plane.
 */
export const clientAccessSyncSecretManifest = ["CLIENT_ACCESS_GROUP_API_TOKEN"] as const;

export interface ClientAccessSyncCommand {
  id: string;
  accountId: string;
  email: string;
  action: "provision" | "revoke";
  attempt: number;
  idempotencyKey: string;
}

export interface ClientAccessSyncResult {
  id: string;
  outcome: "completed" | "retry" | "failed";
  /** A stable, non-sensitive category only; never provider response text. */
  errorCode?: "configuration" | "rate_limited" | "temporary" | "permanent";
}

export interface ClientAccessSyncOutbox {
  claim(env: Env, limit: number, now?: Date): Promise<ClientAccessSyncCommand[]>;
  complete(env: Env, commands: ClientAccessSyncCommand[], results: ClientAccessSyncResult[], now?: Date): Promise<void>;
}

export interface ClientAccessSyncTransport {
  /**
   * Implement this only in a dedicated internal worker with a narrowly scoped
   * Access Groups token. Commands are batched and each carries a durable
   * idempotency key; the transport must never be mounted on public routes.
   */
  dispatch(commands: ClientAccessSyncCommand[]): Promise<ClientAccessSyncResult[]>;
}

function retryDelaySeconds(attempt: number): number {
  return Math.min(60 * 60, 30 * 2 ** Math.min(Math.max(attempt, 0), 7));
}

export const d1ClientAccessSyncOutbox: ClientAccessSyncOutbox = {
  async claim(env, limit, now = new Date()): Promise<ClientAccessSyncCommand[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    if (!Number.isFinite(boundedLimit)) return [];
    const nowIso = now.toISOString();
    const db = env.DELIVERY_DB;
    const candidates = await db.prepare(`
      SELECT id,account_id,email,action,attempts
      FROM client_access_sync_outbox
      WHERE (status='pending' AND datetime(next_attempt_at)<=datetime(?))
         OR (status='processing' AND lease_expires_at IS NOT NULL AND datetime(lease_expires_at)<=datetime(?))
      ORDER BY created_at,id LIMIT ?`).bind(nowIso, nowIso, boundedLimit).all<{
        id: string; account_id: string; email: string; action: "provision" | "revoke"; attempts: number;
      }>();
    const claimed: ClientAccessSyncCommand[] = [];
    for (const row of candidates.results) {
      const leaseExpiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
      const updated = await db.prepare(`
        UPDATE client_access_sync_outbox
        SET status='processing',attempts=attempts+1,lease_expires_at=?,updated_at=datetime('now')
        WHERE id=? AND (
          (status='pending' AND datetime(next_attempt_at)<=datetime(?)) OR
          (status='processing' AND lease_expires_at IS NOT NULL AND datetime(lease_expires_at)<=datetime(?))
        )`).bind(leaseExpiresAt, row.id, nowIso, nowIso).run();
      if (updated.meta.changes !== 1) continue;
      claimed.push({ id: row.id, accountId: row.account_id, email: row.email, action: row.action, attempt: row.attempts + 1, idempotencyKey: `client-access-v1:${row.id}` });
    }
    return claimed;
  },

  async complete(env, commands, results, now = new Date()): Promise<void> {
    const resultById = new Map(results.map(result => [result.id, result]));
    const db = env.DELIVERY_DB;
    for (const command of commands) {
      const result = resultById.get(command.id) ?? { id: command.id, outcome: "retry" as const, errorCode: "temporary" as const };
      if (result.outcome === "completed") {
        await db.batch([
          db.prepare("UPDATE client_access_sync_outbox SET status='completed',lease_expires_at=NULL,last_error_code=NULL,updated_at=datetime('now') WHERE id=? AND status='processing'").bind(command.id),
          db.prepare("INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('system','client-access-sync','client.access_sync.completed','client_access_sync_outbox',?,?)")
            .bind(command.id, JSON.stringify({ action: command.action, accountId: command.accountId })),
        ]);
        continue;
      }
      const retry = result.outcome === "retry";
      const delay = retryDelaySeconds(command.attempt);
      await db.batch([
        db.prepare("UPDATE client_access_sync_outbox SET status=?,lease_expires_at=NULL,next_attempt_at=?,last_error_code=?,updated_at=datetime('now') WHERE id=? AND status='processing'")
          .bind(retry ? "pending" : "failed", retry ? new Date(now.getTime() + delay * 1000).toISOString() : now.toISOString(), result.errorCode ?? "temporary", command.id),
        db.prepare("INSERT INTO audit_log (actor_type,actor_id,action,entity_type,entity_id,details_json) VALUES ('system','client-access-sync',?,'client_access_sync_outbox',?,?)")
          .bind(retry ? "client.access_sync.retry" : "client.access_sync.failed", command.id, JSON.stringify({ action: command.action, accountId: command.accountId, errorCode: result.errorCode ?? "temporary" })),
      ]);
    }
  },
};

/** A worker-safe orchestration helper used by the future internal consumer. */
export async function processClientAccessSyncBatch(
  env: Env,
  transport: ClientAccessSyncTransport,
  outbox: ClientAccessSyncOutbox = d1ClientAccessSyncOutbox,
  limit = 50,
): Promise<number> {
  const commands = await outbox.claim(env, limit);
  if (!commands.length) return 0;
  let results: ClientAccessSyncResult[];
  try {
    results = await transport.dispatch(commands);
  } catch {
    results = commands.map(command => ({ id: command.id, outcome: "retry", errorCode: "temporary" }));
  }
  await outbox.complete(env, commands, results);
  return commands.length;
}
