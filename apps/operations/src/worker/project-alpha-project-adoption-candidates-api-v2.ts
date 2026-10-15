import {
  boundedJson, canonicalConnection, decimal, diagnostic, endpoint, exact, get,
  hash, isFailure, plain, publicId, runPreflight, text, trusted, uuid,
  type ProjectAlphaProjectFailure, type ProjectAlphaProjectLifecycle,
} from "./project-alpha-project-transport";
import {
  withEnabledConfiguredProjectAlphaApiV2Connection,
  type ProjectAlphaApiV2ConnectionEnvironment,
} from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection } from "./project-alpha-api-v2";

/** Discovery is an observation, never a binding, client grant or publication. */
export type ProjectAlphaProjectAdoptionCandidate = Readonly<{
  publicId: string;
  revision: string;
  projectionSha256: string;
  name: string;
  status: ProjectAlphaProjectLifecycle;
  archived: false;
  organizationPublicId: string | null;
  clientPublicId: string | null;
}>;
export type ProjectAlphaProjectAdoptionCandidates = Readonly<{
  apiVersion: "2";
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  requestId: string;
  authorizationGeneration: string;
  projects: readonly ProjectAlphaProjectAdoptionCandidate[];
  nextCursor: string | null;
}>;
export type ProjectAlphaProjectAdoptionCandidatesQuery = Readonly<{ cursor?: string | null; limit?: number }>;
export type ProjectAlphaProjectAdoptionCandidatesOutcome =
  | Readonly<{ status: "observed"; httpStatus: 200; response: ProjectAlphaProjectAdoptionCandidates }>
  | ProjectAlphaProjectFailure;
export const PROJECT_ALPHA_PROJECT_ADOPTION_CANDIDATES_ENDPOINT = Object.freeze(
  endpoint("GET", "/api/v2/projects/adoption-candidates", "projects.adoption_candidates.read"),
);

function validQuery(value: ProjectAlphaProjectAdoptionCandidatesQuery): boolean {
  return plain(value) && Object.keys(value).every(key => key === "cursor" || key === "limit")
    && (value.cursor === undefined || value.cursor === null || publicId(value.cursor))
    && (value.limit === undefined || Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200);
}
function validResponse(value: unknown, connection: ProjectAlphaApiV2Connection,
  requestId: string | null, query: ProjectAlphaProjectAdoptionCandidatesQuery): value is ProjectAlphaProjectAdoptionCandidates {
  const limit = query.limit ?? 100;
  if (!plain(value) || !exact(value, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch",
    "requestId", "authorizationGeneration", "projects", "nextCursor"])
    || value.apiVersion !== "2" || value.sourceInstanceId !== connection.expectedSourceInstanceId
    || value.applicationId !== connection.expectedApplicationId || value.historyEpoch !== connection.expectedHistoryEpoch
    || !uuid(value.requestId) || value.requestId !== requestId || !decimal(value.authorizationGeneration)
    || !Array.isArray(value.projects) || value.projects.length > limit
    || (value.nextCursor !== null && !publicId(value.nextCursor))) return false;
  let previous = query.cursor ?? null;
  for (const item of value.projects) {
    if (!plain(item) || !exact(item, ["publicId", "revision", "projectionSha256", "name", "status", "archived",
      "organizationPublicId", "clientPublicId"])
      || !publicId(item.publicId) || previous !== null && item.publicId <= previous
      || !decimal(item.revision, true) || !hash(item.projectionSha256) || !text(item.name, 150)
      || !["not_started", "active", "completed", "cancelled"].includes(item.status as string)
      || item.archived !== false
      || item.organizationPublicId !== null && !publicId(item.organizationPublicId)
      || item.clientPublicId !== null && !publicId(item.clientPublicId)) return false;
    previous = item.publicId;
  }
  return value.nextCursor === null || value.projects.length === limit && value.nextCursor === previous;
}

export async function readProjectAlphaProjectAdoptionCandidates(
  connectionInput: ProjectAlphaApiV2Connection,
  query: ProjectAlphaProjectAdoptionCandidatesQuery = {},
  fetcher: typeof fetch = fetch,
): Promise<ProjectAlphaProjectAdoptionCandidatesOutcome> {
  if (!validQuery(query)) return { status: "rejected", reason: "invalid_command" };
  const connection = canonicalConnection(connectionInput);
  if (!connection) return { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
  const preflight = await runPreflight(connection, PROJECT_ALPHA_PROJECT_ADOPTION_CANDIDATES_ENDPOINT, fetcher);
  if (preflight) return preflight;
  const params = new URLSearchParams({ limit: String(query.limit ?? 100) });
  if (query.cursor !== undefined && query.cursor !== null) params.set("cursor", query.cursor);
  const response = await get(connection, `/api/v2/projects/adoption-candidates?${params}`, fetcher);
  if (isFailure(response)) return response;
  const info = diagnostic(response);
  if (response.status !== 200) {
    await response.body?.cancel();
    return { status: response.status === 409 ? "conflict" : response.status >= 500 ? "uncertain" : "blocked",
      reason: "http_status", ...info };
  }
  if (!trusted(response, true)) {
    await response.body?.cancel();
    return { status: "uncertain", reason: "invalid_contract", ...info };
  }
  try {
    const parsed = await boundedJson(response, 256 * 1024);
    return validResponse(parsed, connection, response.headers.get("X-Request-ID"), query)
      ? { status: "observed", httpStatus: 200, response: parsed }
      : { status: "uncertain", reason: "invalid_contract", ...info };
  } catch (error) {
    return { status: "uncertain", reason: error instanceof Error && error.message === "response_limit" ? "response_limit"
      : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract", ...info };
  }
}

export async function readConfiguredProjectAlphaProjectAdoptionCandidates(
  env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string,
  query: ProjectAlphaProjectAdoptionCandidatesQuery = {}, fetcher: typeof fetch = fetch,
): Promise<ProjectAlphaProjectAdoptionCandidatesOutcome | Readonly<{ status: "disabled"; sourceId: string }>> {
  const result = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId,
    connection => readProjectAlphaProjectAdoptionCandidates(connection, query, fetcher));
  return result.status === "enabled" ? result.value : result.status === "disabled" ? result
    : { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
}
