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
const RESPONSE_LIMIT = 256 * 1024;
const COMMAND_RESPONSE_LIMIT = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_INTEGER = "9223372036854775807";
const EXTERNAL_ID_MAX_CHARS = 191;
const EXTERNAL_ID_MAX_BYTES = 764;
const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;

export type ProjectAlphaDirectoryCommandKind = "client" | "organization";
export type ProjectAlphaDirectoryLifecycleAction = "archive" | "restore";
export type ProjectAlphaDirectoryLifecycleCommand = Readonly<{
  commandId: string;
  expectedRevision: string;
  expectedAuthorizationGeneration: string;
}>;
export type ProjectAlphaDirectoryRelationshipAction = "assign" | "remove" | "move";
export type ProjectAlphaDirectoryRelationshipCommand = Readonly<{
  commandId: string;
  expectedClientRevision: string;
  expectedAuthorizationGeneration: string;
  expectedCurrentOrganizationPublicId: string | null;
  organization: Readonly<{ externalId: string; publicId: string; expectedRevision: string }> | null;
}>;
export type ProjectAlphaDirectoryBindingRevokeCommand = Readonly<{
  commandId: string;
  externalId: string;
  expectedPublicId: string;
  expectedRevision: string;
  expectedAuthorizationGeneration: string;
}>;
export type ProjectAlphaDirectoryCommand = ProjectAlphaDirectoryLifecycleCommand | ProjectAlphaDirectoryRelationshipCommand | ProjectAlphaDirectoryBindingRevokeCommand;

export type ProjectAlphaDirectoryLifecycleSuccess = Readonly<{
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  requestId: string;
  replayed: boolean;
  result: Readonly<{
    action: ProjectAlphaDirectoryLifecycleAction;
    resource: Readonly<{ type: ProjectAlphaDirectoryCommandKind; publicId: string; revision: string; present: boolean }>;
    authorizationGeneration: string;
  }>;
}>;
export type ProjectAlphaDirectoryRelationshipSuccess = Readonly<{
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  requestId: string;
  replayed: boolean;
  result: Readonly<{
    action: ProjectAlphaDirectoryRelationshipAction;
    client: Readonly<{ publicId: string; revision: string }>;
    organizationPublicId: string | null;
    authorizationGeneration: string;
  }>;
}>;
export type ProjectAlphaDirectoryBindingRevokeSuccess = Readonly<{
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  requestId: string;
  replayed: boolean;
  result: Readonly<{
    action: "revoke";
    binding: Readonly<{ resourceType: ProjectAlphaDirectoryCommandKind; externalId: string; publicId: string; resourceRevision: string; status: "tombstoned" }>;
    authorizationGeneration: string;
  }>;
}>;

export type ProjectAlphaDirectoryTransportFailure = Readonly<{
  status: "rejected" | "blocked" | "conflict" | "uncertain";
  reason: "invalid_command" | "request_limit" | "preflight" | "http_status" | "timeout" | "transport" | "response_limit" | "invalid_contract";
  httpStatus?: number;
  requestId?: string;
  preflight?: ProjectAlphaApiV2Probe;
}>;
export type ProjectAlphaDirectoryLifecycleOutcome =
  | Readonly<{ status: "acknowledged"; httpStatus: 200; response: ProjectAlphaDirectoryLifecycleSuccess }>
  | ProjectAlphaDirectoryTransportFailure;
export type ProjectAlphaDirectoryRelationshipOutcome =
  | Readonly<{ status: "acknowledged"; httpStatus: 200; response: ProjectAlphaDirectoryRelationshipSuccess }>
  | ProjectAlphaDirectoryTransportFailure;
export type ProjectAlphaDirectoryBindingRevokeOutcome =
  | Readonly<{ status: "acknowledged"; httpStatus: 200; response: ProjectAlphaDirectoryBindingRevokeSuccess }>
  | ProjectAlphaDirectoryTransportFailure;

export type ProjectAlphaDirectoryInventoryResource = Readonly<{
  type: ProjectAlphaDirectoryCommandKind;
  publicId: string;
  revision: string;
  present: boolean;
  lastAction: "upsert" | "delete";
  projectionSha256: string;
  binding: Readonly<{ externalId: string; status: "active" | "tombstoned"; resourceRevision: string }> | null;
}>;
export type ProjectAlphaDirectoryInventorySuccess = Readonly<{
  authoritative: false;
  sourceId: string;
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  requestId: string;
  authorizationGeneration: string;
  resources: readonly ProjectAlphaDirectoryInventoryResource[];
  nextCursor: string | null;
}>;
export type ProjectAlphaDirectoryInventoryQuery = Readonly<{
  type?: "all" | ProjectAlphaDirectoryCommandKind;
  cursor?: string | null;
  limit?: number;
}>;
export type ProjectAlphaDirectoryInventoryOutcome =
  | Readonly<{ status: "observed"; inventory: ProjectAlphaDirectoryInventorySuccess }>
  | Readonly<{ status: "disabled"; sourceId: string }>
  | Readonly<{ status: "blocked"; reason: "configuration" | "preflight" | "credentials_or_scope"; preflight?: ProjectAlphaApiV2Probe }>
  | Readonly<{ status: "uncertain"; reason: "transport" | "timeout" | "response_limit" | "invalid_contract" | "http_status"; httpStatus?: number }>;

function plain(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    return Reflect.ownKeys(value).every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && "value" in Object.getOwnPropertyDescriptor(value, key)!);
  } catch { return false; }
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  try { return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)); } catch { return false; }
}
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function publicId(value: unknown): value is string { return typeof value === "string" && PUBLIC_ID.test(value); }
function revision(value: unknown, zero = false): value is string {
  return typeof value === "string" && (zero ? /^(?:0|[1-9][0-9]{0,18})$/ : /^[1-9][0-9]{0,18}$/).test(value)
    && (value.length < MAX_INTEGER.length || value <= MAX_INTEGER);
}
function externalId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > EXTERNAL_ID_MAX_CHARS || /\p{C}/u.test(value)) return false;
  try {
    const bytes = new TextEncoder().encode(value);
    return bytes.byteLength <= EXTERNAL_ID_MAX_BYTES && new TextDecoder("utf-8", { fatal: true }).decode(bytes) === value;
  } catch { return false; }
}
function advances(next: string, prior: string): boolean { return next.length > prior.length || (next.length === prior.length && next > prior); }
function increment(value: string): string | null {
  if (!revision(value, true) || value === MAX_INTEGER) return null;
  const digits = value.split(""); let carry = 1;
  for (let i = digits.length - 1; i >= 0 && carry; i--) { const n = digits[i]!.charCodeAt(0) - 48 + carry; digits[i] = String(n % 10); carry = n === 10 ? 1 : 0; }
  return (carry ? "1" : "") + digits.join("");
}
function endpoint(kind: ProjectAlphaDirectoryCommandKind, action: ProjectAlphaDirectoryLifecycleAction): ProjectAlphaApiV2Endpoint {
  const plural = kind === "client" ? "clients" : "organizations";
  return { method: "POST", path: `/api/v2/directory/${plural}/{publicId}/${action}/commands`, requiredCapability: `directory.${plural}.${action}`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
}
function relationshipEndpoint(action: ProjectAlphaDirectoryRelationshipAction): ProjectAlphaApiV2Endpoint {
  return { method: "POST", path: `/api/v2/directory/clients/{publicId}/organization/${action}/commands`, requiredCapability: `directory.clients.organization.${action}`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
}
function revokeEndpoint(kind: ProjectAlphaDirectoryCommandKind): ProjectAlphaApiV2Endpoint {
  const plural = kind === "client" ? "clients" : "organizations";
  return { method: "POST", path: `/api/v2/directory/${plural}/bindings/revoke/commands`, requiredCapability: `directory.${plural}.unbind`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
}
const inventoryEndpoint: ProjectAlphaApiV2Endpoint = { method: "GET", path: "/api/v2/directory/inventory", requiredCapability: "directory.inventory.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };

export function isProjectAlphaDirectoryLifecycleCommand(value: unknown): value is ProjectAlphaDirectoryLifecycleCommand {
  return plain(value) && exact(value, ["commandId", "expectedRevision", "expectedAuthorizationGeneration"])
    && uuid(value.commandId) && revision(value.expectedRevision) && revision(value.expectedAuthorizationGeneration, true);
}
export function isProjectAlphaDirectoryRelationshipCommand(action: ProjectAlphaDirectoryRelationshipAction, value: unknown): value is ProjectAlphaDirectoryRelationshipCommand {
  if (action !== "assign" && action !== "remove" && action !== "move") return false;
  if (!plain(value) || !exact(value, ["commandId", "expectedClientRevision", "expectedAuthorizationGeneration", "expectedCurrentOrganizationPublicId", "organization"])
    || !uuid(value.commandId) || !revision(value.expectedClientRevision) || !revision(value.expectedAuthorizationGeneration, true)) return false;
  const current = value.expectedCurrentOrganizationPublicId;
  if (current !== null && !publicId(current)) return false;
  if ((action === "assign" && current !== null) || (action !== "assign" && current === null)) return false;
  if (action === "remove") return value.organization === null;
  if (!plain(value.organization) || !exact(value.organization, ["externalId", "publicId", "expectedRevision"]) || !externalId(value.organization.externalId) || !publicId(value.organization.publicId) || !revision(value.organization.expectedRevision)) return false;
  return action !== "move" || value.organization.publicId !== current;
}
export function isProjectAlphaDirectoryBindingRevokeCommand(value: unknown): value is ProjectAlphaDirectoryBindingRevokeCommand {
  return plain(value) && exact(value, ["commandId", "externalId", "expectedPublicId", "expectedRevision", "expectedAuthorizationGeneration"])
    && uuid(value.commandId) && externalId(value.externalId) && publicId(value.expectedPublicId) && revision(value.expectedRevision)
    && revision(value.expectedAuthorizationGeneration, true);
}

function normalizedConnection(input: ProjectAlphaApiV2Connection): ProjectAlphaApiV2Connection {
  return { ...input, expectedSourceInstanceId: input.expectedSourceInstanceId.toLowerCase(), expectedApplicationId: input.expectedApplicationId.toLowerCase(), expectedHistoryEpoch: input.expectedHistoryEpoch?.toLowerCase() };
}
function commandBody(value: unknown): string | null {
  try { const body = JSON.stringify(value); return new TextEncoder().encode(body).byteLength <= REQUEST_LIMIT ? body : null; } catch { return null; }
}
function preflightOutcome(preflight: ProjectAlphaApiV2Probe): ProjectAlphaDirectoryTransportFailure {
  return { status: "blocked", reason: "preflight", preflight };
}
function diagnostic(response: Response): { httpStatus: number; requestId?: string } {
  const candidate = response.headers.get("X-Request-ID");
  return { httpStatus: response.status, ...(candidate && uuid(candidate) ? { requestId: candidate } : {}) };
}
function headers(connection: ProjectAlphaApiV2Connection): Headers {
  const result = new Headers({ Accept: "application/json", "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${connection.apiKey}`,
    "X-PA-Source-Instance-ID": connection.expectedSourceInstanceId, "X-PA-Application-ID": connection.expectedApplicationId, "X-PA-History-Epoch": connection.expectedHistoryEpoch! });
  if (connection.accessClientId && connection.accessClientSecret) { result.set("CF-Access-Client-Id", connection.accessClientId); result.set("CF-Access-Client-Secret", connection.accessClientSecret); }
  return result;
}
function trusted(response: Response, json: boolean): boolean {
  return uuid(response.headers.get("X-Request-ID")) && (response.headers.get("Cache-Control") ?? "").split(",").some(part => part.trim().toLowerCase() === "no-store")
    && !response.headers.has("Set-Cookie") && !response.headers.has("Location") && (!json || /^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? ""));
}
async function boundedJson(response: Response, maximum = RESPONSE_LIMIT): Promise<unknown> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximum)) { await response.body?.cancel(); throw new Error("response_limit"); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("invalid_contract");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { let part: ReadableStreamReadResult<Uint8Array>; try { part = await reader.read(); } catch { throw new Error("transport"); } if (part.done) break; size += part.value.byteLength; if (size > maximum) { await reader.cancel(); throw new Error("response_limit"); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return parseDuplicateFreeJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("invalid_contract"); }
}
async function post(connection: ProjectAlphaApiV2Connection, path: string, body: string, send: typeof fetch): Promise<Response | ProjectAlphaDirectoryTransportFailure> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000); let response: Response | undefined;
  try {
    response = await send(new URL(path, connection.baseUrl), { method: "POST", headers: headers(connection), body, redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal });
    const info = diagnostic(response);
    if (response.status !== 200) { await response.body?.cancel(); return { status: response.status === 409 ? "conflict" : response.status >= 500 ? "uncertain" : response.status === 401 || response.status === 403 ? "blocked" : response.status === 400 || response.status === 413 || response.status === 415 ? "rejected" : "uncertain", reason: "http_status", ...info }; }
    if (!trusted(response, true)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...info }; }
    return response;
  } catch { return { status: controller.signal.aborted ? "uncertain" : "uncertain", reason: controller.signal.aborted ? "timeout" : "transport" }; }
  finally { clearTimeout(timer); }
}
function lifecycleSuccess(value: unknown, kind: ProjectAlphaDirectoryCommandKind, action: ProjectAlphaDirectoryLifecycleAction, publicIdValue: string, command: ProjectAlphaDirectoryLifecycleCommand, connection: ProjectAlphaApiV2Connection, requestId: string | null): value is ProjectAlphaDirectoryLifecycleSuccess {
  if (!plain(value) || !exact(value, ["sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed", "result"]) || value.sourceInstanceId !== connection.expectedSourceInstanceId || value.applicationId !== connection.expectedApplicationId || value.historyEpoch !== connection.expectedHistoryEpoch || !uuid(value.requestId) || value.requestId !== requestId || typeof value.replayed !== "boolean" || !plain(value.result) || !exact(value.result, ["action", "resource", "authorizationGeneration"]) || value.result.action !== action || !revision(value.result.authorizationGeneration, true) || !plain(value.result.resource) || !exact(value.result.resource, ["type", "publicId", "revision", "present"])) return false;
  return value.result.resource.type === kind && value.result.resource.publicId === publicIdValue && publicId(value.result.resource.publicId)
    && revision(value.result.resource.revision) && advances(value.result.resource.revision, command.expectedRevision)
    && value.result.resource.present === (action === "restore")
    && (value.result.authorizationGeneration === command.expectedAuthorizationGeneration || advances(value.result.authorizationGeneration, command.expectedAuthorizationGeneration));
}
function relationshipSuccess(value: unknown, action: ProjectAlphaDirectoryRelationshipAction, publicIdValue: string, command: ProjectAlphaDirectoryRelationshipCommand, connection: ProjectAlphaApiV2Connection, requestId: string | null): value is ProjectAlphaDirectoryRelationshipSuccess {
  return plain(value) && exact(value, ["sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed", "result"]) && value.sourceInstanceId === connection.expectedSourceInstanceId && value.applicationId === connection.expectedApplicationId && value.historyEpoch === connection.expectedHistoryEpoch && uuid(value.requestId) && value.requestId === requestId && typeof value.replayed === "boolean" && plain(value.result) && exact(value.result, ["action", "client", "organizationPublicId", "authorizationGeneration"]) && value.result.action === action && revision(value.result.authorizationGeneration, true) && advances(value.result.authorizationGeneration, command.expectedAuthorizationGeneration) && plain(value.result.client) && exact(value.result.client, ["publicId", "revision"]) && value.result.client.publicId === publicIdValue && revision(value.result.client.revision) && advances(value.result.client.revision, command.expectedClientRevision) && (value.result.organizationPublicId === (command.organization === null ? null : command.organization.publicId));
}
function bindingSuccess(value: unknown, kind: ProjectAlphaDirectoryCommandKind, command: ProjectAlphaDirectoryBindingRevokeCommand, connection: ProjectAlphaApiV2Connection, requestId: string | null): value is ProjectAlphaDirectoryBindingRevokeSuccess {
  return plain(value) && exact(value, ["sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed", "result"]) && value.sourceInstanceId === connection.expectedSourceInstanceId && value.applicationId === connection.expectedApplicationId && value.historyEpoch === connection.expectedHistoryEpoch && uuid(value.requestId) && value.requestId === requestId && typeof value.replayed === "boolean" && plain(value.result) && exact(value.result, ["action", "binding", "authorizationGeneration"]) && value.result.action === "revoke" && revision(value.result.authorizationGeneration, true) && advances(value.result.authorizationGeneration, command.expectedAuthorizationGeneration) && plain(value.result.binding) && exact(value.result.binding, ["resourceType", "externalId", "publicId", "resourceRevision", "status"]) && value.result.binding.resourceType === kind && value.result.binding.externalId === command.externalId && value.result.binding.publicId === command.expectedPublicId && value.result.binding.resourceRevision === command.expectedRevision && value.result.binding.status === "tombstoned";
}

async function sendCommand<T>(connectionInput: ProjectAlphaApiV2Connection, endpointValue: ProjectAlphaApiV2Endpoint, requestPath: string, body: string, valid: (value: unknown, requestId: string | null, connection: ProjectAlphaApiV2Connection) => value is T, send: typeof fetch): Promise<{ outcome: ProjectAlphaDirectoryTransportFailure | { status: "acknowledged"; httpStatus: 200; response: T }; evidence?: { commandJson: string; responseJson: string; destinationOrigin: string } }> {
  let connection: ProjectAlphaApiV2Connection;
  try { connection = normalizedConnection(connectionInput); if (typeof connection.expectedHistoryEpoch !== "string" || !uuid(connection.expectedHistoryEpoch)) return { outcome: { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } } }; }
  catch { return { outcome: { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } } }; }
  const preflight = await probeProjectAlphaApiV2(connection, [], send, [endpointValue]); if (preflight.status !== "verified") return { outcome: preflightOutcome(preflight) };
  const posted = await post(connection, requestPath, body, send);
  if (!(posted instanceof Response)) return { outcome: posted };
  const info = diagnostic(posted);
  try { const parsed = await boundedJson(posted, COMMAND_RESPONSE_LIMIT); if (!valid(parsed, info.requestId ?? null, connection)) return { outcome: { status: "uncertain", reason: "invalid_contract", ...info } }; return { outcome: { status: "acknowledged", httpStatus: 200, response: parsed }, evidence: { commandJson: body, responseJson: JSON.stringify(parsed), destinationOrigin: new URL(connection.baseUrl).origin } }; }
  catch (error) { return { outcome: { status: "uncertain", reason: error instanceof Error && error.message === "response_limit" ? "response_limit" : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract", ...info } }; }
}

const validatedAcknowledgements = new WeakMap<object, Readonly<{ commandJson: string; responseJson: string; destinationOrigin: string }>>();
export function validatedProjectAlphaDirectoryCommandAcknowledgement<T extends ProjectAlphaDirectoryLifecycleSuccess | ProjectAlphaDirectoryRelationshipSuccess | ProjectAlphaDirectoryBindingRevokeSuccess>(outcome: unknown): Readonly<{ response: T; command: ProjectAlphaDirectoryCommand; destinationOrigin: string }> | null {
  if (!outcome || typeof outcome !== "object") return null;
  const evidence = validatedAcknowledgements.get(outcome);
  return evidence ? { response: JSON.parse(evidence.responseJson) as T, command: JSON.parse(evidence.commandJson), destinationOrigin: evidence.destinationOrigin } : null;
}

export async function sendProjectAlphaDirectoryLifecycleCommand(connection: ProjectAlphaApiV2Connection, kind: ProjectAlphaDirectoryCommandKind, publicIdValue: string, action: ProjectAlphaDirectoryLifecycleAction, inputCommand: ProjectAlphaDirectoryLifecycleCommand, send: typeof fetch = fetch): Promise<ProjectAlphaDirectoryLifecycleOutcome> {
  try { if ((kind !== "client" && kind !== "organization") || (action !== "archive" && action !== "restore") || !publicId(publicIdValue) || !isProjectAlphaDirectoryLifecycleCommand(inputCommand)) return { status: "rejected", reason: "invalid_command" }; const body = commandBody(inputCommand); if (body === null) return { status: "rejected", reason: "request_limit" }; const command = JSON.parse(body) as ProjectAlphaDirectoryLifecycleCommand; const required = endpoint(kind, action); const result = await sendCommand(connection, required, required.path.replace("{publicId}", publicIdValue), body, (value, requestId, normalized) => lifecycleSuccess(value, kind, action, publicIdValue, command, normalized, requestId), send); if (result.evidence && result.outcome.status === "acknowledged") validatedAcknowledgements.set(result.outcome, result.evidence); return result.outcome; } catch { return { status: "rejected", reason: "invalid_command" }; }
}
export async function sendConfiguredProjectAlphaDirectoryLifecycleCommand(env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, kind: ProjectAlphaDirectoryCommandKind, publicIdValue: string, action: ProjectAlphaDirectoryLifecycleAction, command: ProjectAlphaDirectoryLifecycleCommand, send: typeof fetch = fetch): Promise<ProjectAlphaDirectoryLifecycleOutcome | Readonly<{ status: "disabled"; sourceId: string }>> {
  const configured = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId, connection => sendProjectAlphaDirectoryLifecycleCommand(connection, kind, publicIdValue, action, command, send));
  return configured.status === "enabled" ? configured.value : configured.status === "disabled" ? configured : { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
}

export async function sendProjectAlphaDirectoryOrganizationRelationshipCommand(connection: ProjectAlphaApiV2Connection, publicIdValue: string, action: ProjectAlphaDirectoryRelationshipAction, inputCommand: ProjectAlphaDirectoryRelationshipCommand, send: typeof fetch = fetch): Promise<ProjectAlphaDirectoryRelationshipOutcome> {
  try { if ((action !== "assign" && action !== "remove" && action !== "move") || !publicId(publicIdValue) || !isProjectAlphaDirectoryRelationshipCommand(action, inputCommand)) return { status: "rejected", reason: "invalid_command" }; const body = commandBody(inputCommand); if (body === null) return { status: "rejected", reason: "request_limit" }; const command = JSON.parse(body) as ProjectAlphaDirectoryRelationshipCommand; const required = relationshipEndpoint(action); const result = await sendCommand(connection, required, required.path.replace("{publicId}", publicIdValue), body, (value, requestId, normalized) => relationshipSuccess(value, action, publicIdValue, command, normalized, requestId), send); if (result.evidence && result.outcome.status === "acknowledged") validatedAcknowledgements.set(result.outcome, result.evidence); return result.outcome; } catch { return { status: "rejected", reason: "invalid_command" }; }
}
export async function sendConfiguredProjectAlphaDirectoryOrganizationRelationshipCommand(env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, publicIdValue: string, action: ProjectAlphaDirectoryRelationshipAction, command: ProjectAlphaDirectoryRelationshipCommand, send: typeof fetch = fetch): Promise<ProjectAlphaDirectoryRelationshipOutcome | Readonly<{ status: "disabled"; sourceId: string }>> {
  const configured = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId, connection => sendProjectAlphaDirectoryOrganizationRelationshipCommand(connection, publicIdValue, action, command, send));
  return configured.status === "enabled" ? configured.value : configured.status === "disabled" ? configured : { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
}

export async function sendProjectAlphaDirectoryBindingRevokeCommand(connection: ProjectAlphaApiV2Connection, kind: ProjectAlphaDirectoryCommandKind, inputCommand: ProjectAlphaDirectoryBindingRevokeCommand, send: typeof fetch = fetch): Promise<ProjectAlphaDirectoryBindingRevokeOutcome> {
  try { if (kind !== "client" && kind !== "organization") return { status: "rejected", reason: "invalid_command" }; if (!isProjectAlphaDirectoryBindingRevokeCommand(inputCommand)) return { status: "rejected", reason: "invalid_command" }; const body = commandBody(inputCommand); if (body === null) return { status: "rejected", reason: "request_limit" }; const command = JSON.parse(body) as ProjectAlphaDirectoryBindingRevokeCommand; const required = revokeEndpoint(kind); const result = await sendCommand(connection, required, required.path, body, (value, requestId, normalized) => bindingSuccess(value, kind, command, normalized, requestId), send); if (result.evidence && result.outcome.status === "acknowledged") validatedAcknowledgements.set(result.outcome, result.evidence); return result.outcome; } catch { return { status: "rejected", reason: "invalid_command" }; }
}
export async function sendConfiguredProjectAlphaDirectoryBindingRevokeCommand(env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, kind: ProjectAlphaDirectoryCommandKind, command: ProjectAlphaDirectoryBindingRevokeCommand, send: typeof fetch = fetch): Promise<ProjectAlphaDirectoryBindingRevokeOutcome | Readonly<{ status: "disabled"; sourceId: string }>> {
  const configured = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId, connection => sendProjectAlphaDirectoryBindingRevokeCommand(connection, kind, command, send));
  return configured.status === "enabled" ? configured.value : configured.status === "disabled" ? configured : { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
}

function inventoryQuery(query: ProjectAlphaDirectoryInventoryQuery): { type: "all" | ProjectAlphaDirectoryCommandKind; cursor: string | null; limit: number } | null {
  if (!plain(query)) return null;
  const type = query.type ?? "all", cursor = query.cursor ?? null, limit = query.limit ?? 100;
  if (!plain(query) || !["all", "client", "organization"].includes(type) || (cursor !== null && !/^(client|organization):[0-9a-f]{32}$/.test(cursor)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) return null;
  if (cursor !== null && type !== "all" && !cursor.startsWith(`${type}:`)) return null;
  return { type: type as "all" | ProjectAlphaDirectoryCommandKind, cursor, limit };
}
function inventorySuccess(value: unknown, sourceId: string, query: { type: "all" | ProjectAlphaDirectoryCommandKind; cursor: string | null; limit: number }, connection: ProjectAlphaApiV2Connection, requestId: string | null): ProjectAlphaDirectoryInventorySuccess | null {
  if (!plain(value) || !exact(value, ["sourceInstanceId", "applicationId", "historyEpoch", "requestId", "authorizationGeneration", "resources", "nextCursor"]) || value.sourceInstanceId !== connection.expectedSourceInstanceId || value.applicationId !== connection.expectedApplicationId || typeof value.historyEpoch !== "string" || value.historyEpoch !== connection.expectedHistoryEpoch || !uuid(value.requestId) || value.requestId !== requestId || !revision(value.authorizationGeneration, true) || !Array.isArray(value.resources) || value.resources.length > query.limit || (value.nextCursor !== null && typeof value.nextCursor !== "string")) return null;
  const resources: ProjectAlphaDirectoryInventoryResource[] = []; let previous = query.cursor ?? "";
  for (const item of value.resources) {
    if (!plain(item) || !exact(item, ["type", "publicId", "revision", "present", "lastAction", "projectionSha256", "binding"]) || !["client", "organization"].includes(item.type as string) || !publicId(item.publicId) || !revision(item.revision) || typeof item.present !== "boolean" || !["upsert", "delete"].includes(item.lastAction as string) || typeof item.projectionSha256 !== "string" || !SHA256.test(item.projectionSha256) || (item.lastAction === "delete" && item.present !== false) || (item.lastAction === "upsert" && item.present !== true)) return null;
    const key = `${item.type}:${item.publicId}`; if (previous && key <= previous || query.type !== "all" && item.type !== query.type) return null; previous = key;
    if (item.binding !== null && (!plain(item.binding) || !exact(item.binding, ["externalId", "status", "resourceRevision"]) || !externalId(item.binding.externalId) || !["active", "tombstoned"].includes(item.binding.status as string) || !revision(item.binding.resourceRevision))) return null;
    resources.push(item as ProjectAlphaDirectoryInventoryResource);
  }
  if (value.nextCursor !== null && (resources.length === 0 || value.nextCursor !== previous || !/^(client|organization):[0-9a-f]{32}$/.test(value.nextCursor) || (query.type !== "all" && !value.nextCursor.startsWith(`${query.type}:`)))) return null;
  return Object.freeze({ authoritative: false, sourceId, sourceInstanceId: value.sourceInstanceId, applicationId: value.applicationId, historyEpoch: value.historyEpoch, requestId: value.requestId, authorizationGeneration: value.authorizationGeneration, resources: Object.freeze(resources), nextCursor: value.nextCursor });
}

export async function readProjectAlphaDirectoryInventory(connectionInput: ProjectAlphaApiV2Connection, sourceId: string, inputQuery: ProjectAlphaDirectoryInventoryQuery = {}, send: typeof fetch = fetch): Promise<ProjectAlphaDirectoryInventoryOutcome> {
  const query = inventoryQuery(inputQuery); if (!query || !SOURCE_ID.test(sourceId)) return { status: "blocked", reason: "configuration" };
  let connection: ProjectAlphaApiV2Connection; try { connection = normalizedConnection(connectionInput); if (typeof connection.expectedHistoryEpoch !== "string" || !uuid(connection.expectedHistoryEpoch)) return { status: "blocked", reason: "configuration" }; } catch { return { status: "blocked", reason: "configuration" }; }
  const preflight = await probeProjectAlphaApiV2(connection, [], send, [inventoryEndpoint]); if (preflight.status !== "verified") return { status: "blocked", reason: preflight.status === "unauthorized" ? "credentials_or_scope" : "preflight", preflight };
  const params = new URLSearchParams({ type: query.type, limit: String(query.limit) }); if (query.cursor !== null) params.set("cursor", query.cursor);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000); let response: Response | undefined;
  try {
    response = await send(new URL(`/api/v2/directory/inventory?${params.toString()}`, connection.baseUrl), { method: "GET", headers: new Headers({ Accept: "application/json", Authorization: `Bearer ${connection.apiKey}`, "X-PA-Source-Instance-ID": connection.expectedSourceInstanceId, "X-PA-Application-ID": connection.expectedApplicationId, "X-PA-History-Epoch": connection.expectedHistoryEpoch, ...(connection.accessClientId && connection.accessClientSecret ? { "CF-Access-Client-Id": connection.accessClientId, "CF-Access-Client-Secret": connection.accessClientSecret } : {}) }), redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal });
    const info = diagnostic(response); if (response.status !== 200) { await response.body?.cancel(); return { status: "uncertain", reason: "http_status", httpStatus: response.status }; }
    if (!trusted(response, true)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...info }; }
    const parsed = await boundedJson(response); const inventory = inventorySuccess(parsed, sourceId, query, connection, info.requestId ?? null); return inventory ? { status: "observed", inventory } : { status: "uncertain", reason: "invalid_contract", ...info };
  } catch (error) { return { status: "uncertain", reason: controller.signal.aborted ? "timeout" : error instanceof Error && error.message === "response_limit" ? "response_limit" : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract" }; }
  finally { clearTimeout(timer); }
}
export async function readConfiguredProjectAlphaDirectoryInventory(env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, query: ProjectAlphaDirectoryInventoryQuery = {}, send: typeof fetch = fetch): Promise<ProjectAlphaDirectoryInventoryOutcome> {
  const configured = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId, connection => readProjectAlphaDirectoryInventory(connection, sourceId, query, send));
  return configured.status === "enabled" ? configured.value : configured.status === "disabled" ? configured : { status: "blocked", reason: "configuration" };
}

// Short aliases make the dormant boundary easy to discover without creating a
// route import or accidentally wiring it into an existing event flow.
export const sendProjectAlphaDirectoryRelationshipCommand = sendProjectAlphaDirectoryOrganizationRelationshipCommand;
export const sendConfiguredProjectAlphaDirectoryRelationshipCommand = sendConfiguredProjectAlphaDirectoryOrganizationRelationshipCommand;
