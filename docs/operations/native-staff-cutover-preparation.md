# Native staff cutover and dormant Sync preparation

This source work adds two separate source-only components: a read-only
qualification function for preparing an Ops Sync version while the native
control is absent or disabled, and an owner-authorized first-cutover D1 executor.
Neither component performs a production provider call or deploys code.

## Dormant Sync preparation

The active Sync version can predate migration 0225 and lack the native
reconciliation markers. A candidate Sync version can be prepared before the
Operations cutover only when its account, worker name, environment, database,
runtime version, settings, cron configuration, and binding metadata are exactly
the same as the active version. The compiler no longer trusts caller-supplied
claims about dormant behavior. It recomputes a closed SHA-256 manifest from the
candidate commit's Git objects for the Sync entrypoint/reconciler, PA ingress
dependencies, and the real D1/Miniflare behavior tests. The tests exercise the
actual scheduled reconciliation path with a missing schema and disabled
control, and PA ingress without staff reconciliation. The preparation step
runs those tests for the exact clean candidate commit, requires the complete
expected scenario set in Vitest's JSON report, performs the existing Wrangler
local dry-run build with a minimal OS-only environment, isolated home, and
Wrangler banner/update check disabled (so it does not perform its package
registry update request), and
requires the emitted `dist/index.js` SHA-256 to equal the expected candidate
module hash supplied for independent review. The runner hash must match the
exact committed Git blob. It rechecks HEAD, source/test cleanliness, and source
hashes after both runs. Any missing test, dirty candidate source, build failure,
or hash mismatch fails closed.

The qualification receipt is a digest-linked record, not a signature or
proof by itself. An operator must review the actual runner/test/build outputs
and the expected module hash. The preparation process does not verify an
uploaded or active immutable Worker version. After a separately authorized
deployment, a distinct provider readback must verify the uploaded version's
module hash and runtime/bindings against this preparation record.

The preparation receipt requires read-only before and after observations:

- The active staff cohort digest and exact active email set must remain equal.
- The managed Access group membership readback must remain byte-for-byte
  equivalent as a normalized sorted set. Historical or otherwise unrelated
  existing group members are preserved during preparation.
- The preparation receipt records digests and counts for both the current
  group and the planned desired group (active admitted primary logins plus
  currently verified alternate bindings). The cutover approval context binds
  this receipt to the exact D1 snapshot, plan, operator, command, and target;
  both group digests are persisted in the immutable execution result.
- The control must be missing or default-off, at generation zero, with no
  active reconciliation lease. This phase must never write Access membership.
- Binding metadata contains names, types, and resource identifiers only; secret
  values are not accepted or retained.

The qualification runner compares the reviewed expected candidate module hash
with a local Wrangler bundle and links it to the D1/Miniflare behavior report.
This is local source qualification, not live deployment or remote readback.
The compiler emits a bounded digest
receipt only. It does not change the final Operations or Sync readiness gate,
authorize a deployment, execute Worker code, or qualify remote observations
unless an independently reviewed read-only provider adapter supplies them.
Provider observations remain separate from source qualification.

## First cutover receipt

The cutover plan is a separate closed contract from the additive installer
plan. Its canonical JSON must be exactly:

```json
{"cohortSha256":"...","controlPlaneStaffIds":["..."],"kind":"operations-native-staff-cutover-v1"}
```

Binding evidence must be exactly:

```json
{"cohortSha256":"...","kind":"operations-native-staff-binding-review-v1","operatorStaffId":"...","operatorSubject":"..."}
```

The compiler hashes the full canonical current staff cohort. The executor
requires an external owner-signature verifier and exact, fresh source snapshot.
One atomic D1 batch rechecks the entire schema, migration ledger, legacy and
native identity/authority state, resource scope, control-plane candidates, and
disabled control row; then it inserts the one-time approval, changes only the
default-off control from disabled to enabled, and inserts the immutable
cutover-purpose approval receipt. No existing identity, owner, grant, history,
or receipt row is rewritten. Any stale check or statement failure rolls the
batch back.

The compiler/executor do not claim that Access has reconciled. Only the
existing Ops Sync reconciler may act after the signed enable transaction.
Final readiness still requires `applied_generation === generation`, a current
successful group readback, no lease or pending error, and the unchanged
production readiness observer. The synthetic tests demonstrate local
transaction behavior only; no owner key, live binding, approval, production
database, group, or deployment is exercised.

The external approval verifier must validate a distinct cutover-purpose
signature over the complete `cutoverApprovalContext`, including the exact
dormant preparation receipt and current/desired group digests. A non-null
trust object or the local synthetic verifier is not production authorization.
No production cutover is qualified until a closed wrapper and the distinct
issuer purpose are wired and independently reviewed.
