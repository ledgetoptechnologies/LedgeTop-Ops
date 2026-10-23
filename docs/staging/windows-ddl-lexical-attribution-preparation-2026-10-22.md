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

Run locally:

```text
node --test scripts/windows-files-ddl-lexical-attribution.test.mjs
```

References: [SQLite quoting and historical exceptions](https://www.sqlite.org/lang_keywords.html),
[SQLite comments](https://www.sqlite.org/lang_comment.html),
[SQLite draft tokenizer requirements](https://www.sqlite.org/draft/tokenreq.html).
The draft is supporting lexical guidance, not a compatibility certification.
