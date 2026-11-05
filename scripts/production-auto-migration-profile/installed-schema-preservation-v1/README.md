# Installed schema preservation v1

This source-only, held profile captures the production metadata observation at
`2026-11-05T15:43:28.683Z` and pins migration names, Git blob IDs, and SHA-256
digests at source commit `2686c535658398baf746b78a41e8af6b79f04538` (tree
`2e612a24a6b3b80df181e85d0bb73749bc3247e8`). The sanitized fixture contains
ordered D1 migration identities and schema counts/digests; it contains no
business rows, raw schema SQL, credentials, or provider response bodies.

The captured ledgers contain 226 Ops rows and 159 Client rows. Ops has the
targeted `0226_staff_login_bindings.sql` at id 226, with 0227–0231 pending.
Client has the targeted, out-of-source-order `0242_client_ops_triage_inquiries.sql`
at id 159, with 0235, 0236, 0239, and 0241 pending; historical rows 0112/0113
remain preserved. These are explicit installed-state exceptions, not complete
source-order migration histories.

Schema digests include all application objects with non-null SQL and exclude
`sqlite_*` and Cloudflare `_cf_*` internals. Client has 1,181 application
objects; its observed extra `_cf_KV` object is excluded. An independent
2026-10-31 Client post-migration snapshot has the same 1,181 ordered
application-object names and definitions. Ops has 2,472 application objects.
The Ops digest pins only this observation; it does not claim that the full
historical Ops schema is unchanged from an earlier baseline.

`readInstalledSchemaPreservationMetadata` accepts a token directly and issues
only bounded `SELECT` statements for migration identities and `sqlite_schema`.
It does not load credentials from environment variables or files. The
classifier accepts later source commits only when both complete migration
inventories and their Git blob bodies still match this profile. New or changed
migrations, ledger order, or application schema definitions fail closed.

The exact canonical-v4 path in both automatic-release runtime adapters now uses
these source helpers. The change has not been deployed. Their receipts preserve
installed schemas without declaring them application-ready, and keep
`allSourceMigrationsInstalled`, `applicationSchemaReady`, DDL, migration
authorization, and feature activation all false. `createInstalledSchemaPreservationSession`
accepts the pinned account, source commit, selected app, v4 profile, and a
caller-provided token. It captures and fully validates the baseline itself,
then `observe()` captures current installation state and obtains fresh
read-only D1 metadata itself. Both captures pass the full v4 installation
validator; the session derives and compares a digest over checked settings,
resources/bindings, plain-variable hashes, schedules, and asset associations.
For Operations or Client only, the current asset association is first checked
against the internally captured baseline with the narrow v4 override (same
config and exact association shape), then normalized to that baseline in the
control digest. Other workers' asset associations remain fully compared; Ops
Sync cannot enable this exception.
Current capture and metadata must be no more than 60 seconds old. The internally
captured baseline may remain in the same process session for at most 45 minutes;
its timestamp is never refreshed. Saved snapshots and caller hashes can only
use the separate offline helper, which requires a historical clock and marks
its receipt `offlineOnly: true`.

Production freshness uses the system wall clock and monotonic process clock.
Arbitrary clock, HTTP, and evidence hooks exist only in the explicitly named
fake-HTTP test factory; its sessions and receipts have separate private brands.
The production factory accepts native HTTP or an in-process, native-backed
Cloudflare pacing transport branded for the exact production account. A caller
fake, cross-account wrapper, or serialized lookalike cannot supply that transport. The
production session does not establish source/CI provenance or owner approval.
Existing runtime source and CI fences validate those independently; this
preservation profile is not activation authority. Call `close()`
when finished to clear the session's in-memory token.

Run the focused offline checks with:

```powershell
node --test scripts/production-auto-migration-profile/installed-schema-preservation-v1/installed-schema-preservation.test.mjs
```

The portable unit suite does not read private production artifacts. To verify
runtime wiring against the actual saved full Worker capture and D1 schema, run
this explicit local acceptance script from the repository root:

```powershell
node scripts/production-auto-migration-profile/installed-schema-preservation-v1/runtime-actual-capture-acceptance.mjs
```

It requires the two fixed `_artifacts/production-release-readback-20261104`
receipts named in the script, uses fake HTTP responses for all Worker and D1
requests, and prints only pass/fail summaries. It verifies that Client's v4
session admits its CI gate, Ops Sync's exact app-scoped session clears before
source/CI gates, and same-run Operations schema drift holds Ops Sync before CI
or provider construction.
