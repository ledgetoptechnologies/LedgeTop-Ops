# Source retention v2: review proposal, not a wire contract

The existing Processing `source-retention-v1` validator accepts a closed v1
metadata receipt and does not authenticate a storage owner, a snapshot, or
physical custody. Preserve it byte-for-byte and never add v2 fields to v1.
This proposal is unagreed and inactive. The snapshot candidate at `9c77363a`
is committed only on an isolated feature branch; it is not activated and it
does not issue any receipt or release a hold.

## Proposed closed signed payload

* `schemaVersion`: integer `2`; `receiptType`: `source_retention_v2`.
* `receiptId`, `storageReceiptId`, `operationId`: distinct stable role IDs.
* `issuerId`, `keyId`, `keyEpoch`, `ownerInstanceId`, `ledgerEpoch`: trusted
  owner/lineage identifiers, with positive integer key epoch.
* `jobId`, `generation`, `environment`, `inputManifestSha256`,
  `pipelineDigest`: exact original Processing submission identity.
* `datasetId`, `snapshotId`, `snapshotCreateTxg`, `holdId`: immutable physical
  identifiers; snapshot and hold semantics need owner-side verification.
* `objects`: complete input closure as records with exactly `id`, `byteSize`,
  `sha256`; sort by ASCII object ID, reject duplicates; positive byte sizes.
* `sourceClosureSha256`: digest of the complete canonical `objects` array.
* `retainedAt`, `validationVersion`, `retentionGuarantee`: canonical UTC
  milliseconds, version ID, and `until_explicit_release_ack_v2` respectively.

The proposed outer envelope has exactly `payload`, `signatureAlgorithm`, and
`signature`. Proposed initial algorithm: Ed25519, encoded as unpadded base64url.
Before use, both owners must agree exact grammars, algorithm/key registry,
issuer authorization, validity/revocation, epoch/anti-rollback rules, object
limit, snapshot identity semantics and retention/release lifecycle. In
particular, textual `retentionGuarantee`, owner IDs and valid signatures do
not themselves prove a physical pin or prevent a privileged release.

## Proposed canonical bytes and signature

Use strict UTF-8 JSON without BOM, duplicate keys, unknown keys, unsafe
integers, floats, non-finite values or invalid Unicode. Limit IDs and keys to
the agreed ASCII grammar; sort object keys by UTF-8 bytes, preserve array
order, emit compact JSON with no whitespace and canonical integer forms.
Cross-language golden vectors must pin exact bytes, including non-ASCII
handling where permitted. `sourceClosureSha256` is SHA-256 of
`ASCII('LTDS-SOURCE-CLOSURE-V2') || 0x00 || canonicalUTF8(objects)`.
The signature covers `ASCII('LTDS-SOURCE-RETENTION-V2') || 0x00 ||
canonicalUTF8(payload)`; `signature` and `signatureAlgorithm` are envelope
fields and are not inside the signed payload. The algorithm must be fixed by
the trusted key registry rather than chosen solely from the envelope. The
receipt digest, if needed for an outbox or ACK, must be separately domain
separated and pinned in the paired contract; none is implied here.

The consumer must recompute full closure and compare each ID, size and hash
against the independently validated input manifest, authenticate issuer and
key/epoch against current protected authority, and check current retention and
anti-rollback state. A verified receipt is not a release authorization, a
source-read grant, a completed result, or proof that any other stage settled.
No original LAS/LAZ or raw Emlid CSV may be deleted by receipt processing;
raw Emlid CSV retention is permanent. Uncertain authority, status, or release
holds. Runtime wiring, signed receipt emission, NAS mount/hold isolation,
source byte verification, forward migration and Processing consumption remain
unimplemented until the two repositories agree on a pinned schema and vectors.

## Proposed closed lexical and semantic rules for review

All objects are plain JSON objects with exactly the specified keys; arrays and
strings are bounded before allocation. Slug IDs (`receiptId`, `storageReceiptId`,
`operationId`, `issuerId`, `keyId`, `ownerInstanceId`, `ledgerEpoch`, `jobId`,
`validationVersion`, object `id`) match `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`.
Receipt, storage and operation IDs are pairwise distinct. `environment` is
exactly `staging` or `production`; `generation` and `keyEpoch` are integers in
1..9007199254740991. Digests are exactly 64 lowercase hexadecimal characters.
`schemaVersion`, `receiptType` and `retentionGuarantee` are exactly as above.
`retainedAt` is `YYYY-MM-DDTHH:mm:ss.SSSZ`, years 0001..9999, with actual
Gregorian calendar validation (no leap seconds or normalized invalid dates).

`datasetId` is 3..512 ASCII bytes, a slash-separated sequence of segments
matching `[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}`; reject `.`/`..`, empty segments,
backslashes, `@`, leading/trailing slash and non-ASCII. The owner must compare
it to one exact administrator-configured dataset, not a prefix. `snapshotId`
is exactly `datasetId + '@' + snapshotName`, where snapshotName matches
`ltds-[a-f0-9]{32}`; its derivation and uniqueness must be pinned by the
approved owner contract. `holdId` is the ASCII literal `truenas` only for the
specific TrueNAS API proposal, not an assertion that other holds do not exist.
`snapshotCreateTxg` is a decimal string matching `[1-9][0-9]{0,19}` and no
larger than `18446744073709551615`; compare as an arbitrary-precision integer,
never a JavaScript number. Reverify actual installed TrueNAS semantics and
stable snapshot identity before adoption.

`ownerInstanceId` identifies one provisioned owner authority, not a PID;
`ledgerEpoch` identifies its protected non-reusable history generation. Both
must be resolved through an independently maintained trust registry and
durable high-water/rollback anchor outside the receipt database. `keyId` and
`keyEpoch` identify a key bound by that registry to this issuer, owner,
environment, algorithm, validity window and revocation policy; claimed times
and self-declared epochs are not authority. Provision, rotate, revoke and
restore keys through that separately reviewed registry; missing or rolled
back state holds. Key IDs cannot be reused for different key material.

`objects` contains 1..10000 closed `{id,byteSize,sha256}` records, with positive
safe-integer byte sizes and exact ASCII ID sorting (`Image-B` precedes
`image-a`). The consumer independently validates the full original manifest,
including its names, kind, mediaType, counts, sizes and hashes, and recomputes
its own manifest digest using the existing manifest contract. The owner must
use an authenticated immutable mapping from each manifest object ID to an
exact safely resolved spool path and read/hash that snapshot file; neither an
ID/hash in this receipt nor an untrusted path field is that mapping. The
mapping's derivation, stored evidence, source finalization and snapshot-bound
no-follow file reads are still unagreed owner-side prerequisites. Full
coverage and total limits must match the original manifest; no subset may
claim full source custody.

`apps/viewer/test/fixtures/source-retention-v2-proposal-vector.json` contains a
deterministic **public test key** and synthetic vector for review. Its fixed
seed is not a secret and must never be provisioned. It pins compact canonical
payload/closure bytes, both domain-prefixed messages and digests, signature,
and envelope; the `Image-B` / `image-a` order is deliberate. The fixture is
not a signature-validation service or storage receipt.

Processing independently reports that its Python `canonical_json` reproduced
the exact closure/payload bytes, domain-prefixed messages, SHA-256 digests,
manifest closure and snapshot derivation for this candidate vector. Node and
Processing report synthetic Ed25519 verification, the latter using PyCA
cryptography 50.0.2 in its test environment. The production Processing image
is stdlib-only; pin and review a maintained verifier dependency or separately
reviewed crypto boundary, and verify deployed runtime availability before any
activation. This evidence does not establish an issuer, snapshot, custody or
rollback authority. The fields are frozen for the fixture-only candidate; any
change requires a new pinned candidate and cross-language vectors.
