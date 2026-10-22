# LOD derivative contract

The investigation, CesiumJS comparison, Obj2Tiles contracts, branch history,
and Codex review checklist are in [LOD_RESEARCH_AND_CODEX_REVIEW.md](LOD_RESEARCH_AND_CODEX_REVIEW.md).

The target interaction is Nira-like: show a lightweight overview immediately,
refine only the visible areas as they occupy more screen pixels, reach the full
source quality at close range, and return to lower-detail tiles as the camera
moves away. Nira itself uses server-side pixel streaming; this self-hosted
Viewer instead streams 3D Tiles to the browser and renders them locally.

## Required hierarchy

- `tileset.json` and every external child tileset use `REPLACE` refinement.
- Parent geometric errors decrease monotonically toward the leaves.
- Every internal tile has a strictly positive geometric error. An internal
  zero-error tile already satisfies the renderer's refinement target, making
  its nominally full-quality children unreachable.
- Every terminal leaf has renderable content and `geometricError: 0`.
- Tiles are spatially partitioned. A chain of whole-model LOD files is not an
  acceptable substitute because approaching one area would download the whole
  high-resolution model.
- LOD-0 leaves preserve the source mesh geometry and textures. Intermediate
  levels may be decimated and may use reduced textures.
- All content uses local relative paths and every referenced file is non-empty.

The renderer calculates screen-space error every frame. Its configured error
target decides when a tile refines; there is no fixed camera-distance switch.
When the camera is inside a tile bounding volume, the renderer may report an
infinite screen-space error. A visible terminal leaf with `geometricError: 0`
still satisfies the target because it has no finer child to request. Infinite
error on a non-terminal or non-zero-error tile remains unsatisfied.

With ancestor loading disabled, queue priority is camera-driven rather than
SSE-driven: used and in-frustum content first, then nearest camera distance,
then shallow depth for stable ties. Sorting by highest SSE first starves nearby
zero-error leaves behind farther positive-error parents and produces the exact
symptom where distant regions sharpen before the foreground.

The persisted and runtime hierarchy remain `REPLACE`. The renderer keeps the
currently displayed parent until its selected children are content-ready, but
`loadAncestors`, sibling preload, and ancestor-sibling preload are disabled so
replaced fine paths can become unused and leave the cache. The Viewer does not
manually toggle cached scene visibility or tile active/visible state.

A renderable-root hierarchy bootstraps complete coverage before normal detail:

1. Select and display the whole-model root.
2. Limit traversal to depth 2 and prefetch the renderable direct-child shell.
   Off-frustum direct siblings may be requested during this bounded phase, but
   grandchildren and deeper content may not be requested.
3. Require every renderable direct child to be decoded for two consecutive
   frames and require the complete shell to fit its derived fallback budget.
4. Promote the complete shell as the only scoped `REPLACE` fallback, retire the
   root from steady fallback retention, restore unlimited traversal depth, and
   apply the raw requested camera SSE immediately.

The three-second prefetch time is a diagnostic milestone, not permission to
promote a partial shell. An incomplete direct shell would allow a later camera
angle to reactivate the whole-model root and hide every ready descendant. A
structurally unsupported, empty, or over-budget shell therefore stays honestly
root-only. Clients reporting 4 GiB or less also stay on the root, remain capped
at Detail 13, and use the constrained 768 MiB soft / 1 GiB hard profile.

The direct shell is bounded independently from focal detail. Its preferred
retention is profile-specific, its absolute ceiling is 1.5 GiB, and promotion
must leave at least 1.625 GiB for the selected focal branch. The item-count cap
is only a 1,024-item failsafe; decoded bytes are the real admission guard.
Recently visible detail is retained as complete fallback-owner cuts rather than
individual tiles, so a partial warm cut cannot force a brief coarse-parent
rollback after a tiny camera move.

Detail `2..24` maps exponentially from SSE 512 down to 2. Detail 20 is `5.481`
and Detail 24 is exactly `2`, independent of the bootstrap hierarchy. A
camera-centered focus plugin transforms each tile bounding sphere from the
tileset-root frame through `TilesRenderer.group.matrixWorld` before projecting
it. This is required because the Viewer parents the renderer under a rotated
and translated model frame. Mixed coordinate spaces produce deterministic but
wrong, angle-dependent foreground selection.

Focus affects request/parse priority while moving, never authored visibility or
the raw selection target. Peripheral queue work receives a 1–4× penalty that
starts decaying after 250 ms idle and reaches neutral after another 500 ms. A
focused replacement owner and its descendants keep raw SSE until the completed
camera cut moves by a cumulative 3-degree view turn or 5% of the positive
camera-to-owner reference scale. The reference remains positive when the camera
is inside a large bounding volume. Under persistent cache pressure only tiles
fully outside the center region may receive a temporary SSE relaxation; the
focused branch is never coarsened.

Memory modes resolve as follows:

| Mode | Soft cache | Hard cache | Notes |
| --- | ---: | ---: | --- |
| Auto, capable desktop | 3 GiB | 3.75 GiB | Browser hint is at least 8 GiB. |
| Auto, unknown / Balanced | 2.5 GiB | 3.125 GiB | Safe fallback when no hint exists. |
| High | 4 GiB | 5 GiB | Explicit capable-desktop choice. |
| Constrained | 768 MiB | 1 GiB | Forced for a known ≤4-GiB client. |

The generated browser fixtures verify root-first startup, bounded direct-shell
promotion, descendant refinement, A→B→A focus reacquisition, 1/2/4/8-pixel
movement stability, complete-cut retention, strict hard admission, and shared
LRU lifecycle cleanup. Unit tests also cover a non-identity Viewer parent frame,
camera-inside-volume pan hysteresis, and linear visited-cut ancestor propagation
without scanning the entire known hierarchy for every tile.

See [`VIEWER_LOD_CAMERA_HANDOFF.md`](VIEWER_LOD_CAMERA_HANDOFF.md) for historical
measurements, superseded approaches, and diagnostic commands.

## Full-quality attestation

The conversion job must run the repository audit; it must not hand-author a
preservation assertion:

```bash
npm run audit:lod -- /path/to/derivatives/project-task /path/to/derivatives/project-task/model.glb
```

The bundled, checksum-pinned converter accepts textured OBJ. Experimental
generation requires both the OBJ (including its MTL/textures) and an independent
companion GLB. Standard WebODM task backups commonly satisfy this source
contract with `assets/odm_texturing/odm_textured_model_geo.obj` and
`assets/odm_texturing/odm_textured_model_geo.glb`. Production requires current
KTX2 generation for eligible new OBJ+GLB work even when the bundle includes
legacy JPEG tiles. The generated tree is registered only after its controlled
proof succeeds. Existing ready and published versions are immutable: there is
no legacy-model reconciliation or manual in-place retry. Operators may set
`MESH_DERIVATIVES_ENABLED=false`, but an eligible required job then fails closed
instead of becoming ready with missing or legacy streaming assets.

GLB-only and OBJ-only inputs deliberately remain downloadable originals, but
are not interactive Viewer layers. The runtime image contains the pinned
Obj2Tiles converter for the audited OBJ+GLB contract only; format conversion
alone is not proof that node transforms, materials, samplers, UVs, texture
bytes, and coordinates survived. Do not add a best-effort single-format
conversion or declare generated tiles valid without an independent source mesh
that the audit can compare. Supporting a single-format source needs a
separately pinned converter, conversion-preservation tests for representative
textured and georeferenced fixtures, and the same fail-closed LOD audit before
registration.

Only after the v2 audit has parsed and compared the source GLB (including
checksum-locked Draco decoding when `KHR_draco_mesh_compression` is required)
with the aggregate zero-error leaf frontier does it atomically write
`lod-provenance.json` beside `tileset.json`:

```json
{
  "schemaVersion": 2,
  "sourceAsset": "model.glb",
  "sourceSha256": "<sha256 of the exact full mesh>",
  "geometry": "bounded-triangle-equivalence",
  "textures": "byte-identical-material-equivalence",
  "leafGeometricError": 0,
  "audit": {
    "algorithm": "ltds-glb-leaf-equivalence-v2",
    "coordinateTolerance": 0.000001,
    "maxNumericDelta": 0,
    "triangleCount": 123456,
    "leafTriangleCount": 130000,
    "duplicateLeafTriangleCount": 6544,
    "equivalenceSha256": "<sha256 of canonical source triangles/materials>",
    "artifacts": [
      { "uri": "tileset.json", "sha256": "<sha256>", "byteLength": 1234 },
      { "uri": "tiles/leaf-0.b3dm", "sha256": "<sha256>", "byteLength": 5678 }
    ]
  }
}
```

The audit compares canonical, winding-preserving triangle streams after GLB
node transforms, 3D Tiles transforms, JSON `RTC_CENTER`, and `CESIUM_RTC`. It
compares every vertex attribute used by each primitive, render-affecting
material state, sampler state, and the exact bytes of every used texture. It
also records a SHA-256 and byte length for every tileset, leaf, and external
texture dependency. At model discovery the Viewer independently re-hashes the
selected source and all recorded artifacts. A missing, changed, renamed,
legacy-v1, or hand-authored assertion removes the tiles from the interactive
Viewer instead of falling back to browser decoding or making a false
full-quality claim. The original GLB remains available through authenticated
Operations downloads.

The default coordinate/attribute tolerance is `1e-6` model units and the audit
records the largest observed delta. `--tolerance` may lower it or raise it only
as far as `1e-3`; choose a bound appropriate for the source coordinate units.

### Deliberately unsupported proof cases

The v2 algorithm decodes `KHR_draco_mesh_compression` through the repository's
locked `draco3d` dependency and fails closed on malformed accessor/semantic
bindings. It still fails closed for meshopt-compressed geometry, sparse
accessors, morphs, skins, GPU instancing, non-triangle primitives, external GLB
buffers, alternate compressed texture-source extensions, binary
`RTC_CENTER`, or remote URLs. Decode these into the supported GLB/B3DM subset
inside the trusted conversion job before auditing.

Spatial partitioning itself is supported by v2 when leaves retain the source
triangles. Exact opaque copies at adjoining partition boundaries are treated as
bounded overlap and recorded separately; missing triangles and additional
non-source geometry still fail closed. If an imported/native tiler clips
triangles at tile boundaries, retriangulates the surface, or repacks texture
atlases, v2 rejects it because exact equivalence is no longer provable.
The production Obj2Tiles invocation deliberately uses a bounded texture-atlas
contract instead of `--keeptextures`: on a representative 2.53 GiB textured
WebODM model, `--keeptextures` duplicated source textures into more than 157
GiB before completion. Current generation adds `--texture-format Ktx2
--ktx2-quality 192`, producing ETC1S textures that remain GPU-compressed through
Three.js `KTX2Loader`. The runtime smoke test executes the pinned converter,
requires generated `KHR_texture_basisu` / `image/ktx2` payloads, runs the
controlled audit, and fails the image build if any stage is missing.

The converter is built from the SHA-256-pinned upstream v1.6.2 source plus a
SHA-256-pinned local scheduling patch. LOD split/write stages run sequentially
with at most two outer workers, while ImageSharp is limited to one worker.
Structured resource diagnostics contain only exception types/HRESULTs and
aggregate process/cgroup counters. An explicit scheduler or memory-pressure
failure permits one clean, serial whole-conversion retry; semantic conversion
errors do not retry. Retry cleanup is limited to the current lease token's
incomplete directory and remains fenced by the original abort signal and job
deadline. Build metadata binds the source, patch, version, and binary digest;
published-image CI checks those pinned inputs and independently hashes the
runtime executable. The runtime image contains no SDK and needs no network.

Locally generated output uses controlled-converter schema v3 or v4 instead of
weakening exact v2. Both bind the approved architecture-specific Obj2Tiles
1.6.2 executable and exact KTX2 command, GLB and OBJ digests, every audited
artifact, a valid zero-error frontier, full-detail bounds/area/centroid/second
moments, deterministic bidirectional BVH samples in rebased coordinates, and
all-triangle opaque textured base-color/TEXCOORD_0 coverage. V3 preserves its
original `1e-5` surface-area limit. V4 adds compensated forward/reverse
accumulation and may accept the narrow `(1e-5, 1.2e-5]` gray zone only when the
stricter spatial, moment, bidirectional-distance, normal, UV/texture, converter,
and artifact evidence all pass. Missing or added geometry still fails, and the
policy is never widened automatically.

At atomic registration the server stores a durable verifier receipt that binds
the attempt, version, source, canonical manifest, policy/schema/equivalence
evidence, and complete canonical provenance digest. Session configuration may
assets still validate. This lets the current server authorize a valid converter
contract that an older deployed browser bundle does not yet recognize, without
making browser startup depend on a duplicate hash list. It does not bypass the
server's converter policy, audit structure, source binding, artifact
hashes, or manifest integrity. The unpublished OBJ remains available only to
server verification; published and client sessions expose no private proof
asset.

The controlled path accepts bound `KHR_texture_basisu` sources while imported
exact-v2 audits continue to reject alternate compressed sources unless their
exact texture identity can be proved. Shifted or missing patches, unapproved
executables, missing UVs, and untextured materials fail closed.
The server enables the worker stage when an older deployment omits the variable.
Setting `MESH_DERIVATIVES_ENABLED=false` makes eligible required OBJ+GLB work
fail closed; it does not bypass KTX2 readiness. Verified imported tiles may
stream when no eligible OBJ+GLB source is available.
The original GLB is never an interactive layer and remains available only through
authenticated Operations downloads. A model without verified tiles is explicitly
unavailable or processing in 3D mode instead of risking a full-resolution browser
decode.

Automatic generation remains verification-gated. New NodeODM and import work
with an eligible OBJ+GLB mesh stays in `derivatives` until the required KTX2 tree
verifies, even when the source bundle includes legacy JPEG tiles. A terminal
failure is reported as a failed job rather than a misleading ready result.

Successful ready and published versions are immutable. Existing verified JPEG
provenance remains readable. A failed local derivative may be retried through
its durable dataset recovery operation, which reuses the retained source
closure and produces a new candidate version; it never mutates or silently
switches a published asset tree. While that recovery is retryable, its source
and target outputs and their parent task/project are protected from deletion.
Imported/native tiles stay on exact v2; only the trusted local generation call
site may request controlled v3/v4. Do not manually change provenance or
derivative state.

## Validate before deployment

```bash
npm run validate:lod -- /path/to/derivatives/project-task /path/to/full/model.glb
```

Run the audit first, then this independent validator. It recursively validates
the root and external child tilesets, zero-error leaf frontier, content
paths/files, source digest, and every artifact digest in the audit evidence. A
valid result is necessary but real hardware QA is still required: start far away,
move close to several different regions, confirm detail increases without
holes, move back out, and verify memory settles rather than growing without
bound. Repeat on a representative phone viewport/device.
