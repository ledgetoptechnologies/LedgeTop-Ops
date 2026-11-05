import { canonicalDomainNavigationRedirect } from "../../../../packages/shared/src/canonical-domain-navigation";
import { requestHostAllowed } from "./host-admission";
import type { Env } from "./types";

const CANONICAL_OPERATIONS_ORIGIN = "https://ops.ledgetop.app";

export function canonicalOperationsNavigationRedirect(request: Request,
  env: Pick<Env, "ENVIRONMENT" | "EXPECTED_HOST" | "OPERATIONS_ORIGINS" | "PUBLIC_BASE_URL" | "LEGACY_OPERATIONS_REDIRECT_ORIGINS">): Response | null {
  // Retired hosts are redirect-only: they are intentionally absent from the
  // active OPERATIONS_ORIGINS used by API, CSRF and CORS admission.
  if (env.PUBLIC_BASE_URL !== CANONICAL_OPERATIONS_ORIGIN || env.EXPECTED_HOST !== "ops.ledgetop.app"
    || env.ENVIRONMENT !== "production"
    || ["Authorization", "Range", "If-Range", "Origin"].some(name => request.headers.has(name))
    || request.headers.get("Sec-Fetch-Dest") !== "document" || request.headers.get("Sec-Fetch-Mode") !== "navigate"
    || !requestHostAllowed(`${CANONICAL_OPERATIONS_ORIGIN}/`, env)) return null;
  let sourceOrigin: string;
  try { sourceOrigin = new URL(request.url).origin; } catch { return null; }
  const redirectOrigins = configuredLegacyOperationsRedirectOrigins(env);
  if (!redirectOrigins || !redirectOrigins.includes(sourceOrigin)) return null;
  return canonicalDomainNavigationRedirect(request, { enabled: true, surface: "operations" });
}

/** A short-lived OAuth callback may still return to the exact host stored in
 * its signed/encrypted pre-cutover state. No other legacy API is admitted. */
export function isLegacyOperationsDropboxCallback(request: Request,
  env: Pick<Env, "ENVIRONMENT" | "EXPECTED_HOST" | "PUBLIC_BASE_URL" | "LEGACY_OPERATIONS_REDIRECT_ORIGINS">): boolean {
  if (env.ENVIRONMENT !== "production" || env.PUBLIC_BASE_URL !== CANONICAL_OPERATIONS_ORIGIN
    || env.EXPECTED_HOST !== "ops.ledgetop.app" || request.method !== "GET") return false;
  let url: URL;
  try { url = new URL(request.url); } catch { return false; }
  const configured = configuredLegacyOperationsRedirectOrigins(env);
  return url.pathname === "/api/dropbox-import/oauth/callback"
    && !!configured?.includes(url.origin);
}

const LEGACY_OPERATIONS_ORIGINS = new Set([
  "https://ops.ledgetopdroneservices.com",
  "https://ops.ledgetoptechnologies.com",
]);

function configuredLegacyOperationsRedirectOrigins(
  env: Pick<Env, "LEGACY_OPERATIONS_REDIRECT_ORIGINS">,
): string[] | null {
  // Older installations already use the canonical primary host but have no
  // spare scalar slot for a redirect-only list. Preserve only these two exact
  // historical browser/callback routes; neither becomes an active API origin.
  // An explicitly empty list still disables this compatibility path.
  if (env.LEGACY_OPERATIONS_REDIRECT_ORIGINS === undefined) return [...LEGACY_OPERATIONS_ORIGINS];
  if (!env.LEGACY_OPERATIONS_REDIRECT_ORIGINS) return [];
  const configured = env.LEGACY_OPERATIONS_REDIRECT_ORIGINS.split(",").map(value => value.trim());
  if (!configured.length || configured.length > LEGACY_OPERATIONS_ORIGINS.size
    || configured.some(value => !LEGACY_OPERATIONS_ORIGINS.has(value))
    || new Set(configured).size !== configured.length) return null;
  return configured;
}
