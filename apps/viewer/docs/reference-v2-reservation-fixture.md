# Synthetic v2 source reservation — disabled candidate

`referenceV2ReservationFixture.js` is an isolated SQLite experiment, not a
production migration or route. `SCOPE` is a fixture label, not a security gate;
`liveReserve` always rejects. It has no current authority, independent trust
root, current epoch, provenance, real filesystem/source pin, process fence,
retention guarantee, physical durability proof, or cleanup authorization. Its
receipt shape and signing domain are synthetic and intentionally do not match
the proposed Processing wire contract. Never use a real Viewer database, data,
production signing key or live service with this fixture.

An explicitly provisioned synthetic quota and managed source BLOB live in the
same fixture SQLite database. `reserve` validates caller-provided synthetic IDs,
re-hashes the exact stored BLOB, checks source revision and size, and in one
`BEGIN IMMEDIATE` transaction consumes the requested budget, stores the exact
canonical intent and a deterministic receipt body, and pins the source row.
Triggers hold source update, delete and replace and protect reservation identity;
there is no automatic release. Identical replay returns the same body without a
second debit; an ID/intent conflict or quota shortfall fails. These SQLite
triggers do not fence old binaries, other filesystems, external processes, a
malicious database owner, or restored snapshots.

Before exact reservation replay and before storing or replaying a signature,
the fixture rechecks the stored synthetic BLOB against its intent hash, size
and revision. This is a point-in-time database check under cooperative fixture
assumptions; it does not prevent a noncooperating writer changing data after
the check. Signer input is copied, and the result is checked against the
unmodified committed receipt bytes.

`signCommitted` signs the committed body outside the transaction with an
injected synthetic signer, verifies that signature against the public key
recorded at reservation, then atomically records it. An interrupted or failed
signature leaves a committed outbox entry and charge for exact recovery. Once
signed, exact replay returns stored receipt/signature. Tests use only ephemeral
test keys. No signature is an authorization, current key/epoch proof, receipt
of production source custody, or permission to delete data.

The focused suite tests conflict and quota, source row replacement/update,
reopen, wrong synthetic signer, an injected post-sign interruption, owned-child
kills after commit and after signing before outbox storage, and two concurrent
worker connections contending for one quota. The tested SQLite BLOB is not a
managed production archive. Still required: exact agreed signed wire and
independent intent verification, real key/registry and monotonic anchor,
old-writer/stream fencing, filesystem source protection, safe schema migration
and rollout/rollback, actual target storage sync/power loss, complete cross-store
crash/reconciliation and authenticated receipt delivery. Do not activate until
jointly qualified with Processing and tested on isolated staging.
