# Default-off canonical browser navigation mounts

Source base: `a0be8882`. This candidate mounts conservative browser navigation
policies in the real Client and Operations request handlers. It changes no
deployment settings, asset-routing configuration, Access application or policy,
resource, credentials, data or frozen phase hashes. Nothing has been activated.

Both handlers recognize the optional string
`CANONICAL_BROWSER_NAVIGATION_ENABLED`. Only the exact string `true` opts in;
absent, false or malformed values preserve the prior behavior. No Wrangler var
or generated default is added. Existing finite production profiles deliberately
do not admit this new scalar. A reviewed versioned settings/profile plan is
required before activation; do not bypass those guards with arbitrary overrides.

Fresh means GET/HEAD with document/navigation Fetch Metadata and no Cookie,
Authorization, Origin, Range or If-Range header. Any cookie conservatively keeps
the request on its original host, including Access, delivery and bulk-resume
cookies. API requests, bodies, assets, media and Viewer sessions retain their
current handlers. Missing Fetch Metadata leaves the request local. The shared
private navigation policy also excludes capability paths and unknown query keys.

## Exact targets and existing host admission

- Client public `/s/:id` and `/client-share/:id` browser entries use only
  `https://delivery.ledgetop.app` and only after the complete canonical public
  tuple matches that origin. Source origins must already be explicitly admitted
  historical public hosts: the old LTDS portal or old LTDS client hostname.
- Client ordinary private pages use only `https://portal.ledgetop.app` when it
  is the configured primary and both request origin/path and target pass existing
  host admission. The old mixed LTDS portal is disambiguated by route: public
  entries go to delivery; private pages go to portal. Existing LTT private aliases
  remain admitted; they do not acquire public-share routes.
- Operations ordinary staff pages use only `https://ops.ledgetop.app` after the
  existing host gate. Both source and target must pass the unchanged configured
  Operations origin policy. Machine and API handlers retain their own admission.

The optional mount never widens `requestHostAllowed`. It uses the request URL
and existing exact origin configuration; `Host`, `X-Forwarded-Host` and other
forwarding headers do not choose or authorize a destination. Targets are fixed.
No cookies, Authorization headers or bodies are forwarded. Redirects are
non-cacheable 302 responses with no-referrer policy. Exact eligible path/query
bytes survive; root private navigation retains the existing `/portal` entry
convention. Location omits a fragment, allowing the browser to inherit it without
revealing the fragment to the Worker. Loopback Chromium acceptance covers that
HTTP behavior; actual production TLS/Access acceptance remains separate.

The one intentional default-off correction is in legacy private routing: an old
origin still present in active `CLIENT_PORTAL_ORIGINS` no longer receives the
retirement-style private redirect merely because it also appears in
`LEGACY_CLIENT_ORIGINS`. Otherwise the new mixed-host public overlap tuple would
force existing old private cookies across origins. Explicitly retired private
hosts keep their existing retirement handler. This correction preserves active
old private sessions and does not create a new public namespace.

## Required deployment gates

**Operations page routing remains a concrete blocker.** Its current declared
`assets.run_worker_first` covers APIs, health, `/r/*` and selected native
administrative pages, while ordinary staff pages are assets-first. Those pages
can bypass this source mount. The source flag alone cannot redirect them.
Separately review actual installed routing and narrowly route the intended
staff page paths through the Worker while preserving assets, APIs and native
handlers. No routing change is included in this candidate.

Client already declares Worker-first root, portal and public-share entry paths,
but actual installed settings must still be verified. Preserve both old/public
session/API namespaces, source/version grants, native private-byte access and
Viewer controller pins. Keep new targets behind their existing independently
verified Access protections; a source redirect is not evidence that those gates
exist. Public delivery must retain its public-share authorization rather than
receive a staff/private Access gate. Do not remove old hosts while their cookies
or pinned Viewer sessions are still in use. Retained frontend URLs and exact
asset-byte verification remain required for 48 hours; no pruning is scheduled.

## Local verification

Real `worker.fetch` tests exercise flag-off/on behavior, mixed-host public/private
selection, GET/HEAD, exact query strings, existing cookies, Authorization,
Range/If-Range, API authentication/invalid-session rejection, POST exclusion,
unknown origins, target/source configuration and forged Host/forwarding headers.
Client `/s` on private portal.app remains denied. These tests run source handlers
directly; they do not prove that assets-first edge routing invokes those handlers.

Client mount/origin suites: 23 passed. Operations mount/host suites: 12 passed.
Existing pure policy/compatibility/browser suites: 26 passed. Client and
Operations TypeScript checks passed. No live request or setting change was made.
