# Project Alpha integration

The approved next-generation ownership, service-catalog, pricing-hint, and
draft-quote command contract is documented in
[the locked client portal v2 compatibility contract](client-portal-v2-architecture.md).
The LTDS caller and immutable receipt ledger are implemented behind
`PROJECT_ALPHA_DRAFT_QUOTES_ENABLED=false`. Project Alpha has not yet
implemented the compatible write endpoint, so the integration must remain
disabled until the contract tests below pass in staging.

## Client request pilot boundary

Project Alpha is read-only from LTDS for the client-request pilot. Staff
manually create PA projects, on-demand quotes, contracts, and invoices. LTDS
may verify and link an existing quote reference with an authenticated `GET`,
but it does not create or mutate those records and does not own financial
communications. The LTDS operational estimate is expressly non-binding; client
confirmation, final LTDS approval, and verified PA quote linkage are separate
events. See [the client request pilot contract](client-portal.md).

Project Alpha is authoritative for Business Units, Projects, Project Team memberships, Operations, Tasks, assignments, and external access entitlements. This repository stores a last-known-good, read-only D1 projection.

## Sanitized Service Library projection (implemented, disabled)

LTDS accepts a server-only catalog v2 projection at
`POST /api/internal/project-alpha/catalog-v2`. The receiver is disabled unless
`PROJECT_ALPHA_CATALOG_SYNC_ENABLED` is exactly `true`. It is not a browser API,
has no CORS allowance, and is separate from client-session authentication.
Configure a dedicated Cloudflare Access service application/audience in
`PROJECT_ALPHA_CATALOG_ACCESS_TEAM_DOMAIN` and
`PROJECT_ALPHA_CATALOG_ACCESS_AUD`. Store a unique secret of at least 32 bytes
as `PROJECT_ALPHA_CATALOG_HMAC_SECRET`; do not reuse the Operations projection,
pricing-preview, or draft-quote secrets. Both systems use the same bounded
deployment identifier in `PROJECT_ALPHA_CATALOG_APPLICATION_KEY`.

Every request is JSON no larger than 128 KiB and carries:

```text
Cf-Access-Client-Id / Cf-Access-Client-Secret: dedicated service token
Cf-Access-Jwt-Assertion: issued by the dedicated Access application
X-PA-Timestamp: current ISO timestamp (five-minute window)
X-PA-Delivery-ID: exact deliveryId from the body
X-PA-Signature: sha256=<lowercase HMAC-SHA-256 hex>
signature input: <X-PA-Timestamp>.<exact request body bytes>
```

The strict envelope has `schemaVersion: 2`, `applicationKey`, `deliveryId`,
`occurredAt`, `sourceGeneration`, `sourceSequence`, and `kind`. Unknown fields
fail validation and IDs are opaque public IDs, never Project Alpha numeric IDs.

Snapshot pages use `kind: "snapshot.page"` plus `snapshotHash`, `pageNumber`,
`pageCount`, `itemCount`, and up to 50 `items`. A snapshot is capped at 100
pages and 500 items. Pages remain invisible in staging. After every page is
acknowledged, Project Alpha sends `kind: "snapshot.activate"` with the same
hash/counts/generation/sequence. LTDS verifies contiguous page coverage and the
total count, then swaps the active catalog and checkpoint in one D1 batch. An
interrupted generation never changes browser catalog reads.

Incremental messages use `kind: "event"` and one strict `event`. An upsert item
contains exactly `publicId`, `sourceVersion`, `name`, nullable `summary`, and
`questions`. A tombstone contains only `action: "tombstone"`, `publicId`, and
`sourceVersion`. Events must match the active `sourceGeneration` and use the
next contiguous `sourceSequence`; gaps and stale deliveries return 409 so the
producer retries or sends a fresh snapshot. Delivery receipts bind an ID to the
exact payload hash: identical retries return success and changed reuse returns
409.

Each item allows 1–10 plain-text questions. Types are `text`, `number`,
`boolean`, `select`, and wire-format `multi-select` (stored as `multi_select`
for the existing renderer). Lengths, numeric bounds, option counts, duplicate
IDs/options, control characters, bidi controls, and markup are rejected. The
contract cannot carry unit prices, internal fulfillment/work activities,
compensation, margins, taxes, raw pricing rules, credentials, or database IDs.

The public client endpoint remains read-only and request-v2 submission still
requires the selected `sourceVersion` to be active. Existing draft snapshots
remain immutable, while a catalog change makes stale draft submission fail 422
until the client reviews the current version.

## Portal hierarchy and entitlement projection (implemented, disabled)

LTDS accepts the separate portal-v2 projection only at
`POST /api/internal/project-alpha/portal-v2`. The receiver hard-404s before
reading the request body or D1 unless `PROJECT_ALPHA_PORTAL_SYNC_ENABLED` is
exactly `true` and all five dedicated configuration values are present:

```text
PROJECT_ALPHA_PORTAL_APPLICATION_KEY
PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN
PROJECT_ALPHA_PORTAL_ACCESS_AUD
PROJECT_ALPHA_PORTAL_HMAC_SECRET (32+ bytes, secret)
PROJECT_ALPHA_PORTAL_SYNC_ENABLED=false
```

This flag only opens the server-to-server inbox. It does not enable client
hierarchy reads; `CLIENT_PORTAL_HIERARCHY_V2_ENABLED` remains an independent,
default-off authorization cutover. Use a separate Access service application,
service token, application key, audience, and HMAC secret from catalog, pricing,
draft-quote, Operations projection, and browser credentials.

Requests are JSON up to 256 KiB. The Access assertion must have the configured
exact issuer and audience. Headers include a current ISO `X-PA-Timestamp`
(five-minute window), body-matching `X-PA-Delivery-ID`, and:

```text
X-PA-Signature: sha256=<lowercase HMAC-SHA-256 hex>
signature input: <timestamp>\nPOST\n/api/internal/project-alpha/portal-v2\n<exact body bytes>
```

The strict schema-v2 envelope carries an opaque `workspaceId`, delivery ID,
source generation, and monotonic per-workspace source sequence. A snapshot page
repeats one immutable workspace descriptor and contains bounded arrays of:

- directory entities: organization, standalone client, department, client,
  contact, and project, each with opaque public ID, source version, active
  state, parent public ID, and client-safe display name;
- portal principals: opaque public ID, email hint, display name, source version,
  and active state; and
- explicit scoped entitlement intents. Allowed scopes are workspace,
  organization, department, client, and project. Allowed capabilities are the
  six values enforced by `workspace-v2.ts`.

The complete snapshot is limited to 100 pages, 100 records per page, and 2,000
records. Pages are invisible until `snapshot.activate` proves contiguous page
coverage and exact total counts. LTDS validates a single exact root, globally
unique public IDs inside the workspace, bounded acyclic parentage, principal
references, and live entitlement scopes, then switches the directory,
workspace, principal intent, entitlement intent, and both checkpoints in one D1
batch. Interrupted or invalid generations leave the prior checkpoint intact.

Incremental events carry exactly one workspace, entity, principal, or
entitlement upsert/tombstone. They must match the active source generation and
the next contiguous source sequence. A gap, stale event, reparented workspace,
or changed delivery-ID payload returns 409. Each event creates a new immutable
directory generation and advances authorization state atomically. Identical
delivery retries are acknowledged from the exact-payload receipt.

The same activated projection can supply the Operations public-share
notification-recipient typeahead when the independent
`DELIVERY_SHARE_DIRECTORY_RECIPIENTS_ENABLED` flag is enabled. Alpha must send
stable opaque principal IDs, unique normalized active email hints per intended
recipient, and explicit `delivery.view` allow/deny intents at workspace,
organization, department, client, or project scope. LTDS derives the folder's
owner from its staff-controlled binding and never asks Alpha—or the browser—to
choose an R2 prefix. A selected recipient does not authorize the bearer link.

PA publishes authorization intent; it does not verify an LTDS login. New PA
principals remain unbound and grant nothing until an LTDS-controlled enrollment
binds the principal to an active `portal_v2_identity`. Projection activation
preserves an existing explicit binding but requires its provider-verified email
to match the current PA email hint before creating an effective membership or
entitlement. A contact record, `primaryContact: true`, matching email, name, or
organization relationship never creates a binding or grant. Tombstones and
inactive ancestors fail closed immediately. This separation is deliberate and
must remain in Project Alpha contract tests.

Migration `0125_project_alpha_portal_projection.sql` is additive and
idempotent. Applying it alone grants no access and enables no endpoint.

## Non-binding pricing preview (implemented, disabled)

The Client Worker can call Project Alpha's server-only endpoint at exactly
`POST /api/v2/integrations/ltds/pricing-hints`. The caller is independently
disabled unless `PROJECT_ALPHA_PRICING_HINTS_ENABLED` is exactly `true` and all
configuration validates. The browser never receives Project Alpha credentials
and cannot supply coverage, acreage, currency, or money to this call.

Configure an exact HTTPS URL and matching allowlisted origin in
`PROJECT_ALPHA_PRICING_HINT_URL` and
`PROJECT_ALPHA_PRICING_HINT_ALLOWED_ORIGIN`. Use a dedicated bearer credential
whose only Project Alpha scope is `portal.pricing.preview`, stored as
`PROJECT_ALPHA_PRICING_HINT_API_KEY`, and an unrelated 32+ byte
`PROJECT_ALPHA_PRICING_HINT_HMAC_SECRET`. Also set a bounded deployment ID in
`PROJECT_ALPHA_PRICING_HINT_APPLICATION_KEY` and a comma-separated response
allowlist such as `PROJECT_ALPHA_PRICING_HINT_CURRENCIES=USD`.

LTDS sends only schema/source/scope, the selected services' public IDs and
immutable source versions, and the server-computed polygon area as a six-place
decimal square-metre string. It deliberately omits browser acreage, display
names, answers, Project Alpha numeric IDs, and all money. The canonical JSON
body is capped by construction and signed as follows:

```text
signature input = <ISO timestamp>\nPOST\n/api/v2/integrations/ltds/pricing-hints\nportal.pricing.preview\n<SHA-256 body hex>
Authorization: Bearer <dedicated preview-only key>
X-LTDS-Scope: portal.pricing.preview
X-LTDS-Timestamp: <same ISO timestamp>
X-LTDS-Body-SHA256: <same body digest>
X-LTDS-Signature: sha256=<HMAC-SHA-256 hex>
X-LTDS-Application-Key: <pricing application key>
```

Project Alpha returns one strict aggregate for the complete selected-service
set, never a list that LTDS would have to add. `displayMode` is `none`,
`starting_at`, or `typical_range`; amount fields are two-place non-negative
decimal strings and `none` has null currency/amounts. The response must echo
the exact canonical square metres, use an allowlisted currency, include the
exact disclaimer `Planning guidance only. Final quote after staff review.`,
and expire within 24 hours. Responses are capped at 16 KiB and the call times
out after four seconds. Timeout, denial, malformed data, stale data, invalid
currency/amounts, or any configuration error degrades to **Pricing provided
after review**. LTDS has no local pricing formula and no stale-price fallback;
request submission remains available.

## Deployment configuration

Choose a deployment-specific application key such as `field_operations`. Configure that same value as `APPLICATION_KEY` on both the provisioning Worker and the Operations snapshot importer, and in Project Alpha’s Custom Integrations settings. The display label, Worker names, URLs, D1 database, Access application, Access group, and application key are deployment choices.

This repository's current LTDS production deployment uses `ltds_ops`. That value is deployment configuration, not an application default: forks must choose their own key and use it consistently on all three components.

Create a dedicated Project Alpha API key with only:

```text
ops.sync.read
```

Store its plaintext value as the Operations Worker’s `PROJECT_ALPHA_API_KEY` secret. The current Project Alpha contract signs the exact bytes of `${timestamp}.${rawBody}` with HMAC-SHA-256 and sends `X-PA-Signature: sha256=<lowercase hex>`. Store the shared secret as `PROJECT_ALPHA_WEBHOOK_HMAC_SECRET` and keep `PROJECT_ALPHA_ALLOW_LEGACY_HMAC=true` for this first-production contract. LTDS still prefers `X-PA-Signature-Ed25519` whenever that header is present; an invalid Ed25519 signature never downgrades to HMAC. A future Ed25519 rollout requires a configured public key and coordinated verification before HMAC can be disabled. The Access service-token ID and secret belong only in Project Alpha; the Access Groups API token belongs only on the provisioning Worker.

## Private draft-quote command (implemented, disabled)

An Operations user with global `operations.manage` may explicitly select
**Create Project Alpha draft** while a request is `under_review` or
`accepted_pending_pa_linkage`. Nothing runs automatically. The browser calls
only the Operations Worker and never receives a Project Alpha credential.
Existing approved quotes may still be linked through the clearly labeled
manual verification fallback.

The disabled caller targets:

```text
POST /api/v2/integrations/ltds/draft-quotes
required Project Alpha credential scope: portal.quote-draft.create
```

Use a dedicated `PROJECT_ALPHA_DRAFT_QUOTE_API_KEY` with exactly that scope and
a separate `PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET` of at least 32 bytes. Do not
reuse the read-only `PROJECT_ALPHA_API_KEY` or webhook verification secret.
`PROJECT_ALPHA_DRAFT_QUOTES_ENABLED` is checked for the exact value `true` and
is committed as `false`.

LTDS emits canonical JSON (recursively sorted object keys), capped at 96 KiB:

```json
{
  "schemaVersion": 1,
  "source": "ltds-operations",
  "request": {
    "publicId": "opaque LTDS request id",
    "revision": 4,
    "title": "bounded request title",
    "scopeSummary": "bounded reviewed scope",
    "deliverablesSummary": "bounded summary or null"
  },
  "authorization": {
    "organizationPublicId": "server-derived PA public id or null",
    "clientPublicId": "server-derived PA public id",
    "projectPublicId": "server-derived PA public id or null"
  },
  "services": [
    {
      "publicId": "service public id",
      "catalogVersion": "observed immutable version",
      "answers": {}
    }
  ],
  "workArea": {
    "revision": 0,
    "hash": "sha256 of canonical effective geometry and POIs",
    "squareMeters": 4046.856,
    "acres": 1
  },
  "attachments": [
    {
      "name": "authorization.pdf",
      "contentType": "application/pdf",
      "sizeBytes": 2048,
      "sha256": "scanner-verified digest"
    }
  ]
}
```

Only attachment rows already accepted by the authenticated scanner are sent,
and only their bounded display/verification metadata is included. R2 object
keys, URLs, source bytes, local paths, raw EXIF, money fields, and private PA
pricing rules are never included. LTDS recomputes acreage from the effective
validated polygon and hashes the effective polygon plus POIs; it ignores any
browser measurement.

The stable idempotency key is
`ltds-pa-draft:<requestPublicId>:r<requestRevision>:a<areaRevision>`. LTDS signs
the exact body with:

```text
signature input = <ISO timestamp>\nPOST\n/api/v2/integrations/ltds/draft-quotes\n<Idempotency-Key>\n<SHA-256 body hex>
X-LTDS-Signature: sha256=<HMAC-SHA-256 hex>
X-LTDS-Timestamp: <same ISO timestamp>
X-LTDS-Body-SHA256: <same body digest>
X-LTDS-Application-Key: <APPLICATION_KEY>
Authorization: Bearer <dedicated draft-only key>
```

Project Alpha must enforce a short timestamp window, constant-time signature
verification, exact body-digest verification, credential scope, client/project
authorization, and atomic idempotency receipts. Same key and fingerprint must
return the same result; same key with a different fingerprint returns
`409 {"code":"IDEMPOTENCY_CONFLICT"}`. A selected catalog version that can no
longer be used returns `409 {"code":"STALE_CATALOG"}`. Project Alpha must
calculate all money and create a private draft only. It must never approve,
send, publish, sign, invoice, charge, or notify.

The success response is strict; extra fields or any status other than `draft`
are rejected:

```json
{
  "receiptId": "public command receipt id",
  "draftQuote": {
    "publicId": "public draft quote id",
    "documentNumber": "Q-DRAFT-7",
    "status": "draft",
    "version": 1,
    "editorPath": "/quotes/public-id/edit"
  }
}
```

`editorPath` must be a same-origin relative path. LTDS persists the result in
the immutable `request_pa_draft_quote_receipts` ledger with the payload hash,
request/area revisions, staff actor, and public result identifiers. A changed
request or area revision gets a new key. A transient failure leaves no LTDS
receipt and is safe to retry. The Project Alpha endpoint and scope remain the
release blocker; no flag should be enabled until staging proves replay,
conflict, stale-catalog, scope-denial, timeout, and no-side-effect behavior.

## Projection and visibility

The snapshot includes users, Business Units, worker/unit membership, clients, organizations, Business Unit-aware Projects, Project Team membership, service locations, entitlements, Operations, Operation assignments, Tasks, multi-worker Task assignments, and calendar events. It excludes passwords, authentication material, private tokens, pay rates, financial details, and secrets.

Visibility rules are assignment-driven:

- Project Team membership grants Project context.
- Direct Operation assignment grants the Operation without another Business Unit checkbox.
- Direct Task assignment grants the Task without another Business Unit checkbox.
- Project Alpha administrators receive global synchronized visibility.
- Business Unit membership is organizational metadata and does not grant Operations access.

Only explicitly enabled Project Alpha entitlements provision an Operations account. Administrators map to the immutable global administrator role; every non-administrator entitlement maps to the assigned-only operator role in both incremental and snapshot recovery. An enabled non-administrator with no Project, Operation, or Task assignment can authenticate but receives an empty operational workspace.

Projects may include `manager_user_id`. A Project Manager receives Project context in the same way as a Project Team member; Project Alpha remains responsible for making the manager a Team member and for choosing the Project's Business Unit.

Project Alpha posts signed incremental changes to `/v1/project-alpha/events`. The receiver validates Cloudflare Access, the configured application key, schema version, event ID, timestamp, and the current HMAC signature contract. Ed25519 remains the preferred optional algorithm when configured, and its failure never falls back to HMAC. Event receipts make delivery idempotent; per-entity source timestamps prevent older events from overwriting newer data. An owner-checked, expiring D1 lease serializes the snapshot and all incremental projection writes; entity leases still protect the Operations and client/organization portal projections and final source marker. A contending delivery receives a retryable response; it does not mutate Project Alpha or silently acknowledge an uncommitted projection.

The receiver acknowledges a valid event after its D1 projection is committed. Cloudflare Access-group membership is reconciled immediately and independently every five minutes, so a temporary Cloudflare control-plane failure cannot block Project Alpha's outbox. Control-plane calls have bounded retries and timeouts; three consecutive failures open a visible five-minute circuit. The managed group is read and compared before any PUT, and unexpected non-email include rules fail closed. Configure both `CF_ACCESS_GROUP_ID` and the exact deployment-specific `CF_ACCESS_GROUP_NAME`; the name provides a safe recovery path if Cloudflare rotates or replaces the group identifier.

A complete snapshot runs daily for recovery and reconciliation. Project Alpha uses OFFSET pagination and emits a fresh `generated_at` on every page, so LTDS reads two complete bounded passes and requires identical per-collection fingerprints before any projection or missing-row deactivation. An unequal pass fails as `project-alpha-snapshot-unstable` and retains the last-known-good projection. This doubles normal snapshot reads and hashing work, but prevents a moving OFFSET window from silently revoking access. Collection fingerprints skip unchanged projection writes, except time-bounded memberships are recomputed on every run so expiration does not depend on a payload change. Each pass retains the same page-count, page-byte, total-record, timeout, retry, and lease limits. The snapshot fails with `delivery-db-binding-required` before fetching or committing fingerprints when the Delivery D1 binding is unavailable; it must not report a healthy reconciliation while the portal projection is stale.

Client-workspace authorization is reconciled from the current projection, not from names. A concrete active PA client controls the client account's active state; losing an optional organization alone does not suspend that account. Project grants remain valid only while the PA project is active and still belongs to the account's exact client, or, for view-only grants, its active organization. A client, organization, or project revoke/remap revokes invalid project delivery, member, and folder associations before a later account or source reactivation can revive stale access. Client-scoped folders are revoked when their concrete client account is suspended. These are LTDS-local projection and authorization changes only; LTDS never mutates Project Alpha.
