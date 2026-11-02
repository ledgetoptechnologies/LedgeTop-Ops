# Reference transfer outbox candidate

Migration 57 adds a dormant durable record for the exact Viewer-to-Processing
source grant. The record binds the attempt, job generation, environment,
reservation identity, input manifest, broker grant ID, broker identity digest,
and SHA-256 of the serialized grant. It stores the reservation nonce as a hash
and never stores the bearer token or raw request body. Migration 58 tightens
the state trigger with a forward-only upgrade; migration 57's identity remains
unchanged. Migration 59 stores the canonical grant digest in a separate
immutable, no-delete binding. Processing returns that digest on both grant POST
and authenticated status so the Viewer can distinguish two grants that share
the same reservation fields but contain different tokens.

The ACK object has changed shape while the inactive route is still named
reference-v1. The candidate Viewer and Processing versions therefore require a
coordinated lockstep release; mixed old/new candidates reject each other's ACK.
Existing v57/v58 outbox rows have no v59 binding and fail closed if reused.

The repository module derives object IDs from the immutable journaled request,
validates the grant against the job and reservation, prepares an immutable
outbox row, records a single send claim, and records uncertain outcomes. It
cannot resend from `sending` or `uncertain`; a newer dispatch lease is not proof
that an earlier HTTP sender stopped. An acknowledgment is accepted only while
the original sender claim is active and only from the unmodified response
object returned by the same provider instance that sent this grant, with the
job, environment and canonical grant digest bound. A status response is parsed
and carries the digest needed for exact reconciliation.
`claimExpiredTransferReconciliation` permits a new journal generation to take
over only an expired attempt that has a `sending` or `uncertain` outbox row.
`reconcileAcknowledged` then records an immutable receipt and transitions the
row only when the new provider instance returns an authenticated ACK matching
the stored canonical grant digest and reservation binding. A missing or
mismatched ACK leaves the row uncertain. This process-local response evidence
is created only for the built-in HTTPS transport; the durable reconciliation
record retains only its digests and recovery generation. A caller-created or
mutated DTO cannot mark the row acknowledged.

Migration 61 gives an expired-transfer recovery lease a separate durable
purpose record tied to one attempt, generation, owner, and outbox row. Normal
dispatch, job binding, grant preparation, sending, and ordinary ACK methods
reject that claim. Reconciliation requires that same purpose record and exact
outbox ID. The v61 migration also requires the purpose record before inserting
the reconciliation receipt. This prevents a recovery lease from being reused
as a general dispatch lease by repository APIs.

The provider identity still needs a production authority binding. The current
primitive accepts a provider instance supplied by its caller and verifies that
the ACK came from its built-in authenticated HTTPS status path; it does not yet
prove that the endpoint belongs to the immutable provider assignment or a
durable receiver lineage. A future adapter must bind the endpoint, receiver
identity/epoch, and rollback/restore authority before this is deployable.

This is a persistence building block, not an enabled transfer adapter. The
public dispatch lane remains hard-off. There is no startup scanner or runtime
calling this narrow reconciliation primitive, broker-to-outbox adapter, or
automatic replay loop. A missing status ACK remains held; exact POST replay
requires the stable broker recovery key and the paired Processing idempotency
semantics and is not wired here. Those are explicit remaining requirements
before the outbox can be activated.

Synthetic tests cover immutable identity, changed-grant rejection, journal-
derived object binding, refusal to retry an uncertain sender, expired-lease
recovery only for pending sends, exact authenticated ACK reconciliation after
restart, mismatch retention, recovery-claim isolation, forward-only migrations
through v61, and non-
persistence of the bearer. They do not prove actual Viewer process restart on
the NAS, key provisioning, automatic replay, a deployed Processing ACK, or
production custody.
