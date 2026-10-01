# Ledge Top Ops + Project Alpha staging status

Updated: 2026-10-01 09:31 UTC

## Short version

The integration is **not yet proven end-to-end or ready for production cutover**. Staging has a default-off API-v2 candidate and portal groundwork, but live Project inventory still returns `binding_stale`; client identity/data access has not passed with a real authorized test client; and the Ops Sync staging Worker is absent. No production PA updates, production client access, or existing public-link changes were made.

## Verified so far

- Current staging databases are `client-data-staging` and `ltds-ops-staging`.
- Fresh private full exports were created on 2026-10-01 and are ignored under `.backups/`; checksums and exact target database IDs are in `.backups/staging-native-pre-migration-evidence-20261001.json`. Do not publish or attach those exports.
- Both just-in-time read-only D1 ledger gates passed: Operations is exactly at 151 migrations through `0151_verified_recipient_delivery_authority_outbox.sql`; Client is exactly at 141 through `0222_verified_recipient_delivery_cross_manager_revoke.sql`. No native portal migration has been applied yet. The reviewed staging-only suffix is Operations `0152`–`0160` and Client `0223`–`0228`.
- The migration-only profile generator/check passed. Its configs each pin one staging D1 database and contain no Worker entrypoint, route, variables, secrets, or portal activation.
- Focused Operations migration/portal suite passed after repairing stale fixture assumptions: 13 files, 39 tests. Operations and Client TypeScript checks pass. Focused Client portal tests are running; their preflight sub-suite passed 9/9, but the Vitest result is still pending.
- Read-only Wrangler deployment history shows Operations staging `ledgetop-ops-staging` version `757133ea-cadb-4392-b331-b69e4e59a2d8` at 100%, annotated as the default-off API-v2 acceptance candidate. Client staging `ledgetop-clients-staging` version `03604bf1-ae6f-4d8e-9c25-a82be28e5642` is at 100%. These deployed revisions are not the current local source candidate.
- Live Ops administration acceptance for source `project-alpha:staging` observed capabilities and Directory successfully, but Project inventory/status remains `binding_stale`. The PA staging tab had expired; no binding refresh or PA staging mutation was attempted.
- `/portal` currently reports that access is not provisioned for the browser's current Access identity. This is not a successful real-client sign-in test and no client access was activated.
- The `ledgetop-ops-sync-staging` Worker remains absent. No end-to-end PA webhook/event or bidirectional/reconciliation acceptance has passed.
- The main Ops checkout is still dirty/conflicted. A fresh read-only branch audit found 174 local branches, 142 attached to worktrees, and 25 dirty worktrees; it found **no safely removable local branches** after protecting `main`, `dev`, and active worktrees. No branch was deleted by that audit. Earlier remote-branch cleanup evidence is separate from this local-branch inventory.

## Priority order and remaining gates

1. **PA↔Ops connection first:** resolve the verified `binding_stale` Project binding via current PA binding-status evidence and its guarded refresh flow, then prove authenticated, scoped reads and durable Ops synchronization across both staging PA instances, including identity, explicit client/project mapping, idempotency, retries, and visible reconciliation. Do not guess a binding revision/hash or activate a client based on stale cached state. The Ops Sync Worker is still absent.
2. **Then client portal:** deploy the minimal portal path and verify a real authorized test client can sign in and see only their linked services/data while existing public links continue to work. Defer workforce, thumbnails, broad UI polish, and unrelated features.
3. Finish the focused Client portal test run, fix any real failures, and rerun all affected Operations/Client migration, auth, and portal checks.
4. Confirm staging secrets and Access/service-binding prerequisites through the approved secret workflow. Expected local ignored secret sidecars were absent at the latest check; secret values were not read or exposed.
5. Freeze the exact staging candidate and hashes; re-run identity/config/migration gates immediately before applying only the reviewed Client/Operations suffixes through Wrangler's migration ledger. Verify exact resulting ledgers, foreign keys, row counts, authorization triggers, and no-op reruns after each database.
6. Deploy only the scoped staging versions, verify revisions and bindings, then run live tests for the PA↔Ops sync and minimal client sign-in/data path.
7. Record evidence and rollback steps. Only after the staging sync and real-client portal acceptance pass should the user update both production PA instances for the separately controlled production acceptance checkpoint.

## Production boundary

No production PA update, production migration, client-access activation, or change to existing public links is included in this staging work. Do not treat staging success as proof that production has been migrated or that clients can sign in yet.

## Estimate

I would not give a reliable calendar estimate until the Client test suite completes and staging migrations/deployments are verified. The remaining work is primarily acceptance and any defects uncovered there; it is not yet a production-ready “one last toggle.”
