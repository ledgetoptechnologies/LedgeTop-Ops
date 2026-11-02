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
these limits. The snapshot reader reuses one 1 MiB buffer while hashing source
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

The intent is not connected to the filesystem, existing lifecycle writers,
NAS administration or external clients. A file can change after observation
and before or after the metadata commit, without changing its indexed row;
aliases and replace/restore races also remain. The scan checks for many changes
while it reads, but it cannot close those races. The fixture does not atomically
commit an association outbox with this split binding. Production requires an
enforced source-side barrier, recovery semantics and an atomic association
commit before the disabled gate can be reconsidered.
