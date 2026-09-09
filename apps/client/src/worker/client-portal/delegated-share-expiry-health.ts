import type { ClientDelegatedShareExpiryResult } from "./delegated-shares";
import { reconcileExpiredClientDelegatedShares } from "./delegated-shares";

const HEALTH_ID = "client-delegated-share-expiry";

type HealthDatabase = Pick<D1Database, "prepare">;

function safeFailureCode(error: unknown): "schema-unavailable" | "reconcile-failed" {
  // The database error text can include deployment and provider detail. Keep
  // the durable diagnostic finite and safe to expose to operators.
  const message = error instanceof Error ? error.message : "";
  return /no such table: client_delegated_share_expiry_health/i.test(message)
    ? "schema-unavailable"
    : "reconcile-failed";
}

async function updateHealth(database: HealthDatabase, sql: string, values: unknown[], requireChange = false): Promise<boolean> {
  try {
    const result = await database.prepare(sql).bind(...values).run();
    return !requireChange || result.meta.changes === 1;
  } catch (error) {
    console.error(JSON.stringify({
      event: "client-delegated-share.expiry-health-unavailable",
      code: safeFailureCode(error),
    }));
    return false;
  }
}

async function startHealthRun(database: HealthDatabase, nowIso: string, runId: string): Promise<boolean> {
  const inserted = await updateHealth(database,
    "INSERT OR IGNORE INTO client_delegated_share_expiry_health(id) VALUES(?)", [HEALTH_ID]);
  if (!inserted) return false;
  return updateHealth(database, `UPDATE client_delegated_share_expiry_health
    SET last_run_at=?,active_run_id=?,updated_at=datetime(?)
    WHERE id=? AND (last_run_at IS NULL OR julianday(last_run_at)<=julianday(?))`,
  [nowIso, runId, nowIso, HEALTH_ID, nowIso], true);
}

async function finishHealthRun(
  database: HealthDatabase,
  nowIso: string,
  runId: string,
  result: ClientDelegatedShareExpiryResult | null,
  errorCode: "schema-unavailable" | "reconcile-failed" | null,
): Promise<void> {
  if (result) {
    await updateHealth(database, `UPDATE client_delegated_share_expiry_health SET
      last_success_at=?,last_error_code=NULL,last_shares_expired=?,last_delegations_expired=?,
      shares_at_limit=?,delegations_at_limit=?,active_run_id=NULL,updated_at=datetime(?)
      WHERE id=? AND active_run_id=?`, [
      nowIso, result.sharesExpired, result.delegationsExpired,
      Number(result.sharesAtLimit), Number(result.delegationsAtLimit), nowIso, HEALTH_ID, runId,
    ], true);
    return;
  }
  await updateHealth(database, `UPDATE client_delegated_share_expiry_health SET
    last_error_code=?,active_run_id=NULL,updated_at=datetime(?) WHERE id=? AND active_run_id=?`,
  [errorCode, nowIso, HEALTH_ID, runId], true);
}

/**
 * Records bounded, component-specific scheduler health without changing the
 * reconciler's authority. The active-run token fences overlapping cron runs:
 * an older completion cannot overwrite a newer attempt's outcome.
 */
export async function runClientDelegatedShareExpiryReconciliation(
  env: Pick<{ DELIVERY_DB: D1Database }, "DELIVERY_DB">,
  options: {
    /** Injectable for deterministic tests; sampled again when the run completes. */
    now?: () => number;
    reconcile?: (env: Pick<{ DELIVERY_DB: D1Database }, "DELIVERY_DB">) => Promise<ClientDelegatedShareExpiryResult>;
  } = {},
): Promise<ClientDelegatedShareExpiryResult> {
  const nowIso = new Date(options.now?.() ?? Date.now()).toISOString();
  const runId = crypto.randomUUID();
  const healthAvailable = await startHealthRun(env.DELIVERY_DB, nowIso, runId);
  try {
    const result = await (options.reconcile ?? reconcileExpiredClientDelegatedShares)(env);
    if (healthAvailable) await finishHealthRun(
      env.DELIVERY_DB, new Date(options.now?.() ?? Date.now()).toISOString(), runId, result, null,
    );
    if (result.sharesExpired || result.delegationsExpired || result.sharesAtLimit || result.delegationsAtLimit) {
      console.log(JSON.stringify({ event: "client-delegated-share.expiry-reconciled", ...result }));
    }
    return result;
  } catch (error) {
    if (healthAvailable) await finishHealthRun(
      env.DELIVERY_DB, new Date(options.now?.() ?? Date.now()).toISOString(), runId, null, safeFailureCode(error),
    );
    console.error(JSON.stringify({ event: "client-delegated-share.expiry-reconciliation-failed", code: safeFailureCode(error) }));
    throw error;
  }
}
