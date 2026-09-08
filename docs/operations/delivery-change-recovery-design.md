# Accepted delivery-change recovery

Design and local implementation checkpoints; this is not a deployed capability.
The staging race fix does not make accepted file-index changes durable through
exhausted queue retries. This document refines the bell plan's recovery step.

## Source identity and time

Do not invent an object incarnation UUID before using the storage provider's
identity. Cloudflare documents `R2Object.version` as a unique identifier for a
specific upload of a key. Capture that identifier from authoritative HEAD for
creates and persist it with the accepted index version so a later delete can
refer to it. Retain ETag for existing conditional/version checks, not as the
sole transition identity. Two uploads of identical bytes can share an ETag;
upload timestamp precision also does not prove uniqueness.

Reference: [R2Object definition](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2object-definition).

Queue `message.id` identifies a delivery, not the semantic object transition.
Keep it as a receipt lookup/audit coordinate, but do not rely on its retry
behavior or on different message IDs implying different storage changes.
Duplicate deliveries must converge on the accepted source-version/action.
Explicitly verify retry-ID behavior before relying on it operationally.

Persist `(queue name, message ID) -> receipt` in the acceptance transaction.
Consumer replay must look up this binding **before** observing current HEAD or
index state. This recovers the original provider version for a committed delete
even after its index row is gone or a replacement has appeared. A new delivery
of the same semantic change can add another immutable message binding; it
cannot change the original recipient set. Conflicting message bindings fail.
Native events do not contain the provider version, so an accepted create is an
authoritative current-index observation, not proof of every historical upload
that occurred before processing. Preserve stale payload/HEAD checks and do not
promise reconstruction of unseen bucket history.

Use a valid source event time; for a deletion without that value, use the
queue's original message timestamp, never the current retry/processing time.
For creation, authoritative HEAD upload time remains the fallback. Invalid
source timestamps must not silently acknowledge an omitted notification.
If neither authoritative nor transport time is usable, reject/retry before
accepting an otherwise unrecorded transition. Do not infer order between two
different transitions solely from equal millisecond timestamps.

## Atomic acceptance

The eventual capture gate defaults off and requires its migration before it
can be enabled. Enabling it does not backfill old files or invent notices.

- Create acceptance writes the authoritative index snapshot, transition
  receipt, and selected recipient snapshots in one D1 transaction.
- Delete acceptance reads the existing source identity and atomically records
  its removal receipt with a compare-and-swap index deletion. Preserve the
  existing live-object checks and replacement/resurrection repair.
- A committed deletion must retain its receipt even though the index row is
  gone. A failed transaction must leave neither an orphan receipt nor a
  partially accepted index change.
- Existing rows without a provider version require an explicit legacy policy.
  A missing version must not silently become a content-hash-only identity or
  trigger a notification backfill. Review all index writers before adding the
  provider-version column so reconciliation cannot erase or falsely preserve it.

R2 and D1 are not one distributed transaction. The receipt proves which
authoritative observation the index accepted, not that an object cannot change
after HEAD. Existing replacement checks and current-access/publication checks
remain necessary.

Provider versions are opaque and must not be sorted lexicographically. Use a
durable per-key acceptance sequence, advanced with the same compare-and-swap
transaction as the index/receipt, to order distinct accepted observations when
source timestamps tie. Capture the expected index state before HEAD so a newer
acceptance committed during the observation cannot be overwritten by an older
one. A losing compare-and-swap retries observation; it cannot consume a receipt
as though that transition was accepted. Projection must preserve that accepted
sequence, including tombstones, rather than reusing the existing timestamp-only
high-water rule. This orders accepted observations, not unseen bucket history.

## Recipient boundary

Capture the same exact-person policy and unique longest-prefix selection used
by current staging. Perform selection inside acceptance, not an unconstrained
pre-read followed by broad recipient rediscovery. Keep source, workspace,
grant/version, policy/version, principal/identity, and binding/version/prefix
coordinates immutable in each target.

The current limit applies to **candidate rows before grouping by identity**;
do not describe it as support for an arbitrary number of overlapping grants
per recipient. Preserve bounded work and expose capacity failures explicitly.

No recipients at acceptance is a terminal result. Enabling a policy later must
not target the old receipt. Projection stages only saved targets; it never
calls the broad discovery query again. A changed/revoked policy, grant, binding,
identity, membership, or entitlement may suppress publication, but cannot
replace a captured target with a new person or wider scope.

## Recovery and release acceptance

Use bounded claim leases, attempt budgets, next-attempt times, and visible
terminal failures. A queue dead-letter route can supplement operational
recovery but does not replace acceptance-time recipient snapshots or atomic
index/receipt persistence. No automatic replay may add recipients.

Required tests before enabling capture:

- Same upload delivered repeatedly; same bytes uploaded again with a different
  provider version; real remove/re-add; equal timestamp boundaries.
- Failure before commit, ambiguous response after commit, process loss after
  index acceptance, and staging outage beyond the raw queue retry budget.
- Concurrent competing prefixes, changed policy/version, revoked grant, source
  collision, and zero-recipient acceptance followed by later opt-in.
- Delete replay after its index row disappeared and a later replacement at the
  same key; reconciliation and other writers preserving provider identity.
- Bounded recovery without duplicate batches, stale notices, retroactive
  recipients, raw object keys in client responses, or dependence on SMTP.

The independent bell ledger, sealing, current-authority checks, cursor/UI work,
and migration-first rollout in `authenticated-delivery-bell-plan.md` remain
required. This design does not complete those workflows or change their scope.

## Additive implementation checkpoint

Migration 0204 and `delivery-change-receipts.ts` provide an internal acceptance
primitive: one caller-supplied authoritative index CAS, receipt, recipient
snapshot, complete-set seal, and message binding commit together. Zero-row or
multi-row CAS and excess candidate rows abort the transaction. A confirmed
duplicate does not execute the index mutation again. Seals prevent late target
insertion, including into an originally empty set.

The internal caller must supply a value-changing index CAS, not merely an
UPDATE that matches one row. SQLite's affected-row count alone cannot prove
that the authoritative object state changed. Migration 0206 and
`delivery-index-acceptance.ts` provide that CAS: a new observation marker is
written even when an upload route already indexed the same provider version.
The marker and receipt must be committed together; the helper must never be
used as a standalone index writer. Repeat observation of the accepted provider
version cannot mutate the marker. Revisions persist after deletion to fence an
absent/present/absent race, including identical-content replacements.

Existing index rows retain unknown (`NULL`) provider identity at migration.
No historical notification is created. Legacy source-metadata changes clear
a carried provider identity, and all index updates advance the revision.
Before enablement, current-observation writers in `file-events.ts` and
`r2-crud.ts` must persist provider versions using pre-observation CAS; repairs
must not synthesize receipts. Administrative cleanup in those modules and
`trash.ts` must retain revision tombstones without inventing removals. A delete
with no known indexed provider version requires explicit no-notice legacy
cleanup and diagnostics, not a fabricated version. The marker does not replace
immutable receipt lookup when the index has already been removed.

The existing stager has a separate exact-target entry point for replaying saved
snapshots without discovering new recipients. Its object-version argument is
still the existing content ETag; it is not the receipt's provider upload ID.
Migration 0205 adds separate provider identity and accepted-sequence fields to
the recipient's object ledger. A durable caller supplies both fields; newer
accepted sequences take precedence over source timestamp ordering. Legacy
calls cannot replace a sequenced ledger, and durable staging refuses a missing
0205 schema. Unsequenced callers can still use the pre-0205 schema.

Capture and projection must be rolled out as one complete path. Do not switch
an object into sequenced staging and then expect the legacy broad discovery
path to keep updating it. A projector must read sealed receipt targets, pass
their exact receipt coordinates, and persist bounded retry state; these new
primitives do not themselves schedule recovery.

## Consumer and recovery integration checkpoint

The local recovery branch is connecting these primitives to the file-event
consumer and provider-aware administrative/reconciliation writers. This work
is not production-enabled. `AUTHENTICATED_DELIVERY_RECOVERY_ENABLED` defaults
off and additionally requires `AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED`.
The deployed configuration must not enable capture before the complete path,
including publication-time upload identity checks, passes acceptance.

Migration 0207 creates a separate mutable projection-job ledger. Inserting a
receipt seal atomically creates jobs for its saved targets, including no jobs
for an empty target set. Existing sealed targets are initialized without
reading the current file index or rediscovering recipients. Readiness checks
require the fan-out trigger as well as its tables.

The bounded projector claims at most 25 targets by default (50 maximum), uses
five-minute leases and a three-attempt budget, and orders outstanding work for
each saved target and object by accepted sequence. Completion and retries are
lease-token fenced; claims also fence the previously observed attempt count.
Expired final-attempt leases become terminal failures so a crashed worker
cannot permanently block later accepted changes. Terminal failure is not
successful notification delivery. Recovery diagnostics expose aggregate
counts and fixed reason codes, not object paths or recipient identities.

The existing notification cron awaits this bounded recovery pass before the
authenticated-change mail dispatcher. Infrastructure failure prevents that
dispatch pass and emits a sanitized error; it does not erase pending jobs.
This is still the existing email pipeline, **not** the independent bell
publication phase described in `authenticated-delivery-bell-plan.md`.

Migration 0208 separately preserves the accepted sequence and provider upload
identity on each actual batch item. Publication must compare that saved
identity with the current index and bucket object; looking only at a newer
object ledger or a matching ETag could validate an obsolete same-content
upload. Durable staging requires this migration. Legacy unsequenced batches
remain readable without it, and do not acquire invented provider identities.

Administrative index repair records only a freshly observed provider upload
version behind a revision CAS. It preserves the last notification observation
marker and does not create receipts. Stream state is controlled explicitly by
the caller: a repair/copy must not unexpectedly reset an in-progress upload,
while a replacement upload must clear the old upload state as its existing
route requires.

Moved-source cleanup must carry the copied provider identity and exact marker
identity, then fence its D1 deletion by the pre-HEAD index revision. A later
same-content upload must not lose its index merely because its ETag matches.
Check for and repair a replacement after derivative cleanup as well. This does
not make the storage retirement itself provider-version-conditional: R2's
ETag condition cannot distinguish identical-byte uploads. A provider HEAD
check narrows that pre-marker window but is not a distributed transaction or
a guarantee that no replacement can race the subsequent R2 write.

Remaining release gates include complete consumer fault/replay tests,
same-content replacement checks at publication, schema/readiness failures,
all relevant legacy paths, current-migration type/build/QA checks, deployed
queue retry-identity verification, and live acceptance of the administrator
terminal-failure surface described below. Logs alone do not fulfill that
operator-review gate. The independent bell producer, cursor/UI,
and live acceptance remain separate unfinished requirements. Do not enable
receipt capture or call the overall workflow complete based on primitive or
projector tests alone.

### Rollout and pause boundary

Apply the additive Client database migrations first, then deploy the compatible
consumer, repair writers, projector, and publisher together with capture still
off. Verify the configured file-event queue name and replay identity behavior
before enabling capture. Do not infer a live queue's behavior from a local mock.
Do not send announcements or backfill notices for ordinary existing objects.

Once any object has entered sequenced staging, disabling recovery alone is not
a safe notification rollback: legacy broad staging deliberately cannot replace
its sequenced state. Pause both authenticated-notification flags together if
recovery needs to be stopped. Preserve receipt, target, alias, projection, and
sequence tables. Resume using compatible code; never drop these records or
reset sequence counters to make legacy processing appear successful. Files,
public links, and access grants are not rollback targets.

A paused capture window cannot promise notifications for unobserved historical
bucket changes. Resume must reconcile current file state without inventing
past recipients, and any pending accepted receipts remain replayable using
their originally saved targets. A failed projection requires visible operator
review and cannot be treated as completed merely to drain a counter.

### Local verification checkpoint

The consumer/projector integration has passed focused local D1 tests for
post-commit retry, exact saved recipients, zero-target sealing, stale listings,
publication-time provider identity, claim expiry, and bounded retries. The
joined consumer/maintenance run passed 14 tests; the staging/provider/projector
and legacy replay run passed 57 tests. The subsequent move/CRUD/index run
passed 35 tests, with the final repair fixture independently rerun (11 passing).
These runs overlap; they are not a full-repository or live acceptance count.

Operations type checking and its production build passed, with the existing
large-client-chunk warning. The 34 source-layout and rollout-manifest checks
also passed. Independent code review found the moved-source cleanup race;
the final fix and its regression cases were reviewed again. No production
migration, capture enablement, browser acceptance, or live queue retry-identity
verification is claimed by this checkpoint. The release gates above remain.

### Administrator recovery status

`GET /api/admin/delivery-change-recovery` is a read-only, no-store diagnostic
requiring the existing administrator role and global `integrations.manage`
permission. It reports aggregate pending, processing, completed, and failed
projection counts, fixed failure reasons, oldest outstanding time, and latest
failure time. It returns no receipt, source, workspace, recipient, or path
identifiers. Missing schema and failed reads return an explicit unavailable
state with null counts, never a fabricated healthy zero. Disabling recovery
does not hide accepted pending work or terminal failures.

The Administration card labels completion as processing, not evidence that an
email was delivered or a bell event was published. Refresh only reads status;
it cannot enable capture, reset retry budgets, rediscover recipients, or replay
jobs. Terminal work requires operator investigation using the deployment's
controlled maintenance process. This surface does not introduce a privileged
retry API, send announcements, or complete independent bell publication.

#### Recovery-status verification checkpoint

The joined local recovery-status, route-authorization, projector, and scheduled
maintenance run passed 21 tests. The aggregate uses real local D1 while its
readiness dependency is isolated; the route tests use real staff ACL tables
and a stub status reader. These tests do not replace a deployed-schema check.

The recovery-card and existing workflow-readiness browser suites passed 18
desktop/mobile cases. Coverage includes unavailable versus empty status,
paused failures, contradictory payload rejection, stale-data clearing,
non-administrator exclusion, and keyboard refresh. Desktop and mobile fixture
screenshots were inspected; the mobile counters use two columns and the card
has a fixed-header scroll offset. Type checking passed. The production build
retains the pre-existing large-client-chunk warning. This is local verification,
not a production deployment or live notification-acceptance claim.
