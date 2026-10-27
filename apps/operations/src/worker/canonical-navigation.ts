import { canonicalDomainNavigationRedirect } from "../../../../packages/shared/src/canonical-domain-navigation";
import { requestHostAllowed } from "./host-admission";
import type { Env } from "./types";

const CANONICAL_OPERATIONS_ORIGIN = "https://ops.ledgetop.app";

export function canonicalOperationsNavigationRedirect(request: Request,
  env: Pick<Env, "ENVIRONMENT" | "EXPECTED_HOST" | "OPERATIONS_ORIGINS" | "PUBLIC_BASE_URL">): Response | null {
  // The existing public base URL is the single rollout control. This keeps
  // canonical page navigation on by default once the reviewed Ops origin is
  // installed, without consuming another Worker scalar binding.
  if (env.PUBLIC_BASE_URL !== CANONICAL_OPERATIONS_ORIGIN || env.EXPECTED_HOST !== "ops.ledgetop.app"
    || env.ENVIRONMENT !== "production"
    || ["Authorization", "Range", "If-Range", "Origin"].some(name => request.headers.has(name))
    || request.headers.get("Sec-Fetch-Dest") !== "document" || request.headers.get("Sec-Fetch-Mode") !== "navigate"
    || !requestHostAllowed(request.url, env)
    || !requestHostAllowed(`${CANONICAL_OPERATIONS_ORIGIN}/`, env)) return null;
  return canonicalDomainNavigationRedirect(request, { enabled: true, surface: "operations" });
}
