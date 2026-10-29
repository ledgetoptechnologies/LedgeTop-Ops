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
  held. Admission also holds unresolved retained-import cleanup globally,
  catalog source-cleanup and adoption-intent markers even after success, malformed catalog payloads,
  and unresolved or overlapping payload-linked catalog attempts. The catalog
  scan fails closed above 10,000 rows. These checks are conservative metadata
  checks, not a complete enumeration of payload-only or cross-root effects.
  While any binding exists, current repository methods suppress all import-cleanup
  claims and filesystem callbacks and catalog cleanup and adoption recovery listing and clearing,
  including unrelated jobs; this global stall is not a production design.
  Current catalog adoption-recovery and import-cleanup jobs acquire durable
  claims in the
  same SQLite transaction domain as draft binding admission, without holding a
  database lock over filesystem work. An interrupted effect remains in-flight
  and blocks all bindings and retries; no timeout or automatic clearing proves
  it stopped. Only a returned synchronous callback records completion, which
  is not a durable filesystem receipt: adoption recovery renames/removes
  without file and directory fsync, so power-loss durability and replay must be
  separately qualified before using completion as evidence. This is one
  participating effects, not an authority over other cleanup paths. One import
  claim covers the whole job, rather than creating a row for every file. A
  completed claim is retained per job; no retirement exists. New claim creation
  pauses at `SOURCE_EFFECT_CLAIM_LIMIT` (default 10000, maximum 1000000), and
  the limit must agree across all API and worker processes. This configurable
  cap does not establish a shared policy or a safe cleanup/recovery procedure;
  query cost and responsiveness at large limits have not been qualified. An
  unresolved import effect prevents its lease from being reclaimed even after
  expiry; interrupted work needs a future independently verified recovery
  procedure and does not automatically clear. The admin-only diagnostics view
  lists active or unresolved effects without deciding whether a writer stopped;
  no operator clearance action or closure authority exists. Failed and legitimate no-delete outcomes also
  leave this global hold. Successful worker settlement checks that the job was
  completed (that transition itself requires an unexpired lease), then matches
  the original claim identity; settlement itself does not check lease expiry.
  Other cleanup paths, old
  and already-running writers remain unfenced, and physical aliases are unknown.
  A catalog cleanup fetched before binding can still run asynchronously; old
  workers and other paths including upload cleanup do not honor these guards.
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
