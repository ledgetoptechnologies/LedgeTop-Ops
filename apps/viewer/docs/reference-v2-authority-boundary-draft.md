# V2 broker authority and recovery boundary — unapproved design

No issuer, key, signature algorithm, audience, proof encoding or deployment is
agreed. No code in this branch authenticates a request, detects rollback, proves
a stream stopped, grants custody, or exposes a route. This document specifies
conditions to negotiate, not an approved wire protocol. Reject all live v2
admissions and reconciliation until both services have qualified implementations.

* Admission must derive current holder and authority from independently verified
  credentials, not from the JSON binding. Verify exact environment, issuer, key,
  audience, operation scope, expiration/revocation and current coordinator
  authority epoch, job, immutable manifest, reservation and generation. The
  signed authorization and the canonical request must match exactly. Define
  key rotation, clock skew and the durable authority source before coding.
* Check current authority and atomically commit the request identity, delivery
  identity and entire byte/request charge against a shared durable ledger before
  streaming. Specify how the authoritative claim remains valid across this
  transaction and stream: a callback saying `true` or an expired local lease
  is not a fence against a stale worker. Prevent an older binary, separate ledger
  or restored snapshot from accepting traffic. Failed/ambiguous checks hold.
* Authenticated reconciliation is independently scoped to the current authorized
  original actor or a properly adopted recovery actor. A snapshot may say
  `recorded`; `authoritatively_absent` requires a verifiably live ledger epoch,
  identity, retention coverage and watermark spanning the exact admission window.
  Missing/pruned records, snapshot rollback, authority ambiguity or uncertain
  predecessor stream means `unknown`, never inferred absence or refunded budget.
  Counters and records must come from a consistent snapshot. Do not leak job or
  delivery existence to an unauthorized caller.
* Adoption must use a distinct, authority-authenticated, durable and auditable
  record bound to the immutable original request hash and predecessor claim,
  with a current actor and strictly increasing recovery generation. Prove the
  old process, its handles and in-flight stream are fenced before takeover.
  Specify proof issuer/audience/key/expiry/revocation and the atomic interaction
  between fence, claim, adoption and ledger. Stale credentials or generations
  cannot be revived. No automatic charge refund or new budget follows adoption.
* Before qualification, independently test competing real processes, stale
  generations/old binaries, authority revocation before commit and midstream,
  actual process kill at each pre/post-commit and stream boundary, idempotency,
  retention/prune/restore and ledger-epoch rollback, WAL/filesystem power-loss
  behavior on the real storage topology, and paired Processing/Viewer vectors.
  Network activation, schema migration and rollback need separate review.

The branch's SQLite fixture is intentionally not this ledger: its scope label,
caller-provided job budget and synthetic stop operation are not authentication
or fencing; it has no trusted epoch, retention coverage or adoption. A valid
canonical parser result is syntax evidence only.

## Processing proposal for joint review

Processing proposes the coordinator as sole claim/worker authorization issuer,
mutually authenticated service-to-service TLS, and a separately signed,
versioned and domain-separated grant for the Viewer audience and exact
operation/request/job/environment/manifest/reservation/generation, actor and
authority epoch. Ed25519 with explicit key IDs is a candidate only. Establish
key distribution, rotation, revocation, audience, expiration, clock behavior,
canonical bytes and deployed TLS termination/identity propagation before use;
mTLS and canonical JSON alone do not prove current authority.

Processing proposes Viewer-signed reconciliation evidence for the Processing
audience binding the immutable request, delivery, charge, ledger identity/epoch,
monotonic revision and complete retention/admission-window coverage. Observation
authorization is separate from admission. A signed statement still needs an
independently protected current epoch/anti-rollback anchor and demonstrable
retention and predecessor fencing; neither a signature nor a restored database
alone makes an absence authoritative. The meaning, origin and units of each
watermark and its proof are unresolved.

The proposed coordinator-side operation fence/pin must be durable before charge
and remain held across disconnect or crash until authenticated quiescence or
externally verified isolation. SQLite cannot atomically fence a remote coordinator
using a local callback. Specify paired durable states, who may release the pin,
the exact stream/worker/process boundary, authority renewal/revocation while a
stream runs, and recovery for a crash between every pair of operations. Expiry,
socket closure, a stale acknowledgment or a coordinator restart is not by itself
proof that bytes stopped. No indefinite-free-replay or charge reset follows a
lost response. A signed recovery adoption must be durable and bind the immutable
original request, current actor, monotonic recovery generation and independently
verified predecessor fence; old proofs cannot regain authority.

An independently protected monotonic anchor or explicitly reviewed offline
re-enrollment is needed when restoring a ledger or journal. Agree on behavior
when anchor access fails or history is pruned: return unknown/hold, never infer
absence. Full-object/chunk identity, signed response/reconciliation schemas,
hash domains, failure codes, key lifecycle and paired cross-language vectors are
still open. Do not deploy or activate from this proposal.
