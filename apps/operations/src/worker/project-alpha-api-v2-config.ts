import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";
import { parseDuplicateFreeJson } from "./bounded-json";

/**
 * Deployment-only secret name. Native onboarding consumes it through the
 * application secret typing; scheduler composition remains a separate cutover.
 */
export const PROJECT_ALPHA_API_V2_CONNECTIONS = "PROJECT_ALPHA_API_V2_CONNECTIONS" as const;

const MAX_CONNECTIONS = 16;
const MAX_CONFIG_BYTES = 128 * 1024;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEADER_MAX = 8192;

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

function headerValue(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > HEADER_MAX || value !== value.trim()) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f || codePoint > 0xff) return false;
  }
  return true;
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

function validConnection(value: unknown): value is ProjectAlphaApiV2ConfiguredConnection {
  if (!plainRecord(value) || !exactKeys(value,
    ["sourceId", "applicationId", "baseUrl", "expectedSourceInstanceId", "expectedHistoryEpoch", "apiKey"],
    ["accessClientId", "accessClientSecret", "enabled"])) return false;
  if (typeof value.sourceId !== "string" || !SOURCE_ID.test(value.sourceId)
    || typeof value.applicationId !== "string" || !UUID_V4.test(value.applicationId)
    || typeof value.expectedSourceInstanceId !== "string" || !UUID_V4.test(value.expectedSourceInstanceId)
    || typeof value.expectedHistoryEpoch !== "string" || !UUID_V4.test(value.expectedHistoryEpoch)
    || !canonicalBaseUrl(value.baseUrl) || !headerValue(value.apiKey)
    || (Object.hasOwn(value, "enabled") && typeof value.enabled !== "boolean")
    || (Object.hasOwn(value, "accessClientId") !== Object.hasOwn(value, "accessClientSecret"))
    || (Object.hasOwn(value, "accessClientId") && (!headerValue(value.accessClientId) || !headerValue(value.accessClientSecret)))) return false;
  return true;
}

function detached(value: Record<string, unknown>): ProjectAlphaApiV2ConfiguredConnection {
  const result = {
    sourceId: value.sourceId as string,
    applicationId: value.applicationId as string,
    baseUrl: value.baseUrl as string,
    expectedSourceInstanceId: value.expectedSourceInstanceId as string,
    expectedApplicationId: value.applicationId as string,
    expectedHistoryEpoch: value.expectedHistoryEpoch as string,
    apiKey: value.apiKey as string,
    // The historical monitor envelope had no per-instance switch. It meant
    // enabled; the current `instances` envelope defaults false for safety.
    enabled: value.enabled !== false,
    ...(Object.hasOwn(value, "accessClientId") ? {
      accessClientId: value.accessClientId as string,
      accessClientSecret: value.accessClientSecret as string,
    } : {}),
  } satisfies ProjectAlphaApiV2ConfiguredConnection;
  return Object.freeze(result);
}

/** Parse deployment-owned JSON without contacting PA, D1, or a legacy resolver. */
export function parseProjectAlphaApiV2Connections(raw: string | undefined): readonly ProjectAlphaApiV2ConfiguredConnection[] {
  const input = typeof raw === "string" && raw.length > 0 && new TextEncoder().encode(raw).byteLength <= MAX_CONFIG_BYTES ? raw : invalid();
  let value: unknown;
  try { value = parseDuplicateFreeJson(input); } catch { invalid(); }
  const object = plainRecord(value) ? value : invalid();
  if (object.version !== 1 || !((exactKeys(object, ["version", "connections"]) && Array.isArray(object.connections))
    || (exactKeys(object, ["version", "instances"]) && plainRecord(object.instances)))) invalid();
  // `instances` is the current deployment-owned connection envelope used by
  // all existing API-v2 callers. Retain `connections` only for the bounded
  // monitor's historical fixtures while making the deployed shape canonical.
  const connections: unknown[] = Array.isArray(object.connections) ? object.connections
    : Object.entries(object.instances as Record<string, unknown>).map(([sourceId, instance]) => {
      if (!plainRecord(instance) || instance.sourceId !== sourceId) return instance;
      const base = instance.enabled === undefined
        ? ["sourceId", "baseUrl", "apiKey", "sourceInstanceId", "applicationId", "historyEpoch"]
        : ["sourceId", "enabled", "baseUrl", "apiKey", "sourceInstanceId", "applicationId", "historyEpoch"];
      const access = instance.accessClientId !== undefined || instance.accessClientSecret !== undefined;
      if (!exactKeys(instance, base, access ? ["accessClientId", "accessClientSecret"] : [])
        || access !== (instance.accessClientId !== undefined && instance.accessClientSecret !== undefined)) return null;
      return {
        sourceId,
        applicationId: instance.applicationId,
        baseUrl: instance.baseUrl,
        expectedSourceInstanceId: instance.sourceInstanceId,
        expectedHistoryEpoch: instance.historyEpoch,
        apiKey: instance.apiKey,
        enabled: instance.enabled === true,
        ...(instance.accessClientId === undefined ? {} : {
          accessClientId: instance.accessClientId,
          accessClientSecret: instance.accessClientSecret,
        }),
      };
    });
  if (connections.length > MAX_CONNECTIONS) invalid();

  const sourceIds = new Set<string>();
  const sourceApplications = new Set<string>();
  const result: ProjectAlphaApiV2ConfiguredConnection[] = [];
  for (const candidate of connections) {
    if (!validConnection(candidate)) invalid();
    const connection = candidate as Record<string, unknown>;
    if (connection.enabled !== undefined && typeof connection.enabled !== "boolean") invalid();
    if (sourceIds.has(connection.sourceId as string)
      || sourceApplications.has(`${connection.expectedSourceInstanceId as string}\u0000${connection.applicationId as string}`)) invalid();
    sourceIds.add(connection.sourceId as string);
    sourceApplications.add(`${connection.expectedSourceInstanceId as string}\u0000${connection.applicationId as string}`);
    result.push(detached(connection));
  }
  return Object.freeze(result);
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
