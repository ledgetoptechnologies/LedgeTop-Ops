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
shown because their durable jobs are keyed to staff `shares`. Location results
are empty until a separate delegated-location privacy policy is explicitly
modeled; this prevents a client-created link from inheriting staff map consent.

## Required validation before enabling

- RPC denies missing/malformed bindings and requests, IDOR attempts, revoked or
  stale membership/delegation/entitlement/binding/target state, and excess
  expiry or missing required access code.
- Exact idempotency retries return the same receipt and URL; key reuse with a
  different request fails with conflict.
- Responses and logs contain no R2 prefix, raw Operations secret or access code.
- `/client-share/` session, manifest, media, download and revocation requests
  reauthorize the current delegation and share version on every request.
- Staff `/s/` cookies, routes and public IDs cannot replay in the client-share
  namespace, and client-share credentials cannot replay against staff routes.
