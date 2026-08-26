# Native portal source ownership

Status: implemented and verified locally, August 26, 2026. Unpublished; no
production migration or secondary connector activation is authorized by this
document. This follows [Delivery provenance](delivery-source-provenance.md) and
the [multi-source design](multi-source-client-design.md).

## Ownership and compatibility

Migration `0158_portal_source_ownership.sql` reserves each local workspace handle
for one exact `(projection_source_id, source_workspace_id)` pair. Reservations
survive workspace closure. Existing primary workspace IDs, client URLs, staged
snapshots, receipt hashes, audit JSON, memberships and identity IDs retain their
original values. Backfill includes staging-only and historical workspaces, not
just currently active native workspaces. Legacy root bytes are not reinterpreted
as native Alpha public IDs.

Native workspaces and staged projection generations carry the producer source;
native root uniqueness is source-qualified. Directory descendants inherit their
owner through the immutable local workspace and generation. A secondary source
with identical external workspace, root, principal, project, generation or event
IDs must not overwrite the primary source's records or replay receipts.

The existing signed HTTP endpoint stays bound to `project-alpha:primary` after
authentication. Current and previous signing keys remain one authority's rotation
pair. No source selector is accepted from an envelope or browser. Internal source
contexts are storage coordinates, not credentials or proof that a connection is
authorized. A second authenticated connector registry remains a separate gate.

Translation applies only to internal workspace coordinates: envelope workspace,
workspace resource ID, workspace-scoped entitlement targets, and workspace events.
Entity, principal, project and relation public IDs remain source-local values.
Signed bytes, payload hashes and producer snapshot hashes are never rewritten.
Malformed source/workspace IDs, including trailing line breaks, are rejected;
they are not silently trimmed into another identity.

Verified `(issuer, subject)` identities remain global. Source ownership does not
bind an identity, grant access, merge memberships or create an invitation. Native
secondary workspaces remain unavailable to the primary-only client authorization,
eligibility, pricing, Client Hub bridge and delivery-intent paths. Local-only
legacy wrappers under primary workspaces keep their existing compatibility rules.

## Transaction boundary

Projection receipts use `(projection_source_id, delivery_id)` rather than a global
delivery ID. Each receipt belongs to the reserved local workspace. The receipt
write guard is a transaction-time assertion: an outdated expected checkpoint or
ownership proof must abort the entire batch before directory or permission writes.
Checking a zero-row checkpoint update after a batch has committed is insufficient.
The native Client Hub cursor uses a partial `(project_alpha_source_id, id)`
index for non-closed workspaces, so source filtering precedes keyset pagination.

The regression gate includes an event read at sequence S racing a newer snapshot
at S+2. The stale event must leave the newer directory, principal state, active
generation and receipts unchanged. Snapshot activation and replay races require
the same protection, not just the ordinary sequential-event tests.

## Rollout and remaining gates

This increment does not make delivery-intent receipts, guest-share idempotency,
outbound routing or the entire portal multi-source. Those still use the one
configured authority and must not be enabled for another source. In particular,
rebuilding intent receipt parents requires preserving dependent grant, audit and
outbox history; prefix-only guest reuse is not source ownership.

Before release, verify populated migration, pending snapshot continuation,
source collisions, source-map immutability, primary URL/replay compatibility,
transaction rollback, and primary-only consumer checks. Apply paired Client and
Operations code with the schema during a controlled writer pause; old projection
writers cannot write the new source-required receipt format. Preserve a verified
backup and the existing whole-database integrity caveat from migration 0157.

Viewer and thumbnail runtimes stay frozen. No invitations, messages, access grants,
live configuration changes or production migrations are part of local QA.

## Verification

The populated migration passes all 14 cases against the real D1 runtime and the
full migration chain through `0157`. It preserves snapshots of 29 populated
tables, existing triggers, foreign-key validity, and per-table integrity checks.
The first attempt exposed a runtime rejection of the seven-way backfill UNION;
seven single-source inserts now perform the same backfill in one atomic batch.
No table or historical-workspace category was omitted to make the test pass.

Primary Client compatibility ran 84 cases across seven files. The first run had
six failures in the delegated-share file because its minimal fixture omitted
`client_accounts`, which the authorization query requires. Adding the missing
fixture table fixed all 13 cases in that file; the other six files passed their
71 cases. Existing invitation, hierarchy, eligibility, pricing and authenticated
delivery behavior remains covered without relaxing the production checks.

The source/projection gate ran 46 cases across five files: migration, source
resolver, projection, relation/lifecycle projection and signed cross-repository
delivery. Seven new multi-step scenarios initially reached the five-second test
timeout. Those scenarios received bounded 20-second integration allowances;
the two complete projection files then passed all 24 cases in 101.85 seconds.
Their assertions remain intact. The populated migration, source resolver and
signed cross-repository delivery files passed their other 22 cases. No second
HTTP producer was enabled for these synthetic source-boundary tests.

The paired Operations consumer gate passed all 127 cases across 13 files in
402.14 seconds: account activation, Client Hub lookup/index/detail/schedule,
primary business-reference proof, recipient resolution, delivery intents,
delegated signer/provisioning, manager recovery, eligibility and grant reads.
Its dependency sourcemap warnings were not test failures.

The final seven-file Client source/compatibility gate passed all 130 cases in
265.40 seconds. It includes the populated migration and source-qualified cursor
index query plan, malformed source rejection before database lookup, portal and
catalog source resolution, feedback targets, request readiness, service catalog
pages and catalog projection compatibility.

The final Operations feedback/current-view-count gate passed all 28 cases in
105.00 seconds. The real-migration feedback fixture now verifies that native
workspace roots cannot be reassigned, while supported suspension and eligibility
revocation still remove access. The folder count still excludes descendants.

Final TypeScript checks and local production builds passed for Client,
Operations and ops-sync. The sync build used Wrangler's `--dry-run`; it did not
upload or deploy. Client and Operations emitted existing large-chunk advisories.
Sandboxed esbuild configuration reads failed before execution; the approved
outside-sandbox local runs passed without changing application permissions.

The broad monorepo/browser suites have not been rerun for this backend-only
increment. Folder-count UI evidence remains in the roadmap. These overlapping
focused runs are recorded separately, not added into a misleading full-suite
total. No production migration, mail, access change or deployment was performed.
