# Point-source volume and section acceptance

Working changes, September 22, 2026. This document is not a deployment receipt.

## Intended client workflow

Finish a polygon to save its area immediately. **Calculate volume** runs a scoped
server calculation; it does not grant import, reprocessing, reconstruction, or
mesh-processing authority. New 3D/point-cloud outlines prefer the original EPT
source. A saved calculation retains its selected asset, base, grid and class
filter. A missing source does not silently substitute a different surface.

The point calculation builds a maximum-height grid from all intersecting indexed
EPT hierarchy levels, within bounded node, point and cell limits. Empty cells
remain missing. It estimates space above/below a reference surface, not solid
material inside buildings, cars or hollow objects. The default grid is 0.1 m;
the result records actual grid dimensions, bounds, resolution and reduction.

The section re-reads the same hash-verified source and reconstructs that exact
grid, using the completed volume's frozen reference triangles. It reports gaps
and cell steps, not interpolated values or native raster measurements. Section
calculations do not overwrite the saved polygon or its volume.

## Height-unit evidence

Ordinary point calculations require explicit supported vertical CRS units in
the hash-verified EPT header. Supported compound WKT definitions have an upward
vertical axis and metre, international-foot or US-survey-foot units. Values are
normalized to metres before surface construction. The vertical datum is not
independently verified. Horizontal UTM metres, numeric vertical identifiers alone,
schema scale and a client-supplied metre assertion do not establish Z units.

Ordinary boundary-derived bases also sample the normalized original point grid;
raw viewer-picked Z is not trusted as a metre base. A custom base remains an
explicit elevation expressed in metres by the request contract. Separate legacy
staff declarations remain labelled as declarations, never as encoded evidence.

County Road D still has no verified source-specific height-unit evidence. The
research document does not supply that evidence. Continue the read-only original
artifact investigation in `COUNTY_ROAD_D_VERTICAL_UNITS_HANDOFF.md`; do not modify
the source or select a metre override to make this acceptance check pass.

## Verified locally

- Known metre and foot fixtures produce expected volumes and section heights.
- Nonzero raw-foot boundary picks do not become metre reference heights.
- Tampered source hashes, changed manifests/grids, missing units and conflicting
  declarations are rejected.
- Signed-in client transport, HTTP API, real calculation child, result attachment
  and linked section execute together against synthetic indexed EPT data.
- Saved results survive renaming but cannot reuse replaced source manifests.
- Temporary calculations remain page-scoped and published-source-only; tests
  cover revocation, source withdrawal and exclusion of specialist methods.
- Isolated rendered browser tests cover point-profile labels, hover/keyboard gap
  inspection, CSV/PNG exports and unchanged saved volumes.

Local verification on September 22, 2026:

- Linux source suite: 1,493 passed, 0 failed, 27 skipped.
- Production runtime build completed; its mounted-test release gate passed all
  109 tests with no failures or skips. This is a local candidate, not a published
  image or deployment receipt.
- Isolated rendered profile browser suite: 8 passed.

Associate these results with the final release commit before publication.
Windows storage tests require Linux
`/proc` semantics; a Windows full-suite failure is not a substitute for running
those tests in Linux. Tests that skip real data/browser requirements do not prove
live performance or survey accuracy.

## Remaining acceptance gates

Complete final diff review and verify the published candidate's release gates.
Verify the deployed candidate with a known-unit stockpile and compare the chosen
base, coverage and volume with an independent reference. Repeat real-data
point-cloud motion/detail-refinement checks; these calculation changes alone do
not prove navigation performance. Preserve Operations code and all existing user
measurements during testing.
