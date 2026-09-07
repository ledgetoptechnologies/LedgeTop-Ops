# Accepted delivery-change recovery

Design for the next implementation phase; this is not a deployed capability.
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

This foundation is **not yet wired into the live consumer**. Provider-version
index writer integration, legacy-row handling, end-to-end accepted sequencing,
bounded projector leases and diagnostics, scheduler integration, and the bell
producer still remain. Do not enable receipt capture or call this workflow
complete merely because the additive schema and primitive tests pass.
