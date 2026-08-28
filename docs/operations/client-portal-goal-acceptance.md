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
| Project Alpha service assignments | Producer/admin release branch, receiver migration `0168`, and exact-source/exact-subject Client Hub card with D1 and desktop/mobile tests | Verified locally | Publish, admit each source/workspace explicitly, and live-prove assignments remain informational and do not grant portal, file, request, or pricing authority. |
| External portal-access roster | Source-qualified membership/invitation reader, Client Hub card, D1 and desktop/mobile browser tests | Verified locally | Publish and verify same-email identities remain distinct and inactive/unassigned states are factual. |

## Contacts and operational memory

| Requirement | Current evidence | State | Remaining acceptance |
| --- | --- | --- | --- |
| Organization/project contact roles | Exact-source project `project_contact`/`site_contact` service, guarded staff routes, progressively loaded exact-root picker, immutable revisions, and D1/desktop/mobile tests | Verified locally | Publish and live-accept project assignments. Organization `primary_operational`/`delivery` roles remain missing. Never infer roles or portal access. |
| Project memory and field notes | Versioned fixed-section operational memory with guarded project-workspace UI, optimistic concurrency, retry-stable idempotency, immutable revisions/audit, post-completion amendment reasons, and reassignment fail-closed tests | Verified locally | Publish and live-accept ordinary and terminal amendments. Attachments require a later exact storage-authority contract. |
| Recurring-project copy-forward | Exact-source/root preview and commit contract, explicit role/section selection, conflict-safe UI, atomic fences, immutable receipts, race/reassignment regressions, and desktop/mobile tests | Verified locally | Publish and live-accept a copy into an already-created Project Alpha destination. Never copy grants, billing, invitations, status, notification state, or empty values over useful destination data. |
| Authoritative project creation | Project Alpha remains the project source | Missing contract | Either add a reviewed Project Alpha create-project contract or route staff to Project Alpha. Operations must not create a local record that pretends to be the authoritative project. |

## Delivery, notifications, and feedback

| Requirement | Current evidence | State | Remaining acceptance |
| --- | --- | --- | --- |
| Portal-native authenticated delivery | Native bindings/grants, access terms, staff and portal UI, tests | Verified locally, default-off | Publish, migrate, enable deliberately, and smoke-test grant/read/revoke against a real workspace. |
| Five-minute staged notification batching | Folder and Project Alpha delivery-intent batches, Send Now/Cancel, leases/retries, notification center | Verified locally, default-off | Add general-upload/staff-grant producers and explicit recipient policy; then live-test cron and outbound mail behavior. |
| Generic feedback | Project/folder/file feedback, New → In Progress → Done, immutable events and completion notice | Verified locally, default-off | Publish and live-test authenticated submission, triage, completion, and direct return link. Viewer annotations, replies, attachments, and video timestamps remain follow-ons. |
| Project Alpha-backed service requests | Catalog, request drafts, attachments/work areas, staff review, quote handoff | Verified locally | Live-accept the existing workflow. Do not filter or authorize it from service assignments until a separate reviewed policy is approved. |

## Delegated access and audit

| Requirement | Current evidence | State | Remaining acceptance |
| --- | --- | --- | --- |
| Delegated link creation with bounded scope | Delegated-share signer/provisioning, client UI, expiration and version/deny checks | Verified locally, default-off | Publish and live-test scoped creation, access, revocation, and manager recovery. |
| Named external collaborator membership | Current feature delegates bearer links rather than a reusable authenticated collaborator membership | Missing | Define the invitation/membership workflow and its address-book relationship without conflating contact data with identity or authority. |
| Project-end expiration plus seven-day grace | Project access terms/deadline latching plus default-off, independently durable SMTP notice ledgers for seven-day, 24-hour, and expired collaborator and exact inviter/access-creator events; exact-origin/authority, ambiguity, retry isolation, recipient-race, duplicate-email suppression, and stable Message-ID tests | Verified locally, default-off | Apply migration 0169, stage with SMTP, then live-prove collaborator and companion warnings/expiry without changing membership or independent grants. A staff notice-history UI remains missing. |
| Complete meaningful audit coverage | Client/project timeline federates eight exact access ledgers, including append-only migration-0172 project-access authority events, plus migration-0169 collaborator/inviter/access-creator notice ledgers; coverage carries the immutable collection start and the UI says **available since**, with exact source/workspace/project joins, replay/expiry reconciliation, encrypted proof-bound high-water pagination, redaction, and refresh-safe filters | Verified locally | Freeze authority mutations/reconcilers, publish both Workers with `PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED=false` at 100% traffic, drain old/in-flight work, apply 0172, verify coverage, enable both together for a canonical event, then reopen mutation ingress. Live-accept replay/expiry/isolation; global/content gates remain separate. |

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
