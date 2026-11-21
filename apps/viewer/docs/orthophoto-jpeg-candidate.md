# Full-resolution orthophoto JPEG source candidate

Owner: Model Viewer chat01a16728-6f90-7fa2-9968-3883d150dd83. Isolated branch
codex/viewer-ortho-jpg-20261114; Merger confirmed no overlapping current writer.
This first candidate owns only the source converter, pure plan contract, focused
tests and this document. It is not an installed download feature.

The intended product is a standalone full-pixel-dimension image alongside the
unchanged original TIFF, available for existing models through a separate
source-bound job. It must not be a screenshot, preview, downsample or TIFF with
JPEG compression. The plan binds asset ID, exact model version, TIFF bytes/SHA,
dimensions and explicit flattening background. It does not change authorization.

## Encoding choices

GDAL's JPEG driver accepts three-channel RGB; its four-band input is CMYK, not
RGBA. Therefore the corrected source converter flattens supported Byte RGB/RGBA
and validity masks into a disk-backed RGB PPM in bounded stripes, then invokes
the exact qualified libjpeg-turbo cjpeg binary without optimization/progression.
The plan requires the encoder's SHA-256; no unknown/default binary is admitted.
No EXIF or sidecar metadata is copied. No resize or
automatic radiometric scaling is permitted. Unsupported input layouts must be
reported, not guessed. See [GDAL JPEG driver](https://gdal.org/en/stable/drivers/raster/jpeg.html).
The candidate explicitly rejects associated/unspecified alpha, non-Byte bands,
color profiles requiring interpretation, and decoded source blocks exceeding its
32MiB bound. It retains private intermediates and failure evidence; independent
worker limits and cleanup remain required.

The dimension ceiling is65500, matching the conservative libjpeg-turbo bound.
Progressive and optimized multipass encoding must stay off: the codec's multipass
path requests a full-image coefficient buffer. See
[libjpeg-turbo dimension bound](https://github.com/libjpeg-turbo/libjpeg-turbo/blob/main/src/jmorecfg.h)
and [encoder initialization](https://github.com/libjpeg-turbo/libjpeg-turbo/blob/main/src/jcinit.c).
Pinned [GDAL3.6.2 encoder source](https://github.com/OSGeo/gdal/blob/v3.6.2/frmts/jpeg/jpgdataset.cpp)
sets optimized Huffman coding unconditionally for its normal JPEG path. The
initial99478472 CreateCopy implementation was therefore withdrawn before native
execution. Baseline alone did not establish bounded memory. The replacement
uses the [cjpeg explicit optimization switch](https://github.com/libjpeg-turbo/libjpeg-turbo/blob/2.1.x/cjpeg.c)
and [row-based PPM reader](https://github.com/libjpeg-turbo/libjpeg-turbo/blob/2.1.x/rdppm.c).
Oversized images require an explicit unsupported-full-resolution result; do not
silently make the image smaller. Full-resolution pixel count also remains large
regardless of container format.

The pure Node plan and Python converter are not workload-admission controls.
Future integration must provide an isolated server worker with fixed CPU/RAM/PID,
deadline, output/disk limits, one job at a time and joined cleanup. Do not run the
converter, GDAL, NumPy, model data or image builds on Beau's PC for this candidate.

The previous ten pure checks did not expose the GDAL codec's hidden default.
Fourteen corrected-source checks pass (3Node/11Python). They additionally bind
the encoder and fixed non-optimizing command, check timeout/cancellation/stderr
overflow cleanup, preserve the first failure if reaping remains unproven, and
require the child to inherit the future Python worker's isolated process group.
The launcher must create that isolated group and enforce the outside deadline;
the converter does not signal a shared group or prove descendant closure.
No GDAL, NumPy, codec, image
fixture or real conversion has been executed. Source checks do not establish
pixel blending, native memory bounds or image fidelity.

## Required follow-up integration and acceptance

- Add durable source/version-bound job state and a reviewed migration allocation.
  Existing derivative and dataset-operation type constraints do not admit this
  job; do not reuse a mesh job type or borrow migration46.
- Register only a verified actual JPEG output with content hash and lineage;
  preserve TIFF and failed evidence. Handle source replacement and retries.
- Add staff and authorized client download discovery through the existing live
  download capabilities. Recheck source/share/session permissions for admission,
  range requests and revocation. Do not broaden the render-asset allowlist merely
  to expose this download product.
- Add the UI's clearly labeled full-resolution JPG option and status/error path,
  including existing models. Do not perform conversion in an HTTP request.
- On an admitted server, verify real RGB/RGBA/alpha/mask samples, codec limits,
  exact dimensions, image fidelity, source immutability, scratch/heap bounds and
  cancellation/closure before staging and release.
- Qualify an immutable image containing the exact cjpeg binary and shared-library
  closure. Current2af calibration image remains unchanged; no install or image
  build is included in this source work.

Pure source checks cannot establish any of that runtime acceptance. The full
Viewer readiness goal remains active; this increment is not its completion.
