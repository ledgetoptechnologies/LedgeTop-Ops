# County Road D: read-only elevation-unit investigation

Status: September 7, 2026. **Actual DSM elevation units remain unproven.** The
current Viewer rejects missing recognized vertical-unit metadata, and the user
has said they do not know the units. No confirmation, original TIFF, unit metadata,
Operations code, share grant or measurement has been changed by this investigation.

## Purpose and scope for the server-access agent

Determine whether authoritative retained or original source evidence establishes
the height units of the exact County Road D DSM used by Viewer. Inspect existing
server artifacts and task records read-only. Do not reprocess, convert or rewrite
the raster, set a metre confirmation, edit Operations, or launch a calculation
merely to make an error disappear. Return findings before proposing any mutation.

This investigation does not block independent native-profile implementation,
measurement UI improvements or tests against synthetic sources with known units.

## What the Viewer currently establishes

- Live calculation has reported no recognized elevation-unit declaration. This
  means the currently supported unit checks found no usable declaration; it does
  not prove that every original sidecar or source artifact has been inspected.
- `server/webodmTaskImport.js` preserves a provider/source fingerprint, original
  asset metadata and georeference data, but no authoritative vertical-unit
  generation contract. `server/odmTaskMetadata.js` extracts processing statistics,
  CRS/origin and bounds; those alone do not prove the DEM's Z units.
- `server/retainedManifest.js` hashes selected DSM/DTM files and retains selected
  `odm_georeferencing` projection/origin/summary/info files and report statistics.
  It retains EPT closure, or a native LAS/LAZ source when EPT is absent. The
  explicit retention selection does not guarantee root generation logs, original
  alignment files or arbitrary raster sidecars are present. Inspect the actual
  manifest and original task; do not assume they survived import.
- `raster-vertical-units.mjs` distinguishes explicit vertical GeoKeys and elevation
  band units from a requester-declared metre confirmation. An empty band unit is
  unknown. Conflicting declarations and unsupported scale/offset transformations
  must not be bypassed. A checkbox declaration is not independent verification.

## Inspection sequence

1. **Bind identity first.** Resolve the County Road D task to the exact Viewer
   model version, registered DSM asset path, byte size and SHA-256. Resolve the
   corresponding original WebODM task and original DSM. Record the mapping and
   compare hashes. A similar task name, preview or matching extent is insufficient.
   Do not include session tokens, signed URLs or credentials in the report.
2. **Inspect the original height band.** Read existing TIFF/GDAL metadata,
   including band `Unit Type`/`UNITTYPE`, `VerticalUnitsGeoKey`, vertical CRS/WKT,
   band scale/offset and any existing `.aux.xml` sidecar. A read-only
   `gdalinfo -json <resolved-dsm-path>` is useful; omit statistics/histogram flags
   that may compute or persist ancillary data. Capture the complete relevant
   vertical declaration, not just a projected CRS's XY metre unit. Report absent,
   conflicting or unsupported declarations explicitly.
3. **If necessary, trace the actual generation.** Read the original task's engine
   version/container identity, processing options and console/generation logs.
   Inspect geolocation/GCP coordinate and height declarations, the georeferenced
   LAZ used for DEM generation, and any alignment reference/matrix or subsequent
   raster transformation. Bind the evidence to this task and DSM, not current
   upstream defaults. Establish the height scale before and after each relevant
   transformation. Check for reused pre-existing DEM outputs as well as new ones.
4. **Use sibling data only with proven lineage.** Inspect retained EPT `srs.wkt`
   and LAS/LAZ vertical SRS, plus georeference `.summary.json`/`.info.json`. Explicit
   EPT or cloud units establish those source units; they establish DSM units only
   if generation evidence connects that cloud to this DSM without an intervening
   height-unit change. LAS integer scale/offset is encoding, not itself a physical
   unit declaration.
5. **Record the conclusion and limits.** If evidence establishes metres, return
   the exact declaration or generation chain with asset hash and source locations.
   If it establishes another unit, name the precise unit (for example international
   foot versus US survey foot). If evidence is missing, conflicting or only
   conventional, return **units not established** and identify the missing item.
   Keep datum knowledge separate: known metre units do not prove a vertical datum
   or independently validate field accuracy.

## Evidence that would be sufficient in principle

- An authoritative explicit elevation-unit declaration for the original DSM,
  bound to the exact immutable asset, with compatible scale/offset and no
  conflicting declaration.
- Alternatively, a verifiable original processing chain establishing metre-valued
  input heights and their preservation into this exact DSM, including the actual
  engine/version and any alignment or postprocessing. A generic pipeline description
  is not a substitute for that task-specific chain.

Horizontal EPSG, a display setting of feet, plausible local elevations, file names,
provider labels and an ODM software tag are insufficient on their own. WebODM
returning a volume does not independently prove the units of an imported raster.
Do not repeat “ODM defaults to metres” as dataset-specific proof.

## Primary source inspected and its limits

- [ODM DEM stage](https://github.com/OpenDroneMap/ODM/blob/master/stages/odm_dem.py):
  the inspected upstream source uses `odm_georeferencing_model_laz` as DEM input,
  selects DSM/DTM generation, and can reuse existing outputs. It identifies the
  lineage to inspect, not County Road D's engine version or actual height units.
- [ODM georeferencing stage](https://github.com/OpenDroneMap/ODM/blob/master/stages/odm_georeferencing.py):
  the inspected source includes optional alignment of the georeferenced cloud
  before later processing. Therefore inspecting just a projected CRS or software
  tag cannot establish the complete transformation history.
- [ODM DEM commands](https://github.com/OpenDroneMap/ODM/blob/master/opendm/dem/commands.py):
  the inspected source invokes `renderdem` and performs raster assembly, optional
  gap filling and smoothing. This is a generation-path reference, not a blanket
  unit guarantee for any TIFF imported as a DSM.
- [WebODM task API](https://github.com/OpenDroneMap/WebODM/blob/master/app/api/tasks.py):
  the inspected source exposes task information and a task console-output read
  path. The server agent should use the corresponding installed version and its
  existing authorized task records when retrieving original generation evidence.

These are upstream `master` references inspected during this investigation, not
claims that County Road D was generated by those exact revisions. Pin the actual
deployed engine revision in any provenance conclusion.

## Return format

Provide a short report containing:

- Viewer model/version, original task identifier and resolved asset mapping.
- DSM byte size and SHA-256; whether original and retained hashes match.
- Exact height-unit declarations, scale/offset and any conflicts or absence.
- Supporting artifact locations and relevant engine/options/transform evidence.
- Conclusion: verified unit, conflicting evidence, or units not established.
- Vertical datum status separately, and any remaining inspection needed.
- Confirmation that the inspection made no source, Operations or measurement
  changes. Any future provenance-record change should be proposed separately,
  preserving the original raster and binding evidence to its immutable hash.
