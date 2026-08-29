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

## Evidence states

- **Verified locally**: implementation and focused automated evidence exist on
  a prepared branch, but the feature may still be default-off or unpublished.
- **Published**: the verified change is on the appropriate main branch.
- **Live accepted**: migrations/configuration are applied and the real workflow
  has passed an authorized production smoke test.
- **Missing**: the user workflow or required evidence does not yet exist.

## Identity, services, and Client Hub

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
| Project memory and field notes | Versioned fixed-section operational memory plus migration `0047` manager-only staff attachments, guarded project-workspace UI, optimistic concurrency, retry-stable idempotency, immutable revisions/audit, exact R2 integrity and cleanup recovery, post-completion amendment reasons, and source/root/race tests; see [staff attachment runbook](project-memory-staff-attachments.md) | Verified locally | Apply `0047`, publish, and live-accept ordinary/terminal amendments plus upload, replay, HEAD/range download, stale-conflict, and orphan-cleanup behavior. Attachments remain private staff uploads and are not copied or exposed to clients. |
| Recurring-project copy-forward | Exact-source/root preview and commit contract, explicit role/section selection, conflict-safe UI, atomic fences, immutable receipts, race/reassignment regressions, and desktop/mobile tests | Verified locally | Publish and live-accept a copy into an already-created Project Alpha destination. Never copy grants, billing, invitations, status, notification state, or empty values over useful destination data. |
| Authoritative project creation | Migration `0046`, reviewed exact-source **Create project in Project Alpha** routing, UI and tests | Verified locally | Publish, configure the reviewed Project Alpha URL for each source, and live-prove create in Project Alpha then sync back. Operations must not create a local record that pretends to be the authoritative project. |

## Delivery, notifications, and feedback

| Requirement | Current evidence | State | Remaining acceptance |
| --- | --- | --- | --- |
| Portal-native authenticated delivery | Native bindings/grants, access terms, staff and portal UI, tests | Verified locally, default-off | Publish, migrate, enable deliberately, and smoke-test grant/read/revoke against a real workspace. |
| Five-minute staged notification batching | Legacy folder and Project Alpha delivery-intent batches plus the migration-`0170` exact-authenticated-grant engine and migration-`0175` policy invariant, reviewed exact-person policy editor, three-lane notification center/Inbox, encrypted independent pagination, Send Now/Cancel, leases/retries, and desktop/mobile coverage | Verified locally, default-off | Apply migrations 0170 and 0175, deliberately enable the flag, and live-test shared R2 events, cron, suppression, retry, and outbound mail. Legacy subscriptions remain an independent explicit opt-in; no project/contact recipient is inferred. |
| Generic feedback | Primary-source project/folder/file feedback, New → In Progress → Done, immutable events and completion notice | Verified locally, default-off | Publish and live-test authenticated submission, triage, completion, and direct return link. Secondary/native source routing must land in Client and Operations together before being enabled. Viewer annotations, replies, attachments, and video timestamps remain follow-ons. |
| Project Alpha-backed service requests | Catalog, request drafts, attachments/work areas, staff review, quote handoff, plus migration-0174 exact-target primary-source assignment narrowing | Verified locally; assignment consumer default-off | Live-accept the existing workflow, then deliberately enable and verify exact root/project assignment filtering. Assignments never grant `request.create`; project requests ignore organization assignments and all inheritance. |

## Delegated access and audit

| Requirement | Current evidence | State | Remaining acceptance |
| --- | --- | --- | --- |
| Delegated link creation with bounded scope | Delegated-share signer/provisioning, client UI, expiration and version/deny checks | Verified locally, default-off | Publish and live-test scoped creation, access, revocation, and manager recovery. |
| Named external collaborator membership | Reviewed invitations accepted into reusable verified workspace memberships, source-aware primary/secondary Team UI, suspension/revocation, address-book copy without authority conflation, project access terms, and backend/browser tests | Verified locally, default-off | Coordinate migrations, feature flags, invitation email, and live acceptance. Secondary `require_approval` remains explicitly unsupported and must not be implied by the UI. |
| Project-end expiration plus seven-day grace | Project access terms/deadline latching plus default-off, independently durable SMTP notice ledgers for seven-day, 24-hour, and expired collaborator and exact inviter/access-creator events; exact-origin/authority, ambiguity, retry isolation, recipient-race, duplicate-email suppression, stable Message-ID tests, and staff Client Hub notice history | Verified locally, default-off | Apply migration 0169, stage with SMTP, then live-prove collaborator and companion warnings/expiry without changing membership or independent grants. Client-facing notice history remains a separate decision. |
| Scoped meaningful audit coverage | Client/project timeline federates exact access ledgers, append-only migration-0172 project-access authority events, migration-0169 notice ledgers, and redacted exact-project/project-target primary feedback lifecycle events with current per-record authorization; coverage carries immutable collection boundaries with encrypted proof-bound high-water pagination and refresh-safe filters | Partially verified locally | Freeze authority mutations/reconcilers, publish both Workers with `PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED=false` at 100% traffic, drain old/in-flight work, apply 0172, verify coverage, enable both together for a canonical event, then reopen mutation ingress. Live-accept replay/expiry/isolation and feedback redaction/revocation. Client-wide and folder/file feedback history, native/secondary feedback routing, ordinary authenticated content-read producers, approved global filtering, common retention, and client visibility remain open. |

## Release gate

Before marking the overall goal complete:

1. Rebase each prepared branch onto the latest corresponding main branch and
   resolve source-layout or migration ordering conflicts.
2. Run populated migration upgrades, focused D1 tests, full unit/type/build
   gates, and supported desktop/mobile browser suites from pinned dependencies.
3. Complete security review for every new mutation or cross-database reader.
4. Publish only after explicit approval, apply migrations before enabling flags,
   and retain a rollback path.
5. Live-accept tenant/source isolation, stale-context invalidation, retries,
   accessibility, responsive layouts, and the daily operator workflow.
6. Update this checklist with direct evidence. Missing or merely compatible
   behavior is not completion.
