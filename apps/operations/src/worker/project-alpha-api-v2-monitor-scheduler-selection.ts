import { parseProjectAlphaApiV2Connections } from "./project-alpha-api-v2-config";
import { snapshotProjectAlphaApiV2MonitorLifecycleDesired } from "./project-alpha-api-v2-monitor-lifecycle";

export class ProjectAlphaApiV2MonitorSchedulerSelectionError extends Error {
  constructor() { super("project_alpha_api_v2_monitor_selection_unavailable");
    this.name = "ProjectAlphaApiV2MonitorSchedulerSelectionError"; }
}

export type ProjectAlphaApiV2MonitorSchedulerSelection = Readonly<
  | { status: "disabled" }
  | { status: "selected"; revision: number }
>;

type Row = { lifecycle_id: unknown; revision: unknown; enabled: unknown;
  identities_json: unknown; operator_command_id: unknown; audited: unknown };

/** Deployment kill-switch first; then select only a fully audited native head.
 * The original operator's short Access session is not ongoing scheduler authority. */
export async function selectProjectAlphaApiV2MonitorSchedulerRevision(database: D1Database,
  raw: Readonly<{ enabled: string | undefined; connections: string | undefined }>,
): Promise<ProjectAlphaApiV2MonitorSchedulerSelection> {
  const enabled = raw.enabled, connections = raw.connections;
  if (enabled !== "true") return Object.freeze({ status: "disabled" });
  try {
    const session = database.withSession("first-primary");
    const row = await session.prepare(`SELECT head.lifecycle_id,head.revision,head.enabled,
        head.identities_json,head.operator_command_id,
        EXISTS(SELECT 1 FROM project_alpha_api_v2_monitor_operator_audit audit
          JOIN project_alpha_api_v2_monitor_lifecycle_history history
            ON history.lifecycle_id=audit.lifecycle_id
              AND history.revision=audit.lifecycle_revision
          WHERE audit.lifecycle_id=head.lifecycle_id AND audit.lifecycle_revision=head.revision
            AND audit.command_id=head.operator_command_id
            AND audit.enabled=head.enabled AND audit.identities_json=head.identities_json
            AND history.enabled=head.enabled AND history.identities_json=head.identities_json)
          AS audited
      FROM project_alpha_api_v2_monitor_lifecycle_heads head WHERE lifecycle_id=1`).first<Row>();
    if (!row || row.lifecycle_id !== 1 || typeof row.revision !== "number"
      || !Number.isSafeInteger(row.revision) || row.revision < 1
      || (row.enabled !== 0 && row.enabled !== 1)
      || typeof row.identities_json !== "string" || typeof row.operator_command_id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.operator_command_id)
      || row.audited !== 1) throw Error();
    const identities: unknown = JSON.parse(row.identities_json);
    const stored = snapshotProjectAlphaApiV2MonitorLifecycleDesired({ expectedRevision: row.revision,
      enabled: row.enabled === 1, identities });
    if (stored.identitiesJson !== row.identities_json) throw Error();
    if (row.enabled === 0) return Object.freeze({ status: "disabled" });
    // Per-instance deployment disables are not lifecycle identities. Keeping
    // them in the active head would make the health cycle attempt a durable
    // `disabled` observation that its own active-pin fence correctly denies.
    const configured = parseProjectAlphaApiV2Connections(connections).filter(connection => connection.enabled).map(connection => ({
      sourceId: connection.sourceId, applicationId: connection.applicationId,
      baseUrl: connection.baseUrl, expectedSourceInstanceId: connection.expectedSourceInstanceId,
      expectedHistoryEpoch: connection.expectedHistoryEpoch,
    }));
    const canonical = snapshotProjectAlphaApiV2MonitorLifecycleDesired({ expectedRevision: row.revision,
      enabled: true, identities: configured });
    if (canonical.identitiesJson !== stored.identitiesJson) throw Error();
    return Object.freeze({ status: "selected", revision: row.revision });
  } catch { throw new ProjectAlphaApiV2MonitorSchedulerSelectionError(); }
}
