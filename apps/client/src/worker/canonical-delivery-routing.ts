import { configuredClientPortalOrigin, configuredClientPortalOrigins, configuredPublicRequestOrigins, configuredPublicShareOrigin, requestHostAllowed } from "./origin-policy.ts";
import { canonicalDomainNavigationRedirect } from "../../../../packages/shared/src/canonical-domain-navigation.ts";
import type { Env } from "./types";

type RoutingEnv = Pick<Env, "ENVIRONMENT" | "EXPECTED_HOST" | "PUBLIC_BASE_URL" | "PUBLIC_SHARE_ORIGIN"
  | "CLIENT_PORTAL_ORIGIN" | "CLIENT_PORTAL_ORIGINS" | "LEGACY_CLIENT_ORIGINS" | "CLIENT_PORTAL_RETIRED_ORIGINS">;
const TARGET = "https://delivery.ledgetop.app";
const SOURCES = new Set(["https://portal.ledgetopdroneservices.com", "https://client.ledgetopdroneservices.com", "https://client.ledgetoptechnologies.com"]);
// Callback capabilities belong to their original route. Move only page filters.
const PRESENTATION_QUERY_KEYS = new Set([
  "folder", "view", "q", "search", "sort", "order", "page", "limit", "cursor", "prefix",
]);

/** Mounted behind the default-off browser navigation control. Enable only after new-host public acceptance.
 * Redirect only a fresh browser page entry. Cookies, API calls, ranges and
 * capabilities continue at their original origin. No credentials are copied.
 * Location deliberately has no fragment: browsers inherit the original link
 * fragment, which never reaches the Worker. Browser acceptance is still required.
 */
export function canonicalDeliveryEntryRedirect(request: Request, env: RoutingEnv, enabled: unknown = false): Response | null {
  if (enabled !== true || env.ENVIRONMENT !== "production" || !["GET", "HEAD"].includes(request.method)
    || request.url.length > 16_384 || configuredPublicShareOrigin(env) !== TARGET) return null;
  // Conservatively retain any browser with cookies; parsing only one cookie
  // would miss delegated and bulk-download resumptions or future session names.
  if (["Cookie", "Authorization", "Range", "If-Range", "Origin"].some(name => request.headers.has(name))) return null;
  if (request.headers.get("Sec-Fetch-Dest") !== "document"
    || request.headers.get("Sec-Fetch-Mode") !== "navigate") return null;
  let source: URL;
  try { source = new URL(request.url); } catch { return null; }
  if (source.username || source.password || !SOURCES.has(source.origin)
    || !configuredPublicRequestOrigins(env)?.includes(source.origin)
    || !/^\/(?:s|client-share)\/[A-Za-z0-9_-]{1,128}$/.test(source.pathname)) return null;
  for (const key of source.searchParams.keys())
    if (!PRESENTATION_QUERY_KEYS.has(key.toLowerCase())) return null;
  const target = new URL(TARGET);
  target.pathname = source.pathname;
  target.search = source.search;
  return new Response(null, { status: 302, headers: {
    Location: target.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  } });
}

/** Redirects presentation pages only after both origins pass existing host
 * admission. Old private-page cookies are not transferred to the target: its
 * existing Access policy authenticates that navigation independently. Public
 * delivery resumptions, signed capabilities, APIs and bytes stay on their host. */
export function canonicalClientNavigationRedirect(request: Request,
  env: RoutingEnv & { CANONICAL_BROWSER_NAVIGATION_ENABLED?: string }): Response | null {
  if (env.CANONICAL_BROWSER_NAVIGATION_ENABLED !== "true" || env.ENVIRONMENT !== "production") return null;
  const publicEntry = canonicalDeliveryEntryRedirect(request, env, true);
  if (publicEntry) return publicEntry;
  if (["Authorization", "Range", "If-Range", "Origin"].some(name => request.headers.has(name))
    || request.headers.get("Sec-Fetch-Dest") !== "document" || request.headers.get("Sec-Fetch-Mode") !== "navigate"
    || configuredClientPortalOrigin(env) !== "https://portal.ledgetop.app"
    || !configuredClientPortalOrigins(env)?.includes("https://portal.ledgetop.app")
    || !requestHostAllowed(request.url, env)
    || !requestHostAllowed("https://portal.ledgetop.app/portal", env)) return null;
  return canonicalDomainNavigationRedirect(request, { enabled: true, surface: "portal" });
}
