# Disabled managed-file reservation experiment

`referenceV2ManagedFileCandidate.js` is an isolated Linux experiment, not a
route, migration, deployable issuer, production pin, or authorization control.
Its `issue()` always rejects. Use only a disposable database, directory and
synthetic files. The caller-provided scope and root descriptor are not trust
boundaries. No production source or key may be used.

The experiment reads one direct child of an already-open directory, rejects
symlinks and hardlinks, checks file identity before and after reading and
compares size and SHA-256 with the requested fixture. It stores a copy of at
most 1 MiB as a SQLite BLOB. The existing fixture then atomically records the
copy's reservation, quota debit and unsigned synthetic outbox in the same
database; its triggers prevent ordinary source updates/deletes once reserved.
The original name can disappear after the copy without destroying the copy.
This holds only for the fixture's cooperative SQLite database: no external
writer, administrator, old binary, snapshot rollback, filesystem or database
owner is fenced, and this is not production-managed dataset integration.

The fixture first commits one immutable mapping of directory device/inode,
filename, source ID, revision, digest and size. It permits only one mapping and
one up-to-1-MiB copy through this interface; a failed or interrupted request
can permanently hold that slot. Copy insertion happens before the reservation
transaction. A crash between those steps leaves an uncharged copy, which exact
recovery can reserve; no automatic cleanup or release exists. These limits do
not constrain direct database writers or total physical SQLite overhead, and the
candidate is unsuitable for large photo datasets. The
tests cover a killed owned process at that boundary, reopening, single-charge
replay, original removal, unsafe source names and tampering; they do not prove
power-loss behavior or cross-host storage durability. The `afterCopy` hook is
only for the isolated interruption test.

## Wire boundary

The implementation intentionally retains the synthetic fixture's local intent
and `ltds-v2-synthetic-reservation-receipt-v1` signing domain. It does **not**
implement or authenticate Processing's experimental wire and must not be
connected to it. As inspected at Processing commit `07f1a47`, its separate
closed canonical ASCII JSON v1 intent and receipt use detached Ed25519 with
`ltds-v2-reservation-intent-experiment-v1\0` and
`ltds-v2-reservation-receipt-experiment-v1\0`; the intent commitment uses
`ltds-v2-reservation-intent-digest-experiment-v1\0` plus canonical intent.
The receipt digest is plain SHA-256 of canonical receipt bytes. The intent binds
coordinator authority and epoch, both deployments, Viewer ledger and epoch,
replay IDs, job/attempt/generation, manifest/count/bytes/budget, policy and
claim-binding commitment; the receipt binds the shared fields, intent digest,
receipt/reservation IDs and source revision. See Processing's
`reference_v2_reservation_candidate.py` for exact field sets and validation.
There is no claim-token-derived fingerprint in the Viewer contract.

Real issuance still requires independently authenticated intent and current
authority/epoch, approved exact schema and policy, a durable real multi-file
source pin and quota across all writers, stream and old-binary fencing,
cross-store restart reconciliation, key lifecycle and clock trust, retention
and revocation policy, storage power-loss qualification, and matched vectors.
The 300-second proof window, empty-source handling, budget semantics and source
pin lifetime remain provisional. Nothing here authorizes activation or deletion.

## Proposed idempotency and custody lifecycle

This is a proposal for agreement, not behavior supplied by the wire or this
experiment. A coordinator persists one unique intent and idempotency ID for a
specific job, attempt, generation, manifest, object count, total source bytes,
budget and policy. Viewer verifies the independently authenticated canonical
intent, binds it to an immutable source revision and all exact object hashes,
and atomically records quota and a receipt outbox. All identity reuse with any
different canonical intent, source mapping, revision or bytes must hold as a
conflict. Exact retries return the original committed receipt and stored
signature without additional debit; a missing response or interruption keeps
the reservation and charge, and cannot silently create a new reservation.

The retained bytes and manifest remain available through processing, recovery
and retry. Processing should persist an authenticated durable acceptance that
binds the exact reservation ID, receipt ID, intent digest, source revision,
manifest and original job/attempt/generation, and replay that acknowledgment
idempotently. Acceptance confirms its defined durable handoff only: it is not
proof that streams stopped, a cleanup instruction, or permission to delete raw
data. A separate authorized and audited cleanup decision must confirm all
required consumers and retry/retention obligations, fence old writers and
streams, and durably reconcile source pins and quota before releasing anything.
Timeout, disconnect, proof expiry, restart or an ambiguous acknowledgment alone
never releases a pin or quota. Exact acceptance authority, scope, storage,
retention, cancellation and release semantics require joint agreement.
