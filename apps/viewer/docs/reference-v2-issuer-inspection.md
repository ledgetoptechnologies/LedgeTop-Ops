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
