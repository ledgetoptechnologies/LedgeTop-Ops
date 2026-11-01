# Catalog adoption recovery: operator investigation and hold

Status: **investigation procedure, not a production claim-release or automated
recovery procedure.** The current candidate deliberately holds normal
single-candidate restoration as well as uncertain interrupted recovery. It has
not been deployed. A held claim may need operator attention indefinitely; there
is currently no qualified command or UI action that safely clears it. Do not
enable the test helper or treat this document as authorization to delete data.

## Collect a case record

1. Record the Viewer build and database/schema version, operation ID, status,
   durable adoption-intent and in-flight effect-claim IDs, and when the last
   known effect began. Restrict access to logs and paths; do not put credentials,
   bearer links, or client data in shared handoffs.
2. Identify the exact source root/path and the expected managed destination
   and `.incomplete` candidate from the journal. Record configured mount
   identities and possible aliases. Read-only inventory should record whether
   each path exists, whether it is a directory or symlink, object counts and
   sizes, and the stored fingerprint and filesystem identities. Keep the
   original journal unchanged. Do not open or copy private source contents into
   a shared record.
3. Preserve every existing source, destination and incomplete tree. Confirm a
   restorable backup or storage snapshot using the owner's normal process;
   snapshot existence alone is not evidence that an old writer has stopped.
   Do not rename, overwrite, purge, retry the effect, clear a claim, or change
   permissions merely to make the warning disappear.

## Establish the hold boundary

An operator with control of the deployment must identify **all** Viewer API,
worker, maintenance and older-version executors that could touch the roots,
their child processes, and any external NAS clients or other storage writers.
Use the deployment owner's documented stop and verification process to prevent
new work and establish quiescence across every host. A lease deadline, a missing
heartbeat, one stopped container, or a PID lookup alone does not prove the old
executor and its descendants cannot act. If quiescence or mount/alias identity
cannot be established, retain the claim and escalate with the case record.

Current source fingerprinting can help compare content but is not a complete,
independently trusted manifest: it omits empty directories and is not a
versioned cross-runtime representation. Pre-adoption device/inode identity can
help assess a same-device rename; it does not establish a cross-device copy's
identity. A matching hash, timestamp or filename does not authorize cleanup.
Use the Viewer diagnostic only in an isolated synthetic environment; it is not
currently connected to the production case or qualified as evidence.

| Observed state | Required disposition |
| --- | --- |
| Original and one or more candidates present | Hold all trees. Do not assume they are interchangeable or delete a copy. |
| Complete and incomplete candidates both present | Hold both, even if one appears newer or has the same size. |
| Exactly one candidate, original absent | Hold. Identity/content and exclusive-writer evidence plus an atomic no-replace move on the actual mount are still required. |
| Original only, no candidate | Hold the journal: a previous move may have completed, but the current records do not prove which tree is present. |
| No paths, inaccessible paths, mismatched identity, uncertain previous outcome | Hold and escalate; do not mark the effect complete. |

## Required release design before operations resume

The owner must approve and test a separate recovery procedure that provides a
durable, audited decision tied to the exact operation, claim, mount identities,
complete object evidence, and all retained copies. It must establish that
legacy executors are quiescent, prevent new conflicting writers, and verify
atomic no-replace support and its error behavior on the actual filesystem.
On filesystems with ambiguous remote failure semantics, a syscall error is not
proof that no move occurred. Reconcile the resulting filesystem and journal
after every interruption before any further effect. Only a separately authorized
transaction may settle the exact claim after the verified effect and retained
data obligations are satisfied. Timeouts, restarts and a test-image probe are
not release authority. This procedure intentionally provides no claim-clear or
destructive commands until that mechanism is implemented and reviewed.
