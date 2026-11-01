# Disabled Viewer v2 issuer inspection

`referenceV2IssuerInspection.js` is an offline fixture inspection, not an
authenticated issuer, production reservation, receipt, route, storage pin, or
authorization. `issue()` always rejects. The scope label is not a security
gate, and fixture-supplied keys, expected body and clock are not an independent
trust registry, current epoch, or proof of coordinator authority. No real data
or production key should be used.

The inspection checks the provisional Processing v1 intent's closed canonical
ASCII representation, detached Ed25519 signature and experimental domain,
fixture key scope and time, exact caller-supplied expected intent, and dataset
binding/object rows. It recomputes the Viewer dataset manifest, checks every
indexed file against binding rows, reconstructs the current image-only
Processing submission from indexed roles and checks the selected paths, sizes,
digests and excluded IDs. Raw CSV IDs remain excluded in this fixture. The
dataset manifest and selected Processing manifest are distinct. Generated GCP
auxiliary input is deliberately unsupported until it has its own source binding.

This combines existing components in a test using actual SQLite binding rows
and synthetic filesystem files, but the binding has no physical writer fence:
the test removes the unconditional admission trigger in a disposable DB only.
Signature correctness is not authentication when registry/expectation/clock are
caller supplied. The result explicitly says both the coordinator-to-Viewer
attempt mapping and `claimBindingSha256` are **unverified**; a signed coordinator
attempt ID is not assumed to equal the Viewer attempt ID. No authoritative
mapping or claim lineage is inferred from similar IDs or names. The test also
rejects a validly signed, protocol-valid subset that tries to submit the raw
CSV in place of the image.

Before any real receipt or source reservation: establish independently trusted
issuer/key/audience/purpose, revocation and current epoch/clock; define a
durable, authoritative cross-system job/attempt/claim mapping; qualify source
root identity, immutable multi-file retention and all-writer/stream fencing;
reserve real byte/object quotas and implement transactional idempotency,
receipt outbox, crash/restore reconciliation, and signed wire vectors; define
acceptance and separately authorized release. The Processing source projection
at commit `5d8394b` is similarly disabled and uses supplied snapshots. A local
fixture match is not evidence any of those prerequisites is satisfied.
