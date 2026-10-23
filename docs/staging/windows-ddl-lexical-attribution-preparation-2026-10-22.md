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

Run locally:

```text
node --test scripts/windows-files-ddl-lexical-attribution.test.mjs
```

References: [SQLite quoting and historical exceptions](https://www.sqlite.org/lang_keywords.html),
[SQLite comments](https://www.sqlite.org/lang_comment.html),
[SQLite draft tokenizer requirements](https://www.sqlite.org/draft/tokenreq.html).
The draft is supporting lexical guidance, not a compatibility certification.
