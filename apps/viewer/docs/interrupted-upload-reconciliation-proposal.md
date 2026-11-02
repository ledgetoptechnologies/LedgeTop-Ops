# Interrupted upload reconciliation: proposed contract

Status: design only, disabled. Existing Viewer attempts in `uploading` or
`uploading_auxiliary`, or marked `provider_upload_acceptance_unknown`, remain
held before provider observation or mutation. Neither this proposal nor a
synthetic test grants authority to resume. Retain original inputs, GCP snapshot,
attempt metadata, receipts and accounting evidence throughout recovery.

## Scope and prerequisites

Viewer currently persists a submission phase and a count before and after a
multipart batch. The count does not identify what the receiver durably stored.
Its immutable attempt provenance also includes an input manifest and digest;
the initialization snapshot binds the provider, task UUID, options and (when
present) reservation. A future protocol must bind to those existing records,
and explicitly define wire filename mapping and roles, rather than assuming an
array position or provider image count proves identity.

Reconciliation requires a coordinator capability negotiated for the exact
deployment and a separately proven authority that fences all predecessor
writers and upload streams. A lease timeout, socket close, process restart,
local database lock, count or untrusted fixture claim is not that proof. The
fence must prevent a previously authorized handler from committing data after
the inventory snapshot, including buffered bytes and delayed writes. Its scope,
enforcement, durability across restart and failover, and current validity need
independent evidence. If any prerequisite is absent or uncertain, hold.

## Durable records and receipt

Before dispatch, Viewer would atomically record a unique immutable batch intent
with attempt ID, provider identity and origin, provider task UUID, reservation
binding and deployment audience, initialization request digest, full manifest
digest, batch ID, generation, exact ordered entries, and physical transfer
budget authorization. Each entry binds a unique wire name, semantic role,
byte length and SHA-256 of the actual bytes to send. The mapping from local
source to wire name must be immutable and collision-free under the receiver's
actual filename and Unicode/case rules; reject aliases, duplicate names,
unsupported roles, missing hashes and source changes. The generated GCP input
must be bound by its own immutable snapshot. Do not treat a filename or hash
alone as sufficient identity. Persist the intent before opening the stream.

After a verified fence, the coordinator would durably commit and authenticate a
complete accepted-inventory receipt, not a count or a list of only known
successes. It must bind protocol and canonical encoding version, issuer/key and
exact deployment audience, coordinator epoch and monotonic durable ledger
position, task and reservation identity, initialization and full manifest
digests, batch/stream generation and intent digest, fence ID/scope/epoch and
proof reference, and every accepted wire name, role, size and SHA-256. It must
state the inventory's completeness and scope (batch and task) and whether
partial or uncommitted files exist. Its identity and content must be replay-safe;
repeated requests return the same receipt, while any conflicting use of an ID
is a hard hold. Signing alone is not a fence, and an unsigned, incomplete,
stale, rolled-back or unanchored local receipt is not sufficient authority.
Canonicalization, durable commit/rename and fsync semantics, key rotation,
authorization, rollback protection and receipt retention require agreement and
implementation by Processing; no current endpoint is assumed to provide them.

The receiver must hash bytes it actually accepted and couple its durable file
and inventory transitions so a crash cannot advertise data it lost or omit
data a stale handler can later commit. A completeness claim must cover every
relevant namespace and role, including extras, duplicate aliases and partials.
If it cannot distinguish a complete exact inventory after recovery, it returns
unknown and Viewer holds. Bounded pagination, if used, needs a single pinned
snapshot/position, authenticated page commitments and explicit end marker;
missing, duplicated, reordered or mixed-generation pages fail closed.

## Decision and resumption

Under a current Viewer job lease and current independent storage/operation
authority, validate all identities, source snapshot and actual file hashes,
the coordinator receipt and fence, and physical accounting. Compare sets of
the exact entries, not counts. Any unexpected, conflicting, duplicated,
unverifiable, changed or partial entry holds the attempt. An exact complete
batch may advance only through a single durable compare-and-swap transition
that records the verified receipt, fence and decision with the expected old
attempt phase, batch ID, lease generation and evidence digests. A repeat of
that transition must yield the same decision; conflicting evidence must not
overwrite the original. The provider receipt and local transition must survive
a crash on either side; a local database transaction cannot make the remote
receipt atomic and does not itself fence an old Viewer writer.

If the accepted set is a strict subset, do not automatically resend it.
Resuming missing entries additionally requires a new, independently fenced
stream generation, fresh scoped authorization, verified immutable source bytes,
and separately reserved *physical* request and byte budgets that account for
all previous attempts and uncertain transfers. Receiver idempotency must cover
the exact batch/entry identity and reject conflicting content. Acknowledgment
loss or an uncertain accounting charge remains held until separately
reconciled; receipt count, elapsed time, or a logical-deduplication key cannot
prove that a physical retransmission was free. Before any production adoption,
define the authority, crash consistency and retention of both the receiver's
inventory ledger and the budget ledger, including restore/rollback and old
writer isolation. If no such guarantees are available, use manual inspection
and keep the original attempt and source retained.

## Required tests before enabling

- Independently validated fence: in-flight old handlers, buffered multipart
  data, delayed disk writes, partitions and failover cannot mutate the snapshot
  afterward; denied or uncertain fences never produce a usable receipt.
- Exact identity: changed bytes or sizes, wire aliases, same name/different
  role, duplicate and extra entries, missing entries, partial files, wrong task,
  reservation, request, audience, epoch, manifest or batch all fail closed.
- Durable recovery: crash before/after each intent, file commit, inventory,
  fence, receipt, local compare-and-swap and acknowledgment; retry responses
  are identical or held, including stale receipts and rollback/restore.
- Concurrency: competing Viewer workers, expired leases, old deployments,
  conflicting replay IDs and simultaneous generations cannot authorize two
  writes or advance twice. Verify the real independent fence, not a mocked
  boolean, and demonstrate source retention through every failure.
- Accounting: interrupted and repeated physical uploads consume independently
  bounded bytes/requests even when logical IDs deduplicate; exhaust budget,
  lose acknowledgments and reconcile uncertain charges before allowing retry.
- Integration: actual Viewer and coordinator over bounded synthetic transport,
  plus explicit process-kill and buffered-stream scenarios; distinguish
  injected resets from natural shutdown. Existing opt-in forced-reset test
  establishes the current hold, not this proposed recovery authority.

Open questions: who owns and enforces the physical predecessor fence and ledger
anchor; can Processing provide a complete per-batch and task inventory with
durable byte hashes and role identity; what are the canonical wire format,
key lifecycle and receipt retention; how are partial files quarantined; and
where are physical transfer reservations charged and recovered? Until resolved
and tested, no automatic resume or production activation is authorized by this
document.

Processing reports that local candidate `74d3081` supplies cooperative
closed-gate point-in-time page observations only. Its lock does not fence
direct/external writers or file and mount changes; it has no durable receipt,
prior-stream generation or physical quota binding. Inventory retention ends on
task removal, and its Python compact JSON is not an agreed wire encoding. It
therefore does not satisfy this contract and must not be consumed as recovery
authority. Reverify these observations against the current implementation before
using them in a future design review.

For reference, a separate synthetic v1 broker test charged the full six-byte
request on each of two interrupted deliveries (12 bytes, two requests). The
v2 fixture's stopped flag is synthetic, not a remote stream fence, and planned
coordinator budget rows are not proof of Viewer charges. A possible, unagreed
future design uses a stable logical request bound to the full claim, reservation,
generation, manifest, object and range, plus unique physical delivery IDs and
bounded retransmission budgets. It still needs atomic server-side uniqueness and
charge before sending, authenticated status and retention, current authority,
and independently enforced predecessor fencing. Unknowns remain held.
