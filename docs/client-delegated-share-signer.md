# Client-delegated public share signer

Status: implemented and contract-tested, but default-off. Public serving uses
`/client-share/<public-id>` plus the cookie-covered
`/client-share/api/shares/<public-id>/...` API namespace.

## Trust boundary

The Client Worker never receives `DELIVERY_TOKEN_SECRET`. Its authenticated
create route rechecks the client's exact workspace, identity, entitlement,
delegation, folder binding and opaque folder target, then calls the Operations
Worker through a named Cloudflare service-binding entrypoint. Operations
independently repeats the live D1 policy checks in the same statement that
creates the bearer.

The RPC accepts only opaque IDs, expected versions, expiry, optional label and
optional access code. It does not accept or return an R2 prefix. The returned
link uses `/client-share/<public-id>#<bearer>`, which is separate from staff
`/s/` links. Operations stores only the bearer hash; exact idempotent retries
derive the same bearer from the Operations-only secret and immutable random
share ID.

## Configuration and rollout

The Client Worker binding is:

```json
{
  "binding": "CLIENT_DELEGATED_SHARE_SIGNER",
  "service": "ltds-ops",
  "entrypoint": "ClientDelegatedShareSigner"
}
```

Both gates stay `false` until the complete surface has passed staging validation:

- Operations: `CLIENT_DELEGATED_SHARE_SIGNER_ENABLED`
- Client: `CLIENT_DELEGATED_SHARES_ENABLED`

Cloudflare requires the target entrypoint to exist before deploying the caller.
For a future staged rollout, deploy the compatible Operations export first,
then the Client Worker binding, migrate D1, validate both flags still return an
unavailable capability, and only enable after public live-reauthorization tests
pass. Roll back by disabling the Client flag first. Do not copy the Operations
token secret into Client configuration.

The Client Worker also requires a dedicated `CLIENT_DELEGATED_SHARE_SESSION_SECRET`
(at least 32 characters) and `CLIENT_DELEGATED_SHARE_KEY_ID`. The delegated
cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, and scoped to `/client-share/`;
it therefore never reaches the staff `/api/public` namespace.

The delegated surface currently supports folder history, progressive manifest
and media hydration, previews, thumbnails, Stream tickets, per-file downloads,
and subtree download summaries. Bulk ZIP creation and cloud transfer are not
available because their durable jobs are keyed to staff `shares`. The viewer
states that limitation and directs recipients to scoped per-file downloads.

Operations explicitly owns location-map consent on each new delegation.
Existing delegations and API callers that omit the setting stay map-disabled.
Delegated location list and asset requests repeat the full live delegation,
manager, entitlement, Project Alpha lineage, binding-version, target and bearer
share checks. They return only coordinates, opaque location references and
ordinary scoped delivery items; raw EXIF and storage keys are never returned.

Safe bulk ZIP support requires a separate delegated job/quota contract. The
current `bulk_download_jobs.share_id` is foreign-keyed to staff `shares`, and
the workflow payload, status lookup, archive read, cleanup and audit paths all
authorize against that staff share/version. Reusing those IDs would collapse
the two security namespaces. A future delegated contract must reauthorize the
live delegation, binding version, target, bearer share version and current
folder scope on create, status and archive download.

## Provisioning and recovery workflow

Migration `0130_client_delegated_share_provisioning.sql` adds browser-safe
target labels, fail-closed delegation location policies, and idempotent staff mutation receipts. The Operations Share
dialog can resolve an already authorized folder reference to one exact active
workspace binding, create an opaque target, and create a manager delegation.
It never returns `r2_prefix` or `relative_prefix`. Exact-root authority is an
explicit unchecked control; descendant-only is the default.

The Client Deliveries page lists only live target/delegation pairs that pass a
fresh policy check. It can create, list, and revoke its own `/client-share/`
links. The fragment-bearing URL is displayed only by the successful create
response, so clients must copy it then; history never reconstructs or exposes
the bearer.

Operations Administration lists safe labels, manager email, status, expiry,
and active-link counts. An administrator with global share permissions can
transfer a delegation to another currently authorized manager or revoke it.
Transfer preserves immutable creator provenance while every existing bearer
immediately follows the replacement delegation version and live entitlement.
Target/delegation writes are audited in `client_delegated_share_events` and
their idempotency keys are fingerprint-bound.

## Required validation before enabling

- RPC denies missing/malformed bindings and requests, IDOR attempts, revoked or
  stale membership/delegation/entitlement/binding/target state, and excess
  expiry or missing required access code.
- Exact idempotency retries return the same receipt and URL; key reuse with a
  different request fails with conflict.
- Responses and logs contain no R2 prefix, raw Operations secret or access code.
- Staff target/delegation list and folder-context responses contain no R2 or
  relative prefixes. Cross-workspace IDs and ambiguous folder bindings fail.
- Transfer accepts only a live replacement membership and a current qualifying
  entitlement; explicit deny precedence still wins.
- `/client-share/` session, manifest, media, download and revocation requests
  reauthorize the current delegation and share version on every request.
- Staff `/s/` cookies, routes and public IDs cannot replay in the client-share
  namespace, and client-share credentials cannot replay against staff routes.
