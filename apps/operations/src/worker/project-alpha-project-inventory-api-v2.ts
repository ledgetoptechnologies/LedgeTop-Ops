import { boundedJson, boundedJsonOrEmpty, canonicalConnection, decimal, diagnostic, endpoint, externalId, exact, get, hash, isFailure, plain, publicId, runPreflight, trusted, uuid, type ProjectAlphaProjectFailure } from "./project-alpha-project-transport";
import { withEnabledConfiguredProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";

export type ProjectAlphaProjectInventoryItem = Readonly<{ externalId: string; publicId: string; revision: string; projectionSha256: string; status: "not_started" | "active" | "completed" | "cancelled"; archived: boolean }>;
export type ProjectAlphaProjectInventory = Readonly<{ apiVersion: "2"; sourceInstanceId: string; applicationId: string; historyEpoch: string; requestId: string; authorizationGeneration: string; projects: readonly ProjectAlphaProjectInventoryItem[]; nextCursor: string | null }>;
export type ProjectAlphaProjectInventoryStaleBinding = Readonly<{ apiVersion: "2"; sourceInstanceId: string; applicationId: string; historyEpoch: string; requestId: string; error: Readonly<{ code: "binding_stale"; externalId: string }> }>;
export type ProjectAlphaProjectInventoryQuery = Readonly<{ cursor?: string | null; limit?: number }>;
export type ProjectAlphaProjectInventoryOutcome = Readonly<{ status: "observed"; httpStatus: 200; response: ProjectAlphaProjectInventory }> | Readonly<{ status: "binding_stale"; httpStatus: 409; response: ProjectAlphaProjectInventoryStaleBinding }> | ProjectAlphaProjectFailure;
const ROUTE = endpoint("GET", "/api/v2/projects/inventory", "projects.inventory.read");
function validQuery(query: ProjectAlphaProjectInventoryQuery): boolean { return plain(query) && Object.keys(query).every(key => key === "cursor" || key === "limit") && (query.cursor === undefined || query.cursor === null || externalId(query.cursor)) && (query.limit === undefined || Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= 200); }
function valid(value: unknown, connection: ProjectAlphaApiV2Connection, requestId: string | null, limit: number): value is ProjectAlphaProjectInventory {
  if (!plain(value) || !exact(value, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "authorizationGeneration", "projects", "nextCursor"]) || value.apiVersion !== "2" || value.sourceInstanceId !== connection.expectedSourceInstanceId || value.applicationId !== connection.expectedApplicationId || value.historyEpoch !== connection.expectedHistoryEpoch || !uuid(value.requestId) || value.requestId !== requestId || !decimal(value.authorizationGeneration) || !Array.isArray(value.projects) || value.projects.length > limit || value.projects.length > 200 || (value.nextCursor !== null && !externalId(value.nextCursor))) return false;
  let previous: string | null = null;
  for (const item of value.projects) { if (!plain(item) || !exact(item, ["externalId", "publicId", "revision", "projectionSha256", "status", "archived"]) || !externalId(item.externalId) || (previous !== null && item.externalId <= previous) || !publicId(item.publicId) || !decimal(item.revision, true) || !hash(item.projectionSha256) || !["not_started", "active", "completed", "cancelled"].includes(item.status as string) || typeof item.archived !== "boolean") return false; previous = item.externalId; }
  return value.nextCursor === null || value.projects.length === limit && value.nextCursor === value.projects[value.projects.length - 1]?.externalId;
}
function validStaleBinding(value: unknown, connection: ProjectAlphaApiV2Connection, requestId: string | null): value is ProjectAlphaProjectInventoryStaleBinding {
  return plain(value) && exact(value, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "error"])
    && value.apiVersion === "2" && value.sourceInstanceId === connection.expectedSourceInstanceId && value.applicationId === connection.expectedApplicationId
    && value.historyEpoch === connection.expectedHistoryEpoch && uuid(value.requestId) && value.requestId === requestId
    && plain(value.error) && exact(value.error, ["code", "externalId"]) && value.error.code === "binding_stale" && externalId(value.error.externalId);
}
export async function readProjectAlphaProjectInventory(connectionInput: ProjectAlphaApiV2Connection, query: ProjectAlphaProjectInventoryQuery = {}, fetcher: typeof fetch = fetch): Promise<ProjectAlphaProjectInventoryOutcome> {
  if (!plain(query) || !validQuery(query)) return { status: "rejected", reason: "invalid_command" };
  const connection = canonicalConnection(connectionInput); if (!connection) return { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
  const preflight = await runPreflight(connection, ROUTE, fetcher); if (preflight) return preflight;
  const limit = query.limit ?? 100; const params = new URLSearchParams({ limit: String(limit) }); if (query.cursor !== undefined && query.cursor !== null) params.set("cursor", query.cursor);
  const response = await get(connection, `/api/v2/projects/inventory?${params.toString()}`, fetcher); if (isFailure(response)) return response; const info = diagnostic(response);
  if (response.status === 409) {
    if (!trusted(response, true)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...info }; }
    try {
      const body = await boundedJsonOrEmpty(response, 256 * 1024);
      if (body.empty) return { status: "conflict", reason: "http_status", ...info };
      return validStaleBinding(body.value, connection, response.headers.get("X-Request-ID"))
        ? { status: "binding_stale", httpStatus: 409, response: body.value }
        : { status: "uncertain", reason: "invalid_contract", ...info };
    } catch (error) { return { status: "uncertain", reason: error instanceof Error && error.message === "response_limit" ? "response_limit" : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract", ...info }; }
  }
  if (response.status !== 200) { await response.body?.cancel(); return { status: response.status >= 500 ? "uncertain" : "blocked", reason: "http_status", ...info }; }
  if (!trusted(response, true)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...info }; }
  try { const parsed = await boundedJson(response, 256 * 1024); return valid(parsed, connection, response.headers.get("X-Request-ID"), limit) ? { status: "observed", httpStatus: 200, response: parsed } : { status: "uncertain", reason: "invalid_contract", ...info }; }
  catch (error) { return { status: "uncertain", reason: error instanceof Error && error.message === "response_limit" ? "response_limit" : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract", ...info }; }
}
export async function readConfiguredProjectAlphaProjectInventory(env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, query: ProjectAlphaProjectInventoryQuery = {}, fetcher: typeof fetch = fetch): Promise<ProjectAlphaProjectInventoryOutcome | Readonly<{ status: "disabled"; sourceId: string }>> { const result = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId, connection => readProjectAlphaProjectInventory(connection, query, fetcher)); return result.status === "enabled" ? result.value : result.status === "disabled" ? result : { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } }; }
