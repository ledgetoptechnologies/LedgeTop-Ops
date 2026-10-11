# Paired staging runtime release: October 11

This is an execution checkpoint, not production approval. Earlier runbooks retain
historical states; use live provider readback rather than their old migration counts.

## Candidate and already-applied schemas

- Application revision: `bcc8ad69f4850483f158a2efac68777ea907c9af`.
- Exact CI: `38135245512` is terminal failed: nine jobs succeeded, Operations
  failed. Do not upload/promote this candidate. Three stale migration-order
  expectations have focused passing corrections; portal acceptance is being
  rerun with the complete current canonical schemas. A new exact revision and
  successful CI run are required, followed by newly sealed release artifacts.
- Client ledger: 149; Ops ledger: 195; foreign-key violations: zero.
- Both schema applies were reconciled. Do not rerun migrations as a runtime
  deployment step.

## Active staging baseline

| Application | Version | Deployment | Bindings | Schedules |
| --- | --- | --- | --- | --- |
| Client | `44cf2ef9-2c55-4bfd-b448-630d36c09dba` | `844fb003-0efc-4189-bed9-a5e6b1254700` | 114 | 2 |
| Ops | `818ef6b8-942a-4fcc-932d-628237c31001` | `0cfcd40f-3d57-4c82-9c7c-4f69d673e5f8` | 144 | 8 |

Provider snapshots were sampled twice with read-only ledger/FK checks. Recapture
at action time. Preserve all bindings, plaintext variables, secret identities,
compatibility settings, schedules and the existing Ops container association.
Do not replace current configuration with an older static example.

## Intended runtime delta

- Client delivery-authority RPC adds only disposition and cancellation methods.
- Ops adds only `ClientPortalNativeFinancialReader.readFinancialDocuments` to the
  expected named-handler list. This does not enable its default-off feature.
- Candidate checks require these exact handler deltas; missing, extra or reordered
  handlers are rejected rather than accepting arbitrary provider output.
- Delivery dispatch retains a retryable apply failure when status has no matching
  receipt. An absent receipt is not a terminal rejection. Existing authorization,
  exact receipt validation, terminal rejection and eight-attempt limits remain.

## Local correction evidence

- Portal resource and billing lifecycle suites passed against the complete
  canonical Ops 0195 / Client 0230 schemas: two files, two tests. The resource
  test exercises selected-file bytes, tenant exclusion, revocation and unchanged
  public shares; it is not a live browser or production acceptance result.
- Delivery retry/recovery and real-D1 authority suites: two files, ten tests pass.
- Corrected inbound migration fixtures: six tests pass; recovery migration suite:
  fifteen tests pass. Historical ordering and current-chain checks are retained.
- Operations type-check passes. Repository contract step: 208 pass, three Windows
  symlink skips. Paired release adapters: 58 pass, one Windows symlink skip.
- New exact-head CI remains required. Old BCC-sealed artifacts are invalid for
  the corrected candidate and must not be used.

## Execution order

1. Require exact-head CI success, unchanged tracked source, sealed configs,
   bundles and complete asset trees, plus fresh source/peer readback.
2. Upload each candidate as an inactive version. Record the exact sealed release
   identity before attempting the mutation; reconcile an uncertain outcome,
   never blindly retry it.
3. Read back candidate bindings, runtime and named handlers; require unchanged
   active source, peer, ledgers, schedules and Ops container application.
4. Promote Client first, Ops last. Require the exact sole 100% candidate and
   paired carrier readback after each promotion.
5. Prove real PA acknowledgements for create/update, exact replay and stale/conflict
   rejection; close temporary synthetic authority windows.
6. Prove genuine recipient login, selected-file bytes, exclusion and revocation;
   exercise financial visibility and outage/recovery requirements separately.

No full deployment, settings PATCH, trigger deployment or container rollout is
part of this runtime release. Existing public links, production PA and production
client access must remain unchanged. The production owner checkpoint follows
successful live sync and portal acceptance; local tests alone do not satisfy it.
