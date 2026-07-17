import { HTTPException } from "hono/http-exception";
import { hmac, timingSafeEqual } from "./crypto";
import type { Env, StaffPrincipal } from "./types";

const WINDOW_MS = 12 * 60 * 60 * 1000;
export async function csrfToken(env: Env, principal: StaffPrincipal, bucket = Math.floor(Date.now() / WINDOW_MS)): Promise<string> { return hmac(env.OPERATIONS_SESSION_SECRET, `csrf:${principal.accessSubject}:${bucket}`); }

export async function requireMutationSecurity(request: Request, env: Env, principal: StaffPrincipal): Promise<void> {
  const expectedOrigin = new URL(env.PUBLIC_BASE_URL).origin;
  if (request.headers.get("Origin") !== expectedOrigin) throw new HTTPException(403, { message: "Request origin was rejected" });
  const supplied = request.headers.get("X-CSRF-Token") || ""; const current = Math.floor(Date.now() / WINDOW_MS);
  const valid = timingSafeEqual(supplied, await csrfToken(env, principal, current)) || timingSafeEqual(supplied, await csrfToken(env, principal, current - 1));
  if (!valid) throw new HTTPException(403, { message: "CSRF validation failed" });
}

export async function auditAddress(env: Env, request: Request): Promise<string> { return hmac(env.AUDIT_IP_SECRET, request.headers.get("CF-Connecting-IP") || "unknown"); }

export function auditStatement(env: Env, request: Request, principal: StaffPrincipal, action: string, entityType: string, entityId: string, divisionId: string | null, details?: unknown): Promise<D1PreparedStatement> {
  return auditAddress(env, request).then(address => env.OPS_DB.prepare(`INSERT INTO audit_events (actor_type,actor_id,actor_email,actor_display_name,action,entity_type,entity_id,division_id,details_json,client_address_hash) VALUES ('staff',?,?,?,?,?,?,?,?,?)`).bind(principal.id, principal.email, principal.displayName, action, entityType, entityId, divisionId, details ? JSON.stringify(details) : null, address));
}
