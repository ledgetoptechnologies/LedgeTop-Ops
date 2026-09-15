import { boundedJson, canonicalConnection, date, decimal, diagnostic, endpoint, get, isFailure, plain, exact, hash, profile, publicId, trusted, uuid, preflightFailure, runPreflight, type ProjectAlphaProjectFailure } from "./project-alpha-project-transport";
import { withEnabledConfiguredProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";

export type ProjectAlphaProjectRead = Readonly<{ apiVersion: "2"; sourceInstanceId: string; applicationId: string; historyEpoch: string; requestId: string; replayed: false; accepted: boolean; resource: Readonly<{ type: "project"; id: string; revision: string; projectionSha256: string }>; data: Readonly<{ name: string; description: string | null; status: "not_started" | "active" | "completed" | "cancelled"; archived: boolean; overdueWarning: boolean; completedAt: string | null; archivedAt: string | null; estimatedStart: string | null; estimatedEnd: string | null; clientPublicId: string | null; organizationPublicId: string | null }> }>;
export type ProjectAlphaProjectReadOutcome = Readonly<{ status: "read"; httpStatus: 200; response: ProjectAlphaProjectRead }> | ProjectAlphaProjectFailure;
const ROUTE = endpoint("GET", "/api/v2/projects/{publicId}", "projects.v2.read");
function timestamp(value: unknown): value is string | null {
  if (value === null || typeof value !== "string" || !/^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{6})?)$/.test(value)) return value === null;
  const normalized = value.includes(" ") ? `${value.replace(" ", "T").replace(/\.(\d{3})\d{3}$/, ".$1")}Z` : value;
  return Number.isFinite(new Date(normalized).valueOf());
}
function valid(value: unknown, id: string, connection: ProjectAlphaApiV2Connection, requestId: string | null): value is ProjectAlphaProjectRead {
  if (!plain(value) || !exact(value, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "replayed", "accepted", "resource", "data"]) || value.apiVersion !== "2" || value.sourceInstanceId !== connection.expectedSourceInstanceId || value.applicationId !== connection.expectedApplicationId || value.historyEpoch !== connection.expectedHistoryEpoch || !uuid(value.requestId) || value.requestId !== requestId || value.replayed !== false || value.accepted !== true || !plain(value.resource) || !exact(value.resource, ["type", "id", "revision", "projectionSha256"]) || value.resource.type !== "project" || value.resource.id !== id || !publicId(value.resource.id) || !decimal(value.resource.revision, true) || !hash(value.resource.projectionSha256) || !plain(value.data)) return false;
  const d = value.data;
  return exact(d, ["name", "description", "status", "archived", "overdueWarning", "completedAt", "archivedAt", "estimatedStart", "estimatedEnd", "clientPublicId", "organizationPublicId"])
    && typeof d.name === "string" && d.name.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "").length > 0 && Array.from(d.name).length <= 150 && !/\p{C}/u.test(d.name)
    && (d.description === null || typeof d.description === "string" && Array.from(d.description).length <= 10000 && !/\p{C}/u.test(d.description)) && (d.status === "not_started" || d.status === "active" || d.status === "completed" || d.status === "cancelled") && typeof d.archived === "boolean" && typeof d.overdueWarning === "boolean" && timestamp(d.completedAt) && timestamp(d.archivedAt) && date(d.estimatedStart) && date(d.estimatedEnd) && (d.clientPublicId === null || publicId(d.clientPublicId)) && (d.organizationPublicId === null || publicId(d.organizationPublicId));
}
export async function readProjectAlphaProject(connectionInput: ProjectAlphaApiV2Connection, requestedPublicId: string, fetcher: typeof fetch = fetch): Promise<ProjectAlphaProjectReadOutcome> {
  if (!publicId(requestedPublicId)) return { status: "rejected", reason: "invalid_command" };
  const connection = canonicalConnection(connectionInput); if (!connection) return { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
  const preflight = await runPreflight(connection, ROUTE, fetcher); if (preflight) return preflight;
  const response = await get(connection, `/api/v2/projects/${requestedPublicId}`, fetcher); if (isFailure(response)) return response;
  const info = diagnostic(response);
  if (response.status !== 200) { await response.body?.cancel(); if (response.status === 409) return { status: "conflict", reason: "http_status", ...info }; return { status: response.status >= 500 ? "uncertain" : "blocked", reason: "http_status", ...info }; }
  if (!trusted(response, true)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...info }; }
  try { const parsed = await boundedJson(response); return valid(parsed, requestedPublicId, connection, response.headers.get("X-Request-ID")) ? { status: "read", httpStatus: 200, response: parsed } : { status: "uncertain", reason: "invalid_contract", ...info }; }
  catch (error) { return { status: "uncertain", reason: error instanceof Error && error.message === "response_limit" ? "response_limit" : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract", ...info }; }
}
export async function readConfiguredProjectAlphaProject(env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, requestedPublicId: string, fetcher: typeof fetch = fetch): Promise<ProjectAlphaProjectReadOutcome | Readonly<{ status: "disabled"; sourceId: string }>> {
  const result = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId, connection => readProjectAlphaProject(connection, requestedPublicId, fetcher));
  return result.status === "enabled" ? result.value : result.status === "disabled" ? result : { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
}
