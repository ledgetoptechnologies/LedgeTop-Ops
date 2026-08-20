# LTDS client request and staff review pilot

This file records the currently deployed pilot. The approved replacement
architecture, including dynamic multi-service selection from Project Alpha,
server-computed acreage, non-binding pricing hints, Operations-only KML export,
and idempotent PA draft creation, is locked separately in
[the client portal v2 compatibility contract](client-portal-v2-architecture.md).

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

The portal's local authorization is authoritative for LTDS data access. An
active Project Alpha portal principal with one canonical email address may
automatically establish a Client Portal identity and enter the matching empty
workspace shell. A PA billing contact, notification recipient, shared mailbox,
or arbitrary email field is never an identity source. Automatic eligibility
creates no capability entitlement, project grant, Delivery grant, or Viewer
grant; every data surface remains empty until staff explicitly share it.
Service-enabled project links require an exact PA client match;
organization-only links are view-only.

Operations exposes this boundary under **Team → Staff** and **Team → Clients**.
The Clients directory is an eligibility directory, not a list of data grants.
Administrators may opt a principal out before or after first login using an
email or exact issuer/subject block. Active blocks are checked on every portal
identity resolution and every Viewer authorization/introspection, so they take
precedence over memberships, entitlements, project grants, and Viewer grants;
previously issued Viewer sessions fail at their next bounded live-introspection
check. Removing a block restores eligibility only;
it does not create or restore any data grant.

Migrations `0144_viewer_client_grants.sql`,
`0145_portal_identity_eligibility.sql`, and
`0146_viewer_client_grant_audit.sql` add authenticated project/task Viewer
grants, opt-out eligibility, the minimal empty-shell bridge, durable mutation
receipts, and an authoritative grant audit colocated with its mutations. Apply
them in that order before deploying code that uses these tables.

Migration `0147_project_alpha_delivery_intents.sql` adds the default-off,
portal-first Project Alpha delivery-intent receipts, principal-only portal
grants, revocation history, authoritative audit, and durable notification
outbox. Operations migration `0031_project_alpha_delivery_intent_rate_limits.sql`
adds its isolated bounded machine-rate counters. The signed wire corpus is
`packages/shared/fixtures/project-alpha-delivery-intent-v1.json` with SHA-256
`f16d540bcfbcf4c77c356fc37e2c046a23a473ebec701d526e3b8d45f38c90e8`.

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

### Request attachments (v2, default-off)

The v2 request wizard may attach up to 10 JPEG, PNG, WebP, HEIC, HEIF, or PDF
files. Each file is capped at 25 MiB and the request aggregate is capped at
100 MiB. ZIP files, archives, SVG/HTML/script content, mismatched MIME types and
file extensions, and mismatched file signatures are rejected. Clients create
the work area only in Mapbox; attachments never accept KML/KMZ.

Attachment bytes never traverse the Client Worker. After an authenticated
client creates an upload intent for an authorized draft, the browser requests a
five-minute ticket for each 8 MiB multipart part and uploads the part directly
to the private R2 S3 endpoint. Each SigV4 ticket binds the private quarantine
object, R2 upload ID, part number, exact `Content-Length`, and declared
`Content-Type`. The Worker stores only upload coordination data and verified
ETag/size checkpoints, verifies the completed R2 size and file signature, and
then leaves the object quarantined.

This feature is fail-closed. Keep `CLIENT_PORTAL_REQUEST_V2_ENABLED` and
`CLIENT_REQUEST_ATTACHMENTS_ENABLED` false until a real scanner consumes
quarantine objects and authenticates scan receipts with the 32+ character
`CLIENT_REQUEST_ATTACHMENT_SCANNER_SECRET`. Apply
`apps/client/r2-request-attachments-cors.json` in production and
`docs/staging/request-attachments-r2-cors.json` in staging, use least-privilege R2
Object Read & Write credentials stored only as
`CLIENT_REQUEST_ATTACHMENT_R2_ACCESS_KEY_ID` and
`CLIENT_REQUEST_ATTACHMENT_R2_SECRET_ACCESS_KEY`, configure an R2 lifecycle backstop for
`_ltds/quarantine/request-attachments/`, and alert on cleanup/scanner failures.
The attachment signer never falls back to the Client Worker's generic
`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`; those remain read-only download
credentials and must not be broadened or reused for uploads.

There is no simulated clean verdict: without scanner configuration upload
initialization returns 503, and drafts containing uploading, quarantined, or
scanning attachments cannot submit. Accepted attachments link immutably to the
submitted request. Authorized client downloads stream through a same-origin
Worker route and never disclose R2 keys or bearer URLs. The hourly scheduled
handler aborts/deletes expired unsubmitted uploads; the R2 lifecycle remains a
recovery backstop. Staging must prove cross-account denial, ticket scope/expiry,
retry/abort/completion, clean and rejected scan receipts, submit gating, and
post-submit download before either flag is enabled.

Project Alpha pricing guidance has a third independent flag,
`PROJECT_ALPHA_PRICING_HINTS_ENABLED`, which also defaults to false. When it is
unavailable or invalid, the review page keeps the authoritative coverage and
shows pricing after review; it never blocks saving or submitting a request and
never calculates or reuses a price locally. See `docs/project-alpha.md` for the
server-to-server contract and credential separation.

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

Migration `0137_authenticated_delivery_grants.sql` is the default-off
portal-v2 successor to the legacy account-wide folder grant. Operations can
select an opaque organization, department, client, project, or exact verified
principal from a folder-confined typeahead. This creates versioned authenticated
authority only: it does not create a bearer URL, public cookie, or public-share
row. Email remains optional notification metadata and never establishes access.

Group grants contain no frozen recipient list. On every portal listing and
file, thumbnail, preview, or download request, the Client Worker intersects the
current Access issuer+subject, active workspace membership, live
`delivery.view` entitlement, current hierarchy and source versions, the exact
folder binding, grant lifecycle/expiry, and applicable deny. Exact-principal
grants additionally snapshot and recheck the opaque PA principal and LTDS
identity binding. This lets a newly authorized group member qualify without a
staff rewrite while a moved, removed, denied, expired, or source-stale member
fails immediately. Revocation is terminal history; restore creates a new grant
version after repeating every current check. A descendant client-created
`/client-share/` link also rechecks this parent grant on every bearer request.

The staff management API and Client enforcement are independently present but
ship disabled through `CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED`,
`CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED`, and
`AUTHENTICATED_DELIVERY_GRANTS_ENABLED`. They must be enabled together only
after migration `0137`, Project Alpha projection parity, and end-to-end staging
grant/revoke/restore/deny evidence are recorded.

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

The reviewed release was promoted to the live Workers on 2026-08-17, and the
Delivery and Operations D1 ledgers were applied through Client `0142` and
Operations `0029`; immediate rechecks reported no pending migrations. Every
portal-v2, Viewer, processing, and client-sharing capability remains disabled.
Activation still requires the isolated staging exercise, evidence packet,
external-provider checks, an operator-selected Project Alpha root, and the
per-boundary approval sequence in the 3D platform release runbook. PA
verification credentials must remain read-only.

## Known limitations and blockers

- The managed browser fixtures now own and await their listener shutdown. The
  current desktop/mobile suites exit normally; retain this teardown assertion
  in future browser-runner changes.
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
- Unsaved-form navigation protection and richer client-side POI naming remain
  usability follow-ups. Staff can already see every POI label and coordinate.
- Client KML upload/import/export is intentionally prohibited. Clients draw the
  work area in Mapbox; authorized Operations staff may export the accepted or
  revised geometry as KML.

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
controls. Do not adopt client KML import; Mapbox remains the client input
surface and KML remains an Operations-only export.

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

## Workspace hierarchy v2 shadow foundation

Migration `0121_client_workspace_hierarchy_v2.sql` is an additive, disabled
shadow model for the hierarchy contract. It separates a globally verified
identity from any one client account, permits independent membership in
multiple workspaces, requires each workspace to have exactly one Project Alpha
organization or standalone-client public ID, and stores versioned scoped
allow/deny entitlements. Complete PA directory generations, opaque folder
bindings, and hashed/expiring/revocable invitation records are separate from
the legacy account and project-grant tables.

`CLIENT_PORTAL_HIERARCHY_V2_ENABLED` is explicitly `false` in the checked-in
Worker configuration. With the flag off, all existing pilot routes continue to
use the legacy account/session/grant path. With it on, the new endpoints remain
fail-closed: they require a verified Access issuer/subject, active global
identity, active workspace membership, a complete active directory generation,
an active source entity, and an explicit capability. A matching deny wins.
Email and `primary_contact` are presentation data and never grant access.

Operations client administration is independently default-off through
`CLIENT_PORTAL_OPERATIONS_MANAGEMENT_ENABLED`. With both flags enabled, Team →
Clients shows the Project Alpha principal, the exact Operations-owned identity
binding state, effective allow/deny scopes, and invitation delivery status.
Eligibility and email hints never create a membership or data grant. Staff may
retry only an existing, unexpired invitation whose secret-bearing outbox row
is intact; its conditional update, idempotency receipt, and audit entry commit
atomically. New invitations remain an authorized client-manager action, and
content requires an explicit authenticated delivery grant.

### Existing-account Project Alpha root activation

Operations Administration exposes the bounded **Client account Project Alpha
activation** card for this one-time transition, both before and after migration
`0121`. It lists only active PA
clients whose active organization ancestry is internally consistent. The
operator chooses the concrete PA client; LTDS derives the one effective root:

- when the PA client belongs to an active organization, the workspace root is
  that organization while the legacy account retains the concrete client ID
  needed by project and service-request authorization;
- when the PA client has no organization, the workspace root is the standalone
  client itself.

The mutation requires an Operations administrator with global
`operations.manage`, request-origin/CSRF validation, an optimistic account
version, an unlinked active account, and a source root not assigned to another
account. It writes `client.account.project_alpha_root_linked` to `audit_log`.
It is idempotent for the exact same source and refuses automatic remapping.
Before `0121`, it preserves the original behavior and links only the legacy
account for the migration backfill. After `0121`, it pins and immediately
rechecks the PA client/organization projection version, then links the account
and creates the exact legacy workspace, identities, memberships, schema-v2
baseline generation, entities, checkpoint, entitlements, folder bindings, and
mandatory audit in one Delivery-D1 batch. A previously linked account with no
workspace rows may use the same bounded repair and records
`client.account.project_alpha_projection_repaired`. Any partial, conflicting,
different-root, or structurally invalid authoritative projection is marked
manual review and remains blocked. A correctly rooted complete schema-v2 or
schema-v3 authoritative generation at a higher checkpoint sequence is
recognized as projected and replays unchanged; the endpoint never overwrites
or lowers its checkpoint.

Production activation order:

1. Keep `CLIENT_PORTAL_HIERARCHY_V2_ENABLED`, `CLIENT_VIEWER_ENABLED`,
   Operations `VIEWER_INTEGRATION_ENABLED`, and
   `CLIENT_VIEWER_SESSION_ISSUER_ENABLED` false. Confirm the latest PA sync is
   healthy and the selected client/organization public IDs are stable opaque
   IDs. Take a D1 export or record a D1 Time Travel restore bookmark.
2. Apply the reviewed Client migration set through the current release while
   every new hierarchy/Viewer/share flag remains false. Migration `0121`
   intentionally leaves an account with neither PA ID unprojected, so the
   pending migrations do not guess a root or grant access.
3. In Operations Administration, review the displayed effective root and link
   the unrooted existing portal account (called a legacy account in the schema
   and migration code). With `0121` present, the same transaction also
   creates the complete legacy projection. Confirm exactly one
   `client.account.project_alpha_root_linked` audit event exists. Do not edit
   the IDs or seed projection rows with ad-hoc SQL. (For a fresh environment,
   linking before `0121` remains supported and its migration backfill creates
   the same projection.)
4. Before any flag changes, verify the new workspace has one non-null root
   column, its `legacy_account_id` is exact, it has one complete active
   directory generation/checkpoint, expected active memberships and explicit
   `workspace.view`/`delivery.view` grants, and `PRAGMA foreign_key_check`
   returns no rows. `projection missing` is actionable only when no projection
   rows exist; `manual review` is a stop condition for any partial or
   conflicting state.
5. For the authoritative PA hierarchy rollout, PA must publish the same exact
   workspace ID (`workspace-<legacy-account-id>`) and root descriptor in a
   complete signed snapshot. Activate the snapshot and verify its root,
   project ancestry, principal binding, entitlements, source sequence, and
   checkpoint before replacing the legacy generation.
6. Enable the hierarchy read path first and exercise workspace selection,
   project delivery, denial, and revocation on desktop and mobile. Viewer
   activation remains separate: apply Client `0138` and Operations `0026`,
   verify the Viewer Tunnel/readiness and shared HMAC contract, enable
   Operations Viewer integration and client-session issuance, associate one
   ready model with an authorized project, then enable `CLIENT_VIEWER_ENABLED`.
   `VIEWER_PUBLIC_SHARES_ENABLED` is not required for authenticated client
   viewing and remains a separate rollout.
7. Rollback is flag-first: turn the Client Viewer/session issuer and hierarchy
   flags back off. Do not erase or remap the audited PA root. Investigate and
   fix forward from the preserved shadow projection.

Invitation and member mutations have a second independent gate,
`CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED`, also checked in as `false`.

Migration `0126_delivery_share_recipient_snapshots.sql` adds the disabled
Operations public-share recipient seam. When
`DELIVERY_SHARE_DIRECTORY_RECIPIENTS_ENABLED` is exactly `true`, the Share
dialog replaces free-text email with a bounded server-backed typeahead. The
server first authorizes the exact folder, resolves one unambiguous longest-
prefix `portal_v2_folder_binding`, requires a complete active directory
generation, and returns only active PA principals whose live `delivery.view`
allow covers that binding owner and has no covering deny. It never returns the
full directory or uses an email/primary-contact flag as access authority.

The selected organization, department, client/project, or individual opaque
public ID plus the deduplicated active recipient-member set, display labels,
workspace, binding, owner, and directory generation are snapshotted for the
new share version. Later PA membership changes therefore do not silently
relabel or expand an existing audience. The snapshot is notification/audit context
only: `/s/` remains a bearer link, and the UI says explicitly that selecting a
recipient does not restrict who can use the complete URL. Clearing the field
still creates an unaddressed link. Legacy shares and the free-text form remain
unchanged while the flag is false. Do not enable this flag before the signed PA
portal projection, Operations folder bindings, and staged migration `0126`
have all been verified together.
Turning on the read-only hierarchy must not implicitly enable an unfinished
email-delivery or Access-enrollment workflow.

The shadow APIs include listing an identity's authorized workspaces,
stateless workspace activation, a bounded authorized hierarchy/typeahead read,
and client-manager invitation/member management. Activation stores no ambient
server-side selection; every later resource request must name and reauthorize
its workspace. A live workspace-scoped `member.manage` entitlement is required
for every team read or mutation. Invitations default to one exact active PA
project; workspace-wide access requires a separate danger confirmation.
Invitees can receive only `workspace.view`, `delivery.view`, and
`request.create`—never manager or delegated-share authority. Migration `0123`
adds hashed one-time tokens, seven-day expiry, durable idempotency/rate limits,
an email delivery outbox, and membership audit. Acceptance binds the exact
normalized invitation email to a cryptographically verified Access
issuer/subject; email alone never authorizes. Member removal is a recoverable
suspension that leaves child grants available for reassignment and refuses to
orphan the last active manager. Operations exposes the default-off staff
transfer/recovery workflow under Administration. The route requires an
administrator session plus global `operations.manage`, proves the replacement
is a live effective manager, grants only missing Operations-owned
`workspace.view` and `member.manage`, and suspends the previous manager only
after the replacement is effective. It never reactivates unrelated grants or
locally promotes/removes a Project Alpha-owned membership.
Migration `0127_portal_invitation_secret_scrub.sql` adds the terminal-state D1
trigger that atomically cancels a leased delivery and redacts its plaintext
token whenever an invitation is accepted, revoked, or explicitly expired.

Migration `0124_client_delegated_public_shares.sql` adds the default-off
delegation foundation without touching staff `shares`. Migration
`0130_client_delegated_share_provisioning.sql` adds browser-safe target labels
and fingerprint-bound staff mutation receipts. The Operations Share dialog can
provision an opaque target/delegation, Administration can transfer or revoke
authority, and the Client Deliveries page can list authorized targets and
create/list/revoke independent `/client-share/` bearers. No browser API returns
the binding prefix or target-relative prefix.

Creation uses a private named Operations service binding that resolves the
server-only folder target, repeats live authorization, mints an independently
signed bearer, and returns an auditable receipt. The client Worker never
receives the Operations `DELIVERY_TOKEN_SECRET`. Every bearer request continues
to recheck live workspace membership, `delegated_share.create`, delegation,
binding version, strict target containment, expiry and revocation.
The link is workspace-owned: `created_by_identity_id` is immutable provenance,
while runtime authority follows the delegation's current exact identity and
entitlement version. Operations can therefore adopt the same delegation to a
reviewed replacement manager without orphaning or silently broadening links.

Do not enable the flag until all of these gates have evidence:

- Project Alpha supplies stable public IDs plus complete, ordered, signed
  portal-v2 directory and entitlement generations; LTDS has a transactional
  ingestion job with replay/out-of-order handling and parity monitoring.
- Operations has deliberately bound every workspace root and delivery prefix;
  accounts without exactly one PA root remain on the legacy path.
- The native Email Service binding is present in the isolated staging config,
  its sender domain and exact sender address are onboarded/restricted, and the
  default-off transactional processor is proven. It leases a bounded batch,
  retries only transient failures with exponential backoff, rechecks live
  invitation state immediately before handoff, and scrubs the plaintext token
  after send, cancellation, acceptance, expiry, or permanent failure. Never
  log `payload_json`, message bodies, or invitation URLs.
- Operations exposes workspace-manager transfer/recovery only from
  administrator routes with global `operations.manage`; the client Worker
  cannot call that seam. Delegated-share recovery remains separately governed
  by the delivery-share permissions documented above.
- Cross-workspace IDOR, revoked/expired grants, deny precedence, incomplete and
  out-of-order generations, invitation replay, legacy-route isolation, mobile
  account switching, migration upgrade, and foreign-key tests all pass in
  staging.
- A separate security review approves any future `/client-share/` delegation
  chain. The existing Operations `/s/` authority cannot be reused.

Invitation links use
`/portal/invitations/accept#token=<secret>`. The fragment keeps the token out of
the HTTP request and referrer; the acceptance screen replaces the current
history entry without the fragment before it calls the authenticated API. The
backend still requires the exact Access-verified email, an unexpired pending
invitation, the stored token hash, and—when autonomous enrollment is enabled—the
exact current, unrevoked invitation enrollment receipt in the same acceptance
transaction. It rejects an invitation for an identity whose existing workspace
membership is Project Alpha-owned, so local invitation entitlements and legacy
bridges cannot acquire a second lifecycle owner. Migration `0132` enforces the
same `client_invitation` source invariant for historical backfill and direct
database bridge writes. Replays by the same issuer/subject are idempotent; a
different email or subject is denied. Email delivery does not
provision Cloudflare Access by itself, so the Access enrollment gate remains a
separate release requirement.

The existing `client_access_sync_outbox` cannot satisfy that requirement for
workspace-v2. It is legacy-account scoped, emits imperative per-source
provision/revoke commands, and has no deployed consumer; using it could remove
an email that remains eligible through a different workspace. Autonomous mail
therefore also requires `CLIENT_PORTAL_ACCESS_ENROLLMENT_READY=true`, which is
reserved for a dedicated internal desired-state reconciler targeting only the
Client Portal Access group. The public Client Worker must never receive the
Access management token. Manual staging pre-enrollment can exercise acceptance
UX but is not autonomous-invitation release evidence.

Migration `0133_portal_invitation_access_enrollment_receipts.sql` adds the
durable handoff contract for that future reconciler. A newly queued invitation
cannot be leased by the email processor without a live server-written receipt
bound to its invitation ID, workspace ID, normalized-email SHA-256, current
invitation-token hash, and monotonic enrollment version. Terminal invitation
state revokes the receipt. The global readiness flag remains an additional
operator gate; it never substitutes for the per-invitation receipt. Existing
queued rows are deliberately left without a recipient hash and remain
ineligible until a reviewed reissue flow creates a new invitation.

Migration `0135_security_scan_followups.sql` makes revocation ordering durable.
The reconciler records the highest revoked enrollment version even when its
positive receipt has not arrived; the same or an older delayed callback is
denied, while a genuinely newer enrollment version remains eligible. The same
migration keeps expired supporting-file rows visible and blocks request
submission until the client explicitly removes the expired file or uploads a
replacement that reaches `accepted`.

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
