import { probeProjectAlphaDirectoryApiV2, type ProjectAlphaApiV2Probe } from "./project-alpha-api-v2";
import { parseProjectAlphaApiV2Connections, type ProjectAlphaApiV2ConfiguredConnection,
  type ProjectAlphaApiV2ConnectionIdentity } from "./project-alpha-api-v2-config";
import { ProjectAlphaApiV2IncidentStoreConflict, readProjectAlphaApiV2Incident,
  recordProjectAlphaApiV2IncidentObservation } from "./project-alpha-api-v2-incident-store";
import { isProjectAlphaApiV2MonitorIdentityActive } from "./project-alpha-api-v2-monitor-lifecycle";

export type ProjectAlphaApiV2HealthCycleResult = Readonly<{
  status: "disabled" | "checked";
  verified: number;
  unhealthy: number;
  storageErrors: number;
  contended: number;
}>;

function identity(connection: ProjectAlphaApiV2ConfiguredConnection): ProjectAlphaApiV2ConnectionIdentity {
  if (!connection.expectedHistoryEpoch) throw Error("project_alpha_api_v2_health_configuration_denied");
  return Object.freeze({ sourceId: connection.sourceId, applicationId: connection.applicationId,
    baseUrl: connection.baseUrl, expectedSourceInstanceId: connection.expectedSourceInstanceId,
    expectedHistoryEpoch: connection.expectedHistoryEpoch });
}

/**
 * Deployment-only composition, not a registered cron or a write grant. Probes
 * run independently of queued commands, checking the two native directory API
 * routes. This is not a substitute for project/financial workflow acceptance.
 * At most two network probes run concurrently; config bounds the list to 16.
 */
export async function runProjectAlphaApiV2HealthCycle(database: D1Database,
  input: Readonly<{ enabled: string | undefined; connections: string | undefined; expectedMonitorRevision: number }>,
  send: typeof fetch = fetch, clock: () => number = Date.now,
): Promise<ProjectAlphaApiV2HealthCycleResult> {
  const counts = { verified: 0, unhealthy: 0, storageErrors: 0, contended: 0 };
  const expectedMonitorRevision = input.expectedMonitorRevision;
  if (!Number.isSafeInteger(expectedMonitorRevision) || expectedMonitorRevision < 1)
    throw Error("project_alpha_api_v2_health_configuration_denied");
  if (input.enabled !== "true") return Object.freeze({ status: "disabled", ...counts });
  // Detach and validate all deployment configuration before any asynchronous work.
  let configured: readonly ProjectAlphaApiV2ConfiguredConnection[];
  try { configured = parseProjectAlphaApiV2Connections(input.connections).filter(connection => connection.enabled); }
  catch { throw Error("project_alpha_api_v2_health_configuration_denied"); }

  async function check(connection: ProjectAlphaApiV2ConfiguredConnection): Promise<void> {
    try {
      const selected = identity(connection);
      if (!await isProjectAlphaApiV2MonitorIdentityActive(database, expectedMonitorRevision, selected)) return;
      let current = await readProjectAlphaApiV2Incident(database, selected);
      const clockStartedAt = clock();
      if (!Number.isSafeInteger(clockStartedAt) || clockStartedAt < 0) throw Error("invalid_clock");
      let startedAt = clockStartedAt;
      const previousStartedAt = current.state?.lastProbeStartedAt;
      if (previousStartedAt !== undefined && startedAt <= previousStartedAt) {
        if (previousStartedAt === Number.MAX_SAFE_INTEGER) throw Error("invalid_clock");
        startedAt = previousStartedAt + 1;
      }
      const probe: ProjectAlphaApiV2Probe = await probeProjectAlphaDirectoryApiV2(connection, send);
      if (probe.status === "verified") counts.verified++; else counts.unhealthy++;
      const observation = Object.freeze({ kind: "probe" as const, startedAt, probe });
      // One bounded retry after CAS contention. Reuse the original probe start,
      // never restamp an old response as fresh when another observation wins.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (!await isProjectAlphaApiV2MonitorIdentityActive(database, expectedMonitorRevision, selected)) return;
          await recordProjectAlphaApiV2IncidentObservation(database,
            { identity: selected, expectedRevision: current.revision, monitorRevision: expectedMonitorRevision, observation });
          return;
        } catch (error) {
          if (!(error instanceof ProjectAlphaApiV2IncidentStoreConflict)) throw error;
          if (!await isProjectAlphaApiV2MonitorIdentityActive(database, expectedMonitorRevision, selected)) return;
          if (attempt === 1) { counts.contended++; return; }
          current = await readProjectAlphaApiV2Incident(database, selected);
        }
      }
    } catch {
      // Provider and database messages may contain credentials or SQL. Only
      // aggregate safe outcomes cross this scheduler boundary.
      counts.storageErrors++;
    }
  }

  for (let index = 0; index < configured.length; index += 2) {
    await Promise.all(configured.slice(index, index + 2).map(check));
  }
  return Object.freeze({ status: "checked", ...counts });
}
