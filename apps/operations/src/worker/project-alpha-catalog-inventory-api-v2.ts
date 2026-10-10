import { boundedJson, boundedJsonOrEmpty, canonicalConnection, diagnostic, endpoint, exact, get, hash, isFailure, plain, publicId, runPreflight, trusted, uuid, type ProjectAlphaProjectFailure } from "./project-alpha-project-transport";
import { withEnabledConfiguredProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import type { ProjectAlphaApiV2Connection, ProjectAlphaApiV2Endpoint } from "./project-alpha-api-v2";

/**
 * Read-only acceptance transport for the future generic catalog inventory.
 * It validates the complete PA contract but neither stores nor forwards catalog
 * content. Publication is left to a later, explicitly enabled integration.
 */
export type ProjectAlphaCatalogQuestionOption = Readonly<{ value: string; label: string }>;
export type ProjectAlphaCatalogQuestion = Readonly<{
  id: string; label: string; type: "text" | "number" | "boolean" | "select" | "multi-select"; required: boolean;
  helpText?: string | null; options?: readonly ProjectAlphaCatalogQuestionOption[]; minimum?: number; maximum?: number;
}>;
export type ProjectAlphaCatalogInventoryItem = Readonly<{
  publicId: string; sourceVersion: string; name: string; summary: string | null; category: string; displayOrder: number;
  geometryRequirement: "none" | "optional" | "required"; questions: readonly ProjectAlphaCatalogQuestion[];
}>;
export type ProjectAlphaCatalogInventory = Readonly<{
  apiVersion: "2"; sourceInstanceId: string; applicationId: string; historyEpoch: string; requestId: string;
  snapshotId: string; totalCount: number; items: readonly ProjectAlphaCatalogInventoryItem[]; nextCursor: string | null;
}>;
export type ProjectAlphaCatalogSnapshotChanged = Readonly<{ apiVersion: "2"; sourceInstanceId: string; applicationId: string; historyEpoch: string; requestId: string; error: Readonly<{ code: "catalog_snapshot_changed" }> }>;
export type ProjectAlphaCatalogInventoryQuery = Readonly<{ cursor?: string | null; limit?: number }>;
export type ProjectAlphaCatalogInventoryOutcome =
  | Readonly<{ status: "observed"; httpStatus: 200; response: ProjectAlphaCatalogInventory }>
  | Readonly<{ status: "snapshot_changed"; httpStatus: 409; response: ProjectAlphaCatalogSnapshotChanged }>
  | ProjectAlphaProjectFailure;
export type ProjectAlphaCatalogSnapshotOutcome =
  | Readonly<{ status: "complete"; snapshotId: string; totalCount: number; items: readonly ProjectAlphaCatalogInventoryItem[]; pageCount: number; attemptCount: number }>
  | Readonly<{ status: "incomplete"; reason: "too_large"; totalCount: number; maxItems: number; accumulatedBytes: number; maxBytes: number }>
  | Readonly<{ status: "incomplete"; reason: "pagination_limit"; totalCount: number; maxPages: number }>
  | ProjectAlphaProjectFailure;
export const PROJECT_ALPHA_CATALOG_SNAPSHOT_MAX_ITEMS = 10_000;
export const PROJECT_ALPHA_CATALOG_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;

export const PROJECT_ALPHA_CATALOG_INVENTORY_ENDPOINT: Readonly<ProjectAlphaApiV2Endpoint> = Object.freeze(
  endpoint("GET", "/api/v2/catalog/inventory", "catalog.inventory.read"),
);
export const PROJECT_ALPHA_CATALOG_INVENTORY_RESPONSE_LIMIT = 1_048_576;

function validQuery(query: ProjectAlphaCatalogInventoryQuery): boolean {
  return plain(query) && Object.keys(query).every(key => key === "cursor" || key === "limit")
    && (query.cursor === undefined || query.cursor === null || (typeof query.cursor === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(query.cursor)))
    && (query.limit === undefined || Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= 200);
}

function safeText(value: unknown, minimum: number, maximum: number, nullable = false): boolean {
  return value === null ? nullable : typeof value === "string" && Array.from(value).length >= minimum && Array.from(value).length <= maximum
    && !/[\x00-\x08\x0B\x0C\x0E-\x1F<>\u202A-\u202E\u2066-\u2069\u200E\u200F]/u.test(value);
}
function validQuestion(value: unknown): value is ProjectAlphaCatalogQuestion {
  if (!plain(value) || !Object.keys(value).every(key => ["id", "label", "type", "required", "helpText", "options", "minimum", "maximum"].includes(key))
    || !Object.hasOwn(value, "id") || !Object.hasOwn(value, "label") || !Object.hasOwn(value, "type") || !Object.hasOwn(value, "required")
    || typeof value.id !== "string" || !/^[a-z][a-z0-9_:-]{0,63}$/.test(value.id) || !safeText(value.label, 1, 200)
    || !["text", "number", "boolean", "select", "multi-select"].includes(value.type as string) || typeof value.required !== "boolean"
    || (Object.hasOwn(value, "helpText") && !safeText(value.helpText, 1, 500, true))) return false;
  const select = value.type === "select" || value.type === "multi-select";
  if (select !== Object.hasOwn(value, "options")) return false;
  if (select) {
    if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > 50) return false;
    const values = new Set<string>();
    for (const option of value.options) {
      if (!plain(option) || !exact(option, ["value", "label"]) || !safeText(option.value, 1, 100) || !safeText(option.label, 1, 200)
        || values.has(option.value as string)) return false;
      values.add(option.value as string);
    }
  }
  const hasMinimum = Object.hasOwn(value, "minimum"), hasMaximum = Object.hasOwn(value, "maximum");
  if (value.type !== "number" && (hasMinimum || hasMaximum)) return false;
  if (hasMinimum && (typeof value.minimum !== "number" || !Number.isFinite(value.minimum))) return false;
  if (hasMaximum && (typeof value.maximum !== "number" || !Number.isFinite(value.maximum))) return false;
  return !(hasMinimum && hasMaximum && (value.minimum as number) > (value.maximum as number));
}
function validItem(value: unknown): value is ProjectAlphaCatalogInventoryItem {
  if (!plain(value) || !exact(value, ["publicId", "sourceVersion", "name", "summary", "category", "displayOrder", "geometryRequirement", "questions"])
    || !publicId(value.publicId) || typeof value.sourceVersion !== "string" || !/^sha256-[0-9a-f]{64}$/.test(value.sourceVersion)
    || !safeText(value.name, 1, 255) || !safeText(value.summary, 1, 1000, true)
    || !safeText(value.category, 1, 100) || !Number.isInteger(value.displayOrder) || (value.displayOrder as number) < 0 || (value.displayOrder as number) > 1_000_000
    || !["none", "optional", "required"].includes(value.geometryRequirement as string) || !Array.isArray(value.questions) || value.questions.length > 10) return false;
  const questionIds = new Set<string>();
  return value.questions.every(question => validQuestion(question) && !questionIds.has(question.id) && Boolean(questionIds.add(question.id)));
}

function valid(value: unknown, connection: ProjectAlphaApiV2Connection, requestId: string | null, limit: number): value is ProjectAlphaCatalogInventory {
  if (!(plain(value) && Object.keys(value).length === 9
    && ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "snapshotId", "totalCount", "items", "nextCursor"].every(key => Object.hasOwn(value, key))
    && value.apiVersion === "2" && value.sourceInstanceId === connection.expectedSourceInstanceId
    && value.applicationId === connection.expectedApplicationId && value.historyEpoch === connection.expectedHistoryEpoch
    && uuid(value.requestId) && value.requestId === requestId && hash(value.snapshotId)
    && Number.isSafeInteger(value.totalCount) && (value.totalCount as number) >= 0 && Array.isArray(value.items)
    && value.items.length <= limit && value.items.length <= 200 && value.items.length <= (value.totalCount as number)
    && (value.nextCursor === null || typeof value.nextCursor === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value.nextCursor))
    && (value.nextCursor === null || value.items.length > 0))) return false;
  let prior: string | null = null;
  for (const item of value.items) { if (!validItem(item) || prior !== null && item.publicId <= prior) return false; prior = item.publicId; }
  return true;
}
function validSnapshotChanged(value: unknown, connection: ProjectAlphaApiV2Connection, requestId: string | null): value is ProjectAlphaCatalogSnapshotChanged {
  return plain(value) && exact(value, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "error"])
    && value.apiVersion === "2" && value.sourceInstanceId === connection.expectedSourceInstanceId && value.applicationId === connection.expectedApplicationId
    && value.historyEpoch === connection.expectedHistoryEpoch && uuid(value.requestId) && value.requestId === requestId
    && plain(value.error) && exact(value.error, ["code"]) && value.error.code === "catalog_snapshot_changed";
}

async function readRequest(connection: ProjectAlphaApiV2Connection, query: ProjectAlphaCatalogInventoryQuery,
  fetcher: typeof fetch): Promise<ProjectAlphaCatalogInventoryOutcome> {
  const limit = query.limit ?? 200;
  const params = new URLSearchParams({ limit: String(limit) });
  if (query.cursor !== undefined && query.cursor !== null) params.set("cursor", query.cursor);
  const response = await get(connection, `${PROJECT_ALPHA_CATALOG_INVENTORY_ENDPOINT.path}?${params}`, fetcher);
  if (isFailure(response)) return response;
  const info = diagnostic(response);
  if (response.status === 409) {
    if (!trusted(response, true)) { await response.body?.cancel(); return { status: "uncertain", reason: "invalid_contract", ...info }; }
    try {
      const body = await boundedJsonOrEmpty(response, 64 * 1024);
      if (body.empty) return { status: "conflict", reason: "http_status", ...info };
      return validSnapshotChanged(body.value, connection, response.headers.get("X-Request-ID"))
        ? { status: "snapshot_changed", httpStatus: 409, response: body.value }
        : { status: "uncertain", reason: "invalid_contract", ...info };
    } catch (error) { return { status: "uncertain", reason: error instanceof Error && error.message === "response_limit" ? "response_limit" : error instanceof Error && error.message === "transport" ? "transport" : "invalid_contract", ...info }; }
  }
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

/** Reads a complete immutable view in memory. It performs one exact endpoint
 * preflight, discards every partial attempt on 409, and never writes state. */
export async function readProjectAlphaCatalogSnapshot(connectionInput: ProjectAlphaApiV2Connection,
  options: Readonly<{ limit?: number; maxAttempts?: number; maxPages?: number; maxItems?: number; maxBytes?: number }> = {}, fetcher: typeof fetch = fetch): Promise<ProjectAlphaCatalogSnapshotOutcome> {
  if (!plain(options) || !Object.keys(options).every(key => ["limit", "maxAttempts", "maxPages", "maxItems", "maxBytes"].includes(key))) return { status: "rejected", reason: "invalid_command" };
  const limit = options.limit ?? 200, maxAttempts = options.maxAttempts ?? 3, maxPages = options.maxPages ?? 10_000;
  const maxItems = options.maxItems ?? PROJECT_ALPHA_CATALOG_SNAPSHOT_MAX_ITEMS;
  const maxBytes = options.maxBytes ?? PROJECT_ALPHA_CATALOG_SNAPSHOT_MAX_BYTES;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10
    || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100_000 || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 50_000
    || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 32 * 1024 * 1024) return { status: "rejected", reason: "invalid_command" };
  const connection = canonicalConnection(connectionInput);
  if (!connection) return { status: "blocked", reason: "preflight", preflight: { status: "misconfigured", reason: "configuration" } };
  const preflight = await runPreflight(connection, PROJECT_ALPHA_CATALOG_INVENTORY_ENDPOINT, fetcher);
  if (preflight) return preflight;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const items: ProjectAlphaCatalogInventoryItem[] = [], ids = new Set<string>(), pairs = new Set<string>();
    let cursor: string | null = null, snapshotId: string | null = null, totalCount: number | null = null, lastPublicId: string | null = null, accumulatedBytes = 0;
    let retry = false;
    for (let page = 1; page <= maxPages; page++) {
      const outcome = await readRequest(connection, { limit, ...(cursor === null ? {} : { cursor }) }, fetcher);
      if (outcome.status === "snapshot_changed" || outcome.status === "conflict") { retry = true; break; }
      if (outcome.status !== "observed") return outcome;
      const current = outcome.response;
      if ((snapshotId !== null && current.snapshotId !== snapshotId) || (totalCount !== null && current.totalCount !== totalCount))
        return { status: "uncertain", reason: "invalid_contract", httpStatus: 200, requestId: current.requestId };
      snapshotId ??= current.snapshotId; totalCount ??= current.totalCount;
      if (totalCount > maxItems) return { status: "incomplete", reason: "too_large", totalCount, maxItems, accumulatedBytes, maxBytes };
      for (const item of current.items) {
        const pair = `${item.publicId}:${item.sourceVersion}`;
        if (ids.has(item.publicId) || pairs.has(pair) || lastPublicId !== null && item.publicId <= lastPublicId) return { status: "uncertain", reason: "invalid_contract", httpStatus: 200, requestId: current.requestId };
        const itemBytes = new TextEncoder().encode(JSON.stringify(item)).byteLength;
        if (accumulatedBytes + itemBytes > maxBytes) return { status: "incomplete", reason: "too_large", totalCount, maxItems, accumulatedBytes, maxBytes };
        accumulatedBytes += itemBytes;
        ids.add(item.publicId); pairs.add(pair); items.push(item);
        lastPublicId = item.publicId;
      }
      if (items.length > totalCount) return { status: "uncertain", reason: "invalid_contract", httpStatus: 200, requestId: current.requestId };
      if (current.nextCursor === null) {
        if (items.length !== totalCount) return { status: "uncertain", reason: "invalid_contract", httpStatus: 200, requestId: current.requestId };
        return Object.freeze({ status: "complete", snapshotId, totalCount, items: Object.freeze(items), pageCount: page, attemptCount: attempt });
      }
      if (current.nextCursor === cursor) return { status: "uncertain", reason: "invalid_contract", httpStatus: 200, requestId: current.requestId };
      cursor = current.nextCursor;
    }
    if (!retry) return { status: "incomplete", reason: "pagination_limit", totalCount: totalCount ?? 0, maxPages };
  }
  return { status: "conflict", reason: "http_status", httpStatus: 409 };
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
