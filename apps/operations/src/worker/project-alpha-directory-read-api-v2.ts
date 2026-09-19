import { parseDuplicateFreeJson } from "./bounded-json";
import {
  withEnabledConfiguredProjectAlphaApiV2Connection,
  type ProjectAlphaApiV2ConnectionEnvironment,
} from "./project-alpha-api-v2-connections";
import {
  probeProjectAlphaApiV2,
  type ProjectAlphaApiV2Connection,
  type ProjectAlphaApiV2Endpoint,
  type ProjectAlphaApiV2Probe,
} from "./project-alpha-api-v2";

/**
 * Dormant, non-authoritative Project Alpha directory reads. Nothing imports
 * this module from a route, scheduler, connector, or legacy event flow.
 * Observations are intentionally detached from local mappings and links.
 */
const RESPONSE_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const MAX_INTEGER = "9223372036854775807";

export type ProjectAlphaDirectoryReadKind = "client" | "organization";
export type ProjectAlphaDirectoryProfile = Readonly<{
  publicId: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: Readonly<{ line1: string | null; line2: string | null; city: string | null; state: string | null; postalCode: string | null; country: string | null }>;
  clientType?: "unknown" | "business" | "consumer";
  organizationPublicId?: string | null;
}>;
export type ProjectAlphaDirectoryProfileObservation = Readonly<{
  authoritative: false;
  sourceId: string;
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  requestId: string;
  authorizationGeneration: string;
  resource: Readonly<{ type: ProjectAlphaDirectoryReadKind; id: string; revision: string }>;
  profile: ProjectAlphaDirectoryProfile;
}>;
export type ProjectAlphaDirectoryBindingObservation = Readonly<{
  authoritative: false;
  sourceId: string;
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  requestId: string;
  authorizationGeneration: string;
  binding: Readonly<{ type: ProjectAlphaDirectoryReadKind; externalId: string; publicId: string; createdAt: string }>;
  resource: Readonly<{ revision: string; present: true }>;
}>;
type Blocked = Readonly<{ status: "blocked"; reason: "configuration" | "preflight" | "credentials_or_scope"; preflight?: ProjectAlphaApiV2Probe }>;
type Uncertain = Readonly<{ status: "uncertain"; reason: "transport" | "timeout" | "response_limit" | "invalid_contract" | "http_status"; httpStatus?: number }>;
type Inactive = Readonly<{ status: "disabled"; sourceId: string }>;
type Missing = Readonly<{ status: "not_found" }>;
type Tombstoned = Readonly<{ status: "tombstoned" }>;
type Conflict = Readonly<{ status: "conflict" }>;
export type ProjectAlphaDirectoryProfileReadOutcome =
  | Readonly<{ status: "observed"; observation: ProjectAlphaDirectoryProfileObservation }>
  | Inactive | Missing | Tombstoned | Conflict | Blocked | Uncertain;
export type ProjectAlphaDirectoryBindingStatusOutcome =
  | Readonly<{ status: "observed"; observation: ProjectAlphaDirectoryBindingObservation }>
  | Inactive | Missing | Tombstoned | Conflict | Blocked | Uncertain;

function plain(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    return Reflect.ownKeys(value).every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && "value" in Object.getOwnPropertyDescriptor(value, key)!);
  } catch { return false; }
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  try { return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)); }
  catch { return false; }
}
function revision(value: unknown, zero = false): value is string {
  return typeof value === "string" && (zero ? /^(?:0|[1-9][0-9]{0,18})$/ : /^[1-9][0-9]{0,18}$/).test(value)
    && (value.length < MAX_INTEGER.length || value <= MAX_INTEGER);
}
function safeText(value: unknown, maximumCharacters = 512, maximumBytes = 2048): value is string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > maximumCharacters || /\p{C}/u.test(value)) return false;
  try {
    const bytes = new TextEncoder().encode(value);
    return bytes.byteLength <= maximumBytes && new TextDecoder("utf-8", { fatal: true }).decode(bytes) === value;
  } catch { return false; }
}
function nullableText(value: unknown, maximumCharacters = 512, maximumBytes = 2048): value is string | null {
  return value === null || safeText(value, maximumCharacters, maximumBytes);
}
function externalId(value: unknown): value is string { return safeText(value, 191, 764); }
function kind(value: unknown): value is ProjectAlphaDirectoryReadKind { return value === "client" || value === "organization"; }
function publicId(value: unknown): value is string { return typeof value === "string" && PUBLIC_ID.test(value); }
function v4(value: unknown): value is string { return typeof value === "string" && UUID_V4.test(value); }
function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}
function endpoint(kindValue: ProjectAlphaDirectoryReadKind, binding: boolean): ProjectAlphaApiV2Endpoint {
  const plural = kindValue === "client" ? "clients" : "organizations";
  return binding
    ? { method: "GET", path: `/api/v2/bindings/${kindValue}/status/{base64urlExternalId}`, requiredCapability: `directory.${plural}.binding_status.read`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true }
    : { method: "GET", path: `/api/v2/directory/${plural}/{publicId}`, requiredCapability: `directory.${plural}.read`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
}
function headers(connection: Readonly<ProjectAlphaApiV2Connection>): Headers {
  const result = new Headers({ Accept: "application/json", Authorization: `Bearer ${connection.apiKey}`,
    "X-PA-Source-Instance-ID": connection.expectedSourceInstanceId,
    "X-PA-Application-ID": connection.expectedApplicationId,
    "X-PA-History-Epoch": connection.expectedHistoryEpoch ?? "" });
  if (connection.accessClientId && connection.accessClientSecret) {
    result.set("CF-Access-Client-Id", connection.accessClientId);
    result.set("CF-Access-Client-Secret", connection.accessClientSecret);
  }
  return result;
}
function hasNoStore(response: Response): boolean {
  return (response.headers.get("Cache-Control") ?? "").split(",").some(value => value.trim().toLowerCase() === "no-store");
}
function trustedHeaders(response: Response, json: boolean): boolean {
  return hasNoStore(response) && !response.headers.has("Set-Cookie") && !response.headers.has("Location")
    && v4(response.headers.get("X-Request-ID")) && (!json || /^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? ""));
}
async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > RESPONSE_LIMIT)) {
    await response.body?.cancel(); throw new Error("response_limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("invalid_contract");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try { part = await reader.read(); } catch { throw new Error("transport"); }
      if (part.done) break;
      size += part.value.byteLength;
      if (size > RESPONSE_LIMIT) { await reader.cancel(); throw new Error("response_limit"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return parseDuplicateFreeJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("invalid_contract"); }
}
function statusFrom(response: Response): Missing | Tombstoned | Conflict | Blocked | Uncertain {
  if (!trustedHeaders(response, false)) return { status: "uncertain", reason: "invalid_contract", httpStatus: response.status };
  if (response.status === 404) return { status: "not_found" };
  if (response.status === 410) return { status: "tombstoned" };
  if (response.status === 409) return { status: "conflict" };
  if (response.status === 401 || response.status === 403) return { status: "blocked", reason: "credentials_or_scope" };
  return { status: "uncertain", reason: "http_status", httpStatus: response.status };
}
function profile(value: unknown, expectedKind: ProjectAlphaDirectoryReadKind, expectedPublicId: string, connection: Readonly<ProjectAlphaApiV2Connection>, requestId: string | null, sourceId: string): ProjectAlphaDirectoryProfileObservation | null {
  if (!plain(value) || !exact(value, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "authorizationGeneration", "resource", "data"])
    || value.apiVersion !== "2" || value.sourceInstanceId !== connection.expectedSourceInstanceId || value.applicationId !== connection.expectedApplicationId
    || value.historyEpoch !== connection.expectedHistoryEpoch || !v4(value.requestId) || value.requestId !== requestId || !revision(value.authorizationGeneration, true)
    || !plain(value.resource) || !exact(value.resource, ["type", "id", "revision"]) || value.resource.type !== expectedKind || value.resource.id !== expectedPublicId || !revision(value.resource.revision)
    || !plain(value.data)) return null;
  const dataFields = expectedKind === "client"
    ? ["publicId", "name", "email", "phone", "address", "clientType", "organizationPublicId"]
    : ["publicId", "name", "email", "phone", "address"];
  if (!exact(value.data, dataFields) || value.data.publicId !== expectedPublicId || !safeText(value.data.name) || !nullableText(value.data.email) || !nullableText(value.data.phone)
    || !plain(value.data.address) || !exact(value.data.address, ["line1", "line2", "city", "state", "postalCode", "country"])) return null;
  const address = value.data.address;
  const line1 = address.line1, line2 = address.line2, city = address.city, state = address.state, postalCode = address.postalCode, country = address.country;
  if (!nullableText(line1) || !nullableText(line2) || !nullableText(city) || !nullableText(state) || !nullableText(postalCode) || !nullableText(country)) return null;
  const result: { publicId: string; name: string; email: string | null; phone: string | null; address: { line1: string | null; line2: string | null; city: string | null; state: string | null; postalCode: string | null; country: string | null }; clientType?: "unknown" | "business" | "consumer"; organizationPublicId?: string | null } = { publicId: value.data.publicId, name: value.data.name, email: value.data.email, phone: value.data.phone,
    address: { line1, line2, city, state, postalCode, country } };
  if (expectedKind === "client") {
    if (!["unknown", "business", "consumer"].includes(value.data.clientType as string) || (value.data.organizationPublicId !== null && !publicId(value.data.organizationPublicId))) return null;
    result.clientType = value.data.clientType as "unknown" | "business" | "consumer";
    result.organizationPublicId = value.data.organizationPublicId as string | null;
  }
  return Object.freeze({ authoritative: false, sourceId, sourceInstanceId: connection.expectedSourceInstanceId, applicationId: connection.expectedApplicationId, historyEpoch: connection.expectedHistoryEpoch!,
    requestId: value.requestId, authorizationGeneration: value.authorizationGeneration, resource: Object.freeze({ type: expectedKind, id: value.resource.id, revision: value.resource.revision }), profile: Object.freeze(result) });
}
function binding(value: unknown, expectedKind: ProjectAlphaDirectoryReadKind, expectedExternalId: string, expectedPublicId: string, connection: Readonly<ProjectAlphaApiV2Connection>, requestId: string | null, sourceId: string): ProjectAlphaDirectoryBindingObservation | null {
  if (!plain(value) || !exact(value, ["apiVersion", "sourceInstanceId", "historyEpoch", "authorizationGeneration", "binding", "resource", "applicationId", "requestId"])
    || value.apiVersion !== "2" || value.sourceInstanceId !== connection.expectedSourceInstanceId || value.applicationId !== connection.expectedApplicationId || value.historyEpoch !== connection.expectedHistoryEpoch
    || !v4(value.requestId) || value.requestId !== requestId || !revision(value.authorizationGeneration, true) || !plain(value.binding) || !exact(value.binding, ["type", "externalId", "publicId", "createdAt"])
    || value.binding.type !== expectedKind || value.binding.externalId !== expectedExternalId || value.binding.publicId !== expectedPublicId || !canonicalTimestamp(value.binding.createdAt)
    || !plain(value.resource) || !exact(value.resource, ["revision", "present"]) || !revision(value.resource.revision) || value.resource.present !== true) return null;
  return Object.freeze({ authoritative: false, sourceId, sourceInstanceId: connection.expectedSourceInstanceId, applicationId: connection.expectedApplicationId, historyEpoch: connection.expectedHistoryEpoch!,
    requestId: value.requestId, authorizationGeneration: value.authorizationGeneration, binding: Object.freeze({ type: expectedKind, externalId: value.binding.externalId, publicId: value.binding.publicId, createdAt: value.binding.createdAt }), resource: Object.freeze({ revision: value.resource.revision, present: true }) });
}
function base64url(value: string): string {
  const bytes = new TextEncoder().encode(value); let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}
async function get(connection: Readonly<ProjectAlphaApiV2Connection>, path: string, send: typeof fetch): Promise<Response | Uncertain> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await send(new URL(path, connection.baseUrl), { method: "GET", headers: headers(connection), redirect: "manual", credentials: "omit", cache: "no-store", signal: controller.signal });
    if (response.redirected || (response.status >= 300 && response.status < 400)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", httpStatus: response.status }; }
    return response;
  }
  catch { return { status: "uncertain", reason: controller.signal.aborted ? "timeout" : "transport" }; }
  finally { clearTimeout(timer); }
}
function isUncertain(value: Response | Uncertain): value is Uncertain { return "status" in value && typeof value.status === "string"; }
function preflightOutcome(preflight: ProjectAlphaApiV2Probe): Blocked {
  return { status: "blocked", reason: preflight.status === "misconfigured" ? "configuration" : preflight.status === "unauthorized" ? "credentials_or_scope" : "preflight", preflight };
}

export async function readConfiguredProjectAlphaDirectoryProfile(
  env: ProjectAlphaApiV2ConnectionEnvironment,
  sourceId: string,
  kindValue: ProjectAlphaDirectoryReadKind,
  requestedPublicId: string,
  send: typeof fetch = fetch,
): Promise<ProjectAlphaDirectoryProfileReadOutcome> {
  if (!kind(kindValue) || !publicId(requestedPublicId)) return { status: "blocked", reason: "configuration" };
  const configured = await withEnabledConfiguredProjectAlphaApiV2Connection<ProjectAlphaDirectoryProfileReadOutcome>(env, sourceId, async connection => {
    const preflight = await probeProjectAlphaApiV2(connection, [], send, [endpoint(kindValue, false)]);
    if (preflight.status !== "verified") return preflightOutcome(preflight);
    const plural = kindValue === "client" ? "clients" : "organizations";
    const response = await get(connection, `/api/v2/directory/${plural}/${requestedPublicId}`, send);
    if (isUncertain(response)) return response;
    if (response.status !== 200) { await response.body?.cancel(); return statusFrom(response); }
    if (!trustedHeaders(response, true)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", httpStatus: response.status }; }
    const requestId = response.headers.get("X-Request-ID");
    try {
      const observed = profile(await boundedJson(response), kindValue, requestedPublicId, connection, requestId, sourceId);
      return observed ? { status: "observed", observation: observed } : { status: "uncertain", reason: "invalid_contract", httpStatus: 200 };
    } catch (error) { return { status: "uncertain", reason: error instanceof Error && error.message === "response_limit" ? "response_limit" : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract", httpStatus: 200 }; }
  });
  return configured.status === "enabled" ? configured.value : configured.status === "disabled" ? configured : { status: "blocked", reason: "configuration" };
}

export async function readConfiguredProjectAlphaDirectoryBindingStatus(
  env: ProjectAlphaApiV2ConnectionEnvironment,
  sourceId: string,
  kindValue: ProjectAlphaDirectoryReadKind,
  requestedExternalId: string,
  expectedPublicId: string,
  send: typeof fetch = fetch,
): Promise<ProjectAlphaDirectoryBindingStatusOutcome> {
  if (!kind(kindValue) || !externalId(requestedExternalId) || !publicId(expectedPublicId)) return { status: "blocked", reason: "configuration" };
  const configured = await withEnabledConfiguredProjectAlphaApiV2Connection<ProjectAlphaDirectoryBindingStatusOutcome>(env, sourceId, async connection => {
    const preflight = await probeProjectAlphaApiV2(connection, [], send, [endpoint(kindValue, true)]);
    if (preflight.status !== "verified") return preflightOutcome(preflight);
    const response = await get(connection, `/api/v2/bindings/${kindValue}/status/${base64url(requestedExternalId)}`, send);
    if (isUncertain(response)) return response;
    if (response.status !== 200) { await response.body?.cancel(); return statusFrom(response); }
    if (!trustedHeaders(response, true)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", httpStatus: response.status }; }
    const requestId = response.headers.get("X-Request-ID");
    try {
      const observed = binding(await boundedJson(response), kindValue, requestedExternalId, expectedPublicId, connection, requestId, sourceId);
      return observed ? { status: "observed", observation: observed } : { status: "uncertain", reason: "invalid_contract", httpStatus: 200 };
    } catch (error) { return { status: "uncertain", reason: error instanceof Error && error.message === "response_limit" ? "response_limit" : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract", httpStatus: 200 }; }
  });
  return configured.status === "enabled" ? configured.value : configured.status === "disabled" ? configured : { status: "blocked", reason: "configuration" };
}
