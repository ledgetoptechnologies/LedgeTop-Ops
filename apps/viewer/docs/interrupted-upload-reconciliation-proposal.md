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

## Candidate fixture receipt (not an agreed wire protocol)

For cross-language, disabled local experiments, a closed payload could contain
`schema`, `receiptId`, `requestId`, `attemptId`, `batchId`, `taskId`,
`taskGeneration`, `authorityId`, `admissionGeneration`, `reservationSha256`,
`initializationSha256`, `manifestSha256`, `batchIntentSha256`, `snapshotId`,
`scope`, `complete`, `entries` and `keyId`. Each accepted entry would contain
`wireNameUtf8Base64url`, `role`, `sizeBytes` and `sha256`, derived from bytes
actually accepted rather than merely echoing expected input. The scope and
completeness claim must match what the prototype can establish; a cooperative
snapshot is not a claim of a physical fence. If fields are unavailable, a
different explicitly versioned fixture schema is necessary; never fabricate
values or interpret missing fields as recovery authority.

Candidate encoding: canonical lowercase UUIDs and SHA-256 hex, bounded unsigned
canonical decimal strings for sizes and generations (avoiding JavaScript number
precision loss), strict unpadded base64url of validated exact UTF-8 wire-name
bytes, and a closed role vocabulary. Sort entries by decoded wire-name bytes
then role; reject duplicates and names equivalent under receiver rules. Use
bounded inputs, reject duplicate decoded keys and unknown/missing fields, and
require canonical byte-for-byte encoding. RFC 8785 JCS on this restricted schema
is a candidate, subject to cross-language vectors and implementation agreement;
Python compact `ensure_ascii` JSON and JavaScript serialization must not be
assumed equivalent. A separate envelope carries payload and lowercase hex MAC;
for a provisioned test-only key, the proposed HMAC-SHA256 input is ASCII
`ltds-coordinator-inventory-fixture-v1`, one NUL byte, then canonical payload
bytes. Validate a fixed-length MAC in constant time. No key fallback, no real
credentials, and no network endpoint are implied.

Receipt and request identifiers bind immutable bytes: same identifier and same
payload replays the durable original; same identifier and different payload is
a conflict. Test duplicate keys, escaped and non-ASCII names, invalid UTF-8,
normalization/case aliases, invalid base64url, integer boundaries, reordering,
unknown fields, altered MAC and key IDs, crash at each transaction boundary,
concurrent requests, and identical Python/Node canonical bytes and MACs. A
shared HMAC proves only that a holder made the statement; it does not establish
the issuing process's identity, ledger freshness, a fence, or durable charge.
Local database rollback and removal of retained task data remain unresolved.

### Public synthetic encoding vector

This vector is deliberately fictional: the repeated-byte hashes are not
hashes of real inputs, `complete` is an invented assertion, and the publicly
known key must never be used outside tests. Processing confirms that its current
`viewer_files` records have no durable batch association or stream intent, and
that initialization, manifest and batch intent fields would currently be caller
assertions. No present issuer can truthfully make this receipt. This vector
tests bytes only; it grants no authority and does not alter the hold.

For this ASCII-only example, the candidate canonical UTF-8 payload is exactly
the following single line, without a trailing newline:

```json
{"admissionGeneration":"2","attemptId":"00000000-0000-4000-8000-000000000001","authorityId":"test-authority","batchId":"00000000-0000-4000-8000-000000000002","batchIntentSha256":"1111111111111111111111111111111111111111111111111111111111111111","complete":true,"entries":[{"role":"photo","sha256":"2222222222222222222222222222222222222222222222222222222222222222","sizeBytes":"6","wireNameUtf8Base64url":"Zmlyc3QuanBn"}],"initializationSha256":"3333333333333333333333333333333333333333333333333333333333333333","keyId":"public-test-key","manifestSha256":"4444444444444444444444444444444444444444444444444444444444444444","receiptId":"00000000-0000-4000-8000-000000000004","requestId":"00000000-0000-4000-8000-000000000003","reservationSha256":"5555555555555555555555555555555555555555555555555555555555555555","schema":"ltds-coordinator-inventory-fixture-v1","scope":"batch","snapshotId":"00000000-0000-4000-8000-000000000005","taskGeneration":"1","taskId":"00000000-0000-4000-8000-000000000006"}
```

- Public key hex: `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`.
- Payload SHA-256: `121e14b94ec3a6677be25f3d7e56234b4720b9a6e44f94ee28e8d35b5c42d0b6`.
- HMAC-SHA256 over the specified domain, NUL and payload:
  `69e96fdf72b79c1a3a675b858055cf2c6a6de3b61bff6d0bb589c2dece0ab6e6`.

Independent Python and Node calculations matched for this restricted example.
It does not establish full RFC 8785 compatibility: Unicode ordering, escaping,
invalid input, duplicate keys and boundary cases still need shared vectors and
actual independent canonicalizer implementations.

### Viewer local batch fixture

`referenceBatchIntentFixture.js` is an unmounted, synthetic-only experiment.
Its caller must supply a dedicated trusted fixture database: the scope string
does not verify the SQLite connection or protect tables from direct writers.
It stores an immutable batch intent, including original multipart order, and
compares caller-supplied observations by exact name, role, size and hash.
Every result returns `hold`; `complete` and the inventory are unverified caller
assertions. The restricted ASCII name profile, decimal-string sizes and
canonical JSON are not an agreed Processing protocol. It does not record a
qualified provider origin, deployment epoch, stream identity, physical budget,
source proof or fence. No current application path creates these records.

Processing reports its local draft now accepts explicit `photo`, `gcp` and
`auxiliary` intent roles, validates photo versus non-photo wire class, and does
not infer or verify GCP semantics from filenames. Its integer representation,
other binding fields and canonicalization remain different. Cross-language
mapping must wait for a mutually reviewed exact contract and actual durable
receiver associations; this fixture alone is not that mapping.

The following fictional ASCII Viewer batch vector is public and contains no
real source hashes. Its two entries are in multipart order, and the GCP role is
explicit intent rather than verified GCP semantics. The single-line canonical
UTF-8 bytes, without a newline, are:

```json
{"attemptId":"00000000-0000-4000-8000-000000000001","batchId":"00000000-0000-4000-8000-000000000002","entries":[{"role":"photo","sha256":"1111111111111111111111111111111111111111111111111111111111111111","sizeBytes":"6","wireNameUtf8Base64url":"Zmlyc3QuanBn"},{"role":"gcp","sha256":"5555555555555555555555555555555555555555555555555555555555555555","sizeBytes":"6","wireNameUtf8Base64url":"Z2NwX2xpc3QudHh0"}],"initializationSha256":"2222222222222222222222222222222222222222222222222222222222222222","manifestSha256":"3333333333333333333333333333333333333333333333333333333333333333","providerId":"00000000-0000-4000-8000-000000000003","providerTaskId":"00000000-0000-4000-8000-000000000004","reservationSha256":"4444444444444444444444444444444444444444444444444444444444444444"}
```

SHA-256 of ASCII `ltds-viewer-batch-intent-fixture-v1`, a NUL byte, and those
payload bytes is `c8cf385d6f6fe6988039065eec01df344a9f3252caf1010f5076e1411918b08d`.
Independently constructed Node and Python calculations match this example;
it does not establish an agreed Processing wire format or general Unicode
canonicalization. Reordering entries changes the digest and is a batch conflict.

The opt-in paired fixture exercises this restricted mapping against Processing
commit `5b3c67d92c18c2bc19c6080ee4591f8470001ff2`: a synthetic process exits
after binding but before journal preparation, reordered replay conflicts, and
exact replay allows two synthetic TaskStore writes and journal associations.
Viewer maps a subset and then exact observed records while returning `hold` in
both cases. The test checks Processing rejects zero-length, wrong wire class,
more than 256 files, more than 64 MiB and noncanonical bytes. Its container-only
data and caller-asserted completeness do not prove authenticated inventory,
source custody, physical stream fencing, GCP semantics or retry authority.

The revised paired fixture also passed against clean Processing commit
`499a544da71f8e6662a89597914b8e5429bc9f00`, which commits binding and journal
intent in one transaction. It killed the synthetic process after the binding
insert and before journal preparation, verified both tables were absent after
restart, committed the exact replay and exited, then rejected reordered replay
and accepted the original. This exercises that particular pre-journal point
and the post-commit point; it does not test a crash after journal writes but
before commit or establish a physical fence. Viewer continues to hold.
