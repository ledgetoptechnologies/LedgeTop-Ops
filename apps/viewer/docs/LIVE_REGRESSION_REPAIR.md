# Production retest: decoder, recovery products, and regional admission

Baseline: `b88620bc3c16f80247c9921f1a439085c96936d4`, freshly fetched from `origin/main`.
Work branch: `codex/lod-live-regression-repair`. Operations is out of scope.

## Evidence captured from the user's Edge window

The live Church view shows discontinuous triangular brick patterns on the front gable. After the user orbits toward sky and returns to a similar facade view, the same area is sharp. These are screenshots and console observations, not identical saved camera matrices.

| Observed state | Blurry facade | Sharp facade after orbit |
| --- | --- | --- |
| Requested / active detail | 20 / 20 | 20 / 20 |
| Raw SSE | 5.481 | 5.481 |
| Peripheral pressure scale | 4 | 4 |
| Base shell | 16 tiles, 1301 MiB | unchanged |
| Cache / hard cap | 5119 / 5120 MiB | 5120 / 5120 MiB |
| Selected required leaves | 166 | 186 |
| Attached required leaves | 35 | 13 |
| Pending required leaves | 131 | 173 |
| Download / parse / process queues | all zero | all zero |
| Regional cover | admission-refused, no current cover | complete, 4/4 ready |
| Regional cover bytes | 0 retained | 757888510.67 bytes (about 723 MiB) |
| Optional regional allowance | 768 MiB | 768 MiB |

The sharp facade does **not** mean the entire requested frontier converged. It proves that a useful regional cut can complete within the existing allowance, and that load history matters. The regional allocation is not universally too large on this legacy Church. Earlier synthetic tests did not establish production convergence.

The Rome session exposes only a model tab and remains on “Streaming LOD tiles.” Its console reports a JavaScript `EvalError` in the Basis transcoder's `newFunc` / `craftInvokerFunction` / embind initialization: dynamic JavaScript evaluation is blocked by the production CSP. The first tile is stuck parsing, with zero visible tiles and zero cached MiB. Do not confuse this decoder failure with Church cache admission.

The second Church import has not yet been independently captured in this retest. The same compressed decoder path is a candidate, not a confirmed attribution.

## Verified source findings and current work

- [x] Re-fetch main and preserve dirty primary checkout.
- [x] Capture broken and recovered Church views plus Rome's actual decoder error.
- [x] Fix external/contentless-root startup retaining `maxDepth = 2` after bypassing bootstrap. Actual-listener plus installed-traversal tests cover deep refinement and reduced-memory control. This is a separate conditional bug, not yet the observed second-Church cause.
- [x] Make the pinned Basis JavaScript glue compatible with production CSP without allowing general JavaScript `unsafe-eval`; run real compressed-tile browser tests with those headers. Keep upstream WASM byte-identical and reject active/queued texture jobs on worker failure instead of leaving parsing stuck indefinitely.
- [x] Preserve registered non-mesh products in new mesh-recovery version ownership, including hierarchy/chunk manifests and camera-photo links. Include their bytes in materialization reservation/storage, not mesh derivative input size.
- [x] Provide a safe explicit remediation for existing mesh-only recovery versions. The **Restore missing products** action creates a new independent version and verifies copied tiles, with no automatic publication or reconversion. See [the recovery procedure](LOD_COMPANION_REPAIR.md).
- [x] Prevent immediate regional admission refusal from releasing preparation before the next traversal can reclaim speculative work. Keep complete base coverage and already-visible detail protected; bounded wait/size/timeout only.
- [x] Test two equally near building sides. A complete regional cover can now protect up to four near regions with distance hysteresis and whole-cut cost accounting. It does not widen all background content to raw SSE or preload an unrestricted high-resolution hemisphere.
- [x] Full focused, browser and Linux suite verification. Production-runtime/readiness checks and remote CI remain mandatory release gates.

## Other-viewer comparison

Cesium offers optional sibling preloading for turns, but it is off by default and only applies with skip-LOD traversal. Its foveated policy defers peripheral requests during movement; its cache has explicit overflow limits and adjusts the requested error when the view cannot fit. Those are useful bounded scheduling ideas, not evidence that unconditional high-detail hemisphere loading is safe here. See the [official Cesium3DTileset reference](https://cesium.com/learn/cesiumjs/ref-doc/Cesium3DTileset.html).

## Release truthfulness

No production dataset mutation, deletion, re-import or retry has been performed in this investigation. Current observations do not establish identical-pose convergence, frame-by-frame retention, or complete refinement of either Church derivative. Report verified tests separately from production results.

The regional fix requires a suitable completed cover in the authored hierarchy. It does not split a tile's geometry, implement occlusion, or guarantee that an oversized foreground cut fits memory. Unknown decoded allocations use a heuristic estimate; the actual admission hard cap remains authoritative. Synthetic weighted cache tests do not allocate that amount of physical GPU memory.

The status display now distinguishes a memory-limited requested target and pending tiles from completed visible detail. Detail 20 remains raw SSE 5.481; Detail 24 remains 2. No model regeneration is needed for the decoder, startup, or runtime-selection fixes.

## Local verification

- Combined focused runtime/startup/decoder/workspace tests: 116 passed, zero skips.
- Independent decoder review: no actionable blocker; actual production-CSP compressed-texture browser test passed without relaxing CSP.
- Linux recovery/import/accounting/integrity tests: 118 passed, zero skips, including the real derivative worker, corrupted chunk proofs, source-directory races, and new-version repair.
- Real two-near-wall regression: eight fine tiles across the two near surfaces remained stable across 115 motion/settling samples, with no gaps, overlaps, or refetches; weighted peak 3808 MiB below the 3840 MiB cap, distant proxies coarse, zero pending at completion.
- Combined local Edge LOD/workspace/public-sharing suites: 36 passed, zero skips, including actual KTX2 GPU decoding under the production CSP, desktop/mobile UI and the server's real product-repair operation format.
- Complete Linux production build and test suite: 838 tests, 821 passed, zero failures, 17 expected skips (16 browser cases covered by the separate Edge run, plus the opt-in TrueNAS bind-mount environment test).
- Runtime-image/readiness and remote CI results are recorded in the release handoff; they must pass before this work is called a verified release. Local testing cannot attest the user's actual TrueNAS mounts.

After deployment, open a fresh Church/Rome session to test the new decoder and compare the Church front-on facade, skyward tilt, two-sided corner, and roof motion at one unchanged memory setting. For Rome's missing products, use the explicit new-version restore action rather than deleting or re-importing the dataset. Production camera-pose confirmation remains necessary; local fixtures are not a claim that every Church angle is fixed.
