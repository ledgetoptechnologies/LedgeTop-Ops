# Staging native authority packet

This procedure establishes and later revokes the minimum native authority needed
for the manually invoked Directory-v2 bootstrap and joined Project-v2 staging
acceptance routes. It does not create an HTTP route, Worker binding, feature
flag, production migration, token, or Access policy. It never applies SQL by
itself.

The packet gives one existing synthetic staging Operations owner:

- one active `native_staff_admissions` row bound to the owner's already verified
  Access subject;
- one exact `native_staff_profiles` row;
- one explicit global `directory.profile.edit` allow in
  `native_directory_grants`; and
- one explicit global `project.shared.sync` allow in `native_project_grants`.

Both global scopes are deliberate and temporary. Directory bootstrap must
authorize a not-yet-created record, and initial Project create inserts its
destination in the same transaction as its native proof, so narrower resource
or `exact_project` grants cannot authorize those creates. No other directory,
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
project-grant generations make the change atomic and auditable. Packet schema
v2 records the exact directory-grant identity and active result in each
canonical plan, immutable approval/receipt, and sanitized manifest. The
directory-grant table has no version column, so each transition instead requires
exactly one full-shape row and rejects any additional or conflicting row.

Remaining hardening: the canonical `native_directory_grants` schema has no
version/generation column or deletion-protection trigger. The packet's exact
current-state guards and immutable approval/receipt evidence cannot detect a
historical off/on transition or delete/reinsert performed outside this governed
path. Adding revisioned, deletion-protected grant history requires a future
canonical schema migration; it is intentionally not simulated in generated
staging SQL.

The preferred `operatorKind` is `synthetic`. A staging database that still
contains the immutable production-seeded owner may explicitly use
`legacy-roster-staging`, which accepts only the one exact reviewed
`staff-beau-koltz` / `beaukoltz@ledgetopdroneservices.com` / `Beau Koltz` tuple
after ordinary Cloudflare Access sign-in has bound its subject. Mixed tuples,
other canonical identities, arbitrary real identities, implicit fallback, and
every non-staging D1 database remain rejected. This exception exists only
because the generator also pins the Cloudflare account, complete binding
inventory, exact `ltds-ops-staging` database ID, and canonical migration chain;
it does not make the identity portable to production.

The input contains no bearer secret. Never put a JWT, `CF_Authorization` cookie,
service token, API token, Access client secret, or PA key in it. The Access
subject is an identifier, not an assertion; handle it as private identity data.
Console output and manifests contain hashes rather than the subject, email, or
display name. Generated SQL necessarily contains the bound values and must stay
in the ignored local directory with operator-only filesystem access.

## Prepare and review

1. Keep both acceptance-route flags and the selected PA connection disabled.
2. Apply and verify the canonical Operations migrations through `0122`. Confirm
   that no native staff-management, directory, or Project command fence is open
   and neither Project nor Directory outbox has pending or leased actor work.
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
6. For the first native admission use packet schema v3, `mode: "create"`, an
   explicit `operatorKind`, and zero expected versions. For a later window use a new packet ID,
   `mode: "reactivate"`, and the exact inactive admission/profile/Project-grant
   versions and generation recorded by the preceding revoke manifest and
   independent readback. Reactivation also requires the one exact inactive
   directory-grant row; there is no directory-grant version counter.

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
readback proving the active admission/profile/Project-grant versions and
generation plus the one exact active global directory grant. Do not record the
raw email or subject in release evidence.

Only then may separately approved acceptance windows enable the Directory-v2
bootstrap or joined Project-v2 route flag and the exact disposable PA
connection. The same signed-in owner must satisfy legacy administrator, global
`integrations.manage`, native identity equality, and the route-specific current
directory or Project grant check. Keep the two route flags in their reviewed
windows; provisioned authority is not permission to enable both routes at once.

## Normal revoke

1. Restore both acceptance-route flags and the selected PA connection to
   disabled and verify the deployed values.
2. Confirm no Project or Directory outbox command for this actor remains
   `pending` or `leased`, and no directory write fence for the actor remains.
   The revoke SQL independently rejects those states.
3. Apply only the generated revoke config:

```powershell
& '.\apps\client\node_modules\.bin\wrangler.cmd' d1 migrations list ltds-ops-staging --remote --config 'apps/operations/wrangler.staging.native-authority.<packet-id>.revoke.json'
& '.\apps\client\node_modules\.bin\wrangler.cmd' d1 migrations apply ltds-ops-staging --remote --config 'apps/operations/wrangler.staging.native-authority.<packet-id>.revoke.json'
```

The migration requires the provision filename in the auxiliary ledger, exact
active admission/profile/Project-grant versions, the exact Project grant
generation, the one exact active directory-grant row, and the unrevoked
provision approval. It deactivates both grants, increments the Project grant
version and generation, deactivates the admission and increments its version,
marks the provision approval revoked, and writes a separate immutable revocation
receipt. The profile and durable authority history remain. The inactive
directory row remains as the packet's durable authority identity; revoke never
uses destructive cleanup, and any surviving directory write fence makes it fail
closed. Existing native Project proofs cease to be live.

### Applied Directory-v2 packet evidence — September 19, 2026

The reviewed revocation packet for the bounded Directory-v2 acceptance window
was applied after the route was removed, the selected PA connection was
disabled, and no actor command, lease, or Directory write fence remained. Its
sanitized readback confirmed the inactive authority versions, Project-grant
generation `2`, and the immutable revocation receipt. The related accepted PA
command was `4349b923-d993-4022-9dce-50ef62a85d35`, with durable Operations
acknowledgement/mapping/audit evidence retained under
`staging-directory-acceptance-ff089045-ea88-4c34-90a5-2ef898b9142f`.

This is evidence of a closed Directory-v2 staging authority window only; it
does not establish a live Project-v2 authority window or production readiness.

List the revoke config again and require no pending migration. Record sanitized
readback of the inactive admission and both grants, incremented Project
generation, both immutable receipts, revoked provision approval, zero live
native Project proofs, and no pending/leased actor work in either outbox.

For an active compromise, apply the already-reviewed revoke packet first, then
disable both routes and the PA connection immediately. If any exact-version or
exact-directory-row guard fails, stop; investigate current state and generate a
new independently reviewed packet. Never weaken a predicate, delete a durable
row, restore an old D1 backup over later acceptance data, or fall back to raw
inserts/updates.
