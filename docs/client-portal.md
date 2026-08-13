# LTDS client request and staff review pilot

Status: deployed to the LTDS production Workers on 2026-08-01 and validated as
described below. Project Alpha source and data were not mutated. Staging was not
used for this release.

## Ownership and pilot boundary

LTDS owns client authentication plus local account/project grants, service
request intake, request revisions, staff triage, non-binding operational
estimates, client estimate confirmations, audit history, durable notifications,
and verified references to Project Alpha artifacts.

Project Alpha (PA) remains the system of record for projects, on-demand quotes,
contracts, invoices, totals, currency, and every financial communication.
During this pilot, staff create those records manually in PA. LTDS only performs
authenticated `GET` verification of a supplied PA quote and stores its reference,
verification fingerprint, and observed metadata. LTDS must not create or edit PA
projects or artifacts, send PA financial notices, or treat an operational
estimate as a quote, contract, invoice, or payment approval.

The portal's local authorization is authoritative for LTDS access. A PA client,
organization, project, email address, billing contact, or notification recipient
does not grant portal or staff access. Service-enabled project links require an
exact PA client match; organization-only links are view-only.

## Workflow

1. An active client identity submits an on-demand or locally granted project
   request. The request may include scope, dates, service category,
   deliverables, contact details, a polygon, and up to 20 POIs. Creation and its
   staff-triage notification are idempotent.
2. While status is `submitted`, the client may edit the request using an
   idempotency key and the last observed `updatedAt` value. The repository
   rechecks identity/account/project authorization in the mutation and appends
   an auditable `client_edit` revision.
3. After review begins, the original request is not overwritten. A client asks
   for a change by creating an auditable child request. Completed requests do
   not accept children.
4. Staff use the dashboard pending count and queue, then open a stable detail
   URL. Detail includes all intake fields, linked parent/children, Mapbox
   geometry, a readable POI label/coordinate roster, immutable estimate
   versions, request revisions, and admin audit history.
5. Staff draft or revise a non-binding LTDS operational estimate. Publishing a
   ready version creates a durable client confirmation notification. Reusing an
   idempotency key with the same payload replays; reusing it with different
   content conflicts. Older mutable versions are preserved as `superseded`.
6. The client accepts or requests changes through an idempotent response. This
   is operational confirmation only. Final LTDS request approval remains a
   separate staff transition.
7. Staff manually create the financial quote in PA. LTDS verifies a supplied PA
   quote reference read-only, checks its client/organization relationship, and
   links the verified reference. Quote linkage is separate from final approval.
   PA continues to own all quote, contract, invoice, and financial messaging.

Request states are `submitted`, `under_review`,
`accepted_pending_pa_linkage`, `accepted_linked`, `declined`, `cancelled`, and
`completed`. Revision actions are `submitted`, `client_edit`, `change_request`,
`staff_proposal`, `client_response`, `status_changed`, and `pa_quote_linked`.

## API, data, and security contracts

Client routes are implemented under `/api/client` in
[`routes.ts`](../apps/client/src/worker/client-portal/routes.ts):

- `GET /service-requests` and `GET /service-requests/:requestId`
- `POST /service-requests` with `Idempotency-Key`
- `PATCH /service-requests/:requestId` with `Idempotency-Key` and `If-Match`
- `POST /service-requests/:requestId/change-request` with `Idempotency-Key`
- `POST /service-requests/:requestId/estimate-response` with `Idempotency-Key`

Staff routes are implemented in
[`index.ts`](../apps/operations/src/worker/index.ts):

- `GET /api/client-service-requests`, `/pending-count`, and `/:id`
- `POST /api/client-service-requests/:id/estimate` with `Idempotency-Key`
- `PATCH /api/client-service-requests/:id` for guarded staff state changes
- `POST /api/client-service-requests/:id/pa-quote` for read-only PA verification

All client operations require the dedicated portal feature gate, valid Access
identity, active local identity/account/membership, and any applicable project
grant. Staff routes require the Operations Access/session and explicit
permission. Mutation authorization is checked again in the SQL mutation to
close revocation races. User-controlled strings and geometry are validated and
bounded. Audit snapshots and notification payloads are JSON-valid; malformed
legacy JSON is quarantined to safe `null`, `[]`, or a discard marker during
migration rather than aborting the migration.

[`0103_client_portal_workspace.sql`](../apps/client/migrations/0103_client_portal_workspace.sql)
adds explicit PA identifiers, bounded folder grants, on-demand/child request
support, expanded intake fields and geometry, PA artifact references, admin
audit, and the pending-review indexes/status model. It rebuilds related tables
with deferred foreign-key checks so legacy rows are preserved.

[`0104_service_request_thread.sql`](../apps/client/migrations/0104_service_request_thread.sql)
adds immutable request revisions and operational-estimate versions. It rebuilds
the outbox with a required per-request dedupe key and adds confirmation/response
events. Estimate/revision mutation keys and fingerprints distinguish a safe
replay from conflicting reuse. The outbox is at-least-once: leases and bounded
retries recover work, while a stable SMTP `Message-ID` reduces provider-side
duplicates. D1 and a mail provider cannot share a transaction, so a crash after
provider acceptance can still retry.

Every new request enqueues exactly one durable staff-triage event for its
request/dedupe key. A missing triage recipient is a terminal configuration
failure with audit/alert handling, not a silent success. The Operations Worker
is the sole notification sender; the Client Worker never owns mail credentials.

## Local validation evidence (2026-08-01)

- Source import: 34 tracked modifications and 7 untracked paths were copied
  from the specified standalone worktree after switching this project to the
  exact common base `f5ac1d7680b68309595fabb7791e9b0479c3bd56`. File hashes
  matched after transfer, and the source worktree status was unchanged.
- Local D1: Wrangler 4.118.0 applied the clean 23-migration chain through 0104
  to an isolated local persistence directory. `PRAGMA foreign_key_check`
  returned no rows. The legacy fixture also exercised malformed area, POI, and
  notification JSON across 0103/0104 and verified safe conversion.
- TypeScript checks passed for client, operations, and ops-sync.
- Unit/integration suites passed: client 194/194, Operations 152/152, and
  ops-sync 21/21. The four source-layout invariants and full monorepo production
  build also passed.
- Client browser tests passed 12/12 across desktop and mobile Edge, including
  pre-review edit, child change request, estimate response, request workflow,
  responsive overflow, Mapbox startup, and CSP behavior.
- Operations browser tests passed 2/2 across desktop and mobile Edge, covering
  the queue/detail deep link, fields, geometry/POIs, links, revision/audit
  history, non-binding estimate request, idempotency header, responsive layout,
  and CSP header.
- The Operations mobile regression was rerun at a 375 px viewport after a live
  overflow finding; desktop and narrow-mobile browser projects both passed.

### Refinement and security validation

The service-request history/new-request workspace refinements were validated
across all three package TypeScript checks, the full monorepo test command, the
full production build, the staging requirement/evidence guards, `git diff
--check`, and the existing desktop/mobile client and Operations browser suites.

The user-started Codex Security standard whole-worktree scan
`640ecb02-b7de-4d3c-9d07-8f22233d834c` completed with 256/256 files covered and
47 targeted tests. It reported eight validated findings (six medium and two
low). Seven findings are outside this release diff and remain separately
triaged backlog; Project Alpha source was not changed. The release-diff finding
was a same-entity projection race in ops-sync. Migration
`0016_projection_entity_leases.sql` and an owner-checked D1 lease now serialize
signed events for an entity across the Operations projection,
client/organization portal projection, and source marker.

The subsequent formal diff scan `d3dd8a37-93c7-4360-9b73-3b44770d4870`
completed and reported one medium, high-confidence finding: a missing
`DELIVERY_DB` binding could silently complete portal revocations. Portal
projections now fail closed with `delivery-db-binding-required`, leave their
receipt and source marker retryable, release the entity lease, and succeed on a
properly bound retry. The staging requirement guard also requires the Delivery
D1 binding. Focused regressions and the full 21-test ops-sync suite passed.

Wrangler 4.114.0 applied the complete Operations 0001-0016 migration chain to a
fresh isolated local D1 database. The new lease table exists, contains no
residual test lease, and `PRAGMA foreign_key_check` returned no rows.

The controlled delivery-file E2E used synthetic `report` bytes only. The portal
does not issue R2 presigned bearer URLs: it returns an opaque, same-origin path
scoped to the project and rechecks the Access-backed client session, project
grant, account association, and exact indexed key on every request before the
first R2 read. The authorized client download returned 200 with `private,
no-store`; another provisioned client received 404, an unauthenticated principal
received 401, removing the project scope received 404, and all denied attempts
performed zero bucket reads.

### Direct authenticated client folder grants

Migration `0105_internal_folder_grants.sql` adds the backend contract for
sharing an Operations folder directly with an existing client workspace. This
is a `scope_type='client'` prefix grant under `Jobs/Clients/`; it does not create
or rotate a row in `shares`, return a `public_id`, issue a public URL, or send a
public-link message. Permissioned staff use
`POST /api/client-portal/accounts/:accountId/folder-grants` with a required
`Idempotency-Key`; replacement versions are immutable and the matching `DELETE`
route revokes the current version. The portal resolves the grant through the
current active account, Access-backed identity, and membership on every list or
file request. Operations derives the grant division and PA client or organization
owner from the longest matching active `project_folders` association. A missing,
ambiguous, mismatched-division, or wrong-client association fails closed; the
request body cannot choose the authorization scope recorded in either audit log.
The portal returns only an opaque same-origin file identifier. Before its first
`DATA_BUCKET` read, the content route rechecks the Access-backed session, active
identity/account/membership, current folder association, and exact `file_index`
key. It creates neither a public share nor a presigned R2 credential. This
release exposes the staff grant contract through the Operations API; a dedicated
staff grant-management UI is not yet included.

The internal notification outbox waits at least five minutes. Its consumer
re-reads the exact association ID, logical grant/version, active PA-backed
account, recipient identity and membership, current email, and indexed content
newly exposed relative to the recipient's prior client-folder coverage. A
revoked, narrowed, superseded, unauthorized, redundant, or empty grant is
suppressed. Valid mail links only to the authenticated `/portal/deliveries`
page. Stable mutation fingerprints, outbox uniqueness, and `Message-ID` values
make retries idempotent. Controlled D1 tests verify share-then-revoke produces
no access and no mail, while a valid due grant sends once; no real message was
sent during this validation.

Migration `0115` extends that internal-only contract with an Operations folder
Share-dialog section for authenticated client workspace access. Staff search by
folder-scoped typeahead; the server first derives the authoritative longest-
prefix PA client/organization owner and returns only matching explicit LTDS
accounts. The browser never downloads the full PA directory. Notification modes
are off, files added, files removed, or both, with active managers selected by
default and exact active identities stored as recipients.

Folder visibility changes immediately. File-change email and the client portal
bell wait for a five-minute net-change grace window, cancel add/remove pairs,
and reauthorize the grant, PA-backed account, identity, membership, preference,
prefix, and indexed object state at dispatch. The bell supports keyboard use,
Escape/outside-click close, read, and dismiss. Its API returns bounded titles,
body text, timestamps, and same-origin portal actions only; no R2 keys, absolute
paths, raw bucket URLs, public-share data, or unrelated organization records are
exposed.

The requested final post-fix diff rescan workspace
`039e35dd-7458-4707-98d8-9af6f3a67225` remained at setup awaiting **Start
scan**, so it produced no scan ID or report. On 2026-08-01 the user explicitly
waived only that stuck post-fix rescan for this non-production merge, relying on
the two completed scans above plus the full green post-fix validation. This
waiver does not authorize or satisfy a production release gate. No Cloudflare
deployment, production migration, client notification, real client-file access,
or Project Alpha mutation is part of this merge.

The first browser invocation ran every scenario but its Windows-managed fixture
server wrappers did not exit. The exact test-owned processes were stopped, and
the same built artifacts were rerun against explicitly managed local fixture
servers. Those authoritative retries exited zero with 12/12 client and 2/2
Operations browser tests passing.

## Production release evidence (2026-08-01)

The release used Cloudflare account `846c924bf17bf4f3dd15c97a4c5d1d51`.
Current Worker versions are:

- `ltds-clients`: `1b13f142-1a25-42e6-99fb-80bc7885b9c4`
- `ltds-ops`: `709c9fbf-8fb2-448b-8fed-8cb594df9d54`
- `ltds-ops-sync`: `779ec9ba-af0c-4767-b7af-9f4fa00e059b`

Remote `client-data` migrations 0103/0104 and Operations migrations
0013/0014/0015 applied successfully; both migration lists are current. Before
migration, Cloudflare D1 Time Travel bookmarks were recorded:

- `client-data`: `00000426-00000000-000050ba-5b57efd495c80df9576bf351a1cf8e87`
- `ltds-ops`: `00000ea1-00000000-000050ba-cb5c0ebaf032202acc85b07221e39af4`

Pre/post checks returned no foreign-key violations. Client rows were preserved
(3 requests and 6 outbox rows before migration); 0104 created 3 initial
revisions and left zero blank notification dedupe keys. After the controlled
workflow, foreign keys remained clean. The Operations D1 has all 15 migrations,
preserved 3 staff users, and grants `operations.view_all` only to the two seeded
owner/admin roles.

The existing client public Mapbox token was added to Operations as a Worker
secret; it is not stored in source. Authenticated live checks verified the
client portal, staff queue and stable detail URL, all request fields, existing
Mapbox geometry and readable POI coordinates, child linkage, six parent
revisions, audit history, and no new browser console errors. A production-only
375 px overflow was fixed and the fresh deployed stylesheet verified at
`scrollWidth === clientWidth`.

One controlled internal request, `TEST — 2026-08-01 portal release E2E —
edited`, exercised submission, pre-review edit, staff review, an auditable child
request, a non-binding scope confirmation with no amount, client acceptance,
and separate final LTDS approval. Its final state is
`accepted_pending_pa_linkage`; PA quote linkage was deliberately not attempted.
The parent has 6 revisions, 1 child, and 1 accepted immutable estimate version.
All recipients used by this test were verified internal LTDS identities. The
outbox created five deduped request, status, confirmation, and response events.
The production five-minute processor marked all five `sent` on their first
attempt; no financial communication was generated.

Pre-release Worker versions retained for rollback reference are
`0b827526-e746-435f-b23f-268c75befc83` (client),
`bb354195-9364-40c1-bc39-cc5a49de3940` (Operations), and
`5d180f26-64b1-42fe-ae08-4a5155564ef9` (ops-sync).

### Rollback

Prefer a reviewed forward fix. A Worker-only rollback is unsafe for client and
Operations because 0104 requires fields older code does not write. A coordinated
database rollback would use `wrangler d1 time-travel restore` with the bookmarks
above and would erase every post-bookmark write, including the controlled test;
it therefore requires incident approval and a fresh impact review. During a
coordinated rollback, quiesce client/staff mutations, restore both D1 databases,
then use `wrangler rollback <version-id> --message <reason>` from each app and
reverify routes, bindings, Access, health, public delivery, and foreign keys.
Ops-sync can be rolled back independently only after confirming its projection
and receipt schema remain compatible.

## Remaining staging and operational prerequisites

Before staging, pin the reviewed commit and preserve database/config exports;
review Access applications and audiences; apply migrations to exported/staging
data first; populate `MAPBOX_PUBLIC_TOKEN` and `CLIENT_REQUEST_TRIAGE_TO`; set
and verify the chosen mail transport/secrets; confirm the five-minute outbox
processor; test requester and staff recipients with controlled non-client
addresses; and execute cross-account, revoked-access, retry, and rollback
checks. The checked-in staging config intentionally leaves the Mapbox token and
triage address blank and SMTP disabled, so it is not release-ready.

Production was authorized and deployed directly. Ongoing release hygiene still
requires committing the exact deployed working tree, attaching this evidence to
the release record, confirming alert ownership, and running a separate staging
exercise before the next schema release. PA verification credentials must
remain read-only.

## Known limitations and blockers

- Playwright's managed fixture-server teardown hangs on this Windows host after
  successful tests. The evidence above used an explicitly started local fixture
  and `PLAYWRIGHT_EXTERNAL_SERVER=true`, then terminated that exact process.
- Client production builds warn that the Mapbox/client JavaScript chunk exceeds
  500 kB. This is a performance concern, not a failed build.
- Operations-to-Delivery folder association spans two D1 databases and cannot
  be atomic. It needs a durable reconciliation/idempotency design before that
  legacy PA-project association path is relied on as a single transaction. The
  direct client-workspace folder-grant path is Delivery-D1-only and does not
  have this cross-database write.
- A provider can accept SMTP before the D1 sent marker commits; the stable
  `Message-ID` mitigates but cannot mathematically eliminate a duplicate.
- Staging still lacks a configured Mapbox token and staff-triage recipient and
  was not validated. Production `ALERT_FROM`/`ALERT_TO` are blank, so the
  separate terminal-failure alert path still needs an owned destination even
  though request mail delivery is configured.
- The release was deployed from an uncommitted working tree by explicit
  authorization. No push or merge was performed; the exact diff must be
  reviewed and committed before normal source-controlled promotion resumes.
- Unsaved-form navigation protection and richer client-side POI naming/removal
  remain high-priority usability work. Staff can already see every POI label
  and coordinate. KML import is intentionally deferred pending a confirmed
  pilot intake need and a bounded parser/security contract.

## Todd's App read-only UX decision record

`C:\Projects\Todds App` was inspected read-only after browser validation. No
source, dependency, credential, business data, or integration design was
copied. Todd's separate user/admin surfaces, request review, map drawing,
geolocation, KML, and responsive patterns were compared with LTDS.

Already covered: LTDS has stronger server-enforced role separation, auditable
pre/post-review changes, versioned non-binding estimates, separate approval and
PA linkage, explicit geolocation consent, desktop/mobile layouts, address
search, draggable POIs/polygon vertices, map-style switching, KML export, and
staff auto-fit geometry review.

Adopt in priority order: (1) protect dirty request/map forms from accidental
Cancel or navigation; (2) add accessible client POI naming/remove/focus
controls—the staff roster was added now; (3) add constrained KML import only if
pilot intake confirms the need, with file/geometry limits, no remote links, and
malformed/unsupported geometry tests.

Reject or defer: browser/localStorage role gates, financial proposal/quote
ownership, direct client status mutation, automatic geolocation, destructive
project deletion, hover-only affordances, and a full mission-planning builder.
Those patterns weaken authorization/accessibility, violate PA ownership, or
materially expand the pilot's data and security contracts.

## Client request workspace UX decision (2026-08-01)

The deployed Flyover workspace at `https://app.flyover.io/` and the local
`C:\Projects\Todds App\flyover-main` source were inspected read-only as layout
references. At a 1280 by 720 desktop viewport, Flyover reserved about 400 px
for its workflow rail and 865 px (68 percent) for a 576 px-high map. At a 390
by 844 mobile viewport, its map occupied the full 375 px content width and
about 704 px of height while its rail moved behind a menu. LTDS adopts the
map-first proportion and hierarchy, not Flyover code, data, authorization, or
mission-planning logic.

The LTDS request flow now uses `/portal/requests` as a history and status
overview. `Submit new request` opens the separate
`/portal/requests/new` workspace. Desktop uses a readable 340 px-minimum form
rail beside the larger map; the canvas is viewport-aware with a tested minimum
of 760 by 560 px at 1440 by 900. At the iPhone 13 viewport the map is first in
DOM and visual order, the form follows below it, and the tested canvas minimum
is 330 by 430 px. The longer LTDS intake remains visible below the map instead
of being hidden in Flyover's full-screen mobile drawer. Both browser projects
assert that the map stays within the viewport and that neither the document nor
body has horizontal overflow.

Client terminology is consistently `Service request`. Project context is
either an explicitly selected existing project or `New or one-off service`.
The form states that it captures and triages the request and does not create or
change a Project Alpha project. The internal historical request type remains in
the validated API/data contract for compatibility but is no longer presented
as a client decision or label.

Map behavior preserves address search, explicit current-location consent,
satellite/streets modes, area drawing, draggable POIs and vertices, limits,
undo, clear, and the existing request/revision payload. Address search now uses
debounced, abortable Mapbox suggestions with stale-result rejection and
keyboard/listbox selection. A chosen result is persisted through the existing
`location_text` field. When a user starts from the map or current location and
that field is blank, LTDS requests a nearby street/place label; failure leaves
a neutral `Near <latitude>, <longitude>` label rather than inventing an exact
address. This existing field is already included in immutable request revision
snapshots, so no database migration was required.

Current location requests low precision, accepts a ten-minute cached reading,
uses an eight-second timeout, and disables only its own button. Loading,
success, denial, timeout, and fallback copy are announced while other map
interaction remains available. POIs can be selected directly on the map or
through an accessible coordinate roster, and any individual point can be
removed without undoing newer points. Inactive map mode/style controls now
have explicit dark-on-light contrast; selected controls retain the dark active
treatment.

KML export is no longer exposed in the client request UI. Geometry remains
available to authorized Operations staff for downstream review and DJI
flight-path preparation. Public-prospect intake remains planning-only and was
not implemented. The existing controlled production row whose historical
title begins `TEST — 2026-08-01` was not renamed or altered because that would
be an external production-data mutation requiring separate approval.

Operational notifications use the existing outbox `payload_json` for a
versioned, stable presentation snapshot (title, existing-project/new-service
context, category/scope, location label, lifecycle, and authorized action).
This also required no DDL. Rendering excludes internal request type/status
tokens, site/billing contacts, estimates/amounts/currency, and PA quote,
contract, or invoice identifiers. Legacy rows fall back only to the same
request-scoped nonfinancial fields.

Local evidence for this change: client TypeScript check passed; client unit and
integration tests passed 194/194; and the client Playwright suite passed 12/12
across desktop and mobile Edge. Browser coverage includes history-first
navigation, separate creation URL, existing-project/new-service copy, map
dimensions, map-first order, overflow, inactive-control contrast, address
suggestion pointer and keyboard selection, selected/reverse location labels,
geolocation loading/failure/success, targeted POI removal, CSP startup, and the
existing edit/change/estimate-response workflow. All three package TypeScript
checks passed. Operations tests passed 152/152, including the versioned
notification snapshot, status-aware subject/body, HTML escaping, legacy
fallback, and financial/unauthorized-field exclusion; ops-sync passed 19/19;
and the four source-layout invariants passed. The full monorepo production build
passed with only the previously documented large JavaScript chunk warnings.
The unchanged Operations desktop/mobile request-review browser suite also
passed 2/2.

## Provider-neutral future integration

Future work may define a generic read-only business-system provider interface
for client/organization/project/artifact lookup, verification metadata,
capabilities, and health. That design must keep provider credentials server-side,
make read versus write capabilities explicit, preserve local ACL and audit
semantics, and avoid provider-specific identifiers in generic workflow code.

This is future architecture only. Current code is deliberately LTDS-only
operational code with a PA-specific read-only verifier; it is not a reusable PA
SDK and must not be represented as a completed provider-neutral integration.

## Handoff checklist

- [ ] Review the working-tree diff and this contract; do not include unrelated
      work or reformat churn.
- [ ] Re-run all three package checks/tests/builds and both desktop/mobile
      browser suites; record exact results below or in release evidence.
- [ ] Reapply 0103/0104 to a copy of representative legacy data and run
      `PRAGMA foreign_key_check` before any remote migration approval.
- [ ] Verify client/staff cross-account denials, mutation replay/conflict cases,
      audit rows, outbox dedupe/retry, stable Message-ID, and PA `GET`-only mocks.
- [ ] Configure and review staging Access, Mapbox, triage recipient, transport,
      secrets, cron, backups, alerts, and rollback before the next release.
- [ ] Run a controlled staging workflow with synthetic recipients only after
      approval, then update factual release evidence.
- [ ] Keep PA financial ownership language visible in UI, tests, and review.
- [ ] Do not push, merge, deploy, run remote D1 commands, restore Time Travel,
      or send external mail without separate authorization.
