import { parseProjectAlphaApiV2Connections } from "./project-alpha-api-v2-config";
import {
  reconcileProjectAlphaDirectorySource,
  type ProjectAlphaDirectoryReconciliationOptions,
  type ProjectAlphaDirectoryReconciliationResult,
} from "./project-alpha-directory-reconciliation";

const DEFAULT_RUNTIME_MS = 25_000;
const DEFAULT_MAX_PAGES = 4;
const DEFAULT_MAX_ITEMS = 400;
const COMPLETE_INTERVAL_MS = 15 * 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;
const LEASE_GRACE_MS = 5_000;
const MAX_LEASE_RENEW_INTERVAL_MS = 5_000;

export type NativeDirectoryReconciliationSchedulerEnvironment = Readonly<{
  OPS_DB: D1Database;
  PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED?: string;
  PROJECT_ALPHA_API_V2_CONNECTIONS?: string;
}>;

export type NativeDirectoryReconciliationSchedulerResult = Readonly<{
  status: "disabled" | "unavailable" | "contended" | "idle" | "ran";
  attempted: number;
  complete: number;
  uncertain: number;
  exhausted: boolean;
}>;

export type NativeDirectoryReconciliationSchedulerOptions = Readonly<{
  now?: () => number;
  maxRuntimeMs?: number;
  maxPages?: number;
  maxItems?: number;
  reconcile?: (env: NativeDirectoryReconciliationSchedulerEnvironment, sourceId: string,
    options: ProjectAlphaDirectoryReconciliationOptions) => Promise<ProjectAlphaDirectoryReconciliationResult>;
}>;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number | null {
  const resolved = value ?? fallback;
  return Number.isSafeInteger(resolved) && resolved >= minimum && resolved <= maximum ? resolved : null;
}
function timestamp(value: number): string { return new Date(value).toISOString(); }
function retryDelay(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.min(5, Math.max(0, failures - 1))));
}

const empty = (status: NativeDirectoryReconciliationSchedulerResult["status"], exhausted = false): NativeDirectoryReconciliationSchedulerResult =>
  Object.freeze({ status, attempted: 0, complete: 0, uncertain: 0, exhausted });

/** Default-off, one-source bounded scheduler for the read-only reconciliation core. */
export async function runNativeDirectoryReconciliationScheduler(
  env: NativeDirectoryReconciliationSchedulerEnvironment,
  options: NativeDirectoryReconciliationSchedulerOptions = {},
): Promise<NativeDirectoryReconciliationSchedulerResult> {
  if (env.PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED !== "true") return empty("disabled");
  const maxRuntimeMs = boundedInteger(options.maxRuntimeMs, DEFAULT_RUNTIME_MS, 10, 120_000);
  const maxPages = boundedInteger(options.maxPages, DEFAULT_MAX_PAGES, 1, 32);
  const maxItems = boundedInteger(options.maxItems, DEFAULT_MAX_ITEMS, 1, 5_000);
  if (!maxRuntimeMs || !maxPages || !maxItems) return empty("unavailable");

  let sourceIds: string[];
  try {
    sourceIds = parseProjectAlphaApiV2Connections(env.PROJECT_ALPHA_API_V2_CONNECTIONS)
      .filter(connection => connection.enabled).map(connection => connection.sourceId).sort();
  } catch { return empty("unavailable"); }
  if (sourceIds.length === 0) return empty("idle");

  const now = options.now ?? Date.now, started = now(), leaseToken = crypto.randomUUID();
  const leaseDurationMs = maxRuntimeMs + LEASE_GRACE_MS;
  const lease = await env.OPS_DB.prepare(`UPDATE project_alpha_directory_reconciliation_scheduler
    SET lease_token=?,lease_expires_at=?,updated_at=? WHERE scheduler_id=1
      AND (lease_token IS NULL OR lease_expires_at<=?)`).bind(
      leaseToken, started + leaseDurationMs, timestamp(started), started).run();
  if (Number(lease.meta.changes ?? 0) !== 1) return empty("contended");

  let stopRenewal = false, wakeRenewal: (() => void) | null = null;
  const renewalIntervalMs = Math.max(5, Math.min(MAX_LEASE_RENEW_INTERVAL_MS, Math.floor(maxRuntimeMs / 3)));
  const waitForRenewal = (): Promise<void> => new Promise(resolve => {
    const timer = setTimeout(() => { wakeRenewal = null; resolve(); }, renewalIntervalMs);
    wakeRenewal = () => { clearTimeout(timer); wakeRenewal = null; resolve(); };
  });
  const renewal = (async (): Promise<void> => {
    while (!stopRenewal) {
      await waitForRenewal();
      if (stopRenewal) return;
      const renewalAt = now();
      try {
        const renewed = await env.OPS_DB.prepare(`UPDATE project_alpha_directory_reconciliation_scheduler SET
          lease_expires_at=?,updated_at=? WHERE scheduler_id=1 AND lease_token=? AND lease_expires_at>?`)
          .bind(renewalAt + leaseDurationMs, timestamp(renewalAt), leaseToken, renewalAt).run();
        if (Number(renewed.meta.changes ?? 0) !== 1) return;
      } catch {
        // Retry while the currently fenced lease may still be live. If D1 is
        // unavailable, no successor can acquire the same durable lease either.
      }
    }
  })();

  try {
    for (const sourceId of sourceIds) await env.OPS_DB.prepare(`INSERT INTO
      project_alpha_directory_reconciliation_schedule_sources(source_id,updated_at) VALUES(?,?)
      ON CONFLICT(source_id) DO NOTHING`).bind(sourceId, timestamp(started)).run();
    const state = await env.OPS_DB.prepare(`SELECT cursor_source_id cursorSourceId FROM
      project_alpha_directory_reconciliation_scheduler WHERE scheduler_id=1 AND lease_token=?`)
      .bind(leaseToken).first<{ cursorSourceId: string | null }>();
    if (!state) return empty("contended");
    const ordered = state.cursorSourceId === null ? sourceIds : [
      ...sourceIds.filter(sourceId => sourceId > state.cursorSourceId!),
      ...sourceIds.filter(sourceId => sourceId <= state.cursorSourceId!),
    ];
    let selected: string | null = null;
    for (const sourceId of ordered) {
      const due = await env.OPS_DB.prepare(`SELECT 1 due FROM project_alpha_directory_reconciliation_schedule_sources
        WHERE source_id=? AND next_attempt_at<=?`).bind(sourceId, started).first();
      if (due) { selected = sourceId; break; }
    }
    if (!selected) return empty("idle");
    const remaining = maxRuntimeMs - (now() - started);
    if (remaining < 10) return empty("idle", true);
    const reconcile = options.reconcile ?? reconcileProjectAlphaDirectorySource;
    let result: ProjectAlphaDirectoryReconciliationResult;
    try {
      result = await reconcile(env, selected, { maxPages, maxItems, timeBudgetMs: remaining });
    } catch {
      const current = await env.OPS_DB.prepare(`SELECT consecutive_uncertain failures FROM
        project_alpha_directory_reconciliation_schedule_sources WHERE source_id=?`).bind(selected)
        .first<{ failures: number }>();
      const failures = Number(current?.failures ?? 0) + 1;
      const retained = await env.OPS_DB.prepare(`UPDATE project_alpha_directory_reconciliation_schedule_sources
        SET next_attempt_at=?,consecutive_uncertain=?,updated_at=? WHERE source_id=?
          AND EXISTS(SELECT 1 FROM project_alpha_directory_reconciliation_scheduler scheduler
            WHERE scheduler.scheduler_id=1 AND scheduler.lease_token=?)`)
        .bind(started + retryDelay(failures), failures, timestamp(now()), selected, leaseToken).run();
      if (Number(retained.meta.changes ?? 0) !== 1)
        return Object.freeze({ status: "contended", attempted: 1, complete: 0, uncertain: 1, exhausted: true });
      const advanced = await env.OPS_DB.prepare(`UPDATE project_alpha_directory_reconciliation_scheduler SET
        cursor_source_id=?,updated_at=? WHERE scheduler_id=1 AND lease_token=?`)
        .bind(selected, timestamp(now()), leaseToken).run();
      if (Number(advanced.meta.changes ?? 0) !== 1)
        return Object.freeze({ status: "contended", attempted: 1, complete: 0, uncertain: 1, exhausted: true });
      return Object.freeze({ status: "ran", attempted: 1, complete: 0, uncertain: 1, exhausted: now() - started >= maxRuntimeMs });
    }
    let persisted: D1Result;
    if (result.status === "complete") {
      persisted = await env.OPS_DB.prepare(`UPDATE project_alpha_directory_reconciliation_schedule_sources SET
        next_attempt_at=?,consecutive_uncertain=0,last_status='complete',last_run_id=?,last_attempt_at=?,updated_at=?
        WHERE source_id=? AND EXISTS(SELECT 1 FROM project_alpha_directory_reconciliation_scheduler scheduler
          WHERE scheduler.scheduler_id=1 AND scheduler.lease_token=?)`).bind(
          started + COMPLETE_INTERVAL_MS, result.runId, started, timestamp(now()), selected, leaseToken).run();
    } else {
      const current = await env.OPS_DB.prepare(`SELECT consecutive_uncertain failures FROM
        project_alpha_directory_reconciliation_schedule_sources WHERE source_id=?`).bind(selected)
        .first<{ failures: number }>();
      const failures = Number(current?.failures ?? 0) + 1;
      persisted = await env.OPS_DB.prepare(`UPDATE project_alpha_directory_reconciliation_schedule_sources SET
        next_attempt_at=?,consecutive_uncertain=?,last_status='uncertain',last_run_id=?,last_attempt_at=?,updated_at=?
        WHERE source_id=? AND EXISTS(SELECT 1 FROM project_alpha_directory_reconciliation_scheduler scheduler
          WHERE scheduler.scheduler_id=1 AND scheduler.lease_token=?)`).bind(
          started + retryDelay(failures), failures, result.runId, started, timestamp(now()), selected, leaseToken).run();
    }
    if (Number(persisted.meta.changes ?? 0) !== 1)
      return Object.freeze({ status: "contended", attempted: 1, complete: 0, uncertain: 1, exhausted: true });
    const advanced = await env.OPS_DB.prepare(`UPDATE project_alpha_directory_reconciliation_scheduler SET cursor_source_id=?,
      updated_at=? WHERE scheduler_id=1 AND lease_token=?`).bind(selected, timestamp(now()), leaseToken).run();
    if (Number(advanced.meta.changes ?? 0) !== 1)
      return Object.freeze({ status: "contended", attempted: 1, complete: 0, uncertain: 1, exhausted: true });
    return Object.freeze({ status: "ran", attempted: 1, complete: result.status === "complete" ? 1 : 0,
      uncertain: result.status === "uncertain" ? 1 : 0, exhausted: now() - started >= maxRuntimeMs });
  } finally {
    stopRenewal = true;
    const wake = wakeRenewal as (() => void) | null;
    if (wake) wake();
    await renewal;
    await env.OPS_DB.prepare(`UPDATE project_alpha_directory_reconciliation_scheduler SET lease_token=NULL,
      lease_expires_at=NULL,updated_at=? WHERE scheduler_id=1 AND lease_token=?`)
      .bind(timestamp(now()), leaseToken).run();
  }
}
