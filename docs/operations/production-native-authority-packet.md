# Production native authority packet

This runbook prepares a production-only, create-mode packet for one existing,
verified Operations owner. The generator does not apply SQL, deploy a Worker,
add a route, change a public link, alter a feature flag, or obtain credentials.
Generated SQL and Wrangler configs are local, ignored artifacts.

The packet can create exactly these native rows for the one reviewed owner
identified only in the ignored private values file:

- one active native staff admission bound to the independently reviewed
  Cloudflare Access subject;
- one version-1 native staff profile for the seeded production email and
  display name;
- one active global `directory.profile.edit` allow; and
- one active global `project.shared.sync` allow.

It creates no directory scope, membership, staff-management delegation,
integration-control grant, workforce grant, public-share authority, route, or
credential. Reactivation is deliberately unsupported. After revocation, the
admission and both grants remain inactive and durable; a later authority window
requires a separately designed and reviewed mechanism.

## Pinned production boundary

The generator reads `apps/operations/wrangler.jsonc` and rejects any drift from
the reviewed production Worker name, environment, complete D1 inventory, or
the production `OPS_DB` identity supplied in the ignored private values file.
No owner identity or infrastructure UUID is embedded in the public generator,
tests, example, or runbook.

The ignored private values file must also enumerate the owner's complete
reviewed `staff_permission_overrides` set. Each entry contains exactly `id`,
`permissionKey`, `effect`, `scope`, nullable `divisionId`, `scopeKey`, and
`createdBy`. The generator canonicalizes those entries by ID. Public manifests
contain only the canonical row count and SHA-256 digest, never the raw override
values.

It also pins the exact 124-file Operations migration chain and its content
digest through `0124_project_alpha_project_adoption_review_evidence.sql`.
Generated configs are intentionally smaller than the deploy config: they carry
only the Worker metadata and the one `OPS_DB` migration binding. They contain
no routes, assets, variables, service bindings, public-link configuration,
account identifier, token, or secret.

Provision and revoke have separate configs and separate directories containing
one migration each. Both use the auxiliary
`production_native_authority_migrations` table, never the canonical
`d1_migrations` table. Applying the provision config therefore cannot discover
the revoke migration, and the reverse is also true.

## Fail-closed invariants

Before provision, the migration requires the exact canonical 124-name D1
ledger, an empty auxiliary ledger, the exact active seeded owner row and global
owner assignment, the reviewed Access subject, the exact complete reviewed
permission-override set, and no prior native admission,
profile, grant, grant generation/history, bootstrap approval, or bootstrap
receipt for that owner. It rejects other native management, integration,
workforce, Directory, or Project authority and any surviving actor command,
pending/leased outbox work, or Directory write fence.

Permission overrides are existing owner state, not authority created by this
packet. The packet never inserts, updates, or deletes them. Both phases require
the complete current set to match the private canonical set with no missing,
extra, or changed reviewed row, and verify that exact set again before commit.
An explicitly reviewed empty array is supported.

Provision verifies all of the following before it can commit:

- admission version `1` and profile version `1`;
- exactly one Directory grant, generation `1`, with exactly one immutable
  history row at grant version `1` and generation `1`;
- exactly one Project grant at version `1` and generation `1`; and
- the immutable approval and receipt for the reviewed canonical plan.

Revoke requires that exact active state, the exact provision row in the
auxiliary ledger, unchanged Directory history/generation, unchanged Project
version/generation, no added native authority, and no pending actor work. It
then deactivates the Directory and Project grants and admission. The Directory
trigger must append history version `2` at generation `2`; the Project grant
must reach version `2` and generation `2`; and the admission must reach version
`2`. Any mismatch aborts the whole migration. SQLite/D1 transaction rollback
also removes approvals, receipts, history, and grant changes after a late
failure.

## Prepare the input

1. Keep every write route and production activation flag outside this packet's
   separately approved change window. This packet grants database authority;
   it does not authorize enabling a route or connection.
2. Confirm production `d1_migrations` contains exactly the checked-in chain
   through `0124`, with no pending canonical migration.
3. Confirm the seeded owner is active, has the exact checked-in email and
   display name, has signed in through the ordinary production Access
   application, and has exactly the reviewed global owner assignment.
4. Independently verify the Access subject and record a nontrivial SHA-256 of
   the binding evidence. The subject is an identifier, not a bearer assertion.
5. Copy `docs/operations/production-native-authority.json.example` to the
   ignored `.backups/production-native-authority.json`. Replace every
   placeholder. The window may not exceed four hours.
6. Read every current override for the owner from `staff_permission_overrides`
   and copy the complete reviewed set into `permissionOverrides`. Preserve each
   row's exact `id`, `permission_key`, `effect`, `scope`, nullable `division_id`,
   `scope_key`, and `created_by` values using the example's camel-case field
   names. `createdBy` must equal the packet `staffId`; otherwise stop for review.
   Do not omit apparently redundant allows. Use `[]` only after explicitly
   confirming that the current set is empty.

Never place a JWT, `CF_Authorization` cookie, API token, service-token secret,
PA key, or other credential in the values file. Manifests contain hashes, but
the generated SQL necessarily contains the reviewed owner identity and Access
subject. Keep the ignored output under operator-only filesystem access.

## Generate and review only

Run the focused test and generate both phases before any separately approved
change window:

```powershell
npm.cmd run production:native-authority:test
npm.cmd run production:native-authority:generate
npm.cmd run production:native-authority:check
npm.cmd run production:native-authority:revoke:generate
npm.cmd run production:native-authority:revoke:check
```

These commands never invoke Wrangler. Review both manifests, SQL hashes,
production D1 identity, 124-file chain digest, and configs. Require exactly one
SQL file in each phase directory. Do not hand-edit generated output; the check
must reject any changed byte or unexpected migration.

## Separately authorized application

This repository change does not authorize or perform a live apply. If a later
production change is approved, use only the reviewed phase-specific config and
the immutable reviewed database name from the private packet. First list
migrations and require the
single expected filename. After an apply, list again and require no pending
auxiliary migration. Never substitute `wrangler d1 execute`, the ordinary
production deploy config, or a dashboard query.

Before provision, independently recheck the canonical ledger, auxiliary ledger,
owner binding, empty native state, and zero pending actor work. After provision,
record sanitized readback of admission/profile versions, the permission-override
count and canonical digest, the exact Directory
grant plus generation/history, the exact Project grant plus version/generation,
and the immutable receipt. Do not record the raw Access subject or email in
release evidence.

For normal revoke, first disable any separately activated write path and verify
zero pending or leased Project/Directory work and zero Directory write fences.
Use only the already reviewed revoke config. Record sanitized readback of the
inactive admission and grants, Directory history version/generation `2`, Project
version/generation `2`, the revoked provision approval, both receipts, zero live
Project proofs, and no pending auxiliary migration.
The readback must also reproduce the same permission-override count and digest;
do not record raw override values in public release evidence.

If a guard fails, stop and investigate the current database state. Do not
weaken a predicate, rewrite history, delete durable rows, use raw D1 updates, or
restore an older backup over newer production data.
