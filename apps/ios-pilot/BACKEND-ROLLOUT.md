# Read-only pilot rollout

October 29, 2026. This is a source and local-test checkpoint, not deployment approval or evidence of live sign-in.

## Scope

The Access-protected `/api/mobile-pilot/authorize` issues a short-lived, single-use PKCE code for the fixed native callback. `/mobile-pilot/v1/token` exchanges it for a hashed-at-rest opaque session lasting no more than fifteen minutes or the originating Access expiry. The separate facade exposes session, paginated operations, operation details, and logout. Existing staff, assignment, source, and native-admission cutover rules remain authoritative. Mobile tokens cannot authenticate to the general API. Authentication bookkeeping is allowed; business mutations and connector reconciliation are not.

`IOS_PILOT_ENABLED` is absent/off in deployment configuration. The client also ships with `LTOpsLiveEnabled=false`. Neither switch has been enabled remotely.

## Activation gates

1. Recheck current release ownership, deployed schema, source revision, and provider settings. The last Hub note reported ledger 225; source migration 0232 is not permission to apply intervening migrations. Review prerequisite tables and the actual migration plan first.
2. Verify the approved synthetic staging connector manifest and staff/source permissions. Resolve configuration mismatches through the existing configuration process; mobile reads deliberately cannot repair them.
3. Keep the browser authorization endpoint behind Access. Review ingress for only the exact native facade paths, where opaque sessions are validated by the Worker. Do not bypass Access on the general API. Confirm worker-first routing reaches the facade instead of SPA fallback.
4. Deploy the reviewed staging revision and migration through the established release process, then explicitly enable the backend and client for that approved staging origin. Keep production unchanged until separately qualified.
5. Build against a real Apple SDK and install on the iPad. Complete the device checklist in README.md: browser callback, cancellation, logout races, expiry/revocation, scope filtering, pagination, and network errors. Local syntax parsing is insufficient.
6. For rollback, disable the pilot flag and revoke pilot sessions as appropriate. Preserve existing web assets under the established retention policy; do not prune shared release resources.

The current worktree preflight reports missing generated staging configs and an
outdated ordered migration inventory: 11 Delivery and 32 Operations filenames
are newer than the checked-in contract; none named in that contract are missing.
This is not evidence of the remote staging ledger. Migration 0232 itself creates
only pilot credential tables and indexes. The staff login binding code introduced
in 0226 also has an explicit compatibility path for an already-bound primary
identity when all of its tables are absent; alternate identities fail closed.
Applying 0232 in isolation would not prove safe authentication. Review the
actual staging ledger and complete dependency chain with the release owner.

Cloudflare's current documentation says path-specific Access rules override the
broader path and cautions that Bypass disables Access controls and request logging;
it advises against using Bypass as a persistent access mechanism. Consequently,
the proposed native facade ingress is not yet an approved production design. Review
alternatives that preserve edge authentication and logging, and validate whichever
approach is chosen against mobile credential handling before any activation. A
shared service token embedded in a distributed app is not an acceptable substitute.
See [application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
and [Cloudflare's Bypass caution](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/).

Candidate to investigate: [Access Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
can authenticate non-browser clients as users and forward an Access assertion to
the origin. Use a dedicated narrowly scoped application and retain the server-side
read-only facade; a token valid for the existing general web application could
otherwise authorize write endpoints. Cloudflare documents HTTPS dynamically
registered redirects, plus optional localhost/loopback redirects, so the current
custom-scheme callback is not proven compatible. Cloudflare's API reference
also describes exact custom-scheme registration, which conflicts with the guide;
verify the actual self-hosted application behavior rather than assuming either
description applies. Confirm account availability,
RFC 8707/resource isolation, redirect and PKCE behavior, token expiry and revocation,
and device compatibility before selecting or enabling it. Do not enable Managed
OAuth on the shared web application merely for this experiment.
See the [Access API schema](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/)
and [Apple authentication session documentation](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession).

## Staging inspection, October 29

Read-only inspection of the Operations staging D1 database (ID ending `c6b8`)
found migration 0225 as the latest recorded migration. The `staff_login_bindings`
and pilot credential tables were absent. No migration was applied. This confirms
that the existing custom-session implementation cannot simply be enabled there.
The Managed OAuth facade does not use the 0232 session tables and can use the
legacy primary-identity path when all 0226 tables are absent. That observation
does not establish a valid staff binding, permissions, complete schema or connector
configuration, and does not authorize enabling data access.

The existing staging Access application protects the entire Operations hostname
with the staff allow policy. Its Managed OAuth setting is available but off. Do
not enable it on that shared application: a mobile token must not gain access to
the general API. A separate pilot-only hostname and Access application is a
candidate; route only the read-only facade and reject other paths and methods.
Verify host routing and token isolation with negative tests before activation.
Routing review found that the existing Operations Worker has earlier dispatch
paths and path-selective static asset handling. Mounting only a pilot path in
that Worker would not prove all requests to the pilot hostname reach the narrow
facade. Prefer a separate staging-only Worker without assets, schedules, queues,
or general API dispatch; route every request through the facade and bind only
the reviewed dependencies. D1 bindings are not intrinsically read-only, so
application-level restrictions and negative tests remain necessary. Preserve
the connector consistency contract and coordinate the staging database binding
with the existing release owner before any deployment.
An unconfigured standalone entrypoint now sends every fetch to the facade and
defaults closed outside staging. Two local entrypoint tests and the Operations
TypeScript check passed. Before deployment, add a reviewed exact-host allowlist
and check Cloudflare DNS and Worker route collisions: merely requiring the pilot
host to differ from the web hostname does not exclude another production alias.
Read-only dashboard inspection on October 29 found no explicit DNS record
matching `ios-pilot-staging.ledgetopdroneservices.com`, but the zone has a
DNS-only wildcard A record. The zone's Workers Routes page showed no routes.
The wildcard affects the candidate hostname until a more-specific record exists;
this is not approval to create one, and all collision and routing checks must be
repeated immediately before any deployment or DNS change.
Read-only inspection of all visible Access application destinations found no
exact or wildcard match for that candidate. A subsequent authenticated,
read-only Workers Domains API query returned all 28 account domains on one page
and found no exact or wildcard custom-domain match for the candidate. This is
point-in-time evidence and must be repeated immediately before assigning a route.
The current staging ledger remains at 0225, and a zero-row compilation of the
operation projection and key joins succeeded; neither establishes that a staff
identity or connector setup is ready.

An undeployed synthetic-only OAuth probe is available for the first provider
experiment. Its origin allowlist is empty and it has no business-data bindings.
Four signed-assertion and routing tests passed locally. An example Wrangler
configuration also passed a local dry-run bundle with no bindings, routes or
account configured; workers.dev and preview URLs are disabled in that example.
Cloudflare's application form describes exact custom-scheme redirect URIs as
supported, although acceptance and device callback behavior are not yet tested.
The probe checks the assertion
and bearer syntax but relies on Access to validate the actual bearer: before
using it as evidence, test invalid and mismatched tokens at the protected edge
and disable alternative Worker URLs/routes. The Operations connector consistency
check currently reads a credential envelope that can contain unrelated secrets;
review a least-privilege approach before binding the real staging database.
The exact synthetic test boundary and remaining provider checks are recorded in
[PROBE-STAGING.md](PROBE-STAGING.md).
The existing native app has a separate synthetic sign-in test mode, disabled
by a false plist flag and an empty reviewed pin list. It reads only the fixed
probe endpoint and displays a test-only result, without Operations data. All 33
Swift package tests passed and an unsigned Apple SDK build succeeded. The test
mode has not been enabled, signed, installed, or exercised against Cloudflare.
The current candidate is a named private Service Binding entrypoint in the existing
Operations Worker that validates the pilot assertion and performs the narrow
authorized read within the authoritative environment. The public pilot Worker
would then need neither the Operations database nor connector secrets. This is
not deployed or approved: the local implementation requires a staging wrapper, release
coordination, exact target/version checks, independent issuer/audience and
staff/source authorization, and negative tests. Gradual deployments and D1 state
must be checked at activation; a binding name alone does not prove the active
version or data state. A readiness-only RPC would additionally leave a gap
between readiness and the pilot's separate database read.
The local RPC implementation is default-closed and exported only by a separate
staging wrapper that no deployment configuration selects. Two local Miniflare
tests verified the closed service binding and existing HTTP route, and compared
its runtime exports with the canonical staging inventory. The Operations type
check passed. Four boundary tests and two signed-assertion, real-D1 integration cases
passed: they exercised identity and staff denial, assigned versus unassigned
and foreign-source list/detail reads, and watched nine tables for business or
authority writes. This does not prove the live edge, service binding target, or
absence of every possible side effect.
The checked-in staging release contract still has
`RELEASE_CONTRACT_FINALIZED=false`, an older Operations candidate and a pending
Viewer image sentinel. Exporting this entrypoint into the shared staging Worker
therefore requires the release owner to refresh and review the cross-repository
pins, generated configuration, migration inventory and source manifest. The
synthetic probe does not require that business-data deployment.
The local edge bridge now forwards only the URL and Access assertion to that
private RPC; it has no database or connector-secret bindings and remains closed
by an empty source-controlled origin list. The combined edge/RPC tests passed
eight cases, including signed assertions and real local-D1 source/assignment
checks. Access must validate the bearer and replace any client-supplied assertion
at the actual protected edge; the bridge's bearer syntax check cannot prove
that relationship. Disable workers.dev, preview, and alternate routes and verify
the active binding target and deployment version before any activation.

The separate Cloudflare account named `Staging` is distinct from the `Ledge Top`
account that currently owns the Operations staging Access application and D1
database. Its dashboard displayed Rival Ready staging resources, while its Zero
Trust Applications page showed the initial setup screen on this inspection. This
does not establish that it is ready for an Operations Access experiment; do not
assume resources or identity configuration cross account boundaries.

Managed OAuth would require implementation changes: the native client must use
Cloudflare's OAuth flow, and the facade must validate the Access assertion for
the separate pilot audience while retaining staff and record-level authorization.
The existing validator expects the web application's audience, and the current
client and facade use their own opaque sessions. Redirect compatibility, PKCE,
registration, refresh and revocation remain unverified on a real device. The
required database dependencies may change with the final design; do not assume
the existing pilot-session migration remains necessary.

Local work now includes an undeployed Managed OAuth facade and a dedicated
assertion validator. Neither is connected to deployment configuration. Fourteen
signed-assertion unit tests passed and the Operations TypeScript check passed.
The initial combined real-D1 test run produced no result within 120 seconds and
was stopped. A subsequent single-worker focused run of the two new facade
cases passed (15 unrelated cases skipped); it exercised real local D1, with the
Access verification boundary mocked and covered separately by signed-JWT tests.
The full pre-review-change suite then passed 31 tests with a single worker in
213 seconds. After review added a final permission recheck, the three focused
managed-facade cases, including the new late-revocation regression, passed
against real local D1 (15 other cases skipped). The final check narrows the
revocation window; it is not an atomic database-version guarantee. A further
security review found assignment or source visibility can change after the last
visibility query while subsequent staff/scope checks await, allowing stale rows
to be returned. That defect blocked real-data release. D1 sessions provide
sequential consistency, not one snapshot across those awaits. A fix must use a
single authoritative transactional read or a fully covered transactional
authority epoch, preserving existing staff, ACL, assignment and connector
semantics; alternating additional rechecks is insufficient. The final database
snapshot defines the authorization point and cannot retract a response after a
later revocation. A focused real-D1 diagnostic reproduced the race: an
assignment was revoked during the final scope check and the stale operation was
returned. The local candidate now puts staff identity and admission, ACL grants,
connector registry state, and the filtered operation projection in one D1 batch;
it validates those results before returning the batch's rows. The full local
pilot API suite passed 20 tests, including revocations immediately before that
batch for assignments, sources, sessions and roles, and a managed detail-route
regression. Staff snapshot tests passed five cases, including admission-control
and binding-schema changes between discovery and the final batch; ACL helper and existing ACL
tests passed 11 cases. An independent local review found no concrete data-route
authorization defect in the candidate. The connector suite passed its 12 other
cases; its new snapshot case initially attempted a database update forbidden by
an existing transition trigger, then passed after testing a modified snapshot
without bypassing the trigger. This is local evidence, not staging or device
validation: release configuration, actual Cloudflare sign-in and device checks
still need verification before real-data activation.
The private read-service integration and staging-entrypoint suites also passed
five local tests against the updated candidate.
The separate session-status endpoint does not use the same atomic batch.
The earlier backend suite subsequently passed all 32 tests with a single
worker. Swift 6.4 on WSL passed all 17 package tests, including five synthetic
OAuth wire-format tests. Swift emitted an existing test-stub Sendable warning.
A native transport now covers pinned discovery, public registration,
and code exchange with bounded responses and cancellation handling. After its
addition, all 21 Swift package tests passed; its synthetic tests do not prove
Cloudflare compatibility. The eventual app coordinator must still guard against
late results after sign-out. Provider metadata examples and the API guide differ
on issuer formatting and custom redirect support, which require staging evidence.
Read-only discovery on October 29 at the configured Ledge Top Access team's
public authorization-server metadata returned an HTTPS issuer, S256 and public
client authentication support, but did not advertise a registration endpoint.
This was not a request for a dedicated OAuth-enabled pilot application and does
not establish what its resource-scoped discovery will return. Registration and
callback behavior must be verified after a safely isolated test application is
prepared; the client currently rejects metadata without a registration endpoint.
The managed coordinator now keeps tokens in memory, clears local access at
sign-out, and attempts revocation. It reports uncertainty for failed or in-flight
exchanges; provider acknowledgement does not prove revocation. Its read-only
data transport is connected to the live-workspace model, but an empty reviewed
pin list and the disabled plist flag prevent activation. All 32 Swift package
tests and three Worker entrypoint tests passed, and an unsigned xtool build
against the Apple SDK succeeded after integration. The model cancels tracked
requests on sign-out and guards late responses; device lifecycle behavior still
needs validation. Provider revocation and callback behavior remain unverified on
the iPad. End-to-end
sign-in, Access ingress, and iPad behavior remain unverified.

## Local evidence

- 15 real-D1 mobile integration tests passed, including atomic redemption, scope and revocation races.
- One focused connector regression passed, confirming no registry or audit writes during validation.
- 15 Worker-mount, native-auth and visibility tests passed.
- 43 staging scaffold/preflight tests passed.
- Final full Operations TypeScript check passed after mount-test additions.
- Root checks: 14 workflow-policy tests, 18 visibility/host-admission tests and 56 deployment-guard tests passed. Some coverage overlaps the agent runs above.
- Independent source review found no remaining blocking source issue. Runtime ingress, deployment and device tests remain outstanding.
- An earlier D1 run hit a Windows 30-second timeout; the bounded rerun with a 120-second test budget passed. This is recorded separately from assertion results.

No feature-branch Actions, production deployment, migration, account policy change, or live business-data mutation was performed for this checkpoint. Private-repository branch protection was unavailable on the current GitHub plan; PR-only changes remain a working convention.
