import {
  probeProjectAlphaApiV2,
  type ProjectAlphaApiV2Connection,
  type ProjectAlphaApiV2Endpoint,
  type ProjectAlphaApiV2Probe,
} from "./project-alpha-api-v2";

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

/** A bounded JSON scanner which rejects duplicate object keys before the
 * standard parser applies last-member-wins semantics.  It validates the same
 * JSON grammar while retaining decoded member names, including \\u escapes. */
class DuplicateMemberScanner {
  private index = 0;
  private depth = 0;
  constructor(private readonly input: string) {}
  scan(): void { this.space(); this.value(); this.space(); if (this.index !== this.input.length) throw new SyntaxError(); }
  private space(): void { while (/[\x20\x09\x0a\x0d]/.test(this.input[this.index] ?? "")) this.index += 1; }
  private value(): void {
    if (this.depth++ >= 32) throw new SyntaxError();
    try {
      const current = this.input[this.index];
      if (current === "{") this.object();
      else if (current === "[") this.array();
      else if (current === "\"") { this.string(); }
      else if (this.input.startsWith("true", this.index)) this.index += 4;
      else if (this.input.startsWith("false", this.index)) this.index += 5;
      else if (this.input.startsWith("null", this.index)) this.index += 4;
      else this.number();
    } finally { this.depth -= 1; }
  }
  private object(): void {
    this.index += 1; this.space(); const keys = new Set<string>();
    if (this.input[this.index] === "}") { this.index += 1; return; }
    for (;;) {
      if (this.input[this.index] !== "\"") throw new SyntaxError();
      const key = this.string(); if (keys.has(key)) throw new SyntaxError(); keys.add(key);
      this.space(); if (this.input[this.index++] !== ":") throw new SyntaxError(); this.space(); this.value(); this.space();
      const separator = this.input[this.index++]; if (separator === "}") return; if (separator !== ",") throw new SyntaxError(); this.space();
    }
  }
  private array(): void {
    this.index += 1; this.space(); if (this.input[this.index] === "]") { this.index += 1; return; }
    for (;;) { this.value(); this.space(); const separator = this.input[this.index++]; if (separator === "]") return; if (separator !== ",") throw new SyntaxError(); this.space(); }
  }
  private string(): string {
    const start = this.index++;
    while (this.index < this.input.length) {
      const code = this.input.charCodeAt(this.index++);
      if (code < 0x20) throw new SyntaxError();
      if (code === 0x22) {
        const token = this.input.slice(start, this.index);
        try { return JSON.parse(token) as string; } catch { throw new SyntaxError(); }
      }
      if (code === 0x5c) {
        const escape = this.input[this.index++];
        if (!escape || !'"\\\\/bfnrtu'.includes(escape)) throw new SyntaxError();
        if (escape === "u") {
          const hex = this.input.slice(this.index, this.index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError();
          this.index += 4;
        }
      }
    }
    throw new SyntaxError();
  }
  private number(): void {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    match.lastIndex = this.index; const value = match.exec(this.input); if (!value) throw new SyntaxError(); this.index += value[0].length;
  }
}
function parseEnvelope(raw: string): unknown {
  new DuplicateMemberScanner(raw).scan();
  return JSON.parse(raw) as unknown;
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
  try { envelope = parseEnvelope(raw); } catch { return invalid(); }
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
