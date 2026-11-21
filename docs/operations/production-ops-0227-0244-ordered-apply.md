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

Before any write, the ledger must be exactly the observed production ledger: 226
rows, ids 1–226, a pinned names digest, and none of the ten files present. There
is no partial resume. A ledger that already contains any of these files is
refused.

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

After each file, the tool checks the following:

- Exactly one ledger row was appended, with the next id and this file's name.
- Every earlier schema object is unchanged.
- The added objects exactly match the pinned list and digest.
- Each new table has exactly the pinned seed row count.
- For 0240: 2 permissions and 4 `role_permissions` rows exist.

After 0240, the tool prints and records this note: **recapture the post-0226
authority snapshot (role_permissions changed)**.

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
node scripts/production-ops-0227-0244-ordered-once.mjs --execute --receipt <absolute path> --account-id <account> --database-id <uuid> --database-name <name>
```

Execute mode works as follows:

1. It refuses an existing receipt path.
2. For the production database that the 0226 precedent already pins, it requires
   a clean `main` checkout that equals `origin/main`.
3. For any other database, it requires `--rehearsal`. `--rehearsal` refuses the
   production database.
4. It runs the full dry run first.
5. It waits for the typed confirmation `APPLY 0227-0244 TO <database-name>`.
6. It runs the ordered loop.

Exit codes:

- 0: complete, or the dry run passed.
- 1: stopped or refused.
- 2: cancelled.

## Receipt and stop behaviour

The receipt is a JSON file. The tool creates it exclusively and rewrites it in
full after every phase, so a stop always leaves a complete partial receipt. It
contains:

- the plan hash and the fixture hash;
- the target ids;
- each file's hash and statement counts;
- each preflight check, with its expected and observed counts and timestamps;
- the apply start and finish times;
- each post-check result;
- notes;
- the final ledger: count, last name and names digest;
- the stop record, if the run stopped: step, phase and code.

It contains no token, no staff ids, emails or names, and no schema SQL. Only
counts, names and digests are recorded.

The tool stops at the first failed check or error and never continues. An apply
error is recorded as `apply_failed_outcome_unknown_no_retry`. Do **not** re-run
the tool to "finish" the plan. It refuses any ledger other than the exact 226-row
start. Reconcile `d1_migrations` and `sqlite_master` with read-only queries, then
decide on a reviewed follow-up.

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
