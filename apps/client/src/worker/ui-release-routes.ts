import { fetchUiReleaseAsset, fetchUiReleaseShell } from "../../../../packages/shared/src/ui-release-assets";
import { findUiReleaseManifest, uiReleaseForRequest } from "../../../../packages/shared/src/ui-release-catalog";
import { clientUiReleaseOriginAllowed } from "./origin-policy";
import type { Env } from "./types";

export function clientUiReleaseFailure(status: 404 | 503): Response {
  return new Response(null, { status, headers: {
    "Cache-Control": "no-store", "Cloudflare-CDN-Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow",
  } });
}

/** Mounted only after the existing global request-origin/security middleware.
 * Release availability is independent of the active HTML selector for rollback. */
export async function serveClientUiReleaseAsset(request: Request, env: Env): Promise<Response> {
  if (!clientUiReleaseOriginAllowed(request.url, env)) return clientUiReleaseFailure(404);
  const manifest = uiReleaseForRequest("client", request.url);
  if (!manifest) return clientUiReleaseFailure(404);
  if (!env.UI_RELEASE_ASSETS) return clientUiReleaseFailure(503);
  return fetchUiReleaseAsset(request, env.UI_RELEASE_ASSETS, manifest);
}

/** Null means preserve the original shell. Never use this for public bearer,
 * invitation, API, enrollment, owner or session routes. */
export async function selectedClientUiReleaseShell(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if ((path !== "/portal" && !path.startsWith("/portal/")) || !clientUiReleaseOriginAllowed(request.url, env)) return null;
  if (env.UI_ACTIVE_RELEASE === undefined || env.UI_ACTIVE_RELEASE === "") return null;
  const manifest = findUiReleaseManifest("client", env.UI_ACTIVE_RELEASE);
  if (!manifest || !env.UI_RELEASE_ASSETS) return clientUiReleaseFailure(503);
  return fetchUiReleaseShell(request, env.UI_RELEASE_ASSETS, manifest);
}
