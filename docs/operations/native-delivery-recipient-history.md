# Native delivery recipient history

Status: implementation and focused verification in progress. Not deployed.
This increment does not complete the whole client-management goal.

Verification checkpoint: Operations type checking and a full migration-chain
SQLite schema/FK check were reported passing. Five Client cursor tests and
Client type checking were reported passing. These do not prove the joined
workflow or authorization races. Several producer test invocations printed only
the command output and lost the returned session/exit metadata. Their outer
orchestration completion is not evidence that the child process finished;
those runs are unverified, must not be counted as passes, and must not be
restarted solely because their output was quiet. Preserve complete command
result objects and resume returned session handles for subsequent verification.

The focused Operations delivery-intent suite was then rerun with preserved
terminal evidence: 24 tests passed with exit code 0. This includes separate
fail-closed cases for each required 0202 table and confirms guest delivery stays
available when the recipient-bell schema is unavailable. The migrated native
notification staging suite also completed with preserved evidence: 31 tests
passed with exit code 0. Consumer mutation and joined authorization-race
evidence are still pending, so this remains non-release evidence.

## User workflow and authority

An accepted Project Alpha portal delivery should appear in the recipient's
existing notification bell even when email is disabled or fails. An exact
source-qualified principal may receive a grant before signing in for the first
time; that must not discard the event. Event retention is not portal access:
the reader must resolve the current authoritative individual identity binding
and reauthorize the exact delivery before displaying it.

The producer owns immutable source/workspace/principal/version and receipt,
grant/version, folder binding/version, owner and prefix coordinates. Per-person
read and dismissed state is separate. Rebinding a principal must not transfer a
former person's read state or infer identity from an address-book email.
Neither bell history nor an email status grants file or workspace access.

An explicit `pa_portal_principals.identity_id` binding is authoritative. A
historical eligibility record may establish access only while that principal is
unbound (`identity_id IS NULL`); it cannot override a non-null binding to a
different identity. The same rule is enforced by workspace resolution,
delivery and feedback reads, and the atomic notification-state mutation fence.
Regression coverage preserves both legitimate cases: the explicitly bound
identity and an unbound principal with current exact eligibility.

The current producer is **PA grant acceptance**, not all native file changes.
`authenticated-delivery-change-notifications.ts` has a separate accepted
object-version contract for opted-in authenticated grants. Its recipient-event
projection remains required follow-up work. Coverage must not imply those
events are included merely because PA grant notices are available.

## Required acceptance before integration

- An accepted portal grant commits its receipt and recipient event together,
  independently of SMTP staging, success, cancellation or retries.
- An exact retried delivery returns the same receipt without another event;
  conflicting replay cannot replace the event or recipient coordinates.
- An unclaimed principal's accepted event survives until legitimate identity
  binding; no contact or email match can claim it.
- Current source, root, principal, binding, grant, expiry, denial and access
  terms are enforced when reading and atomically creating/updating read state.
- Revocation between the initial route check and the write rejects the write.
- The single bell merges bounded pages deterministically, preserving each
  ledger's fixed watermark. Older cursor contracts require refresh rather
  than inserting a new ledger into an existing page.
- Legacy delivery/request/feedback notices and their mutation paths remain
  compatible. Unsupported native file-change coverage is explicit.
- Migrated-D1, route, merged-pagination and responsive browser tests pass.

## Rollout and recovery requirements

Client migration `0202_native_delivery_recipient_events.sql` is additive to
the existing migration history. It does not waive the maintenance/drain
requirements for pending migrations 0200/0201. Follow their preserving migration
runbook first; never replay raw migration SQL against production.

The Operations producer requires both `native_delivery_recipient_events` and
`native_delivery_recipient_event_state` before accepting a new portal grant.
This is deliberately stricter than accepting access while leaving the client
bell unusable. A missing table returns 503 before receipt, grant, outbox or
event writes; guest delivery and revocation remain independent.

Deploying a producer that silently accepts a new portal grant while omitting
its event is not an acceptable compatibility mode. Require the new schema
before accepting new portal grants, or provide a separately verified durable
reconciliation mechanism. Guest deliveries and revocation must not depend on
notification availability. Readiness behavior and its regression tests are
still being finalized; do not treat this document as release approval.

Keep additive tables and history on rollback. Rolling back to an older writer
can create an event gap even if access itself remains correct. Pause new
portal intent acceptance while restoring a compatible writer, or record and
reconcile the exact accepted-receipt interval before claiming complete history.
Do not replay client emails as recovery and do not delete retained events to
make a deployment appear clean.

Live acceptance remains LTDS-only. Preserve its existing single signed
integration endpoint, current public links and all revocations. Do not enroll
LTT, send announcement mail, or modify the Viewer to validate this increment.

## Follow-up: authenticated file-change event projection

The inspected producer is `recordAuthenticatedDeliveryObjectChange` in
`apps/operations/src/worker/authenticated-delivery-change-notifications.ts`.
It is invoked after the shared R2 event consumer's authoritative HEAD/index
transition. Its candidates are exact opted-in staff authenticated grants, not
the PA intent grants referenced by migration 0202. Its batch transaction writes
current object-version state and net-change mail items; publication and SMTP
success happen later. Do not join a 0202 PA grant ID to the staff grant table.

The follow-up must persist the accepted transition independently of mutable mail
batch state, in the same transaction as transition acceptance. Deduplication
must distinguish a retry from a later real remove/re-add cycle; hashing only
the final object version is insufficient. Recheck observation ordering at the
write boundary, not only in the pre-read. Keep exact source, individual grant
recipient, grant/policy/binding versions and current delivery authorization.
An explicit notification policy is not a substitute for file permission.

Tests must exercise repeated and out-of-order events, remove/re-add, policy or
grant changes during staging, ambiguous overlapping grants, independent mail
failure/cancellation and source-qualified recipient isolation. Define whether
the bell presents immutable per-transition notices or a sealed net-change
summary before adding this producer; do not accidentally make Send Now/Cancel
erase or rewrite already-presented client history.
