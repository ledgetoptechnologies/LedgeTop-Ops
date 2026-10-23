# Selected DDL lexical attribution helper

`attributeSelectedDdl(app, expectedRows, observedRows)` accepts in-memory local
reviewed captures restricted to the existing frozen selected-object allowlist.
It has no path, network, database, SQL execution or migration interface. It adds
no raw capture, normalization, baseline verification or release authorization.

The safe output contains selected object identities, presence flags, exact
SHA256 hashes, category counts and these categories:

| Category | What it records |
| --- | --- |
| `exact_sql_bytes` | The two SQL strings, or two explicit null SQL values, match exactly. |
| `whitespace_outside_quoted_tokens_only` | Complete lexical token sequences match exactly after ignoring only SQLite whitespace between tokens. |
| `identifier_quoting_only_candidate` | Token spelling matches after decoding identifier quotes; this is a lexical candidate, not parser meaning. |
| `unresolved_token_or_structure_difference` | Other token/structural differences, absent definitions, malformed or unsupported lexical forms. |

Quoted string literals, quoted contents and comments are preserved exactly.
Single/double/backtick doubled quotes are recognized; bracket identifiers end at
the first closing bracket. Comments do not nest. A line comment includes its
terminating newline, so changing that boundary cannot hide active SQL. Blob
literal adjacency and multi-character operator boundaries are preserved. Keyword
case, comment changes and numeric spellings are not normalized. Unsupported
forms and token-count overflow stay unresolved. This is a conservative
attribution lexer, not a full SQLite parser.

SQLite has historical exceptions that can interpret single-quoted tokens as
identifiers or double-quoted tokens as literals depending on context. Therefore
even the identifier-quoting category cannot establish semantic equivalence.
`canonicalBaselineVerified` and `semanticEquivalenceEstablished` stay false for
every result. Exact textual equality also cannot prove historical migration or
data effects. No mismatches are waived or converted into readiness.

No raw SQL, literal fragments, comment content or token arrays leave the helper.
Input validation uses the existing per-object/app byte limits and strict object
identity validation. The helper adds a bounded token count. There is no CLI and
no filesystem or remote invocation in the tests.

## Additional reasons for coarse unresolved results

The four original categories remain unchanged. An unresolved object may now carry
`residualAttribution` containing only a reason enum, changed token-kind names, bounded counts per token kind,
non-comment token counts, and booleans indicating whether complete literal/blob
or comment token sequences differ. Values, excerpts, positions and token arrays
are never returned. Numeric tokens have their own count kind; the literal-sequence
boolean specifically describes quoted-string/blob tokens, not all SQL values.

Reasons distinguish definition presence/null SQL, unsupported lexical forms,
comment-token-only changes, unquoted ASCII word-case-only candidates, combined
comment/word-case candidates, and other non-comment token differences. Comments
are filtered **after** tokenization, preserving surrounding token boundaries:
`a/**/b` is never collapsed into the single token `ab`. Case folding is limited to
ASCII unquoted word tokens; literals, quoted identifiers, numbers and blobs stay
exact. This additional attribution never changes the coarse unresolved category
or either false verification flag.

The safe residual report
`windows-selected-schema-residual-attribution-2026-10-22.json` records an actual
bounded in-memory comparison of the two root-approved private capture files.
Their exact SHA256 hashes were verified before parsing. Only safe results were
written; no raw definitions were printed or copied to source, chat, logs or EH.
Three of the six shared application definitions have comment-token-only changes;
three still have non-comment token differences. One of those three also changes
the quoted-string/blob token sequence. No word-case-only case was observed.
This is evidence for further source/lineage review, not semantic equivalence,
historical migration proof, a metadata waiver or migration authorization.

## Three-identity RAISE syntax hypothesis

A separate `syntaxRelation` is considered only for these exact reviewed trigger
identities: Operations `native_staff_onboarding_approve_finish`, Operations
`operations_directory_audit_original_subject_required`, and Client
`client_folder_notification_batch_control_result` (including their fixed table
identities). It does not broaden the allowlist or change any coarse category.

The matcher requires exactly one uppercase statement of this bounded shape:

```text
SELECT RAISE(ABORT, <one string-literal message>) WHERE <balanced predicate>;
```

It constructs only the corresponding `SELECT CASE WHEN <same predicate> THEN
RAISE(ABORT, <same message>) END;` token order and compares the complete definition.
Every predicate token and every other active statement token must match exactly.
Parenthesis/CASE balance and the statement terminator are checked. Additional
RAISE statements, other RAISE modes, expression messages, malformed forms and
changed surrounding statements stay unproved. Comment filtering uses the existing
lexer and never concatenates adjacent source fragments.

Only the known second-argument string literal of that ABORT call can be compared
separately, with exact literal hashes and an explicit changed flag. Predicate
action/status literals and literals elsewhere are never masked. No captured DDL
is executed, modified or written back.

One bounded comparison of the two previously approved private capture files,
after verifying their exact hashes, found the relation for **all three** identities.
All three ABORT message-literal hashes matched as well: zero message changes.
The safe evidence is
`windows-selected-schema-raise-relation-2026-10-22.json`. The earlier Client
literal-token-sequence flag is explained by the reordered predicate/message
positions in this exact transformation, rather than a differing ABORT message.

The result is named `syntax_relation_candidate`; both semantic and canonical
verification remain false, and all three coarse categories remain unresolved.
This narrow lexical relation does not verify historical source lineage,
application data effects, actual trigger behavior or readiness, and is no
authorization to apply migrations or dismiss platform/marker differences.

Run locally:

```text
node --test scripts/windows-files-ddl-lexical-attribution.test.mjs
```

References: [SQLite quoting and historical exceptions](https://www.sqlite.org/lang_keywords.html),
[SQLite comments](https://www.sqlite.org/lang_comment.html),
[SQLite draft tokenizer requirements](https://www.sqlite.org/draft/tokenreq.html).
The draft is supporting lexical guidance, not a compatibility certification.
