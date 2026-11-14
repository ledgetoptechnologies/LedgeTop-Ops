// Logs directory for the local (NAS) Logs host: exactly four read-only lookups, reached over HTTPS through
// Cloudflare Access with the NAS's own service token, and mounted before the staff middleware.
//
//   POST /api/internal/logs-directory/v1/resolve-pilot    { username } -> { pilot: { staffId, eligibilityRevision } | null }
//   POST /api/internal/logs-directory/v1/pilot-authority  { staffId }  -> { eligible: true, revision } | { eligible: false }
//   POST /api/internal/logs-directory/v1/staff-active     { staffId }  -> { active }   (legacy device-eligibility alias)
//   POST /api/internal/logs-directory/v1/staff-authority  { staffId }  -> { active, canViewAll, canImport, administrator }
//
// staff-authority is the explicit, versioned fourth scope (Merger decision): current canonical status and ACL only,
// never names, emails, roles, other permissions or any list. Every answer is computed fresh; nothing is cached.
// The caller must present a valid Access service-token assertion for this app (issuer, single audience, type 'app',
// empty sub, no email) whose client id is the one configured for the Logs directory. Everything else is a 404.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { getPilotDeviceAuthority, isActiveStaff, resolvePilotUsername } from "./staff-directory-lookup";
import { isAdministrator, permissionKeys } from "./acl";
import type { Env, StaffPrincipal } from "./types";

export const LOGS_DIRECTORY_PREFIX = "/api/internal/logs-directory/v1/";
const METHODS = new Set(["resolve-pilot", "pilot-authority", "staff-active", "staff-authority"]);
const STAFF_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_BODY = 4096;
const PER_MINUTE = 120;

export type LogsDirectoryEnv = Pick<Env, "OPS_DB" | "ENVIRONMENT"> & {
  TEAM_DOMAIN?: string;
  FLIGHT_LOGS_ENABLED?: string;
  LOGS_DIRECTORY_ENABLED?: string;
  LOGS_DIRECTORY_HOST?: string;
  LOGS_DIRECTORY_AUD?: string;
  LOGS_DIRECTORY_CLIENT_ID?: string;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
const notFound = () => json({ error: "Not found" }, 404);

/** Per-isolate request budget for the one machine identity (defence in depth; Access already admits only it). */
const windows = new Map<number, number>();
function withinBudget(now = Date.now()): boolean {
  const minute = Math.floor(now / 60_000);
  for (const key of windows.keys()) if (key < minute) windows.delete(key);
  const used = windows.get(minute) ?? 0;
  if (used >= PER_MINUTE) return false;
  windows.set(minute, used + 1);
  return true;
}

function canonicalIssuer(value: string | undefined): string | null {
  let issuer: URL;
  try { issuer = new URL(value ?? ""); } catch { return null; }
  if (issuer.protocol !== "https:" || !issuer.hostname.endsWith(".cloudflareaccess.com") || issuer.hostname === ".cloudflareaccess.com"
    || issuer.origin !== value?.replace(/\/$/, "") || issuer.username || issuer.password || issuer.port
    || issuer.pathname !== "/" || issuer.search || issuer.hash) return null;
  return issuer.origin;
}

/** The same service-token claim rules as the reviewed agent verifier, for this app's own audience and client id. */
export async function verifyDirectoryService(request: Request, env: LogsDirectoryEnv, keyResolver?: JWTVerifyGetKey): Promise<boolean> {
  const issuer = canonicalIssuer(env.TEAM_DOMAIN);
  const audience = env.LOGS_DIRECTORY_AUD ?? "";
  const clientId = env.LOGS_DIRECTORY_CLIENT_ID ?? "";
  if (!issuer || !/^[A-Za-z0-9_-]{16,128}$/.test(audience) || !/^[A-Za-z0-9._-]{8,256}$/.test(clientId)) return false;
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion || assertion.length > 16384 || /\s/.test(assertion)) return false;
  try {
    const { payload } = await jwtVerify(assertion, keyResolver ?? createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer)),
      { issuer, audience, algorithms: ["RS256"] });
    const audiences = typeof payload.aud === "string" ? [payload.aud] : payload.aud;
    const now = Math.floor(Date.now() / 1000);
    return Array.isArray(audiences) && audiences.length === 1 && audiences[0] === audience
      && payload.type === "app" && payload.sub === "" && !Object.hasOwn(payload, "email")
      && payload.common_name === clientId
      && Number.isSafeInteger(payload.iat) && Number.isSafeInteger(payload.exp)
      && payload.iat! >= 0 && payload.iat! <= now && payload.exp! > now && payload.iat! < payload.exp!;
  } catch { return false; }
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/** Fresh, minimal authority for a sensitive Logs write. */
export async function staffAuthority(env: LogsDirectoryEnv, staffId: string) {
  const staff = await env.OPS_DB.prepare("SELECT id FROM staff_users WHERE id = ? AND status = 'active'").bind(staffId).first();
  if (!staff) return { active: false, canViewAll: false, canImport: false, administrator: false };
  const principal = { id: staffId } as StaffPrincipal;
  const permissions = await permissionKeys(env as Env, principal);
  const canImport = permissions.includes("flight_logs.import" as never);
  return {
    active: true,
    // In Logs, the import permission is what widens the view to every pilot's flights.
    canViewAll: canImport,
    canImport,
    administrator: await isAdministrator(env as Env, principal),
  };
}

/** Returns a Response for this prefix, or null when the path is not ours. */
export async function handleLogsDirectory(request: Request, env: LogsDirectoryEnv, dependencies: { keyResolver?: JWTVerifyGetKey } = {}): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(LOGS_DIRECTORY_PREFIX)) return null;
  const method = url.pathname.slice(LOGS_DIRECTORY_PREFIX.length);
  const enabled = env.LOGS_DIRECTORY_ENABLED === "true" && (env.ENVIRONMENT !== "staging" || env.FLIGHT_LOGS_ENABLED === "true");
  if (!enabled || url.protocol !== "https:" || !env.LOGS_DIRECTORY_HOST || url.host !== env.LOGS_DIRECTORY_HOST
    || request.method !== "POST" || !METHODS.has(method) || url.search) return notFound();
  if (!(await verifyDirectoryService(request, env, dependencies.keyResolver))) return notFound();
  if (!withinBudget()) return json({ error: "Rate limited" }, 429);
  const body = await readBody(request);
  if (!body) return json({ error: "Bad request" }, 400);
  if (method === "resolve-pilot") {
    if (Object.keys(body).join() !== "username") return json({ error: "Bad request" }, 400);
    // Unknown and ineligible usernames get the same answer shape.
    return json({ pilot: await resolvePilotUsername(env.OPS_DB as D1Database, body.username) });
  }
  if (Object.keys(body).join() !== "staffId" || typeof body.staffId !== "string" || !STAFF_ID.test(body.staffId)) return json({ error: "Bad request" }, 400);
  const staffId = body.staffId;
  if (method === "pilot-authority") {
    const authority = await getPilotDeviceAuthority(env.OPS_DB as D1Database, staffId);
    return json(authority.eligible ? { eligible: true, revision: authority.revision } : { eligible: false });
  }
  if (method === "staff-active") return json({ active: await isActiveStaff(env.OPS_DB as D1Database, staffId) });
  return json(await staffAuthority(env, staffId));
}
