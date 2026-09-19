import {
  probeProjectAlphaApiV2,
  type ProjectAlphaApiV2Connection,
  type ProjectAlphaApiV2Endpoint,
  type ProjectAlphaApiV2Probe,
} from "./project-alpha-api-v2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
const MAX_REVISION = "9223372036854775807";
const REQUEST_LIMIT = 32 * 1024;
const RESPONSE_LIMIT = 64 * 1024;

export type ProjectAlphaDirectoryBindingRevisionRefreshKind = "client" | "organization";
export type ProjectAlphaDirectoryBindingRevisionRefreshCommand = {
  commandId: string;
  externalId: string;
  expectedPriorRevision: string;
  expectedLiveRevision: string;
  expectedAuthorizationGeneration: string;
};
export type ProjectAlphaDirectoryBindingRevisionRefreshSuccess = {
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  requestId: string;
  replayed: boolean;
  result: {
    resource: { type: ProjectAlphaDirectoryBindingRevisionRefreshKind; id: string; revision: string };
    binding: { publicId: string; previousRevision: string; authorizationGeneration: string };
  };
};
export type ProjectAlphaDirectoryBindingRevisionRefreshOutcome =
  | { status: "acknowledged"; httpStatus: 200; response: ProjectAlphaDirectoryBindingRevisionRefreshSuccess }
  | { status: "rejected" | "blocked" | "conflict" | "uncertain"; reason: "invalid_command" | "request_limit" | "preflight" | "http_status" | "timeout" | "transport" | "response_limit" | "invalid_contract"; httpStatus?: number; requestId?: string; preflight?: ProjectAlphaApiV2Probe };

// This evidence is minted only after the bounded POST has passed the exact
// response contract. JSON-shaped outcomes supplied by callers cannot mint it.
const validatedAcknowledgements = new WeakMap<object, Readonly<{ commandJson: string; responseJson: string; destinationOrigin: string }>>();
export function validatedProjectAlphaDirectoryBindingRevisionRefreshAcknowledgement(outcome: ProjectAlphaDirectoryBindingRevisionRefreshOutcome): Readonly<{ command: ProjectAlphaDirectoryBindingRevisionRefreshCommand; response: ProjectAlphaDirectoryBindingRevisionRefreshSuccess; destinationOrigin: string }> | null {
  const snapshot = validatedAcknowledgements.get(outcome);
  return snapshot ? { command: JSON.parse(snapshot.commandJson) as ProjectAlphaDirectoryBindingRevisionRefreshCommand,
    response: JSON.parse(snapshot.responseJson) as ProjectAlphaDirectoryBindingRevisionRefreshSuccess, destinationOrigin: snapshot.destinationOrigin } : null;
}

function plain(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    return Reflect.ownKeys(value).every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && "value" in Object.getOwnPropertyDescriptor(value, key)!);
  } catch { return false; }
}
function keys(value: Record<string, unknown>, fields: readonly string[]): boolean { return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)); }
function positiveRevision(value: unknown): value is string { return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && (value.length < MAX_REVISION.length || value <= MAX_REVISION); }
function generation(value: unknown): value is string { return typeof value === "string" && /^(?:0|[1-9][0-9]{0,18})$/.test(value) && (value.length < MAX_REVISION.length || value <= MAX_REVISION); }
function increment(value: string): string | null {
  if (!generation(value) || value === MAX_REVISION) return null;
  const digits = value.split(""); let carry = 1;
  for (let index = digits.length - 1; index >= 0 && carry; index--) { const next = digits[index]!.charCodeAt(0) - 48 + carry; digits[index] = String(next % 10); carry = next === 10 ? 1 : 0; }
  return (carry ? "1" : "") + digits.join("");
}
function advances(live: string, prior: string): boolean { return live.length > prior.length || (live.length === prior.length && live > prior); }
function externalId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > 191 || new TextEncoder().encode(value).byteLength > 764 || /\p{C}/u.test(value)) return false;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) === value; } catch { return false; }
}
function endpoint(kind: ProjectAlphaDirectoryBindingRevisionRefreshKind): ProjectAlphaApiV2Endpoint {
  const plural = kind === "client" ? "clients" : "organizations";
  return { method: "POST", path: `/api/v2/directory/${plural}/bindings/revisions/commands`, requiredCapability: `directory.${plural}.binding.revision.refresh`, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true };
}

export function isProjectAlphaDirectoryBindingRevisionRefreshCommand(value: unknown): value is ProjectAlphaDirectoryBindingRevisionRefreshCommand {
  return plain(value) && keys(value, ["commandId", "externalId", "expectedPriorRevision", "expectedLiveRevision", "expectedAuthorizationGeneration"])
    && typeof value.commandId === "string" && UUID.test(value.commandId) && externalId(value.externalId)
    && positiveRevision(value.expectedPriorRevision) && positiveRevision(value.expectedLiveRevision)
    && advances(value.expectedLiveRevision, value.expectedPriorRevision) && generation(value.expectedAuthorizationGeneration)
    && increment(value.expectedAuthorizationGeneration) !== null;
}
function success(value: unknown, kind: ProjectAlphaDirectoryBindingRevisionRefreshKind, command: ProjectAlphaDirectoryBindingRevisionRefreshCommand, connection: ProjectAlphaApiV2Connection, requestId: string | null): value is ProjectAlphaDirectoryBindingRevisionRefreshSuccess {
  return plain(value) && keys(value, ["sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed", "result"])
    && value.sourceInstanceId === connection.expectedSourceInstanceId && value.applicationId === connection.expectedApplicationId && value.historyEpoch === connection.expectedHistoryEpoch
    && typeof value.requestId === "string" && UUID.test(value.requestId) && value.requestId === requestId && typeof value.replayed === "boolean"
    && plain(value.result) && keys(value.result, ["resource", "binding"]) && plain(value.result.resource) && keys(value.result.resource, ["type", "id", "revision"])
    && value.result.resource.type === kind && value.result.resource.id === command.externalId && value.result.resource.revision === command.expectedLiveRevision && positiveRevision(value.result.resource.revision)
    && plain(value.result.binding) && keys(value.result.binding, ["publicId", "previousRevision", "authorizationGeneration"])
    && typeof value.result.binding.publicId === "string" && PUBLIC_ID.test(value.result.binding.publicId)
    && value.result.binding.previousRevision === command.expectedPriorRevision && positiveRevision(value.result.binding.previousRevision)
    && value.result.binding.authorizationGeneration === increment(command.expectedAuthorizationGeneration);
}
async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("Content-Length"); if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > RESPONSE_LIMIT)) { await response.body?.cancel(); throw new Error("response_limit"); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("invalid_contract"); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read().catch(() => { throw new Error("transport"); }); if (part.done) break; size += part.value.byteLength; if (size > RESPONSE_LIMIT) { await reader.cancel(); throw new Error("response_limit"); } chunks.push(part.value); } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** One bounded, default-off transport attempt. It neither stores a receipt nor changes local mappings, links, or authority. */
export async function sendProjectAlphaDirectoryBindingRevisionRefreshCommand(inputConnection: ProjectAlphaApiV2Connection, kind: ProjectAlphaDirectoryBindingRevisionRefreshKind, inputCommand: ProjectAlphaDirectoryBindingRevisionRefreshCommand, send: typeof fetch = fetch): Promise<ProjectAlphaDirectoryBindingRevisionRefreshOutcome> {
  let command: ProjectAlphaDirectoryBindingRevisionRefreshCommand, connection: ProjectAlphaApiV2Connection, body: string;
  try {
    if ((kind !== "client" && kind !== "organization") || !isProjectAlphaDirectoryBindingRevisionRefreshCommand(inputCommand)) return { status: "rejected", reason: "invalid_command" };
    body = JSON.stringify(inputCommand); if (new TextEncoder().encode(body).byteLength > REQUEST_LIMIT) return { status: "rejected", reason: "request_limit" };
    command = JSON.parse(body) as ProjectAlphaDirectoryBindingRevisionRefreshCommand; if (!isProjectAlphaDirectoryBindingRevisionRefreshCommand(command)) return { status: "rejected", reason: "invalid_command" };
    connection = { ...inputConnection, expectedSourceInstanceId: inputConnection.expectedSourceInstanceId.toLowerCase(), expectedApplicationId: inputConnection.expectedApplicationId.toLowerCase() };
    if (typeof connection.expectedHistoryEpoch !== "string" || !UUID.test(connection.expectedHistoryEpoch)) return { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
  } catch { return { status: "rejected", reason: "invalid_command" }; }
  const preflight = await probeProjectAlphaApiV2(connection, [], send, [endpoint(kind)]); if (preflight.status !== "verified") return { status: "blocked", reason: "preflight", preflight };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000); let response: Response | undefined;
  try {
    const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${connection.apiKey}`, "X-PA-Source-Instance-ID": connection.expectedSourceInstanceId, "X-PA-Application-ID": connection.expectedApplicationId, "X-PA-History-Epoch": connection.expectedHistoryEpoch });
    if (connection.accessClientId && connection.accessClientSecret) { headers.set("CF-Access-Client-Id", connection.accessClientId); headers.set("CF-Access-Client-Secret", connection.accessClientSecret); }
    response = await send(new URL(endpoint(kind).path, connection.baseUrl), { method: "POST", headers, body, redirect: "manual", credentials: "omit", cache: "no-store", signal: controller.signal });
    const candidate = response.headers.get("X-Request-ID"), diagnostic = { httpStatus: response.status, ...(candidate && UUID.test(candidate) ? { requestId: candidate } : {}) };
    if (response.redirected || (response.status >= 300 && response.status < 400)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...diagnostic }; }
    if (response.status !== 200) { await response.body?.cancel(); return { status: response.status >= 500 || response.status < 400 ? "uncertain" : response.status === 409 ? "conflict" : [400, 413, 415].includes(response.status) ? "rejected" : "blocked", reason: "http_status", ...diagnostic }; }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "") || !(response.headers.get("Cache-Control") ?? "").split(",").some(part => part.trim().toLowerCase() === "no-store") || response.headers.has("Set-Cookie") || response.headers.has("Location")) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...diagnostic }; }
    const parsed = await boundedJson(response); if (!success(parsed, kind, command, connection, candidate)) return { status: "uncertain", reason: "invalid_contract", ...diagnostic };
    const acknowledged: ProjectAlphaDirectoryBindingRevisionRefreshOutcome = { status: "acknowledged", httpStatus: 200, response: parsed };
    // Store detached evidence so mutations of the returned public result do
    // not change what a future ledger settlement can authenticate.
    validatedAcknowledgements.set(acknowledged, Object.freeze({ commandJson: body, responseJson: JSON.stringify(parsed), destinationOrigin: new URL(connection.baseUrl).origin }));
    return acknowledged;
  } catch (error) { if (controller.signal.aborted) return { status: "uncertain", reason: "timeout" }; if (error instanceof Error && error.message === "response_limit") return { status: "uncertain", reason: "response_limit" }; if (error instanceof Error && error.message === "transport") return { status: "uncertain", reason: "transport" }; return { status: "uncertain", reason: response ? "invalid_contract" : "transport" }; }
  finally { clearTimeout(timer); }
}
