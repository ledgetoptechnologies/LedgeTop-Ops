# NAS-backed processing boundary: review-only seam

This proposal and its SQLite fixture do not expose an endpoint, access TrueNAS,
issue credentials or authorize a transfer, publication, acknowledgement or
cleanup. The current NodeODM/ClusterODM v1 worker remains unchanged. The
reference submission planner, broker candidates and result bridge are unmounted
or synthetic; a local callback, receipt-shaped record or SQLite lock does not
establish a NAS writer fence, authenticated issuer or immutable source custody.
TreeDar outer-v2 remains unagreed and inactive.

## Current boundary and missing service

Viewer's v1 worker resolves registered managed inputs, checks their recorded
size and SHA-256, then sends multipart input to NodeODM. It captures an archive
receipt for a completed attempt. Those operations do not by themselves provide
a separately authenticated NAS broker, remote just-in-time source streaming or
an independently issued NAS accepted-copy receipt. Processing reports the
coordinator provisioning receipt has broker/intake/services false and worker
configs absent. Those are reported observations, not an instruction to start a
service or a substitute for verifying the actual deployment.

The existing reference-v1 candidate has a closed ODM result/acceptance shape;
its unmounted bridge needs external current authority and an idempotent durable
ingest implementation. Its four-field legacy acknowledgement is compatible but
does not confirm a receipt ID/digest; the optional six-field response validates
the exact receipt ID and canonical digest. Neither is a signature or proof that
an independent NAS custody issuer exists. Preserve those v1 shapes, old jobs and
the normal v1 route. A future broker/receipt API must be explicitly versioned and
paired; the synthetic fixture's objects below are not a production wire format.

## Proposed operations and durable facts

1. **Source registration.** NAS-owned storage associates an opaque source object
   ID with its immutable file closure, actual byte length and SHA-256, managed
   root/object generation, acquisition identity and retention/pin. A source
   snapshot binds ordered object IDs, sizes and hashes to the Viewer attempt and
   input manifest. Recheck actual opened bytes and file identity under a real
   writer/purge fence; an ID, filename, copied hash or current SQLite row is not
   custody. Raw Emlid CSV files are permanent and must never be deleted, including
   on failure, cancellation, rollback, purge or cleanup. Worker-selected inputs
   must not silently include these raw source CSVs.
2. **Just-in-time grant and delivery.** Only after the coordinator has an exact
   authenticated current job/worker/reservation and destination capacity, request
   a scoped NAS read. The decision binds environment, issuer/audience, job,
   worker, original claim/generation, source manifest and object IDs/hash/size,
   reservation, stable operation and unique physical delivery ID, expiry and
   cumulative byte/request budgets. Persist the immutable intent and the full
   physical charge before sending bytes; count attempted bytes/requests even
   when acknowledgement is lost. A repeated delivery ID must not stream twice.
   A new physical attempt needs fresh authority, bounded budget and a proved
   predecessor stream/writer fence. A cooperative lease expiry is not that proof.
3. **Accepted result.** Before download/ingest, bind the exact job, attempt,
   immutable result manifest and producer custody evidence; reserve coexistence
   for original bytes, result transfer, expansion and retained accepted copy.
   Write to an exclusive owned temporary object, verify EOF, size, hash and
   required artifact closure, synchronize bytes and required directories, and
   durably commit an immutable accepted-copy record via an authorized NAS issuer.
   A result receipt binds receipt ID, issuer/audience and generation, accepted
   object IDs/size/hash, original result and source binding, producer receipt,
   validation and storage-copy identity. The existing v1 ODM `storageReceiptId`
   is a derived reference key, not proof of a separately authenticated NAS issuer.
   Future v2 TreeDar requires the distinct typed bundle contract, not a v1 role
   extension; see `reference-v2-acceptance-seam-proposal.md`.
4. **Exact acknowledgement and replay.** Persist a stable outbox operation ID
   and exact accepted-copy receipt/digest before sending. A receiver response
   must confirm the agreed exact operation/receipt and binding; replay the same
   immutable payload after a lost reply and treat ID reuse with changed bytes as
   conflict. Unknown delivery, pruned history, rollback, stale authority or
   ambiguous predecessor activity stays held. Define a protected epoch/anchor,
   issuer/key lifecycle and authenticated observation before interpreting absence.
5. **Separate cleanup.** Acknowledging an accepted copy does not automatically
   delete producer or source bytes. A separately authorized, durable cleanup
   intent must identify the exact producer object and prove accepted coverage,
   current retention/pins, physical writer/stream quiescence and any required
   consumer completion. Reconcile uncertain deletion by authoritative identity;
   never infer success from a missing path. Never delete the NAS managed accepted
   copy or permanent raw Emlid CSV as a side effect of result acknowledgement.

## Fixture contract and qualification

`test/helpers/reference-nas-seam-fixture.cjs` models only synthetic immutable
source/reservation/delivery/acceptance/ACK identities in a dedicated disposable
SQLite database. Its logical physical-charge counter is not a real byte meter;
its acceptance insert is not a NAS write receipt. Duplicate identities must have
the exact same canonical payload, different delivery IDs consume separate
synthetic budget, a changed source/hash or ACK fails, and cleanup always returns
`hold`, including after a matched synthetic ACK. The scope string is not a
security boundary: caller must supply a trusted dedicated fixture database.
No source file, network endpoint, credential, physical operation or deletion is
performed. The optional reopen test checks SQLite records across a connection
close, not power loss or concurrent legacy writers.

The fixture's `accept()` checks only that its reservation row exists. It does
not require a delivery, compare results to producer evidence, charge result
capacity, enforce one receipt per result, or prove artifact coverage. A matched
fixture ACK therefore proves replay binding only to that unverified row. The
fixture counter charges each new delivery ID its declared whole size; it does
not measure actual streamed bytes, request counts, physical retries, concurrency,
or capacity shared across reservations. These omissions are blockers for a real
implementation, not behavior to carry into production.

Before runtime adoption, jointly specify and verify the actual TrueNAS service
owner, deployment and identity, authenticated issuer/key rotation and revocation,
durable operation/receipt schemas and ACK/reconciliation protocol, external
single-writer/stream fences, capacity ledger and rollback/restore anchor, all
purge paths and permanent CSV policy, real filesystem/fsync semantics and safe
recovery. Test real competing writers, lease loss, process crashes at each
barrier, byte mutations, malformed/replayed tokens, interrupted transfer and
budget exhaustion, missing/pruned receipts, ACK loss and cleanup uncertainty.
Unknowns stay held. No configured route, production source ownership or rollout
is implied by a review fixture or this document.
