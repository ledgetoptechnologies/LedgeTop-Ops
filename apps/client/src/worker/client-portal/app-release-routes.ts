import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { AppReleaseFeedError, legacyWindowsAppOffer, nativeWindowsAppOffer,
  readLatestAppRelease, readAppReleaseVersion, serveAppReleaseBytes } from "@ltds/shared/app-release-feed";
import { configuredClientPortalOrigin } from "../origin-policy";
import { portalIdentityAccepted, authorizePortalWorkspaceCapability } from "./workspace-v2";
import type { Env } from "../types";
import type { VerifiedClientPrincipal } from "./types";

type Bindings = { Bindings: Env; Variables: { clientPrincipal: VerifiedClientPrincipal } };
type FeedMode = "native" | "legacy";
type EligibilityRow = { eligibility_id: string; cohort_revision: number; workspace_id: string; folder_binding_id: string };

function failure(status: number, code: string, head = false): Response {
  const body = JSON.stringify({ error: code });
  return new Response(head ? null : body, { status, headers: {
    "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8", "Content-Length": String(new TextEncoder().encode(body).byteLength),
    "X-Content-Type-Options": "nosniff",
  } });
}
function json(value: unknown, head: boolean): Response {
  const body = JSON.stringify(value);
  return new Response(head ? null : body, { status: 200, headers: {
    "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8", "Content-Length": String(new TextEncoder().encode(body).byteLength),
    "X-Content-Type-Options": "nosniff",
  } });
}
function exactCanonicalOrigin(request: Request, env: Env): boolean {
  const canonical = configuredClientPortalOrigin(env);
  return canonical !== null && new URL(request.url).origin === canonical;
}
function parseLatestQuery(url: URL): FeedMode | null {
  const query = [...url.searchParams.entries()];
  if (query.length === 1 && query[0]?.[0] === "platform" && new Set(["windows", "macos", "linux"]).has(query[0]?.[1] ?? ""))
    return "legacy";
  if (query.length === 3 && query[0]?.[0] === "platform" && query[0]?.[1] === "windows"
    && query[1]?.[0] === "channel" && query[1]?.[1] === "pilot"
    && query[2]?.[0] === "schemaVersion" && query[2]?.[1] === "1") return "native";
  return null;
}
function exactDownloadQuery(url: URL): boolean {
  return url.search === "" || url.search === "?platform=windows&channel=pilot";
}
function noOffer(mode: FeedMode): Record<string, unknown> {
  return mode === "native" ? { schemaVersion: 1, available: false } : { available: false };
}
function routeError(error: unknown, head: boolean): Response {
  if (error instanceof AppReleaseFeedError) return failure(error.status, error.code, head);
  if (error instanceof HTTPException) return failure(error.status, error.message || "app_release_unavailable", head);
  return failure(503, "app_release_unavailable", head);
}

async function pilotEligible(env: Env, principal: VerifiedClientPrincipal): Promise<boolean> {
  if (!await portalIdentityAccepted(env, principal)) return false;
  let rows: EligibilityRow[];
  try {
    rows = (await env.DELIVERY_DB.withSession("first-primary").prepare(`
      SELECT e.eligibility_id,e.cohort_revision,e.workspace_id,g.folder_binding_id
      FROM app_release_pilot_eligibilities e
      JOIN portal_v2_identities i ON i.id=e.identity_id AND i.status='active' AND i.revoked_at IS NULL
      JOIN portal_v2_workspace_memberships m ON m.workspace_id=e.workspace_id AND m.identity_id=i.id
        AND m.status='active' AND m.revoked_at IS NULL
        AND (m.expires_at IS NULL OR datetime(m.expires_at)>datetime('now'))
      JOIN portal_v2_workspaces w ON w.id=e.workspace_id AND w.status='active'
      JOIN pa_portal_principals p ON p.workspace_id=e.workspace_id AND p.public_id=e.principal_public_id
        AND p.status='active' AND p.source_version=e.principal_source_version
        AND (p.identity_id IS NULL OR p.identity_id=i.id)
      JOIN portal_v2_authenticated_delivery_grants g ON g.id=e.grant_id AND g.workspace_id=e.workspace_id
        AND g.grant_version=e.grant_version AND g.status='active' AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR datetime(g.expires_at)>datetime('now'))
      JOIN portal_v2_folder_bindings b ON b.id=g.folder_binding_id AND b.workspace_id=g.workspace_id
        AND b.status='active' AND b.revoked_at IS NULL AND b.source_version=g.binding_source_version
      JOIN portal_v2_authenticated_delivery_grant_recipients r ON r.grant_id=g.id AND r.workspace_id=g.workspace_id
        AND r.identity_id=i.id AND r.principal_public_id=p.public_id AND r.principal_source_version=p.source_version
      WHERE i.issuer=? AND i.subject=? AND e.channel='pilot'
        AND NOT EXISTS(SELECT 1 FROM app_release_pilot_revocations x WHERE x.eligibility_id=e.eligibility_id)
      LIMIT 51`).bind(principal.issuer, principal.subject).all<EligibilityRow>()).results;
  } catch { throw new AppReleaseFeedError(503, "app_release_eligibility_unavailable"); }
  if (rows.length > 50 || rows.some(row => typeof row.eligibility_id !== "string" || !Number.isSafeInteger(row.cohort_revision)
    || !row.workspace_id || !row.folder_binding_id)) throw new AppReleaseFeedError(503, "app_release_eligibility_ambiguous");
  for (const row of rows) {
    if (await authorizePortalWorkspaceCapability(env, principal, row.workspace_id, "delivery.view",
      { scopeType: "folder", publicId: row.folder_binding_id })) return true;
  }
  return false;
}

export function createClientAppReleaseRouter(): Hono<Bindings> {
  const router = new Hono<Bindings>();
  router.onError((error, c) => routeError(error, c.req.method === "HEAD"));

  router.on(["GET", "HEAD"], "/latest", async c => {
    const head = c.req.method === "HEAD";
    if (c.env.ENVIRONMENT !== "staging" || !exactCanonicalOrigin(c.req.raw, c.env))
      return failure(404, "app_release_unavailable", head);
    const url = new URL(c.req.url);
    const mode = parseLatestQuery(url);
    if (!mode) return failure(400, "app_release_query_invalid", head);
    try {
      const principal = c.get("clientPrincipal");
      if (!await pilotEligible(c.env, principal)) return json(noOffer(mode), head);
      if (mode === "legacy" && url.searchParams.get("platform") !== "windows") return json(noOffer(mode), head);
      const release = await readLatestAppRelease(c.env.DELIVERY_DB, c.env.APP_RELEASE_BUCKET);
      if (!await pilotEligible(c.env, principal)) return json(noOffer(mode), head);
      if (!release) return json(noOffer(mode), head);
      const base = "/api/client/app";
      return json(mode === "native" ? nativeWindowsAppOffer(release, base) : legacyWindowsAppOffer(release, base), head);
    } catch (error) { return routeError(error, head); }
  });

  router.on(["GET", "HEAD"], "/download/:version", async c => {
    const head = c.req.method === "HEAD";
    if (c.env.ENVIRONMENT !== "staging" || !exactCanonicalOrigin(c.req.raw, c.env))
      return failure(404, "app_release_unavailable", head);
    if (!exactDownloadQuery(new URL(c.req.url))) return failure(400, "app_release_query_invalid", head);
    try {
      const principal = c.get("clientPrincipal");
      if (!await pilotEligible(c.env, principal)) throw new AppReleaseFeedError(404, "app_release_unavailable");
      const release = await readAppReleaseVersion(c.env.DELIVERY_DB, c.env.APP_RELEASE_BUCKET, c.req.param("version"));
      const response = await serveAppReleaseBytes(c.req.raw, c.env.APP_RELEASE_BUCKET, release, async () => {
        if (!await pilotEligible(c.env, principal)) throw new AppReleaseFeedError(404, "app_release_unavailable");
      });
      return response;
    } catch (error) { return routeError(error, head); }
  });
  return router;
}
