import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { admittedOperationsRequestOrigin } from "./host-admission";
import { auditStatement, csrfToken, requireMutationSecurity } from "./request-security";
import { changeStaffOperationsAccess, openStaffOperationsAccess, readStaffOperationsAccess, StaffOperationsAccessError,
  type StaffOperationsAccessCommand } from "./staff-operations-access";
import type { Env, StaffPrincipal } from "./types";

type Bindings = { Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } };
const ROUTE = "/api/staff-operations-access/:staffId";
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const KEYS = ["commandId", "permission", "operation", "expectedRevision", "expectedAdmissionVersion", "reason"];
function commandSnapshot(value: unknown): StaffOperationsAccessCommand {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== KEYS.length || !KEYS.every(key => Object.hasOwn(value, key)))
    throw new StaffOperationsAccessError("staff_operations_access_invalid", 400);
  const input = value as Record<string, unknown>;
  if (typeof input.commandId !== "string" || typeof input.permission !== "string"
    || input.operation !== "grant" && input.operation !== "revoke" || typeof input.expectedRevision !== "number"
    || typeof input.expectedAdmissionVersion !== "number" || typeof input.reason !== "string")
    throw new StaffOperationsAccessError("staff_operations_access_invalid", 400);
  return Object.freeze({ commandId: input.commandId, permission: input.permission, operation: input.operation,
    expectedRevision: input.expectedRevision, expectedAdmissionVersion: input.expectedAdmissionVersion, reason: input.reason });
}

/** Native-only Operations-access writer for Ops-onboarded hires. Terminates
 * before the generic staff wrapper; independently verifies the Access JWT and
 * native identity and never trusts an administrator flag or browser actor
 * fields. Activation is migration 0244 only: absent → 404, partial → 503,
 * both decided before any authentication or authorization read. */
export function registerStaffOperationsAccessRoutes(app: Hono<Bindings>): void {
  for (const method of ["get", "post"] as const) app[method](ROUTE, async c => {
    try {
      const request = c.req.raw;
      if (request.method !== method.toUpperCase()) return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, POST" } });
      if (new URL(request.url).search) return json({ error: "staff_operations_access_invalid" }, 400);
      const origin = admittedOperationsRequestOrigin(request.url, { ENVIRONMENT: c.env.ENVIRONMENT,
        EXPECTED_HOST: c.env.EXPECTED_HOST, OPERATIONS_ORIGINS: c.env.OPERATIONS_ORIGINS }, c.env.PUBLIC_BASE_URL);
      if (origin === null) return json({ error: "staff_operations_access_denied" }, 403);
      const session = await openStaffOperationsAccess(c.env.OPS_DB);
      const actor = await authenticateNativeStaffWithAdmissionVersion(request, c.env.OPS_DB, {
        enabled: true, issuer: c.env.TEAM_DOMAIN, staffAudience: c.env.OPERATIONS_AUD,
      });
      const principal: StaffPrincipal = { id: actor.identity.staffId, email: actor.identity.email,
        displayName: actor.identity.displayName, accessSubject: actor.identity.verifiedAccessSubject,
        projectAlphaUserId: null, accessExpiresAt: Math.floor(Date.parse(actor.verifiedUntil) / 1000),
        ...(actor.verifiedLogin ? { verifiedLogin: actor.verifiedLogin } : {}) };
      const staffId = c.req.param("staffId");
      if (method === "get") {
        const token = await csrfToken(c.env, principal);
        const state = await readStaffOperationsAccess(c.env.OPS_DB, session, actor, staffId);
        if (Date.now() >= Date.parse(actor.verifiedUntil)) return json({ error: "staff_operations_access_denied" }, 403);
        return json({ ...state, csrfToken: token, verifiedUntil: actor.verifiedUntil });
      }
      await requireMutationSecurity(request, c.env, principal);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? ""))
        return json({ error: "staff_operations_access_invalid" }, 400);
      const command = commandSnapshot(await readBoundedJson(request, 4096, "Operations access"));
      const audit = await auditStatement(c.env, request, principal,
        command.operation === "grant" ? "staff.operations_access.granted" : "staff.operations_access.revoked", "staff", staffId, null,
        { commandId: command.commandId, permission: command.permission, operation: command.operation,
          expectedRevision: command.expectedRevision, expectedAdmissionVersion: command.expectedAdmissionVersion, reason: command.reason });
      return json({ receipt: await changeStaffOperationsAccess(c.env.OPS_DB, session, actor, staffId, command, audit) });
    } catch (error) {
      if (error instanceof StaffOperationsAccessError)
        return json(error.reason ? { error: error.code, reason: error.reason } : { error: error.code }, error.status);
      if (error instanceof Error && error.message === "native_staff_access_denied") return json({ error: "staff_operations_access_denied" }, 403);
      if (error instanceof HTTPException && [400, 403, 413].includes(error.status))
        return json({ error: error.status === 403 ? "staff_operations_access_denied" : "staff_operations_access_invalid" }, error.status);
      return json({ error: "staff_operations_access_unavailable" }, 503);
    }
  });
}
