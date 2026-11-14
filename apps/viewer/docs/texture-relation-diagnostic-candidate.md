# Standalone photographic-relation diagnostic

Processing's actual 8c calibration converted case00 with native exit0, then
frozen engine E failed `lod_texture_photographic_relation_failed`. In E this
gate compares pre-KTX raw PNG atlas bytes against decoded KTX level0, before
the later source-UV proof. The full metric is computed and then rejected before
`onMetric`, so the ordinary CLI's privacy-safe failure receipt omits it. This
does not prove a UV, flip, channel, encoder or decoder defect.

The new standalone driver uses the frozen E public components without editing
them or rebuilding the image. It verifies raw-Git-blob SHA256 for five direct
engine module/script dependencies, imports them from an immutable E mount,
and uses E's pinned Basis decoder and real reaped GDAL row reader. Windows
checkout line endings are not the Linux source hashes. E commit remains
`0e18f938a157f882057fcbd3b040e5f0ed71ae10`; the driver has a separate source/hash.

It reconstructs the same tileset/B3DM/descriptor/mapping/raw-manifest/image
closure, validates declared face association, and directly calls E's existing
`compareAtlasLevelZero`. It reports the first failing pair's exact relative
tile, embedded image and raw-atlas identities/hashes, RGB/alpha/channel/region
statistics, worst-error pixel coordinates and unchanged policy. No flip,
swizzle, re-encoding or alternative acceptance path is attempted. Only level0
is decoded; the iterator closes its native texture before reporting a metric.
The raw iterator must finish its final hash and child-exit check.

## Owner-only execution contract

The trusted request contains exactly `engineScripts`, `output`,
`basisJavascript`, `basisWasm`, all canonical absolute paths. `engineScripts`
is the frozen E scripts directory, not the driver's directory. The five direct
pins do not cover every transitive dependency: `stream_atlas_rows.py` imports
`verify_atlas_proof.py`. The owner must independently rehash the complete frozen
752-file E packet against manifest `96dcad131e3c11a62d2c797fb9f7b77f8e346e86f09438c6077a5ee2a556658d`
before and after the operation, and seal and RO-mount exact E, the retained case00 output and pinned
Basis files; record actual file/source/image/host identity; enforce a one-shot
deadline and complete PID/CID/cgroup cleanup. No DB, registry, app mutation or
network is needed. Python stays `/usr/bin/python3` with the existing runtime.
Processing owns materialization and admission; none is performed by this PR.

Run the separately pinned driver with `--request /absolute/request.json` in the
existing owner-verified image only after its own reviewed admission.
The JSON request is limited to 64KiB, per metadata/B3DM/JSONL reads to 16MiB,
aggregate metadata to 32MiB and the receipt to 512KiB. Decoder image limits and
comparison thresholds remain E's. This bounded driver may refuse larger output;
that is a diagnostic budget failure, not a conversion/fidelity verdict.

Exit0 means the diagnostic measurement completed. Root `candidatePass:false`,
`ready:false`, `wholeConsumerProofVerified:false` and unexamined lower mips are
always explicit, even when no failing level0 pair was found. Inner metrics retain
their original statistical candidatePass values. No registry or recovery adapter
may use this receipt as whole-proof/calibration acceptance. Exceptions emit only
allowlisted codes, not private OS/model paths.

Twenty lightweight tests pass across new tiny synthetic diagnostic pairs and
existing relation-policy/whole-proof tests. No real output, GDAL, WASM, decoder,
host or native model work ran on Beau's PC. Actual diagnostic results and root
cause remain pending owner execution. Frozen inputs, fixtures, thresholds,
image/binary/runtime identities and failed captures are unchanged.
