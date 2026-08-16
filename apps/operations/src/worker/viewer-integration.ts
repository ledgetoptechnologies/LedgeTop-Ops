import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  ViewerServiceClient,
  ViewerServiceError,
  viewerServiceConfigured,
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
const revokeInput = z.object({ reason: z.string().trim().min(1).max(240) }).strict();
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

interface AssociationRow {
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
  const scope = await sqlScope(env, principal, permission);
  if (!scope.global || scope.deniedGlobal)
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

export function viewerServiceClient(env: Env, fetcher: typeof fetch = fetch): ViewerServiceClient {
  if (!viewerIntegrationEnabled(env) || !viewerServiceConfigured({
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
    "SELECT id FROM viewer_model_associations WHERE project_id=? AND viewer_model_id=?",
  ).bind(input.project.id, input.model.id).first<{ id: string }>();
  const id = existing?.id || crypto.randomUUID();
  try {
    await database.batch([database.prepare(`INSERT INTO viewer_model_associations
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
      (actor_staff_id,idempotency_key,action,request_fingerprint,association_id) VALUES (?,?,?,?,?)`)
      .bind(input.principal.id, input.idempotencyKey, "association.create", input.fingerprint, id),
    ]);
  } catch (error) {
    const raced = await replayedAssociationMutation({
      env: input.env, principal: input.principal, action: "association.create",
      idempotencyKey: input.idempotencyKey, fingerprint: input.fingerprint,
    });
    if (!raced) throw error;
    return { id: raced, created: false, replayed: true };
  }
  return { id, created: !existing, replayed: false };
}

export async function issueViewerSession(input: {
  env: Env;
  actorId: string;
  audience: ViewerAudience;
  association: AssociationRow;
  idempotencyKey: string;
  displayUnits?: ViewerDisplayUnits;
}): Promise<ViewerSessionGrant> {
  const requestFingerprint = await sha256(JSON.stringify({
    associationId: input.association.id,
    associationVersion: input.association.association_version,
    viewerModelId: input.association.viewer_model_id,
    viewerModelVersionId: input.association.viewer_model_version_id,
    displayUnits: input.displayUnits || "imperial",
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
    permissions: { view: true, measure: true, cameras: true, download: false },
  });
  await db.prepare(`INSERT INTO viewer_session_issuance_receipts
    (actor_id,audience,idempotency_key,request_fingerprint,response_json,expires_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(actor_id,audience,idempotency_key) DO UPDATE SET
      response_json=CASE WHEN request_fingerprint=excluded.request_fingerprint THEN excluded.response_json ELSE response_json END,
      expires_at=CASE WHEN request_fingerprint=excluded.request_fingerprint THEN excluded.expires_at ELSE expires_at END`)
    .bind(input.actorId, input.audience, input.idempotencyKey, requestFingerprint, JSON.stringify(grant), grant.grantExpiresAt).run();
  return grant;
}

function viewerError(error: unknown): never {
  if (error instanceof HTTPException) throw error;
  if (error instanceof ViewerServiceError)
    throw new HTTPException(error.status as 404 | 409 | 503, { message: error.message });
  throw error;
}

export function registerViewerIntegrationRoutes(app: ViewerApp): void {
  app.get("/api/viewer", async c => {
    await requireGlobalViewer(c.env, c.get("principal"), "viewer.view");
    if (!viewerIntegrationEnabled(c.env)) return c.json({
      enabled: false, publicSharesEnabled: false, models: [], projects: [], associations: [],
    });
    try {
      const [models, projects, associations] = await Promise.all([
        viewerServiceClient(c.env).listModels(), listProjectOptions(c.env), listAssociations(c.env),
      ]);
      return c.json({
        enabled: true,
        publicSharesEnabled: viewerPublicSharesEnabled(c.env),
        models,
        projects,
        associations,
      });
    } catch (error) { return viewerError(error); }
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
        return c.json({ association, replayed: true }, 200);
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
      if (persisted.replayed) return c.json({ association, replayed: true }, 200);
      await c.env.OPS_DB.batch([await auditStatement(
        c.env, c.req.raw, principal,
        persisted.created ? "viewer.association.created" : "viewer.association.refreshed",
        "viewer_model_association", persisted.id, null,
        { projectId: project.id, viewerModelId: model.id, viewerModelVersionId: model.activeVersion.id },
      )]);
      return c.json({ association }, persisted.created ? 201 : 200);
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
    if (replay) return c.json({ success: true, replayed: true });
    const database = primaryDeliveryDb(c.env);
    const existing = await database.prepare(
      "SELECT id,state FROM viewer_model_associations WHERE id=?",
    ).bind(associationId.data).first<{ id: string; state: string }>();
    if (!existing) throw new HTTPException(404, { message: "Viewer association not found" });
    try {
      await database.batch([database.prepare(`UPDATE viewer_model_associations SET
      state='revoked',association_version=association_version+1,updated_at=datetime('now'),
      revoked_at=COALESCE(revoked_at,datetime('now')),revoked_by_staff_id=COALESCE(revoked_by_staff_id,?),
      revoke_reason=COALESCE(revoke_reason,?) WHERE id=? AND state='active'`)
        .bind(principal.id, value.data.reason, associationId.data),
      database.prepare(`INSERT INTO viewer_association_mutation_receipts
        (actor_staff_id,idempotency_key,action,request_fingerprint,association_id) VALUES (?,?,?,?,?)`)
        .bind(principal.id, key.data, "association.revoke", fingerprint, associationId.data),
      ]);
    } catch (error) {
      const raced = await replayedAssociationMutation({
        env: c.env, principal, action: "association.revoke", idempotencyKey: key.data, fingerprint,
      });
      if (!raced) throw error;
      return c.json({ success: true, replayed: true });
    }
    if (existing.state === "active") await c.env.OPS_DB.batch([await auditStatement(
      c.env, c.req.raw, principal, "viewer.association.revoked", "viewer_model_association",
      associationId.data, null, { reason: value.data.reason },
    )]);
    return c.json({ success: true });
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
      return c.json(await issueViewerSession({
        env: c.env, actorId: principal.id, audience: "ops", association, idempotencyKey: key.data,
        displayUnits: await resolveViewerUnits(c.env, principal.id),
      }), 201);
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

export { currentStaffAssociation, type AssociationRow };
