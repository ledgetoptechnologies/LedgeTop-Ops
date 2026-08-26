# Delivery source provenance

Status: scoped local verification complete, unpublished, August 26, 2026.
No second connector, production migration or access change is enabled here.

## Ownership contract

Client migration `0157_delivery_source_provenance.sql` adds nullable
`project_alpha_source_id` to Delivery accounts and projects. Existing linked
records are explicitly backfilled to `project-alpha:primary`; genuinely local
records retain NULL. Existing local IDs, URLs, Alpha reference bytes, timestamps,
grants, shares, requests and immutable history are not rewritten or rebuilt.

The backfill assumes the pre-upgrade integration had only the configured primary
producer. Verify that assumption before live cutover. If historical rows have
unknown or mixed producer ownership, stop for an explicit reconciliation plan;
neither matching names nor scalar IDs can establish that provenance.

The three Alpha reference uniqueness indexes now include source. This permits
two distinct source-owned local records to carry the same producer-supplied ID,
without merging them. `projects.external_ref` retains its separate existing
global uniqueness contract. Catalog selection provenance remains independent
of account and project ownership.

Existing Alpha scalar references are a mixture of legacy business IDs and native
portal public IDs. This migration does **not** reinterpret them as Operations'
opaque projection handles or claim that their reference namespaces are resolved.
That remains a source-aware connector and reference-resolution requirement.

Established non-NULL ownership and local parent IDs are immutable. New Alpha
references require an explicit source. Existing local parents may be deliberately
associated with primary through UPDATE, but cannot be relabeled as a secondary
source: that would reinterpret earlier identity and history. Secondary rows must
start with their own explicit provenance and new local IDs.

Source-conflicting INSERT/REPLACE and conflicting external-reference ownership
are rejected. Same-ID, same-source UPSERT remains supported; this is not a
general prohibition on same-source REPLACE. Runtime writers must continue to
use non-destructive update/upsert operations.

## Compatibility and authorization

Account/project relationships check source compatibility before legacy member
auto-provisioning triggers run. Local/primary compatibility is retained; NULL
is not a wildcard allowing a local record to join another producer. Native
workspace bridges remain primary/local only. This does not grant membership,
eligibility or folder access: the existing explicit authorization checks remain.

Established local-only workspace wrappers retain their verified identity bridge,
explicit project grants and primary-project pricing context. A local wrapper
does not become evidence of Alpha eligibility, and a secondary-owned account
cannot borrow that wrapper or its primary project's capabilities. Regression
fixtures exercise these runtime denials independently of the migration's
immutable-source guards.

Primary snapshot and event writers qualify both direct updates and absence
sweeps by Delivery source. Renames, suspensions, project cleanup, grant
revocation and replay for primary cannot affect another producer with matching
external IDs. Client Hub lookups, folder provisioning, notification guards,
pricing, quotes and feedback must retain ownership at their respective boundary.

New feedback snapshots include explicit versioned producer provenance. Old
immutable JSON and fingerprints are preserved; only the bounded legacy reader
may interpret versionless, pre-source snapshots using their migrated primary or
local ownership. Unknown versions or incomplete new provenance fail closed.

## Release and remaining work

This is a paired Client/Operations/ops-sync schema-and-code change. Old parent
writers omit required source fields; old primary sync can sweep secondary rows.
Do not apply the schema while incompatible writers remain active. Before an
approved release, checkpoint the populated database, pause/drain writers,
apply the paired migration and code, and verify primary sync, existing client
URLs, explicit grants, request replay and historical feedback. A rollback must
restore a compatible schema/code checkpoint, not strip provenance from rows.

Secondary native portal roots, receipts and lifecycle ownership still need an
end-to-end contract. A verified source registry, credential/workspace binding,
outbound routing and explicit reference namespace resolution are also pending.
No browser field, same-name match or same-email match may select a producer or
grant authority. Keep secondary activation disabled until those gates pass.

Viewer code and thumbnail runtime remain outside this increment.
The frozen Viewer-facing Operations adapters and Client's models route still
resolve some Alpha project references without source qualification. Their
association, project-selection and session-issuance contracts must be updated and verified before secondary
Delivery activation; do not interpret these account/project guards as completion
of that separate integration boundary.

## Verification

The scoped local gates below are complete. Synthetic fixtures are not live
acceptance or permission to publish, and the broader multi-source goal remains
in progress.

The populated full-chain D1 migration suite passed 14 tests in 23.48 seconds.
It checks source collisions, exact old-row/JSON/trigger preservation, local
adoption, relationship/bridge guards, explicit source validation, transaction
rollback and reference-conflict protection for INSERT/UPDATE OR REPLACE.
All 25 populated authority/history tables passed table-level `quick_check`
before and after the upgrade, and the global foreign-key check remained empty.

The local runtime's database-wide `PRAGMA quick_check` returned `SQLITE_NOMEM`
both before `0157` and afterward. The test records both results and rejects any
new or different post-upgrade error; it does not describe that global probe as
passing. Per-table checks do not establish whole-file freelist or cross-table
page integrity. Preserve this limitation in release evidence and perform the
appropriate whole-database integrity/backup verification before live cutover.

Operations snapshot tests passed all 16 cases, including real-D1 matching-source
IDs and an empty primary snapshot that leaves secondary accounts, projects and
grants untouched. The ops-sync projection file initially passed 21 cases and
hit a five-second timeout in the new multi-database replay case. That case then
passed with a bounded 30-second timeout (17.67 seconds including setup).
No assertion was removed. The final complete ops-sync rerun passed all 35 tests
across three files in 220.49 seconds, including the expanded local-only name
propagation/cleanup cases and the primary/secondary collision case. Its final
TypeScript check also passed. Injected rejection logs in that suite are expected
failure-path assertions, not failed tests.

Operations, Client and ops-sync TypeScript checks passed at this checkpoint.
The initial eight-file Client consumer gate ran 144 cases: 141 passed and three
failed. Two failures came from a new wrapper fixture's foreign-key cleanup and
the subsequent leftover-row count; the third exposed a local-wrapper pricing
compatibility guard. Cleanup order and the local/primary guards were corrected.
The complete workspace and pricing files then passed all 41 cases in 121.63
seconds, including an established synthetic identity bridge, primary project
capabilities, and secondary-source denials. The original gate and corrected
rerun are recorded separately, not represented as an original clean pass.
The focused Operations consumer gate passed all 216 tests across 14 files in
676.45 seconds: account activation, primary-reference proof, Client Hub,
folder grants, batched notifications, request administration, feedback, Job
Brief attachments and portal grant management. It emitted dependency sourcemap
warnings, not test failures.

The remaining Client gate passed all 99 tests across eight files in 184.67
seconds. It covers the real full-chain request workflow, attachment lifecycle,
native portal projection/relationships, and feedback target/store behavior.
The added legacy-to-v2 feedback replay returns the original record, retains its
JSON/fingerprint and creates no extra event. Incomplete or mixed source metadata
is rejected before feedback, event or audit writes.

The final Operations type check and four-file snapshot/quote/navigation/count
gate passed all 31 tests in 4.65 seconds. The expanded snapshot case proves
local-only accounts/projects survive the primary absence sweep while suspended
local-client folder cleanup still applies; secondary rows remain unchanged.

Final Client, Operations and ops-sync TypeScript checks passed, as did all three
production builds. The ops-sync build was Wrangler's `--dry-run`, not a deploy.
Client and Operations emitted large-chunk warnings; no dependency upgrades or
bundle-performance work was included. No known failing case remains in the
scoped gates above; their overlapping counts are not additive. The complete
Client/Operations packages, monorepo and browser suites were not rerun for this
backend increment. The unchanged folder-count UI retains its previously recorded
desktop/mobile browser verification; its unit cases were rerun here.

No live database, connection, role, invitation, email or client content was
changed. Remaining registry, native portal, outbound routing and frozen Viewer
adapter gates above must be completed before enabling another producer. Apply
the documented populated-backup and integrity checks before any separately
approved production cutover.
