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

`verify_recovery_raw_uv.py` consumes the host's exact reachable-LOD0 inventory,
binds every B3DM digest, checks raw atlas pixels and source-UV association using
the established primitives, and publishes its receipt only after all tiles and
the once-final retained-input check. A strict prepared-source object independently
builds the source closure once; tile/index snapshots recheck every file identity
and return copies. This avoids rescanning the entire OBJ/texture set per tile.
Default standalone verifier behavior is unchanged. Its receipt explicitly does
not establish emitted B3DM association, decoded KTX equivalence or geometry.

`verify_recovery_textures.mjs` and `texture-output-proof.mjs` connect the real
filesystem, SHA-pinned decoder, streamed mapping records and GDAL row subprocesses.
Every root/parent/leaf image consumes every mip. LOD0 additionally requires exact
emitted/declaration multiplicity and raw-image identity/size/hash binding, then
full-count level-zero statistics. Metrics are published only after the image's
last mip and decoder cleanup. Earlier files retain their identities through the
last tile. The bounded receipt includes the exact raw-verifier inventory and its
hash, all render artifacts, metric digest and actual coverage counts. It remains
candidate evidence with calibrationRequired and false source/geometry/ready flags.
It does not automatically run the Python source proof, existing V4 audit or change
server state. The host must enforce immutable mounts, process-tree limits and a
deadline; neither script creates its own runtime admission.

`recovery-render-provenance.mjs` extends a freshly recomputed V4 audit's existing
equivalence digest with the texture runner's complete render inventory, including
root and parents. Every measured leaf must retain its exact bytes and the old
audit digest must still match its measured evidence. Only render files enter
this inventory; raw atlas/proof/source files remain private. Existing geometry
measurements and policy are preserved. The resulting evidence still requires
the server verifier and does not qualify photographic calibration by itself.

`verify_recovery_candidate.mjs --request <private-host-request.json>` now connects
the existing V4 audit, texture runner, all-LOD0 raw/source-UV child and complete
render provenance in one isolated process. The strict request binds the actual
OBJ, canonical GLB and current converter hashes; the installed current converter
policy must accept the exact binary/command pair. Source hashes are checked
again at the end. The Python receipt must bind the exact reachable inventory,
source digest, tile/face counts and completed final checks. Its bounded stdout
is hashed only after exit0 and reap. Private scratch is removed afterward.

`prepare` returns evidence/provenance for the host's pre-intake preparation;
it writes nothing to the derivative directory. `verify` recomputes that same
evidence and requires the already stored provenance to match exactly. Neither
mode changes readiness. The overall result remains calibrationRequired with
ready=false; the existing statistical gates are candidate evidence. The current
PC does not have an installed generation binary/receipt, and the host guards
correctly refuse to substitute a source fixture for that installed trust.

The complete admission adapter still needs custody-derived source/slot paths,
owner-qualified Linux execution of the integrated runner, photographic
calibration and the supported server verifyCandidate/executor wiring. The established geometry contract remains V4 aggregate
and bidirectional surface policy on the actual canonical GLB/OBJ/candidate.
SourceUvCoverage describes association of every candidate full-detail triangle;
no exhaustive source-face union or universal decoded-pixel equality is claimed.

Run heavy proof in bounded, reaped children so parent lease heartbeats remain
responsive. Preserve the custody fence through child completion/cancellation.
Image dependencies, native ABI, calibration, real source/model evidence and the
supported same-attempt intake/ready/ACK path require independent qualification.
