# Depth-overlap and movement LOD repair

## Evidence and scope

The independent review reproduced five mechanisms on `ced21687b2613575251ead9aea8fe39d5948ca58`: camera motion globally restored raw SSE; an unready sibling could hide cached foreground under a shared REPLACE parent; sphere/cone overlap was not occlusion; focus/whole-cut retention had boundaries; and prior browser fixtures lacked depth-overlapping surfaces.

This repair does not change Operations, imports, converter/audit policy, derivatives, authentication, or memory profile limits. It does not convert REPLACE to ADD, force overlapping visibility, or implement speculative occlusion culling. Detail 20 remains raw SSE 5.481, Detail 24 remains 2. Pointer movement does not select quality.

## Changes

1. Classify the known hierarchy bottom-up each frame, once per node. Only genuinely unknown descendant paths stay conservatively raw. Camera movement no longer expands every background branch to full quality.
2. Where a direct shell has suitable positive-error regional children, prepare one complete regional fallback cover before its first fine cut. Requests are serialized, measured against the existing transition allowance, and bounded by tile count, timeout, and refusal cooldown. Existing sharp cuts are never newly gated. No suitable cover means ordinary strict REPLACE remains in effect.
3. A completed cover separates the broad owner's quality lock: its acquired near region stays at requested quality even below screen center; distant regional subtrees can relax under pressure. The broader lock still orders requests. Unknown bounds and current foreground relevance retain conservative protection.
4. Regional residency and recent fine-cut retention share one byte allowance, excluding already reserved proxies from recent-cut accounting. No extra global memory cap or permanent ancestor retention is introduced.
   Switching owners preserves at most four historical complete covers (64 tile references) as fallback metadata while their proxy scenes remain cached. They are not pinned or proactively re-requested; disposal of any member removes that historical cover's eligibility. This prevents a focus switch alone from discarding a usable regional fallback.
5. Coalesce equal/larger known-size admission refusals within one unchanged frame/cache/priority context. Smaller allocations, actual headroom, changed context, and every new frame can retry immediately. Download and parse work is not delayed by a timer.
6. Add bounded structured tile/owner traces distinguishing selected, cached, attached, kicked, downloaded, and disposed states. Attachment means actual membership in renderer-group children, not merely a parent pointer.

## What testing established

The new real-Edge fixtures put near surfaces and delayed background geometry at different depths, both under different base owners and under a shared owner with regional proxies. They assert coverage throughout an active orbit gesture, not just after settlement. The test also documents the unsplit leaf-sibling limitation using the actual patched renderer traversal.

Before the regional fix, adding background hid four warm near tiles despite their unchanged cached scenes. After regional preparation, coverage was stable but the broad focus lock still demanded all 44 fine tiles and stalled at the cap. Narrowing the quality lock let the same fixture settle with four near fine tiles and ten coarse rear proxies: 1504 MiB final residency, 3808 MiB peak under a 3840 MiB cap. Near scene identities stayed unchanged and no near URL was fetched again.

Thousands of reported pressure events were mainly repeated prequeue admission checks, not repeated network downloads. The wrapper reduces these redundant recovery scans without suppressing post-parse safety checks.

Final frozen-source validation:

- Focused policy, traversal, regional lifecycle, admission, and diagnostics: **100 passed, zero skips**.
- Real local Edge LOD plus workspace/sharing suites: **26 passed, zero skips** (14 LOD and 12 workspace/sharing). Includes desktop, 390px, and 320px layouts.
- Complete Linux test suite in the isolated Docker build image: passed, exit 0. Browser-dependent tests are separately covered by the no-skip Edge run above.
- Fresh pinned renderer installation and upgrade from the previous patched installation produce identical source/build files; a second patch application makes zero writes.
- Vite production build and whitespace validation pass. Production runtime converter verification passes with v4 provenance, 57 artifacts, and 83 compressed textures; both authenticated readiness tests pass inside the non-root runtime image. CI is checked before release handoff.

Synthetic byte weights test admission behavior, not physical allocation of multi-gigabyte GPU textures.

Reproduce the real browser run in PowerShell with local Edge/Chrome installed:

```powershell
$env:LTDS_LOD_TEST_TILE_ROOT = Join-Path (Get-Location) 'test\fixtures\ktx2-tiles'
node --test --test-concurrency=1 test/lod-browser-acceptance.test.mjs test/workspace-project-browser.test.mjs test/project-share-browser.test.mjs
```

## Remaining limits and production verification

- A single leaf region can still contain both a facade and geometry behind it. Without a finer authored proxy, strict REPLACE must wait for that region's complete selected leaf cut. Priority or cache tuning cannot safely split a tile's geometry.
- Bounding spheres and screen cones remain conservative approximations, not a visible-surface/depth buffer. This release does not prove how many Church bytes belong to fully occluded geometry.
- If a regional cover exceeds its transition allowance, fails, or is not supported by the derivative topology, telemetry reports that reason and ordinary coverage remains. It must not silently increase memory or fabricate completeness.
- A historical regional cover can legitimately disappear after cache eviction; its base shell remains the safe fallback. Metadata-only history does not guarantee permanent sharpness across unlimited travel.
- Production Church good/bad camera poses and real KTX2/GPU residency require retesting after deployment. Passing synthetic tests is not proof of every production angle.

No re-import or derivative retry is required for these client-side changes. After pulling the verified Viewer image, open a fresh session and test front-on facade, upward tilt, roof orbit, and tiny pan/zoom at the same memory profile. Leave the foreground visible while bringing more background into view.

For a remaining failure, export before-motion, during-motion, and settled snapshots from the console:

```js
copy(JSON.stringify(window.__ltds.lodOwnerDiagnostics({ maxTiles: 2048 }), null, 2))
copy(JSON.stringify(window.__ltds.lodTileEvents(), null, 2))
```

Also capture the existing LOD status payload (regional fallback phase/reason, admission counters, effective targets, cache and queue counts). Owner diagnostics use local numeric identities, not signed asset URLs. Compare whether foreground scenes were disposed, merely hidden, or never admitted; record regional fallback availability before proposing a topology change.
