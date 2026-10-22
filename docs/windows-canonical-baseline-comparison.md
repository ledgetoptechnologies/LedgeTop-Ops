# Windows staging canonical shape comparison

The standalone offline comparison is available, but staging is **not proven canonical**. `canonicalBaselineVerified` remains `false` in both preflight and comparison output.

`windows-files-canonical-baseline.mjs --local-replay` creates blank local Miniflare D1 databases and applies the existing independently byte-reviewed migration sources in order. It uses the exact installed Wrangler migration-ledger DDL, rather than the older test helper's differently declared ledger. Existing frozen bootstrap/migration receipts are not edited. The reference covers Ops through 0221 plus its 0222/0223/0224 checkpoints, and Client through 0234 plus 0235/0236. Client's 0234 checkpoint contains 153 migrations because the historical numbering has a gap. It records source inventory hashes, ordered ledger hashes, full exact sqlite_master SQL hashes/counts, local FK checks and pinned Node/Miniflare/Workerd/Wrangler/lockfile provenance. It exports no application rows or SQL text.

The completed local replay used Miniflare 4.20260730.0, Workerd 1.20260730.1, Wrangler 4.118.0 and compatibility date 2026-08-06. Local D1 rejects sqlite_version(); there was no bypass, and no actual SQLite-version observation is claimed. Regeneration requires the reviewed Node 24 runtime's TypeScript stripping support and the existing lockfile-installed application dependencies. The generator is explicitly local-only and denies outbound requests. The reference's LF-normalized JSON digest is independently pinned by `windows-files-canonical-comparison.mjs`.

| Checkpoint | Ledger entries | Schema objects | Exact schema SHA256 |
|---|---:|---:|---|
| Ops 0221 | 221 | 2402 | `8da53584a8a7bf06affec4994ec34cda3bfac9060a360c1566aad873e171a325` |
| Ops 0222 | 222 | 2412 | `647717749fa3513036037b46a671bbbb8bc7a8344f4d2148c938115f9240dbe6` |
| Ops 0223 | 223 | 2428 | `f11f3a90fc4cc1c6aaea33678b50d19d6279ec60dfd89c038cb3f6a111ba23af` |
| Ops 0224 | 224 | 2429 | `ccfad5e81e25cb113fc78ef05f1fd029f59d9b6197e4d49aabc4edc4e867eb26` |
| Client 0234 | 153 | 1158 | `e25d98637026da4137f5cf72bba3e5a385cac41ef05be24b1ae81596d659cab8` |
| Client 0235 | 154 | 1159 | `258e8f759d655f149d2a617d5c2dccfc8a3b026aa5638ee4d58ce2c663ce458b` |
| Client 0236 | 155 | 1164 | `266f1c09fa6e844501db9d349a8caa7d16e3f45c2ebe21704119a82a45816a8d` |

The root agent supplied a separate, already-collected GET-only staging summary. Its ordered ledgers match the local baselines exactly, but schema fingerprints do not:

- Ops: remote 2403 objects / `90e1daff584a6f930c6e5922c24f042d9e6bda7acf12a7ca6dd31f400354825e`.
- Client: remote 1158 objects / `66315f85873f39a4bd8cbd9b265dd7d4ad3e216111f0cb90d979ef2096f2623a`.

These differences are unresolved. An extra object, an alternative ledger declaration, reviewed historical schema lineage or SQLite ALTER TABLE SQL rendering could matter; no cause has been attributed. There are **no ignored metadata objects, SQL whitespace normalization, type substitution or permissive exception list**. Do not apply migration suffixes based on ledger matches alone.

`node scripts/windows-files-canonical-comparison.mjs --receipt <saved-preflight.json>` only reads the supplied local receipt and pinned local reference. It emits the separate `observedSchemaAndLedgerComparison`, with per-app ledger/schema/FK outcomes and `requires_review` for the current supplied staging summary. It performs no remote queries or deployment. A supplied receipt can be forged or stale; the comparison provides consistency checks, not signed remote provenance. Schema pages, ledger, Worker metadata and FK checks are non-atomic observations. Even an exact match cannot attest historical migration data/seed effects, authority correctness, all prior SQL source execution, or activation readiness.

Validation: the full local replay completed; 21/21 comparison and existing preflight tests passed. Tests cover all 12 checkpoint pairings, pinned-reference tampering, missing/reordered/unknown migrations, forged ledger digests, duplicate entries, schema hash/count drift, FK failures and current-source inventory bytes. No remote query, credential access, remote migration or activation was performed for this work.
