import { createRemoteJWKSet, jwtVerify } from "jose";
import { HTTPException } from "hono/http-exception";
import type { Env, StaffPrincipal } from "./types";

interface AccessClaims {
  sub?: unknown;
  email?: unknown;
  type?: unknown;
  exp?: unknown;
  common_name?: unknown;
  service_token_status?: unknown;
}

export interface VerifiedStaffIdentity {
  principal: StaffPrincipal;
  expiresAt: number;
}

async function verifyAccessClaims(request: Request, env: Env): Promise<AccessClaims> {
  if (!env.TEAM_DOMAIN || !env.OPERATIONS_AUD || env.OPERATIONS_AUD.startsWith("REPLACE_")) throw new HTTPException(503, { message: "Cloudflare Access is not configured for Operations" });
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) throw new HTTPException(401, { message: "Cloudflare Access authentication required" });
  try {
    const issuer = env.TEAM_DOMAIN.replace(/\/$/, "");
    const verified = await jwtVerify(assertion, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)), { issuer, audience: env.OPERATIONS_AUD, algorithms: ["RS256"] });
    return verified.payload;
  } catch {
    throw new HTTPException(401, { message: "Invalid Cloudflare Access authentication" });
  }
}

function isHumanAccessIdentity(claims: AccessClaims): claims is AccessClaims & { sub: string; email: string; exp: number } {
  return claims.type === "app" && typeof claims.sub === "string" && !!claims.sub.trim() &&
    typeof claims.email === "string" && claims.email.trim().length > 0 &&
    typeof claims.exp === "number" && Number.isSafeInteger(claims.exp) && claims.exp > Math.floor(Date.now() / 1000) &&
    claims.common_name === undefined && claims.service_token_status !== true;
}

/** Once the reviewed native cohort is activated, a historical active bridge is
 * insufficient admission. Missing additive schema preserves the pre-cutover
 * reader only; malformed state or database failures never become admission. */
async function requireNativeAdmissionAfterCutover(db: D1DatabaseSession, staffId: string, email: string, subject: string): Promise<void> {
  let state: { enabled: number } | null;
  try { state = await db.prepare("SELECT enabled FROM native_staff_access_reconciliation WHERE singleton=1").first<{ enabled: number }>(); }
  catch (error) {
    if (error instanceof Error && error.message.includes("no such table: native_staff_access_reconciliation")) return;
    throw new HTTPException(503, { message: "Operations staff admission is unavailable" });
  }
  if (state?.enabled === 0) return;
  if (state?.enabled !== 1) throw new HTTPException(503, { message: "Operations staff admission is unavailable" });
  const admitted = await db.prepare(`SELECT 1 ok FROM native_staff_admissions a JOIN native_staff_profiles p ON p.staff_id=a.staff_id
    JOIN staff_users s ON s.id=a.staff_id WHERE a.staff_id=? AND a.active=1 AND a.bound_access_subject=?
      AND p.login_email=? COLLATE BINARY AND s.email=p.login_email COLLATE BINARY
      AND s.access_subject=a.bound_access_subject AND s.status='active'`).bind(staffId, subject, email).first("ok");
  if (admitted !== 1) throw new HTTPException(403, { message: "This Operations staff account is not currently admitted" });
}

async function activeStaffForIdentity(env: Env, claims: AccessClaims & { sub: string; email: string }): Promise<StaffPrincipal> {
  const email = claims.email.trim().toLowerCase(); const subject = claims.sub.trim();
  const db = env.OPS_DB.withSession("first-primary");
  const user = await db.prepare("SELECT id,email,display_name,access_subject,project_alpha_user_id FROM staff_users WHERE email=? AND status='active'").bind(email).first<{ id: string; email: string; display_name: string; access_subject: string | null; project_alpha_user_id: string | null }>();
  if (!user) throw new HTTPException(403, { message: "This email is not set up for Ledge Top. Sign in with your Operations staff email or contact your administrator." });
  if (user.access_subject && user.access_subject !== subject) throw new HTTPException(403, { message: "This staff account is bound to a different Access identity" });
  await requireNativeAdmissionAfterCutover(db, user.id, email, subject);
  if (!user.access_subject) {
    try { await env.OPS_DB.prepare("UPDATE staff_users SET access_subject=?,last_seen_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND access_subject IS NULL").bind(subject, user.id).run(); }
    catch { throw new HTTPException(403, { message: "This Access identity is already assigned to another staff account" }); }
  } else await env.OPS_DB.prepare("UPDATE staff_users SET last_seen_at=datetime('now') WHERE id=?").bind(user.id).run();
  return { id: user.id, email: user.email, displayName: user.display_name, accessSubject: subject, projectAlphaUserId: user.project_alpha_user_id };
}

export async function authenticateStaff(request: Request, env: Env): Promise<StaffPrincipal> {
  const claims = await verifyAccessClaims(request, env);
  if (claims.type !== "app" || typeof claims.sub !== "string" || !claims.sub.trim() || typeof claims.email !== "string") {
    throw new HTTPException(401, { message: "A human Cloudflare Access identity is required" });
  }
  const principal = await activeStaffForIdentity(env, claims as AccessClaims & { sub: string; email: string });
  if (typeof claims.exp === "number" && Number.isSafeInteger(claims.exp)) principal.accessExpiresAt = claims.exp;
  return principal;
}

/** Verify a Viewer background-renewal caller without auto-provisioning or rebinding staff. */
export async function authenticateBoundStaffForViewerRenewal(request: Request, env: Env): Promise<VerifiedStaffIdentity> {
  const claims = await verifyAccessClaims(request, env);
  if (!isHumanAccessIdentity(claims)) throw new HTTPException(401, { message: "A current human Cloudflare Access identity is required" });
  const email = claims.email.trim().toLowerCase();
  const subject = claims.sub.trim();
  const db = env.OPS_DB.withSession("first-primary");
  const user = await db.prepare("SELECT id,email,display_name,access_subject,project_alpha_user_id FROM staff_users WHERE email=? AND status='active'")
    .bind(email).first<{ id: string; email: string; display_name: string; access_subject: string | null; project_alpha_user_id: string | null }>();
  // Renewal must never trigger authenticateStaff's normal first-login subject
  // binding behavior. Require the existing immutable binding before updating
  // last-seen metadata or issuing any Viewer grant.
  if (!user || !user.access_subject || user.access_subject !== subject)
    throw new HTTPException(403, { message: "This Operations staff account is not bound to the current Access identity" });
  await requireNativeAdmissionAfterCutover(db, user.id, email, subject);
  await env.OPS_DB.prepare("UPDATE staff_users SET last_seen_at=datetime('now') WHERE id=? AND access_subject=?")
    .bind(user.id, subject).run();
  const principal: StaffPrincipal = {
    id: user.id, email: user.email, displayName: user.display_name,
    accessSubject: subject, projectAlphaUserId: user.project_alpha_user_id,
  };
  principal.accessExpiresAt = claims.exp;
  return { principal, expiresAt: claims.exp };
}
