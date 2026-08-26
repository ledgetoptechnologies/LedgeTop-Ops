# Secondary Project Alpha snapshot recovery

Status: implemented and verified locally, August 26, 2026; not published.
This is not a deployment announcement. No producer has been enrolled or activated,
no production migration has run, and no client or staff access has changed.

## Purpose and authority

Registered secondary sources already support signed events and manual snapshots.
Recovery adds an independent periodic snapshot check for missed events. It uses
the same exact source destination, credentials, two-pass consistency validation,
projection ownership and revision fences. It never enables a pending source,
changes business visibility, or turns a business source into staff authority.

The primary retains its existing daily recovery. Secondary recovery requires
both an active registered primary and an active `business_data` source. Pending,
suspended and retired sources are skipped. Hidden-but-active business sources
remain eligible: staff visibility and ingestion are separate controls.

## Scheduling and failure behavior

- A separate hourly trigger runs at minute 17 UTC. It awaits only secondary
  recovery, with at most two sources processed sequentially. It does not start
  thumbnail, notification, Viewer, airspace, Access or primary synchronization.
- The scheduler claims durable ownership before resolving credentials. A missing
  secret, open circuit, busy source or failed network attempt therefore has
  durable accounting instead of being retried ahead of every other source.
- Successful recovery has a minimum 24-hour interval. Failures have bounded
  backoff. The next time shown in Administration means **not before**, not a
  guaranteed completion time. Backlog, failures and runtime limits can delay it.
- Duplicate/out-of-order ticks, overlapping invocations, and stale completion
  must not claim or finish a successor's attempt. Expired attempts are recovered
  through the same durable schedule.
- Source and primary revision/version, scheduler ownership and the individual
  attempt are checked in projection transactions. Changing either connection
  stops subsequent writes. Already committed chunks are not rolled back.

The recovery head describes the last owned scheduled attempt, not the health of
the current configuration. An attempt invalidated by a revision may record its
own failure and backoff if its token is still current; it cannot finish a newer
attempt or overwrite current integration health. Revising a connection does not
erase its recovery history or bypass its backoff. Manual synchronization remains
an explicit operator action with independent current-configuration validation.

The hourly capacity is at most 48 attempts per day for the registry's maximum
31 secondaries. That is sufficient capacity for one successful daily pass when
each source fits the limits, but **not an SLA** during retries or outages.

## Execution bounds

The implementation must bound the whole invocation as well as each source:
elapsed time, cumulative response bytes across both snapshot passes, and database
queries including transaction guards and cleanup. Oversized work must fail with
a stable diagnostic before projection writes rather than repeatedly rewriting
the beginning of the same snapshot or advancing incomplete fingerprints.

Current scheduled-only limits are six minutes and 16 MiB of cumulative response
bytes per source, 400 normal D1 statements plus a reserve up to 450 for cleanup,
and a thirteen-minute scheduler claim window. Normal work ends no later than
minute eleven of that window, reserving time for cleanup and finalization.
Cleanup checks its own sixty-second allowance before starting each new database
execution. An in-flight D1 call is still awaited and subject to the platform's
call limit; this is not a promise of instantaneous cancellation at minute thirteen.
Two attempts leave at least 100 D1 statements for scheduling,
credential/configuration resolution and finalization.
Batch members and transaction guards count as statements. The projection plan is
checked before reserving source IDs or writing business rows. Existing manual
and primary synchronization limits are unchanged.

A `project-alpha-recovery-query-budget` or `project-alpha-recovery-byte-budget`
error is an actionable capacity failure, not a successfully recovered source.
Large exports may require a future resumable snapshot pipeline. Do not claim
that this bounded invocation can recover every possible export size, or increase
the limits without reviewing total invocation and memory capacity.

Do not implement a whole-sync timeout with `Promise.race`: losing that race does
not cancel pending projection writes. Actual fetch/body deadlines and cooperative
database checkpoints stop new work; completion and cleanup retain their own
bounded allowance. If that allowance is exhausted, a remaining source projection
lease is left to expire; it is not reported as successfully released.

Current platform constraints are documented in [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/). The isolated
hourly schedule is intentional; changing its frequency also changes the Cron CPU
allowance. Review invocation-wide budgets before increasing capacity.

## Operator workflow

Administration → Configurations → Project Alpha connections shows the source's
ordinary sync health and separate scheduled recovery status. Eligibility is
displayed independently of historical success: a suspended source must not look
like it is still scheduled just because its last attempt succeeded.

Review the last attempt, last success, next eligible time and short error code.
Correct the registered source configuration or deployed credential reference
through the existing audited controls, then use **Sync now** when appropriate.
Manual sync uses the existing source projection lease and cannot overlap its
scheduled projection. Recovery does not bypass that lease to force progress.

Missing recovery schema is shown as unavailable; it is not a healthy or empty
queue. Connection inspection remains available during the additive schema
rollout, but scheduled execution fails closed. Unrelated database failures must
not be swallowed as a missing migration.

## Release and rollback

1. Verify the connector/source-provenance prerequisites, an up-to-date backup,
   and the target's paid Worker/D1 execution allowance. The free plan's smaller
   invocation limits do not support these budgets; this change does not upgrade
   an account or authorize a plan purchase.
2. Apply Operations migration `0038_project_alpha_snapshot_recovery.sql` after
   migrations through `0037`. It adds scheduling metadata, not source grants.
3. Deploy the matching Operations code and cron configuration together. No new
   binding or credential value is introduced by this increment.
4. Observe a due source through claim, completion/failure, backoff and the admin
   status read. Confirm primary authority and unrelated queues remain unchanged.

For a forward correction or rollback, pause/remove this recovery trigger before
replacing its runtime. Retain the source accounting and attempt history. Do not
delete registry entries or reset attempt ownership to force a retry. Connector
registry rollback restrictions continue to apply; see the
[registry runbook](project-alpha-connector-registry.md).

Attempt history is persistent operational audit data. This increment does not
silently delete it; a future retention policy needs its own explicit review.

## Verification

Local Operations verification on August 26, 2026:

- 88 focused backend tests across eight files passed: recovery (22), connector
  registry/sync (30), administrator routes/primary sync/ordering (31), and
  isolated recovery/directory cron dispatch (5). Repeated runs of the same tests
  are not counted twice.
- Populated migration, expired/concurrent claims, fair backoff, missing secrets,
  source/primary revision races, stale finalization, byte/query/time budgets,
  actual body cancellation and bounded cleanup are covered with synthetic data.
- All 40 Project Alpha connections browser cases passed on desktop/mobile.
  Widths 375, 640, 1280 and 3440 were exercised; 375- and 1280-pixel screenshots
  were also visually inspected. Tests cover permission gates, state changes,
  conflicts, unavailable status and honest paused/history presentation.
- Operations generated-type consistency, TypeScript check and production build
  passed. The existing large-client-chunk build warning remains.
- Shared event receiver compatibility passed across serial runs: 40 tests in
  the three unchanged files passed in the initial full run, and all 24 tests in
  the two adjusted integration suites passed in the final focused run. Its
  TypeScript check and Wrangler dry-run build also passed.

The first event-receiver run was not green: two real-D1 cases exceeded the
runner's default five-second test timeout and two following cases encountered
their unfinished projection leases. The cases passed in approximately 6.2 and
6.6 seconds when allowed to finish. Only those two integration suites now have
a thirty-second test timeout; the explicit sixty-second snapshot case and all
application deadlines/assertions are unchanged. An intermediate diagnostic run
also saw one unreproduced `fetch failed` response in a completion-fence case;
the final checked-in-settings run passed that case and all 24 tests. No retry or
error suppression was added to application code. Revisit the local RPC seam if
that transport symptom recurs; do not classify it as a demonstrated production
defect or a proven permanent infrastructure fix.

These are scoped local gates, not a whole-monorepo pass or production acceptance.
No production migration, connector activation, message or deployment was performed.
