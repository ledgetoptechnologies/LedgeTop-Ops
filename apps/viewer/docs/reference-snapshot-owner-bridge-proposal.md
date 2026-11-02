# Owner-operated snapshot bridge: qualification proposal

Status: unallocated design and local fixture only. It does not create or mount
snapshots, change permissions, establish a storage authority, or enable source
admission. No TrueNAS system was accessed for this proposal.

## What the checked-in deployment describes

The repository's `docker-compose.yml` describes one writable host bind for
`/mnt/Plugins/App_Data/Model-Viewer/Storage` at `/app/storage`, shared by the
Viewer API and worker running as `568:568`; the container root itself is
read-only. Datasets, the SQLite database, cache, outputs, imports and trash are
under that host bind. WebODM media is a separate read-only bind. These are
repository settings, not proof of the currently installed mounts, filesystem,
ACLs, snapshot support or available space. A snapshot of the whole bind may
also contain sensitive database and unrelated project data; it must never be
exposed as a client share or used as an unrestricted browser root.

## Candidate owner-operated sequence

1. Before any pilot, the storage owner inventories the installed API/worker
   versions, actual mount topology and aliases, service identities, writable
   shares, direct clients and maintenance processes. Establish the exact
   dataset scope and preserve original CSVs. Unknown writers, mounts or
   privileges hold admission; a stopped container or a process list alone is
   not proof that access cannot return.
2. The owner establishes a storage-enforced, read-only retained view, such as
   an immutable snapshot if the installed platform supports and qualifies it,
   with an independently durable hold against deletion and replacement.
   Verify the exact volume, retained-view and hold identities, authority epoch,
   access policy and mount topology; keep administrative and other writers
   from altering or replacing the retained view for the full reservation. The
   owner must retain control of privileged storage operations. A read-only bind
   alone does not prevent another host or administrator changing the source.
3. A separately authenticated authority supplies short-lived evidence bound
   to the storage identity, hold, project/dataset and indexed manifest. The
   verifier must bind a descriptor-root to that exact retained view, check
   authority key, purpose, epoch, expiry and revocation against independently
   current trusted state, and reject ambiguous or stale evidence. A signed
   statement alone is not proof that the claimed mount or hold is real.
4. Hash the retained view once outside the SQLite write lock, compare every
   indexed photo and retained excluded file including raw CSV, and revalidate
   the authority and immutable view immediately before a short atomic
   binding/outbox transaction. Use a bounded buffer; assess actual I/O time,
   disk/inode capacity and renewal needs on a representative 10,000-photo,
   approximately 50 GB set before any live admission.
5. Keep the hold and original CSV retention through crashes, retries,
   processing transfers, rollback and uncertain delivery. A separate reviewed,
   authenticated release protocol must prove transfer and retention conditions;
   failure, lost authority, mount change or an uncertain release must hold.
   No snapshot release may be inferred from a local callback or timeout.

## Local evidence contract experiment

`referenceSnapshotBridgeFixture.js` verifies a public test signature over a
canonical, short-lived owner-evidence shape and compares supplied snapshot
directory contents with the indexed manifest. Its tests use a normal copied
directory, a caller-supplied key and clock, and deliberately label storage
barrier and authority freshness unverified. It checks stale, revoked, changed
identity, bad signature and changed bytes; `issue()` always refuses. A copied
directory is not an immutable snapshot, its path is not authenticated to the
signed volume identity, and the test does not fence external changes. This is
not a storage service, deployable protocol or evidence of NAS capabilities.
Independent review also found that the supplied clock and key registry are
checked only before the synchronous scan: evidence may expire or be revoked
while 50 GB is being hashed. A real bridge must refresh trusted time, key,
authority epoch, revocation, hold and descriptor-to-view identity after the
scan and again at commit, including a renewal plan for long scans. The current
scan uses synchronous reads and would block a live Node event loop; it needs a
bounded owned worker or process, cancellation, cleanup and I/O qualification
before production. An offline supervisor fixture now performs its scan in one
owned child, pins the opened root descriptor, checks the caller-supplied device,
inode and mount ID before and after scanning, and asks for another signed
evidence packet afterward. One deadline and cancellation signal cover evidence
retrieval and the child; timeout/cancellation kills the owned child and waits
for exit, reporting its PID if termination cannot be confirmed. The callback
receives the signal but an evidence provider that ignores cancellation can
continue its own work. Tests verify child exit for ordinary cancellation and
timeout. The child closes its descriptor before the final evidence check, and
the expected root identity, registry and clock are caller-supplied: the result
does not bind the descriptor to the signed volume/snapshot/hold or establish a
real fence. Ancestor-path, privileged writer and replacement races remain.
Neither its registry nor its clock is independently trusted, and this process
fixture is not wired to admission, signing or production startup.

The separate compatibility rehearsal seeds nonempty synthetic rows before
fixture-only deny triggers and checks schema-aware reopen. It does not prove a
production migration or nonempty storage hold can be safely created, restored
or released. Version ownership and the actual installed migration ledger must
be verified before any migration is allocated.
