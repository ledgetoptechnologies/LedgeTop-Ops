import { createRemoteJWKSet, jwtVerify } from "jose";
import { HTTPException } from "hono/http-exception";
import type { Env, StaffPrincipal } from "./types";

interface AccessClaims {
  sub?: unknown;
  email?: unknown;
  type?: unknown;
}

export async function authenticateStaff(request: Request, env: Env): Promise<StaffPrincipal> {
  if (!env.TEAM_DOMAIN || !env.OPERATIONS_AUD || env.OPERATIONS_AUD.startsWith("REPLACE_")) throw new HTTPException(503, { message: "Cloudflare Access is not configured for Operations" });
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) throw new HTTPException(401, { message: "Cloudflare Access authentication required" });
  let claims: AccessClaims;
  try {
    const issuer = env.TEAM_DOMAIN.replace(/\/$/, "");
    const verified = await jwtVerify(assertion, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)), { issuer, audience: env.OPERATIONS_AUD, algorithms: ["RS256"] });
    claims = verified.payload;
  } catch {
    throw new HTTPException(401, { message: "Invalid Cloudflare Access authentication" });
  }
  if (claims.type !== "app" || typeof claims.sub !== "string" || !claims.sub.trim() || typeof claims.email !== "string") {
    throw new HTTPException(401, { message: "A human Cloudflare Access identity is required" });
  }
  const email = claims.email.trim().toLowerCase(); const subject = claims.sub.trim();
  const user = await env.OPS_DB.prepare("SELECT id,email,display_name,access_subject,project_alpha_user_id FROM staff_users WHERE email=? AND status='active'").bind(email).first<{ id: string; email: string; display_name: string; access_subject: string | null; project_alpha_user_id: string | null }>();
  if (!user) throw new HTTPException(403, { message: "Your Access identity is not provisioned for LTDS Operations" });
  if (user.access_subject && user.access_subject !== subject) throw new HTTPException(403, { message: "This staff account is bound to a different Access identity" });
  if (!user.access_subject) {
    try { await env.OPS_DB.prepare("UPDATE staff_users SET access_subject=?,last_seen_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND access_subject IS NULL").bind(subject, user.id).run(); }
    catch { throw new HTTPException(403, { message: "This Access identity is already assigned to another staff account" }); }
  } else await env.OPS_DB.prepare("UPDATE staff_users SET last_seen_at=datetime('now') WHERE id=?").bind(user.id).run();
  return { id: user.id, email: user.email, displayName: user.display_name, accessSubject: subject, projectAlphaUserId: user.project_alpha_user_id };
}
