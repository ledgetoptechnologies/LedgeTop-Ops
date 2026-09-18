# Project Alpha Directory API v2 staging acceptance

`npm run staging:pa-api-v2:directory:acceptance` is an operator-only staging
rehearsal. It neither deploys a Worker nor makes a hard-delete request. With no
token it makes just one unauthenticated capabilities request and requires the
expected `401` response.

## Current staging prerequisite checkpoint (September 18, 2026)

- Dedicated Directory key **#9** has the exact 23-scope Directory/capabilities
  set required by this rehearsal. Its secret is DPAPI-protected outside the
  repository and has no plaintext file copy.
- Key #9 was dry-run bound and then applied to existing staging application
  `150cb108-af37-4973-ab6e-f6d991a6e8c8`. Its authenticated capabilities
  probe now returns HTTP 200 with the expected source, application, and history
  identities.
- The tunnel ingress again maps `pa-staging.ledgetoptechnologies.com` to the
  staging web container. An independent public probe returns HTTP 200 and the
  expected Project Alpha login page, so the Cloudflare-hosted Operations path
  is no longer blocked by the former public 404.
- The first credentialed Directory rehearsal failed closed before mutation with
  `directory_capabilities_contract_mismatch`. After the host was corrected to
  the exact Directory-only window, the authenticated preflight returned the
  exact 23 capabilities and endpoints, 22 Directory/binding endpoints, zero
  Project endpoints, and matching source/application/history identity. The
  subsequent live rehearsal passed all 71 paced requests with zero `429`
  responses or retries. It proved the complete create/read/update/binding/
  relationship/lifecycle/replay/conflict contract and retained only disposable
  soft-lifecycle records plus immutable audit history. The governed Operations
  bootstrap is now the next gate; do not switch to the Project-only window
  until that acknowledged mapping and replay evidence are complete.

A mutable rehearsal requires these secret-store values. Do not put any of them
on a command line, in a fixture, or in CI output:

- `PA_DIRECTORY_BASE_URL`: a root HTTPS Project Alpha staging origin.
- `PA_DIRECTORY_API_TOKEN`: a dedicated, fine-grained, non-`full` key.
- `PA_DIRECTORY_ACCEPTANCE_ALLOW_MUTATIONS=allow` and a new prefix beginning
  `pa-directory-acceptance-`.
- `PA_SOURCE_INSTANCE_ID`, `PA_APPLICATION_ID`, and `PA_HISTORY_EPOCH`: the
  bound application identity UUIDs.
- `PA_DIRECTORY_ORGANIZATION_PROFILE_JSON`,
  `PA_DIRECTORY_MOVE_ORGANIZATION_PROFILE_JSON`, and
  `PA_DIRECTORY_CLIENT_PROFILE_JSON`: complete disposable profiles.

Profiles are preflighted before the capabilities call or any mutation using the
same constraints as Project Alpha: valid UTF-8, no Unicode control characters,
PHP-compatible trimming, scalar and UTF-8 byte limits, canonical valid email
(including dot-atom checks such as rejecting `a..b@example.com` and the PHP-
invalid numeric-leading final label in `a@b.1`), and the
`unknown`/`business`/`consumer` client-type enum. The two organization names
must differ case-insensitively. Organization base names can be at most 109
scalar values (client base names, which are only updated, can be 110): the
runner appends ` <32-hex> primary` and ` <32-hex> move` to its two organization
create names, making every created organization run-unique, and appends
` <32-hex> update` for profile updates. This reservation ensures a locally
accepted configuration cannot reach a later create or update and then fail
because the generated name is too long.

The Node preflight intentionally uses a conservative, documented subset of
PHP `FILTER_VALIDATE_EMAIL`: conventional ASCII dot-atoms and DNS domains with
an alphabetic-leading final label. It may reject unusual addresses PHP accepts
(for example quoted local parts or address literals), but it rejects the
standard malformed local/domain forms Project Alpha rejects before any request
or mutation is attempted.

If Cloudflare Access protects the staging origin, set both
`PA_DIRECTORY_CF_ACCESS_CLIENT_ID` and
`PA_DIRECTORY_CF_ACCESS_CLIENT_SECRET`; a partial pair fails closed.

The live runner spaces requests by 1.1 seconds by default, below Project
Alpha's normal 60-requests-per-minute per-key limit even though each replay
probe intentionally sends three calls. A `429` is retried only within a
bounded four-retry budget using `Retry-After` when present and capped backoff
otherwise. The sanitized report records request, `429`, retry, and delay
counts. Tests may set `PA_DIRECTORY_ACCEPTANCE_MIN_REQUEST_INTERVAL_MS=0`;
operators must not disable pacing for a live rehearsal merely to finish it
faster or raise PA's production limit to accommodate the test.

Before mutating, the runner compares the complete ordered Project Alpha
capabilities document with the exact route and scope matrix from commit
`33e623ac`. That matrix includes the default-off `APP_API_V2_*` directory
flags exported as `DIRECTORY_FEATURE_FLAGS`. Capabilities exposes an enabled
flag through its route/scope mapping, not through a raw feature-flag object;
extra scopes, missing scopes, route aliases, omitted identity headers, or
invented fields fail the run. The revoke routes are only verified in discovery:
the rehearsal never invokes them.

Every command gets a fresh UUID; replay deliberately reuses that command ID
with the identical body, then reuses it once more with a changed body. Server
generated public IDs, revisions, and authorization generations are carried
forward instead of being supplied in a fixture; final inventory projection
hashes are dynamically verified and retained only as hashes in evidence.
The mutable sequence verifies organization and client create (`201`), replay
(`200`), changed-body conflict (`409`), exact reads, profile updates, automatic
create bindings, stale binding status plus refresh, client
assign/move/remove readback, soft archive/restore replay/conflict, persistent
tombstone/no-auto-rebind behavior, and the required explicit rebind.
It asserts each source transition: create is revision `1` and advances the
authorization generation once; profile update advances only revision; refresh,
relationship mutation, archive/tombstone, and rebind each advance generation
once; restore advances only revision. Revisions and generations are restricted
to signed-64-bit decimal values.

Write profiles remain exact string-valued contracts. Readback follows PA's
canonical database projection for optional email, phone, and second address
line fields: a submitted empty string is returned as JSON `null`. The runner
models only those documented nullable fields and retains exact key order,
shape, and value checks everywhere else.

Final inventory uses `type=all&limit=2`; the three disposable records force a
bounded full pagination walk. It requires sorted, duplicate-free resources in
the caller's application scope, requires each generated record, and accepts
the Directory inventory route's 256 KiB response limit (all other route
responses are bounded to 64 KiB). Its authorization generation is pinned across
all pages; a concurrent change causes a fail-closed result instead of mixed
inventory evidence.

Evidence contains only response statuses, request IDs, command-body and final
projection SHA-256 digests, and page/generation counts. It excludes bearer tokens, Access
credentials, profile contents, external IDs, public IDs, and command bodies.
Archive is a soft lifecycle event: retain the disposable records, bindings,
receipts, tombstones, and audit history; do not hard-delete them after a run.
