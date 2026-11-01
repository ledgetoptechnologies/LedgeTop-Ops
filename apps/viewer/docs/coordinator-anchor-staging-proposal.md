# Coordinator as Viewer external checkpoint: isolated-test proposal

Status: unapproved design, no endpoint or infrastructure change. The Processing
coordinator on the cluster PC is a candidate separately provisioned checkpoint
for Viewer on the NAS. Its actual storage, restore coupling, credentials,
authority lifecycle and running topology have not been verified. All tests
below use isolated synthetic stores until the owners qualify that topology.

## Scope and prerequisites

If the coordinator checkpoint and its trusted identity survive independently,
it may detect rollback of the Viewer store alone. It does not protect against a
coordinated rollback of both systems, a compromised/cloned coordinator, rollback
of the coordinator checkpoint itself, loss/compromise of its trust keys, or a
replayed stale response without a fresh authenticated exchange. It is not an
independent authority against the coordinator's own compromise. Backups on a
different host are not automatically an independent monotonic anchor.

Before qualified use, independently provision scoped credentials and verified
service identities for both directions; define TLS termination, key custody,
rotation/revocation, protected durable state, membership/leader fencing, audit,
backup/restore and owner controls. Do not place test keys in production trust.
Verify that exactly one authoritative coordinator writer and checkpoint history
exists. An authenticated checkpoint proves neither process/stream quiescence nor
that a signed claim remains current. Separately enforce the coordinator operation
pin and predecessor fence; a local SQLite check or expired socket is not a fence.

## Candidate checkpoint semantics

Bind an anchor record to trust domain, deployment/environment, Viewer ledger ID,
anchor epoch, monotonic revision, exact state/transition digest, operation ID,
previous revision/digest and current authority/issuer identity. Specify the
canonical bytes, signature/transport, authorization, ledger retention semantics,
monotonic anchor implementation and response expiry before wire implementation.
An externally trusted current anchor epoch and revision—not one supplied by the
requester or recovered from the same backup—must authorize every comparison.
Within an epoch, a CAS accepts only the exact previous revision and digest and a
single next revision/digest. Exact operation-ID replay returns its immutable
result; a conflicting replay, same revision with different digest, stale epoch,
lower revision, missing history, uncertain anchor identity or unavailable
authority holds without serving bytes. Never automatically reset epoch, counters,
budget or retention watermark. Define explicit overflow and bounded retention.

An anchor comparison is not automatically authoritative absence. The authority
must separately attest a complete retained history covering the entire possible
admission interval, including how interval endpoints and watermark units are
derived, and an independently enforced predecessor/stream fence. Pruned history,
old binaries, unknown in-flight work, incomplete recovery, stale anchor, missing
proof, or unavailable authority returns unknown/hold. A separately signed Viewer
observation cannot itself establish that the coordinator's anchor is current.

## Paired commit and crash windows

No distributed SQLite transaction exists. Agree a durable, uniquely identified
operation intent before attempting anchor CAS, and preserve its exact expected
previous and proposed next digest. A proposed conservative ordering is: (1)
durably record local intent with no streaming permission; (2) coordinator
enforces the current authorized operation pin; (3) authenticate CAS and retain
the anchor's durable receipt; (4) commit the matching local ledger transition and
full delivery charge; (5) reverify the pin, current authority and exact anchor
receipt before allowing any stream. This is a design to test, not proof of
atomicity or a complete algorithm: simultaneous claims, old writers, coordinator
failure and authority revocation can invalidate naive rechecks. No byte streams
or ACK/cleanup may begin while transition identity or authority is uncertain.

If a CAS response is lost, query/replay its exact operation ID and binding against
the current trusted anchor; never issue a different CAS or assume failure. If the
anchor advanced but local commit did not, hold, retain intent and recover only
the exact anchored transition under current authority after verifying no old
writer or stream is active. If local state is ahead of the authenticated anchor,
differs at equal revision, or a restored copy cannot prove its history and
retention coverage, hold for independently reviewed recovery; never reset the
anchor or overwrite retained input/results. If the anchor is unavailable, expired,
revoked, not independently current or returns ambiguous state, fail closed.
No timeout, process exit or lost socket alone authorizes pin release or refund.

The joint team must choose exactly which durable ledger events advance the anchor,
how concurrent requests serialize with different operations and how evidence is
bound to the retained event journal. A checkpoint of an arbitrary aggregate
counter is insufficient to prove an individual delivery was never admitted.
Specify whether a receipt is per transition, batch or snapshot and how a complete
retained interval is proven. Prevent duplicate streaming despite replay and never
make a re-stream free merely because an earlier CAS/HTTP response was lost.

## Restore and independent tests

If the coordinator anchor may itself have rolled back or both stores were
restored together, the coordinator cannot certify its own freshness. Stop and
isolate all old writers and streams; retain and inventory exact ledger, receipts,
pin records, charges, input/output objects and backups. Use an independently
protected monotonic authority if actually available; otherwise require explicitly
owner-operated offline re-enrollment into a new epoch with reviewed reconciliation
of all nonempty work and a durable audit record. No automatic new epoch or blind
replay is permitted. Failure to prove a writer fence or reconcile unknown work
remains held. Production owner controls any actual infrastructure lifecycle.

Paired synthetic tests must use separate Viewer and coordinator stores and
credentials and cover: Viewer-only rollback; coordinator-only and coordinated
rollback; cloned coordinator; old writer still running; CAS races, exact replay
and conflicting operation ID; loss before/after intent, pin, CAS commit, receipt,
local commit and response; anchor ahead/local ahead/same-revision conflict;
unavailable anchor and invalid identity; key revocation and rotation; missing or
pruned retention interval; crashes while streaming, lost ACK and process fence;
and offline re-enrollment with nonempty charges and retained inputs. Verify both
stores and any independently protected anchor cannot be silently rolled back
together in the topology used. Separate local mocks and simulations are evidence
of logic only, not actual isolation, hardware durability or security.
