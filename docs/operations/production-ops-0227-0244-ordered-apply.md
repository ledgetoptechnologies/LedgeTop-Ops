# Ordered Ops migrations 0227–0244

`scripts/production-ops-0227-0244-ordered-once.mjs` advances the Operations D1
ledger from exactly 226 rows (last `0226_staff_login_bindings.sql`) to 236 rows
through these ten files, in this order:

| # | file | ledger id |
|---|---|---|
| 1 | `0227_owner_intel_reads.sql` | 227 |
| 2 | `0228_competitor_intel_ingest.sql` | 228 |
| 3 | `0229_owner_intel_source_feed.sql` | 229 |
| 4 | `0230_app_release_pilot.sql` | 230 |
| 5 | `0231_owner_google_ads_summary.sql` | 231 |
| 6 | `0240_flight_logs_permissions.sql` | 232 |
| 7 | `0241_staff_usernames.sql` | 233 |
| 8 | `0242_native_staff_onboarding_approval_actor_authority.sql` | 234 |
| 9 | `0243_staff_logs_device_eligibility.sql` | 235 |
| 10 | `0244_staff_operations_access_writer.sql` | 236 |

Raw `wrangler d1 migrations apply --remote` is not an approved way to do this. It
applies every pending file without per-file checks. This tool applies each file
the way the 0226 one-shot did. It sends one D1 REST `/query` batch that holds the
file's pinned Wrangler wire statements followed by
`INSERT INTO d1_migrations(name) VALUES (?)`. The script pins each file's
SHA-256. It also pins the wire fixture
`scripts/fixtures/production-ops-0227-0244-wrangler-wire-statements.json`. Before
any remote call, the script checks the local bytes against both pins. To
re-derive the fixture offline, run
`node scripts/production-ops-0227-0244-wire-fixture.mjs`.

## What each run checks

A fresh run starts only from the exact observed production ledger: 226 rows, ids
1–226, a pinned names digest, and none of the ten files present. A ledger that
already contains any of the files is refused as `reconciliation-required`. Such a
ledger can only continue through reconcile and resume, described below.

Before **each** file, the tool takes a fresh read-only snapshot and checks the
following:

- The ledger count is right, the ledger tail is the previous file, and the
  earlier history is unchanged.
- None of the file's new objects exist yet (for 0240: no `flight_logs.*`
  permission).
- 0240: `role-owner` and `role-admin` exist.
- 0242: no onboarding is `claimed`. The global `staff.onboarding.approve`
  approver count is recorded.
- 0243: the three `staff_login_*` prerequisite tables exist.
- 0244: all 15 catalog permission keys exist. The native-hire override count is
  0, using the exact `staff_operations_access_native_hires` predicate.
  `native_staff_access_reconciliation.enabled` is 0. The five `staff_users`
  view columns exist. The native-hire count is recorded.

After each file, the tool re-reads the database and records a **readback** in
the receipt step. The readback holds the ledger count, the ledger tail (id and
name), and how many of the file's expected objects are present. It then checks
the following:

- The ledger tail is this file at the next id, and every expected object is
  present.
- Exactly one ledger row was appended, and the earlier rows are unchanged.
- Every earlier schema object is unchanged.
- The added objects exactly match the pinned list and digest.
- Each new table has exactly the pinned seed row count.
- For 0240: 2 permissions and 4 `role_permissions` rows exist.

After 0240, the tool prints and records this note: **recapture the post-0226
authority snapshot (role_permissions changed)**.

## Intentional authority changes

- **0240** grants `flight_logs.view` and `flight_logs.import` to `role-owner`
  and `role-admin`. It inserts the two `permissions` rows and four
  `role_permissions` rows, and the grants take effect immediately. This is the
  only change these ten files make to existing authority data. It invalidates any
  authority snapshot taken before 0240.
- **0242** adds four `BEFORE INSERT` triggers:
  - `native_staff_onboarding_approve_actor_allow` and
    `native_staff_onboarding_approve_actor_deny` on
    `native_staff_management_fences`;
  - `native_staff_onboarding_approve_receipt_actor_allow` and
    `native_staff_onboarding_approve_receipt_actor_deny` on
    `native_staff_management_commands`.

  From then on, an onboarding approval needs three things. The actor must hold
  an active global `staff.onboarding.approve` allow delegation (contract version
  1). The onboarding must be claimed (version 2) with an empty ACL proposal. The
  approver's subject must differ from the claimant's. A matching deny delegation
  blocks the approval. 0242 changes no rows.
- **0244** adds three guards on the existing `staff_permission_overrides` table
  for native hires. Applying it activates the Team Operations-access writer.

## Dry run (default)

```powershell
node scripts/production-ops-0227-0244-ordered-once.mjs --account-id <account> --database-id <uuid> --database-name <name> [--receipt <absolute path>]
```

The tool prints the ordered plan and checks the target against the D1 metadata
endpoint. It then takes one read-only snapshot and evaluates every preflight that
can be evaluated on the current state. The ledger checks for files 2–10 are
marked deferred. A dry run never writes. It can run against staging or against a
disposable D1 copy. The account can also come from `CLOUDFLARE_ACCOUNT_ID`. The
token is read only from `CLOUDFLARE_API_TOKEN`, as in the 0226 runbook. Never put
the token on the command line or in a file.

## Execute

```powershell
# production (the database pinned by the 0226 precedent)
node scripts/production-ops-0227-0244-ordered-once.mjs --execute --receipt <absolute path> --approval-ref <approval id> --account-id <account> --database-id <uuid> --database-name <name>
# rehearsal on a disposable copy
node scripts/production-ops-0227-0244-ordered-once.mjs --execute --rehearsal --receipt <absolute path> --account-id <account> --database-id <uuid> --database-name <name>
```

Execute mode works as follows:

1. It refuses an existing receipt path.
2. For the production database id, it requires two things:
   - `--approval-ref <id>`, the reference of the owner's production approval. The
     tool records it in the receipt and treats it only as a reference: it does
     not check it.
   - A clean `main` checkout that equals `origin/main`.
3. For any other database, it requires `--rehearsal`, and the approval reference
   is optional. `--rehearsal` refuses the production database.
4. It runs the full dry run first.
5. It waits for the typed confirmation `APPLY 0227-0244 TO <database-name>`.
6. It runs the ordered loop.

Exit codes:

- 0: complete, dry run passed, or reconciled.
- 1: stopped, refused, or reconciliation required.
- 2: cancelled.

## Receipt and stop behaviour

The receipt is a JSON file. The tool creates it exclusively and rewrites it in
full after every phase, so a stop always leaves a complete partial receipt. It
contains:

- the plan hash and the fixture hash;
- the target ids and the approval reference;
- `resumeFrom`, if the run resumed;
- the reconcile result;
- each file's hash and statement counts;
- each preflight check, with its expected and observed counts and timestamps;
- the apply start and finish times and the apply outcome;
- each readback and post-check result;
- notes;
- the final ledger: count, last name and names digest;
- the stop record, if the run stopped: step, phase and code.

It contains no token, no staff ids, emails or names, and no schema SQL. Only
counts, names and digests are recorded.

The tool stops at the first failed check or error and never continues. Each
apply step records one of these outcomes:

- `acknowledged`: D1 confirmed the batch, including the ledger row.
- `not-sent`: the provider refused before sending, for example because of a pin
  mismatch. The stop code is `apply_refused_before_send`.
- `ambiguous`: the request errored, timed out or returned an unparseable or
  unconfirmed response after it may have been sent. The run stops with status
  `reconciliation-required` and code
  `reconciliation_required:apply_ambiguous_no_retry`.

A failed read after an apply is treated the same way as an ambiguous apply. The
tool never retries a batch, and it never sends a file twice in one process.

## Reconcile and resume

After any stop past the first write, do **not** re-run plain `--execute`. It
refuses any ledger beyond 226. Reconcile first instead:

```powershell
node scripts/production-ops-0227-0244-ordered-once.mjs --reconcile --account-id <account> --database-id <uuid> --database-name <name> [--receipt <absolute path>]
```

Reconcile is read-only: it takes one snapshot and writes nothing. It proves the
following:

- The first 226 rows are the pinned prior ledger.
- The rows after them are exactly an ordered prefix of the ten files, with ids
  contiguous from 227.
- Every recorded file's objects exist exactly as pinned (names, types and SQL
  digest). For a recorded 0240, the 2 permissions and 4 role grants exist.
- No object of any unrecorded file exists. For an unrecorded 0240, there are no
  `flight_logs.*` permissions.

If all of this holds, the status is `reconciled` and the receipt names the exact
next step. Any other state is refused with status `reconciliation-required` and
the first failing check, for example:

- a gap, a reordered row or an extra row;
- a recorded file whose objects are missing;
- a partial object set for an unrecorded file.

That state needs a reviewed manual reconciliation; the tool cannot continue it.

To continue, pass exactly the reported next step:

```powershell
node scripts/production-ops-0227-0244-ordered-once.mjs --execute --resume-from <next file> --receipt <new absolute path> [--approval-ref <id> | --rehearsal] --account-id <account> --database-id <uuid> --database-name <name>
```

The resumed run re-proves everything before it asks for confirmation:

1. It reconciles again in the same run, and refuses unless the next step equals
   `--resume-from`. Files that are already recorded are never sent again.
2. It runs the dry-run preflight for the remaining files.
3. The execute pass itself re-reads and re-proves the prefix before its first
   write.

Use a new receipt path for every run.

## Rollback notes

None of the files has a down migration. These notes come from the release
research.

- **0227, 0228, 0229, 0231:** Code rollback leaves inert, empty tables, apart
  from controls seeded with `enabled=0`. A reverse migration drops the triggers
  first, then the tables in this order: Google Ads, source, ci_ingest,
  owner_intel. 0229 and 0231 add triggers on `ci_ingest_inbox` and
  `owner_intel_source_inbox`, so drop those triggers before the other lanes'
  tables.
- **0230:** Drop its triggers and tables. Its control is disabled, and it creates
  no eligibility.
- **0240:** The owner/admin `flight_logs.*` grants are effective immediately. To
  un-seed, delete the `role_permissions` rows for the two keys, then the two
  `permissions` rows. This is only safe if no override references the keys.
- **0241:** Drop the empty table.
- **0242:** Drop the four triggers. There is no data to remove.
- **0243:** Drop the seven triggers, then the eligibility table, then the
  commands table. Rows written after the apply are durable.
- **0244:** Applying the file activates the writer. A reverse migration drops the
  three `staff_permission_overrides` guards and the other triggers, then the two
  views, then the state, commands and catalog tables. Grants that the writer made
  remain ordinary override rows. Command rows are the audit trail, so dropping
  them loses provenance.

## Tests

```powershell
node --test scripts/production-ops-0227-0244-ordered-once.test.mjs
```

The tests are offline. The synthetic D1 is a local SQLite file built from this
repository's migrations 0001–0226.
