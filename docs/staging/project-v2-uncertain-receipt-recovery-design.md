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
- These are source observations, not proof that the same revision is deployed
  or that a real uncertain command exists in staging.
- The hashes are not interchangeable: Ops currently fingerprints the UTF-8
  canonical command JSON body; PA stores SHA-256 of its parsed command wrapped
  as `{type, command}` using its defined JSON encoding. Receipt lookup must
  name and validate these distinct hash domains explicitly. Do not compare
  PA's stored `request_sha256` directly with Ops' wire-body fingerprint or
  change existing historical fingerprints to make them match. Cross-language
  canonicalization fixtures, including Unicode/escaping and PA profile parsing,
  are required before choosing the receipt DTO/hash contract.

## Proposed generic PA read contract

- Add a separately default-off, scoped receipt-read capability. Use generic
  labels and documentation; no Ledge Top names or hard-coded instance IDs.
- A bounded GET such as `/api/v2/projects/commands/{commandId}/receipt` accepts
  the existing source/application/history fences plus expected command type,
  canonical request hash and external ID through a reviewed bounded contract.
  Final header/query names are not decided here.
- Require a currently valid, bound, scoped key and current application
  identity. Receipt-read authority must not implicitly grant command writes,
  billing, user management or client data access. Review whether the matching
  command scope is also required; do not silently reuse broad `full` access.
- Derive the application primary key from the authenticated, non-revoked key
  binding and the current epoch/source from the history singleton. Supplied
  identity headers are exact-match fences, never caller-selected lookup
  coordinates. Query only `(derived application_pk, current history_epoch,
  command_id)`. A replacement key can recover only within that same application
  and current epoch; it cannot cross applications or read an old epoch after
  history rotation.
- Read only the receipt belonging to that application and history epoch;
  validate the exact UUID, type, hash and external ID. Do not expose another
  application's receipt or permit lookup by name/email.
- Return a strict, bounded, `no-store` DTO containing command identity/hash,
  original committed result revision/projection hash/authorization generation,
  source/application/history identity and a fresh request correlation ID.
  Do not return tokens, asset URLs, unrelated documents or private profiles.
- A stored receipt is historical evidence of a committed command, not current
  permission or current project state. Revoked credentials/authority still
  deny access. Recovery must separately verify current authorization and read
  the live resource before local activation.
- Missing receipt, timeout, identity mismatch or ambiguous state remains
  unresolved. In particular, a `404` does not prove that a concurrent or delayed
  original POST cannot commit and must never authorize an automatic resend.

## Proposed Operations recovery composition

- Default-off and staging-only initially; manually invoked by an authenticated
  authorized operator. Preserve existing administrator, deny-aware scoped
  permission, same-person native admission/profile, CSRF/origin and current
  project-authority checks. Exact mounted route protections must be reviewed
  before implementation; this draft grants none.
- Select one original immutable command reservation explicitly. Re-read its
  canonical body/hash, UUID, type, source/application/history, destination,
  expected local version/hash and mapping state. No inferred matching, new
  command ID, changed body or different PA destination.
- Fetch and validate only the matching trusted PA receipt. Do not call a
  mutation POST during recovery.
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

- Positive CREATE, UPDATE and BIND recovery, with the original PA command
  committed but its response deliberately unavailable to Ops.
- Exactly one PA mutation per command; recovery performs receipt/resource
  reads only. Stable command UUID/body hash and no second canonical activation.
- Unknown receipt, wrong hash/type/application/history/destination, stale local
  version, revoked/denied actor, and changed PA resource all fail closed.
- Replacement keys cannot cross application bindings or history epochs.
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
