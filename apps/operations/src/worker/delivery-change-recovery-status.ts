import { authenticatedDeliveryChangeRecoveryEnabled, deliveryChangeProjectionReady } from "./delivery-change-projector";
import type { Env } from "./types";

const reasons = ["authority-suppressed", "staging-fence", "staging-schema", "staging-invalid", "staging-failed"] as const;
type Reason = typeof reasons[number];
type Counts = { pending: number; processing: number; completed: number; failed: number };
export interface DeliveryChangeRecoveryStatus {
  enabled: boolean;
  state: "ready" | "attention" | "disabled" | "unavailable";
  reason: "schema_unavailable" | "status_unavailable" | null;
  counts: Counts | null;
  failures: Array<{ reason: Reason; count: number }>;
  oldestPendingAt: string | null;
  lastFailureAt: string | null;
}

function date(value: unknown): string {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value)))
    throw new Error("recovery-status-invalid");
  return new Date(value).toISOString();
}

/** Read-only, global-administrator aggregate. No receipt keys, source paths,
 * identities, mail addresses, or raw storage errors cross this boundary.
 * Pausing does not conceal previously accepted work or terminal failures. */
export async function deliveryChangeRecoveryStatus(env: Env): Promise<DeliveryChangeRecoveryStatus> {
  const enabled = authenticatedDeliveryChangeRecoveryEnabled(env);
  const unavailable = (reason: "schema_unavailable" | "status_unavailable"): DeliveryChangeRecoveryStatus => ({
    enabled, state: "unavailable", reason, counts: null, failures: [], oldestPendingAt: null, lastFailureAt: null,
  });
  try {
    if (!(await deliveryChangeProjectionReady(env))) return unavailable("schema_unavailable");
    const groups = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT status,last_reason_code,
        count(*) count,min(created_at) oldest_created_at,max(updated_at) latest_updated_at
      FROM portal_authenticated_delivery_change_projection_jobs
      GROUP BY status,last_reason_code LIMIT 25`).all<{
        status: string; last_reason_code: string | null; count: number;
        oldest_created_at: string; latest_updated_at: string;
      }>();
    // Four states, with a nullable reason or one of five fixed codes each.
    if (groups.results.length > 24) return unavailable("status_unavailable");
    const counts: Counts = { pending: 0, processing: 0, completed: 0, failed: 0 };
    const failures = new Map<Reason, number>();
    let oldestPendingAt: string | null = null, lastFailureAt: string | null = null;
    for (const row of groups.results) {
      if (!Object.hasOwn(counts, row.status) || !Number.isSafeInteger(row.count) || row.count < 1
        || row.last_reason_code !== null && !reasons.includes(row.last_reason_code as Reason))
        return unavailable("status_unavailable");
      const state = row.status as keyof Counts;
      counts[state] += row.count;
      if (!Number.isSafeInteger(counts[state])) return unavailable("status_unavailable");
      if (state === "pending" || state === "processing") {
        const candidate = date(row.oldest_created_at);
        if (!oldestPendingAt || candidate < oldestPendingAt) oldestPendingAt = candidate;
      }
      if (state === "failed") {
        const reason = (row.last_reason_code ?? "staging-failed") as Reason;
        failures.set(reason, (failures.get(reason) ?? 0) + row.count);
        const candidate = date(row.latest_updated_at);
        if (!lastFailureAt || candidate > lastFailureAt) lastFailureAt = candidate;
      }
    }
    return { enabled, state: !enabled ? "disabled" : counts.failed > 0 ? "attention" : "ready", reason: null,
      counts, failures: reasons.filter(reason => failures.has(reason)).map(reason => ({ reason, count: failures.get(reason)! })),
      oldestPendingAt, lastFailureAt };
  } catch {
    // Unavailable is not an empty, healthy queue. Do not surface the D1 error.
    return unavailable("status_unavailable");
  }
}
