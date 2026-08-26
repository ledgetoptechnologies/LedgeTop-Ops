import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sqlScope } from "./acl";
import { rebuildOperationAirspaceMatches } from "./airspace";
import { auditStatement } from "./request-security";
import { syncRegisteredProjectAlpha } from "./project-alpha";
import {
  listProjectAlphaConnectors, ProjectAlphaConnectorError, registerProjectAlphaConnector,
  reviseProjectAlphaConnector, setProjectAlphaConnectorState,
} from "./project-alpha-connectors";
import type { Env, StaffPrincipal } from "./types";

type App = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
const ROOT = "/api/admin/integrations/project-alpha/connectors";
const revision = z.object({ credentialRef: z.string().min(1).max(64), snapshotBasePath: z.string().min(1).max(1024),
  accessIssuer: z.string().min(1).max(2048), accessAudience: z.string().min(1).max(512), accessSubject: z.string().min(1).max(512) }).strict();
const registration = z.object({ sourceId: z.string().min(1).max(78), producerBindingId: z.string().min(1).max(128),
  snapshotOrigin: z.string().min(1).max(2048), applicationKey: z.string().min(1).max(64),
  profile: z.enum(["primary_legacy", "business_data"]), displayName: z.string().min(1).max(160), revision }).strict();
const state = z.object({ expectedVersion: z.number().int().positive(), state: z.enum(["pending", "active", "suspended", "retired"]),
  readVisible: z.boolean().optional(), displayName: z.string().min(1).max(160).optional() }).strict();
async function json<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new HTTPException(415, { message: "Connection request must use application/json" });
  if (!request.body) throw new HTTPException(400, { message: "Connection request must contain JSON" });
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let bytes: Uint8Array;
  try {
    bytes = await Promise.race([
      (async () => {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 16 * 1024) throw new HTTPException(413, { message: "Connection request is too large" });
          if (next.value.byteLength) chunks.push(next.value);
        }
        const result = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
        return result;
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HTTPException(408, { message: "Connection request timed out" })), 5000); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Cancel any pending read as well as the upstream body on timeout/overflow.
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([reader.cancel().catch(() => undefined), new Promise<void>(resolve => { cancelTimer = setTimeout(resolve, 50); })]);
    if (cancelTimer !== undefined) clearTimeout(cancelTimer);
    reader.releaseLock();
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new HTTPException(400, { message: "Connection request must contain valid JSON" }); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HTTPException(400, { message: "Connection request is invalid" });
  return parsed.data;
}

/** Mounted after the application's staff authentication, administrator gate,
 * and CSRF/origin middleware. This adds a separate deny-aware global check. */
export function registerProjectAlphaConnectorAdminRoutes(app: App): void {
  app.use(`${ROOT}/*`, async (c, next) => {
    if (!c.get("administrator")) throw new HTTPException(403, { message: "Administrator access required" });
    const scope = await sqlScope(c.env, c.get("principal"), "integrations.manage");
    if (!scope.global || scope.deniedGlobal) throw new HTTPException(403, { message: "Global integrations.manage permission required" });
    c.header("Cache-Control", "no-store");
    try { await next(); } catch (error) {
      if (error instanceof ProjectAlphaConnectorError) throw new HTTPException(
        error.code === "invalid" ? 400 : error.code === "changed" || error.code === "conflict" || error.code === "capacity" ? 409 : 503,
        { message: error.message },
      );
      throw error;
    }
  });
  app.get(ROOT, async c => {
    const connectors = await listProjectAlphaConnectors(c.env);
    const ids = ["project-alpha:primary", ...connectors.map(row => row.sourceId).filter(id => id !== "project-alpha:primary")];
    const health = await c.env.OPS_DB.withSession("first-primary").prepare(`SELECT projection_source_id sourceId,status,last_attempt_at lastAttemptAt,
      last_success_at lastSuccessAt,last_error_code lastErrorCode,consecutive_failures consecutiveFailures
      FROM integration_health WHERE integration='project-alpha' AND projection_source_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids).all<Record<string, unknown>>();
    const safeHealth = health.results.map(row => ({ ...row, lastErrorCode: row.lastErrorCode == null ? null
      : typeof row.lastErrorCode === "string" && /^[a-z][a-z0-9-]{0,119}$/.test(row.lastErrorCode) ? row.lastErrorCode : "project-alpha-sync-failed" }));
    return c.json({ connectors, health: safeHealth, legacyPrimary: !connectors.some(row => row.sourceId === "project-alpha:primary") });
  });
  app.post(ROOT, async c => c.json({ connector: await registerProjectAlphaConnector(c.env,
    await json(c.req.raw, registration), c.get("principal").id) }, 201));
  app.post(`${ROOT}/:sourceId/revisions`, async c => {
    const value = await json(c.req.raw, z.object({ expectedVersion: z.number().int().positive(), revision }).strict());
    return c.json({ connector: await reviseProjectAlphaConnector(c.env, c.req.param("sourceId"), value.expectedVersion, value.revision, c.get("principal").id) });
  });
  app.patch(`${ROOT}/:sourceId`, async c => c.json({ connector: await setProjectAlphaConnectorState(c.env,
    c.req.param("sourceId"), await json(c.req.raw, state), c.get("principal").id) }));
  app.post(`${ROOT}/:sourceId/sync`, async c => {
    await json(c.req.raw, z.object({}).strict());
    const sourceId = c.req.param("sourceId");
    await c.env.OPS_DB.batch([await auditStatement(c.env, c.req.raw, c.get("principal"), "integration.sync_requested", "integration", sourceId, null, { sourceId })]);
    const result = await syncRegisteredProjectAlpha(c.env, sourceId);
    if (result.changedCollections.some(name => name === "operations" || name === "service_locations")) await rebuildOperationAirspaceMatches(c.env);
    return c.json({ sourceId, ...result });
  });
}
