# Staging native authority packet

This procedure establishes and later revokes the minimum native authority needed
for the manually invoked joined Project-v2 staging acceptance route. It does not
create an HTTP route, Worker binding, feature flag, production migration, token,
or Access policy. It never applies SQL by itself.

The packet gives one existing synthetic staging Operations owner:

- one active `native_staff_admissions` row bound to the owner's already verified
  Access subject;
- one exact `native_staff_profiles` row; and
- one explicit global `project.shared.sync` allow in `native_project_grants`.

The global scope is deliberate and temporary. Initial Project create inserts its
destination in the same transaction as its native proof, so an `exact_project`
grant cannot satisfy the foreign key before that create. No directory,
staff-management, integration-control, workforce, or delegation authority is
created.

## Safety model

The checked-in generator validates the exact staging account, Operations D1 ID,
complete D1 binding inventory, and the exact reviewed 122-file Operations
migration chain. Generated files are ignored. Provision and revoke use separate
Wrangler configs and separate one-file migration directories so applying the
provision config cannot select the revoke migration.

Both configs use the staging-only
`staging_native_authority_migrations` migration table. They do not add rows to
the canonical `d1_migrations` ledger. Each migration rechecks the exact 122-name
canonical ledger in D1 and its expected auxiliary-ledger predecessor before any
authority mutation. Wrangler migration rollback, database constraints, final
sentinel checks, immutable bootstrap approvals/receipts, admission versions, and
project-grant generations make the change atomic and auditable.

The input contains no bearer secret. Never put a JWT, `CF_Authorization` cookie,
service token, API token, Access client secret, or PA key in it. The Access
subject is an identifier, not an assertion; handle it as private identity data.
Console output and manifests contain hashes rather than the subject, email, or
display name. Generated SQL necessarily contains the bound values and must stay
in the ignored local directory with operator-only filesystem access.

## Prepare and review

1. Keep the joined route flag and the selected PA connection disabled.
2. Apply and verify the canonical Operations migrations through `0122`. Confirm
   that no native staff-management, directory, or Project command fence is open.
3. Sign in once through the ordinary staging Operations Access application so
   the existing synthetic owner's `staff_users.access_subject` is bound. Verify
   the owner is active, has the exact reviewed email/display name, a global
   owner/admin role, global `integrations.manage`, and no global deny.
4. Obtain the exact subject and binding-evidence digest through the approved
   identity-review process. Do not copy an Access assertion into the packet.
5. Copy
   `docs/staging/staging-native-authority.json.example` to the ignored
   `.backups/staging-native-authority.json`. Replace every placeholder. The
   authority window must already have started, must remain open at apply time,
   and may not exceed four hours.
6. For the first native admission use `mode: "create"` and zero expected
   versions. For a later window use a new packet ID, `mode: "reactivate"`, and
   the exact inactive admission/profile/grant/generation versions recorded by
   the preceding revoke manifest and independent readback.

Generate both phases before opening the window so reviewed emergency revocation
is already available:

```powershell
npm.cmd run staging:native-authority:generate
npm.cmd run staging:native-authority:check
npm.cmd run staging:native-authority:revoke:generate
npm.cmd run staging:native-authority:revoke:check
npm.cmd run staging:native-authority:test
```

Review the two manifests, SQL hashes, exact staging D1 identity, and the generated
configs. Confirm that the provision and revoke configs resolve to different
one-file directories and both name only
`staging_native_authority_migrations`. Do not hand-edit an artifact; checks must
fail on any change.

## Provision

Use only the generated provision config and the immutable database name. Do not
use `wrangler d1 execute`, a dashboard query, the ordinary staging config, or the
revoke config for provisioning.

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' d1 migrations list ltds-ops-staging --remote --config 'apps/operations/wrangler.staging.native-authority.<packet-id>.provision.json'
& '.\apps\client\node_modules\.bin\wrangler.cmd' d1 migrations apply ltds-ops-staging --remote --config 'apps/operations/wrangler.staging.native-authority.<packet-id>.provision.json'
```

The list must contain exactly the one reviewed provision filename. After apply,
list again and require no pending migration. Record the generated manifest hash,
Wrangler backup/migration output, auxiliary-ledger filename, and sanitized
readback proving active admission/profile/grant versions and generation. Do not
record the raw email or subject in release evidence.

Only then may the separately approved acceptance window enable the joined route
flag and exact disposable PA connection. The same signed-in owner must satisfy
legacy administrator, global `integrations.manage`, native identity equality,
and current project-grant checks.

## Normal revoke

1. Restore the joined route flag and selected PA connection to disabled and
   verify the deployed values.
2. Confirm no Project outbox command for this actor remains `pending` or
   `leased`. The revoke SQL independently rejects that state.
3. Apply only the generated revoke config:

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' d1 migrations list ltds-ops-staging --remote --config 'apps/operations/wrangler.staging.native-authority.<packet-id>.revoke.json'
& '.\apps\client\node_modules\.bin\wrangler.cmd' d1 migrations apply ltds-ops-staging --remote --config 'apps/operations/wrangler.staging.native-authority.<packet-id>.revoke.json'
```

The migration requires the provision filename in the auxiliary ledger, exact
active admission/profile/grant versions, the exact grant generation, and the
unrevoked provision approval. It deactivates the grant, increments its version
and generation, deactivates the admission and increments its version, marks the
provision approval revoked, and writes a separate immutable revocation receipt.
The profile and durable authority history remain. Existing native Project proofs
cease to be live.

List the revoke config again and require no pending migration. Record sanitized
readback of the inactive admission/grant, incremented generation, both immutable
receipts, revoked provision approval, and zero live native Project proofs.

For an active compromise, apply the already-reviewed revoke packet first, then
disable the route and PA connection immediately. If any exact-version guard
fails, stop; investigate current state and generate a new independently reviewed
packet. Never weaken a predicate, delete a durable row, restore an old D1 backup
over later acceptance data, or fall back to raw inserts/updates.
