# 3D Viewer integration boundary

Status: **contract foundation only; not enabled or deployed**.

The 3D Viewer remains an independently deployed service and repository. LTDS
Operations owns people, verified identities, hierarchy, projects, permissions,
and the decision that a caller may view or administer a model. The Viewer owns
model identity, versions, providers, imports, model assets, rendering, Viewer
sessions, Viewer public shares, and direct asset delivery.

This boundary deliberately reuses the two sharing concepts used by Delivery:

- **Grant to Client Portal** is an authenticated LTDS entitlement. It is based
  on an opaque organization, department, client, project, or verified-principal
  ID and current source versions. Email is display/notification metadata only.
- **Create public link** creates an independent Viewer bearer share with its own
  expiry, optional access code, permissions, audit history, and revocation.

The two objects must never be interchangeable. Revoking an LTDS authenticated
grant stops future internal Viewer-session issuance. Revoking a Viewer public
share stops that share without changing LTDS membership or an Operations public
share.

## Data plane and control plane

```text
Browser --LTDS session--> Operations / Client Portal
                              |
                              | signed service request (small JSON only)
                              v
                         Viewer /api/v1
                              |
Browser --short session------>+-- Nginx -- model assets
```

No model, point-cloud, texture, tile, or other large Viewer asset may pass
through an LTDS Worker. After LTDS authorizes the human, it requests a scoped,
short-lived Viewer session. The browser then loads the Viewer and assets
directly through Cloudflare/Nginx. Viewer asset endpoints should support byte
ranges where their formats benefit from them.

## Stable identifiers and local associations

The Viewer assigns opaque canonical `modelId` and `modelVersionId` values. LTDS
stores only those opaque values and an optimistic Viewer resource version when
associating a model to a Project Alpha project or other LTDS resource. Neither
repository reads the other repository's database, filesystem paths, numeric
row IDs, or provider credentials.

An LTDS association should contain, at minimum:

- opaque association ID and version;
- opaque Viewer model ID and observed model version;
- opaque Project Alpha workspace/project public IDs and source versions;
- lifecycle state (`active`, `revoked`, or source-stale);
- creator/revoker, timestamps, reason, idempotency key, and audit correlation.

The Viewer owns whether a public share follows the latest model version or is
pinned to a specific version. LTDS must not infer model identity from a WebODM
directory name.

## Service authentication v1

LTDS-to-Viewer calls use an HTTPS-only HMAC service credential that is never
sent to a browser. Version 1 signs these newline-separated bytes exactly:

```text
ltds-viewer-service-v1
<UPPERCASE_METHOD>
<PATH_WITH_QUERY>
<UNIX_TIMESTAMP_SECONDS>
<RANDOM_NONCE>
<LOWERCASE_HEX_SHA256_OF_EXACT_BODY_BYTES>
```

Required headers are `X-LTDS-Key-Id`, `X-LTDS-Timestamp`, `X-LTDS-Nonce`,
`X-LTDS-Content-SHA256`, and `X-LTDS-Signature`. The signature is base64url
HMAC-SHA-256. The Viewer compares hashes/signatures in constant time, rejects
timestamps outside the configured short skew window, and consumes `(keyId,
nonce)` once. Method, path including query, and exact request bytes are all
covered. Key rotation must support an explicit overlap; it must never fall back
to unsigned requests.

Every mutation also requires an `Idempotency-Key` and stores its canonical
request fingerprint and result. Same key/same fingerprint returns the original
result; same key/different fingerprint returns `409`.

## Minimum API v1 responsibilities

Exact response schemas must be frozen with shared fixtures before enablement,
but the boundary exposes these responsibilities:

- bounded model list/detail and import status;
- create/renew a one-time internal session grant for an already-authorized
  opaque LTDS subject and audience (`ops` or `client`);
- create/list/revoke Viewer-owned public shares;
- enqueue provider-agnostic imports and recovery rescans;
- unregister a model without deleting WebODM/Terra source data;
- liveness/readiness and redacted audit/diagnostic correlation.

An internal session request includes model ID, opaque LTDS subject, audience,
bounded permissions, expiration, and correlation ID. The Viewer returns a
single-use grant with a very short redemption window. Redemption creates an
approximately 30-minute Viewer session. LTDS silently renews only after
reauthorizing the current identity, hierarchy, source grant/association,
denylist state, and model lifecycle. A Viewer session may not outlive any
explicit LTDS or Viewer expiry used to authorize it.

The browser never receives the service key, provider credentials, storage
paths, or a model-wide asset credential.

## Required authorization checks

Before Operations issues or renews an internal Viewer session it must verify:

1. the Cloudflare Access assertion and exact human subject;
2. the active LTDS identity/account and applicable staff or portal capability;
3. the active model association and current Project Alpha hierarchy/source
   versions;
4. the exact authenticated grant for client access, if applicable;
5. explicit denylist, suspension, revocation, and expiry state;
6. the requested model and permission set are no broader than the association.

The Viewer independently verifies that the model/version is live before
redeeming or serving a session. Authorization defaults to deny in both systems.

## Browser/session behavior

- Use a short-lived, HttpOnly, Secure session or an equivalently protected
  same-origin redemption flow; never place a service credential in a URL.
- Renew before expiry while the LTDS session and authorization remain valid.
- Keep the current credential until it expires if a renewal attempt has a
  retryable failure, then retry with bounded backoff.
- Preserve camera, selected layers, visibility, and relevant tool state across
  renewal or an unavoidable reload.
- Clear protected Viewer state immediately on a definitive authorization,
  revocation, source-removal, or deny decision.

## Public shares

Viewer public shares use a Viewer-specific URL, token audience/cookie path,
rate limit, and audit stream. Public IDs contain at least 128 bits of entropy;
only a token hash is stored. Each protected request rechecks share existence,
expiry, revocation, model/version lifecycle, and permissions. Access-code
verification is rate-limited. Public errors distinguish expiry, revocation,
access-code requirements, removed models, and retryable service failures
without making arbitrary identifiers enumerable.

## Rollout gate

Do not enable integration until all of the following are recorded against exact
LTDS and Viewer commits:

- shared request/response and signature fixtures pass independently in both
  repositories;
- key rotation, timestamp expiry, body/path tampering, nonce replay,
  idempotent replay/conflict, and redacted-log tests pass;
- staff and client cross-workspace/project/model escalation tests deny;
- grant, source-version, association, identity-denial, and public-share
  revocation stop access immediately;
- session renewal and Viewer state preservation pass on desktop and mobile;
- large assets are proven to travel Browser -> Cloudflare -> Nginx -> Viewer,
  never through an LTDS Worker;
- Viewer `/health` and `/ready`, Docker health checks, immutable image tags,
  rollback, persistent storage, and read-only provider mounts are verified;
- feature flags remain off until migrations, secrets, routes, DNS/origin
  protection, CORS, rate limits, monitoring, and operator rollback are ready.

The current separate Viewer worktree contains early registry, version, import,
service-HMAC, session-grant, and audit foundations. They are not an LTDS release
dependency and must be reviewed and completed in the Viewer repository before
this contract is enabled.
