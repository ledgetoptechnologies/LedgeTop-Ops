# Operations staging project lifecycle candidate: 203 → 204

This is a preparation contract, not evidence of deployment or live acceptance.
The window applies only `0204_native_project_archive_restore.sql` to Operations
staging database `78b34173-b168-4e3d-9832-bb9d245cc6b8`. It does not activate PA
write scopes, grant staff permissions, configure portals, or change Workers.

The 203 source descriptor and authority compilers remain frozen. Current source
readers use the separately reviewed 204 descriptor; historical bootstrap/release
inventories retain their existing migration selections. The new project-only
authority compiler grants one scoped `project.shared.sync` allow and retains
the original Directory grants, project denies, and monotonic grant versions.

## Checks and execution gates

Run the local suites from the reviewed checkout:

```powershell
npm run staging:pa-ops-authority-203:test
npm run staging:pa-ops-authority-204:test
npm run staging:project-203-204:test
node scripts/staging-native-project-203-204-migrations.mjs dry-run
```

Before a live migration, independently review the exact SQL and source commit,
then obtain a successful **new 204 candidate** CI run with all ten jobs. The
prior 203 CI result does not authorize this candidate. The checkout must be
clean and match `STAGING_SOURCE_COMMIT_SHA`; `STAGING_SOURCE_CI_RUN_ID` must name
that successful run. The runner checks freshness and stores both identities in
its protected backup evidence and exclusive attempt marker.

Keep business mutation windows closed. Verify fresh primary-served D1
preconditions and the exact 203 ledger. Preserve the current provider settings,
resources, routes, six reviewed cron entries, purpose credentials, and the
128-text-binding budget when preparing the separate Worker release. A fresh
private SQL export must be independently restored and checked before apply;
export success alone does not establish restorability.

An existing legitimately configured pending secondary portal is valid baseline
state and must be preserved; this window does not require portal tables to be
empty. The paired checkpoint captured before secondary configuration is useful
provenance, but cannot replace a fresh migration backup after that configuration
change. The strict apply gate rejects post-backup data drift.

With the reviewed source-CI environment and the existing protected credential
loader, the available commands are:

```powershell
node scripts/staging-native-project-203-204-migrations.mjs preflight candidate204
node scripts/staging-native-project-203-204-migrations.mjs backup candidate204
# Independently restore and verify the captured backup, then obtain operator release.
node scripts/staging-native-project-203-204-migrations.mjs apply candidate204
node scripts/staging-native-project-203-204-migrations.mjs reconcile candidate204
```

An apply attempt creates one shared marker for this exact window before calling
the provider. Unknown outcomes require read-only reconciliation. Changing the
artifact label does not authorize a retry. No temporary project permission
window may open until the exact 204 ledger and reviewed runtime are confirmed.

## Recovery limitation

The SQL is additive and has no automatic down migration. Once lifecycle
commands, receipts, or activations exist, retain the migration and its history.
A prior 203 Worker does not recognize lifecycle lineage; reverting runtime
alone can make affected project reads unavailable.

Prefer a reviewed forward fix after writes. Restoring an exact pre-migration
backup is a separate recovery decision and requires reconciliation of every
post-backup write. Do not drop lifecycle tables, erase receipts, reset grant
generations, or restore an entire database blindly to simulate rollback.

CLI reference: [Cloudflare D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/).
