# Notification migration maintenance: local verification

September 6, 2026. This is local evidence, not production rollout approval or
completion of the overall Client Portal goal.

The default-false `CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE` control
pauses the notification-table HTTP writers and relevant scheduled dispatchers.
It does not replace the drain, checkpoint, and state-preservation sequence in
R8a of [the rollout manifest](client-portal-rollout-manifest.md).

## Corrections and verified coverage

- Installed Hono preserves `/api/client` in `c.req.path` for mounted routers.
  The maintenance and native-workspace path checks now recognize that exact
  mount as well as the standalone test router. Authentication, workspace
  resolution and tenant validation remain in place.
- Client route suite: 38 passed, including the mounted maintenance response.
- Native migrated-D1 history suite: 2 passed in 67.85 seconds. The actual
  `/api/client/notification-history` path returns only the authorized owner's
  record; foreign workspaces and revoked memberships remain denied. Maintenance
  prevents a mounted read mutation, preserves `read_at`, and does not replace
  foreign-identity denial with a successful mutation.
- Operations maintenance runtime suite: 4 passed. The actual scheduled handler
  skips request/folder notification writers while unrelated work continues.
  An authenticated staff mutation returns 503/Retry-After without writes;
  maintenance off reaches the route and non-admin access remains denied.
- Operations admin-route suite: 28 passed. The fixture now models all four
  atomic receipt/audit/outbox statements and does not fake a committed receipt
  before batch assertions complete. Notification recipient and receipt-derived
  deduplication are asserted.
- Both app type checks pass. Both generated-binding checks were run after adding
  the shared flag; later changes only affect test fixtures.
- Both production builds and maintenance-enabled Wrangler dry runs pass.
  Existing bundle-size/source-map warnings are not hidden.
- Full Operations Playwright run against maintenance checkout `a80d50e`:
  1,018 passed in 6.0 minutes, desktop and mobile Edge (session 83861, exit 0).
  This uses local fixtures, not production authority or live provisioning.
  Manual screenshot review found the organization-contact editor cramped inside
  its desktop grid card despite passing tests. Follow-up `9594939` uses the card's
  available width to stack controls; its type check, production build, and 36
  desktop/mobile contact tests passed. The 1280px screenshot was reviewed after
  the fix, and the new regression checks actual field widths and stacking.

Operations uses `--containers-rollout none` for this Worker-only release. No
container source, package manifest or lockfile differs from the inspected main
baseline, and no container image is rebuilt or replaced by that invocation.

## Still required

Current delivery-history increment (working tree following `c94e834`):
- Follow-up review reproduced a mixed-case cursor omission in run 22781:
  `z-delivery-cursor-a-00` was skipped across pages. The merge now uses binary
  ASCII ordering, matching SQL, rather than locale collation. Type check passed;
  post-fix database regression 92252 exited 0 (one passed, 16 filtered skips;
  34.57 seconds), returning every expected notice without duplicates.
  The first expanded run 50529
  ended at its 30-second timeout; the regression now allows 120 seconds for its
  52 real-D1 notices and retains bounded pagination assertions.
- Release blocker: selected legacy-v2 workspace notification PATCH currently
  checks authority before calling the legacy UPDATE, but the UPDATE lacks the
  selected workspace's current binding/capability predicate. Add an atomic
  mutation guard for delivery.view and request.create without changing native
  or unselected legacy behavior, then exercise revocation between check/write.
  A second route check alone does not close this race. The read-history review
  does not claim instantaneous revocation of already-authorized response bytes.
  Migrated-D1 regression 66733 reproduced both read and dismiss after a
  membership revocation injected at the repository write boundary: expected
  404, received 200 (two failed, 23 filtered skips, 53.30 seconds). Both
  non-revoked controls passed before the injected race. The partial dedicated
  guard was rejected and removed because it did not preserve all ordered
  identity-bridge, lineage and access-term semantics. Type checking after its
  removal passed. The shared capability-guard replacement is still in progress.
  Expanded baseline 24558 also reproduced capability revocation: all four
  membership/capability x read/dismiss cases returned 200 instead of 404,
  with their ordinary controls passing (105.83 seconds, 23 filtered skips).
  The separate identity-only SQL helper now passes its focused local D1 test
  (one test, 3.05 seconds, exit 0): optional-schema direct fallback, ordered
  invitation/eligibility bridge selection, bridge/member revocation, current
  email/issuer-subject blocks, expired blocks and global identity revocation.
  Client type checking also passes. This minimal relational fixture does not
  prove complete capability-guard integration; the migrated route regressions
  and independent candidate review remain required.
  Route run 34877 has now exited 0: seven notification tests passed, 21
  filtered skips, 225.33 seconds. It includes the four injected
  membership/capability read/dismiss races and ordinary request-read controls.
  The subsequent delivery-only proof correction removes the unrelated PA
  request-project mapping requirement; its own guard-level run remains pending.
  Unselected legacy delivery SQL was also retained and its existing real-D1
  revocation regression passed (one passed, 16 filtered skips, 11.88 seconds).
  Guard suite 79439 exited 1 (three passed, one failed): the legitimate delivery
  control was rejected because folder scope was incorrectly required in the
  organization/project lineage. The comparison now separately excludes the
  exact folder scope already validated by the binding join. Rerun 17346 exited
  0: all four guard tests passed (95.33 seconds), including that control and
  binding/capability/membership revocations. Client type checking passes after
  this correction. A fresh read-only candidate security review is in progress;
  full package/release acceptance remains outstanding.
  An additional workspace.view revocation scenario reproduced another race in
  54130 (exit 1, expected false, received true). The candidate now also composes
  a write-time workspace-visibility predicate, preserving the existing verified
  eligibility-shell alternative and live workspace.view entitlement semantics.
  Type checking passes; expanded guard run 89717 exited 0 (four passed,
  99.86 seconds), including the workspace.view revocation scenario. The fresh
  reviewer completed the same candidate-review cycle, including the visibility
  helper, and reported no concrete bypass or regression. This was static review,
  not a substitute for runtime gates. Its earlier separate test attempt was
  interrupted by that reviewer without a terminal result and is not counted.
  Full service-assignment policy run 23379 remains live and predates this last
  visibility addition; it must not be represented as final-candidate coverage.
  The separate migrated-D1 eligibility compatibility suite passes (two tests,
  24.28 seconds). It captures the guard before changes and then verifies both
  ordinary workspace.view revocation/deny and default-on eligibility shell
  behavior, including bridge revocation, principal version replacement and
  verified-email identity rebinding. This is local authorization evidence,
  not live Project Alpha provisioning acceptance.
  Full browser run 87958 remains live. It exposed a harness routing error:
  dual-domain specs were discovered by the localhost configuration and expected
  a named portal host instead of 127.0.0.1. The base configuration now excludes
  only that file, and `test:browser` runs both the base and J7 configurations.
  List-only verification reports 400 base tests plus 16 two-domain tests, so
  this partitions rather than drops coverage. Both correctly configured runtime
  runs remain required after 87958 terminates; do not reuse its known failures
  as a passing result or start a second server on the same port.
  Run 87958 has now terminated with exit 1: 398 passed, eight skipped and the
  two expected hostname-configuration failures (desktop and mobile), 7.3 minutes.
  The partition regression itself passes two unit tests, and diff checking is
  clean. Correctly configured runtime verification follows this terminal run.
- D1 and cursor regression run 51198 exited 0: 21 tests passed, including
  current delivery revocation, mixed-kind pagination and rejection of a valid
  legacy cursor envelope. Client type check and build 97972 exited 0.
- Browser run 97969 had 39 passes, eight skips and one failure. Its trace
  records `net::ERR_ADDRESS_IN_USE` fetching the local app CSS, followed by
  an unable-to-preload-CSS page error; it was not a rendered access assertion.
- Single-worker rerun 35851 exited 0: 40 passed and eight skipped (34.8s),
  including the mobile denial case and late-response dismissal regression.
  This is local fixture evidence, not production portal acceptance.
- Live LTDS PA UI still reports connection Ready, routing Paused, zero active
  workspaces and zero queued/failed events. Its prerequisite warning requires
  the portal producer to be saved for the existing connection. No setting was
  changed during this read-only check and LTT was not enrolled.

Additional unchanged-package checks against the frozen candidate:
Ops Sync session 66273 exited 0 (5 files / 72 tests, 251.33 seconds), and its
type check passed. Thumbnail renderer exited 0 (27 passed, one native-Bash
check skipped on Windows), with syntax checks passing. Neither package's
source differs between the candidate and the current integration commit.
These are local regressions, not live sync or container-rendering acceptance.

The frozen candidate Client run (session 41232, checkout `3e0ed29`) completed
with exit 0: 95 files / 1,073 tests passed in 3,798.98 seconds. This does not
include subsequent maintenance or delivery-history changes. The Operations
candidate run 9178 is terminal (exit 1): 184 files passed, two failed;
1,913 tests passed and two failed in 7,110.31 seconds. The PA draft route
fixture expected 201 but received 200 (the outdated statement-count fixture,
fixed above). The notification cursor test failed while loading ACLs because
Miniflare's local connection returned `EADDRINUSE 127.0.0.1:61971`, not an
authority assertion failure. Its unchanged isolated file passed previously;
neither that result nor the infrastructure diagnosis makes this full run green. Complete the
remaining gates, reconcile the tested revision, then follow R8a in production.
There has been no production maintenance activation, migration, or deployment
for this increment. The separate formal security scan finalization failure
also remains recorded; this document does not claim a sealed scan result.
