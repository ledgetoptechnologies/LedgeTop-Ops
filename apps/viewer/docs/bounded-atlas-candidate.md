# Bounded atlas candidate: qualification required

This source candidate repairs the texture allocation path that the outer-worker
limit alone did not bound. It is not installed or accepted for client processing.
Do not publish or activate it until the converter, verifier and supported recovery
path have been qualified together.

## Inputs and behavior

- Upstream Obj2Tiles v1.6.2 archive SHA256:
  `79093e12f6eab2cfcd522aebe670892c5d8874e160956b84f3e55c77b94ac0b5`.
- Complete patch against that pristine archive:
  `98c641e28a7711708a46e8a3bcabb6ceea689b8488b09ae60a5c19868e7d9317`.
  This is a composed patch, not concatenated patches against different baselines.
- The initial command is serial and explicitly sets `--max-texture-size 0`.
  It preserves source texel density together with the new allocation guards;
  that flag alone would not solve memory exhaustion.
- Source rasters are limited to 8,192 pixels per edge; padded atlases to 16,384.
  One maximum RGBA atlas is 1 GiB. The ImageSharp retained pool is capped at
  128 MiB and allocation groups at 2,048 MiB. These are allocation guards,
  **not a total process-memory guarantee** or qualification for a 4 GiB worker.
- KTX mip upload now reuses one row buffer of at most 64 KiB. Level zero
  borrows the loaded image; lower mips keep the same direct-base Lanczos path.
  The loaded source is disposed after native mip upload and before Basis
  compression. This removes avoidable managed buffers, not native workspace.
- Material-owned decoding, serial atlas saves and deterministic disposal replace
  shared decoded-texture retention and unbounded save-task fanout.
- The qualified candidate profile rejects unsupported texture roles/options.
  Its diffuse-only scope must be explicit; normal-map fidelity is not established.
- LOD0 atlas UVs use the actual integer source crop and pixel placement.
  KTX2 ETC1S remains lossy compression; preserved density does not mean
  byte-identical final decoded KTX pixels.

## Independent evidence

The converter retains streamed mapping records and raw atlas proof rasters before
temporary split files disappear. Include those private proof bytes in admission,
transfer and cleanup accounting; they are not browser render resources.

`scripts/verify_atlas_proof.py` independently checks the declared diffuse source
closure, LOD0 crop pixels and affine UV mapping using bounded raster windows.
Its receipt explicitly leaves original geometry coverage and final KTX
equivalence unverified. A passing receipt alone cannot publish an output or
trigger Viewer readiness/acceptance. PNG-only runtime checks do not establish
support for every source format or coarse JPEG atlas.

Historical converter arguments, hashes, binaries and schema-2 metadata remain
readable. Only exact current build inputs grant current generation trust. A
serial resource failure retains evidence instead of clearing and repeating an
identical command.

## Release gates

1. Independent patch review, licensed locked build, NUnit and actual converter
   fixtures with bounded measured memory; preserve all first failures.
2. Exact-image Python/GDAL, allowed-driver, path and raster-window qualification.
3. Original OBJ/MTL/archive-to-split geometry coverage and final embedded
   KTX/material/UV relationship, separate from raw atlas pixel checks.
4. Supported source-bound, leased and idempotent recovery of the retained failed
   attempt; no database patch, filesystem injection or reconstruction retry.
5. Actual Viewer rendering and matching durable acceptance for that attempt.

Keep the existing originals/results protected and automatic cleanup/update timers
disabled. Ordinary staging tests do not authorize a production rollout.

## Row-upload revision status

The preceding `3e6294c9` source and `f4779ac4` binary retain their tiny synthetic
qualification evidence. The subsequent full-resolution test reached two actual
16,384-pixel raw atlases, then the first KTX conversion was killed by the 8 GiB
cgroup limit. GNU Time reported 8,402,928 KiB maximum RSS and signal 9. Raw crop,
UV, root and full-size KTX consumer gates did not complete.

This row-upload source revision requires a fresh licensed build and all 38
selected NUnit cases (21 library and 17 KTX), followed by measured converter
qualification. No new binary, memory pass, runtime deployment or client
acceptance is implied by the updated source pins. The dependency lockset is
unchanged.
