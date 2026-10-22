# LOD/KTX2 research and Codex review context

## Status and release boundary

This document records the investigation behind the automatic KTX2 work. The code is being placed on `main` so Codex can review it. It is not authorization to deploy the image or replace the active church model.

The church must be processed as a new model version, pass authenticated normal-memory and forced-4-GiB browser acceptance, and be explicitly published. Existing ready or published model versions are immutable in this release.

## Root cause

The rendering failure was measured as a texture-memory problem, not a standards-traversal defect.

Church model observations:

- Decoded model memory was 99.24% textures.
- The root tile was approximately 31 MiB.
- Two large intermediate tiles were approximately 273 MiB and 256 MiB and were over 99.8% texture data.
- The coarse 16-tile replacement frontier was approximately 1.27 GiB.
- The forced-4-GiB browser profile assigns the Viewer a 768 MiB LRU ceiling.
- Raising the test ceiling to 1 GiB, 1.5 GiB, and 2 GiB did not make strict `REPLACE` refinement reliable on the constrained profile.

A strict `REPLACE` parent must remain visible until the selected replacement frontier for that branch is ready. When texture bytes prevent that frontier from fitting, retaining the root is correct behavior.

## Old branch versus current traversal

The old branch was `27fe91a439172901eb25bbd47f2f50c1f6b9be70`. The production baseline at the start of this work was `f2b3c1b23f87928f5796a5d04736dae8f4eb0d8a`.

The old branch appeared to work because it bypassed the replacement requirement:

- It changed the top-level refinement behavior to `ADD` at runtime.
- It retained the coarse root as a permanent whole-model backdrop.
- It manually hid and evicted detailed leaves by changing scene visibility, traversal state, and LRU state.
- It used a large fixed cache rather than the current reduced-memory profile.

That let individual children appear over the coarse root without completing a valid replacement frontier. It was visually responsive but was not a fix for the measured memory demand. It also conflicts with current authorization, CSS/UI, and lifecycle behavior.

Current behavior deliberately remains standards-oriented:

- Strict `REPLACE` refinement.
- `loadAncestors = false`.
- `loadSiblings = false`.
- `loadAncestorSiblings = false`.
- Progressive root, overview coverage, then nearby refinement.
- No permanent root backdrop.
- No global automatic detail rollback.
- No direct scene-visibility manipulation of cached tiles.

Do not restore the old root-`ADD` workaround or automatic global detail rollback. Production captures showed that global rollback caused visible corruption.

## CesiumJS research

No CesiumJS source code was copied into this Viewer.

The Viewer uses:

- Three.js `0.185.1`.
- `3d-tiles-renderer` `0.5.1` from NASA-AMMOS.
- A narrowly scoped local traversal fallback already present in the Viewer.
- Three.js `KTX2Loader` and the matching Basis transcoder.

CesiumJS and `3d-tiles-renderer` have broadly comparable cache-pressure behavior for this failure mode: neither can complete a strict replacement frontier that exceeds the available decoded texture budget.

CesiumJS options reviewed but not implemented:

- `dynamicScreenSpaceError`
- `foveatedScreenSpaceError`
- `skipLevelOfDetail`
- request-volume/request-culling policies

Those options can change request order or visual refinement policy. They do not reduce the church textures from roughly 1.27 GiB at the required coarse frontier to the 768 MiB constrained budget. Reintroducing skip-LOD or root-`ADD` behavior would mask the measured constraint and weaken strict `REPLACE` guarantees.

## Obj2Tiles research and contracts

The server converter is OpenDroneMap/Obj2Tiles `1.6.2`. The Docker build verifies the pinned release archive and executable digests before installing it.

Two provenance contracts remain recognized during transition:

1. Legacy JPEG contract

   - Command SHA-256: `7d82c354b3d65985e602454c0bcc204fe8e75d8efc1826b76a5681d85c34f681`
   - Includes octree LOD generation and `--lod-texture-scale 0.5`.
   - Accepted only so existing verified assets remain readable.
   - It is not automatically migrated or regenerated in place.

2. Current KTX2 contract

   - Command SHA-256: `8d0931aa44aae76b48832212cd6c649b73e9b9843d5d5f07462f167d0e8d5752`
   - Arguments:

     ```text
     --octree
     --lods 3
     --divisions 2
     --lod-texture-scale 0.5
     --texture-format Ktx2
     --ktx2-quality 192
     --local <source.obj> <output>
     ```

   - Uses ETC1S KTX2 texture output.
   - Requires both the textured OBJ input and an auditable GLB source.
   - Produces schema-v3 controlled bidirectional surface-equivalence evidence.

A real Obj2Tiles smoke conversion produced:

```json
{"ok":true,"schemaVersion":3,"artifacts":57,"compressedTextures":83}
```

Real Chrome loaded the resulting B3DM through the production tile path and attached GPU `CompressedTexture` objects without runtime exceptions.

## Why KTX2 is the selected fix

KTX2 reduces the decoded/retained texture footprint while preserving strict replacement traversal. It addresses the measured resource, unlike request-order or traversal bypasses.

The implementation does not claim that KTX2 alone is production-accepted for the church. The release gate still requires the server-produced church derivative to demonstrate:

- Complete overview coverage.
- Nearby zero-error descendant refinement.
- Return-to-overview coverage.
- No visible holes or persistent coarse-only state.
- Cache use within the forced-4-GiB policy.
- Correct color and alpha behavior.

## Automatic pipeline behavior

For new eligible work:

1. NodeODM completion, WebODM task import, or catalog/Terra import registers the staged source assets.
2. If OBJ and GLB are available, `mesh_tiles` is required even when legacy native tiles were included or the worker-generation flag was explicitly disabled. A disabled worker therefore fails the staged attempt closed; it never bypasses readiness.
3. The attempt remains in `derivatives` status.
4. The TrueNAS `viewer-worker` runs Obj2Tiles and the controlled audit.
5. The generated tree is activated only after source, geometry, material, artifact, and manifest verification.
6. Only then can the attempt become `ready_for_review`.

A required derivative failure marks the staged attempt failed. It does not silently fall back and call the job complete.

Existing ready and published versions are not queued for automatic backfill. Manual in-place LOD generation and retry are disabled. Upgrading an existing model requires a new processing attempt/model version, so the active version remains the rollback path.

## Durability and resource controls

The automatic lane includes:

- A SQLite `BEGIN IMMEDIATE` singleton plus a partial unique index that permits only one leased LOD row, including mixed-version rolling upgrades.
- Migration v27 retains one legacy LOD lease, safely returns any additional old leases to pending, then installs the database invariant.
- A unique 128-bit lease token per claim.
- Token checks on heartbeat, progress, activation, completion, and failure.
- A persisted 24-hour wall-clock deadline.
- Three maximum lease acquisitions for LOD work before terminal failure; unrelated derivatives keep their existing retry behavior.
- Claim and heartbeat expirations capped at the persisted deadline, with immediate deadline terminalization even for a legacy overlong lease.
- Heartbeat rejects an already expired lease, preserves the pre-v27 numeric duration call shape, and rolls back the row extension if the LOD lock cannot be renewed atomically.
- A legacy pre-v27 live LOD lease fences new conversions even when it has no token or singleton row.
- Durable `processing.failed` outbox delivery when a required derivative is terminalized.
- Manual non-LOD retry resets its lease counter, token, start time, and deadline.
- Token-specific `.incomplete` and `.complete` directories.
- A deterministic final directory per derivative job.
- Re-verification of an existing final after a crash before registration.
- Same-filesystem checks for atomic rename.
- A source-size cap, four-times expansion admission estimate, fixed free-space reserve, and inode reserve.
- One-second free-space and inode monitoring while Obj2Tiles and the audit run.
- A 100,000-file audit ceiling.
- A storage reconciler with a persistent cursor that eventually examines every terminal job and removes only old, unreferenced token directories after a grace period.
- Symlink fences on derivative generation and cleanup paths, including same-root aliases.
- Timeout and lease-loss shutdown that sends `SIGTERM`, escalates to `SIGKILL`, and waits for the converter process tree to exit before deleting work directories.
- A parent worker supervisor that restarts a stale child and will not signal a child again after signal-based exit, preventing delayed hard-kill timers from targeting a reused PID/process group.
- A startup SQLite locking preflight on the configured database filesystem.

TrueNAS Compose ceilings are fixed at 16 CPUs and 24 GiB RAM, leaving eight of the server's 24 CPU cores for NodeODM, ZFS, the Viewer API, and other work.

## Provenance and Viewer acceptance

The following must all recognize the same current converter contract:

- `lod-converter-policy.cjs`
- `scripts/lib/lod-equivalence.mjs`
- `server/lodProvenance.js`
- `server/processingRepository.js`
- `lod-policy.mjs`

The browser policy previously recognized only the legacy command SHA. This was corrected so the current KTX2 schema-v3 evidence is accepted while arbitrary command hashes remain rejected.

Three.js is pinned exactly to `0.185.1`; the Basis JavaScript and WASM copied during postinstall come from that same package release.

## Council review history

Multi-model production-readiness reviews were archived as council reviews 54 through 59.

- Review 54 rejected automatic in-place migration because a failed promotion could take the published church offline without a rollback path.
- Subsequent revisions replaced in-place migration with immutable model versions, database/lease-token fencing, atomic job-specific activation, storage guards, and an explicit real-browser acceptance gate.
- Review 59 considered local implementation sound only with the SQLite filesystem preflight, external worker supervisor, terminal lease cleanup, and no automatic legacy recovery. Those conditions are represented in this changeset.
- None of the reviews authorized a TrueNAS deployment or church publication. Resource profiling and authenticated browser acceptance remain separate gates.

## Pre-push review findings resolved

The independent pre-push pass and adversarial local reproductions found and fixed:

- Required KTX2 readiness could be bypassed when `MESH_DERIVATIVES_ENABLED=false`, including when legacy tiles existed. Required OBJ+GLB work is now flag-independent and fails closed if the worker is disabled.
- A pre-migration active LOD lease with no token and an empty v27 singleton row could allow a second conversion. Any live LOD lease now fences new LOD claims, and a database partial unique index prevents an old worker from bypassing the singleton during a rolling upgrade.
- Heartbeat could resurrect an expired token, changed the old positional duration argument, and could commit a row extension after lock renewal failed. Expired leases are rejected, numeric third arguments retain their duration meaning, and row/lock renewal now succeeds or rolls back together.
- The supervisor's delayed `SIGKILL` could target a reused process group after a child exited from `SIGTERM`, because signal-based exit leaves `exitCode` null. `stopChild` now also treats non-null `signalCode` as exited.
- Reclaim and heartbeat could extend a lease beyond its persisted deadline, and terminalization waited for that overlong lease. Both renewal paths are capped and a passed deadline terminalizes immediately.
- Exhausting a required derivative failed database state without emitting the durable `processing.failed` outbox event. Terminalization now emits the same bounded failure contract as normal worker failure.
- The new LOD retry ceiling accidentally constrained unrelated derivatives, while manual non-LOD retries retained stale deadline state. The ceiling is LOD-only and a manual non-LOD retry starts a fresh lifecycle.
- A converter that ignored `SIGTERM` could outlive timeout handling and continue writing after cleanup. Command shutdown now escalates to `SIGKILL` and waits for exit.
- Cleanup repeatedly scanned only the oldest terminal page. A persistent composite cursor prevents later terminal jobs from starving.
- Generation and cleanup accepted an existing attempt-directory symlink. Both paths now reject symlink aliases before writing or deleting.
- `3d-tiles-renderer` plugin disposal could call an absent Draco loader. KTX2 support now disables plugin auto-disposal and explicitly disposes the KTX2 loader during Viewer teardown.
- Browser provenance initially recognized only the legacy JPEG command hash. It now recognizes the exact pinned KTX2 command while rejecting arbitrary contracts.

Each item has a regression test in the staged changeset.

## Items Codex should review closely

1. `server/processingRepository.js`
   - Migration 27 compatibility.
   - Singleton acquisition/release and stale lease terminalization.
   - Token fencing and idempotent registration.
   - Required-readiness transition.

2. `server/derivativeWorker.js`
   - Disk-pressure abort behavior.
   - Crash windows around `.incomplete`, `.complete`, final rename, and SQLite registration.
   - Re-verification and quarantine behavior.
   - Confirmation that prior successful versions are never deleted.

3. `server/workerSupervisor.js` and `server/sqliteLockPreflight.js`
   - Signal forwarding, restart limits, stale-heartbeat detection, and SQLite/ZFS assumptions.

4. Import paths
   - `server/processingWorker.js`
   - `server/webodmTaskImport.js`
   - `server/catalogImport.js`
   - Confirm every eligible new ingest requires KTX2 before readiness.

5. Provenance parity
   - Ensure all five policy/validation surfaces listed above accept exactly the same legacy and KTX2 contracts.

6. Browser behavior
   - Confirm KTX2 loading does not alter strict `REPLACE` traversal.
   - Review color-space, alpha, WebGL-context-loss, and low-memory acceptance coverage.

7. Deployment boundary
   - A push to `main` builds `ghcr.io/ledgetoptechnologies/3d-viewer:latest`.
   - Do not deploy/restart TrueNAS against this image until church acceptance is complete.

## Pre-push verification snapshot

The final local changeset completed these checks before the review push:

- `npm run check`: 523 tests, 512 passed, 0 failed, 11 skipped because their real-browser/environment prerequisites were not configured for that run.
- All 32 focused database, lease, deadline, supervisor, process-tree, cleanup, symlink, and storage-safety tests passed.
- Docker Compose resolved successfully with the production environment-file path overridden only for local validation.
- The production Dockerfile built successfully as `3d-viewer:ktx2-codex-review-final`.
- The in-image Obj2Tiles smoke produced schema version 3, 57 audited artifacts, and 83 compressed textures.
- The image contains the matching Basis JavaScript and WASM transcoder files.
- A prior real-Chrome acceptance run decoded the KTX2 B3DM textures as GPU compressed textures without runtime exceptions.

## Remaining production gates

- Full local test suite and image smoke checks must be green for the pushed commit.
- Codex independent review.
- TrueNAS conversion/resource profiling on a new church version.
- Authenticated normal and forced-4-GiB church browser acceptance.
- Explicit approval before changing the running TrueNAS stack or publishing the new version.
