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

**The batch is not assumed to be atomic.** The 0226 precedent does not assume
it, and nothing in this repository proves that a D1 `/query` batch rolls back as
a unit. A failed or ambiguous apply can therefore leave some of a file's tables,
triggers or views in place with no ledger row. Reconcile detects that partial
state and refuses to continue (see below), and the offline tests model it with a
synthetic D1 that applies statements one by one.

Each snapshot is one read-only `/query` batch of two SELECTs:

1. One JSON value holding the ledger, the probe counts and the row counts.
2. The schema objects (`type`, `name`, `tbl_name`, `sql`) as ordinary rows.

The schema is not folded into one value, because the full Ops schema SQL is
about 2.7 MB as a single value, above D1's roughly 2 MB per-value limit. Every
receipt phase records `snapshotBytes`, which is the largest single returned
value, about 20 KB on the synthetic chain. The receipt gets a note if this ever
exceeds 1.5 MB.

**Scope:** this tool and this change cover the Operations database only. The
Client sections of the shared release profiles (`append-plan.json`,
`reconciliation-manifest.json`) are unchanged from main. The Client append and
its ordering have their own owner and are out of scope here. The tool refuses
the Client production database id in every mode.

## Approved production schema

On the production database the tool requires one exact existing schema: the 2472
objects that none of the ten files creates, with digest
`b05eb4958761549c7112518856970c010fe408dfb355d40d262595e012ab4e9b`
(`OPS_PRODUCTION_EXISTING_SCHEMA`). Any other value stops the run with zero
writes.

- It is the schema observed in production on 2026-11-05 and recorded in
  `installed-schema-preservation-v1/profile.json`. That profile hashes the same
  rows in another form (`8e522095...`).
- It is not the schema built from source (`e62e9bfe...`, 2465 objects).
  Production also has seven objects that no numbered migration creates: the
  auxiliary `production_native_authority_migrations` ledger, and two receipt
  tables with two triggers each. They are kept as they are. Never drop or
  normalise them to make a digest match.
- Production is recognised by its database id, not by a label or a flag. No
  command line option, receipt or environment variable can change the value. A
  new value needs a reviewed source change.

The check runs in every mode:

- **Dry run:** stops with `approved_existing_schema_mismatch`.
- **Execute:** refused before the confirmation prompt, checked again on a fresh
  read after the prompt, and checked again before each file
  (`preflight_failed:approved_existing_schema`).
- **Reconcile and resume:** refused with
  `reconciliation_required:approved_existing_schema_mismatch`, independently of
  the baseline receipt. A production baseline receipt that holds any other
  `existingSchema` is refused with `baseline_receipt_existing_schema_not_approved`.

The receipt records `approvedExistingSchema` with the expected and observed count
and digest. A change between a read and the write that follows it cannot be
excluded, so the post-check still compares the schema after each file. Rehearsals
on other databases do not use the production value.

## What each run checks

A fresh run starts only from the exact observed production ledger: 226 rows, ids
1–226, a pinned names digest, and none of the ten files present. A ledger that
already contains any of the files is refused as `reconciliation-required`. Such a
ledger can only continue through reconcile and resume, described below.

Before **each** file, the tool takes a fresh read-only snapshot and checks the
following:

- The ledger count is right, the ledger tail is the previous file, and the
  earlier history is unchanged.
- The `d1_migrations` AUTOINCREMENT sequence (`sqlite_sequence`) equals the
  last ledger id. A sequence ahead of the ledger would give the new row a
  skipped id.
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
- Row counts of the existing authority tables:
  - `roles`: unchanged.
  - `permissions`: unchanged, except exactly +2 for 0240.
  - `role_permissions`: unchanged, except +1 to +4 for 0240 (+4 when both
    roles exist).
  - `staff_users` and `staff_permission_overrides`: unchanged since the start
    of the run.
  - For 0244: the catalog holds exactly 15 rows.

  The tool records per-step deltas and the start and final counts. These are
  counts only, never row contents. A live staff or override change during the
  run therefore stops it after that file's write. Plan the run in a quiet window.

After 0240, the tool prints and records this note: **recapture the post-0226
authority snapshot (role_permissions changed)**. After 0244 it records a matching
note, because 0244 adds the override guards and the catalog seed.

### After a complete apply

- Recapture the post-0226 ordinary-frontend authority packet. Both 0240 and 0244
  change its base.
- Recapture the installed-schema-preservation profile. It describes ledger 226
  with ten files pending, so it no longer matches.
- Refresh the Ops section of the append plan for the 236-row base.

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
- 1: stopped, refused, or reconciliation required. Also a run that ends without
  settling, which prints `ops_0227_0244:command_line_unsettled`.
- 2: cancelled.

## Receipt and stop behaviour

The receipt is a JSON file. The tool creates it exclusively and rewrites it in
full after every phase, so a stop always leaves a complete partial receipt. Each
rewrite goes to `<receipt>.next` first and replaces the receipt only when it is
proven, so the last complete receipt stays in place. Before the first file is
sent, an execute run also saves `<receipt>.pre-apply.json` once: the proven
starting point, with the start counts, the schema digest and the ledger. An
error before the ordered run starts (for example a missing token, or a failed
target check) is recorded as `refused`, phase `command-line`, with zero writes.
A process that is killed, or ends without settling, leaves its last saved receipt
(empty if there was none yet), perhaps with a `.next` file beside it. The receipt
contains:

- the plan hash and the fixture hash;
- the target ids and the approval reference;
- `resumeFrom`, if the run resumed;
- the reconcile result;
- `rowCounts.start` and `existingSchema`: the start counts, and the object count
  and digest of every schema object that the ten files do not create. A resumed
  run carries both forward from its baseline receipt;
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

## When the receipt cannot be saved

A receipt write counts only after every byte is written to `<receipt>.next`,
flushed, closed and read back equal, the file has replaced the receipt, the folder
has been flushed (not on Windows, which has no way to), and the receipt has been
read back equal. After a failure the process never writes that
receipt again, and nothing is tried again. On Windows a receipt that another
program holds open cannot be replaced, and that is such a failure: do not open the
receipt files during a run. The previous complete receipt normally stays in place,
and
`.next` holds whatever was written. A receipt that was not saved is never
reported as a success: the exit code is 1, whatever the run reached, and stderr
has its own line.

| What failed | stdout summary | stderr | Exit |
|---|---|---|---|
| A receipt write in the ordered run, before any file was sent in this run | `stopped`, `receipt_write_failed` | `ops_0227_0244:receipt_write_failed` | 1 |
| A receipt write in the ordered run, after a file was sent | `reconciliation-required`, `reconciliation_required:receipt_write_failed`, with `writesPerformed` | `ops_0227_0244:receipt_write_failed` | 1 |
| A receipt write after the run had already stopped | the stop's own status and code | `ops_0227_0244:receipt_write_failed` | 1 |
| The receipt of a refusal or a cancelled run | the refusal's own status and code | `ops_0227_0244:refusal_receipt_write_failed` | 1 |
| The receipt of an error | none | the error, then `ops_0227_0244:refusal_receipt_write_failed` | 1 |

A result or an error whose receipt cannot be closed would add
`ops_0227_0244:receipt_close_failed` in the same way. The file receipt holds
nothing open between writes, so it does not raise it.

The run stops at the failure: no later file is read or sent. After a file was
sent, the database holds at least the confirmed files (`writesPerformed`), and the
saved receipt is the one from before the failed write: it may still say
`sending` for a file that landed. That includes a failure on the last write of a
run that reached 236. Do not retry. The exit code and stderr decide, not the
file. If only the last check after the replacement failed, the receipt can be
newer, even `complete`.

An unfinished receipt (status `running`) is not accepted as a baseline. The
pre-apply receipt is accepted only while the ledger is still where it was before
the first file. Any later state needs a reviewed manual reconciliation from a
read-only look at the ledger and schema.

## Reconcile and resume

After any stop past the first write, do **not** re-run plain `--execute`. It
refuses any ledger beyond 226. Reconcile first instead, passing the receipt of
the run that stopped as the baseline:

```powershell
node scripts/production-ops-0227-0244-ordered-once.mjs --reconcile --baseline-receipt <stopped run's receipt> --account-id <account> --database-id <uuid> --database-name <name> [--receipt <new absolute path>]
```

After an **ambiguous** stop, do not reconcile at once. A request whose response
was lost may still be finishing on the D1 side. Wait several minutes, then run
reconcile **twice**, a few minutes apart, and continue only if both runs report
the same ledger count, the same next step and the same checks. If they differ,
something is still changing: stop and investigate.

Reconcile is read-only: it takes one snapshot and writes nothing. Every
reconcile result and every refusal states the ledger count and the expected
next file, for example
`ledger has 229 rows ending 0229_owner_intel_source_feed.sql; expected next file 0230_app_release_pilot.sql`.
It proves the following:

- The first 226 rows are the pinned prior ledger.
- The rows after them are exactly an ordered prefix of the ten files, with ids
  contiguous from 227.
- Every recorded file's objects exist exactly as pinned (names, types and SQL
  digest). For a recorded 0240, the 2 permissions and 4 role grants exist.
- No object of any unrecorded file exists. For an unrecorded 0240, there are no
  `flight_logs.*` permissions.
- When at least one file is recorded, the row counts still hold against the start
  counts in the baseline receipt:
  - `roles`, `staff_users` and `staff_permission_overrides` are unchanged;
  - `permissions` is the start count plus 2 if 0240 is recorded;
  - `role_permissions` is the start count plus the 0240 grants (4) if 0240 is
    recorded.

  The receipt lists every differing count with its expected and observed values.
  Without a baseline receipt, reconcile refuses with
  `baseline_receipt_required`. A baseline receipt for another plan or database
  is refused.
- The baseline receipt did not stop on a failed post-check. A post-check failure
  (`reconciliation_required:postcheck_failed`, including a row-count delta
  mismatch) means a write was acknowledged but the state is not as pinned. Such
  a stop always needs a reviewed manual reconciliation, and reconcile refuses it
  with `baseline_receipt_postcheck_failed`.
- The baseline is the **latest** receipt. Its recorded final ledger (count and
  tail) must equal the current ledger. After an ambiguous apply or a failed
  post-apply read, the current ledger may also hold one more row: the row of the
  file that receipt stopped on. An older receipt is refused with
  `baseline_receipt_not_latest`. This stops an older receipt from bypassing a
  later `postcheck_failed` stop.
- Every schema object that the ten files do not create (type, name, table and
  SQL) still matches the digest recorded at the 226 start. A change is refused
  with `existing_schema_changed`, and the receipt states the expected and
  observed object counts and digests. This also covers one edge case: after an
  ambiguous stop on file k that did not land, a resumed run applies file k and
  then fails its post-check. The older receipt's ambiguity allowance accepts a
  ledger ending at file k. Reconcile with that older receipt is still refused if
  the state differs from the pin, because it re-verifies the objects, the seeds,
  the counts and this digest.
- Every recorded file's seeded rows are still exactly the pinned seed: one
  control row each for 0227, 0229, 0230 and 0231, and 15 catalog rows for 0244.

If all of this holds, the status is `reconciled` and the receipt names the exact
next step. Any other state is refused with status `reconciliation-required` and
the first failing check, for example:

- a gap, a reordered row or an extra row;
- a recorded file whose objects are missing;
- a partial object set for an unrecorded file;
- a row count that differs from the start counts plus the expected deltas;
- an earlier post-check failure, or a baseline receipt that is not the latest;
- a seeded control or catalog row count that differs from the pin.

**Receipts are evidence. Never edit, rewrite or hand-craft a receipt** to get past
a refusal. Ordinary staff activity can change the `staff_users` or
`staff_permission_overrides` counts between runs, for example a new staff
account or a granted override. Resuming after that needs a separately reviewed
manual reconciliation. The tool intentionally has no option to accept new
counts.

That state needs a reviewed manual reconciliation; the tool cannot continue it.
For a partial file, list its objects read-only before deciding, for example for
0231:

```sql
SELECT type, name, tbl_name FROM sqlite_master
WHERE name GLOB 'owner_intel_google_ads_*'
   OR name IN ('owner_intel_source_no_google_ads_operation', 'owner_intel_v1_no_google_ads_operation')
ORDER BY type, name;
```

The two named triggers belong to 0231 but sit on the earlier
`owner_intel_source_inbox` and `ci_ingest_inbox` tables.

The exact names of each file's objects are in the fixture's
`expectedAddedObjects`.

To continue, pass exactly the reported next step:

```powershell
node scripts/production-ops-0227-0244-ordered-once.mjs --execute --resume-from <next file> --baseline-receipt <stopped run's receipt> --receipt <new absolute path> [--approval-ref <id> | --rehearsal] --account-id <account> --database-id <uuid> --database-name <name>
```

The resumed run re-proves everything before it asks for confirmation:

1. It reconciles again in the same run, and refuses unless the next step equals
   `--resume-from`. Files that are already recorded are never sent again.
2. It runs the dry-run preflight for the remaining files.
3. The execute pass itself re-reads and re-proves the prefix before its first
   write.

Use a new receipt path for every run. A resumed run's receipt carries the
original start counts forward, so it can serve as the baseline for a later
resume.

## Rollback notes

None of the files has a down migration. These notes come from the release
research. A manual reverse migration must also delete that file's
`d1_migrations` row (`DELETE FROM d1_migrations WHERE name='<file>'`), or the
ledger gates and this tool's reconcile will refuse the state. Delete the rows
from the latest file backwards.

Deleting a ledger row does not lower the `d1_migrations` AUTOINCREMENT sequence.
After a rollback, the `sqlite_sequence` preflight therefore refuses to re-apply
the file, because the next id would skip a number. This is by design. Re-applying
after a rollback is a separate, reviewed decision, and it needs a new reviewed
tool or plan.

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
  remain ordinary override rows. While the guards exist, a native hire's override
  rows can be removed only by a revoke command. They can be removed directly only
  after the three guards are dropped. Command rows are the audit trail, so
  dropping them loses provenance.

## Rehearsal profile: copied-226

The QA rehearsal starts from a disposable database at exactly ledger 226. Its
pins are committed in `scripts/fixtures/production-ops-copied-226-profile.json`.
The builder and verifier is
`scripts/production-ops-0227-0244-copied-226-fixture.mjs`. Neither contacts
Cloudflare.

### What is pinned

- **Ordered files.** `migrations` lists the 226 files `0001_operations.sql` to
  `0226_staff_login_bindings.sql` from `apps/operations/migrations`, in order,
  with ledger id and source SHA-256. `migrationsContentsSha256` covers the whole
  list.
- **Ledger at 226.** There are 226 contiguous rows ending at
  `0226_staff_login_bindings.sql`, and `sqlite_sequence` for `d1_migrations` is
  226. `namesSha256` is the same value as the operator's prior-ledger pin.
- **Schema at 226.** `schema` is the object count and SHA-256 of every
  `sqlite_master` row with SQL, excluding `sqlite_*` and `_cf_*`. This uses the
  operator's own schema-row query and digest. At 226 none of the ten files'
  objects exist, so `existingSchema` equals `schema`.
- **Preflight values.** `probes` are the operator's probe values on the built
  copy. `requiredProbes` are the values every 0244 preflight needs:
  - 15 catalog permission keys;
  - 0 native-hire override rows and 0 native hires;
  - one native switch row, set to off;
  - two owner/admin roles;
  - no `flight_logs.*` permissions yet;
  - the three staff-login tables and the five `staff_users` columns.
- **Seed rows.** None are needed beyond what migrations 0001–0226 seed
  themselves. The 15 catalog keys, the owner/admin roles and the disabled switch
  row come from the migrations. `staff_permission_overrides` and native
  onboarding are empty.

### Commands

From the repository root, with dependencies installed:

```powershell
node scripts/production-ops-0227-0244-copied-226-fixture.mjs --build "$env:TEMP\ops-rehearsal\copied-226.sqlite"
```

`--build` checks each of the 226 source files against its pinned SHA-256 first.
It builds the copy in its own scratch folder next to the target, applying the
files with the same Wrangler splitter the operator uses, and verifies it there
against the pins. Only a copy that passes is published, as a hard link that
fails if anything already exists at the target. The builder never opens or
overwrites the target path, even when another process creates that file
during the build. The scratch folder is always removed. It prints `ok`,
`published` and any mismatches, and exits 1 on a mismatch.

```powershell
node scripts/production-ops-0227-0244-copied-226-fixture.mjs --verify "$env:TEMP\ops-rehearsal\copied-226.sqlite"
```

`--verify` checks any existing SQLite file read-only against the same pins.

```powershell
node scripts/production-ops-0227-0244-copied-226-fixture.mjs
```

With no flag, it re-derives the pins and compares them with the committed file.
`--write` regenerates the file. Regenerate only together with a reviewed change
to migrations 0001–0226.

### Comparing with production

The pinned schema digest comes from the source files. It is not a reading of
production, and production is known to differ from it (see "Approved production
schema" above). The copied-226 store is therefore not production's exact shape.
Do not adjust this pin to match production.

## Tests

```powershell
node --test scripts/production-ops-0227-0244-ordered-once.test.mjs
```

```powershell
node --test scripts/production-ops-0227-0244-cli-entry.test.mjs
```

```powershell
node --test scripts/production-ops-0227-0244-copied-226-fixture.test.mjs
```

The command-line tests start the real command as a child process with the real
provider and a fake token. A preload records and refuses every network attempt,
or answers Cloudflare requests from a local SQLite file. They need no npm
dependencies, except the cases inside the ordered-once test file.

The tests are offline. One test is skipped unless
`OPS_0227_0244_PRODUCTION_SHAPED_SQLITE` names a private production-shaped 226
store. That store holds raw production definitions, so it is never committed. The synthetic D1 is a local SQLite file built from this
repository's migrations 0001–0226. The copied-226 tests also run the
operator's dry run against the built copy, and it passes every preflight
without writing.
