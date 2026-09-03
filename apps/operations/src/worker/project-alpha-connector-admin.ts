import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import { sqlScope } from "./acl";
import { rebuildOperationAirspaceMatches } from "./airspace";
import { auditStatement } from "./request-security";
import { syncRegisteredProjectAlpha } from "./project-alpha";
import { reconcilePrimaryClientPortalWorkspaces } from "./client-account-root-activation";
import { getProjectAlphaSnapshotRecoveryStatus } from "./project-alpha-snapshot-recovery";
import {
  listProjectAlphaConnectors, preflightPrimaryProjectAlphaConnector, ProjectAlphaConnectorError, registerProjectAlphaConnector,
} from "./project-alpha-connectors";
import { PortalSourceAuthorityError } from "../../../client/src/worker/project-alpha-portal-authority";
import {
  getConnectorPortalStatus, configureConnectorPortal, changeConnectorPortal, recoverConnectorPortalCoordination,
  reviseCoordinatedProjectAlphaConnector, setCoordinatedProjectAlphaConnectorState,
} from "./project-alpha-portal-coordination";
import type { Env, StaffPrincipal } from "./types";
import {
  listProjectAlphaProjectManagementRoutes, ProjectAlphaProjectManagementError,
  setProjectAlphaProjectManagementRoute,
} from "./project-alpha-project-management";

type App = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
const ROOT = "/api/admin/integrations/project-alpha/connectors";
export function portalAuthorityErrorResponse(error: PortalSourceAuthorityError): { status: 400 | 409 | 503; error: string; code: string } {
  return {
    status: error.code === "invalid" ? 400 : error.code === "conflict" || error.code === "changed" ? 409 : 503,
    error: error.code === "credentials_unavailable"
      ? "Deploy this connection's portal signing credentials to Operations and Client before configuring client access"
      : error.code === "invalid" ? "Portal connection request is invalid"
      : error.code === "conflict" || error.code === "changed" ? "Portal connection changed. Refresh its status before continuing"
      : "Portal connection is unavailable. Refresh status and recover any unfinished connection update",
    code: `PROJECT_ALPHA_PORTAL_${error.code.toUpperCase()}`,
  };
}
function projectManagementHttpError(error: unknown): never {
  if (error instanceof ProjectAlphaProjectManagementError || (error instanceof Error
    && error.name === "ProjectAlphaProjectManagementError"
    && ["invalid", "conflict", "changed", "unavailable"].includes(String((error as { code?: unknown }).code)))) {
    const code = (error as ProjectAlphaProjectManagementError).code;
    throw new HTTPException(code === "invalid" ? 400 : code === "conflict" || code === "changed" ? 409 : 503,
      { message: (error as Error).message });
  }
  throw error;
}
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
      if (error instanceof PortalSourceAuthorityError) {
        const response = portalAuthorityErrorResponse(error);
        throw new HTTPException(response.status, { message: response.error });
      }
      // Miniflare can evaluate Worker module boundaries in separate realms, so
      // retain the named, bounded domain-error fallback instead of relying only
      // on instanceof when translating this non-secret administration error.
      if (error instanceof ProjectAlphaProjectManagementError || (error instanceof Error
        && error.name === "ProjectAlphaProjectManagementError")) projectManagementHttpError(error);
      throw error;
    }
  });
  app.get(ROOT, async c => {
    const connectors = await listProjectAlphaConnectors(c.env);
    const registeredPrimary = connectors.find(row => row.sourceId === "project-alpha:primary");
    const ids = ["project-alpha:primary", ...connectors.map(row => row.sourceId).filter(id => id !== "project-alpha:primary")];
    const health = await c.env.OPS_DB.withSession("first-primary").prepare(`SELECT projection_source_id sourceId,status,last_attempt_at lastAttemptAt,
      last_success_at lastSuccessAt,last_error_code lastErrorCode,consecutive_failures consecutiveFailures
      FROM integration_health WHERE integration='project-alpha' AND projection_source_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids).all<Record<string, unknown>>();
    const safeHealth = health.results.map(row => ({ ...row, lastErrorCode: row.lastErrorCode == null ? null
      : typeof row.lastErrorCode === "string" && /^[a-z][a-z0-9-]{0,119}$/.test(row.lastErrorCode) ? row.lastErrorCode : "project-alpha-sync-failed" }));
    const recovery = await getProjectAlphaSnapshotRecoveryStatus(c.env.OPS_DB);
    const portal = await getConnectorPortalStatus(c.env);
    const projectManagement = await listProjectAlphaProjectManagementRoutes(c.env);
    return c.json({ connectors, health: safeHealth, recovery, portal, projectManagement,
      legacyPrimary: !registeredPrimary || registeredPrimary.state === "pending" });
  });
  app.post(ROOT, async c => c.json({ connector: await registerProjectAlphaConnector(c.env,
    await json(c.req.raw, registration), c.get("principal").id) }, 201));
  app.post(`${ROOT}/primary-preflight`, async c => c.json({ preflight: await preflightPrimaryProjectAlphaConnector(c.env,
    await json(c.req.raw, registration)) }));
  app.post(`${ROOT}/:sourceId/revisions`, async c => {
    const value = await json(c.req.raw, z.object({ expectedVersion: z.number().int().positive(), revision }).strict());
    return c.json({ connector: await reviseCoordinatedProjectAlphaConnector(c.env, c.req.param("sourceId"), value.expectedVersion, value.revision, c.get("principal").id) });
  });
  app.patch(`${ROOT}/:sourceId`, async c => c.json({ connector: await setCoordinatedProjectAlphaConnectorState(c.env,
    c.req.param("sourceId"), await json(c.req.raw, state), c.get("principal").id) }));
  app.post(`${ROOT}/:sourceId/portal`, async c => {
    const value = await json(c.req.raw, z.object({
      expectedVersion: z.number().int().positive(), expectedPortalVersion: z.number().int().positive().nullable(),
      action: z.enum(["configure", "activate", "suspend"]),
    }).strict());
    if (value.action !== "configure" && value.expectedPortalVersion === null)
      throw new HTTPException(400, { message: "Configure this connection's client portal before changing its state" });
    const authority = value.action === "configure"
      ? await configureConnectorPortal(c.env, c.req.param("sourceId"), value.expectedVersion, value.expectedPortalVersion, c.get("principal").id)
      : await changeConnectorPortal(c.env, c.req.param("sourceId"), value.expectedVersion, value.expectedPortalVersion!,
        value.action === "activate" ? "active" : "suspended", c.get("principal").id);
    return c.json({ authority });
  });
  app.post(`${ROOT}/recover-portal-update`, async c => {
    const value = await json(c.req.raw, z.object({ expectedVersion: z.number().int().positive() }).strict());
    await recoverConnectorPortalCoordination(c.env, value.expectedVersion, c.get("principal").id);
    return c.json({ recovered: true });
  });
  app.post(`${ROOT}/:sourceId/sync`, async c => {
    await json(c.req.raw, z.object({}).strict());
    const sourceId = c.req.param("sourceId");
    await c.env.OPS_DB.batch([await auditStatement(c.env, c.req.raw, c.get("principal"), "integration.sync_requested", "integration", sourceId, null, { sourceId })]);
    const result = await syncRegisteredProjectAlpha(c.env, sourceId);
    if (result.changedCollections.some(name => name === "operations" || name === "service_locations")) await rebuildOperationAirspaceMatches(c.env);
    const clientPortalReconciliation = sourceId === PRIMARY_ALPHA_SOURCE_ID && result.status === "success"
      ? await reconcilePrimaryClientPortalWorkspaces(c.env)
      : undefined;
    if (clientPortalReconciliation) console.log(JSON.stringify({
      event: "client_portal.primary_workspace_reconciliation",
      ...clientPortalReconciliation,
    }));
    return c.json({ sourceId, ...result, ...(clientPortalReconciliation ? { clientPortalReconciliation } : {}) });
  });
  app.put(`${ROOT}/:sourceId/project-management`, async c => {
    const value = await json(c.req.raw, z.object({
      expectedConnectorVersion: z.number().int().positive(), expectedVersion: z.number().int().positive().nullable(),
      idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
      reviewedUrlTemplate: z.string().min(9).max(2048).nullable(),
    }).strict());
    try {
      return c.json({ projectManagement: await setProjectAlphaProjectManagementRoute(c.env,
        c.req.param("sourceId"), value, c.get("principal").id) });
    } catch (error) { return projectManagementHttpError(error); }
  });
}
