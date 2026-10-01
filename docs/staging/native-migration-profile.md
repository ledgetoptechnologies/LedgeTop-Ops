# Native portal staging migration profile

This profile is a migration-only staging rehearsal boundary. The byte-pinned
pre-candidate bases contain 143 Client files and 154 Operations files. The full
reviewed source inventories contain 147 Client files through `0228` and 163
Operations files through `0163`. Profile generation does not alter either source
inventory, any production Wrangler configuration, feature flag, route, binding,
CI workflow, or remote resource.

Generate and verify the ignored artifacts locally:

```powershell
npm run staging:native-migrations:generate
npm run staging:native-migrations:check
```

The generator first verifies the byte-pinned canonical base chains and every
new native migration. It then copies only the expected suffix after the required
staging baselines into ignored, app-local directories and emits minimal configs
containing only the staging account and one exact D1 binding. The expected suffix
is Operations `0152` through `0163` (including the reviewed gap files `0154` and
`0156`–`0160`, plus API-v2 adoption migrations `0161`–`0163`) and Client `0223`
through `0228` (including `0224` and `0226`–`0228`).

The generated configs contain no Worker entrypoint, vars, routes, services,
assets, schedules, queues, storage bindings, or feature activation. Generation
performs no network operation.

Immediately before any separately approved remote apply, run both live ledger
gates from the repository root:

```powershell
npm run staging:native-migrations:gate:operations
npm run staging:native-migrations:gate:client
```

Each gate uses the pinned local Wrangler executable and generated single-D1
config to perform only this read-only query against the exact staging binding:
`SELECT name FROM "d1_migrations" ORDER BY id`. It fails unless the returned
ordered history exactly equals the pinned pre-suffix chain and ends at
Operations `0151` or Client `0222`. `wrangler d1 migrations list` is not used
because it reports only local files that are unapplied and therefore cannot
prove the complete remote history. A successful gate does not apply a migration
and describes only the live read completed by that invocation; copied,
user-entered, or earlier evidence is not treated as current live state.

Stop unless both gates have just passed, the exact staging IDs match, current
private backups and recovery evidence exist, and the generated migration list
is exactly the suffix above. Apply authorization, the apply command itself,
deployment, runtime activation, and live acceptance remain separate gates.
