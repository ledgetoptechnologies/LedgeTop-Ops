# Viewer processing queue handoff: synthetic integration map

Status: **proposal only**. No endpoint, deployment, reservation, NAS action,
storage guarantee, or client-data test is provided by this document. Branch
observations below are draft code, not claims about the active production build.

## Existing boundaries

* On main, `processingApi.js` exposes staff-authorized `POST /api/v1/tasks`
  and `POST /api/v1/tasks/:id/attempts`. `processingRepository.js` owns
  `createAttempt` and `deferSubmitAdmission`; an attempt being queued or
  deferred does not prove that its bytes are held or space is reserved.
* Draft #417 (`9846fcbc`) sketches Viewer source database holds; #418
  (`0baeff3e`) adds `sourceSpoolCopyCandidate.js` and
  `sourceCopyOutboxCandidate.js`. The latter prepares a hold, logical capacity
  record and outbox together, but `claim` and `complete` deliberately fail
  closed because independent writer fencing and verification are unavailable.
  Its logical reservation, sample seal and filesystem checks do not establish
  exclusive physical custody or actual reserved space.
* Draft #409 (`7b8e9271`) contains disabled reference dispatch, broker and
  acceptance candidates. `ReferenceAppJournal.claimNext` in
  `referenceAppDispatch.js` claims a candidate attempt; the broker's
  `mintGrant` requires a reservation input; `referenceAcceptance.js` persists
  accepted records and an ACK outbox. These are not an enabled end-to-end
  protocol and their existing v1 shapes must not be mistaken for the proposed
  Processing spool-v2 or Reference-v2 acceptance formats.
* Draft #419 (`7e1dd43b`) adds an unmounted strict metadata decoder. It is not
  a schema validator or a transport/authentication implementation. Draft #406
  (`b489c4bf`) concerns workspace/hierarchy UI; its grouping metadata does not
  itself grant client access.

## Next bounded integration slice

Build a **synthetic-only adapter rehearsal**, in a separate feature branch,
using disposable fixture storage and an injected, explicitly fake transport.
Keep existing production route registration, worker startup and provider
selection unchanged. No real bearer, service identity or customer file is used.

1. Start from a finalized synthetic dataset and an existing queued attempt.
   Record an immutable attempt/generation/manifest binding and a copy intent in
   one durable transaction, with a stable operation ID. Replays with identical
   bytes return the existing intent; changed bindings conflict. An incomplete
   or unknown outcome stays held, never silently requeues as a new attempt.
2. At the just-in-time admission boundary, request a scoped reservation and
   verified custody from injected storage and coordinator interfaces. The
   fixture must distinguish `unavailable`, `rejected`, `committed`, and
   `outcome_unknown`; it must not manufacture successful physical capacity,
   identity, fencing or custody from a SQLite row. No grant or copy starts
   until independently verifiable reservation and writer-fence evidence exists.
   In the rehearsal these are explicitly fake receipts, never usable outside
   the test.
3. Persist the exact authorized transfer/grant payload and operation ID before
   any mocked send; retry only those exact bytes. On timeout or crash, reconcile
   the peer's durable exact-operation record before retry. A changed receipt,
   generation, manifest, inventory, role or operation ID fails closed. Never
   reclaim a possibly active writer merely because a lease expired.
4. Exercise mocked worker result delivery to Viewer. The accepted-copy service
   must verify every required output's bytes and custody before it persists the
   Reference-v2 `PartialAcceptance` and ACK in its durable outbox. Coordinator
   acknowledgement and replay refer to the same canonical acceptance and
   ordered inventory. The existing v1 Viewer acceptance store is not evidence
   that this v2 step is implemented.
5. Keep source copies and result outputs held throughout this rehearsal.
   Accepted-copy ACK alone does not terminalize a job, free capacity, publish,
   or authorize cleanup. Future release requires separate authenticated,
   generation-bound spool-v2 authorization, executor fencing, a durable
   per-object journal, exact pre-expiry effects and ACK, and conservative
   reconciliation of unknown or partial outcomes. Original Viewer inputs and
   raw Emlid CSVs remain outside release scope.

The first implementation should expose only test helpers and injected
interfaces, not a configurable production switch. Prove restart after each
durable boundary, duplicate exact delivery, conflicting replay, unavailable
independent authorities, stale generation, expired grants, and failure before
and after each mocked effect. Include concurrent claim and partial ACK cases;
test bounded queue/backpressure rather than launching unbounded processes.

## Prerequisites before a real service

Agreement on exact roles, transport identities, endpoint/profile schemas and
replay ledgers is required across Viewer and Processing. A real storage owner
must independently implement and prove writer fencing, durable physical object
identity and a reservation covering input plus concurrent output/expansion.
The approved spool is a subfolder of the existing Viewer dataset: a parent
dataset snapshot is neither a subfolder-only pin nor a physical reservation.
Migration compatibility with the hierarchy/GCP work, real v1/v2 profile
separation, authenticated integration, staging failure recovery and operator
acceptance are additional release gates. TrueNAS administration remains with
the operator.
