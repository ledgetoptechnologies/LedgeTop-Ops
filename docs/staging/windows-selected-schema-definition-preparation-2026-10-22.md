# Selected staging schema-definition diagnostic preparation

Source-only diagnostic based on drift report at `3389d192`. No remote command or
full local migration replay was run for this change. This does not authorize
migrations, normalize SQL, waive metadata differences, or establish semantic
equivalence or readiness.

The frozen allowlist contains exactly the reported missing/extra/changed object
identities: 41 Operations objects and 10 Client objects, including platform tables
and the staging marker. It is checked against retained report UTF-8 text after
explicit CRLF-to-LF normalization, with both checkout forms tested.
There is no user object filter, SQL, database, account or output-path argument.

`windowsFilesStagingSchemaDiagnostic({readOnly:true})` is a separate exported
preparation API in the existing preflight module, with no executable CLI flag.
The existing CLI, npm command and ordinary preflight retain their no-SQL-export
contract. Even passing `selectedDiagnostic:true` to the ordinary public function
cannot enable the separate diagnostic.

It uses the existing installed Wrangler helper with its fixed staging account and
owned config, and the same current deployment, origin, Access and resource
validation. **Both** Workers must pass those guards before either D1 read. It
then issues exactly one fixed query per database:

```text
d1 execute ltds-ops-staging --remote --command <frozen sqlite_master SELECT> --json
d1 execute client-data-staging --remote --command <frozen sqlite_master SELECT> --json
```

Each SELECT projects only `type,name,tbl_name,sql` from `sqlite_master`, matching
the complete frozen identity triples and using a bounded LIMIT. There are no
application-row, restore, export or write commands. Unknown rows/keys, duplicates,
SQL over 128 KiB per object or 1 MiB per app, and oversized/non-JSON provider
output fail closed. Provider errors are sanitized by the existing helper.

Raw DDL is retained only in `selected-definitions.json` inside a newly created
`ops-windows-ddl-review-*` directory under local temporary storage. Creation is
exclusive; `mode:0600` applies where the OS honors it, and existing user-temp
directory permissions apply on Windows. No certificate, account, or filesystem
permission changes are made. Review this file locally; do not upload it to
GitHub, EH, public logs or a chat. The safe result contains the local file path,
hashes, exact object identities, absent identities and validated Worker metadata,
but no SQL. Temporary owned config files are removed. The raw review file remains
for the operator to inspect and remove explicitly.

For local expected definitions, the canonical generator accepts an optional
`selectedDefinitionObserver` function only with `baselineOnly:true`. It receives
one copied/frozen selected-row collection per app after checkpoint hashes have
been computed. It receives no database handle, source array or mutable reference
to the returned canonical result. Default generator output and CLI contain no
raw SQL. Callback failures become a fixed error code. This allows one separately
reviewed baseline-only local replay to save selected expected DDL for comparison;
this change does not start that replay.

After immutable review, the root operator can call the paired read API once and
serialize only its returned safe result. Do not serialize internal captures.
For the separate single local replay, the narrow composition is:

```js
const captures = [];
const reference = await generateWindowsCanonicalBaseline({
  baselineOnly: true,
  selectedDefinitionObserver: observation => { captures.push(observation); }
});
const localReview = await retainDefinitionReviewFile(captures);
// reference and localReview contain hashes/metadata, not the selected raw SQL.
// captures remain in process memory and the owned localReview file only.
```

These are library API examples, not an executable release script. Only the fixed
diagnostic errors should be printed on failure; never print captured row objects
or raw underlying provider/process errors. The remote helper already sanitizes
provider failures before the diagnostic sees them.

Raw definitions support human attribution of formatting, SQLite rewrite or actual
DDL differences. Hash equality or a formatting explanation does not prove
historical execution or data effects. Observations remain non-atomic. Existing
fingerprint mismatches and release gates stay unresolved until reviewed evidence
addresses them.

Local focused command:

```text
node --test scripts/windows-files-staging-preflight.test.mjs scripts/windows-files-schema-definition-diagnostic.test.mjs
```

Tests use synthetic provider output only, verify the exact query/identity
allowlist and both-Worker guards, reject user overrides and malformed responses,
inspect an owned synthetic local review file, remove that test-owned file, and
assert no raw SQL appears in safe results. No remote invocation occurs.

References: [Wrangler D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/)
and [D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/).
