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

Thirty-six focused and existing GCP tests pass with reused dependencies, one test at a time and a
128 MiB Node heap. Coverage includes tiny local HTTP upload/import/delete/download,
authentication, mutation-key requirements, exact BOM/CRLF bytes, immutable rows,
legacy fidelity, trash/purge and refusal on source drift or busy checkpoints.
Reconciliation also recovers an older-version intent journal whose tree already
moved to trash before an original archive was created.
A real disk database built from the unchanged schema1..42 migrations upgrades
through normal startup46, backfills labeled legacy text, retains a new original,
deletes its legacy set, and reopens with both retained objects byte-exact and
SQLite integrity_check=ok. This is normal close/reopen, not a power-loss test.
The focused route fixture uses simplified mutation middleware. A separate test
mounts the real processing API, staff sessions and idempotency middleware: exact
binary retries replay the original response, changed bytes or filename conflict,
read-only staff cannot upload, and revoked staff cannot replay or download.
GCP routes accept staff sessions, not machine HMAC authentication. Fixtures exercise the
registered migration46 through ordinary database startup. Servers and databases close on teardown.
Syntax and whitespace checks pass.

## Remaining acceptance

- Reconcile registered Merger-reserved migration46 with foundation43/hierarchy44
  before integration; preserve unknown upload-claim WIP45.
- Verify the combined43/44/45/46 upgrade, installed staff-session/retry behavior,
  power-loss durability and independent source review before staging/release.
- Review unindexed/incomplete upload cancellation separately; finalized indexed
  dataset coverage does not prove retention of every arbitrary CSV on storage.
- Finish valid Emlid auto-detection, 50-foot candidates, large map/photo marking,
  CRS/vertical units and actual NodeODX delivery separately.

This is a durable handoff, not a general Engineering Hub task record.

## Cadens source refresh — November 16, 2026

The existing PR #594 branch now includes main `6d474071`; no unrelated private
Viewer stack was imported. The new Hub task is
`6de89142-43ee-41b7-b9e1-1238a202f930` (Codex owner, Claude reviewer).

An additional regression reproduced replacement of retained rows with SQLite
`INSERT OR REPLACE` while recursive triggers were disabled. A BEFORE INSERT
guard now rejects both primary-ID and source-identity collisions. Exact retries
resolve and verify the existing bytes before insertion under the owning write
transaction, preserving the original row and lineage. Four cases cover both
collision forms with recursive triggers on and off.

Forty focused source checks pass, including the disk upgrade/reopen, staff
authorization/replay, retention lifecycle and marking contracts. The Vite build
passes with the branch's exact locked dependencies. Full suite/browser/native
validation and Claude's exact-head review remain pending; this is not staging
acceptance. Migration 46 remains candidate source, not a claimed installed
upgrade. Incomplete-upload retention and the later coordinate contract remain
separate integration work. No real dataset, processing job or production resource
was changed by this refresh.
