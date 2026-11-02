# Disabled Viewer v2 issuer inspection

`referenceV2IssuerInspection.js` is an offline fixture inspection, not an
authenticated issuer, production reservation, receipt, route, storage pin, or
authorization. `issue()` always rejects. The scope label is not a security
gate, and fixture-supplied keys, expected body and clock are not an independent
trust registry, current epoch, or proof of coordinator authority. No real data
or production key should be used.

The inspection checks the provisional Processing v1 intent's closed canonical
ASCII representation, detached Ed25519 signature and experimental domain,
fixture key scope and time, exact caller-supplied expected intent, and dataset
binding/object rows. It recomputes the Viewer dataset manifest, checks every
indexed file against binding rows, reconstructs the current image-only
Processing submission from indexed roles and checks the selected paths, sizes,
digests and excluded IDs. Raw CSV IDs remain excluded in this fixture. The
dataset manifest and selected Processing manifest are distinct. Generated GCP
auxiliary input is deliberately unsupported until it has its own source binding.

This combines existing components in a test using actual SQLite binding rows
and synthetic filesystem files, but the binding has no physical writer fence:
the test removes the unconditional admission trigger in a disposable DB only.
Signature correctness is not authentication when registry/expectation/clock are
caller supplied. The result explicitly says both the coordinator-to-Viewer
attempt mapping and `claimBindingSha256` are **unverified**; a signed coordinator
attempt ID is not assumed to equal the Viewer attempt ID. No authoritative
mapping or claim lineage is inferred from similar IDs or names. The test also
rejects a validly signed, protocol-valid subset that tries to submit the raw
CSV in place of the image.

## Provisional two-attempt association

The optional fixture comparison reads `viewer_reference_attempt_journal` by
the bound Viewer attempt, verifies exact stored request/job hashes, matches the
local task/dataset, submission ID, environment, job ID, generation, Processing
manifest and pipeline digest, and compares these with the supplied coordinator
observation and signed intent. The coordinator observation, key registry,
clock and signed claim-lineage value are still supplied and untrusted. A local
journal match is **not** an authenticated or current coordinator claim.
The pipeline digest is compared to the stored job and supplied observation; it
is not independently recomputed from the submission pipeline or authenticated.
The separate database reads do not form a consistent transaction snapshot.

For joint review only, the unsigned proposal has exactly these fields:

`version`, `kind`, `issuer`, `keyId`, `audience`, `operation`, `issuedAt`,
`expiresAt`, `nonce`, `environment`, `trustDomain`, `coordinatorDeploymentId`,
`coordinatorAuthorityId`, `coordinatorEpoch`, `viewerDeploymentId`,
`viewerLedgerId`, `viewerLedgerEpoch`, `viewerAttemptId`,
`coordinatorAttemptId`, `submissionId`, `jobId`, `generation`, `manifestSha256`,
`pipelineDigest`, `intentDigest`, and `claimLineageSha256`.

Literal fixture values are `kind: "attempt-mapping"` and
`operation: "bind-attempt"`. The nonce is exactly 32 bytes encoded as
canonical unpadded base64url (43 ASCII characters); validating its encoding
does not establish how it was generated.

The experimental detached-signature domain proposal is ASCII
`ltds-v2-two-attempt-binding-experiment-v1` followed by one NUL and the exact
canonical body. The separate diagnostic body commitment is SHA-256 of ASCII
`ltds-v2-two-attempt-binding-digest-experiment-v1`, one NUL, and those same
body bytes. `intentDigest` is the existing domain-separated intent commitment;
`claimLineageSha256` is copied from the signed intent but is not independently
verified. `nonce`, issued/expiry times and the 300-second limit are provisional;
shape checking cannot prove randomness or trustworthy time. The proposed body
is not allowed to outlive its input intent. The public unsigned
vector `test/fixtures/viewer-two-attempt-association-proposal.json` uses two
different synthetic UUIDs and is checked against the actual fixture journal.
It is neither a signature nor an agreed wire. A production implementation must
derive and verify both sides from independently authorized persisted records,
and must not serialize a claim token or token-derived fingerprint.
The coordinator-bound fixture requires `coordinatorAuthorityId` to be a UUID;
the older `authority-1` value is valid only for the separate signature-only
vector and is rejected as an association. The UUID in this Viewer vector is a
synthetic proposal, not evidence of any actual coordinator record.

Before any real receipt or source reservation: establish independently trusted
issuer/key/audience/purpose, revocation and current epoch/clock; define a
durable, authoritative cross-system job/attempt/claim mapping; qualify source
root identity, immutable multi-file retention and all-writer/stream fencing;
reserve real byte/object quotas and implement transactional idempotency,
receipt outbox, crash/restore reconciliation, and signed wire vectors; define
acceptance and separately authorized release. The Processing source projection
at commit `5d8394b` is similarly disabled and uses supplied snapshots. A local
fixture match is not evidence any of those prerequisites is satisfied.

## Disabled association signing outbox fixture

`referenceV2AssociationOutboxFixture.js` creates a disposable-only SQLite
outbox for the proposed **attempt mapping**, not a source-reservation receipt.
The production method `liveIssue()` always rejects; no migration or route calls
this fixture. It uses the existing inspection inside one `BEGIN IMMEDIATE`
transaction to read the actual fixture binding, dataset and Viewer journal,
then commits the exact canonical body, signed coordinator intent, fixture
viewer public key and idempotency identities. A second SQLite writer test
confirms the fixture's snapshot transaction holds the write lock. This does not
lock filesystem writers or authenticate the supplied coordinator observation.

The test-only signer runs after commit. Its Ed25519 signature is checked with
the stored fixture public key, then the input, binding and journal are checked
again in a new transaction before the signature is stored. Exact replay returns
the stored bytes and signature without signing again; conflicts hold. Replay
revalidates the supplied clock, key and records and can therefore fail closed
after expiry or changes. An owned child is killed after signing but before the
outbox update; its signature is not captured. A separate in-process signing
interruption is compared with retry after reopening. Tests also reject signer
mutation of message, key and expected context.
When encoded for the proposed wire, a 64-byte Ed25519 signature is canonical
unpadded base64url of 86 ASCII characters. No real key or signing service is
used; schema/trigger integrity, independently current trust, storage rollback,
physical source pin, quota, and actual cross-system attempt mapping remain
unqualified. No response from this fixture permits source cleanup or delivery.
The separate public `test/fixtures/viewer-two-attempt-association-signed-fixture.json`
contains a fixed public test key and detached signature over the same canonical
proposal. `test/helpers/reference-v2-mapping-test-signer.js` deliberately embeds
the public test seed (32 bytes of `0x51`) so Processing can sign its own
synthetic fixture; it must never be used as a production credential. It accepts
exact canonical ASCII body bytes on standard input without a trailing newline,
requires the synthetic staging/test issuer, key ID, deployments and authority
UUID, and prints the test SPKI and signature. The helper checks fixture shape,
not authority; no signature from this public key is a real Viewer issuance or
cross-system authorization.

The isolated fixture can also insert the observed indexed binding and its
association outbox row in one SQLite transaction. Failed inspection rolls both
back; the production admission guard remains in place. This is an unfenced
filesystem observation, not physical custody.

`test/helpers/reference-v2-association-stdin-fixture.js` is a synthetic-only
cross-process harness. It accepts schema version 1 JSON on stdin and emits a
JSON result with the persisted body, signature, test public key and SQLite
path. It accepts staging/test inputs with manifest ID `dataset-d`, selected
direct-child ASCII source names, and the fixed test validity interval. The
caller supplies a private, empty, owned output directory and is responsible
for its cleanup. `prepare-sign` creates the fixture; `replay` requires the same
inputs and uses the stored signature without calling the signer. Setting
`VIEWER_ASSOC_FIXTURE_PAUSE_AFTER_COMMIT=1` writes a `FIXTURE_SIGNED_COMMIT`
marker and stops the owned process for crash testing. The helper embeds the
same public test seed and cannot establish real authority or custody.

## Large datasets and limits

The metadata planner test covers 10,000 image records totalling 52,428,800,000
bytes and a separate retained raw CSV; it allocates no image payloads. The
current v1 contract permits at most 10,000 submitted objects and 4 MiB of
submission metadata, so longer names or a generated GCP auxiliary can exceed
these limits. A generated GCP file counts as one object: at most 9,999 images
can accompany it. The retained raw CSV is excluded from submission and does
not consume a submitted-object slot. The snapshot reader reuses one 1 MiB buffer while hashing source
files, and the binding table stores file identity metadata, not image bytes.
This test is not a 50 GB NAS benchmark or proof of retention.

The offline acquisition currently hashes every source synchronously while a
SQLite write transaction is held. That can block other writers for an
unacceptable time on a real large dataset, and filesystem and NAS writers
remain unfenced. A production design needs a durable source-side retention
barrier and an interruption-safe, bounded scan that does not hold that lock
across full dataset I/O; revalidate the barrier and metadata before the short
commit. Do not enable admission based on the fixture's scale test.

`referenceSourceScanFixture.js` explores that transaction split in disposable
databases only. It commits a single retained `scanning` intent in a short
transaction, observes the files with no SQLite write transaction held, then
compares the observed files against current indexed metadata and calls the
existing source-binding draft in a second transaction. The normal admission
trigger must be removed only in a disposable fixture. An interrupted or failed
scan remains `scanning` and blocks another fixture scan; it is not automatically
retried or released. Tests show a second SQLite writer can commit during file
reading, metadata changes fail closed, process death leaves no binding, and
10,001 metadata records (10,000 images plus CSV) can be bound without copying
their contents into SQLite. The metadata test does not read 50 GB of source.
Fixture-only SQLite triggers hold indexed dataset/file updates, deletes and
replacement while a scan intent is active. Tests use a separate connection to
check these guards and show that a missing guard holds finalization. The fixture
checks trigger names, not trusted schema definitions or protection against a
database administrator; these triggers are not a production writer fence.

An optional synthetic association is now prepared in the same final transaction
as the binding and scan-intent state change. Signing remains outside that
transaction and is revalidated before persisting; exact replay uses the stored
signature. Tests kill an owned process before and after the final commit and
verify rollback or durable replay, and reject changed supplied authority data.
This validates caller-supplied fixture snapshots, not a current authority.

An explicit disposable-fixture option connects the scan intent to the
experimental lifecycle, import-cleanup, catalog-cleanup and adoption effect
claims. Either an existing claim or scan intent prevents the other from being
created, globally and transactionally. A process must actually use the relevant
cooperative claim for this to work; this option is not installed in production.
The scan reopens and checks captured root, directory and file identities after
hashing, outside the write transaction, detecting ordinary replacement or
content changes between the scan and that check. This is still not a lock.

The intent is not connected to all filesystem writers, NAS administration or
external clients. Current write paths include dataset upload assembly and
finalization, import/adoption and cleanup, storage trash/restore/purge,
photo imports and GCP raw/materialized files. Their complete coverage by the
experimental cooperative claims has not been proven; old processes may bypass
them entirely. A file can change after the final identity check
and before or after the metadata commit, without changing its indexed row;
aliases and replace/restore races also remain. The scan checks for many changes
while it reads, but it cannot close those races. Production requires an
enforced source-side barrier, recovery semantics and a verified authority
before the disabled gate can be reconsidered. Generated GCP auxiliary binding
is not yet supported by this inspector even when within the v1 object limit.

The current writer audit identifies `datasetOperationWorker.finalizeUpload` →
`StorageManager.assembleFile` for assembled uploads; `copyTaskPhotos` for task
photo copying; `StorageManager.adoptImport` and recovery/cleanup for imports;
and `moveExact`, trash, restore, and purge for lifecycle effects. The raw GCP
archive and reference GCP materializers are presently dormant primitives.
The disposable cooperative fixture has a managed-writer adapter with durable
in-flight claims, global exclusion against scan/binding, and a fail-closed hold
for failed or uncertain callbacks. The dataset worker accepts an explicit
fixture injection for upload finalization, managed adoption and raw-photo copy. With injection,
it holds the claim across the actual copy, synchronizes the finalized tree and
root, and waits for the dataset-operation receipt before completing the claim.
Tests exercise the real worker paths, uncertain operation receipt and killed
fixture writer. An in-flight managed-writer claim now blocks another fixture
writer as well as a scan. A current dataset worker seeing the fixture marker
without its own matching injected handler defers its write after restart;
this cannot constrain an old binary. Existing lifecycle fixture injection
covers its experimental trash/purge claim paths. The dormant GCP materializers
also accept explicit fixture injection; the reference materializer refuses a
missing handler when it sees the marker. The raw archive primitive has no
database in its ordinary interface, so a direct caller can omit the injection.
None of these injections is installed in production; direct and legacy
StorageManager callers remain unqualified.
Filesystem and SQLite durability under actual NAS failures is not established;
callback completion is not sufficient evidence to release a production claim.

`test/reference-managed-upload-custody-e2e.test.js` joins the actual upload
worker, fixture writer claim, unlocked scan, indexed binding, outbox signature
and database reopen into one synthetic flow. The raw CSV stays in the Viewer
binding and is excluded from the submitted photo manifest. It removes admission
triggers only in the disposable test database and uses a raw SQLite reopen;
normal `openDatabase` rejects that altered protected schema. This demonstrates
that the fixture cannot be activated by ordinary startup.

## Deployment evidence still required

No process inventory or idle period by itself proves old writers have stopped.
Before enabling a real reservation, the deployment needs a verified inventory
of every process and identity with write access to the actual source volume,
including old Viewer workers, recovery jobs, direct mount clients, administrator
sessions and services reachable through aliases. It needs a barrier enforced by
the storage authority that prevents those identities from changing or removing
the reserved objects for the full reservation lifetime, and a way to detect
restarts, changed mounts, lost barriers and stale authority. Any unavailable or
ambiguous evidence must hold admission. The fixture claims and identity checks
are not that barrier; no TrueNAS or NAS configuration was inspected here.

One candidate design to investigate is a storage-authority-controlled,
read-only immutable snapshot or equivalent retained source, identified by a
stable volume and snapshot identity and retained by a durable hold. Hash that
retained view outside SQLite, compare it with the indexed manifest, and bind
the exact snapshot and hold to the reservation in a short transaction. The
storage authority must independently prevent snapshot deletion or replacement
and supply current authenticated evidence before transfer and release. A
rollout would also need to stop and account for prior Viewer workers and direct
mount clients, prevent them from regaining write access, and prove new workers
use the barrier; a version check or process list alone is insufficient. Storage
support, privileges, failure behavior, aliases, retention and capacity remain
unverified. This proposal makes no snapshot or configuration change.

Existing `requireProcessingHeadroom` groups dataset, cache and model estimates
by observed filesystem device and includes local active attempt and derivative
estimates. A synthetic 50 GiB test exercises separate device groups and existing
reservations; this does not measure a NAS, reserve free blocks or establish
remote quota. Source intake separately checks dataset free space. Live admission
would require current, authoritative capacity and inode evidence for each
relevant physical volume, alias-aware shared-volume accounting, concurrent
durable reservations, safety headroom, expiry/renewal and revalidation when
mount or quota authority changes. No capacity claim is issued by this fixture.
