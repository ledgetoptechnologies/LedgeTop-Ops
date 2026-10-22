# Viewer stability, renewal and safe storage retirement

## Released baseline and user acceptance

The stability update was released to main as `ab6bcc766e102d549c1267717da02b46c9fdf522`. The [Viewer image workflow](https://github.com/ledgetoptechnologies/3D-Viewer/actions/runs/33937998464) passed, including exact-image verification and promotion to `ghcr.io/ledgetoptechnologies/3d-viewer:sha-ab6bcc7` and `:latest`.

Published image digest: `sha256:dcbc24c44042339eb237dea7f8617851389e5cd27d43f31ededb525a5deabf3d`.

On September 4, 2026 (America/Chicago), after testing this release, the user reported that the viewer aspect was working as it should. Record this as qualitative user acceptance of the viewing experience and preserve this release as the known-good comparison baseline for future LOD, memory and navigation changes.

This acceptance does not establish a measured heap ceiling, completion of the full token-lifetime soak, or actual storage reclamation. Those checks remain separate; do not infer them from the successful viewing report.

## Scope and evidence

Candidate based on `origin/main` at `92179ba66a5ddb7fd2a60ef2ef65ad21494743d6`.
Viewer-only changes; no Operations services, production files, imports or published assets were changed during development.

Three symptoms are distinct:

- Rapid navigation: the user observed roughly 7 GB of **JS heap**, falling only to about 6.3 GB after settling. The supplied partial logs show 62 queued parses and two running parses; all 172 required tiles eventually attached. Tracked tile cache fell from a peak of 1,974 MiB to 1,521 MiB. Those logs do not contain heap snapshots and cannot attribute every retained byte.
- Missing geometry after a long session: supplied logs contain tile and EPT HTTP 403 failures while cache was below its cap and admission refusals were zero. The exact original authorization failure was not reproduced; renewal/controller gaps are independently verified code defects.
- Dashboard storage: Rome has approximately 83.0 GB, 4.5 GB and 83.1 GB retained outputs, totaling 170.6 GB. The two independent Church imports account for about 68 GB. These are registry accounting values, not an inode-level deduplication measurement. The increase is not evidence that KTX2 alone added all that storage.

Raw user logs contain signed asset capabilities. Do not copy them into public issues, reports or commits.

## Memory changes

1. Bound the entire download/body/parse lifecycle, rather than HTTP concurrency alone. At most eight lifetimes are admitted, with a profile-derived byte reservation. Requests deferred before admission stay selectable; no extra delay timer, forced visibility, SSE change or eviction of a visible tile is introduced.
2. Account for the byte length of downloaded bodies waiting for parsing. Diagnostics store counts, not buffer references. Reservations are estimates: an unknown or individually oversized tile can exceed them. This is **not a hard total browser-memory limit**.
3. Allow a requested large tile to drain smaller in-flight work without starving indefinitely. The demand barrier uses a weak reference and expires after a view change.
4. Dispose the unlit replacement materials actually rendered by Viewer. Flatten and deduplicate material arrays in the pinned renderer's resource inventory so textures are counted and disposal does not throw on arrays.
5. Cancel pending BVH construction for evicted meshes and release completed BVHs at disposal.
6. Release only the completed GLTF parser reference, whose caches otherwise retain input buffers. Keep scene resources, attribution, extras, animations and feature/batch metadata. Real GLB and B3DM tests exercise both source and bundled renderer paths.

No claim is made that these fixes account for the entire observed heap spike. Production repeated-navigation and settling measurements remain necessary. Clearing the cache more aggressively by itself would risk restoring the blur/refetch problem.

## Session changes

- Published-output launches now use an immutable output/version renewal context, like review sessions already do.
- Parallel authorization failures coalesce. Fresh grants are still required; authorization is not bypassed.
- A late denial from the previous access generation retries once using already renewed access, without requesting a second grant. Aborted requests remain aborted.
- Resident geometry stays visible during renewal. A persistent status explains failed access instead of ordinary LOD text overwriting the warning.
- The real-browser regression exposed another retry defect: the pinned renderer resets a failed tile's state but leaves its LRU entry in place, which prevents the next admission. Recovery removes only failed entries before resetting, preserving completed resident tiles.
- Required failed child content must not count as ready for strict `REPLACE`. Otherwise a denied tile can hide its valid fallback even though the fallback scene is still resident. The readiness correction preserves contentless/external traversal semantics.
- EPT metadata, hierarchy and LAZ fetches retry once after confirmed renewal, preserving camera and tools. Rotated capability roots are applied to cached child URLs.
- Binary/zstandard EPT transport uses XHR and is not covered by this fetch recovery. Closing or refreshing the workspace can still lose its controller; reopen the affected model if instructed.

## Storage policy

Age alone never makes a model eligible. Independent imports, adopted/external datasets, active outputs, published/shared/session dependencies, processing/retry dependencies and unknown files are protected.

Automatic retirement requires explicit successful same-task recovery lineage, a verified active replacement, matching physical accounting and registered hashes, and proof that every old file is preserved with identical bytes and SHA-256 under one consistent replacement path prefix. Preserving relative paths keeps OBJ/MTL, EPT and tile references intact. Changed or ambiguous evidence blocks cleanup and records a reason. Recovery history remains. Explicitly restoring a retired output prevents automatic retirement of that output again.

Eligible outputs use journaled recoverable trash with the existing fourteen-day period. Moving to trash changes active-storage accounting but **does not immediately reclaim physical disk space**. Final purge must still be safe. Actual Rome reclaim has not been proven: unmatched generated files or originals may correctly prevent automatic cleanup.

An interrupted automatic purge whose replacement proof subsequently fails preserves the files, but its pending journal intent can prevent UI restoration until that intent is repaired. This is a known recovery limitation, not permission to bypass the proof or delete the files.

## Verification status

Completed locally on September 4, 2026:

- Full isolated Linux regression: 911 tests; 910 passed, zero failures, one intentional skip for the opt-in host-bind Docker restart/upgrade test.
- Full real-browser suite: 39 passed, zero failures or skips. Includes weighted and depth-stacked LOD during movement, photo/camera UI, desktop/mobile workspace and sharing, compressed KTX2 decoding under production CSP, and real cross-tab session renewal.
- The renewal browser case exercises controlled expiry, denied tiles, grant redemption, a delayed old denial and terminal authorization loss while retaining visible fallback. It does not replace a real production token-lifetime soak or a full Potree LAZ expiry integration test.
- Current frontend and production Docker builds passed. Exact runtime-image readiness: two passed, none skipped. Real converter verification passed with provenance schema v4, 57 artifacts and 83 compressed textures.
- Independent storage review and focused lineage, dependency, path-alias, hash, restore and purge tests passed. No actual Rome output was retired during QA.

Browser QA also corrected three test assumptions: reading child bounds before initialization, expecting the obsolete nonrenewable published-launch contract, and treating an LRU placeholder as an already decoded tile. The no-refetch assertion remains enforced for genuinely loaded, scene-attached cached tiles.

Local image: `ltds-viewer:stability-final-candidate`. Manifest digest: `sha256:7dedc827dccde1d5c277799e09adc554ae03aa8e7fff351d918eb0a18e5ee82e`. This is an unpublished working-tree candidate with an unknown embedded source revision, not a commit-attested release. Existing dependency-audit warnings remain; dependencies were not changed to silence them.

Release confidence is based on these automated checks, not a claimed production heap profile. The actual reduction in the reported seven-gigabyte spike, a production token-lifetime soak and reclaimable Rome bytes remain to be measured.

## Production retest after release

1. Pull the verified Viewer image and open fresh Church and Rome sessions from the workspace. Keep the workspace open for the renewal test. No re-import is needed for frontend fixes.
2. On Auto, repeat the same route and rapid orbit/pan sequence, then stop until download/parse queues drain. Compare JS heap, tile-cache bytes and loading reservations separately. Repeat the route several times; distinguish transient peaks from monotonically growing post-settle memory.
3. Check the front facade, both sides of a corner and skyward/backward orbit. Warm nearby detail should remain stable, without gaps or repeated requests for cached tiles.
4. Leave the session open beyond its token lifetime, navigate to unloaded regions, then switch to point cloud. Confirm access renewal and continued streaming. Test loss of the workspace controller separately; it must show a clear recovery instruction.
5. Inspect storage cleanup diagnostics and Recycle Bin. Retained outputs should have an explanation; never delete one manually just to make the dashboard smaller. Confirm original photos, point cloud, ortho, DSM and DTM remain available before and after retirement.

The local QA record above describes the pre-release candidate. Publication and subsequent user acceptance are recorded at the top of this document. No production files were manually deleted during development or release.
