# ledgetop.app compatibility and acceptance

This is a source/configuration review and local test packet. Live DNS, deployed Worker configuration and existing links were not changed by
these checks. Separately, the rollout operator verified additive new staff and
private portal destinations on the existing Access applications, retaining old
destinations, policies, audiences and session durations. Worker domain/runtime
and bucket CORS changes remain source preparation at this checkpoint. The user-confirmed addresses are **`https://ops.ledgetop.app` for
staff** and **`https://portal.ledgetop.app` for clients**. These supersede the
initial apex staff-host proposal. The apex `https://ledgetop.app` is not an
implicit staff, portal, or public-bearer origin. PA remains separate.

The source candidate adds the exact new Worker domains, staff/private origin
settings and mirrored upload CORS origins. The private portal primary becomes
the new client host. Public canonical origins remain on the existing LTDS portal.
The new native physical profile pins the unchanged Worker/account/database and
allows only the new portal and retained LTDS private portal for byte requests;
the LTT presentation alias gains no native byte access. Its configured allowlist
must also explicitly retain each admitted private origin.

The pure navigation redirect policy remains disabled by default and unmounted.
There are no permanent redirects. Source preparation is not proof that the new
hosts are serving or that a live canonical cutover is complete.

Local validation on October 22: 44 Node checks (10 navigation policy, 10 actual
compatibility helper, 24 repository/configuration invariants), 46 focused Client
Worker/native route checks and 10 receiver preflight checks passed. Client
TypeScript also passed. These synthetic route tests prove both reviewed private
hosts can stream the same existing authorized file handle without redirects and return identical finite fixture bytes,
recheck its current grant, and deny revoked access before R2 acquisition. They
also prove old public session cookies remain usable on the original hosts and
still fail after share-version revocation. They do not substitute for live
Access authentication or real browser download/upload acceptance.

Live new-domain sign-in, denied identities, upload/CORS, Viewer renewal, existing
open private sessions and historical public download acceptance remain release
gates. Retain the old domains, route handlers, signing secrets and Access
applications until that acceptance passes; a new DNS record alone is not a
completed migration.

## Confirmed staff/client separation

The staff and client subdomains are separate application surfaces. Reusing the
same parent DNS zone does not share their sessions or grant their permissions.

| Host | Intended application | Must not become |
| --- | --- | --- |
| `ops.ledgetop.app` | Staff Operations, protected by the existing staff Access policy and Ops staff authorization | A client/public bearer host |
| `portal.ledgetop.app` | Client portal, protected on its private paths by client Access and current client grants | A staff API host or automatic alternate public bearer host |
| `ledgetop.app` | No application assignment implied by this request | An implicit staff/client admission alias |
| Existing LTDS public portal/client hosts | Existing public links, sessions and download APIs | Redirect-only hosts that discard old host-bound sessions |

An additive client migration can set `CLIENT_PORTAL_ORIGIN` to the new client
subdomain while retaining the original public canonical tuple and old private
presentation aliases. This preserves old share and session endpoints. It still
requires the separately reviewed native-delivery physical profile for the new
private primary. Do not label a successful host-allowlist check proof that file
delivery, the Access audience, or private grants are working on the new host.

Before reporting the two new hosts live, verify both a permitted and a denied
identity on each application. A valid client Access assertion must not admit a
staff route, and a staff cookie must not replace client resource authorization.
Keep cookie host boundaries, exact origin checks and existing audience checks;
do not broaden these to `*.ledgetop.app` to avoid testing individual hosts.

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
npm --prefix apps/client test -- --maxWorkers=1 --pool=threads test/portal-origin-migration.test.ts test/operations-native-delivery-deployment.test.ts test/operations-native-delivery-routes.test.ts
npm --prefix apps/client test -- --maxWorkers=1 --pool=threads test/platform-security.test.ts test/client-routing.test.ts test/client-onboarding-origin-worker.test.ts test/public-share-routes.test.ts test/access-identity.test.ts
node --test scripts/source-layout-invariants.test.mjs
```

The new Node suite imports the actual TypeScript origin policy, route parser,
cookie signer/verifier, Ops host admission and native deployment gate. It does
not reimplement those decisions. It covers final and additive-only configurations,
known unsafe partial/overlapping configurations, preserved opaque credentials,
legacy host-only cookies, encoded paths/query and separate namespaces.

The current source candidate passed **46/46** focused migration/native route
checks and **104/104** additional existing routing, public-share and identity
checks; receiver preflight passed **10/10**. These tests use controlled fixtures
and actual Worker/helper code. They do not prove live `.app` DNS, certificate
issuance, Access configuration, remote keys, or customer downloads. Record the
final candidate revision after integration.

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
