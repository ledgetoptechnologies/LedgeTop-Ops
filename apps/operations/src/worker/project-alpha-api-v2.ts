import { parseDuplicateFreeJson } from "./bounded-json";

/** Replacement-connection preflight. This does not enable synchronization,
 * change source ownership, or treat a successful probe as resource authority. */
const CAPABILITIES_PATH = "/api/v2/capabilities";
const MAX_RESPONSE_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HISTORY_EPOCH = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// PA v2 capability names are lowercase dotted namespaces; the binding-status
// capability also contains an intentional underscore for compatibility.
const CAPABILITY = /^[a-z][a-z0-9._-]{1,95}$/;

export type ProjectAlphaApiV2Endpoint = {
  method: string;
  path: string;
  requiredCapability: string;
  requiresSourceInstanceId?: boolean;
  requiresApplicationId?: boolean;
  requiresUpdatePublicId?: boolean;
  requiresHistoryEpoch?: boolean;
  requiresExpectedPublicId?: boolean;
  requiresExpectedProfileSha256?: boolean;
};

const DIRECTORY_ENDPOINTS: readonly ProjectAlphaApiV2Endpoint[] = [
  { method: "POST", path: "/api/v2/directory/organizations/commands", requiredCapability: "directory.organizations.create",
    requiresSourceInstanceId: true, requiresApplicationId: true, requiresUpdatePublicId: true, requiresHistoryEpoch: true },
  { method: "POST", path: "/api/v2/directory/clients/commands", requiredCapability: "directory.clients.create",
    requiresSourceInstanceId: true, requiresApplicationId: true, requiresUpdatePublicId: true, requiresHistoryEpoch: true },
];

export type ProjectAlphaApiV2Connection = {
  baseUrl: string;
  apiKey: string;
  expectedSourceInstanceId: string;
  expectedApplicationId: string;
  expectedHistoryEpoch?: string;
  accessClientId?: string;
  accessClientSecret?: string;
};

export type ProjectAlphaApiV2Probe =
  | { status: "verified"; sourceInstanceId: string; applicationId: string; historyEpoch: string; requestId: string; grantedCapabilities: string[] }
  | { status: "misconfigured" | "unavailable" | "unauthorized" | "incompatible" | "rate_limited";
      reason: "configuration" | "transport" | "timeout" | "credentials_or_scope" | "http_status" | "rate_limit"
        | "response_limit" | "invalid_contract" | "source_mismatch" | "application_mismatch" | "history_epoch_mismatch" | "missing_capability" | "missing_endpoint";
      httpStatus?: number; requestId?: string };

function target(connection: ProjectAlphaApiV2Connection): URL {
  const url = new URL(connection.baseUrl);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash
    || !UUID.test(connection.expectedSourceInstanceId) || !UUID.test(connection.expectedApplicationId) || !connection.apiKey.trim()
    || (connection.expectedHistoryEpoch !== undefined
      && (typeof connection.expectedHistoryEpoch !== "string" || !HISTORY_EPOCH.test(connection.expectedHistoryEpoch)))
    || Boolean(connection.accessClientId) !== Boolean(connection.accessClientSecret)) throw new Error("configuration");
  url.pathname = CAPABILITIES_PATH;
  return url;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function endpointContract(value: unknown): value is ProjectAlphaApiV2Endpoint {
  return record(value) && typeof value.method === "string" && ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(value.method)
    && typeof value.path === "string" && /^\/api\/v2\/[A-Za-z0-9/_.{}-]+$/.test(value.path) && value.path.length <= 256
    && !value.path.split("/").some(segment => segment === "." || segment === "..")
    && typeof value.requiredCapability === "string" && CAPABILITY.test(value.requiredCapability)
    && (value.requiresSourceInstanceId === undefined || typeof value.requiresSourceInstanceId === "boolean")
    && (value.requiresApplicationId === undefined || typeof value.requiresApplicationId === "boolean")
    && (value.requiresUpdatePublicId === undefined || typeof value.requiresUpdatePublicId === "boolean")
    && (value.requiresHistoryEpoch === undefined || typeof value.requiresHistoryEpoch === "boolean")
    && (value.requiresExpectedPublicId === undefined || typeof value.requiresExpectedPublicId === "boolean")
    && (value.requiresExpectedProfileSha256 === undefined || typeof value.requiresExpectedProfileSha256 === "boolean");
}

async function readMetadata(response: Response): Promise<unknown> {
  const declared = response.headers.get("Content-Length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new Error("response_limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("invalid_contract");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try { part = await reader.read(); }
      catch { throw new Error("body_transport"); }
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("response_limit");
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return parseDuplicateFreeJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Credentials go only to the configured HTTPS origin; never follow redirects.
 * One bounded attempt. Callers own persisted retries/outage duration and must
 * not classify authorization/contract failures as successful health checks. */
export async function probeProjectAlphaApiV2(
  connection: ProjectAlphaApiV2Connection,
  requiredCapabilities: readonly string[] = [],
  send: typeof fetch = fetch,
  requiredEndpoints: readonly ProjectAlphaApiV2Endpoint[] = [],
): Promise<ProjectAlphaApiV2Probe> {
  let url: URL, headers: Headers;
  try {
    // Pin identities before the first await, including direct preflight callers.
    // Keep snapshot errors inside the safe configuration-error boundary.
    connection = { ...connection };
    url = target(connection);
    if (requiredCapabilities.length > 128 || requiredCapabilities.some(value => !CAPABILITY.test(value))
      || requiredEndpoints.length > 128 || requiredEndpoints.some(value => !endpointContract(value))) throw new Error("configuration");
    headers = new Headers({ Accept: "application/json", Authorization: `Bearer ${connection.apiKey}` });
    if (connection.accessClientId && connection.accessClientSecret) {
      headers.set("CF-Access-Client-Id", connection.accessClientId);
      headers.set("CF-Access-Client-Secret", connection.accessClientSecret);
    }
  } catch { return { status: "misconfigured", reason: "configuration" }; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response: Response | undefined;
  try {
    // Workers turns redirect:"error" into an opaque transport TypeError before
    // callers can classify the response. Manual mode still never follows the
    // redirect, and lets us reject it as an incompatible upstream contract.
    response = await send(url, { method: "GET", headers, redirect: "manual", credentials: "omit", cache: "no-store", signal: controller.signal });
    const candidateId = response.headers.get("X-Request-ID");
    const diagnostic = { httpStatus: response.status, ...(candidateId && UUID.test(candidateId) ? { requestId: candidateId } : {}) };
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      return { status: "incompatible", reason: "invalid_contract", ...diagnostic };
    }
    if (!candidateId || !UUID.test(candidateId)) {
      await response.body?.cancel();
      return { status: "incompatible", reason: "invalid_contract", ...diagnostic };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) return { status: "unauthorized", reason: "credentials_or_scope", ...diagnostic };
      if (response.status === 429) return { status: "rate_limited", reason: "rate_limit", ...diagnostic };
      return { status: response.status >= 500 ? "unavailable" : "incompatible", reason: "http_status", ...diagnostic };
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")
      || !(response.headers.get("Cache-Control") ?? "").split(",").some(value => value.trim().toLowerCase() === "no-store")
      || response.headers.has("Set-Cookie") || response.headers.has("Location")) {
      await response.body?.cancel();
      return { status: "incompatible", reason: "invalid_contract", ...diagnostic };
    }
    const data = await readMetadata(response);
    if (!record(data) || data.apiVersion !== "2" || typeof data.sourceInstanceId !== "string" || !UUID.test(data.sourceInstanceId)
      || typeof data.applicationId !== "string" || !UUID.test(data.applicationId)
      || typeof data.historyEpoch !== "string" || !HISTORY_EPOCH.test(data.historyEpoch)
      || typeof data.requestId !== "string" || !UUID.test(data.requestId) || candidateId !== data.requestId
      || !Array.isArray(data.grantedCapabilities) || data.grantedCapabilities.length > 128
      || !Array.isArray(data.implementedEndpoints) || data.implementedEndpoints.length > 128
      || !data.implementedEndpoints.some(endpoint => record(endpoint) && endpoint.method === "GET" && endpoint.path === CAPABILITIES_PATH
        && endpoint.requiredCapability === "api.capabilities.read")) {
      return { status: "incompatible", reason: "invalid_contract", ...diagnostic };
    }
    const granted: string[] = [];
    for (const capability of data.grantedCapabilities) {
      if (!record(capability) || typeof capability.name !== "string" || !CAPABILITY.test(capability.name) || granted.includes(capability.name)) {
        return { status: "incompatible", reason: "invalid_contract", ...diagnostic };
      }
      granted.push(capability.name);
    }
    const implemented = new Set<string>();
    const routes = new Map<string, ProjectAlphaApiV2Endpoint>();
    for (const endpoint of data.implementedEndpoints) {
      if (!endpointContract(endpoint) || routes.has(`${endpoint.method} ${endpoint.path}`)) {
        return { status: "incompatible", reason: "invalid_contract", ...diagnostic };
      }
      routes.set(`${endpoint.method} ${endpoint.path}`, endpoint);
      implemented.add(endpoint.requiredCapability);
    }
    if (data.sourceInstanceId.toLowerCase() !== connection.expectedSourceInstanceId.toLowerCase()) {
      return { status: "incompatible", reason: "source_mismatch", ...diagnostic };
    }
    if (data.applicationId.toLowerCase() !== connection.expectedApplicationId.toLowerCase()) {
      return { status: "incompatible", reason: "application_mismatch", ...diagnostic };
    }
    if (connection.expectedHistoryEpoch !== undefined && data.historyEpoch !== connection.expectedHistoryEpoch) {
      return { status: "incompatible", reason: "history_epoch_mismatch", ...diagnostic };
    }
    if (!["api.capabilities.read", ...requiredCapabilities, ...requiredEndpoints.map(endpoint => endpoint.requiredCapability)]
      .every(capability => granted.includes(capability))) {
      return { status: "unauthorized", reason: "missing_capability", ...diagnostic };
    }
    if (requiredCapabilities.some(capability => !implemented.has(capability))
      || requiredEndpoints.some(endpoint => {
        const implementedEndpoint = routes.get(`${endpoint.method} ${endpoint.path}`);
        return implementedEndpoint?.requiredCapability !== endpoint.requiredCapability
          || (endpoint.requiresSourceInstanceId !== undefined
            && implementedEndpoint.requiresSourceInstanceId !== endpoint.requiresSourceInstanceId)
          || (endpoint.requiresApplicationId !== undefined
            && implementedEndpoint.requiresApplicationId !== endpoint.requiresApplicationId)
          || (endpoint.requiresUpdatePublicId !== undefined
            && implementedEndpoint.requiresUpdatePublicId !== endpoint.requiresUpdatePublicId)
          || (endpoint.requiresHistoryEpoch !== undefined
            && implementedEndpoint.requiresHistoryEpoch !== endpoint.requiresHistoryEpoch)
          || (endpoint.requiresExpectedPublicId !== undefined
            && implementedEndpoint.requiresExpectedPublicId !== endpoint.requiresExpectedPublicId)
          || (endpoint.requiresExpectedProfileSha256 !== undefined
            && implementedEndpoint.requiresExpectedProfileSha256 !== endpoint.requiresExpectedProfileSha256);
      })) {
      return { status: "incompatible", reason: "missing_endpoint", ...diagnostic };
    }
    return { status: "verified", sourceInstanceId: data.sourceInstanceId.toLowerCase(), applicationId: data.applicationId.toLowerCase(),
      historyEpoch: data.historyEpoch,
      requestId: data.requestId, grantedCapabilities: granted };
  } catch (error) {
    if (controller.signal.aborted) return { status: "unavailable", reason: "timeout" };
    if (error instanceof Error && error.message === "body_transport") return { status: "unavailable", reason: "transport" };
    if (error instanceof Error && error.message === "response_limit") return { status: "incompatible", reason: "response_limit" };
    // Never return/log a provider error message: it may contain URLs or credentials.
    return { status: response ? "incompatible" : "unavailable", reason: response ? "invalid_contract" : "transport" };
  } finally { clearTimeout(timer); }
}

/** Verify the actual two directory command routes, not merely any endpoint
 * advertising their scopes. This is read-only readiness, not a write grant,
 * managed-policy activation or proof that synchronization/backfill is complete. */
export function probeProjectAlphaDirectoryApiV2(
  connection: ProjectAlphaApiV2Connection,
  send: typeof fetch = fetch,
): Promise<ProjectAlphaApiV2Probe> {
  return probeProjectAlphaApiV2(connection, [], send, DIRECTORY_ENDPOINTS);
}

