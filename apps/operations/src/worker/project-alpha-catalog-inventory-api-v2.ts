import { boundedJson, canonicalConnection, diagnostic, endpoint, get, hash, isFailure, plain, runPreflight, trusted, uuid, type ProjectAlphaProjectFailure } from "./project-alpha-project-transport";
import { withEnabledConfiguredProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection, ProjectAlphaApiV2Endpoint } from "./project-alpha-api-v2";

/**
 * Read-only acceptance transport for the future generic catalog inventory.
 * It deliberately validates only the frozen inventory envelope. The acceptance
 * slice keeps item schemas opaque: this module neither stores nor forwards
 * catalog content.
 */
export type ProjectAlphaCatalogInventory = Readonly<{
  apiVersion: "2"; sourceInstanceId: string; applicationId: string; historyEpoch: string; requestId: string;
  snapshotId: string; totalCount: number; items: readonly unknown[]; nextCursor: string | null;
}>;
export type ProjectAlphaCatalogInventoryQuery = Readonly<{ cursor?: string | null; limit?: number }>;
export type ProjectAlphaCatalogInventoryOutcome =
  | Readonly<{ status: "observed"; httpStatus: 200; response: ProjectAlphaCatalogInventory }>
  | ProjectAlphaProjectFailure;

export const PROJECT_ALPHA_CATALOG_INVENTORY_ENDPOINT: Readonly<ProjectAlphaApiV2Endpoint> = Object.freeze(
  endpoint("GET", "/api/v2/catalog/inventory", "catalog.inventory.read"),
);
export const PROJECT_ALPHA_CATALOG_INVENTORY_RESPONSE_LIMIT = 1_048_576;

function validQuery(query: ProjectAlphaCatalogInventoryQuery): boolean {
  return plain(query) && Object.keys(query).every(key => key === "cursor" || key === "limit")
    && (query.cursor === undefined || query.cursor === null || (typeof query.cursor === "string" && query.cursor.length > 0 && query.cursor.length <= 2048))
    && (query.limit === undefined || Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= 200);
}

function valid(value: unknown, connection: ProjectAlphaApiV2Connection, requestId: string | null, limit: number): value is ProjectAlphaCatalogInventory {
  return plain(value) && Object.keys(value).length === 9
    && ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "snapshotId", "totalCount", "items", "nextCursor"].every(key => Object.hasOwn(value, key))
    && value.apiVersion === "2" && value.sourceInstanceId === connection.expectedSourceInstanceId
    && value.applicationId === connection.expectedApplicationId && value.historyEpoch === connection.expectedHistoryEpoch
    && uuid(value.requestId) && value.requestId === requestId && hash(value.snapshotId)
    && Number.isSafeInteger(value.totalCount) && (value.totalCount as number) >= 0 && Array.isArray(value.items)
    && value.items.length <= limit && value.items.length <= 200 && value.items.length <= (value.totalCount as number)
    && (value.nextCursor === null || typeof value.nextCursor === "string" && value.nextCursor.length > 0 && value.nextCursor.length <= 2048);
}

async function readRequest(connection: ProjectAlphaApiV2Connection, query: ProjectAlphaCatalogInventoryQuery,
  fetcher: typeof fetch): Promise<ProjectAlphaCatalogInventoryOutcome> {
  const limit = query.limit ?? 200;
  const params = new URLSearchParams({ limit: String(limit) });
  if (query.cursor !== undefined && query.cursor !== null) params.set("cursor", query.cursor);
  const response = await get(connection, `${PROJECT_ALPHA_CATALOG_INVENTORY_ENDPOINT.path}?${params}`, fetcher);
  if (isFailure(response)) return response;
  const info = diagnostic(response);
  if (response.status !== 200) { await response.body?.cancel(); return { status: response.status >= 500 ? "uncertain" : "blocked", reason: "http_status", ...info }; }
  if (!trusted(response, true)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...info }; }
  try {
    const body = await boundedJson(response, PROJECT_ALPHA_CATALOG_INVENTORY_RESPONSE_LIMIT);
    return valid(body, connection, response.headers.get("X-Request-ID"), limit)
      ? { status: "observed", httpStatus: 200, response: body }
      : { status: "uncertain", reason: "invalid_contract", ...info };
  } catch (error) {
    return { status: "uncertain", reason: error instanceof Error && error.message === "response_limit" ? "response_limit"
      : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract", ...info };
  }
}

export async function readProjectAlphaCatalogInventory(connectionInput: ProjectAlphaApiV2Connection,
  query: ProjectAlphaCatalogInventoryQuery = {}, fetcher: typeof fetch = fetch): Promise<ProjectAlphaCatalogInventoryOutcome> {
  if (!plain(query) || !validQuery(query)) return { status: "rejected", reason: "invalid_command" };
  const connection = canonicalConnection(connectionInput);
  if (!connection) return { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
  const preflight = await runPreflight(connection, PROJECT_ALPHA_CATALOG_INVENTORY_ENDPOINT, fetcher);
  return preflight ?? readRequest(connection, query, fetcher);
}

export async function readProjectAlphaCatalogInventoryAfterVerifiedCapabilities(connectionInput: ProjectAlphaApiV2Connection,
  query: ProjectAlphaCatalogInventoryQuery = {}, fetcher: typeof fetch = fetch): Promise<ProjectAlphaCatalogInventoryOutcome> {
  if (!plain(query) || !validQuery(query)) return { status: "rejected", reason: "invalid_command" };
  const connection = canonicalConnection(connectionInput);
  if (!connection) return { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
  return readRequest(connection, query, fetcher);
}

export async function readConfiguredProjectAlphaCatalogInventory(env: ProjectAlphaApiV2ConnectionEnvironment, sourceId: string,
  query: ProjectAlphaCatalogInventoryQuery = {}, fetcher: typeof fetch = fetch): Promise<ProjectAlphaCatalogInventoryOutcome | Readonly<{ status: "disabled"; sourceId: string }>> {
  const result = await withEnabledConfiguredProjectAlphaApiV2Connection(env, sourceId,
    connection => readProjectAlphaCatalogInventory(connection, query, fetcher));
  return result.status === "enabled" ? result.value : result.status === "disabled" ? result
    : { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
}
