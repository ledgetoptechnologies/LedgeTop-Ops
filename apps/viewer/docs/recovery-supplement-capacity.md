# Staging recovery inventory capacity

This proposal raises only the canonical STAGING supplement file count from
10,000 to 20,000. PRODUCTION remains limited to 10,000. No route, installed
configuration, frame contract, photographic proof policy, converter or immutable
proof-engine source is changed.

The retained conversion inventory contains 15,991 regular files: 337 B3DM,
337 JSON, 672 JSONL, 9,618 PNG, 5,026 JPG and one timing text file. All image
paths are under texture-proof; LOD0 alone contains 10,642 files. The fixed proof
engine reads raw LOD0 atlas images, mapping manifests and JSONL for pixel and UV
verification. Classifying these images as disposable diagnostics to fit the old
limit would defeat that verification. Filename metadata does not establish the
exact referenced closure, so this proposal preserves the entire captured output
and timing file rather than filtering it. The original archive is retained.

The exported inventory metadata was independently SHA-256 checked before
analysis. No archive body, image or native decoder was opened. These counts do
not establish geometry, texture fidelity, reachability or successful intake.
The captured output also lacks lod-provenance.json. The owner must run the fixed
prepare proof after admission/qualification and include its exact provenance in
a newly sealed supplement before the read-only verify phase. It must not be
invented or appended to the original retained archive. Including that file would
bring this conservative candidate to 15,992 files.

Bounds remain explicit: at most 20,000 staging files, 16 MiB of canonical manifest
UTF-8, 64 GiB of file payload, 1,024-character safe relative paths, and the existing
intake depth/component limits. Inventory metadata is checked incrementally
before hashing the full array; the complete canonical envelope is checked too.
Intake uses the same byte cap, reserves metadata plus 8 KiB per file/directory
and existing overhead, and retains its streaming 1 MiB IO chunks. Directory and
retained-part count bounds follow the finite file cap. No processing concurrency
or native resource/deadline limit is raised.

Twenty-five lightweight checks pass: existing strict envelope, source binding,
custody and cancellation tests plus a synthetic 15,992-file intake layout,
unchanged production boundary, staging boundary, metadata overflow and payload
overflow. Windows tests do not establish Linux descriptor custody or physical
cleanup. An independent source review found no actionable regression. Actual
staging intake, source/frame/producer binding, qualified calibration, immutable
custody, required-output readiness, usable Viewer output and delivered matching
ACK remain separate acceptance requirements. No deployment or intake ran.
