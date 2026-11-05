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

The classification and release-admission helpers are not wired into either
production runtime. They return held evidence with
`allSourceMigrationsInstalled`, `applicationSchemaReady`, DDL, migration
authorization, and feature activation all false. Release admission accepts the
actual baseline and current full installation captures plus the exact v4
profile. It calls the existing full installation validator on each capture,
using the exact selected app, then derives and compares a digest over checked
settings, resources/bindings, plain-variable hashes, schedules, and asset
associations. Hash strings alone cannot admit. Production admission uses the
wall clock with a fixed 60-second evidence age; a separate offline-only helper
supports saved artifacts under a supplied historical clock and marks its
receipt `offlineOnly: true`.

Run the focused offline checks with:

```powershell
node --test scripts/production-auto-migration-profile/installed-schema-preservation-v1/installed-schema-preservation.test.mjs
```
