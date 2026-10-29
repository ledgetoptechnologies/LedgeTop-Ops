# Indexed source binding experiment: NO-GO

This source-only draft cannot issue a custody receipt or authorize a provider.
Migration 49 is provisional; its `viewer_source_binding_unavailable` trigger
unconditionally rejects admission. Tests remove that trigger **only in synthetic
databases** to exercise the proposed indexed metadata and repository guards.
Never drop it on a real database or deploy this branch as an issuer.

The draft binds an active pending attempt to its current managed finalized
dataset, project, logical root/path, recorded dataset manifest and exact indexed
file IDs, relative names, sizes and hashes. A prepared binding is immutable and
blocks selected actual repository lifecycle paths. The same-root indexed-path
comparison conservatively holds ancestor/descendant paths and unknown syntax;
it does not establish filesystem identity or prove bytes exist or match.

The code is incomplete and must remain disabled until all of these are solved:

* A trusted real source custody authority and exact authenticated caller and
  environment binding; no caller-supplied ID, metadata or callback is proof.
* Attested physical domains, mount/inode identity and cross-root alias coverage;
  the indexed root/path comparison is not physical path or writer fencing.
* Every import, source cleanup, payload-linked dataset operation, storage
  mutation and recovery effect must participate in one durable overlap fence.
  Failed/cancelled/awaiting-derivatives indexed operations are conservatively
  held, but succeeded operations may still have cleanup, and payload-only or
  cross-root effects are not fully enumerated.
* `applyStorageMutation` checks a binding before effects, but this draft does
  not hold an interprocess filesystem fence across check and move/remove.
  Preexisting, unjournaled, old-version and external writers must be drained
  or fenced; a DB transaction, timeout, AbortSignal or positive status is not
  proof that their file descriptors or remote effects have stopped.
* Permanent raw CSV retention and any release must follow an independently
  authenticated, verified full closure; there is no release implementation.
* Migration 49 is a provisional experiment. Version 48 and later ledger
  identities, cancellation work, triggers and actual deployment ledger must be
  reconciled before any application. Unknown version identities fail closed.
  There is no compatibility or upgrade claim for other prototype schemas.
* Actual Linux filesystem and multiprocess tests on an owner-coordinated target
  are required, including both race orders, process death, path replacement,
  symlink/mount aliasing, external writers, cleanup and crash recovery.

The tests prove only selected repository and SQLite behavior on synthetic data;
they do not prove physical retention, complete lifecycle coverage, or release
readiness. No route or worker calls the draft preparation function.
