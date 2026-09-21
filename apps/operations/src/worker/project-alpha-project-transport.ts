import { parseDuplicateFreeJson } from "./bounded-json";
import {
  probeProjectAlphaApiV2,
  type ProjectAlphaApiV2Connection,
  type ProjectAlphaApiV2Endpoint,
  type ProjectAlphaApiV2Probe,
} from "./project-alpha-api-v2";

export const PROJECT_ALPHA_PROJECT_RESPONSE_LIMIT = 64 * 1024;
export const PROJECT_ALPHA_PROJECT_REQUEST_LIMIT = 32 * 1024;
export const PROJECT_ALPHA_PROJECT_MAX_INTEGER = "9223372036854775807";
export const PROJECT_ALPHA_PROJECT_MAX_GENERATION = "9223372036854775807";
export const PROJECT_ALPHA_PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const PROJECT_ALPHA_PROJECT_PUBLIC_ID = /^[0-9a-f]{32}$/;
export const PROJECT_ALPHA_PROJECT_HASH = /^[0-9a-f]{64}$/;
export const PROJECT_ALPHA_PROJECT_CONFLICT_CODES = [
  "identity_conflict",
  "command_id_conflict",
  "authorization_generation_conflict",
  "external_binding_conflict",
  "relationship_proof_conflict",
  "resource_precondition_conflict",
  "database_constraint_conflict",
] as const;
export type ProjectAlphaProjectConflictCode = typeof PROJECT_ALPHA_PROJECT_CONFLICT_CODES[number];

export type ProjectAlphaProjectLifecycle = "not_started" | "active" | "completed" | "cancelled";
export type ProjectAlphaProjectCustomer = Readonly<{ organizationPublicId: string | null; clientPublicId: string | null }>;
export type ProjectAlphaProjectProfile = Readonly<{
  name: string;
  description: string | null;
  estimatedStart: string | null;
  estimatedEnd: string | null;
}>;
export type ProjectAlphaProjectRelationProof = Readonly<{
  externalId: string;
  expectedPublicId: string;
  expectedRevision: string;
  expectedProjectionSha256: string;
}>;
export type ProjectAlphaProjectFailure = Readonly<{
  status: "rejected" | "blocked" | "conflict" | "uncertain";
  reason: "invalid_command" | "request_limit" | "preflight" | "http_status" | "timeout" | "transport" | "response_limit" | "invalid_contract" | ProjectAlphaProjectConflictCode;
  httpStatus?: number;
  requestId?: string;
  preflight?: ProjectAlphaApiV2Probe;
}>;

export function plain(value: unknown): value is Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    return Reflect.ownKeys(value).every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && "value" in Object.getOwnPropertyDescriptor(value, key)!);
  } catch { return false; }
}
export function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  try { return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field)); } catch { return false; }
}
export function uuid(value: unknown): value is string { return typeof value === "string" && PROJECT_ALPHA_PROJECT_UUID.test(value); }
export function publicId(value: unknown): value is string { return typeof value === "string" && PROJECT_ALPHA_PROJECT_PUBLIC_ID.test(value); }
export function hash(value: unknown): value is string { return typeof value === "string" && PROJECT_ALPHA_PROJECT_HASH.test(value); }
export function decimal(value: unknown, positive = false): value is string {
  return typeof value === "string" && (positive ? /^[1-9][0-9]{0,18}$/.test(value) : /^(?:0|[1-9][0-9]{0,18})$/.test(value))
    && (value.length < PROJECT_ALPHA_PROJECT_MAX_INTEGER.length || value <= PROJECT_ALPHA_PROJECT_MAX_INTEGER);
}
export function generation(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,18})$/.test(value)
    && (value.length < PROJECT_ALPHA_PROJECT_MAX_GENERATION.length || value <= PROJECT_ALPHA_PROJECT_MAX_GENERATION);
}
export function externalId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > 191 || /\p{C}/u.test(value)) return false;
  try { const bytes = new TextEncoder().encode(value); return bytes.byteLength <= 764 && new TextDecoder("utf-8", { fatal: true }).decode(bytes) === value; } catch { return false; }
}
export function date(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
export function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "").length > 0 && Array.from(value).length <= maximum && !/\p{C}/u.test(value);
}
export function profile(value: unknown): value is ProjectAlphaProjectProfile {
  return plain(value) && exact(value, ["name", "description", "estimatedStart", "estimatedEnd"])
    && text(value.name, 150) && (value.description === null || (typeof value.description === "string" && Array.from(value.description).length <= 10000 && !/\p{C}/u.test(value.description)))
    && date(value.estimatedStart) && date(value.estimatedEnd)
    && !(typeof value.estimatedStart === "string" && typeof value.estimatedEnd === "string" && value.estimatedStart > value.estimatedEnd);
}
export function relation(value: unknown, required: boolean): value is ProjectAlphaProjectRelationProof | null {
  if (value === null) return !required;
  return plain(value) && exact(value, ["externalId", "expectedPublicId", "expectedRevision", "expectedProjectionSha256"])
    && externalId(value.externalId) && publicId(value.expectedPublicId) && decimal(value.expectedRevision, true) && hash(value.expectedProjectionSha256);
}
export function nextGeneration(value: string): string | null {
  if (!generation(value) || value === PROJECT_ALPHA_PROJECT_MAX_GENERATION) return null;
  const digits = value.split(""); let carry = 1;
  for (let i = digits.length - 1; i >= 0 && carry; i--) { const n = digits[i]!.charCodeAt(0) - 48 + carry; digits[i] = String(n % 10); carry = n === 10 ? 1 : 0; }
  return (carry ? "1" : "") + digits.join("");
}
export function advances(live: string, prior: string): boolean { return live.length > prior.length || (live.length === prior.length && live >= prior); }

export function canonicalConnection(input: ProjectAlphaApiV2Connection): ProjectAlphaApiV2Connection | null {
  try {
    const connection = { ...input, expectedSourceInstanceId: input.expectedSourceInstanceId.toLowerCase(), expectedApplicationId: input.expectedApplicationId.toLowerCase(), expectedHistoryEpoch: input.expectedHistoryEpoch?.toLowerCase() };
    return typeof connection.expectedHistoryEpoch === "string" && uuid(connection.expectedSourceInstanceId) && uuid(connection.expectedApplicationId) && uuid(connection.expectedHistoryEpoch) ? connection : null;
  } catch { return null; }
}
export function diagnostic(response: Response): { httpStatus: number; requestId?: string } {
  const value = response.headers.get("X-Request-ID"); return { httpStatus: response.status, ...(value && uuid(value) ? { requestId: value } : {}) };
}
export function trusted(response: Response, json: boolean): boolean {
  return uuid(response.headers.get("X-Request-ID")) && (response.headers.get("Cache-Control") ?? "").split(",").some(v => v.trim().toLowerCase() === "no-store")
    && !response.headers.has("Set-Cookie") && !response.headers.has("Location") && (!json || /^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? ""));
}
export async function boundedJson(response: Response, maximum = PROJECT_ALPHA_PROJECT_RESPONSE_LIMIT): Promise<unknown> {
  return (await boundedJsonWithBytes(response, maximum)).value;
}
export async function boundedJsonWithBytes(response: Response, maximum = PROJECT_ALPHA_PROJECT_RESPONSE_LIMIT): Promise<Readonly<{ value: unknown; bytes: Uint8Array }>> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximum)) { await response.body?.cancel(); throw new Error("response_limit"); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("invalid_contract");
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read().catch(() => { throw new Error("transport"); }); if (part.done) break; size += part.value.byteLength; if (size > maximum) { await reader.cancel(); throw new Error("response_limit"); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return Object.freeze({ value: parseDuplicateFreeJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), bytes }); } catch { throw new Error("invalid_contract"); }
}
export async function boundedJsonOrEmpty(response: Response, maximum = PROJECT_ALPHA_PROJECT_RESPONSE_LIMIT): Promise<Readonly<{ empty: true }> | Readonly<{ empty: false; value: unknown }>> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maximum)) { await response.body?.cancel(); throw new Error("response_limit"); }
  const reader = response.body?.getReader();
  if (!reader) {
    if (declared === null || Number(declared) === 0) return Object.freeze({ empty: true });
    throw new Error("invalid_contract");
  }
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const part = await reader.read().catch(() => { throw new Error("transport"); }); if (part.done) break; size += part.value.byteLength; if (size > maximum) { await reader.cancel(); throw new Error("response_limit"); } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  if (size === 0) {
    if (declared !== null && Number(declared) !== 0) throw new Error("invalid_contract");
    return Object.freeze({ empty: true });
  }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return Object.freeze({ empty: false, value: parseDuplicateFreeJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }); } catch { throw new Error("invalid_contract"); }
}
export function authHeaders(connection: ProjectAlphaApiV2Connection, contentType = false): Headers {
  const headers = new Headers({ Accept: "application/json", Authorization: `Bearer ${connection.apiKey}`, "X-PA-Source-Instance-ID": connection.expectedSourceInstanceId, "X-PA-Application-ID": connection.expectedApplicationId, "X-PA-History-Epoch": connection.expectedHistoryEpoch! });
  if (contentType) headers.set("Content-Type", "application/json; charset=utf-8");
  if (connection.accessClientId && connection.accessClientSecret) { headers.set("CF-Access-Client-Id", connection.accessClientId); headers.set("CF-Access-Client-Secret", connection.accessClientSecret); }
  return headers;
}
export function endpoint(method: string, path: string, requiredCapability: string, flags: Partial<ProjectAlphaApiV2Endpoint> = {}): ProjectAlphaApiV2Endpoint {
  return { method, path, requiredCapability, requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true, ...flags };
}
export function preflightFailure(preflight: ProjectAlphaApiV2Probe): ProjectAlphaProjectFailure { return { status: "blocked", reason: "preflight", preflight }; }
export async function post(connection: ProjectAlphaApiV2Connection, route: ProjectAlphaApiV2Endpoint, body: string, send: typeof fetch, accepted: readonly number[] = [200]): Promise<Response | ProjectAlphaProjectFailure> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000); let response: Response | undefined;
  try {
    response = await send(new URL(route.path, connection.baseUrl), { method: "POST", headers: authHeaders(connection, true), body, redirect: "manual", credentials: "omit", cache: "no-store", signal: controller.signal });
    const info = diagnostic(response);
    if (response.redirected || (response.status >= 300 && response.status < 400)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...info }; }
    if (!accepted.includes(response.status)) { await response.body?.cancel(); const status = response.status >= 500 || response.status < 400 ? "uncertain" : response.status === 409 ? "conflict" : [400, 413, 415].includes(response.status) ? "rejected" : "blocked"; return { status, reason: "http_status", ...info }; }
    if (!trusted(response, true)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...info }; }
    return response;
  } catch { return { status: "uncertain", reason: controller.signal.aborted ? "timeout" : "transport" }; }
  finally { clearTimeout(timer); }
}
export async function get(connection: ProjectAlphaApiV2Connection, path: string, send: typeof fetch): Promise<Response | ProjectAlphaProjectFailure> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await send(new URL(path, connection.baseUrl), { method: "GET", headers: authHeaders(connection), redirect: "manual", credentials: "omit", cache: "no-store", signal: controller.signal });
    if (response.redirected || (response.status >= 300 && response.status < 400)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...diagnostic(response) }; }
    return response;
  }
  catch { return { status: "uncertain", reason: controller.signal.aborted ? "timeout" : "transport" }; }
  finally { clearTimeout(timer); }
}
export function isFailure(value: Response | ProjectAlphaProjectFailure): value is ProjectAlphaProjectFailure { return "status" in value && typeof value.status === "string"; }
export async function runPreflight(connection: ProjectAlphaApiV2Connection, route: ProjectAlphaApiV2Endpoint, send: typeof fetch): Promise<ProjectAlphaProjectFailure | null> {
  const result = await probeProjectAlphaApiV2(connection, [], send, [route]); return result.status === "verified" ? null : preflightFailure(result);
}
