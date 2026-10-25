import { canonicalDomainNavigationRedirect } from "../../../../packages/shared/src/canonical-domain-navigation";
import { requestHostAllowed } from "./host-admission";
import type { Env } from "./types";

export function canonicalOperationsNavigationRedirect(request: Request,
  env: Pick<Env, "ENVIRONMENT" | "EXPECTED_HOST" | "OPERATIONS_ORIGINS" | "CANONICAL_BROWSER_NAVIGATION_ENABLED">): Response | null {
  if (env.CANONICAL_BROWSER_NAVIGATION_ENABLED !== "true" || env.ENVIRONMENT !== "production"
    || ["Cookie", "Authorization", "Range", "If-Range", "Origin"].some(name => request.headers.has(name))
    || request.headers.get("Sec-Fetch-Dest") !== "document" || request.headers.get("Sec-Fetch-Mode") !== "navigate"
    || !requestHostAllowed(request.url, env)
    || !requestHostAllowed("https://ops.ledgetop.app/", env)) return null;
  return canonicalDomainNavigationRedirect(request, { enabled: true, surface: "operations" });
}
