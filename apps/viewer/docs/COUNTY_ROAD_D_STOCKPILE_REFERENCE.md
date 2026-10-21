# County Road D stockpile reference — 2026-09-22

## Approved behavior

Draw an outline, show area, then **Calculate volume** on the server. Viewing mode
is not a calculation method: new outlines prefer the original DSM in model,
point-cloud and map views. Existing explicit source choices remain pinned. DTM
is never silently substituted for a stockpile DSM. Point-only datasets retain
their existing point-surface fallback and unit requirements.

The Operations repository and deployed source assets are not modified by this
implementation. No client is given processing/import/reconstruction authority.

## Reviewed unit evidence

`server/measurementUnitEvidence.mjs` records one reviewed source, not a default
that treats arbitrary untagged TIFFs as metres. It is bound to model, version,
asset, SHA-256, file size, dimensions and CRS. The worker verifies the actual
whole-file hash before calculating; conflicting explicit metadata still fails.
Results and native sections retain the evidence identifier and report hash.

Hermes supplied original-to-imported DSM/report hash matches, processing command
excerpts, a metre-labelled DSM report, and a live reference calculation. These
support metre interpretation of this source. They do not establish its vertical
datum or independent field accuracy. A replacement source/version requires its
own evidence review. The registry cannot be populated by a client request.

Source DSM SHA-256:
`0265277ff9c34805e2de4aff20cf568bf36d5a205423f6b0c39631880be7f514`

Report SHA-256:
`4684491d9c720dec0c5e4d5ebb6a3498bc32b3cb168ac56ea6020626d2a656c1`

## Reproducible reference

The exact supplied EPSG:4326 polygon and result are in
`test/fixtures/county-road-d-webodm-reference.json`. No large private raster is
committed. Run the read-only verifier against the original local file:

```powershell
node scripts/validate-county-stockpile-reference.mjs <dsm.tif>
```

An optional second argument specifies a comparison tolerance in cubic metres;
without it, the script reports the difference but does not declare acceptance.
The third argument is `map` or `spatial3d`. No source/unit override, database
mutation, remote job or download is performed by this script.

WebODM reference: **5,647.0534 m³**, triangulated base, western covered pile.
This is a visually digitized outline, not a surveyed toe; cover and tires are
part of the observed surface. The server response is absolute signed net volume,
so compare against `abs(netM3)`, not gross cut alone.

The original Viewer ear-clipped base produced 5,516.122456 m³, 2.318571% below
WebODM. Map and spatial calculations were identical after sampling all boundary
heights from the same DSM. This discrepancy was not a units conversion error.
Independent version-matched Python replay reproduced WebODM's rounded value;
its Delaunay base construction accounts for the principal difference.

WebODM uses raster-index boundary samples, Delaunay interpolation, all-touched
whole boundary pixels, and omission of NaN values. Viewer preserves fractional
boundary integration, separate cut/fill, and missing-data coverage. Numerical
agreement is a compatibility check, not a surveyed-accuracy claim. The report's
relative vertical LE90 is not applied as a volume correction or confidence bound.

## Implemented result

Native raster boundary references now use Delaunay triangulation in projected
coordinates, clipped to the actual polygon. All views sample the same native
boundary elevations. The final real-file calculation returned **5,647.271691 m³
net**, versus WebODM's **5,647.0534 m³**: **+0.218291 m³ (+0.003866%)**. It
processed 22,226,061 cells in about seven seconds locally, with full coverage
within floating-point tolerance. Map and spatial3d requests returned identical
numbers. This passes the explicit 1 m³ numerical comparison tolerance, not a
field-accuracy certification.

The native side section uses the calculation's frozen reference triangles and
source, rather than independently constructing a different base. Completed
legacy raster jobs without native-boundary provenance are not reused for a new
Calculate action; historical saved results are not deleted or rewritten.

## Verification and release status

- Local Linux source-suite image: 1,515 passed, 27 skipped, zero failures.
  Browser/native-optional suites account for skips; focused local browser tests
  were also exercised during implementation.
- Exact production-dependency runtime image: 52 selected numerical, source-unit,
  profile and private-calculation tests passed, no skips.
- Real DSM in the production runtime: identical 5,647.271691 m³ net, about nine
  seconds, read-only source mount and no external network.
- Native Windows full suite is not a release gate: existing Linux `/proc`
  storage-descriptor tests cannot execute there. Linux source suite above is the
  supported-environment verification. Browser-source tests that import unbundled
  frontend files are run in the source image, not the runtime-only image.
- Local runtime and frontend builds passed. No deployment or live production
  measurement write was performed in this batch.
