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
and carries the digest needed for future exact reconciliation, but the outbox
does not transition an ambiguous row to acknowledged after restart. This process-local evidence
is created only for the built-in HTTPS transport; it does not survive restart
and is not a durable receiver attestation. A caller-created or mutated DTO
cannot mark the row acknowledged.

This is a persistence building block, not an enabled transfer adapter. The
public dispatch lane remains hard-off. A process failure that leaves a row in
`sending` also leaves the journal claim held; there is no startup fence,
lease-recovery authority, broker-to-outbox adapter, or automatic replay loop.
Those are explicit remaining requirements before the outbox can be activated.

Synthetic tests cover immutable identity, changed-grant rejection, journal-
derived object binding, refusal to retry an uncertain sender, held state when
the sender dies in `sending`, forward-only migration from v57, and non-
persistence of the bearer. They do not prove actual Viewer process restart on
the NAS, key provisioning, durable ACK reconciliation after restart, a real
Processing ACK, or production custody.
