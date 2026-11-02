# Synthetic reference v2 lexical fixtures

These byte-for-byte fixtures and their index entries come from Processing
`f40c68918ad2c612a415fc9447e4a3f9b87c15b7`,
`contracts/reference-v2-candidate/invalid/`. Their hashes are checked before use.
The sibling `canonical-vectors.json` is copied from the same Processing commit
and pinned by its complete SHA-256 in the Viewer test.
`boolean-integer` is a schema-level case and is intentionally excluded: a JSON
decoder cannot determine whether a boolean occupies an integer schema field.

Viewer's candidate combines predecode and canonical-metadata restrictions: it
rejects floats and negative integers even though Processing's lexical decoder
retains some such tokens for later canonical/schema rejection. Thus parity here
is with Processing decode *plus canonical metadata*, not `_decode` alone.
Record schemas, boolean/integer field distinctions, authentication, custody,
closed field validation, and the reverse v1 verifier rejection are outside this
fixture. There is no route, runtime registration, or authority in this candidate.
