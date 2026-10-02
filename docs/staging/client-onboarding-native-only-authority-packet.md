# Client onboarding native-only authority packet

Status: **local validation and live synthetic provision/revoke rehearsal passed**.
The replaced initial draft failed its seven tests. The schema-version-2
replacement passed 26 tests against the complete current 165-migration schema,
including failures after a real grant write and trigger-generated history.
The live rehearsal temporarily issued and then revoked exactly the two approved
synthetic-area grants. This is not evidence of full live portal acceptance.

This staging-only packet adds exactly two Directory allows to an already active, verified native operator:
`directory.profile.edit` and `directory.identity.link`, both restricted to one reviewed synthetic business area.
It does not create or modify an admission, profile, role, membership, client, Project Alpha record, public link, or production setting.

The schema-version-2 values file is a reviewed snapshot, not a lookup request.
It contains the exact `STAGING_TARGET`, complete snake-case `SELECT *` rows for
`admission`, `profile`, `generation`, and `businessArea`, all `grants` and
`history` rows for that staff member, a bounded `approval`, and `priorProvision`.
The business-area ID must be explicitly selected and start with
`staging-native-only-`; the packet does not create the area. Deterministic grant
IDs are derived with `nativeOnlyGrantIds(staffId, businessAreaId, approvalId)`.
`priorProvision` is null for provision and contains the exact original immutable
approval and receipt for revoke.

The compiler pins all 165 migration names and source-content hashes. The
transaction verifies exact applied-migration name equality, full native
admission/profile/generation rows, and complete per-staff grant/history sets in
both directions. Prior grant rows and the entire history prefix are unchanged.
Only the two expected suffix rows may be appended, with exact identity,
permission, scope, active state, versions, and sequential generation; timestamps
are canonical server-generated values bounded by execution time and tied to
the final generation timestamp. Extra, missing, denied, conflicting, stale, or
active-work state makes the transaction fail.

Generate a review artifact with:

```text
node scripts/staging-onboarding-native-only-authority-packet.mjs --values .backups/staging-onboarding-native-only-authority.json
```

The compiler script never invokes Wrangler and cannot apply remotely. Application is available only through the exported
`applyNativeOnlyAuthorityPacket(db, packet, {target: STAGING_TARGET})` helper,
which recompiles and compares the entire packet before submitting every guard,
approval, mutation, receipt, and postcondition in one `D1.batch`.
The trusted out-of-band runner must obtain the target identity from the actual
configured staging binding, not a caller-supplied label. No Worker HTTP route
may issue bootstrap approvals. The module-only remote runner is
`scripts/staging-native-authority-binding-runner.mjs`; do not use
sequential CLI statements or assume a REST multi-query has identical atomicity.
Failed guards evaluate malformed JSON and raise an SQL error; zero-row CAS
operations also raise. Both pre- and post-write expiration checks use DB time.
Approval windows are at most four hours, and execution must begin within five
minutes of the reviewed execution timestamp.

Provision and revoke use distinct immutable approvals and receipts. Revoke also marks the paired provision approval revoked and deactivates only the
two deterministic packet grant IDs. Existing admissions, profiles, and all pre-existing grants remain unchanged. Re-read the full authority state and
compile a fresh revoke packet immediately before revocation; never reuse an old readback.

Revoke requires the exact original provision ledger and receipt, the same
admission/profile identity, and unmodified version-1 active packet grants.
If these changed, stop and review rather than weakening the guard. Durable
approval/receipt/history rows are retained; revocation never deletes them.

Local evidence: `node --test --test-reporter=spec
scripts/staging-onboarding-native-only-authority-packet.test.mjs` passed 26 tests
in 148.47 seconds on 2026-10-02, including the post-write expiry guard. The fixture applies the actual complete migration
chain once using the locked Wrangler SQL splitter and real Miniflare D1.
Cases include replay after revoke, exact prior-state preservation, fresh deny,
active work, stale identities/timestamps, extra/missing grants, applied-ledger
drift, altered packet/target/IDs, unpaired revoke, post-write abort, skipped grant
insert, and postcondition corruption. All local fixtures are disposed in finally.

Independent review reran the initial 18 tests successfully and confirmed the SQL
placeholder ordering, evaluated failure guards, paired receipt checks, and
full prior-state preservation. The expanded 26-test run additionally covers
both actor and target branches of management/admin fences, pending and leased
Project/Directory outbox rejection, terminal outbox acceptance, and a
trigger-injected post-write active-work fence with complete rollback.

Before the live rehearsal, read-only staging inspection on 2026-10-02 confirmed 165 applied migrations and
zero `staging-native-only-` business areas. The dedicated binding configuration
contains only the pinned staging account, Worker name, and `OPS_DB` database;
no production resources or application secrets. A synthetic area had to be
explicitly selected and created before provision. No staging grant was issued
by this inspection.

The runner passed 19 local tests and its live read-only status check returned
the expected staging database with 165 migrations ending at `0165`. Its CLI is
read-only; writes are available only through the reviewed module helper. It
validates the complete minimal regular JSON configuration before and after
opening Wrangler's remote binding, refuses extra/production resources, suppresses
environment-file loading, and disposes the proxy in `finally`. The actual
configured account/name/database/binding establish the trusted target rather
than accepting a caller-supplied staging label. No Worker application code or
public approval endpoint is deployed by this runner.

```text
node scripts/staging-native-authority-binding-runner.mjs status --config apps/operations/wrangler.staging.native-authority-binding.json
```

The configuration is ignored by Git and contains no secrets. Wrangler uses the
existing configured OAuth login; do not copy credential files into artifacts.
Remote binding behavior and transactional batch semantics were checked against
[Wrangler's API documentation](https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy)
and [D1's batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).

## Live synthetic rehearsal — 2026-10-02

- `scripts/staging-native-authority-packet-rehearsal.test.mjs`: 12 tests passed,
  including durable recovery, lost responses, evidence-write failure, and
  unsafe artifact paths. Independent review found no code blocker.
- Fixed synthetic scope: `staging-native-only-portal-acceptance-20261002`.
- Provision issued exactly two business-area allows; paired revoke deactivated
  exactly those two rows. Prior admission/profile/grants/history were preserved.
- Full readback verified cleanup. A subsequent `--recover` returned
  `already-revoked` and `cleanupVerified: true`; authority was not restored.
- Private evidence is retained under ignored `.backups/staging-native-authority/`
  in approval directory `ee1e8419-ea40-4680-bd20-1d20c64dc256`. Never publish the
  raw identity snapshots or canonical approval/receipt payloads.
- Durable ledger/history rows and the synthetic business-area fixture remain;
  no active packet grants remain. No production resources, clients, public
  links, or portal enrollment were changed.

Provision evidence must be safely saved before mutation. Later evidence-write
failures cannot block revoke. If transport or current-state verification fails,
recover from the exact existing `provision.json`; do not start a fresh packet
or relax the state guards. Recovery preserves the original IDs, reads exact
immutable paired receipts, and uses fresh database-clock timestamps.

```text
node scripts/staging-native-authority-packet-rehearsal.mjs --config apps/operations/wrangler.staging.native-authority-binding.json --confirm-synthetic-provision-and-paired-revoke
node scripts/staging-native-authority-packet-rehearsal.mjs --config apps/operations/wrangler.staging.native-authority-binding.json --recover .backups/staging-native-authority/<approval-id>/provision.json
```

The standalone rehearsal does not retain permissions for portal use. A live
onboarding acceptance window must use a separately reviewed provision/paired
revoke around the actual UI flow; do not claim the rehearsal creates clients.

## Native folder acceptance follow-up

- The local owner UI now loads an authorized shared-project folder proof rather
  than asking the operator to enter confirmation identity or timestamps.
- Confirmation and folder publication remain separate actions. These changes
  do not activate a recipient or alter an existing public link.
- A retained uncertain folder request is checked against every visible folder
  field and the publication revision/reason before retry. Switching projects
  cannot silently replay a request for the previous project.
- Focused owner HTTP and workspace/folder retry regressions passed 26/26, and
  client API regressions passed 5/5. The six real-D1 folder service cases passed
  against the complete canonical chain through migration 0165. The Operations
  TypeScript check and local build passed. Independent review found no remaining
  code blocker after old-division authority, monotonic confirmation and retry
  selection fixes. The build reported its existing large-client-chunk warning.
- Final independent root run passed all 37 cases together across four files in
  52.67 seconds. An earlier combined run exposed a test-only CSRF corruption
  that could accidentally equal the original token; the fixture now guarantees
  a different valid-format token. Runtime CSRF checks were not changed.
- Full live portal acceptance and production readiness are not yet established.
  Latest-chain local execution does not replace signed-in staging acceptance.
- Remote publication of the new scripts and evidence documentation is awaiting
  explicit approval because the repository may be public and the payload includes
  internal staging identifiers and non-secret rehearsal metadata. Raw private
  evidence, credentials, and identity snapshots must remain excluded.
