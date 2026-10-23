# Platform and staging-ledger shape attribution

The five remaining presence differences now have source-level shape attribution.
The retained raw inventories and original schema hashes remain unchanged.

The diagnostic checked Cloudflare's upstream Workerd tag `v1.20260730.1`, resolved
to commit `26b5461b7dcc640bb16072f1ba6f2c6df82572ba`, matching the pinned local
Workerd package version. It retrieved four source files through GitHub's read-only
contents API and retained their Git blob and SHA-256 identities in the JSON
companion. This does not identify Cloudflare's deployed runtime version.

| Difference | Actual comparison | Limit |
| --- | --- | --- |
| Local `_cf_METADATA`, absent in both observed staging databases | Both retained local definitions exactly match the SQLite-stored form of the fixed upstream table constant. | Upstream describes alarm/local-development-bookmark storage and lazy creation. Its absence does not prove which runtime or operations produced the remote state. |
| Observed `_cf_KV` in both staging databases | Both retained observed definitions exactly match the SQLite-stored form of the fixed upstream KV table constant. | This table has a different purpose from `_cf_METADATA`; do not describe the two as equivalent replacements. No KV contents were read. |
| Observed Operations `staging_native_authority_migrations` | Its retained definition exactly matches the pinned Wrangler ledger shape with the repository's existing custom ledger name. | Naming and shape do not prove applied authority packets, ledger rows or historical source effects. The old packet's 183-file contract is not permission to run it against the current 221-file baseline. |

The diagnostic executed only three fixed source constants in a fresh local
in-memory SQLite database, after checking the two platform constants occur
verbatim in the pinned upstream source. It did not execute captured DDL or
downloaded code. It checked both private capture hashes before comparing
definitions through the existing conservative lexical classifier. All five
comparisons were exact SQL bytes, with no whitespace normalization needed.
No application rows, remote queries, migrations or deployments occurred.

This evidence explains the table shapes. It does not waive any original schema
mismatch, prove historical execution, enable EH, or establish semantic readiness.
`canonicalBaselineVerified` and `semanticReadinessVerified` remain false. A reviewer
must still assess the paired observed baseline and actual authority state before
authorizing an execution window.

Sources: pinned Workerd
[metadata implementation](https://github.com/cloudflare/workerd/blob/26b5461b7dcc640bb16072f1ba6f2c6df82572ba/src/workerd/util/sqlite-metadata.c++),
[metadata lifecycle](https://github.com/cloudflare/workerd/blob/26b5461b7dcc640bb16072f1ba6f2c6df82572ba/src/workerd/util/sqlite-metadata.h),
[KV implementation](https://github.com/cloudflare/workerd/blob/26b5461b7dcc640bb16072f1ba6f2c6df82572ba/src/workerd/util/sqlite-kv.c++),
and [KV purpose](https://github.com/cloudflare/workerd/blob/26b5461b7dcc640bb16072f1ba6f2c6df82572ba/src/workerd/util/sqlite-kv.h).
Repository evidence: `scripts/windows-files-canonical-baseline.mjs`,
`scripts/staging-native-authority-packet.mjs` and
`scripts/staging-onboarding-authority-packet.mjs`.
