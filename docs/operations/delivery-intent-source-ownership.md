# Delivery intent and guest-link source ownership

Status: implemented and locally verified, updated August 31, 2026. Unpublished;
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

The legacy scalar-configured HTTP routes remain primary-only. A registered
business-data source uses the source-qualified routes under
`/api/internal/project-alpha/sources/:sourceId/delivery-intents`. Operations
derives the source from that canonical path and an active registry revision;
it never trusts a body or free-form source header. The request must pass both an
RS256 Cloudflare Access assertion with the exact registered issuer, audience and
subject and the source revision's current/previous HMAC key. Remote Access JWKS
resolvers are cached by validated HTTPS origin and bounded to 32 issuers.
After Access succeeds, a separate coarse source-scoped attempt budget runs
before deploy credentials or request bodies are parsed. Invalid HMAC traffic
therefore cannot do unlimited application work or consume the smaller accepted
preflight/intent quota.

The first statement in each create/revoke transaction rechecks the registered
source revision, connector revision and versions. Authority changed before the
commit aborts the whole write; authority changed after the commit does not turn
an accepted receipt into a false failure. Current and previous HMAC keys remain
one source authority's rotation pair. The request reader enforces its 16 KiB
limit on actual streamed bytes as well as declared length.

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
An active registered source may produce portal notifications only when its exact
workspace, binding, directory owner, principal, grant version and source
authority remain live at publication. Unregistered, suspended or retired source
rows are terminally suppressed. Historical staff records remain source-labelled
and readable when the configured business source is still read-visible; they do
not become proof that current send authority still exists.

Migrations `0182` and `0183` add immutable notification-source provenance,
source-leading ready indexes, global bounded orphan probes and a durable
round-robin cursor. Each staged pass sends at most 10 batches; each direct pass
claims at most 25 rows. A noisy source cannot consume every slot, retries stop
after three attempts, and exhausted cleanup is capped at 100 rows per pass.
Deploy-before-migration compatibility stays bounded and primary-compatible.

These checks do not claim transactional atomicity with an external mail service.
Source-aware outbound routing and broader notification lease/deduplication
acceptance remain separate release gates.

## Release and recovery

1. Keep every unapproved secondary connector/activation gate closed. Registered
   route availability is not permission to enroll a source. Resolve the staff
   authority choice and approve each producer/consumer release separately.
2. Back up the target database and record its migration/code checkpoint using
   the established release procedure. Rehearse the populated upgrade locally.
3. Apply the full pending migration sequence and paired Operations/Client code
   in a controlled release window. Old intent writers omit the now-required
   source field; do not roll back only the application after this migration.
4. Verify primary and registered-source preflight/create/replay/revoke,
   current/previous key overlap, recipient suppression, existing receipt
   URLs/history, fair queue progress and retry exhaustion before activation.
5. On failure, stop new acceptance and use the approved coordinated recovery
   plan. Never drop receipts to clear retries or restore permissions by hand.

Remaining gates include approved source enrollment, source-pinned outbound
commands, secondary client authority and browser/live acceptance. The Alpha
public-ID export is still unpublished;
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
