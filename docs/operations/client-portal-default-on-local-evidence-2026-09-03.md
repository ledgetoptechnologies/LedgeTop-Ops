# Default-on portal provisioning: local evidence, September 3, 2026

This is local implementation evidence, **not a deployment or live acceptance
record**. The existing production links and Viewer were not changed by these
checks. The broader client-platform goal remains incomplete.

Project Alpha's reviewed backfill is checkpointed locally as `17e20c55` on
`codex/portal-default-on`, including the prior contact-assignment/activation
changes. A fresh fetch confirmed it contains current `origin/main`; it has not
been pushed. Operations' prepared base is `fcb7d61`, also current with main at
the time of this check. Uncommitted receiver changes are not a release identity.

A subsequent fetch on September 3 reconfirmed Operations has no divergence from
`origin/main` at `fcb7d61`. Project Alpha is six prepared commits ahead and zero
behind `origin/main` at `11fca5ff` (contract scope persistence/rendering). Its
working tree is clean. The six commits include activation readiness, contact
assignment schema-v4 and transition/fixture fixes, and historical provisioning;
the release is not solely the final backfill commit.

## Contract

- Project Alpha creates one workspace per organization or standalone client,
  with organization contacts represented as scoped principals.
- Historical roots are reconciled automatically after producer preflight;
  no per-client pilot enrollment or invitation email is required.
- Explicit person/root revocations survive backfill and sign-in. Eligibility
  alone does not grant any delivery folder.
- Each Project Alpha instance retains its own source-qualified authority.

## Concrete defects addressed

1. Primary native enrollment joined the secondary-source authority registry.
   Primary signed workspaces therefore could not enroll even when their
   projections existed. Enrollment, listing and native contexts now accept a
   read-only proof of the primary keys reserved by authenticated ingress.
2. Existing producers had mutation hooks but no automatic historical-root
   backfill. Project Alpha migration `0083` adds durable per-root completion
   and bounded retry state; cron processes 25 roots per run. Standalone
   entitlements now use the supported `client` scope.
3. Legacy bootstrap projections could outlive the underlying account root or
   membership. Client migration `0195` and read guards invalidate stale legacy
   authority without changing signed successor generations or public links.

## Terminal local results

Operations focused tests:

| Suite | Passed |
| --- | ---: |
| Primary legacy project management | 3 |
| Share recipient source isolation | 26 |
| Delivery notification source isolation | 19 |
| Project Alpha delivery intents | 22 |
| Delivery intent source runtime | 24 |
| Portal delivery notification batches | 29 |
| Client Hub workspace resolution | 12 |
| Project management routing, desktop/mobile browser | 12 |

The primary-native Client gate passed 11 tests using signed ingress through
first-login enrollment, listing and native-resource access, including missing
or ambiguous email, missing/unreserved keys, tombstones and key rotation.
The authority suite passed 21 tests. Client and Operations typechecks and
production builds passed. Builds retain the existing large-chunk warning.

The frozen legacy lifecycle suite passed 13 tests, including role-change
invalidation, signed-successor controls, public-token preservation and atomic
rollback. Aligned eligibility tests passed 8, secondary workspace tests passed
9, and cross-repository delivery tests passed 2. Client typecheck passed again
after those final changes.

Project Alpha's latest focused portal workflow gate passed 140 tests with
1,204 assertions. The full suite before the final binding-recovery addition
passed 758 tests with 6,146 assertions and 91 environment skips. All 83 migration
files passed the repository validator; this is not proof of executing `0083`
against MySQL.

The exact final Project Alpha commit `17e20c55` subsequently passed its complete
suite: 759 tests, 6,166 assertions, 90 environment skips, exit 0. The disposable
network-disabled container used PHP 8.5.10 and PHPUnit 10.5.63 with a git archive
and a copied existing vendor tree. Five PHP 8.5 deprecations were reported
(triggered by 17 tests); no source or production files changed. This supersedes
the earlier pre-final full-suite count. A prior symlinked-vendor harness attempt
was invalid because Composer resolved classes outside the copied tree.

A subsequent network-isolated, RAM-only MySQL 8.4 test executed `0083`, reran it
on empty and populated state, and preserved all three fixture rows. Reactivation
reset only the selected profile, case-distinct root IDs remained distinct, and
lock-first reads observed the committed disabled profile under REPEATABLE READ.
The disposable container was removed afterward; production was not accessed.
Source-layout invariants also passed all 11 tests.
The rollout-manifest and joined-runner contract tests passed all 6 tests after
updating the pinned boundaries to Client `0195`, Operations `0052`, and Alpha
`0083`; both deny-management switches are now included in the dormant-gate test.
The joined operational-memory/copy-forward regression passed 1/1 after its
fixture was aligned with the required Operations `0052` schema boundary.
The J2 joined metadata gate passed 1/1 in 36.47 seconds against all current
Client migrations. Signed contact/service snapshots and their tombstones did
not create memberships, authenticated delivery grants, service requests, or
notification rows while those consumer capabilities were disabled. This is
metadata-isolation evidence, not proof of enabled first-login provisioning.
The combined source-layout and rollout-manifest checks subsequently passed
15/15, including the pinned wire fixtures, public namespace/configuration, and
repository-owned deployment wrappers.

`packages/shared` and `packages/ui` remain restored to HEAD. No direct Viewer
changes are included.

## Still required before live acceptance

The corrected Linux Client full gate completed with 989 of 990 tests passing.
`client-feedback-target.test.ts` failed to establish its initial native target
for the newly-active-deny insertion race. Earlier cases correctly invalidated
the workspace, directory, and legacy folder projection via `0195`, while setup
restored only memberships/entitlements. Restoring those three fixture records
made the full feedback file pass 25/25 on Linux in 14.37 seconds. Production
authorization was unchanged; a complete Client rerun was required afterward.
That corrected, frozen Client rerun has now completed successfully on Linux:
990/990 Vitest tests and 9/9 deployment-preflight tests, exit 0. The runtime
candidate is checkpointed locally as `137b286`; only evidence documentation
changed after its frozen test snapshot. Nothing has been pushed or deployed.
The native-resource full file subsequently passed 38/38 in 580.46 seconds.
Operations' Linux gate passed all 1,857 executed tests, but one further file
could not collect because the isolated archive omitted its `apps/ops-sync`
source dependency. That packaging error still requires a corrected complete
gate; 1,857 passing tests alone is not a full-suite pass.
With the sync service included, the previously uncollected ordering file passed
2/2. A subsequent all-app harness attempt stopped before tests because it tried
`npm ci` for the thumbnail renderer, which has no package lock. The corrected
full-gate harness retains all application source but installs only the required
lockfile-owned Client, Operations, and ops-sync dependency trees. Neither
harness failure is counted as an application pass or failure.

The final corrected frozen Operations gate subsequently passed all 1,859 tests
across 180 files, exit 0, with structured report `success=true` and zero failed
or pending tests. Final Client covered 84 files and passed 990/990, plus 9/9
preflight tests. All disposable test containers and source archives were removed;
only local result reports remain. Project Alpha's exact-commit frontend tests
also passed 29/29 on Node 24.20.0. These are local results, not live acceptance.

The new explicit release-profile helper, actual preflight runner with injected
secret names, rollout tests, and source-layout checks passed 31/31 together.
The checked-in profile remains `receiver-only`; no Worker flags changed. The
alternative profile validates coordinated eligibility/deny flags and retains
no-email and unrelated-capability guards. It does not prove remote readiness.

September 3 remote-ledger attempt: the configured Wrangler login reached the
Client D1 API, but the migration-list request was rejected with Cloudflare
authorization code `7403`. No migration was applied and no production data or
flags were changed. Current remote schema readiness remains unverified; do not
reuse the earlier September 2 ledger observation as proof of today's state.

The checked-in Client and Operations `deploy` scripts build and deploy Workers;
neither applies remote D1 migrations. Their `db:migrate:remote` scripts are
separate operations. A successful push/build therefore does not prove that
Client `0195` or Operations `0052` exists remotely. Verify the remote ledgers
and recovery baseline, apply outstanding migrations in the ordered release
window, and verify them before activating the new receiver behavior. The
repository workflows inspected here do not establish the external Cloudflare
build configuration; that configuration must also be checked before pushing.

- Reconcile both prepared branches against current main without overwriting
  concurrent Project Alpha onboarding/document changes; run Linux CI gates.
- Deploy the coordinated migrations and code, then activate the four automatic
  eligibility/deny-management flags together only after receiver readiness.
- Observe historical roots reaching the receiver, test a new client and an
  existing client, and verify individual/root revocation on both portal hosts.
- Recheck old public links and record actual live versions, flags, migration
  state and rollback evidence in the production evidence record.

The full phased acceptance matrix remains in
[the rollout manifest](client-portal-rollout-manifest.md).
