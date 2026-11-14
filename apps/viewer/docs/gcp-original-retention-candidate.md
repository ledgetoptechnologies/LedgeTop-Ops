# GCP original retention candidate

Source candidate only: not deployed or a claim of complete Emlid acceptance.

The staff UI uploads bounded binary data before parsing. The server retains exact
bytes and SHA-256 independently of editable sets and managed dataset deletion.
UTF-8 BOM and line endings are preserved. Indexed CSV files are retained before
trash/purge even when never imported. Retention does not make an invalid CSV valid
GCP input or submit it for processing.

Archive rows reject ordinary SQL updates/deletes. A FULL synchronous transaction
and successful full WAL checkpoint precede acknowledgment and destructive
lifecycle operations. Busy checkpoints or changed/missing indexed sources block
deletion and preserve the existing intent for reconciliation. Database backups
remain necessary; application retention cannot prevent storage-volume loss.

Downloads require the dedicated staff GCP read permission and are private/no-store.
No public links or client grants are created. Origin-project metadata grants no
access. Legacy text is marked `legacy_utf8_snapshot`, without claiming recovery of
lost original octets. New text-only imports require a matching indexed raw file
or the binary upload protocol; otherwise `gcp_original_upload_required` is returned.
Frontend releases must preserve the separate 48-hour asset requirement.

## Source verification

Thirty-five focused and existing GCP tests pass with reused dependencies, one test at a time and a
128 MiB Node heap. Coverage includes tiny local HTTP upload/import/delete/download,
authentication, mutation-key requirements, exact BOM/CRLF bytes, immutable rows,
legacy fidelity, trash/purge and refusal on source drift or busy checkpoints.
Reconciliation also recovers an older-version intent journal whose tree already
moved to trash before an original archive was created.
A real disk database built from the unchanged schema1..42 migrations upgrades
through normal startup46, backfills labeled legacy text, retains a new original,
deletes its legacy set, and reopens with both retained objects byte-exact and
SQLite integrity_check=ok. This is normal close/reopen, not a power-loss test.
HTTP fixtures use simplified mutation middleware: this does not prove production
idempotency replay or machine-auth acceptance. HTTP fixtures now exercise the
registered migration46 through ordinary database startup. Servers and databases close on teardown.
Syntax and whitespace checks pass.

## Remaining acceptance

- Reconcile registered Merger-reserved migration46 with foundation43/hierarchy44
  before integration; preserve unknown upload-claim WIP45.
- Verify the combined43/44/45/46 upgrade, real idempotency and permissions,
  power-loss durability and independent source review before staging/release.
- Review unindexed/incomplete upload cancellation separately; finalized indexed
  dataset coverage does not prove retention of every arbitrary CSV on storage.
- Finish valid Emlid auto-detection, 50-foot candidates, large map/photo marking,
  CRS/vertical units and actual NodeODX delivery separately.

This is a durable handoff, not a general Engineering Hub task record.
