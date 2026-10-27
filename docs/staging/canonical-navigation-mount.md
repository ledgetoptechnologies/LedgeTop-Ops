# Canonical browser navigation mounts

Source base: `a0be8882`. This candidate mounts conservative browser navigation
policies in the real Client and Operations request handlers. It changes no
deployment settings, asset-routing configuration, Access application or policy,
resource, credentials, data or frozen phase hashes. Nothing has been activated.

Client retains its optional `CANONICAL_BROWSER_NAVIGATION_ENABLED` switch.
Operations uses its existing `PUBLIC_BASE_URL` as the rollout control: fresh
page redirects are active only when that value is exactly
`https://ops.ledgetop.app`, `EXPECTED_HOST` is exactly `ops.ledgetop.app`, and
both request and target origins pass the existing `OPERATIONS_ORIGINS` host
policy. No extra Worker scalar is needed.
The source Operations Wrangler and staging templates route only redirectable
staff page paths through the Worker so asset-first handling cannot bypass the
policy. `/api/*`, `/r/*`, and static assets retain their existing routing.

For public Client redirects, fresh means GET/HEAD with document/navigation Fetch
Metadata and no Cookie, Authorization, Origin, Range or If-Range header. Ordinary
private Client pages and Ops staff pages redirect even when the old host carries an Access cookie:
no cookie or authorization header is copied, and Access on the canonical host
performs its normal check. This makes the old-host UI redirect automatic; users
may need to authenticate at the canonical host because old-host cookies are
host-scoped and are not transferable. The original cookies are not modified.
API requests, bodies, assets, media and Viewer sessions remain local. Missing
Fetch Metadata leaves requests local. The shared navigation policy excludes
capability paths and unknown query keys.

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
force existing old private cookies across origins before the navigation control
is enabled. Explicitly retired private hosts keep their existing retirement
handler. When the navigation control is enabled, ordinary private page entries
move to the canonical portal while API requests remain local for existing open
sessions. Public delivery cookies keep their original resumption behavior.
This does not create a new public namespace.

## Required deployment gates

**Installed Operations page routing remains a deployment gate.** Capture and
compare installed settings before activation. Confirm the deployed Worker-first
paths include redirectable pages while API, asset, `/r/*`, native handler, and
callback routing remain unchanged.

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

Real `worker.fetch` tests exercise the `PUBLIC_BASE_URL` activation boundary,
deep Operations Client Hub bookmarks, GET/HEAD, exact query strings, cookie-bearing
staff pages, Authorization, Range/If-Range, legacy public paths and signed
callbacks, API authentication/invalid-session rejection, POST exclusion, unknown
origins, target/source configuration and forged Host/forwarding headers.
Client `/s` on private portal.app remains denied. These tests run source handlers
directly; they do not prove that assets-first edge routing invokes those handlers.

No live request or setting change was made. Source-level routing declarations do
not prove what the Worker currently serves in the active namespace.
