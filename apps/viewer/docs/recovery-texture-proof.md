# Real-data verifier components in progress

This branch is separate from qualified recovery/image candidate9fdd3136. It does
not install an adapter, route, image or runtime. Current components establish
only the named intermediate relations. They cannot authorize readiness alone.

`scripts/lib/texture-relation-policy.mjs` consumes contiguous RGBA8 row bands.
It counts every pixel, compares RGB where raw alpha is positive, compares alpha
everywhere and reports image/512-square-region statistics, channel quantiles,
maxima, coverage and failure coordinates. Frozen candidate gates are image RGB
MAE10/RMSE16, nonempty-region RGB MAE16/RMSE24, alpha maximum20/MAE2. It retains
only counters/histograms and a region row, not image buffers. Natural-photo
calibration and wrong-image/orientation/alpha/channel negatives are required
before acceptance; candidatePass explicitly is not verification or readiness.
The metrics have a measured sensitivity boundary: a64x64 region differing by128
RGB levels inside a512x512 image gives MAE2/RMSE16 and can pass. Calibration must
record this localized-corruption case rather than promise detection of all wrong
content. Exact source/mapping/material/image association remains independently
mandatory; do not tune gates against a failing real-model candidate.

`scripts/lib/lod-texture-association.mjs` reads the pinned current Obj2Tiles
writer's static, non-instanced, identity-transform, self-contained B3DM profile.
It includes root and parent content in the render inventory and requires terminal
LOD0 content for the current three-LOD command. It checks embedded KTX dimensions
and mip ranges, image/material selection, bounded position/UV accessors and index coverage.
It streams declared face records into cyclic float32 position/UV/material hash
multiplicities, preserving winding and duplicate counts. Expected V inversion
matches the writer; signed zero is numerically normalized. This does not replace
the existing V4 geometry audit, original-source UV association or Basis decoding.

Resource admission is explicit: at most512MiB per B3DM,16MiB JSON,4million triangles,
12million vertices,16K image edge and128MiB per embedded image. Accessors do not
allocate arrays from counts. Reused accessor ranges are validated once, with
aggregate component work bounded by512MiB and early triangle admission. Image hashing checks cancellation, caches identical
immutable ranges and limits aggregate hashing to512MiB. Unused textures/images
are refused. An unused resource-free PBR default material is separately accounted
for because it is emitted by SharpGLTF in the real positive capture; it cannot
introduce an omitted texture. Unsupported transforms, animation/skinning,
external resources, extra texture channels and malformed data fail closed.

Actual captured synthetic output was checked read-only, without extraction,
native execution, pixel decoding or new large allocation:44 render contents,
29LOD0 contents,66 declared/emitted triangles and47 used image identities pass.
Source tests also exercise12,000 streamed triangles, wrong UV/material/winding,
missing/duplicate records, orphan images, index bounds and cancellation.
These results do not establish capacity or acceptance for the real model.

`pinned-basis-decoder.mjs` copies and SHA-pins the exact cached Basis JS/WASM before
trusted execution, requires the observed ETC1S/sRGB/straight-alpha/right-down
metadata and yields one RGBA mip buffer at a time without copying the full output.
It closes/deletes the native texture on completion or early return. The caller
must consume every mip and release each buffer before advancing. This belongs in
an isolated proof child; actual WASM execution has not been qualified locally.

`stream_atlas_rows.py` reuses the PNG-only Byte RGB/RGBA backend and16MiB GDAL cache.
It checks source hash/identity before and after streaming bounded full-width RGBA
rows, with no PAM or sidecar discovery. `raw-atlas-rows.mjs` requires exact framing,
dimensions, source digest and byte counts; it waits for final child exit0/reap
before returning statistics. Abort, timeout, errors and early iterator return
terminate and await the owned child. Decoder/source interpretation metadata is
retained. Actual Python/GDAL child behavior still needs Linux qualification.

The complete adapter still needs actual pinned-source/slot paths, all-LOD0
SourceUvIndex/final checks, raw atlas verification, every used image/mip decoding,
calibrated full-count photographic comparison and complete server-verifiable
render-only provenance. The established geometry contract remains V4 aggregate
and bidirectional surface policy on the actual canonical GLB/OBJ/candidate.
SourceUvCoverage describes association of every candidate full-detail triangle;
no exhaustive source-face union or universal decoded-pixel equality is claimed.

Run heavy proof in bounded, reaped children so parent lease heartbeats remain
responsive. Preserve the custody fence through child completion/cancellation.
Image dependencies, native ABI, calibration, real source/model evidence and the
supported same-attempt intake/ready/ACK path require independent qualification.
