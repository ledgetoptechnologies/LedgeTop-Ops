# Offline encrypted backup envelope component

`scripts/staging-backup-envelope.mjs` provides two library functions:

```js
const envelope = await sealStagingBackup(bytes, key, reviewedBinding, keyId);
const restoredBytes = await openStagingBackup(envelope, key, reviewedBinding, keyId);
```

This component has **no CLI, provider calls, file storage, key loading/generation/export,
credential reads or import execution**. Merger must review the separate export, private
storage, key-custody and restore executor before using real data. Passing these functions'
tests does not establish a consistent backup, correct source lineage, accepted data transfer,
recovery after a machine loss or permission to restore a database.

## Bound identities

The binding has exactly these fields: `role`, `runId`, `sourceAccountId`, `targetAccountId`,
`sourceDatabaseId`, `targetDatabaseId`, `migrationChainSha256`, `sourceSnapshotSha256`.
Role is `operations` or `portal`; run ID is a UUIDv4 and both hashes are lowercase SHA-256.
The source account is the existing Ledge Top account and **only the old staging database
IDs** are admitted. The target is the separate Staging account and Merger's allocated IDs:

| Role | Legacy staging source D1 | Allocated target D1 |
| --- | --- | --- |
| Operations | `78b34173-b168-4e3d-9832-bb9d245cc6b8` | `a58ea102-f04d-417a-bfd1-b0654cfeb503` |
| Portal | `b6f653ab-9acd-4421-9ad0-207754b59aeb` | `15d02028-8c52-40b2-9979-d67abf7d5bbf` |

The fixed source/target mapping is a validation fence, not a grant to query either account.
It cannot be widened by an environment variable. Future reallocation requires reviewed
source changes. Before real use, Merger must independently confirm both identities and pin
the actual reviewed snapshot/migration manifests; the library cannot prove the caller's
declarations describe a consistent source export.

## Cryptographic boundary

- Inject a nonextractable AES-GCM 256-bit `CryptoKey` from a separately reviewed protected
  custody mechanism. The function needs the corresponding encrypt/decrypt usage. It does
  not export, persist or log the key. A process-local test key is not a recovery strategy.
- Every seal generates a random 12-byte IV and uses a 128-bit authentication tag. Canonical
  associated data binds the format version, exact reviewed identities/hashes/run, symbolic
  key ID, computed plaintext SHA-256 and plaintext length. Altering these fields does not
  allow opening ciphertext in a different role, target, run or key context.
- Opening checks exact schema, size and canonical base64 before cryptographic processing;
  it releases plaintext only after authenticated decryption and digest/length verification.
  The caller must keep returned plaintext in private memory and clear it after its reviewed
  use. Do not write it to an ordinary temporary SQL file, stdout or logs.
- The component's internal seal copy is cleared after use. This is best effort memory
  hygiene, not proof that a JavaScript runtime or the caller has erased every copy.
- Error messages are fixed codes, never reflected provider/caller data. Shared receipts
  may contain reviewed identities and safe hashes, never plaintext payloads, secret values
  or private object names. Envelope metadata is authenticated but **not encrypted**.

## Capacity and continuity limits

A single payload must be nonempty and at most **32 MiB**. Oversized input fails closed.
This is a bounded in-memory D1-backup component, not a streaming R2 transfer. Do not split
an export arbitrarily: ordered multipart manifests, complete-set verification and a safe
streaming transfer protocol are separate unimplemented requirements. Do not assume opening
one envelope proves an entire migration is complete or that retries/imports are idempotent.

Keep ciphertext, its reviewed manifest/receipt and protected recovery-key custody until
Merger accepts restore/recovery and applicable retention. Losing an unpersisted key makes
the envelope unrecoverable. Key rotation must keep the old recovery key until old backups
can be recovered; replacing the key ID alone is not rotation. No provider import can follow
merely from successful decryption: SQL/schema/authority/ledger parity and source/grant
continuity still require the guarded executor described in `custody-tooling.md`.

Local synthetic cryptographic checks:
`node --test --test-concurrency=1 scripts/staging-backup-envelope.test.mjs`.
These checks must use generated synthetic bytes and ephemeral test keys only; do not pass
real exports or secrets to a test runner.
