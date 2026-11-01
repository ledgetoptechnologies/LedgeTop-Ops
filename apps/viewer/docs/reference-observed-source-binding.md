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
fixture fence, or a fixture can register one for a single repository instance;
no runtime caller registers it and no migration installs the table.
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

### Audited entry points and current fixture coverage

| Entry point | Current state |
| --- | --- |
| `storageLifecycle.applyStorageMutation` for managed dataset/output trash, restore and purge | Participates only when an isolated fixture explicitly injects or registers a fence on that repository instance. Tests exercise interrupted rename/delete, project-container trash and reconciliation. API, container restore/purge and maintenance converge here, but have not all been exercised end to end under the fixture. |
| `importCleanup` and catalog adoption recovery | Existing `viewer_source_effect_claims` participate in reciprocal global exclusion with the lifecycle fixture; uncertain existing claims remain held. The fixture checks both claim orderings. Their own source bytes and external writers are not fenced. |
| Initial catalog adoption (`catalogImport.mapCatalogCandidate` / `StorageManager.adoptImport`) | Adopted-mode catalog calls participate only on a registered fixture repository, after their adoption intent is persisted. The fixture checks source, destination and fingerprint, holds the claim across the awaited operation, and commits any source-cleanup intent with settlement. Generic import and WebODM adoption remain uncovered; no physical fence is established. |
| Catalog source cleanup (`reconcileCatalogSourceCleanups` / `removeAdoptedSourceIfMatches`) | Participates only on a registered fixture repository. A durable claim spans the awaited callback; confirmed success settles the claim and clears the matching journal together. False, thrown or interrupted outcomes remain held. Tests exercise actual verified quarantine removal on synthetic files and callback interruption/restart. |
| WebODM staging cleanup, upload cleanup, photo/GCP writes, model/derivative cleanup | Not covered. Even nominally distinct roots can alias until independently attested. |
| Direct `StorageManager` legacy helpers, old binaries and NAS clients | Not covered. Registration is per object; updated unregistered lifecycle and catalog-cleanup entry points refuse to proceed if the fixture schema is present. |

The existing claim table and this fixture mutually reject new in-flight claims
under SQLite's write transaction. Fixture tests check both orderings and a
simultaneous cross-type claim race. No normal server, API or worker entry point
enables fixture registration.

The catalog cleanup fixture uses a separate durable claim table, mutual guards
with bindings and the other effect claims, and immutable operation payload
while the callback is running. A newly opened unregistered repository refuses
the covered cleanup and lifecycle entry points if fixture tables exist; this
only applies to updated code, not old binaries or direct storage calls. Fixture
installation is transactional and registration checks required object names,
but does not attest their SQL definitions or protect against a database owner.
The callback is trusted to await its work; no receipt or physical fencing is
implied. There is no automatic release after an uncertain outcome.

Initial catalog adoption has its own fixture claim. It binds the stored
operation, owner, source root/path/fingerprint, dataset ID and metadata to the
callback arguments; row guards hold the operation, dataset and indexed files
while the effect is awaited. A successful cross-device result journals the
matching source-cleanup identity atomically with claim settlement; exceptions,
lease loss and crashes leave an in-flight hold. Tests cover a real synthetic
same-device adoption, mismatched source, guarded metadata, journal creation and
a killed process after a synthetic rename. The callback, database, source
fingerprint and root remain untrusted in production; the test does not prove a
cross-device storage system or external-writer fence. Generic import, WebODM,
upload and other direct operations need separate coverage before activation.

## Existing adoption-recovery behavior

The default code already records a v53 catalog adoption-recovery effect before
calling the filesystem recovery callback. If that callback throws or its
process dies, the effect stays `in_flight`; a subsequent maintenance pass does
not automatically run it again, even after its lease or process has expired.
This is an existing availability limitation, not a new effect of fixture
registration. The original catalog tests expected an automatic retry and also
failed on the unchanged baseline. They now assert the existing held state and
preservation of bytes, while a separate real-filesystem test confirms recovery
that completes without interruption still restores the source.

An uncertain effect requires operator investigation: preserve both original
and destination data, identify the exact journal and filesystem identities,
and independently establish that all old executors and children have stopped
before any reviewed reconciliation or release. There is currently no qualified
automatic proof, claim-clear mechanism, or safe operator recovery procedure in
this experiment. Do not manually clear a claim, delete a source, or assume a
timeout establishes safety. A reviewed operational procedure and tested
reconciliation are required before rollout.

`test/fixtures/viewer-processing-source-map-public.json` is an unsigned public
synthetic mapping for the two-file fixture. Its indexed dataset manifest and
selected Processing submission manifest have distinct hashes: only the image is
submitted and the raw CSV is retained/excluded. The accompanying test checks
object ID, filename, size and digest mappings; it does not prove physical
custody or authenticate a future multi-object receipt.
