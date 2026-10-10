# API v2 Client Hub Projection Gap

## Superseding acceptance checkpoint — October 9, 2026 UTC

- Latest local verification: the real legacy client-list HTTP route passes
  without a native mapping relation, and nine focused source/visibility checks
  pass. The canonical native list/exact-root-resolver suite also passes after
  increasing only its migration-setup timeout (one test, 94.47 seconds total).
  That suite is not a complete HTTP detail/render acceptance test. The broader
  HTTP run passed 41 cases; three incomplete native-mapping test fixtures
  failed closed. Corrected fixtures exposed a portal-alias context-stability
  issue in two cases. After preserving the established source display label,
  all three affected HTTP cases pass; the mapping/context checks remain intact.
  The isolated greater-than-500-root pagination regression also passes after
  avoiding native per-row checks on databases without native mappings. A new
  exact-revision CI run and live staging acceptance remain required.
- The canonical-181 temporary-authority database test now executes an initial
  open/close and a second open/close, including exact audit/receipt history and
  atomic rollback on approval or grant conflicts, while preserving unrelated
  staff grant/history rows. All eight focused Workers-runtime checks also pass.
  These are local tests, not a live grant or a completed staging permission window.
- Producer tracing disproved a proposed acquired differing-ID pending-command
  race: the writer emits the resolved PA external ID for acquired updates, so
  the canonical external-ID pending fence is retained. Fixtures now use that
  actual wire identity, distinct from Ops record ID. Unsupported alias and
  acquired-create acceptance paths were removed; current-intent-version proof
  and an eight-case update response negative matrix are retained. Consumer
  fixtures do not prove acquisition/activation producer enforcement. A separate
  populated-upgrade test now passes through all 181 canonical migrations with
  triggers enabled and proves activation retains distinct Ops and PA IDs.
- A deliberately created synthetic customer now has independently verified PA
  create and profile-update acknowledgments. Each dispatched once; the update
  advanced the current PA resource revision. An active external binding may
  retain its creation-time revision: do not equate that revision with the
  current resource revision or report them as identical.
- The reviewed staging base was restored after the bounded scheduler window.
  Temporary preview credentials were removed and all three temporary
  synthetic-area Directory grants were independently confirmed inactive.
- Normal Client Hub navigation remains blocked for an API-v2-only source that
  has no legacy connector registration. The correction must admit only exact,
  unique, active native mappings under enabled deployment-owned identity;
  preserve explicit connector hiding, legacy projection isolation, and
  credential-free detail/context/pagination invalidation. Do not register a
  legacy connector merely to bypass this gap.
- Independent review caught two additional cases before deployment: the
  historical primary-source visibility default must not substitute for native
  identity proof, and an acquisition-time local version must not prevent a
  later acknowledged profile update from supplying current relationship
  evidence. Corrections and regression coverage are local work, not live
  acceptance.
- The relationship proposal passes six focused full-canonical-181 SQLite
  tests, including an acquired mapping at local version 1 followed by an
  acknowledged update at version 2. It remains a proposal, not a canonical or
  applied migration. These fixtures isolate the consumer view by seeding
  producer outputs; they do not prove the complete live producer workflow.
- Remaining gates: deploy and verify the native Client Hub correction; restore
  the synthetic profile through the normal editor; complete post-acknowledgment
  replay/conflict and relationship acceptance; then verify real signed-in
  recipient enrollment, selected direct/nested file bytes, sibling and
  cross-customer denial, and same-session revocation.
- The production owner-update checkpoint is **not ready**. No production PA
  update, production client activation, portal cutover, or existing public-link
  change is authorized by this evidence. Older dated observations below are
  historical and must not be treated as current deployment or schema state.

## Current architecture

- API-v2 inventory is immutable evidence; inventory sync alone must not create or mutate canonical Ops records, client access, Delivery records, or public links.
- Client Hub retains legacy projections and a disposable `client_hub_roots` cache. The native Directory path resolves approved canonical Ops records through active mappings; raw inventory observations must not be written directly into either legacy projections or the cache as an adoption shortcut.
- The canonical Ops directory is `operations_directory_records`; canonical shared projects use `operations_shared_projects`.
- Canonical mappings already exist: `project_alpha_active_directory_mappings` for directory records and `project_alpha_project_mappings` for projects.
- Directory adoption reserves an explicitly selected Ops record and seals field decisions. Separate guarded acquisition and activation paths establish the canonical mapping; reservation or display alone does not activate it or grant portal access.
- Existing project adoption rereads live Project Alpha inventory rather than starting from a selected, persisted API-v2 observation.

## Required staging implementation

1. Expose bounded staff-only candidates from the conflict-free current observation views. Include the full source identity tuple, resource IDs/type, revision, authorization generation, and conflict/review status; do not infer identity from customer fields.
2. Fetch current per-record detail under the dedicated scoped read capability, then let an authorized reviewer explicitly choose or create the corresponding Ops record and decide field-by-field what to adopt.
3. Pin the review to current observation, detail revision/hash, binding, authorization generation, actor authority, local record version, and relationship state. Reject stale evidence and duplicate local↔remote mappings.
4. Seal decisions durably, then use existing guarded acquisition/rebind and mapping-activation paths. Enrollment mappings retain exact ID equality; acquired mappings may retain distinct immutable Ops `record_id` and PA `external_id` only through the exact acquisition/activation proof. Never infer an association from names or create a false active mapping.
5. Project only approved canonical Ops records into the ordinary `business` Client Hub namespace. The separate `review` namespace is a display-only exception for already-sealed standalone-client comparisons: it is visible only to staff with effective `directory.profile.view` authority for the reviewed record (global, resource, assigned, business-area, or division scope, with deny precedence), is excluded from direct Client Hub detail/collection lookup, and can never establish canonical mapping, client invitation, portal access, service enrollment, Delivery access, or public-link authority. Keep existing public links separate and unchanged.
6. Seed project adoption from the selected current observation, then keep its live detail/binding reread and existing canonical bind/activation checks.
7. Add D1, route, browser, stale-evidence, conflict, idempotency, and rollback tests. Preserve the invariant that inventory sync alone changes no canonical or mapping rows.

## Acceptance evidence

Staging sync is accepted only when a deliberately selected test record flows from current PA API-v2 detail through reviewed canonical mapping into the Client Hub exactly once, with no identity auto-match or access grant. Then separately validate a synthetic invitation through the portal's secret-token acceptance route and verify client-scoped data visibility. Do not change production PA or existing public links during staging work.

### Finalization isolation snapshot

Before enabling either `PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED` or the separate
`PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED` window for a synthetic finalization,
capture bounded pre-change counts and row digests for client portal accounts/grants, workspace
binding selections, folder permissions, Delivery records/shares, and public-link projections.
Finalize and replay one explicitly sealed synthetic receipt, then require byte-identical
post-change snapshots for every one of those surfaces while the expected acquisition receipt and
one canonical mapping/activation advance exactly once. Do not enroll a recipient or create a grant
until these comparisons pass. Folder-permission isolation has no dedicated local D1 assertion yet,
so its staging snapshot is a mandatory gate rather than optional evidence.

Existing local evidence is intentionally split by boundary:

- `project-alpha-directory-read-adoption-finalizer-d1.test.ts` preserves client portal accounts,
  Delivery records, and Delivery public-share rows while preparing the immutable finalization.
- `project-alpha-existing-directory-private-acceptance.test.ts` preserves Delivery and public-share
  byte payloads through acquisition/activation.
- `project-alpha-existing-directory-binding-review-consumer.test.ts` preserves public-share rows
  through activation.
- `verified-recipient-delivery-authority-canonical-joined.test.ts` proves canonical activation does
  not create a workspace selection without the separate workspace authority workflow.
- `project-alpha-directory-read-adoption-runtime-finalizer.test.ts` proves the runtime saga reuses
  one local mutation, command, and activation key across boundary failures and exact replay.

## Review-display privacy and migration safety

- Generic `team.view` is not sufficient to list or search the review namespace. The worker requires current, deny-aware `directory.profile.view` authority scoped to each returned record; cursors bind to this effective review visibility. Direct detail/collection resolution never treats review rows as client roots, even for a profile reviewer.
- Migration `0166` adds durable display-only rows and rebuilds the populated Client Hub root/search tables without changing their public key semantics. The populated-upgrade test must prove representative pre-existing root/search rows survive and `PRAGMA foreign_key_check` is empty before staging apply.
- There is no down migration for `0166`. Before applying it remotely, take and verify the staging D1 backup and record the exact Worker/migration revisions. If the release must be withdrawn, first disable the API-v2/review feature flags and stop writes; use a reviewed forward fix, or restore the verified pre-migration staging backup into an isolated staging database and repoint staging. Do not assume a Worker-version rollback reverses D1 schema/data changes.

## October 3 staging read and invitation gate

- The latest live API-v2 inventory for the single configured source
  `project-alpha:staging` is complete: Directory 14 records at generation 51
  and Projects 2 at generation 7, with zero conflicts on the latest pages.
  This proves authenticated bounded read/inventory ingestion for one staging
  PA source; it does not prove canonical reconciliation, both PA instances,
  client access, or portal readiness.
- Inventory is not yet canonical sync. One Directory resource is unbound and
  only one Ops Directory mapping exists. One project is mapped; the revision-10
  project remains unmapped with no durable binding-refresh receipt. No
  canonical acquisition/activation has been recorded. Re-read its current
  binding/CAS evidence before any refresh; never infer a revision from cached
  state. The historical project-generation conflict remains in history, but
  did not recur in the latest page.
- Live Operations staging is version
  `30dd4b02-96f2-48e0-8e43-d3f8505d670b` and Client staging is version
  `9006973d-2934-41a7-ab24-d0a3cde58f14`, each at 100%. Candidate Ops PR #145
  is `b5f1c3827a4ec5175d83919074a7b9ab8a5d178e`; its CI passes, but it is not
  deployed. Operations D1 is applied through `0165`, with `0166`–`0169`
  pending; Client D1 is applied through `0228` with no pending migrations.
- The Operations admin/recipient bridge and Client onboarding recipient bridge
  are default-off. A JSON `{"error":"Not found"}` from
  `/onboarding/00000000-0000-4000-8000-000000000000` therefore confirms the
  closed Worker gate. The zero UUID is not an issued invitation, so this does
  not test a valid invitation or establish that the Client portal is broken.
- Two distinct flows must not be conflated: profile intake uses
  `/onboarding/:invitationId#<secret>` and is issued through the Operations
  client-onboarding workflow; signed-in portal-membership acceptance uses
  `/portal/invitations/accept#token=...`. Neither URL is interchangeable with
  the other. Never substitute a guessed UUID or share a real secret fragment
  in chat, logs, screenshots, or documentation.

The next staging order is: preserve and verify backups; run the migration-only
ledger gate against the exact current histories; apply only Ops `0166`–`0169`;
deploy the reviewed exact-head Ops candidate and verify revision/rollback;
re-read the current Project binding and complete explicit synthetic canonical
mapping/replay; then exercise real synthetic onboarding, recipient enrollment,
scoped portal data, denial/revocation, and unchanged public-link checks. Do not
request the production PA update checkpoint until this two-source and portal
acceptance is complete.
