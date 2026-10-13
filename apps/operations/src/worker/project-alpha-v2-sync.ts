import {
  PROJECT_ALPHA_DIRECTORY_INVENTORY_ENDPOINT,
  readProjectAlphaDirectoryInventoryAfterVerifiedCapabilities,
  type ProjectAlphaDirectoryInventorySuccess,
} from "./project-alpha-directory-command-api-v2";
import {
  PROJECT_ALPHA_PROJECT_INVENTORY_ENDPOINT,
  readProjectAlphaProjectInventoryAfterVerifiedCapabilities,
  type ProjectAlphaProjectInventory,
  type ProjectAlphaProjectInventoryStaleBinding,
} from "./project-alpha-project-inventory-api-v2";
import { probeProjectAlphaApiV2 } from "./project-alpha-api-v2";
import type { ProjectAlphaApiV2SyncCursorPayload } from "./project-alpha-api-v2-sync-cursor";
import {
  withEnabledConfiguredProjectAlphaApiV2Connection,
  type ProjectAlphaApiV2ConnectionEnvironment,
} from "./project-alpha-api-v2-connections";

/**
 * Default-off API-v2 synchronization entrypoint. This stays separate from the
 * legacy snapshot connector and from every native-record / portal projector.
 * It persists only validated inventory evidence and explicit conflicts.
 */
export const PROJECT_ALPHA_API_V2_SYNC_ENABLED = "PROJECT_ALPHA_API_V2_SYNC_ENABLED" as const;

const SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const DIRECTORY_CURSOR = /^(client|organization):[0-9a-f]{32}$/;
const MAX_CURSOR_CHARACTERS = 764;

export interface ProjectAlphaApiV2SyncEnvironment extends ProjectAlphaApiV2ConnectionEnvironment {
  OPS_DB: D1Database;
  PROJECT_ALPHA_API_V2_SYNC_ENABLED?: string;
}

export type ProjectAlphaApiV2SyncPageInput = Readonly<{
  sourceId: string;
  continuation?: ProjectAlphaApiV2SyncCursorPayload;
  limit?: number;
}>;

export type ProjectAlphaApiV2PersistedPage = Readonly<{
  status: "persisted" | "conflicted";
  itemCount: number;
  conflictCount: number;
  nextCursor: string | null;
  continuationIdentity: Readonly<{ sourceInstanceId: string; applicationId: string; historyEpoch: string; authorizationGeneration: string }>;
}>;

type SurfaceFailure = Readonly<{
  status: "blocked";
  reason: "transport" | "contract" | "authorization" | "binding_stale" | "storage" | "cursor_stale";
}>;

export type ProjectAlphaApiV2SyncPageOutcome =
  | Readonly<{ status: "disabled" }>
  | Readonly<{ status: "rejected"; reason: "invalid_input" }>
  | Readonly<{ status: "blocked"; reason: "connection" | "capabilities" | "storage" }>
  | Readonly<{
      status: "completed" | "partial";
       directory: ProjectAlphaApiV2PersistedPage | SurfaceFailure | Readonly<{ status: "not_requested" }>;
       projects: ProjectAlphaApiV2PersistedPage | SurfaceFailure | Readonly<{ status: "not_requested" }>;
    }>;

type InventoryIdentity = Readonly<{
  sourceId: string;
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  requestId: string;
  authorizationGeneration: string;
  nextCursor: string | null;
}>;

function exactKeys(value: object, keys: readonly string[]): boolean {
  try {
    const actual = Object.keys(value);
    return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
  } catch { return false; }
}

function safeCursor(value: unknown, directory: boolean): value is string | null | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > MAX_CURSOR_CHARACTERS || /\p{C}/u.test(value)) return false;
  return directory ? DIRECTORY_CURSOR.test(value) : true;
}

function validContinuation(value: unknown, sourceId: string, limit: number): value is ProjectAlphaApiV2SyncCursorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as Partial<ProjectAlphaApiV2SyncCursorPayload>;
  return exactKeys(value, ["v", "sourceId", "surface", "limit", "sourceInstanceId", "applicationId",
    "historyEpoch", "authorizationGeneration", "cursor", "expires"])
    && cursor.v === 1 && cursor.sourceId === sourceId
    && (cursor.surface === "directory" || cursor.surface === "projects") && cursor.limit === limit
    && typeof cursor.sourceInstanceId === "string" && /^[0-9a-f-]{36}$/i.test(cursor.sourceInstanceId)
    && typeof cursor.applicationId === "string" && /^[0-9a-f-]{36}$/i.test(cursor.applicationId)
    && typeof cursor.historyEpoch === "string" && /^[0-9a-f-]{36}$/i.test(cursor.historyEpoch)
    && typeof cursor.authorizationGeneration === "string" && /^(?:0|[1-9][0-9]{0,18})$/.test(cursor.authorizationGeneration)
    && typeof cursor.cursor === "string" && cursor.cursor.length > 0 && cursor.cursor.length <= MAX_CURSOR_CHARACTERS
    && !/\p{C}/u.test(cursor.cursor) && Number.isSafeInteger(cursor.expires);
}

function validInput(value: ProjectAlphaApiV2SyncPageInput): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = ["sourceId", ...(Object.hasOwn(value, "continuation") ? ["continuation"] : []),
    ...(Object.hasOwn(value, "limit") ? ["limit"] : [])];
  return exactKeys(value, keys)
    && SOURCE_ID.test(value.sourceId)
    && (value.limit === undefined || Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200)
    && (value.continuation === undefined || validContinuation(value.continuation, value.sourceId, value.limit ?? value.continuation.limit));
}

function canonicalDirectoryPage(inventory: ProjectAlphaDirectoryInventorySuccess, requestedCursor: string | null): string {
  return JSON.stringify({
    inventoryKind: "directory", sourceId: inventory.sourceId,
    sourceInstanceId: inventory.sourceInstanceId, applicationId: inventory.applicationId,
    historyEpoch: inventory.historyEpoch, requestId: inventory.requestId,
    authorizationGeneration: inventory.authorizationGeneration, requestedCursor,
    nextCursor: inventory.nextCursor,
    resources: inventory.resources.map(resource => ({
      type: resource.type, publicId: resource.publicId, revision: resource.revision,
      present: resource.present, lastAction: resource.lastAction,
      projectionSha256: resource.projectionSha256,
      binding: resource.binding === null ? null : {
        externalId: resource.binding.externalId, status: resource.binding.status,
        resourceRevision: resource.binding.resourceRevision,
      },
    })),
  });
}

function canonicalProjectPage(sourceId: string, inventory: ProjectAlphaProjectInventory, requestedCursor: string | null): string {
  return JSON.stringify({
    inventoryKind: "project", sourceId, sourceInstanceId: inventory.sourceInstanceId,
    applicationId: inventory.applicationId, historyEpoch: inventory.historyEpoch,
    requestId: inventory.requestId, authorizationGeneration: inventory.authorizationGeneration,
    requestedCursor, nextCursor: inventory.nextCursor,
    projects: inventory.projects.map(project => ({
      externalId: project.externalId, publicId: project.publicId, revision: project.revision,
      projectionSha256: project.projectionSha256, status: project.status, archived: project.archived,
    })),
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function receiptInsert(db: D1Database, identity: InventoryIdentity,
  inventoryKind: "directory" | "project", requestedCursor: string | null,
  pageSha256: string, itemCount: number): D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO project_alpha_api_v2_inventory_receipts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,
    authorization_generation,requested_cursor,next_cursor,page_sha256,item_count
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(
    identity.sourceId, identity.sourceInstanceId, identity.applicationId, identity.historyEpoch,
    inventoryKind, identity.requestId, identity.authorizationGeneration, requestedCursor,
    identity.nextCursor, pageSha256, itemCount,
  );
}

function requestReuseConflict(db: D1Database, identity: InventoryIdentity,
  inventoryKind: "directory" | "project", pageSha256: string): D1PreparedStatement {
  return db.prepare(`INSERT OR IGNORE INTO project_alpha_api_v2_inventory_conflicts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
    request_id,prior_reference,conflict_kind,details_json
  ) SELECT source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,'source',
      request_id,'request:'||request_id,'request_reuse_mismatch',
      json_object('observedPageSha256',?,'priorPageSha256',page_sha256)
    FROM project_alpha_api_v2_inventory_receipts
    WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
      AND inventory_kind=? AND request_id=? AND page_sha256<>?`).bind(
    pageSha256, identity.sourceId, identity.sourceInstanceId, identity.applicationId,
    identity.historyEpoch, inventoryKind, identity.requestId, pageSha256,
  );
}

async function persistedPageResult(db: D1Database, identity: InventoryIdentity,
  inventoryKind: "directory" | "project", pageSha256: string): Promise<ProjectAlphaApiV2PersistedPage | SurfaceFailure> {
  const receipt = await db.prepare(`SELECT page_sha256,item_count,next_cursor
    FROM project_alpha_api_v2_inventory_receipts
    WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
      AND inventory_kind=? AND request_id=?`).bind(
    identity.sourceId, identity.sourceInstanceId, identity.applicationId, identity.historyEpoch,
    inventoryKind, identity.requestId,
  ).first<{ page_sha256: string; item_count: number; next_cursor: string | null }>();
  if (!receipt || receipt.page_sha256 !== pageSha256) return { status: "blocked", reason: "storage" };
  const conflictCount = await db.prepare(`SELECT count(*) AS count
    FROM project_alpha_api_v2_inventory_conflicts
    WHERE source_id=? AND source_instance_id=? AND application_id=? AND history_epoch_id=?
      AND inventory_kind=? AND request_id=?`).bind(
    identity.sourceId, identity.sourceInstanceId, identity.applicationId, identity.historyEpoch,
    inventoryKind, identity.requestId,
  ).first<number>("count");
  const observedConflicts = conflictCount ?? 0;
  return { status: observedConflicts === 0 ? "persisted" : "conflicted",
    itemCount: receipt.item_count, conflictCount: observedConflicts, nextCursor: receipt.next_cursor,
    continuationIdentity: { sourceInstanceId: identity.sourceInstanceId, applicationId: identity.applicationId,
      historyEpoch: identity.historyEpoch, authorizationGeneration: identity.authorizationGeneration } };
}

export async function persistProjectAlphaDirectoryInventoryPage(db: D1Database,
  inventory: ProjectAlphaDirectoryInventorySuccess,
  requestedCursor: string | null): Promise<ProjectAlphaApiV2PersistedPage | SurfaceFailure> {
  const pageSha256 = await sha256(canonicalDirectoryPage(inventory, requestedCursor));
  const identity: InventoryIdentity = inventory;
  const statements: D1PreparedStatement[] = [requestReuseConflict(db, identity, "directory", pageSha256),
    receiptInsert(db, identity, "directory", requestedCursor, pageSha256, inventory.resources.length)];
  for (const resource of inventory.resources) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO project_alpha_api_v2_directory_observations(
      source_id,source_instance_id,application_id,history_epoch_id,request_id,resource_type,
      project_alpha_public_id,resource_revision,present,last_action,projection_sha256,
      binding_external_id,binding_status,binding_resource_revision
    ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM project_alpha_api_v2_inventory_receipts receipt
        WHERE receipt.source_id=? AND receipt.source_instance_id=? AND receipt.application_id=?
          AND receipt.history_epoch_id=? AND receipt.inventory_kind='directory'
          AND receipt.request_id=? AND receipt.page_sha256=?)`).bind(
      inventory.sourceId, inventory.sourceInstanceId, inventory.applicationId, inventory.historyEpoch,
      inventory.requestId, resource.type, resource.publicId, resource.revision,
      resource.present ? 1 : 0, resource.lastAction, resource.projectionSha256,
      resource.binding?.externalId ?? null, resource.binding?.status ?? null,
      resource.binding?.resourceRevision ?? null,
      inventory.sourceId, inventory.sourceInstanceId, inventory.applicationId, inventory.historyEpoch,
      inventory.requestId, pageSha256,
    ));
  }
  try {
    await db.batch(statements);
    return await persistedPageResult(db, identity, "directory", pageSha256);
  } catch { return { status: "blocked", reason: "storage" }; }
}

export async function persistProjectAlphaProjectInventoryPage(db: D1Database, sourceId: string,
  inventory: ProjectAlphaProjectInventory,
  requestedCursor: string | null): Promise<ProjectAlphaApiV2PersistedPage | SurfaceFailure> {
  const pageSha256 = await sha256(canonicalProjectPage(sourceId, inventory, requestedCursor));
  const identity: InventoryIdentity = { sourceId, sourceInstanceId: inventory.sourceInstanceId,
    applicationId: inventory.applicationId, historyEpoch: inventory.historyEpoch,
    requestId: inventory.requestId, authorizationGeneration: inventory.authorizationGeneration,
    nextCursor: inventory.nextCursor };
  const statements: D1PreparedStatement[] = [requestReuseConflict(db, identity, "project", pageSha256),
    receiptInsert(db, identity, "project", requestedCursor, pageSha256, inventory.projects.length)];
  for (const project of inventory.projects) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO project_alpha_api_v2_project_observations(
      source_id,source_instance_id,application_id,history_epoch_id,request_id,external_project_id,
      project_alpha_public_id,resource_revision,projection_sha256,lifecycle_status,archived
    ) SELECT ?,?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM project_alpha_api_v2_inventory_receipts receipt
        WHERE receipt.source_id=? AND receipt.source_instance_id=? AND receipt.application_id=?
          AND receipt.history_epoch_id=? AND receipt.inventory_kind='project'
          AND receipt.request_id=? AND receipt.page_sha256=?)`).bind(
      sourceId, inventory.sourceInstanceId, inventory.applicationId, inventory.historyEpoch,
      inventory.requestId, project.externalId, project.publicId, project.revision,
      project.projectionSha256, project.status, project.archived ? 1 : 0,
      sourceId, inventory.sourceInstanceId, inventory.applicationId, inventory.historyEpoch,
      inventory.requestId, pageSha256,
    ));
  }
  try {
    await db.batch(statements);
    return await persistedPageResult(db, identity, "project", pageSha256);
  } catch { return { status: "blocked", reason: "storage" }; }
}

export async function persistProjectAlphaProjectBindingStale(db: D1Database, sourceId: string,
  stale: ProjectAlphaProjectInventoryStaleBinding): Promise<SurfaceFailure> {
  try {
    await db.prepare(`INSERT OR IGNORE INTO project_alpha_api_v2_inventory_conflicts(
      source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
      external_id,request_id,prior_reference,conflict_kind,details_json
    ) VALUES(?,?,?,?,?,'project',?,?,'pa-binding:'||?,'binding_stale',json_object('externalId',?))`).bind(
      sourceId, stale.sourceInstanceId, stale.applicationId, stale.historyEpoch, "project",
      stale.error.externalId, stale.requestId, stale.error.externalId, stale.error.externalId,
    ).run();
    return { status: "blocked", reason: "binding_stale" };
  } catch { return { status: "blocked", reason: "storage" }; }
}

function safeSurfaceFailure(outcome: Readonly<{ status: string; reason?: string }>): SurfaceFailure {
  if (outcome.status === "blocked" && (outcome.reason === "credentials_or_scope" || outcome.reason === "preflight"))
    return { status: "blocked", reason: "authorization" };
  if (outcome.reason === "invalid_contract" || outcome.reason === "response_limit")
    return { status: "blocked", reason: "contract" };
  return { status: "blocked", reason: "transport" };
}

export function projectAlphaApiV2SyncEnabled(env: Pick<ProjectAlphaApiV2SyncEnvironment,
  "PROJECT_ALPHA_API_V2_SYNC_ENABLED">): boolean {
  return env.PROJECT_ALPHA_API_V2_SYNC_ENABLED === "true";
}

/** Reads and persists at most one page per requested surface. It does not chase
 * cursors, infer matches, create native records, alter PA, or publish portal data. */
export async function runProjectAlphaApiV2SyncPage(env: ProjectAlphaApiV2SyncEnvironment,
  input: ProjectAlphaApiV2SyncPageInput, send: typeof fetch = fetch): Promise<ProjectAlphaApiV2SyncPageOutcome> {
  if (!projectAlphaApiV2SyncEnabled(env)) return { status: "disabled" };
  if (!validInput(input)) return { status: "rejected", reason: "invalid_input" };
  const continuation = input.continuation;
  const limit = input.limit ?? continuation?.limit ?? 100;
  const selected = await withEnabledConfiguredProjectAlphaApiV2Connection(env, input.sourceId,
    async connection => {
      const probe = await probeProjectAlphaApiV2(connection, [], send, [
        PROJECT_ALPHA_DIRECTORY_INVENTORY_ENDPOINT, PROJECT_ALPHA_PROJECT_INVENTORY_ENDPOINT]);
      if (probe.status !== "verified") return { status: "blocked", reason: "capabilities" } as const;
      if (continuation && (connection.expectedSourceInstanceId !== continuation.sourceInstanceId
        || connection.expectedApplicationId !== continuation.applicationId || connection.expectedHistoryEpoch !== continuation.historyEpoch))
        return { status: "partial", directory: { status: "blocked", reason: "cursor_stale" },
          projects: { status: "blocked", reason: "cursor_stale" } } as const;
      const readDirectory = !continuation || continuation.surface === "directory";
      const readProjects = !continuation || continuation.surface === "projects";
      const directoryRead = readDirectory ? await readProjectAlphaDirectoryInventoryAfterVerifiedCapabilities(connection, input.sourceId,
        { type: "all", cursor: continuation?.surface === "directory" ? continuation.cursor : null, limit }, send) : null;
      const projectRead = readProjects ? await readProjectAlphaProjectInventoryAfterVerifiedCapabilities(connection,
        { cursor: continuation?.surface === "projects" ? continuation.cursor : null, limit }, send) : null;
      let directory: ProjectAlphaApiV2PersistedPage | SurfaceFailure | Readonly<{ status: "not_requested" }>;
      if (!directoryRead) directory = { status: "not_requested" };
      else if (directoryRead.status === "observed") {
        const actual = directoryRead.inventory;
        if (continuation?.surface === "directory" && (actual.sourceInstanceId !== continuation.sourceInstanceId
          || actual.applicationId !== continuation.applicationId || actual.historyEpoch !== continuation.historyEpoch
          || actual.authorizationGeneration !== continuation.authorizationGeneration))
          directory = { status: "blocked", reason: "cursor_stale" };
        else directory = await persistProjectAlphaDirectoryInventoryPage(env.OPS_DB, actual,
          continuation?.surface === "directory" ? continuation.cursor : null);
      } else directory = safeSurfaceFailure(directoryRead);
      let projects: ProjectAlphaApiV2PersistedPage | SurfaceFailure | Readonly<{ status: "not_requested" }>;
      if (!projectRead) projects = { status: "not_requested" };
      else if (projectRead.status === "observed") {
        const actual = projectRead.response;
        if (continuation?.surface === "projects" && (actual.sourceInstanceId !== continuation.sourceInstanceId
          || actual.applicationId !== continuation.applicationId || actual.historyEpoch !== continuation.historyEpoch
          || actual.authorizationGeneration !== continuation.authorizationGeneration))
          projects = { status: "blocked", reason: "cursor_stale" };
        else projects = await persistProjectAlphaProjectInventoryPage(env.OPS_DB, input.sourceId, actual,
          continuation?.surface === "projects" ? continuation.cursor : null);
      } else if (projectRead.status === "binding_stale")
        projects = await persistProjectAlphaProjectBindingStale(env.OPS_DB, input.sourceId, projectRead.response);
      else projects = safeSurfaceFailure(projectRead);
      const requested = [directory, projects].filter(surface => surface.status !== "not_requested");
      return { status: requested.every(surface => surface.status === "persisted") ? "completed" : "partial",
        directory, projects } as const;
    });
  if (selected.status !== "enabled") return { status: "blocked", reason: "connection" };
  return selected.value;
}
