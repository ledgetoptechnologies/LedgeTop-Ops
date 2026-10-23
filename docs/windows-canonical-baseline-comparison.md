# Windows staging canonical shape comparison

The standalone offline comparison is available, but staging is **not proven canonical**. `canonicalBaselineVerified` remains `false` in both preflight and comparison output.

`node scripts/windows-files-canonical-baseline.mjs --local-replay` creates blank local Miniflare D1 databases and applies the existing independently byte-reviewed migration sources in order. It uses the exact installed Wrangler migration-ledger DDL, rather than the older test helper's differently declared ledger. Existing frozen bootstrap/migration receipts are not edited. The reference covers Ops through 0221 plus its 0222/0223/0224 checkpoints, and Client through 0234 plus 0235/0236. Client's 0234 checkpoint contains 153 migrations because the historical numbering has a gap. It records source inventory hashes, ordered ledger hashes, full exact sqlite_master SQL hashes/counts, local FK checks and pinned Node/Miniflare/Workerd/Wrangler/lockfile provenance. It exports no application rows or SQL text.

The refreshed exact-query local replay used Miniflare 4.20260730.0, Workerd 1.20260730.1, Wrangler 4.118.0 and compatibility date 2026-08-06. Local D1 rejects sqlite_version(); there was no bypass, and no actual SQLite-version observation is claimed. Regeneration requires the reviewed Node 24 runtime's TypeScript stripping support and the existing lockfile-installed application dependencies. The generator is explicitly local-only and denies outbound requests. The reference's LF-normalized JSON digest is independently pinned by `windows-files-canonical-comparison.mjs`.

| Checkpoint | Ledger entries | Schema objects | Exact schema SHA256 |
|---|---:|---:|---|
| Ops 0221 | 221 | 2402 | `8da53584a8a7bf06affec4994ec34cda3bfac9060a360c1566aad873e171a325` |
| Ops 0222 | 222 | 2412 | `647717749fa3513036037b46a671bbbb8bc7a8344f4d2148c938115f9240dbe6` |
| Ops 0223 | 223 | 2428 | `f11f3a90fc4cc1c6aaea33678b50d19d6279ec60dfd89c038cb3f6a111ba23af` |
| Ops 0224 | 224 | 2429 | `ccfad5e81e25cb113fc78ef05f1fd029f59d9b6197e4d49aabc4edc4e867eb26` |
| Client 0234 | 153 | 1158 | `e25d98637026da4137f5cf72bba3e5a385cac41ef05be24b1ae81596d659cab8` |
| Client 0235 | 154 | 1159 | `258e8f759d655f149d2a617d5c2dccfc8a3b026aa5638ee4d58ce2c663ce458b` |
| Client 0236 | 155 | 1164 | `266f1c09fa6e844501db9d349a8caa7d16e3f45c2ebe21704119a82a45816a8d` |

The root agent supplied a separate, already-collected read-only staging summary. Its ordered ledgers match the local baselines exactly, but schema fingerprints do not:

- Ops: remote 2403 objects / `90e1daff584a6f930c6e5922c24f042d9e6bda7acf12a7ca6dd31f400354825e`.
- Client: remote 1158 objects / `66315f85873f39a4bd8cbd9b265dd7d4ad3e216111f0cb90d979ef2096f2623a`.

These differences are unresolved. An extra object, an alternative ledger declaration, reviewed historical schema lineage or SQLite ALTER TABLE SQL rendering could matter; no cause has been attributed. There are **no ignored metadata objects, SQL whitespace normalization, type substitution or permissive exception list**. Do not apply migration suffixes based on ledger matches alone.

`node scripts/windows-files-canonical-comparison.mjs --receipt <saved-preflight.json>` only reads the supplied local receipt and pinned local reference. It emits the separate `observedSchemaAndLedgerComparison`, with per-app ledger/schema/FK outcomes and `requires_review` for the current supplied staging summary. It performs no remote queries or deployment. A supplied receipt can be forged or stale; the comparison provides consistency checks, not signed remote provenance. Schema pages, ledger, Worker metadata and FK checks are non-atomic observations. Even an exact match cannot attest historical migration data/seed effects, authority correctness, all prior SQL source execution, or activation readiness.

Validation: the full local replay completed; 21/21 comparison and existing preflight tests passed. Tests cover all 12 checkpoint pairings, pinned-reference tampering, missing/reordered/unknown migrations, forged ledger digests, duplicate entries, schema hash/count drift, FK failures and current-source inventory bytes. No remote query, credential access, remote migration or activation was performed for this work.

The comparison CLI's zero exit code means it produced a comparison result,
including `requires_review`. It is not a shell readiness gate. Callers must
inspect the explicit result and retain the separate deployment authorization;
even `matches_pinned_local_replay` is not migration or activation approval.

## Optional exact schema-object diagnostics

The reviewed root invocation has now run against staging with both diagnostics
and recovery metadata enabled. Its result is
`staging/windows-staging-schema-drift-2026-10-22.json`:

- Both complete ordered ledgers match their local baseline checkpoints; both
  foreign-key checks report zero violations.
- Both replace the local `_cf_METADATA` identity with `_cf_KV`. Ops also has
  `staging_native_authority_migrations`.
- Ops has 38 changed SQL fingerprints (5 tables, 29 triggers, 4 views); Client
  has 8 (2 tables, 6 triggers). These changes still need semantic review. A
  fingerprint difference alone is not evidence of a defect or a harmless change.
- Both current recovery bookmarks were observed. Public evidence retains their
  hashes; no restore, paired snapshot, backup export or retention extension was
  tested or performed.

The actual remote invocation used clean source `a823b69d` and its corrected
exact-prefix query. That CLI preceded the additive query-digest output field.
The original receipt remains unchanged; the explicitly derived observation
records the executed source, tool, shared query and raw receipt hashes. This is
caller-recorded provenance, not signed attestation, and does not relabel an old
LIKE-query capture. Fresh local replay qualified the same exact query scope.
The result remains `requires_review`, with `canonicalBaselineVerified: false`.

A separately reviewed, default-off option retains only each sqlite_master object's `type`, `name`, `tbl_name` and exact UTF-8 SQL SHA256 (`null` remains null). It never emits SQL text or application rows. The preflight option is `includeSchemaObjectDigests: true` / `--read-only --schema-object-digests`; it uses precisely the existing validated, bounded schema query pages, without an additional query or changed binding/identity checks. This option does not change `canonicalBaselineVerified` or make the pages atomic. Root must review and compose it with any other preflight options before remote invocation.

The current retained object maps were derived from **one full exact-query local replay**, using `node scripts/windows-files-canonical-baseline.mjs --local-replay --schema-object-digests`. This run applied all Windows suffixes locally; it was not a baseline-only replay. Its complete temporary capture SHA256 is `b8290547d5841efb45dc832750989afa3d5a29cc4d75944d97650aef35d09721`. The seven-checkpoint reference was derived by removing each checkpoint's per-object map; the baseline-map reference was derived by retaining only the baseline checkpoint for each app. Runtime/source inventory metadata is retained from that full run, including source inventories through the suffixes.

The retained baseline checkpoint maps are in `docs/staging/windows-canonical-baseline-objects-local-2026-10-22.json` (LF-normalized SHA256 `e2509bd4e9cc5eb8e1ff724cafc370ad196b2fecd3a9cde6943e51b05a7e9b35`), and the seven-checkpoint summary pin is `1a9ba2dffbbe532295be7c3830af37bf3dc150b2f1cba92a4b8eba14139081e7`. All prior local full-schema hashes/counts reproduced exactly, but the capture now qualifies the corrected query scope. `_cf_METADATA` and Wrangler `d1_migrations` remain included; neither is silently ignored. No second migration replay is needed to derive the second artifact.

`compareSchemaObjectDigests(expected, observed)` in `scripts/windows-files-schema-object-digests.mjs` reports missing/extra identities and changed SQL fingerprints, with `canonicalBaselineVerified: false`. It is an attribution aid, not a whitelist or schema approval. Exact metadata DDL and whitespace-only trigger differences remain visible. The current remote-vs-local differences have not been attributed by this work; no remote calls were made.

Phase-two validation: 27/27 helper/comparison/preflight tests pass. Tests execute real local SQLite DDL to change only trigger whitespace, remove an index and add a table; each is attributed without SQL export. They also cover raw UTF-8 hashing, distinct null SQL, duplicate/malformed/oversized inventories, tampered digests, pinned retained capture, default absence, explicit read-only requirement, unchanged query calls and no SQL text in optional receipts.

### Diagnostic manifest validation

Fingerprint helpers accept only enumerable own data fields on plain `Object.prototype` records or explicit null-prototype records. Custom prototypes, unknown manifest fields, symbols, hidden fields, accessor properties, sparse/augmented arrays and unexpected scope values are refused. Arrays must be dense ordinary arrays; object identifiers are bounded to 4096 UTF-8 bytes. Complete serialized manifests are bounded to 2 MiB before digest verification/calculation. SQL remains byte-exact, and the captured baseline artifact/pin are unchanged.

The comparison also returns `inventoryDigestEqual`. An order-only inventory difference can have no missing/extra/changed object identities while this flag is false. Neither result upgrades aggregate schema validation or canonical proof. Validation-only follow-up: 31/31 focused tests passed, with no migration replay or remote invocation.


### Exact query-scope qualification

The old `name NOT LIKE 'sqlite_%'` predicate treated `_` as a wildcard and hid legal application names such as `sqliteX_visible`. The shared query now excludes only `substr(lower(name),1,7) = 'sqlite_'`. A real SQLite counterexample regression demonstrates the difference. No broader metadata ignore was introduced.

Generator references and preflight observations now include `schemaQuerySha256` for the exact UTF-8 query string. The refreshed query digest is `8fce60a0f677bb4e8e21d04b6e64efa0b46ad4a6a982141f1b432bc0788eecd9`. Comparison never reports `matches_pinned_local_replay` unless that exact scope digest is present: absent, old or different valid digests produce `requires_review` / `query_scope_unverified`; malformed digests are refused. Even the correct field is supplied metadata, not signed remote attestation. A derived receipt must preserve its original capture and clearly record the actually executed source/tool/query provenance; merely adding a new digest to an old LIKE-query receipt cannot qualify it.

The corrected query did not change any schema hashes/counts in this canonical local source, and current staging hashes remain different. A complete exact-query full replay—not a scope label alone—qualified these refreshed local artifacts. Subsequent validation-only changes did not rerun migrations. Local checks: 34/34 focused query/helper/comparison/preflight tests passed. No remote query was performed in this work.

### Invoke replay from a file

Use the CLI above or import the generator from an owned `.mjs` file; do not use
`node --input-type=module -e`. Miniflare's pinned synchronous fetch helper creates
an eval Worker containing CommonJS `require()`. Node inherits `--input-type` into
that Worker. A minimal isolated Worker under the original module invocation
failed with `ReferenceError: require is not defined`; Miniflare's caller can remain
blocked in its unbounded `Atomics.wait()` after that failure. The initial diagnostic
replay produced **no result**. The precise in-flight RPC was not instrumented.

The generator now rejects both `--input-type=value` and `--input-type value`
before loading Miniflare/Wrangler, with `canonical_replay_use_file_runner`.
It does not remove flags, rewrite dependencies, expose an inspector, or alter
the frozen replay/runtime/schema contracts. Bounded subprocess tests invoke the
actual generator while trapping any engine import: module eval is rejected and
ordinary file invocation reaches normal option validation. No replay or SQL runs
in these guard tests. A subsequent replay must be a separately reported file-runner
execution; this guard does not turn the stalled invocation into a successful one.
