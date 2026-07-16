import { createRemoteJWKSet, jwtVerify } from "jose";
import { constantTimeEqual, sha256 } from "./crypto";
import { HttpError } from "./http";
import type { Env, IntegrationPrincipal, StaffPrincipal } from "./types";

export async function authenticateStaff(request: Request, env: Env): Promise<StaffPrincipal> {
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) {
    throw new HttpError(503, "Cloudflare Access is not configured");
  }
  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion) throw new HttpError(401, "Cloudflare Access authentication required");

  let email: string;
  try {
    const jwks = createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN.replace(/\/$/, "")}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(assertion, jwks, {
      issuer: env.TEAM_DOMAIN.replace(/\/$/, ""),
      audience: env.POLICY_AUD,
    });
    if (typeof payload.email !== "string") throw new Error("JWT has no email claim");
    email = payload.email.trim().toLowerCase();
  } catch {
    throw new HttpError(401, "Invalid Cloudflare Access authentication");
  }

  let user = await env.DB.prepare(
    "SELECT id, email, display_name, role FROM staff_users WHERE email = ? AND active = 1",
  ).bind(email).first<{ id: string; email: string; display_name: string | null; role: "admin" | "staff" }>();

  if (!user && env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() === email) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM staff_users").first<{ count: number }>();
    if ((count?.count || 0) === 0) {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO staff_users (id, email, display_name, role) VALUES (?, ?, ?, 'admin')",
      ).bind(id, email, email.split("@")[0] || "Administrator").run();
      user = { id, email, display_name: email.split("@")[0] || null, role: "admin" };
    }
  }

  if (!user) throw new HttpError(403, "Your authenticated email is not an active staff account");
  await env.DB.prepare("UPDATE staff_users SET last_seen_at = datetime('now') WHERE id = ?").bind(user.id).run();
  return { type: "staff", id: user.id, email: user.email, displayName: user.display_name, role: user.role };
}

export async function authenticateIntegration(request: Request, env: Env): Promise<IntegrationPrincipal> {
  const authorization = request.headers.get("authorization") || "";
  const [scheme, key] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !key?.startsWith("ltds_")) {
    throw new HttpError(401, "A valid integration API key is required");
  }
  const keyHash = await sha256(key);
  const record = await env.DB.prepare(
    "SELECT id, name, key_hash, scopes FROM api_keys WHERE key_hash = ? AND active = 1",
  ).bind(keyHash).first<{ id: string; name: string; key_hash: string; scopes: string }>();
  if (!record || !constantTimeEqual(record.key_hash, keyHash)) throw new HttpError(401, "Invalid API key");
  await env.DB.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").bind(record.id).run();
  return { type: "integration", id: record.id, name: record.name, scopes: record.scopes.split(" ").filter(Boolean) };
}

export function requireAdmin(principal: StaffPrincipal): void {
  if (principal.role !== "admin") throw new HttpError(403, "Administrator access required");
}

export function requireScope(principal: IntegrationPrincipal, scope: string): void {
  if (!principal.scopes.includes(scope)) throw new HttpError(403, `API key requires the ${scope} scope`);
}
