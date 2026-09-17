import { parseProjectAlphaApiV2Connections } from "./project-alpha-api-v2-config";
import { runProjectAlphaApiV2HealthCycle, type ProjectAlphaApiV2HealthCycleResult } from "./project-alpha-api-v2-health-cycle";
import { dispatchProjectAlphaApiV2IncidentAlert, projectAlphaApiV2IncidentAlertDispatchDependencies,
  type ProjectAlphaApiV2AlertDispatchResult } from "./project-alpha-api-v2-incident-alert-dispatch";
import type { Env } from "./types";

export type ProjectAlphaApiV2MonitorCycleInput = Readonly<{
  enabled: string | undefined;
  connections: string | undefined;
  expectedMonitorRevision: number;
  recipient: string | undefined;
}>;

/** Scheduler composition, not a registered trigger. The selected audited head
 * revision is pinned for this invocation; no lifecycle authority is created. */
export async function runProjectAlphaApiV2MonitorCycle(database: D1Database, mailerEnv: Env,
  input: ProjectAlphaApiV2MonitorCycleInput, send: typeof fetch = fetch, clock: () => number = Date.now,
): Promise<Readonly<{ health: ProjectAlphaApiV2HealthCycleResult;
  alerts: Readonly<Partial<Record<ProjectAlphaApiV2AlertDispatchResult["status"], number>>> }>> {
  const selected = Object.freeze({ enabled: input.enabled, connections: input.connections,
    expectedMonitorRevision: input.expectedMonitorRevision, recipient: input.recipient });
  if (selected.enabled !== "true") return Object.freeze({ health: Object.freeze({ status: "disabled",
    verified: 0, unhealthy: 0, storageErrors: 0, contended: 0 }), alerts: Object.freeze({}) });
  // Validate the bounded deployment list before any network or storage work.
  const connections = parseProjectAlphaApiV2Connections(selected.connections).filter(connection => connection.enabled);
  const health = await runProjectAlphaApiV2HealthCycle(database, selected, send, clock);
  const dependencies = projectAlphaApiV2IncidentAlertDispatchDependencies(database, mailerEnv);
  const alerts: Partial<Record<ProjectAlphaApiV2AlertDispatchResult["status"], number>> = {};
  for (let index = 0; index < connections.length; index += 2) {
    const results = await Promise.all(connections.slice(index, index + 2).map(async connection => {
      try {
        const result = await dispatchProjectAlphaApiV2IncidentAlert({
          identity: { sourceId: connection.sourceId, applicationId: connection.applicationId,
            baseUrl: connection.baseUrl, expectedSourceInstanceId: connection.expectedSourceInstanceId,
            expectedHistoryEpoch: connection.expectedHistoryEpoch! },
          monitorRevision: selected.expectedMonitorRevision, recipient: selected.recipient,
          currentConfiguration: () => selected, clock,
        }, dependencies);
        return result.status;
      } catch { return "storage_error" as const; }
    }));
    for (const status of results) alerts[status] = (alerts[status] ?? 0) + 1;
  }
  // Only counts cross the scheduler boundary, never deployment credentials,
  // recipient addresses, mail bodies, database errors, or PA response bodies.
  return Object.freeze({ health, alerts: Object.freeze(alerts) });
}
