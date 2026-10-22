# ledgetop.app compatibility and acceptance

This is a review/test packet. No DNS, Access policy, Worker route, canonical
configuration, deployment profile or existing link was changed by these checks.
The candidate addresses are `https://ledgetop.app` for Operations and
`https://portal.ledgetop.app` for the client portal. PA's domains and ownership
remain separate.

Current candidate scope: the pure navigation redirect policy is implemented,
disabled by default, and unmounted. Host admission, origin transitions,
native physical-deployment profiles, Access destinations, Worker domains and
generated production links have not been changed. This candidate is preparation
for the migration, not a serving new domain or a completed canonical cutover.

Validated on October 22: 10 navigation-policy checks, 9 actual compatibility
helper checks, 114 existing Client Worker checks, and 10 existing portal
preflight checks passed; Operations and Client TypeScript checks passed. Live
new-domain sign-in, upload, Viewer renewal and legacy download acceptance are
still required after the additive configuration stage below.

## What existing source actually requires

Public bearer links and signed-in portal pages use distinct host namespaces.
`CLIENT_PORTAL_ORIGINS` is not a public-link allowlist. The public canonical tuple
is `PUBLIC_SHARE_ORIGIN == PUBLIC_BASE_URL`, with `EXPECTED_HOST` equal to its
hostname. A partial tuple change fails closed. Existing public hosts belong in
`LEGACY_CLIENT_ORIGINS`; do not add the Technologies presentation host there,
because it deliberately cannot serve public bearer routes today.

Do not blindly change that tuple and keep all previous portal aliases active.
The current legacy-origin validator refuses a public legacy host overlapping
an active private presentation alias after the new primary has been promoted.
The test packet intentionally captures this failure. A reviewed transition
policy or deliberate private-host retirement is required for the full cutover.

The first additive stage can keep the current public canonical origin, retain
the existing private primary, and add the new portal only as a presentation
alias. That stage does not make the new portal a public-share namespace or a
machine/onboarding ingress host. All configured origin lists are bounded to
four entries, so validate the actual inventory rather than appending aliases
indefinitely.

Native delivery adds another physical deployment gate. Its production profile
and helper currently recognize the old exact portal/public origins. Changing
only the public tuple to `.app` makes that helper deny both portal and RPC
admission. Update/review the exact deployment profile and dependent release
validation together; never disable the physical-admission check to migrate.

## Old-link behavior to retain

| Traffic | Required behavior during migration |
| --- | --- |
| Ops ordinary GET/HEAD navigation | Temporary, non-cacheable redirect only after new staff Access/login is verified. Preserve raw path and query. |
| Portal ordinary GET/HEAD navigation | Temporary redirect after new client Access/login, grants and native delivery are verified. |
| `/s/:id` and `/client-share/:id` | Continue serving on their existing explicit public hosts. Do not blanket redirect. |
| Fragment-bearing legacy `client.*` link | Existing browser handler preserves path, query and opaque fragment before session exchange; its current first hop is the existing `portal.*` host. Keep that first hop working until a separately tested client change. |
| Fragment-less refresh or password/session download | Stay on the existing host. The `__Host-ltds_delivery` cookie has no Domain attribute and cannot be carried to another origin by a redirect. |
| Historical single-token `/s/<token>` | Keep the token parser and existing link record/key material unchanged. |
| Public session/manifest/media/range/ZIP APIs | Keep original origin, method, headers, authorization and cookie. No cross-host redirects. |
| Private client API, onboarding and internal ingress | Do not forward request bodies/cookies across hosts. Canonical-only internal/onboarding origins need an explicit producer cutover. |
| Ops agent/MCP API, PA webhooks, machine service ingress | Preserve existing clients and registered paths. A website redirect is not an API migration. |
| Upload start/parts/finalize and presigned storage URLs | Preserve endpoint origins, signed URL/query bytes and allowed CORS origins until an actual upload completes on the new configuration. |
| Viewer launch/renewal/download | Preserve the existing Viewer host and renewal endpoint. Validate exact origin CORS, Access audience, existing subject binding and CSRF challenge on each host. |
| OAuth/login callbacks, invitations and capability URLs | Keep original route-specific handlers; do not let a generic navigation rule move their credential-bearing paths or queries. |
| Existing assets/open sessions | Retain old asset bundles and hosts during the overlap; loading a new page is not proof an already-open share still downloads. |

## Automated evidence

Requires the repository's supported Node 24 runtime and locked Client
dependencies (`npm ci --prefix apps/client`).

```powershell
node --test scripts/domain-migration-compatibility.test.mjs
node --test scripts/canonical-domain-navigation.test.mjs
npm --prefix apps/client test -- test/platform-security.test.ts test/client-routing.test.ts test/portal-origin-migration.test.ts test/client-onboarding-origin-worker.test.ts test/public-share-routes.test.ts
```

The new Node suite imports the actual TypeScript origin policy, route parser,
cookie signer/verifier, Ops host admission and native deployment gate. It does
not reimplement those decisions. It covers final and additive-only configurations,
known unsafe partial/overlapping configurations, preserved opaque credentials,
legacy host-only cookies, encoded paths/query and separate namespaces.

On the initial review candidate, the existing five Client suites passed
**114/114**, and receiver preflight passed **10/10**. These tests use controlled
fixtures and actual Worker/helper code. They do not prove live `.app` DNS,
certificate issuance, Access configuration, remote keys, or customer downloads.
Record the final candidate revision and final test result after integration.

## Live acceptance before enabling redirects

1. Record current routes, Worker versions, public/private origin settings,
   release profile and Access applications without recording credentials.
2. Add the new origin without removing old routes or changing database rows,
   share IDs, secret hashes, signing keys, expiration, grants or share versions.
3. Verify staff owner and ordinary staff authorization on the new Ops origin.
   A signed Access session on an old host does not prove authentication on the
   new host; confirm the intended audience and normal sign-in flow.
4. Verify an authorized synthetic client on the new portal and a denied client
   from another account. Check private files and native delivery current-grant
   enforcement, including revocation, rather than only the home page.
5. Open synthetic examples of each old link form on the original host. Test
   first-use fragment, existing fragment-less session, access code, expired and
   revoked shares, file ranges and ZIP download. Repeat from an already-open tab.
6. Exercise a complete upload and Viewer silent renewal using current bindings
   and normal Access. Verify the new exact origins without adding wildcards.
7. Run the tested temporary navigation redirect policy only for verified browser
   pages. Confirm no redirect loop and preservation of deep-link/query state.
8. Observe acceptance failures before any permanent redirect. Roll back by
   disabling the temporary navigation policy and restoring the recorded origin
   profile/routes. Keep the old hosts and original data intact throughout.

Do not remove an old public host merely because ordinary navigation redirects
successfully. Retire it only after a separately reviewed compatibility mechanism
serves all remaining links and host-bound sessions for their supported lifetime.
