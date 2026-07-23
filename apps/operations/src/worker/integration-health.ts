export const PROJECT_ALPHA_SNAPSHOT_FRESHNESS_MS = 26 * 60 * 60 * 1000;

export type IntegrationHealthRow = {
  integration?: unknown;
  status?: unknown;
  last_success_at?: unknown;
};

/**
 * Project Alpha sends incremental changes through webhooks and performs one
 * full reconciliation each day. The dashboard warning therefore tracks a
 * missed daily reconciliation, not the age of the most recent webhook.
 */
export function projectAlphaHealthIsStale(row: IntegrationHealthRow, now = Date.now()): boolean {
  if (String(row.integration ?? "").toLowerCase().replaceAll("_", "-") !== "project-alpha") return false;
  if (row.status !== "healthy" || !row.last_success_at) return true;

  const timestamp = Date.parse(`${String(row.last_success_at).replace(" ", "T")}Z`);
  return !Number.isFinite(timestamp) || now - timestamp > PROJECT_ALPHA_SNAPSHOT_FRESHNESS_MS;
}
