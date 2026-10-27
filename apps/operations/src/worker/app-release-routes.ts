import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { configuredDeploymentOrigin } from "@ltds/shared/configured-deployment-origin";
import {
  AppReleaseFeedError,
  legacyWindowsAppOffer,
  nativeWindowsAppOffer,
  readLatestAppRelease,
  readAppReleaseVersion,
  serveAppReleaseBytes,
  type AppReleaseCatalogRow,
} from "@ltds/shared/app-release-feed";
import { assertCurrentStaffLogin, type StaffLoginProof } from "./staff-login-bindings";
import type { Env, StaffPrincipal } from "./types";

type Bindings = { Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } };
type FeedMode = "native" | "legacy";

function failure(status: number, code: string, head = false): Response {
  const body = JSON.stringify({ error: code });
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(new TextEncoder().encode(body).byteLength),
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(head ? null : body, { status, headers });
}

function json(value: unknown, head: boolean): Response {
  const body = JSON.stringify(value);
  return new Response(head ? null : body, { status: 200, headers: {
    "Cache-Control": "private, no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(new TextEncoder().encode(body).byteLength),
    "X-Content-Type-Options": "nosniff",
  } });
}

function exactCanonicalOrigin(request: Request, env: Env): boolean {
  if (env.ENVIRONMENT !== "staging") return false;
  const origin = configuredDeploymentOrigin({
    environment: env.ENVIRONMENT ?? "",
    origin: env.PUBLIC_BASE_URL,
    expectedHost: env.EXPECTED_HOST,
  });
  return origin !== null && new URL(request.url).origin === origin;
}

function parseLatestQuery(url: URL): FeedMode | null {
  const query = [...url.searchParams.entries()];
  if (query.length === 1 && query[0]?.[0] === "platform" && query[0]?.[1] !== undefined
    && new Set(["windows", "macos", "linux"]).has(query[0][1])) return "legacy";
  if (query.length === 3 && query[0]?.[0] === "platform" && query[0]?.[1] === "windows"
    && query[1]?.[0] === "channel" && query[1]?.[1] === "pilot"
    && query[2]?.[0] === "schemaVersion" && query[2]?.[1] === "1") return "native";
  return null;
}

function exactDownloadQuery(url: URL): boolean {
  return url.search === "" || url.search === "?platform=windows&channel=pilot";
}

async function requireCurrentOwner(env: Env, principal: StaffPrincipal, now = Date.now()): Promise<void> {
  if (!Number.isSafeInteger(principal.accessExpiresAt) || (principal.accessExpiresAt ?? 0) <= Math.floor(now / 1000))
    throw new HTTPException(401, { message: "app_release_login_required" });
  const proof = principal.verifiedLogin as StaffLoginProof | undefined;
  if (proof && !await assertCurrentStaffLogin(env.OPS_DB, proof, Math.floor(now / 1000)))
    throw new HTTPException(403, { message: "app_release_access_denied" });
  const row = await env.OPS_DB.withSession("first-primary").prepare(`
    SELECT 1 ok FROM staff_users s JOIN staff_role_assignments r ON r.staff_id=s.id
    WHERE s.id=? AND s.access_subject=? AND s.status='active'
      AND r.role_id='role-owner' AND r.scope='global' LIMIT 1`)
    .bind(principal.id, principal.accessSubject).first<number>("ok");
  if (row !== 1) throw new HTTPException(403, { message: "app_release_access_denied" });
}

async function eligible(env: Env, principalId: string): Promise<boolean> {
  let row: { eligibility_id: string; cohort_revision: number } | null;
  try {
    row = await env.OPS_DB.withSession("first-primary").prepare(`
      SELECT e.eligibility_id,e.cohort_revision FROM app_release_pilot_eligibilities e
      JOIN staff_users s ON s.id=e.principal_id AND s.status='active'
      JOIN staff_role_assignments r ON r.staff_id=s.id AND r.role_id='role-owner' AND r.scope='global'
      WHERE e.principal_id=? AND e.channel='pilot'
        AND NOT EXISTS(SELECT 1 FROM app_release_pilot_revocations x WHERE x.eligibility_id=e.eligibility_id)
      LIMIT 2`).bind(principalId).first<{ eligibility_id: string; cohort_revision: number }>();
  } catch { throw new AppReleaseFeedError(503, "app_release_eligibility_unavailable"); }
  if (!row || typeof row.eligibility_id !== "string" || !Number.isSafeInteger(row.cohort_revision) || row.cohort_revision < 1) return false;
  return true;
}

function noOffer(mode: FeedMode): Record<string, unknown> {
  return mode === "native" ? { schemaVersion: 1, available: false } : { available: false };
}

function routeError(error: unknown, head: boolean): Response {
  if (error instanceof AppReleaseFeedError) return failure(error.status, error.code, head);
  if (error instanceof HTTPException) return failure(error.status, error.message || "app_release_unavailable", head);
  return failure(503, "app_release_unavailable", head);
}

export function registerOperationsAppReleaseRoutes(app: Hono<Bindings>): void {
  const routes = new Hono<Bindings>();
  routes.onError((error, c) => routeError(error, c.req.method === "HEAD"));

  routes.on(["GET", "HEAD"], "/latest", async c => {
    const head = c.req.method === "HEAD";
    if (!exactCanonicalOrigin(c.req.raw, c.env)) return failure(404, "app_release_unavailable", head);
    const url = new URL(c.req.url);
    const mode = parseLatestQuery(url);
    if (!mode) return failure(400, "app_release_query_invalid", head);
    const principal = c.get("principal");
    try {
      await requireCurrentOwner(c.env, principal);
      if (!await eligible(c.env, principal.id)) return json(noOffer(mode), head);
      if (mode === "legacy" && url.searchParams.get("platform") !== "windows") return json(noOffer(mode), head);
      const release = await readLatestAppRelease(c.env.OPS_DB, c.env.APP_RELEASE_BUCKET);
      await requireCurrentOwner(c.env, principal);
      if (!await eligible(c.env, principal.id)) return json(noOffer(mode), head);
      if (!release) return json(noOffer(mode), head);
      return json(mode === "native" ? nativeWindowsAppOffer(release, "/api/app") : legacyWindowsAppOffer(release, "/api/app"), head);
    } catch (error) { return routeError(error, head); }
  });

  routes.on(["GET", "HEAD"], "/download/:version", async c => {
    const head = c.req.method === "HEAD";
    if (!exactCanonicalOrigin(c.req.raw, c.env)) return failure(404, "app_release_unavailable", head);
    if (!exactDownloadQuery(new URL(c.req.url))) return failure(400, "app_release_query_invalid", head);
    const principal = c.get("principal");
    try {
      await requireCurrentOwner(c.env, principal);
      if (!await eligible(c.env, principal.id)) throw new AppReleaseFeedError(404, "app_release_unavailable");
      const release = await readAppReleaseVersion(c.env.OPS_DB, c.env.APP_RELEASE_BUCKET, c.req.param("version"));
      await requireCurrentOwner(c.env, principal);
      if (!await eligible(c.env, principal.id)) throw new AppReleaseFeedError(404, "app_release_unavailable");
      const response = await serveAppReleaseBytes(c.req.raw, c.env.APP_RELEASE_BUCKET, release);
      await requireCurrentOwner(c.env, principal);
      if (!await eligible(c.env, principal.id)) {
        await response.body?.cancel();
        throw new AppReleaseFeedError(404, "app_release_unavailable");
      }
      return response;
    } catch (error) { return routeError(error, head); }
  });

  app.route("/api/app", routes);
}
