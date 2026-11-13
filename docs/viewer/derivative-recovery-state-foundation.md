# Derivative supplement recovery state foundation

This candidate is inert. No HTTP route, worker dispatch, converter run, physical
storage adapter or qualified supplement verifier is installed. `prepare` fails
closed by default. It does not repair the Todd output by itself.

Migration 43 adds a dedicated journal instead of disguising the operation as a
catalog import. Deployment therefore requires migration/rollback qualification;
the prior schema-42 same-schema adoption receipt does not apply to this change.
The journal retains immutable request identity, source-state fingerprint and the
original failure snapshot. Foreign-key restrictions preserve its referenced
history. There is deliberately one operation per attempt, with reclaim of that
operation after worker death rather than another reconstruction or recovery job.

Only the active failed native-processing attempt, its failed unpublished managed
model/output, one failed mandatory mesh derivative, and completed other required
derivatives are eligible. Ready/published versions, newer attempts, active jobs,
dataset operations and already registered tiles are rejected. Authorization is
bound to the requesting staff session and rechecked throughout qualification.

Qualification holds the token-fenced heavy-work singleton but leaves the failed
attempt and derivative unchanged. Both measurement claim paths observe that
singleton; recovery also rejects running measurement calculations. A reclaimed
lease invalidates the former owner's token and in-memory qualification tickets.
The absolute deadline cannot be extended. Expiry or abandonment releases only
the fenced singleton and preserves original output/source failure state.

The future trusted adapter must pin and independently rehash actual source and
supplement files, enforce capacity and complete closure, verify current converter
identity, geometry, LOD0 texture coverage/density and the defined final encoding
contract. It must provide bounded cancellation, crash recovery and cleanup. Its
registration callback is synchronous and transaction-only; use
`registerVerifiedLodAssetInTransaction`, never nest a repository transaction.
No caller-supplied `verified: true` JSON is a qualification ticket.

The adapter's registration and the existing all-required finalization run in the
same SQL transaction as restoration. Any exception rolls back every restored
state. Successful finalization uses the existing ready-for-review event and
Viewer acceptance ACK boundary. It does not publish a model. Filesystem promotion
and durable crash reconciliation still need the physical adapter; SQL rollback
alone does not roll back renamed files.

## Validation

Native Windows Node 24.16.0: 19 recovery-state tests and 18 existing input/policy
tests pass (37 total, no skips). Tests cover ownership/replay, failed state and
archive preservation, default-closed qualification, eligibility denial, lease
reclaim, registration rollback, finalization/ACK invocation, both measurement
admission orders, expiry and transaction-only hooks. Synthetic registration is a
state test, not texture/conversion or actual coordinator ACK-delivery acceptance.

An independent read-only reviewer found the initial measurement-admission gap;
the fix and tests were independently rechecked. A broader seven-file regression
attempt on native Windows failed in Linux-only storage initialization at
`/proc/self/fdinfo`; it is not a successful broader regression run. Run the
affected storage/provenance/automatic-safety suites on the admitted Linux test
host before promoting this PR. Do not skip them or weaken the Linux guards.

No runtime update, host install, source-data mutation, reconstruction retry,
conversion or publication is authorized by this foundation's test results.
