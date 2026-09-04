# Client portal v2: locked Project Alpha compatibility contract

Status: **approved target architecture; not the current production contract**.

The current pilot remains read-only toward Project Alpha as documented in
[the client request pilot](client-portal.md). This document locks the contract
that both repositories must implement and validate before any v2 feature flag
is enabled. It does not authorize a deployment, migration, production write,
or Project Alpha data change.

## Ownership and trust boundaries

Project Alpha (PA) is the source of truth for:

- organizations, departments, clients, projects, and their stable public IDs;
- portal role and entitlement intent;
- the Service Library, service availability, and client-facing pricing policy;
- quotes, contracts, invoices, tax, totals, currency, approval, signing, payment,
  and every financial communication.

LTDS is the source of truth for:

- verified portal identities, invitations, effective workspace membership, and
  local guest grants;
- service-request drafts, immutable submitted revisions, Mapbox work geometry,
  request attachments, discussions, and operational review;
- delivery folder bindings, file authorization, public-share capabilities,
  notification inboxes, and the canonical LTDS authorization audit;
- an explicitly labeled, non-binding price hint observed from PA.

Operations is the staff collaboration and execution interface. It may ask PA to
create a draft quote through the command described below, but it does not
calculate a binding price, write quote lines directly, approve or send a quote,
or become a second financial system of record.

The browser never calls a PA integration endpoint. Dedicated server-to-server
routes use a separate integration principal and narrowly scoped credentials.
Worker-to-Worker calls inside the LTDS deployment use service bindings rather
than public HTTP. No client session, public-share token, raw R2 key, or browser
credential is accepted as PA integration authority.

### Portal hierarchy and effective authorization

- A workspace represents exactly one PA organization or one standalone PA
  client. Departments, clients, and projects remain scoped children.
- PA publishes portal authorization intent. LTDS mirrors that intent but makes
  the final decision from the active source entity, active entitlement, verified
  identity, workspace membership, scoped capability, folder binding, and any
  explicit deny. A synchronized contact or primary-contact flag grants nothing.
- One global verified identity may hold independent memberships in several
  workspaces. Their dashboards, searches, notifications, and data never merge.
- PA supports multiple organization administrators, department heads scoped to
  one department, and project managers scoped to one project. PA staff appoint
  and replace those PA-backed managers through the audited PA authority screen.
  A portal manager may invite ordinary LTDS-local guests only inside a scope
  where the manager already holds `member.manage`; invitations never grant
  `member.manage` or create another PA-backed manager.
- Client-invited members and subcontractors may remain LTDS-local guests. They
  are not silently added to PA's CRM. Promotion to a management role requires
  an explicit PA portal principal/entitlement.
- Project scope is the invitation default. Organization-wide access requires an
  organization administrator and a prominent warning. The default project
  expiry is 30 days after PA marks the project complete.
- Removing an individual administrator removes that person's authority without
  deleting workspace-owned memberships or links. Removing the final
  administrator locks management until Operations appoints a replacement.
- Removing, disabling, or reparenting the source organization, department,
  project, or entitlement immediately suspends affected access and descendants.
  LTDS retains the suspended grant for a 30-day reviewed restoration window.
- Folder authority uses opaque, versioned bindings for organization,
  department, client, or project scope. Raw R2 prefixes never cross a client
  API, and authorization is rechecked before each object read.
- Staff-created authenticated Delivery grants are versioned LTDS objects
  targeting one current opaque organization, department, client, project, or
  verified principal. Group audiences resolve dynamically from current
  membership, `delivery.view`, hierarchy and deny state; only exact-principal
  grants snapshot a principal/identity binding. Revocation is terminal and
  restore creates a new version after current source-version revalidation.
- Authenticated grants, Operations `/s/` bearers, and client-owned
  `/client-share/` bearers are three separate security objects. Removing the
  authenticated source grant immediately suspends any descendant client bearer
  without granting the client authority over an Operations share.
- Operations bearer shares remain under `/s/`. Delegated client bearer shares
  use `/client-share/`, a separate signing audience/cookie namespace/audit, and
  remain bounded by the workspace's live source grant. They are workspace-owned,
  not creator-owned. Named-user security uses authenticated membership rather
  than a recipient label on a bearer link.
- The client namespace uses the path-scoped Secure cookie
  `__Secure-ltds_client_share` and the `client-delegated-share:v1` signing
  context. Staff delivery cookies are not accepted, and the delegated
  DeliveryApp namespace never calls the staff `/api/public` surface.
- Client APIs carry only opaque staff-provisioned folder target IDs. Every
  public request rechecks live identity, membership, PA hierarchy and deny
  precedence, the exact entitlement/delegation versions, binding version,
  strict descendant containment, expiry and revocation. Exact-root selection
  is denied unless staff explicitly approved it.
- Link minting remains fail-closed until an internal Operations signer service
  binding returns an auditable receipt. `DELIVERY_TOKEN_SECRET` must never be
  copied into the client Worker.

### Versioned portal directory projection

PA supplies a separately gated portal-v2 complete snapshot and incremental
event profile. It includes organizations, departments, clients, department
contacts, projects with department relationship, portal principals, and scoped
portal entitlements. Every resource uses a stable public ID, source version,
active state, and tombstone/removal signal. Project Alpha writes a source
mutation and its outbox event transactionally.

LTDS applies complete generations to shadow tables before authorization cutover.
It advances a consumer checkpoint only after every required LTDS projection is
committed. Interrupted, partial, out-of-order, duplicated, or split-destination
delivery retains the last-known-good authorization state and remains retryable.
The existing v1 projection remains unchanged until portal-v2 parity is recorded.

Project Alpha publishes every portal delivery as the strict outer integration
event `event_type: "portal.projection"` through its one External Operations
connection at Ops Sync. Ops Sync authenticates and records the source event,
then privately invokes the Client Worker's named portal-projection entrypoint.
Project Alpha does not call the Client Worker, an internal HTTP route, or a
`portal.*` hostname directly. The internal receiver
is behind the independent exact flag `PROJECT_ALPHA_PORTAL_SYNC_ENABLED=false`
and additive migration 0125. Receiver enablement does not enable
`CLIENT_PORTAL_HIERARCHY_V2_ENABLED`. PA principal
rows are authorization intent only: an LTDS-controlled, provider-verified
identity binding is required before any projected membership or entitlement is
effective. Email hints and primary-contact flags never bind or grant access.
The Project Alpha event envelope and the distinct Operations-internal delivery
envelope are documented in [the Project Alpha integration guide](project-alpha.md).

Cross-repository compatibility is executable, not prose-only. The shared
corpus contains strict positive and negative specimens for portal projection
and activation (`packages/shared/fixtures/project-alpha-portal-v2.json`), the
independently gated relation/lifecycle projection
(`project-alpha-portal-relations-v3.json`), the catalog
(`project-alpha-catalog-v2.json`), pricing authorization
(`project-alpha-pricing-hint-v1.json`), and the private draft-quote command
(`project-alpha-draft-quote-v1.json`). LTDS consumer tests and Project Alpha
producer/receiver tests must consume equivalent byte-for-byte copies before any
independent feature flag is enabled.

### Relation-compatible authorization foundation

Migration 0129 adds generation-owned `contains` and `contact_assignment`
edges plus an explicit project lifecycle row. This removes the authorization
assumption that every PA object has only one parent: one project may be related
to an organization, department, and client, and one contact may be assigned to
multiple departments. The legacy `parent_public_id` remains a display-order
compatibility field and is not authoritative when
`CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED=true`.

The directed relation contract is closed rather than inferred. `contains`
allows organization to department/client/project, standalone client to project,
and department/client to project. `contact_assignment` allows an organization,
standalone client, department, client, or project to point to a contact. All
other directions are rejected by both the strict receiver and D1 triggers.
Schema-v3 project tombstones atomically deactivate the project, dependent edges,
orphaned descendants, lifecycle, and scoped entitlement intents. A workspace
tombstone atomically suspends the complete workspace graph and PA-derived
authorization state; neither operation leaves the previous checkpoint live.

The relation flag is independent and defaults to false. When enabled, the
signed receiver accepts strict schema-v3 snapshot pages and ordered relation
or lifecycle events, stages every resource family, and advances the directory
checkpoint only after complete cross-reference validation. Schema v2 remains
unchanged. The Worker then resolves all active reverse edges in the current complete generation,
requires the exact workspace root to be reachable, and evaluates entitlements
against the resulting target scopes. Any matching deny wins. Directory search
returns only entries for which that identity has `directory.read`; it never
uses a workspace-wide read as a shortcut. A project completed by PA retains
access for 30 days after `completedAt`, then fails closed. PA reopening the
project publishes `active` with `completedAt: null`, which restores the
underlying unexpired grants without rewriting or resurrecting revoked grants.
PA maps `not_started`, `active`, and `overdue` to wire-level `active`.
`completed` requires an authoritative PA `completed_at`; `updated_at` is not a
substitute. `cancelled` is an entity deactivation/tombstone that closes the
project graph immediately rather than receiving the 30-day completed grace.

Client managers can create only `client_invitation` guest memberships within a
scope where they already hold `member.manage`. The invit-able capability set
does not include `member.manage`; PA-backed manager designation remains a PA
staff-controlled entitlement and cannot be created or transferred in the
client portal.

Migration `0132_portal_v2_legacy_member_bridges.sql` is the temporary cutover
adapter for LTDS-local guests. Invitation acceptance atomically creates one
account-local synthetic repository identity per `(workspace, v2 identity)`;
that synthetic issuer is never accepted as an authentication principal. Every
legacy project, file, and request route still intersects the repository session
with the live v2 membership and exact entitlement, so a project invitation
cannot see a sibling project. Suspension or revocation disables the bridge
immediately, while another workspace keeps its separate bridge and access.
Remove this adapter only after the resource repository is fully workspace-v2
native.

## Versioned, sanitized Service Library resource

PA publishes a portal-safe catalog projection. It is not the administrative
`item_library` table and must not serialize database IDs, internal fulfillment
notes, worker compensation, margins, internal costs, tax configuration,
inactive package internals, or private pricing formulas.

Project Alpha pushes bounded pages to the server-only receiver documented in
`project-alpha.md`. A projected item has this deliberately small logical shape:

```json
{
  "schemaVersion": 2,
  "sourceGeneration": "opaque-generation",
  "sourceSequence": 42,
  "items": [
    {
      "publicId": "stable-public-id",
      "sourceVersion": "opaque-service-version",
      "name": "2D Mapping",
      "summary": "Client-safe description",
      "category": "Mapping",
      "displayOrder": 10,
      "geometryRequirement": "required",
      "questions": [
        {
          "id": "deliverable-format",
          "label": "Preferred deliverable",
          "type": "select",
          "required": true,
          "options": [
            { "value": "orthomosaic", "label": "Orthomosaic" }
          ]
        }
      ]
    }
  ]
}
```

Contract rules:

- `publicId` is an opaque, immutable public identifier. LTDS never persists a
  PA auto-increment ID as cross-system identity.
- `sourceVersion` changes whenever a portal-visible field changes.
  `sourceGeneration` identifies a complete snapshot and `sourceSequence` is
  monotonic across the activation and later incremental events.
- Only active, explicitly portal-requestable service selections are projected.
  Project Alpha decides what is requestable before publishing it.
- Catalog schema v2 publishes only PA `entry_type=service` rows. Fees and
  bundles remain PA-only; LTDS must not flatten bundle composition or infer
  package pricing until a later versioned contract defines those semantics.
- Each item has 0–10 client-safe questions. Allowed wire types are `text`,
  `number`, `boolean`, `select`, and `multi-select`, with bounded lengths,
  options, minimums, and maximums. Questions cannot contain executable code,
  HTML, arbitrary regular expressions, prices, credentials, or internal notes.
- `category` is 1–100 plain-text characters, `displayOrder` is an integer from
  0 through 1,000,000, and `geometryRequirement` is exactly `none`, `optional`,
  or `required`. These fields and the question schema are immutable for a given
  `sourceVersion` and are retained in request snapshots.
- Pricing-hint eligibility and amounts are obtained only through the separate
  pricing-preview contract. They are not catalog projection fields.
- LTDS applies a complete generation atomically, retains its last-known-good
  generation on failure, and records the source version selected in every
  request revision.
- A service disabled after a draft was started cannot be newly submitted. An
  already submitted revision retains a sanitized name/category/version
  snapshot for audit and staff review.

The catalog is delivered only to
`POST /api/internal/project-alpha/catalog-v2`, protected by a dedicated Access
service application and exact-body HMAC. The PA producer capability should be
named `portal.catalog.publish` (or an equivalent dedicated scope). It must not
reuse a broad administrative API, the human browser session, or the separate
pricing/draft credentials.

## Dynamic, multi-service client request

A request contains between one and ten distinct service selections. Each item
records the PA `serviceId` and `version`, client-safe selection answers, and the
submitted sanitized catalog snapshot. Duplicate service IDs are rejected. A
single validated request work area is shared by services that require geometry;
services that do not require an area ignore it. Work needing different areas is
submitted as separate requests so scope and revision history stay clear.

The client UI is generated from the sanitized catalog rather than a duplicated
LTDS service list. It must:

- preserve a draft if a catalog refresh is temporarily unavailable;
- show a blocking reselect/review message when a selected service is no longer
  requestable or its material selection contract changed;
- never silently replace a selected version or change a submitted revision;
- present each service, work-area summary, attachments, schedule, contacts, and
  deliverables on the final review page with an Edit action per section;
- submit one immutable request revision using an idempotency key and optimistic
  draft version.

## Mapbox geometry and authoritative acreage

Mapbox is the client drawing and display interface. A client does **not** upload,
import, download, or export KML. Client APIs do not expose KML endpoints.

LTDS accepts bounded GeoJSON created by the application, revalidates it on the
server, and rejects malformed coordinates, out-of-range positions,
self-intersection, excessive vertices, unsupported geometry, and payloads over
the configured bound. The server computes geodesic area from the accepted
WGS84 geometry using a pinned, tested geospatial implementation. It persists
canonical square metres and converts display acreage with:

```text
acres = square_metres / 4046.8564224
```

The browser-provided area is never trusted. The UI may optimistically display a
local calculation, but the server result replaces it and is the only value sent
to the pricing-hint service or stored with the submitted revision. Display
rounding does not alter the canonical measurement.

Operations may download an authorized server-generated KML for either the
immutable original client geometry or the current staff-finalized revision.
KML export is staff-only, permission-gated, audited, sanitized, and contains no
hidden paths or unrelated geometry. Importing KML into a client request remains
out of scope.

## Non-binding pricing hints

LTDS never derives a price by copying PA's unit price or implementing a local
pricing formula. After authoritative acreage is available, the LTDS server may
call the dedicated PA preview endpoint whose path is bound to the configured
application key,
`POST /api/v2/integrations/{applicationKey}/pricing-hints`, with scope
`portal.pricing.preview`.

The request includes only the active PA service public IDs/versions, canonical
coverage in square metres, and a server-derived authorization context. The
context contains a workspace root `{ type: organization | standalone_client,
publicId }` and `projectPublicId`. LTDS resolves those opaque PA public IDs only
after reauthorizing the selected workspace and stored draft project; browser
IDs, local IDs, projectless drafts, numeric PA legacy IDs, and unresolved
relationships degrade to no hint before any PA call. PA independently verifies
that the active project belongs beneath the supplied root. The exact request
fixture is `packages/shared/fixtures/project-alpha-pricing-hint-v1.json`. PA
returns a bounded presentation result:

```json
{
  "schemaVersion": 1,
  "catalogVersion": "opaque-monotonic-version",
  "coverageSquareMetres": "404685.642240",
  "displayMode": "starting_at",
  "currency": "USD",
  "startingAt": "1500.00",
  "typicalMinimum": null,
  "typicalMaximum": null,
  "reasonUnavailable": null,
  "disclaimer": "Planning guidance only. Final quote after staff review.",
  "validUntil": "RFC3339 timestamp"
}
```

The result is one PA-calculated aggregate for the complete selected-service
set. LTDS never adds per-service amounts. The only amount-bearing modes are
`starting_at` and `typical_range`; `none` carries no currency or amounts. There
is no `exact` mode. Amounts are decimal strings, never binary floating-point
numbers. PA calculates the result from its current policy; LTDS renders it but
cannot edit or reuse it after `validUntil`.

Every hint must display all of the following together:

- `Estimated coverage: X acres`;
- either `Starting at`, `Typical range`, or no amount;
- `Planning guidance only. Final quote after staff review.`

Hints cannot be accepted, signed, paid, or described as an estimate, quote,
contract, invoice, or guaranteed price. Missing, stale, ineligible, or failed
preview data degrades to acreage and `Pricing provided after review`; LTDS must
not fall back to a local formula or an old amount. Travel, tax, terrain,
airspace, urgency, mobilization, access, processing complexity, and staff
judgment remain part of final PA review unless PA deliberately includes them in
its authoritative policy.

## Idempotent Project Alpha draft-quote command

After a submitted request is reviewed, an authorized Operations user may select
**Create Project Alpha draft**. Operations sends a server-to-server command to
`POST /api/v2/integrations/{applicationKey}/draft-quotes` using a principal with only
`portal.quote-draft.create`.

The command includes:

- a unique LTDS request public ID and immutable request revision;
- PA organization/client/project public IDs already authorized for that request;
- selected service public IDs and observed catalog versions;
- authoritative geometry measurement and sanitized scope/deliverable summary;
- an `Idempotency-Key` and a canonical request fingerprint.

PA must atomically persist the command receipt and draft creation. Repeating the
same key and fingerprint returns the same draft quote. Reusing the key with a
different fingerprint returns a conflict and creates nothing. Concurrent
delivery cannot create two drafts. PA reauthorizes all public IDs, resolves the
current catalog, calculates actual draft lines using PA business rules, and
snapshots those rules into the draft.

The response contains only the draft quote public ID, command receipt ID,
status/version, and the exact public-ID path
`/quotes/{encodeURIComponent(draftQuote.publicId)}/edit`. Numeric query-string editor routes and
absolute URLs are rejected. LTDS stores the verified reference and opens PA's
native editor. The
command must never approve, send, publish, sign, invoice, charge, or notify a
client. A retryable failure leaves the LTDS request unlinked and safe to retry.

If the LTDS request revision or finalized work area changes after creation,
LTDS marks the PA association stale. Staff must review the existing PA draft or
create an explicitly new revision flow; LTDS never silently rewrites a financial
artifact.

## Server-to-server security contract

- Use separate least-privilege scopes for catalog read, pricing preview, and
  draft creation. A read credential cannot create a draft.
- Require TLS, an integration application key, timestamped request signatures
  over the exact method/path/body bytes, a short replay window, and constant-time
  verification. Rotate secrets without an unsigned compatibility downgrade.
- Require `Idempotency-Key` on draft creation and on any future mutation. Store
  the actor, source request/revision, fingerprint, result, and audit correlation
  ID in both systems.
- Enforce request byte, item-count, string, geometry, timeout, retry, and rate
  limits. Use bounded exponential retry only for retryable failures.
- Browser cookies, Cloudflare Access authentication, and portal membership are
  necessary for the human LTDS action but are never forwarded as PA authority.
- Derive organization/client/project scope server-side from the current
  authorized workspace. Caller-provided public IDs cannot widen access.
- Do not log credentials, full request geometry, private pricing policy, or
  client documents. Structured logs use correlation IDs, public resource IDs,
  versions, outcome, duration, and redacted failure classes.
- Return generic client errors. Detailed integration failures remain in
  permissioned Operations diagnostics and audit.

## Rollout and release gates

1. Add stable PA public IDs, versioned catalog projection, scoped integration
   credentials, and audited command receipts behind disabled PA flags.
2. Consume catalog generations into a shadow LTDS projection. Compare counts,
   versions, availability, and sanitized fields without changing the request UI.
3. Enable catalog-backed selection for staff test workspaces. Keep pricing hints
   disabled and retain the existing request path as rollback.
4. Enable acreage and pricing hints for a disposable staging workspace. A hint
   outage must prove safe coverage-only degradation.
5. Enable draft-quote commands in staging. Prove idempotent replay, conflicting
   replay denial, no message/payment side effect, and native editor handoff.
6. Run authorization, contract, browser, mobile, performance, migration, audit,
   and security gates below. Record immutable source commits and evidence.
7. Canary one non-production workspace, then one explicitly approved production
   workspace. Expand only after monitored error, stale-catalog, replay, and
   duplicate-draft rates remain within the release thresholds.

No gate authorizes an automatic production deployment. Schema changes follow
expand/migrate/contract order; old readers remain valid during rollout. Feature
flags are independent for catalog selection, pricing hints, and draft creation
so the write path can be disabled without breaking request intake.

## Required validation

- Contract fixtures validate schema versions, enum values, decimal strings,
  public IDs, pagination, complete generations, tombstones, and unknown fields.
- Catalog tests cover inactive/non-requestable services, rejection of fees and
  bundles under the flat v2 contract,
  changed versions, interrupted pagination, stale responses, and last-known-good
  recovery.
- Request tests cover one through ten services, duplicate rejection, material
  catalog change before submit, immutable submitted snapshots, idempotent
  replay, conflicting replay, and readable final review.
- Geometry tests use known polygons at different latitudes and antimeridian-adjacent
  cases; verify server acreage tolerance, invalid/self-intersecting rejection,
  browser-value tampering, vertex/size bounds, and revision immutability.
- Route tests prove clients cannot upload, import, or export KML and cannot call
  catalog, preview, or draft endpoints directly. Operations KML export requires
  current object permission and returns only the requested revision.
- Hint tests cover starting/range/none, rounding, multiple services, currency,
  expired versions, unavailable policies, timeout, PA denial, and the absence of
  any local-price fallback or exact-price language.
- Draft-command tests cover authorization, source-scope mismatch, stale catalog,
  same-key replay, different-payload conflict, concurrent delivery, timeout after
  PA commit, retry recovery, and proof that no approval, email, payment, contract,
  invoice, or client notification occurred.
- Security tests cover signature tampering, timestamp expiry, replay, scope
  separation, secret rotation, rate/size limits, redacted logs, SSRF-safe editor
  URLs, and cross-workspace/cross-project denial.
- Desktop and mobile browser tests cover dynamic service search, multiple items,
  Mapbox drawing, acreage replacement, safe hint language, review/edit/submit,
  Operations review-only default, KML export, and native PA handoff.
- Staging observability proves catalog age, preview latency/error rate,
  idempotency replay/conflict counts, draft command outcomes, and audit
  correlation across both systems.

## Exact Project Alpha compatibility checklist

The Project Alpha implementation is compatible only when every item below is
demonstrated with tests and recorded evidence:

- [ ] Every organization, department, client, project, Service Library entry,
  portal principal, and portal entitlement used by LTDS has an immutable opaque
  public ID; database IDs never cross the contract.
- [ ] The portal-v2 snapshot/events cover organization, department, client,
  department contact, project relationship, portal principal, and scoped
  entitlement with source versions and tombstones.
- [ ] PA can represent multiple organization administrators, department heads,
  and project managers without treating a primary contact as authorization.
- [ ] Source removal/reparenting emits enough authoritative state for LTDS to
  suspend the exact scope and descendants; replay/out-of-order delivery cannot
  restore stale access.
- [ ] PA remains authoritative for hierarchy, Service Library data, pricing
  policy, quotes, contracts, invoices, tax, payments, and financial messages.
- [ ] A versioned, paginated, complete-generation catalog endpoint returns only
  active, explicitly requestable, sanitized service fields.
- [ ] Every service and catalog generation has an opaque change version and PA
  produces tombstones or an equivalent complete-generation removal signal.
- [ ] Catalog output excludes internal notes, compensation, costs, margins,
  private formulas, credentials, and package internals.
- [ ] Optional dynamic request fields use stable IDs and the bounded declarative
  types/options contract; the projection contains no executable markup or code.
- [ ] PA supports `none`, `starting_at`, and `typical_range` hint modes and has
  no exact-price mode for the portal.
- [ ] The pricing-preview endpoint accepts canonical server-computed square
  metres and never trusts browser acreage or client-supplied money.
- [ ] Preview results use decimal strings, include currency/source versions and
  expiry, and always carry the required non-binding disclaimer.
- [ ] The draft-quote endpoint accepts multiple selected services and one
  immutable LTDS request revision, then resolves current PA records itself.
- [ ] Draft creation has a durable unique idempotency key plus payload
  fingerprint; equal replay returns the original result and conflicting replay
  creates nothing.
- [ ] Draft creation never approves, sends, signs, contracts, invoices, charges,
  pays, or emails, and returns only a safe native-editor handoff.
- [ ] PA provides three distinct scopes: `portal.catalog.publish`,
  `portal.pricing.preview`, and `portal.quote-draft.create`.
- [ ] Requests are authenticated and signed server-to-server with timestamp and
  replay protection; no browser credential can call an integration route.
- [ ] PA verifies that submitted organization/client/project/service public IDs
  are active and related before previewing or creating a draft.
- [ ] PA writes an audit record and correlation ID for every allowed, denied,
  replayed, conflicted, and failed command without logging secrets or geometry.
- [ ] Contract fixtures are shared or generated from one versioned schema and
  pass independently in both repositories.
- [ ] Staging proves catalog snapshot recovery, hint-safe degradation, command
  replay after an ambiguous timeout, concurrent duplicate prevention, and zero
  unintended financial or notification side effects.
- [ ] Feature flags for catalog, hints, and draft commands are independent and
  default off; the read-only pilot remains a tested rollback path.
- [ ] Deployment runbooks name migration order, credential provisioning and
  rotation, monitoring, canary scope, rollback/fix-forward, and the operator who
  may enable each production flag.
