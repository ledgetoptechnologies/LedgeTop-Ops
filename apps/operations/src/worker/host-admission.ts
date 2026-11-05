import type { Env } from "./types";

const PRODUCTION_OPERATIONS_ORIGINS = new Set([
  "https://ops.ledgetop.app",
]);
const RETIRED_PRODUCTION_OPERATIONS_ORIGINS = new Set([
  "https://ops.ledgetopdroneservices.com",
  "https://ops.ledgetoptechnologies.com",
]);
const STAGING_OPERATIONS_ORIGINS = new Set([
  "https://ops-staging.ledgetopdroneservices.com",
]);
const ALL_KNOWN_OPERATIONS_ORIGINS = new Set([
  ...PRODUCTION_OPERATIONS_ORIGINS, ...RETIRED_PRODUCTION_OPERATIONS_ORIGINS, ...STAGING_OPERATIONS_ORIGINS,
]);
const NON_OPERATIONS_APP_HOST = /^(?:portal|client|delivery|incoming)(?:-staging)?\.(?:ledgetop\.app|ledgetopdroneservices\.com|ledgetoptechnologies\.com)$/u;
const CANONICAL_PRODUCTION_OPERATIONS_ORIGIN = "https://ops.ledgetop.app";
const LEGACY_VIEWER_CONTROLLER_ORIGINS = RETIRED_PRODUCTION_OPERATIONS_ORIGINS;

const LEGACY_VIEWER_CONTROLLER_ROUTES = new Set([
  "POST /api/viewer/admin-grant",
  "OPTIONS /api/viewer/workspace/session-renewal",
  "GET /api/viewer/workspace/session-renewal/challenge",
  "POST /api/viewer/workspace/session-renewal",
]);

export function requestHostAllowed(
  requestUrl: string,
  env: Pick<Env, "ENVIRONMENT" | "EXPECTED_HOST" | "OPERATIONS_ORIGINS">,
): boolean {
  if (env.ENVIRONMENT !== "production" && env.ENVIRONMENT !== "staging") return true;
  try {
    const request = new URL(requestUrl);
    const configured = env.OPERATIONS_ORIGINS
      ? env.OPERATIONS_ORIGINS.split(",").map(value => value.trim())
      : [`https://${env.EXPECTED_HOST}`];
    if (!configured.length || configured.length > 4 || configured.some(value => !value)) return false;
    const origins = configured.map(value => {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.origin !== value || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("invalid-origin");
      return url.origin;
    });
    if (new Set(origins).size !== origins.length || !origins.includes(`https://${env.EXPECTED_HOST}`)) return false;
    return origins.includes(request.origin);
  } catch {
    return false;
  }
}

/**
 * Preserve the existing Viewer controller origin only for the authenticated
 * grant and renewal endpoints after production switches to the exact
 * canonical-only Operations origin list. All other routes continue to use
 * requestHostAllowed and deny those retired hosts.
 */
export function legacyViewerControllerCompatibilityAllowed(
  requestUrl: string,
  method: string,
  env: Pick<Env, "ENVIRONMENT" | "EXPECTED_HOST" | "OPERATIONS_ORIGINS">,
): boolean {
  if (env.ENVIRONMENT !== "production" || env.EXPECTED_HOST !== "ops.ledgetop.app"
    || env.OPERATIONS_ORIGINS !== CANONICAL_PRODUCTION_OPERATIONS_ORIGIN) return false;
  try {
    const request = new URL(requestUrl);
    if (request.protocol !== "https:" || request.port || request.search
      || !LEGACY_VIEWER_CONTROLLER_ORIGINS.has(request.origin)) return false;
    return LEGACY_VIEWER_CONTROLLER_ROUTES.has(`${method.toUpperCase()} ${request.pathname}`);
  } catch { return false; }
}

/** Returns the exact admitted Operations origin for browser API and CSRF checks.
 * Fixed Ops aliases are admitted only for known Ops deployments; a custom
 * deployment retains its configured primary origin without gaining aliases. */
export function admittedOperationsRequestOrigin(
  requestUrl: string,
  env: Pick<Env, "ENVIRONMENT" | "EXPECTED_HOST" | "OPERATIONS_ORIGINS">,
  canonicalOrigin: string,
): string | null {
  try {
    const request = new URL(requestUrl);
    const canonical = new URL(canonicalOrigin);
    if (canonical.protocol !== "https:" || canonical.origin !== canonicalOrigin
      || canonical.pathname !== "/" || canonical.search || canonical.hash
      || canonical.username || canonical.password || canonical.port
      || canonical.origin !== `https://${env.EXPECTED_HOST}`
      || !requestHostAllowed(requestUrl, env)) return null;
    // Local development continues to require the configured origin for these
    // privileged APIs; the general host admission used by local tooling is wider.
    if (env.ENVIRONMENT !== "production" && env.ENVIRONMENT !== "staging")
      return request.origin === canonical.origin ? request.origin : null;
    const configured = env.OPERATIONS_ORIGINS
      ? env.OPERATIONS_ORIGINS.split(",").map(value => value.trim())
      : [`https://${env.EXPECTED_HOST}`];
    // Known former production Ops origins remain usable only while explicitly
    // present in OPERATIONS_ORIGINS. Removing one from that exact list retires
    // its browser APIs while the Worker can still serve navigation redirects.
    const allowed = env.ENVIRONMENT === "production"
      ? new Set([...PRODUCTION_OPERATIONS_ORIGINS, ...RETIRED_PRODUCTION_OPERATIONS_ORIGINS])
      : STAGING_OPERATIONS_ORIGINS;
    if (canonical.origin !== `https://${env.EXPECTED_HOST}`
      || configured.some(value => {
        try { return NON_OPERATIONS_APP_HOST.test(new URL(value).hostname); } catch { return true; }
      })) return null;
    if (ALL_KNOWN_OPERATIONS_ORIGINS.has(canonical.origin) && !allowed.has(canonical.origin)) return null;
    if (!allowed.has(canonical.origin))
      return configured.length === 1 && configured[0] === canonical.origin && request.origin === canonical.origin
        ? request.origin : null;
    if (!configured.length || configured.length > 4 || configured.some(value => !allowed.has(value))
      || new Set(configured).size !== configured.length || !configured.includes(canonical.origin)
      || !configured.includes(`https://${env.EXPECTED_HOST}`)) return null;
    return configured.includes(request.origin) ? request.origin : null;
  } catch { return null; }
}
