import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { canManageOperationsCustomerServices, createOperationsServiceDefinition, readOperationsServiceManagement,
  writeOperationsCustomerServiceEnrollment } from "./ops-service-management";
import type { Env, StaffPrincipal } from "./types";

type App = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
type AppContext = Context<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
export const OPS_SERVICE_MANAGEMENT_ROUTE = "/api/client-hub/service-management";
const MAX_BODY = 8 * 1024;

export function opsServiceManagementEnabled(env: Pick<Env, "ENVIRONMENT" | "OPS_SERVICE_MANAGEMENT_ENABLED">) {
  return env.ENVIRONMENT === "staging" && env.OPS_SERVICE_MANAGEMENT_ENABLED === "true";
}

export function registerOpsServiceManagementRoutes(app: App) {
  app.use(`${OPS_SERVICE_MANAGEMENT_ROUTE}/*`, async (c, next) => {
    c.header("Cache-Control", "no-store"); c.header("Cloudflare-CDN-Cache-Control", "no-store");
    if (!opsServiceManagementEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    await next();
  });
  const actor = async (c: AppContext) => {
    const authenticated = await authenticateNativeStaffWithAdmissionVersion(c.req.raw, c.env.OPS_DB,
      { enabled: true, issuer: c.env.TEAM_DOMAIN ?? "", staffAudience: c.env.OPERATIONS_AUD });
    const principal = c.get("principal");
    if (principal.id !== authenticated.identity.staffId) throw new HTTPException(403, { message: "Denied" });
    return authenticated;
  };
  app.get(`${OPS_SERVICE_MANAGEMENT_ROUTE}/clients/:recordId`, async c => {
    const authenticated = await actor(c), recordId = c.req.param("recordId");
    if (!await canManageOperationsCustomerServices(c.env.OPS_DB, authenticated, recordId))
      throw new HTTPException(403, { message: "Denied" });
    return c.json(await readOperationsServiceManagement(c.env.OPS_DB, recordId));
  });
  app.post(`${OPS_SERVICE_MANAGEMENT_ROUTE}/definitions`, async c => {
    const body = await readBoundedJson(c.req.raw, MAX_BODY, "Service definition");
    const key = c.req.header("Idempotency-Key");
    if (!body || typeof body !== "object" || Array.isArray(body) || key !== Reflect.get(body, "idempotencyKey"))
      throw new HTTPException(400, { message: "Invalid request" });
    return c.json(await createOperationsServiceDefinition(c.env.OPS_DB, await actor(c), body), 201);
  });
  app.post(`${OPS_SERVICE_MANAGEMENT_ROUTE}/clients/:recordId/enrollments`, async c => {
    const body = await readBoundedJson(c.req.raw, MAX_BODY, "Service enrollment");
    const key = c.req.header("Idempotency-Key");
    if (!body || typeof body !== "object" || Array.isArray(body) || key !== Reflect.get(body, "idempotencyKey")
      || Reflect.get(body, "customerRecordId") !== c.req.param("recordId"))
      throw new HTTPException(400, { message: "Invalid request" });
    return c.json(await writeOperationsCustomerServiceEnrollment(c.env.OPS_DB, await actor(c), body));
  });
}
