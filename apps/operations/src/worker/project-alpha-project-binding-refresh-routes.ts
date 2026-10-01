import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sqlScope } from "./acl";
import { readBoundedJson } from "./bounded-json";
import { auditStatement } from "./request-security";
import { refreshProjectAlphaProjectBinding } from "./project-alpha-project-binding-revision-refresh";
import type { Env, StaffPrincipal } from "./types";

type Variables = { principal: StaffPrincipal; administrator: boolean };
type App = Hono<{ Bindings: Env; Variables: Variables }>;

export const PROJECT_ALPHA_PROJECT_BINDING_REFRESH_ROUTE =
  "/api/admin/integrations/project-alpha/api-v2/project-binding-refresh";

const schema = z.object({
  sourceId: z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/),
  externalProjectId: z.string().min(1).max(191).refine(value => !/\p{C}/u.test(value)),
  commandId: z.string().uuid(),
}).strict();

/**
 * Staging-only operator recovery for one explicitly selected stale binding.
 * This route never accepts revisions or public IDs from the browser; the
 * service re-reads the PA status and fences the exact response server-side.
 */
export function registerProjectAlphaProjectBindingRefreshRoutes(app: App): void {
  app.post(PROJECT_ALPHA_PROJECT_BINDING_REFRESH_ROUTE, async c => {
    if (c.env.ENVIRONMENT !== "staging" || c.env.PROJECT_ALPHA_PROJECT_BINDING_REFRESH_ENABLED !== "true")
      throw new HTTPException(404, { message: "Not found" });
    if (!c.get("administrator")) throw new HTTPException(403, { message: "Administrator access required" });
    const permission = await sqlScope(c.env, c.get("principal"), "integrations.manage");
    if (!permission.global || permission.deniedGlobal)
      throw new HTTPException(403, { message: "Global integrations.manage permission required" });
    const parsed = schema.safeParse(await readBoundedJson(c.req.raw, 2_048, "Project binding refresh"));
    if (!parsed.success) throw new HTTPException(400, { message: "Project binding refresh request is invalid" });
    if (c.req.header("Idempotency-Key") !== parsed.data.commandId)
      throw new HTTPException(400, { message: "Idempotency-Key must match commandId" });
    c.header("Cache-Control", "no-store");
    const outcome = await refreshProjectAlphaProjectBinding(c.env, {
      sourceId: parsed.data.sourceId,
      externalProjectId: parsed.data.externalProjectId,
      commandId: parsed.data.commandId,
    });
    await c.env.OPS_DB.batch([await auditStatement(c.env, c.req.raw, c.get("principal"),
      "integration.project_alpha_project_binding_refresh_completed",
      "project_alpha_project_binding_refresh", parsed.data.commandId, null, {
        sourceId: parsed.data.sourceId,
        externalProjectId: parsed.data.externalProjectId,
        status: outcome.status,
        ...(outcome.status === "acknowledged" ? { postStatusConfirmed: outcome.postStatusConfirmed } : {}),
        ...(outcome.status !== "acknowledged" ? { reason: outcome.reason } : {}),
      })]);
    return c.json({ sourceId: parsed.data.sourceId, externalProjectId: parsed.data.externalProjectId, outcome });
  });
}
