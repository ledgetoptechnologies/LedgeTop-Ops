import { boundedJsonWithBytes, canonicalConnection, date, decimal, diagnostic, endpoint, get, isFailure, plain, exact, hash, publicId, trusted, uuid, runPreflight, type ProjectAlphaProjectFailure } from "./project-alpha-project-transport";
import { withEnabledConfiguredProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";

export type ProjectAlphaProjectRead = Readonly<{ apiVersion: "2"; sourceInstanceId: string; applicationId: string; historyEpoch: string; requestId: string; replayed: false; accepted: boolean; resource: Readonly<{ type: "project"; id: string; revision: string; projectionSha256: string }>; data: Readonly<{ name: string; description: string | null; status: "not_started" | "active" | "completed" | "cancelled"; archived: boolean; overdueWarning: boolean; completedAt: string | null; archivedAt: string | null; estimatedStart: string | null; estimatedEnd: string | null; clientPublicId: string | null; organizationPublicId: string | null }> }>;
export type ProjectAlphaProjectReadOutcome = Readonly<{ status: "read"; httpStatus: 200; response: ProjectAlphaProjectRead }> | ProjectAlphaProjectFailure;
export type ValidatedProjectAlphaProjectRead = Readonly<{
  requestedPublicId: string;
  response: ProjectAlphaProjectRead;
  responseJson: string;
  destinationOrigin: string;
  responseSha256: string;
}>;
const ROUTE = endpoint("GET", "/api/v2/projects/{publicId}", "projects.v2.read");
const validatedReads = new WeakMap<object, Readonly<{
  requestedPublicId: string;
  responseJson: string;
  destinationOrigin: string;
  responseSha256: string;
}>>();
const settlementEvidence = new WeakSet<object>();

function deepFreezeJson<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
export function validatedProjectAlphaProjectRead(outcome: ProjectAlphaProjectReadOutcome): ValidatedProjectAlphaProjectRead | null {
  if (!outcome || typeof outcome !== "object") return null;
  const snapshot = validatedReads.get(outcome); if (!snapshot) return null;
  const evidence: ValidatedProjectAlphaProjectRead = Object.freeze({
    requestedPublicId: snapshot.requestedPublicId,
    response: deepFreezeJson(JSON.parse(snapshot.responseJson) as ProjectAlphaProjectRead),
    responseJson: snapshot.responseJson,
    destinationOrigin: snapshot.destinationOrigin,
    responseSha256: snapshot.responseSha256,
  });
  settlementEvidence.add(evidence);
  return evidence;
}
/** Identity-gated handoff for the dormant canonical settlement adapter. */
export function privateProjectAlphaProjectReadEvidence(value: unknown): ValidatedProjectAlphaProjectRead | null {
  return !!value && typeof value === "object" && settlementEvidence.has(value) ? value as ValidatedProjectAlphaProjectRead : null;
}
function timestamp(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !/^(?:[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z|[1-9]\d{3}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{6})?)$/.test(value)) return false;
  const normalized = value.includes(" ")
    ? `${value.replace(" ", "T").replace(/\.(\d{3})\d{3}$/, ".$1").replace(/(?<!\.\d{3})$/, ".000")}Z`
    : value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z");
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === normalized;
}
function valid(value: unknown, id: string, connection: ProjectAlphaApiV2Connection, requestId: string | null): value is ProjectAlphaProjectRead {
  if (!plain(value) || !exact(value, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed", "accepted", "resource", "data"]) || value.apiVersion !== "2" || value.sourceInstanceId !== connection.expectedSourceInstanceId || value.applicationId !== connection.expectedApplicationId || value.historyEpoch !== connection.expectedHistoryEpoch || !uuid(value.requestId) || value.requestId !== requestId || value.replayed !== false || value.accepted !== true || !plain(value.resource) || !exact(value.resource, ["type", "id", "revision", "projectionSha256"]) || value.resource.type !== "project" || value.resource.id !== id || !publicId(value.resource.id) || !decimal(value.resource.revision, true) || !hash(value.resource.projectionSha256) || !plain(value.data)) return false;
  const d = value.data;
  return exact(d, ["name", "description", "status", "archived", "overdueWarning", "completedAt", "archivedAt", "estimatedStart", "estimatedEnd", "clientPublicId", "organizationPublicId"])
    && typeof d.name === "string" && d.name.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "").length > 0 && Array.from(d.name).length <= 150 && !/\p{C}/u.test(d.name)
    && (d.description === null || typeof d.description === "string" && Array.from(d.description).length <= 10000 && !/\p{C}/u.test(d.description)) && (d.status === "not_started" || d.status === "active" || d.status === "completed" || d.status === "cancelled") && typeof d.archived === "boolean" && typeof d.overdueWarning === "boolean" && timestamp(d.completedAt) && timestamp(d.archivedAt) && date(d.estimatedStart) && date(d.estimatedEnd)
    && !(typeof d.estimatedStart === "string" && typeof d.estimatedEnd === "string" && d.estimatedStart > d.estimatedEnd)
    && (d.status === "completed") === (d.completedAt !== null) && d.archived === (d.archivedAt !== null)
    && (d.clientPublicId === null || publicId(d.clientPublicId)) && (d.organizationPublicId === null || publicId(d.organizationPublicId));
}
export async function readProjectAlphaProject(connectionInput: ProjectAlphaApiV2Connection, requestedPublicId: string, fetcher: typeof fetch = fetch): Promise<ProjectAlphaProjectReadOutcome> {
  if (!publicId(requestedPublicId)) return { status: "rejected", reason: "invalid_command" };
  const connection = canonicalConnection(connectionInput); if (!connection) return { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
  const preflight = await runPreflight(connection, ROUTE, fetcher); if (preflight) return preflight;
  const response = await get(connection, `/api/v2/projects/${requestedPublicId}`, fetcher); if (isFailure(response)) return response;
  const info = diagnostic(response);
  if (response.status !== 200) { await response.body?.cancel(); if (response.status === 409) return { status: "conflict", reason: "http_status", ...info }; return { status: response.status >= 500 ? "uncertain" : "blocked", reason: "http_status", ...info }; }
  if (!trusted(response, true)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...info }; }
  try {
    const decoded = await boundedJsonWithBytes(response), parsed = decoded.value;
    if (!valid(parsed, requestedPublicId, connection, response.headers.get("X-Request-ID"))) return { status: "uncertain", reason: "invalid_contract", ...info };
    const outcome: ProjectAlphaProjectReadOutcome = { status: "read", httpStatus: 200, response: parsed };
    validatedReads.set(outcome, Object.freeze({
      requestedPublicId,
      responseJson: new TextDecoder("utf-8", { fatal: true }).decode(decoded.bytes),
      destinationOrigin: new URL(connection.baseUrl).origin,
      responseSha256: await sha256(decoded.bytes),
    }));
    return outcome;
  }
  catch (error) { return { status: "uncertain", reason: error instanceof Error && error.message === "response_limit" ? "response_limit" : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract", ...info }; }
}
export async function readConfiguredProjectAlphaProject(env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, requestedPublicId: string, fetcher: typeof fetch = fetch): Promise<ProjectAlphaProjectReadOutcome | Readonly<{ status: "disabled"; sourceId: string }>> {
  const result = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId, connection => readProjectAlphaProject(connection, requestedPublicId, fetcher));
  return result.status === "enabled" ? result.value : result.status === "disabled" ? result : { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
}
