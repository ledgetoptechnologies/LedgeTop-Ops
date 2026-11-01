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
