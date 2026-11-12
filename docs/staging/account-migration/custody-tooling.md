# Existing tooling and missing transfer prerequisites

This is a source inspection, not permission to execute provider operations. Merger owns
backup/export/import and key provisioning. No credential file or secret value was read.
The newly allocated databases have no proven restored schema, data or authority yet.

| Existing source | Callable contract | Reuse limit |
| --- | --- | --- |
| `scripts/read-complete-table-snapshot.mjs` | `readCompleteTableSnapshot(tableName, batchReader)` validates count/rows from one injected read-only batch | Per-table consistency only; not a cross-table transaction, encrypted backup, private export or restore tool |
| `scripts/ordered-read-only-snapshot.mjs` | `collectOrderedReadOnlySnapshot(keys, read, { concurrency })` preserves key order with at most four parallel reads | Independent read ordering only; does not establish backup consistency or encryption |
| `scripts/staging-native-migration-profile.mjs` | `buildProfiles(base)` / `validateGenerated(...)` builds historical migration profiles | Pins the legacy production-owned account and old schema history; do not retarget or execute for this move |
| `scripts/staging-native-migration-ledger-gate.mjs` | `verifyLiveRemoteLedger(base, application, runner, options)` / CLI `--application operations|client` | Historical old-account read guard; its output is not an import receipt or a new-account apply plan |
| `scripts/staging-v4-migration-operator.mjs` | `compileStagingV4MigrationPlan`, `validatePreparedStagingV4Plan`, `executePreparedStagingV4Step` | One-use pinned historical capsule/targets/journals; never replay or silently repoint to allocated databases |
| `scripts/staging-pa-ops-connectors-v203.mjs` | `buildConnectorManifest203(metadata)` / `parseConnectorMetadata203(raw)` | Public metadata contract for manifest, fingerprint and source identity; historical origin/account profiles require reviewed successor |
| `scripts/staging-ops-two-source-connection-profile-v1.mjs` | `buildTwoSourceStagingConnectionPlan(metadata)` and `buildTwoSourceStagingConnectionSecret(metadata, credentials)` | Secret builder returns sensitive material; do not call it to print/export credentials. Existing fixed source origins must be reverified |
| `docs/operations/project-alpha-deployment-sources.md` | Manifest, source commitments and matching Ops/Sync receiver configuration requirements | Architecture/custody reference, not an executable key escrow or secret transfer mechanism |

Before invoking any named function, re-read its exact current signature, inputs and target
fence. Do not run a CLI to discover flags if its entrypoint may perform remote operations.
No existing helper above is established as a complete protected cross-account D1+R2 transfer.

## Missing reviewed successor tooling

1. **Private consistent source export:** choose the actual provider-supported backup/export
   boundary, verify actual account/database identities and stop/drain or otherwise fence
   writes across the dependent databases. Per-table SELECT results are not an atomic backup.
   Protect export files and sidecars with encryption, restrictive ACLs and a recovery key
   outside the repository and outside the exported payload. Ordinary stdout must carry only
   safe metadata/hashes, never SQL rows, object paths, tokens or encryption keys.
2. **Protected R2 object transfer:** preserve exact content hashes and metadata privately,
   without listing private object names in shared artifacts; scope credentials separately to
   the required source/target buckets, redact presigned URLs and keep retry/idempotency state.
   Review CORS, lifecycle/notifications and empty/nonempty/in-flight multipart cases.
3. **Target import executor:** new immutable plan pinned to the allocated Staging account,
   both exact D1 IDs, reviewed source snapshot hashes and ordered migration source hashes.
   Bind the one-use journal to those inputs; inspect schema/data/foreign keys and source,
   root/grant/revision/outbox lineage before marking import complete. Partial or unknown
   outcomes require readback/reconciliation, never blind replay or target replacement.
4. **Key custody and source manifest:** generate independent Staging-only event/HMAC,
   snapshot and device/Viewer credentials through the existing protected operator channel.
   Public source IDs, revision, signer public keys/fingerprints and source commitments belong
   in the review manifest; private keys and API credentials belong only in protected secret
   storage. Both Ops and Sync must receive the same reviewed source identity/manifest and
   matching server-side credentials without exposing their values. PA owner must verify
   source application permissions and any explicitly approved lineage mapping.
5. **Proof and rollback:** verify restored counts, hash/ledger parity, original grants and
   source bindings plus restart/revocation behavior. Preserve old ciphertext/keys and
   protected rollback custody until retention and recovery are accepted. A backup filename,
   encryption flag or successful import call alone proves none of these invariants.

Until that executor/custody plan is reviewed, the allocated storage is only an empty target.
Do not invoke generic Wrangler export/execute/restore commands or reuse the old deployment
token/capsule as an unreviewed shortcut. This document contains no credential location or
values and does not authorize reading private credential material.
