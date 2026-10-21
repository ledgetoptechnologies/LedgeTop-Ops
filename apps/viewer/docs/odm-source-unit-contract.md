# Native ODM source-unit contract

`server/odmSourceUnitProvenance.js` is a pure conservative resolver. The scheduled
ingestion caller now supplies durable upload/initialization/archive receipts and
independent raster metadata through `processingUnitEvidence.js`; registration is
lease-guarded. It does not infer from provider branding or accept browser proof.
Initial audited scope: **ODM exactly 3.5.6**, native GPS,
fresh creation, native LAZ/DSM/DTM. ODX and every other version remain unknown.

## Trusted caller boundary

The caller must obtain `receipt` from its own completed provider operation, not
from an imported JSON assertion. `operation: create` means a newly allocated
provider task with no prior processing/output reuse, not a restart renamed to a
creation. `providerTaskId` must equal `completedTaskId`. `archiveSha256` is the
digest of the downloaded response for that task. Ingestion binds the receipt to
immutable attempt/model-version records and verifies task success.

`inputFiles` is the complete uploaded source manifest, including ancillary files,
in its immutable stored order: `{relativePath, byteSize, sha256}`. Its canonical
JSON digest must equal receipt `inputManifestSha256`; this matches the existing
dataset manifest hash. No hidden GCP/geo/alignment uploads may be omitted.

`archiveFiles` is a complete safe inventory of that same returned archive. The
caller must hash actual bytes, never trust an archive-supplied inventory. It must
reject links, duplicate/ambiguous roots, replacement races, and path escapes in
its normal extraction flow. `source` supplies one independently inspected native
asset's relativePath/kind/sha256/byteSize, numeric `horizontalEpsg`, and explicit
`verticalUnit` (`null` means absent, `metre` accepted; all other values fail).
Canonicalize all explicit vertical-unit metadata, including conflicts, before
calling; a 2D horizontal CRS is not itself vertical-unit evidence.

Artifacts `log`, `photos`, `coords` each contain `{relativePath, bytes: Buffer}`.
Resolver verifies their bytes against inventory digests and caps each at 8 MiB.
Native paths are `log.json` (or `assets/log.json`), `images.json`, and
`odm_georeferencing/coords.txt`. Two log locations must have identical hashes.
Incomplete archives lacking these artifacts remain unknown; do not synthesize
them or use folder names/report text as a replacement. The input is deliberately
not exposed as an API. Hashes establish binding/integrity, not producer identity
against an adversary controlling a processing node.

## Actual producer schema and acceptance checks

ODM 3.5.6 log.json has `odmVersion`, `images`, `options`, `startTime`, `endTime`,
`totalTime`, `stages`, `processes`, and `success`. Option names use underscores;
`rerun_from` is a stage array when set. `sm_cluster` is redacted to boolean true
when configured. No invented `nativeGps: true` / `producingEngineVerified: true`
artifact fields are accepted. Unknown or absent critical options fail closed.

Require successful complete stages and process exit codes, image count matching
the entire image-only manifest, no GCP/geo/align/split-group/external-cluster or
rerun inputs, and a split threshold above the image count. Reject discovered
ancillary filenames and submodels, cached-output messages, and pseudo/no-georef
paths. Parsed native images.json must have finite GPS coordinates/elevations,
matching filenames, and preserved altitudes in native UTM coords.txt. Source
CRS must match that UTM header, with no explicit vertical-unit conflict.

The output contains fixed classification, hashes, numerical source binding and
GPS Z offset only. It never echoes paths, commands, options, credentials, log
messages or filename lists. It reports `verticalDatum: unknown`: unit evidence
does not prove vertical datum, photogrammetric accuracy, or survey quality.
Report display units do not control source units. GPS Z offset remains metres.

## Audited upstream source

- [Exact logger schema](https://github.com/OpenDroneMap/ODM/blob/v3.5.6/opendm/log.py)
- [Exact option serialization](https://github.com/OpenDroneMap/ODM/blob/v3.5.6/opendm/arghelpers.py)
- [Photo GPS metadata](https://github.com/OpenDroneMap/ODM/blob/v3.5.6/opendm/photo.py)
- [GPS UTM coordinates, unchanged altitude](https://github.com/OpenDroneMap/ODM/blob/v3.5.6/opendm/location.py)
- [Automatic ancillary discovery](https://github.com/OpenDroneMap/ODM/blob/v3.5.6/opendm/types.py)
- [Dataset images.json / georef selection](https://github.com/OpenDroneMap/ODM/blob/v3.5.6/stages/dataset.py)
- [XY-only native offset and optional alignment](https://github.com/OpenDroneMap/ODM/blob/v3.5.6/stages/odm_georeferencing.py)
- [DEM from native LAZ; pseudo-georef exception](https://github.com/OpenDroneMap/ODM/blob/v3.5.6/stages/odm_dem.py)

## Deliberately unresolved

No import currently supplies a trusted fresh-task receipt. Imports need a
separately reviewed evidence policy, or one source-bound staff confirmation.
EPT conversion requires a derivative-chain contract tying its immutable manifest
to the accepted LAZ, not reuse of a native-path test. GCP, custom geolocation,
alignment, split/merge and reused outputs need separately audited contracts.
Integration must not set producingEngineVerified from ClusterODX /info: that
describes a reference worker, not necessarily the actual producer. Full native
artifacts may require preserving additional private files during ingestion;
missing files intentionally keep the classification unknown.
