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

const REQUEST_LIMIT = 32 * 1024;
const RESPONSE_LIMIT = 64 * 1024;
const TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const MAX_INTEGER = "9223372036854775807";

export type ProjectAlphaDirectoryProfileKind = "client" | "organization";
export type ProjectAlphaDirectoryOrganizationProfile = Readonly<{
  name: string;
  generalEmail: string;
  generalPhone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}>;
export type ProjectAlphaDirectoryClientCreateProfile = Readonly<{
  name: string;
  email: string;
  phone: string;
  clientType: "unknown" | "business" | "consumer";
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}>;
export type ProjectAlphaDirectoryClientUpdateProfile = Readonly<{
  name: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}>;
export type ProjectAlphaDirectoryProfile = ProjectAlphaDirectoryOrganizationProfile | ProjectAlphaDirectoryClientUpdateProfile;

export type ProjectAlphaDirectoryProfileUpdateCommand = Readonly<{
  commandId: string;
  expectedRevision: string;
  expectedAuthorizationGeneration: string;
  profile: ProjectAlphaDirectoryProfile;
}>;
export type ProjectAlphaDirectoryClientCreateCommand = Readonly<{
  commandId: string;
  externalId: string;
  expectedAuthorizationGeneration: string;
  profile: ProjectAlphaDirectoryClientCreateProfile;
  organization: Readonly<{ externalId: string; expectedRevision: string }> | null;
}>;
export type ProjectAlphaDirectoryOrganizationCreateCommand = Readonly<{
  commandId: string;
  externalId: string;
  expectedAuthorizationGeneration: string;
  profile: ProjectAlphaDirectoryOrganizationProfile;
}>;
export type ProjectAlphaDirectoryCreateCommand = ProjectAlphaDirectoryClientCreateCommand | ProjectAlphaDirectoryOrganizationCreateCommand;

export type ProjectAlphaDirectoryProfileSuccess = Readonly<{
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  requestId: string;
  replayed: boolean;
  result: Readonly<{
    resource: Readonly<{ type: ProjectAlphaDirectoryProfileKind; publicId: string; revision: string }>;
    authorizationGeneration: string;
  }>;
}>;
export type ProjectAlphaDirectoryCreateSuccess = Readonly<{
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  requestId: string;
  replayed: boolean;
  result: Readonly<{
    resource: Readonly<{ type: ProjectAlphaDirectoryProfileKind; id: string; publicId: string; revision: string }>;
    authorizationGeneration: string;
  }>;
}>;

export type ProjectAlphaDirectoryProfileTransportFailure = Readonly<{
  status: "rejected" | "blocked" | "conflict" | "uncertain";
  reason: "invalid_command" | "request_limit" | "preflight" | "http_status" | "timeout" | "transport" | "response_limit" | "invalid_contract";
  httpStatus?: number;
  requestId?: string;
  preflight?: ProjectAlphaApiV2Probe;
}>;
export type ProjectAlphaDirectoryProfileOutcome =
  | Readonly<{ status: "acknowledged"; httpStatus: 200; response: ProjectAlphaDirectoryProfileSuccess }>
  | ProjectAlphaDirectoryProfileTransportFailure;
export type ProjectAlphaDirectoryCreateOutcome =
  | Readonly<{ status: "acknowledged"; httpStatus: 200 | 201; response: ProjectAlphaDirectoryCreateSuccess }>
  | ProjectAlphaDirectoryProfileTransportFailure;

function plain(value: unknown): value is Record<string, unknown> {
  try {
    return !!value && typeof value === "object" && !Array.isArray(value)
      && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  } catch { return false; }
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  try { return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)); }
  catch { return false; }
}
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function publicId(value: unknown): value is string { return typeof value === "string" && PUBLIC_ID.test(value); }
function revision(value: unknown, zero = false): value is string {
  return typeof value === "string" && (zero ? /^(?:0|[1-9][0-9]{0,18})$/ : /^[1-9][0-9]{0,18}$/).test(value)
    && (value.length < MAX_INTEGER.length || value <= MAX_INTEGER);
}
function advances(next: string, prior: string): boolean { try { return BigInt(next) >= BigInt(prior); } catch { return false; } }
function externalId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > 191 || /\p{C}/u.test(value)) return false;
  try {
    const bytes = new TextEncoder().encode(value);
    return bytes.byteLength <= 764 && new TextDecoder("utf-8", { fatal: true }).decode(bytes) === value;
  } catch { return false; }
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Array.from(value).length <= maximum && /\p{C}/u.test(value) === false
    && (() => { try { return new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) === value; } catch { return false; } })();
}
function nonEmptyProfile(profile: unknown, kind: ProjectAlphaDirectoryProfileKind, create: boolean): profile is ProjectAlphaDirectoryProfile | ProjectAlphaDirectoryClientCreateProfile {
  const fields = kind === "client"
    ? (create ? ["name", "email", "phone", "clientType", "addressLine1", "addressLine2", "city", "state", "postalCode", "country"] : ["name", "email", "phone", "addressLine1", "addressLine2", "city", "state", "postalCode", "country"])
    : ["name", "generalEmail", "generalPhone", "addressLine1", "addressLine2", "city", "state", "postalCode", "country"];
  if (!plain(profile) || !exact(profile, fields) || !fields.every(field => text(profile[field], field === "name" ? 150 : field === "state" ? (kind === "client" ? 2 : 100) : field === "postalCode" ? (kind === "client" ? 20 : 32) : field === "clientType" ? 8 : field === "email" || field === "generalEmail" ? 255 : field === "phone" || field === "generalPhone" ? 50 : field === "city" ? 100 : field === "country" ? 100 : 255))) return false;
  if (profile.name === "") return false;
  if (kind === "client" && create && !["unknown", "business", "consumer"].includes(profile.clientType as string)) return false;
  const email = kind === "client" ? profile.email : profile.generalEmail;
  return typeof email === "string" && (email === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}
function updateCommand(kind: ProjectAlphaDirectoryProfileKind, value: unknown): value is ProjectAlphaDirectoryProfileUpdateCommand {
  return plain(value) && exact(value, ["commandId", "expectedRevision", "expectedAuthorizationGeneration", "profile"])
    && uuid(value.commandId) && revision(value.expectedRevision) && revision(value.expectedAuthorizationGeneration, true)
    && nonEmptyProfile(value.profile, kind, false);
}
function createCommand(kind: ProjectAlphaDirectoryProfileKind, value: unknown): value is ProjectAlphaDirectoryCreateCommand {
  const fields = kind === "client" ? ["commandId", "externalId", "expectedAuthorizationGeneration", "profile", "organization"] : ["commandId", "externalId", "expectedAuthorizationGeneration", "profile"];
  if (!plain(value) || !exact(value, fields) || !uuid(value.commandId) || !externalId(value.externalId) || !revision(value.expectedAuthorizationGeneration, true) || !nonEmptyProfile(value.profile, kind, true)) return false;
  if (kind === "organization") return true;
  if (value.organization === null) return true;
  return plain(value.organization) && exact(value.organization, ["externalId", "expectedRevision"])
    && externalId(value.organization.externalId) && revision(value.organization.expectedRevision);
}
function endpoint(kind: ProjectAlphaDirectoryProfileKind, operation: "create" | "update"): ProjectAlphaApiV2Endpoint {
  const plural = kind === "client" ? "clients" : "organizations";
  return operation === "create"
    ? { method: "POST", path: `/api/v2/directory/${plural}/commands`, requiredCapability: `directory.${plural}.create`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true }
    : { method: "POST", path: `/api/v2/directory/${plural}/{publicId}/profile/commands`, requiredCapability: `directory.${plural}.write`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
}
function normalized(connection: ProjectAlphaApiV2Connection): ProjectAlphaApiV2Connection {
  return { ...connection, expectedSourceInstanceId: connection.expectedSourceInstanceId.toLowerCase(), expectedApplicationId: connection.expectedApplicationId.toLowerCase(), expectedHistoryEpoch: connection.expectedHistoryEpoch?.toLowerCase() };
}
function headers(connection: ProjectAlphaApiV2Connection): Headers {
  const result = new Headers({ Accept: "application/json", "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${connection.apiKey}`,
    "X-PA-Source-Instance-ID": connection.expectedSourceInstanceId, "X-PA-Application-ID": connection.expectedApplicationId, "X-PA-History-Epoch": connection.expectedHistoryEpoch! });
  if (connection.accessClientId && connection.accessClientSecret) { result.set("CF-Access-Client-Id", connection.accessClientId); result.set("CF-Access-Client-Secret", connection.accessClientSecret); }
  return result;
}
function diagnostic(response: Response): { httpStatus: number; requestId?: string } {
  const id = response.headers.get("X-Request-ID");
  return { httpStatus: response.status, ...(id && uuid(id) ? { requestId: id } : {}) };
}
function trusted(response: Response): boolean {
  return uuid(response.headers.get("X-Request-ID"))
    && (response.headers.get("Cache-Control") ?? "").split(",").some(value => value.trim().toLowerCase() === "no-store")
    && !response.headers.has("Set-Cookie") && !response.headers.has("Location")
    && /^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "");
}
async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > RESPONSE_LIMIT)) { await response.body?.cancel(); throw new Error("response_limit"); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("invalid_contract");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { let part: ReadableStreamReadResult<Uint8Array>; try { part = await reader.read(); } catch { throw new Error("transport"); } if (part.done) break; size += part.value.byteLength; if (size > RESPONSE_LIMIT) { await reader.cancel(); throw new Error("response_limit"); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return parseDuplicateFreeJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("invalid_contract"); }
}
function requestBody(value: unknown): string | null {
  try { const body = JSON.stringify(value); return new TextEncoder().encode(body).byteLength <= REQUEST_LIMIT ? body : null; } catch { return null; }
}
function preflightFailure(preflight: ProjectAlphaApiV2Probe): ProjectAlphaDirectoryProfileTransportFailure { return { status: "blocked", reason: "preflight", preflight }; }
function statusFailure(response: Response, expectedStatus: number | readonly number[]): ProjectAlphaDirectoryProfileTransportFailure {
  const info = diagnostic(response);
  if (response.redirected || (response.status >= 300 && response.status < 400)) return { status: "uncertain", reason: "invalid_contract", ...info };
  if (!trusted(response)) return { status: "uncertain", reason: "invalid_contract", ...info };
  if (response.status === 409) return { status: "conflict", reason: "http_status", ...info };
  if (response.status === 400 || response.status === 413 || response.status === 415) return { status: "rejected", reason: "http_status", ...info };
  if (response.status === 401 || response.status === 403) return { status: "blocked", reason: "http_status", ...info };
  return { status: "uncertain", reason: "http_status", ...info };
}
function profileSuccess(value: unknown, kind: ProjectAlphaDirectoryProfileKind, publicIdValue: string, command: ProjectAlphaDirectoryProfileUpdateCommand, connection: ProjectAlphaApiV2Connection, requestId: string | undefined): value is ProjectAlphaDirectoryProfileSuccess {
  if (!plain(value) || !exact(value, ["sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed", "result"]) || value.sourceInstanceId !== connection.expectedSourceInstanceId || value.applicationId !== connection.expectedApplicationId || value.historyEpoch !== connection.expectedHistoryEpoch || !uuid(value.requestId) || value.requestId !== requestId || typeof value.replayed !== "boolean" || !plain(value.result) || !exact(value.result, ["resource", "authorizationGeneration"]) || !revision(value.result.authorizationGeneration, true) || !plain(value.result.resource) || !exact(value.result.resource, ["type", "publicId", "revision"])) return false;
  return value.result.resource.type === kind && value.result.resource.publicId === publicIdValue && revision(value.result.resource.revision) && advances(value.result.resource.revision, command.expectedRevision);
}
function createSuccess(value: unknown, kind: ProjectAlphaDirectoryProfileKind, command: ProjectAlphaDirectoryCreateCommand, connection: ProjectAlphaApiV2Connection, requestId: string | undefined, httpStatus: number): value is ProjectAlphaDirectoryCreateSuccess {
  if (!plain(value) || !exact(value, ["sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed", "result"]) || value.sourceInstanceId !== connection.expectedSourceInstanceId || value.applicationId !== connection.expectedApplicationId || value.historyEpoch !== connection.expectedHistoryEpoch || !uuid(value.requestId) || value.requestId !== requestId || typeof value.replayed !== "boolean" || !plain(value.result) || !exact(value.result, ["resource", "authorizationGeneration"]) || !revision(value.result.authorizationGeneration) || !plain(value.result.resource) || !exact(value.result.resource, ["type", "id", "publicId", "revision"])) return false;
  return value.result.resource.type === kind && value.result.resource.id === command.externalId && publicId(value.result.resource.publicId)
    && value.result.resource.revision === "1" && (httpStatus === 201 ? value.replayed === false : value.replayed === true);
}
async function post(connection: ProjectAlphaApiV2Connection, path: string, body: string, expectedStatus: number | readonly number[], send: typeof fetch): Promise<Response | ProjectAlphaDirectoryProfileTransportFailure> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await send(new URL(path, connection.baseUrl), { method: "POST", headers: headers(connection), body, redirect: "manual", credentials: "omit", cache: "no-store", signal: controller.signal });
    if (response.redirected || (response.status >= 300 && response.status < 400)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...diagnostic(response) }; }
    const accepted = Array.isArray(expectedStatus) ? expectedStatus.includes(response.status) : response.status === expectedStatus;
    if (!accepted) { const failure = statusFailure(response, expectedStatus); await response.body?.cancel(); return failure; }
    if (!trusted(response)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...diagnostic(response) }; }
    return response;
  } catch { return { status: "uncertain", reason: controller.signal.aborted ? "timeout" : "transport" }; }
  finally { clearTimeout(timer); }
}
type Evidence = Readonly<{ commandJson: string; responseJson: string; destinationOrigin: string }>;
const acknowledgements = new WeakMap<object, Evidence>();
export function validatedProjectAlphaDirectoryProfileAcknowledgement<T extends ProjectAlphaDirectoryProfileSuccess | ProjectAlphaDirectoryCreateSuccess>(outcome: unknown): Readonly<{ response: T; command: ProjectAlphaDirectoryProfileUpdateCommand | ProjectAlphaDirectoryCreateCommand; destinationOrigin: string }> | null {
  if (!outcome || typeof outcome !== "object") return null;
  const evidence = acknowledgements.get(outcome);
  return evidence ? { response: JSON.parse(evidence.responseJson) as T, command: JSON.parse(evidence.commandJson), destinationOrigin: evidence.destinationOrigin } : null;
}

export function isProjectAlphaDirectoryProfileUpdateCommand(kind: ProjectAlphaDirectoryProfileKind, value: unknown): value is ProjectAlphaDirectoryProfileUpdateCommand { return updateCommand(kind, value); }
export function isProjectAlphaDirectoryCreateCommand(kind: ProjectAlphaDirectoryProfileKind, value: unknown): value is ProjectAlphaDirectoryCreateCommand { return createCommand(kind, value); }

export async function sendProjectAlphaDirectoryProfileUpdate(connectionInput: ProjectAlphaApiV2Connection, kind: ProjectAlphaDirectoryProfileKind, publicIdValue: string, inputCommand: ProjectAlphaDirectoryProfileUpdateCommand, send: typeof fetch = fetch): Promise<ProjectAlphaDirectoryProfileOutcome> {
  try {
    const connection = normalized(connectionInput);
    if ((kind !== "client" && kind !== "organization") || !publicId(publicIdValue) || !updateCommand(kind, inputCommand)) return { status: "rejected", reason: "invalid_command" };
    const body = requestBody(inputCommand); if (body === null) return { status: "rejected", reason: "request_limit" };
    if (typeof connection.expectedHistoryEpoch !== "string" || !uuid(connection.expectedHistoryEpoch)) return { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
    const required = endpoint(kind, "update"); const preflight = await probeProjectAlphaApiV2(connection, [], send, [required]); if (preflight.status !== "verified") return preflightFailure(preflight);
    const posted = await post(connection, required.path.replace("{publicId}", publicIdValue), body, 200, send); if (!(posted instanceof Response)) return posted;
    const info = diagnostic(posted);
    try { const parsed = await boundedJson(posted); if (!profileSuccess(parsed, kind, publicIdValue, inputCommand, connection, info.requestId)) return { status: "uncertain", reason: "invalid_contract", ...info }; const outcome = { status: "acknowledged" as const, httpStatus: 200 as const, response: parsed }; acknowledgements.set(outcome, { commandJson: body, responseJson: JSON.stringify(parsed), destinationOrigin: new URL(connection.baseUrl).origin }); return outcome; }
    catch (error) { return { status: "uncertain", reason: error instanceof Error && error.message === "response_limit" ? "response_limit" : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract", ...info }; }
  } catch { return { status: "rejected", reason: "invalid_command" }; }
}
export async function sendConfiguredProjectAlphaDirectoryProfileUpdate(env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, kind: ProjectAlphaDirectoryProfileKind, publicIdValue: string, command: ProjectAlphaDirectoryProfileUpdateCommand, send: typeof fetch = fetch): Promise<ProjectAlphaDirectoryProfileOutcome | Readonly<{ status: "disabled"; sourceId: string }>> {
  const configured = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId, connection => sendProjectAlphaDirectoryProfileUpdate(connection, kind, publicIdValue, command, send));
  return configured.status === "enabled" ? configured.value : configured.status === "disabled" ? configured : { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
}

export async function sendProjectAlphaDirectoryCreate(connectionInput: ProjectAlphaApiV2Connection, kind: ProjectAlphaDirectoryProfileKind, inputCommand: ProjectAlphaDirectoryCreateCommand, send: typeof fetch = fetch): Promise<ProjectAlphaDirectoryCreateOutcome> {
  try {
    const connection = normalized(connectionInput);
    if ((kind !== "client" && kind !== "organization") || !createCommand(kind, inputCommand)) return { status: "rejected", reason: "invalid_command" };
    const body = requestBody(inputCommand); if (body === null) return { status: "rejected", reason: "request_limit" };
    if (typeof connection.expectedHistoryEpoch !== "string" || !uuid(connection.expectedHistoryEpoch)) return { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
    const required = endpoint(kind, "create"); const preflight = await probeProjectAlphaApiV2(connection, [], send, [required]); if (preflight.status !== "verified") return preflightFailure(preflight);
    const posted = await post(connection, required.path, body, [200, 201], send); if (!(posted instanceof Response)) return posted;
    const info = diagnostic(posted);
    try { const parsed = await boundedJson(posted); if (!createSuccess(parsed, kind, inputCommand, connection, info.requestId, posted.status)) return { status: "uncertain", reason: "invalid_contract", ...info }; const outcome = { status: "acknowledged" as const, httpStatus: posted.status as 200 | 201, response: parsed }; acknowledgements.set(outcome, { commandJson: body, responseJson: JSON.stringify(parsed), destinationOrigin: new URL(connection.baseUrl).origin }); return outcome; }
    catch (error) { return { status: "uncertain", reason: error instanceof Error && error.message === "response_limit" ? "response_limit" : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract", ...info }; }
  } catch { return { status: "rejected", reason: "invalid_command" }; }
}
export async function sendConfiguredProjectAlphaDirectoryCreate(env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, kind: ProjectAlphaDirectoryProfileKind, command: ProjectAlphaDirectoryCreateCommand, send: typeof fetch = fetch): Promise<ProjectAlphaDirectoryCreateOutcome | Readonly<{ status: "disabled"; sourceId: string }>> {
  const configured = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId, connection => sendProjectAlphaDirectoryCreate(connection, kind, command, send));
  return configured.status === "enabled" ? configured.value : configured.status === "disabled" ? configured : { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
}
