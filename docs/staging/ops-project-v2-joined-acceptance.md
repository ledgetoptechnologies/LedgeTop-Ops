# Operations joined Project-v2 acceptance

This is a manually invoked, staging-only acceptance harness for the joined
Operations route:

`POST /api/admin/project-alpha/projects/v2/commands`

It is not a scheduler, queue consumer, public route, client route, or
production synchronization path. It requires the explicit mutation gate
`OPS_ACCEPTANCE_ALLOW_MUTATIONS=allow` and refuses every origin except
`https://ops-staging.ledgetopdroneservices.com`. Do not run it against a
production hostname, even for a read-only check.

## Authenticated browser-context adapter

For an already-authenticated Operations browser, callers can use
`parseBrowserContextJoinedAcceptanceConfig` with
`runJoinedAcceptanceWithBrowserContext`. Supply a `browserContextFetcher` that
executes native browser `fetch` in that exact Operations origin, and a separate
ordinary `publicFetcher` for the reviewed public-link GETs. The adapter allows
the browser fetcher only for the fixed Ops origin and the session/command
routes; it gives public probes `credentials: "omit"`.

Browser-context mode rejects `OPS_SESSION_COOKIE`, `OPS_STORAGE_STATE`, and
`OPS_CF_ACCESS_JWT_ASSERTION`. It neither reads nor serializes cookies,
localStorage, Playwright storage state, or Access assertions, and never passes
credential headers to either fetcher. Native same-origin browser authentication
and the in-memory CSRF value from `/api/session` remain the only Operations
credential path. The existing validation, replay/conflict workflow, public-link
invariant, response bounds, and sanitized report are unchanged.

## September 19, 2026 current joined-window gate recheck

The Ops staging Cloudflare Access policy **Ledge Top Staging Staff Access**
explicitly includes `beaukoltz@ledgetopdroneservices.com`. A live in-app
session loaded the authenticated administrator view for Beau Koltz. This
proves the authenticated delivery path, not
Project-v2 authority or acceptance.

The exact PA staging candidate remains
`ff42c3432f39e50e92058b21d7e4942c26f5b355`. Fresh nonmutating capability
probes with key **#8** returned HTTP `200`, `apiVersion: 2`,
`implementedEndpointCount: 23`, and `grantedCapabilityCount: 1`. PA therefore
remains Directory-only and is not in the required Project-only window. No
Project authority, Ops route, selected connection, or mutation was
activated.

The local Operations check and build pass. Focused diagnosis of
`authenticated-delivery-change-notifications` (`batches forty together`)
passes in about 100 seconds; the delay comes from roughly 90 sequential
Miniflare/D1 operations on Windows, not a deadlock or functional regression.
The pure-function batch suite passed 11 tests and the access-code suite passed
2 tests. The broad suite has no trustworthy complete total. GitHub PR98 checks
were rejected in about two seconds by the account spending/build limit, not by
code failures. This harness has not run and no acceptance is claimed.

## September 19–20, 2026 base Project window checkpoint

The exact PA candidate remains
`ff42c3432f39e50e92058b21d7e4942c26f5b355`. The deliberately bounded base
Project window had exactly these five PA flags enabled: `APP_API_V2_PROJECTS_CREATE_ENABLED`, `APP_API_V2_PROJECTS_READ_ENABLED`, `APP_API_V2_PROJECTS_WRITE_ENABLED`,
`APP_API_V2_PROJECTS_BINDING_STATUS_ENABLED`, and `APP_API_V2_PROJECTS_INVENTORY_ENABLED`. A capabilities request returned HTTP `200`,
`apiVersion: 2`, `implementedEndpointCount: 6`, and
`grantedCapabilityCount: 6`.

The Project inventory GET returned an empty-body `409` because the deliberately
stale browser-edited binding remains. No joined mutation ran, and static
generation must not be guessed from this result. This is a read-only base
Project checkpoint, not joined acceptance.

Operations has a local parser for the newer PA stale-binding recovery contract.
It treats only exact, trusted, identity- and request-correlated JSON envelopes as
typed discovery/recovery evidence. The observed empty-body `409` above remains
an ordinary conflict, and the parser does not issue a refresh, retry the page,
or otherwise mutate PA. A future staging rehearsal must exercise the exact JSON
contract before any joined recovery orchestration is considered.

## September 20, 2026 recovery-contract staging proof

PA candidate `2956779ce6bb40e95aeb76704018b470f3f42a7b` was published by the
staging-only Docker run `35548372193`; the web, cron, and database images built,
both Trivy scans passed, the staging control rebuild completed, migrations exited
zero, and the web/database containers were healthy. The server remained in the
exact five-flag base Project window.

A nonmutating key-#8 probe then exercised the new contract. Inventory returned
the exact six-field trusted `409 binding_stale` discovery envelope. Binding
status returned the exact nine-field trusted recovery envelope with matching
source/application/history identity, canonical authorization generation,
matching external identity, valid public ID, valid pinned and live revisions, a
strictly newer live revision, a lowercase projection hash, and `no-store`.
No static generation was guessed and no PA mutation ran.

Operations commit `0bb69c6` adds the matching strict adapter. Its focused
transport suite passed 14 tests and the Operations TypeScript check passed. The
adapter was deployed first under the Project-v2 staging config and then restored
to the default-off config after the prior internal Operations login had expired.
The selected PA connection was enabled only during that bounded attempt, then
disabled again. Temporary native-authority packet
`staging-authority-project-v2-20260921-005000z` was provisioned only after a
zero-fence/zero-pending preflight and safely revoked without a Project command.
Final readback showed inactive admission and grants at versions `6`/`6`, Project
generation `6`, zero pending/leased work, zero directory write fences, and one
immutable revoke receipt. Joined mutation remains pending a fresh authenticated
Operations staging session.

PA PR184's CodeQL, JavaScript analysis, Python analysis, gitleaks, and smoke
checks all passed. PR98's ten GitHub jobs were rejected before startup by the
account payment/spending limit; this is not a code-test failure.

## September 19, 2026 readiness checkpoint

The exact PA candidate for this run is
`ff42c3432f39e50e92058b21d7e4942c26f5b355`; the Operations candidate starts
from `56cfe9a`. Record the deployed PA version before any mutation. A healthy
container on an older image is not acceptable evidence.

PA candidate deployment parity is now proven: staging-only Docker workflow
`35361793571` passed both Trivy scans, the staging rebuild completed, and the
healthy web container reports `APP_VERSION=ff42c34`. Operations staging Worker
version `9aa05566-bf5d-4eba-b2fd-20c8a11d8eb0` now contains the reviewed
fail-closed Incoming host gate fix from `56cfe9a` and the SPA assets needed for
the authenticated UI. Version inspection preserved the existing two secrets,
the same staging D1/R2 bindings, and added only the `ASSETS` binding. The
staging Access policy now permits the exact existing synthetic-owner email in
addition to the prior tester group. The app loads and correctly rejects the
still-active unmatched Gmail tester identity. A fresh matching-identity sign-in
and subject binding remain pending before the native-authority packet may be
generated or applied.

The former `NATIVE_STAFF_ONBOARDING_AUD` prerequisite is not part of this
acceptance window. No native onboarding route is mounted, and the accepted
assertion remains exactly one human-app assertion for the Operations staff
audience plus an existing native admission. Focused auth and staging-config
tests and an independent security review confirm that removing the unused
value did not broaden the accepted identity boundary.

The PA side is ready for the joined proof only after the staging server
disables archive/restore and enables Project binding for the bounded window.
The application-bound Project key is limited to capabilities discovery,
Project read/create/write, identity binding, binding status, and inventory;
archive, restore, refresh, Directory, and unrelated scopes must remain absent.
Operations staging Access/deployment is still pending, so this harness has not
run and PA PR184 must not merge before its result. Keep the existing public-link
probe mandatory: it must return the same status, content type, and bounded body
hash before and after the joined mutation.

## Required operator inputs

The legacy Node CLI (not the browser-context adapter) accepts an authenticated
Operations browser storage-state file or short-lived Cloudflare Access cookie.
Only the secure `CF_Authorization` cookie for the exact staging Operations host
is accepted; that legacy path never imports or forwards unrelated browser
cookies, and never prints or stores the cookie. Do not provide those values to
browser-context mode:

```powershell
$env:OPS_BASE_URL = "https://ops-staging.ledgetopdroneservices.com"
$env:OPS_STORAGE_STATE = ".backups/staging-ops-storage-state.json"
# Alternatively: $env:OPS_SESSION_COOKIE = "CF_Authorization=<staging value>"
$env:OPS_ACCEPTANCE_ALLOW_MUTATIONS = "allow"
$env:OPS_ACCEPTANCE_PREFIX = "ops-joined-acceptance-20260918"
$env:OPS_PROJECT_ALPHA_SOURCE_ID = "project-alpha:staging"
$env:OPS_PROJECT_ALPHA_APPLICATION_ID = "<staging application UUID>"
$env:OPS_ACCEPTANCE_AUTHORIZATION_GENERATION = "<current reviewed grant generation>"
$env:OPS_ACCEPTANCE_SCOPES_JSON = '[{"scopeKind":"business_area","businessAreaId":"<staging business area>","divisionId":null}]'
$env:OPS_ACCEPTANCE_ORGANIZATION_RECORD_ID = "<existing mapped organization record>"
$env:OPS_ACCEPTANCE_ORGANIZATION_PUBLIC_ID = "<reviewed PA organization public ID>"
$env:OPS_ACCEPTANCE_ORGANIZATION_REVISION = "<reviewed revision>"
$env:OPS_ACCEPTANCE_ORGANIZATION_PROJECTION_SHA256 = "<reviewed projection hash>"
$env:OPS_ACCEPTANCE_PUBLIC_LINK_URL = "<existing reviewed staging public link>"
```

The `/api/session` request runs first through the same authenticated session.
The harness validates the bounded response, administrator status, and
`integrations.manage` permission, then keeps the returned CSRF token only in
memory. Every command POST includes the exact staging `Origin`,
`X-CSRF-Token`, cookie, and command-matching `Idempotency-Key`. Cloudflare
injects `Cf-Access-Jwt-Assertion` after validating `CF_Authorization`; the
harness does not require an operator to extract or copy that assertion. For a
controlled non-edge test only, an assertion may be supplied via
`OPS_CF_ACCESS_JWT_ASSERTION`; it is validated in memory and never emitted.

If a client relation is part of the reviewed staging fixture, supply the
matching `OPS_ACCEPTANCE_CLIENT_RECORD_ID`,
`OPS_ACCEPTANCE_CLIENT_PUBLIC_ID`, `OPS_ACCEPTANCE_CLIENT_REVISION`, and
`OPS_ACCEPTANCE_CLIENT_PROJECTION_SHA256` values together. The harness refuses
partial relation proofs.

To prove public-link preservation, supply the reviewed existing staging URL in
`OPS_ACCEPTANCE_PUBLIC_LINK_URL`. It is used only for two GET probes and is
never included in the report. The URL must be HTTPS on an approved staging
public host; production and Operations origins are rejected. The harness
requires the link to return 200 before the mutation and fails unless its status,
content type, and bounded response hash remain identical afterward.

## Run

```powershell
npm run staging:ops-project-v2:joined:test
npm run staging:ops-project-v2:joined -- --output .backups/staging-acceptance/ops-project-v2-joined.json
```

The run creates one fresh, prefixed disposable Project through Operations,
then sends the exact same command and idempotency key again. It finally sends a
changed body with the same command ID and requires a `command_id` conflict.
The first successful response must include the Operations read-settlement and
canonical-activation evidence; the exact replay must report `replayed: true`.
The route itself performs the PA dispatch, read settlement, and local canonical
activation inside the reviewed staging authority window.

The bounded report contains only statuses, generated command/external IDs,
request/response hashes, sanitized receipt IDs, activation version, and public
link status/body hashes. It excludes cookies, API keys, Access assertions,
private URLs, request bodies, and customer data. Do not paste the report into a
ticket if an operator has modified the script to log raw responses.

## Required staging window and cleanup

Before running, verify the Operations route flag and the selected Project Alpha
connection are enabled only for staging, and that the native authority packet
and least-privilege PA Project key are active. The PA key must have only the
capabilities required by the selected create/read/write/bind window; lifecycle
flags and Directory flags are separate windows.

After the run, disable the route and selected connection, confirm there are no
pending or leased commands for the acceptance actor, and apply the reviewed
native-authority revoke packet. Keep the immutable ledger evidence, but do not
delete the generated Project or rewrite its history. This harness does not
provide rollback or cleanup mutations.

## September 21, 2026 joined attempt

The matching staging administrator identity authenticated successfully, and
the browser-context transport reached the protected Operations command route
without copying a cookie, Access assertion, or storage state. PA reported the
current Project authorization generation as `5`. Operations accepted fresh
synthetic command `9eb7ba9b-5fb2-4cfb-a2b1-4293cf8deb8e`, reserved it, and
dispatched it once. PA returned an empty-body `409`; Operations therefore
recorded the command as `uncertain` and did not create a canonical activation
or claim success. The generation remained `5`, ruling out a concurrent
generation advance. Source inspection narrows the remaining create-time
conflict to PA's application-scoped identity or Directory relation proof
fences; the exact Directory binding must be read back in a Directory-only
window before another fresh command is authorized.

The existing staging public link returned `200 text/html` before and after the
attempt with the same bounded body hash. Its URL and token were never emitted
or stored in the report. The temporary browser bridge assets were removed, the
Project route restored to default-off, and the selected PA connection disabled.
Worker version `0e60b962-ab56-4d25-a924-25dbd4be5b1c` is the restored default-
off deployment. Final D1 readback proved admission inactive at version `8`,
Project grant inactive at version `8`, Project grant generation `8`, Directory
grant inactive, zero Project/Directory pending or leased work, zero Directory
write fences, exactly one revoke receipt, and no pending revoke migration.
This is preserved negative acceptance evidence, not a passing joined result.

## September 21, 2026 — typed Project conflict and closed staging window

The current Operations candidate is PR98 head `de1e9db9ba0363834b1f4600fca9eb685fc121ae`; its exact GitHub workflow `35561740004` passed all ten jobs. PA PR184 head is `3b43e1275e3b248979876ace56ca38e6e383f52c` and its required checks are green. A supported `cloudflared` human Access login succeeded for the staging Operations origin; no cookie, Access assertion, or browser storage state was copied into the harness.

The first joined attempt was blocked before mutation because the harness omitted the canonical PA staging host from its origin configuration. The harness now accepts `STAGING_PROJECT_ALPHA_ORIGIN`, and its unit suite is 10/10. This corrected configuration was then exercised with fresh command `3b785ca6-96a8-4103-b2e5-4a60ce5cae41`. PA made one attempt and returned terminal typed `relationship_proof_conflict` HTTP `409`, correlated to request `fcd6627d-405d-477b-8486-d51140a2d6bf`. There was no success receipt and no Operations activation. The authoritative PA Project authorization generation was `5`.

The independently observed Project binding remains stale: external ID `pa-acceptance-p184fix-20260917a:33b8e6f6-8beb-4190-a24f-abdd7b401112` is revision `2` while the live revision is `10`, and the binding reports generation `5`. That proves the generation without guessing, but it is separate from the typed relationship-proof rejection and is not evidence that the terminal command was absent. The runner stopped before the public-link probe/command on the first harness failure; the second run attempted only Project creation after its pre-command public probe. A separate post-attempt probe returned `200 text/html`, `3266` bytes, and the unchanged SHA-256 `5632e883d6fe3ca72c68e900e8e6b76561c07d454605e728c4a765d07a383464`.

Cleanup completed after the bounded attempt: the selected PA connection secret is empty, default-off Operations version `de550f0c-f5ec-452c-a4db-3c61bc7cffc2` is deployed, and the native-authority revoke was applied. Final readback shows admission, Project grant, and Project generation at inactive version `10`, Directory grant inactive, zero actor fences, zero Project/Directory pending or leased outbox rows, zero live proofs, and one immutable revoke receipt. Do not call this joined acceptance passing or merge-ready.

The remaining gate is deliberately narrow: enable only PA Directory read and binding-status flags alongside the bounded Project window, read the current organization proof with key #9, restore the Project-only flags if desired, issue a fresh authority packet, and rerun with a fresh command. Do not retry the uncertain or terminal command IDs.
