# Source custody migration assessment

Status: design only, disabled; no migration number reserved, no deployment or
storage authority verified. Existing migrations through version 56 are present
in this checkout. Allocation and actual deployed ledger must be checked with
the other owners immediately before any future migration.

## Current constraint

The protected v50 attempt journal and v53 source binding reject admission
unconditionally. The protected migration verifier checks exact definitions and
rejects unknown triggers and indexes on protected tables. The current synthetic
flow removes guards and installs experimental triggers in a disposable database;
normal `openDatabase` correctly refuses that database. An already-running older
worker does not necessarily rerun the startup verifier. Neither the verifier
nor an SQLite trigger fences direct or external writers.

Changing old migration SQL, spoofing a fixture namespace under the same table
names, restoring a guard after unguarded writes, or weakening verification
would not establish a safe production integration.

## Candidate forward path

1. Establish the separate, authenticated storage authority and immutable
   source barrier first. Bind its current authority epoch, verified volume and
   immutable snapshot identity, manifest hash, durable hold, expiry/renewal
   and release policy to the exact dataset and attempt. The barrier must also
   prevent deletion or replacement of the retained view throughout transfer.
   Verify source hashes against that view outside the SQLite write transaction.
2. Ship a compatibility release before the new migration. It must understand
   the chosen later migration identity and fail closed on disabled, uncertain,
   expired or unsupported custody states. Audit all active workers and direct
   writers, revoke or otherwise fence old access at the storage authority, and
   prove the barrier remains enforced across process restarts, network and
   authority changes. Merely restarting a service or checking process names is
   not sufficient evidence.
3. Allocate a new forward migration after checking the deployed ledger and
   parallel work. It should introduce new versioned custody, association,
   retained-source and outbox records, plus explicitly defined transitions,
   uniqueness and immutable identity checks. Preserve the old disabled
   reference guards and all raw CSV retention guarantees. Add the new exact
   schema identity to the protected migration verifier in the same release.
   The initial state must remain disabled; migration alone grants no authority.
   A real integration must have a narrowly defined, authenticated admission
   path for the new records; a database flag or caller-supplied observation
   alone cannot prove storage custody, quota, or issuer identity.
4. Revalidate the barrier and current authority without holding a write lock
   for the full file scan. In a short serializable transaction, revalidate the
   indexed manifest, current attempt, retained excluded sources, validated
   authority evidence and idempotency identity; atomically commit custody and
   association outbox state. Sign after commit and durably store or replay the
   exact signed bytes only after revalidating the relevant authority. Define
   crash and uncertain-effect holds before implementing any release path.
5. Qualify capacity for each physical volume: authenticated current limits,
   shared-device and alias accounting, inodes, durable concurrent reservations,
   headroom, expiry and renewal. A local free-space estimate or caller-supplied
   cross-filesystem plan is not a cross-system capacity reservation. Preserve
   the existing 10,000-object and metadata bounds until all parties explicitly
   agree on an interoperable change.

## Rollback and qualification

Once a new migration is applied, an older binary that does not recognize it is
expected to refuse startup. Rollback must therefore use a previously tested
compatibility build that recognizes the schema but keeps custody disabled;
do not delete migration records, drop holds, silently re-enable old workers,
or roll back storage permissions to restore service. Backups and restore tests
must preserve active snapshot holds, raw CSV files, association outbox state,
authority epochs and uncertain claims. Define operator recovery for lost holds
and unavailable authority before enabling writes. Where an externally managed
barrier cannot be proved, keep reservations and source deletion held.

Qualification needs real deployed schema and supported storage evidence,
cross-process writer and rollback tests, crash at each commit/authority edge,
concurrent lifecycle/import/GCP paths, retained raw CSV, a representative
10,000-photo dataset and actual per-volume capacity. Synthetic file counts or
local signatures do not prove 50 GiB NAS performance, retention, or authority.
No TrueNAS action, production enablement, or migration is authorized by this
assessment.

## Unallocated compatibility schema preview and review

`reference-custody-compatibility-schema.sql` is a runnable, unallocated design
preview only. Its four separately named candidate tables describe intent,
selected and retained-excluded objects, authority evidence and an outbox. All
inserts are blocked and updates/deletes are blocked. The committed/signed
outbox shape anticipates signing after commit, but its compatibility trigger
does not permit that transition. It cannot issue an association, retain real
files or represent a qualified production migration. It is not included in
`MIGRATIONS`, and its objects are not protected by the production verifier.
The preview test compares exact SQLite schema catalog entries against the
preview, detects a changed trigger, reopens through normal startup while
existing admission gates remain in place, and verifies that an unknown
forward migration makes the current build refuse startup. This comparison is
test-only, not an implementation of a production schema identity guard.

The compatibility preview test additionally executes the actual
`openDatabase`/protected-verifier functions with an in-memory test-only
substitution for a synthetic version 999 and this exact schema. The simulated
schema-aware build accepts that version, the unmodified current verifier refuses
it, and the simulated aware verifier refuses an added trigger. Version 999 is a
test sentinel, not an allocation; this is not an actual compatibility build,
does not prove nonempty-record rollback, and does not fence already-running
processes.

Ownership review on November 1, 2026 found open PR #371 at head
`79622f895ae31dfc295c95940fdc338f73277179`; its diff introduces protected
Viewer identities 41, 42 and 44–47 and changes the startup verifier. It must
be reconciled with the current branch's later identities before allocation.
Open PR #404 covers Viewer upgrade/rollback rehearsal. This check does not
establish ownership of unseen branches or the deployed ledger. The existing
Claude Viewer link is recorded, but the message-bus tool was unavailable in
this session; no new confirmation or current delivery is claimed.

An independent read-only review found the following blockers before any
successor could admit records: enforce attempt/task/project/dataset identity;
match every indexed file's path, size and hash; seal an exact count and
canonical inventory digest including excluded raw CSV; prevent late additions
and replacement under `INSERT OR REPLACE`; validate path and integer bounds;
bind environment, protocol, job, generation, issuer, key, signature and
canonical body to the same current attempt and authority. The preview's
unconditional deny does not solve those future transition requirements.
Fresh, authenticated source-retention evidence, current epoch and revocation,
all writer fences, crash recovery and safe release remain separate blockers.

Once ownership and a version are agreed, a compatibility build must recognize
the exact chosen version and complete object/trigger/index definitions before
it is used as a rollback artifact. The current verifier does not recognize an
unknown new version, and already-running older workers are not stopped by a
startup refusal. A later admission-capable successor would need a reviewed
version-aware verifier for any changed schema definitions and a safe rollback
build that understands all nonempty records. No old migration identity may be
silently rewritten or reused, and no version is reserved by this document.
