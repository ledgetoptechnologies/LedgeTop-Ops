# Authenticated delivery changes in the client bell

Implementation plan, not deployment evidence. The existing PA grant-accepted
bell and authenticated file-change email batches are separate producers. This
plan closes the missing file-change bell workflow without changing PA grant
receipts, adding recipients, or making SMTP success an access decision.

## Presentation contract

Use an immutable **sealed net-change summary**, not one bell item per file.
Preserve the existing five-minute quiet period and 50-object batch limit.
Add/remove churn that has no net change within the same unsealed window
produces no notice. A real remove/re-add cycle after a prior batch has been
sealed/published remains a distinct accepted transition rather than being
mistaken for an old queue retry. Transition identity does not imply one bell
item per transition; same-window churn is intentionally collapsed.

The existing explicit, exact-person notification policy remains the eligibility
boundary. Organization contacts, department names, matching email addresses,
and a PA business-party link are not recipient expansion rules. Workspace
eligibility alone never grants delivery access.

Before sealing, staff cancellation can cancel the pending notification. After
sealing, the bell event is immutable: cancelling a pending email cannot retract
or rewrite history already presented to a client. The UI must distinguish
pending-notification cancellation from email-only cancellation. Send Now seals
the current summary through the same authorization and compare-and-swap path;
it must not bypass that path or merely race the scheduler.

## Ordered implementation

### 1. Repair transition staging

`recordAuthenticatedDeliveryObjectChange` must arbitrate event ordering inside
the transaction that changes object state and batch items. A pre-read timestamp
check is insufficient. An older concurrent event must not change the item after
losing the object-state comparison. Sealing, claiming, cancelling, policy
changes, and capacity changes between read and write must not mutate an already
sealed batch or silently consume an unstaged transition.

Preserve queue retry behavior. Distinguish a definite stale/no-op event from an
ambiguous write response; do not wrap commit-ambiguous mutations in an automatic
application retry.

### 2. Make accepted index changes recoverable

The shared R2 consumer currently changes the authoritative file index before
notification staging, in separate calls. It does retry failed messages and
re-enters staging even for already-indexed creates and already-absent deletes;
separate calls alone are not proof of a lost notice. First exercise failure and
replay with source replacement/removal between attempts, and define which
accepted transitions the summary must retain. Do not add an outbox merely to
duplicate the queue's existing retry mechanism.

The checked-in file-events consumer has five retries and no dead-letter queue.
If staging remains unavailable through that budget, a previously committed
index transition has no durable notification recovery source. This is a
specific recovery gap, unlike an ordinary short-lived failure which replay
already repairs. Verify the deployed queue separately; checked-in configuration
is not proof of its current live configuration. The consumer fault tests must
exercise both persistent failure and successful retry, while retaining stale
replacement suppression and intentional net-zero summaries.

If that evidence shows an accepted transition cannot be recovered, persist a
bounded accepted-transition receipt/outbox in the same D1 transaction as the
applicable index transition and project it idempotently into the batch pipeline.
A process failure after indexing must not make a transition promised by the
notification contract disappear on retry.

The receipt needs action, authoritative object-version/observation coordinates,
and a transition identity that distinguishes real remove/re-add cycles. Do not
deduplicate solely by final ETag or object key. Retain replacement-safe delete
handling and authoritative HEAD validation; notification recovery does not
authorize deleting or re-importing source files.

### 3. Seal independently of mail

Use a separate authenticated-change recipient ledger and per-person state.
Do not widen migration 0202's PA-only event type, receipt foreign key, or grant
guards to accommodate a different authority model.

Sealing atomically checks the pending batch revision, its complete net-change
summary, and current exact source/workspace, policy, grant/version, recipient,
binding/version/prefix, membership, access terms, and denials. It inserts one
immutable bell event, unique by sealed batch. Retain the authority coordinates
needed for current-access checks, without returning them or raw object keys to
the browser. Missing new schema must not silently accept a notification and
omit its durable event.

The current `sealed_at` is a mail-pipeline marker set by capacity handling or
dispatcher claim, not proof that a client event was published. Introduce an
explicit seal/publish phase and readiness gate that the scheduler runs even
when SMTP is unavailable. Mail dispatch then consumes the sealed summary with its existing bounded leases and
attempt budget. Email configuration failure, provider failure, retry, or
email-only cancellation does not delete an already-published bell event.
Current authorization still governs every bell read and mutation; retained
history does not override a revoked grant.

The current pending-batch cancel control is not an email-only suppression API.
Add a distinct post-publication email suppression state/control with its own
authorization and concurrency checks rather than relabelling that mutation or
changing the immutable bell event.

### 4. Join the existing client workflow

Add the new ledger to the unified bell with its own bounded watermark. Bump the
cursor contract and require refresh for older cursors instead of adding a new
stream halfway through an existing page. Preserve deterministic ordering,
actor/workspace-bound read and dismiss state, stale-context cancellation,
and exact authorized delivery links. PA grant notices, requests, feedback, and
legacy notifications keep their own producers and authority checks.

## Required verification

- Migrated-D1 interleavings: older event after newer state, millisecond ordering,
  same-version observations, remove/re-add, batch seal/claim/cancel and capacity
  changes between read and transaction.
- Fault injection at index acceptance, outbox persistence, staging, sealing,
  and delivery. Replay recovers a committed receipt without duplicate notices;
  rollback leaves neither partial index acceptance nor an orphan bell event.
- Bell publication with SMTP disabled, misconfigured, failed, and retrying;
  pending cancellation versus email-only cancellation after publication.
- Exact-source/workspace collisions, overlapping grants, principal rebinding,
  policy changes, expiry, and revocation before seal, read, or state mutation.
- End-to-end shared R2 event to batch to client history, read/dismiss and exact
  delivery navigation, including cursor refresh and combined pagination.
- Desktop/mobile and keyboard workflows: clear state labels, no per-file bell
  flood, no stale workspace contents, and no action that implies new access.
- Migration-first coordinated rollout, default-off staging, bounded recovery,
  and documented rollback that retains accepted events. No announcement mail
  or automatic recipient backfill.

The Viewer is outside this change. Completing only transition staging does not
complete the new bell producer or the overall client-management goal.

## Local staging-fix checkpoint

The isolated staging patch passed its 20-test suite, including same-second
policy timing, concurrent policy revision, folder-snapshot changes, and a
49-to-50 capacity race with replay. Five additional consumer tests verify
transient create/delete recovery and stale replacement suppression, and
characterize the unresolved finite-retry recovery gap. Passing the latter
test does not fix that gap. The joined current-migration native-delivery test,
Operations type checking, and the production build also passed. These are local
fixture/build results, not deployment or live
notification acceptance. The separate bell producer and its UI workflow
remain planned work.
