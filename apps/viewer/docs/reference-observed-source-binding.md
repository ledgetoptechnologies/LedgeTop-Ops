# Disabled observed managed-source binding

`prepareObservedSourceBindingDraft` is an offline experiment using the existing
`viewer_source_bindings` / `viewer_source_binding_objects` schema and repository
lifecycle checks. It is not a production source pin, signed receipt, durable
filesystem snapshot, reservation quota, route or worker. The migration's
`viewer_source_binding_unavailable` trigger remains installed and the observed
path rejects both new admissions and replay while it exists. Tests remove it
only in a disposable synthetic database.

With the fixture guard removed, the experiment validates the existing active
attempt and managed finalized dataset, rejects known pending effects, reads the
exact indexed multi-file manifest, hashes every real file via the existing
Linux source snapshot acquirer, and commits the existing binding and object
rows in the repository transaction. Exact replay rechecks physical bytes and
indexed rows; changed bytes, identifiers or manifests fail. The test covers a
raw CSV and photo, attempted metadata lifecycle operations, process death while
hashing and immediately after commit, and replay after restart. No source file
is deleted. A stale legacy lifecycle test now recreates the stored mutation it
intends to exercise, matching the current API's authoritative DB lookup.

The caller chooses the managed root. A second root with identical files can
pass replay; this demonstrates content equality, not a stable physical source
identity. The acquirer returns an unfenced point-in-time observation. Hashing
inside a SQLite write transaction can lock writers for the whole scan, making
this unsuitable for normal large datasets and runtime activation. Neither the
database guards nor the pre-effect checks fence a filesystem move/deletion
already in flight, external/older writers, root aliases, direct storage helpers,
backup rollback or streams. An effect can pass a check before binding and act
after it. No authority, issuer, current epoch, signed wire, quota, source-copy
retention or release is implemented.

Before any real admission, require a trusted managed-root identity and alias
inventory; an atomic exclusion protocol for all queued, in-flight and retried
dataset/container storage mutations, adoption and import/catalog cleanup;
old-writer/stream fencing; durable byte and object quota and exact intent
replay; verified independent issuer/epoch/clock; durable source retention and
audited acceptance plus separately authorized cleanup. Reconcile crashes and
power loss on the actual storage system. Until then uncertainty holds and no
receipt or cleanup authorization may be inferred from these rows.

## Cooperative lifecycle exclusion experiment

`referenceLifecycleEffectFence.js` can install a separate claim table only in
an isolated fixture. `applyStorageMutation` accepts an explicitly injected
fixture fence; no runtime caller injects it and no migration installs the table.
In one immediate transaction a claim reloads the stored mutation and rejects
any existing binding or other in-flight lifecycle claim. The binding draft
checks the same claim table, and a reciprocal insert trigger rejects a binding
while an effect is in flight. This conservatively serializes all participating
lifecycle effects, including disjoint paths, because aliases are not attested.
The claim remains held around the filesystem operation and journal completion.
Only a cooperative callback reporting a durably completed journal settles it;
exceptions, process death and uncertainty hold indefinitely, including a crash
after the journal completes but before settlement. No timeout or lease permits
takeover. There is deliberately no automatic recovery or release. The tests use
real synthetic rename/delete effects, two SQLite connections, replacement
guards and killed owned child processes; they do not prove power-loss behavior.

This experiment is not installed, enabled, an OS lock, or a complete fence.
Uninstrumented lifecycle calls, catalog/import/adoption paths, uploads, direct
storage helpers, older binaries, other NAS clients and database owners remain
outside it. Its fixture callback and database are not trusted production
authority; a real design must also prevent early journal completion by another
executor, protect all relevant mutation identities and install a safe migration
and recovery protocol. Never infer receipt issuance or deletion authority.

`test/fixtures/viewer-processing-source-map-public.json` is an unsigned public
synthetic mapping for the two-file fixture. Its indexed dataset manifest and
selected Processing submission manifest have distinct hashes: only the image is
submitted and the raw CSV is retained/excluded. The accompanying test checks
object ID, filename, size and digest mappings; it does not prove physical
custody or authenticate a future multi-object receipt.
