# Bounded private measurement calculations

## Permission boundary

Viewing a shared project or task never grants general processing authority. All normal stockpile volume calculations are intended to run on the Viewer server, including clients' measurements on shared models. This is a narrow measurement capability, not permission to import, reprocess, reconstruct geometry, edit projects, or start arbitrary jobs.

The signed-in path is implemented locally: a live Viewer bearer with `view` and `measure`, a trusted individual identity, and access to the exact immutable version can create/list/read/cancel `surface-cut-fill` jobs only for that person's saved measurements. Clients require `permissions.personalMeasurements:true`; staff use their trusted `ops` identity. `rasterCalculations` advertises this capability. The worker rechecks the live Viewer session, current model/version availability, ownership and revision while running and before storing results.

Advanced point-surface, closed-mesh and reconstructed-estimate jobs still require a separate matching-person Operations admin bearer with explicit `viewer.processing.write`. `serverCalculations` remains the advanced capability flag. `audience: ops` alone is insufficient for these methods. The worker independently rechecks both sessions for advanced jobs.

Public-link and temporary-identity server calculations use the locally implemented ephemeral lifecycle described below. Public shares remain excluded from private persistence APIs. The normal production inspector must not silently fall back to browser volume calculation when server access or a source is unavailable. Final full-suite and deployment acceptance remain pending.

Jobs snapshot saved canonical `[E,N,Z]` metre vertices, collection, coordinate reference, registered source asset identity, method and settings. Client paths and alternate geometry are not accepted. Source files are hash-verified. Measurement edits cancel queued/running jobs; deletion cancels jobs and removes their retained private input/result. Terminal calculation history is bounded to twenty per measurement. Job responses never expose source paths or capability hashes. A stopped worker marks expired leases failed instead of silently retrying costly work.

## Methods and what they mean

| Method | Authoritative input | Result and limitations |
| --- | --- | --- |
| `surface-cut-fill` | Original registered DSM/DTM GeoTIFF, image 0 | Native-cell 2.5D surface above/below the selected base. No overview or display-tile calculation. |
| `surface-transect` | The completed owned volume's exact native DSM/DTM and frozen effective reference triangles | Piecewise-constant native-cell elevation profile through that polygon. Explicit gaps and base heights; not a new volume, inferred smooth surface, or point-cloud corridor. |
| `point-surface-cut-fill` | Original EPT manifest and every intersecting hierarchy node | All source points contribute to a topmost-point grid at an explicit requested cell size; optional ground class 2. This is a 2.5D surface, not the enclosed volume of a car/building. |
| `closed-mesh` | Original OBJ, explicitly declared projected or local-ENU frame | Seed-selected connected original mesh component within the selected polygon and elevation bounds; only a validated closed manifold produces a volume. Cropping that opens the object fails. |
| `reconstructed-estimate` | Selected original OBJ surface vertices or all selected native EPT points | Explicit opt-in screened-Poisson reconstruction, then closed-mesh validation. Every generated face is inferred. The output is an estimate, never an observed-object/exact volume. |

Surface references are boundary-triangulated, fitted plane, explicit custom horizontal elevation, or lowest/highest/average boundary elevation, with optional offset. Map measurements store placeholder Z coordinates; server calculations resample boundary elevations from the native raster/requested native-point grid for every non-custom reference. Missing boundary elevation fails rather than implicitly using zero. Spatial 3D measurements use their saved picked boundary elevation.

Surface integration clips each native cell against the polygon and the piecewise-linear base patches, then clips positive and negative portions before integrating. Fractional edge cells and base sign crossings are accounted for. Nodata, missing point cells and missing raster extent stay missing, produce incomplete coverage, and are never filled with zero. Values retain double precision; displayed decimal places are not a claim of survey accuracy. Grid calculations model each cell's height as constant, so input resolution and sampling remain physical limitations.

GeoTIFF requires matching projected CRS and metre horizontal units. A WGS84 UTM CRS supplies the horizontal metre convention only when the horizontal unit key is absent; it cannot override explicit nonmetric or invalid units. It does not establish vertical units. Point EPT currently requires matching WGS84 UTM.

Point EPT horizontal CRS recognition accepts numeric EPSG declarations and supported WKT1/WKT2 WGS84 UTM definitions, including WKT-only EPT metadata. All supplied declarations must agree with the measurement frame. The parser validates datum/ellipsoid, projection parameters, hemisphere, horizontal units, and east/north axes; it is bounded and is not a general CRS transformation engine. Conflicting or unsupported definitions remain errors. This fixes rejection of valid WKT-only metadata without treating horizontal metre units as proof of elevation units. The existing separate point-source height declaration requirement remains unchanged.

Recognized GeoTIFF vertical-unit keys and GDAL elevation-band units are converted to metres, including international feet and US survey feet. Conflicting/unsupported declarations, invalid metadata and nonidentity scale/offset fail rather than guessing. If vertical units are absent, an explicit metre declaration is recorded as `requester-declared` for ordinary server calculations, or `administrator-declared` when separate administrative authority is present. Neither declaration is encoded or independently verified source metadata. Users who do not know the units must not guess. Pixel-is-point, rotation, non-north-up rasters and codec blocks exceeding the configured bounded limit (no more than 256 MiB) fail. OBJ coordinate-frame declarations are explicit; local ENU uses only registered immutable version RTC offsets. Unsupported frames/CRS fail.

## Normal stockpile workflow

The ordinary surface inspector uses a direct, scoped Viewer-bearer client and the existing worker. Finishing a polygon saves its geometry and displays area/perimeter immediately, without opening the volume inspector or submitting a volume job. The record's **Calculate volume** action opens the surface/base inspector; its **Calculate volume** button explicitly submits or retrieves the calculation. Client labels and progress omit hosting terminology. The helper checks existing jobs for the same saved revision and parameters before creating one. Matching queued/running work is observed, and a matching completed result can be retrieved. A create race rechecks existing work instead of deliberately submitting a duplicate.

The standard inspector does not offer a metre-confirmation checkbox and always sends `confirmMeters:false`. Missing elevation units are a source-readiness issue for the model owner, not a decision clients must guess. Existing API declaration support and authorized specialist methods are unchanged; this UI change does not introduce verified-provenance storage, migrate legacy declared-unit jobs, or silently restore a prior declaration. Previously attached totals remain labelled as saved results. The displayed **Ground from boundary** option is the existing `boundary-triangulated` method, with unchanged numerical behavior; it estimates a base from surrounding boundary points and is not a surveyed-ground claim.

Client presentation shows the outline's horizontal area and one **Calculate volume** action. Source/base inputs are hidden and disabled without separately checked staff calculation capability; staff get a collapsed Advanced settings disclosure. Specialist methods still require their separate staff capability and are not offered to client sessions. This presentation does not replace server authorization. New client stockpile calculations explicitly select the pile-containing DSM even when the outline originated in a terrain view; no automatic bare-ground substitution occurs if that source is absent. An explicitly saved source/reference remains unchanged when its result is reopened or recalculated. Missing-source and CRS errors direct clients to the model owner without asking them to use hidden settings.

The ordinary workflow calculates a relative surface volume, not volume from the currently displayed point-cloud subset. WebODM likewise documents a DSM and a reference base for its stockpile tool: https://docs.webodm.net/how-to/calculate-volumes/. A relative base removes a common absolute-height offset, not uncertainty about height units. Native point-cloud calculation remains a distinct specialist method; changing its client permissions or profile source requires a separate implementation, not renamed raster results.

The inspector exposes cancellation without requiring the advanced staff dialog. Active work with different settings must finish or be cancelled before submitting changed settings. Closing or switching views stops observation, not an accepted job; reopening and calculating with the same settings resumes observation or retrieves the result. Result attachment checks the measurement revision, source asset, immutable model version and reference base. Stale observers cannot attach results to a different view or edited geometry.

Errors retain exact allowlisted codes and become plain-language guidance. Missing DSM does not silently select a bare-earth DTM that may omit the pile. Server execution is not by itself a guarantee of accuracy: source units, coverage, base choice and input resolution still determine what a volume means.

## Parent-linked native profiles

Normal measurement access also permits `surface-transect`, advertised by
`transectCalculations`. Its request contains only `revision`, `method`,
`parentCalculationId`, and a `line` with projected XY `start`/`end`; the server
resolves the source and reference from the completed authorized native volume.
It rejects client-provided sources/base triangles, stale or foreign parents,
changed geometry and unmatched source versions. The exact unchanged attached
volume may be used at a later document revision only with verified attachment
evidence. The returned profile does not change measurement or volume results.

Both crossed raster cells and output intervals are capped at 20,000. NoData and
outside-polygon/raster intervals are explicit, not interpolated. The effective
reference includes the parent's offset exactly once. Existing worker bounds,
source hashing, cancellation and current-access checks apply. Private retention
protects an attached volume and parents of active profiles within the bounded
history; temporary profiles cannot outlive their parent volume. See
[native-profile implementation and acceptance](NATIVE_ELEVATION_PROFILE_QA_2026-09-07.md).

## Temporary/public server lifecycle

Migration 33 adds `ephemeral_measurement_jobs`, separate from personal measurement rows. A live Viewer grant or an existing signed task/project-share asset capability with `view` and `measure` can submit only a bounded native DSM/DTM surface calculation. Shared sources must be published and belong to the exact authorized immutable version. The request pins that version explicitly; a later model version cannot silently substitute different geometry or sources.

An unguessable per-page handle is kept only in browser memory and hashed server-side. Job list/read/cancel operations require the same valid grant scope, page handle and model version. Lists are narrowed to the requested temporary measurement. Geometry hashes use the collection, vertices and fixed-order CRS/vertical-unit values, not incidental object-key order. Reopening in the same page can recover a matching job; changed geometry cannot reuse its result. Refresh creates a new handle and does not restore old temporary measurements or jobs.

Temporary requests/results expire after at most fifteen minutes, earlier if their grant expires. Expired rows are pruned through the job lifecycle, and worker authority/lease checks stop revoked or expired work. Closing or refreshing does not promise immediate cancellation of an already accepted job; its inaccessible server-side snapshot remains bounded by that expiry. No anonymous personal identity or persistent private measurement is manufactured.

Private and temporary jobs share the twenty-job queued/running ceiling and the existing single measurement-worker/heavy-job admission boundary. Temporary retention is additionally capped at forty rows per grant/version scope, with submission rate limits. A public page does not gain an independent unbounded compute lane, arbitrary file access, reconstruction, imports or reprocessing.

Closed-mesh validation checks exact coincident vertex welding, finite vertices, nondegenerate unique triangular faces, one connected component, two opposite-oriented faces per edge, single vertex fans, and triangle self-intersections using a bounded BVH search. It computes shifted-origin signed-tetrahedron volume. It does not fill holes, simplify a source into a box, or accept disconnected shells as one object.

## Reconstruction support and provenance

The existing worker image builds the official [PoissonRecon](https://github.com/mkazhdan/PoissonRecon) C++ executable from commit `262b0f539d404057d1f36e1adc07fc9388678899` (18.76). Source archive SHA-256: `4a07ad091a63cc8403c57a8906b97b41d07c2fd87aa8aad0e7680dac20c4dcd5`.

`third_party/poissonrecon/262b0f5-two-threads.patch` pins the internal thread pool to two threads. Docker verifies the patch SHA-256 as well as the archive, builds with double precision, standard C++17/OpenMP, and no fast-math. The source license and build receipt are included in `/opt/poisson`. There is no new service, external API, runtime package download, or Open3D wheel dependency. Capability discovery advertises reconstruction only when this installed executable and pinned build receipt are present.

Reconstruction request:

```json
{
  "revision": 1,
  "method": "reconstructed-estimate",
  "sourceAssetId": "registered-native-source-id",
  "sourceCoordinateFrame": "projected",
  "selection": { "seed": [367000, 4759000, 100], "minElevationM": 98, "maxElevationM": 105 },
  "reconstruction": { "depth": 6, "normalRadiusM": 0.3, "supportDistanceM": 0.08, "acknowledgeInferredGeometry": true }
}
```

EPT uses `sourceVerticalUnit: "m"` and optional `classFilter`, without an OBJ frame choice. Normals use bounded 24-neighbor PCA within the explicit radius, seeded connectivity, and consistent neighbor orientation. Depth is 6–9; radii/support distance must be positive and at most 100 metres. Sparse, unstable, excessively large or unclosed results fail. Seed connectivity can exclude disconnected points; counts are recorded.

The result records source identity, reconstruction settings, engine commit/precision/thread count, selected/excluded point counts, closed-mesh checks and nearest-source-distance percentiles. Generated geometry must remain within the selected polygon and vertical limits; edges crossing concave boundaries also fail. An estimate that extends outside fails with `measurement_reconstruction_outside_selection`; expand the selection deliberately if appropriate. The implementation does not clip and seal an escaped shape to manufacture a volume. The support distance overlay reports proximity only: a generated underside may be close to observed points without ever having been observed. All preview faces are marked inferred; unsupported-area fraction additionally reports triangles with vertices farther than the explicitly chosen support distance. Poisson can bridge gaps, invent an underside and smooth edges. These estimates need independent real-object validation before commercial quantity claims.

## Resource and privacy limits

- Existing processing worker only; one active measurement job across private and temporary lanes, with symmetric database admission against heavy dataset/processing/derivative jobs. Maximum twenty queued/running measurement jobs globally across both lanes. Temporary rows additionally have a fifteen-minute-or-grant-expiry lifetime and a forty-row grant/version-scope cap.
- Native DSM/DTM calculations stream up to one hundred million cells by default (`MEASUREMENT_RASTER_MAX_CELLS`, hard maximum one hundred million), with a separate one-billion candidate cell/reference-patch work limit. The cell limit applies to the selected raster bounding rectangle, not just polygon area. Native raster row/column indexing restricts integration to spatially intersecting patch bounding boxes; work is charged for those candidate visits, rather than multiplying every cell by every patch anywhere in a concave outline. A bounded spatial estimate rejects oversized work before selection decoding, and cumulative window checks remain enforced. Point grids retain their independent two-million-cell default (`MEASUREMENT_MAX_CELLS`, configurable up to sixteen million) and thirty-million cell/reference-patch work limit. No silent coarsening. Interior raster cells use exact linear-plane integration; boundary and cut/fill sign-crossing cells retain fractional clipping.
- Native TIFF reads use at most 512-by-512-cell windows (2 MiB of normalized Float64 samples); codec-block allocation remains separately bounded. Smaller test windows are supported and produce the same native integration within floating-point summation tolerance. EPT uses at most 20,000 intersecting nodes/10,000 hierarchy pages, 64 MiB per node, two million decoded points per node and twenty million points read per selection.
- Reconstruction accepts 50–100,000 selected unique sample candidates, with at most 200,000 output vertices/faces and 32 MiB generated ASCII output. Closed source selection similarly caps 200,000 vertices/faces. Intersection validation has a finite test budget.
- V8 old-space capped at 1 GiB. Default total calculation memory 4 GiB; parent RSS checks run independently of child event-loop activity. Native subprocess RSS plus Node RSS is also checked. Two native threads; deadline default 300 seconds, configurable maximum 900 seconds; native Poisson has its own 240-second deadline.
- Cancellation, revoked access, changed measurement revision, timeout or lost lease kills the child process group, including native descendants on Linux. Private scratch directories are removed after termination. Only bounded previews/results are persisted; source rasters, clouds and full reconstructed meshes are not copied into measurement rows.

Environment controls: `MEASUREMENT_CALCULATIONS_ENABLED`, `MEASUREMENT_MAX_CELLS`, `MEASUREMENT_RASTER_MAX_CELLS`, `MEASUREMENT_MEMORY_MIB`, `MEASUREMENT_TIMEOUT_MS`, `MEASUREMENT_POISSON_BIN`.

Accepted jobs are database-backed and do not require the calculation dialog or
browser page to remain open. They still require the original Viewer authorization
to remain valid: expiry, revocation, cancellation, changed measurement revision,
or lost worker lease stops the job. Do not promise completion after access expires.
Closing the dialog alone does not cancel an accepted job; use explicit cancellation.

## Verification and remaining deployment checks

Focused tests cover exact fractional cells, base cut/fill crossings, projected-coordinate stability, negative and zero elevation, nodata/coverage, map boundary resampling, source hashes, native TIFF windows, all-level EPT binary reads, bundled offline LAZ decoding, closed/open/intersecting meshes, PCA normal orientation, parser bounds, job ownership/revision/revocation and explicit estimate acknowledgement.

Both amd64 and ARM64 pinned native source stages compiled and executed their usage smoke successfully. The final non-root amd64 runtime candidate (`ltds-viewer:measurement-runtime-candidate`) passed 36 focused calculation/private-API tests with zero skips, mounting only read-only tests—not replacement application code. Native reconstruction of an analytic unit sphere and a full original-EPT-to-reconstruction sphere pipeline stayed within an explicit 0.2 m³ tolerance of 4π/3. This verifies a bounded synthetic case, not a general accuracy guarantee. ARM64 reconstruction numerical comparison beyond the compile/executable smoke has not been run.

The runtime and numerical counts above describe the earlier advanced-calculation verification, not acceptance of the current signed-in/public stockpile changes. Current focused and isolated-browser evidence is recorded in `STOCKPILE_SERVER_AND_REFINEMENT_QA_2026-09-07.md`; the final full-suite run is pending. Before production acceptance, verify the final full worker image with real projected datasets, sparse/occluded surfaces, permission revocation during native work, worker restart and competing imports. Verify clients can operate only their own authorized raster jobs and cannot access advanced methods, another person's jobs, other versions or general processing endpoints. Include public refresh/reset, TTL, revocation and shared admission-limit checks in that final acceptance. Compare quantities against a known reference object and record source accuracy, base selection, point spacing and support warnings. No processing job or production dataset was launched by the local tests.
