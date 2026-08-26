# Client workspace and portal roadmap

Status: approved direction; implementation in progress. Audited against Operations
main on August 25, 2026. This is a delivery plan, not a claim that the features
below are already enabled or complete.

The source handoff is the August 24 Project Alpha / Operations & Client Portal
development handoff. Its final external-collaboration workflow ends mid-list;
the preceding requirements are retained here without inventing a missing ending.

## Boundaries

- Operations is the operational layer over the existing separate Project Alpha
  installations. Do not consolidate those installations.
- Project Alpha remains generic and owns its business records, service catalog,
  pricing, contracts, invoices, and financial communications. Operations must not
  create a competing service or pricing database.
- The 3D Viewer repository is frozen for this work while Hermes owns its runtime
  changes. Record any required Viewer contract change as a separate handoff.
- Preserve existing public delivery links, authenticated delivery, thumbnail
  ownership, staff ACLs, and client authorization while extending workflows.
- Do not redesign the main dashboard before the client workflows work well.
- Code availability, automated test success, production feature flags, and a
  verified live workflow are different states and must be reported separately.
- Production migrations, mail, client invitations, access changes, and destructive
  testing are not implicit consequences of a local UI test. Use synthetic local
  data and obtain the required authority before external side effects.

## Identity and ownership model

Keep four distinct concepts:

1. **Business party:** the Operations customer, either an organization or an
   individual, which may link to multiple external business records.
2. **Source record:** a connector-qualified Project Alpha client, organization,
   project, service, or contact. Its source and lifecycle owner remain explicit.
3. **Authenticated person:** a verified issuer/subject identity, independent of
   business-contact records and reusable across independently authorized workspaces.
4. **Authorization:** explicit workspace/project/folder/resource grants and denies.

Linking business records changes presentation and operational context only. It
must not merge login identities, memberships, roles, billing authority, or content
grants. Names, email addresses, domains, and folder paths may suggest a match for
review but must never perform an automatic merge or grant access.

An operational contact need not have a login. A primary contact is not implicitly
an administrator. Service visibility determines which workflows are offered; it
does not bypass resource authorization or explicit denies.

## Audit findings that govern implementation

### Reuse existing foundations

- Dedicated Client Hub/detail routes and the oldest-first service-request queue.
- Verified portal identities, explicit scoped grants, deny precedence, invitation
  receipts, multiple manager entitlements, and staff recovery controls.
- Authenticated folder delivery and same-origin, authorization-checked file access.
- Durable notification outboxes, a five-minute file-change grace period, and the
  client notification bell.
- Signed/versioned Project Alpha service catalogs and request drafts/revisions.
- Versioned operation Job Briefs, private attachments, pinned SOP revisions,
  optimistic concurrency, and unsaved-draft protection.

### Gaps and conflicts

These are baseline audit findings. Local corrections and release state are
recorded by slice below; an implemented local correction is not yet a live fix.

- Client Hub eagerly loads the directory, fails above 500 roots, and expands
  access rows inline. Detail histories fail above 200 rows. Replace those limits
  with bounded server queries and progressive navigation, not larger constants.
- Client Hub's current project list is an access-grant inventory, not complete
  business project history. Show these separately and retain `projects.view` and
  assignment/division scope checks before returning business project details.
- No meaningful client activity rollup exists. Projection refresh timestamps and
  page views must not count as business activity.
- Current Alpha projection IDs, leases, fingerprints, receipts, snapshots,
  portal roots, and catalog activation assume one producer. A second connector
  can collide with or deactivate the first producer's records. Do not enable it
  until all relevant state is source-scoped and tested.
- Current staff role synchronization also assumes one Alpha authority. A second
  connector must not gain global Operations administration from a matching role
  label or overwrite another source's user association by email.
- Completed-project hierarchy authorization currently has a global 30-day
  cutoff. The new policy instead retains ordinary client project history while
  expiring external-collaborator grants. Do not replace the global 30 with 7.
- Existing invitations intentionally cannot delegate manager authority. Peer
  client-admin appointment requires a separately bounded policy and tests.
- File notifications are currently per-object/per-recipient, lack staff Send Now
  and Cancel controls, and do not cover every authenticated v2 delivery path.
- Audit records exist in several stores but lack a unified filtered timeline;
  authenticated content access also needs deliberate audit coverage.
- Generic feedback, role-based operational contacts, project memory, selective
  recurrence, and per-client service assignments remain new work.

## Release slices

Each slice requires implementation, automated coverage, browser acceptance,
documentation, and a safe migration/rollback plan before release. Do not turn
this roadmap into one unreviewable migration or deployment.

### Navigation and delivery-link cleanup (added August 25)

- Top navigation: Dashboard, Airspace, Operations, Client Hub, Models, Data,
  then Administration. Permission-limited staff see only authorized entries.
- SOP Library lives under Operations. Existing SOP document/revision URLs remain
  usable; canonical new links use the nested Operations route.
- Models uses the existing Operations Viewer overview as its own top-level entry,
  not a Data subtab. No direct Viewer runtime work is included.
- Recent client links show at most eight links targeting the current folder or
  its descendants. A client root includes that client's subfolders; a subfolder
  excludes siblings and ancestor-wide links. Folder matching is literal and is
  applied alongside authorization before pagination.
- View folder links opens searchable, paginated scoped history. Search, Clear,
  refresh, Load More, and Back/Forward retain folder scope; View all links is
  explicit. The global history and dashboard remain unscoped but authorized.
- Search labels, inputs, buttons, helper text, recent links, and Trash have
  responsive spacing. Folder changes cancel stale reads; loading and failures
  are distinct from an empty result. Share creation refreshes the recent panel.
- Browser gates cover mobile and desktop navigation/spacing, legacy SOP URLs,
  restricted permissions, folder scoping, stale responses, errors/retry, and
  unchanged Viewer launch behavior.
- Reselecting the current Data subtab preserves its URL query/folder state.
  Confirmed link revocations survive concurrent search/filter reads; an older
  response must not make a revoked link appear active again.

Follow-up requested August 25 (verified locally; not published): show a current
view item count, split into folders and files. Count immediate folder entries
only, never descendant contents. Search counts describe matching results rather
than the underlying folder. Mark partially loaded listings explicitly and do not
present stale, loading, or failed results as a final total. This does not change
the separate recent-links policy, which includes links within the folder tree.
The type check and production build passed, as did 14 focused unit tests and
74 desktop/mobile browser tests, including 10 new count cases. Desktop and
375-pixel mobile screenshots were visually reviewed. No API, migration,
thumbnail, or Viewer change is part of this follow-up.
Saved locally as `5e2ec18` (`feat(delivery): show current folder and file counts`);
this follow-up is not included in the deployed navigation release below.

Implementation notes: the optional `prefix` query on `GET /api/delivery/shares`
is an additional filter, not an authorization grant. Omitting it retains the
global authorized history. No database migration, source-object move, thumbnail
pipeline change, Project Alpha change, or Viewer change is required for this slice.

Local verification on August 25, 2026:

- Operations type checks and production build passed.
- All 697 unit tests across 98 files passed, including real local D1 coverage for
  literal folder boundaries, authorization, and filtered pagination.
- All 192 desktop/mobile browser tests passed in the final single-worker run.
  An earlier two-worker run passed 191 tests but failed one when the local browser
  could not load the stylesheet (`net::ERR_NO_BUFFER_SPACE`). The trace isolated
  that transport failure; no forced clicks or weakened assertions were used.
- Desktop/mobile screenshots were visually reviewed for navigation, search
  controls, folder scope, and the gap between recent links and Trash.
- Released on main as `28827c4` (`feat(operations): simplify navigation and scope
  client link history`). All three Cloudflare builds (`ltds-ops`, `ltds-clients`,
  and `ltds-ops-sync`) completed successfully.
- Read-only checks in the deployed application verified the navigation order,
  nested SOP Library, standalone Models overview, recent links changing from
  the client root to one selected client, and folder-scoped searchable history.
  No production migration, client-access change, or content mutation was needed.

### Unreleased directory checkpoint (August 25)

The next directory slice remains local and is **not ready to deploy**. It adds
server-side bounded search, stable continuation cursors, source-qualified direct
detail links, responsive cards, and a resumable rebuildable index. The initial
five index integration tests passed, including 620 roots and restart checkpoints;
34 focused directory/detail/eligibility tests passed before the contract review.
Those synthetic tests do not establish compatibility with the real Alpha export.

The subsequent local checkpoint passes type checking, the production build,
six index integration tests (including the query-budget and moved-account
guards), and 18 desktop/mobile directory browser tests. Mobile, laptop, and
ultrawide screenshots were inspected; request title/metadata spacing was corrected.
The final focused directory/detail/eligibility gate passes all 42 tests, including
long literal searches, moved/inactive source ownership, and fail-closed portal
principal search while the explicit ID mapping is unavailable.
These UI browser tests use synthetic API responses. They are not evidence that
the new directory is deployed or that the unresolved producer mapping works.

Explicit source-mapping implementation checkpoint (not deployed):

- Native Alpha public identifiers are 32 lowercase hexadecimal characters, not
  hyphenated UUIDs. The separate Alpha branch adds the existing stored public ID
  to v1 organization/client/project snapshots without changing numeric IDs or
  relationships. Focused v1 plus unchanged v2 tests pass (13 tests, 185 assertions).
- V2 public-ID export is deliberately deferred: upgrading existing fingerprints
  would write versioned events, and its unfinished event sequence does not yet
  guarantee commit order across concurrent transactions. Keep v2 disabled; this
  directory uses the existing v1 connector. The Alpha documentation records the
  required three-connection MySQL convergence proof before enabling v2.
- Directory identity now includes source, namespace (`business`, `portal`, or
  `account`), kind, and ID. Business IDs stay internal IDs; portal-only IDs are
  exact workspace IDs. Names/email/equal-looking raw IDs never link these roots.
- Native workspace association requires the explicit source mapping plus a
  selected complete portal generation/root. Legacy workspaces require their
  current account bridge and selected legacy-backfill provenance; historic
  internal IDs in `pa_*_public_id` columns are never treated as native IDs.
- Unmapped portal workspaces remain visible separately. Once verified, they fold
  into the business card; retained portal URLs resolve through fresh, unique
  mapping proof. Missing, pending, and conflicting links are distinct states.
- Seven index tests pass, including 620-root restart/query-budget coverage and
  native mapping arrival after a portal-only import. Sixty source/workspace/
  directory/detail/eligibility tests pass with the real identifier shapes.
  The isolated scheduler's two tests, type checking, and production build pass.
  The updated directory browser gate passed 24 cases, with mobile/laptop/
  ultrawide screenshots inspected. A subsequent generated-type check exposed
  local dependency drift (installed Wrangler 4.125 versus lockfile 4.118).
  The provisional full unit run was stopped and `npm ci` restored the existing
  lockfile without modifying dependencies. Final typegen, unit, build and browser
  gates must now be rerun against these exact versions. Source-public-ID lookup
  expression indexes and a query-plan regression were added after the earlier
  focused runs and are also awaiting this final gate.
- Locked-dependency follow-up: generated Worker types, TypeScript, production
  build, all 755 unit tests across 103 files, and the full 216-test browser suite
  passed with Wrangler 4.118.0 and Vitest 4.1.10. The newly added populated
  migration test passed separately. This is the directory baseline, before the
  subsequent detail-pagination gate; do not count the earlier stopped run as
  verification. No package manifest/lockfile change was needed.
- A populated upgrade regression applies actual Operations migrations through
  0031, seeds valid/missing/malformed/duplicate public-ID payloads, then applies
  0032. It passed with payload preservation, both mapping-index query plans,
  initial readiness, revision behavior, cascading search cleanup, and database
  integrity checked. An organization/active/client index also prevents contact
  counts from scanning every unrelated client for each organization card.
- Search covers root names, current-owned business contacts and their scalar
  email/phone fields, and authorized projects. Portal-only login/contact search
  is explicitly unsupported in this slice (`portalContacts: false`); arbitrary
  cross-database principal matches cannot be safely filtered after pagination.
  Search freshness is labeled, and source moves/deactivation are checked live.
- Index maintenance has its own offset cron invocation, with bounded pages,
  time, and D1 statements. It does not run within thumbnail/notification work.
  Production migration, initial backfill, release and read-only live acceptance
  remain pending. No permissions, memberships, or source records are written.
- Alpha prerequisite is committed locally as `38dc6c81` on
  `codex/client-source-public-ids` in the isolated Alpha worktree. Its broader
  local gate passed 536 PHP tests (86 skipped) and 29 frontend tests. The push
  was explicitly rejected by the permission reviewer: no remote branch, PR,
  merge, or image publication occurred. Obtain explicit user approval before
  publishing the three reviewed files to `ledgetoptechnologies/Project-Alpha`
  and opening a PR against main; do not bypass or retry the rejected push.

Release gates and remaining follow-up:

- Alpha's `OpsSnapshotService` and `OpsSnapshotV2Service` export internal numeric
  client/organization/project IDs. `PortalProjectionService` uses public IDs.
  Released v1 producers do not yet export `public_id`. Release the additive v1
  producer change and verify the normal sync retains it before claiming native
  business-to-portal mapping in production. V2 remains unchanged and disabled.
- Do not activate migration 0032 or the new directory until final gates pass.
  Apply the additive index migration before deploying its consumer, confirm the
  isolated schedule runs, and wait for `ready=1` before live workflow acceptance.
  During initial preparation the directory returns a retryable 503, not an empty
  client list. Roll back application code if needed; keep additive index tables
  for recovery, and never roll back authoritative client/access/source data.
- Reconciliation must have its own bounded invocation budget, not consume the
  existing thumbnail/notification cron's subrequests. The draft reserves at most
  800 D1 statements per invocation as well as page/time limits; activation still
  needs migration/backfill/rollback verification. Cloudflare
  documents a 1,000-query paid invocation ceiling, including statements within
  batches: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
- Periodic search state needs honest freshness and live ownership checks for
  moved/deactivated contacts and projects. Successful local tests must include
  those cases, not only unchanged synthetic source IDs.
- At this baseline, portal identity/access-list limits remained separate work;
  the follow-on below replaces that reader. Meaningful activity rollups remain
  unfinished. This slice does not enable a second Alpha producer, merge business
  records, grant access, or complete the roadmap.

Detail pagination is implemented locally: seven non-identity collections start
with five records and have independent continuation routes (25 by default, 100
maximum). Business contacts remain distinct from portal principals.
Account/project and delivery rows use composite keys; mapping, account
ownership, and permission context is checked before and after collection reads.
Changed context clears all visible sections and cancels other pending reads.
Ordinary transient errors retain the affected section's data and offer Retry.
Suspended/disabled portal aliases retain their portal status without falsely
invalidating an unchanged business root.

The focused backend gate passed 70 cases before the alias correction, followed
by all 26 affected Client Hub cases including the two new alias regressions.
Type checking and the production build passed. All 246 desktop/mobile browser
tests passed in the final single-worker run (including 30 new pagination cases),
with layouts visually reviewed at 375, 640, 1280, and 3440 pixels. Coverage
includes independent continuation, duplicate clicks, keyboard focus, composite
keys, legacy links, refresh after access changes, and late-response cancellation.

The subsequent full unit run exercised 766 cases across 104 files: 764 passed,
and two failed with Windows loopback `EADDRINUSE` errors in the local Miniflare
transport. A serial isolated rerun of both affected suites passed all 32 cases.
The two alias regressions were added during that run and passed separately in
the 26-case affected suite above. These are complete coverage results across a
full run and explicit retries, not a claim of one clean final full-suite pass.
Repeat the serial full gate from the runbook before publication/merge.

The clean serial baseline was subsequently completed against checkpoint
`45800a9`: **768 tests across 104 files passed**, with no failures, in 710.63
seconds on August 25. This baseline precedes the progressive portal-login and
business-history integration below; it is not the final gate for those changes.

### Follow-on local work: portal logins and business history

- Replace eager portal principal/access reads with bounded, independent pages.
  Keep business contacts, verified logins, workspace membership, explicit rules,
  and effective resource authorization distinct. Current-principal context
  fences must prevent a stale login header from receiving another identity's
  rule history.
- Add a separate business-project history, authorized with `projects.view` and
  the existing assignment policy. Delivery access inventory is not a substitute
  for that history. Source creation dates may order records; local sync times
  are not business activity.
- Invitation retry had a concrete receipt-format defect: the common hash helper
  emits base64url, but deployed migration 0149 requires a 64-character receipt.
  A new regression using the actual migration reproduced seven failures before
  the fix. The narrow hexadecimal SHA-256 correction and normalized-email match
  pass all **8 new cases**, including idempotent replay, expired/redacted
  invitations, authorization flags and transactional audit-failure rollback.
  Other fingerprint formats and the database constraint remain unchanged.
- The isolated business-history module passes **10 focused tests**. The final
  focused real-D1 portal-login reader run passes **11 tests**, including 532
  principals, 5,005 access rules and 510 invitation records. The associated six
  eligibility mutation tests pass. One Hub route-test expectation was corrected
  to require 403 when project permission is absent; its isolated rerun passed.
  The combined full suite is still required below, not inferred from these runs.
- Additive Delivery migration 0152 passes a full-chain populated upgrade and
  query-plan regression. Its four history indexes preserve all existing rows,
  constraints and audit triggers, and avoid sorting the matching histories for
  the tested exact lookups. No authority or source data is rewritten.
- Client Portal's actual full-migration-chain end-to-end and eligibility suites
  pass **13 tests** with 0152 included (55.03 seconds). Production data was not used.
- The five-file focused browser gate passes **100 desktop/mobile tests**. A
  subsequent expiry-badge and screenshot follow-up passes **60 affected tests**.
  Expired grants are no longer labelled active, revoked/inactive status takes
  precedence, and invalid/blank dates are explicitly unverified. This is display
  logic only, not a change to content authorization or Viewer behavior.
- Layouts were visually reviewed at 375, 640, 1280 and 3440 pixels, including long
  names/emails, wrapping controls, spacing and keyboard focus. Generated Worker
  types, TypeScript checking and the production build pass.
- The final serial Operations unit run passes **796 tests across 108 files**,
  zero failures, in 785.66 seconds. It includes the integrated history, portal
  reader, routes, invitation-retry and populated-migration regressions. Both
  Operations and Client Portal TypeScript checks pass.
- The final complete Operations browser run passes **290 tests**, zero failures,
  in 4.0 minutes with one worker. It includes both desktop and mobile coverage
  for the new Client Hub workflow and existing navigation, scoped links, SOPs,
  uploads, client requests, staff access and Viewer-launch behavior.

These follow-on changes have passed local integrated backend/browser acceptance.
They are not deployed. No live invitation or permission mutation was used for
verification. The separate pre-existing thumbnail documentation assertion still
fails the repository-level source-layout test; the runbook records this rather
than claiming that the entire monorepo gate is green.

Portal identity/entitlement/block/invitation pagination and scoped business
project history are integrated and verified locally; publication and deployment
remain pending. Rollout and recovery steps are recorded in
[the directory runbook](client-hub-directory.md). No part of this new directory
or detail checkpoint has been deployed.

### 1. Client foundation and find/open workflow

- Introduce immutable connector provenance and an Operations business-party
  mapping without changing existing authorization identities or source URLs.
- Preserve the current connector as the compatible default. Do not activate a
  second producer before source-isolation acceptance is complete.
- Add explicit, audited, idempotent business linking with conflict detection;
  any suggested match remains operator-reviewed.
- Build a bounded operational read model for customer names, source names,
  contacts, project references, service indicators, and meaningful activity.
- Client Hub defaults to All with Organizations and Individual Clients filters.
- Server-side search reaches unloaded records by name, contact, email, phone,
  project name, and supported identifiers. Search scope must be authorized before
  pagination; no browser-only search over the first page.
- Use stable cursor pagination and responsive direct-link cards, not inline
  expansion. Preserve query/filter state in the URL and Back/Forward navigation.
- Keep pending requests visible above the directory without downloading the
  whole customer database.
- Dedicated detail pages separate scoped business projects/history from portal
  access, show honest empty states, and link to real existing workflows.
- Never show an action that silently does nothing or bypasses its ownership
  boundary. New Project/Create Document must route to an authorized Alpha action
  until an explicit versioned write contract is implemented.

### 2. Contacts and project memory

- Separate operational contacts from login principals.
- Support organization primary/billing/delivery roles plus project/site roles,
  multiple site contacts, phone/email, preferred contact method, and arrival notes.
- Reuse Job Brief revision, attachment, and SOP patterns for project memory:
  plan, actual outcome, deviations/reasons, observations, issues, successes, and
  recommendations for the next occurrence.
- Support text, private images/screenshots, PDFs, and appropriate attachments;
  annotation authoring is a deliberate feature, not assumed from file upload.
- Provide a field-friendly view with contact, arrival instructions, maps, notes,
  requirements, procedures, and deliverables.
- Create Next Occurrence / Use as Template selects copy-forward fields, creates
  a new authoritative job/project, and copies Ops-owned content independently.
- Never copy grants, invitations, completion state, invoices, or pending notices
  implicitly. Historical records and attachment provenance remain intact.

Contacts/project-memory audit and local follow-on (August 25):

- Existing Job Briefs are operation-owned. Reuse their optimistic versions,
  immutable revisions, private-attachment and pinned-SOP patterns; do not rename
  them into project memory or reuse source-operation attachment URLs as if the
  destination project authorizes them.
- Alpha owns named contacts, departments, project-contact assignments and billing
  flags. The current snapshot exports contact email/phone and a primary
  `project.client_id`, but not every department/project role or organization
  general contact channel. Missing projections are not proof of absent contacts,
  and `project.client_id` must not be relabelled as the site contact.
- The existing contact display gap is corrected locally: explicit nullable email
  and phone now come from guarded, bounded JSON text extraction, replacing empty
  placeholders and obsolete identity/access fields. Real local D1 fixtures cover
  initial/continued pages, malformed/non-string/long/control-bearing values,
  private-field exclusion and current contact ownership. No new migration or
  Alpha export is needed for these channels.
- A staff-only, source-scoped **read-only** project workspace is implemented
  locally. Business project links preserve client filters; the detail reader
  rechecks live project visibility and root ownership and labels Alpha's
  `project.client_id` as a linked contact, not a site/billing role. No note-editing
  permission is inferred from assignment or directory visibility.
- Explicit Ops-owned site roles, versioned text memory and selective copying
  into an **existing** authorized destination remain proposed. Creating a new
  Alpha project requires its authoritative contract. Attachment/SOP copying
  needs separate staging and ownership checks. See
  [project-memory-design.md](project-memory-design.md) for existing authority,
  proposed contracts and unresolved product choices, including the pending
  question about assigned field-staff contributions.
- Copy requires source-read and destination-write authority, current contact
  ownership, an expected destination version and replay-safe request identity.
  Destination content is independently editable with source-revision provenance;
  do not copy grants, invoice-recipient flags or pending notifications.
- Before extending this slice, settle field-staff write access, whether local-only
  contacts are needed, cross-client copying and completed-project edit policy.
  Conservative initial proposals are manager-only writes, existing Alpha contacts
  and same-client/same-source copies; these are proposals, not enabled policies.

Read-only follow-on verification is separate from the `537310f` full-unit
baseline above. Its tests include a real Hono route, exact source/root ownership,
changed permissions and assignments, out-of-root/inactive contact suppression,
malformed source fields, browser route/filter history, invalid responses and
late-request cancellation. No migrations, Alpha writes, Viewer edits or
thumbnail-runtime changes are included. Final serial verification passed **56
focused backend tests** and the **322-test complete browser suite**, plus
TypeScript and the production build. The baseline full unit suite was not rerun
for this increment. Exact counts, visual acceptance and remaining release
prerequisites are recorded in the directory runbook. This follow-on remains
local and unpublished.

### 3. Predictable client and collaborator access

- Retain ordinary authorized client history with recent-first progressive UI.
- Apply explicit expiration to external-collaborator grants: a date, project end
  plus seven days, or manual revocation. Invitation acceptance expiry is separate.
- Define behavior for unknown end dates, extended/reopened projects, manual
  overrides, and already-expired access before enabling automation.
- Add organization invitation policy: disabled, administrator approval, or
  allowed. Preserve existing behavior until an operator explicitly configures it.
- Provide a lightweight reusable organization address book.
- Support multiple client administrators with bounded delegation ceilings,
  last-manager protection, staff override, and complete audit history.
- Notify the collaborator and inviter of scheduled expiry and revocation without
  deleting the person's account or other independent workspace memberships.

### 4. Portal-native delivery and Operations notification center

- Deliver into the selected client/project/folder using existing authenticated
  delivery infrastructure and predictable inherited permissions.
- Cover legacy and current authenticated grant producers without duplicate mail.
- Batch related changes by authorized client/project/audience into one pending
  notification with a five-minute grace window.
- Expose countdown, Send Now, Cancel, and reviewed recipient changes. Dispatch
  must recheck permissions/recipient eligibility and fence races with cancellation.
- Default recipients to explicit project/delivery contacts, not the entire
  organization. Separate notification audience from resource-access authority.
- Add a staff inbox for requests, feedback, pending notifications, integration
  failures, access changes/expiry, and other actionable events.
- Keep client preference controls as a later backlog item.

Local follow-on implemented and verified (August 25; not published): the existing `0115` subscriptions
debounce per object, not per audience, so one forty-photo upload can emit forty
messages to one person. This bounded increment adds `0153` audience batches
and `0154` staff-control receipts, an Operations Notifications subpage, current
division-scoped audit/create/revoke permissions, a grace countdown, Send Now,
Cancel, terminal history, and progressive server search. Existing subscribers
remain the only recipients. Viewer and thumbnail code stay frozen.

Each batch keeps one exact account, logical folder grant and subscribed identity;
it does not combine independent grants or infer a notification audience from
business contacts. Send Now ends the current grace period but does not claim
delivery success. Cancel stops pending work, including remaining retry attempts;
it cannot recall a message already accepted by the mail provider or remove an
already-published portal notice. Existing files and access grants are unchanged.

The final Operations gate passed **867 unit tests across 111 files**, including
the populated legacy-database upgrade proof, and **370 desktop/mobile browser
tests**. TypeScript and the production build passed; layouts were visually
accepted at 375, 640, 1280 and 3440 pixels. The separate focused notification UI
gate passed 48 cases, and 29 focused Client notification/workspace/eligibility
tests passed. No production migration, mail, access mutation or deployment
was performed for this increment. These checks do not complete the outstanding
multi-source identity, project-memory or general-notification roadmap.

This is not the entire delivery/notification roadmap: initial-access,
public-share, native-workspace and request outboxes remain separate; editable
recipient staging, explicit project/delivery-contact defaults, and the unified
staff inbox remain outstanding. See [notifications.md](../notifications.md)
for adoption, retry/cancellation semantics, provider boundaries and rollout
requirements. Do not publish or claim production acceptance from local tests.

### 5. Generic feedback and service requests

- One Leave Feedback flow with typed project/folder/asset targets and a shared
  New → In Progress → Done lifecycle. Clients do not classify the feedback.
- Manual completion, optional note, idempotent notification, and an authorized
  deep link. Preserve business history without retaining duplicate media solely
  for before/after review.
- Website-element feedback and video timestamps extend the same target model
  later; they are not separate ticket systems.
- Present the Alpha service catalog category-first, with source-aware request
  routing and per-client service visibility.
- Keep internal prices private by default. Starting-at/fixed-price visibility
  requires an authoritative versioned Alpha contract; never infer it locally.
- Routine technical deployments do not automatically notify clients.

The baseline source audit found a flat catalog and a New Request entry point
without current `request.create` readiness. The next local increment implements
scoped readiness, target selection before autosave, category-first
browsing, bounded catalog pages, saved-version warnings, and transaction-time
catalog guards. It is verified locally and not published. The final serial Client
backend gate passed **521 tests across 50 files**, zero failures or skips, in
**471.67 seconds**; the complete Client browser suite passed **138 tests**,
including 34 new cases. TypeScript and the production build passed, and layouts
were visually accepted at 375, 640, 1280 and 3440 pixels. A stale migration-test
filename whitelist was replaced with SQL trigger detection; the real populated
upgrade/FK checks and test timeouts were preserved. No application migration or
Viewer/thumbnail runtime change was required. These are local package results,
not a claim that the full monorepo or production workflow is accepted. See
[the service request runbook](client-service-request-readiness.md).

A native workspace may still require an active legacy account/identity bridge
for requests. Per-client service visibility is not projected yet, and the
singleton catalog checkpoint is not a multi-producer contract. Existing
authorized draft pricing hints are supported and retained; catalog browsing
does not expose internal pricing. Generic asset/folder/project feedback is a
separate feature, not a relabelled request or inspection note.

The feedback increment is implemented and verified locally on August 26, not
published. Its additive `0155` migration and transactional store pass populated
upgrade, replay, concurrent-transition, revocation-guard, and audit/outbox rollback
checks. Final package gates pass **566 Client backend tests (52 files)** and
**905 Operations backend tests (114 files)**, without failures or skips; full
browser gates pass **172 Client and 410 Operations tests**, with four intentional
duplicate-viewport skips in Client. Both types/builds pass and layouts were
independently reviewed at 375, 640, 1280, and 3440 pixels. The first slice
targets authenticated project/folder/file feedback only; it does not modify the
Viewer or add anonymous, annotation, attachment, or timestamp feedback. See
[the feedback contract and rollout checklist](client-feedback.md) for scope,
ownership, mail semantics, and the outstanding gates.

### 6. Unified activity and release acceptance

- Meaningful append-only activity records carry actor, organization/client,
  source, resource, action/result, occurred time, and replay-safe event identity.
- Client/org activity rolls up from meaningful project, task, document, delivery,
  feedback, request, and supported financial events; opening a page has no effect.
- Global audit filters and scoped client/project timelines use bounded queries.
- Authentication telemetry comes from actual authentication events, not fabricated
  page-load events. Content access auditing is bounded and avoids noisy per-chunk
  records or secrets/capability URLs in logs.
- Confirm migrations, foreign keys, source isolation, rollback/recovery, browser
  behavior, authorization, notification races, and operational runbooks.

## UI and workflow acceptance matrix

Test the complete workflow, not only whether a component renders:

- Find an unloaded customer by contact/email/phone/project; filter, Load More,
  open detail, refresh, Back/Forward, and recover from an interrupted request.
- Verify empty/loading/error/retry states, duplicate-click prevention, cancellation,
  stale-response handling, keyboard focus, labels, contrast, and long content.
- Exercise populated mobile, 13-inch laptop, standard desktop, 200% zoom, and
  ultrawide layouts. Use content-driven card sizing, not a fixed card count.
- Same source ID in two connectors stays separate; linking/unlinking customers
  never grants access; one source's snapshot/revocation cannot alter another.
- A contact with no login and a login with no grant remain distinct; access in
  workspace A must not label or authorize workspace B.
- Scoped project history is separate from access inventory; unauthorized business
  details are omitted before pagination, not merely hidden in the browser.
- Concurrent note edits conflict safely; drafts survive appropriate navigation;
  copy-forward yields independently editable records and no copied permissions.
- A collaborator sees only the granted scope; new deliveries inherit correctly;
  explicit deny wins; expiry/reopen/override and last-manager cases are tested.
- Forty related uploads produce one pending notice; accidental changes can be
  removed/cancelled; Send Now races safely; revoked access suppresses delivery.
- Feedback on an exact asset stays unambiguous, replay does not duplicate it,
  manual completion sends once, and revoked targets cannot leak their content.
- Missing or unhealthy connector/mail/scanner states are actionable and do not
  silently appear successful.

## Current checkpoint

- [x] Read and reconcile the handoff against current released Operations source.
- [x] Record the identity, authorization, source ownership, and Viewer-freeze boundaries.
- [x] Create an active goal and phased plan with UI/workflow acceptance.
- [x] Correct the existing cross-workspace eligibility display defect and regress it.
- [x] Implement and locally verify navigation and scoped delivery-link cleanup.
- [x] Release the verified navigation slice and check it in the deployed UI.
- [x] Integrate bounded portal-login reads and scoped business-project history
      locally; keep authority separate from contact records and access inventory.
- [x] Add projected business contact channels and a read-only, source-qualified
      project workspace, with responsive layouts and permission/race regressions.
- [x] Locally implement and verify legacy folder-change notification batches,
      scoped staff controls, retry/cancellation races and populated upgrades.
- [x] Locally implement and verify scoped request readiness, category-first
      paged service selection, saved-draft protection and atomic catalog guards.
- [x] Locally implement and verify current-view folder/file counts without
      descendant totals, including filtered and partially loaded listings.
- [ ] Implement slice 1 and verify its backend-to-browser workflow.
- [ ] Implement and verify subsequent slices without broadening authority implicitly.
- [ ] Verify live workflows after approved deployment; do not equate local tests with
      production acceptance or claim the whole roadmap is complete prematurely.
