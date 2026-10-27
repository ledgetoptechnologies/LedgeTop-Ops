/**
 * Reversible browser-navigation policy for the ledgetop.app migration.
 *
 * This is deliberately not host admission, authentication, a proxy, or a public
 * share migration. Callers must separately admit/protect the new domains before
 * enabling it. Existing API, capability, upload, detailed Viewer session and share namespaces
 * continue at their original hosts with their existing cookies and authority.
 * Nothing invokes this policy until a caller explicitly supplies enabled=true.
 */
export type CanonicalDomainSurface = "operations" | "portal";
export interface CanonicalDomainNavigationConfiguration {
  enabled?: unknown;
  surface: CanonicalDomainSurface;
}

const TARGETS = Object.freeze({
  operations: "https://ops.ledgetop.app",
  portal: "https://portal.ledgetop.app",
});
const SOURCES: Readonly<Record<CanonicalDomainSurface, readonly string[]>> = Object.freeze({
  operations: Object.freeze([
    "https://ops.ledgetopdroneservices.com",
    "https://ops.ledgetoptechnologies.com",
  ]),
  portal: Object.freeze([
    "https://portal.ledgetopdroneservices.com",
    "https://portal.ledgetoptechnologies.com",
    "https://client.ledgetopdroneservices.com",
  ]),
});

const OPERATIONS_PAGES = new Set([
  "/", "/dashboard", "/airspace", "/operations", "/clients", "/delivery",
  "/team", "/administration",
  "/clients/requests", "/clients/feedback", "/clients/invitation-requests",
  "/viewer", "/viewer/models", "/viewer/sharing", "/viewer/processing", "/operations/processing",
  "/intel", "/account", "/configurations", "/notifications", "/jobs", "/projects", "/tasks", "/sops",
  "/operations/projects", "/operations/tasks", "/operations/sops", "/operations/notifications",
  "/operations/client-requests", "/operations/feedback", "/operations/inbox", "/operations/invitation-requests",
  "/delivery/incoming", "/delivery/links",
]);
const PORTAL_PAGES = new Set([
  "/", "/portal", "/portal/dashboard", "/portal/projects", "/portal/deliveries",
  "/portal/requests", "/portal/requests/new", "/portal/feedback", "/portal/account",
]);
// Unknown query keys are served on the original host. A navigation allowlist
// is safer than guessing every spelling of OAuth/share/invitation credentials.
const NAVIGATION_QUERY_KEYS = new Set([
  "q", "search", "scope", "workspace", "project", "projectid", "file", "fileid",
  "folder", "prefix", "page", "limit", "cursor", "sort", "order", "filter", "tab",
  "status", "source", "sourceid", "area", "division", "client", "clientid",
  "organization", "organizationid", "id", "kind", "type", "view", "from", "to", "date",
  "business", "range",
]);

function browserPage(pathname: string, surface: CanonicalDomainSurface): boolean {
  // Encoded separators/control bytes are not an alternate way into a page
  // namespace. Do not interpret or normalize capability routes for the caller.
  if (pathname.includes("//") || /%(?:2f|5c|00|0a|0d)/i.test(pathname)) return false;
  const path = pathname === "/" ? pathname : pathname.replace(/\/$/, "");
  const exactPage = (surface === "operations" ? OPERATIONS_PAGES : PORTAL_PAGES).has(path);
  const legacyClientDetail = surface === "operations"
    && /^(?:\/operations\/(?:client-requests|feedback|invitation-requests)|\/clients\/(?:requests|feedback|invitation-requests))\/[A-Za-z0-9_-]{1,128}$/.test(path);
  let decodedSegments: string[];
  try { decodedSegments = pathname.split("/").map(segment => decodeURIComponent(segment)); }
  catch { return false; }
  // Reject malformed/multiply encoded segments instead of guessing how a later
  // router decodes them. Source identifiers such as project-alpha%3Aprimary
  // remain valid, while encoded capability words are checked as actual words.
  if (decodedSegments.some(segment => /[%\\/\p{C}]/u.test(segment))) return false;
  // A fixed ordinary page such as the legacy invitation-request list is not
  // an invitation capability. Unknown/deep routes retain the lexical guard.
  if (exactPage || legacyClientDetail) return true;
  if (decodedSegments.some(segment => /(?:^|[-_.])(?:onboarding|enrollments?|invitations?|invite|callbacks?|oauth|sessions?|authorize|authorization|tokens?|grants?)(?:[-_.]|$)/i.test(segment))) return false;
  if (surface === "operations") {
    if (OPERATIONS_PAGES.has(path)) return true;
    // Preserve ordinary Client Hub record bookmarks. Administrative capability
    // and enrollment pages intentionally are not covered by this prefix.
    return /^\/clients(?:\/[A-Za-z0-9._~!$&'()+,;=:@%+-]+)+$/.test(path);
  }
  if (PORTAL_PAGES.has(path)) return true;
  return /^\/portal\/(?:projects|feedback)\/[A-Za-z0-9_-]{1,128}$/.test(path);
}

function hasOnlyNavigationQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    // Normal list filters/search and workspace/project selection remain intact.
    // Links carrying login, OAuth or share capabilities need their original
    // route-specific handler rather than a generic cross-domain redirect.
    if (!NAVIGATION_QUERY_KEYS.has(key.toLowerCase())) return false;
  }
  return true;
}

export function canonicalDomainNavigationRedirect(
  request: Pick<Request, "method" | "url">,
  configuration: CanonicalDomainNavigationConfiguration,
): Response | null {
  if (configuration.enabled !== true || !["GET", "HEAD"].includes(request.method)
    || (configuration.surface !== "operations" && configuration.surface !== "portal")) return null;
  let source: URL;
  try { source = new URL(request.url); } catch { return null; }
  if (source.username || source.password || request.url.length > 16_384
    || !SOURCES[configuration.surface].includes(source.origin)
    || !browserPage(source.pathname, configuration.surface)
    || !hasOnlyNavigationQuery(source)) return null;

  // Assigning pathname/search avoids interpreting //host or a query-provided
  // destination as the target host. Neither request Host nor query chooses it.
  const target = new URL(TARGETS[configuration.surface]);
  target.pathname = configuration.surface === "portal" && source.pathname === "/"
    ? "/portal" : source.pathname;
  target.search = source.search;
  return new Response(null, { status: 302, headers: {
    Location: target.toString(),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  } });
}
