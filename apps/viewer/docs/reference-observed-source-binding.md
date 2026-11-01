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
