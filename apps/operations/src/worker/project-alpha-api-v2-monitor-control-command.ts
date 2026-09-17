import {
  parseProjectAlphaApiV2Connections,
  type ProjectAlphaApiV2ConfiguredConnection,
} from "./project-alpha-api-v2-config";
import {
  snapshotProjectAlphaApiV2MonitorLifecycleDesired,
  type ProjectAlphaApiV2MonitorLifecycleDesired,
} from "./project-alpha-api-v2-monitor-lifecycle";

const DENIED = "project_alpha_api_v2_monitor_control_command_invalid";
const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;

export type ProjectAlphaApiV2MonitorControlCommand = ProjectAlphaApiV2MonitorLifecycleDesired;

export class ProjectAlphaApiV2MonitorControlCommandError extends Error {
  constructor() {
    super(DENIED);
    this.name = "ProjectAlphaApiV2MonitorControlCommandError";
  }
}

function invalid(): never { throw new ProjectAlphaApiV2MonitorControlCommandError(); }

/** Copy only data properties from a plain command object; accessors and proxy
 * failures are rejected without invoking user code or exposing its error. */
function snapshotRecord(raw: unknown): Record<string, unknown> | null {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(raw);
    if (keys.some(key => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const entries: Array<[string, unknown]> = [];
    for (const key of keys) {
      const descriptor = descriptors[key as string];
      if (!descriptor?.enumerable || !("value" in descriptor)) return null;
      entries.push([key as string, descriptor.value]);
    }
    return Object.fromEntries(entries);
  } catch { return null; }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every(key => expected.includes(key))
    && expected.every(key => Object.hasOwn(value, key));
}

function identity(connection: ProjectAlphaApiV2ConfiguredConnection) {
  return Object.freeze({
    sourceId: connection.sourceId,
    applicationId: connection.applicationId,
    baseUrl: connection.baseUrl,
    expectedSourceInstanceId: connection.expectedSourceInstanceId,
    expectedHistoryEpoch: connection.expectedHistoryEpoch,
  });
}

/**
 * Prepare the exact native control command before authentication/store awaits.
 * The command contains no authorization proof: a later native-authenticated
 * service must bind its actor and capability to the same-primary CAS write.
 * Enabled identities come only from the deployment-owned secret JSON. A
 * disabled command deliberately does not parse that JSON, so a broken
 * connection configuration cannot prevent an operator from stopping probes.
 */
export function prepareProjectAlphaApiV2MonitorControlCommand(
  rawInput: unknown,
  rawConnections: string | undefined,
): ProjectAlphaApiV2MonitorControlCommand {
  try {
    const input = snapshotRecord(rawInput);
    if (!input || !exactKeys(input, ["expectedRevision", "enabled"])
      || typeof input.expectedRevision !== "number"
      || !Number.isSafeInteger(input.expectedRevision)
      || input.expectedRevision < 0 || input.expectedRevision > MAX_REVISION
      || typeof input.enabled !== "boolean") invalid();

    // This is synchronous and intentionally captured before any future caller
    // can cross an await boundary. Never accept browser-supplied identities.
    const capturedConnections = rawConnections;
    const identities = input.enabled
      // Per-instance disabled entries are deployment-owned retirement intent,
      // not active monitor pins. The scheduler makes the same selection before
      // exact head comparison, so including them here would create an audited
      // head that can never run.
      ? parseProjectAlphaApiV2Connections(capturedConnections).filter(connection => connection.enabled).map(identity)
      : [];
    return snapshotProjectAlphaApiV2MonitorLifecycleDesired({
      expectedRevision: input.expectedRevision,
      enabled: input.enabled,
      identities,
    });
  } catch (error) {
    if (error instanceof ProjectAlphaApiV2MonitorControlCommandError) throw error;
    throw new ProjectAlphaApiV2MonitorControlCommandError();
  }
}
