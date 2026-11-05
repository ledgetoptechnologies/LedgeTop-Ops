# Viewer source release paired qualification

Viewer `3426fa69af62f1ab52888f4e95229c8aca0840b9` was paired with Processing
`7b33720f76604e02d1977a5bb91e2c5adf94cf1a`. The integrated local Linux run passed
**178/178 Processing tests in 177.992 seconds**, followed by **26/26 focused
Viewer tests in 842.677 milliseconds**, with no skips. One task-owned Docker
runner used one CPU, 2 GiB, read-only source mounts and no external network.
Its container and scratch volume were verified absent afterward.

The paired case uses real Viewer SQLite repositories, signed snapshots and
outboxes, the actual Python HTTPS API, the licensed ImageSharp 3.2.0 conversion
artifact, and real temporary filesystem retirement. The ODM engine response is
synthetic; the source-mount barrier is a controlled fixture, not live NAS proof.

The full case checks source/GCP upload, lost acknowledgements, accepted result
copy, required derivative conversion and publication before release. A dropped
release POST response is reconciled by a new Node process using the identical
durable authorization. Files remain at 23h55m; 288 ordinary five-minute injected
monotonic checkpoints exercise the backend's 24-hour minimum without changing
journal age directly. Eligible source/derived copies are physically removed;
the nonempty permanent GCP closure and all Viewer model/original bytes survive.

A real `ProcessingRepository.createAttempt` rerun supersedes the original
published attempt before retirement. Cleanup remains bound to the original
attempt, model/version, derivative receipt and exact output inventory. A Node
process exits 42 after the terminal receipt is committed but before retiring its
snapshot hold. Ordinary bounded background reconciliation in another process
finds and repairs that exact interrupted handoff. The terminal receipt remains
unchanged on replay.

The integration fixes include:

- Reading result hashes and identities from the actual durable outbox/binding,
  rather than fields absent from production repository DTOs.
- Verifying the original signed snapshot, selected inputs and retained completion
  receipts before held-to-accepted transition; accepted snapshots remain guarded.
- Retiring the matching snapshot only after a validated terminal receipt is
  durable, including recovery after process death and after a normal rerun.
- Reusing a persisted readiness proof while waiting, with exact fresh physical
  verification at authorization and terminal handoff. Status polling does not
  repeatedly hash large output trees throughout the 24-hour wait.
- Thirty-second failure spacing, five-minute policy status polling and fair
  retry rotation, including refused/corrupt state without reparsing it to record
  retry timing.

The feature remains disabled by default. This is not package publication,
installed activation, live engine execution, NAS durability, genuine TreeDar
readiness or browser/UI acceptance. Staging's existing service remains inactive
and its mutable `dev` image is absent; a blind restart is not a qualified release.
