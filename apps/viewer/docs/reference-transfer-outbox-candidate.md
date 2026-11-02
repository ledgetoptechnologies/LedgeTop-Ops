# Reference transfer outbox candidate

Migration 57 adds a dormant durable record for the exact Viewer-to-Processing
source grant. The record binds the attempt, job generation, environment,
reservation identity, input manifest, broker grant ID, broker identity digest,
and SHA-256 of the serialized grant. It stores the reservation nonce as a hash
and never stores the bearer token or raw request body. The broker now returns
the digest of its exact stored identity so a future adapter can compare this
record with a grant reconstructed after restart.

The repository module validates the grant against the job and reservation,
prepares an immutable outbox row, records send attempts by dispatch lease
generation, records uncertain outcomes, binds the exact acknowledgment and
keeps those rows retained. A changed grant or acknowledgment conflicts. A
retry must pass the existing journal's current active-task/project/lease check
and present the same serialized grant identity and payload digest. A stale
sender cannot record an acknowledgment under a newer lease.

This is a persistence building block, not an enabled transfer adapter. The
public dispatch lane remains hard-off. A process failure that leaves a row in
`sending` also leaves the journal claim held; there is no startup fence,
lease-recovery authority, broker-to-outbox adapter, or automatic replay loop.
Those are explicit remaining requirements before the outbox can be activated.

Synthetic tests cover immutable identity, changed-grant rejection, exact ACK
binding, replay after an explicitly released/advanced claim, held state when
the sender dies in `sending`, and non-persistence of the bearer. They do not
prove actual Viewer process restart on the NAS, key provisioning, a real
Processing ACK, or production custody.
