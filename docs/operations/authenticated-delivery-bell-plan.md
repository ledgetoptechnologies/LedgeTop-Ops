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

## Recovery and next implementation checkpoint

The subsequent local recovery implementation adds transactional accepted-change
receipts, sealed exact targets, provider-identity fencing, and a bounded
projector. Its rollout constraints and test evidence are recorded in
`delivery-change-recovery-design.md`, including the administrator recovery
status card. Capture is not enabled by these local changes.

Steps 3 and 4 now have a local implementation under verification; they are not
release or live-acceptance evidence. Migration 0209 introduces a separate
immutable exact-recipient event ledger, mutable individual read/dismiss state,
and an audited email-only suppression control. The publisher is independent of
SMTP and integrated with maintenance and Send Now. A version-4 cursor adds the
new history stream, and delivery-only workspaces can display the bell.

The local UI checks passed 78 Operations browser cases and six new client cases
across desktop/mobile, including failed read actions that must not navigate.
Both production builds passed, with the existing large-chunk warnings. Six
cursor checks passed. These runs do not replace backend acceptance: migrated-D1
tests exposed an expression-depth limit in publication and native history, and
fixtures needed to respect automatically created immutable source mappings.
Those corrections and their joined reruns remain release gates. Source
authority must also be rechecked before SMTP dispatch, not only when the bell
is first published.

Native delivery actions use exact encrypted folder handles. Bridged/legacy
root delivery actions remain deliberately non-linking until an exact scoped
navigation contract is implemented; never substitute a broad archive link.
Combined-stream pagination, publication rollback/interleavings, recovery
regressions, migration-first rollout and actual end-to-end delivery still need
their complete acceptance evidence. Do not publish a schema-only or UI-only
slice as completion of this workflow. No production migration, notification
backfill or announcement email is authorized by this checkpoint itself.

### Continued local verification

The complete Operations notification browser suite passed again after removing
the duplicate section heading and distinguishing staff email suppression from
an eligibility failure. The six Operations notification-control tests passed.
Seven recovery/provider/index/replay suites passed 53 checks, including atomic
receipt rollback, immutable target replay, and safe scheduler error reporting.

The native query depth correction passed its initial three history tests, but
a subsequent fixture audit found an unrelated PA grant with the same ID could
mask the authenticated staff-grant path. That fixture is now being replaced
with a genuine native staff publication, and candidate matching explicitly
requires the staff grant family. The secondary native publication receipt must
also be enforced at candidate staging, final staging CAS, publication, history
mutation and final email authorization. Its implementation and complete rerun
remain pending; the earlier passes are not acceptance of that newer fence.

### Exact-folder workflow for existing bridged workspaces

Do not extend native `np1_` handles to legacy-adapter workspaces: their native
context proof does not exist there. Do not use `pf2_` or the past-deliveries
archive as a substitute: those paths authorize a different, broader selection.

An isolated `ad1_` codec now provides a strict, encrypted, short-lived resource
coordinate with a separate key purpose. It binds source, workspace, global
identity, recipient event, grant/version and binding/version, plus a relative
path. Decoding is not an access grant. The initial four codec tests passed;
current-workspace authorization and browser/resource integration are still
required before any bridge bell item may use it.

Remaining implementation order:

1. Reuse one current-event authorizer for history/state and exact resource
   requests; retain the same-statement source, recipient and authority checks.
2. Add exact folder, continuation and file resource routes fenced to that
   event's binding prefix. Recheck before emitting private data. Reject stale
   or revoked handles; never fall back to an archive or an unrelated grant.
3. Route the bridge bell action to that exact folder in the client FileBrowser.
   Descendant navigation and file requests must retain the same scope. Native
   navigation stays native; ordinary archive navigation stays unchanged.
4. Verify crossed sources/identities, replacement grant IDs/versions, receipt
   revocation, prefix changes, pagination, failed read actions and mobile UX
   through the actual resource route, not just mocked link strings.

### Exact-folder implementation checkpoint (not released)

The shared batch authority query now materializes only the selected batch's
native publication proof, rather than an unbounded grant ledger. Its focused
Operations publication suite passes four tests. The joined client run passes
13 of 14 checks: effective-workspace history, receipt enforcement, handle
validation and cursors pass; the true native staff-grant fixture still fails
candidate discovery and remains a release blocker.

The subsequent four-suite regression run passes 48 tests covering existing
content auditing, notification mutation fences, native PA-draft/delivery
history, and AD1 codec behavior. This protects existing producers; it is not
evidence for the new AD1 resource/audit path, whose positive and denial tests
are still being added.

The AD1 resource router and client navigation are implemented locally. A bridge
notice opens its exact folder; children, breadcrumbs and continuation handles
retain the event/source/workspace/global-identity/grant/binding coordinates.
Invalid or revoked inputs never fall back to the archive. File GET/HEAD uses
conditional R2 reads and byte ranges, checks indexed versions and tombstones,
and rechecks current authority before returning metadata or content. Existing
public links and native NP1 navigation are unchanged.

After tightening response validation (including rejecting broad media URLs
inside an otherwise valid AD1 folder response), the client build and 12 focused
desktop/mobile browser checks pass. Desktop and mobile screenshots show the
scoped shared-folder view without horizontal overflow. The browser fixtures
cannot prove database authorization or R2 behavior: the mounted Worker tests
remain required. Headerless browser media requests select a workspace only
from a decoded AD1 coordinate, reject conflicting workspace headers, then run
the same live identity resolver and exact resource authorization.

These v2-grant content starts use the existing `native_delivery` audit ledger
shape (workspace/global identity/folder binding/grant), even when the shell has
a legacy adapter. The new authenticated-delivery producer proves the exact
recipient event and current batch authority instead of inventing an account
association. This does not change existing native grant producer semantics.
Content release fails closed if required auditing is unavailable. Map, bulk,
feedback and delegated-share controls are not routed through broad legacy
authorizers from the new exact-folder view; their future integration must
retain the same scope.

The focused history suite subsequently passes all six tests. The native
fixture now supplies its required directory `contains` relation and proves a
real staff grant without a same-ID PA grant masking authorization. Coverage
includes native read/dismiss behavior and paginated authenticated events with
backdated insert fencing, no duplicates/loss, and cross-source cursor denial.
This is not yet multi-kind pagination coverage. Operations TypeScript checking
also passes on the current local implementation.

Pending acceptance: actual migrated-D1 resource and audit tests, true multi-page
mixed-stream coverage, complete regression runs, and final joined browser
verification. This checkpoint is implementation progress only, not a claim that
the workflow or overall goal is finished.

### Publication retry fairness (local, acceptance pending)

The bounded publisher previously selected the same first 20 eligible batches
when their source connection proof was unavailable. That could delay ready
batches from another source indefinitely. Migration 0209 now includes a
publication retry deadline; an unchanged pending batch that is not ready is
deferred by one minute without cancelling it, changing its quiet-period time,
or granting access. Candidate ordering uses the retry deadline when present,
so fairness does not depend on cron running more often than once per minute.
Successful publication clears the deadline. A concurrent revision change wins
over this scheduling-only update. Real-D1 fairness regression is required before
release, including an already elapsed retry delay.

### Resource acceptance findings (local)

The migrated-D1/R2 route tests confirm scoped folder navigation, headerless
media downloads, byte ranges, conditional responses, and cross-actor/workspace
denials. Required auditing exposed a real D1 expression-depth failure before
content release. Its correction keeps the batch-authority and event/file proof
in independent materialized CTEs, required by both the audit insert and replay
read in the same transaction. It does not replace authorization with a pre-read
or make auditing optional. Focused positive audit/replay and deliberate audit
failure tests must pass before releasing this correction. The first refactor
preserved 11 existing audit/handle regression tests but was not sufficient to
fix the new path; do not treat that earlier green run as acceptance.

The new multi-kind native history pagination case passes in isolation, covering
both existing delivery notices and authenticated-change notices on page one,
continuation without loss/duplication, and a backdated late insert. The entire
seven-case history suite is being rerun together to check fixture interactions.

The second audit-query refactor passes its focused mounted-resource case:
required auditing permits an authorized download, replay keeps one audit row,
and an intentionally rejected audit insert still prevents preview content.
The six-case resource suite remains a separate combined gate.

Publication fairness also passes its real-D1 regression: 20 source-unavailable
native batches remain pending, a later ready primary batch publishes, and
already elapsed retry deadlines do not move those unavailable batches ahead
of older never-attempted ready work. The seven-suite Operations center/recovery
group passes 55 tests. A clean final full notification suite is still required;
the earlier 32/33 run plus targeted fixes is not counted as one green full run.

### Combined history and resource acceptance (local)

The combined seven-case history run reproduced two failures after the new
mixed-kind pagination case. That case left its additional native notices in
the shared migrated database, moving the original native notice off the first
page used by later cases. Test teardown now dismisses only the pagination
case's extra notices for its exact fixture workspace and recipient; immutable
events, baseline notices, and all pagination assertions remain unchanged.
The corrected combined run passes 13 tests: all seven history cases and all six
migrated-D1/R2 resource cases. That includes the current-authority audit and
replay proof, deliberate audit failure, byte ranges, conditional requests,
Unicode folder navigation, policy revision and grant revocation during R2
metadata lookup. Client TypeScript checking and tracked-diff whitespace
checking also pass. Generated Worker bindings were refreshed for the two apps
whose committed declarations were stale, and the complete generated-type gate
now passes. These changes remain local pending the remaining Operations,
Ops Sync, browser, build, and deployment-safety gates.
