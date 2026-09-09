# Client portal and Client Hub acceptance checklist

This checklist is the release evidence map for the August 2026 Project Alpha,
Operations, and Client Portal handoff. A feature is not complete merely because
a table, route, or card exists. Completion requires the stated source of truth,
authorization boundary, recovery behavior, user workflow, automated coverage,
and live acceptance to agree.

The Project Alpha instances remain separate producers. Operations may unify
their presentation through explicit source-qualified business-party links, but
must not merge producer records by name, email, or other inferred similarity.
The 3D Viewer is outside this work while Hermes is changing it.

## Current production acceptance warning — September 9, 2026

Use the [September 9 checkpoint](client-portal-checkpoint-2026-09-09.md)
for the newest inspected production state. Both PA business directories are
visible, but neither source has a native portal workspace in Client D1.
Primary has a staged page without activation; secondary has pending Ops
forwarding receipts whose projection family still needs diagnosis. Source
enrollment and healthy business synchronization are not native-portal
acceptance. Historical implementation and deployment claims below must not
override that direct evidence.

Incoming pickup is the operator's existing hourly TrueNAS rclone PULL/MOVE
task, not a new server worker. The [rclone-native rollout](../truenas/incoming-rclone.md)
requires coordinated ready-prefix selection, basic-check publication, and
browse/download verification before resuming that task. Never infer a pickup
receipt solely from R2 object absence.

The owner explicitly authorized Ledge Top Technologies enrollment on September
7, 2026. Authorization is not evidence that the source is enrolled or accepted:
keep LTT pending and hidden until its dedicated Access service token, snapshot
key, Ed25519 public key, exact-source receipt, and historical snapshot have all
been verified. Enroll the existing LTDS primary first and preserve its healthy
legacy route during the staged handoff. Both Project Alpha instances use the
same Ops Sync application and Worker; LTT uses the source-qualified event path,
its own immutable producer identity, and its own credentials. Do not create a
second portal connection or share either producer's keys.

The dated production admission, migration, and provisioning checkpoint is
recorded in
[client-portal-production-evidence-2026-09-01.md](client-portal-production-evidence-2026-09-01.md).
It verifies the shared two-domain Access boundary and preserved public links,
but also records that no portal workspace or membership was provisioned at that
checkpoint. Treat that state as partially deployed, not live accepted.

The [September 3 Access consolidation evidence](client-portal-access-evidence-2026-09-03.md)
supersedes that checkpoint's hostname-to-application mapping: both portal
domains now share the original application, while the legacy client domain has
its own application. Private-path redirects and public fake-link shells were
verified, but authenticated J7 workflows remain unverified.

The ordered activation dependencies, rollback rules, bounded local test
partitions, and joined workflow matrix are maintained in the
[client portal rollout manifest](client-portal-rollout-manifest.md). That
manifest is an execution checklist, not permission to enable a feature or
mutate production.

Project Alpha's current onboarding, approval, project, contract, and document
workflows are authoritative. Portal integration changes must compose on top of
them through the single External Operations profile; they must not replace,
fork, or reimplement those workflows in Operations or Client. The producer must
emit outer `portal.projection` events to its exact configured Ops Sync webhook;
Ops Sync validates that existing Access/HMAC contract and privately invokes the
Client Worker named entrypoint. A direct Project Alpha-to-portal connection is
an acceptance failure.

## Evidence states

- **Verified locally**: implementation and focused automated evidence exist on
  a prepared branch, but the feature may still be default-off or unpublished.
- **Published**: the verified change is on the appropriate main branch.
- **Live accepted**: migrations/configuration are applied and the real workflow
  has passed an authorized production smoke test.
- **Missing**: the user workflow or required evidence does not yet exist.

## Identity, services, and Client Hub

### Default-on provisioning requirement (reconfirmed September 3, 2026)

The current unpublished implementation and exact local test results are in
[the September 3 local evidence record](client-portal-default-on-local-evidence-2026-09-03.md).
That record does not replace the production acceptance checkpoint.

Creating an eligible client in Project Alpha must automatically provision its
portal access through the existing signed connection, without an invitation or
announcement email. An organization owns one workspace; a standalone client
owns its own workspace. Organization contacts are scoped principals in that
workspace, not duplicate organization workspaces. Missing, invalid, or ambiguous
email addresses require review. Department and individual delivery boundaries
remain explicit; workspace eligibility never grants arbitrary folder access.

Existing clients must be reconciled automatically in bounded, idempotent
background batches. An administrator's person/root revocation must survive
every subsequent sync, reconciliation, and sign-in. Source-qualified records
from separate Project Alpha instances must never merge by email or name.

Remaining live acceptance gates are the historical producer backfill, primary signed
native workspace enrollment/listing/resource routing, and regression coverage
for legacy client reparenting and member revocation. These are not yet live
accepted. The current checked-in release profile is `default-on-eligibility`;
the earlier receiver-only disabled-flag checkpoint is historical, not an
instruction to turn off the current coordinated configuration. Follow
[the activation runbook](project-alpha-portal-activation.md) and its profile-aware
preflight, and distinguish deployed flags from successful workspace creation.
PA's strict-MySQL activation fix is merged in `80fb0cc` (PR #174), but image
publication, production recreation, and successful reconciliation still require
verification. A successful business
directory sync or a green isolated membership test is not sufficient evidence.

| Requirement | Current evidence | State | Remaining acceptance |
| --- | --- | --- | --- |
| Source-qualified unified client grouping | `0036_business_parties.sql`, `business-parties.ts`, Client Hub business-party UI and tests | Verified locally | Publish and exercise a same-customer link across two configured Project Alpha sources without changing either producer record. |
| Searchable, progressively loaded Client Hub | Source-qualified directory/index workers, dedicated client route, desktop/mobile browser tests | Verified locally | Production search must find older clients by supported fields without preloading the whole directory. |
| Meaningful client/project activity | `0037_client_business_activity.sql`, source-qualified business activity and unified audit timeline | Verified locally | Confirm source events and local security/business events appear with correct provenance and no view-click noise. |
| Direct folder and file counts | Client Delivery current-view count and browser tests | Published | Count direct folders/files only; never include descendants. |
| Project Alpha service assignments | Producer/admin release branch, receiver migration `0168`, exact-source/exact-subject Client Hub card, plus migration `0174` default-off exact-target request-availability consumer with D1 and desktop/mobile tests | Verified locally; assignment consumer default-off | Publish, admit each source/workspace explicitly, and deliberately enable/live-prove exact request filtering. Assignments remain non-authorizing and never grant portal, file, request, pricing, or delivery authority. |
| External portal-access roster | Source-qualified membership/invitation reader, Client Hub card, D1 and desktop/mobile browser tests | Verified locally | Publish and verify same-email identities remain distinct and inactive/unassigned states are factual. |

## Contacts and operational memory

| Requirement | Current evidence | State | Remaining acceptance |
| --- | --- | --- | --- |
| Organization/project contact roles | Exact-source project `project_contact`/`site_contact` service plus migration `0045`, organization `primary_operational`/`delivery` roles, guarded staff routes, progressively loaded exact-root pickers, immutable revisions, and D1/desktop/mobile tests | Verified locally | Publish and live-accept both project and organization assignments. These operational references must never infer portal access, notification recipients, or billing authority. |
| Project memory and field notes | Versioned fixed-section operational memory plus migration `0047` manager-only staff attachments, guarded project-workspace UI, optimistic concurrency, retry-stable idempotency, immutable revisions/audit, lazy exact-source/root/project/version historical snapshot inspection, exact R2 integrity and cleanup recovery, post-completion amendment reasons, and source/root/race/cache-isolation tests; see [staff attachment runbook](project-memory-staff-attachments.md) | Verified locally | Publish and live-accept ordinary/terminal amendments, historical-version inspection, upload, replay, HEAD/range download, stale-conflict, and orphan-cleanup behavior after confirming `0047` remains applied. Attachments remain private staff uploads and are not copied or exposed to clients. |
| Recurring-project copy-forward | Exact-source/root preview and commit contract, explicit role/section selection, conflict-safe UI, atomic fences, immutable receipts, race/reassignment regressions, and desktop/mobile tests | Verified locally | Publish and live-accept a copy into an already-created Project Alpha destination. Never copy grants, billing, invitations, status, notification state, or empty values over useful destination data. |
| Authoritative project creation | Migration `0046`, reviewed exact-source **Create project in Project Alpha** routing, UI and tests | Verified locally | Publish, configure the reviewed Project Alpha URL for each source, and live-prove create in Project Alpha then sync back. Operations must not create a local record that pretends to be the authoritative project. |

## Delivery, notifications, and feedback

| Requirement | Current evidence | State | Remaining acceptance |
| --- | --- | --- | --- |
| Portal-native authenticated delivery | Native bindings/grants, access terms, staff and portal UI, tests | Verified locally, default-off | Publish, migrate, enable deliberately, and smoke-test grant/read/revoke against a real workspace. |
| Primary Operations folder-to-workspace linking | Migration `0189`, signed primary workspace/root selection, non-authorizing staff receipt, legacy compatibility backfill, runtime Operations/projection revalidation, and grant/revoke D1 transaction fences | Verified locally, default-off | Apply `0189` before the Operations build, prove the unreceipted active-binding query is empty, relink any unprovable legacy row, then live-test link, exact recipient/group grant, stale-context suspension, revoke ordering, and preserved public-link sharing. |
| Five-minute staged notification batching | Legacy folder and Project Alpha delivery-intent batches plus the migration-`0170` exact-authenticated-grant engine and migration-`0175` policy invariant, reviewed exact-person policy editor, three-lane notification center/Inbox, encrypted independent pagination, Send Now/Cancel, leases/retries, and desktop/mobile coverage | Verified locally, default-off | Apply migrations 0170 and 0175, deliberately enable the flag, and live-test shared R2 events, cron, suppression, retry, and outbound mail. Legacy subscriptions remain an independent explicit opt-in; no project/contact recipient is inferred. |
| Generic feedback | Primary and exact-source native project/folder/file feedback, New → In Progress → Done, immutable events, migration-`0184` native ownership, and migration-`0188` exact-recipient in-app completion notices | Verified locally, default-off | Apply the ordered migrations with `CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS` empty, then enroll one reviewed exact secondary source and live-test authenticated submission, triage, completion, direct return link, colliding IDs, identity/grant revocation, and notice read/dismiss. Native email, Viewer annotations, replies, attachments, and video timestamps remain follow-ons. |
| Project Alpha-backed service requests | Catalog, request drafts, attachments/work areas, staff review, exact connector quote handoff, migration-0174 assignment narrowing, migration-0185 native ownership, and an exact-workspace native request-notification bell with read/dismiss, stale-context cancellation, and workspace-pinned action links | Published; native and assignment consumers default-off | Deliberately enable one exact source and verify root/project authority, colliding IDs, attachments, replay/cancel, hidden storage accounts, exact quote destination, and client-visible request notifications. Assignments never grant `request.create`; project requests ignore organization assignments and all inheritance. Native feedback-completion and delivery-batch portal notices remain separate capabilities and are not implied by the request-only bell. |

## Delegated access and audit

| Requirement | Current evidence | State | Remaining acceptance |
| --- | --- | --- | --- |
| Delegated link creation with bounded scope | Delegated-share signer/provisioning, client UI, expiration and version/deny checks | Verified locally, default-off | Publish and live-test scoped creation, access, revocation, and manager recovery. |
| Named external collaborator membership | Reviewed invitations accepted into reusable verified workspace memberships, source-aware primary/secondary Team UI, suspension/revocation, address-book copy without authority conflation, project access terms, and backend/browser tests | Verified locally, default-off | Coordinate migrations, feature flags, invitation email, and live acceptance. Secondary `require_approval` remains explicitly unsupported and must not be implied by the UI. |
| Project-end expiration plus seven-day grace | Project access terms/deadline latching plus default-off, independently durable SMTP notice ledgers for seven-day, 24-hour, and expired collaborator and exact inviter/access-creator events; exact-origin/authority, ambiguity, retry isolation, recipient-race, duplicate-email suppression, stable Message-ID tests, and staff Client Hub notice history | Verified locally, default-off | Apply migration 0169, stage with SMTP, then live-prove collaborator and companion warnings/expiry without changing membership or independent grants. Client-facing notice history remains a separate decision. |
| Scoped meaningful audit coverage | Client/project timeline federates exact access ledgers, append-only migration-0172 project-access authority events, migration-0169 notice ledgers, redacted feedback lifecycle events, and migration-0187 legacy/native authenticated preview/download request events with current per-record authorization. Exact-client feedback history includes project, folder, and file targets for primary and native workspaces using migration 0200's source/workspace index. Coverage carries immutable collection boundaries with encrypted proof-bound high-water pagination and refresh-safe filters; authenticated content rows have archive-first 365-day retention. | Verified locally, default-off | Freeze authority mutations/reconcilers, publish both Workers with `PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED=false` and `CLIENT_PORTAL_CONTENT_AUDIT_ENABLED=false` at 100% traffic, drain old/in-flight work, apply 0172, 0187, and 0200, provision the dedicated content-audit HMAC secret, verify coverage, enable each producer only in its reviewed window, and emit canonical events before reopening ingress. Live-accept replay/expiry/isolation, authorization races, content audit fail-closed behavior, archive/readback, and feedback redaction/revocation. Approved global filtering, common retention for the other ledgers, and client visibility remain open. |

## Release gate

Before marking the overall goal complete:

1. Rebase each prepared branch onto the latest corresponding main branch and
   resolve source-layout or migration ordering conflicts.
2. Run populated migration upgrades, focused D1 tests, full unit/type/build
   gates, and supported desktop/mobile browser suites from pinned dependencies.
   Required GitHub CI runs the Client Portal and Operations browser suites on
   desktop and mobile Microsoft Edge. The Client Portal jobs also run the J7
   dual-domain cases for both portal hostnames; local browser evidence alone
   does not replace those required checks.
3. Complete security review for every new mutation or cross-database reader.
4. Publish only after explicit approval, apply migrations before enabling flags,
   and retain a rollback path.
5. Live-accept tenant/source isolation, stale-context invalidation, retries,
   accessibility, responsive layouts, and the daily operator workflow. The
   portal release must separately prove sign-in, refresh, logout, session
   expiry, revocation, unauthorized-user denial, and cross-tenant denial on
   both protected domains under the same Access application/audience/policy
   set. Reprove that canonical public links remain outside Access and
   unavailable on the secondary portal namespace.
6. Update this checklist with direct evidence. Missing or merely compatible
   behavior is not completion.

## Joined local acceptance matrix

Run these groups in separate processes on Windows. The authoritative complete
package gate remains Linux CI because a monolithic Windows Miniflare run can
exhaust loopback ports. A passing isolated retry is evidence for the isolated
case only; never add an automatic retry around a commit-ambiguous mutation.

| Group | Joined workflow | Required assertions before live rollout |
| --- | --- | --- |
| J1 — Identity and Client Hub | Seed one customer in two exact Project Alpha sources, link the records only through a reviewed business-party presentation link, then search, paginate, open both workspaces, unlink, archive, and restore. | Source records, cursors, workspaces, identities, grants, inactive states, and tombstones remain independent even when names or email addresses match. |
| J2 — Eligibility, services, and contact metadata | Reconcile eligible, review-required, revoked, and archived clients; consume one signed generation containing hierarchy, explicit services, and schema-v4 organization/department/project contact assignments; then tombstone an assignment and revoke the root. | Service and contact metadata never create identity, membership, delivery, request, billing, or notification authority. Every consumer follows the exact source, workspace, generation, and revocation. |
| J3 — Contacts and project memory | Open Client Hub project detail; edit organization and project operational contacts; version terminal project memory; inspect history; upload, range-read, and clean up a private staff attachment; preview and commit selected copy-forward data into an already-created Project Alpha destination. | Empty values never replace useful destination data. Attachments, access, billing, invitations, status, and notification state never copy. Destination reassignment and stale edits fail closed. |
| J4 — Membership and delegated access | Invite and accept a named member, exercise manager recovery, create and revoke a delegated bearer link, apply customer and collaborator project terms, latch completion-plus-seven expiry, emit notices, and inspect the audit timeline. | Membership and bearer links remain independently revocable; expiry of one project does not affect customer history or another project; reopening does not silently renew expired access; last-manager and concurrent-denial rules hold. |
| J5 — Native delivery and notifications | Bind one staff folder to an exact workspace/root, preview and publish a grant, read it in the portal, coalesce R2 changes for five minutes, Send Now/Cancel, and revoke. Repeat for one signed secondary source. | A lost receipt, leased-batch binding change, same-email person/group collision, or unreceipted legacy binding fails closed. Existing canonical public links stay outside portal authority and keep working. |
| J6 — Feedback and service requests | Submit authorized project/folder/file feedback through completion and client notice; verify the client's redacted own-feedback lifecycle list and separately authorized detail; then run catalog, assignment filter, draft, attachment, submit, review, estimate, exact Project Alpha quote handoff, notification, cancellation, and replay. | Assignment or authority changes between page load and submit are rechecked. Feedback list cursors are encrypted, actor/source/workspace/root-bound and fixed to an as-of high-water; list payloads contain no messages, completion notes, actors, or proofs. Source/root/project collisions, scan/cancel races, destination rotation, revocation, and feedback/request independence are covered. |
| J7 — Dual-domain daily use | On both portal domains, exercise sign-in, greeting/workspace selection, direct links, refresh, Back/Forward, logout, session expiry, unauthorized and unprovisioned denial, cross-tenant denial, and revocation during active reads. Run core flows at 375 and 1280 pixels with keyboard/focus checks. | Both hosts use the same Access application, audience, and policy, but hostname never grants application authority. The canonical public namespace remains separate. No horizontal overflow, stale data restoration, or hidden focus trap is accepted. |

The exact migration, flag, test-file, dependency, and rollback mapping for J1–J7
is in the rollout manifest. Production evidence belongs only in the dated
production-evidence record; do not mark a row live accepted from fixtures.

### J6 follow-up — confirmed draft visibility and notification

The September 6 joined audit found that confirmed PA draft receipts were saved
with request/admin audit records but without a client notification outbox
intent. A derived draft-created label alone does not complete J6. Track both:

- Exact-source, current request/area revision, non-stale receipt visibility in
  primary/native client request readers, without financial/editor details or
  a request lifecycle change.
- An atomic, receipt-deduplicated informational notification intent; dispatch
  must recheck current recipient authority. Native delivery must not acquire
  email authority merely because a receipt exists. No notice may imply quote
  acceptance, payment, or access to an unshared resource.

These slices are in isolated implementation branches and remain unverified for
production. The broader primary/native browser rerun passed 184/184 cases after
the 12 old split-notification fixtures were updated to the unified history
contract. The focused D1 receipt rerun initially passed four cases and failed two
because wrong-source fixtures violated the composite request/source foreign key.
The fixtures now use valid distinct-source requests and both focused cases passed;
a complete three-file database regression rerun then completed 80 passed/14
failed because receipt fixtures outlived a DELETE-based catalog test cleanup.
Receipt-reader tests now have a dedicated migrated database; the reader/catalog
rerun passed 60/60. The native policy and repository cases passed separately
(23 and 17): all 100 cases passed across runs, not one combined run. Database
immutability constraints were preserved. Browser checks do not prove live
provisioning. Notification checks now pass: producer 51, native D1 dispatcher 8,
unit 19, populated migration 3, and primary history/revocation 2. Native client
history readback and the combined release gates remain open.
The review additionally requires root-workspace requests (without a project),
current receipt/revision checks at dispatch, exact claim/attempt/lease fences,
and idempotent success for an already-created matching inbox record. Typechecks
and mocked notification cases alone do not close these requirements.
