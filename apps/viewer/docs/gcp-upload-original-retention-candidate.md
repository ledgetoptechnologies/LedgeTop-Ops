# CSV retention before dataset indexing

Source successor to permanent-original retention PR #594 / migration 46. No new
migration, deployment, permission, public link or parsing behavior is introduced.

A CSV can finish uploading while another image in the same upload never
finishes. Previously the completed CSV existed only in chunk cache or an
unindexed assembled raw tree; normal cleanup could delete it before the existing
dataset-files retention path saw it.

The chunk route now retains a fully received CSV/GCP-source file before its
final chunk acknowledgment. It verifies each pinned chunk's exact size/hash and
the complete file's manifest hash, then uses the existing immutable original
store and FULL commit/checkpoint barrier. Invalid CSV encoding or content is
preserved byte-for-byte without parsing, normalization or valid-GCP claims.
Upload-scoped file IDs are not recorded as global dataset-file IDs.

Finalization/replay, dataset deletion and expiry maintenance all use guarded
upload cleanup. Existing retained originals are integrity-checked and pass the
durability barrier again before cache deletion. Legacy uploads whose chunks
already disappeared may recover the exact size/hash-bound assembled source.
Dataset trash/purge also considers upload manifests before indexed files, using
the lifecycle journal's current raw-tree location after an interrupted move.
Project/container lifecycle therefore retains an unindexed completed CSV too.

Partial/unindexed or oversized CSV candidates do not become fake complete
originals. Their upload cache tree is kept, including associated photo chunks.
No automatic pruning is added. The existing 2MiB original-store limit remains:
oversized CSV does not block photo chunk upload, but destructive dataset lifecycle
is held where the original cannot enter the durable store. Partial/oversized
recovery, disk inventory and a reviewed storage policy remain operational work;
cache preservation is not an indexed/downloadable permanent-original receipt.
No unavailable historical bytes can be recovered by this change.

## Validation

Twenty-three lightweight GCP original/idempotency/lifecycle/upload checks pass,
using actual SQLite, tiny synthetic CSV/chunk filesystem fixtures and HTTP.
Cases include unindexed completion with missing photos, exact BOM/invalid bytes,
partial unindexed chunks, tampering, oversized holds, legacy assembled fallback,
journal move recovery, source-set/dataset deletion and a busy-checkpoint ACK
failure followed by identical replay.

Broader upload-ID and workspace lifecycle regressions produced one pass and six
setup failures on Windows at the existing Linux `/proc/self/fdinfo` requirement.
Their affected runtime flows were not exercised. Those platform checks remain
unchanged and require an admitted Linux runner. Six verified task-owned fixture
directories remain because automatic approval review blocked cleanup; the test
processes exited. Exact paths are retained in the private handoff.

Independent source review covers the helper, route/cleanup wiring and lifecycle
fallback; installed/combined migration, real upload lifecycle, durable power-loss
behavior, GCP auto-import/marking and NodeODX submission still need staging
acceptance. The full Viewer goal remains active.
