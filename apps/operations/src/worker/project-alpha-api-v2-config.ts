import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";
import { parseProjectAlphaApiV2ConnectionConfigurations } from "./project-alpha-api-v2-connections";
import { parseDuplicateFreeJson } from "./bounded-json";

/**
 * Deployment-only secret name. Native onboarding consumes it through the
 * application secret typing; scheduler composition remains a separate cutover.
 */
export const PROJECT_ALPHA_API_V2_CONNECTIONS = "PROJECT_ALPHA_API_V2_CONNECTIONS" as const;

const MAX_CONFIG_BYTES = 256 * 1024;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ProjectAlphaApiV2ConfiguredConnection = ProjectAlphaApiV2Connection & {
  readonly sourceId: string;
  readonly applicationId: string;
  /** A disabled deployment connection remains observable but is never probed. */
  readonly enabled: boolean;
};

export type ProjectAlphaApiV2ConnectionIdentity = Readonly<{
  sourceId: string;
  applicationId: string;
  baseUrl: string;
  expectedSourceInstanceId: string;
  expectedHistoryEpoch: string;
}>;

export class ProjectAlphaApiV2ConfigurationError extends Error {
  constructor() {
    super("Project Alpha API v2 connection configuration is unavailable");
    this.name = "ProjectAlphaApiV2ConfigurationError";
  }
}

const invalid = (): never => { throw new ProjectAlphaApiV2ConfigurationError(); };

function plainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string")) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return keys.every(key => {
      const descriptor = descriptors[key as string];
      return descriptor?.enumerable === true && "value" in descriptor;
    });
  } catch { return false; }
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return keys.length === required.length + optional.filter(key => Object.hasOwn(value, key)).length
    && keys.every(key => allowed.has(key)) && required.every(key => Object.hasOwn(value, key));
}

/** Snapshot data properties without invoking accessors or trusting a proxy. */
function snapshotRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries: Array<[string, unknown]> = [];
    for (const key of keys) {
      const descriptor = descriptors[key as string];
      if (!descriptor?.enumerable || !("value" in descriptor)) return null;
      entries.push([key as string, descriptor.value]);
    }
    return Object.fromEntries(entries);
  } catch { return null; }
}

function canonicalBaseUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === "/" && value === url.origin;
  } catch { return false; }
}

/** Parse deployment-owned JSON without contacting PA, D1, or a legacy resolver. */
export function parseProjectAlphaApiV2Connections(raw: string | undefined): readonly ProjectAlphaApiV2ConfiguredConnection[] {
  const input = typeof raw === "string" && raw.length > 0 && new TextEncoder().encode(raw).byteLength <= MAX_CONFIG_BYTES ? raw : invalid();
  try {
    const parsedEnvelope = parseDuplicateFreeJson(input);
    const object = plainRecord(parsedEnvelope) ? parsedEnvelope : invalid();
    if (object.version !== 1
      || !((exactKeys(object, ["version", "connections"]) && Array.isArray(object.connections))
        || (exactKeys(object, ["version", "instances"]) && plainRecord(object.instances)))) invalid();

    if (Array.isArray(object.connections) && object.connections.length === 0) return Object.freeze([]);

    // Scheduler fixtures historically use a `connections` array with omitted
    // enabled interpreted as active. Normalize that compatibility shape once,
    // then send both formats through the same strict deployment parser used by
    // routes and write transports.
    let normalized = input;
    if (Array.isArray(object.connections)) {
      const instances: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const candidate of object.connections) {
        if (!plainRecord(candidate) || !exactKeys(candidate,
          ["sourceId", "applicationId", "baseUrl", "expectedSourceInstanceId", "expectedHistoryEpoch", "apiKey"],
          ["accessClientId", "accessClientSecret", "enabled"])) invalid();
        const source = candidate.sourceId;
        if (typeof source !== "string" || !SOURCE_ID.test(source) || Object.hasOwn(instances, source)) invalid();
        if (Object.hasOwn(candidate, "accessClientId") !== Object.hasOwn(candidate, "accessClientSecret")) invalid();
        const enabled = candidate.enabled === undefined ? true : candidate.enabled;
        if (typeof enabled !== "boolean") invalid();
        instances[source] = {
          sourceId: source,
          enabled,
          baseUrl: candidate.baseUrl,
          apiKey: candidate.apiKey,
          sourceInstanceId: candidate.expectedSourceInstanceId,
          applicationId: candidate.applicationId,
          historyEpoch: candidate.expectedHistoryEpoch,
          ...(candidate.accessClientId === undefined ? {} : {
            accessClientId: candidate.accessClientId,
            accessClientSecret: candidate.accessClientSecret,
          }),
        };
      }
      normalized = JSON.stringify({ version: 1, instances });
    }

    const configuredConnections = parseProjectAlphaApiV2ConnectionConfigurations({ PROJECT_ALPHA_API_V2_CONNECTIONS: normalized });
    return Object.freeze(configuredConnections.map(connection => Object.freeze({
      ...connection,
      applicationId: connection.expectedApplicationId,
    })));
  } catch { return invalid(); }
}

/**
 * Resolve only an exact durable destination identity. Probe results are never
 * consulted or adopted, and unmatched/invalid input reveals no configuration.
 */
export function resolveProjectAlphaApiV2Connection(
  raw: string | undefined,
  requested: ProjectAlphaApiV2ConnectionIdentity,
): ProjectAlphaApiV2ConfiguredConnection {
  const requestedSnapshot = snapshotRecord(requested) ?? invalid();
  if (!exactKeys(requestedSnapshot,
    ["sourceId", "applicationId", "baseUrl", "expectedSourceInstanceId", "expectedHistoryEpoch"])
    || typeof requestedSnapshot.sourceId !== "string" || !SOURCE_ID.test(requestedSnapshot.sourceId)
    || typeof requestedSnapshot.applicationId !== "string" || !UUID_V4.test(requestedSnapshot.applicationId)
    || typeof requestedSnapshot.expectedSourceInstanceId !== "string" || !UUID_V4.test(requestedSnapshot.expectedSourceInstanceId)
    || typeof requestedSnapshot.expectedHistoryEpoch !== "string" || !UUID_V4.test(requestedSnapshot.expectedHistoryEpoch)
    || !canonicalBaseUrl(requestedSnapshot.baseUrl)) invalid();
  const match = parseProjectAlphaApiV2Connections(raw).find(candidate => candidate.sourceId === requestedSnapshot.sourceId
    && candidate.applicationId === requestedSnapshot.applicationId && candidate.baseUrl === requestedSnapshot.baseUrl
    && candidate.expectedSourceInstanceId === requestedSnapshot.expectedSourceInstanceId
    && candidate.expectedHistoryEpoch === requestedSnapshot.expectedHistoryEpoch);
  return match ?? invalid();
}
