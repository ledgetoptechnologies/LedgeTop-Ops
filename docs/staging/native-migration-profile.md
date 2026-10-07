# Native portal staging migration profile

This profile is a migration-only staging rehearsal boundary. The currently
pinned staging baselines contain 147 Client migrations through `0228` and 173
Operations migrations through `0173`. The reviewed candidate suffix contains
no Client migrations and only Operations `0174`–`0180`. These counts and hashes
are deliberately specific to the currently verified staging databases; a
different remote ledger must fail closed and requires a new review. Profile
generation does not alter either source inventory, any production Wrangler
configuration, feature flag, route, binding, CI workflow, or remote resource.

Generate and verify the ignored artifacts locally:

```powershell
npm run staging:native-migrations:generate
npm run staging:native-migrations:check
```

The generator first verifies the byte-pinned canonical base chains and every
new native migration. It then copies only the expected suffix after the required
staging baselines into ignored, app-local directories and emits minimal configs
containing only the staging account and one exact D1 binding. At this checkpoint,
the Operations suffix is `0174`–`0180`; the Client suffix is empty because its
staging ledger is already at the reviewed final migration `0228`.

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
Operations `0173` or Client `0228`. `wrangler d1 migrations list` is not used
because it reports only local files that are unapplied and therefore cannot
prove the complete remote history. A successful gate does not apply a migration
and describes only the live read completed by that invocation; copied,
user-entered, or earlier evidence is not treated as current live state.

Stop unless both gates have just passed, the exact staging IDs match, current
private backups and recovery evidence exist, and the generated migration list
is exactly Operations `0174`–`0180` with no Client SQL files. Applying these
Operations migrations, deploying the matching Worker candidate, runtime
activation, and live acceptance are separate gates. A successful ledger gate
does not authorize any production action.
