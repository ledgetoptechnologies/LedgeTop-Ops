# Reference result range-resume candidate

This candidate makes an interrupted sealed-result download resumable inside the
existing Linux descriptor-backed spool. It is deliberately unmounted: no
provider enables it, and it does not grant custody, accept a result, publish a
model, or change the live Viewer route.

## Transfer and recovery contract

- The existing sealed result manifest binds the object ID, byte count, object
  SHA-256, job generation, environment, input manifest, and result manifest.
- A resumed request carries `Range: bytes=<durable offset>-<last byte>` and must
  receive HTTP 206 with the exact `Content-Range`, remaining `Content-Length`,
  object digest, and manifest digest. A 200 response or any mismatch fails
  closed. The original full-body request remains unchanged.
- The journal reserves the exact object before creating a spool file. It tracks
  a monotone durable offset and SHA-256 of the prefix. The spool verifies that
  prefix on restart, discards only bytes beyond the last recorded checkpoint,
  and resumes from the recorded offset. Periodic checkpoints are 8 MiB; a
  failed stream also persists its received tail before returning the error.
- An exact prior candidate journal schema is migrated transactionally by
  retaining its intents and initializing transfer progress at offset zero.
  WAL, FULL synchronous mode, foreign-key enforcement and the exclusive root
  authority are established before migration. A post-commit barrier failure is
  reported without attempting rollback; reopening verifies the committed
  schema. Unknown schemas fail closed. Existing ready files are still verified
  against their original binding before reuse.
- A prefix whose bytes no longer match its durable digest stays held: the
  candidate does not discard it, request another range, or publish a result.
  Recovery requires an operator-reviewed repair or restore that re-establishes
  the exact prefix; this candidate does not yet provide an operator repair
  command.
- The full object length and SHA-256 must match before a no-replace link can
  publish the retained file. A crash after linking but before removing the
  temporary name is recovered only when both names identify the same private,
  regular file with the expected size and digest.
- Pending transfers have both a per-object byte limit and an aggregate pending
  byte limit. These bounds apply before contacting the provider.
- Transfer replay remains tied to the original binding. The result acceptance
  outbox continues to retry after a lost Viewer acknowledgement without
  redownloading or re-ingesting an already verified result.

## Verification

The synthetic tests cover exact range headers and status, mismatched range
metadata, interruption and restart, uncheckpointed-tail truncation, prefix and
whole-object digest checks, pending-byte quotas, link/unlink crash recovery,
old-schema migration including post-commit authority loss, zero-byte reports,
corrupted-prefix hold behavior, and lost acceptance acknowledgement replay.
Filesystem durability tests require Linux descriptor and directory-fsync
behavior; a Windows run skips those cases.

The feature remains a candidate until the Viewer chat reviews the isolated
branch, its upstream/PR base is resolved, and an authorized runtime wiring and
acceptance plan is completed. Do not infer production readiness from these
synthetic results.
