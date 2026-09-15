import {
  probeProjectAlphaApiV2,
  type ProjectAlphaApiV2Connection,
  type ProjectAlphaApiV2Endpoint,
  type ProjectAlphaApiV2Probe,
} from "./project-alpha-api-v2";
import { parseDuplicateFreeJson } from "./bounded-json";

/** The deployment secret is independent of legacy snapshot/event settings.
 * It is server-owned only: no route, browser payload, or registry operation
 * consumes or changes it. */
export interface ProjectAlphaApiV2ConnectionEnvironment {
  PROJECT_ALPHA_API_V2_CONNECTIONS?: string;
}

export type ProjectAlphaApiV2ConfiguredConnection = Readonly<{
  sourceId: string;
  enabled: boolean;
  /** Deliberately redacted: the API key stays inside the explicit probe bridge. */
  connection: Readonly<Omit<ProjectAlphaApiV2Connection, "apiKey">>;
}>;

export type ProjectAlphaApiV2ConfiguredProbe =
  | { status: "disabled"; sourceId: string }
  | ProjectAlphaApiV2Probe;

/** Deliberately has no configuration detail: callers must not surface secret
 * envelope contents in logs, responses, or diagnostics. */
export class ProjectAlphaApiV2ConnectionConfigurationError extends Error {
  constructor() { super("Project Alpha API v2 connection configuration is invalid"); }
}

const MAX_SECRET_BYTES = 256 * 1024;
const MAX_CONNECTIONS = 64;
const MAX_API_KEY_LENGTH = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Keep the deployment-owned map on the exact canonical source-ID contract
// shared with migration 0087 and source-identity.ts; aliases are not labels.
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;

function invalid(): never { throw new ProjectAlphaApiV2ConnectionConfigurationError(); }
function plain(value: unknown): value is Record<string, unknown> {
  try { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
  catch { return false; }
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  try { return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)); }
  catch { return false; }
}
function optionalEnabled(value: Record<string, unknown>): value is Record<string, unknown> & { enabled?: boolean } {
  try { return value.enabled === undefined || typeof value.enabled === "boolean"; }
  catch { return false; }
}
function sourceId(value: unknown): value is string { return typeof value === "string" && SOURCE_ID.test(value); }
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function apiKey(value: unknown): value is string {
  // A bearer value is interpolated directly into Authorization.  Restrict it
  // to printable ASCII excluding SP, every control byte, and non-ASCII data.
  return typeof value === "string" && value.length > 0 && value.length <= MAX_API_KEY_LENGTH && /^[\x21-\x7e]+$/.test(value);
}
function origin(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || value !== value.trim()) invalid();
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) invalid();
    // URL.search/hash are empty for a bare trailing ? or #, so also require
    // the parser's complete canonical serialization to be the origin root.
    if (url.href !== `${url.origin}/`) invalid();
    return url.origin;
  } catch { return invalid(); }
}

type ParsedConfiguredConnection = Readonly<{ resolved: ProjectAlphaApiV2ConfiguredConnection; apiKey: string }>;

/**
 * Resolves one versioned, deployment-owned connection.  Every instance is
 * parsed before selection so a malformed sibling cannot be mistaken for an
 * unconfigured source.  `enabled` is optional only to preserve default-off
 * deployment behavior.
 */
function parseProjectAlphaApiV2Connection(
  env: ProjectAlphaApiV2ConnectionEnvironment,
  requestedSourceId: string,
): ParsedConfiguredConnection {
  if (!sourceId(requestedSourceId) || typeof env.PROJECT_ALPHA_API_V2_CONNECTIONS !== "string") invalid();
  const raw = env.PROJECT_ALPHA_API_V2_CONNECTIONS;
  if (!raw.trim() || new TextEncoder().encode(raw).byteLength > MAX_SECRET_BYTES) invalid();

  let envelope: unknown;
  try { envelope = parseDuplicateFreeJson(raw); } catch { return invalid(); }
  if (!plain(envelope) || !exact(envelope, ["version", "instances"]) || envelope.version !== 1 || !plain(envelope.instances)) invalid();
  const entries = Object.entries(envelope.instances);
  if (entries.length === 0 || entries.length > MAX_CONNECTIONS) invalid();

  const sourceIds = new Set<string>(), origins = new Set<string>(), sourceInstances = new Set<string>();
  const applications = new Set<string>(), historyEpochs = new Set<string>();
  let selected: ParsedConfiguredConnection | undefined;
  for (const [key, value] of entries) {
    if (!sourceId(key) || !plain(value) || !optionalEnabled(value)) invalid();
    const allowed = value.enabled === undefined
      ? ["sourceId", "baseUrl", "apiKey", "sourceInstanceId", "applicationId", "historyEpoch"]
      : ["sourceId", "enabled", "baseUrl", "apiKey", "sourceInstanceId", "applicationId", "historyEpoch"];
    if (!exact(value, allowed) || !sourceId(value.sourceId) || value.sourceId !== key || !apiKey(value.apiKey)
      || !uuid(value.sourceInstanceId) || !uuid(value.applicationId) || !uuid(value.historyEpoch)) invalid();
    const baseUrl = origin(value.baseUrl);
    const identity = [value.sourceInstanceId.toLowerCase(), value.applicationId.toLowerCase(), value.historyEpoch.toLowerCase()];
    if (new Set(identity).size !== identity.length || sourceIds.has(value.sourceId) || origins.has(baseUrl)
      || sourceInstances.has(identity[0]!) || applications.has(identity[1]!) || historyEpochs.has(identity[2]!)) invalid();
    sourceIds.add(value.sourceId); origins.add(baseUrl); sourceInstances.add(identity[0]!); applications.add(identity[1]!); historyEpochs.add(identity[2]!);
    const configured = Object.freeze({ sourceId: value.sourceId, enabled: value.enabled ?? false,
      connection: Object.freeze({ baseUrl, expectedSourceInstanceId: identity[0]!, expectedApplicationId: identity[1]!, expectedHistoryEpoch: identity[2]! }) });
    const parsed = Object.freeze({ resolved: configured, apiKey: value.apiKey });
    if (key === requestedSourceId) selected = parsed;
  }
  return selected ?? invalid();
}

export function resolveProjectAlphaApiV2Connection(
  env: ProjectAlphaApiV2ConnectionEnvironment,
  requestedSourceId: string,
): ProjectAlphaApiV2ConfiguredConnection {
  try { return parseProjectAlphaApiV2Connection(env, requestedSourceId).resolved; }
  catch { return invalid(); }
}

/** Explicit, one-shot probe bridge.  No scheduler or route calls this.  A
 * disabled connection exits before the provided fetch function is touched. */
export function probeConfiguredProjectAlphaApiV2Connection(
  env: ProjectAlphaApiV2ConnectionEnvironment,
  sourceId: string,
  requiredCapabilities: readonly string[] = [],
  send: typeof fetch = fetch,
  requiredEndpoints: readonly ProjectAlphaApiV2Endpoint[] = [],
): Promise<ProjectAlphaApiV2ConfiguredProbe> {
  try {
    const configured = parseProjectAlphaApiV2Connection(env, sourceId);
    if (!configured.resolved.enabled) return Promise.resolve({ status: "disabled", sourceId: configured.resolved.sourceId });
    return probeProjectAlphaApiV2({ ...configured.resolved.connection, apiKey: configured.apiKey }, requiredCapabilities, send, requiredEndpoints);
  } catch { return Promise.resolve({ status: "misconfigured", reason: "configuration" }); }
}

/**
 * The only general bridge that can hand an enabled deployment connection to a
 * dormant transport. The callback runs immediately and its result is the only
 * value that escapes; callers cannot resolve or serialize the secret-bearing
 * connection as configuration data.
 */
export async function withEnabledConfiguredProjectAlphaApiV2Connection<T>(
  env: ProjectAlphaApiV2ConnectionEnvironment,
  sourceId: string,
  callback: (connection: Readonly<ProjectAlphaApiV2Connection>) => Promise<T> | T,
): Promise<{ status: "enabled"; value: T } | { status: "disabled"; sourceId: string } | { status: "misconfigured" }> {
  try {
    const configured = parseProjectAlphaApiV2Connection(env, sourceId);
    if (!configured.resolved.enabled) return { status: "disabled", sourceId: configured.resolved.sourceId };
    return { status: "enabled", value: await callback(Object.freeze({ ...configured.resolved.connection, apiKey: configured.apiKey })) };
  } catch { return { status: "misconfigured" }; }
}
