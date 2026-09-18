# Operations joined Project-v2 acceptance

This is a manually invoked, staging-only acceptance harness for the joined
Operations route:

`POST /api/admin/project-alpha/projects/v2/commands`

It is not a scheduler, queue consumer, public route, client route, or
production synchronization path. It requires the explicit mutation gate
`OPS_ACCEPTANCE_ALLOW_MUTATIONS=allow` and refuses every origin except
`https://ops-staging.ledgetopdroneservices.com`. Do not run it against a
production hostname, even for a read-only check.

## September 18, 2026 readiness checkpoint

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

Use an authenticated Operations browser storage-state file, or provide the
short-lived Cloudflare Access cookie through the environment. Only the secure
`CF_Authorization` cookie for the exact staging Operations host is accepted;
the harness never imports or forwards unrelated browser cookies. The harness
never prints or stores the cookie:

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
