# API v2 Client Hub Projection Gap

## Current architecture

- API-v2 inventory is immutable evidence; inventory sync alone must not create or mutate canonical Ops records, client access, Delivery records, or public links.
- Client Hub is currently indexed from `pa_organizations`, `pa_clients`, and `pa_projects`. Do not write inventory observations directly to those legacy projections or to the disposable `client_hub_roots` cache.
- The canonical Ops directory is `operations_directory_records`; canonical shared projects use `operations_shared_projects`.
- Canonical mappings already exist: `project_alpha_active_directory_mappings` for directory records and `project_alpha_project_mappings` for projects.
- Existing directory adoption reserves an explicitly selected Ops record and seals field decisions, but stops before activating a canonical mapping or applying a profile disposition.
- Existing project adoption rereads live Project Alpha inventory rather than starting from a selected, persisted API-v2 observation.

## Required staging implementation

1. Expose bounded staff-only candidates from the conflict-free current observation views. Include the full source identity tuple, resource IDs/type, revision, authorization generation, and conflict/review status; do not infer identity from customer fields.
2. Fetch current per-record detail under the dedicated scoped read capability, then let an authorized reviewer explicitly choose or create the corresponding Ops record and decide field-by-field what to adopt.
3. Pin the review to current observation, detail revision/hash, binding, authorization generation, actor authority, local record version, and relationship state. Reject stale evidence and duplicate local↔remote mappings.
4. Seal decisions durably, then use existing guarded acquisition/rebind and mapping-activation paths. Directory activation must prove `external_id` equals the canonical Ops record ID or use the guarded rebind workflow; never create a false active mapping.
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

## Onboarding URL note

`/onboarding/00000000-0000-4000-8000-000000000000` is a placeholder URL, not an issued invitation. A JSON `Not found` response for that zero UUID is expected and does not, by itself, show that the staging portal is unavailable. The implemented invitation acceptance flow uses a real secret-token URL under `/portal/invitations/accept#token=...`; only a token generated by Operations for a real staging invitation should be tested. Never substitute a guessed UUID or publish the secret token in logs, screenshots, or documentation.
