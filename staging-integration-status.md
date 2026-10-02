# Ledge Top Ops + Project Alpha staging status

Updated: 2026-10-02 (live read-acceptance checkpoint)

## Short version

The integration is **not yet proven end-to-end or ready for production cutover**.
A fresh signed-in Operations staging API-v2 read check succeeded on October 2:
Directory 14 records, Projects 2 records. The older `binding_stale` result below
is historical and was not reproduced by this check. Live recipient sign-in,
selected file access, and revocation remain unproven. The absent legacy Ops
Sync Worker is not a safe substitute or required fix for API-v2 read acceptance.
No production PA updates, production client access, or existing public-link
changes were made.

## Current October 2 checkpoint

- The owner browser at Operations staging completed **Verify read-only API
  connection** for the explicitly configured `project-alpha:staging` source.
  Its current result is `API v2 read connection verified · Directory 14 ·
  Projects 2`. This does not prove all configured production sources, full
  reconciliation, write authority, or client access.
- **Read one bounded inventory page** then completed for the same source:
  Directory 14 observed, 0 conflicts, page complete; Projects 2 observed,
  0 conflicts, page complete. This verifies the live bounded inventory path
  and its reported persistence result; it does not activate mappings, clients,
  recipients, folders, or public links.
- Ops staging version `363c9714-bd6f-4eeb-96df-fef681f4a44a` and Client staging
  version `2512de43-cd37-4118-97d9-d0c241a3fabd` are the read-back 100-percent
  deployments. No new candidate was deployed for this read verification.
- Both staging migration lists report no pending migrations. The missing
  native enrollment CSRF and native content-audit secrets still need secure
  staging-only provisioning. Existing local/deployed configuration drift must
  be reconciled before opening a portal test window.
- The canonical staging workspace owner-page route correction passed 41
  focused tests and is committed locally at `625731d4`. Publication and
  exact-revision CI for that correction are still required. Existing CI on
  the earlier published `f24a60f2` is a separate gate.

The October 1 evidence below is retained as history, not current deployment or
readiness proof. In particular its stale-binding and migration-count notes
must not override the current readback.

## Verified so far

- Current staging databases are `client-data-staging` and `ltds-ops-staging`.
- Fresh private full exports were created on 2026-10-01 and are ignored under `.backups/`; checksums and exact target database IDs are in `.backups/staging-native-pre-migration-evidence-20261001.json`. Do not publish or attach those exports.
- Both pre-apply read-only D1 ledger gates passed at the exact pinned baselines. The reviewed suffixes have now been applied in staging: Operations `0152`–`0163` (12 migrations) and Client `0223`–`0228` (6 migrations). Wrangler reports no migrations pending on either D1.
- The migration-only profile checker passed before apply; both profiles pin only their staging D1 database, with no Worker entrypoint, route, variables, secrets, or portal activation. Post-apply `PRAGMA foreign_key_check` returned no rows for either database. Operations workspace, recipient, and delivery authority-head tables each contain zero rows, so these migrations created no client access or delivery grants.
- Focused migration acceptance passes against the current complete chain: Ops binding-selection plus recipient-cancellation migration-chain tests, 23 passed; Client full-bootstrap migration-chain test, 1 passed after removing the obsolete 0224 migration exclusion. The focused Ops 163-migration no-access test also passed earlier (1 passed, 21 skipped). Focused Ops API-v2 Project transport, sync-route, and D1 persistence tests passed (40 tests). This turn's isolated Operations regressions passed: portal workspace-binding selection (22), reviewed migration inventory (2), authenticated delivery notification center (6), and native delivery bindings (40), 70 total. Isolated Client portal end-to-end, route, repository, and UI tests passed (17 + 39 + 19 + 38 = 113). The migration inventory assertion was aligned from 160 to 163 and now ends at `0163_project_alpha_directory_read_adoption_field_review_receipts.sql`; the checksum-backed bootstrap contract already contains that full suffix. A combined serial Operations run stalled without producing results and was stopped; individual runs completed. Client and Operations TypeScript checks passed; both Worker production builds completed successfully. Root release-invariant test for the intentionally staged Ops config hash passes after updating its normalized hash pin. A prior full Client run timed out in `workspace-v2.test.ts`, so Client full-suite status remains unverified; the full-suite checks are not being represented as passing.
- Cloudflare's live Operations staging deployment remains `757133ea-cadb-4392-b331-b69e4e59a2d8` at 100%, labeled “Staging API-v2 read acceptance candidate with preserved disabled portal gates” (observed about 9 hours before this update). Client staging version `03604bf1-ae6f-4d8e-9c25-a82be28e5642` remains at 100%. These deployed revisions are not the current local source candidate.
- Live Ops administration acceptance for source `project-alpha:staging` again observed capabilities and Directory successfully, but Project inventory/status remains `binding_stale`. I used the previously supplied staging credentials to restore the PA staging admin session; the synthetic fixture project remains visible and its existing public project link is live. Ops' read-only verification still reports the stale project binding. The portal `/portal` still says access is not provisioned for the current test identity. No client access was activated. The existing public link was not opened, copied, or changed. The exact current PA binding-status/CAS envelope has not been read back. No binding refresh, sync activation, or PA staging mutation has been attempted.
- The candidate includes an administrator-only API-v2 inventory sync-page route in the main Operations Worker, guarded by `PROJECT_ALPHA_API_V2_SYNC_ENABLED` (default `false`). The separate `apps/ops-sync` Worker is currently a webhook/HMAC-or-Ed25519 receiver, and its staging example enables legacy HMAC. It remains undeployed and must not be deployed as-is for the agreed API-v2 cutover. The API-v2 route is not a replacement for a complete durable PA↔Ops reconciliation flow; neither path has passed end-to-end sync acceptance.
- The main Ops checkout is still dirty/conflicted. A fresh read-only branch audit found 174 local branches, 142 attached to worktrees, and 25 dirty worktrees; it found **no safely removable local branches** after protecting `main`, `dev`, and active worktrees. No branch was deleted by that audit. Earlier remote-branch cleanup evidence is separate from this local-branch inventory.

## Priority order and remaining gates

1. **PA↔Ops connection first:** read current status for the exact synthetic stale external ID `pa-acceptance-p184fix-20260917a:33b8e6f6-8beb-4190-a24f-abdd7b401112`; confirm PA source/application/history identity, auth generation, binding revision, live revision/hash, and recoverability. Only if PA returns a valid newer live projection with a current CAS generation, use its guarded staging-only revision-refresh flow; otherwise stop and investigate the exact reason. Then prove authenticated, scoped reads and durable Ops synchronization across both staging PA instances, including identity, explicit client/project mapping, idempotency, retries, and visible reconciliation. Do not guess a binding revision/hash or activate a client based on stale cached state. The separate Ops Sync Worker remains undeployed and is not a safe substitute in its current legacy-HMAC configuration.
2. **Then client portal:** deploy the minimal portal path and verify a real authorized test client can sign in and see only their linked services/data while existing public links continue to work. Defer workforce, thumbnails, broad UI polish, and unrelated features.
3. Finish the focused Client portal test run, fix any real failures, and rerun all affected Operations/Client migration, auth, and portal checks.
4. Confirm staging secrets and Access/service-binding prerequisites through the approved secret workflow. Expected local ignored secret sidecars were absent at the latest check; secret values were not read or exposed.
5. Migrations are now applied, but the code candidate still needs full test completion and deployment. Re-run exact migration-ledger, configuration, foreign-key, authority-row, and no-op checks immediately before staging Worker deployment.
6. Deploy only the scoped staging versions, verify revisions and bindings, then run live tests for the PA↔Ops sync and minimal client sign-in/data path.
7. Record evidence and rollback steps. Only after the staging sync and real-client portal acceptance pass should the user update both production PA instances for the separately controlled production acceptance checkpoint.

## Production boundary

No production PA update, production migration, client-access activation, or change to existing public links is included in this staging work. Do not treat staging success as proof that production has been migrated or that clients can sign in yet.

## Estimate

I would not give a reliable calendar estimate until the Client test suite completes and staging migrations/deployments are verified. The remaining work is primarily acceptance and any defects uncovered there; it is not yet a production-ready “one last toggle.”
