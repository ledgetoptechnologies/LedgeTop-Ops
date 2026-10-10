# Project-v2 uncertain receipt recovery — review draft

Status: design only. No endpoint, migration, scope, grant or deployment is
enabled by this document. Production PA and existing public links are out of
scope. Local/staging implementation requires review of the authorization and
immutable-ledger transition described below.

## Current evidence

- Operations `project-alpha-project-v2-pending-dispatcher.ts` intentionally
  records uncertain responses as terminal evidence and prohibits redispatch.
- Operations `project-alpha-project-settlement-adapter.ts` likewise refuses
  uncertain/in-flight redispatch. A known-success replay is not lost-response
  recovery.
- PA candidate `7afb30cf156f69077eefe44886e22c1204e65924` stores
  `api_v2_project_command_receipts`, keyed by application, history epoch and
  command UUID. `api_v2_project_sync_write()` also checks command type,
  canonical request SHA-256 and external ID before returning a stored result.
  Its current public route inventory exposes command POSTs, project reads,
  inventory and binding status, not a command-receipt read endpoint.
- A focused source review of PA worktree
  `codex/api-v2-binding-generation-fence` at
  `08b21f34c8415f8923b32ed7e66e16660fbccf66` confirms exact command POST replay
  is idempotent: PA locks the current application identity and authorization
  generation, then scopes receipt lookup by application, history epoch and
  command ID. It returns the prior immutable result only when command type,
  typed request hash and external ID match; changed input conflicts. Receipt,
  resource mutation and generation advancement commit in the same transaction.
- These are source observations, not proof that the same revision is deployed
  or that a real uncertain command exists in staging. PA integration tests
  cover replay and rollback, but could not be rerun in this environment because
  `tests/bootstrap.php` was unreadable.
- The hashes are not interchangeable: Ops currently fingerprints the UTF-8
  canonical command JSON body; PA stores SHA-256 of its parsed command wrapped
  as `{type, command}` using its defined JSON encoding. Receipt lookup must
  name and validate these distinct hash domains explicitly. Do not compare
  PA's stored `request_sha256` directly with Ops' wire-body fingerprint or
  change existing historical fingerprints to make them match. Cross-language
  canonicalization fixtures, including Unicode/escaping and PA profile parsing,
  are required before choosing the receipt DTO/hash contract.

## Preferred recovery contract: exact idempotent command replay

- Do not add a PA receipt-read endpoint for initial recovery. Replay the exact
  original command POST with the same durable command ID and byte-identical
  canonical JSON body. PA serializes the original request and replay so an
  exact duplicate returns the same immutable receipt; if the first request
  never committed, the replay executes the command once.
- This requires Operations to have durably stored the exact accepted wire body
  before sending and to prove its hash, command type, UUID, source, application,
  source instance, history epoch and destination are unchanged. Never rebuild
  from current profile fields, create a new ID, change destination, or retry
  under a different project mapping.
- Exact replay may return a historical authorization generation. That result
  proves only that the command committed, not current authority or resource
  state. Before local activation, recheck current actor/route authority, live
  command proof, source/history fences, expected local version/hash and mapping;
  then read PA's current project and binding and require exact ID/revision/hash
  agreement. Changed or stale state stays unresolved for explicit review.
- The original native command proof is immutable and expires. If it is no
  longer live, recovery must stop; never revive or extend it implicitly. A
  future operator-initiated recovery authorization would need a distinct,
  immutable, short-lived ledger bound to the original command/body/destination,
  current actor/permission, source/application/history identity and current
  local version/mapping, with deny-aware revocation and single-use CAS. That
  ledger and its predicates require a separate security review before allowing
  recovery after proof expiry.
- A command-receipt GET may be considered later for diagnostics, but is not
  needed for safe retry and must be separately scoped/default-off if added.
  A timeout or missing receipt response never authorizes a different mutation.

## Proposed Operations recovery composition

### Implemented safety boundary

The candidate recovery path permits redispatch only for the same authenticated actor whose immutable command proof authorized the original request. A different manager is rejected before the outbox is reopened or any external Project Alpha request is sent. The current post-ack authorization is bound to that original proof, so manager-through-receipt recovery would require a separately reviewed forward-only ledger migration; this candidate deliberately fails closed instead.

An exact retry after activation first reads the durable recovery authorization and the complete command, success-receipt, acknowledgement, settlement, and activation chain. It returns the stored `activated` result with `replayed: true` only when the request fields, expected recovery event version, authenticated actor, and current authority still match. Changed input or actor conflicts; missing chain evidence is stale; revoked or drifted authority is rejected.

- Default-off and staging-only initially; manually invoked by an authenticated
  authorized operator. Preserve existing administrator, deny-aware scoped
  permission, same-person native admission/profile, CSRF/origin and current
  project-authority checks. Exact mounted route protections must be reviewed
  before implementation; this draft grants none.
- Select one original immutable command reservation explicitly. Re-read its
  canonical body/hash, UUID, type, source/application/history, destination,
  expected local version/hash and mapping state. No inferred matching, new
  command ID, changed body or different PA destination.
- Revalidate current authorization and every original request fence, then
  replay the exact original mutation POST. This is the same idempotent command,
  not a new mutation. Validate its acknowledgement against the durable request
  and current PA project/binding reads before settling.
- Preserve the original uncertain/terminal event. Add an audited, idempotent,
  CAS-fenced recovery event and validated receipt through a separately reviewed
  atomic D1 transition; do not rewrite history or relax existing triggers.
- Use a separate recovery-aware read-settlement and canonical activation
  entrypoint with independently reviewed trigger predicates consuming the new
  immutable recovery receipt. The normal chain cannot be reused unchanged:
  its acknowledgements require acknowledged events and its activation guards
  require leased/acknowledged outbox state. Leave the original outbox terminal,
  its outcome and all original events unchanged. Never manufacture a normal
  acknowledgement/success receipt or move terminal work back to leased or
  acknowledged. Require current authority and exact current-state checks.
  A stale/conflicting resource or revoked actor remains blocked for explicit
  review. A receipt alone must not activate a project, publish it or enroll a
  client.
- After revalidating current operator/route authority and the exact request
  fence, an exact recovery retry returns the same receipt/settlement/activation IDs
  and version. A changed recovery body or fence conflicts. If acknowledgement
  is lost after D1 commits, re-read exact durable recovery evidence rather than
  creating another recovery transition. Stored IDs are historical idempotency
  evidence, not authority for route access or another activation.

## Required proof before release

- Positive CREATE, UPDATE and BIND recovery in both timing cases: PA committed
  but its response was unavailable to Ops, and the original request did not
  commit. Each must converge to one PA resource and one immutable receipt.
- Stable command UUID and byte-identical body across attempts; exact current
  application/history/destination/scope fences; no alternate command and no
  second canonical activation.
- Unknown receipt, wrong hash/type/application/history/destination, stale local
  version, revoked/denied actor, and changed PA resource all fail closed.
- Replacement keys cannot cross application bindings or history epochs, and
  replay is denied if the active key lacks the matching command scope.
- PHP/JS hash fixtures cover strict field order, parser trimming/null versus
  empty-description normalization, BMP/astral Unicode, U+2028/U+2029, quotes,
  backslashes, slashes, controls and invalid Unicode rejection. Verify the PA
  typed-command hash from its parsed form and the Ops hash from durable wire
  bytes independently.
- Concurrent recovery and lost local acknowledgement converge on one audited
  receipt and one activation, with atomic rollback on every failed predicate.
- Public-link bytes and all financial/publication/client-access state remain
  unchanged; selected staging fixtures and rollback targets are recorded.
- Close the recovery route first, drain/reconcile its in-flight work, revoke
  temporary authority, restore default-off configuration and verify all
  rollback/ledger checks before requesting the production owner checkpoint.

## Review decisions still needed

- Exact PA receipt-read scope and whether original command scope is required.
- DTO and bounded lookup fields, including historical receipt versus live
  generation semantics and sanitized missing/conflict responses.
- Separate wire-body and PA typed-command hash fields with proven PHP/JS
  canonicalization parity; neither hash may be relabeled as the other.
- New Ops recovery event/receipt schema and predicates preserving immutable
  terminal history, atomic CAS, deny state and current-authority validation.
- Explicit policy for receipts that remain absent or resources changed later:
  recommendation is operator review, not automatic mutation retry.
