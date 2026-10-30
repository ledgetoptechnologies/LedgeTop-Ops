# client-0242-targeted-v1

This is a separate held evidence compiler for a possible one-file append of
`apps/client/migrations/0242_client_ops_triage_inquiries.sql`. It is not wired
into the old frozen append-only profile, automatic admission, or any executor.

The compiler pins source38-inventory-v2 manifest and append-plan bytes, source
commit `38ad7ebcfc09e4334de846d5307e7dac5a0ff327`, client database ID
`7f40a7b7-c3ec-470e-a626-e798867f71f8`, the exact 158-row ordered base,
historical rows 0112/0113 at IDs 31/32, and migration 0242's Git blob and
SHA-256. Of the source-pending set 0235, 0236, 0239, 0241, 0242, it selects only
0242 at ledger ID 159 and explicitly leaves the first four pending.
If such an append were later observed, a future inventory would need to record
that exceptional order exactly; it must not claim the canonical source-order
five-file append. Any subsequent normal Wrangler migration apply needs separate
review because the four earlier source files remain pending.

It requires a metadata-only schema snapshot for the same account/database,
matching ledger, exact captured `sqlite_schema` object rows (capture excludes
`sql IS NULL`, `sqlite_*`, and `_cf_*` objects), and the
`portal_v2_identities.id TEXT PRIMARY KEY` prerequisite. Missing schema input
returns a held packet with no request body. The compiler includes a same-batch
guard that compares the exact ordered ledger and schema object snapshot again,
checks the identity parent key and that foreign-key enforcement is enabled,
then removes its private guard table before creating the exact pinned
migration objects and appending the 0242 ledger row.
No business rows are written. Inputs are caller-supplied evidence; the compiler
cannot attest how they were acquired. The emitted request body remains a
review candidate with all execution/readiness/feature-authority fields false.

The synthetic `node:sqlite` tests build only a small in-memory schema plus the
158 pinned migration-name/ID metadata rows. That is a guard/transaction unit
fixture, not a clone or reconstruction of the actual client schema or data.
The root's separate metadata-only schema capsule and the disposable REST batch
probe are provenance evidence for review; the probe qualified transaction
behavior on its own empty synthetic D1 only. Neither is a full client baseline
rehearsal, nor does either authorize applying the migration.

Root also separately reproduced all 1,176 captured application schema definitions
and the 158 ledger identities in local in-memory SQLite, then exercised the
compiled nine-statement packet, concurrent schema-change rejection and replay
rejection. That structural rehearsal uses empty application tables. It is not a
test against production records or a REST execution against the full schema
clone, and it does not provide migration execution authority.

Run only these focused local tests with:

```powershell
node --test scripts/production-auto-migration-profile/client-0242-targeted-v1/packet.test.mjs
```
