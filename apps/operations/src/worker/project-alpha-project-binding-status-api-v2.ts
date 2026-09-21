import { boundedJson, boundedJsonOrEmpty, canonicalConnection, decimal, diagnostic, endpoint, externalId, exact, generation, get, hash, isFailure, plain, publicId, runPreflight, trusted, uuid, type ProjectAlphaProjectFailure } from "./project-alpha-project-transport";
import { withEnabledConfiguredProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";

export type ProjectAlphaProjectBindingStatus = Readonly<{ apiVersion: "2"; sourceInstanceId: string; applicationId: string; historyEpoch: string; requestId: string; authorizationGeneration: string; binding: Readonly<{ externalId: string; publicId: string; createdAt: string; updatedAt: string }>; resource: Readonly<{ revision: string; projectionSha256: string; status: "not_started" | "active" | "completed" | "cancelled"; archived: boolean }> }>;
export type ProjectAlphaProjectBindingStatusStale = Readonly<{ apiVersion: "2"; sourceInstanceId: string; applicationId: string; historyEpoch: string; requestId: string; error: Readonly<{ code: "binding_stale" }>; authorizationGeneration: string; binding: Readonly<{ externalId: string; publicId: string; revision: string }>; resource: Readonly<{ revision: string; projectionSha256: string }> }>;
export type ProjectAlphaProjectBindingStatusOutcome = Readonly<{ status: "observed"; httpStatus: 200; response: ProjectAlphaProjectBindingStatus }> | Readonly<{ status: "binding_stale"; httpStatus: 409; response: ProjectAlphaProjectBindingStatusStale }> | Readonly<{ status: "not_found" }> | ProjectAlphaProjectFailure;
const ROUTE = endpoint("GET", "/api/v2/projects/bindings/status/{base64urlExternalId}", "projects.binding_status.read");
function datetime(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{6})?)$/.test(value)) return false;
  const normalized = value.includes(" ") ? `${value.replace(" ", "T").replace(/\.(\d{3})\d{3}$/, ".$1")}Z` : value;
  return Number.isFinite(new Date(normalized).valueOf());
}
function b64(value: string): string { let binary = ""; for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, ""); }
function valid(value: unknown, external: string, connection: ProjectAlphaApiV2Connection, requestId: string | null): value is ProjectAlphaProjectBindingStatus {
  if (!plain(value) || !exact(value, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "authorizationGeneration", "binding", "resource"]) || value.apiVersion !== "2" || value.sourceInstanceId !== connection.expectedSourceInstanceId || value.applicationId !== connection.expectedApplicationId || value.historyEpoch !== connection.expectedHistoryEpoch || !uuid(value.requestId) || value.requestId !== requestId || !decimal(value.authorizationGeneration) || !plain(value.binding) || !exact(value.binding, ["externalId", "publicId", "createdAt", "updatedAt"]) || value.binding.externalId !== external || !publicId(value.binding.publicId) || !datetime(value.binding.createdAt) || !datetime(value.binding.updatedAt) || !plain(value.resource) || !exact(value.resource, ["revision", "projectionSha256", "status", "archived"]) || !decimal(value.resource.revision, true) || !hash(value.resource.projectionSha256) || !["not_started", "active", "completed", "cancelled"].includes(value.resource.status as string) || typeof value.resource.archived !== "boolean") return false;
  return true;
}
function newerRevision(live: string, pinned: string): boolean { return live.length > pinned.length || live.length === pinned.length && live > pinned; }
function validStaleBinding(value: unknown, external: string, connection: ProjectAlphaApiV2Connection, requestId: string | null): value is ProjectAlphaProjectBindingStatusStale {
  if (!plain(value) || !exact(value, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "error", "authorizationGeneration", "binding", "resource"])
    || value.apiVersion !== "2" || value.sourceInstanceId !== connection.expectedSourceInstanceId || value.applicationId !== connection.expectedApplicationId
    || value.historyEpoch !== connection.expectedHistoryEpoch || !uuid(value.requestId) || value.requestId !== requestId
    || !plain(value.error) || !exact(value.error, ["code"]) || value.error.code !== "binding_stale" || !generation(value.authorizationGeneration)
    || !plain(value.binding) || !exact(value.binding, ["externalId", "publicId", "revision"]) || value.binding.externalId !== external
    || !publicId(value.binding.publicId) || !decimal(value.binding.revision, true)
    || !plain(value.resource) || !exact(value.resource, ["revision", "projectionSha256"]) || !decimal(value.resource.revision, true)
    || !newerRevision(value.resource.revision, value.binding.revision) || !hash(value.resource.projectionSha256)) return false;
  return true;
}
export async function readProjectAlphaProjectBindingStatus(connectionInput: ProjectAlphaApiV2Connection, requestedExternalId: string, fetcher: typeof fetch = fetch): Promise<ProjectAlphaProjectBindingStatusOutcome> {
  if (!externalId(requestedExternalId)) return { status: "rejected", reason: "invalid_command" };
  const connection = canonicalConnection(connectionInput); if (!connection) return { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
  const preflight = await runPreflight(connection, ROUTE, fetcher); if (preflight) return preflight;
  const response = await get(connection, `/api/v2/projects/bindings/status/${b64(requestedExternalId)}`, fetcher); if (isFailure(response)) return response; const info = diagnostic(response);
  if (response.status === 404) { if (!trusted(response, false)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...info }; } await response.body?.cancel(); return { status: "not_found" }; }
  if (response.status === 409) {
    if (!trusted(response, true)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...info }; }
    try {
      const body = await boundedJsonOrEmpty(response);
      if (body.empty) return { status: "conflict", reason: "http_status", ...info };
      return validStaleBinding(body.value, requestedExternalId, connection, response.headers.get("X-Request-ID"))
        ? { status: "binding_stale", httpStatus: 409, response: body.value }
        : { status: "uncertain", reason: "invalid_contract", ...info };
    } catch (error) { return { status: "uncertain", reason: error instanceof Error && error.message === "response_limit" ? "response_limit" : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract", ...info }; }
  }
  if (response.status !== 200) { await response.body?.cancel(); return { status: response.status >= 500 ? "uncertain" : "blocked", reason: "http_status", ...info }; }
  if (!trusted(response, true)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...info }; }
  try { const parsed = await boundedJson(response); return valid(parsed, requestedExternalId, connection, response.headers.get("X-Request-ID")) ? { status: "observed", httpStatus: 200, response: parsed } : { status: "uncertain", reason: "invalid_contract", ...info }; }
  catch (error) { return { status: "uncertain", reason: error instanceof Error && error.message === "response_limit" ? "response_limit" : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract", ...info }; }
}
export async function readConfiguredProjectAlphaProjectBindingStatus(env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string, requestedExternalId: string, fetcher: typeof fetch = fetch): Promise<ProjectAlphaProjectBindingStatusOutcome | Readonly<{ status: "disabled"; sourceId: string }>> { const result = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId, connection => readProjectAlphaProjectBindingStatus(connection, requestedExternalId, fetcher)); return result.status === "enabled" ? result.value : result.status === "disabled" ? result : { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } }; }
