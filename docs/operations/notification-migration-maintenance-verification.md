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

Operations uses `--containers-rollout none` for this Worker-only release. No
container source, package manifest or lockfile differs from the inspected main
baseline, and no container image is rebuilt or replaced by that invocation.

## Still required

The full Client/Operations candidate runs remain pending. The older candidate
Operations run reported the outdated three-statement fixture assertion, fixed
above; focused results do not reclassify that run as passing. Complete the
remaining gates, reconcile the tested revision, then follow R8a in production.
There has been no production maintenance activation, migration, or deployment
for this increment. The separate formal security scan finalization failure
also remains recorded; this document does not claim a sealed scan result.
