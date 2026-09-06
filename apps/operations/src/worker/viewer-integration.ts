import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  ViewerServiceClient,
  ViewerServiceError,
  viewerServiceConfigured,
  viewerServiceOrigin,
  type Permission,
  type ViewerAudience,
  type ViewerDisplayUnits,
  type ViewerModelSummary,
  type ViewerSessionGrant,
} from "@ltds/shared";
import { z } from "zod";
import { sqlScope } from "./acl";
import { sha256 } from "./crypto";
import { auditStatement } from "./request-security";
import type { Env, StaffPrincipal } from "./types";
import { resolveViewerUnits } from "./viewer-units";

type Variables = { principal: StaffPrincipal; administrator: boolean };
type ViewerApp = Hono<{ Bindings: Env; Variables: Variables }>;

const opaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const idempotencyKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const associationInput = z.object({ projectId: opaqueId, viewerModelId: opaqueId }).strict();
const clientGrantInput = z.object({
  accountId: opaqueId,
  projectId: opaqueId,
  scopeType: z.enum(["project", "task"]),
  associationId: opaqueId.nullable(),
  includeFuturePublished: z.boolean().default(true),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  permissions: z.object({ measure: z.boolean().default(true), cameras: z.boolean().default(true), download: z.boolean().default(false) }).strict(),
}).strict().superRefine((value, context) => {
  if (value.scopeType === "project" && value.associationId !== null)
    context.addIssue({ code: "custom", path: ["associationId"], message: "Project grants cannot select a task" });
  if (value.scopeType === "task" && value.associationId === null)
    context.addIssue({ code: "custom", path: ["associationId"], message: "Task grants require an association" });
  if (value.scopeType === "task" && value.includeFuturePublished)
    context.addIssue({ code: "custom", path: ["includeFuturePublished"], message: "Task grants cannot include future tasks" });
  if (value.expiresAt && Date.parse(value.expiresAt) <= Date.now())
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Grant expiry must be in the future" });
});
const nativeClientGrantInput = z.object({
  sourceId: z.string().min(15).max(78).regex(/^project-alpha:[a-z0-9][a-z0-9_-]*$/),
  workspaceId: opaqueId,
  projectPublicId: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/),
  scopeType: z.enum(["project", "task"]),
  associationId: opaqueId.nullable(),
  includeFuturePublished: z.boolean().default(false),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  permissions: z.object({ measure: z.boolean().default(true), cameras: z.boolean().default(true), download: z.boolean().default(false) }).strict(),
}).strict().superRefine((value, context) => {
  if (value.scopeType === "project" && value.associationId !== null)
    context.addIssue({ code: "custom", path: ["associationId"], message: "Project grants cannot select a task" });
  if (value.scopeType === "task" && value.associationId === null)
    context.addIssue({ code: "custom", path: ["associationId"], message: "Task grants require an association" });
  if (value.scopeType === "task" && value.includeFuturePublished)
    context.addIssue({ code: "custom", path: ["includeFuturePublished"], message: "Task grants cannot include future tasks" });
  if (value.scopeType === "project" && !value.includeFuturePublished)
    context.addIssue({ code: "custom", path: ["includeFuturePublished"], message: "Project grants must include published tasks" });
  if (value.expiresAt && Date.parse(value.expiresAt) <= Date.now())
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Grant expiry must be in the future" });
});
const revokeInput = z.object({ reason: z.string().trim().min(1).max(240) }).strict();
const nativeClientGrantSnapshot = z.object({
  id: opaqueId, source_id: z.string(), workspace_id: opaqueId, project_public_id: z.string(),
  scope_type: z.enum(["project", "task"]), association_id: opaqueId.nullable(), include_future_published: z.number().int(),
  can_measure: z.number().int(), can_view_cameras: z.number().int(), can_download: z.number().int(),
  authorization_expires_at: z.string().nullable(), grant_version: z.number().int(), status: z.literal("active"),
  created_by_staff_id: opaqueId, created_at: z.string(), updated_at: z.string(), revoked_at: z.null(),
  revoked_by_staff_id: z.null(), revoke_reason: z.null(), workspace_name: z.string(), project_name: z.string(),
  model_title: z.string().nullable(),
}).strict();
type NativeClientGrantSnapshot = z.infer<typeof nativeClientGrantSnapshot>;
function parseNativeClientGrantSnapshot(value:string):NativeClientGrantSnapshot{
  let decoded:unknown;
  try{decoded=JSON.parse(value);}catch{throw new HTTPException(500,{message:"Stored native Viewer grant receipt is invalid"});}
  const parsed=nativeClientGrantSnapshot.safeParse(decoded);
  if(!parsed.success)throw new HTTPException(500,{message:"Stored native Viewer grant receipt is invalid"});
  return parsed.data;
}
const publicShareInput = z.object({
  label: z.string().trim().max(120).nullable().optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  password: z.string().min(8).max(128).optional(),
  displayUnits: z.enum(["imperial", "metric"]).default("imperial"),
  permissions: z.object({
    view: z.literal(true),
    measure: z.boolean().default(true),
    cameras: z.boolean().default(true),
    download: z.boolean().default(false),
  }).strict().default({ view: true, measure: true, cameras: true, download: false }),
}).strict().superRefine((value, context) => {
  if (value.expiresAt === null) return;
  const expiry = Date.parse(value.expiresAt), now = Date.now();
  if (expiry < now + 5 * 60 * 1000)
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Expiry must be at least five minutes in the future" });
  if (expiry > now + 30 * 24 * 60 * 60 * 1000)
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Expiry cannot be more than 30 days in the future" });
});

export interface AssociationRow {
  id: string;
  project_id: string;
  project_alpha_project_id: string;
  project_source_version: string;
  viewer_model_id: string;
  viewer_model_version_id: string;
  viewer_resource_version: string;
  model_title: string;
  model_provider: string;
  model_status: string;
  state: "active" | "revoked" | "source_stale";
  association_version: number;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  authorization_expires_at?: string | null;
  viewer_grant_expires_at?: string | null;
  authorization_can_measure?: number;
  authorization_can_view_cameras?: number;
  authorization_can_download?: number;
  project_name?: string;
  client_name?: string;
  project_active?: number;
  current_project_source_version?: string | null;
}

interface PortalProjectRow {
  id: string;
  project_alpha_project_id: string;
  project_name: string;
  client_name: string;
  source_updated_at: string;
}

function primaryDeliveryDb(env: Env): D1Database {
  const db = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return db.withSession?.("first-primary") ?? db;
}

async function requireGlobalViewer(
  env: Env,
  principal: StaffPrincipal,
  permission: Extract<Permission, "viewer.view" | "viewer.manage" | "viewer.share.create" | "viewer.share.revoke">,
): Promise<void> {
  const [viewScope, actionScope] = await Promise.all([
    sqlScope(env, principal, "viewer.view"),
    permission === "viewer.view" ? Promise.resolve(null) : sqlScope(env, principal, permission),
  ]);
  if (!viewScope.global || viewScope.deniedGlobal)
    throw new HTTPException(403, { message: "Global viewer.view permission required" });
  if (actionScope && (!actionScope.global || actionScope.deniedGlobal))
    throw new HTTPException(403, { message: `Global ${permission} permission required` });
}

export function viewerIntegrationEnabled(env: Pick<Env, "VIEWER_INTEGRATION_ENABLED">): boolean {
  return env.VIEWER_INTEGRATION_ENABLED === "true";
}

export function viewerPublicSharesEnabled(
  env: Pick<Env, "VIEWER_INTEGRATION_ENABLED" | "VIEWER_PUBLIC_SHARES_ENABLED">,
): boolean {
  return viewerIntegrationEnabled(env) && env.VIEWER_PUBLIC_SHARES_ENABLED === "true";
}

export function viewerServiceClient(
  env: Env,
  fetcher: typeof fetch = fetch,
  options: { allowWhenDisabled?: boolean } = {},
): ViewerServiceClient {
  if ((!options.allowWhenDisabled && !viewerIntegrationEnabled(env)) || !viewerServiceConfigured({
    baseUrl: env.VIEWER_BASE_URL || "",
    keyId: env.VIEWER_SERVICE_KEY_ID || "",
    secret: env.VIEWER_SERVICE_HMAC_SECRET || "",
  })) throw new ViewerServiceError("3D Viewer integration is not configured", "not_configured");
  return new ViewerServiceClient({
    baseUrl: env.VIEWER_BASE_URL!,
    keyId: env.VIEWER_SERVICE_KEY_ID!,
    secret: env.VIEWER_SERVICE_HMAC_SECRET!,
  }, fetcher);
}

interface PublicViewerProbe {
  reachable: boolean;
  ok: boolean;
  issueCount: number | null;
}

async function publicViewerProbe(origin: string, path: "/api/v1/health" | "/api/v1/ready"): Promise<PublicViewerProbe> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${origin}${path}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      // Workers rejects redirect:"error". Manual preserves the no-follow
      // boundary and the response is considered healthy only when it is 2xx.
      redirect: "manual",
      signal: controller.signal,
    });
    const declaredLength = Number(response.headers.get("Content-Length") || "0");
    if (Number.isFinite(declaredLength) && declaredLength > 16_384)
      return { reachable: true, ok: false, issueCount: null };
    if (!response.body) return { reachable: true, ok: false, issueCount: null };
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 16_384) {
        await reader.cancel();
        return { reachable: true, ok: false, issueCount: null };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return { reachable: true, ok: false, issueCount: null }; }
    const record = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
    return {
      reachable: true,
      ok: response.ok && record?.ok === true,
      issueCount: path === "/api/v1/ready" && Array.isArray(record?.missing)
        ? Math.min(record.missing.length, 100)
        : null,
    };
  } catch {
    return { reachable: false, ok: false, issueCount: null };
  } finally {
    clearTimeout(timeout);
  }
}

function associationView(row: AssociationRow) {
  const current = row.current_project_source_version ?? row.project_source_version;
  const live = row.state === "active" && row.project_active !== 0 && current === row.project_source_version;
  return {
    id: row.id,
    projectId: row.project_id,
    projectAlphaProjectId: row.project_alpha_project_id,
    projectSourceVersion: row.project_source_version,
    projectName: row.project_name || "Project",
    clientName: row.client_name || "Client",
    viewerModelId: row.viewer_model_id,
    viewerModelVersionId: row.viewer_model_version_id,
    viewerResourceVersion: row.viewer_resource_version,
    modelTitle: row.model_title,
    modelProvider: row.model_provider,
    modelStatus: row.model_status,
    state: live ? "active" as const : row.state === "revoked" ? "revoked" as const : "source_stale" as const,
    version: row.association_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

async function listAssociations(env: Env): Promise<ReturnType<typeof associationView>[]> {
  const rows = await primaryDeliveryDb(env).prepare(`SELECT association.*,
    project.project_name,project.client_name,project.active project_active,
    project.source_updated_at current_project_source_version
    FROM viewer_model_associations association
    JOIN projects project ON project.id=association.project_id
    ORDER BY association.model_title COLLATE NOCASE,project.client_name COLLATE NOCASE,project.project_name COLLATE NOCASE`)
    .all<AssociationRow>();
  return rows.results.map(associationView);
}

export async function listViewerClientGrants(env: Env, principal: StaffPrincipal) {
  await requireGlobalViewer(env, principal, "viewer.manage");
  const rows = await primaryDeliveryDb(env).prepare(`SELECT grant_record.*,account.display_name account_name,
    project.project_name,association.model_title
    FROM viewer_client_grants grant_record
    JOIN client_accounts account ON account.id=grant_record.account_id
    JOIN projects project ON project.id=grant_record.project_id
    LEFT JOIN viewer_model_associations association ON association.id=grant_record.association_id
    WHERE grant_record.status='active' AND grant_record.revoked_at IS NULL
    ORDER BY grant_record.created_at DESC,grant_record.id LIMIT 501`).all<Record<string, unknown>>();
  if (rows.results.length > 500) throw new HTTPException(503, { message: "The Viewer client-grant list is too large" });
  return rows.results;
}

export async function createViewerClientGrant(input: {
  env: Env; principal: StaffPrincipal; grant: z.infer<typeof clientGrantInput>;
  idempotencyKey: string; request: Request;
}): Promise<{ grant: Record<string, unknown> | undefined; replayed: boolean }> {
  await requireGlobalViewer(input.env, input.principal, "viewer.manage");
  const parsed = clientGrantInput.safeParse(input.grant);
  const key = idempotencyKey.safeParse(input.idempotencyKey);
  if (!parsed.success || !key.success) throw new HTTPException(400, { message: "Viewer client grant is invalid" });
  const fingerprint = await associationMutationFingerprint("grant.create", parsed.data);
  const database = primaryDeliveryDb(input.env);
  const prior = await database.prepare(`SELECT request_fingerprint,grant_id FROM viewer_client_grant_mutation_receipts
    WHERE actor_staff_id=? AND idempotency_key=?`).bind(input.principal.id, key.data)
    .first<{ request_fingerprint: string; grant_id: string }>();
  if (prior) {
    if (prior.request_fingerprint !== fingerprint) throw new HTTPException(409, { message: "Idempotency-Key was already used" });
    return { grant: (await listViewerClientGrants(input.env, input.principal)).find(row => row.id === prior.grant_id), replayed: true };
  }
  const target = await database.prepare(`SELECT project.id FROM projects project
    JOIN client_project_grants project_grant ON project_grant.project_id=project.id AND project_grant.account_id=?
      AND project_grant.revoked_at IS NULL
    JOIN client_accounts account ON account.id=project_grant.account_id AND account.status='active'
    WHERE project.id=? AND project.active=1`).bind(parsed.data.accountId, parsed.data.projectId).first<{ id: string }>();
  if (!target) throw new HTTPException(404, { message: "Active client project not found" });
  if (parsed.data.associationId) {
    const association = await currentStaffAssociation(input.env, parsed.data.associationId);
    if (!association || association.project_id !== parsed.data.projectId)
      throw new HTTPException(404, { message: "Published Viewer task not found" });
  }
  const grantCount = await database.prepare("SELECT COUNT(*) count FROM viewer_client_grants WHERE status='active' AND revoked_at IS NULL").first<number>("count") || 0;
  if (grantCount >= 500) throw new HTTPException(503, { message: "The Viewer client-grant list is at capacity" });
  const grantId = crypto.randomUUID();
  try {
    await database.batch([
      database.prepare(`INSERT INTO viewer_client_grants(id,account_id,project_id,scope_type,association_id,
        include_future_published,can_measure,can_view_cameras,can_download,authorization_expires_at,created_by_staff_id)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM viewer_client_grants WHERE status='active' AND revoked_at IS NULL)<500`).bind(grantId, parsed.data.accountId, parsed.data.projectId, parsed.data.scopeType,
        parsed.data.associationId, parsed.data.scopeType === "project" && parsed.data.includeFuturePublished ? 1 : 0,
        parsed.data.permissions.measure ? 1 : 0, parsed.data.permissions.cameras ? 1 : 0,
        parsed.data.permissions.download ? 1 : 0, parsed.data.expiresAt, input.principal.id),
      database.prepare(`INSERT INTO viewer_client_grant_mutation_receipts
        (actor_staff_id,idempotency_key,action,request_fingerprint,grant_id) VALUES(?,?,?,?,?)`)
        .bind(input.principal.id, key.data, "grant.create", fingerprint, grantId),
      database.prepare(`INSERT INTO viewer_client_grant_audit
        (id,grant_id,action,actor_staff_id,idempotency_key,details_json) VALUES(?,?,'grant.created',?,?,?)`)
        .bind(crypto.randomUUID(), grantId, input.principal.id, key.data, JSON.stringify({
          accountId: parsed.data.accountId, projectId: parsed.data.projectId,
          scopeType: parsed.data.scopeType, associationId: parsed.data.associationId,
        })),
    ]);
  } catch (error) {
    const raced = await database.prepare(`SELECT request_fingerprint,grant_id FROM viewer_client_grant_mutation_receipts
      WHERE actor_staff_id=? AND idempotency_key=?`).bind(input.principal.id, key.data)
      .first<{ request_fingerprint: string; grant_id: string }>();
    if (raced?.request_fingerprint === fingerprint)
      return { grant: (await listViewerClientGrants(input.env, input.principal)).find(row => row.id === raced.grant_id), replayed: true };
    const conflict = await database.prepare(`SELECT id FROM viewer_client_grants WHERE account_id=? AND project_id=?
      AND scope_type=? AND COALESCE(association_id,'')=COALESCE(?,'') AND status='active' AND revoked_at IS NULL`)
      .bind(parsed.data.accountId, parsed.data.projectId, parsed.data.scopeType, parsed.data.associationId).first();
    if (conflict) throw new HTTPException(409, { message: "An active Viewer client grant already exists" });
    throw error;
  }
  await input.env.OPS_DB.batch([await auditStatement(input.env, input.request, input.principal, "viewer.client_grant.created",
    "viewer_client_grant", grantId, null, { accountId: parsed.data.accountId, projectId: parsed.data.projectId,
      scopeType: parsed.data.scopeType, associationId: parsed.data.associationId })]);
  return { grant: (await listViewerClientGrants(input.env, input.principal)).find(row => row.id === grantId), replayed: false };
}

export async function revokeViewerClientGrant(input: {
  env: Env; principal: StaffPrincipal; grantId: string; reason: string;
  idempotencyKey: string; request: Request;
}): Promise<{ success: true; replayed: boolean; sessionRevocation: { delivered: number; pending: number } }> {
  await requireGlobalViewer(input.env, input.principal, "viewer.manage");
  const grantId = opaqueId.safeParse(input.grantId), value = revokeInput.safeParse({ reason: input.reason });
  const key = idempotencyKey.safeParse(input.idempotencyKey);
  if (!grantId.success || !value.success || !key.success)
    throw new HTTPException(400, { message: "Viewer client-grant revocation is invalid" });
  const database = primaryDeliveryDb(input.env);
  const grant = await database.prepare(`SELECT id,project_id,association_id,status,grant_version FROM viewer_client_grants WHERE id=?`)
    .bind(grantId.data).first<{ id: string; project_id: string; association_id: string | null; status: string; grant_version: number }>();
  if (!grant) throw new HTTPException(404, { message: "Viewer client grant not found" });
  const fingerprint = await associationMutationFingerprint("grant.revoke", { grantId: grantId.data, reason: value.data.reason });
  const prior = await database.prepare(`SELECT request_fingerprint FROM viewer_client_grant_mutation_receipts
    WHERE actor_staff_id=? AND idempotency_key=?`).bind(input.principal.id, key.data).first<string>("request_fingerprint");
  if (prior && prior !== fingerprint) throw new HTTPException(409, { message: "Idempotency-Key was already used" });
  if (!prior && grant.status !== "active")
    throw new HTTPException(409, { message: "Viewer client grant is already revoked" });
  if (!prior) await database.batch([
    database.prepare(`UPDATE viewer_client_grants SET status='revoked',grant_version=grant_version+1,
      revoked_at=COALESCE(revoked_at,datetime('now')),revoked_by_staff_id=COALESCE(revoked_by_staff_id,?),
      revoke_reason=COALESCE(revoke_reason,?),updated_at=datetime('now') WHERE id=? AND status='active'`)
      .bind(input.principal.id, value.data.reason, grant.id),
    database.prepare(`INSERT INTO viewer_client_grant_mutation_receipts
      (actor_staff_id,idempotency_key,action,request_fingerprint,grant_id) VALUES(?,?,?,?,?)`)
      .bind(input.principal.id, key.data, "grant.revoke", fingerprint, grant.id),
    database.prepare(`INSERT INTO viewer_client_grant_audit
      (id,grant_id,action,actor_staff_id,idempotency_key,details_json) VALUES(?,?,'grant.revoked',?,?,?)`)
      .bind(crypto.randomUUID(), grant.id, input.principal.id, key.data, JSON.stringify({ reason: value.data.reason })),
    database.prepare(`INSERT OR IGNORE INTO viewer_session_revocation_outbox(id,association_id,association_version,idempotency_key)
      SELECT lower(hex(randomblob(16))),association.id,association.association_version,
        'viewer-session-revoke:'||lower(hex(randomblob(16))) FROM viewer_model_associations association
      WHERE association.project_id=? AND (? IS NULL OR association.id=?) AND association.state='active'`)
      .bind(grant.project_id, grant.association_id, grant.association_id),
    database.prepare(`UPDATE viewer_model_associations SET association_version=association_version+1,
      updated_at=datetime('now') WHERE project_id=? AND (? IS NULL OR id=?) AND state='active'`)
      .bind(grant.project_id, grant.association_id, grant.association_id),
  ]);
  if (!prior) await input.env.OPS_DB.batch([await auditStatement(input.env, input.request, input.principal,
    "viewer.client_grant.revoked", "viewer_client_grant", grant.id, null, { reason: value.data.reason })]);
  const sessionRevocation = await drainViewerSessionRevocations(input.env);
  return { success: true, replayed: Boolean(prior), sessionRevocation };
}

export async function listNativeViewerClientGrants(env: Env, principal: StaffPrincipal) {
  await requireGlobalViewer(env, principal, "viewer.manage");
  const rows = await primaryDeliveryDb(env).prepare(`SELECT grant_record.*,
    workspace.display_name workspace_name,project.display_name project_name,association.model_title
    FROM viewer_native_client_grants grant_record
    JOIN portal_v2_workspaces workspace ON workspace.id=grant_record.workspace_id
      AND workspace.project_alpha_source_id=grant_record.source_id
    LEFT JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    LEFT JOIN portal_v2_directory_entities project ON project.workspace_id=workspace.id
      AND project.generation_id=checkpoint.active_generation_id AND project.entity_type='project'
      AND project.public_id=grant_record.project_public_id
    LEFT JOIN viewer_model_associations association ON association.id=grant_record.association_id
    WHERE grant_record.status='active' AND grant_record.revoked_at IS NULL
    ORDER BY grant_record.created_at DESC,grant_record.id LIMIT 501`).all<Record<string,unknown>>();
  if(rows.results.length>500)throw new HTTPException(503,{message:"The native Viewer grant list is too large"});
  return rows.results;
}

export async function listNativeViewerClientGrantWorkspace(env:Env,principal:StaffPrincipal){
  await requireGlobalViewer(env,principal,"viewer.manage");
  const database=primaryDeliveryDb(env);
  const [grants,rows]=await Promise.all([listNativeViewerClientGrants(env,principal),database.prepare(`SELECT
    workspace.id workspace_id,workspace.project_alpha_source_id source_id,workspace.display_name workspace_name,
    entity.public_id project_public_id,entity.display_name project_name,association.id association_id,association.model_title
    FROM portal_v2_workspaces workspace
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities entity ON entity.workspace_id=workspace.id AND entity.generation_id=generation.id
      AND entity.entity_type='project' AND entity.active=1
    JOIN projects project ON project.project_alpha_source_id=workspace.project_alpha_source_id
      AND project.project_alpha_project_id=entity.public_id AND project.source_updated_at=entity.source_version AND project.active=1
    LEFT JOIN viewer_model_associations association ON association.project_id=project.id
      AND association.project_alpha_project_id=entity.public_id AND association.project_source_version=entity.source_version
      AND association.state='active' AND association.revoked_at IS NULL AND association.model_status='ready'
    WHERE workspace.status='active' AND workspace.legacy_account_id IS NULL
    ORDER BY workspace.display_name COLLATE NOCASE,entity.display_name COLLATE NOCASE,association.model_title COLLATE NOCASE LIMIT 501`)
    .all<{workspace_id:string;source_id:string;workspace_name:string;project_public_id:string;project_name:string;
      association_id:string|null;model_title:string|null}>()]);
  if(rows.results.length>500)throw new HTTPException(503,{message:"The native Viewer target list is too large"});
  const targets=new Map<string,{sourceId:string;workspaceId:string;workspaceName:string;projectPublicId:string;projectName:string;
    associations:Array<{id:string;modelTitle:string}>}>();
  for(const row of rows.results){const key=`${row.source_id}\u0000${row.workspace_id}\u0000${row.project_public_id}`;
    let target=targets.get(key);if(!target){target={sourceId:row.source_id,workspaceId:row.workspace_id,workspaceName:row.workspace_name,
      projectPublicId:row.project_public_id,projectName:row.project_name,associations:[]};targets.set(key,target);}
    if(row.association_id&&row.model_title)target.associations.push({id:row.association_id,modelTitle:row.model_title});}
  return {grants,targets:[...targets.values()]};
}

async function requireNativeViewerGrantTarget(env:Env,value:z.infer<typeof nativeClientGrantInput>):Promise<{
  workspaceName:string;projectName:string;modelTitle:string|null}>{
  const database=primaryDeliveryDb(env);
  const target=await database.prepare(`SELECT entity.source_version,workspace.display_name workspace_name,
      entity.display_name project_name FROM portal_v2_workspaces workspace
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities entity ON entity.workspace_id=workspace.id AND entity.generation_id=generation.id
      AND entity.entity_type='project' AND entity.public_id=? AND entity.active=1
    WHERE workspace.id=? AND workspace.project_alpha_source_id=? AND workspace.legacy_account_id IS NULL
      AND workspace.status='active' LIMIT 2`).bind(value.projectPublicId,value.workspaceId,value.sourceId)
    .all<{source_version:string;workspace_name:string;project_name:string}>();
  if(target.results.length!==1)throw new HTTPException(404,{message:"Native client project not found"});
  let modelTitle:string|null=null;
  if(value.associationId){
    const association=await database.prepare(`SELECT association.id,association.model_title FROM viewer_model_associations association
      JOIN projects project ON project.id=association.project_id AND project.active=1
        AND project.project_alpha_source_id=? AND project.project_alpha_project_id=?
        AND project.source_updated_at=association.project_source_version
      WHERE association.id=? AND association.state='active' AND association.revoked_at IS NULL
        AND association.model_status='ready' AND association.project_source_version=?`)
      .bind(value.sourceId,value.projectPublicId,value.associationId,target.results[0]!.source_version)
      .first<{id:string;model_title:string}>();
    if(!association)throw new HTTPException(404,{message:"Published native Viewer task not found"});
    modelTitle=association.model_title;
  }
  return {workspaceName:target.results[0]!.workspace_name,projectName:target.results[0]!.project_name,modelTitle};
}

export async function createNativeViewerClientGrant(input:{env:Env;principal:StaffPrincipal;
  grant:z.infer<typeof nativeClientGrantInput>;idempotencyKey:string;request:Request}){
  await requireGlobalViewer(input.env,input.principal,"viewer.manage");
  const parsed=nativeClientGrantInput.safeParse(input.grant),key=idempotencyKey.safeParse(input.idempotencyKey);
  if(!parsed.success||!key.success)throw new HTTPException(400,{message:"Native Viewer client grant is invalid"});
  const database=primaryDeliveryDb(input.env),fingerprint=await associationMutationFingerprint("native-grant.create",parsed.data);
  const prior=await database.prepare(`SELECT request_fingerprint,grant_id,response_json FROM viewer_native_client_grant_mutation_receipts
    WHERE actor_staff_id=? AND idempotency_key=?`).bind(input.principal.id,key.data)
    .first<{request_fingerprint:string;grant_id:string;response_json:string}>();
  if(prior){if(prior.request_fingerprint!==fingerprint)throw new HTTPException(409,{message:"Idempotency-Key was already used"});
    return {grant:parseNativeClientGrantSnapshot(prior.response_json),replayed:true};}
  const target=await requireNativeViewerGrantTarget(input.env,parsed.data);
  const count=await database.prepare("SELECT COUNT(*) count FROM viewer_native_client_grants WHERE status='active' AND revoked_at IS NULL").first<number>('count')??0;
  if(count>=500)throw new HTTPException(503,{message:"The native Viewer grant list is at capacity"});
  const grantId=crypto.randomUUID(),now=new Date().toISOString();
  const snapshot:NativeClientGrantSnapshot={id:grantId,source_id:parsed.data.sourceId,workspace_id:parsed.data.workspaceId,
    project_public_id:parsed.data.projectPublicId,scope_type:parsed.data.scopeType,association_id:parsed.data.associationId,
    include_future_published:parsed.data.scopeType==='project'&&parsed.data.includeFuturePublished?1:0,
    can_measure:parsed.data.permissions.measure?1:0,can_view_cameras:parsed.data.permissions.cameras?1:0,
    can_download:parsed.data.permissions.download?1:0,authorization_expires_at:parsed.data.expiresAt,grant_version:1,status:"active",
    created_by_staff_id:input.principal.id,created_at:now,updated_at:now,revoked_at:null,revoked_by_staff_id:null,revoke_reason:null,
    workspace_name:target.workspaceName,project_name:target.projectName,model_title:target.modelTitle};
  try{await database.batch([
    database.prepare(`INSERT INTO viewer_native_client_grants(id,source_id,workspace_id,project_public_id,scope_type,association_id,
      include_future_published,can_measure,can_view_cameras,can_download,authorization_expires_at,created_by_staff_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(grantId,parsed.data.sourceId,parsed.data.workspaceId,parsed.data.projectPublicId,
      parsed.data.scopeType,parsed.data.associationId,parsed.data.scopeType==='project'&&parsed.data.includeFuturePublished?1:0,
      parsed.data.permissions.measure?1:0,parsed.data.permissions.cameras?1:0,parsed.data.permissions.download?1:0,
      parsed.data.expiresAt,input.principal.id),
    database.prepare(`UPDATE viewer_native_client_grants SET created_at=?,updated_at=? WHERE id=?`).bind(now,now,grantId),
    database.prepare(`INSERT INTO viewer_native_client_grant_mutation_receipts(actor_staff_id,idempotency_key,action,request_fingerprint,grant_id,response_json)
      VALUES(?,?,'grant.create',?,?,?)`).bind(input.principal.id,key.data,fingerprint,grantId,JSON.stringify(snapshot)),
    database.prepare(`INSERT INTO viewer_native_client_grant_audit(id,grant_id,action,actor_staff_id,idempotency_key,details_json)
      VALUES(?,?,'grant.created',?,?,?)`).bind(crypto.randomUUID(),grantId,input.principal.id,key.data,JSON.stringify(parsed.data)),
  ]);}catch(error){const raced=await database.prepare(`SELECT request_fingerprint,grant_id,response_json FROM viewer_native_client_grant_mutation_receipts
    WHERE actor_staff_id=? AND idempotency_key=?`).bind(input.principal.id,key.data)
    .first<{request_fingerprint:string;grant_id:string;response_json:string}>();
    if(raced?.request_fingerprint===fingerprint)return {grant:parseNativeClientGrantSnapshot(raced.response_json),replayed:true};throw error;}
  await input.env.OPS_DB.batch([await auditStatement(input.env,input.request,input.principal,"viewer.native_client_grant.created",
    "viewer_native_client_grant",grantId,null,{sourceId:parsed.data.sourceId,workspaceId:parsed.data.workspaceId,projectPublicId:parsed.data.projectPublicId,
      scopeType:parsed.data.scopeType,associationId:parsed.data.associationId})]);
  return {grant:snapshot,replayed:false};
}

export async function revokeNativeViewerClientGrant(input:{env:Env;principal:StaffPrincipal;grantId:string;reason:string;
  idempotencyKey:string;request:Request}){
  await requireGlobalViewer(input.env,input.principal,"viewer.manage");
  const grantId=opaqueId.safeParse(input.grantId),value=revokeInput.safeParse({reason:input.reason}),key=idempotencyKey.safeParse(input.idempotencyKey);
  if(!grantId.success||!value.success||!key.success)throw new HTTPException(400,{message:"Native Viewer grant revocation is invalid"});
  const database=primaryDeliveryDb(input.env),grant=await database.prepare(`SELECT id,source_id,project_public_id,association_id,status
    FROM viewer_native_client_grants WHERE id=?`).bind(grantId.data)
    .first<{id:string;source_id:string;project_public_id:string;association_id:string|null;status:string}>();
  if(!grant)throw new HTTPException(404,{message:"Native Viewer grant not found"});
  const fingerprint=await associationMutationFingerprint("native-grant.revoke",{grantId:grant.id,reason:value.data.reason});
  const prior=await database.prepare(`SELECT request_fingerprint FROM viewer_native_client_grant_mutation_receipts
    WHERE actor_staff_id=? AND idempotency_key=?`).bind(input.principal.id,key.data).first<string>('request_fingerprint');
  if(prior&&prior!==fingerprint)throw new HTTPException(409,{message:"Idempotency-Key was already used"});
  if(!prior&&grant.status!=="active")throw new HTTPException(409,{message:"Native Viewer grant is already revoked"});
  if(!prior)try{await database.batch([
    database.prepare(`UPDATE viewer_native_client_grants SET status='revoked',grant_version=grant_version+1,revoked_at=datetime('now'),
      revoked_by_staff_id=?,revoke_reason=?,updated_at=datetime('now') WHERE id=? AND status='active'`).bind(input.principal.id,value.data.reason,grant.id),
    database.prepare(`INSERT INTO viewer_native_client_grant_mutation_receipts(actor_staff_id,idempotency_key,action,request_fingerprint,grant_id,response_json)
      VALUES(?,?,'grant.revoke',?,?,?)`).bind(input.principal.id,key.data,fingerprint,grant.id,
        JSON.stringify({success:true,existingSessionsExpireWithinSeconds:1800})),
    database.prepare(`INSERT INTO viewer_native_client_grant_audit(id,grant_id,action,actor_staff_id,idempotency_key,details_json)
      VALUES(?,?,'grant.revoked',?,?,?)`).bind(crypto.randomUUID(),grant.id,input.principal.id,key.data,JSON.stringify({reason:value.data.reason})),
  ]);}catch(error){
    const raced=await database.prepare(`SELECT request_fingerprint FROM viewer_native_client_grant_mutation_receipts
      WHERE actor_staff_id=? AND idempotency_key=?`).bind(input.principal.id,key.data).first<string>('request_fingerprint');
    if(raced===fingerprint)return {success:true as const,replayed:true,existingSessionsExpireWithinSeconds:1800};
    if(raced)throw new HTTPException(409,{message:"Idempotency-Key was already used"});
    const current=await database.prepare("SELECT status FROM viewer_native_client_grants WHERE id=?").bind(grant.id).first<string>('status');
    if(current!=="active")throw new HTTPException(409,{message:"Native Viewer grant is already revoked"});
    throw error;
  }
  if(!prior)await input.env.OPS_DB.batch([await auditStatement(input.env,input.request,input.principal,"viewer.native_client_grant.revoked",
    "viewer_native_client_grant",grant.id,null,{reason:value.data.reason})]);
  return {success:true as const,replayed:Boolean(prior),existingSessionsExpireWithinSeconds:1800};
}

async function listProjectOptions(env: Env): Promise<PortalProjectRow[]> {
  const rows = await primaryDeliveryDb(env).prepare(`SELECT DISTINCT project.id,project.project_alpha_project_id,
    project.project_name,project.client_name,project.source_updated_at
    FROM projects project
    JOIN client_project_grants grant_record ON grant_record.project_id=project.id AND grant_record.revoked_at IS NULL
    WHERE project.active=1 AND project.project_alpha_project_id IS NOT NULL
      AND project.source_updated_at IS NOT NULL
    ORDER BY project.client_name COLLATE NOCASE,project.project_name COLLATE NOCASE,project.id LIMIT 501`)
    .all<PortalProjectRow>();
  if (rows.results.length > 500) throw new HTTPException(503, { message: "The Viewer project list is too large" });
  return rows.results;
}

async function currentStaffAssociation(env: Env, associationId: string): Promise<AssociationRow | null> {
  const row = await primaryDeliveryDb(env).prepare(`SELECT association.*,
    project.project_name,project.client_name,project.active project_active,
    project.source_updated_at current_project_source_version
    FROM viewer_model_associations association
    JOIN projects project ON project.id=association.project_id
    WHERE association.id=?`).bind(associationId).first<AssociationRow>();
  if (!row || row.state !== "active" || row.project_active !== 1 ||
    row.project_source_version !== row.current_project_source_version || row.model_status !== "ready") return null;
  const source = await env.OPS_DB.withSession("first-primary").prepare(
    "SELECT updated_at FROM pa_projects WHERE id=? AND active=1",
  ).bind(row.project_alpha_project_id).first<{ updated_at: string }>();
  return source?.updated_at === row.project_source_version ? row : null;
}

export async function listViewerClientGrantWorkspace(env: Env, principal: StaffPrincipal) {
  await requireGlobalViewer(env, principal, "viewer.manage");
  const database = primaryDeliveryDb(env);
  const [grantRows, projectRows, associationRows] = await Promise.all([
    listViewerClientGrants(env, principal),
    database.prepare(`SELECT DISTINCT project.id,project_grant.account_id account_id,
      project.client_name,project.project_name FROM projects project
      JOIN client_project_grants project_grant ON project_grant.project_id=project.id AND project_grant.revoked_at IS NULL
      JOIN client_accounts account ON account.id=project_grant.account_id AND account.status='active'
      WHERE project.active=1 ORDER BY project.client_name COLLATE NOCASE,project.project_name COLLATE NOCASE LIMIT 501`).all<{
        id:string;account_id:string;client_name:string;project_name:string;
      }>(),
    listAssociations(env),
  ]);
  if (projectRows.results.length > 500) throw new HTTPException(503,{message:"The Viewer client project list is too large"});
  const liveAssociations = (await Promise.all(associationRows.slice(0,501).map(async row => {
    const current = await currentStaffAssociation(env,row.id);
    return current ? associationView(current) : null;
  }))).filter((row): row is NonNullable<typeof row> => row !== null);
  if (associationRows.length > 500 || liveAssociations.length > 500)
    throw new HTTPException(503,{message:"The Viewer client task list is too large"});
  return {
    grants: grantRows.map(row => ({ id:row.id, accountId:row.account_id, clientName:row.account_name,
      projectId:row.project_id, projectName:row.project_name, scopeType:row.scope_type,
      associationId:row.association_id, modelTitle:row.model_title, includeFuturePublished:Boolean(row.include_future_published),
      permissions:{measure:Boolean(row.can_measure),cameras:Boolean(row.can_view_cameras),download:Boolean(row.can_download)},
      expiresAt:row.authorization_expires_at, status:row.status, createdAt:row.created_at, revokedAt:row.revoked_at })),
    projects: projectRows.results.map(row=>({id:row.id,accountId:row.account_id,clientName:row.client_name,projectName:row.project_name})),
    associations: liveAssociations.map(row=>({
      id:row.id,
      projectId:row.projectId,
      viewerModelId:row.viewerModelId,
      viewerModelVersionId:row.viewerModelVersionId,
      modelTitle:row.modelTitle,
    })),
  };
}

async function associationMutationFingerprint(action: string, value: unknown): Promise<string> {
  return sha256(JSON.stringify(["viewer-association-mutation:v1", action, value]));
}

async function replayedAssociationMutation(input: {
  env: Env;
  principal: StaffPrincipal;
  action: "association.create" | "association.revoke";
  idempotencyKey: string;
  fingerprint: string;
}): Promise<string | null> {
  const receipt = await primaryDeliveryDb(input.env).prepare(`SELECT action,request_fingerprint,association_id
    FROM viewer_association_mutation_receipts WHERE actor_staff_id=? AND idempotency_key=?`)
    .bind(input.principal.id, input.idempotencyKey)
    .first<{ action: string; request_fingerprint: string; association_id: string }>();
  if (!receipt) return null;
  if (receipt.action !== input.action || receipt.request_fingerprint !== input.fingerprint)
    throw new HTTPException(409, { message: "Idempotency-Key was already used for another Viewer change" });
  return receipt.association_id;
}

export async function persistViewerAssociation(input: {
  env: Env;
  principal: StaffPrincipal;
  project: PortalProjectRow;
  model: ViewerModelSummary & { activeVersion: NonNullable<ViewerModelSummary["activeVersion"]> };
  idempotencyKey: string;
  fingerprint: string;
}): Promise<{ id: string; created: boolean; replayed: boolean }> {
  const replay = await replayedAssociationMutation({
    env: input.env, principal: input.principal, action: "association.create",
    idempotencyKey: input.idempotencyKey, fingerprint: input.fingerprint,
  });
  if (replay) return { id: replay, created: false, replayed: true };
  const database = primaryDeliveryDb(input.env);
  const existing = await database.prepare(
    "SELECT id,association_version FROM viewer_model_associations WHERE project_id=? AND viewer_model_id=?",
  ).bind(input.project.id, input.model.id).first<{ id: string; association_version: number }>();
  const id = existing?.id || crypto.randomUUID();
  const statements = [database.prepare(`INSERT OR IGNORE INTO viewer_session_revocation_outbox
      (id,association_id,association_version,idempotency_key)
      SELECT ?,id,association_version,? FROM viewer_model_associations
      WHERE project_id=? AND viewer_model_id=?`)
    .bind(crypto.randomUUID(), `viewer-session-revoke:${crypto.randomUUID()}`, input.project.id, input.model.id),
    database.prepare(`INSERT INTO viewer_model_associations
      (id,project_id,project_alpha_project_id,project_source_version,viewer_model_id,viewer_model_version_id,
       viewer_resource_version,model_title,model_provider,model_status,state,created_by_staff_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,'active',?)
      ON CONFLICT(project_id,viewer_model_id) DO UPDATE SET
        project_alpha_project_id=excluded.project_alpha_project_id,
        project_source_version=excluded.project_source_version,
        viewer_model_version_id=excluded.viewer_model_version_id,
        viewer_resource_version=excluded.viewer_resource_version,
        model_title=excluded.model_title,model_provider=excluded.model_provider,model_status=excluded.model_status,
        state='active',association_version=association_version+1,updated_at=datetime('now'),
        revoked_at=NULL,revoked_by_staff_id=NULL,revoke_reason=NULL`)
    .bind(id, input.project.id, input.project.project_alpha_project_id, input.project.source_updated_at,
      input.model.id, input.model.activeVersion.id, input.model.updatedAt, input.model.title,
      input.model.provider, input.model.status, input.principal.id),
    database.prepare(`INSERT INTO viewer_association_mutation_receipts
      (actor_staff_id,idempotency_key,action,request_fingerprint,association_id)
      SELECT ?,?,?,?,id FROM viewer_model_associations WHERE project_id=? AND viewer_model_id=?`)
      .bind(input.principal.id, input.idempotencyKey, "association.create", input.fingerprint,
        input.project.id, input.model.id)];
  try {
    await database.batch(statements);
  } catch (error) {
    const raced = await replayedAssociationMutation({
      env: input.env, principal: input.principal, action: "association.create",
      idempotencyKey: input.idempotencyKey, fingerprint: input.fingerprint,
    });
    if (!raced) throw error;
    return { id: raced, created: false, replayed: true };
  }
  const persisted = await database.prepare(
    "SELECT id FROM viewer_model_associations WHERE project_id=? AND viewer_model_id=?",
  ).bind(input.project.id, input.model.id).first<{ id: string }>();
  if (!persisted) throw new Error("Viewer association persistence failed");
  return { id: persisted.id, created: !existing && persisted.id === id, replayed: false };
}

export async function issueViewerSession(input: {
  env: Env;
  actorId: string;
  audience: ViewerAudience;
  association: AssociationRow;
  idempotencyKey: string;
  displayUnits?: ViewerDisplayUnits;
  verifiedIndividualIdentity?: {
    identityId: string;
    principalIssuer: string;
    principalSubject: string;
  };
}): Promise<ViewerSessionGrant> {
  const personalMeasurements = input.audience === "client" &&
    input.verifiedIndividualIdentity?.identityId === input.actorId &&
    input.verifiedIndividualIdentity.principalIssuer.length > 0 &&
    input.verifiedIndividualIdentity.principalSubject.length > 0;
  const requestFingerprint = await sha256(JSON.stringify({
    associationId: input.association.id,
    associationVersion: input.association.association_version,
    viewerModelId: input.association.viewer_model_id,
    viewerModelVersionId: input.association.viewer_model_version_id,
    displayUnits: input.displayUnits || "imperial",
    ...(personalMeasurements ? { personalMeasurements: true } : {}),
  }));
  const db = primaryDeliveryDb(input.env);
  const client = viewerServiceClient(input.env);
  const currentModel = (await client.listModels()).find(model => model.id === input.association.viewer_model_id);
  if (!currentModel?.available || currentModel.status !== "ready" || !currentModel.activeVersion ||
    currentModel.activeVersion.id !== input.association.viewer_model_version_id)
    throw new HTTPException(409, { message: "The 3D model changed and must be re-associated before viewing" });
  const maximumAuthorizationExpiry = Date.now() + 30 * 60 * 1000;
  const sourceAuthorizationExpiry = input.association.authorization_expires_at
    ? Date.parse(input.association.authorization_expires_at)
    : maximumAuthorizationExpiry;
  const authorizationExpiresAt = new Date(Math.min(maximumAuthorizationExpiry, sourceAuthorizationExpiry)).toISOString();
  if (Date.parse(authorizationExpiresAt) <= Date.now())
    throw new HTTPException(404, { message: "3D model not found" });
  const existing = await db.prepare(`SELECT request_fingerprint,response_json,expires_at
    FROM viewer_session_issuance_receipts WHERE actor_id=? AND audience=? AND idempotency_key=?`)
    .bind(input.actorId, input.audience, input.idempotencyKey)
    .first<{ request_fingerprint: string; response_json: string; expires_at: string }>();
  if (existing) {
    if (existing.request_fingerprint !== requestFingerprint)
      throw new HTTPException(409, { message: "Idempotency-Key was already used for a different Viewer session" });
    if (Date.parse(existing.expires_at) > Date.now()) return JSON.parse(existing.response_json) as ViewerSessionGrant;
  }
  const grant = await client.createSession({
    modelId: input.association.viewer_model_id,
    modelVersionId: input.association.viewer_model_version_id,
    subject: `${input.audience}:${input.actorId}`.slice(0, 200),
    audience: input.audience,
    idempotencyKey: input.idempotencyKey,
    authorizationExpiresAt,
    displayUnits: input.displayUnits || "imperial",
    permissions: {
      view: true,
      measure: input.association.authorization_can_measure !== 0,
      cameras: input.association.authorization_can_view_cameras !== 0,
      download: input.association.authorization_can_download === 1,
      ...(personalMeasurements ? { personalMeasurements: true } : {}),
    },
    sourceAuthorization: {
      type: "model_association", id: input.association.id, version: input.association.association_version,
    },
  });
  await db.prepare(`INSERT INTO viewer_session_issuance_receipts
    (actor_id,audience,idempotency_key,request_fingerprint,response_json,expires_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(actor_id,audience,idempotency_key) DO UPDATE SET
      response_json=CASE WHEN request_fingerprint=excluded.request_fingerprint THEN excluded.response_json ELSE response_json END,
      expires_at=CASE WHEN request_fingerprint=excluded.request_fingerprint THEN excluded.expires_at ELSE expires_at END`)
    .bind(input.actorId, input.audience, input.idempotencyKey, requestFingerprint, JSON.stringify(grant), grant.grantExpiresAt).run();
  return grant;
}

export async function pruneViewerSessionIssuanceReceipts(env: Pick<Env, "DELIVERY_DB">): Promise<number> {
  const result = await primaryDeliveryDb(env as Env).prepare(
    "DELETE FROM viewer_session_issuance_receipts WHERE datetime(expires_at)<=datetime('now')",
  ).run();
  return result.meta.changes || 0;
}

interface ViewerSessionRevocationRow {
  id: string;
  association_id: string;
  association_version: number;
  idempotency_key: string;
  attempt_count: number;
}

function revocationRetrySeconds(attempt: number): number {
  return Math.min(900, 30 * (2 ** Math.min(Math.max(attempt, 0), 5)));
}

export async function drainViewerSessionRevocations(
  env: Env,
  options: { associationId?: string; limit?: number; fetcher?: typeof fetch } = {},
): Promise<{ delivered: number; pending: number }> {
  const database = primaryDeliveryDb(env);
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const rows = await database.prepare(`SELECT id,association_id,association_version,idempotency_key,attempt_count
    FROM viewer_session_revocation_outbox
    WHERE state='pending' AND datetime(next_attempt_at)<=datetime('now')
      AND (? IS NULL OR association_id=?)
    ORDER BY created_at,id LIMIT ?`)
    .bind(options.associationId ?? null, options.associationId ?? null, limit)
    .all<ViewerSessionRevocationRow>();
  let delivered = 0;
  for (const row of rows.results) {
    try {
      await viewerServiceClient(env, options.fetcher ?? fetch, { allowWhenDisabled: true })
        .revokePublishedSessionSourceAuthorization({
          sourceAuthorization: {
            type: "model_association", id: row.association_id, version: row.association_version,
          },
          idempotencyKey: row.idempotency_key,
        });
      const update = await database.prepare(`UPDATE viewer_session_revocation_outbox SET
        state='delivered',attempt_count=attempt_count+1,last_error_code=NULL,
        delivered_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND state='pending'`)
        .bind(row.id).run();
      delivered += update.meta.changes || 0;
    } catch (error) {
      const code = error instanceof ViewerServiceError ? error.code : "unavailable";
      await database.prepare(`UPDATE viewer_session_revocation_outbox SET
        attempt_count=attempt_count+1,last_error_code=?,updated_at=datetime('now'),
        next_attempt_at=datetime('now',?) WHERE id=? AND state='pending'`)
        .bind(code.slice(0, 64), `+${revocationRetrySeconds(row.attempt_count)} seconds`, row.id).run();
    }
  }
  const pending = await database.prepare(`SELECT COUNT(*) count FROM viewer_session_revocation_outbox
    WHERE state='pending' AND (? IS NULL OR association_id=?)`)
    .bind(options.associationId ?? null, options.associationId ?? null).first<number>("count");
  return { delivered, pending: pending ?? 0 };
}

function viewerError(error: unknown): never {
  if (error instanceof HTTPException) throw error;
  if (error instanceof ViewerServiceError)
    throw new HTTPException(error.status as 404 | 409 | 503, { message: error.message });
  throw error;
}

export function registerViewerIntegrationRoutes(app: ViewerApp): void {
  app.get("/api/viewer/connection-preflight", async c => {
    c.header("Cache-Control", "no-store");
    await requireGlobalViewer(c.env, c.get("principal"), "viewer.manage");
    const configured = viewerServiceConfigured({
      baseUrl: c.env.VIEWER_BASE_URL || "",
      keyId: c.env.VIEWER_SERVICE_KEY_ID || "",
      secret: c.env.VIEWER_SERVICE_HMAC_SECRET || "",
    });
    const origin = viewerServiceOrigin(c.env.VIEWER_BASE_URL || "");
    if (!configured || !origin) return c.json({
      integrationEnabled: viewerIntegrationEnabled(c.env),
      configured: false,
      publicHealthReachable: false,
      publicHealthOk: false,
      publicReadyReachable: false,
      publicReady: false,
      readinessIssueCount: null,
      serviceAuthReachable: false,
      serviceAuthStatus: "not_configured" as const,
      modelCount: null,
      readyModelCount: null,
    });
    const [health, ready, service] = await Promise.all([
      publicViewerProbe(origin, "/api/v1/health"),
      publicViewerProbe(origin, "/api/v1/ready"),
      viewerServiceClient(c.env, fetch, { allowWhenDisabled: true }).listModels()
        .then(models => ({
          reachable: true,
          status: "connected" as const,
          modelCount: models.length,
          readyModelCount: models.filter(model => model.available && model.status === "ready" && model.activeVersion).length,
        }))
        .catch(error => ({
          reachable: false,
          status: error instanceof ViewerServiceError
            ? error.code === "authentication_failed" ? "authentication_failed" as const
              : error.code === "not_found" ? "route_not_found" as const
                : error.code === "invalid_response" ? "invalid_response" as const
                  : "unavailable" as const
            : "unavailable" as const,
          modelCount: null,
          readyModelCount: null,
        })),
    ]);
    return c.json({
      integrationEnabled: viewerIntegrationEnabled(c.env),
      configured: true,
      publicHealthReachable: health.reachable,
      publicHealthOk: health.ok,
      publicReadyReachable: ready.reachable,
      publicReady: ready.ok,
      readinessIssueCount: ready.issueCount,
      serviceAuthReachable: service.reachable,
      serviceAuthStatus: service.status,
      modelCount: service.modelCount,
      readyModelCount: service.readyModelCount,
    });
  });

  app.get("/api/viewer", async c => {
    await requireGlobalViewer(c.env, c.get("principal"), "viewer.view");
    if (!viewerIntegrationEnabled(c.env)) return c.json({
      enabled: false, publicSharesEnabled: false, models: [], projects: [], associations: [],
    });
    try {
      const [models, projects, associations, clientGrants] = await Promise.all([
        viewerServiceClient(c.env).listModels(), listProjectOptions(c.env), listAssociations(c.env),
        listViewerClientGrants(c.env, c.get("principal")),
      ]);
      return c.json({
        enabled: true,
        publicSharesEnabled: viewerPublicSharesEnabled(c.env),
        models,
        projects,
        associations,
        clientGrants,
      });
    } catch (error) { return viewerError(error); }
  });

  app.post("/api/viewer/client-grants", async c => {
    const principal = c.get("principal");
    const parsed = clientGrantInput.safeParse(await c.req.json().catch(() => null));
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    if (!parsed.success || !key.success) throw new HTTPException(400, { message: "Viewer client grant is invalid" });
    const result = await createViewerClientGrant({
      env: c.env, principal, grant: parsed.data, idempotencyKey: key.data, request: c.req.raw,
    });
    return c.json(result, result.replayed ? 200 : 201);
  });

  app.delete("/api/viewer/client-grants/:grantId", async c => {
    const principal = c.get("principal");
    const grantId = opaqueId.safeParse(c.req.param("grantId"));
    const value = revokeInput.safeParse(await c.req.json().catch(() => null));
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    if (!grantId.success || !value.success || !key.success) throw new HTTPException(400, { message: "Viewer client-grant revocation is invalid" });
    const result = await revokeViewerClientGrant({
      env: c.env, principal, grantId: grantId.data, reason: value.data.reason,
      idempotencyKey: key.data, request: c.req.raw,
    });
    return c.json(result, result.sessionRevocation.pending ? 202 : 200);
  });

  app.get("/api/viewer/native-client-grants", async c => {
    return c.json(await listNativeViewerClientGrantWorkspace(c.env,c.get("principal")));
  });

  app.post("/api/viewer/native-client-grants", async c => {
    const parsed=nativeClientGrantInput.safeParse(await c.req.json().catch(()=>null));
    const key=idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    if(!parsed.success||!key.success)throw new HTTPException(400,{message:"Native Viewer client grant is invalid"});
    const result=await createNativeViewerClientGrant({env:c.env,principal:c.get("principal"),grant:parsed.data,
      idempotencyKey:key.data,request:c.req.raw});
    return c.json(result,result.replayed?200:201);
  });

  app.delete("/api/viewer/native-client-grants/:grantId", async c => {
    const grantId=opaqueId.safeParse(c.req.param("grantId")),value=revokeInput.safeParse(await c.req.json().catch(()=>null));
    const key=idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    if(!grantId.success||!value.success||!key.success)throw new HTTPException(400,{message:"Native Viewer grant revocation is invalid"});
    const result=await revokeNativeViewerClientGrant({env:c.env,principal:c.get("principal"),grantId:grantId.data,
      reason:value.data.reason,idempotencyKey:key.data,request:c.req.raw});
    return c.json(result,200);
  });

  app.post("/api/viewer/associations", async c => {
    const principal = c.get("principal");
    await requireGlobalViewer(c.env, principal, "viewer.manage");
    const parsed = associationInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HTTPException(400, { message: "Viewer association is invalid" });
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    if (!key.success) throw new HTTPException(400, { message: "A valid Idempotency-Key is required" });
    try {
      const fingerprint = await associationMutationFingerprint("association.create", parsed.data);
      const replay = await replayedAssociationMutation({
        env: c.env, principal, action: "association.create", idempotencyKey: key.data, fingerprint,
      });
      if (replay) {
        const association = (await listAssociations(c.env)).find(item => item.id === replay);
        if (!association) throw new HTTPException(409, { message: "The replayed Viewer association no longer exists" });
        const sessionRevocation = await drainViewerSessionRevocations(c.env, { associationId: replay });
        return c.json({ association, replayed: true, sessionRevocation }, 200);
      }
      const [projects, models] = await Promise.all([listProjectOptions(c.env), viewerServiceClient(c.env).listModels()]);
      const project = projects.find(item => item.id === parsed.data.projectId);
      const model = models.find(item => item.id === parsed.data.viewerModelId);
      if (!project || !model?.available || model.status !== "ready" || !model.activeVersion)
        throw new HTTPException(404, { message: "Ready model or active client project not found" });
      const paProject = await c.env.OPS_DB.withSession("first-primary").prepare(
        "SELECT updated_at FROM pa_projects WHERE id=? AND active=1",
      ).bind(project.project_alpha_project_id).first<{ updated_at: string }>();
      if (!paProject || paProject.updated_at !== project.source_updated_at)
        throw new HTTPException(409, { message: "Project data changed; synchronize Project Alpha before associating this model" });
      const persisted = await persistViewerAssociation({
        env: c.env, principal, project,
        model: model as ViewerModelSummary & { activeVersion: NonNullable<ViewerModelSummary["activeVersion"]> },
        idempotencyKey: key.data, fingerprint,
      });
      const association = (await listAssociations(c.env)).find(item => item.id === persisted.id);
      const sessionRevocation = await drainViewerSessionRevocations(c.env, { associationId: persisted.id });
      if (persisted.replayed) return c.json({ association, replayed: true, sessionRevocation }, 200);
      await c.env.OPS_DB.batch([await auditStatement(
        c.env, c.req.raw, principal,
        persisted.created ? "viewer.association.created" : "viewer.association.refreshed",
        "viewer_model_association", persisted.id, null,
        { projectId: project.id, viewerModelId: model.id, viewerModelVersionId: model.activeVersion.id },
      )]);
      return c.json({ association, sessionRevocation }, persisted.created ? 201 : 200);
    } catch (error) { return viewerError(error); }
  });

  app.delete("/api/viewer/associations/:associationId", async c => {
    const principal = c.get("principal");
    await requireGlobalViewer(c.env, principal, "viewer.manage");
    const associationId = opaqueId.safeParse(c.req.param("associationId"));
    const value = revokeInput.safeParse(await c.req.json().catch(() => null));
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    if (!associationId.success || !value.success || !key.success)
      throw new HTTPException(400, { message: "Viewer association revocation is invalid" });
    const fingerprint = await associationMutationFingerprint("association.revoke", {
      associationId: associationId.data, reason: value.data.reason,
    });
    const replay = await replayedAssociationMutation({
      env: c.env, principal, action: "association.revoke", idempotencyKey: key.data, fingerprint,
    });
    if (replay) {
      const sessionRevocation = await drainViewerSessionRevocations(c.env, { associationId: replay });
      return c.json({ success: true, replayed: true, sessionRevocation }, sessionRevocation.pending ? 202 : 200);
    }
    const database = primaryDeliveryDb(c.env);
    const existing = await database.prepare(
      "SELECT id,state,association_version FROM viewer_model_associations WHERE id=?",
    ).bind(associationId.data).first<{ id: string; state: string; association_version: number }>();
    if (!existing) throw new HTTPException(404, { message: "Viewer association not found" });
    try {
      const statements = [database.prepare(`UPDATE viewer_model_associations SET
      state='revoked',association_version=association_version+1,updated_at=datetime('now'),
      revoked_at=COALESCE(revoked_at,datetime('now')),revoked_by_staff_id=COALESCE(revoked_by_staff_id,?),
      revoke_reason=COALESCE(revoke_reason,?) WHERE id=? AND state='active'`)
        .bind(principal.id, value.data.reason, associationId.data)];
      if (existing.state === "active") statements.unshift(database.prepare(`INSERT OR IGNORE INTO viewer_session_revocation_outbox
        (id,association_id,association_version,idempotency_key)
        SELECT ?,id,association_version,? FROM viewer_model_associations WHERE id=? AND state='active'`)
        .bind(crypto.randomUUID(), `viewer-session-revoke:${crypto.randomUUID()}`, associationId.data));
      statements.push(database.prepare(`INSERT INTO viewer_association_mutation_receipts
        (actor_staff_id,idempotency_key,action,request_fingerprint,association_id) VALUES (?,?,?,?,?)`)
        .bind(principal.id, key.data, "association.revoke", fingerprint, associationId.data));
      await database.batch(statements);
    } catch (error) {
      const raced = await replayedAssociationMutation({
        env: c.env, principal, action: "association.revoke", idempotencyKey: key.data, fingerprint,
      });
      if (!raced) throw error;
      const sessionRevocation = await drainViewerSessionRevocations(c.env, { associationId: raced });
      return c.json({ success: true, replayed: true, sessionRevocation }, sessionRevocation.pending ? 202 : 200);
    }
    if (existing.state === "active") await c.env.OPS_DB.batch([await auditStatement(
      c.env, c.req.raw, principal, "viewer.association.revoked", "viewer_model_association",
      associationId.data, null, { reason: value.data.reason },
    )]);
    const sessionRevocation = await drainViewerSessionRevocations(c.env, { associationId: associationId.data });
    return c.json({ success: true, sessionRevocation }, sessionRevocation.pending ? 202 : 200);
  });

  app.post("/api/viewer/associations/:associationId/session", async c => {
    const principal = c.get("principal");
    await requireGlobalViewer(c.env, principal, "viewer.view");
    const associationId = opaqueId.safeParse(c.req.param("associationId"));
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    if (!associationId.success || !key.success)
      throw new HTTPException(400, { message: "Viewer session request is invalid" });
    const association = await currentStaffAssociation(c.env, associationId.data);
    if (!association) throw new HTTPException(404, { message: "3D model not found" });
    try {
      const grant = await issueViewerSession({
        env: c.env, actorId: principal.id, audience: "ops", association, idempotencyKey: key.data,
        displayUnits: await resolveViewerUnits(c.env, principal.id),
      });
      return c.json({ ...grant, modelId: association.viewer_model_id }, 201);
    } catch (error) { return viewerError(error); }
  });

  app.get("/api/viewer/models/:modelId/shares", async c => {
    const principal = c.get("principal");
    await requireGlobalViewer(c.env, principal, "viewer.view");
    if (!viewerPublicSharesEnabled(c.env))
      throw new HTTPException(404, { message: "Viewer public shares are not enabled" });
    const modelId = opaqueId.safeParse(c.req.param("modelId"));
    if (!modelId.success) throw new HTTPException(400, { message: "Viewer model is invalid" });
    try {
      return c.json({ shares: await viewerServiceClient(c.env).listPublicShares(modelId.data) });
    } catch (error) { return viewerError(error); }
  });

  app.post("/api/viewer/models/:modelId/shares", async c => {
    const principal = c.get("principal");
    await requireGlobalViewer(c.env, principal, "viewer.share.create");
    if (!viewerPublicSharesEnabled(c.env))
      throw new HTTPException(404, { message: "Viewer public shares are not enabled" });
    const modelId = opaqueId.safeParse(c.req.param("modelId"));
    const value = publicShareInput.safeParse(await c.req.json().catch(() => null));
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    if (!modelId.success || !value.success || !key.success)
      throw new HTTPException(400, { message: value.success ? "Viewer public-share request is invalid" : value.error.issues[0]?.message || "Viewer public-share request is invalid" });
    try {
      const client = viewerServiceClient(c.env);
      const model = (await client.listModels()).find(item => item.id === modelId.data);
      if (!model?.available || model.status !== "ready" || !model.activeVersion)
        throw new HTTPException(404, { message: "Ready 3D model not found" });
      const created = await client.createPublicShare({
        modelId: model.id,
        idempotencyKey: key.data,
        createdBy: `ops:${principal.id}`.slice(0, 200),
        label: value.data.label,
        expiresAt: value.data.expiresAt,
        displayUnits: value.data.displayUnits,
        password: value.data.password,
        permissions: value.data.permissions,
      });
      await c.env.OPS_DB.batch([await auditStatement(
        c.env, c.req.raw, principal, "viewer.share.created", "viewer_public_share", created.share.id, null,
        {
          viewerModelId: model.id,
          viewerModelVersionId: model.activeVersion.id,
          label: created.share.label,
          expiresAt: created.share.expiresAt,
          passwordProtected: created.share.hasPassword,
          permissions: created.share.permissions,
        },
      )]);
      return c.json({ share: created.share, viewUrl: created.viewUrl }, 201);
    } catch (error) { return viewerError(error); }
  });

  app.delete("/api/viewer/shares/:shareId", async c => {
    const principal = c.get("principal");
    await requireGlobalViewer(c.env, principal, "viewer.share.revoke");
    if (!viewerPublicSharesEnabled(c.env))
      throw new HTTPException(404, { message: "Viewer public shares are not enabled" });
    const shareId = opaqueId.safeParse(c.req.param("shareId"));
    const value = revokeInput.safeParse(await c.req.json().catch(() => null));
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    if (!shareId.success || !value.success || !key.success)
      throw new HTTPException(400, { message: "Viewer public-share revocation is invalid" });
    try {
      const share = await viewerServiceClient(c.env).revokePublicShare({
        shareId: shareId.data,
        idempotencyKey: key.data,
        reason: value.data.reason,
      });
      await c.env.OPS_DB.batch([await auditStatement(
        c.env, c.req.raw, principal, "viewer.share.revoked", "viewer_public_share", share.id, null,
        { viewerModelId: share.modelId, reason: value.data.reason },
      )]);
      return c.json({ share });
    } catch (error) { return viewerError(error); }
  });
}

export { currentStaffAssociation };
