# Delivery intent and guest-link source ownership

Status: implemented and locally verified, August 26, 2026. Unpublished;
no production migration, connector activation, mail or access change is implied.
This follows [native portal ownership](portal-source-ownership.md) and the
[multi-source design](multi-source-client-design.md).

## Contract

Migration `0159_delivery_intent_source_provenance.sql` preserves globally stable
receipt handles while qualifying create/revoke replay keys by
`(project_alpha_source_id, delivery_id)`. Existing receipts adopt the primary
source without rewriting IDs, timestamps, fingerprints or dependent history.
Revocation's composite foreign key requires the original receipt's exact source.
Receipt and resource guards reject ownership transfers, including SQL `REPLACE`
bypasses; terminal grants cannot be revived by replacing an existing row.

The parent-table rebuild preserves child tables and their existing foreign keys,
indexes and triggers. It uses deferred foreign-key validation in one atomic
batch, without renaming the old parent or deleting grant/audit/outbox history.
Do not split the migration into independently committed statements.

Public signed HTTP remains primary-only. Current and previous HMAC keys are one
authority's rotation pair, not separate sources. Source context is an internal
trusted input, never an unauthenticated body/header selector. The request reader
enforces its 16 KiB limit on actual streamed bytes as well as declared length.

An exact accepted request returns its original receipt before relative expiry
checks. Conflicting payloads under the same source/replay key fail; another
source may use the same external delivery ID without sharing its result.
Concurrent create/revoke retries return the committed winner's receipt.

## Authorization and guest compatibility

Source qualification precedes ambiguous-binding limits. Recipient resolution
must identify the exact workspace, folder binding and active generation. Before
accepting a write, the first receipt statement rechecks that binding, directory
owner/version, eligible principal/email, applicable blocks and current policy.
A failed assertion aborts the entire batch before resources, audit or notices
are committed. Matching email or folder text alone does not prove ownership.

Portal grant reuse is version/policy checked at commit time. Guest creation also
requires one source-owned Delivery project. Primary compatibility permits local
projects with null Alpha source; secondary sources never inherit that fallback.
Primary guest actor/idempotency keys retain their old values, while secondary
keys carry an unambiguous source namespace.

An existing active guest link can be reused only when its receipt, authority,
project, folder, audience and policy agree. Rechecking the actual share prefix
matters because metadata changes need not increment credential versions. A
colliding staff-owned or other-source link is never overwritten or expired.
Expiration of this source's own links occurs inside the acceptance transaction.
Physical folder-link uniqueness remains enforced; this increment does not allow
two sources to claim the same storage scope.

Revocation uses the owning source and original receipt even if eligibility was
subsequently removed. It must not depend on continued eligibility to revoke
access. Ordinary approved lifecycle updates remain supported.

## Notifications

Guest notices recheck receipt source, live workspace, exact binding/generation,
directory-owner version and current recipient eligibility before sending.
Portal notices use equivalent live owner proof and the exact returned binding.
Secondary portal notifications remain suppressed: the public client portal is
still primary-only, so an internal secondary test grant must not produce an
unusable client invitation. No live messages are used for verification.

These checks do not claim transactional atomicity with an external mail service.
Source-aware outbound routing and broader notification lease/deduplication
acceptance remain separate release gates.

## Release and recovery

1. Keep the secondary ingress/activation gate closed. Resolve the pending staff
   authority choice and approve the producer/consumer release separately.
2. Back up the target database and record its migration/code checkpoint using
   the established release procedure. Rehearse the populated upgrade locally.
3. Apply the full pending migration sequence and paired Operations/Client code
   in a controlled release window. Old intent writers omit the now-required
   source field; do not roll back only the application after this migration.
4. Verify primary create/replay/revoke, recipient suppression, existing receipt
   URLs/history and queue health before considering additional source work.
5. On failure, stop new acceptance and use the approved coordinated recovery
   plan. Never drop receipts to clear retries or restore permissions by hand.

Remaining gates include an authenticated connector registry, source-pinned
outbound commands, explicit business-party linking, secondary client authority
and browser/live acceptance. The Alpha public-ID export is still unpublished;
its rejected publication must not be retried without renewed approval. Viewer
and thumbnail runtimes are unchanged.

## Verification

The populated migration passed all 17 real-D1 cases in 22.90 seconds. It applies
the entire preceding migration chain, snapshots populated parent/child history,
verifies preserved schemas, triggers and foreign keys, and tests source replay
collisions, receipt-first creation, transaction rollback and replacement bypasses.

The paired intent/recipient gate passed 55 cases across three files in 69.30
seconds. This includes the added guest folder-change race, staff-link
preservation, exact retries and current-recipient transaction guards.

The final source-runtime/notification/intent gate passed 39 cases across three
files in 108.18 seconds. Twelve new real-D1 scenarios cover portal and guest A/B
collisions, independent revocation, exact concurrent retries, permission changes
before commit, expired replay and authenticated HTTP source binding. Six new
notification scenarios use the full migration chain on SQLite with mocked mail;
they cover overlapping identifiers/email/prefixes, generation changes, primary
delivery, secondary portal suppression and stale owner versions. The existing
intent file was rerun after the final notification owner-proof changes.

The existing Client authorization/intent-migration compatibility gate passed all
five cases in 8.28 seconds. No client reader was broadened to accept secondary
portal authority.

Final TypeScript checks and local production builds passed for Operations,
Client and ops-sync. The sync build used the existing Wrangler `--dry-run`
script; it did not upload or deploy. Client/Operations emitted their existing
large-chunk advisories. Sandboxed Operations build startup failed because
esbuild could not read an ancestor directory; the approved local build outside
the sandbox passed, without changing application permissions.

The five current-view count unit tests were rerun and passed. Existing folder
count browser evidence remains in the roadmap; no Viewer code was changed.

These overlapping runs are not a full-suite total. This backend increment does
not claim a full monorepo/browser run or production acceptance.
