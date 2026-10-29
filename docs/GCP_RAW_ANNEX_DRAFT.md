# Raw GCP source annex: isolated draft, not release-ready

This branch is a source-only experiment. **Do not deploy or enable it.** No API
route, UI, worker, or startup hook calls the draft raw-source journal or archive
materializer. Migration 47 is provisional and has not been reconciled against a
real target database. This draft does not satisfy the user's retention request.

The candidate preserves UTF-8 bytes (including a BOM and line endings), binds
the preview confirmation to their SHA-256, and uses a pending SQLite BLOB row
before any attempted materialization. A Linux-only descriptor-based archive
candidate writes a synced temporary file, creates a final hard link without
overwriting an existing name, and checks the result. Pending journal entries
participate in the dataset purge fence. Recovery inspection is read-only and
blocks matching preexisting sets until complete derived-state validation exists.

Before integration or activation all of the following remain open:

- Merge and independently review the exact actual migration ledger, identities
  41–47 and unknown-version rejection, including upgrades and pre-WAL failure.
  Verify the actual deployment ledger before any write; earlier prototype 43–46
  schemas are not established as compatible.
- Provide authenticated archive-root identity and exclusive writer fencing,
  including existing and external writers, safe root/mount replacement handling,
  physical CSV protection, and complete crash/restart reconciliation. The
  database ready trigger does not itself attest that an archive file exists.
- Implement complete set, points, provenance and mark validation on recovery,
  a safe ready transition, and resolution of stale partial files and failed writes.
  No caller may treat the read-only recovery plan as a completion receipt.
- Build a bounded authenticated byte transport and preview/import UI; retain
  authorization on every idempotent replay and prevent legacy text-only manual
  import from bypassing byte retention. Support the existing indexed-file
  discovery and explicitly label historical text-only records as unverified.
- Specify capacity and backpressure for permanent pending BLOB rows without
  silently dropping user files. The disabled journal now checks an explicit
  server-owned byte and entry policy inside its write transaction; this is
  logical accounting only. Reconcile physical database/WAL and archive quotas,
  trusted policy configuration, current authorization on every replay, and
  operational recovery and every purge/cleanup path before activation.
- Validate on actual Linux with the target filesystem: normal, replay, symlink,
  concurrent writer, interrupted creation, process death, partial file, full
  disk, I/O errors, and directory/file fsync behavior. Unit tests on Windows
  cannot establish those filesystem properties.
- Run rendered desktop/mobile browser acceptance and the full staged workflow,
  then review release decisions and target state before production deployment.

Local Windows evidence at this draft: 10 raw-source/journal/archive tests
passed, and two Linux archive tests were skipped. This is not power-loss,
cross-process, external-storage, or production evidence.
