import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sqlScope } from "./acl";
import { readBoundedJson } from "./bounded-json";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import { decodeProjectAlphaApiV2SyncCursor, encodeProjectAlphaApiV2SyncCursor,
  type ProjectAlphaApiV2SyncSurface } from "./project-alpha-api-v2-sync-cursor";
import {
  runProjectAlphaApiV2SyncPage,
  type ProjectAlphaApiV2PersistedPage,
  type ProjectAlphaApiV2SyncPageOutcome,
} from "./project-alpha-v2-sync";
import { auditStatement } from "./request-security";
import type { Env, StaffPrincipal } from "./types";

type Variables = { principal: StaffPrincipal; administrator: boolean };
type App = Hono<{ Bindings: Env; Variables: Variables }>;

export const PROJECT_ALPHA_API_V2_SYNC_ROUTE =
  "/api/admin/integrations/project-alpha/api-v2/sync-page";

const sourceId = z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/);
const requestSchema = z.object({
  sourceId,
  directoryContinuationToken: z.string().min(1).max(2048).optional(),
  projectContinuationToken: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict().superRefine((value, context) => {
  if (value.directoryContinuationToken && value.projectContinuationToken)
    context.addIssue({ code: "custom", message: "Continue one inventory surface at a time" });
  if ((value.directoryContinuationToken || value.projectContinuationToken) && value.limit === undefined)
    context.addIssue({ code: "custom", message: "Continuation limit is required" });
});

type SafeSurface = Readonly<{
  status: string;
  reason?: string;
  itemCount?: number;
  conflictCount?: number;
  hasMore?: boolean;
  continuationToken?: string;
}>;

async function safeSurface(env: Env, actorId: string, sourceId: string, limit: number,
  surfaceName: ProjectAlphaApiV2SyncSurface,
  surface: ProjectAlphaApiV2PersistedPage | Readonly<{ status: "not_requested" }> | Readonly<{
  status: "blocked";
  reason: string;
}>): Promise<SafeSurface> {
  if (surface.status === "blocked") return { status: surface.status, reason: surface.reason };
  if (surface.status === "not_requested") return { status: surface.status };
  const continuationToken = surface.nextCursor === null ? undefined : await encodeProjectAlphaApiV2SyncCursor(env, actorId, {
    v: 1, sourceId, surface: surfaceName, limit, ...surface.continuationIdentity,
    cursor: surface.nextCursor, expires: Date.now() + 5 * 60_000,
  });
  return {
    status: surface.status,
    itemCount: surface.itemCount,
    conflictCount: surface.conflictCount,
    hasMore: surface.nextCursor !== null,
    ...(continuationToken ? { continuationToken } : {}),
  };
}

async function safeOutcome(env: Env, actorId: string, sourceId: string, limit: number,
  outcome: ProjectAlphaApiV2SyncPageOutcome): Promise<Record<string, unknown>> {
  if (outcome.status !== "completed" && outcome.status !== "partial") {
    return {
      status: outcome.status,
      ...(outcome.status === "blocked" || outcome.status === "rejected" ? { reason: outcome.reason } : {}),
    };
  }
  return {
    status: outcome.status,
    directory: await safeSurface(env, actorId, sourceId, limit, "directory", outcome.directory),
    projects: await safeSurface(env, actorId, sourceId, limit, "projects", outcome.projects),
  };
}

function auditOutcome(value: Record<string, unknown>): Record<string, unknown> {
  const strip = (surface: unknown) => {
    if (!surface || typeof surface !== "object" || Array.isArray(surface)) return surface;
    const { continuationToken: _continuationToken, ...safe } = surface as Record<string, unknown>;
    return safe;
  };
  return { ...value, ...(value.directory ? { directory: strip(value.directory) } : {}),
    ...(value.projects ? { projects: strip(value.projects) } : {}) };
}

/** Mounted after Operations' authenticated mutation middleware. That
 * middleware supplies same-origin and CSRF protection before this route runs. */
export function registerProjectAlphaApiV2SyncRoutes(app: App): void {
  app.post(PROJECT_ALPHA_API_V2_SYNC_ROUTE, async c => {
    if (c.env.PROJECT_ALPHA_API_V2_SYNC_ENABLED !== "true")
      throw new HTTPException(404, { message: "Not found" });
    if (!c.get("administrator"))
      throw new HTTPException(403, { message: "Administrator access required" });
    const permission = await sqlScope(c.env, c.get("principal"), "integrations.manage");
    if (!permission.global || permission.deniedGlobal)
      throw new HTTPException(403, { message: "Global integrations.manage permission required" });

    const parsed = requestSchema.safeParse(await readBoundedJson(
      c.req.raw,
      2_048,
      "Project Alpha API v2 bounded sync",
    ));
    if (!parsed.success)
      throw new HTTPException(400, { message: "Project Alpha API v2 sync request is invalid" });

    c.header("Cache-Control", "no-store");
    const limit = parsed.data.limit ?? 100;
    let continuation;
    const surface: ProjectAlphaApiV2SyncSurface | null = parsed.data.directoryContinuationToken ? "directory"
      : parsed.data.projectContinuationToken ? "projects" : null;
    const token = parsed.data.directoryContinuationToken ?? parsed.data.projectContinuationToken;
    if (surface && token) {
      let decoded;
      try {
        decoded = await decodeProjectAlphaApiV2SyncCursor(c.env, c.get("principal").id, token,
          { sourceId: parsed.data.sourceId, surface, limit });
      } catch (error) {
        const status = error instanceof Error && error.message.endsWith("is stale") ? 409 : 400;
        throw new HTTPException(status, { message: "Project Alpha inventory continuation is invalid or stale" });
      }
      let current;
      try { current = resolveProjectAlphaApiV2Connection(c.env, parsed.data.sourceId); }
      catch { throw new HTTPException(409, { message: "Project Alpha inventory source changed; restart the bounded inventory" }); }
      if (!current.enabled || current.connection.expectedSourceInstanceId !== decoded.sourceInstanceId
        || current.connection.expectedApplicationId !== decoded.applicationId
        || current.connection.expectedHistoryEpoch !== decoded.historyEpoch)
        throw new HTTPException(409, { message: "Project Alpha inventory source changed; restart the bounded inventory" });
      continuation = decoded;
    }
    const outcome = await runProjectAlphaApiV2SyncPage(c.env, { sourceId: parsed.data.sourceId, limit, ...(continuation ? { continuation } : {}) });
    const stale = outcome.status === "partial" && [outcome.directory, outcome.projects]
      .some(item => item.status === "blocked" && item.reason === "cursor_stale");
    const safeResult = await safeOutcome(c.env, c.get("principal").id, parsed.data.sourceId, limit, outcome);
    await c.env.OPS_DB.batch([await auditStatement(
      c.env,
      c.req.raw,
      c.get("principal"),
      "integration.project_alpha_api_v2_sync_page_completed",
      "project_alpha_api_v2_sync_page",
      "bounded_page",
      null,
      auditOutcome(safeResult),
    )]);
    if (stale) throw new HTTPException(409, { message: "Project Alpha inventory changed; restart the bounded inventory" });
    return c.json(safeResult);
  });
}
