import { buildNavigationDestination } from "@ltds/shared";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  hasLocalGlobalAllow,
  hasPermission,
  requirePermission,
  sqlScope,
} from "./acl";
import { encodeRef, mime } from "./delivery";
import { auditAddress } from "./request-security";
import { serveSourceFile } from "./source-file";
import type { Env, ResourceContext, StaffPrincipal } from "./types";
import { paResourceFilter } from "./visibility";

type AppEnv = {
  Bindings: Env;
  Variables: { principal: StaffPrincipal; administrator: boolean };
};
type App = Hono<AppEnv>;
type AppContext = Context<AppEnv>;

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;
const scopeItemSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    category: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(160),
    instructions: z.string().trim().min(1).max(12_000),
    presetRef: z.string().trim().min(1).max(128).nullable().optional(),
  })
  .strict();
const saveBriefSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    items: z.array(scopeItemSchema).max(50),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.items.map(item => item.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: "custom", message: "Scope item IDs must be unique" });
  });
const referenceSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    objectKey: z.string().trim().min(1).max(1000),
    displayName: z.string().trim().min(1).max(255).optional(),
  })
  .strict();
const storedScopeItemSchema = scopeItemSchema.extend({
  sortOrder: z.number().int().min(0),
  presetRef: z.string().trim().min(1).max(128).nullable(),
});
const storedSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  items: z.array(storedScopeItemSchema).max(50),
  attachments: z.array(z.unknown()).max(500),
});

export interface JobBriefScopeItem {
  id: string;
  category: string;
  title: string;
  instructions: string;
  sortOrder: number;
  presetRef: string | null;
}

interface BriefSnapshot {
  schemaVersion: 1;
  items: JobBriefScopeItem[];
  attachments: AttachmentDto[];
}

interface OperationRow {
  id: string;
  project_id: string;
  title: string;
  status: string;
  scheduled_start_at: string | null;
  scheduled_end_at: string | null;
  location: string | null;
  division_id: string | null;
  service_location_name: string | null;
  service_latitude: number | null;
  service_longitude: number | null;
  assigned_staff_ids: string | null;
}

interface BriefRow {
  operation_id: string;
  version: number;
  snapshot_json: string;
  created_at: string;
  updated_at: string;
  updated_by: string;
  updated_by_name: string;
  updated_by_email: string;
}

interface AttachmentRow {
  id: string;
  operation_id: string;
  version_added: number;
  source_kind: "staff_upload" | "project_file";
  object_key: string;
  display_name: string;
  content_type: string;
  size: number;
  etag: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
}

interface RevisionRow {
  version: number;
  change_kind: string;
  author_id: string;
  author_email: string;
  author_display_name: string;
  created_at: string;
}

interface AttachmentDto {
  id: string;
  versionAdded: number;
  sourceKind: AttachmentRow["source_kind"];
  displayName: string;
  contentType: string;
  size: number;
  createdBy: { id: string; displayName: string };
  createdAt: string;
  contentUrl: string;
}

interface NewAttachment {
  id: string;
  sourceKind: AttachmentRow["source_kind"];
  sourceReference: string | null;
  objectKey: string;
  displayName: string;
  contentType: string;
  size: number;
  etag: string;
}

function parseJsonBody<T>(value: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new HTTPException(400, {
      message: parsed.error.issues.map(issue => issue.message).join("; "),
    });
  return parsed.data;
}

async function jsonBody<T>(c: AppContext, schema: z.ZodType<T>): Promise<T> {
  const value = await c.req.json().catch(() => {
    throw new HTTPException(400, { message: "Request body must be JSON" });
  });
  return parseJsonBody(value, schema);
}

function resourceContext(operation: OperationRow): ResourceContext {
  return {
    divisionId: operation.division_id,
    assignedStaffIds: operation.assigned_staff_ids?.split(",").filter(Boolean) || [],
  };
}

async function visibleOperation(
  env: Env,
  principal: StaffPrincipal,
  administrator: boolean,
  operationId: string,
): Promise<OperationRow> {
  await requirePermission(env, principal, "operations.view");
  const [scope, explicitAll] = await Promise.all([
    sqlScope(env, principal, "operations.view"),
    hasLocalGlobalAllow(env, principal, "operations.view_all"),
  ]);
  const filter = paResourceFilter(
    scope,
    principal,
    administrator,
    "o",
    "operation",
    explicitAll,
  );
  const row = await env.OPS_DB.withSession("first-primary")
    .prepare(
      `SELECT o.id,o.project_id,o.title,o.status,o.scheduled_start_at,o.scheduled_end_at,o.location,
        d.id division_id,
        (SELECT sl.name FROM pa_service_locations sl WHERE sl.project_id=o.project_id AND sl.active=1 AND sl.latitude IS NOT NULL AND sl.longitude IS NOT NULL ORDER BY sl.id LIMIT 1) service_location_name,
        (SELECT sl.latitude FROM pa_service_locations sl WHERE sl.project_id=o.project_id AND sl.active=1 AND sl.latitude IS NOT NULL AND sl.longitude IS NOT NULL ORDER BY sl.id LIMIT 1) service_latitude,
        (SELECT sl.longitude FROM pa_service_locations sl WHERE sl.project_id=o.project_id AND sl.active=1 AND sl.latitude IS NOT NULL AND sl.longitude IS NOT NULL ORDER BY sl.id LIMIT 1) service_longitude,
        (SELECT GROUP_CONCAT(s.id) FROM pa_operation_assignments a JOIN staff_users s ON s.project_alpha_user_id=a.user_id WHERE a.operation_id=o.id AND a.active=1) assigned_staff_ids
       FROM pa_operations o
       LEFT JOIN divisions d ON d.project_alpha_business_unit_id=o.business_unit_id
       WHERE o.id=? AND ${filter.sql}`,
    )
    .bind(operationId, ...filter.values)
    .first<OperationRow>();
  if (!row) throw new HTTPException(404, { message: "Operation not found" });
  return row;
}

async function requireEdit(
  env: Env,
  principal: StaffPrincipal,
  operation: OperationRow,
): Promise<void> {
  await requirePermission(
    env,
    principal,
    "operations.manage",
    resourceContext(operation),
  );
}

function parseSnapshot(value: string): BriefSnapshot {
  try {
    const parsed = storedSnapshotSchema.safeParse(JSON.parse(value));
    if (parsed.success)
      return {
        schemaVersion: 1,
        items: parsed.data.items,
        attachments: [],
      };
  } catch {
    // The generic error handler logs corrupted persisted state without leaking it.
  }
  throw new Error("Operational job brief snapshot is invalid");
}

function attachmentDto(operationId: string, row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    versionAdded: row.version_added,
    sourceKind: row.source_kind,
    displayName: row.display_name,
    contentType: row.content_type,
    size: row.size,
    createdBy: { id: row.created_by, displayName: row.created_by_name },
    createdAt: row.created_at,
    contentUrl: `/api/operations/${encodeURIComponent(operationId)}/job-brief/attachments/${encodeURIComponent(row.id)}/content`,
  };
}

async function currentVersion(env: Env, operationId: string): Promise<number> {
  const row = await env.OPS_DB.withSession("first-primary")
    .prepare("SELECT version FROM operational_job_briefs WHERE operation_id=?")
    .bind(operationId)
    .first<{ version: number }>();
  return row?.version || 0;
}

async function loadAttachments(env: Env, operationId: string): Promise<AttachmentRow[]> {
  const result = await env.OPS_DB.withSession("first-primary")
    .prepare(
      `SELECT a.id,a.operation_id,a.version_added,a.source_kind,a.object_key,a.display_name,a.content_type,a.size,a.etag,a.created_by,s.display_name created_by_name,a.created_at
       FROM operational_job_brief_attachments a
       JOIN staff_users s ON s.id=a.created_by
       WHERE a.operation_id=? ORDER BY a.version_added,a.id`,
    )
    .bind(operationId)
    .all<AttachmentRow>();
  return result.results;
}

async function loadBrief(
  env: Env,
  principal: StaffPrincipal,
  operation: OperationRow,
) {
  const session = env.OPS_DB.withSession("first-primary");
  const results = await session.batch<BriefRow | AttachmentRow | RevisionRow>([
    session.prepare(
        `SELECT b.operation_id,b.version,b.snapshot_json,b.created_at,b.updated_at,b.updated_by,s.display_name updated_by_name,s.email updated_by_email
         FROM operational_job_briefs b JOIN staff_users s ON s.id=b.updated_by
         WHERE b.operation_id=?`,
      )
      .bind(operation.id),
    session.prepare(
        `SELECT a.id,a.operation_id,a.version_added,a.source_kind,a.object_key,a.display_name,a.content_type,a.size,a.etag,a.created_by,s.display_name created_by_name,a.created_at
         FROM operational_job_brief_attachments a JOIN staff_users s ON s.id=a.created_by
         WHERE a.operation_id=? ORDER BY a.version_added,a.id`,
      )
      .bind(operation.id),
    session.prepare(
        `SELECT version,change_kind,author_id,author_email,author_display_name,created_at
         FROM operational_job_brief_revisions WHERE operation_id=? ORDER BY version DESC LIMIT 100`,
      )
      .bind(operation.id),
  ]);
  const briefResult = results[0]!, attachments = results[1]!, revisions = results[2]!;
  const row = briefResult.results.find((value): value is BriefRow => "snapshot_json" in value);
  const attachmentRows = attachments.results.filter((value): value is AttachmentRow => "object_key" in value);
  const revisionRows = revisions.results.filter((value): value is RevisionRow => "change_kind" in value);
  const canEdit = await hasPermission(
    env,
    principal,
    "operations.manage",
    resourceContext(operation),
  );
  const navigation = buildNavigationDestination({
    latitude: operation.service_latitude,
    longitude: operation.service_longitude,
    label: operation.service_location_name || operation.location || operation.title,
  });
  return {
    operation: {
      id: operation.id,
      title: operation.title,
      status: operation.status,
      scheduledStart: operation.scheduled_start_at,
      scheduledEnd: operation.scheduled_end_at,
      location: operation.location,
      navigation,
    },
    brief: row
      ? {
          version: row.version,
          items: parseSnapshot(row.snapshot_json).items,
          attachments: attachmentRows.map(item => attachmentDto(operation.id, item)),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          updatedBy: {
            id: row.updated_by,
            displayName: row.updated_by_name,
          },
        }
      : null,
    history: revisionRows.map(revision => ({
      version: revision.version,
      changeKind: revision.change_kind,
      author: {
        id: revision.author_id,
        displayName: revision.author_display_name,
      },
      createdAt: revision.created_at,
    })),
    canEdit,
  };
}

function snapshot(items: JobBriefScopeItem[], attachments: AttachmentDto[]): BriefSnapshot {
  return { schemaVersion: 1, items, attachments };
}

async function mutationStatements(
  env: Env,
  request: Request,
  principal: StaffPrincipal,
  operation: OperationRow,
  expectedVersion: number,
  nextSnapshot: BriefSnapshot,
  changeKind: "scope_saved" | "attachment_added",
  attachment?: NewAttachment,
): Promise<D1PreparedStatement[]> {
  const version = expectedVersion + 1;
  const snapshotJson = JSON.stringify(nextSnapshot);
  const mutation = expectedVersion === 0
    ? env.OPS_DB.prepare(
        `INSERT OR IGNORE INTO operational_job_briefs(operation_id,version,snapshot_json,created_by,updated_by)
         VALUES (?,1,?,?,?)`,
      ).bind(operation.id, snapshotJson, principal.id, principal.id)
    : env.OPS_DB.prepare(
        `UPDATE operational_job_briefs
         SET version=?,snapshot_json=?,updated_by=?,updated_at=datetime('now')
         WHERE operation_id=? AND version=?`,
      ).bind(version, snapshotJson, principal.id, operation.id, expectedVersion);
  const statements: D1PreparedStatement[] = [mutation];
  if (attachment)
    statements.push(
      env.OPS_DB.prepare(
        `INSERT INTO operational_job_brief_attachments(id,operation_id,version_added,source_kind,source_reference,object_key,display_name,content_type,size,etag,created_by)
         SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1`,
      ).bind(
        attachment.id,
        operation.id,
        version,
        attachment.sourceKind,
        attachment.sourceReference,
        attachment.objectKey,
        attachment.displayName,
        attachment.contentType,
        attachment.size,
        attachment.etag,
        principal.id,
      ),
    );
  statements.push(
    env.OPS_DB.prepare(
      `INSERT INTO operational_job_brief_revisions(id,operation_id,version,change_kind,snapshot_json,author_id,author_email,author_display_name)
       SELECT ?,?,?,?,?,?,?,? WHERE changes()=1`,
    ).bind(
      crypto.randomUUID(),
      operation.id,
      version,
      changeKind,
      snapshotJson,
      principal.id,
      principal.email,
      principal.displayName,
    ),
  );
  const address = await auditAddress(env, request);
  statements.push(
    env.OPS_DB.prepare(
      `INSERT INTO audit_events(actor_type,actor_id,actor_email,actor_display_name,action,entity_type,entity_id,division_id,details_json,client_address_hash)
       SELECT 'staff',?,?,?,?,?,?,?,?,? WHERE changes()=1`,
    ).bind(
      principal.id,
      principal.email,
      principal.displayName,
      `job_brief.${changeKind}`,
      "operational_job_brief",
      operation.id,
      operation.division_id,
      JSON.stringify({
        version,
        itemCount: nextSnapshot.items.length,
        attachmentCount: nextSnapshot.attachments.length,
        attachmentId: attachment?.id || null,
        attachmentSource: attachment?.sourceKind || null,
      }),
      address,
    ),
  );
  return statements;
}

async function saveScope(
  env: Env,
  request: Request,
  principal: StaffPrincipal,
  operation: OperationRow,
  value: z.infer<typeof saveBriefSchema>,
): Promise<boolean> {
  const attachments = await loadAttachments(env, operation.id);
  const items = value.items.map((item, sortOrder) => ({
    ...item,
    sortOrder,
    presetRef: item.presetRef || null,
  }));
  const nextSnapshot = snapshot(
    items,
    attachments.map(item => attachmentDto(operation.id, item)),
  );
  const results = await env.OPS_DB.batch(
    await mutationStatements(
      env,
      request,
      principal,
      operation,
      value.expectedVersion,
      nextSnapshot,
      "scope_saved",
    ),
  );
  return Boolean(results[0]?.meta.changes);
}

async function addAttachment(
  env: Env,
  request: Request,
  principal: StaffPrincipal,
  operation: OperationRow,
  expectedVersion: number,
  attachment: NewAttachment,
): Promise<boolean> {
  const current = await env.OPS_DB.withSession("first-primary")
    .prepare("SELECT snapshot_json FROM operational_job_briefs WHERE operation_id=? AND version=?")
    .bind(operation.id, expectedVersion)
    .first<{ snapshot_json: string }>();
  if (expectedVersion > 0 && !current) return false;
  const items = current ? parseSnapshot(current.snapshot_json).items : [];
  const attachments = await loadAttachments(env, operation.id);
  const addedRow: AttachmentRow = {
    id: attachment.id,
    operation_id: operation.id,
    version_added: expectedVersion + 1,
    source_kind: attachment.sourceKind,
    object_key: attachment.objectKey,
    display_name: attachment.displayName,
    content_type: attachment.contentType,
    size: attachment.size,
    etag: attachment.etag,
    created_by: principal.id,
    created_by_name: principal.displayName,
    created_at: new Date().toISOString(),
  };
  const nextSnapshot = snapshot(items, [
    ...attachments.map(item => attachmentDto(operation.id, item)),
    attachmentDto(operation.id, addedRow),
  ]);
  const results = await env.OPS_DB.batch(
    await mutationStatements(
      env,
      request,
      principal,
      operation,
      expectedVersion,
      nextSnapshot,
      "attachment_added",
      attachment,
    ),
  );
  return Boolean(results[0]?.meta.changes);
}

function safeFileName(value: string): string {
  const name = value.trim().split(/[\\/]/).pop()?.trim() || "attachment";
  const safe = name.replace(/[\0-\x1f\x7f"<>:|?*]/g, "_").slice(0, 255);
  if (!safe || safe === "." || safe === "..")
    throw new HTTPException(400, { message: "A valid file name is required" });
  return safe;
}

function normalizeProjectFileKey(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  const segments = normalized.split("/");
  if (
    !normalized.startsWith("Jobs/Clients/") ||
    normalized.endsWith("/") ||
    segments.some(segment => !segment || segment === "." || segment === ".." || ["dump", "_ltds", ".previews"].includes(segment.toLowerCase()))
  )
    throw new HTTPException(400, { message: "Project file path is invalid" });
  return normalized;
}

async function projectFile(
  env: Env,
  operation: OperationRow,
  key: string,
): Promise<{ size: number; etag: string; content_type: string | null }> {
  const row = await env.DELIVERY_DB.withSession("first-primary")
    .prepare(
      `SELECT f.size,f.etag,f.content_type
       FROM client_folder_associations association
       JOIN client_accounts account ON account.id=association.account_id AND account.status='active'
       JOIN projects p ON p.id=association.project_id AND p.active=1
       JOIN file_index f ON f.r2_key=? AND substr(f.r2_key,1,length(association.r2_prefix))=association.r2_prefix
       WHERE association.scope_type='project' AND association.revoked_at IS NULL
         AND p.project_alpha_project_id=?
       ORDER BY length(association.r2_prefix) DESC LIMIT 1`,
    )
    .bind(key, operation.project_id)
    .first<{ size: number; etag: string; content_type: string | null }>();
  if (!row) throw new HTTPException(404, { message: "Project file not found" });
  const head = await env.DATA_BUCKET.head(key);
  if (!head || head.httpEtag !== row.etag || head.size !== row.size)
    throw new HTTPException(409, { message: "Project file changed before it could be attached" });
  return row;
}

function conflict(c: AppContext, version: number) {
  return c.json(
    { error: "The job brief changed. Refresh and try again.", currentVersion: version },
    409,
  );
}

export function registerJobBriefRoutes(app: App): void {
  app.get("/api/operations/:id/job-brief", async c => {
    const operation = await visibleOperation(
      c.env,
      c.get("principal"),
      c.get("administrator"),
      c.req.param("id"),
    );
    return c.json(await loadBrief(c.env, c.get("principal"), operation));
  });

  app.put("/api/operations/:id/job-brief", async c => {
    const principal = c.get("principal");
    const operation = await visibleOperation(
      c.env,
      principal,
      c.get("administrator"),
      c.req.param("id"),
    );
    await requireEdit(c.env, principal, operation);
    const value = await jsonBody(c, saveBriefSchema);
    if (!(await saveScope(c.env, c.req.raw, principal, operation, value)))
      return conflict(c, await currentVersion(c.env, operation.id));
    return c.json(await loadBrief(c.env, principal, operation));
  });

  app.post("/api/operations/:id/job-brief/attachments/upload", async c => {
    const principal = c.get("principal");
    const operation = await visibleOperation(
      c.env,
      principal,
      c.get("administrator"),
      c.req.param("id"),
    );
    await requireEdit(c.env, principal, operation);
    const expectedVersion = Number(c.req.header("X-Expected-Version"));
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
      throw new HTTPException(400, { message: "X-Expected-Version is required" });
    const declaredSize = Number(c.req.header("Content-Length") || 0);
    if (declaredSize > MAX_ATTACHMENT_SIZE)
      throw new HTTPException(413, { message: "Attachments are limited to 25 MiB" });
    if (!c.req.raw.body)
      throw new HTTPException(400, { message: "Attachment content is required" });
    const displayName = safeFileName(c.req.header("X-File-Name") || "attachment");
    const contentType = (c.req.header("Content-Type") || "application/octet-stream").slice(0, 200);
    const id = crypto.randomUUID();
    // `_ltds` is a reserved segment rejected by the generic delivery browser.
    // Only the operation-authorized attachment route can serve these bytes.
    const objectKey = `Jobs/Operations/_ltds/JobBriefs/${id}/${displayName}`;
    let observed = 0, tooLarge = false;
    let committed = false;
    const limiter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        observed += chunk.byteLength;
        if (observed > MAX_ATTACHMENT_SIZE) {
          tooLarge = true;
          controller.error(new Error("attachment-too-large"));
          return;
        }
        controller.enqueue(chunk);
      },
    });
    try {
      const stored = await c.env.DATA_BUCKET.put(
        objectKey,
        c.req.raw.body.pipeThrough(limiter),
        { httpMetadata: { contentType } },
      );
      if (!stored.size) {
        await c.env.DATA_BUCKET.delete(objectKey);
        throw new HTTPException(400, { message: "Attachment content is required" });
      }
      const added = await addAttachment(c.env, c.req.raw, principal, operation, expectedVersion, {
        id,
        sourceKind: "staff_upload",
        sourceReference: null,
        objectKey,
        displayName,
        contentType,
        size: stored.size,
        etag: stored.httpEtag,
      });
      if (!added) {
        await c.env.DATA_BUCKET.delete(objectKey);
        return conflict(c, await currentVersion(c.env, operation.id));
      }
      committed = true;
      return c.json(await loadBrief(c.env, principal, operation), 201);
    } catch (error) {
      if (!committed)
        await c.env.DATA_BUCKET.delete(objectKey).catch(() => undefined);
      if (error instanceof HTTPException) throw error;
      if (tooLarge || (error instanceof Error && error.message === "attachment-too-large"))
        throw new HTTPException(413, { message: "Attachments are limited to 25 MiB" });
      throw error;
    }
  });

  app.post("/api/operations/:id/job-brief/attachments/reference", async c => {
    const principal = c.get("principal");
    const operation = await visibleOperation(
      c.env,
      principal,
      c.get("administrator"),
      c.req.param("id"),
    );
    await requireEdit(c.env, principal, operation);
    await requirePermission(c.env, principal, "delivery.browse", resourceContext(operation));
    const value = await jsonBody(c, referenceSchema);
    const key = normalizeProjectFileKey(value.objectKey);
    const existing = await c.env.OPS_DB.withSession("first-primary")
      .prepare(
        "SELECT id FROM operational_job_brief_attachments WHERE operation_id=? AND object_key=?",
      )
      .bind(operation.id, key)
      .first<{ id: string }>();
    if (existing)
      throw new HTTPException(409, { message: "This project file is already attached to the job brief" });
    // This proves project authorization, not who originally uploaded the file.
    const indexed = await projectFile(c.env, operation, key);
    const id = crypto.randomUUID();
    const added = await addAttachment(c.env, c.req.raw, principal, operation, value.expectedVersion, {
      id,
      sourceKind: "project_file",
      sourceReference: encodeRef(key),
      objectKey: key,
      displayName: safeFileName(value.displayName || key),
      contentType: indexed.content_type || mime(key),
      size: indexed.size,
      etag: indexed.etag,
    });
    if (!added) return conflict(c, await currentVersion(c.env, operation.id));
    return c.json(await loadBrief(c.env, principal, operation), 201);
  });

  app.on(["GET", "HEAD"], "/api/operations/:id/job-brief/attachments/:attachmentId/content", async c => {
    const operation = await visibleOperation(
      c.env,
      c.get("principal"),
      c.get("administrator"),
      c.req.param("id"),
    );
    const attachment = await c.env.OPS_DB.withSession("first-primary")
      .prepare(
        `SELECT object_key,etag FROM operational_job_brief_attachments
         WHERE id=? AND operation_id=?`,
      )
      .bind(c.req.param("attachmentId"), operation.id)
      .first<{ object_key: string; etag: string }>();
    if (!attachment)
      throw new HTTPException(404, { message: "Attachment not found" });
    return serveSourceFile(
      c.env.DATA_BUCKET,
      attachment.object_key,
      c.req,
      "attachment",
      attachment.etag,
    );
  });
}
